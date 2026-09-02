/**
 * V2-005 — the explicit WorkflowRun state machine (PURE).
 *
 * States are aligned with the registry run-event vocabulary
 * (workflow.run.requested/started/paused/resumed/completed/failed). The
 * terminal `cancelled` STATE is V2-005's own domain vocabulary: the frozen
 * registry defines NO workflow.run.cancelled EVENT, so the cancellation
 * transition is recorded in the timeline under a deliberately module-scoped
 * name (never a minted registry-shaped event name) — see
 * RUN_TIMELINE_EVENT_NAMES in types.ts.
 *
 * The SAME transition table is enforced in PostgreSQL by the migration-0061
 * guard trigger (a buggy caller cannot perform an illegal transition or
 * mutate a terminal run even with raw SQL).
 */
import { WorkflowRunError, type WorkflowRunState } from '../types.js';

/** The legal transition table (from-state → allowed to-states). */
export const RUN_TRANSITIONS: Readonly<Record<WorkflowRunState, readonly WorkflowRunState[]>> = {
  requested: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalRunState(state: WorkflowRunState): boolean {
  return RUN_TRANSITIONS[state].length === 0;
}

export function canTransitionRun(from: WorkflowRunState, to: WorkflowRunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/**
 * Assert the transition is legal. ANY lifecycle command on a terminal state
 * throws RUN_TERMINAL first (terminal runs are lifecycle-immutable — even a
 * repeat of the same terminal state is a terminal rejection, not a state
 * question); illegal transitions from a NON-terminal state throw
 * RUN_INVALID_STATE_TRANSITION; a no-op transition to the same state is not
 * a lifecycle command.
 */
export function assertRunTransition(from: WorkflowRunState, to: WorkflowRunState): void {
  if (isTerminalRunState(from)) {
    throw new WorkflowRunError(
      'RUN_TERMINAL',
      `the run is in terminal state "${from}" — the lifecycle is immutable (evidence remains appendable, lifecycle commands are rejected)`,
    );
  }
  if (from === to) {
    throw new WorkflowRunError(
      'RUN_INVALID_STATE_TRANSITION',
      `the run is already in state "${from}" — a no-op transition to the same state is not a lifecycle command`,
    );
  }
  if (!RUN_TRANSITIONS[from].includes(to)) {
    throw new WorkflowRunError(
      'RUN_INVALID_STATE_TRANSITION',
      `the transition "${from}" → "${to}" is not legal (legal targets from "${from}": ${RUN_TRANSITIONS[from].join(', ') || 'none'})`,
    );
  }
}
