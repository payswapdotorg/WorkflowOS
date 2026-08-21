import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import {
  ArtifactMetadataRepository,
  type ObjectStore,
  InMemoryObjectStore,
} from '@platform/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * DATA3-AC-02 — Large bodies are not required in core relational records.
 *
 * Evidence (schema + static):
 *
 * 1. The `wfos_artifact_metadata` table has NO column for the artifact body.
 *    Instead it holds a `storage_key` reference plus provenance fields
 *    (content_length, content_type, digest_sha256, metadata). The body lives
 *    in object storage.
 *
 * 2. The migration SQL (`0001_init.sql`) statically demonstrates the contract:
 *    the artifact table has `storage_key` but no `body`/`content`/`data`
 *    column.
 *
 * 3. A round-trip proves the relational record + object store together recover
 *    the full artifact: the metadata row holds the storage key, the object
 *    store returns the body. The core relational record never holds the body.
 */
describe('DATA3-AC-02 — large bodies use the artifact boundary', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await buildTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  it('the artifact_metadata table has a storage_key column but no body column', async () => {
    const columns = await db.client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'wfos_artifact_metadata'
       ORDER BY ordinal_position`,
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toContain('storage_key');
    expect(names).toContain('content_length');
    expect(names).toContain('digest_sha256');

    // The artifact_metadata table MUST NOT embed the artifact body. Reject any
    // column whose name suggests large content storage.
    const forbiddenBodyColumns = names.filter((n) =>
      /^(body|content|data|blob|payload|raw|text)$/.test(n),
    );
    expect(
      forbiddenBodyColumns,
      `artifact_metadata must not embed bodies; found: ${forbiddenBodyColumns.join(', ')}`,
    ).toEqual([]);

    // content_length is a numeric (BIGINT), not a TEXT/BYTEA holding the body.
    const lengthType = columns.rows.find((r) => r.column_name === 'content_length');
    expect(lengthType?.data_type).toBe('bigint');
  });

  it('the fixture parent/child tables do not embed large bodies either', async () => {
    for (const table of ['wfos_fixture_parent', 'wfos_fixture_child']) {
      const columns = await db.client.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_name = $1
         ORDER BY ordinal_position`,
        [table],
      );
      const names = columns.rows.map((r) => r.column_name);
      const forbidden = names.filter((n) =>
        /^(body|content|data|blob|payload|raw)$/.test(n),
      );
      expect(forbidden, `${table} must not embed bodies`).toEqual([]);
    }
  });

  it('the migration SQL statically declares storage_key without a body column', () => {
    const migrationPath = fileURLToPath(
      new URL(
        '../../../src/platform/postgres/migrations/0001_init.sql',
        import.meta.url,
      ),
    );
    const sql = readFileSync(migrationPath, 'utf8');

    // The artifact metadata table is defined with storage_key...
    expect(sql).toMatch(/CREATE\s+TABLE\s+wfos_artifact_metadata[\s\S]*storage_key\s+TEXT\s+NOT\s+NULL/i);

    // ...and has no body/content/data column.
    const tableBlock = sql.match(
      /CREATE\s+TABLE\s+wfos_artifact_metadata\s*\(([\s\S]*?)\);/i,
    )?.[1] ?? '';
    expect(tableBlock, 'expected wfos_artifact_metadata CREATE TABLE block').toBeTruthy();
    expect(tableBlock).not.toMatch(/^\s*body\s+/im);
    expect(tableBlock).not.toMatch(/^\s*content\s+/im);
    expect(tableBlock).not.toMatch(/^\s*data\s+/im);
    expect(tableBlock).not.toMatch(/^\s*blob\s+/im);
  });

  it('a large artifact is represented in PostgreSQL only by its reference + provenance', async () => {
    const store: ObjectStore = new InMemoryObjectStore();
    const repo = new ArtifactMetadataRepository(db.client);

    // A "large" artifact: 64 KiB of pseudo-random bytes (we use a deterministic pattern).
    const body = Buffer.alloc(64 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i & 0xff;

    const stored = await store.put({ body, contentType: 'application/octet-stream' });
    const meta = await repo.create({
      storageKey: stored.key,
      storageProvider: store.provider,
      contentLength: stored.contentLength,
      contentType: stored.digestSha256 ? 'application/octet-stream' : undefined,
      digestSha256: stored.digestSha256,
      metadata: { description: '64KiB fixture artifact' },
    });

    // The PostgreSQL row is small: it contains the storage_key + provenance,
    // NOT the 64KiB body.
    const fetched = await repo.findById(meta.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.contentLength).toBe(64 * 1024);
    expect(fetched!.digestSha256).toHaveLength(64); // sha256 hex = 64 chars

    // The 64KiB body is recovered from object storage, not PostgreSQL.
    const object = await store.get(fetched!.storageKey);
    expect(object).not.toBeNull();
    expect(object!.body.length).toBe(64 * 1024);
    expect(object!.body).toEqual(body);
  });
});
