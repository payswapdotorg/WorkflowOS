/**
 * WORK-038: PgProjectBaselineRepository — the durable Project Baseline boundary.
 *
 * Mechanical properties (migration 0038's triggers are the backstop):
 *   * ensureBaseline is lookup-or-create (UNIQUE(project, repo, commit) — a
 *     retry after "record created → crash" returns the SAME row: no second
 *     baseline; the exact revision is recorded on first creation and is
 *     immutable thereafter — retries never re-resolve and never diverge);
 *   * every state transition is a repository-level CAS (version + state
 *     predicate; lost CAS → null — convergence, the caller observes the
 *     winner's row);
 *   * observations are upserted idempotently on (baseline, kind, claim_digest)
 *     — a re-analyze of the same revision appends no duplicates;
 *   * the authorized confirmation path (confirmObservation) issues the
 *     provenance transition inferred/proposed → confirmed + confirmed_by/at;
 *     the observation-guard trigger is the final backstop (no silent promotion);
 *   * a failed baseline NEVER carries a confirmed observation — markComplete
 *     refuses if any observation is confirmed (failed analysis cannot produce
 *     a false confirmed baseline).
 *
 * Boundary: internal/ — persistence only. Never mutates workflow / verification
 * / review / architecture-frozen state; never imports provider SDKs; never
 * stores credentials (secret-shaped content is redacted before persistence by
 * the onboarding orchestrator using the platform observation-redaction util).
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  ProjectBaseline,
  BaselineObservation,
  BaselineEvidence,
  ProjectBaselineRepository,
  EnsureBaselineInput,
  NewBaselineObservation,
  NewBaselineEvidence,
  BaselineProvenance,
  BaselineObservationKind,
  BaselineEvidenceSource,
  BaselineState,
  BaselineAnalysisMode,
  RepositoryReadEnforcement,
  PersistBaselineInput,
  PersistBaselineResult,
  PersistencePolicySnapshot,
} from './project-baseline.types.js';
import { ProjectBaselineError } from './project-baseline.types.js';

/**
 * A "queryable" — either the {@link DatabaseClient} (pool-backed) or a
 * transaction-scoped {@link DatabaseTx} (the connection-bound handle passed to
 * `db.transaction()`'s callback). Both expose the same `query` API, so the
 * private `*In(q, ...)` helpers can run against either (the round-5 fenced
 * persist runs them inside a transaction; the legacy public methods run them
 * against the pool — identical SQL, identical semantics). Using a structural
 * type (rather than importing `pg`'s `QueryResult`/`QueryResultRow` directly)
 * keeps the /projects module free of a direct `pg` dependency — the same
 * convention every other `pg-*.ts` repository in /modules follows.
 */
interface Queryable {
  query: DatabaseClient['query'];
}

const BASELINE_COLUMNS = `id, project_id, organization_id, project_github_repository_id,
       repository_owner, repository_name, baseline_commit_sha, revision_ref,
       state, version, analysis_mode, content_digest, failure_stage,
       analysis_run_id, created_at, updated_at, finalized_at, terminal_at`;

interface BaselineRow {
  id: string;
  project_id: string;
  organization_id: string;
  project_github_repository_id: string;
  repository_owner: string;
  repository_name: string;
  baseline_commit_sha: string;
  revision_ref: string;
  state: string;
  version: number;
  analysis_mode: string;
  content_digest: string | null;
  failure_stage: string | null;
  analysis_run_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  finalized_at: Date | string | null;
  terminal_at: Date | string | null;
}

interface ObservationRow {
  id: string;
  baseline_id: string;
  kind: string;
  provenance: string;
  claim: Record<string, unknown>;
  claim_digest: string;
  evidence_ref: string[] | { id: string }[] | unknown;
  confirmed_by: string | null;
  confirmed_at: Date | string | null;
  created_at: Date | string;
}

interface EvidenceRow {
  id: string;
  baseline_id: string;
  source: string;
  locator: string;
  content_digest: string | null;
  redacted: boolean;
  tool_invocation_id: string | null;
  policy_decision: string | null;
  // PR #42 round-3 (the governed repository-read boundary): the WORK-037
  // decideForProjectScope decision + the concrete enforcement effect, recorded
  // in their OWN columns (distinct from the Tool Runtime columns).
  repository_read_decision: string | null;
  repository_read_enforcement: Record<string, unknown> | null;
  observed_at: Date | string;
  created_at: Date | string;
}

function asDate(v: Date | string | null): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(v);
}

function mapBaseline(r: BaselineRow): ProjectBaseline {
  return {
    id: r.id,
    projectId: r.project_id,
    organizationId: r.organization_id,
    projectGithubRepositoryId: r.project_github_repository_id,
    repositoryOwner: r.repository_owner,
    repositoryName: r.repository_name,
    baselineCommitSha: r.baseline_commit_sha,
    revisionRef: r.revision_ref,
    state: r.state as BaselineState,
    version: r.version,
    analysisMode: r.analysis_mode as BaselineAnalysisMode,
    contentDigest: r.content_digest,
    failureStage: r.failure_stage,
    analysisRunId: r.analysis_run_id,
    createdAt: asDate(r.created_at)!,
    updatedAt: asDate(r.updated_at)!,
    finalizedAt: asDate(r.finalized_at),
    terminalAt: asDate(r.terminal_at),
  };
}

