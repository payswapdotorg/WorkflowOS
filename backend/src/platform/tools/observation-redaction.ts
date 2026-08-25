/**
 * WORK-036: observation REDACTION — credentials never enter durable tool
 * payloads.
 *
 * The tool runtime observes every invocation (session events + audit).
 * Before anything is persisted, secret-shaped values are redacted by KEY
 * NAME (case-insensitive substring match on the canonical credential
 * vocabulary) and HTTP headers are checked against the sensitive-header
 * set. The executor itself never ADDS credentials (sanitized process env,
 * no implicit authentication) — this layer guarantees the OBSERVED side:
 * a caller may legitimately pass an Authorization header or an API-key
 * env var, but the durable evidence shows `[REDACTED]`, never the value.
 *
 * Raw stdout/stderr are evidence and are NOT key-redacted (bounded only)
 * — they are the process output, not credential payloads.
 */

/** Key names whose VALUES never persist (case-insensitive substring match). */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /cookie/i,
  /credential/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /access[-_]?key/i,
  /bearer/i,
];

/** The canonical redaction marker. */
export const REDACTED = '[REDACTED]';

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Deep-clone a JSON-able value with every secret-shaped key's value
 * replaced by [REDACTED]. The input is never mutated.
 */
export function redactForObservation(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[CIRCULAR]';
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? REDACTED : redactValue(v, seen);
  }
  return out;
}

/** Header names whose values never persist in HTTP observations. */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  'set-cookie',
  'set-cookie2',
  'x-api-key',
  'x-auth-token',
  'x-session-token',
  'x-amz-security-token',
  'www-authenticate',
  'proxy-authenticate',
]);

/** Redact an HTTP header map for observation (sensitive names → [REDACTED]). */
export function redactHttpHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/** Whether a header NAME is sensitive (for tests + future policy use). */
export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}
