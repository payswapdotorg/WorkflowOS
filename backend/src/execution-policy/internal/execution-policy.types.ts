/**
 * WORK-033 — internal contracts + persistence interface.
 *
 * Boundary (mirrors the §34 benchmark pattern): the execution-policy domain
 * lives at `src/execution-policy/` (NOT src/modules/). It CONSUMES the 17
 * frozen modules via their public barrels (`@modules/*`) + `@platform/*`.
 * It NEVER imports any module's `/internal/`. It NEVER stores credentials.
 * It NEVER mutates workflow state.
 */
import type { DatabaseClient } from '@platform/postgres/database-client.js';
import type { Logger } from '@platform/logger.js';
import type {
  ExecutionPolicyDecisionRecord,
  ProjectPolicyRecord,
  UserPreferenceRecord,
  ProviderAccessProfileRecord,
  UpdateProjectPolicyInput,
  UpdateUserPreferencesInput,
  UpsertAccessProfileInput,
} from '../types.js';

/**
 * Append-only + project/user policy persistence. Hand-written parameterized
 * SQL (the WorkflowOS convention — no ORM). Tenant scoping enforced by
 * organization_id / project_id / user_id on every row.
 */
export interface ExecutionPolicyRepository {
  // --- project policy ---
  getProjectPolicy(projectId: string): Promise<ProjectPolicyRecord | null>;
  /** Insert a default policy (externalExecutionAllowed=true, nativeExecutionAllowed=true, ...). */
  insertDefaultProjectPolicy(organizationId: string, projectId: string): Promise<ProjectPolicyRecord>;
  updateProjectPolicy(projectId: string, input: UpdateProjectPolicyInput): Promise<ProjectPolicyRecord | null>;
  freezeProjectPolicy(projectId: string): Promise<ProjectPolicyRecord | null>;

  // --- user preferences ---
  getUserPreferences(userId: string): Promise<UserPreferenceRecord | null>;
  insertDefaultUserPreferences(organizationId: string, userId: string): Promise<UserPreferenceRecord>;
  updateUserPreferences(userId: string, input: UpdateUserPreferencesInput): Promise<UserPreferenceRecord | null>;

  // --- provider access profiles ---
  listAccessProfiles(userId: string): Promise<ProviderAccessProfileRecord[]>;
  upsertAccessProfile(organizationId: string, userId: string, input: UpsertAccessProfileInput): Promise<ProviderAccessProfileRecord>;

  // --- append-only decision audit (§22) ---
  /**
   * PR #37 review fix (TOCTOU): ATOMIC SNAPSHOT-VALIDATED decision insert.
   * ONE statement checks the CURRENT authoritative policy row at insert
   * time and inserts ONLY when the snapshot the recommendation was
   * computed from is still exact:
   *
   *   current policy_version == guard.snapshotPolicyVersion
   *   AND (current frozen = false OR row.benchmarkMode == current default
   *        benchmark mode)
   *
   * Returns NULL when the guard rejects the insert (the policy mutated —
   * including a §9 freeze, which bumps the version — or the policy is
   * frozen with a differing effective mode): the caller retries with a
   * fresh policy read. Invariant: every PERSISTED decision corresponds to
   * one exact, currently authoritative policy version.
   */
  insertDecision(organizationId: string, projectId: string, workItemId: string, requestedBy: string | null, row: DecisionRow, guard: DecisionSnapshotGuard): Promise<ExecutionPolicyDecisionRecord | null>;
  listDecisions(workItemId: string, limit?: number): Promise<ExecutionPolicyDecisionRecord[]>;