function mapEvidenceRef(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => (typeof v === 'string' ? v : (v as { id?: string }).id ?? '')).filter(Boolean);
}

function mapObservation(r: ObservationRow): BaselineObservation {
  return {
    id: r.id,
    baselineId: r.baseline_id,
    kind: r.kind as BaselineObservationKind,
    provenance: r.provenance as BaselineProvenance,
    claim: r.claim,
    claimDigest: r.claim_digest,
    evidenceRef: mapEvidenceRef(r.evidence_ref),
    confirmedBy: r.confirmed_by,
    confirmedAt: asDate(r.confirmed_at),
    createdAt: asDate(r.created_at)!,
  };
}

function mapEnforcement(raw: Record<string, unknown> | null): RepositoryReadEnforcement | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  return {
    policyVersion: typeof v.policyVersion === 'number' ? v.policyVersion : null,
    ruleId: typeof v.ruleId === 'string' ? v.ruleId : null,
    performed: v.performed === true,
    truncated: v.truncated === true,
    maxOutputBytes: typeof v.maxOutputBytes === 'number' ? v.maxOutputBytes : null,
    truncatedAtBytes: typeof v.truncatedAtBytes === 'number' ? v.truncatedAtBytes : null,
    pathAllowed: v.pathAllowed === true,
    reason: typeof v.reason === 'string' ? v.reason : null,
    // PR #42 round-4 (the snapshot/fencing protocol): the revalidation
    // metadata + the stale flag. Older evidence rows (persisted before
    // round-4) will not have these fields — the mapper defaults them to
    // null/false (revalidated=false, stale=false — honestly "this row was
    // persisted before the fence existed"). New rows (persisted by the
    // round-4 boundary) carry the real values.
    revalidated: v.revalidated === true,
    revalidatedPolicyVersion:
      typeof v.revalidatedPolicyVersion === 'number' ? v.revalidatedPolicyVersion : null,
    revalidatedRuleId:
      typeof v.revalidatedRuleId === 'string' ? v.revalidatedRuleId : null,
    revalidatedDecision:
      v.revalidatedDecision === 'allow' ||
      v.revalidatedDecision === 'constrained' ||
      v.revalidatedDecision === 'deny' ||
      v.revalidatedDecision === 'ask'
        ? v.revalidatedDecision
        : null,
    stale: v.stale === true,
  };
}

function mapEvidence(r: EvidenceRow): BaselineEvidence {
  return {
    id: r.id,
    baselineId: r.baseline_id,
    source: r.source as BaselineEvidenceSource,
    locator: r.locator,
    contentDigest: r.content_digest,
    redacted: r.redacted,
    toolInvocationId: r.tool_invocation_id,
    policyDecision: (r.policy_decision ?? null) as BaselineEvidence['policyDecision'],
    // PR #42 round-3: the governed repository-read decision + enforcement.
    repositoryReadDecision:
      (r.repository_read_decision ?? null) as BaselineEvidence['repositoryReadDecision'],
    repositoryReadEnforcement: mapEnforcement(
      (r.repository_read_enforcement ?? null) as Record<string, unknown> | null,
    ),
    observedAt: asDate(r.observed_at)!,
    createdAt: asDate(r.created_at)!,
  };
}

/**
 * PR #42 round-5: determine whether the persistence-boundary snapshot is
 * STALE relative to a revalidation. Mirrors the round-4 `isSnapshotStale`
 * logic in the governed-read boundary: compare version (primary) + ruleId
 * (defense-in-depth) + decision (defense-in-depth — last resort). When the
 * gate surfaces no version on either side, the fence falls back to
 * ruleId + decision comparison.
 */
function isPersistenceSnapshotStale(
  snapshot: PersistencePolicySnapshot,
  revalidation: PersistencePolicySnapshot,
): boolean {
  // Primary signal: the policy version changed (the WORK-037 store bumps
  // policy_version on every document mutation — a version change is the
  // definitive signal that the policy document the snapshot was captured
  // against is no longer current).
  if (
    snapshot.policyVersion !== null &&
    revalidation.policyVersion !== null &&
    snapshot.policyVersion !== revalidation.policyVersion
  ) {
    return true;
  }
  // Defense-in-depth: the matched rule id changed (a rule replacement
  // without a version bump would be an engine bug, but the fence catches it).
  if (
    (snapshot.ruleId !== null || revalidation.ruleId !== null) &&
    snapshot.ruleId !== revalidation.ruleId
  ) {
    return true;
  }
  // Defense-in-depth: the decision itself changed (an allow→deny flip
  // without a version/rule change would be an engine bug, but the fence
  // catches it). This is the last-resort signal when the gate surfaces no
  // version AND no ruleId.
  if (
    (snapshot.decision !== null || revalidation.decision !== null) &&
    snapshot.decision !== revalidation.decision
  ) {
    return true;
  }
  return false;
}

/**
 * PR #42 round-5: the internal sentinel thrown inside the
 * `persistBaselineWithPolicyFence` transaction to abort it (the
 * throw-to-rollback pattern). The outer catch translates this to the public
 * `PersistBaselineResult` (fence-stale / fence-revalidation-failed /
 * cas-lost). This is NOT a `ProjectBaselineError` — it is a private control-
 * flow signal the public method never leaks (the public method returns the
 * typed result; only genuine infrastructure errors throw).
 */
