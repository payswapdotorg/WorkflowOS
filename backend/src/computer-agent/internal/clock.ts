/**
 * V2-008 — the injected agent/attestation clock (PURE: no Date API).
 *
 * All computer-agent timestamps come from injected clocks; the module
 * source never touches the ambient clock (pinned at source level by the
 * module-boundary test). The fixed format `YYYY-MM-DDTHH:MM:SS.sssZ` is
 * produced/consumed by pure civil↔days conversions (the Howard Hinnant
 * algorithms — the merged V2-005 run-clock pattern, deterministic across
 * leap days/year boundaries).
 */

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

/** Format injected epoch milliseconds as the fixed-format UTC timestamp. */
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

/** Parse the fixed-format UTC timestamp into epoch milliseconds (inverse). */
export function epochMsOf(timestamp: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(timestamp);
  if (!match) {
    throw new Error(`computer-agent clock: not a fixed-format UTC timestamp: "${timestamp}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Number(match[7]);
  return (
    daysFromCivil(year, month, day) * MS_PER_DAY +
    hour * MS_PER_HOUR +
    minute * MS_PER_MINUTE +
    second * MS_PER_SECOND +
    millis
  );
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

/** (year, month, day) → days since 1970-01-01 (Hinnant days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = month > 2 ? month - 3 : month + 9; // [0, 11]
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146_097 + doe - 719_468;
}

/** Age of `timestamp` relative to `now` in milliseconds (pure). */
export function ageMs(timestamp: string, now: string): number {
  return epochMsOf(now) - epochMsOf(timestamp);
}

/** Fixed-format UTC + ms (validity windows; pure). */
export function addMs(timestamp: string, ms: number): string {
  return formatUtcTimestamp(epochMsOf(timestamp) + ms);
}

/** A deterministic stepping UTC clock: base epoch + fixed step per call. */
export function createSteppingAgentClock(baseMs: number, stepMs: number): () => string {
  let current = baseMs;
  return () => {
    const stamp = formatUtcTimestamp(current);
    current += stepMs;
    return stamp;
  };
}
