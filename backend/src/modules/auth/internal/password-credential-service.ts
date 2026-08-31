import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseClient } from '@platform/index.js';
import type { User, UserRepository, LinkedIdentityRepository } from '@modules/users/index.js';

/**
 * WORK-074 — the email/password authentication mechanism (WORK-063: "email —
 * email/password or passwordless email"; this runtime implements
 * email/password, the smallest production-appropriate mechanism that requires
 * no mail infrastructure).
 *
 * Credential discipline (SEC-AC-01/02):
 *   - ONLY the scrypt-encoded verifier is persisted
 *     (`scrypt$N$r$p$salt$hash`, salt random per user). The raw password is
 *     never stored, logged, or emitted — verification is a constant-time
 *     comparison of derived keys.
 *   - The email subject is the identity subject (provider 'password').
 *
 * Fail-closed registration semantics (typed rejections):
 *   - `weak-password` — fewer than 8 characters;
 *   - `invalid-email` — malformed address;
 *   - `email-taken` — an account already carries that email (whether from a
 *     password registration or a provider login). A password is NEVER attached
 *     to an existing account through self-service registration: without an
 *     email-verification flow, attaching a password to a claimed email would
 *     be an account-takeover path. (A future verification flow may relax this;
 *     WORK-074 fails closed.)
 *
 * Verification is uniform: wrong password and unknown email are the same
 * `invalid` result (no user enumeration).
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

export type PasswordCredentialError = Error & { code: 'weak-password' | 'invalid-email' | 'email-taken' };

export interface PasswordRegisterInput {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
}

export type PasswordVerifyResult =
  | { readonly status: 'valid'; readonly user: User }
  | { readonly status: 'invalid' };

export interface PasswordCredentialService {
  register(input: PasswordRegisterInput): Promise<{ user: User; created: boolean }>;
  verify(input: { email: string; password: string }): Promise<PasswordVerifyResult>;
}

export class DefaultPasswordCredentialService implements PasswordCredentialService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly users: UserRepository,
    private readonly linkedIdentities: LinkedIdentityRepository,
  ) {}

  async register(input: PasswordRegisterInput): Promise<{ user: User; created: boolean }> {
    const email = normalizeEmail(input.email);
    if (!isEmail(email)) {
      throw passwordError('invalid-email', 'the email address is not valid');
    }
    if (!input.password || input.password.length < 8) {
      throw passwordError('weak-password', 'the password must be at least 8 characters');
    }

    // Fail closed: an account already carries this email (password OR provider).
    // No password is attached to an existing account without a verification flow.
    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw passwordError('email-taken', 'an account with this email already exists');
    }
    const existingIdentity = await this.linkedIdentities.findByProviderSubject('password', email);
    if (existingIdentity) {
      throw passwordError('email-taken', 'an account with this email already exists');
    }

    const user = await this.users.upsertByExternalId({
      // Deterministic external id for the password subject (AUTH-AC-01).
      externalId: `password:${email}`,
      displayName: input.displayName?.trim() || email,
      email,
    });
    const digest = await encodePassword(input.password);
    await this.db.query(
      `INSERT INTO wfos_password_credentials (user_id, password_digest, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET password_digest = EXCLUDED.password_digest, updated_at = NOW()`,
      [user.id, digest],
    );
    await this.linkedIdentities.link({
      userId: user.id,
      provider: 'password',
      subject: email,
      email,
      displayName: user.displayName,
      // The email is NOT provider-verified (no verification flow in this
      // runtime) — verified-provider identities will never auto-link here.
      emailVerified: false,
    });
    return { user, created: true };
  }

  async verify(input: { email: string; password: string }): Promise<PasswordVerifyResult> {
    const email = normalizeEmail(input.email);
    const identity = await this.linkedIdentities.findByProviderSubject('password', email);
    if (!identity) return { status: 'invalid' };
    const result = await this.db.query<{ password_digest: string }>(
      'SELECT password_digest FROM wfos_password_credentials WHERE user_id = $1',
      [identity.userId],
    );
    if (result.rows.length === 0) return { status: 'invalid' };
    const stored = result.rows[0]!.password_digest;
    const ok = await verifyPassword(input.password, stored);
    if (!ok) return { status: 'invalid' };
    const user = await this.users.findById(identity.userId);
    if (!user) return { status: 'invalid' };
    return { status: 'valid', user };
  }
}

export async function encodePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'hex');
  const expected = Buffer.from(parts[5]!, 'hex');
  const derived = await scrypt(password, salt, expected.length, { N, r, p });
  return timingSafeEqual(derived, expected);
}

function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function passwordError(code: PasswordCredentialError['code'], message: string): PasswordCredentialError {
  const err = new Error(message) as PasswordCredentialError;
  err.code = code;
  return err;
}
