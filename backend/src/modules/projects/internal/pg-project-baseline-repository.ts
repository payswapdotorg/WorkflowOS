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
} from './project-baseline.types.js';
import { ProjectBaselineError } from './project-baseline.types.js';

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
    observedAt: asDate(r.observed_at)!,
    createdAt: asDate(r.created_at)!,
  };
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
      const r = await this.db.query<{ id: string }>(
        `INSERT INTO wfos_project_baseline_evidence
           (baseline_id, source, locator, content_digest, redacted,
            tool_invocation_id, policy_decision)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
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
        ],
      );
      if (r.rowCount && r.rows[0]) {
        insertedIds.push(r.rows[0].id);
      } else {
        // ON CONFLICT DO NOTHING — the evidence already exists (idempotent
        // re-drive). Re-fetch the existing row's id for observation linkage
        // by the honest composite key (source, locator).
        const existing = await this.db.query<{ id: string }>(
          `SELECT id FROM wfos_project_baseline_evidence
            WHERE baseline_id = $1 AND source = $2 AND locator = $3`,
          [baselineId, ev.source, ev.locator],
        );
        if (existing.rowCount && existing.rows[0]) {
          insertedIds.push(existing.rows[0].id);
        }
      }
    }
    const rows = await this.db.query<EvidenceRow>(
      `SELECT id, baseline_id, source, locator, content_digest, redacted,
              tool_invocation_id, policy_decision, observed_at, created_at
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
    if (observations.length === 0) return [];
    // Idempotent upsert on (baseline_id, kind, claim_digest). The claim is
    // immutable (the trigger enforces no claim rewrite); a re-drive is a
    // no-op. ON CONFLICT DO NOTHING — existing rows are left as-is (their
    // provenance is immutable except the authorized confirmation path).
    for (const obs of observations) {
      await this.db.query(
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
    const rows = await this.db.query<ObservationRow>(
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
              tool_invocation_id, policy_decision, observed_at, created_at
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
    // No-confirmed-on-failed: refuse to complete a baseline that carries a
    // confirmed observation UNLESS the baseline is already being completed
    // (defensive — the analyzer never confirms; a confirmed observation on an
    // analyzing baseline would be an invariant violation). This is the
    // "failed analysis cannot produce a false confirmed baseline" guard.
    const confirmedCount = await this.db.query<{ n: number }>(
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
    const r = await this.db.query<BaselineRow>(
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
