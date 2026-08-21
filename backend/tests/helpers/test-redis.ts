import RedisMock from 'ioredis-mock';
import IORedis, { type Redis, type RedisOptions } from 'ioredis';

/**
 * Test Redis client factory.
 *
 * - When `WORKFLOWOS_REDIS_URL` (or `REDIS_URL`) is set (CI with a real redis
 *   service), returns a real `ioredis` client connected to that server.
 * - Otherwise (local dev), returns an `ioredis-mock` instance so tests run
 *   without a redis server.
 *
 * In both cases the tests exercise the actual `RedisQueue` / `TransientLock` /
 * `TransientCache` code paths — only the backing transport differs.
 *
 * Redis is NOT authoritative application/workflow state (architecture §29,
 * `DATA2-AC-02`).
 */
export async function createTestRedisClient(): Promise<Redis> {
  const url = process.env.WORKFLOWOS_REDIS_URL ?? process.env.REDIS_URL;
  if (url && url.startsWith('redis')) {
    return new IORedis(url);
  }
  // ioredis-mock satisfies the same ioredis interface.
  return new RedisMock() as unknown as Redis;
}

/** Disconnect the test Redis client (works for both real and mock). */
export function disconnectTestRedis(client: Redis): void {
  // ioredis-mock exposes `disconnect`; real ioredis exposes `quit`/`disconnect`.
  (client as unknown as { disconnect: () => void }).disconnect?.();
}

export type { Redis, RedisOptions };
