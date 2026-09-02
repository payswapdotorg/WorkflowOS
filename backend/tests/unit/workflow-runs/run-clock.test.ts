/**
 * V2-005 — the injected run clock (PURE, no Date APIs): the fixed-format UTC
 * formatter and the deterministic stepping clock. The module source NEVER
 * touches the ambient clock (pinned by the module-boundary test); all run
 * timestamps come from this injected source.
 */
import { describe, it, expect } from 'vitest';
import {
  formatUtcTimestamp,
  toUtcIsoString,
  createSteppingRunClock,
} from '../../../src/workflow-runs/internal/run-clock.js';

describe('V2-005 — the pure UTC formatter (no Date API in the module)', () => {
  it('formats epoch milliseconds into the exact fixed format', () => {
    expect(formatUtcTimestamp(1788264000000)).toBe('2026-09-01T12:00:00.000Z');
    expect(formatUtcTimestamp(1709251199999)).toBe('2024-02-29T23:59:59.999Z');
    expect(formatUtcTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(formatUtcTimestamp(946684800001)).toBe('2000-01-01T00:00:00.001Z');
    expect(formatUtcTimestamp(1788263970250)).toBe('2026-09-01T11:59:30.250Z');
  });

  it('handles leap-day and year boundaries (civil-from-days algorithm)', () => {
    expect(formatUtcTimestamp(1709164800000)).toBe('2024-02-29T00:00:00.000Z');
    expect(formatUtcTimestamp(1709251200000)).toBe('2024-03-01T00:00:00.000Z');
    expect(formatUtcTimestamp(1735689599999)).toBe('2024-12-31T23:59:59.999Z');
    expect(formatUtcTimestamp(1735689600000)).toBe('2025-01-01T00:00:00.000Z');
  });

  it('negative epoch times stay UTC-correct (pre-1970)', () => {
    expect(formatUtcTimestamp(-1)).toBe('1969-12-31T23:59:59.999Z');
    expect(formatUtcTimestamp(-86400000)).toBe('1969-12-31T00:00:00.000Z');
  });

  it('normalizes driver-returned timestamp forms to the same fixed format', () => {
    expect(toUtcIsoString('2026-09-01T12:00:00.000Z')).toBe('2026-09-01T12:00:00.000Z');
    expect(toUtcIsoString('2026-09-01 12:00:00.000+00')).toBe('2026-09-01T12:00:00.000Z');
    expect(toUtcIsoString('2026-09-01 12:00:00+00')).toBe('2026-09-01T12:00:00.000Z');
    expect(toUtcIsoString(1788264000000)).toBe('2026-09-01T12:00:00.000Z');
  });
});

describe('V2-005 — the deterministic stepping clock', () => {
  it('steps monotonically by the injected step (never wall-clock)', () => {
    const clock = createSteppingRunClock(1788264000000, 1000);
    expect(clock.now()).toBe('2026-09-01T12:00:00.000Z');
    expect(clock.now()).toBe('2026-09-01T12:00:01.000Z');
    expect(clock.now()).toBe('2026-09-01T12:00:02.000Z');
  });

  it('two clocks with the same base produce identical time streams (deterministic)', () => {
    const a = createSteppingRunClock(1788264000000, 250);
    const b = createSteppingRunClock(1788264000000, 250);
    for (let i = 0; i < 5; i += 1) {
      expect(a.now()).toBe(b.now());
    }
  });

  it('sub-second steps format with millisecond precision', () => {
    const clock = createSteppingRunClock(1788264000000, 1);
    expect(clock.now()).toBe('2026-09-01T12:00:00.000Z');
    expect(clock.now()).toBe('2026-09-01T12:00:00.001Z');
  });
});
