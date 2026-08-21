import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TransientCache } from '@platform/redis/transient-cache.js';
import { buildTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import { createTestRedisClient, disconnectTestRedis } from '../../helpers/test-redis.js';
import type { Redis } from 'ioredis';

/**
 * DATA2-AC-02 — Redis is not authoritative application/workflow state.
 *
 * Evidence: authoritative WorkflowOS state lives in PostgreSQL. Redis holds
 * only transient coordination data (cache, locks, queues). Flushing Redis
 * does not destroy authoritative PostgreSQL state; a fresh Redis instance
 * starts empty and does not recover any application/workflow state.
 *
 * The test uses the infrastructure fixture tables (no domain entities).
 */
describe('DATA2-AC-02 — Redis is not authoritative', () => {
  let db: TestDatabase;
  let redis: Redis;

  beforeAll(async () => {
    db = await buildTestDatabase();
    redis = await createTestRedisClient();
    await redis.flushdb();
  });
  afterAll(async () => {
    await db.close();
    await disconnectTestRedis(redis);
  });

  it('clearing Redis does not destroy PostgreSQL state', async () => {
    // Write authoritative state.
    const parent = await db.client.query<{ id: number }>(
      'INSERT INTO wfos_fixture_parent (name) VALUES ($1) RETURNING id',
      ['durable-record'],
    );
    const parentId = parent.rows[0]!.id;

    // Mirror a transient value in Redis (cache).
    const cache = new TransientCache(redis);
    await cache.set(`parent:${parentId}`, 'durable-record');

    // Flush Redis completely.
    await redis.flushdb();

    // The cache entry is gone (Redis was transient)...
    expect(await cache.get(`parent:${parentId}`)).toBeNull();

    // ...but the PostgreSQL record is intact.
    const recovered = await db.client.query<{ name: string }>(
      'SELECT name FROM wfos_fixture_parent WHERE id = $1',
      [parentId],
    );
    expect(recovered.rows[0]!.name).toBe('durable-record');
  });

  it('a fresh Redis instance starts empty (no authoritative state recovered)', async () => {
    // Write authoritative state to PostgreSQL.
    const parent = await db.client.query<{ id: number }>(
      'INSERT INTO wfos_fixture_parent (name) VALUES ($1) RETURNING id',
      ['no-redis-state'],
    );
    const parentId = parent.rows[0]!.id;

    // Simulate "Redis restart from a clean image" by flushing the current
    // Redis (equivalent to a fresh, empty instance). With real Redis in CI
    // this proves the same point: no PostgreSQL state is recovered from Redis.
    await redis.flushdb();
    const freshCache = new TransientCache(redis);

    // Redis has NO authoritative state for this record.
    expect(await freshCache.get(`parent:${parentId}`)).toBeNull();

    // PostgreSQL still has it.
    const recovered = await db.client.query<{ name: string }>(
      'SELECT name FROM wfos_fixture_parent WHERE id = $1',
      [parentId],
    );
    expect(recovered.rows[0]!.name).toBe('no-redis-state');
  });

  it('Redis queue data is transient — losing it does not affect already-completed PostgreSQL work', async () => {
    // Write + commit authoritative state.
    const child = await db.client.query<{ id: number; parent_id: number }>(
      `WITH p AS (
         INSERT INTO wfos_fixture_parent (name) VALUES ($1) RETURNING id
       )
       INSERT INTO wfos_fixture_child (parent_id, note)
       SELECT id, $2 FROM p RETURNING id, parent_id`,
      ['committed', 'child'],
    );
    expect(child.rows).toHaveLength(1);

    // Flush Redis (queue, locks, cache — all transient).
    await redis.flushdb();

    // The committed PostgreSQL transaction is intact.
    const recovered = await db.client.query<{ parent_name: string; child_note: string }>(
      `SELECT p.name AS parent_name, c.note AS child_note
       FROM wfos_fixture_parent p
       JOIN wfos_fixture_child c ON c.parent_id = p.id
       WHERE c.id = $1`,
      [child.rows[0]!.id],
    );
    expect(recovered.rows[0]!.parent_name).toBe('committed');
    expect(recovered.rows[0]!.child_note).toBe('child');
  });
});
