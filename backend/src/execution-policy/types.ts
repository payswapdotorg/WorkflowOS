/**
 * WORK-033 — Execution Policy & Fair Benchmarking (PUBLIC CONTRACT)
 *
 * The execution-policy layer is an APPLICATION-LAYER ORCHESTRATOR that lives
 * at `src/execution-policy/` (mirrors the §34 benchmark pattern: it is NOT
 * the 18th frozen module — it CONSUMES the 17 frozen modules via their
 * public barrels `@modules/*` + `@platform/*`).
 *
 * PRODUCT PRINCIPLE (§1, §21):
 *   WorkflowOS SHALL NOT intentionally degrade an eligible provider's
 *   capability to equalize benchmark outcomes unless the benchmark
 *   explicitly uses CONTROLLED_COMPARISON mode and the restriction is part
 *   of its policy.
 *
 *   > Constraints decide who may compete; benchmark evidence helps decide
 *   > who should win; capability is never intentionally suppressed.
 *
 * This layer is ADVISORY ONLY (§27, §34 — does NOT build adaptive routing):
 *   - It does NOT mutate workflow state (no INSERT INTO wfos_workflow_*).
 *   - It does NOT evaluate verification / approve reviews / merge PRs.
 *   - It does NOT create another ExecutionService.
 *   - It does NOT bypass ExecutionService.submit() — the caller submits.
 *   - It NEVER stores credentials. The candidate is metadata only (§2).
 */

import type { ExecutionMode } from '@modules/agents';
import type { BenchmarkCellStatistics } from '../benchmark/index.js';

// ============================================================================
// §2  EXECUTION CANDIDATE — metadata only; NEVER carries secrets
// ============================================================================

/**
 * A candidate execution strategy under evaluation. Pure metadata: provider,
 * model, surface, capabilities, availability, eligibility, cost/latency
 * estimates, historical performance, subscription status, policy status,
 * and a recommendation score.
 *
 * §2: MUST NEVER contain API keys, callback tokens, handoff tokens, cookies,
 * or provider auth material. (Enforced by static-architecture checks +
 * the migration has no such columns.)
 */
export interface ExecutionCandidate {
  readonly provider: string;
  readonly name: string;
  readonly model: string;
  readonly executionMode: ExecutionMode;
  /** §6 normalized surface/capability profile (composed from ExecutionProviderInfo). */
  readonly capabilities: ProviderCapabilityProfile;
  /** §5 user-configured subscription capability profile (or 'unknown'). */
  readonly accessProfile: ProviderAccessProfile | null;
  /** §23 normalized provider readiness. */
  readonly availability: ProviderAvailability;
  /** §3 eligibility verdict + blocking reasons (if any). */
  readonly eligibility: ExecutionEligibilityResult;
  /** §24 estimated cost. NEVER fabricated. */
  readonly estimatedCost: CostEstimate;
  /** §25 estimated latency (authoritative WorkflowOS timestamps only). */
  readonly estimatedLatency: LatencyEstimate;
  /** §14 historical performance evidence (may be insufficient). */
  readonly historicalPerformance: HistoricalPerformance;
  /** §4/§9 policy-status snapshot at evaluation time. */
  readonly policyStatus: PolicyStatus;
  /** §13 normalized recommendation score [0..1]. Eligible candidates only. */
  readonly recommendationScore: number;
}

// ============================================================================
// §6  PROVIDER CAPABILITY PROFILE — normalized, NEVER invented
// ============================================================================

/**
 * Normalized capability profile for a provider. Composed FROM EXISTING
 * metadata (`ExecutionProviderInfo` + `EXTERNAL_UI_CATALOG` from
 * @modules/agents) — NEVER hard-coded invented capabilities (§6, static
 * check enforces no second catalog).
 */
export interface ProviderCapabilityProfile {
  readonly conversational: CapabilityReadiness;
  readonly codingAgent: CapabilityReadiness;
  readonly browser: CapabilityReadiness;
  readonly repositoryAccess: CapabilityReadiness;
  readonly terminal: CapabilityReadiness;
  readonly nativeApi: CapabilityReadiness;
  readonly externalUi: CapabilityReadiness;
  readonly streaming: CapabilityReadiness;
  readonly toolUse: CapabilityReadiness;
  readonly maxContext: ContextWindow;
  /** Which execution modes this provider supports. */
  readonly supportedExecutionModes: readonly ExecutionMode[];
}

export type CapabilityReadiness = 'supported' | 'ready' | 'unverified' | 'unavailable';

export interface ContextWindow {
  readonly tokens: number | null;
  readonly source: 'provider_doc' | 'user_configured' | 'unknown';
}

// ============================================================================
// §5  PROVIDER ACCESS PROFILE — user-configured subscription capability
// ============================================================================

