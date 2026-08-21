import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  InMemoryObjectStore,
  FsObjectStore,
  createTempFsObjectStore,
  ArtifactMetadataRepository,
  type ObjectStore,
  type PutObjectResult,
} from '@platform/index.js';
import { buildTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * DATA3-AC-01 — Large/immutable artifacts can be stored through object
 * storage with durable PostgreSQL references.
 *
 * Evidence: an artifact body is stored via the provider-independent
 * {@link ObjectStore}; the returned `storage_key` is persisted as a durable
 * `wfos_artifact_metadata` row via {@link ArtifactMetadataRepository}; the row
 * is then read back from PostgreSQL and the storage key is used to retrieve
 * the original object body.
 *
 * ```text
 * artifact
 *    ↓
 * object storage
 *    ↓
 * object reference (storage_key)
 *    ↓
 * PostgreSQL metadata (durable)
 * ```
 *
 * The PostgreSQL record is sufficient to locate the stored object.
 *
 * Both {@link InMemoryObjectStore} and {@link FsObjectStore} are exercised to
 * prove the abstraction is provider-independent.
 */
describe.each([
  ['InMemoryObjectStore', () => new InMemoryObjectStore()],
  ['FsObjectStore', () => createTempFsObjectStore()],
])('DATA3-AC-01 — object storage with durable references (%s)', (_name, makeStore) => {
  let db: TestDatabase;
  let store: ObjectStore;
  let repo: ArtifactMetadataRepository;

  beforeAll(async () => {
    db = await buildTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    store = makeStore();
    repo = new ArtifactMetadataRepository(db.client);
  });

  it('stores an artifact and persists a durable PostgreSQL reference that can retrieve it', async () => {
    // 1. Store the artifact body in object storage.
    const body = Buffer.from('a large immutable artifact body', 'utf8');
    const stored: PutObjectResult = await store.put({
      body,
      contentType: 'text/plain',
      metadata: { origin: 'integration-test' },
    });
    expect(stored.key).toBeTruthy();
    expect(stored.contentLength).toBe(body.length);
    expect(stored.digestSha256).toMatch(/^[0-9a-f]{64}$/);

    // 2. Persist a durable PostgreSQL metadata reference.
    const meta = await repo.create({
      storageKey: stored.key,
      storageProvider: store.provider,
      contentLength: stored.contentLength,
      contentType: 'text/plain',
      digestSha256: stored.digestSha256,
      metadata: { origin: 'integration-test' },
    });
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/);

    // 3. Read the metadata back from PostgreSQL (simulating a later lookup).
    const fetched = await repo.findById(meta.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.storageKey).toBe(stored.key);
    expect(fetched!.storageProvider).toBe(store.provider);
    expect(fetched!.contentLength).toBe(body.length);
    expect(fetched!.digestSha256).toBe(stored.digestSha256);

    // 4. Use the stored reference to retrieve the original artifact body.
    const object = await store.get(fetched!.storageKey);
    expect(object).not.toBeNull();
    expect(object!.body.toString('utf8')).toBe('a large immutable artifact body');
    expect(object!.contentType).toBe('text/plain');
  });

  it('returns null for a non-existent storage key', async () => {
    const missing = await store.get('does-not-exist-uuid');
    expect(missing).toBeNull();
  });

  it('delete is idempotent and removes the object', async () => {
    const stored = await store.put({ body: Buffer.from('temp') });
    await store.delete(stored.key);
    expect(await store.get(stored.key)).toBeNull();
    // Deleting again is a no-op.
    await expect(store.delete(stored.key)).resolves.toBeUndefined();
  });

  it('preserves binary content byte-for-byte', async () => {
    // 256 bytes spanning the full byte range.
    const body = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) body[i] = i;
    const stored = await store.put({ body, contentType: 'application/octet-stream' });
    await repo.create({
      storageKey: stored.key,
      storageProvider: store.provider,
      contentLength: stored.contentLength,
      digestSha256: stored.digestSha256,
      contentType: 'application/octet-stream',
    });
    const fetched = await repo.findById(
      (await repo.create({
        storageKey: stored.key,
        storageProvider: store.provider,
        contentLength: stored.contentLength,
      })).id,
    );
    const object = await store.get(fetched!.storageKey);
    expect(object!.body).toEqual(body);
  });
});

describe('FsObjectStore — filesystem-specific behavior', () => {
  let db: TestDatabase;
  let store: FsObjectStore;

  beforeAll(async () => {
    db = await buildTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    store = createTempFsObjectStore();
  });

  it('writes the object body to a real file on disk', async () => {
    const stored = await store.put({ body: Buffer.from('on-disk') });
    // Read the raw file from the store's root dir to prove it landed on disk.
    const path = join((store as unknown as { rootDir: string }).rootDir, stored.key);
    const onDisk = await readFile(path);
    expect(onDisk.toString('utf8')).toBe('on-disk');
  });

  it('survives a new FsObjectStore instance pointing at the same root dir', async () => {
    const root = (store as unknown as { rootDir: string }).rootDir;
    const stored = await store.put({ body: Buffer.from('persistent') });
    // Create a second store pointing at the same directory.
    const store2 = new FsObjectStore(root);
    const object = await store2.get(stored.key);
    expect(object!.body.toString('utf8')).toBe('persistent');
  });
});
