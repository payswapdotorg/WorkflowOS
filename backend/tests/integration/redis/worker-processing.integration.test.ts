import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger } from '@platform/logger.js';
import {
  RedisQueue,
  WorkerHost,
  buildHandlerRegistry,
  createEchoJobHandler,
  type EchoJobResult,
  type JobRecord,
} from '@platform/index.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import { waitFor } from '../../helpers/test-app.js';
import { createTestRedisClient, disconnectTestRedis } from '../../helpers/test-redis.js';
import type { Redis } from 'ioredis';

/**
 * DATA2-AC-01 — Background jobs enqueue and process through Redis-backed
 * workers, reusing the WORK-001 queue/worker mechanism.
 *
 * Evidence: the existing {@link RedisQueue} + {@link WorkerHost} from WORK-001
 * are used unchanged. A job is enqueued via the Redis-backed queue, the worker
 * polls and executes it asynchronously, and the worker-side log line includes
 * the job's execution id (OBS-AC-01 / OBS-AC-02 still hold).
 *
 * No second queue or worker implementation is introduced.
 */
describe('DATA2-AC-01 — Redis-backed worker processing (reuses WORK-001)', () => {
  let redis: Redis;
  let queue: RedisQueue;
  let capture: CaptureStream;
  let worker: WorkerHost;

  beforeEach(async () => {
    redis = await createTestRedisClient();
    // Flush any leftover keys so each test starts clean (esp. with real Redis).
    await redis.flushdb();
    queue = new RedisQueue(redis, 'wfos:test:jobs:pending', 'wfos:test:jobs:acked');
    capture = new CaptureStream();
    const logger = createLogger({ level: 'info', destination: capture });
    const handlers = buildHandlerRegistry([createEchoJobHandler(logger)]);
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });
  });

  afterEach(async () => {
    await worker.stop();
    await queue.close();
    await disconnectTestRedis(redis);
  });

  it('enqueues via RedisQueue and the worker processes the job asynchronously', async () => {
    let captured: JobRecord | undefined;
    let result: EchoJobResult | undefined;
    // Replace the handler registry entry with one that captures.
    capture.reset();
    const logger = createLogger({ level: 'info', destination: capture });
    const handlers = buildHandlerRegistry([
      createEchoJobHandler(logger, {
        onEcho: (job, r) => {
          captured = job;
          result = r;
        },
      }),
    ]);
    // Stop the default worker and start a new one with the capturing handler.
    await worker.stop();
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });
    await worker.start();

    const record = await queue.enqueue('echo', { message: 'hello-redis' });
    expect(record.executionId).toMatch(/^wf_[0-9a-f]{8}$/);

    await waitFor(() => result !== undefined);
    expect(captured?.id).toBe(record.id);
    expect(captured?.payload).toEqual({ message: 'hello-redis' });
    expect(result?.receivedExecutionId).toBe(record.executionId);
  });

  it('uses Redis list semantics (RPUSH/LPOP) — FIFO across multiple jobs', async () => {
    capture.reset();
    const logger = createLogger({ level: 'info', destination: capture });
    const completed: string[] = [];
    const handlers = buildHandlerRegistry([
      createEchoJobHandler(logger, {
        onEcho: (job) => {
          completed.push(job.id);
        },
      }),
    ]);
    await worker.stop();
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });
    await worker.start();

    const a = await queue.enqueue('echo', { i: 1 });
    const b = await queue.enqueue('echo', { i: 2 });
    const c = await queue.enqueue('echo', { i: 3 });

    await waitFor(() => completed.length === 3);
    expect(completed).toEqual([a.id, b.id, c.id]);
  });

  it('the worker-side log line includes the job execution id (OBS still holds)', async () => {
    capture.reset();
    const logger = createLogger({ level: 'info', destination: capture });
    const handlers = buildHandlerRegistry([createEchoJobHandler(logger)]);
    await worker.stop();
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });
    await worker.start();

    const record = await queue.enqueue('echo', { message: 'trace' });
    await waitFor(() =>
      capture
        .json()
        .some((r) => (r as { msg?: string }).msg === 'worker.job.completed'),
    );
    const records = capture.json() as Array<Record<string, unknown>>;
    const started = records.find((r) => r.msg === 'worker.job.started');
    expect(started?.executionId).toBe(record.executionId);
    const handled = records.find((r) => r.msg === 'echo.handled');
    expect(handled?.executionId).toBe(record.executionId);
  });
});
