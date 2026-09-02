/**
 * V2-005 — the explicit WorkflowRun state machine (PURE semantics).
 *
 * States are aligned with the registry run-event vocabulary
 * (workflow.run.requested/started/paused/resumed/completed/failed; the
 * terminal 'cancelled' STATE is V2-005's own domain vocabulary — the frozen
 * registry defines no workflow.run.cancelled EVENT, so the timeline entry for
 * cancellation is deliberately module-scoped, never a minted registry name).
 */
import { describe, it, expect } from 'vitest';
import {
  WORKFLOW_RUN_STATES,
  TERMINAL_WORKFLOW_RUN_STATES,
  WorkflowRunError,
  type WorkflowRunState,
} from '../../../src/workflow-runs/index.js';
import {
  RUN_TRANSITIONS,
  canTransitionRun,
  assertRunTransition,
  isTerminalRunState,
} from '../../../src/workflow-runs/internal/run-state-machine.js';

describe('V2-005 — the explicit run state machine', () => {
  it('exposes exactly the six canonical run states', () => {
    expect([...WORKFLOW_RUN_STATES]).toEqual([
      'requested',
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('marks exactly completed/failed/cancelled terminal', () => {
    expect([...TERMINAL_WORKFLOW_RUN_STATES]).toEqual(['completed', 'failed', 'cancelled']);
    for (const state of WORKFLOW_RUN_STATES) {
      expect(isTerminalRunState(state)).toBe(
        (TERMINAL_WORKFLOW_RUN_STATES as readonly string[]).includes(state),
      );
    }
  });

  it('allows exactly the legal lifecycle transitions', () => {
    // requested → running | cancelled
    expect(RUN_TRANSITIONS.requested).toEqual(['running', 'cancelled']);
    // running → paused | completed | failed | cancelled
    expect(RUN_TRANSITIONS.running).toEqual(['paused', 'completed', 'failed', 'cancelled']);
    // paused → running | cancelled
    expect(RUN_TRANSITIONS.paused).toEqual(['running', 'cancelled']);
    // terminal states are lifecycle-immutable
    expect(RUN_TRANSITIONS.completed).toEqual([]);
    expect(RUN_TRANSITIONS.failed).toEqual([]);
    expect(RUN_TRANSITIONS.cancelled).toEqual([]);
  });

  it('pause/resume round trip is legal, completion from paused is not', () => {
    expect(canTransitionRun('running', 'paused')).toBe(true);
    expect(canTransitionRun('paused', 'running')).toBe(true);
    // completing/failing requires an ACTIVE run
    expect(canTransitionRun('paused', 'completed')).toBe(false);
    expect(canTransitionRun('paused', 'failed')).toBe(false);
    expect(canTransitionRun('requested', 'completed')).toBe(false);
    expect(canTransitionRun('requested', 'paused')).toBe(false);
  });

  it('a cancelled run is terminal — no resume from cancelled', () => {
    expect(canTransitionRun('cancelled', 'running')).toBe(false);
    expect(canTransitionRun('completed', 'running')).toBe(false);
    expect(canTransitionRun('failed', 'running')).toBe(false);
    expect(canTransitionRun('failed', 'completed')).toBe(false);
  });

  it('illegal transitions throw the TYPED state-transition error', () => {
    expect(() => assertRunTransition('paused', 'completed')).toThrowError(WorkflowRunError);
    try {
      assertRunTransition('paused', 'completed');
      expect.unreachable('must throw');
    } catch (err) {
      const typed = err as WorkflowRunError;
      expect(typed.code).toBe('RUN_INVALID_STATE_TRANSITION');
    }
  });

  it('terminal lifecycle mutation throws the TYPED terminal error (distinct code)', () => {
    for (const from of TERMINAL_WORKFLOW_RUN_STATES) {
      for (const to of ['running', 'paused', 'completed', 'failed', 'cancelled'] as const) {
        if (from === to) continue;
        try {
          assertRunTransition(from as WorkflowRunState, to);
          expect.unreachable(`terminal ${from} → ${to} must throw`);
        } catch (err) {
          const typed = err as WorkflowRunError;
          expect(typed.code).toBe('RUN_TERMINAL');
        }
      }
    }
  });
});
