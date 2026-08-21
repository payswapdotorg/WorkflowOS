import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestDatabase, type TestDatabase } from '../../helpers/test-database.js';

/**
 * DATA-AC-03 — PostgreSQL is authoritative; state is recoverable without Redis.
 *
 * Evidence: authoritative WorkflowOS state is written to PostgreSQL through
 * the shared {@link DatabaseClient}, then read back after Redis is "lost"
 * (cleared/disconnected). The persisted state survives because PostgreSQL —
 * not Redis — is the system of record (architecture §28, §29, `DATA2-AC-02`).
 *
 * The test uses the infrastructure fixture tables so no domain entities are
 * introduced. Redis (real in CI, ioredis-mock locally) is flushed mid-test to
 * prove Redis holds only transient coordination data.
 */
import { TransientCache } from '@platform/redis/transient-cache.js';
import { createTestRedisClient, disconnectTestRedis } from '../../helpers/test-redis.js';
import type { Redis } from 'ioredis';

describe('DATA-AC-03 — PostgreSQL remains authoritative without Redis', () => {
  let db: TestDatabase;
  let redis: Redis;
  let cache: TransientCache;

  beforeAll(async () => {
    db = await buildTestDatabase();
    redis = await createTestRedisClient();
    await redis.flushall();
    cache = new TransientCache(redis);
  });
  afterAll(async () => {
    await db.close();
    disconnectTestRedis(redis);
  });

  it('authoritative state written to PostgreSQL survives Redis loss', async () => {
    // 1. Write authoritative state to PostgreSQL.
    const parent = await db.client.query<{ id: number }>(
      'INSERT INTO wfos_fixture_parent (name) VALUES ($1) RETURNING id',
      ['authoritative-record'],
    );
    const parentId = parent.rows[0]!.id;

    // 2. Use Redis for transient coordination data (a cache entry mirroring the
    //    authoritative id). Redis is NOT the source of truth.
    await cache.set(`parent:${parentId}:cached_name`, 'authoritative-record', {
      ttlMs: 60_000,
    });
    expect(await cache.get(`parent:${parentId}:cached_name`)).toBe(
      'authoritative-record',
    );

    // 3. Simulate Redis loss: flush all keys.
    await redis.flushall();

    // 4. The cached value is gone (Redis was transient) ...
    expect(await cache.get(`parent:${parentId}:cached_name`)).toBeNull();

    // 5. ... but the authoritative PostgreSQL record survives and is recoverable.
    const recovered = await db.client.query<{ name: string }>(
      'SELECT name FROM wfos_fixture_parent WHERE id = $1',
      [parentId],
    );
    expect(recovered.rows).toHaveLength(1);
    expect(recovered.rows[0]!.name).toBe('authoritative-record');
  });

  it('a fresh Redis client does not restore authoritative state from Redis', async () => {
    // Write authoritative state.
    const parent = await db.client.query<{ id: number }>(
      'INSERT INTO wfos_fixture_parent (name) VALUES ($1) RETURNING id',
      ['redis-independent'],
    );
    const parentId = parent.rows[0]!.id;

    // Simulate "Redis restart from a clean image" by flushing the current
    // Redis. No state was written to Redis for this row, so after the flush
    // Redis has nothing for it — exactly the point.
    await redis.flushall();
    const freshCache = new TransientCache(redis);
    expect(await freshCache.get(`parent:${parentId}:cached_name`)).toBeNull();

    // The authoritative record is still recoverable from PostgreSQL.
    const recovered = await db.client.query<{ name: string }>(
      'SELECT name FROM wfos_fixture_parent WHERE id = $1',
      [parentId],
    );
    expect(recovered.rows[0]!.name).toBe('redis-independent');
  });

  it('transactions roll back atomically without affecting Redis', async () => {
    // Begin a transaction, insert, then throw to trigger rollback.
    await expect(
      db.client.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO wfos_fixture_parent (name) VALUES ($1)',
          ['will-roll-back'],
        );
        throw new Error('intentional rollback');
      }),
    ).rejects.toThrow('intentional rollback');

    // The rolled-back row is NOT present in PostgreSQL.
    const present = await db.client.query<{ name: string }>(
      'SELECT name FROM wfos_fixture_parent WHERE name = $1',
      ['will-roll-back'],
    );
    expect(present.rows).toHaveLength(0);

    // And flushing Redis (again simulating loss) does not bring it back.
    await redis.flushall();
    const present2 = await db.client.query<{ name: string }>(
      'SELECT name FROM wfos_fixture_parent WHERE name = $1',
      ['will-roll-back'],
    );
    expect(present2.rows).toHaveLength(0);
  });
});
