import { describe, it, expect } from 'vitest';

/**
 * WORK-066 — CONTINUOUS cadence evaluation: the scheduled-window math
 * (cadence calculation, missed-window behavior, duplicate-window
 * suppression identity, clock determinism, project/environment scope
 * binding, concurrent scheduler decisions).
 */
import {
  evaluateContinuousWindow,
  deriveSchedulingIdentity,
  scheduledWindowReference,
  ValidationSchedulingError,
} from '../../src/validation-scheduling/index.js';

const HOUR = 60 * 60 * 1000;

describe('WORK-066 cadence — window math', () => {
  it('cadence calculation: windowIndex = floor(epochMs / intervalMs)', () => {
    const now = new Date('2026-09-01T00:30:00.000Z');
    const window = evaluateContinuousWindow({ intervalMs: HOUR, now });
    // 2026-09-01T00:00:00Z epoch / 3600000
    const expectedIndex = Math.floor(now.getTime() / HOUR);
    expect(window.windowIndex).toBe(expectedIndex);
    expect(window.windowStartIso).toBe(new Date(expectedIndex * HOUR).toISOString());
    expect(window.windowEndIso).toBe(new Date((expectedIndex + 1) * HOUR).toISOString());
  });

  it('a non-positive / non-integer interval fails closed (SCHEDULING_CADENCE_INVALID)', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => evaluateContinuousWindow({ intervalMs: bad, now: new Date() })).toThrowError(ValidationSchedulingError);
    }
  });

  it('clock determinism: identical (interval, clock) → identical windows; the clock is INJECTED', () => {
    const now = new Date('2026-09-01T05:00:00.000Z');
    const a = evaluateContinuousWindow({ intervalMs: HOUR, now });
    const b = evaluateContinuousWindow({ intervalMs: HOUR, now });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('the same wall-clock time always maps to the SAME window regardless of who evaluates it', () => {
    const t = new Date('2026-09-01T07:59:59.999Z').getTime();
    const late = evaluateContinuousWindow({ intervalMs: HOUR, now: new Date(t) });
    const early = evaluateContinuousWindow({ intervalMs: HOUR, now: new Date(t) });
    expect(late.windowIndex).toBe(early.windowIndex);
    // 07:59:59.999 is still the 07:00 window (not the 08:00 one):
    expect(new Date(late.windowStartIso).toISOString()).toBe('2026-09-01T07:00:00.000Z');
  });
});

describe('WORK-066 cadence — missed-window behavior (NO catch-up)', () => {
  it('ONLY the current window is ever derivable — a scheduler that was down for three windows schedules the CURRENT window, never the missed ones', () => {
    const interval = HOUR;
    // window 8 is "now"; windows 5,6,7 were missed entirely.
    const now = new Date(8 * interval + 1000);
    const window = evaluateContinuousWindow({ intervalMs: interval, now });
    expect(window.windowIndex).toBe(8);
    // The scheduling identity for window 8 is distinct from windows 5/6/7 —
    // the missed windows have no identity derivable from the current request:
    const idNow = scheduledWindowReference(8);
    const missed = [5, 6, 7].map((i) => scheduledWindowReference(i));
    for (const m of missed) {
      expect(m).not.toBe(idNow);
    }
  });

  it('duplicate-window suppression: the same window index yields the SAME scheduling identity (a re-invocation within the window is a duplicate)', () => {
    const interval = HOUR;
    const earlier = new Date(8 * interval + 1000);
    const later = new Date(9 * interval - 1000); // still window 8
    const w1 = evaluateContinuousWindow({ intervalMs: interval, now: earlier });
    const w2 = evaluateContinuousWindow({ intervalMs: interval, now: later });
    expect(w1.windowIndex).toBe(w2.windowIndex);
    const identityA = deriveSchedulingIdentity({
      trigger: 'SCHEDULED',
      projectId: 'proj-1',
      journeyId: 'journey-1',
      environmentId: 'env-production',
      mode: 'CONTINUOUS',
      reference: scheduledWindowReference(w1.windowIndex),
      assurance: 'CRITICAL',
    });
    const identityB = deriveSchedulingIdentity({
      trigger: 'SCHEDULED',
      projectId: 'proj-1',
      journeyId: 'journey-1',
      environmentId: 'env-production',
      mode: 'CONTINUOUS',
      reference: scheduledWindowReference(w2.windowIndex),
      assurance: 'CRITICAL',
    });
    expect(identityA.schedulingId).toBe(identityB.schedulingId);
    expect(identityA.runId).toBe(identityB.runId);
  });

  it('the NEXT window yields a DIFFERENT scheduling identity (the next cadence step is a new logical event)', () => {
    const identityA = deriveSchedulingIdentity({
      trigger: 'SCHEDULED', projectId: 'proj-1', journeyId: 'journey-1',
      environmentId: 'env-production', mode: 'CONTINUOUS',
      reference: scheduledWindowReference(8), assurance: 'CRITICAL',
    });
    const identityB = deriveSchedulingIdentity({
      trigger: 'SCHEDULED', projectId: 'proj-1', journeyId: 'journey-1',
      environmentId: 'env-production', mode: 'CONTINUOUS',
      reference: scheduledWindowReference(9), assurance: 'CRITICAL',
    });
    expect(identityA.schedulingId).not.toBe(identityB.schedulingId);
    expect(identityA.runId).not.toBe(identityB.runId);
  });
});

describe('WORK-066 cadence — project/environment scope binding', () => {
  it('the scheduling identity includes the project + environment: different scopes are INDEPENDENT logical events', () => {
    const base = {
      trigger: 'SCHEDULED' as const,
      journeyId: 'journey-1',
      mode: 'CONTINUOUS' as const,
      reference: scheduledWindowReference(8),
      assurance: 'CRITICAL',
    };
    const projA = deriveSchedulingIdentity({ ...base, projectId: 'proj-A', environmentId: 'env-prod-A' });
    const projB = deriveSchedulingIdentity({ ...base, projectId: 'proj-B', environmentId: 'env-prod-B' });
    expect(projA.schedulingId).not.toBe(projB.schedulingId);

    const envA = deriveSchedulingIdentity({ ...base, projectId: 'proj-A', environmentId: 'env-prod-A' });
    const envB = deriveSchedulingIdentity({ ...base, projectId: 'proj-A', environmentId: 'env-prod-B' });
    expect(envA.schedulingId).not.toBe(envB.schedulingId);
  });
});
