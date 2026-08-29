/**
 * WORK-046 — Multi-Agent Delegation (public barrel).
 *
 * The delegation domain is an APPLICATION-LAYER ORCHESTRATOR that lives at
 * `src/delegation/` (mirrors the §34 benchmark / execution-policy /
 * execution-routing / agent-roles pattern: NOT the 18th frozen module — it
 * CONSUMES the frozen modules via `@modules/*` public barrels + the
 * agent-roles domain via its public barrel).
 *
 * Boundary contract (static-architecture checks enforce):
 *   - imports from @modules/* (public barrels only — never internal/)
 *   - imports from @platform/* (cross-cutting infrastructure)
 *   - imports the WORK-045 role contracts from ../agent-roles/index.js
 *   - submits delegated executions ONLY through the EXISTING
 *     ExecutionService + ExecutionTaskService (exactly one submit call site)
 *   - NEVER mutates workflow state, verification state, review state, or
 *     execution records (coordination data only — there is NO hidden
 *     lifecycle state)
 *   - NEVER evaluates eligibility, ranks candidates, dispatches providers,
 *     authors roles, or schedules anything
 *   - NEVER imports pg / provider SDKs directly, and stores no credentials
 *
 * THE DELEGATION LAYER IS COORDINATION, NOT AUTHORITY (spec/work-orders/
 * WORK-046.md): one Work Item, one workflow authority (/workflows), one
 * execution authority (/agents), the existing role catalog (WORK-045), the
 * existing policy/routing/verification/review boundaries.
 */
export type {
  DelegationPlanStatus,
  DelegationUnitStatus,
  DelegationAttemptOutcome,
  DelegationUnitSpec,
  DelegationPlanInput,
  DelegationRoleAssignment,
  DelegationUnit,
  DelegationAttempt,
  DelegationPlan,
  DelegationUnitDriveResult,
  DelegationDriveResult,
  DelegationPlanService,
  DelegationCoordinator,
  DelegationErrorCode,
} from './types.js';
export { DelegationError, DELEGATION_ERROR_CODES } from './types.js';
export { DefaultDelegationPlanService } from './internal/delegation-plan-service.js';
export type { DefaultDelegationPlanServiceDeps } from './internal/delegation-plan-service.js';
export { DefaultDelegationCoordinator } from './internal/delegation-coordinator.js';
export type { DefaultDelegationCoordinatorDeps } from './internal/delegation-coordinator.js';
export { PgDelegationRepository } from './internal/pg-delegation-repository.js';