  // --- WORK-043 (§33.3): quota / rate-limit usage derivation ---
  //
  // AR-043-02 — the two usage models are DISTINCT (the shared
  // one-predicate-for-both seam conflated them):
  //
  //   quota usage
  //     → LOGICAL EXECUTIONS (the max_executions_per_month/day unit —
  //       one per execution row that dispatched, project-wide)
  //   rate-limit usage
  //     → PROVIDER DISPATCH EVENTS (the rate_limit_max_requests unit —
  //       each actual dispatch attributed to the provider that
  //       dispatched it, per sliding window)
  //
  // Both are derived at evaluation time from the EXISTING authoritative
  // records through the AR-043-01 DISPATCH PREDICATE — NO parallel usage
  // ledger:
  //
  //   dispatched(e) := EXISTS (a wfos_agent_runs row for e.execution_id)
  //                    OR e.package_json IS NOT NULL
  //
  // An AgentRun ledger row is the durable native provider-operation record
  // (created by the gateway BEFORE the adapter invocation — a failed run
  // still dispatched); package_json is the external dispatch artifact
  // (persisted only after ExternalExecutionProvider.submit succeeded). A
  // merely-created record, a pre-dispatch rejection, or an attempt that
  // failed before provider submission is NOT a dispatch — it never counts
  // in EITHER model. NULL = the usage is unresolvable → an ACTIVE
  // quota/rate limit FAILS CLOSED in the evaluator.
  /**
   * QUOTA usage — the project's LOGICAL EXECUTIONS since `since` (one per
   * execution row that actually dispatched — the AR-043-01 predicate;
   * project-wide, NOT provider-attributed). A cross-mode handed-off
   * execution (two dispatch phases) is ONE logical execution: exactly ONE
   * unit of quota.
   */
  countProjectDispatchedExecutionsSince(projectId: string, since: Date): Promise<number | null>;
  /**
   * RATE-LIMIT usage — the project's PROVIDER DISPATCH EVENTS since `since`
   * for `provider`: each ACTUAL dispatch counted once and attributed to the
   * provider that dispatched it (the AgentRun ledger row's OWN provider —
   * native; the ExternalExecutionPackage's OWN provider field — external,
   * including a handed-off-away external phase's snapshot in the append-only
   * handoff log). A cross-mode handed-off execution contributes ONE event
   * to EACH provider that dispatched.
   */
  countProjectProviderDispatchesSince(projectId: string, provider: string, since: Date): Promise<number | null>;
}

/**
 * PR #37 review fix (TOCTOU): the atomic decision-write guard — the policy
 * snapshot the recommendation was computed from (its version) + the
 * effective benchmark mode of the decision, both validated against the
 * CURRENT policy row inside the insert statement.
 */
export interface DecisionSnapshotGuard {
  /** The policy_version the recommendation read (the snapshot version). */
  readonly snapshotPolicyVersion: number;
}

export interface DecisionRow {
  policyVersion: number;
  benchmarkMode: string;
  taskProfile: unknown;
  eligibleCandidates: unknown;
  excludedCandidates: unknown;
  recommendedCandidate: unknown;
  whyExplanation: string;
  scores: Record<string, number>;
  benchmarkEvidence: unknown;
}

export interface DefaultExecutionPolicyServiceDeps {
  readonly db: DatabaseClient;
  readonly logger: Logger;
  readonly repository: ExecutionPolicyRepository;
  /** §3: the HARD filter. */
  readonly eligibilityService: ExecutionEligibilityServiceLike;
  /** §13: ordered scoring (preserves capability ceiling). */
  readonly recommendationService: ExecutionRecommendationServiceLike;
  /** §15: derives ExecutionTaskProfile from a Work Item (no new authority). */
  readonly taskProfileBuilder: ExecutionTaskProfileBuilderLike;
  /** §6: provider capability source — @modules/agents AgentProviderRegistryService. */
  readonly agentProviderRegistry: AgentProviderRegistryLike;
  /** §14: historical performance evidence from WORK-032 benchmark. */
  readonly benchmarkEvidenceProvider: BenchmarkEvidenceProviderLike;
  /** §31/§32: org-policy resolver (deferred persistence — §32). */
  readonly orgPolicyResolver?: OrgPolicyResolverLike;
  /**
   * WORK-043 (§33.3): the project-scoped agent-policy external-domain gate
   * (WORK-037). Optional — when ABSENT the constraint family is INACTIVE
   * (externalDecision 'allow': this layer has no recommendation-time input,
   * and the RUNTIME boundaries — the policy-gated handoff decorator + the
   * cross-mode handoff gate — still enforce the agent policy). When WIRED:
   * the engine's decision flows into the constraint set (the engine itself
   * fails closed to 'deny' on internal errors); a THROWN error becomes
   * 'unresolved' → external candidates fail closed. Wired in app.ts to the
   * AgentPolicyEngine's evaluateExternalForProject.
   */
  readonly agentPolicyProjectGate?: AgentPolicyProjectGateLike;
  /** WORK-043: clock seam (period/window boundaries). Defaults to real time. */
  readonly now?: () => Date;
}