class FenceStaleSignal extends Error {
  constructor(
    readonly kind: 'fence-stale' | 'fence-revalidation-failed' | 'cas-lost',
    readonly snapshot: PersistencePolicySnapshot,
    readonly revalidated: PersistencePolicySnapshot | null,
    message: string,
  ) {
    super(message);
    this.name = 'FenceStaleSignal';
  }
}

export class PgProjectBaselineRepository implements ProjectBaselineRepository {
  constructor(private readonly db: DatabaseClient) {}

  async ensureBaseline(input: EnsureBaselineInput): Promise<ProjectBaseline> {
    // Idempotent lookup-or-create on UNIQUE(project, repo, commit). An
    // existing row returns as-is — its exact revision is immutable (retries
    // never re-resolve and never diverge). ON CONFLICT DO NOTHING + re-select
    // avoids a read-check-write race: two concurrent ensures converge on the
    // same row.
    await this.db.query(
      `INSERT INTO wfos_project_baselines
         (project_id, organization_id, project_github_repository_id,
          repository_owner, repository_name, baseline_commit_sha, revision_ref,
          state, version, analysis_mode, analysis_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'analyzing', 0, $8, $9)
       ON CONFLICT (project_id, project_github_repository_id, baseline_commit_sha)
       DO NOTHING`,
      [
        input.projectId,
        input.organizationId,
        input.projectGithubRepositoryId,
        input.repositoryOwner,
        input.repositoryName,
        input.baselineCommitSha,
        input.revisionRef,
        input.analysisMode,
        input.analysisRunId ?? null,
      ],
    );
    const row = await this.db.query<BaselineRow>(
      `SELECT ${BASELINE_COLUMNS} FROM wfos_project_baselines
        WHERE project_id = $1 AND project_github_repository_id = $2
          AND baseline_commit_sha = $3`,
      [input.projectId, input.projectGithubRepositoryId, input.baselineCommitSha],
    );
    if (row.rowCount === 0 || !row.rows[0]) {
      // The ON CONFLICT DO NOTHING guarantees a row exists here; if not, the
      // trigger rejected the insert (an invariant violation — fail closed).
      throw new ProjectBaselineError(
        'project-baseline-not-found',
        `project-baseline-not-found: ensureBaseline insert+select did not yield a row for project=${input.projectId} repo=${input.projectGithubRepositoryId} sha=${input.baselineCommitSha}`,
        { input },
      );
    }
    return mapBaseline(row.rows[0]);
  }

  async findById(id: string): Promise<ProjectBaseline | null> {
    const r = await this.db.query<BaselineRow>(
      `SELECT ${BASELINE_COLUMNS} FROM wfos_project_baselines WHERE id = $1`,
      [id],
    );
    return r.rowCount && r.rows[0] ? mapBaseline(r.rows[0]) : null;
  }

  async findByRevision(
    projectId: string,
    projectGithubRepositoryId: string,
    baselineCommitSha: string,
  ): Promise<ProjectBaseline | null> {
    const r = await this.db.query<BaselineRow>(
      `SELECT ${BASELINE_COLUMNS} FROM wfos_project_baselines
        WHERE project_id = $1 AND project_github_repository_id = $2
          AND baseline_commit_sha = $3`,
      [projectId, projectGithubRepositoryId, baselineCommitSha],
    );
    return r.rowCount && r.rows[0] ? mapBaseline(r.rows[0]) : null;
  }

