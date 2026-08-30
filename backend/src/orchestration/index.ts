/**
 * WORK-062 — Durable Multi-Agent Orchestration Substrate (public barrel).
 *
 * The substrate is an APPLICATION-LAYER capability that lives at
 * `src/orchestration/` (mirrors the §34 benchmark / execution-policy /
 * execution-routing / agent-roles / delegation pattern: NOT the 18th frozen
 * module — it consumes nothing from the frozen modules directly; it OBSERVES
 * the delegation tables and drives delegated executions ONLY through the
 * injected OrchestrationExecutor port, which the WORK-046 delegation
 * coordinator implements with the EXISTING dispatch protocol and its
 * exactly-one ExecutionService.submit() call site).
 *
 * Boundary contract (static-architecture checks enforce):
 *   - durable orchestration state ONLY (migration 0058:
 *     wfos_orchestration_graphs + wfos_orchestration_nodes)
 *   - every identity REFERENCES an existing authority row (delegation
 *     plan/unit; the existing execution identity via the delegation attempt)
 *   - NEVER writes delegation, workflow, execution, agent-run,
 *     verification, or review rows (observation only)
 *   - NEVER submits executions itself (the executor port is the boundary)
 *   - NEVER schedules anything (every drive is an explicit call)
 *   - NEVER uses Redis (PostgreSQL is authoritative)
 *   - NO workflow states (orchestration vocabulary is structurally disjoint
 *     from the frozen WorkflowState set and the WORK-046 coordination set)
 *
 * THE SUBSTRATE IS ORCHESTRATION, NOT AUTHORITY (spec/work-orders/
 * WORK-062.md): leases/ownership with fencing generations, durable
 * dependency-aware admission, deterministic reconciliation, explicit
 * partial completion, and safe dependency-aware parallelism — underneath
 * the ONE delegation authority (WORK-046), above the ONE execution
 * authority (the existing ExecutionService.submit boundary).
 */
export type {
  OrchestrationGraphStatus,
  OrchestrationNodeOutcome,
  OrchestrationGraph,
  OrchestrationNode,
  OrchestrationNodeContext,
  OrchestrationExecutorResult,
  OrchestrationExecutor,
  OrchestrationNodeDriveResult,
  OrchestrationDriveResult,
  OrchestrationDriveOptions,
  OrchestrationSubstrate,
  OrchestrationErrorCode,
} from './types.js';
export { OrchestrationError, ORCHESTRATION_ERROR_CODES } from './types.js';
export { DefaultOrchestrationSubstrate } from './internal/orchestration-substrate.js';
export type { DefaultOrchestrationSubstrateDeps } from './internal/orchestration-substrate.js';
export { PgOrchestrationRepository } from './internal/pg-orchestration-repository.js';
export { nodeOutcomeFromUnitStatus } from './internal/orchestration-substrate.js';
export type { DelegationPlanSnapshot, LeasePurpose, LeaseAcquireFailure } from './internal/pg-orchestration-repository.js';
