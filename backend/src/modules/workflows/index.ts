/**
 * workflows module — public interface.
 *
 * Canonical name: /workflows
 * Responsibility (spec/architecture.md): workflow state machine, legal state
 * transitions, orchestration.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-009: implements the canonical workflow state machine (WORKFLOW-001..005).
 * /workflows is the EXCLUSIVE owner of canonical workflow state. No other
 * module may mutate it or define a competing state enum.
 *
 * WORK-017: extends /workflows with the convergence orchestration layer that
 * connects Work Item, Work Order, Agent Run, GitHub, Verification, and
 * Architect Review contracts into the canonical implementation loop. The
 * orchestrator consumes public contracts from /work-items, /agents, /llm,
 * /github, /verification, /reviews — never their internal/ implementations.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  WorkflowState,
  WorkflowExecution,
  WorkflowTransition,
  TransitionRequest,
  TransitionResult,
  WorkflowExecutionRepository,
  WorkflowTransitionRepository,
  WorkflowEngine,
} from './internal/workflow.types.js';
// WORK-017: Convergence orchestration types.
export type {
  SignalType,
  SignalProcessingState,
  ConvergenceSignal,
  SubmitSignalInput,
  ConvergenceSignalRepository,
  WorkflowOrchestrator,
} from './internal/convergence.types.js';

/**
 * Public capabilities exposed by the /workflows module to other modules.
 */
export interface WorkflowsModuleApi {
  // future: additional workflow-domain methods consumed by other modules
}

/**
 * Frozen module contract for /workflows.
 */
export const workflowsModule: ModuleContract & WorkflowsModuleApi = {
  name: '/workflows',
};

export default workflowsModule;
