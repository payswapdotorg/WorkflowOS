/**
 * WORK-039: PgProjectContextIndexRepository — the durable context-index
 * boundary (the revision-bound, explainable, provenance-preserving context
 * layer stored THROUGH the existing /projects authority).
 *
 * Mechanical properties (migration 0041's triggers are the backstop):
 *   * ensureIndex is lookup-or-create (UNIQUE(baseline, query_kind, query_ref)
 *     — a retry after "index created → crash" returns the SAME row: no second
 *     index; the exact revision + query shape are recorded on first creation
 *     and are immutable thereafter);
 *   * every state transition is a repository-level CAS (version + state
 *     predicate; lost CAS → cas-lost — convergence, the caller observes the
 *     winner's row);
 *   * items are upserted idempotently on (index, locator, source, kind) — a
 *     re-drive of the same indexing run appends no duplicates (crash/retry
 *     safe);
 *   * markComplete wraps the SELECT FOR UPDATE + the idempotent item upserts
 *     + the CAS complete in a SINGLE transaction (concurrent indexing jobs
 *     serialize on the index row lock — the loser sees cas-lost + reconciles).
 *
 * Boundary: internal/ — persistence only. Never mutates workflow /
 * verification / review / architecture-frozen state; never imports provider
 * SDKs; never stores credentials (the capability operates on already-redacted
 * baseline evidence — the redacted flag is preserved, never reversed).
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  ProjectContextIndex,
  ContextItem,
  ContextItemKind,
  ContextItemSource,
  ContextItemProvenance,
  ContextIndexQueryKind,
  ContextIndexState,
  ProjectContextIndexRepository,
  EnsureContextIndexInput,
  EnsureContextIndexResult,
  MarkContextIndexCompleteInput,
  MarkContextIndexCompleteResult,
  MarkContextIndexFailedInput,
  MarkContextIndexStaleInput,
  NewContextItem,
} from './project-context-index.types.js';
import { RepositoryIntelligenceError } from './project-context-index.types.js';

/**
 * A "queryable" — either the {@link DatabaseClient} (pool-backed) or a
 * transaction-scoped {@link DatabaseTx} (the connection-bound handle passed to
 * `db.transaction()`'s callback). Mirrors the WORK-038 `Queryable` in
 * pg-project-baseline-repository.ts — keeps the /projects module free of a
 * direct `pg` dependency (the same convention every other `pg-*.ts` repository
 * in /modules follows).
 */
interface Queryable {
  query: DatabaseClient['query'];
}

const INDEX_COLUMNS = `id, project_id, organization_id, project_github_repository_id,
       baseline_id, baseline_commit_sha, content_digest, query_kind, query_ref,
       query_terms_json, state, version, indexing_run_id, tool_invocation_ids,
       failure_stage, created_at, updated_at, finalized_at, terminal_at`;

const ITEM_COLUMNS = `id, project_id, organization_id, context_index_id, baseline_id,
       kind, locator, source, provenance, content_digest, redacted,
       relevance_score, relevance_reason, evidence_ref, authority_ref, created_at`;

interface IndexRow {
  id: string;
  project_id: string;
  organization_id: string;
  project_github_repository_id: string;
  baseline_id: string;
  baseline_commit_sha: string;
  content_digest: string | null;
  query_kind: string;
  query_ref: string | null;
  query_terms_json: Record<string, unknown> | string;
  state: string;
  version: number;
  indexing_run_id: string | null;
  tool_invocation_ids: string[] | string;
  failure_stage: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  finalized_at: Date | string | null;
  terminal_at: Date | string | null;
}

interface ItemRow {
  id: string;
  project_id: string;
  organization_id: string;
  context_index_id: string;
  baseline_id: string;
  kind: string;
  locator: string;
  source: string;
  provenance: string;
  content_digest: string | null;
  redacted: boolean;
  relevance_score: number;
  relevance_reason: string;
  evidence_ref: string[] | string;
  authority_ref: Record<string, unknown> | string;
  created_at: Date | string;
}

function asJson<T>(v: T | string): T {
  if (typeof v === 'string') {
    return JSON.parse(v) as T;
  }
  return v;
}

function mapIndex(row: IndexRow): ProjectContextIndex {
  return {
    id: row.id,
    projectId: row.project_id,
    organizationId: row.organization_id,
    projectGithubRepositoryId: row.project_github_repository_id,
    baselineId: row.baseline_id,
    baselineCommitSha: row.baseline_commit_sha,
    contentDigest: row.content_digest,
    queryKind: row.query_kind as ContextIndexQueryKind,
    queryRef: row.query_ref,
    queryTermsJson: asJson<Record<string, unknown>>(row.query_terms_json),
    state: row.state as ContextIndexState,
    version: row.version,
    indexingRunId: row.indexing_run_id,
    toolInvocationIds: asJson<string[]>(row.tool_invocation_ids),
    failureStage: row.failure_stage,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    finalizedAt: row.finalized_at ? new Date(row.finalized_at) : null,
    terminalAt: row.terminal_at ? new Date(row.terminal_at) : null,
  };
}

