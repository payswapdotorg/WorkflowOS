/**
 * V2-009 — the pure IANA timezone engine (deterministic; REQUIRED REGRESSION:
 * "timezone boundary").
 *
 * The engine maps (injected epoch, IANA zone) ⇄ local wall-clock through the
 * runtime's tz database via Intl (no Date object construction — the epoch is
 * passed as a NUMBER; the module-boundary battery pins this). Given the same
 * tzdata, results are byte-identical everywhere.
 *
 * The pinned DST facts (IANA America/New_York, long-established rules):
 *   - 2026-03-08: spring forward, 02:00 EST → 03:00 EDT (gap 02:00–03:00,
 *     transition instant 2026-03-08T07:00:00.000Z).
 *   - 2026-11-01: fall back, 02:00 EDT → 01:00 EST (ambiguous hour
 *     01:00–02:00 local; transition instant 2026-11-01T06:00:00.000Z).
 *   - Africa/Accra: fixed GMT+0, no DST (the user timezone — sanity pin).
 */
import { describe, it, expect } from 'vitest';
import {
  isValidTimezone,
  offsetMsAt,
  localPartsAt,
  wallClockToEpoch,
} from '../../../src/workflow-deployments/internal/timezone.js';

describe('V2-009 — the pure timezone engine', () => {
  describe('isValidTimezone', () => {
    it('accepts the canonical IANA zone names used by wall-clock schedules', () => {
      expect(isValidTimezone('Africa/Accra')).toBe(true);
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('Europe/London')).toBe(true);
    });

    it('rejects malformed or unknown zone identifiers (fail-closed)', () => {
      expect(isValidTimezone('Not/AZone')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
      expect(isValidTimezone('EST')).toBe(false); // abbreviation, not IANA
      expect(isValidTimezone('America/New_York/Extra')).toBe(false);
    });
  });

  describe('offsetMsAt (instant → local offset)', () => {
    it('Africa/Accra is fixed GMT+0 (no DST, any epoch)', () => {
      expect(offsetMsAt(Date.UTC(2026, 5, 1, 12, 0), 'Africa/Accra')).toBe(0);
      expect(offsetMsAt(Date.UTC(2026, 11, 15, 3, 30), 'Africa/Accra')).toBe(0);
    });

    it('America/New_York is EST (−5h) before the 2026 spring-forward and EDT (−4h) after', () => {
      // 2026-03-08T06:59:59Z is still EST; 07:00:00Z is EDT (gap end).
      expect(offsetMsAt(Date.UTC(2026, 2, 8, 6, 59, 59), 'America/New_York')).toBe(-5 * 3_600_000);
      expect(offsetMsAt(Date.UTC(2026, 2, 8, 7, 0, 0), 'America/New_York')).toBe(-4 * 3_600_000);
    });

    it('America/New_York is EDT before the 2026 fall-back and EST after', () => {
      // 2026-11-01T05:59:59Z is EDT; 06:00:00Z is EST (fall-back instant).
      expect(offsetMsAt(Date.UTC(2026, 10, 1, 5, 59, 59), 'America/New_York')).toBe(-4 * 3_600_000);
      expect(offsetMsAt(Date.UTC(2026, 10, 1, 6, 0, 0), 'America/New_York')).toBe(-5 * 3_600_000);
    });
  });

  describe('localPartsAt (instant → local wall-clock)', () => {
    it('returns the local civil parts at an instant (Accra = UTC identity)', () => {
      const parts = localPartsAt(Date.UTC(2026, 8, 1, 12, 0), 'Africa/Accra');
      expect(parts).toMatchObject({ year: 2026, month: 9, day: 1, hour: 12, minute: 0 });
    });

    it('reports the ISO weekday (1=Monday..7=Sunday) for weekly schedules', () => {
      // 2026-09-01 is a Tuesday.
      const parts = localPartsAt(Date.UTC(2026, 8, 1, 12, 0), 'Africa/Accra');
      expect(parts.weekday).toBe(2);
      // 2026-09-06 is a Sunday.
      expect(localPartsAt(Date.UTC(2026, 8, 6, 12, 0), 'Africa/Accra').weekday).toBe(7);
    });
  });

  describe('wallClockToEpoch (local wall-clock → instant) — THE DST BOUNDARY', () => {
    it('NORMAL: 02:30 Accra on 2026-09-01 → 02:30:00.000Z (fixed offset, exact)', () => {
      const r = wallClockToEpoch({ year: 2026, month: 9, day: 1, hour: 2, minute: 30 }, 'Africa/Accra');
      expect(r.resolution).toBe('normal');
      expect(r.epochMs).toBe(Date.UTC(2026, 8, 1, 2, 30));
    });

    it('NORMAL (offset): 02:30 New York on 2026-09-01 → 06:30:00.000Z (EDT)', () => {
      const r = wallClockToEpoch({ year: 2026, month: 9, day: 1, hour: 2, minute: 30 }, 'America/New_York');
      expect(r.resolution).toBe('normal');
      expect(r.epochMs).toBe(Date.UTC(2026, 8, 1, 6, 30));
    });

    it('GAP (spring forward): 02:30 New York on 2026-03-08 does NOT exist → resolves FORWARD to the gap end 2026-03-08T07:00:00.000Z (03:00 EDT), typed gap_shifted', () => {
      const r = wallClockToEpoch({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York');
      expect(r.resolution).toBe('gap_shifted');
      expect(r.epochMs).toBe(Date.UTC(2026, 2, 8, 7, 0, 0));
    });

    it('AMBIGUOUS (fall back): 01:30 New York on 2026-11-01 occurs twice → first (EDT) = 2026-11-01T05:30:00.000Z by default, typed ambiguous_first', () => {
      const r = wallClockToEpoch({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
      expect(r.resolution).toBe('ambiguous_first');
      expect(r.epochMs).toBe(Date.UTC(2026, 10, 1, 5, 30));
    });

    it('AMBIGUOUS (fall back): the same 01:30 with disambiguation "last" (EST) = 2026-11-01T06:30:00.000Z, typed ambiguous_last', () => {
      const r = wallClockToEpoch(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
        'America/New_York',
        'last',
      );
      expect(r.resolution).toBe('ambiguous_last');
      expect(r.epochMs).toBe(Date.UTC(2026, 10, 1, 6, 30));
    });

    it('UNAMBIGUOUS after the fall-back: 02:30 New York on 2026-11-01 exists exactly once (EST) → 07:30:00.000Z, typed normal', () => {
      const r = wallClockToEpoch({ year: 2026, month: 11, day: 1, hour: 2, minute: 30 }, 'America/New_York');
      expect(r.resolution).toBe('normal');
      expect(r.epochMs).toBe(Date.UTC(2026, 10, 1, 7, 30));
    });
  });
});
