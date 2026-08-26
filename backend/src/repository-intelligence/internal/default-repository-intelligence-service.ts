/**
 * WORK-039: DefaultRepositoryIntelligenceService — the application/context-
 * intelligence orchestrator.
 *
 * Composes the EXISTING authorities (read-only) to produce ranked, explainable,
 * provenance-preserving context selections stored THROUGH the existing
 * /projects authority (the context index is a PROJECT artifact, like
 * ProjectBaseline). The orchestrator owns NO tables.
 *
 *   buildIndex  — resolve baseline → verify 'complete' (tenant-isolation
 *                 check) → inspect host (optional; honest toolInvocationIds)
 *                 → read candidates → rank → compute content_digest →
 *                 ensureIndex (idempotent) → markComplete (CAS + atomic
 *                 item upserts). Idempotent per (baseline, query_kind,
 *                 query_ref); concurrent jobs converge (cas-lost).
 *   retrieve    — look up the complete index; build if missing; return the
 *                 selection. NEVER silently swaps the baseline under the
 *                 caller (the index is pinned to the caller's baselineId +
 *                 its baseline_commit_sha).
 *   detectStale — compare the index's baseline_commit_sha against the current
 *                 repo HEAD (resolved through /github). Advisory; the index
 *                 is NEVER swapped.
 *
 * PROVENANCE PRESERVATION. The orchestrator passes the ranker's output
 * through to the storage layer VERBATIM — it never mutates provenance. The
 * ranker never mutates it either (the ranker only attaches score + reason).
 *
 * REPOSITORY REVISION IS FUNDAMENTAL. The orchestrator reads the baseline's
 * baseline_commit_sha + pins the index to it. A retrieve for baseline B
 * (commit B) NEVER returns the index for baseline A (commit A).
 *
 * TENANT ISOLATION. The orchestrator verifies the baseline's projectId ===
 * query.projectId (defense in depth — the route already checked ownership).
 *
 * NO FABRICATED EVIDENCE. The orchestrator passes the hostInspector's
 * toolInvocationIds through to the storage layer VERBATIM (NEVER invents IDs).
 * When hostInspector is the NoOp default, toolInvocationIds is '[]'.
 *
 * The orchestrator NEVER mutates workflow / verification / review / execution
 * state, NEVER auto-freezes architecture, NEVER stores credentials.
 */
import type {
  BuildIndexResult,
  ContextIndexQuery,
  ContextResolutionContext,
  ContextSelection,
  RepositoryIntelligenceService,
  RepositoryIntelligenceServiceDeps,
  StaleReport,
} from '../repository-intelligence.types.js';
import { computeIndexContentDigest } from './deterministic-context-ranker.js';
import { NoOpHostInspector } from './noop-host-inspector.js';
import { RepositoryIntelligenceError } from '@modules/projects/index.js';
import { randomUUID } from 'node:crypto';

export class DefaultRepositoryIntelligenceService implements RepositoryIntelligenceService {
  private readonly hostInspector;
  constructor(private readonly deps: RepositoryIntelligenceServiceDeps) {
    this.hostInspector = deps.hostInspector ?? new NoOpHostInspector();
  }