/**
 * §5: explicit, user-configured capability profile. WorkflowOS does NOT
 * scrape provider billing pages and does NOT collect provider credentials.
 * `statusSource = 'unknown'` MUST NOT automatically become available.
 */
export interface ProviderAccessProfile {
  readonly provider: string;
  readonly plan: string | null;
  readonly codingAgent: CapabilityReadiness;
  readonly externalUi: CapabilityReadiness;
  readonly nativeApi: CapabilityReadiness;
  readonly statusSource: 'verified' | 'user_configured' | 'unknown';
}

// ============================================================================
// §23 PROVIDER STATUS (normalized)
// ============================================================================

export type ProviderAvailability =
  | 'ready'
  | 'unverified'
  | 'unavailable'
  | 'subscription_blocked'
  | 'capability_blocked'
  | 'policy_blocked'
  | 'configuration_missing';

/**
 * §9: the policy-status snapshot at evaluation time — the eligibility verdict
 * captured on the candidate for the UI. Distinct from ProviderAvailability
 * (which is the provider's runtime readiness) — PolicyStatus is the
 * policy-layer verdict that composes availability + constraints.
 */
export type PolicyStatus = ExecutionEligibilityStatus;

// ============================================================================
// §3  ELIGIBILITY — HARD filter
// ============================================================================

export type ExecutionEligibilityStatus =
  | 'eligible'
  | 'unavailable'
  | 'subscription_blocked'
  | 'capability_blocked'
  | 'unknown_constrained'
  | 'policy_blocked'
  | 'privacy_blocked'
  | 'project_policy_blocked'
  | 'configuration_missing'
  | 'provider_temporarily_unavailable'
  /** WORK-043 — the project execution quota for the current period is exhausted (or unverifiable, fail-closed). */
  | 'quota_exhausted'
  /** WORK-043 — the per-provider rate-limit window is exhausted (or unverifiable, fail-closed). */
  | 'rate_limited'
  /** WORK-043 — the project security classification exceeds the destination-mode security ceiling. */
  | 'security_blocked'
  /** WORK-043 — the agent policy denies / requires approval for the candidate's execution domain. */
  | 'agent_policy_blocked';

/**
 * §3: Eligibility is a HARD filter. Benchmark quality MUST NEVER make an
 * ineligible candidate eligible. Each blocking reason names the constraint
 * category that excluded the candidate (§4) so the frontend can show "why".
 */
export interface ExecutionEligibilityResult {
  readonly status: ExecutionEligibilityStatus;
  readonly eligible: boolean;
  /** Empty iff eligible. Each reason is human-readable + structured. */
  readonly blockingReasons: readonly EligibilityBlock[];
  /** For eligible candidates, the constraints satisfied (transparency). */
  readonly satisfiedConstraints: readonly string[];
}

export interface EligibilityBlock {
  readonly category: ExecutionConstraintCategory;
  readonly constraint: string;
  readonly reason: string;
}

// ============================================================================
// §4  HARD CONSTRAINT CATEGORIES
// ============================================================================

export type ExecutionConstraintCategory =
  | 'capability'
  | 'user'
  | 'project'
  | 'organization'
  | 'availability'
  | 'subscription'
  | 'privacy'
  /**
   * PR #37 review fix (fail-closed constrained modes): a constrained
   * benchmark mode (§8) whose required cost/latency EVIDENCE is unknown for
   * this candidate. Unknown evidence under an explicit maximum constraint
   * is NOT neutral — the candidate cannot legitimately be declared eligible
   * (fail-closed), because the constraint cannot be verified.
   */
  | 'evidence'
  /**
   * WORK-043 — quota constraints: the project's execution quota for the
   * current period (monthly/daily) is exhausted, or an active quota cannot
   * be verified against usage (fail-closed). Quotas are eligibility inputs
   * (§33.3), never quality scores.
   */
  | 'quota'
  /**
   * WORK-043 — rate-limit constraints: the per-provider sliding-window
   * dispatch limit is exhausted, or an active rate limit cannot be verified
   * against current window usage (fail-closed).
   */
  | 'rate_limit'
  /**
   * WORK-043 — security requirements: the project's security classification
   * exceeds what the destination mode is permitted to carry (the external
   * execution ceiling). Security is a hard constraint (§33.3), not a
   * preference.
   */
  | 'security'
  /**
   * WORK-043 — agent-policy constraints (WORK-037): the project-scoped agent
   * policy denies (or requires approval for) the candidate's execution
   * domain. Policies apply to native execution and to external handoff
   * eligibility/observability (WORK-037 execution modes).
   */
  | 'agent_policy';

