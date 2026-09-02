/**
 * V2-009 — schedule spec validation + occurrence derivation (PURE).
 *
 * `nextOccurrenceAfter(spec, afterEpochMs, anchorEpochMs)` derives the next
 * occurrence STRICTLY AFTER `afterEpochMs` (the subscription cursor):
 *   - one_shot: the fixed instant (null once passed — one-shot never refires);
 *   - interval: anchor + k·everyMs (the smallest k with value > after —
 *     UTC-anchored fixed-duration recurrence, timezone-free);
 *   - daily/weekly: the next matching local wall-clock in the zone,
 *     DST-resolved through the pure timezone engine (gap → forward to the
 *     gap end, typed gap_shifted; ambiguous → first occurrence, typed
 *     ambiguous_first) — the work order's timezone/time-source correctness.
 *
 * All validation is fail-closed and typed (SUBSCRIPTION_SCHEDULE_INVALID).
 */
import { WorkflowDeploymentError, type ScheduleOccurrence, type ScheduleSpec } from '../types.js';
import { civilFromDays, daysFromCivil, epochMsOf, formatUtcTimestamp } from './clock.js';
import { isValidTimezone, localPartsAt, wallClockToEpoch } from './timezone.js';

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FIXED_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Smallest representable recurrence (sub-second recurrences rejected). */
const MIN_EVERY_MS = 1_000;

/** Parse "HH:MM" → minutes since local midnight. */
function minutesOfDay(timeOfDay: string): number {
  const match = TIME_OF_DAY.exec(timeOfDay);
  if (!match) return -1;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Validate + normalize a schedule spec (fail-closed, typed). */
export function validateScheduleSpec(spec: unknown): ScheduleSpec {
  if (typeof spec !== 'object' || spec === null) {
    throw new WorkflowDeploymentError('SUBSCRIPTION_SCHEDULE_INVALID', 'the schedule spec must be an object');
  }
  const record = spec as Record<string, unknown>;
  switch (record.kind) {
    case 'one_shot': {
      const at = record.at;
      if (typeof at !== 'string' || !FIXED_UTC.test(at)) {
        throw new WorkflowDeploymentError(
          'SUBSCRIPTION_SCHEDULE_INVALID',
          'one_shot.at must be a fixed-format UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ)',
          typeof at === 'string' ? at : JSON.stringify(at),
        );
      }
      return { kind: 'one_shot', at };
    }
    case 'interval': {
      const everyMs = record.everyMs;
      if (typeof everyMs !== 'number' || !Number.isSafeInteger(everyMs) || everyMs < MIN_EVERY_MS) {
        throw new WorkflowDeploymentError(
          'SUBSCRIPTION_SCHEDULE_INVALID',
          `interval.everyMs must be an integer >= ${MIN_EVERY_MS} ms`,
          JSON.stringify(record.everyMs),
        );
      }
      return { kind: 'interval', everyMs };
    }
    case 'daily': {
      const timezone = requireTimezone(record.timezone);
      const timeOfDay = requireTimeOfDay(record.timeOfDay);
      return { kind: 'daily', timezone, timeOfDay };
    }
    case 'weekly': {
      const timezone = requireTimezone(record.timezone);
      const timeOfDay = requireTimeOfDay(record.timeOfDay);
      const days = requireDaysOfWeek(record.daysOfWeek);
      return { kind: 'weekly', timezone, timeOfDay, daysOfWeek: days };
    }
    default:
      throw new WorkflowDeploymentError(
        'SUBSCRIPTION_SCHEDULE_INVALID',
        'kind must be one of one_shot | interval | daily | weekly',
        JSON.stringify(record.kind),
      );
  }
}

function requireTimezone(timezone: unknown): string {
  if (typeof timezone !== 'string' || !isValidTimezone(timezone)) {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_SCHEDULE_INVALID',
      'the schedule timezone must be a valid IANA zone identifier',
      typeof timezone === 'string' ? timezone : JSON.stringify(timezone),
    );
  }
  return timezone;
}

function requireTimeOfDay(timeOfDay: unknown): string {
  if (typeof timeOfDay !== 'string' || !TIME_OF_DAY.test(timeOfDay)) {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_SCHEDULE_INVALID',
      'timeOfDay must be HH:MM (24h, zero-padded)',
      typeof timeOfDay === 'string' ? timeOfDay : JSON.stringify(timeOfDay),
    );
  }
  return timeOfDay;
}

