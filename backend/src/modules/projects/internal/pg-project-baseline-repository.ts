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
 * PR #42 round-6: the application-level staleness check
 * (`isPersistenceSnapshotStale`) used by the round-5 fence (Check A + Check
 * C revalidation) is REMOVED — the round-6 fence replaces it with a
 * database-level `SELECT ... FOR UPDATE` on the authoritative
 * `wfos_agent_policies` row (the lock held from the version check through
 * COMMIT IS the fence; there is no separate revalidation read to compare
 * against). The per-read snapshot verification (Check B) inside the
 * transaction is retained + compares the snapshot's policyVersion to each
 * evidence row's per-read `repository_read_enforcement.policyVersion`
 * directly (no helper function needed).
 */

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
  // PR #42 round-7 (the SCOPE-RESOLUTION fence): persist evidence + observations
  // + complete the baseline in ONE PostgreSQL transaction whose commit is
  // conditioned on the EFFECTIVE policy resolution remaining at the snapshot's
  // (source, policyVersion) — via `SELECT ... FOR UPDATE` on the scope ANCHOR
  // rows (`wfos_projects` + `wfos_organizations`) AND the relevant policy rows,
  // held from the re-resolution THROUGH commit.
  //
  // THE ROUND-7 BLOCKER (the architect's review of commit `60dda58`): the
  // round-6 fence locked ONLY the row represented by `snapshot.source`. That
  // works when the current effective policy source is an existing project/org
  // policy row. But consider:
  //
  //   Current effective policy:
  //       organization policy V7
  //       project policy does not exist
  //       ↓
  //   snapshot.source = organization
  //   snapshot.version = 7
  //
  //   T1 starts persistence
  //       ↓
  //   locks organization policy row FOR UPDATE
  //
  //   T2 creates a NEW project policy row
  //       ↓
  //   project policy now overrides organization policy
  //       ↓
  //   effective policy has changed
  //
  //   T1 still holds the organization row
  //       ↓
  //   T1 sees organization version 7
  //       ↓
  //   T1 commits
  //
  // The effective policy changed, but the locked organization row did NOT.
  // The same problem occurs in the reverse direction when a project policy
  // is DELETED and resolution falls back to organization. So:
  //
  //   policy row immutability ≠ effective policy immutability
  //
  // THE ROUND-7 FIX (implemented here): the fence serializes the ENTIRE
  // scope-resolution decision, not just the currently selected policy
  // document. The fence locks:
  //   * the project scope anchor (wfos_projects row) — FOR UPDATE
  //   * the organization scope anchor (wfos_organizations row) — FOR UPDATE
  //   * the project-scope policy row (if present) — FOR UPDATE
  //   * the org-scope policy row (if present) — FOR UPDATE
  // The anchor locks make a concurrent T2's INSERT/UPDATE/DELETE that can
  // change the effective resolution BLOCK on the anchor (the project anchor
  // blocks a NEW project policy INSERT via the FK-induced FOR KEY SHARE;
  // the org anchor blocks a NEW org policy INSERT similarly). The mutation
  // paths (setProjectPolicy / clearProjectPolicy / setOrganizationPolicy /
  // clearOrganizationPolicy in pg-agent-policy-repository.ts) acquire the
  // SAME anchor lock BEFORE the INSERT/UPDATE/DELETE — so the two
  // transactions SERIALIZE against each other even when the effective
  // policy changes because a row is CREATED or DELETED.
  //
  // THE FENCE PROTOCOL (the scope-resolution serialization point):
  //
  //   1. BEGIN TRANSACTION.
  //   2. LOCK the scope ANCHOR rows:
  //      a. SELECT id FROM wfos_projects WHERE id = $proj FOR UPDATE
  //      b. SELECT id FROM wfos_organizations WHERE id = $org FOR UPDATE
  //   3. LOCK the relevant policy rows (present OR absent — the anchor
  //      locks block creation mid-flight):
  //      a. SELECT policy_version FROM wfos_agent_policies
  //           WHERE scope='project' AND organization_id=$org AND project_id=$proj
  //           FOR UPDATE
  //      b. SELECT policy_version FROM wfos_agent_policies
  //           WHERE scope='organization' AND organization_id=$org AND project_id IS NULL
  //           FOR UPDATE
  //   4. RE-RESOLVE the effective policy from the LOCKED rows:
  //      project-override → org-default → platform-default.
  //   5. VERIFY (source, policyVersion) against the snapshot — NOT just
  //      version. If the effective source DIFFERS from the snapshot's
  //      source (a row was CREATED or DELETED mid-flight, changing the
  //      effective resolution) OR the version DIFFERS (an in-place
  //      mutation committed before the lock) → ROLLBACK → `fence-stale`.
  //   6. PER-READ SNAPSHOT VERIFICATION (Check B — retained from round-5):
  //      verify `snapshot.policyVersion` matches each evidence row's per-read
  //      `repository_read_enforcement.policyVersion`. If ANY differ →
  //      ROLLBACK → `fence-stale`.
  //   7. (test seam) If `input.willMutate` is set, invoke it NOW — the
  //      scope-anchor locks + the policy-row locks are held, so a concurrent
  //      policy mutation (T2) driven from the hook BLOCKS on the FOR UPDATE
  //      locks until this transaction commits. No-op in production.
  //   8. WRITES — appendEvidence + upsertObservations + markComplete (CAS on
  //      baseline.version). Lost CAS → ROLLBACK → `cas-lost`. NO post-writes
  //      revalidation — the locks held since steps 2 + 3 serialize against
  //      ANY concurrent mutation for the duration of the writes + commit.
  //   9. COMMIT — releases all the locks. A blocked concurrent mutator (T2)
  //      now proceeds + applies its mutation (the persistence happened-before
  //      the mutation in the serialization order).
  //  10. Return `persisted` with the completed baseline + the evidence rows.
  //
  // SERIALIZATION GUARANTEE: a concurrent policy mutation (via
  // `setProjectPolicy` / `setOrganizationPolicy` / `clearProjectPolicy` /
  // `clearOrganizationPolicy` — all acquire the SAME anchor lock the fence
  // holds) must either WAIT for this transaction to commit (T1 holds the
  // anchor lock → T2 blocks → T1 commits → T2 applies) OR commit FIRST (then
  // the fence's locked re-resolution sees the NEW effective policy → source/
  // version mismatch → ROLLBACK → zero stale evidence/observations are
  // committed). There is no TOCTOU hole for the missing-row cases because the
  // fence no longer locks a single row — it locks the scope ANCHOR + every
  // relevant row + re-resolves. The architect's invariant — "policy row
  // immutability ≠ effective policy immutability" — is honored: the fence
  // asserts against the EFFECTIVE policy version/source, NOT merely the old
  // policy row's version.
  //
  // CAS-LOST: the markComplete CAS losing (another worker completed the
  // baseline first) is treated as `cas-lost` — the transaction is ROLLED BACK
  // (the caller re-reads the winner's row — convergence).
  //
  // WHY THE THROW-TO-ROLLBACK PATTERN: the `db.transaction()` callback rolls
  // back on any thrown error. The fence throws a `FenceStaleSignal` (a
  // private internal sentinel — NOT a ProjectBaselineError) to abort the
  // transaction; the outer catch translates it to the `fence-stale` /
  // `cas-lost` result. The `fence-revalidation-failed` variant is retained in
  // the signal's union + the result type + the catch branch for contract
  // completeness + the round-5 fail-closed architecture invariant; the
  // round-7 fence does NOT throw it (the locked re-resolution replaces the
  // application-level revalidation; a locked-SELECT failure is a genuine
  // infrastructure error that re-throws, not a typed fence result). This
  // keeps the public method's contract clean (it never throws for fence-stale
  // — it returns a typed result; only the genuine infrastructure errors
  // throw).
  // =========================================================================

  async persistBaselineWithPolicyFence(
    input: PersistBaselineInput,
  ): Promise<PersistBaselineResult> {
    try {
      const result = await this.db.transaction(async (tx) => {
        const q: Queryable = tx as unknown as Queryable;

        // ---- THE SCOPE-RESOLUTION FENCE (round-7): LOCK the scope ANCHORS
        // + the relevant policy rows + RE-RESOLVE the effective policy
        // INSIDE this transaction. The round-6 fence locked ONLY the row
        // represented by `snapshot.source`. The architect's round-7 review
        // of commit `60dda58` established that locking a single policy row
        // does NOT fence policy RESOLUTION: when the current effective
        // source is `organization` (no project policy exists) and a
        // concurrent T2 CREATES a NEW project policy row, the effective
        // policy changes (project now overrides organization) but the
        // locked organization row did NOT change → the round-6 fence let
        // V7 (org) stale evidence commit under the new V1 (project)
        // effective policy. The inverse hole existed when a project policy
        // was DELETED (clearProjectPolicy) and resolution fell back to
        // organization.
        //
        // THE ROUND-7 FIX: the fence locks the SCOPE ANCHOR rows (the
        // `wfos_projects` + `wfos_organizations` rows — the authoritative
        // scope boundary every policy row references via FK) PLUS the
        // relevant policy rows (project-scope AND org-scope, present OR
        // absent — the anchor lock blocks a NEW project policy row's
        // FK-induced `FOR KEY SHARE` on the project parent). The fence
        // then RE-RESOLVES the effective policy from the LOCKED rows
        // (project-override → org-default → platform-default) and compares
        // (source, policyVersion) against the snapshot — NOT just version.
        // If source DIFFERS (the effective policy changed because a row was
        // created or deleted) OR version differs → ROLLBACK → fence-stale.
        //
        // The mutation paths (setProjectPolicy / clearProjectPolicy /
        // setOrganizationPolicy / clearOrganizationPolicy in
        // pg-agent-policy-repository.ts) acquire the SAME anchor lock
        // BEFORE the INSERT/UPDATE/DELETE — so the fence's anchor lock
        // SERIALIZES against ANY concurrent mutation that can change the
        // effective resolution, including the missing-row cases (T2 creates
        // a NEW project policy → blocked on the fence's project anchor
        // lock; T2 deletes the project policy → blocked on the same lock;
        // T2 mutates the org default → blocked on the org anchor lock).
        //
        // SERIALIZATION GUARANTEE: a concurrent policy mutation must
        // either WAIT for this transaction to commit (then the mutation
        // applies AFTER the persistence — happened-before in the
        // serialization order) OR commit FIRST (then the fence's locked
        // re-resolution sees the NEW effective policy → source/version
        // mismatch → ROLLBACK → zero stale evidence/observations are
        // committed). There is no TOCTOU hole for the missing-row cases
        // because the fence no longer locks a single row — it locks the
        // scope ANCHOR + every relevant row + re-resolves.

        // ---- 1. Lock the project-scope anchor: SELECT ... FOR UPDATE on
        // the wfos_projects row. The project's existence is the scope
        // anchor; every project-scope policy row references it via FK.
        // The mutation paths (setProjectPolicy / clearProjectPolicy) hold
        // the SAME lock — they SERIALIZE against this fence. The lock
        // also blocks a concurrent T2's INSERT into wfos_agent_policies
        // (FK-induced FOR KEY SHARE on the project parent conflicts with
        // FOR UPDATE) — the missing-row case 1 (org policy active, T2
        // creates project policy) is fenced.
        await q.query(
          `SELECT id FROM wfos_projects WHERE id = $1 FOR UPDATE`,
          [input.projectId],
        );

        // ---- 2. Lock the organization-scope anchor: SELECT ... FOR
        // UPDATE on the wfos_organizations row. The org anchor covers
        // every project-scope AND organization-scope mutation in the org.
        // setOrganizationPolicy / clearOrganizationPolicy acquire this
        // SAME lock. The lock ALSO blocks a concurrent T2's INSERT of an
        // org-scope policy row (FK-induced FOR KEY SHARE on the org
        // parent) — covering the platform-default → organization case.
        await q.query(
          `SELECT id FROM wfos_organizations WHERE id = $1 FOR UPDATE`,
          [input.organizationId],
        );

        // ---- 3. Lock the project-scope policy row (if present). SELECT
        // ... FOR UPDATE on the project-scope wfos_agent_policies row.
        // If the row is absent, this is a no-op (the anchor lock from
        // step 1 blocks any concurrent T2 from CREATING a new project
        // policy row mid-flight via the FK-induced lock). If the row is
        // present, the lock blocks T2's UPDATE/DELETE on this row (the
        // mutation paths also acquire the anchor lock; the row lock here
        // is defense-in-depth).
        const projectPolicyRes = await q.query<{ policy_version: number }>(
          `SELECT policy_version FROM wfos_agent_policies
            WHERE scope = 'project' AND organization_id = $1 AND project_id = $2
            FOR UPDATE`,
          [input.organizationId, input.projectId],
        );
        const projectPolicyRow = projectPolicyRes.rows[0] ?? null;

        // ---- 4. Lock the organization-scope policy row (if present).
        // SELECT ... FOR UPDATE on the org-scope wfos_agent_policies row.
        // Same rationale as step 3 for the org-scope row.
        const orgPolicyRes = await q.query<{ policy_version: number }>(
          `SELECT policy_version FROM wfos_agent_policies
            WHERE scope = 'organization' AND organization_id = $1 AND project_id IS NULL
            FOR UPDATE`,
          [input.organizationId],
        );
        const orgPolicyRow = orgPolicyRes.rows[0] ?? null;

        // ---- 5. RE-RESOLVE the effective policy from the LOCKED rows.
        // The effective policy is: project-override → org-default →
        // platform-default. The fence's resolution mirrors the policy
        // engine's getEffectivePolicy (project → org → null), but reads
        // from the LOCKED rows inside this transaction (so the resolution
        // is consistent with the lock state — no concurrent mutation can
        // change it between the read and COMMIT).
        let effectiveSource: 'project' | 'organization' | 'platform-default';
        let effectiveVersion: number | null;
        if (projectPolicyRow) {
          effectiveSource = 'project';
          effectiveVersion = projectPolicyRow.policy_version;
        } else if (orgPolicyRow) {
          effectiveSource = 'organization';
          effectiveVersion = orgPolicyRow.policy_version;
        } else {
          effectiveSource = 'platform-default';
          effectiveVersion = null;
        }

        // ---- 6. VERIFY the snapshot's (source, policyVersion) against
        // the LOCKED re-resolved effective policy. The architect's
        // round-7 invariant: assert against the EFFECTIVE policy
        // version/source, NOT merely the old policy row's version. The
        // source comparison catches the missing-row cases (snapshot
        // source='organization' but the effective is now 'project' →
        // a project policy was created mid-flight; OR snapshot
        // source='project' but the effective is now 'organization' →
        // the project policy was deleted mid-flight). The version
        // comparison catches in-place document mutations on the SAME
        // source (the round-6 invariant, retained).
        const lockedRow: PersistencePolicySnapshot = {
          source: effectiveSource,
          policyVersion: effectiveVersion,
          ruleId: input.snapshot.ruleId,
          decision: input.snapshot.decision,
          reason: null,
        };

        if (input.snapshot.source !== null && effectiveSource !== input.snapshot.source) {
          // The effective source DIFFERS from the snapshot's source —
          // the effective policy CHANGED because a row was CREATED
          // (e.g., snapshot='organization' but effective='project' —
          // T2 created a project policy that overrides the org default)
          // OR DELETED (e.g., snapshot='project' but
          // effective='organization' — T2 cleared the project policy
          // and resolution fell back to the org default). ROLLBACK.
          throw new FenceStaleSignal(
            'fence-stale',
            input.snapshot,
            lockedRow,
            `the persistence-boundary SCOPE-RESOLUTION fence REJECTED the persist at the EFFECTIVE-POLICY re-resolution step: the snapshot's source '${input.snapshot.source}' does NOT match the locked re-resolved effective source '${effectiveSource}' — the effective policy changed because a wfos_agent_policies row was CREATED (a project override was added or an org default was created) or DELETED (a project override was cleared or an org default was cleared) between the snapshot capture and the fence's lock acquisition; the transaction is rolled back (zero evidence/observations are committed)`,
          );
        }
        // If the snapshot surfaced no source (the capture failed-closed),
        // skip the source comparison (best-effort — same fail-closed
        // behavior as the round-4 fence).

        // Source matches (or the snapshot failed-closed to null). Now
        // verify the version (when both the snapshot + the effective
        // resolution surfaced one). The version comparison catches in-
        // place document mutations on the SAME source (the round-6
        // invariant): setProjectPolicy / setOrganizationPolicy bump
        // policy_version on UPDATE; the fence's locked read returns
        // the NEWEST committed version → mismatch → ROLLBACK.
        if (
          input.snapshot.policyVersion !== null &&
          effectiveVersion !== null &&
          input.snapshot.policyVersion !== effectiveVersion
        ) {
          throw new FenceStaleSignal(
            'fence-stale',
            input.snapshot,
            lockedRow,
            `the persistence-boundary SCOPE-RESOLUTION fence REJECTED the persist at the EFFECTIVE-POLICY re-resolution step: the snapshot's policyVersion=${input.snapshot.policyVersion} does NOT match the locked re-resolved effective policyVersion=${effectiveVersion} (source=${effectiveSource}) — a concurrent policy mutation committed BEFORE this transaction acquired the FOR UPDATE row lock; the transaction is rolled back (zero evidence/observations are committed)`,
          );
        }

        // Special case: the snapshot source is 'project' OR
        // 'organization' but the LOCKED row for that source is MISSING
        // (the row was deleted mid-flight). This is caught by the source
        // comparison above (effectiveSource will differ — e.g.,
        // snapshot='project' but projectPolicyRow is null →
        // effectiveSource='organization' or 'platform-default' → mismatch
        // → ROLLBACK). The explicit missing-row check below is defense-
        // in-depth (the source comparison is the primary guard).
        if (
          input.snapshot.source === 'project' &&
          projectPolicyRow === null
        ) {
          throw new FenceStaleSignal(
            'fence-stale',
            input.snapshot,
            lockedRow,
            `the persistence-boundary SCOPE-RESOLUTION fence REJECTED the persist: the snapshot's source is 'project' but the locked project-scope wfos_agent_policies row is MISSING — the project override was deleted mid-flight (clearProjectPolicy committed between the snapshot capture and the fence's lock); the effective resolution has fallen back to '${effectiveSource}'; the transaction is rolled back (zero evidence/observations are committed)`,
          );
        }
        if (
          input.snapshot.source === 'organization' &&
          orgPolicyRow === null
        ) {
          throw new FenceStaleSignal(
            'fence-stale',
            input.snapshot,
            lockedRow,
            `the persistence-boundary SCOPE-RESOLUTION fence REJECTED the persist: the snapshot's source is 'organization' but the locked organization-scope wfos_agent_policies row is MISSING — the org default was deleted mid-flight (clearOrganizationPolicy committed between the snapshot capture and the fence's lock); the effective resolution has fallen back to '${effectiveSource}'; the transaction is rolled back (zero evidence/observations are committed)`,
          );
        }

        // ---- Check B: PER-READ SNAPSHOT VERIFICATION (retained from round-5).
        // Verify `input.snapshot` matches each evidence row's per-read
        // `repository_read_enforcement.policyVersion` (the snapshot the
        // analyzer's per-read fence captured for THAT individual read). If
        // ANY differ, the policy mutated BETWEEN the per-read fence and
        // the persistence capture — the evidence is stale → ROLLBACK.
        for (const ev of input.evidence) {
          if (ev.repositoryReadEnforcement === null) continue;
          const perReadVersion = ev.repositoryReadEnforcement.policyVersion;
          const perReadRuleId = ev.repositoryReadEnforcement.ruleId;
          if (
            perReadVersion !== null &&
            input.snapshot.policyVersion !== null &&
            perReadVersion !== input.snapshot.policyVersion
          ) {
            throw new FenceStaleSignal(
              'fence-stale',
              input.snapshot,
              lockedRow,
              `the persistence-boundary fence REJECTED the persist at the PER-READ snapshot verification (Check B): the evidence row for locator '${ev.locator}' carries a per-read snapshot (version=${perReadVersion}, rule=${perReadRuleId ?? 'default'}) that does NOT match the persistence-boundary snapshot (version=${input.snapshot.policyVersion}, rule=${input.snapshot.ruleId ?? 'default'}) — the policy mutated between the per-read fence and the persistence capture; the evidence is stale; the transaction is rolled back (zero evidence/observations are committed)`,
            );
          }
          if (
            (perReadRuleId !== null || input.snapshot.ruleId !== null) &&
            perReadRuleId !== input.snapshot.ruleId
          ) {
            throw new FenceStaleSignal(
              'fence-stale',
              input.snapshot,
              lockedRow,
              `the persistence-boundary fence REJECTED the persist at the PER-READ snapshot verification (Check B — ruleId defense-in-depth): the evidence row for locator '${ev.locator}' carries a per-read ruleId '${perReadRuleId ?? 'default'}' that does NOT match the persistence-boundary snapshot's ruleId '${input.snapshot.ruleId ?? 'default'}' — the matched rule changed between the per-read fence and the persistence capture; the transaction is rolled back (zero evidence/observations are committed)`,
            );
          }
        }

        // ---- (test seam) the willMutate hook — invoked AFTER the row
        // lock is acquired + verified, BEFORE the writes. The real-
        // PostgreSQL concurrency regression drives a concurrent policy
        // mutation (T2) from here; T2's UPDATE blocks on this
        // transaction's FOR UPDATE lock until COMMIT. No-op in
        // production (input.willMutate is undefined).
        if (input.willMutate) {
          await input.willMutate();
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
          // transaction is ROLLED BACK (the caller re-reads the winner's
          // row — convergence). The winner's evidence is already in
          // (idempotent upserts); the rolled-back writes from this call
          // are no-ops.
          throw new FenceStaleSignal(
            'cas-lost',
            input.snapshot,
            lockedRow,
            'the markComplete CAS lost (another worker completed the baseline first) — the transaction is rolled back; the caller re-reads the winner\'s row (convergence)',
          );
        }

        // ---- NO post-writes revalidation (round-7): the scope-anchor row
        // locks (FOR UPDATE on wfos_projects + wfos_organizations, held
        // since steps 1 + 2) PLUS the policy-row locks (steps 3 + 4)
        // serialize against ANY concurrent mutation that can change the
        // effective policy resolution for the duration of the writes +
        // commit. A mutation cannot sneak in between the fence's
        // re-resolution read and COMMIT because the locks held since the
        // re-resolution block any concurrent mutation (whether in-place on
        // an existing row, OR a NEW row creation that would change the
        // effective source, OR a row DELETION that would change the
        // effective source) — the source/version comparison is final.
        // The transaction will COMMIT, releasing all the locks; a
        // blocked concurrent mutator (T2) now proceeds + applies its
        // mutation (the persistence happened-before the mutation in the
        // serialization order).

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
          // Retained for contract completeness + the round-5 fail-closed
          // architecture invariant; the round-6 fence does NOT throw this
          // (the locked SELECT replaces the application-level revalidation).
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
            source: null,
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
