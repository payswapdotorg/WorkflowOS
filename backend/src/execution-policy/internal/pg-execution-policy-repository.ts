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
              max_executions_per_month, max_executions_per_day,
              rate_limit_max_requests, rate_limit_window_seconds,
              security_classification, external_security_ceiling,
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
                 max_executions_per_month, max_executions_per_day,
                 rate_limit_max_requests, rate_limit_window_seconds,
                 security_classification, external_security_ceiling,
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
    // WORK-043 (§33.3): quota + rate-limit + security columns.
    if ('maxExecutionsPerMonth' in input) push('max_executions_per_month', input.maxExecutionsPerMonth ?? null);
    if ('maxExecutionsPerDay' in input) push('max_executions_per_day', input.maxExecutionsPerDay ?? null);
    if ('rateLimitMaxRequests' in input) push('rate_limit_max_requests', input.rateLimitMaxRequests ?? null);
    if ('rateLimitWindowSeconds' in input) push('rate_limit_window_seconds', input.rateLimitWindowSeconds ?? null);
    if (input.securityClassification != null) push('security_classification', input.securityClassification);
    if ('externalSecurityCeiling' in input) push('external_security_ceiling', input.externalSecurityCeiling ?? null);
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
                  max_executions_per_month, max_executions_per_day,
                  rate_limit_max_requests, rate_limit_window_seconds,
                  security_classification, external_security_ceiling,
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
                  max_executions_per_month, max_executions_per_day,
                  rate_limit_max_requests, rate_limit_window_seconds,
                  security_classification, external_security_ceiling,
                  frozen, policy_version, created_at, updated_at`,
      [projectId],
    );
    const row = res.rows[0];
    return row ? mapProjectPolicy(row) : null;
  }

  // ---------------------------------------------------------------- usage (WORK-043)

  /**
   * The AR-043-01 DISPATCH PREDICATE — shared by both usage queries. A
   * logical execution row counts as EXECUTED only when a durable
   * provider-dispatch artifact exists:
   *
   *   dispatched(e) :=
   *     EXISTS (SELECT 1 FROM wfos_agent_runs r
   *              WHERE r.execution_id = e.execution_id)
   *     OR e.package_json IS NOT NULL
   *
   *   - NATIVE arm — wfos_agent_runs IS the durable native provider-operation
   *     ledger (PR #46 round 8): the AgentGateway creates the run row BEFORE
   *     invoking the adapter (and only after the adapter-support check), so
   *     a run row exists IFF the native provider operation actually
   *     initiated. A FAILED run still counts — the provider operation ran
   *     and consumed provider capacity. A pre-dispatch rejection (no model,
   *     no adapter) leaves NO run row and does not count. execution_id is
   *     UNIQUE on wfos_agent_runs → structurally one run per logical
   *     execution.
   *   - EXTERNAL arm — package_json IS the external dispatch artifact: it is
   *     persisted ONLY by the dispatch-outcome writes (the execution
   *     service's handoff_ready path and the cross-mode
   *     completeFencedDispatch gate), both strictly AFTER
   *     ExternalExecutionProvider.submit() succeeded. A provider-submit
   *     failure or a fence-lost dispatch leaves package_json NULL and does
   *     not count.
   *   - The predicate is deliberately MODE-INDEPENDENT (the artifact
   *     disjunction): a cross-mode handoff mutates mode BEFORE the target
   *     dispatch, so a mode-gated predicate would misclassify in-flight and
   *     failed handoffs.
   */
  private static readonly DISPATCHED_PREDICATE = `EXISTS (
        SELECT 1 FROM wfos_agent_runs r
         WHERE r.execution_id = e.execution_id
      )
      OR e.package_json IS NOT NULL`;

  /**
   * WORK-043 (§33.3) — QUOTA usage (AR-043-02): counts the project's LOGICAL
   * EXECUTIONS since `since` — ONE per execution row that actually
   * dispatched (the AR-043-01 predicate above), project-wide and
   * deliberately NOT provider-attributed: the policy columns are
   * max_executions_per_month / max_executions_per_day — the quota's unit is
   * the LOGICAL EXECUTION, so a cross-mode handed-off execution (two
   * provider dispatch phases — a native AgentRun row AND an external
   * package) consumes exactly ONE unit of quota. No parallel usage ledger:
   * the count is derived from the authoritative records at evaluation time.
   *
   * Returns NULL when the query fails: an ACTIVE quota whose usage cannot
   * be resolved fails CLOSED in the evaluator.
   */
  async countProjectDispatchedExecutionsSince(
    projectId: string,
    since: Date,
  ): Promise<number | null> {
    try {
      const res = await this.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
           FROM wfos_executions e
          WHERE e.project_id = $1
            AND e.created_at >= $2
            AND (${PgExecutionPolicyRepository.DISPATCHED_PREDICATE})`,
        [projectId, since],
      );
      return Number(res.rows[0]?.c ?? 0);
    } catch {
      // Unresolvable usage — the evaluator's fail-closed posture handles it.
      return null;
    }
  }

  /**
   * WORK-043 (§33.3) — RATE-LIMIT usage (AR-043-02 + AR-043-03): counts the
   * project's PROVIDER DISPATCH EVENTS since `since` for `provider` — each
   * ACTUAL dispatch attributed to the provider that dispatched it, never to
   * the execution row's (mutable, current) provider. The unit is the DISPATCH
   * EVENT (rate_limit_max_requests per sliding window), so a cross-mode
   * handed-off execution contributes ONE event to EACH provider that
   * actually dispatched. Three arms over the EXISTING authoritative
   * artifacts (NO parallel usage ledger — no dual-write, no drift):
   *
   *   1. NATIVE events — one per wfos_agent_runs ledger row, attributed to
   *      the run row's OWN provider (immutable — updateSuccess/updateFailed
   *      never touch it). Event time = the run row's created_at (the row is
   *      created immediately BEFORE the adapter invocation — the dispatch
   *      initiation). A FAILED run still dispatched.
   *   2. EXTERNAL events (the CURRENT external phase) — one per package
   *      artifact on the execution row, attributed to the package's OWN
   *      `provider` field (ExternalExecutionPackage is self-describing).
   *      Event time = the package's OWN `dispatchedAt` (AR-043-03): the
   *      AUTHORITATIVE dispatch-event timestamp stamped by the provider at
   *      the moment the dispatch initiated — NEVER the execution row's or
   *      the handoff log row's created_at (both are RESERVATION timestamps
   *      that can precede the actual dispatch by an arbitrary scheduling
   *      gap).
   *   3. EXTERNAL events (a HANDED-OFF-AWAY external phase) — one per
   *      previous_package_json snapshot in the append-only
   *      wfos_execution_mode_handoffs log (to_mode = 'native'), attributed
   *      to the snapshot package's OWN `provider` field. Event time = the
   *      SNAPSHOT's OWN `dispatchedAt` — the snapshot preserves the
   *      dispatched-away phase's authoritative dispatch timestamp (again
   *      NEVER the execution row's creation).
   *
   * Arms 2 and 3 are MUTUALLY EXCLUSIVE per external dispatch: arm 2
   * requires mode = 'external' (the current phase) while arm 3 requires
   * to_mode = 'native' (the phase was handed off away — transitionMode's
   * COALESCE RETAINS the prior package on the row, so the row's package
   * would otherwise be invisible after the handoff). Every external
   * dispatch is therefore counted EXACTLY ONCE, from exactly one arm.
   *
   * FAIL-CLOSED on a missing timestamp: both external arms count the event
   * when its package lacks `dispatchedAt` (COALESCE(..., TRUE)) — a dispatch
   * whose event time cannot be resolved is assumed IN the window
   * (conservative admission control; structurally impossible through the
   * typed package constructors, which REQUIRE the field). A MALFORMED
   * dispatchedAt throws in the cast → the whole query returns NULL → the
   * evaluator fails closed.
   */
  async countProjectProviderDispatchesSince(
    projectId: string,
    provider: string,
    since: Date,
  ): Promise<number | null> {
    try {
      const res = await this.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
           FROM (
                  -- (1) NATIVE dispatch events: the AgentRun ledger row's
                  --     OWN provider + OWN creation time (the row is created
                  --     immediately BEFORE the adapter invocation).
                  SELECT 1
                    FROM wfos_agent_runs r
                    JOIN wfos_executions e ON e.execution_id = r.execution_id
                   WHERE e.project_id = $1
                     AND r.provider = $2
                     AND r.created_at >= $3
                  UNION ALL
                  -- (2) EXTERNAL dispatch events — the CURRENT external
                  --     phase's package artifact (self-describing provider).
                  --     Event time = the package's OWN dispatchedAt — the
                  --     AUTHORITATIVE dispatch timestamp (AR-043-03), NEVER
                  --     the execution/handoff-log row creation (reservations).
                  --     COALESCE(..., TRUE): a package without dispatchedAt
                  --     counts FAIL-CLOSED (assumed in-window).
                  SELECT 1
                    FROM wfos_executions e
                   WHERE e.project_id = $1
                     AND e.mode = 'external'
                     AND e.package_json IS NOT NULL
                     AND e.package_json->>'provider' = $2
                     AND COALESCE((e.package_json->>'dispatchedAt')::timestamptz >= $3, TRUE)
                  UNION ALL
                  -- (3) EXTERNAL dispatch events — the HANDED-OFF-AWAY
                  --     external phase's package snapshot in the append-only
                  --     handoff log. Event time = the SNAPSHOT's OWN
                  --     dispatchedAt (the snapshot preserves the dispatched-
                  --     away phase's authoritative dispatch timestamp).
                  --     COALESCE(..., TRUE): fail-closed as in arm (2).
                  SELECT 1
                    FROM wfos_execution_mode_handoffs h
                    JOIN wfos_executions e ON e.id = h.execution_record_id
                   WHERE e.project_id = $1
                     AND h.to_mode = 'native'
                     AND h.previous_package_json IS NOT NULL
                     AND h.previous_package_json->>'provider' = $2
                     AND COALESCE((h.previous_package_json->>'dispatchedAt')::timestamptz >= $3, TRUE)
                ) dispatch_events`,
        [projectId, provider, since],
      );
      return Number(res.rows[0]?.c ?? 0);
    } catch {
      // Unresolvable usage — the evaluator's fail-closed posture handles it.
      return null;
    }
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
  max_executions_per_month: number | null; max_executions_per_day: number | null;
  rate_limit_max_requests: number | null; rate_limit_window_seconds: number | null;
  security_classification: string; external_security_ceiling: string | null;
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
    maxExecutionsPerMonth: r.max_executions_per_month,
    maxExecutionsPerDay: r.max_executions_per_day,
    rateLimitMaxRequests: r.rate_limit_max_requests,
    rateLimitWindowSeconds: r.rate_limit_window_seconds,
    securityClassification: (r.security_classification ?? 'standard') as ProjectPolicyRecord['securityClassification'],
    externalSecurityCeiling: (r.external_security_ceiling ?? null) as ProjectPolicyRecord['externalSecurityCeiling'],
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
