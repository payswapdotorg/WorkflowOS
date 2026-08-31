import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildIdentityStack, type TestIdentityStack } from '../../helpers/test-identity-stack.js';

/**
 * WORK-074 — human identity resolution (WORK-063 invariants #1, #2; the
 * proofs "human login end-to-end", "email login", "identity linking").
 *
 * Proven on real PostgreSQL through the identity test harness:
 *   - email/password: register → login → re-login resolves the SAME user;
 *   - password verification fails closed for wrong credentials;
 *   - password registration cannot claim an email that already belongs to an
 *     account (fail-closed against unverified-email takeover);
 *   - a verified OAuth assertion with an email matching a VERIFIED existing
 *     account LINKS to the same user (identity linking — one user, two
 *     provider identities);
 *   - a verified OAuth assertion matching an UNVERIFIED (password-created)
 *     account is REJECTED with a typed email-conflict (fail-closed — never
 *     an automatic takeover path);
 *   - re-login with the same provider subject is deterministic (AUTH-AC-01
 *     generalized to OIDC subjects);
 *   - machine principals are never resolved to human users (no wfos_users
 *     row is created for a machine external id).
 */
describe('WORK-074 — human identity: providers, deterministic resolution, identity linking', () => {
  let stack: TestIdentityStack;

  beforeAll(async () => {
    stack = await buildIdentityStack();
  });

  afterAll(async () => {
    await stack.teardown();
  });

  // --- email/password provider -------------------------------------------------

  it('email login: registration creates the user, login verifies, re-login resolves the SAME user', async () => {
    const registered = await stack.passwordCredentials.register({
      email: 'alice@example.com',
      password: 'correct-horse-battery',
      displayName: 'Alice',
    });
    expect(registered.created).toBe(true);

    const login = await stack.passwordCredentials.verify({
      email: 'alice@example.com',
      password: 'correct-horse-battery',
    });
    expect(login.status).toBe('valid');
    if (login.status === 'valid') {
      expect(login.user.id).toBe(registered.user.id);
      expect(login.user.email).toBe('alice@example.com');
    }

    // Deterministic re-login: the same subject resolves to the same user.
    const loginAgain = await stack.passwordCredentials.verify({
      email: 'alice@example.com',
      password: 'correct-horse-battery',
    });
    expect(loginAgain.status).toBe('valid');
    if (loginAgain.status === 'valid') {
      expect(loginAgain.user.id).toBe(registered.user.id);
    }
  });

  it('email login fails closed for a wrong password and for an unknown account', async () => {
    const wrong = await stack.passwordCredentials.verify({
      email: 'alice@example.com',
      password: 'definitely-wrong',
    });
    expect(wrong.status).toBe('invalid');

    const unknown = await stack.passwordCredentials.verify({
      email: 'nobody-here@example.com',
      password: 'whatever-password',
    });
    expect(unknown.status).toBe('invalid');
  });

  it('password registration rejects a weak password and a duplicate account (fail closed)', async () => {
    await expect(
      stack.passwordCredentials.register({ email: 'short@example.com', password: 'short' }),
    ).rejects.toMatchObject({ code: 'weak-password' });

    // Registering the SAME email again is a typed rejection (no second account).
    await expect(
      stack.passwordCredentials.register({ email: 'alice@example.com', password: 'another-password' }),
    ).rejects.toMatchObject({ code: 'email-taken' });
  });

  // --- deterministic provider-subject resolution (OIDC generalization) ---------

  it('the same provider subject always resolves to the same WorkflowOS user (deterministic)', async () => {
    const assertion = {
      provider: 'google',
      subject: 'google-sub-100',
      email: 'bob@gmail.com',
      emailVerified: true,
      displayName: 'Bob (Google)',
    };
    const first = await stack.identityResolution.resolve(assertion);
    expect(first.created).toBe(true);
    const second = await stack.identityResolution.resolve(assertion);
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.linked).toBe(false);
  });

  it('different subjects resolve to different users (no cross-subject conflation)', async () => {
    const a = await stack.identityResolution.resolve({
      provider: 'google',
      subject: 'google-sub-200',
      email: 'carol@gmail.com',
      emailVerified: true,
      displayName: 'Carol',
    });
    const b = await stack.identityResolution.resolve({
      provider: 'google',
      subject: 'google-sub-201',
      email: 'dave@gmail.com',
      emailVerified: true,
      displayName: 'Dave',
    });
    expect(a.user.id).not.toBe(b.user.id);
  });

  // --- identity linking ---------------------------------------------------------

  it('identity linking: a second verified provider identity with the same email links to the SAME user', async () => {
    const google = await stack.identityResolution.resolve({
      provider: 'google',
      subject: 'google-sub-300',
      email: 'erin@example.com',
      emailVerified: true,
      displayName: 'Erin (Google)',
    });
    const github = await stack.identityResolution.resolve({
      provider: 'github',
      subject: 'github-sub-300',
      email: 'erin@example.com',
      emailVerified: true,
      displayName: 'Erin (GitHub)',
    });
    expect(github.created).toBe(false);
    expect(github.linked).toBe(true);
    expect(github.user.id).toBe(google.user.id);

    // Re-login through EITHER provider resolves to the same single user.
    const googleAgain = await stack.identityResolution.resolve({
      provider: 'google',
      subject: 'google-sub-300',
      email: 'erin@example.com',
      emailVerified: true,
      displayName: 'Erin (Google)',
    });
    const githubAgain = await stack.identityResolution.resolve({
      provider: 'github',
      subject: 'github-sub-300',
      email: 'erin@example.com',
      emailVerified: true,
      displayName: 'Erin (GitHub)',
    });
    expect(googleAgain.user.id).toBe(google.user.id);
    expect(githubAgain.user.id).toBe(google.user.id);

    // Exactly ONE user exists for this human.
    const byGoogle = await stack.userRepository.findByExternalId('google:google-sub-300');
    const byGithub = await stack.userRepository.findByExternalId('github:github-sub-300');
    expect(byGoogle).not.toBeNull();
    expect(byGithub).toBeNull();
  });

  it('a verified provider identity NEVER auto-links to an unverified (password-created) account (typed email-conflict)', async () => {
    // A password account exists with an unverified email claim.
    await stack.passwordCredentials.register({
      email: 'frank@example.com',
      password: 'a-long-password',
      displayName: 'Frank (password)',
    });
    // An OAuth assertion arrives claiming the same (provider-)verified email.
    // Linking would hand the OAuth identity a session on the password
    // account — the takeover path. It must FAIL CLOSED with a typed conflict.
    await expect(
      stack.identityResolution.resolve({
        provider: 'google',
        subject: 'google-sub-400',
        email: 'frank@example.com',
        emailVerified: true,
        displayName: 'Frank (Google)',
      }),
    ).rejects.toMatchObject({ code: 'email-conflict' });
  });

  it('an unverified provider assertion does not link by email (a new account is created instead)', async () => {
    // An existing verified account owns erin@example.com.
    const erin = await stack.userRepository.findByExternalId('google:google-sub-300');
    expect(erin).not.toBeNull();
    // An assertion WITHOUT a verified email must not touch that account.
    const unverified = await stack.identityResolution.resolve({
      provider: 'github',
      subject: 'github-sub-500',
      email: 'erin@example.com',
      emailVerified: false,
      displayName: 'Some Erin Claim',
    });
    expect(unverified.created).toBe(true);
    expect(unverified.user.id).not.toBe(erin!.id);
    expect(unverified.linked).toBe(false);
  });

  // --- human/machine separation at the identity layer ----------------------------

  it('a machine principal external id never resolves to a human user row', async () => {
    // The machine namespace is distinct from the human external_id namespace;
    // resolving a service-account external id creates NO wfos_users row.
    const before = await stack.userRepository.findByExternalId('service-account:nonexistent');
    expect(before).toBeNull();
    // And the identity resolution service rejects machine-namespaced subjects.
    await expect(
      stack.identityResolution.resolve({
        provider: 'apikey',
        subject: 'service-account:nonexistent',
        email: null,
        emailVerified: false,
        displayName: 'A Machine',
      }),
    ).rejects.toMatchObject({ code: 'machine-subject-forbidden' });
  });
});