  async buildIndex(
    query: ContextIndexQuery,
    ctx: ContextResolutionContext,
  ): Promise<BuildIndexResult> {
    // 1. Resolve the baseline. MUST be 'complete' (an 'analyzing'/'failed'
    //    baseline cannot be indexed — its evidence is incomplete or
    //    inconsistent). The baseline carries the authoritative revision
    //    identity (baseline_commit_sha) + the tenant scope.
    const baseline = await ctx.projectBaselineRepository.findById(query.baselineId);
    if (!baseline) {
      throw new RepositoryIntelligenceError(
        'context-index-baseline-not-complete',
        `context-index-baseline-not-complete: baseline ${query.baselineId} does not exist`,
        { query },
      );
    }
    if (baseline.state !== 'complete') {
      throw new RepositoryIntelligenceError(
        'context-index-baseline-not-complete',
        `context-index-baseline-not-complete: baseline ${query.baselineId} state=${baseline.state} (only 'complete' baselines can be indexed)`,
        { query, baselineState: baseline.state },
      );
    }
    // TENANT ISOLATION (defense in depth — the route already checked
    // ownership). The baseline's projectId MUST match the query's projectId.
    if (baseline.projectId !== query.projectId) {
      throw new RepositoryIntelligenceError(
        'context-index-not-found',
        `context-index-not-found: baseline ${query.baselineId} belongs to project ${baseline.projectId}, not ${query.projectId} (tenant isolation)`,
        { query, baselineProjectId: baseline.projectId },
      );
    }

    // 2. Inspect host (OPTIONAL — the NoOp default returns '[]'
    //    toolInvocationIds; a real inspector returns honest IDs from
    //    ToolRuntime.invoke()). The orchestrator passes these through
    //    VERBATIM — NEVER fabricates.
    const hostResult = await this.hostInspector.inspect(query, ctx);

    // 3. Read candidates from the EXISTING authorities (read-only). The
    //    source carries provenance verbatim + authority_ref pointing back.
    const candidates = await this.deps.source.readCandidates(query, ctx);

    // 4. Rank (deterministic, explainable, NEVER promotes provenance).
    const ranked = await this.deps.ranker.rank(query, candidates);

    // 5. Compute the deterministic content_digest (sha256 of the canonical
    //    item set). Same baseline + same query → same digest (test invariant
    //    #1). Different revision → different baseline → different items →
    //    different digest (test invariant #3).
    const contentDigest = computeIndexContentDigest(query, ranked);

    // 6. ensureIndex (idempotent lookup-or-create on (baseline, query_kind,
    //    query_ref)). A re-build of the same baseline+query returns the SAME
    //    row.
    const ensureResult = await ctx.projectContextIndexRepository.ensureIndex({
      projectId: query.projectId,
      organizationId: ctx.organizationId,
      projectGithubRepositoryId: ctx.projectGithubRepositoryId,
      baselineId: query.baselineId,
      baselineCommitSha: baseline.baselineCommitSha,
      queryKind: query.kind,
      queryRef: query.queryRef,
      queryTermsJson: query.queryTerms as unknown as Record<string, unknown>,
      indexingRunId: randomUUID(),
      toolInvocationIds: hostResult.toolInvocationIds, // HONEST — passed through verbatim
    });

    // 7. If the index already exists + is 'complete', return it (idempotent —
    //    no rebuild). If 'indexing' (a concurrent job is running), return
    //    cas-lost (convergence — the caller observes the existing row). If
    //    terminal ('failed'/'stale'), the caller can detect + create a new
    //    index (different query_ref or a version bump — out of scope for
    //    this slice).
    if (ensureResult.kind === 'existing') {
      if (ensureResult.index.state === 'complete') {
        return { kind: 'complete', index: ensureResult.index };
      }
      if (ensureResult.index.state === 'indexing') {
        return { kind: 'cas-lost', index: ensureResult.index };
      }
      // terminal ('failed'/'stale') — return as cas-lost so the caller
      // reconciles (a future slice could auto-create a replacement).
      return { kind: 'cas-lost', index: ensureResult.index };
    }

    // 8. 'created' — this caller owns the indexing run. Drive the ranker
    //    output through markComplete (CAS + atomic item upserts in a SINGLE
    //    transaction). The SELECT FOR UPDATE on the index row fences
    //    concurrent indexing jobs (the loser sees cas-lost + reconciles).
    const completeResult = await ctx.projectContextIndexRepository.markComplete({
      indexId: ensureResult.index.id,
      expectedVersion: ensureResult.index.version,
      contentDigest,
      items: ranked.map((r) => ({
        kind: r.kind,
        locator: r.locator,
        source: r.source,
        provenance: r.provenance, // NEVER mutated
        contentDigest: r.contentDigest,
        redacted: r.redacted,
        relevanceScore: r.relevanceScore,
        relevanceReason: r.relevanceReason,
        evidenceRef: r.evidenceRef,
        authorityRef: r.authorityRef,
      })),
    });
    if (completeResult.kind === 'cas-lost') {
      return { kind: 'cas-lost', index: completeResult.index };
    }
    return { kind: 'complete', index: completeResult.index };
  }

