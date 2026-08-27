/**
 * WORK-044 — Adaptive Execution Router (public barrel).
 *
 * The execution-routing domain is an APPLICATION-LAYER ORCHESTRATOR that
 * lives at `src/execution-routing/` (mirrors the §34 benchmark +
 * execution-policy pattern: NOT the 18th frozen module — it CONSUMES the
 * frozen modules via `@modules/*` public barrels + the execution-policy
 * domain via ITS public barrel).
 *
 * Boundary contract (static-architecture checks enforce):
 *   - imports from @modules/* (public barrels only — never internal/)
 *   - imports from @platform/* (cross-cutting infrastructure)
 *   - imports the WORK-043 contract from ../execution-policy/index.js
 *     (the public barrel — NEVER its internal/)
 *   - NEVER imports pg / @octokit / provider SDKs directly
 *   - NEVER stores credentials
 *   - NEVER re-evaluates hard constraints (no parallel eligibility engine)
 *   - NEVER mutates workflow state; NEVER dispatches (advisory only — the
 *     caller submits via the existing ExecutionService.submit() authority)
 *
 * THE CRITICAL BOUNDARY (Work Order WORK-044):
 *
 *   WORK-043 eligibility → eligible candidates only → WORK-044 ranking
 *   → recommend / select
 */
export type {
  AdaptiveExecutionRouterService,
  RoutingCandidateIdentity,
  RoutingSignalStatus,
  QualitySignal,
  ReliabilitySignal,
  CostSignal,
  LatencySignal,
  HumanInterventionSignal,
  RankingComponent,
  RoutingCandidate,
  RoutingRankInput,
  RoutingScoreComponents,
  RoutingRankedCandidate,
  RoutingExplanation,
  RoutingExcludedCandidate,
  RoutingRankOutput,
  RoutingRequestInput,
  RoutingRecommendationResult,
  RoutingSelectionResult,
  RoutingEligibilitySource,
  ExecutionRoutingErrorCode,
} from './types.js';

export { ExecutionRoutingError } from './types.js';

export { AdaptiveExecutionRouter } from './internal/adaptive-execution-router.js';
export type { AdaptiveExecutionRouterDeps } from './internal/adaptive-execution-router.js';
export { DEFAULT_ROUTING_PREFERENCES } from './internal/adaptive-execution-router.js';

export { rankEligibleCandidates, ROUTING_METHODOLOGY, deriveRoutingWeights } from './internal/execution-ranking.js';
export type { RoutingWeights } from './internal/execution-ranking.js';
