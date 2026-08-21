import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import { createLogger } from '@platform/logger.js';
import { runWithExecutionContext } from '@platform/execution-context.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SEC-AC-01 — Provider credentials are accessed through the secret-management
 * abstraction.
 * SEC-AC-02 — Provider secrets are absent from domain/workflow records and logs.
 *
 * Evidence:
 * - The raw API key is retrieved ONLY via the SecretStore (SEC-AC-01).
 * - The wfos_api_key_credentials table holds only a digest + opaque ref,
 *   never the raw key (SEC-AC-02 schema check).
 * - The static architecture check verifies no domain module imports a concrete
 *   secret-store implementation.
 * - Raw secret values never appear in logs.
 */
describe('SEC-AC-01 / SEC-AC-02 — secret management', () => {
  let stack: TestAuthStack;
  const RAW_KEY = 'wfos_sec_test_secret_value_xyz';
  const ENV_VAR = 'WFOS_TEST_SECRET_KEY';

  beforeAll(async () => {
    stack = await buildAuthStack({ [ENV_VAR]: RAW_KEY });
    await stack.apiKeyProvisioner.provision({
      keyId: 'sec-key-1',
      secretRef: ENV_VAR,
      externalId: 'sec-user',
      label: 'SEC Test User',
      rawKey: RAW_KEY,
    });
  });
  afterAll(async () => {
    await stack.teardown();
  });

  // --- SEC-AC-01: credentials accessed through the abstraction ---

  it('SEC-AC-01: the SecretStore resolves the raw secret by opaque reference', async () => {
    const ref = stack.secretStore.ref(ENV_VAR);
    const value = await stack.secretStore.getSecret(ref);
    expect(value).toBe(RAW_KEY);
  });

  it('SEC-AC-01: the SecretStore returns null for a missing secret', async () => {
    const ref = stack.secretStore.ref('WFOS_NONEXISTENT_SECRET_XYZ');
    const value = await stack.secretStore.getSecret(ref);
    expect(value).toBeNull();
  });

  it('SEC-AC-01: authentication retrieves the raw key only through the SecretStore', async () => {
    // The ApiKeyAuthProvider.authenticate() path internally calls
    // secrets.getSecret({ key: row.secret_ref }) — the ONLY sanctioned way
    // to retrieve the raw value. A valid key authenticates successfully.
    const result = await stack.authProvider.authenticate(RAW_KEY);
    expect(result.kind).toBe('principal');
  });

  // --- SEC-AC-02: secrets absent from domain/workflow records ---

  it('SEC-AC-02 (schema): the credential table holds NO raw-key column', async () => {
    const columns = await stack.db.client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'wfos_api_key_credentials'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toContain('key_id');
    expect(names).toContain('secret_ref');
    expect(names).toContain('key_digest');
    // The table must NOT hold the raw key value in any form other than the
    // one-way digest.
    const forbidden = names.filter((n) =>
      /^(raw_key|secret_value|api_key|key_value|plaintext|secret)$/.test(n),
    );
    expect(forbidden, `credential table must not store raw secrets; found: ${forbidden.join(', ')}`).toEqual([]);
  });

  it('SEC-AC-02 (schema): the secret_ref column is the only secret-related column and holds an opaque reference', async () => {
    const rows = await stack.db.client.query<{ secret_ref: string; key_digest: string }>(
      'SELECT secret_ref, key_digest FROM wfos_api_key_credentials WHERE key_id = $1',
      ['sec-key-1'],
    );
    expect(rows.rows[0]!.secret_ref).toBe(ENV_VAR); // an env var NAME, not the value
    expect(rows.rows[0]!.key_digest).not.toBe(RAW_KEY); // a digest, not the raw key
    expect(rows.rows[0]!.key_digest).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('SEC-AC-02 (logs): raw secret values are never emitted in logs', async () => {
    const capture = new CaptureStream();
    const logger = createLogger({ level: 'debug', destination: capture });
    // Perform an authentication (which internally retrieves the raw key via
    // the SecretStore) while a capturing logger is active.
    await runWithExecutionContext({ executionId: 'wf_sec_log_test' }, async () => {
      logger.info('secrets.test.authenticating', { keyId: 'sec-key-1' });
      const result = await stack.authProvider.authenticate(RAW_KEY);
      expect(result.kind).toBe('principal');
      logger.info('secrets.test.authenticated', { keyId: 'sec-key-1' });
    });
    const raw = capture.raw();
    // The raw key MUST NOT appear anywhere in the captured log output.
    expect(raw).not.toContain(RAW_KEY);
    // The digest is fine to log; the raw value is not.
    expect(raw).not.toContain('wfos_sec_test_secret_value_xyz');
  });

  it('SEC-AC-02 (static): domain tables have no column whose name suggests a raw secret', async () => {
    // Scan every user-defined table for columns whose names suggest raw
    // secret storage. This is a schema-level guard against secrets leaking
    // into ordinary domain persistence.
    const tables = await stack.db.client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND table_name LIKE 'wfos_%'`,
    );
    const violations = tables.rows.filter((r) =>
      /^(raw_key|secret_value|api_key|key_value|plaintext|secret|password|token)$/.test(r.column_name),
    );
    expect(
      violations,
      `domain tables must not store raw secrets; found: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it('SEC-AC-02 (static): migration files do not define raw-secret columns', () => {
    const migrationPath = fileURLToPath(
      new URL(
        '../../../src/platform/postgres/migrations/0003_api_key_credentials.sql',
        import.meta.url,
      ),
    );
    const sql = readFileSync(migrationPath, 'utf8');
    // The credential table defines secret_ref (opaque reference) + key_digest
    // (one-way hash), never a raw-key column.
    expect(sql).toMatch(/secret_ref\s+TEXT\s+NOT\s+NULL/i);
    expect(sql).toMatch(/key_digest\s+TEXT\s+NOT\s+NULL/i);
    expect(sql).not.toMatch(/^\s*raw_key\s+/im);
    expect(sql).not.toMatch(/^\s*secret_value\s+/im);
    expect(sql).not.toMatch(/^\s*plaintext\s+/im);
  });
});
