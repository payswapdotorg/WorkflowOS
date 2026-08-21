import { describe, it, expect } from 'vitest';
import RedisMock from 'ioredis-mock';
import { RedisQueue } from '@platform/redis/redis-queue.js';

/**
 * Verifies that the Redis-backed queue implementation uses Redis list commands
 * (RPUSH/LPOP) correctly. Uses an in-memory ioredis-compatible mock so the
 * test runs without a real Redis server while still exercising the actual
 * Redis code path.
 *
 * In production this implementation is backed by a real Redis instance
 * (architecture §27, §29). Redis is NOT authoritative application state.
 */
describe('RedisQueue', () => {
  it('enqueues via RPUSH and dequeues via LPOP, preserving FIFO order', async () => {
    const redis = new RedisMock();
    const queue = new RedisQueue(redis, 'wfos:test:pending', 'wfos:test:acked');
    const a = await queue.enqueue('echo', { n: 1 }, { executionId: 'wf_r1' });
    const b = await queue.enqueue('echo', { n: 2 }, { executionId: 'wf_r2' });

    // RPUSH appends to the tail; LPOP removes from the head. The oldest
    // enqueued job is returned first => FIFO.
    const first = await queue.dequeue();
    const second = await queue.dequeue();
    expect(first?.id).toBe(a.id);
    expect(second?.id).toBe(b.id);
    expect(await queue.dequeue()).toBeNull();
    await queue.close();
    redis.disconnect();
  });

  it('regression: FIFO ordering is preserved across many jobs (not LIFO)', async () => {
    // Regression guard: if anyone ever switches enqueue to LPUSH (head push),
    // RPUSH+LPOP would still FIFO but LPUSH+LPOP would LIFO. This test pins
    // FIFO behavior so such a regression is caught.
    const redis = new RedisMock();
    const queue = new RedisQueue(redis, 'wfos:test:fifo', 'wfos:test:fifo-ack');
    const N = 10;
    const enqueued: string[] = [];
    for (let i = 0; i < N; i++) {
      const rec = await queue.enqueue('echo', { i }, { executionId: `wf_fifo_${i}` });
      enqueued.push(rec.id);
    }
    const dequeued: string[] = [];
    for (let i = 0; i < N; i++) {
      const job = await queue.dequeue();
      expect(job).not.toBeNull();
      dequeued.push(job!.id);
    }
    expect(dequeued).toEqual(enqueued); // exact FIFO order
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
