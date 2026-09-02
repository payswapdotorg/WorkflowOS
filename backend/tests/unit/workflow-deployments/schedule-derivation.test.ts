/**
 * V2-009 — schedule occurrence derivation (PURE; the "one-shot and recurring
 * schedules" + "timezone/time-source correctness" must-deliver, plus the
 * REQUIRED REGRESSION "missed schedule" derivation semantics).
 *
 * `nextOccurrenceAfter(spec, afterEpochMs, anchorEpochMs)` is a pure function
 * of the schedule spec, the cursor and the anchor — the next occurrence
 * STRICTLY after `afterEpochMs`:
 *   - one_shot: the fixed instant (or null when already passed);
 *   - interval: anchor + k·everyMs (the smallest k with value > after);
 *   - daily/weekly: the next matching local wall-clock in the zone,
 *     DST-resolved (gap → forward to gap end, typed gap_shifted; ambiguous →
 *     first occurrence, typed ambiguous_first).
 */
import { describe, it, expect } from 'vitest';
import { WorkflowDeploymentError } from '../../../src/workflow-deployments/index.js';
import {
  validateScheduleSpec,
  nextOccurrenceAfter,
} from '../../../src/workflow-deployments/internal/schedule.js';
import { epochMsOf } from '../../../src/workflow-deployments/internal/clock.js';

/** Fixed-format UTC helper (test-only; mirrors the module clock format). */
function utc(iso: string): number {
  return Date.parse(iso);
}

const ANCHOR = utc('2026-09-01T00:00:00.000Z');

describe('V2-009 — schedule spec validation (fail-closed, typed)', () => {
  it('accepts the four canonical kinds', () => {
    expect(validateScheduleSpec({ kind: 'one_shot', at: '2026-09-02T09:00:00.000Z' })).toEqual({
      kind: 'one_shot',
      at: '2026-09-02T09:00:00.000Z',
    });
    expect(validateScheduleSpec({ kind: 'interval', everyMs: 3_600_000 })).toEqual({
      kind: 'interval',
      everyMs: 3_600_000,
    });
    expect(validateScheduleSpec({ kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '09:00' })).toEqual({
      kind: 'daily',
      timezone: 'Africa/Accra',
      timeOfDay: '09:00',
    });
    expect(
      validateScheduleSpec({ kind: 'weekly', timezone: 'Africa/Accra', timeOfDay: '09:00', daysOfWeek: [1, 5] }),
    ).toEqual({ kind: 'weekly', timezone: 'Africa/Accra', timeOfDay: '09:00', daysOfWeek: [1, 5] });
  });

  it('normalizes weekly daysOfWeek to a sorted set', () => {
    const spec = validateScheduleSpec({
      kind: 'weekly',
      timezone: 'Africa/Accra',
      timeOfDay: '09:00',
      daysOfWeek: [5, 1, 5, 3],
    });
    expect(spec.kind === 'weekly' && spec.daysOfWeek).toEqual([1, 3, 5]);
  });

  it('rejects unknown kinds, malformed instants, non-positive intervals, bad timezones/times/days (typed SUBSCRIPTION_SCHEDULE_INVALID)', () => {
    const cases: unknown[] = [
      null,
      'daily',
      { kind: 'sometimes' },
      { kind: 'one_shot', at: '2026-09-02 09:00:00' }, // not fixed-format UTC
      { kind: 'one_shot', at: 'not-a-time' },
      { kind: 'one_shot' },
      { kind: 'interval', everyMs: 0 },
      { kind: 'interval', everyMs: -60_000 },
      { kind: 'interval' },
      { kind: 'interval', everyMs: 1 }, // sub-second recurrence is unrepresentable
      { kind: 'daily', timezone: 'Nope/Nope', timeOfDay: '09:00' },
      { kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '9:00' },
      { kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '24:00' },
      { kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '09:60' },
      { kind: 'daily', timezone: 'Africa/Accra' },
      { kind: 'weekly', timezone: 'Africa/Accra', timeOfDay: '09:00', daysOfWeek: [] },
      { kind: 'weekly', timezone: 'Africa/Accra', timeOfDay: '09:00', daysOfWeek: [0] },
      { kind: 'weekly', timezone: 'Africa/Accra', timeOfDay: '09:00', daysOfWeek: [8] },
      { kind: 'weekly', timezone: 'Africa/Accra', timeOfDay: '09:00' },
    ];
    for (const spec of cases) {
      expect(() => validateScheduleSpec(spec), `spec ${JSON.stringify(spec)}`).toThrowError(WorkflowDeploymentError);
      try {
        validateScheduleSpec(spec);
      } catch (error) {
        expect((error as WorkflowDeploymentError).code).toBe('SUBSCRIPTION_SCHEDULE_INVALID');
      }
    }
  });
});