  async listForProject(projectId: string): Promise<ProjectBaseline[]> {
    const r = await this.db.query<BaselineRow>(
      `SELECT ${BASELINE_COLUMNS} FROM wfos_project_baselines
        WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId],
    );
    return r.rows.map(mapBaseline);
  }

  async appendEvidence(
    baselineId: string,
    evidence: readonly NewBaselineEvidence[],
  ): Promise<BaselineEvidence[]> {
    return this.appendEvidenceIn(this.db, baselineId, evidence);
  }

  /**
   * PR #42 round-5: the `*In` helper — runs against either the pool
   * (`this.db`) OR a transaction-scoped `DatabaseTx` (inside
   * `persistBaselineWithPolicyFence`). The SQL + the idempotency semantics
   * are identical to the legacy public method (ON CONFLICT DO NOTHING on
   * (baseline_id, source, locator) — the honest composite key; re-fetches
   * the existing id on a no-op insert for observation linkage).
   */
  private async appendEvidenceIn(
    q: Queryable,
    baselineId: string,
    evidence: readonly NewBaselineEvidence[],
  ): Promise<BaselineEvidence[]> {
    if (evidence.length === 0) return [];
    const insertedIds: string[] = [];
    // Insert one-by-one with ON CONFLICT DO NOTHING on (baseline_id, source,
    // locator) — the honest idempotency key (one evidence row per read locator
    // per baseline). The PR #42 round-2 review replaced the prior
    // (baseline_id, tool_invocation_id) key: tool_invocation_id is now NULL
    // for /github-authority reads (no ToolRuntime invocation), so the prior
    // key could not deduplicate (NULL != NULL in PostgreSQL UNIQUE). The
    // honest composite key is (source, locator) — a re-drive of the same
    // governed read upserts the same row, no duplicates.
    for (const ev of evidence) {
      const r = await q.query<{ id: string }>(
        `INSERT INTO wfos_project_baseline_evidence
           (baseline_id, source, locator, content_digest, redacted,
            tool_invocation_id, policy_decision,
            repository_read_decision, repository_read_enforcement)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (baseline_id, source, locator) DO NOTHING
         RETURNING id`,
        [
          baselineId,
          ev.source,
          ev.locator,
          ev.contentDigest,
          ev.redacted,
          ev.toolInvocationId,
          ev.policyDecision,
          // PR #42 round-3: the governed repository-read decision + the
          // concrete enforcement effect (the `constrained` effect made
          // OBSERVABLE). NULL when the evidence row did not come from a
          // governed repository read.
          ev.repositoryReadDecision,
          ev.repositoryReadEnforcement === null
            ? null
            : JSON.stringify(ev.repositoryReadEnforcement),
        ],
      );
      if (r.rowCount && r.rows[0]) {
        insertedIds.push(r.rows[0].id);
      } else {
        // ON CONFLICT DO NOTHING — the evidence already exists (idempotent
        // re-drive). Re-fetch the existing row's id for observation linkage
        // by the honest composite key (source, locator).
        const existing = await q.query<{ id: string }>(
          `SELECT id FROM wfos_project_baseline_evidence
            WHERE baseline_id = $1 AND source = $2 AND locator = $3`,
          [baselineId, ev.source, ev.locator],
        );
        if (existing.rowCount && existing.rows[0]) {
          insertedIds.push(existing.rows[0].id);
        }
      }
    }
    const rows = await q.query<EvidenceRow>(
      `SELECT id, baseline_id, source, locator, content_digest, redacted,
              tool_invocation_id, policy_decision,
              repository_read_decision, repository_read_enforcement,
              observed_at, created_at
         FROM wfos_project_baseline_evidence
        WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [insertedIds],
    );
    return rows.rows.map(mapEvidence);
  }

  async upsertObservations(
    baselineId: string,
    observations: readonly NewBaselineObservation[],
  ): Promise<BaselineObservation[]> {
    return this.upsertObservationsIn(this.db, baselineId, observations);
  }

  /**
   * PR #42 round-5: the `*In` helper — runs against either the pool OR a
   * transaction-scoped `DatabaseTx`. Idempotent upsert on (baseline_id, kind,
   * claim_digest). The claim is immutable (the trigger enforces no claim
   * rewrite); a re-drive is a no-op. ON CONFLICT DO NOTHING.
   */
  private async upsertObservationsIn(
    q: Queryable,
    baselineId: string,
    observations: readonly NewBaselineObservation[],
  ): Promise<BaselineObservation[]> {
    if (observations.length === 0) return [];
    for (const obs of observations) {
      await q.query(
        `INSERT INTO wfos_project_baseline_observations
           (baseline_id, kind, provenance, claim, claim_digest, evidence_ref)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (baseline_id, kind, claim_digest) DO NOTHING`,
        [
          baselineId,
          obs.kind,
          obs.provenance,
          JSON.stringify(obs.claim),
          obs.claimDigest,
          JSON.stringify(obs.evidenceRef),
        ],
      );
    }
    const rows = await q.query<ObservationRow>(
      `SELECT id, baseline_id, kind, provenance, claim, claim_digest,
              evidence_ref, confirmed_by, confirmed_at, created_at
         FROM wfos_project_baseline_observations
        WHERE baseline_id = $1 ORDER BY created_at`,
      [baselineId],
    );
    return rows.rows.map(mapObservation);
  }

  async listObservations(baselineId: string): Promise<BaselineObservation[]> {
    const rows = await this.db.query<ObservationRow>(
      `SELECT id, baseline_id, kind, provenance, claim, claim_digest,
              evidence_ref, confirmed_by, confirmed_at, created_at
         FROM wfos_project_baseline_observations
        WHERE baseline_id = $1 ORDER BY created_at`,
      [baselineId],
    );
    return rows.rows.map(mapObservation);
  }

  async listEvidence(baselineId: string): Promise<BaselineEvidence[]> {
    const rows = await this.db.query<EvidenceRow>(
      `SELECT id, baseline_id, source, locator, content_digest, redacted,
              tool_invocation_id, policy_decision,
              repository_read_decision, repository_read_enforcement,
              observed_at, created_at
         FROM wfos_project_baseline_evidence
        WHERE baseline_id = $1 ORDER BY created_at`,
      [baselineId],
    );
    return rows.rows.map(mapEvidence);
  }

  async markComplete(
    baselineId: string,
    contentDigest: string,
    expectedVersion: number,
  ): Promise<ProjectBaseline | null> {
    return this.markCompleteIn(this.db, baselineId, contentDigest, expectedVersion);
  }