/**
 * §4: the full constraint set evaluated for a candidate. This is the input to
 * the eligibility service (NOT the candidate itself). Constraint sets are
 * composable: project + user + org + availability + capability + subscription.
 */
export interface ExecutionConstraintSet {
  readonly capability: readonly CapabilityConstraint[];
  readonly user: UserConstraints;
  readonly project: ProjectConstraints;
  readonly organization: OrganizationConstraints;
  readonly availability: AvailabilityConstraints;
  readonly subscription: SubscriptionConstraints;
  readonly privacy: PrivacyConstraints;
  /** WORK-043: quota constraints (period execution limits + current usage). */
  readonly quota: QuotaConstraints;
  /** WORK-043: rate-limit constraints (per-provider sliding window + usage). */
  readonly rateLimit: RateLimitConstraints;
  /** WORK-043: security requirements (project classification + mode ceilings). */
  readonly security: SecurityConstraints;
  /** WORK-043: the project-scoped agent-policy decision (WORK-037). */
  readonly agentPolicy: AgentPolicyConstraints;
}

export interface CapabilityConstraint {
  readonly kind: CapabilityRequirement;
  readonly required: boolean;
}

export type CapabilityRequirement =
  | 'coding_agent'
  | 'browser'
  | 'repository_access'
  | 'terminal'
  | 'private_network'
  | 'native_api'
  | 'external_ui';

/**
 * §4.2 user-scoped HARD constraints. NOTE (PR #37 review fix): these are
 * constraints the user has EXPLICITLY configured as hard (e.g. a budget
 * cap). §12 PREFERENCES (preferredMode, externalPreferred, nativePreferred,
 * the scoring weights) are ADVISORY and must NEVER be routed into this
 * set — they influence RECOMMENDATION ranking only. A preferredMode is not
 * an allowedModes restriction: preferring external must never make a
 * native candidate (that is fully allowed by every hard constraint)
 * ineligible.
 */
export interface UserConstraints {
  readonly allowedProviders: readonly string[];
  readonly allowedModes: readonly ExecutionMode[];
  readonly monthlyBudgetCents: number | null;
  readonly maxPerTaskCostCents: number | null;
}

export interface ProjectConstraints {
  readonly externalExecutionAllowed: boolean;
  readonly nativeExecutionAllowed: boolean;
  readonly providerAllowlist: readonly string[];
  readonly providerDenylist: readonly string[];
  readonly allowedModes: readonly ExecutionMode[];
  readonly localOnly: boolean;
  readonly privateRepositoryPolicy: boolean;
  readonly dataResidency: string | null;
}

export interface OrganizationConstraints {
  readonly approvedModelsOnly: readonly string[];
  readonly approvedProvidersOnly: readonly string[];
  readonly noThirdPartyBrowserAutomation: boolean;
  readonly maximumExecutionCostCents: number | null;
  readonly securityClassification: string | null;
}

export interface AvailabilityConstraints {
  readonly providerUnavailable: readonly string[];
  readonly modelUnavailable: readonly string[];
  readonly externalCompanionInstalled: boolean;
  readonly codingSurfaceVerified: readonly string[];
}

export interface SubscriptionConstraints {
  /** §5: candidates whose subscription capability is 'unknown' default to blocked. */
  readonly blockUnknownSubscription: boolean;
  readonly requiredCodingAgentProviders: readonly string[];
}

export interface PrivacyConstraints {
  readonly level: PrivacyLevel;
  readonly approvedLocations: readonly string[];
}

export type PrivacyLevel = 'standard' | 'private' | 'local_only' | 'regulated';

// ============================================================================
// WORK-043 — §33.3 constraint families: quota, rate limits, security, agent policy
// ============================================================================

/**
 * WORK-043 — the security classification ladder. Ordered:
 *   standard (0) < confidential (1) < restricted (2).
 * A mode may carry a classification only when classification ≤ mode ceiling.
 */
export type SecurityClassification = 'standard' | 'confidential' | 'restricted';

export const SECURITY_CLASSIFICATION_RANK: Readonly<Record<SecurityClassification, number>> =
  Object.freeze({ standard: 0, confidential: 1, restricted: 2 });

/**
 * WORK-043 — quota constraints (§33.3 "quota"). Period execution limits are
 * ELIGIBILITY INPUTS, never quality scores. Usage counts are resolved by the
 * orchestrator from the AUTHORITATIVE execution records (wfos_executions —
 * no parallel usage ledger). A configured quota whose usage is UNRESOLVABLE
 * (null) fails CLOSED: the candidate cannot be declared eligible against a
 * constraint that cannot be verified (the fail-closed evidence precedent).
 */
