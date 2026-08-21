import type { Redis } from 'ioredis';

/**
 * Transient, non-authoritative cache backed by Redis (DATA-002).
 *
 * Used to avoid recomputing expensive-but-recoverable values. Cache hits are
 * a performance optimization; the authoritative value MUST always be
 * recoverable from PostgreSQL (architecture §29, `DATA2-AC-02`). Clearing
 * Redis (or letting TTLs expire) MUST NOT corrupt any persisted state.
 *
 * The cache stores opaque string values. Callers serialize/deserialize.
 */
export interface CacheGetOptions {
  ttlMs?: number;
}

export class TransientCache {
  constructor(private readonly redis: Redis) {}

  /**
   * Get a cached value by key, or `null` on miss.
   */
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /**
   * Set a cached value with an optional TTL. If `ttlMs` is omitted the value
   * persists until evicted or explicitly deleted (use sparingly).
   */
  async set(key: string, value: string, options: CacheGetOptions = {}): Promise<void> {
    if (options.ttlMs !== undefined) {
      await this.redis.set(key, value, 'PX', options.ttlMs);
    } else {
      await this.redis.set(key, value);
    }
  }

  /**
   * Delete a cached key. Idempotent.
   */
  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Convenience: return the cached value at `key`, or compute it via `loader`
   * and cache the result. `ttlMs` applies only to freshly-loaded values.
   */
  async getOrLoad(
    key: string,
    loader: () => Promise<string>,
    options: CacheGetOptions = {},
  ): Promise<string> {
    const existing = await this.get(key);
    if (existing !== null) return existing;
    const value = await loader();
    await this.set(key, value, options);
    return value;
  }
}
