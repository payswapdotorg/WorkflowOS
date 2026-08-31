/**
 * WORK-066 — CONTINUOUS cadence evaluation (the scheduled-window math).
 *
 * PURE: given a cadence (a fixed interval) and an injected clock, the window
 * index is `floor(epochMs / intervalMs)` — the global epoch window. The
 * semantics (lifecycle §1 CONTINUOUS + the Work Order's explicit-configuration
 * rule):
 *
 *   - cadence calculation: windowIndex = floor(now / intervalMs);
 *   - missed-window behavior: ONLY the current window is ever scheduled —
 *     there is no catch-up (a scheduler that was down for three windows does
 *     not schedule the three missed windows; the next invocation schedules
 *     the CURRENT window exactly once);
 *   - duplicate-window suppression: the window index is part of the
 *     scheduling identity, so a re-invocation within the same window is a
 *     typed duplicate (the claim-store boundary);
 *   - clock determinism: the clock is injected — identical (interval, clock)
 *     yields identical windows;
 *   - NO autonomous drive: this module is pure math invoked by an explicit
 *     scheduling request; there are no timers, no loops, no background
 *     scheduling anywhere in WORK-066.
 */
import { ValidationSchedulingError as SchedulingError } from '../types.js';

/** The evaluated scheduled window. */
export interface ContinuousScheduleWindow {
  /** The global epoch window index (floor(epochMs / intervalMs)). */
  readonly windowIndex: number;
  /** Inclusive window start (ISO). */
  readonly windowStartIso: string;
  /** Exclusive window end (ISO). */
  readonly windowEndIso: string;
}

/**
 * Evaluate the current scheduled window. The interval must be a positive
 * integer number of milliseconds (a non-positive/non-finite interval fails
 * closed with SCHEDULING_CADENCE_INVALID).
 */
export function evaluateContinuousWindow(input: { intervalMs: number; now: Date }): ContinuousScheduleWindow {
  const { intervalMs, now } = input;
  if (!Number.isFinite(intervalMs) || !Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new SchedulingError(
      'SCHEDULING_CADENCE_INVALID',
      `the CONTINUOUS cadence must be a positive integer interval in milliseconds (received: ${JSON.stringify(intervalMs)})`,
    );
  }
  const epochMs = now.getTime();
  if (!Number.isFinite(epochMs) || epochMs < 0) {
    throw new SchedulingError(
      'SCHEDULING_CADENCE_INVALID',
      `the injected clock must yield a finite non-negative epoch time (received: ${epochMs})`,
    );
  }
  const windowIndex = Math.floor(epochMs / intervalMs);
  return {
    windowIndex,
    windowStartIso: new Date(windowIndex * intervalMs).toISOString(),
    windowEndIso: new Date((windowIndex + 1) * intervalMs).toISOString(),
  };
}