describe('V2-009 — one-shot occurrence derivation', () => {
  it('the occurrence is the fixed instant, derivable strictly after any earlier cursor', () => {
    const spec = validateScheduleSpec({ kind: 'one_shot', at: '2026-09-02T09:00:00.000Z' });
    const occ = nextOccurrenceAfter(spec, ANCHOR, ANCHOR);
    expect(occ).not.toBeNull();
    expect(occ!.scheduledAt).toBe('2026-09-02T09:00:00.000Z');
    expect(occ!.resolution).toBe('normal');
  });

  it('null once the cursor has passed the instant (one-shot never refires)', () => {
    const spec = validateScheduleSpec({ kind: 'one_shot', at: '2026-09-02T09:00:00.000Z' });
    expect(nextOccurrenceAfter(spec, utc('2026-09-02T09:00:00.000Z'), ANCHOR)).toBeNull();
    expect(nextOccurrenceAfter(spec, utc('2026-09-03T00:00:00.000Z'), ANCHOR)).toBeNull();
  });

  it('the anchor plays no role for one-shot (the instant is the identity)', () => {
    const spec = validateScheduleSpec({ kind: 'one_shot', at: '2026-09-02T09:00:00.000Z' });
    const a = nextOccurrenceAfter(spec, ANCHOR, ANCHOR);
    const b = nextOccurrenceAfter(spec, ANCHOR, utc('2025-01-01T00:00:00.000Z'));
    expect(a).toEqual(b);
  });
});

describe('V2-009 — interval occurrence derivation (fixed-duration recurrence)', () => {
  it('derives anchor + k·everyMs — the smallest k strictly after the cursor', () => {
    const spec = validateScheduleSpec({ kind: 'interval', everyMs: 3_600_000 });
    // anchor 00:00; cursor 00:30 → next 01:00 (k=1)
    let occ = nextOccurrenceAfter(spec, ANCHOR + 30 * 60_000, ANCHOR);
    expect(occ!.scheduledAt).toBe('2026-09-01T01:00:00.000Z');
    // cursor 01:00 (exactly an occurrence) → next 02:00 (strictly after)
    occ = nextOccurrenceAfter(spec, utc('2026-09-01T01:00:00.000Z'), ANCHOR);
    expect(occ!.scheduledAt).toBe('2026-09-01T02:00:00.000Z');
    // cursor 01:59:59.999 → next 02:00
    occ = nextOccurrenceAfter(spec, utc('2026-09-01T01:59:59.999Z'), ANCHOR);
    expect(occ!.scheduledAt).toBe('2026-09-01T02:00:00.000Z');
  });

  it('is timezone-free (identical derivation in any zone context — fixed UTC durations)', () => {
    const spec = validateScheduleSpec({ kind: 'interval', everyMs: 86_400_000 });
    const occ = nextOccurrenceAfter(spec, ANCHOR, ANCHOR);
    expect(occ!.scheduledAt).toBe('2026-09-02T00:00:00.000Z');
    expect(occ!.resolution).toBe('normal');
  });
});

