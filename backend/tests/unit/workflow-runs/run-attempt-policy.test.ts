/**
 * V2-005 — the execution-attempt rule (documented in the module header, pinned
 * here): an explicit PAUSE suspends the CURRENT attempt and an explicit RESUME
 * CONTINUES that same attempt at the exact step (resume-to-exact-step); a
 * DECLARED interruption (crash/loss of the execution host) closes the attempt
 * and the next resume RESTARTS execution as a NEW attempt (crash-retry).
 */
import { describe, it, expect } from 'vitest';
import { decideResumeAction } from '../../../src/workflow-runs/internal/attempt-policy.js';

describe('V2-005 — the attempt rule (pause continues, crash restarts)', () => {
  it('a SUSPENDED attempt resumes IN PLACE (same attempt number)', () => {
    const action = decideResumeAction({ state: 'suspended', attemptNumber: 3 });
    expect(action).toEqual({ kind: 'continue', attemptNumber: 3 });
  });

  it('an INTERRUPTED attempt resumes as the NEXT attempt (crash-retry)', () => {
    const action = decideResumeAction({ state: 'interrupted', attemptNumber: 3 });
    expect(action).toEqual({ kind: 'restart', attemptNumber: 4 });
  });

  it('an ENDED attempt (run terminal) never resumes in place', () => {
    const action = decideResumeAction({ state: 'ended', attemptNumber: 2 });
    expect(action).toEqual({ kind: 'restart', attemptNumber: 3 });
  });

  it('a still-RUNNING attempt never restarts (resume is a no-op decision for the running case)', () => {
    const action = decideResumeAction({ state: 'running', attemptNumber: 1 });
    expect(action).toEqual({ kind: 'continue', attemptNumber: 1 });
  });

  it('with no prior attempt, resume restarts at attempt 1', () => {
    expect(decideResumeAction(null)).toEqual({ kind: 'restart', attemptNumber: 1 });
  });

  it('attempt numbers are monotonically increasing across retries', () => {
    let latest: { state: 'suspended' | 'interrupted' | 'running' | 'ended'; attemptNumber: number } | null = null;
    const seen: number[] = [];
    // first start
    latest = { state: 'running', attemptNumber: 1 };
    seen.push(latest.attemptNumber);
    // pause → resume (same attempt)
    latest = { state: 'suspended', attemptNumber: 1 };
    const resume1 = decideResumeAction(latest);
    expect(resume1).toEqual({ kind: 'continue', attemptNumber: 1 });
    seen.push(resume1.attemptNumber);
    // crash → resume (new attempt)
    latest = { state: 'interrupted', attemptNumber: 1 };
    const resume2 = decideResumeAction(latest);
    expect(resume2).toEqual({ kind: 'restart', attemptNumber: 2 });
    seen.push(resume2.attemptNumber);
    // crash again → resume (attempt 3)
    latest = { state: 'interrupted', attemptNumber: 2 };
    const resume3 = decideResumeAction(latest);
    expect(resume3).toEqual({ kind: 'restart', attemptNumber: 3 });
    seen.push(resume3.attemptNumber);
    expect(seen).toEqual([1, 1, 2, 3]);
  });
});
