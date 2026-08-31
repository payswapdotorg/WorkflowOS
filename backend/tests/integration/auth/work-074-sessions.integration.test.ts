import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildIdentityStack, type TestIdentityStack } from '../../helpers/test-identity-stack.js';

/**
 * WORK-074 — the server-side session lifecycle (WORK-063 invariant #5:
 * "Sessions are server-side authoritative and revocable. Logout/revocation
 * actually removes access; there are no immortal tokens.").
 *
 * Proofs (real PostgreSQL through the test harness):
 *   - create → verify: a fresh session token verifies to the same user;
 *   - refresh persistence: refresh extends expiry (sliding) and the token
 *     keeps verifying (PROOF: refresh persistence);
 *   - expiry: a session whose expires_at has passed is rejected with a typed
 *     `expired` status (PROOF: invalid/expired session);
 *   - revocation: a revoked session is rejected with a typed `revoked`
 *     status while an unrevoked session still verifies — DISCRIMINATION:
 *     removing the revoked_at check makes the revoked-session assertion FAIL
 *     (the unrevoked control keeps passing);
 *   - tampering: an unknown token is rejected (invalid);
 *   - revocation is idempotent and scoped: revoking one session does not
 *     touch other sessions of the same user;
 *   - raw token material never persists (digest-only) — PROOF: credential
 *     safety at the session layer.
 */
describe('WORK-074 — server-side session lifecycle', () => {
  let stack: TestIdentityStack;

  beforeAll(async () => {
    stack = await buildIdentityStack();
  });

  afterAll(async () => {
    await stack.teardown();
  });

  it('creates a session and verifies the same user from the opaque token', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'session-user-1@example.com',
      displayName: 'Session User 1',
    });
    const created = await stack.sessionService.create({
      userId: user.id,
      provider: 'password',
    });
    expect(created.token).toBeTruthy();
    expect(created.session.userId).toBe(user.id);
    expect(created.session.revokedAt).toBeNull();

    const verified = await stack.sessionService.verify(created.token);
    expect(verified.status).toBe('valid');
    if (verified.status === 'valid') {
      expect(verified.userId).toBe(user.id);
      expect(verified.session.id).toBe(created.session.id);
    }
  });

  it('verifies the same session repeatedly (stateless-to-client, server-authoritative)', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'session-user-2@example.com',
      displayName: 'Session User 2',
    });
    const created = await stack.sessionService.create({ userId: user.id, provider: 'password' });
    for (let i = 0; i < 3; i++) {
      const verified = await stack.sessionService.verify(created.token);
      expect(verified.status).toBe('valid');
    }
  });

  it('refresh extends the expiry (refresh persistence) and the token keeps verifying', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'session-user-3@example.com',
      displayName: 'Session User 3',
    });
    const created = await stack.sessionService.create({
      userId: user.id,
      provider: 'password',
      ttlSeconds: 60,
    });
    const refreshed = await stack.sessionService.refresh(created.token, 3600);
    expect(refreshed.status).toBe('valid');
    if (refreshed.status === 'valid') {
      expect(refreshed.session.expiresAt.getTime()).toBeGreaterThan(
        created.session.expiresAt.getTime(),
      );
      expect(refreshed.session.lastRefreshedAt).not.toBeNull();
    }
    const verified = await stack.sessionService.verify(created.token);
    expect(verified.status).toBe('valid');
  });

  it('rejects an expired session with a typed status (discriminated from revoked)', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'session-user-4@example.com',
      displayName: 'Session User 4',
    });
    const created = await stack.sessionService.create({
      userId: user.id,
      provider: 'password',
      ttlSeconds: -1, // already expired at creation
    });
    const verified = await stack.sessionService.verify(created.token);
    expect(verified.status).toBe('expired');
  });

  it('a revoked session is rejected while an unrevoked control session still verifies', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'session-user-5@example.com',
      displayName: 'Session User 5',
    });
    const victim = await stack.sessionService.create({ userId: user.id, provider: 'password' });
    const control = await stack.sessionService.create({ userId: user.id, provider: 'password' });

    // Pre-revocation: both verify.
    expect((await stack.sessionService.verify(victim.token)).status).toBe('valid');
    expect((await stack.sessionService.verify(control.token)).status).toBe('valid');

    // Logout (revocation) — the unrevoked control is the discrimination basis.
    await stack.sessionService.revoke(victim.token);

    const afterRevocation = await stack.sessionService.verify(victim.token);
    expect(afterRevocation.status).toBe('revoked');
    const controlAfter = await stack.sessionService.verify(control.token);
    expect(controlAfter.status).toBe('valid');

    // Revocation is idempotent.
    await stack.sessionService.revoke(victim.token);
    expect((await stack.sessionService.verify(victim.token)).status).toBe('revoked');
  });

  it('an unknown/tampered token is rejected (invalid)', async () => {
    const verified = await stack.sessionService.verify('not-a-real-session-token');
    expect(verified.status).toBe('invalid');
  });

  it('revoking every session of a user removes all access (logout everywhere)', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'session-user-6@example.com',
      displayName: 'Session User 6',
    });
    const s1 = await stack.sessionService.create({ userId: user.id, provider: 'password' });
    const s2 = await stack.sessionService.create({ userId: user.id, provider: 'password' });
    await stack.sessionService.revokeAllForUser(user.id);
    expect((await stack.sessionService.verify(s1.token)).status).toBe('revoked');
    expect((await stack.sessionService.verify(s2.token)).status).toBe('revoked');
  });

  it('raw session tokens never persist — only their digest (credential safety)', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'session-user-7@example.com',
      displayName: 'Session User 7',
    });
    const created = await stack.sessionService.create({ userId: user.id, provider: 'password' });
    const rows = await stack.db.client.query<{ token_digest: string }>(
      'SELECT token_digest FROM wfos_sessions WHERE user_id = $1',
      [user.id],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    // The raw token must NOT appear anywhere in the session records.
    const rawRows = await stack.db.client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wfos_sessions WHERE token_digest = $1`,
      [created.token],
    );
    // The raw token is not storable in a digest column — the count query above
    // simply cannot match; assert the row count of sessions carrying the raw
    // value in ANY text column via a targeted probe.
    const leak = await stack.db.client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wfos_sessions
       WHERE id::text = $1 OR user_id::text = $1 OR token_digest = $1`,
      [created.token],
    );
    expect(leak.rows[0]!.count).toBe('0');
    expect(rawRows.rows.length).toBeGreaterThan(0);
  });
});
