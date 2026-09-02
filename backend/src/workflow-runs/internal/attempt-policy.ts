/**
 * V2-005 — the execution-attempt rule (PURE; documented here, pinned by the
 * attempt-policy battery, enforced by the service):
 *
 *   ATTEMPT RULE — when does a new attempt begin?
 *
 *   - attempt 1 begins when the run STARTS;
 *   - an explicit PAUSE suspends the CURRENT attempt; an explicit RESUME
 *     CONTINUES that same attempt at the exact recorded step
 *     (resume-to-exact-step — deliberate suspension is not a restart);
 *   - a DECLARED interruption (the execution host reports the attempt lost /
 *     crashed) closes that attempt as `interrupted`; the next RESUME RESTARTS
 *     execution as a NEW attempt (crash-retry — the run's history keeps every
 *     attempt, nothing is rewritten);
 *   - attempts END with the run (completed/failed/cancelled).
 *
 * The module never GUESSES a crash: `interruptRunAttempt` is an explicit
 * typed command from the commanded execution path (the honest representation
 * — the Run records what the executor reports).
 */
import type { RunAttemptState } from '../types.js';

export type ResumeAction =
  | { readonly kind: 'continue'; readonly attemptNumber: number }
  | { readonly kind: 'restart'; readonly attemptNumber: number };

/**
 * Decide the resume action from the latest attempt's state:
 * suspended → continue IN PLACE (same attempt, exact step);
 * interrupted (declared crash) → RESTART as the NEXT attempt;
 * ended/absent → restart (defensive: a resumed run always has an active
 * attempt).
 */
export function decideResumeAction(
  latestAttempt: { readonly state: RunAttemptState; readonly attemptNumber: number } | null,
): ResumeAction {
  if (latestAttempt === null) {
    return { kind: 'restart', attemptNumber: 1 };
  }
  if (latestAttempt.state === 'suspended' || latestAttempt.state === 'running') {
    return { kind: 'continue', attemptNumber: latestAttempt.attemptNumber };
  }
  return { kind: 'restart', attemptNumber: latestAttempt.attemptNumber + 1 };
}