function mapItem(row: ItemRow): ContextItem {
  return {
    id: row.id,
    projectId: row.project_id,
    organizationId: row.organization_id,
    contextIndexId: row.context_index_id,
    baselineId: row.baseline_id,
    kind: row.kind as ContextItemKind,
    locator: row.locator,
    source: row.source as ContextItemSource,
    provenance: row.provenance as ContextItemProvenance,
    contentDigest: row.content_digest,
    redacted: row.redacted,
    relevanceScore: row.relevance_score,
    relevanceReason: row.relevance_reason,
    evidenceRef: asJson<string[]>(row.evidence_ref),
    authorityRef: asJson<Record<string, unknown>>(row.authority_ref),
    createdAt: new Date(row.created_at),
  };
}

/**
 * The control-flow signal for a lost CAS (the public method translates this to
 * the typed { kind: 'cas-lost' } result). Thrown inside the transaction so the
 * rollback is automatic (no partial writes leak).
 */
class CasLostSignal extends Error {
  constructor(readonly index: ProjectContextIndex) {
    super('context-index-cas-lost');
    this.name = 'CasLostSignal';
  }
}

export class PgProjectContextIndexRepository implements ProjectContextIndexRepository {
  constructor(private readonly db: DatabaseClient) {}

  async ensureIndex(input: EnsureContextIndexInput): Promise<EnsureContextIndexResult> {
    // Idempotent lookup-or-create on UNIQUE(baseline_id, query_kind, query_ref).
    // ON CONFLICT DO NOTHING + re-select avoids a read-check-write race: two
    // concurrent ensures converge on the same row.
    await this.db.query(
      `INSERT INTO wfos_project_context_indices
         (project_id, organization_id, project_github_repository_id,
          baseline_id, baseline_commit_sha, query_kind, query_ref,
          query_terms_json, state, version, indexing_run_id, tool_invocation_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'indexing', 0, $9, $10)
       ON CONFLICT (baseline_id, query_kind, query_ref) DO NOTHING`,
      [
        input.projectId,
        input.organizationId,
        input.projectGithubRepositoryId,
        input.baselineId,
        input.baselineCommitSha,
        input.queryKind,
        input.queryRef,
        JSON.stringify(input.queryTermsJson),
        input.indexingRunId,
        JSON.stringify(input.toolInvocationIds),
      ],
    );
    const r = await this.db.query<IndexRow>(
      `SELECT ${INDEX_COLUMNS} FROM wfos_project_context_indices
        WHERE baseline_id = $1 AND query_kind = $2
          AND (query_ref IS NOT DISTINCT FROM $3)`,
      [input.baselineId, input.queryKind, input.queryRef],
    );
    if (r.rowCount === 0 || !r.rows[0]) {
      // The ON CONFLICT DO NOTHING guarantees a row exists here; if not, the
      // trigger rejected the insert (an invariant violation — fail closed).
      throw new RepositoryIntelligenceError(
        'context-index-not-found',
        `context-index-not-found: ensureIndex insert+select did not yield a row for baseline=${input.baselineId} query=${input.queryKind}/${input.queryRef}`,
        { input },
      );
    }
    const index = mapIndex(r.rows[0]!);
    // If WE created the row (our run id matches), it's 'created'. If a row
    // already existed (different run id, or same run re-driving), it's
    // 'existing' — the caller reconciles (re-use if complete, re-drive if
    // reclaimable).
    const created = index.indexingRunId === input.indexingRunId && index.version === 0;
    return created ? { kind: 'created', index } : { kind: 'existing', index };
  }

  async findById(indexId: string): Promise<ProjectContextIndex | null> {
    const r = await this.db.query<IndexRow>(
      `SELECT ${INDEX_COLUMNS} FROM wfos_project_context_indices WHERE id = $1`,
      [indexId],
    );
    return r.rowCount && r.rows[0] ? mapIndex(r.rows[0]) : null;
  }

  async findByQuery(
    projectId: string,
    queryKind: ContextIndexQueryKind,
    queryRef: string | null,
  ): Promise<ProjectContextIndex | null> {
    // Return the most recent index for (project, query_kind, query_ref),
    // regardless of terminal status — a 'complete' index IS terminal
    // (terminal_at is set on completion) but is the CURRENT index the caller
    // wants. The caller detects the state (complete / indexing / failed /
    // stale) + reconciles.
    const r = await this.db.query<IndexRow>(
      `SELECT ${INDEX_COLUMNS} FROM wfos_project_context_indices
        WHERE project_id = $1 AND query_kind = $2
          AND (query_ref IS NOT DISTINCT FROM $3)
        ORDER BY created_at DESC LIMIT 1`,
      [projectId, queryKind, queryRef],
    );
    return r.rowCount && r.rows[0] ? mapIndex(r.rows[0]) : null;
  }