// Local structural interfaces so this file does NOT import the service files
// (avoid a cycle: service files import these types). They are structurally
// compatible with the public service interfaces in ../types.ts.

export interface ExecutionEligibilityServiceLike {
  evaluate(input: import('../types.js').EligibilityEvaluationInput): import('../types.js').ExecutionEligibilityResult;
}

export interface ExecutionRecommendationServiceLike {
  rank(input: import('../types.js').RankInput): import('../types.js').RankResult;
}

export interface ExecutionTaskProfileBuilderLike {
  build(workItemId: string): Promise<import('../types.js').ExecutionTaskProfile>;
}

export interface AgentProviderRegistryLike {
  getExecutionProviders(projectId?: string): Promise<readonly {
    name: string;
    provider: string;
    model: string;
    nativeApi: 'ready' | 'not-configured';
    externalUi: 'available' | 'not-supported';
    capabilities?: {
      conversationalChat: 'ready' | 'unverified' | 'not-available';
      codingAgent: 'ready' | 'unverified' | 'not-available';
      implementationSurface: 'conversational-chat' | 'coding-agent';
    };
  }[]>;
  isExternalProviderSupported(provider: string, projectId?: string): Promise<boolean>;
}

export interface BenchmarkEvidenceProviderLike {
  /** §14: aggregate historical performance for a (provider, mode) cell across experiments. */
  historicalPerformanceForCell(projectId: string, provider: string, mode: 'native' | 'external'): Promise<import('../types.js').HistoricalPerformance>;
  /** §14: aggregate across all eligible cells for a project (for the overall recommendation evidence). */
  aggregateForProject(projectId: string): Promise<import('../types.js').HistoricalPerformance>;
}

/** §32: resolved org policy (persistence deferred; resolved via composition root). */
export interface ResolvedOrgPolicy {
  readonly allowedProviders: readonly string[];
  readonly allowedExecutionModes: readonly ('native' | 'external')[];
  readonly externalExecutionAllowed: boolean;
  readonly maximumCostCents: number | null;
  readonly requiredPrivacyLevel: string | null;
}

export interface OrgPolicyResolverLike {
  resolve(organizationId: string): Promise<ResolvedOrgPolicy>;
}

/**
 * WORK-043 (§33.3): the project-scoped agent-policy external-domain gate —
 * the narrow port of the WORK-037 AgentPolicyEngine's ADDITIVE
 * `evaluateExternalForProject` entry (non-interactive: 'ask' stays 'ask' —
 * a recommendation cannot pre-approve a future handoff). Structurally
 * compatible with AgentPolicyExternalDecision from @modules/agents.
 */
export interface AgentPolicyProjectGateLike {
  evaluateExternalForProject(input: {
    organizationId: string;
    projectId: string;
  }): Promise<{
    decision: 'allow' | 'deny' | 'ask' | 'constrained';
    reason: string | null;
    policyVersion: number | null;
    scopeSource?: string | null;
  }>;
}