export interface QuotaConstraints {
  /** Max executions per calendar month (project-wide). NULL = unlimited. */
  readonly monthlyMaxExecutions: number | null;
  /** Max executions per calendar day (project-wide). NULL = unlimited. */
  readonly dailyMaxExecutions: number | null;
  /** Executions dispatched in the CURRENT calendar month. NULL = unresolvable. */
  readonly monthlyUsed: number | null;
  /** Executions dispatched in the CURRENT calendar day. NULL = unresolvable. */
  readonly dailyUsed: number | null;
}

/**
 * WORK-043 — rate-limit constraints (§33.3 "rate limits"). A per-provider
 * sliding window over dispatch events. `providerWindowUsage` maps provider →
 * dispatch count inside the trailing window; NULL = usage unresolvable
 * (fail-closed while a limit is active). Providers absent from the map used
 * 0 — the usage query is provider-scoped only for the evaluated candidate's
 * provider (the pure evaluator reads `providerWindowUsage[candidate.provider]`).
 */
export interface RateLimitConstraints {
  /** Max dispatches per window PER PROVIDER. NULL = no rate limit. */
  readonly maxRequestsPerWindow: number | null;
  /** The sliding-window width in seconds. Required when maxRequestsPerWindow is set. */
  readonly windowSeconds: number | null;
  /** provider → dispatches in the trailing window. NULL = unresolvable (fail-closed). */
  readonly providerWindowUsage: Readonly<Record<string, number>> | null;
}

/**
 * WORK-043 — security requirements (§33.3 "security constraints"). The
 * project's data classification vs. the classification ceiling each execution
 * mode is permitted to carry. Native execution stays inside the WorkflowOS
 * boundary; EXTERNAL execution sends code/context to a third-party provider
 * product — the external ceiling bounds what may leave.
 */
export interface SecurityConstraints {
  /** The project's security classification. */
  readonly projectClassification: SecurityClassification;
  /**
   * The maximum classification EXTERNAL execution may carry
   * (NULL = no external security restriction beyond privacy constraints).
   */
  readonly externalCeiling: SecurityClassification | null;
}

/**
 * WORK-043 — the project-scoped agent-policy decision (WORK-037) as a
 * constraint input. Resolved ONCE per evaluation scope by the orchestrator
 * (the external-domain rule is project-scoped — it is not
 * provider-refined), then applied by the pure evaluator to the affected
 * candidates.
 */
export interface AgentPolicyConstraints {
  /**
   * The project-scoped external-domain decision:
   *   'allow'       → external candidates pass this family
   *   'constrained' → pass (the constraints are advisory to the runtime)
   *   'deny'        → external candidates blocked (agent_policy_blocked)
   *   'ask'         → blocked pending approval (a recommendation cannot
   *                   pre-approve a future handoff — non-interactive context)
   *   'unresolved'  → the policy engine could not resolve a decision —
   *                   FAIL-CLOSED for external candidates
   */
  readonly externalDecision: 'allow' | 'constrained' | 'deny' | 'ask' | 'unresolved';
  readonly reason: string | null;
  readonly policyVersion: number | null;
}

// ============================================================================
// §8  BENCHMARK MODES + §9 BENCHMARK POLICY (immutable once experiment starts)
// ============================================================================

export type BenchmarkMode =
  | 'maximum_capability'
  | 'controlled_comparison'
  | 'cost_constrained'
  | 'latency_constrained'
  | 'subscription_constrained'
  | 'privacy_constrained';

/**
 * §9: BenchmarkPolicy. Persists a version (`policyVersion`); policies are
 * IMMUTABLE once an experiment starts (enforced by DB trigger +
 * `BenchmarkPolicy.frozen`). The policy is the source of truth for which
 * dimensions are controlled vs. free.
 */
export interface BenchmarkPolicy {
  readonly benchmarkMode: BenchmarkMode;
  readonly maxCostCents: number | null;
  readonly maxDurationMs: number | null;
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  readonly allowedProviders: readonly string[];
  readonly allowedModes: readonly ExecutionMode[];
  readonly privacyRequirements: PrivacyConstraints;
  readonly subscriptionRequirement: SubscriptionConstraints;
  readonly toolPolicy: ToolPolicy;
  readonly humanInterventionPolicy: HumanInterventionPolicy;
  readonly policyVersion: number;
  /** §9: set true when a benchmark experiment starts; thereafter immutable. */
  readonly frozen: boolean;
}

export interface ToolPolicy {
  /** §10: controlled comparison keeps tool CLASS fixed but persists impl differences. */
  readonly toolClassFixed: boolean;
  /** §11: maximum-capability mode — each candidate uses its strongest config. */
  readonly maximumCapability: boolean;
  /** §21: NEVER artificially cap a provider's tools solely for fairness. */
  readonly noArtificialCaps: boolean;
}

