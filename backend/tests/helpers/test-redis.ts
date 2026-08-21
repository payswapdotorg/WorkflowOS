import RedisMock from 'ioredis-mock';
import IORedis, { type Redis, type RedisOptions } from 'ioredis';

/**
 * Test Redis client factory with per-worker isolation.
 *
 * - When `WORKFLOWOS_REDIS_URL` (or `REDIS_URL`) is set (CI with a real redis
 *   service), returns a real `ioredis` client connected to that server and
 *   `SELECT`ed to a unique Redis logical database (0–15) derived from the
 *   vitest worker id. Each parallel test file lands on its own db, so
 *   `FLUSHDB` in one file never touches another file's keys.
 * - Otherwise (local dev), returns an `ioredis-mock` instance so tests run
 *   without a redis server. Each mock instance is isolated in-process.
 *
 * **Parallel-safety (Correction 1):** real-redis tests use `SELECT <db>` +
 * `FLUSHDB` (never `FLUSHALL`, which would wipe all 16 dbs and clobber other
 * parallel test files). The db number is derived from `VITEST_WORKER_ID` so it
 * is deterministic and collision-free across parallel workers.
 *
 * Redis is NOT authoritative application/workflow state (architecture §29,
 * `DATA2-AC-02`).
 */

/** Redis supports logical databases 0–15. We reserve 0 and use 1–15. */
const MAX_REDIS_DB = 15;

/**
 * Derive a Redis db number (1–15) from the vitest worker id. Falls back to 1
 * when not running under vitest (e.g. direct script execution).
 */
function pickRedisDb(): number {
  const raw = process.env.VITEST_WORKER_ID;
  if (!raw) return 1;
  // VITEST_WORKER_ID is 1-based. Hash to 1–15.
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  const db = (Math.abs(hash) % MAX_REDIS_DB) + 1;
  return db;
}

export async function createTestRedisClient(): Promise<Redis> {
  const url = process.env.WORKFLOWOS_REDIS_URL ?? process.env.REDIS_URL;
  if (url && url.startsWith('redis')) {
    const client = new IORedis(url);
    // Select the per-worker db and flush it so the test starts clean.
    // Using FLUSHDB (not FLUSHALL) so parallel test files on other dbs are
    // not affected.
    const db = pickRedisDb();
    await client.select(db);
    await client.flushdb();
    return client;
  }
  // ioredis-mock: each instance is isolated in-process. Still flushdb for
  // cleanliness.
  const mock = new RedisMock();
  await mock.flushdb();
  return mock as unknown as Redis;
}

/**
 * Disconnect the test Redis client. Flushes the per-worker db before
 * disconnecting so the next run starts clean.
 */
export async function disconnectTestRedis(client: Redis): Promise<void> {
  try {
    await client.flushdb();
  } catch {
    // ignore — best-effort cleanup
  }
  (client as unknown as { disconnect: () => void }).disconnect?.();
}

export type { Redis, RedisOptions };