describe('V2-009 — daily wall-clock occurrence derivation (timezone-correct)', () => {
  it('derives the next local 09:00 in Africa/Accra (fixed GMT+0 → 09:00Z)', () => {
    const spec = validateScheduleSpec({ kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '09:00' });
    // cursor 2026-09-01T12:00Z (already past today's 09:00) → tomorrow 09:00Z
    const occ = nextOccurrenceAfter(spec, utc('2026-09-01T12:00:00.000Z'), ANCHOR);
    expect(occ!.scheduledAt).toBe('2026-09-02T09:00:00.000Z');
    expect(occ!.resolution).toBe('normal');
    // cursor before today's 09:00 → today 09:00Z
    const occ2 = nextOccurrenceAfter(spec, utc('2026-09-01T07:30:00.000Z'), ANCHOR);
    expect(occ2!.scheduledAt).toBe('2026-09-01T09:00:00.000Z');
  });

  it('derives 09:00 America/New_York as 13:00Z in EDT (same day) and 14:00Z in EST (after fall-back) — the DST shift is in the INSTANT, honestly', () => {
    const spec = validateScheduleSpec({ kind: 'daily', timezone: 'America/New_York', timeOfDay: '09:00' });
    // cursor 2026-10-31T12:00Z (local 08:00 EDT) → TODAY's 09:00 EDT = 13:00Z
    const sameDay = nextOccurrenceAfter(spec, utc('2026-10-31T12:00:00.000Z'), ANCHOR);
    expect(sameDay!.scheduledAt).toBe('2026-10-31T13:00:00.000Z');
    // after today's fire → 2026-11-01 09:00 EST (post fall-back) = 14:00Z
    const afterFallBack = nextOccurrenceAfter(spec, utc('2026-10-31T13:00:00.000Z'), ANCHOR);
    expect(afterFallBack!.scheduledAt).toBe('2026-11-01T14:00:00.000Z');
    // the day after is still EST: 2026-11-02 09:00 = 14:00Z
    const next = nextOccurrenceAfter(spec, utc('2026-11-01T14:00:00.000Z'), ANCHOR);
    expect(next!.scheduledAt).toBe('2026-11-02T14:00:00.000Z');
  });

  it('GAP BOUNDARY: daily 02:30 America/New_York across 2026-03-08 fires at the gap end 07:00Z (typed gap_shifted)', () => {
    const spec = validateScheduleSpec({ kind: 'daily', timezone: 'America/New_York', timeOfDay: '02:30' });
    // cursor 2026-03-07T12:00Z → next local 02:30 = 2026-03-08 (skipped) → gap end
    const occ = nextOccurrenceAfter(spec, utc('2026-03-07T12:00:00.000Z'), ANCHOR);
    expect(occ!.scheduledAt).toBe('2026-03-08T07:00:00.000Z');
    expect(occ!.resolution).toBe('gap_shifted');
    // the NEXT day is a normal 02:30 EDT (post spring-forward) = 06:30Z
    const next = nextOccurrenceAfter(spec, utc('2026-03-08T07:00:00.000Z'), ANCHOR);
    expect(next!.scheduledAt).toBe('2026-03-09T06:30:00.000Z');
    expect(next!.resolution).toBe('normal');
  });

  it('AMBIGUITY BOUNDARY: daily 01:30 America/New_York across 2026-11-01 fires at the FIRST 01:30 (05:30Z, typed ambiguous_first)', () => {
    const spec = validateScheduleSpec({ kind: 'daily', timezone: 'America/New_York', timeOfDay: '01:30' });
    const occ = nextOccurrenceAfter(spec, utc('2026-10-31T12:00:00.000Z'), ANCHOR);
    expect(occ!.scheduledAt).toBe('2026-11-01T05:30:00.000Z');
    expect(occ!.resolution).toBe('ambiguous_first');
    // the next day is normal 01:30 EST = 06:30Z
    const next = nextOccurrenceAfter(spec, utc('2026-11-01T05:30:00.000Z'), ANCHOR);
    expect(next!.scheduledAt).toBe('2026-11-02T06:30:00.000Z');
    expect(next!.resolution).toBe('normal');
  });
});

describe('V2-009 — weekly wall-clock occurrence derivation', () => {
  const spec = validateScheduleSpec({
    kind: 'weekly',
    timezone: 'Africa/Accra',
    timeOfDay: '09:00',
    daysOfWeek: [1, 5], // Monday + Friday
  });

  it('derives the next matching weekday (Tue 2026-09-01 cursor → Fri 09:00; Fri cursor → Mon 09:00)', () => {
    // 2026-09-01 is a Tuesday.
    const fri = nextOccurrenceAfter(spec, utc('2026-09-01T12:00:00.000Z'), ANCHOR);
    expect(fri!.scheduledAt).toBe('2026-09-04T09:00:00.000Z'); // Friday
    const mon = nextOccurrenceAfter(spec, utc('2026-09-04T12:00:00.000Z'), ANCHOR);
    expect(mon!.scheduledAt).toBe('2026-09-07T09:00:00.000Z'); // Monday
  });

  it('the occurrence exactly AT the cursor advances to the NEXT matching weekday (strictly-after)', () => {
    const occ = nextOccurrenceAfter(spec, utc('2026-09-04T09:00:00.000Z'), ANCHOR);
    expect(occ!.scheduledAt).toBe('2026-09-07T09:00:00.000Z');
  });

  it('a cursor on a non-matching weekday before the time-of-day still derives the NEXT matching day', () => {
    // Wednesday 2026-09-02 07:00 → Friday 09:00 (not Wednesday — not in the set)
    const occ = nextOccurrenceAfter(spec, utc('2026-09-02T07:00:00.000Z'), ANCHOR);
    expect(occ!.scheduledAt).toBe('2026-09-04T09:00:00.000Z');
  });
});

describe('V2-009 — derivation determinism (same inputs → byte-identical output)', () => {
  it('repeated derivation over a cursor sequence is stable', () => {
    const spec = validateScheduleSpec({ kind: 'daily', timezone: 'America/New_York', timeOfDay: '02:30' });
    let cursor = utc('2026-03-01T00:00:00.000Z');
    const seen: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const occ = nextOccurrenceAfter(spec, cursor, ANCHOR);
      expect(occ).not.toBeNull();
      seen.push(occ!.scheduledAt);
      cursor = epochMsOf(occ!.scheduledAt);
    }
    // The DST boundary days appear exactly once each, in order.
    expect(seen.filter((s) => s.startsWith('2026-03-08'))).toEqual(['2026-03-08T07:00:00.000Z']);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
