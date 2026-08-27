/**
 * WORK-033 — Execution Policy & Fair Benchmarking (public barrel).
 *
 * The execution-policy domain is an APPLICATION-LAYER ORCHESTRATOR that lives
 * at `src/execution-policy/` (mirrors the §34 benchmark pattern: NOT the 18th
 * frozen module — it CONSUMES the 17 frozen modules via their public barrels).
 *
 * Boundary contract (static-architecture checks enforce):
 *   - imports from @modules/* (public barrels only — never internal/)
 *   - imports from @platform/* (cross-cutting infrastructure)
 *   - NEVER imports pg / @octokit / @electric-sql/pglite directly
 *   - NEVER stores credentials, callback tokens, handoff tokens, or cookies
 *
 * Authority model (§1, §34):
 *   - reads provider capability via @modules/agents (ExecutionProviderInfo +
 *     EXTERNAL_UI_CATALOG — never invents capabilities)
 *   - reads historical evidence via @root/benchmark BenchmarkRepository
 *   - derives task profile via @modules/work-items repositories (types only)
 *   - NEVER mutates workflow state; NEVER evaluates verification / reviews /
 *     merges PRs; NEVER creates another ExecutionService
 *   - recommendations are ADVISORY — the caller (route layer) submits via
 *     ExecutionService.submit(); this layer never bypasses it
 */
export type {
  ExecutionCandidate,
  ProviderCapabilityProfile,
  CapabilityReadiness,
  ContextWindow,
  ProviderAccessProfile,
  ProviderAvailability,
  ExecutionEligibilityResult,
  ExecutionEligibilityStatus,
  EligibilityBlock,
  ExecutionConstraintCategory,
  ExecutionConstraintSet,
  CapabilityConstraint,
  CapabilityRequirement,
  UserConstraints,
  ProjectConstraints,
  OrganizationConstraints,
  AvailabilityConstraints,
  SubscriptionConstraints,
  PrivacyConstraints,
  PrivacyLevel,
  BenchmarkMode,
  BenchmarkPolicy,
  ToolPolicy,
  HumanInterventionPolicy,
  ControlledComparisonDimensions,
  ExecutionPreferenceProfile,
  ExecutionTaskProfile,
  CostConfidence,
  CostEstimate,
  LatencyEstimate,
  HistoricalPerformance,
  ExecutionRecommendation,
  RecommendationWhy,
  RecommendationReason,
  RecommendationDimension,
  ExecutionHandoffPolicy,
  ExecutionEligibilityService,
  EligibilityEvaluationInput,
  ExecutionCandidateInput,
  ExecutionRecommendationService,
  RankInput,
  RankResult,
  ExecutionPolicyService,
  RecommendInput,
  CandidateEligibilityInput,
  CandidateEligibilityResult,
  ProjectPolicyRecord,
  UserPreferenceRecord,
  ProviderAccessProfileRecord,
  ExecutionPolicyDecisionRecord,
  UpdateProjectPolicyInput,
  UpdateUserPreferencesInput,
  UpsertAccessProfileInput,
  // WORK-043 (§33.3) — the new constraint families.
  QuotaConstraints,
  RateLimitConstraints,
  SecurityConstraints,
  AgentPolicyConstraints,
  SecurityClassification,
  SECURITY_CLASSIFICATION_RANK,
} from './types.js';

export { DEFAULT_TOOL_POLICY } from './types.js';

export type {
  ExecutionPolicyRepository,
  DecisionRow,
  DefaultExecutionPolicyServiceDeps,
  AgentProviderRegistryLike,
  BenchmarkEvidenceProviderLike,
  ExecutionEligibilityServiceLike,
  ExecutionRecommendationServiceLike,
  ExecutionTaskProfileBuilderLike,
  OrgPolicyResolverLike,
  ResolvedOrgPolicy,
} from './internal/execution-policy.types.js';

export { DefaultExecutionEligibilityService } from './internal/default-execution-eligibility-service.js';
export { DefaultExecutionRecommendationService } from './internal/default-execution-recommendation-service.js';
export { DefaultExecutionTaskProfileBuilder } from './internal/default-execution-task-profile-builder.js';
export type { ExecutionTaskProfileBuilderDeps } from './internal/default-execution-task-profile-builder.js';
export { DefaultBenchmarkEvidenceProvider } from './internal/default-benchmark-evidence-provider.js';
export type { BenchmarkEvidenceProviderDeps } from './internal/default-benchmark-evidence-provider.js';
export { ProviderCapabilityNormalizer } from './internal/provider-capability-normalizer.js';
export { PgExecutionPolicyRepository } from './internal/pg-execution-policy-repository.js';
export { DefaultExecutionPolicyService } from './internal/default-execution-policy-service.js';
// PR #37 review fix: the constrained-mode semantic validation (a constrained
// benchmark mode requires its cap — rejected at the policy boundary rather
// than silently falling back to unconstrained behavior). Exported for the
// route layer's 400 mapping + direct testing.
export { validateBenchmarkModeConstraint } from './internal/default-execution-policy-service.js';
// WORK-043 (§33.3): the quota / rate-limit / security field validation (the
// same policy-boundary pattern — clean domain errors; migration 0051's CHECKs
// are the DB backstop). Exported for the route layer's 400 mapping + tests.
export { validateWork043PolicyFields } from './internal/default-execution-policy-service.js';
