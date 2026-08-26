/**
 * WORK-039: DefaultRepositoryIntelligenceService — the application/context-
 * intelligence orchestrator.
 *
 * Composes the EXISTING authorities (read-only) to produce ranked, explainable,
 * provenance-preserving context selections stored THROUGH the existing
 * /projects authority (the context index is a PROJECT artifact, like
 * ProjectBaseline). The orchestrator owns NO tables.
 *
 *   buildIndex         — resolve baseline → verify 'complete' (tenant-isolation
 *                        check) → inspect host (optional; honest toolInvocationIds)
 *                        → read candidates → rank → compute content_digest →
 *                        ensureIndex (idempotent) → markComplete (CAS + atomic
 *                        item upserts). Idempotent per (baseline, query_kind,
 *                        query_ref); concurrent jobs converge (cas-lost).
 *                        CRASH RECOVERY: if ensureIndex returns an 'existing'
 *                        'indexing' row whose updated_at is older than the
 *                        indexing-staleness TTL (the run crashed after ensureIndex),
 *                        reclaimStaleIndexing takes ownership + re-drives
 *                        markComplete (a crashed run can NEVER permanently block
 *                        the same baseline+query).
 *   retrieve           — MUTATION (build-if-missing) for write-authorized
 *                        programmatic callers. NEVER used by the HTTP GET route
 *                        (which calls retrieveExisting — read-only).
 *   retrieveExisting   — READ-ONLY. Returns the existing selection for the
 *                        caller's baseline, or null if none (the caller POSTs to
 *                        build — the build is a write). A read-authorized caller
 *                        can NEVER trigger a state mutation through this method.
 *   detectStale        — load the index BY indexId (never re-query by query
 *                        tuple — that could inspect a different index) → resolve
 *                        the current HEAD of the repository authority's DEFAULT
 *                        branch (ctx.repositoryDefaultBranch — NEVER a hardcoded
 *                        'main') → compare. Advisory; the index is NEVER swapped.
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

/** The default indexing-staleness TTL: 5 minutes. A legitimate concurrent
 * indexing job completes well within this window; an 'indexing' row whose
 * updated_at is older than this is assumed to belong to a CRASHED run + is
 * reclaimable by a subsequent buildIndex. */
const DEFAULT_INDEXING_STALE_AFTER_MS = 5 * 60 * 1000;