function requireDaysOfWeek(daysOfWeek: unknown): number[] {
  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
    throw new WorkflowDeploymentError(
      'SUBSCRIPTION_SCHEDULE_INVALID',
      'weekly.daysOfWeek must be a non-empty array of ISO weekdays 1..7',
    );
  }
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const day of daysOfWeek) {
    if (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 1 || day > 7) {
      throw new WorkflowDeploymentError(
        'SUBSCRIPTION_SCHEDULE_INVALID',
        'weekly.daysOfWeek entries must be integers 1..7 (ISO: 1=Monday..7=Sunday)',
        JSON.stringify(day),
      );
    }
    if (!seen.has(day)) {
      seen.add(day);
      normalized.push(day);
    }
  }
  normalized.sort((a, b) => a - b);
  return normalized;
}

/**
 * Derive the next occurrence strictly after `afterEpochMs`.
 * `anchorEpochMs` anchors interval recurrence (the subscription creation).
 * Returns null when the schedule can never fire again (one-shot passed).
 */
export function nextOccurrenceAfter(
  spec: ScheduleSpec,
  afterEpochMs: number,
  anchorEpochMs: number,
): ScheduleOccurrence | null {
  switch (spec.kind) {
    case 'one_shot': {
      const atMs = epochMsOf(spec.at); // validated fixed-format UTC (pure)
      return atMs > afterEpochMs ? { scheduledAt: spec.at, resolution: 'normal' } : null;
    }
    case 'interval': {
      const delta = afterEpochMs - anchorEpochMs;
      const k = Math.floor(delta / spec.everyMs) + 1;
      const instant = anchorEpochMs + k * spec.everyMs;
      return { scheduledAt: formatUtcTimestamp(instant), resolution: 'normal' };
    }
    case 'daily':
    case 'weekly': {
      return nextWallClockOccurrence(spec, afterEpochMs);
    }
  }
}

/**
 * The next local wall-clock occurrence of (timeOfDay[, daysOfWeek]) in the
 * zone, strictly after `afterEpochMs`. Candidate days advance CIVILLY
 * (days-since-epoch arithmetic — DST-safe: no wall-clock drift), and each
 * candidate instant is resolved through the DST-aware timezone engine.
 */
function nextWallClockOccurrence(
  spec: { kind: 'daily' | 'weekly'; timezone: string; timeOfDay: string; daysOfWeek?: readonly number[] },
  afterEpochMs: number,
): ScheduleOccurrence {
  const minutes = minutesOfDay(spec.timeOfDay);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const wantedDays =
    spec.kind === 'weekly' && spec.daysOfWeek ? new Set<number>(spec.daysOfWeek) : null;

  // Start from the local civil day of `afterEpochMs`.
  const afterParts = localPartsAt(afterEpochMs, spec.timezone);
  const startDays = daysFromCivil(afterParts.year, afterParts.month, afterParts.day);

  // Iterate civil days forward — at most 8 candidates (weekly worst case 7).
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const days = startDays + dayOffset;
    if (wantedDays !== null && !wantedDays.has(civilWeekdayOf(days))) continue;

    const candidate = civilFromDays(days);
    const conversion = wallClockToEpoch(
      { year: candidate.year, month: candidate.month, day: candidate.day, hour, minute },
      spec.timezone,
    );
    if (conversion.epochMs > afterEpochMs) {
      return {
        scheduledAt: formatUtcTimestamp(conversion.epochMs),
        resolution:
          conversion.resolution === 'ambiguous_last'
            ? 'ambiguous_first'
            : conversion.resolution,
      };
    }
    // The candidate is at/before the cursor → the next day (strictly-after
    // semantics: an occurrence never refires).
  }
  // Unreachable for well-formed specs (weekly max gap 7 days), but fail
  // closed rather than loop forever.
  throw new WorkflowDeploymentError(
    'SUBSCRIPTION_SCHEDULE_INVALID',
    'wall-clock occurrence derivation exceeded its search window',
  );
}

/** ISO weekday of a days-since-epoch civil date (1970-01-01 was Thursday). */
function civilWeekdayOf(days: number): number {
  return (((days % 7) + 7 + 3) % 7) + 1;
}
