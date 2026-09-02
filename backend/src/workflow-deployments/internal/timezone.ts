/**
 * V2-009 — the pure IANA timezone engine (deterministic).
 *
 * Maps (injected epoch, IANA zone) ⇄ local wall-clock through the runtime's
 * tz database via `Intl.DateTimeFormat`. DISCIPLINE (pinned by the
 * module-boundary battery):
 *   - epochs are passed around as NUMBERS — no `new Date` anywhere (the
 *     determinism contract is unchanged: Intl with a fixed zone + a fixed
 *     numeric epoch is a pure function of the tz database);
 *   - the UTC civil math (days ⇄ civil) is the module's own pure
 *     Hinnant-conversion clock (no Date API);
 *   - given the same tzdata, every result is byte-identical everywhere.
 *
 * DST policy (deterministic, honestly recorded):
 *   - a SKIPPED local time (spring-forward gap) resolves FORWARD to the gap
 *     end (the instant the wall clock passes the scheduled time);
 *   - an AMBIGUOUS local time (fall-back overlap) resolves to the FIRST
 *     occurrence by default (the earlier instant), or the LAST when
 *     explicitly requested;
 *   - both carry a typed resolution marker — never silently normalized.
 */

const MS_PER_DAY = 86_400_000;

/** Local wall-clock parts (civil, zone-resolved). */
export interface LocalWallClock {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number; // 1..31
  readonly hour: number; // 0..23
  readonly minute: number; // 0..59
}

export interface LocalParts extends LocalWallClock {
  readonly second: number;
  /** ISO 8601 weekday: 1 (Monday) .. 7 (Sunday). */
  readonly weekday: number;
}

/** How a wall-clock → instant conversion resolved (the honesty markers). */
export type WallClockResolution =
  | 'normal'
  | 'ambiguous_first'
  | 'ambiguous_last'
  | 'gap_shifted';

export interface WallClockConversion {
  readonly epochMs: number;
  readonly resolution: WallClockResolution;
}

// ============================================================================
// The Intl bridge (the ONLY zone-data consumer; epochs as numbers)
// ============================================================================

const PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = PARTS_FORMATTERS.get(timeZone);
  if (dtf === undefined) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    });
    PARTS_FORMATTERS.set(timeZone, dtf);
  }
  return dtf;
}

/** Validate an IANA zone identifier (fail-closed; canonical form only). */
export function isValidTimezone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  if (!/^[A-Za-z0-9/_+\-]+$/.test(timeZone)) return false;
  // Canonical IANA zones are Area/Location (plus the sanctioned 'UTC');
  // legacy abbreviation aliases (EST, CST, …) are deliberately rejected —
  // schedules must use canonical region names.
  if (!timeZone.includes('/') && timeZone !== 'UTC') return false;
  try {
    partsFormatter(timeZone).formatToParts(0);
    return true;
  } catch {
    return false;
  }
}

/** The local civil parts at an instant (pure; weekday included). */
export function localPartsAt(epochMs: number, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(epochMs);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let weekday = 1;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value) % 24; // hour '24' normalization (some ICU versions)
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      case 'weekday':
        weekday = WEEKDAY_OF[part.value] ?? 1;
        break;
      default:
        break;
    }
  }
  return { year, month, day, hour, minute, second, weekday };
}

const WEEKDAY_OF: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * The zone's UTC offset (ms) at an instant: the difference between the local
 * wall-clock read at the instant and the instant itself (the wall clock is
 * second-precision, so the sub-second remainder of the epoch is floored).
 */
