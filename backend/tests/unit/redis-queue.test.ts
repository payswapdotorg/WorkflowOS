import { describe, it, expect } from 'vitest';
import RedisMock from 'ioredis-mock';
import { RedisQueue } from '@platform/redis/redis-queue.js';

/**
 * Verifies that the Redis-backed queue implementation uses Redis list commands
 * (LPUSH/LPOP) correctly. Uses an in-memory ioredis-compatible mock so the
 * test runs without a real Redis server while still exercising the actual
 * Redis code path.
 *
 * In production this implementation is backed by a real Redis instance
 * (architecture §27, §29). Redis is NOT authoritative application state.
 */
describe('RedisQueue', () => {
  it('enqueues via LPUSH and dequeues via LPOP (FIFO preserved)', async () => {
    const redis = new RedisMock();
    const queue = new RedisQueue(redis, 'wfos:test:pending', 'wfos:test:acked');
    const a = await queue.enqueue('echo', { n: 1 }, { executionId: 'wf_r1' });
    const b = await queue.enqueue('echo', { n: 2 }, { executionId: 'wf_r2' });

    // LPUSH pushes to head, so the tail is the oldest -> LPOP returns oldest.
    const first = await queue.dequeue();
    const second = await queue.dequeue();
    expect(first?.id).toBe(a.id);
    expect(second?.id).toBe(b.id);
    expect(await queue.dequeue()).toBeNull();
    await queue.close();
    redis.disconnect();
  });

  it('carries execution id and correlation id on the stored record', async () => {
    const redis = new RedisMock();
    const queue = new RedisQueue(redis, 'wfos:test:pending2', 'wfos:test:acked2');
    const record = await queue.enqueue('echo', { msg: 'hi' }, { executionId: 'wf_redis3' });
    expect(record.executionId).toBe('wf_redis3');
    expect(record.correlationId).toBe('wf_redis3');

    const dequeued = await queue.dequeue();
    expect(dequeued?.executionId).toBe('wf_redis3');
    expect(dequeued?.payload).toEqual({ msg: 'hi' });
    await queue.close();
    redis.disconnect();
  });

  it('reports queue size via LLEN', async () => {
    const redis = new RedisMock();
    const queue = new RedisQueue(redis, 'wfos:test:pending3', 'wfos:test:acked3');
    expect(await queue.size()).toBe(0);
    await queue.enqueue('echo', {});
    await queue.enqueue('echo', {});
    expect(await queue.size()).toBe(2);
    await queue.dequeue();
    expect(await queue.size()).toBe(1);
    await queue.close();
    redis.disconnect();
  });

  it('acks by adding the job id to a Redis set', async () => {
    const redis = new RedisMock();
    const queue = new RedisQueue(redis, 'wfos:test:pending4', 'wfos:test:acked4');
    const record = await queue.enqueue('echo', {});
    await queue.ack(record.id);
    const acked = await redis.sismember('wfos:test:acked4', record.id);
    expect(acked).toBe(1);
    await queue.close();
    redis.disconnect();
  });
});