export interface HumanInterventionPolicy {
  readonly allowed: boolean;
  /** If false, external strategies that require user confirmation become ineligible (§26). */
  readonly blockIfRequired: boolean;
}

// ============================================================================
// §10 CONTROLLED COMPARISON — which dimensions are actually controlled
// ============================================================================

/**
 * §10: For controlled benchmark experiments, the system MUST display which
 * dimensions are actually controlled (✓) vs. genuinely differ (≠). Do NOT
 * falsely label a benchmark "equal" when execution environments differ.
 */
export interface ControlledComparisonDimensions {
  readonly sameTask: boolean;
  readonly sameArchitecture: boolean;
  readonly sameBaseline: boolean;
  readonly sameImplementationContext: boolean;
  readonly sameVerification: boolean;
  readonly comparableToolClass: boolean;
  readonly differingSurfaces: boolean;        // native vs external ≠
  readonly differingContextWindow: boolean;   // provider context ≠
  readonly differingToolImplementation: boolean; // provider tool impl ≠
}

// ============================================================================
// §12 USER PREFERENCES — advisory; NEVER override hard constraints
// ============================================================================

export interface ExecutionPreferenceProfile {
  readonly quality: number;
  readonly cost: number;
  readonly latency: number;
  readonly privacy: number;
  readonly preferredMode: ExecutionMode | null;
  readonly externalPreferred: boolean;
  readonly nativePreferred: boolean;
  readonly defaultBenchmarkMode: BenchmarkMode;
}

// ============================================================================
// §15 EXECUTION TASK PROFILE — derived metadata (NOT another authority)
// ============================================================================

/**
 * §15: derived from the Work Item / Work Order + ImplementationContext. This
 * is DERIVED METADATA feeding eligibility + recommendation — it is NOT another
 * authority for architecture/requirements (those remain with /architecture,
 * /requirements, /work-items).
 */
export interface ExecutionTaskProfile {
  readonly language: string | null;
  readonly framework: string | null;
  readonly repositorySize: 'small' | 'medium' | 'large' | 'unknown';
  readonly complexity: 'low' | 'medium' | 'high' | 'unknown';
  readonly architectureSensitivity: 'low' | 'medium' | 'high';
  readonly securitySensitivity: 'low' | 'medium' | 'high';
  readonly browserRequired: boolean;
  readonly terminalRequired: boolean;
  readonly repositoryAccess: boolean;
  readonly externalExecutionAllowed: boolean;
  readonly nativeExecutionAllowed: boolean;
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  readonly humanInterventionLikely: boolean;
}

// ============================================================================
// §24 COST + §25 LATENCY — never fabricated
// ============================================================================

export type CostConfidence = 'known' | 'estimated' | 'unknown';

export interface CostEstimate {
  readonly cents: number | null;
  readonly confidence: CostConfidence;
  /** §24: unknown cost shown as unknown; never fabricated. */
  readonly currency: string;
}

export interface LatencyEstimate {
  readonly estimatedMs: number | null;
  readonly confidence: CostConfidence;
  /** §25: authoritative WorkflowOS timestamps only; no provider self-report. */
  readonly source: 'historical_observed' | 'estimated' | 'unknown';
}

// ============================================================================
// §14 HISTORICAL PERFORMANCE — consume WORK-032 benchmark evidence
// ============================================================================

export interface HistoricalPerformance {
  readonly sampleSize: number;
  readonly sufficient: boolean;            // §14: never treat 1 run as definitive
  readonly observedQuality: number | null; // mean engineeringQualityScore
  readonly ciFirstPassRate: number | null;
  readonly verificationFirstPassRate: number | null;
  readonly medianCorrectionCycles: number | null;
  readonly medianTimeToVerifiedMs: number | null;
  readonly humanInterventionCount: number | null;
  /** §22: which (provider, mode) cells backed this (audit trail). */
  readonly evidenceCells: readonly BenchmarkCellStatistics[];
}

// ============================================================================
// §13/§16 EXECUTION RECOMMENDATION
// ============================================================================

/**
 * §16: the recommendation response. Includes the recommended candidate, all
 * eligible candidates, excluded candidates WITH reasons, benchmark evidence,
 * the policy snapshot, and the task profile. Returned by
 * `GET /work-items/:workItemId/execution/recommendation`.
 */
export interface ExecutionRecommendation {
  readonly workItemId: string;
  readonly recommendedCandidate: ExecutionCandidate | null;
  readonly eligibleCandidates: readonly ExecutionCandidate[];
  readonly excludedCandidates: readonly ExecutionCandidate[];
  /** §16/§19 Why explanation — structured, never "AI chose this". */
  readonly why: RecommendationWhy;
  /** §14 benchmark evidence summary backing the recommendation. */
  readonly benchmarkEvidence: HistoricalPerformance;
  /** §9 the policy snapshot at decision time. */
  readonly policy: BenchmarkPolicy;
  /** §15 the derived task profile. */
  readonly taskProfile: ExecutionTaskProfile;
  /** §22 immutable decision record id (append-only audit). */
  readonly decisionId: string;
}

