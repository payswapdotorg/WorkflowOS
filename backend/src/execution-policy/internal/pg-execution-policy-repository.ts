/**
 * WORK-033 — Postgres-backed ExecutionPolicyRepository.
 *
 * Hand-written parameterized SQL (the WorkflowOS convention — no ORM). All
 * queries go through DatabaseClient. Tenant scoping enforced by
 * organization_id / project_id / user_id on every row. The decisions table
 * is INSERT-ONLY (§22 append-only — enforced by a DB trigger that rejects
 * UPDATE/DELETE).
 */
import type { DatabaseClient } from '@platform/postgres/database-client.js';
import type {
  ExecutionPolicyDecisionRecord,
  ProjectPolicyRecord,
  ProviderAccessProfileRecord,
  UserPreferenceRecord,
  UpdateProjectPolicyInput,
  UpdateUserPreferencesInput,
  UpsertAccessProfileInput,
  BenchmarkMode,
  PrivacyLevel,
  CapabilityReadiness,
} from '../types.js';
import type {
  DecisionRow,
  DecisionSnapshotGuard,
  ExecutionPolicyRepository,
} from './execution-policy.types.js';

export class PgExecutionPolicyRepository implements ExecutionPolicyRepository {
  constructor(private readonly db: DatabaseClient) {}

  // ---------------------------------------------------------------- project

  async getProjectPolicy(projectId: string): Promise<ProjectPolicyRecord | null> {
    const res = await this.db.query<ProjectPolicyRow>(
      `SELECT id, organization_id, project_id, default_benchmark_mode,
              external_execution_allowed, native_execution_allowed,
              max_cost_per_task_cents, max_cost_per_trial_cents, max_time_to_pr_ms,
              human_intervention_allowed, privacy_level,
              allowed_providers, denied_providers, allowed_modes,
              frozen, policy_version, created_at, updated_at
         FROM wfos_execution_policies
        WHERE project_id = $1
        LIMIT 1`,
      [projectId],
    );
    const row = res.rows[0];
    return row ? mapProjectPolicy(row) : null;
  }

  async insertDefaultProjectPolicy(organizationId: string, projectId: string): Promise<ProjectPolicyRecord> {
    const res = await this.db.query<ProjectPolicyRow>(
      `INSERT INTO wfos_execution_policies (organization_id, project_id)
       VALUES ($1, $2)
       ON CONFLICT (project_id) DO NOTHING
       RETURNING id, organization_id, project_id, default_benchmark_mode,
                 external_execution_allowed, native_execution_allowed,
                 max_cost_per_task_cents, max_cost_per_trial_cents, max_time_to_pr_ms,
                 human_intervention_allowed, privacy_level,
                 allowed_providers, denied_providers, allowed_modes,
                 frozen, policy_version, created_at, updated_at`,
      [organizationId, projectId],
    );
    const row = res.rows[0];
    if (!row) {
      // ON CONFLICT DO NOTHING → a concurrent insert won; re-read.
      const existing = await this.getProjectPolicy(projectId);
      if (!existing) throw new Error(`execution-policy: default insert race for project ${projectId}`);
      return existing;
    }
    return mapProjectPolicy(row);
  }

