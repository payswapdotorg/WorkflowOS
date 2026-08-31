import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@platform/index.js';

/**
 * WORK-074 — the server-side OAuth authorization-request state store (the
 * callback CSRF contract). Before redirecting the browser to a provider, the
 * /auth route mints a cryptographically random state AND binds it to the
 * initiating browser's pre-auth transaction id (a random HttpOnly cookie the
 * /start response issued). The callback MUST present a state that:
 *   - exists, is unexpired, AND matches the provider;
 *   - matches the TRANSACTION BINDING of the presenting browser (login-CSRF
 *     protection: a state minted for browser A is rejected when presented by
 *     browser B — the binding is part of the SAME atomic single-use consume,
 *     so state and transaction are spent together on first use);
 *   — and the binding is checked BEFORE any provider assertion is accepted.
 *
 * The state is a random nonce and the transaction id a random pre-auth value —
 * neither is long-lived secret material, but the transaction id is persisted
 * DIGEST-ONLY (SHA-256) in line with the session-token discipline: browser-held
 * identifiers never sit raw in the database.
 */
export interface OAuthStateRecord {
  readonly state: string;
  readonly provider: string;
  readonly redirectTo: string;
  readonly expiresAt: Date;
}

export interface OAuthStateStore {
  /** Mint + persist a fresh single-use state for `provider`, bound to `transactionId`. */
  create(input: {
    provider: string;
    redirectTo: string;
    /** The initiating browser's pre-auth transaction id (from the transaction cookie). */
    transactionId: string;
    ttlSeconds?: number;
  }): Promise<OAuthStateRecord>;
  /**
   * Atomically consume `state` for `provider` — ONLY when the presenting
   * browser's `transactionId` matches the binding recorded at create time.
   * Returns the record when valid (known, unexpired, provider-matching,
   * binding-matching) — and deletes it so it cannot be used again. Returns
   * null when unknown/expired/mismatched (including a foreign transaction).
   */
  consume(state: string, provider: string, transactionId: string): Promise<OAuthStateRecord | null>;
}

/**
 * The state TTL. MUST equal the transaction cookie TTL in
 * api/routes/session-cookie.ts (OAUTH_TRANSACTION_COOKIE_TTL_SECONDS) — the
 * browser binding expires with the state it binds (pinned by the static
 * architecture invariant).
 */
const DEFAULT_TTL_SECONDS = 600; // 10 minutes

function transactionDigest(transactionId: string): string {
  return createHash('sha256').update(transactionId).digest('hex');
}

export class PgOAuthStateStore implements OAuthStateStore {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    provider: string;
    redirectTo: string;
    transactionId: string;
    ttlSeconds?: number;
  }): Promise<OAuthStateRecord> {
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const state = randomBytes(32).toString('hex');
    const result = await this.db.query<StateRow>(
      `INSERT INTO wfos_oauth_states (state, provider, redirect_to, transaction_digest, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))
       RETURNING state, provider, redirect_to, expires_at`,
      [state, input.provider, input.redirectTo, transactionDigest(input.transactionId), ttl],
    );
    const row = result.rows[0]!;
    return {
      state: row.state,
      provider: row.provider,
      redirectTo: row.redirect_to,
      expiresAt: row.expires_at,
    };
  }

  async consume(
    state: string,
    provider: string,
    transactionId: string,
  ): Promise<OAuthStateRecord | null> {
    if (!state || !transactionId) return null;
    // DELETE ... RETURNING is the atomic single-use consume: the binding check
    // and the spend happen in the SAME statement — two concurrent callbacks
    // with the same state, or ANY callback without the initiating browser's
    // transaction, get nothing (and an unmatched state row is left for its
    // legitimate browser to still complete its own flow).
    const result = await this.db.query<StateRow>(
      `DELETE FROM wfos_oauth_states
       WHERE state = $1 AND provider = $2 AND transaction_digest = $3 AND expires_at > NOW()
       RETURNING state, provider, redirect_to, expires_at`,
      [state, provider, transactionDigest(transactionId)],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    return {
      state: row.state,
      provider: row.provider,
      redirectTo: row.redirect_to,
      expiresAt: row.expires_at,
    };
  }
}

interface StateRow {
  state: string;
  provider: string;
  redirect_to: string;
  expires_at: Date;
}