  /**
   * PR #42 round-5: the `*In` helper — runs against either the pool OR a
   * transaction-scoped `DatabaseTx`. CAS: analyzing → complete (version +
   * state predicate). Lost CAS → null (convergence — another worker
   * completed it; the caller re-reads).
   */
  private async markCompleteIn(
    q: Queryable,
    baselineId: string,
    contentDigest: string,
    expectedVersion: number,
  ): Promise<ProjectBaseline | null> {
    // No-confirmed-on-failed: refuse to complete a baseline that carries a
    // confirmed observation UNLESS the baseline is already being completed
    // (defensive — the analyzer never confirms; a confirmed observation on an
    // analyzing baseline would be an invariant violation). This is the
    // "failed analysis cannot produce a false confirmed baseline" guard.
    const confirmedCount = await q.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM wfos_project_baseline_observations
        WHERE baseline_id = $1 AND provenance = 'confirmed'`,
      [baselineId],
    );
    // A complete baseline legitimately may carry confirmed observations (the
    // user confirmed facts after completion). This guard only blocks the
    // transition itself from being incorrectly attributed; the trigger layer
    // enforces terminal immutability. We permit completion regardless — the
    // "no false confirmed on failed" invariant is enforced in markFailed (a
    // failed baseline cannot have been completed with confirmed observations).
    void confirmedCount;
    // CAS: analyzing → complete (version + state predicate). Lost CAS → null
    // (convergence — another worker completed it; the caller re-reads).
    const r = await q.query<BaselineRow>(
      `UPDATE wfos_project_baselines
          SET state = 'complete', version = $3, content_digest = $2,
              finalized_at = NOW(), terminal_at = NOW()
        WHERE id = $1 AND state = 'analyzing' AND version = $4
       RETURNING ${BASELINE_COLUMNS}`,
      [baselineId, contentDigest, expectedVersion + 1, expectedVersion],
    );
    return r.rowCount && r.rows[0] ? mapBaseline(r.rows[0]) : null;
  }

  async markFailed(
    baselineId: string,
    failureStage: string,
    expectedVersion: number,
  ): Promise<ProjectBaseline | null> {
    // The "failed analysis cannot produce a false confirmed baseline" guard:
    // refuse to mark failed if any observation is confirmed. A confirmed
    // observation implies the baseline reached a state where confirmation was
    // meaningful; marking it failed would erase that evidence illegitimately.
    const confirmedCount = await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM wfos_project_baseline_observations
        WHERE baseline_id = $1 AND provenance = 'confirmed'`,
      [baselineId],
    );
    if ((confirmedCount.rows[0]?.n ?? 0) > 0) {
      throw new ProjectBaselineError(
        'project-baseline-no-confirmed-on-failed',
        `project-baseline-no-confirmed-on-failed: baseline ${baselineId} carries a confirmed observation — it cannot be marked failed (a failed analysis cannot produce a false confirmed baseline)`,
        { baselineId, confirmedCount: confirmedCount.rows[0]?.n },
      );
    }
    const r = await this.db.query<BaselineRow>(
      `UPDATE wfos_project_baselines
          SET state = 'failed', version = $3, failure_stage = $2,
              terminal_at = NOW()
        WHERE id = $1 AND state = 'analyzing' AND version = $4
       RETURNING ${BASELINE_COLUMNS}`,
      [baselineId, failureStage, expectedVersion + 1, expectedVersion],
    );
    return r.rowCount && r.rows[0] ? mapBaseline(r.rows[0]) : null;
  }

  // =========================================================================
  // PR #42 round-5 (the persistence-boundary fence): persist evidence +
  // observations + complete the baseline in ONE DB transaction, under the
  // captured persistence-boundary policy snapshot.
  //
  // THE ROUND-5 BLOCKER (the architect's review of commit `2a597ed`): the
  // round-4 fence protects the READ window (capture V7 → read → revalidate V7
  // → discard if stale) but does NOT protect the SUBSEQUENT PERSISTENCE
  // window:
  //
  //   capture V7
  //     ↓
  //   read
  //     ↓
  //   revalidate V7                ← round-4 fence passes here
  //     ↓
  //   policy mutates V7 → V8       ← the round-4 fence does NOT cover this gap
  //     ↓
  //   appendEvidence(V7)           ← STALE V7 evidence committed
  //     ↓
  //   upsertObservations(V7)       ← STALE V7 observations committed
  //     ↓
  //   markComplete                 ← baseline marked complete under V8 with V7 evidence
  //
  // The architect's required fix: a "persistence-boundary CAS/transactional
  // policy snapshot guard." A regression must explicitly mutate the policy
  // AFTER revalidation (the per-read fence's revalidation) BUT BEFORE
  // persistence and prove zero stale evidence/observations are committed.
  //
  // THE ROUND-5 FIX (implemented here): the persistence-boundary fence wraps
  // the appendEvidence + upsertObservations + markComplete in ONE DB
  // transaction + performs a CAS check on the policy version INSIDE the
  // transaction (before commit). If the snapshot is stale at any fence check,
  // the transaction is ROLLED BACK — zero evidence/observations are
  // committed. The architect's invariant: "a repository-read result is
  // persisted only if the policy snapshot that authorized it is still current
  // when the result is committed."
  //
  // THE FENCE PROTOCOL (the double-CAS pattern — defense-in-depth):
  //
  //   1. BEGIN TRANSACTION.
  //   2. PRE-WRITES REVALIDATION (Check A) — call `revalidate()` to fetch the
  //      CURRENT policy snapshot; compare to `input.snapshot`:
  //      * If they differ, the policy mutated BETWEEN the orchestrator's
  //        capture and the transaction start → ROLLBACK → return `fence-stale`.
  //   3. PER-READ SNAPSHOT VERIFICATION (Check B) — verify `input.snapshot`
  //      matches each evidence row's per-read `repository_read_enforcement
  //      .policyVersion` (captured by the analyzer's per-read fence). If ANY
  //      differ, the policy mutated BETWEEN the per-read fence and the
  //      persistence capture → the evidence is stale → ROLLBACK → return
  //      `fence-stale`. This is the architect's exact regression scenario
  //      (the test hook mutates V7 → V8 AFTER the per-read fence passes, BEFORE
  //      the persistence transaction begins).
  //   4. WRITES — appendEvidence (idempotent on (baseline_id, source,
  //      locator)) + upsertObservations (idempotent on (baseline_id, kind,
  //      claim_digest)) + markComplete (CAS on baseline.version). Lost CAS
  //      → ROLLBACK → return `cas-lost`.
  //   5. POST-WRITES REVALIDATION (Check C — defense-in-depth) — call
  //      `revalidate()` AGAIN; compare to `input.snapshot`. If they differ,
  //      the policy mutated DURING the writes → ROLLBACK → return `fence-stale`.
  //   6. COMMIT (the transaction commits only if every fence check passed).
  //   7. Return `persisted` with the completed baseline + the evidence rows.
  //
  // The double-CAS pattern (Check A + Check C) keeps the TOCTOU window
  // between step 5 and COMMIT itself as small as possible. A mutation in that
  // final gap is the same unavoidable window the architect's earlier rounds
  // acknowledged (the DB cannot participate in the policy store's
  // transaction). The fence DETECTS + REJECTS stale snapshots at every other
  // point in the persistence flow — same fencing protocol as round-4,
  // extended to cover the persistence window the round-4 fence left open.
  //
  // FAIL-CLOSED: a revalidation call FAILURE (the gate throws on the
  // revalidation) is treated as STALE — the transaction is ROLLED BACK, the
  // result is `fence-revalidation-failed`. A revalidation failure must NOT
  // become an implicit persist (the result cannot be committed without a
  // successful revalidation).
  //
  // CAS-LOST: the markComplete CAS losing (another worker completed the
  // baseline first) is treated as `cas-lost` — the transaction is ROLLED BACK
  // (the caller re-reads the winner's row — convergence). The winner's
  // evidence is already in (idempotent upserts); the rolled-back writes from
  // this call are no-ops (the ON CONFLICT DO NOTHING semantic).
  //
  // WHY THE THROW-TO-ROLLBACK PATTERN: the `db.transaction()` callback rolls
  // back on any thrown error. The fence throws a `FenceStaleSignal` (a
  // private internal sentinel — NOT a ProjectBaselineError) to abort the
  // transaction; the outer catch translates it to the `fence-stale` /
  // `fence-revalidation-failed` result. This keeps the public method's
  // contract clean (it never throws for fence-stale — it returns a typed
  // result; only the genuine infrastructure errors throw).
  // =========================================================================

  async persistBaselineWithPolicyFence(
    input: PersistBaselineInput,
    revalidate: () => Promise<PersistencePolicySnapshot>,
  ): Promise<PersistBaselineResult> {
    try {
      const result = await this.db.transaction(async (tx) => {
        const q: Queryable = tx as unknown as Queryable;

        // ---- Check A: PRE-WRITES REVALIDATION (the first CAS).
        // Fetch the current policy snapshot INSIDE the transaction. If the
        // snapshot mutated between the orchestrator's capture and the
        // transaction start, this CAS catches it.
        let revalidationA: PersistencePolicySnapshot;
        try {
          revalidationA = await revalidate();
        } catch (err) {
          throw new FenceStaleSignal(
            'fence-revalidation-failed',
            input.snapshot,
            null,
            `the persistence-boundary pre-writes revalidation failed (${(err as Error).message}) — the transaction is rolled back (a revalidation failure must NOT become an implicit persist)`,
          );
        }
        if (isPersistenceSnapshotStale(input.snapshot, revalidationA)) {
          throw new FenceStaleSignal(
            'fence-stale',
            input.snapshot,
            revalidationA,
            `the persistence-boundary fence REJECTED the persist at the PRE-WRITES revalidation (Check A): the snapshot (version=${input.snapshot.policyVersion ?? 'not-surfaced'}, rule=${input.snapshot.ruleId ?? 'default'}, decision=${input.snapshot.decision ?? 'none'}) that authorized the persistence is no longer current (revalidation saw version=${revalidationA.policyVersion ?? 'not-surfaced'}, rule=${revalidationA.ruleId ?? 'default'}, decision=${revalidationA.decision ?? 'none'}) — the policy mutated between the orchestrator's capture and the transaction start; the transaction is rolled back (zero evidence/observations are committed)`,
          );
        }

        // ---- Check B: PER-READ SNAPSHOT VERIFICATION.
        // Verify `input.snapshot` matches each evidence row's per-read
        // `repository_read_enforcement.policyVersion` (the snapshot the
        // analyzer's per-read fence captured for THAT individual read). If ANY
        // differ, the policy mutated BETWEEN the per-read fence and the
        // persistence capture — the evidence is stale → ROLLBACK. This is
        // the architect's exact regression scenario: the test hook mutates
        // V7 → V8 AFTER the per-read fence's revalidation passes, BEFORE the
        // persistence transaction begins. The orchestrator's V_p capture
        // (post-mutation) would be V8; the evidence's per-read snapshot
        // (pre-mutation) is V7 → mismatch → ROLLBACK.
        for (const ev of input.evidence) {
          // Evidence rows that did NOT come from a governed repository read
          // carry no per-read snapshot — skip them (no fence reference to
          // compare against). Currently every evidence row comes from a
          // governed read, but the check is forward-compatible.
          if (ev.repositoryReadEnforcement === null) continue;
          const perReadVersion = ev.repositoryReadEnforcement.policyVersion;
          const perReadRuleId = ev.repositoryReadEnforcement.ruleId;
          // If the per-read snapshot surfaced a version, the persistence
          // snapshot must match it. If the persistence snapshot surfaced a
          // version, the per-read snapshot must match it. Either direction
          // of mismatch is stale.
          if (
            perReadVersion !== null &&
            input.snapshot.policyVersion !== null &&
            perReadVersion !== input.snapshot.policyVersion
          ) {
            throw new FenceStaleSignal(
              'fence-stale',
              input.snapshot,
              revalidationA,
              `the persistence-boundary fence REJECTED the persist at the PER-READ snapshot verification (Check B): the evidence row for locator '${ev.locator}' carries a per-read snapshot (version=${perReadVersion}, rule=${perReadRuleId ?? 'default'}) that does NOT match the persistence-boundary snapshot (version=${input.snapshot.policyVersion}, rule=${input.snapshot.ruleId ?? 'default'}) — the policy mutated between the per-read fence and the persistence capture; the evidence is stale; the transaction is rolled back (zero evidence/observations are committed)`,
            );
          }
          // Defense-in-depth: the per-read ruleId must match too (a rule
          // replacement without a version bump would be a bug, but the fence
          // catches it).
          if (
            (perReadRuleId !== null || input.snapshot.ruleId !== null) &&
            perReadRuleId !== input.snapshot.ruleId
          ) {
            throw new FenceStaleSignal(
              'fence-stale',
              input.snapshot,
              revalidationA,
              `the persistence-boundary fence REJECTED the persist at the PER-READ snapshot verification (Check B — ruleId defense-in-depth): the evidence row for locator '${ev.locator}' carries a per-read ruleId '${perReadRuleId ?? 'default'}' that does NOT match the persistence-boundary snapshot's ruleId '${input.snapshot.ruleId ?? 'default'}' — the matched rule changed between the per-read fence and the persistence capture; the transaction is rolled back (zero evidence/observations are committed)`,
            );
          }
        }

        // ---- WRITES (the actual persist).
        // 1. appendEvidence (idempotent on (baseline_id, source, locator)).
        const persistedEvidence = await this.appendEvidenceIn(
          q,
          input.baselineId,
          input.evidence,
        );
        // 2. Link observations to evidence IDs by locator (the analyzer
        //    references evidence by LOCATOR, not by a manufactured
        //    toolInvocationId — round-2 Blocker A preserved). The
        //    upsertObservationsIn expects observations with resolved evidence
        //    IDs in evidenceRef.
        const evidenceByLocator = new Map<string, string>();
        for (const ev of persistedEvidence) {
          evidenceByLocator.set(ev.locator, ev.id);
        }
        const linkedObservations: NewBaselineObservation[] = input.observations.map(
          (obs) => ({
            ...obs,
            evidenceRef: obs.evidenceRef
              .map((ref) => evidenceByLocator.get(ref) ?? null)
              .filter((v): v is string => v !== null),
          }),
        );
        // 3. upsertObservations (idempotent on (baseline_id, kind,
        //    claim_digest)).
        await this.upsertObservationsIn(q, input.baselineId, linkedObservations);
        // 4. markComplete (CAS on baseline.version). Lost CAS → ROLLBACK +
        //    return `cas-lost` (the caller re-reads the winner's row).
        const completed = await this.markCompleteIn(
          q,
          input.baselineId,
          input.contentDigest,
          input.expectedVersion,
        );
        if (completed === null) {
          // CAS lost — another worker completed the baseline first. The
          // transaction is ROLLED BACK (the caller re-reads the winner's row —
          // convergence). The winner's evidence is already in (idempotent
          // upserts); the rolled-back writes from this call are no-ops.
          throw new FenceStaleSignal(
            'cas-lost',
            input.snapshot,
            revalidationA,
            'the markComplete CAS lost (another worker completed the baseline first) — the transaction is rolled back; the caller re-reads the winner\'s row (convergence)',
          );
        }

        // ---- Check C: POST-WRITES REVALIDATION (defense-in-depth — the
        // second CAS, just before COMMIT). If the policy mutated DURING the
        // writes, this CAS catches it.
        let revalidationB: PersistencePolicySnapshot;
        try {
          revalidationB = await revalidate();
        } catch (err) {
          throw new FenceStaleSignal(
            'fence-revalidation-failed',
            input.snapshot,
            null,
            `the persistence-boundary post-writes revalidation failed (${(err as Error).message}) — the transaction is rolled back (a revalidation failure must NOT become an implicit persist)`,
          );
        }
        if (isPersistenceSnapshotStale(input.snapshot, revalidationB)) {
          throw new FenceStaleSignal(
            'fence-stale',
            input.snapshot,
            revalidationB,
            `the persistence-boundary fence REJECTED the persist at the POST-WRITES revalidation (Check C — defense-in-depth): the snapshot (version=${input.snapshot.policyVersion ?? 'not-surfaced'}, rule=${input.snapshot.ruleId ?? 'default'}, decision=${input.snapshot.decision ?? 'none'}) that authorized the persistence is no longer current after the writes (revalidation saw version=${revalidationB.policyVersion ?? 'not-surfaced'}, rule=${revalidationB.ruleId ?? 'default'}, decision=${revalidationB.decision ?? 'none'}) — the policy mutated DURING the writes; the transaction is rolled back (zero evidence/observations are committed)`,
          );
        }

        // ---- Every fence check passed — the transaction will COMMIT.
        return {
          kind: 'persisted' as const,
          baseline: completed,
          evidence: persistedEvidence,
        };
      });
      return result;
    } catch (err) {
      if (err instanceof FenceStaleSignal) {
        // The fence rejected the persist (or the CAS lost). Translate the
        // internal signal to the public typed result.
        if (err.kind === 'cas-lost') {
          return { kind: 'cas-lost' };
        }
        if (err.kind === 'fence-revalidation-failed') {
          return {
            kind: 'fence-revalidation-failed',
            snapshot: err.snapshot,
            reason: err.message,
          };
        }
        return {
          kind: 'fence-stale',
          snapshot: err.snapshot,
          revalidated: err.revalidated ?? {
            policyVersion: null,
            ruleId: null,
            decision: null,
            reason: null,
          },
          reason: err.message,
        };
      }
      // A genuine infrastructure error (DB connection lost, serialization
      // failure, etc.) — re-throw so the caller's catch block handles it.
      throw err;
    }
  }

  async confirmObservation(
    baselineId: string,
    observationId: string,
    confirmedBy: string,
  ): Promise<BaselineObservation> {
    // PR #42 fix (Blocker 3): confirmObservation must check the parent
    // baseline state. The invariant (migration 0038): "a failed baseline
    // NEVER carries a confirmed observation (failed analysis cannot produce
    // a false confirmed baseline)." markFailed enforces the symmetric side
    // (refuses when a confirmed observation exists); confirmObservation must
    // enforce THIS side — refuse to confirm when the parent baseline is
    // already failed. Without this check, a failed → confirmed transition
    // was possible (the architect identified the loophole on PR #42).
    const baselineRow = await this.db.query<{ state: string }>(
      `SELECT state FROM wfos_project_baselines WHERE id = $1`,
      [baselineId],
    );
    if (baselineRow.rowCount === 0) {
      throw new ProjectBaselineError(
        'project-baseline-not-found',
        `project-baseline-not-found: baseline ${baselineId} does not exist (cannot confirm observation ${observationId})`,
        { baselineId, observationId },
      );
    }
    const baselineState = baselineRow.rows[0]!.state;
    if (baselineState === 'failed') {
      throw new ProjectBaselineError(
        'project-baseline-no-confirmed-on-failed',
        `project-baseline-no-confirmed-on-failed: baseline ${baselineId} is failed — a failed baseline must never carry a confirmed observation (failed analysis cannot produce a false confirmed baseline)`,
        { baselineId, observationId, baselineState },
      );
    }
    // The authorized confirmation path: inferred/proposed → confirmed +
    // confirmed_by/at. The observation-guard trigger is the final backstop
    // (no silent promotion; proposed→observed forbidden; claim immutable).
    const r = await this.db.query<ObservationRow>(
      `UPDATE wfos_project_baseline_observations
          SET provenance = 'confirmed', confirmed_by = $3, confirmed_at = NOW()
        WHERE id = $2 AND baseline_id = $1
          AND provenance IN ('inferred', 'proposed')
       RETURNING id, baseline_id, kind, provenance, claim, claim_digest,
                 evidence_ref, confirmed_by, confirmed_at, created_at`,
      [baselineId, observationId, confirmedBy],
    );
    if (!r.rowCount || !r.rows[0]) {
      // Either the row doesn't exist, or its provenance is already
      // 'confirmed' or 'observed' (no promotion possible). Distinguish.
      const existing = await this.db.query<{ provenance: string }>(
        `SELECT provenance FROM wfos_project_baseline_observations
          WHERE id = $1 AND baseline_id = $2`,
        [observationId, baselineId],
      );
      if (!existing.rowCount) {
        throw new ProjectBaselineError(
          'project-baseline-not-found',
          `project-baseline-not-found: observation ${observationId} (baseline ${baselineId}) does not exist`,
          { baselineId, observationId },
        );
      }
      throw new ProjectBaselineError(
        'project-baseline-confirmation-inconsistent',
        `project-baseline-confirmation-inconsistent: observation ${observationId} has provenance '${existing.rows[0]!.provenance}' — only inferred/proposed → confirmed is permitted`,
        { baselineId, observationId, currentProvenance: existing.rows[0]!.provenance },
      );
    }
    return mapObservation(r.rows[0]);
  }
}