  async listForBaseline(baselineId: string): Promise<ProjectContextIndex[]> {
    const r = await this.db.query<IndexRow>(
      `SELECT ${INDEX_COLUMNS} FROM wfos_project_context_indices
        WHERE baseline_id = $1 ORDER BY created_at DESC`,
      [baselineId],
    );
    return r.rows.map(mapIndex);
  }

  async listForProject(projectId: string): Promise<ProjectContextIndex[]> {
    const r = await this.db.query<IndexRow>(
      `SELECT ${INDEX_COLUMNS} FROM wfos_project_context_indices
        WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId],
    );
    return r.rows.map(mapIndex);
  }

  async listItems(indexId: string): Promise<ContextItem[]> {
    const r = await this.db.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM wfos_project_context_items
        WHERE context_index_id = $1
        ORDER BY relevance_score DESC, created_at ASC`,
      [indexId],
    );
    return r.rows.map(mapItem);
  }

  async markComplete(
    input: MarkContextIndexCompleteInput,
  ): Promise<MarkContextIndexCompleteResult> {
    try {
      return await this.db.transaction(async (tx) => {
        // SELECT FOR UPDATE on the index row — fences concurrent indexing
        // jobs (the loser waits, then sees the winner's `complete` state +
        // re-reads its items → cas-lost). Mirrors the WORK-038 fence.
        const r = await tx.query<IndexRow>(
          `SELECT ${INDEX_COLUMNS} FROM wfos_project_context_indices
            WHERE id = $1 FOR UPDATE`,
          [input.indexId],
        );
        if (r.rowCount === 0 || !r.rows[0]) {
          throw new RepositoryIntelligenceError(
            'context-index-not-found',
            `context-index-not-found: markComplete could not SELECT FOR UPDATE index=${input.indexId}`,
            { input },
          );
        }
        const current = mapIndex(r.rows[0]!);
        if (current.state !== 'indexing') {
          // Terminal or already complete — the caller lost the CAS.
          throw new CasLostSignal(current);
        }
        if (current.version !== input.expectedVersion) {
          throw new CasLostSignal(current);
        }
        // Idempotent item upserts (ON CONFLICT DO NOTHING on
        // (context_index_id, locator, source, kind) — a re-drive of the same
        // run appends no duplicates; crash/retry safe).
        for (const item of input.items) {
          await this.insertItemIn(tx, input.indexId, current, item);
        }
        // CAS complete: version bump + state transition. The trigger enforces
        // the legal edge (indexing → complete) + content_digest exactly-on-
        // complete + terminal_at consistency.
        const upd = await tx.query<IndexRow>(
          `UPDATE wfos_project_context_indices
             SET state = 'complete', content_digest = $1,
                 version = $2 + 1, finalized_at = NOW(), terminal_at = NOW()
           WHERE id = $3 AND version = $2 AND state = 'indexing'
           RETURNING ${INDEX_COLUMNS}`,
          [input.contentDigest, input.expectedVersion, input.indexId],
        );
        if (upd.rowCount === 0 || !upd.rows[0]) {
          // Lost the CAS (a concurrent run completed first).
          const after = await tx.query<IndexRow>(
            `SELECT ${INDEX_COLUMNS} FROM wfos_project_context_indices WHERE id = $1`,
            [input.indexId],
          );
          throw new CasLostSignal(mapIndex(after.rows[0]!));
        }
        const completed = mapIndex(upd.rows[0]!);
        // Re-read the items (the idempotent upserts above made them durable;
        // re-reading inside the tx guarantees the caller sees the exact set
        // that landed, ordered by relevance_score DESC).
        const itemsR = await tx.query<ItemRow>(
          `SELECT ${ITEM_COLUMNS} FROM wfos_project_context_items
            WHERE context_index_id = $1
            ORDER BY relevance_score DESC, created_at ASC`,
          [input.indexId],
        );
        return { kind: 'complete', index: completed, items: itemsR.rows.map(mapItem) };
      });
    } catch (err) {
      if (err instanceof CasLostSignal) {
        return { kind: 'cas-lost', index: err.index };
      }
      throw err;
    }
  }

