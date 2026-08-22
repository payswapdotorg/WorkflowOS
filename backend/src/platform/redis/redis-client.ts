import IORedis, { type Redis, type RedisOptions } from 'ioredis';

// Re-export the Redis type so other layers can type Redis clients without
// importing ioredis directly (WORK-023: the provider-package boundary check
// forbids importing ioredis outside src/platform/**).
export type { Redis };

/**
 * Redis connection factory for WorkflowOS.
 *
 * Used by the production {@link RedisQueue} and any future Redis-backed
 * component (locks, caches, coordination). The connection is shared so that
 * the API process and the worker process each maintain a single client.
 *
 * Redis is NOT authoritative application/workflow state (architecture §29,
 * `DATA2-AC-02`).
 */
export async function createRedisClient(
  urlOrOptions?: string | RedisOptions,
): Promise<Redis> {
  const client =
    typeof urlOrOptions === 'string'
      ? new IORedis(urlOrOptions)
      : new IORedis(urlOrOptions ?? { host: '127.0.0.1', port: 6379 });
  return client;
}
