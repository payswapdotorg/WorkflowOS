import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';

/**
 * AUTH-AC-01 — Valid authentication resolves one WorkflowOS identity.
 * AUTH-AC-02 — Invalid authentication is rejected.
 *
 * Evidence: the same authenticated principal resolves deterministically to the
 * same persisted WorkflowOS user identity across multiple authentications.
 * Invalid credentials are rejected.
 */
describe('AUTH-AC-01 / AUTH-AC-02 — authentication', () => {
  let stack: TestAuthStack;
  const RAW_KEY = 'wfos_test_api_key_secret_value_123';
  const ENV_VAR = 'WFOS_TEST_API_KEY_AUTH_AC';
  const EXTERNAL_ID = 'auth-ac-user@example.com';
  const LABEL = 'Auth AC Test User';

  beforeAll(async () => {
    stack = await buildAuthStack({ [ENV_VAR]: RAW_KEY });
    // Provision a credential. The raw key is placed in the env-backed
    // SecretStore (NOT in the domain record — only the opaque ref + digest
    // are persisted).
    await stack.apiKeyProvisioner.provision({
      keyId: 'auth-ac-key-1',
      secretRef: ENV_VAR,
      externalId: EXTERNAL_ID,
      label: LABEL,
      rawKey: RAW_KEY,
    });
  });
  afterAll(async () => {
    await stack.teardown();
  });

  it('AUTH-AC-02: missing credentials are rejected', async () => {
    const result = await stack.authProvider.authenticate('');
    expect(result.kind).toBe('unauthenticated');
    if (result.kind === 'unauthenticated') {
      expect(result.reason).toBe('missing-credentials');
    }
  });

  it('AUTH-AC-02: invalid credentials are rejected', async () => {
    const result = await stack.authProvider.authenticate('not-a-real-key');
    expect(result.kind).toBe('unauthenticated');
    if (result.kind === 'unauthenticated') {
      expect(result.reason).toBe('invalid-credentials');
    }
  });

  it('AUTH-AC-01: valid credentials resolve to an authenticated principal', async () => {
    const result = await stack.authProvider.authenticate(RAW_KEY);
    expect(result.kind).toBe('principal');
    if (result.kind === 'principal') {
      expect(result.principal.externalId).toBe(EXTERNAL_ID);
      expect(result.principal.label).toBe(LABEL);
      expect(result.principal.provider).toBe('apikey');
    }
  });

  it('AUTH-AC-01: the same principal resolves deterministically to the same persisted user', async () => {
    const result = await stack.authProvider.authenticate(RAW_KEY);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    const user1 = await stack.userRepository.upsertByExternalId({
      externalId: result.principal.externalId,
      displayName: result.principal.label,
    });
    const user2 = await stack.userRepository.upsertByExternalId({
      externalId: result.principal.externalId,
      displayName: result.principal.label,
    });
    expect(user2.id).toBe(user1.id);
    expect(user2.externalId).toBe(EXTERNAL_ID);
  });

  it('AUTH-AC-01: authentication persists the WorkflowOS user identity', async () => {
    const result = await stack.authProvider.authenticate(RAW_KEY);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    const user = await stack.userRepository.findByExternalId(result.principal.externalId);
    expect(user).not.toBeNull();
    expect(user!.externalId).toBe(EXTERNAL_ID);
  });

  it('AUTH-AC-02: a key with the wrong raw value (digest match but secret mismatch) is rejected', async () => {
    // Provision a second credential pointing at a different env var whose
    // value does NOT match the digest — simulates a tampered/rotated secret.
    await stack.apiKeyProvisioner.provision({
      keyId: 'auth-ac-key-tampered',
      secretRef: 'WFOS_TEST_NONEXISTENT_SECRET',
      externalId: 'tampered@example.com',
      label: 'Tampered',
      rawKey: 'another-raw-key',
    });
    // The digest matches 'another-raw-key' but the env var is unset → secret
    // store returns null → mismatch → rejected.
    const result = await stack.authProvider.authenticate('another-raw-key');
    expect(result.kind).toBe('unauthenticated');
  });
});
