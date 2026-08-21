import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TransientLock } from '@platform/redis/transient-lock.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import { createTestRedisClient, disconnectTestRedis } from '../../helpers/test-redis.js';
import type { Redis } from 'ioredis';

/**
 * TransientLock (DATA-002) — short-lived coordination via Redis.
 *
 * The lock is explicitly NON-authoritative: holding/releasing it has no effect
 * on persisted WorkflowOS state. Its only purpose is to coordinate concurrent
 * access (e.g. prevent duplicate webhook processing).
 *
 * Uses the WORK-001 shared Redis client boundary. No new worker/queue runtime.
 */
describe('TransientLock', () => {
  let redis: Redis;
  let lock: TransientLock;

  beforeEach(async () => {
    redis = await createTestRedisClient();
    await redis.flushdb();
    lock = new TransientLock(redis, createLogger({ level: 'warn', destination: new CaptureStream() }));
  });
  afterEach(async () => {
    await disconnectTestRedis(redis);
  });

  it('acquires a lock and the holder can release it', async () => {
    const acquired = await lock.acquire('resource-1', { ttlMs: 5000 });
    expect(acquired).not.toBeNull();
    await acquired!.release();
    // After release, the key is gone.
    expect(await redis.get('resource-1')).toBeNull();
  });

  it('rejects a second acquirer while the first holds the lock', async () => {
    const first = await lock.acquire('resource-2', { ttlMs: 5000 });
    expect(first).not.toBeNull();
    const second = await lock.acquire('resource-2', { ttlMs: 5000 });
    expect(second).toBeNull();
    await first!.release();
  });

  it('releasing a lock with the wrong token is a no-op', async () => {
    const acquired = await lock.acquire('resource-3', { ttlMs: 5000 });
    expect(acquired).not.toBeNull();
    // Manually attempt to release with a bogus token.
    const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
    const result = await redis.eval(RELEASE_SCRIPT, 1, 'resource-3', 'bogus-token');
    expect(result).toBe(0);
    // The lock is still held by the original token.
    expect(await redis.get('resource-3')).toBe(acquired!.token);
    await acquired!.release();
  });

  it('auto-expires after the TTL (does not leak)', async () => {
    const acquired = await lock.acquire('resource-4', { ttlMs: 50 });
    expect(acquired).not.toBeNull();
    // Wait past the TTL.
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Now the key should be gone (TTL expired).
    expect(await redis.get('resource-4')).toBeNull();
    // And a new acquirer can take it.
    const second = await lock.acquire('resource-4', { ttlMs: 5000 });
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('withLock runs the callback while holding the lock and releases on success', async () => {
    const order: string[] = [];
    const result = await lock.withLock('resource-5', { ttlMs: 5000 }, async () => {
      // While the callback runs, the lock is held.
      expect(await lock.acquire('resource-5', { ttlMs: 5000 })).toBeNull();
      order.push('ran');
      return 'done';
    });
    expect(result).toBe('done');
    expect(order).toEqual(['ran']);
    // After withLock, the lock is released.
    const reacquired = await lock.acquire('resource-5', { ttlMs: 5000 });
    expect(reacquired).not.toBeNull();
    await reacquired!.release();
  });

  it('withLock releases the lock even when the callback throws', async () => {
    await expect(
      lock.withLock('resource-6', { ttlMs: 5000 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Lock released despite the error.
    const reacquired = await lock.acquire('resource-6', { ttlMs: 5000 });
    expect(reacquired).not.toBeNull();
    await reacquired!.release();
  });

  it('withLock returns null when the lock cannot be acquired', async () => {
    const first = await lock.acquire('resource-7', { ttlMs: 5000 });
    expect(first).not.toBeNull();
    const result = await lock.withLock('resource-7', { ttlMs: 5000 }, async () => 'unreachable');
    expect(result).toBeNull();
    await first!.release();
  });
});
