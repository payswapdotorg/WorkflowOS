/**
 * V2-008 — clock regressions (work-order: injected pure clock, no Date API).
 *
 * Covers the required regressions:
 *   - `formatUtcTimestamp`/`epochMsOf` are exact inverses (round-trip over
 *     representative instants, INCLUDING the leap day 2024-02-29 and
 *     year/epoch boundaries);
 *   - fixed-format UTC rendering (`YYYY-MM-DDTHH:MM:SS.sssZ`);
 *   - `ageMs` (pure, signed) and `addMs` (validity windows, day rollover);
 *   - `createSteppingAgentClock` determinism: fixed base, fixed step per call.
 */
import { describe, it, expect } from 'vitest';
import {
  formatUtcTimestamp,
  epochMsOf,
  ageMs,
  addMs,
  createSteppingAgentClock,
} from '../../../src/computer-agent/index.js';

describe('V2-008 clock (pure injected UTC, no Date API)', () => {
  it('round-trips representative instants exactly (incl. leap day 2024-02-29)', () => {
    const instants = [
      0,
      1,
      999,
      1_000,
      86_400_000, // 1970-01-02T00:00:00.000Z
      1_709_164_800_000, // 2024-02-29T00:00:00.000Z (leap day)
      1_709_208_000_000, // 2024-02-29T12:00:00.000Z (leap-day noon)
      1_709_251_199_999, // 2024-02-29T23:59:59.999Z (last leap-day ms)
      1_709_251_200_000, // 2024-03-01T00:00:00.000Z
      1_735_689_600_000, // 2025-01-01T00:00:00.000Z
      4_102_444_800_000, // 2100-01-01T00:00:00.000Z (non-leap century year)
      1_788_264_000_000, // the battery's fixed base epoch
    ];
    for (const ms of instants) {
      const stamp = formatUtcTimestamp(ms);
      expect(stamp, `formatUtcTimestamp(${String(ms)})`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(epochMsOf(stamp), `epochMsOf(formatUtcTimestamp(${String(ms)}))`).toBe(ms);
    }
  });

  it('renders the fixed-format UTC string exactly for known instants', () => {
    expect(formatUtcTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(formatUtcTimestamp(1_709_164_800_000)).toBe('2024-02-29T00:00:00.000Z');
    expect(formatUtcTimestamp(1_709_164_800_001)).toBe('2024-02-29T00:00:00.001Z');
    expect(formatUtcTimestamp(1_709_208_000_000)).toBe('2024-02-29T12:00:00.000Z');
    expect(epochMsOf('2024-02-29T12:00:00.000Z')).toBe(1_709_208_000_000);
    expect(formatUtcTimestamp(1_788_264_000_000)).toBe('2026-09-01T12:00:00.000Z');
    expect(formatUtcTimestamp(86_399_999)).toBe('1970-01-01T23:59:59.999Z');
  });

  it('rejects non-fixed-format timestamps fail-closed (typed throw)', () => {
    expect(() => epochMsOf('2026-09-04T00:00:00Z')).toThrow(/fixed-format UTC/);
    expect(() => epochMsOf('')).toThrow(/fixed-format UTC/);
    expect(() => epochMsOf('not-a-timestamp')).toThrow(/fixed-format UTC/);
  });

  it('computes ageMs purely (signed; exact over day boundaries)', () => {
    const now = '2026-09-01T12:01:00.000Z';
    expect(ageMs('2026-09-01T12:00:00.000Z', now)).toBe(60_000);
    expect(ageMs('2026-09-01T11:01:00.000Z', now)).toBe(3_600_000);
    expect(ageMs('2026-08-29T12:01:00.000Z', now)).toBe(3 * 86_400_000); // exact day multiples
    // a timestamp AFTER now is negative (pure signed arithmetic — no clamping)
    expect(ageMs('2026-09-01T12:02:00.000Z', now)).toBe(-60_000);
    expect(ageMs(now, now)).toBe(0);
    // leap-day boundary arithmetic
    expect(ageMs('2024-02-29T23:59:59.000Z', '2024-03-01T00:00:01.000Z')).toBe(2_000);
  });

  it('adds milliseconds exactly (validity windows; day/leap rollover)', () => {
    expect(addMs('2026-09-01T12:00:00.000Z', 0)).toBe('2026-09-01T12:00:00.000Z');
    expect(addMs('2026-09-01T12:00:00.000Z', 300_000)).toBe('2026-09-01T12:05:00.000Z');
    expect(addMs('2026-09-04T23:59:30.000Z', 30_000)).toBe('2026-09-05T00:00:00.000Z');
    expect(addMs('2024-02-28T23:59:59.000Z', 1_000)).toBe('2024-02-29T00:00:00.000Z');
    expect(addMs('2024-02-29T23:59:59.999Z', 1)).toBe('2024-03-01T00:00:00.000Z');
    // addMs ∘ epochMsOf round-trips (the inverse of subtraction)
    expect(epochMsOf(addMs('2026-09-04T12:34:56.789Z', 123_456))).toBe(
      epochMsOf('2026-09-04T12:34:56.789Z') + 123_456,
    );
  });

  it('createSteppingAgentClock steps deterministically from a fixed base', () => {
    const base = 1_788_264_000_000;
    const clock1000 = createSteppingAgentClock(base, 1000);
    expect(clock1000()).toBe('2026-09-01T12:00:00.000Z');
    expect(clock1000()).toBe('2026-09-01T12:00:01.000Z');
    expect(clock1000()).toBe('2026-09-01T12:00:02.000Z');
    // a different step produces the correspondingly different sequence
    const clock250 = createSteppingAgentClock(base, 250);
    expect(clock250()).toBe('2026-09-01T12:00:00.000Z');
    expect(clock250()).toBe('2026-09-01T12:00:00.250Z');
    // two clocks from the same base are independent sequences
    const again = createSteppingAgentClock(base, 1000);
    expect(again()).toBe('2026-09-01T12:00:00.000Z');
    expect(again()).toBe('2026-09-01T12:00:01.000Z');
  });
});
