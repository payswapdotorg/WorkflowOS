import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@platform/index.js';
import type { AuditEventWriter } from '@modules/audit/index.js';

/**
 * WORK-074 — the server-side session lifecycle (WORK-063: "Sessions are
 * server-side, authoritative, and revocable; logout/revocation actually
 * removes access").
 *
 * Design:
 *   - The session token is a 256-bit random opaque string. The client receives
 *     it ONCE (as an HttpOnly cookie set by the /auth routes); the database
 *     stores ONLY its SHA-256 digest (SEC-AC-02 — a database leak exposes no
 *     usable session).
 *   - Verification is server-side against PostgreSQL (WORK-063 invariant #14):
 *     unknown → `invalid`, past expires_at → `expired`, revoked_at set →
 *     `revoked`. There are no immortal tokens.
 *   - `refresh` implements refresh persistence: a valid session's expiry is
 *     extended (sliding window) and last_refreshed_at recorded.
 *   - `revoke` is the logout primitive. Revocation actually removes access —
 *     the discrimination is pinned by tests (a revoked session is rejected
 *     while an unrevoked control still verifies).
 *   - Login/audit: creation emits `identity.login` on the /audit surface
 *     (WORK-063 invariant #12); revocation emits `identity.logout`.
 *
 * This service NEVER logs or returns the raw token after creation.
 */

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastRefreshedAt: Date | null;
  readonly revokedAt: Date | null;
}

export type SessionVerification =
  | { readonly status: 'valid'; readonly session: SessionRecord; readonly userId: string }
  | { readonly status: 'invalid' | 'expired' | 'revoked' };

export type SessionRefreshResult =
  | { readonly status: 'valid'; readonly session: SessionRecord; readonly userId: string }
  | { readonly status: 'invalid' | 'expired' | 'revoked' };

export interface CreateSessionInput {
  readonly userId: string;
  /** The authentication provider that produced this session (e.g. 'password', 'google', 'github'). */
  readonly provider: string;
  /** Session lifetime in seconds. Default: 14 days. */
  readonly ttlSeconds?: number;
}

export interface CreateSessionResult {
  readonly session: SessionRecord;
  /** The opaque bearer token — returned EXACTLY once, never logged, never stored. */
  readonly token: string;
}

export interface SessionService {
  create(input: CreateSessionInput): Promise<CreateSessionResult>;
  verify(token: string): Promise<SessionVerification>;
  refresh(token: string, ttlSeconds?: number): Promise<SessionRefreshResult>;
  revoke(token: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<number>;
  listForUser(userId: string): Promise<SessionRecord[]>;
}

const DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

export class DefaultSessionService implements SessionService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly audit?: AuditEventWriter,
  ) {}

  async create(input: CreateSessionInput): Promise<CreateSessionResult> {
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const token = randomBytes(32).toString('base64url');
    const digest = sha256Hex(token);
    const result = await this.db.query<SessionRow>(
      `INSERT INTO wfos_sessions (user_id, token_digest, provider, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4))
       RETURNING id, user_id, token_digest, provider, created_at, expires_at, last_refreshed_at, revoked_at`,
      [input.userId, digest, input.provider, ttl],
    );
    const session = mapRow(result.rows[0]!);
    await this.audit?.write({
      eventType: 'identity.login',
      actor: input.userId,
      source: 'auth',
      resourceType: 'user_session',
      resourceId: session.id,
      metadata: { provider: input.provider },
    });
    return { session, token };
  }

  async verify(token: string): Promise<SessionVerification> {
    if (!token) return { status: 'invalid' };
    const digest = sha256Hex(token);
    const result = await this.db.query<SessionRow>(
      `SELECT id, user_id, token_digest, provider, created_at, expires_at, last_refreshed_at, revoked_at
       FROM wfos_sessions WHERE token_digest = $1`,
      [digest],
    );
    if (result.rows.length === 0) return { status: 'invalid' };
    const session = mapRow(result.rows[0]!);
    if (session.revokedAt) return { status: 'revoked' };
    if (session.expiresAt.getTime() <= Date.now()) return { status: 'expired' };
    return { status: 'valid', session, userId: session.userId };
  }

  async refresh(token: string, ttlSeconds?: number): Promise<SessionRefreshResult> {
    const verified = await this.verify(token);
    if (verified.status !== 'valid') return verified;
    const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const result = await this.db.query<SessionRow>(
      `UPDATE wfos_sessions
       SET expires_at = NOW() + make_interval(secs => $2),
           last_refreshed_at = NOW()
       WHERE id = $1
       RETURNING id, user_id, token_digest, provider, created_at, expires_at, last_refreshed_at, revoked_at`,
      [verified.session.id, ttl],
    );
    const session = mapRow(result.rows[0]!);
    return { status: 'valid', session, userId: session.userId };
  }

  async revoke(token: string): Promise<void> {
    if (!token) return;
    const digest = sha256Hex(token);
    // Revoke by digest; capture the session id for the audit event. Idempotent:
    // revoking an already-revoked (or unknown) token is a no-op.
    const result = await this.db.query<SessionRow>(
      `UPDATE wfos_sessions SET revoked_at = NOW()
       WHERE token_digest = $1 AND revoked_at IS NULL
       RETURNING id, user_id, token_digest, provider, created_at, expires_at, last_refreshed_at, revoked_at`,
      [digest],
    );
    const row = result.rows[0];
    if (row) {
      await this.audit?.write({
        eventType: 'identity.logout',
        actor: row.user_id,
        source: 'auth',
        resourceType: 'user_session',
        resourceId: row.id,
        metadata: { provider: row.provider },
      });
    }
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE wfos_sessions SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
      [userId],
    );
    return result.rows.length;
  }

  async listForUser(userId: string): Promise<SessionRecord[]> {
    const result = await this.db.query<SessionRow>(
      `SELECT id, user_id, token_digest, provider, created_at, expires_at, last_refreshed_at, revoked_at
       FROM wfos_sessions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map(mapRow);
  }
}

interface SessionRow {
  id: string;
  user_id: string;
  token_digest: string;
  provider: string;
  created_at: Date;
  expires_at: Date;
  last_refreshed_at: Date | null;
  revoked_at: Date | null;
}

function mapRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastRefreshedAt: row.last_refreshed_at,
    revokedAt: row.revoked_at,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