export class DefaultRepositoryIntelligenceService implements RepositoryIntelligenceService {
  private readonly hostInspector;
  private readonly indexingStaleAfterMs: number;
  private readonly clock: () => number;
  constructor(private readonly deps: RepositoryIntelligenceServiceDeps) {
    this.hostInspector = deps.hostInspector ?? new NoOpHostInspector();
    this.indexingStaleAfterMs = deps.indexingStaleAfterMs ?? DEFAULT_INDEXING_STALE_AFTER_MS;
    this.clock = deps.clock ?? (() => Date.now());
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
    //    row. The indexingRunId is THIS caller's run id — a fresh UUID every
    //    buildIndex call (it becomes the ownership marker for reclaim).
    const indexingRunId = randomUUID();
    const ensureResult = await ctx.projectContextIndexRepository.ensureIndex({
      projectId: query.projectId,
      organizationId: ctx.organizationId,
      projectGithubRepositoryId: ctx.projectGithubRepositoryId,
      baselineId: query.baselineId,
      baselineCommitSha: baseline.baselineCommitSha,
      queryKind: query.kind,
      queryRef: query.queryRef,
      queryTermsJson: query.queryTerms as unknown as Record<string, unknown>,
      indexingRunId,
      toolInvocationIds: hostResult.toolInvocationIds, // HONEST — passed through verbatim
    });

    // 7. If the index already exists + is 'complete', return it (idempotent —
    //    no rebuild). If terminal ('failed'/'stale'), return as cas-lost so the
    //    caller reconciles.
    if (ensureResult.kind === 'existing') {
      if (ensureResult.index.state === 'complete') {
        return { kind: 'complete', index: ensureResult.index };
      }
      // CRASH RECOVERY (the round-2 PR #43 fix). An 'indexing' row whose
      // updated_at is older than the indexing-staleness TTL belongs to a run
      // that CRASHED after ensureIndex (a live run would have completed or
      // touched the row within the TTL). reclaimStaleIndexing takes ownership
      // (CAS: state='indexing' + version=expected → bump indexing_run_id to
      // THIS caller's run + version+1) + we re-drive markComplete. Without
      // this, a crash after ensureIndex leaves the row permanently 'indexing'
      // → every subsequent buildIndex returns cas-lost forever → the
      // (baseline, query) is permanently un-indexable. Two concurrent
      // reclaims converge (reclaimStaleIndexing is a CAS — only one wins; the
      // loser gets null → returns cas-lost + reconciles).
      if (ensureResult.index.state === 'indexing') {
        const reclaimed = await this.attemptReclaimAndComplete(
          ctx,
          ensureResult.index,
          indexingRunId,
          contentDigest,
          ranked,
        );
        if (reclaimed !== null) return reclaimed;
        // reclaim did not take ownership (another run won it OR it completed)
        // → converge: return cas-lost so the caller re-reads.
        const after = await ctx.projectContextIndexRepository.findById(ensureResult.index.id);
        return { kind: 'cas-lost', index: after ?? ensureResult.index };
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

  /**
   * CRASH RECOVERY. Attempt to reclaim a stuck 'indexing' row (whose run is
   * no longer live, per the staleness TTL) + drive markComplete. Returns the
   * BuildIndexResult on success, or null if this caller did NOT take
   * ownership (the row is no longer 'indexing' — another run won it OR it
   * completed — the caller converges via cas-lost).
   *
   * The TTL check (this.isStaleIndexing) is what makes this SAFE against
   * legitimate concurrent indexing: a live run that started milliseconds ago
   * is NOT stale → not reclaimed → converges via the normal cas-lost path.
   * Only rows whose updated_at predates the TTL (a crashed run) are reclaimed.
   */
  private async attemptReclaimAndComplete(
    ctx: ContextResolutionContext,
    stuck: { id: string; version: number; updatedAt: Date; indexingRunId: string | null },
    newIndexingRunId: string,
    contentDigest: string,
    ranked: readonly import('../repository-intelligence.types.js').RankedContextItem[],
  ): Promise<BuildIndexResult | null> {
    if (!this.isStaleIndexing(stuck.updatedAt)) {
      // A genuinely-concurrent live run — do NOT reclaim. Converge.
      return null;
    }
    const reclaimed = await ctx.projectContextIndexRepository.reclaimStaleIndexing(
      stuck.id,
      newIndexingRunId,
      stuck.version,
    );
    if (reclaimed === null) {
      // Another concurrent reclaimer won OR the row completed — converge.
      return null;
    }
    // This caller now owns the run (reclaimed.indexingRunId === newIndexingRunId;
    // version bumped). Drive markComplete with the reclaimed version.
    const completeResult = await ctx.projectContextIndexRepository.markComplete({
      indexId: reclaimed.id,
      expectedVersion: reclaimed.version,
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

  /**
   * An 'indexing' row is stale (its run crashed) iff its updated_at is older
   * than the indexing-staleness TTL. A live run completes well within the TTL.
   * The TTL is configurable (indexingStaleAfterMs); the clock is injectable
   * (deps.clock, defaults to Date.now) so tests can simulate elapsed time
   * WITHOUT waiting in real time AND without SQL aging (the touch trigger on
   * wfos_project_context_indices resets updated_at = NOW() on every UPDATE,
   * defeating SQL aging).
   */
  private isStaleIndexing(updatedAt: Date): boolean {
    const ageMs = this.clock() - updatedAt.getTime();
    return ageMs > this.indexingStaleAfterMs;
  }

  async retrieve(
    query: ContextIndexQuery,
    ctx: ContextResolutionContext,
  ): Promise<ContextSelection> {
    // MUTATION (build-if-missing) — see the interface JSDoc. The HTTP GET
    // route MUST NOT call this; it calls retrieveExisting (read-only).
    // 1. Look up the existing index for (project, query_kind, query_ref).
    //    NEVER silently swaps the baseline under the caller (the index is
    //    pinned to the caller's baselineId).
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

  async retrieveExisting(
    query: ContextIndexQuery,
    ctx: ContextResolutionContext,
  ): Promise<ContextSelection | null> {
    // READ-ONLY. Never builds, never mutates. Returns null iff no
    // non-terminal index exists for the caller's baseline (the caller must
    // POST to build — the build is a write). A read-authorized caller can
    // NEVER trigger a state mutation through this method.
    const existing = await ctx.projectContextIndexRepository.findByQuery(
      query.projectId,
      query.kind,
      query.queryRef,
    );
    if (!existing) return null;
    // The caller asked for baseline B; an index exists for baseline A
    // (different revision) → there is no index for the caller's baseline.
    if (existing.baselineId !== query.baselineId) return null;
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
      // Convergence — a concurrent job is indexing. Return the existing row
      // with empty items. This is NOT a mutation (the row was created by a
      // prior write-authorized caller; this call only reads it).
      return {
        index: existing,
        items: [],
        reason: 'indexing in progress (a concurrent job is building this index; re-read later)',
        freshlyBuilt: false,
      };
    }
    // terminal ('failed'/'stale') — return the existing row with empty items.
    return {
      index: existing,
      items: [],
      reason: `index is terminal (state=${existing.state}${existing.failureStage ? `, failureStage=${existing.failureStage}` : ''})`,
      freshlyBuilt: false,
    };
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
    indexId: string,
    ctx: ContextResolutionContext,
  ): Promise<StaleReport> {
    // 1. Load the index BY indexId (NOT by query tuple). The stale route
    //    receives indexId from the path + has already verified ownership; we
    //    re-load by id here (defense in depth — the orchestrator is
    //    authoritative about WHICH index it reports on). Re-querying by
    //    (project, queryKind, queryRef) could inspect a DIFFERENT index than
    //    the one the caller asked about (multiple indices can match the same
    //    query tuple — e.g. a terminal 'stale' one + a fresh 'complete' one).
    const index = await ctx.projectContextIndexRepository.findById(indexId);
    if (!index) {
      throw new RepositoryIntelligenceError(
        'context-index-not-found',
        `context-index-not-found: no index for indexId=${indexId}`,
        { indexId },
      );
    }
    // 2. Resolve the current HEAD of the repository authority's DEFAULT
    //    branch through /github (read-only). The branch name is the /github
    //    authority's defaultBranch (ctx.repositoryDefaultBranch) — NEVER a
    //    hardcoded 'main' (a repo whose default branch is 'develop' must
    //    compare against 'develop's HEAD). The baseline's commit is the
    //    pinned revision; the current HEAD is the advisory comparison point.
    let currentHeadSha: string | null = null;
    try {
      const branch = await ctx.githubAdapter.getBranch({
        owner: ctx.repositoryOwner,
        repository: ctx.repositoryName,
        branchName: ctx.repositoryDefaultBranch,
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
        branch: ctx.repositoryDefaultBranch,
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
