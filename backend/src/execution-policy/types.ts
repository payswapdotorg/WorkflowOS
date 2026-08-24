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
  | 'policy_blocked'
  | 'privacy_blocked'
  | 'project_policy_blocked'
  | 'configuration_missing'
  | 'provider_temporarily_unavailable';

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
  | 'privacy';

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
  /** §9: freeze a project policy (called when a benchmark experiment starts). */
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
}

export interface RecommendInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly userId: string;
  /** §8: optional explicit mode override (else project default / user pref). */
  readonly benchmarkMode?: BenchmarkMode;
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