  async updateProjectPolicy(projectId: string, input: UpdateProjectPolicyInput): Promise<ProjectPolicyRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, val: unknown) => { sets.push(`${col} = $${i++}`); params.push(val); };
    if (input.defaultBenchmarkMode != null) push('default_benchmark_mode', input.defaultBenchmarkMode);
    if (input.externalExecutionAllowed != null) push('external_execution_allowed', input.externalExecutionAllowed);
    if (input.nativeExecutionAllowed != null) push('native_execution_allowed', input.nativeExecutionAllowed);
    if ('maxCostPerTaskCents' in input) push('max_cost_per_task_cents', input.maxCostPerTaskCents ?? null);
    if ('maxCostPerTrialCents' in input) push('max_cost_per_trial_cents', input.maxCostPerTrialCents ?? null);
    if ('maxTimeToPrMs' in input) push('max_time_to_pr_ms', input.maxTimeToPrMs ?? null);
    if (input.humanInterventionAllowed != null) push('human_intervention_allowed', input.humanInterventionAllowed);
    if (input.privacyLevel != null) push('privacy_level', input.privacyLevel);
    if (input.allowedProviders != null) push('allowed_providers', Array.from(input.allowedProviders));
    if (input.deniedProviders != null) push('denied_providers', Array.from(input.deniedProviders));
    if (input.allowedModes != null) push('allowed_modes', Array.from(input.allowedModes));
    if (sets.length === 0) return this.getProjectPolicy(projectId);
    params.push(projectId);
    const res = await this.db.query<ProjectPolicyRow>(
      `UPDATE wfos_execution_policies
          SET ${sets.join(', ')}
        WHERE project_id = $${i}
        RETURNING id, organization_id, project_id, default_benchmark_mode,
                  external_execution_allowed, native_execution_allowed,
                  max_cost_per_task_cents, max_cost_per_trial_cents, max_time_to_pr_ms,
                  human_intervention_allowed, privacy_level,
                  allowed_providers, denied_providers, allowed_modes,
                  frozen, policy_version, created_at, updated_at`,
      params,
    );
    const row = res.rows[0];
    return row ? mapProjectPolicy(row) : null;
  }

  async freezeProjectPolicy(projectId: string): Promise<ProjectPolicyRecord | null> {
    const res = await this.db.query<ProjectPolicyRow>(
      `UPDATE wfos_execution_policies
          SET frozen = true
        WHERE project_id = $1
        RETURNING id, organization_id, project_id, default_benchmark_mode,
                  external_execution_allowed, native_execution_allowed,
                  max_cost_per_task_cents, max_cost_per_trial_cents, max_time_to_pr_ms,
                  human_intervention_allowed, privacy_level,
                  allowed_providers, denied_providers, allowed_modes,
                  frozen, policy_version, created_at, updated_at`,
      [projectId],
    );
    const row = res.rows[0];
    return row ? mapProjectPolicy(row) : null;
  }

  // ---------------------------------------------------------------- user prefs

  async getUserPreferences(userId: string): Promise<UserPreferenceRecord | null> {
    const res = await this.db.query<UserPrefRow>(
      `SELECT id, organization_id, user_id, quality_weight, cost_weight,
              latency_weight, privacy_weight, preferred_mode,
              external_preferred, native_preferred, default_benchmark_mode,
              created_at, updated_at
         FROM wfos_execution_preferences
        WHERE user_id = $1
        LIMIT 1`,
      [userId],
    );
    const row = res.rows[0];
    return row ? mapUserPref(row) : null;
  }

  async insertDefaultUserPreferences(organizationId: string, userId: string): Promise<UserPreferenceRecord> {
    const res = await this.db.query<UserPrefRow>(
      `INSERT INTO wfos_execution_preferences (organization_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING id, organization_id, user_id, quality_weight, cost_weight,
                 latency_weight, privacy_weight, preferred_mode,
                 external_preferred, native_preferred, default_benchmark_mode,
                 created_at, updated_at`,
      [organizationId, userId],
    );
    const row = res.rows[0];
    if (!row) {
      const existing = await this.getUserPreferences(userId);
      if (!existing) throw new Error(`execution-policy: user pref insert race for user ${userId}`);
      return existing;
    }
    return mapUserPref(row);
  }

  async updateUserPreferences(userId: string, input: UpdateUserPreferencesInput): Promise<UserPreferenceRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, val: unknown) => { sets.push(`${col} = $${i++}`); params.push(val); };
    if (input.qualityWeight != null) push('quality_weight', input.qualityWeight);
    if (input.costWeight != null) push('cost_weight', input.costWeight);
    if (input.latencyWeight != null) push('latency_weight', input.latencyWeight);
    if (input.privacyWeight != null) push('privacy_weight', input.privacyWeight);
    if ('preferredMode' in input) push('preferred_mode', input.preferredMode ?? null);
    if (input.externalPreferred != null) push('external_preferred', input.externalPreferred);
    if (input.nativePreferred != null) push('native_preferred', input.nativePreferred);
    if (input.defaultBenchmarkMode != null) push('default_benchmark_mode', input.defaultBenchmarkMode);
    if (sets.length === 0) return this.getUserPreferences(userId);
    params.push(userId);
    const res = await this.db.query<UserPrefRow>(
      `UPDATE wfos_execution_preferences
          SET ${sets.join(', ')}
        WHERE user_id = $${i}
        RETURNING id, organization_id, user_id, quality_weight, cost_weight,
                  latency_weight, privacy_weight, preferred_mode,
                  external_preferred, native_preferred, default_benchmark_mode,
                  created_at, updated_at`,
      params,
    );
    const row = res.rows[0];
    return row ? mapUserPref(row) : null;
  }

  // ---------------------------------------------------------------- access profiles

  async listAccessProfiles(userId: string): Promise<ProviderAccessProfileRecord[]> {
    const res = await this.db.query<AccessProfileRow>(
      `SELECT id, organization_id, user_id, provider, plan,
              coding_agent, external_ui, native_api, status_source, notes,
              created_at, updated_at
         FROM wfos_provider_access_profiles
        WHERE user_id = $1
        ORDER BY provider`,
      [userId],
    );
    return res.rows.map(mapAccessProfile);
  }

  async upsertAccessProfile(organizationId: string, userId: string, input: UpsertAccessProfileInput): Promise<ProviderAccessProfileRecord> {
    const res = await this.db.query<AccessProfileRow>(
      `INSERT INTO wfos_provider_access_profiles
          (organization_id, user_id, provider, plan, coding_agent, external_ui,
           native_api, status_source, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, provider) DO UPDATE
          SET plan = EXCLUDED.plan,
              coding_agent = EXCLUDED.coding_agent,
              external_ui = EXCLUDED.external_ui,
              native_api = EXCLUDED.native_api,
              status_source = EXCLUDED.status_source,
              notes = EXCLUDED.notes
       RETURNING id, organization_id, user_id, provider, plan,
                 coding_agent, external_ui, native_api, status_source, notes,
                 created_at, updated_at`,
      [
        organizationId, userId, input.provider,
        input.plan ?? null,
        input.codingAgent ?? 'unverified',
        input.externalUi ?? 'unverified',
        input.nativeApi ?? 'unverified',
        input.statusSource ?? 'unknown',
        input.notes ?? null,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`execution-policy: access profile upsert failed for ${input.provider}`);
    return mapAccessProfile(row);
  }

  // ---------------------------------------------------------------- decisions (§22)

  async insertDecision(
    organizationId: string, projectId: string, workItemId: string,
    requestedBy: string | null, row: DecisionRow,
    guard: DecisionSnapshotGuard,
  ): Promise<ExecutionPolicyDecisionRecord | null> {
    // PR #37 review fix (TOCTOU + snapshot staleness): the decision write is
    // an ATOMIC SNAPSHOT VALIDATION with a ROW LOCK at the decision
    // boundary. ONE statement (a CTE) reads the CURRENT authoritative
    // policy row FOR UPDATE and inserts ONLY when the snapshot the
    // recommendation was computed from is still exact:
    //
    //   current_policy = the project's policy row as of NOW (FOR UPDATE)
    //   inserted       = the decision INSERT ... SELECT FROM current_policy
    //                    WHERE current_policy.policy_version = snapshot version
    //                      AND (current_policy.frozen = false
    //                           OR effective mode = current_policy.default mode)
    //
    // WHY FOR UPDATE (the follow-up review's finding): a plain SELECT in
    // the CTE reads the STATEMENT-START snapshot, so a concurrent policy
    // UPDATE that commits while this statement is executing could leave the
    // decision persisted against the OLD policy version — the check and
    // the insert were not serialized against the policy writer. With
    // FOR UPDATE the locked read SERIALIZES against any concurrent policy
    // writer (the touch/reject-frozen triggers' UPDATE, a policy PATCH, a
    // benchmark-start freeze):
    //   * an in-flight concurrent UPDATE holds the row lock → this read
    //     WAITS → once it commits, READ COMMITTED locked-read semantics
    //     return the NEWEST committed row → the version predicate rejects
    //     the stale snapshot → no insert;
    //   * if this statement wins the lock, the concurrent UPDATE waits
    //     until this statement commits → the decision happened-before the
    //     policy change in the serialization order.
    //
    // The two guard clauses eliminate the reviewer's race windows:
    //   * a policy MUTATION (any UPDATE — including the §9 freeze, which
    //     bumps policy_version via the touch trigger) during the
    //     recommendation → version differs → no row → null → the caller
    //     retries with the fresh policy;
    //   * the policy BECOMING (or being) FROZEN while the decision uses a
    //     request-scoped mode that differs from the frozen default → the
    //     frozen/mode clause rejects → null (belt-and-braces: the freeze
    //     also bumps the version, but this clause holds even if a future
    //     change ever made freezing version-neutral).
    //
    // Invariant enforced: every PERSISTED decision corresponds to one exact,
    // currently authoritative policy version — where "currently" is
    // linearized by the row lock at the decision boundary. A missing policy
    // row (deleted mid-recommendation) also yields no insert. Statement
    // atomicity means there is no window between the check and the insert.
    const res = await this.db.query<DecisionRowDb>(
      `WITH current_policy AS (
         SELECT policy_version, frozen, default_benchmark_mode
           FROM wfos_execution_policies
          WHERE project_id = $2
            FOR UPDATE
       ), inserted AS (
         INSERT INTO wfos_execution_policy_decisions
           (organization_id, project_id, work_item_id, requested_by,
            policy_version, benchmark_mode, task_profile, eligible_candidates,
            excluded_candidates, recommended_candidate, why_explanation, scores,
            benchmark_evidence)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
           FROM current_policy cp
          WHERE cp.policy_version = $14
            AND (cp.frozen = false OR $6::text = cp.default_benchmark_mode)
         RETURNING id, organization_id, project_id, work_item_id, requested_by,
                   policy_version, benchmark_mode, task_profile, eligible_candidates,
                   excluded_candidates, recommended_candidate, why_explanation, scores,
                   benchmark_evidence, created_at
       )
       SELECT * FROM inserted`,
      [
        organizationId, projectId, workItemId, requestedBy,
        row.policyVersion, row.benchmarkMode,
        JSON.stringify(row.taskProfile),
        JSON.stringify(row.eligibleCandidates),
        JSON.stringify(row.excludedCandidates),
        row.recommendedCandidate ? JSON.stringify(row.recommendedCandidate) : null,
        row.whyExplanation,
        JSON.stringify(row.scores),
        JSON.stringify(row.benchmarkEvidence),
        guard.snapshotPolicyVersion,
      ],
    );
    // Zero rows = the guard rejected the insert (stale snapshot and/or a
    // frozen-mode violation). Null (not a throw): the SERVICE decides how
    // to surface it (the retryable stale-snapshot error).
    return res.rows[0] ? mapDecision(res.rows[0]) : null;
  }

  async listDecisions(workItemId: string, limit = 50): Promise<ExecutionPolicyDecisionRecord[]> {
    const res = await this.db.query<DecisionRowDb>(
      `SELECT id, organization_id, project_id, work_item_id, requested_by,
              policy_version, benchmark_mode, task_profile, eligible_candidates,
              excluded_candidates, recommended_candidate, why_explanation, scores,
              benchmark_evidence, created_at
         FROM wfos_execution_policy_decisions
        WHERE work_item_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [workItemId, limit],
    );
    return res.rows.map(mapDecision);
  }
}

// ---------------------------------------------------------------------------
// ROW TYPES + MAPPERS
// ---------------------------------------------------------------------------

interface ProjectPolicyRow {
  id: string; organization_id: string; project_id: string;
  default_benchmark_mode: string;
  external_execution_allowed: boolean; native_execution_allowed: boolean;
  max_cost_per_task_cents: string | null; max_cost_per_trial_cents: string | null;
  max_time_to_pr_ms: number | null;
  human_intervention_allowed: boolean; privacy_level: string;
  allowed_providers: string[]; denied_providers: string[]; allowed_modes: string[];
  frozen: boolean; policy_version: number;
  created_at: Date; updated_at: Date;
}

function mapProjectPolicy(r: ProjectPolicyRow): ProjectPolicyRecord {
  return {
    id: r.id, organizationId: r.organization_id, projectId: r.project_id,
    defaultBenchmarkMode: r.default_benchmark_mode as BenchmarkMode,
    externalExecutionAllowed: r.external_execution_allowed,
    nativeExecutionAllowed: r.native_execution_allowed,
    maxCostPerTaskCents: r.max_cost_per_task_cents != null ? Number(r.max_cost_per_task_cents) : null,
    maxCostPerTrialCents: r.max_cost_per_trial_cents != null ? Number(r.max_cost_per_trial_cents) : null,
    maxTimeToPrMs: r.max_time_to_pr_ms,
    humanInterventionAllowed: r.human_intervention_allowed,
    privacyLevel: r.privacy_level as PrivacyLevel,
    allowedProviders: r.allowed_providers ?? [],
    deniedProviders: r.denied_providers ?? [],
    allowedModes: (r.allowed_modes ?? []) as ('native' | 'external')[],
    frozen: r.frozen, policyVersion: r.policy_version,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface UserPrefRow {
  id: string; organization_id: string; user_id: string;
  quality_weight: number; cost_weight: number; latency_weight: number; privacy_weight: number;
  preferred_mode: string | null; external_preferred: boolean; native_preferred: boolean;
  default_benchmark_mode: string; created_at: Date; updated_at: Date;
}
function mapUserPref(r: UserPrefRow): UserPreferenceRecord {
  return {
    id: r.id, organizationId: r.organization_id, userId: r.user_id,
    qualityWeight: r.quality_weight, costWeight: r.cost_weight,
    latencyWeight: r.latency_weight, privacyWeight: r.privacy_weight,
    preferredMode: r.preferred_mode as 'native' | 'external' | null,
    externalPreferred: r.external_preferred, nativePreferred: r.native_preferred,
    defaultBenchmarkMode: r.default_benchmark_mode as BenchmarkMode,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface AccessProfileRow {
  id: string; organization_id: string; user_id: string; provider: string; plan: string | null;
  coding_agent: string; external_ui: string; native_api: string; status_source: string;
  notes: string | null; created_at: Date; updated_at: Date;
}
function mapAccessProfile(r: AccessProfileRow): ProviderAccessProfileRecord {
  return {
    id: r.id, organizationId: r.organization_id, userId: r.user_id,
    provider: r.provider, plan: r.plan,
    codingAgent: r.coding_agent as CapabilityReadiness,
    externalUi: r.external_ui as CapabilityReadiness,
    nativeApi: r.native_api as CapabilityReadiness,
    statusSource: r.status_source as 'verified' | 'user_configured' | 'unknown',
    notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface DecisionRowDb {
  id: string; organization_id: string; project_id: string; work_item_id: string;
  requested_by: string | null; policy_version: number; benchmark_mode: string;
  task_profile: unknown; eligible_candidates: unknown; excluded_candidates: unknown;
  recommended_candidate: unknown | null; why_explanation: string;
  scores: Record<string, number>; benchmark_evidence: unknown; created_at: Date;
}
function mapDecision(r: DecisionRowDb): ExecutionPolicyDecisionRecord {
  return {
    id: r.id, organizationId: r.organization_id, projectId: r.project_id,
    workItemId: r.work_item_id, requestedBy: r.requested_by,
    policyVersion: r.policy_version, benchmarkMode: r.benchmark_mode as BenchmarkMode,
    taskProfile: r.task_profile as ExecutionPolicyDecisionRecord['taskProfile'],
    eligibleCandidates: r.eligible_candidates as ExecutionPolicyDecisionRecord['eligibleCandidates'],
    excludedCandidates: r.excluded_candidates as ExecutionPolicyDecisionRecord['excludedCandidates'],
    recommendedCandidate: r.recommended_candidate as ExecutionPolicyDecisionRecord['recommendedCandidate'],
    whyExplanation: r.why_explanation,
    scores: r.scores ?? {},
    benchmarkEvidence: r.benchmark_evidence as ExecutionPolicyDecisionRecord['benchmarkEvidence'],
    createdAt: r.created_at,
  };
}