export interface RecommendationWhy {
  readonly recommendedCandidateId: string | null;
  readonly headline: string;
  readonly reasons: readonly RecommendationReason[];
  /** §17: eligible candidates the user could select instead. */
  readonly alternatives: readonly string[];
}

export interface RecommendationReason {
  readonly dimension: RecommendationDimension;
  readonly satisfied: boolean;
  readonly detail: string;
}

export type RecommendationDimension =
  | 'hard_eligibility'
  | 'user_project_org_policy'
  | 'required_capability'
  | 'benchmark_evidence'
  | 'cost'
  | 'latency'
  | 'user_preferences';

// ============================================================================
// §20 CROSS-MODE HANDOFF CONTRACT (define only; do NOT implement yet — §34)
// ============================================================================

/**
 * §20/§34: the CONTRACT for cross-mode handoff (full adaptive routing is
 * WORK-042+). The same logical engineering task must remain intact across a
 * handoff. This type is defined here so future work can implement against a
 * stable contract without re-designing the policy layer.
 */
export interface ExecutionHandoffPolicy {
  readonly sourceExecutionId: string;
  readonly destinationMode: ExecutionMode;
  readonly destinationProvider: string;
  readonly reason: string;
  readonly preserveContext: boolean;
  readonly preserveWorkspace: boolean;
  readonly preservePromptDigest: boolean;
}

// ============================================================================
// §27 SERVICE INTERFACES
// ============================================================================

/**
 * §3: ExecutionEligibilityService — the HARD filter. Eligibility is a hard
 * filter; benchmark quality MUST NEVER make an ineligible candidate eligible.
 */
export interface ExecutionEligibilityService {
  evaluate(input: EligibilityEvaluationInput): ExecutionEligibilityResult;
}

export interface EligibilityEvaluationInput {
  readonly candidate: ExecutionCandidateInput;
  readonly taskProfile: ExecutionTaskProfile;
  readonly policy: BenchmarkPolicy;
  readonly constraints: ExecutionConstraintSet;
}

/** The candidate WITHOUT eligibility/score (those are computed). */
export interface ExecutionCandidateInput {
  readonly provider: string;
  readonly name: string;
  readonly model: string;
  readonly executionMode: ExecutionMode;
  readonly capabilities: ProviderCapabilityProfile;
  readonly accessProfile: ProviderAccessProfile | null;
  readonly availability: ProviderAvailability;
  readonly estimatedCost: CostEstimate;
  readonly estimatedLatency: LatencyEstimate;
  readonly historicalPerformance: HistoricalPerformance;
}

/**
 * §13: ExecutionRecommendationService — ordered scoring that PRESERVES the
 * capability ceiling (§13 example: Claude quality 98 vs Qwen 93 — do NOT
 * lower Claude's effective score to normalize).
 */
export interface ExecutionRecommendationService {
  rank(input: RankInput): RankResult;
}

export interface RankInput {
  readonly eligibleCandidates: readonly ExecutionCandidateInput[];
  readonly preferences: ExecutionPreferenceProfile;
  readonly policy: BenchmarkPolicy;
  readonly taskProfile: ExecutionTaskProfile;
}

export interface RankResult {
  readonly ranked: readonly { readonly candidate: ExecutionCandidateInput; readonly score: number }[];
  readonly recommended: ExecutionCandidateInput | null;
  readonly why: RecommendationWhy;
}

/**
 * §1/§16: the ExecutionPolicyService — the application-layer orchestrator.
 * Produces recommendations, persists policy decisions (§22), exposes
 * project/user/org policy + preference CRUD, and freezes policies (§9).
 */
