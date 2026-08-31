/**
 * WORK-074 — the HttpOnly session cookie contract (the ONLY session carrier).
 *
 * The browser never sees session state in JS-readable storage: the token is an
 * opaque random value in an HttpOnly cookie, verified server-side against
 * wfos_sessions. Attributes:
 *   - HttpOnly     — invisible to JavaScript (XSS cannot exfiltrate it);
 *   - SameSite=Lax — cross-site POSTs never carry it (CSRF baseline; the API's
 *     CORS is an exact-origin allowlist, never '*');
 *   - Path=/       — the SPA and the /api routes share the origin;
 *   - Secure       — when the deployment is https (production);
 *   - Max-Age      — matches the server-side expiry (refresh re-issues it).
 */

export const SESSION_COOKIE_NAME = 'wfos_session';

/**
 * WORK-074 (PR #99 security remediation) — the pre-auth OAuth transaction
 * cookie: the initiating-browser binding for an OAuth login flow. /start mints
 * it, the state row stores its DIGEST, and the callback requires the SAME
 * value before any provider assertion is accepted (login-CSRF protection —
 * a state presented by a different browser never yields a session).
 * SameSite=Lax is the correct choice for the OAuth round-trip: the provider's
 * redirect back to /callback is a top-level GET navigation, which Lax cookies
 * ride along with (Strict would not) — while cross-site POSTs still never
 * carry it.
 */
export const OAUTH_TRANSACTION_COOKIE_NAME = 'wfos_oauth_tx';

/**
 * The transaction cookie's Max-Age. MUST equal the OAuth state store's TTL
 * (modules/auth/internal/oauth-state-store.ts DEFAULT_TTL_SECONDS) — the
 * browser binding expires with the state it binds (pinned by the static
 * architecture invariant).
 */
export const OAUTH_TRANSACTION_COOKIE_TTL_SECONDS = 600; // 10 minutes

export function buildSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure = false): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** The pre-auth transaction cookie: HttpOnly, Lax, bounded to the state TTL. */
export function buildOAuthTransactionCookie(transactionId: string, ttlSeconds: number, secure: boolean): string {
  const parts = [
    `${OAUTH_TRANSACTION_COOKIE_NAME}=${transactionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(ttlSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearOAuthTransactionCookie(secure = false): string {
  const parts = [
    `${OAUTH_TRANSACTION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Read a named cookie from a raw Cookie header (no decoding — opaque ids). */
export function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  for (const part of header.split(';')) {
    const [cookieName, ...rest] = part.trim().split('=');
    if (cookieName === name) return rest.join('=') || null;
  }
  return null;
}
