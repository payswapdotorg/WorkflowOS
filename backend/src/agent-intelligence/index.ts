/**
 * WORK-047 — Agent Intelligence (public barrel).
 *
 * The agent-intelligence domain lives at `src/agent-intelligence/`
 * (application-layer ORCHESTRATOR outside src/modules/, mirroring the §34
 * benchmark / execution-policy / execution-routing / agent-roles /
 * delegation pattern — NOT the 18th frozen module).
 *
 * Boundary contract (static-architecture checks enforce):
 *   - imports ONLY public barrels: ../execution-routing/index.js (the
 *     routing authority it consumes — never reached around to the policy
 *     service), ../agent-roles/index.js (the role catalog), type-only
 *     imports from ../execution-policy/index.js (the carried vocabulary),
 *     and @platform (logger / db types)
 *   - CONSUMES the WORK-044 router, the WORK-045 catalog, and READ-ONLY
 *     aggregates over the EXISTING stores (wfos_executions + the
 *     W046-AC10 delegation ledger): NO second eligibility/routing/role
 *     engine, NO second historical-data store, NO migration
 *   - NEVER mutates workflow/execution/verification/review/delegation state
 *     (SELECT-only evidence SQL — pinned)
 *   - NEVER imports @modules/llm (the intelligence is deterministic
 *     evidence aggregation, not generation), provider SDKs/adapters, or
 *     credentials
 *   - NO scheduler (no timers/cron/background loops — every recommendation
 *     is an explicit call)
 *   - the ranking seam REJECTS ineligible candidates (typed, fail-closed)
 *
 * THE FORWARD DEPENDENCY SLICE (terminal):
 *
 *   WORK-044 (routing) → WORK-045 Agent Roles → WORK-046 Delegation
 *        → WORK-047 Agent Intelligence
 */
export type {
  // Evidence model
  IntelligenceSignalStatus,
  ExecutionHistoryCell,
  DelegationRoleHistoryCell,
  IntelligenceEvidenceSummary,
  // Signals + ranking
  HistoricalSuccessSignal,
  IntelligenceComponent,
  IntelligenceScoreComponents,
  IntelligenceRankedCandidate,
  IntelligenceRejectedAlternative,
  // Provenance
  IntelligenceReason,
  IntelligenceReasonDimension,
  EvidenceContribution,
  ConstraintsAppliedRecord,
  ConsumedRoutingSummary,
  IntelligenceProvenance,
  // Results
  IntelligenceExecutionRecommendation,
  IntelligenceUnitRecommendation,
  IntelligenceRejectedRole,
  IntelligenceDelegationRecommendation,
  // Service contract
  IntelligenceRequestInput,
  AgentIntelligenceService,
  AgentIntelligenceRepository,
  IntelligenceRoleCatalogLike,
  // Errors
  AgentIntelligenceErrorCode,
} from './types.js';

export { AgentIntelligenceError } from './types.js';

export { DefaultAgentIntelligenceService, RECOMMENDED_PLAN_KEY } from './internal/agent-intelligence.service.js';
export type { AgentIntelligenceServiceDeps } from './internal/agent-intelligence.service.js';

export { PgAgentIntelligenceRepository } from './internal/pg-agent-intelligence-repository.js';
export type { PgAgentIntelligenceRepositoryDeps } from './internal/pg-agent-intelligence-repository.js';

export {
  // The documented, deterministic ranking constants (pinned by static invariants)
  ROUTING_WEIGHT,
  HISTORY_WEIGHT,
  NEUTRAL_PRIOR,
  INSUFFICIENT_SAMPLE,
  // The pure ranking seam + helpers
  rankWithIntelligence,
  assertEligibleAtSeam,
  compositeScore,
  historicalComponent,
  deriveHistoricalSignal,
  executionCellKey,
  findExecutionCell,
  validateExecutionCell,
  compareIntelligenceRanked,
  identityLexicographicKey,
  classifyExclusion,
  buildRejectedAlternatives,
  executionContribution,
  confidenceOf,
} from './internal/intelligence-ranking.js';
export type { IntelligenceRankInput, IntelligenceRankOutput } from './internal/intelligence-ranking.js';

export {
  // The deterministic decomposition rules
  DECOMPOSITION_RULES,
  computeDecomposition,
  aggregateRoleHistory,
  roleHistoryFor,
  POOR_ROLE_SUCCESS_THRESHOLD,
  ROLE_WARNING_MIN_SAMPLE,
} from './internal/decomposition.js';
export type { DecompositionRule, DecompositionInput, DecompositionOutput } from './internal/decomposition.js';