export interface ExecutionPolicyService {
  /** §16: produce a recommendation for a Work Item. */
  recommend(input: RecommendInput): Promise<ExecutionRecommendation>;
  /** §22: list historical policy decisions for a Work Item (audit). */
  listDecisions(workItemId: string): Promise<readonly ExecutionPolicyDecisionRecord[]>;
  /** §31: get the project execution policy (null if not yet created). */
  getProjectPolicy(projectId: string): Promise<ProjectPolicyRecord | null>;
  /** §31: get-or-create the project default policy (needs org for insert). */
  ensureProjectPolicy(organizationId: string, projectId: string): Promise<ProjectPolicyRecord>;
  /** §31: update the project policy (rejected if frozen — §9). */
  updateProjectPolicy(projectId: string, input: UpdateProjectPolicyInput): Promise<ProjectPolicyRecord>;
  /**
   * §9: EXPLICITLY freeze a project policy (pre-freeze before any
   * experiment starts). NOTE (PR #37 review fix): the §9 GUARANTEE — a
   * policy is immutable once any benchmark experiment in its project is
   * RUNNING — is enforced AUTOMATICALLY at the persistence boundary by
   * migration 0032 (an AFTER UPDATE trigger on wfos_benchmark_experiments
   * freezes the policy atomically with the authoritative start
   * transition, + a BEFORE INSERT trigger births policies frozen for
   * projects with already-started experiments). This method remains for
   * explicit EARLY freezing only — it is not load-bearing for §9.
   */
  freezeProjectPolicy(projectId: string): Promise<ProjectPolicyRecord>;
  /** §12: get the user preference profile (null if not yet created). */
  getUserPreferences(userId: string): Promise<UserPreferenceRecord | null>;
  /** §12: get-or-create the user default preferences (needs org for insert). */
  ensureUserPreferences(organizationId: string, userId: string): Promise<UserPreferenceRecord>;
  /** §12: update the user preference profile. */
  updateUserPreferences(userId: string, input: UpdateUserPreferencesInput): Promise<UserPreferenceRecord>;
  /** §5: list the user's provider access profiles. */
  listAccessProfiles(userId: string): Promise<readonly ProviderAccessProfileRecord[]>;
  /** §5: upsert a user provider access profile (needs org for insert). */
  upsertAccessProfile(organizationId: string, userId: string, input: UpsertAccessProfileInput): Promise<ProviderAccessProfileRecord>;
  /** §10: compute controlled-comparison dimension display for an experiment. */
  controlledComparisonDimensions(): ControlledComparisonDimensions;
  /**
   * WORK-043 (§33.3): evaluate ONE execution candidate (provider + model +
   * mode) against the project's CURRENT full constraint set — the SAME
   * engine the recommendation path uses, exposed for point-in-time
   * re-eligibility (the WORK-042 cross-mode handoff destination gate).
   * Returns the hard-filter verdict with structured blocking reasons;
   * persists NOTHING (no §22 decision — this is not a recommendation).
   */
  evaluateCandidateEligibility(input: CandidateEligibilityInput): Promise<CandidateEligibilityResult>;
}

export interface RecommendInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly userId: string;
  /**
   * §8/§16: optional request-scoped benchmark mode override (else the
   * project default). NOTE (PR #37 review fix): when the project policy is
   * FROZEN (§9), an override that DIFFERS from the frozen policy's mode is
   * REJECTED — a decision must never claim the frozen policyVersion while
   * using a different benchmark mode. Passing the frozen mode itself is a
   * no-op and stays allowed; unfrozen policies keep the full override.
   */
  readonly benchmarkMode?: BenchmarkMode;
}

/**
 * WORK-043 — the point-in-time single-candidate eligibility input.
 * `workItemId` supplies the task profile context (the handoff passes the
 * EXISTING execution's work item — the logical task does not change across
 * a mode handoff; §33.7). `userId` (optional — the handoff actor) resolves
 * the user-scoped subscription/access-profile constraints.
 *
 * AR-043-04 (PR #48 round 4): the input carries NO organization id. The
 * organization scope is resolved SERVER-SIDE from the existing project
 * authority (wfos_projects.organization_id — the project→organization
 * relationship is authoritative), so the org-scoped families (org policy,
 * the recommendation-time agent-policy gate) are ACTIVE for EVERY caller —
 * the WORK-042 handoff destination gate included — and can never be
 * omitted, spoofed, or declared absent. An unresolvable scope fails closed.
 *
 * ADMISSION SEMANTICS (AR-043-05 — FROZEN): the evaluation this input drives
 * is ADVISORY point-in-time eligibility — a snapshot verdict, NOT an
 * admission reservation. `eligible=true` does NOT guarantee the subsequent
 * dispatch will be admitted: the authoritative HARD ADMISSION boundary is
 * the DISPATCH MUTATION BOUNDARY (the cross-mode handoff's
 * beginFencedDispatch gate + the direct execution record creation —
 * src/modules/agents/internal/dispatch-admission.ts), which re-derives the
 * active quota/rate limits ATOMICALLY (advisory-lock-serialized per project)
 * against the admission pressure — dispatched artifacts + in-flight
 * reservations — at the moment of the mutation. Concurrent callers can BOTH
 * observe `usage=0, limit=1` here and both receive `eligible=true`; the
 * admission boundary admits EXACTLY ONE of them.
 */
export interface CandidateEligibilityInput {
  readonly projectId: string;
  readonly workItemId: string;
  readonly provider: string;
  readonly model: string | null;
  readonly executionMode: ExecutionMode;
  readonly userId?: string | null;
}