export function offsetMsAt(epochMs: number, timeZone: string): number {
  const parts = localPartsAt(epochMs, timeZone);
  const asUtc = utcEpochOf(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

// ============================================================================
// Pure UTC civil math (Hinnant; the module clock's algorithm, inlined here
// for seconds precision)
// ============================================================================

function utcEpochOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146_097 + doe - 719_468;
  return days * MS_PER_DAY + hour * 3_600_000 + minute * 60_000 + second * 1000;
}

// ============================================================================
// Wall-clock → instant (the DST boundary resolution)
// ============================================================================

function sameWallClock(a: LocalParts, b: LocalWallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/**
 * Convert a local wall-clock in `timeZone` to the UTC instant.
 *
 *   normal        — exactly one instant maps back to the wall clock;
 *   ambiguous_*   — two instants map back (fall-back overlap): 'first' (the
 *                   earlier instant, the default) or 'last';
 *   gap_shifted   — no instant maps back (spring-forward gap): resolves
 *                   FORWARD to the gap end (the transition instant where the
 *                   wall clock passes the requested time).
 */
export function wallClockToEpoch(
  wall: LocalWallClock,
  timeZone: string,
  disambiguation: 'first' | 'last' = 'first',
): WallClockConversion {
  const naive = utcEpochOf(wall.year, wall.month, wall.day, wall.hour, wall.minute, 0);
  // The two plausible offsets: the zone's offset shortly BEFORE and shortly
  // AFTER the local time (a ±14h window brackets every possible transition —
  // IANA's maximum offset spread). For normal times both are equal; for
  // ambiguous times they are the two overlapping offsets; for gaps they are
  // the pre/post offsets and NEITHER candidate round-trips.
  const offsetEarly = offsetMsAt(naive - 14 * 3_600_000, timeZone);
  const offsetLate = offsetMsAt(naive + 14 * 3_600_000, timeZone);
  const candidateA = naive - offsetEarly;
  const candidateB = naive - offsetLate;

  const validA = sameWallClock(localPartsAt(candidateA, timeZone), wall);
  const validB = sameWallClock(localPartsAt(candidateB, timeZone), wall);

  if (validA && validB) {
    // Ambiguous (the offsets differ and both round-trip).
    if (candidateA === candidateB) return { epochMs: candidateA, resolution: 'normal' };
    return disambiguation === 'first'
      ? { epochMs: Math.min(candidateA, candidateB), resolution: 'ambiguous_first' }
      : { epochMs: Math.max(candidateA, candidateB), resolution: 'ambiguous_last' };
  }
  if (validA) return { epochMs: candidateA, resolution: 'normal' };
  if (validB) return { epochMs: candidateB, resolution: 'normal' };

  // Neither round-trips: the wall clock is inside a gap (or the zone is
  // degenerate) — resolve FORWARD to the transition instant.
  const transition = findForwardTransition(wall, timeZone);
  return { epochMs: transition, resolution: 'gap_shifted' };
}

/**
 * The first instant at/after which the zone's local wall clock has passed
 * `wall` (the gap end). Deterministic binary search over the offset
 * function: the search window is the ±15h around the naive instant (the
 * maximum possible offset spread per IANA).
 */
function findForwardTransition(wall: LocalWallClock, timeZone: string): number {
  const naive = utcEpochOf(wall.year, wall.month, wall.day, wall.hour, wall.minute, 0);
  const windowMs = 15 * 3_600_000;
  let lo = naive - windowMs;
  let hi = naive + windowMs;
  // The local wall clock at lo is before `wall`; at hi it is after `wall`
  // (guaranteed: 15h window covers every offset change).
  // Find the smallest instant where local(wall at instant) >= wall.
  for (let guard = 0; guard < 64; guard += 1) {
    if (hi - lo <= 1) break;
    const mid = Math.floor((lo + hi) / 2);
    const parts = localPartsAt(mid, timeZone);
    if (wallClockAtOrAfter(parts, wall)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

function wallClockAtOrAfter(parts: LocalParts, wall: LocalWallClock): boolean {
  const a = parts.year * 1_000_000 + parts.month * 10_000 + parts.day * 100 + parts.hour; // minute precision folded
  const b = wall.year * 1_000_000 + wall.month * 10_000 + wall.day * 100 + wall.hour;
  if (a !== b) return a > b;
  return parts.minute >= wall.minute;
}
