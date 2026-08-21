import { describe, it, expect } from 'vitest';
import { InMemoryQueue } from '@platform/queue/in-memory-queue.js';
import {
  WorkerHost,
  buildHandlerRegistry,
  createLogger,
  type JobHandler,
  type JobRecord,
} from '@platform/index.js';
import { runWithExecutionContext, getExecutionContext } from '@platform/execution-context.js';
import { CaptureStream } from '../helpers/capture-stream.js';
import { waitFor } from '../helpers/test-app.js';

function makeLogger(capture: CaptureStream) {
  return createLogger({ level: 'info', destination: capture });
}

describe('WorkerHost', () => {
  it('runs a handler for a dequeued job and acks it', async () => {
    const capture = new CaptureStream();
    const logger = makeLogger(capture);
    const queue = new InMemoryQueue();
    const handled: JobRecord[] = [];
    const handler: JobHandler = {
      type: 'test',
      async handle(job) {
        handled.push(job);
      },
    };
    const worker = new WorkerHost(
      queue,
      buildHandlerRegistry([handler]),
      logger,
      { pollIntervalMs: 5 },
    );
    const enqueued = await queue.enqueue('test', { x: 1 }, { executionId: 'wf_host1' });
    await worker.start();
    await waitFor(() => handled.length === 1);
    await worker.stop();
    await queue.close();

    expect(handled[0]?.id).toBe(enqueued.id);
  });

  it('propagates the job execution id into the handler context (OBS-AC-01)', async () => {
    const capture = new CaptureStream();
    const logger = makeLogger(capture);
    const queue = new InMemoryQueue();
    const observed: (string | undefined)[] = [];
    const handler: JobHandler = {
      type: 'test',
      async handle() {
        observed.push(getExecutionContext()?.executionId);
      },
    };
    const worker = new WorkerHost(
      queue,
      buildHandlerRegistry([handler]),
      logger,
      { pollIntervalMs: 5 },
    );
    await queue.enqueue('test', {}, { executionId: 'wf_propagated' });
    await worker.start();
    await waitFor(() => observed.length === 1);
    await worker.stop();
    await queue.close();

    expect(observed[0]).toBe('wf_propagated');
  });

  it('emits log lines containing the job execution id (OBS-AC-02)', async () => {
    const capture = new CaptureStream();
    const logger = makeLogger(capture);
    const queue = new InMemoryQueue();
    const handler: JobHandler = {
      type: 'test',
      async handle() {
        logger.info('handler.ran');
      },
    };
    const worker = new WorkerHost(
      queue,
      buildHandlerRegistry([handler]),
      logger,
      { pollIntervalMs: 5 },
    );
    await queue.enqueue('test', {}, { executionId: 'wf_in_logs' });
    await worker.start();
    await waitFor(() => capture.json().some((r) => (r as { msg?: string }).msg === 'handler.ran'));
    await worker.stop();
    await queue.close();

    const records = capture.json() as Array<Record<string, unknown>>;
    const handlerLog = records.find((r) => r.msg === 'handler.ran');
    expect(handlerLog?.executionId).toBe('wf_in_logs');
    const startedLog = records.find((r) => r.msg === 'worker.job.started');
    expect(startedLog?.executionId).toBe('wf_in_logs');
  });

  it('continues processing after a handler throws', async () => {
    const capture = new CaptureStream();
    const logger = makeLogger(capture);
    const queue = new InMemoryQueue();
    const handled: string[] = [];
    const failing: JobHandler = {
      type: 'fail',
      async handle() {
        handled.push('fail');
        throw new Error('boom');
      },
    };
    const ok: JobHandler = {
      type: 'ok',
      async handle() {
        handled.push('ok');
      },
    };
    const worker = new WorkerHost(
      queue,
      buildHandlerRegistry([failing, ok]),
      logger,
      { pollIntervalMs: 5 },
    );
    await queue.enqueue('fail', {}, { executionId: 'wf_f' });
    await queue.enqueue('ok', {}, { executionId: 'wf_ok' });
    await worker.start();
    await waitFor(() => handled.includes('ok'));
    await worker.stop();
    await queue.close();

    expect(handled).toEqual(['fail', 'ok']);
    const records = capture.json() as Array<Record<string, unknown>>;
    expect(records.some((r) => r.msg === 'worker.job.failed')).toBe(true);
    expect(records.some((r) => r.msg === 'worker.job.completed')).toBe(true);
  });

  it('stops cleanly when stop() is called before start()', async () => {
    const capture = new CaptureStream();
    const logger = makeLogger(capture);
    const queue = new InMemoryQueue();
    const worker = new WorkerHost(queue, buildHandlerRegistry([]), logger);
    await expect(worker.stop()).resolves.toBeUndefined();
    await queue.close();
  });

  it('does not establish an execution context outside of job processing', async () => {
    // Sanity: the worker only sets context around job.handle(), not in the
    // outer loop. This guarantees the OBS-AC-02 propagation is per-job.
    const capture = new CaptureStream();
    const logger = makeLogger(capture);
    const queue = new InMemoryQueue();
    const observed: (string | undefined)[] = [];
    const handler: JobHandler = {
      type: 'test',
      async handle() {
        observed.push(getExecutionContext()?.executionId);
      },
    };
    const worker = new WorkerHost(queue, buildHandlerRegistry([handler]), logger, {
      pollIntervalMs: 5,
    });
    await worker.start();
    // While the loop is running with an empty queue, no context is active.
    const seenOutside = runWithExecutionContext({ executionId: 'outer' }, () =>
      getExecutionContext()?.executionId,
    );
    expect(seenOutside).toBe('outer');
    await queue.enqueue('test', {}, { executionId: 'wf_isolated' });
    await waitFor(() => observed.length === 1);
    await worker.stop();
    await queue.close();
    expect(observed[0]).toBe('wf_isolated');
  });
});