/**
 * WORK-043 — the single-candidate eligibility verdict (+ the constraint
 * snapshot the verdict was computed from, for handoff audit records).
 */
export interface CandidateEligibilityResult {
  readonly eligibility: ExecutionEligibilityResult;
  readonly constraints: ExecutionConstraintSet;
  readonly policyVersion: number;
}

// ============================================================================
// PERSISTED RECORDS (DB rows; §22 append-only for decisions)
// ============================================================================

export interface ProjectPolicyRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly defaultBenchmarkMode: BenchmarkMode;
  readonly externalExecutionAllowed: boolean;
  readonly nativeExecutionAllowed: boolean;
  readonly maxCostPerTaskCents: number | null;
  readonly maxCostPerTrialCents: number | null;
  readonly maxTimeToPrMs: number | null;
  readonly humanInterventionAllowed: boolean;
  readonly privacyLevel: PrivacyLevel;
  readonly allowedProviders: readonly string[];
  readonly deniedProviders: readonly string[];
  readonly allowedModes: readonly ExecutionMode[];
  // --- WORK-043 (§33.3): quota, rate limits, security requirements ---
  readonly maxExecutionsPerMonth: number | null;
  readonly maxExecutionsPerDay: number | null;
  readonly rateLimitMaxRequests: number | null;
  readonly rateLimitWindowSeconds: number | null;
  readonly securityClassification: SecurityClassification;
  readonly externalSecurityCeiling: SecurityClassification | null;
  readonly frozen: boolean;
  readonly policyVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UserPreferenceRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly qualityWeight: number;
  readonly costWeight: number;
  readonly latencyWeight: number;
  readonly privacyWeight: number;
  readonly preferredMode: ExecutionMode | null;
  readonly externalPreferred: boolean;
  readonly nativePreferred: boolean;
  readonly defaultBenchmarkMode: BenchmarkMode;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProviderAccessProfileRecord extends ProviderAccessProfile {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** §22 append-only decision record. */
export interface ExecutionPolicyDecisionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly requestedBy: string | null;
  readonly policyVersion: number;
  readonly benchmarkMode: BenchmarkMode;
  readonly taskProfile: ExecutionTaskProfile;
  readonly eligibleCandidates: readonly ExecutionCandidate[];
  readonly excludedCandidates: readonly ExecutionCandidate[];
  readonly recommendedCandidate: ExecutionCandidate | null;
  readonly whyExplanation: string;
  readonly scores: Record<string, number>;
  readonly benchmarkEvidence: HistoricalPerformance;
  readonly createdAt: Date;
}

export interface UpdateProjectPolicyInput {
  readonly defaultBenchmarkMode?: BenchmarkMode;
  readonly externalExecutionAllowed?: boolean;
  readonly nativeExecutionAllowed?: boolean;
  readonly maxCostPerTaskCents?: number | null;
  readonly maxCostPerTrialCents?: number | null;
  readonly maxTimeToPrMs?: number | null;
  readonly humanInterventionAllowed?: boolean;
  readonly privacyLevel?: PrivacyLevel;
  readonly allowedProviders?: readonly string[];
  readonly deniedProviders?: readonly string[];
  readonly allowedModes?: readonly ExecutionMode[];
  // --- WORK-043 (§33.3): quota, rate limits, security requirements ---
  readonly maxExecutionsPerMonth?: number | null;
  readonly maxExecutionsPerDay?: number | null;
  readonly rateLimitMaxRequests?: number | null;
  readonly rateLimitWindowSeconds?: number | null;
  readonly securityClassification?: SecurityClassification;
  readonly externalSecurityCeiling?: SecurityClassification | null;
}

export interface UpdateUserPreferencesInput {
  readonly qualityWeight?: number;
  readonly costWeight?: number;
  readonly latencyWeight?: number;
  readonly privacyWeight?: number;
  readonly preferredMode?: ExecutionMode | null;
  readonly externalPreferred?: boolean;
  readonly nativePreferred?: boolean;
  readonly defaultBenchmarkMode?: BenchmarkMode;
}

export interface UpsertAccessProfileInput {
  readonly provider: string;
  readonly plan?: string | null;
  readonly codingAgent?: CapabilityReadiness;
  readonly externalUi?: CapabilityReadiness;
  readonly nativeApi?: CapabilityReadiness;
  readonly statusSource?: 'verified' | 'user_configured' | 'unknown';
  readonly notes?: string | null;
}

// The default benchmark policy used when a project has no custom policy.
export const DEFAULT_TOOL_POLICY: ToolPolicy = Object.freeze({
  toolClassFixed: false,
  maximumCapability: true,
  noArtificialCaps: true,
});