  async markFailed(input: MarkContextIndexFailedInput): Promise<ProjectContextIndex> {
    const r = await this.db.query<IndexRow>(
      `UPDATE wfos_project_context_indices
         SET state = 'failed', failure_stage = $1,
             version = $2 + 1, finalized_at = NOW(), terminal_at = NOW()
       WHERE id = $3 AND version = $2 AND state = 'indexing'
       RETURNING ${INDEX_COLUMNS}`,
      [input.failureStage, input.expectedVersion, input.indexId],
    );
    if (r.rowCount === 0 || !r.rows[0]) {
      // Lost the CAS OR the index doesn't exist OR it's already terminal.
      const existing = await this.findById(input.indexId);
      if (!existing) {
        throw new RepositoryIntelligenceError(
          'context-index-not-found',
          `context-index-not-found: markFailed index=${input.indexId}`,
          { input },
        );
      }
      if (existing.terminalAt !== null) {
        throw new RepositoryIntelligenceError(
          'context-index-terminal',
          `context-index-terminal: markFailed index=${input.indexId} is terminal (state=${existing.state})`,
          { input, existing },
        );
      }
      throw new RepositoryIntelligenceError(
        'context-index-cas-lost',
        `context-index-cas-lost: markFailed index=${input.indexId} expectedVersion=${input.expectedVersion} actual=${existing.version}`,
        { input, existing },
      );
    }
    return mapIndex(r.rows[0]!);
  }

  async markStale(input: MarkContextIndexStaleInput): Promise<ProjectContextIndex> {
    const r = await this.db.query<IndexRow>(
      `UPDATE wfos_project_context_indices
         SET state = 'stale',
             version = $1 + 1, finalized_at = NOW(), terminal_at = NOW()
       WHERE id = $2 AND version = $1 AND state = 'indexing'
       RETURNING ${INDEX_COLUMNS}`,
      [input.expectedVersion, input.indexId],
    );
    if (r.rowCount === 0 || !r.rows[0]) {
      const existing = await this.findById(input.indexId);
      if (!existing) {
        throw new RepositoryIntelligenceError(
          'context-index-not-found',
          `context-index-not-found: markStale index=${input.indexId}`,
          { input },
        );
      }
      if (existing.terminalAt !== null) {
        throw new RepositoryIntelligenceError(
          'context-index-terminal',
          `context-index-terminal: markStale index=${input.indexId} is terminal (state=${existing.state})`,
          { input, existing },
        );
      }
      throw new RepositoryIntelligenceError(
        'context-index-cas-lost',
        `context-index-cas-lost: markStale index=${input.indexId} expectedVersion=${input.expectedVersion} actual=${existing.version}`,
        { input, existing },
      );
    }
    return mapIndex(r.rows[0]!);
  }

  async reclaimStaleIndexing(
    indexId: string,
    newIndexingRunId: string,
    expectedVersion: number,
  ): Promise<ProjectContextIndex | null> {
    // Reclaim an 'indexing' row whose run is no longer live (crash recovery).
    // CAS: state='indexing' (still in-flight) + version=expectedVersion →
    // bump indexing_run_id (take ownership) + version+1. The caller then
    // re-drives the ranker + markComplete. Returns null if the row is no
    // longer 'indexing' (another run won it OR it already completed).
    const r = await this.db.query<IndexRow>(
      `UPDATE wfos_project_context_indices
         SET indexing_run_id = $1, version = $2 + 1
       WHERE id = $3 AND version = $2 AND state = 'indexing'
       RETURNING ${INDEX_COLUMNS}`,
      [newIndexingRunId, expectedVersion, indexId],
    );
    if (r.rowCount === 0 || !r.rows[0]) return null;
    return mapIndex(r.rows[0]!);
  }

  /**
   * The idempotent item insert (ON CONFLICT DO NOTHING on
   * (context_index_id, locator, source, kind) — a re-drive of the same run
   * appends no duplicates). Runs against either the pool OR a transaction-
   * scoped tx (the markComplete path calls it with the tx-scoped queryable so
   * the writes are atomic with the fence checks).
   */
  private async insertItemIn(
    q: Queryable,
    indexId: string,
    index: ProjectContextIndex,
    item: NewContextItem,
  ): Promise<void> {
    await q.query(
      `INSERT INTO wfos_project_context_items
         (project_id, organization_id, context_index_id, baseline_id,
          kind, locator, source, provenance, content_digest, redacted,
          relevance_score, relevance_reason, evidence_ref, authority_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (context_index_id, locator, source, kind) DO NOTHING`,
      [
        index.projectId,
        index.organizationId,
        indexId,
        index.baselineId,
        item.kind,
        item.locator,
        item.source,
        item.provenance,
        item.contentDigest,
        item.redacted,
        item.relevanceScore,
        item.relevanceReason,
        JSON.stringify(item.evidenceRef),
        JSON.stringify(item.authorityRef),
      ],
    );
  }
}
