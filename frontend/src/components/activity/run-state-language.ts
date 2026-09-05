/**
 * run-state-language — the shared §15 execution-status vocabulary (V2-017).
 *
 * ONE source for the human run-state words, consumed by both the run-status
 * surface (T6's RunExperience) and the universal Activity timeline (T10).
 * The words derive ONLY from the authoritative run record's state field —
 * never guessed, never fabricated; an unknown authoritative state renders
 * as the state itself (the honest word). The "Waiting for you" derivation
 * (paused at an approval step) stays with each surface because it needs the
 * history + version-content facts; this module owns only the record-state
 * mapping.
 */
import type { ProductWorkflowRun } from '../../api/client';

/** The run's human state word (UX spec §15) from the authoritative record. */
export function humanRunState(run: Pick<ProductWorkflowRun, 'state'>): string {
  switch (run.state) {
    case 'requested':
      return 'Ready';
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Couldn\u2019t complete';
    case 'cancelled':
      return 'Cancelled';
    default:
      // An unknown authoritative state: the honest word is the state
      // itself — never a guessed human translation.
      return run.state;
  }
}

/** The one-line sentence under the state word (UX spec §15). */
export function humanRunStateSentence(state: string): string {
  switch (state) {
    case 'Ready':
      return 'Ready to run — it hasn\u2019t started yet.';
    case 'Running':
      return 'It\u2019s working right now.';
    case 'Waiting for you':
      return 'It\u2019s paused for your approval before it continues.';
    case 'Paused':
      return 'It\u2019s paused.';
    case 'Completed':
      return 'It finished.';
    case 'Couldn\u2019t complete':
      return 'It stopped before finishing.';
    case 'Cancelled':
      return 'It was cancelled.';
    default:
      return '';
  }
}
