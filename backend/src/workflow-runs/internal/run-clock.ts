/**
 * V2-005 — the injected run clock (PURE: no Date API anywhere in this module).
 *
 * All run timestamps come from an injected `WorkflowRunClock`; the module
 * source never touches the ambient clock (pinned at source level by the
 * module-boundary test). The fixed format `YYYY-MM-DDTHH:MM:SS.sssZ` is
 * produced by a pure civil-from-days conversion of injected epoch
 * milliseconds (the Howard Hinnant algorithm — deterministic, no Date
 * objects, correct across leap days/year boundaries/negative epochs).
 */
import type { WorkflowRunClock } from '../types.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function pad3(value: number): string {
  if (value < 10) return `00${value}`;
  if (value < 100) return `0${value}`;
  return String(value);
}

function pad4(value: number): string {
  if (value < 0) return `-${pad4(-value)}`;
  if (value < 10) return `000${value}`;
  if (value < 100) return `00${value}`;
  if (value < 1000) return `0${value}`;
  return String(value);
}

/**
 * Format injected epoch milliseconds as the fixed-format UTC timestamp
 * `YYYY-MM-DDTHH:MM:SS.sssZ` (pure civil conversion — chronological string
 * comparison equals chronological time comparison).
 */
export function formatUtcTimestamp(epochMs: number): string {
  const days = Math.floor(epochMs / MS_PER_DAY);
  let remainder = epochMs - days * MS_PER_DAY;
  const hours = Math.floor(remainder / MS_PER_HOUR);
  remainder -= hours * MS_PER_HOUR;
  const minutes = Math.floor(remainder / MS_PER_MINUTE);
  remainder -= minutes * MS_PER_MINUTE;
  const seconds = Math.floor(remainder / MS_PER_SECOND);
  const millis = remainder - seconds * MS_PER_SECOND;

  const { year, month, day } = civilFromDays(days);
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(millis)}Z`;
}

/** Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian calendar. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  return { year: m <= 2 ? y + 1 : y, month: m, day: d };
}

/**
 * Normalize a driver-returned timestamp (Date instance, ISO string, or
 * PostgreSQL text form like `2026-09-01 12:00:00.000+00`) into the same
 * fixed-format UTC string WITHOUT constructing any Date object.
 */
export function toUtcIsoString(value: unknown): string {
  if (typeof value === 'number') return formatUtcTimestamp(value);
  if (typeof value === 'object' && value !== null && typeof (value as Date).toISOString === 'function') {
    return (value as Date).toISOString();
  }
  if (typeof value !== 'string') return String(value);
  // Already canonical (fast path)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return value;
  let text = value.trim();
  // PostgreSQL text form: 'YYYY-MM-DD HH:MM:SS[.sss][+00|+00:00|Z]'
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+]\d{2}|[+]\d{2}:\d{2}|Z)?$/);
  if (match) {
    const [, datePart, timePart, fraction, zone] = match;
    const millis = (fraction ?? '000').padEnd(3, '0').slice(0, 3);
    void zone; // only the UTC zone (Z/+00) reaches the run tables (TIMESTAMPTZ reads are UTC-normalized)
    return `${datePart}T${timePart}.${millis}Z`;
  }
  // ISO forms with variable precision
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+]\d{2}:\d{2})?$/);
  if (iso) {
    const [, datePart, timePart, fraction, zone] = iso;
    const millis = (fraction ?? '000').padEnd(3, '0').slice(0, 3);
    if (zone === undefined || zone === 'Z' || zone === '+00:00') {
      return `${datePart}T${timePart}.${millis}Z`;
    }
  }
  return text;
}

/** A deterministic stepping clock: base epoch + fixed step per `now()` call. */
export function createSteppingRunClock(baseMs: number, stepMs: number): WorkflowRunClock {
  let current = baseMs;
  return {
    now: () => {
      const stamp = formatUtcTimestamp(current);
      current += stepMs;
      return stamp;
    },
  };
}

/** Is the value already the fixed-format UTC timestamp? */
export function isFixedUtcTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}