  async retrieve(
    query: ContextIndexQuery,
    ctx: ContextResolutionContext,
  ): Promise<ContextSelection> {
    // 1. Look up the existing index for (project, query_kind, query_ref) —
    //    non-terminal only. NEVER silently swaps the baseline under the
    //    caller (the index is pinned to the caller's baselineId).
    const existing = await ctx.projectContextIndexRepository.findByQuery(
      query.projectId,
      query.kind,
      query.queryRef,
    );
    if (existing) {
      // Verify the index is for the caller's baseline (defense in depth —
      // the caller asked for baselineId; the index found by query must match).
      if (existing.baselineId !== query.baselineId) {
        // The caller asked for baseline B but a non-terminal index exists for
        // baseline A (different revision). Build a new index for baseline B
        // (the unique constraint is on (baseline_id, query_kind, query_ref)
        // — different baseline → different row).
        return this.buildAndRetrieve(query, ctx);
      }
      if (existing.state === 'complete') {
        const items = await ctx.projectContextIndexRepository.listItems(existing.id);
        return {
          index: existing,
          items,
          reason: `existing complete index for baseline ${existing.baselineCommitSha.slice(0, 12)} (retrieved; not rebuilt)`,
          freshlyBuilt: false,
        };
      }
      if (existing.state === 'indexing') {
        // Convergence — a concurrent job is indexing. Return the existing
        // row with empty items; the caller re-reads once indexing completes.
        return {
          index: existing,
          items: [],
          reason: 'indexing in progress (a concurrent job is building this index; re-read later)',
          freshlyBuilt: false,
        };
      }
      // terminal ('failed'/'stale') — return the existing row with empty
      // items + the terminal reason.
      return {
        index: existing,
        items: [],
        reason: `index is terminal (state=${existing.state}${existing.failureStage ? `, failureStage=${existing.failureStage}` : ''})`,
        freshlyBuilt: false,
      };
    }
    // 2. No existing index — build one.
    return this.buildAndRetrieve(query, ctx);
  }

  private async buildAndRetrieve(
    query: ContextIndexQuery,
    ctx: ContextResolutionContext,
  ): Promise<ContextSelection> {
    const result = await this.buildIndex(query, ctx);
    if (result.kind === 'complete') {
      const items = await ctx.projectContextIndexRepository.listItems(result.index.id);
      return {
        index: result.index,
        items,
        reason: `freshly built index for baseline ${result.index.baselineCommitSha.slice(0, 12)} (${items.length} items)`,
        freshlyBuilt: true,
      };
    }
    if (result.kind === 'cas-lost') {
      // Convergence — a concurrent job won. Return the existing row with
      // whatever items it has (empty if still indexing).
      const items = result.index.state === 'complete'
        ? await ctx.projectContextIndexRepository.listItems(result.index.id)
        : [];
      return {
        index: result.index,
        items,
        reason: `concurrent indexing in progress (state=${result.index.state}; re-read later)`,
        freshlyBuilt: false,
      };
    }
    // 'failed' — return the failed row with empty items + the failure stage.
    return {
      index: result.index,
      items: [],
      reason: `indexing failed (failureStage=${result.failureStage})`,
      freshlyBuilt: false,
    };
  }

  async detectStale(
    query: ContextIndexQuery,
    ctx: ContextResolutionContext,
  ): Promise<StaleReport> {
    // 1. Look up the index. If none exists, throw (the caller should build
    //    first OR the route returns 404).
    const index = await ctx.projectContextIndexRepository.findByQuery(
      query.projectId,
      query.kind,
      query.queryRef,
    );
    if (!index) {
      throw new RepositoryIntelligenceError(
        'context-index-not-found',
        `context-index-not-found: no index for project=${query.projectId} query=${query.kind}/${query.queryRef}`,
        { query },
      );
    }
    // 2. Resolve the current repo HEAD through /github (read-only). The
    //    baseline's commit is the pinned revision; the current HEAD is the
    //    advisory comparison point.
    let currentHeadSha: string | null = null;
    try {
      const branch = await ctx.githubAdapter.getBranch({
        owner: ctx.repositoryOwner,
        repository: ctx.repositoryName,
        branchName: 'main', // the default-branch HEAD — the canonical "current" revision
        installationId: ctx.installationId,
      });
      currentHeadSha = branch.sha;
    } catch (err) {
      // /github not configured or unavailable — currentHeadSha stays null;
      // the stale flag is conservatively false (we cannot prove staleness
      // without the current HEAD).
      this.deps.logger.warn('repository-intelligence: detectStale could not resolve current HEAD', {
        owner: ctx.repositoryOwner,
        repo: ctx.repositoryName,
        err: (err as Error).message,
      });
    }
    // 3. Compare. The index's baseline_commit_sha is immutable (pinned at
    //    creation); the current HEAD may have advanced.
    const stale = currentHeadSha !== null && currentHeadSha !== index.baselineCommitSha;
    return {
      index,
      baselineCommitSha: index.baselineCommitSha,
      currentHeadSha,
      stale,
    };
  }
}
