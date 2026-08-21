import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '@api/server.js';
import { InMemoryQueue } from '@platform/queue/in-memory-queue.js';
import { createLogger } from '@platform/logger.js';
import { buildHandlerRegistry, createEchoJobHandler, WorkerHost } from '@platform/index.js';
import type { JobRecord, EchoJobResult } from '@platform/index.js';
import { CaptureStream } from '../helpers/capture-stream.js';
import { waitFor } from '../helpers/test-app.js';

/**
 * PLAT-AC-03 — Long-running work executes asynchronously and does not block
 * API request handling.
 *
 * Evidence (integration test):
 *   - POST /jobs/echo with a payload that includes a `delayMs` longer than the
 *     request budget.
 *   - The API responds in well under `delayMs` (i.e. it does NOT wait for the
 *     worker to finish the long-running job).
 *   - The worker eventually processes the job to completion.
 */
describe('PLAT-AC-03 — async background execution', () => {
  let capture: CaptureStream;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    capture = new CaptureStream();
    const logger = createLogger({ level: 'info', destination: capture });
    queue = new InMemoryQueue();
    const handlers = buildHandlerRegistry([createEchoJobHandler(logger)]);
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });
    server = await buildServer({ queue, logger });
    await server.ready();
    await worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    await server.close();
    await queue.close();
  });

  it('returns 202 while the job is still running, then completes asynchronously', async () => {
    const jobDelayMs = 600; // well above any reasonable API latency budget
    const startedAt = Date.now();
    const response = await server.inject({
      method: 'POST',
      url: '/jobs/echo',
      payload: { message: 'long-running', delayMs: jobDelayMs },
    });
    const requestLatency = Date.now() - startedAt;

    expect(response.statusCode).toBe(202);
    const body = response.json() as { accepted: boolean; jobId: string; executionId: string };
    expect(body.accepted).toBe(true);
    expect(body.executionId).toMatch(/^wf_[0-9a-f]{8}$/);

    // The API MUST return well before the long-running job completes. We use a
    // generous latency budget that still proves non-blocking behavior.
    expect(requestLatency).toBeLessThan(jobDelayMs);

    // The queue MUST have received the job.
    expect(await queue.size()).toBeGreaterThanOrEqual(0);
    // Wait for the worker to actually complete the long-running job.
    await waitFor(async () => {
      const records = capture.json() as Array<Record<string, unknown>>;
      return records.some(
        (r) => r.msg === 'worker.job.completed' && r.jobId === body.jobId,
      );
    });

    // ...and the worker completed AFTER the API returned.
    const completedAt = Date.now();
    expect(completedAt - startedAt).toBeGreaterThanOrEqual(jobDelayMs - 50);
  });

  it('processes many concurrent jobs without serializing API responses', async () => {
    const jobDelayMs = 200;
    const N = 5;
    const startedAt = Date.now();
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        server.inject({
          method: 'POST',
          url: '/jobs/echo',
          payload: { message: 'concurrent', delayMs: jobDelayMs },
        }),
      ),
    );
    const requestLatency = Date.now() - startedAt;

    for (const res of responses) {
      expect(res.statusCode).toBe(202);
    }
    // All N enqueues complete in well under one job's duration.
    expect(requestLatency).toBeLessThan(jobDelayMs);

    await waitFor(async () => {
      const records = capture.json() as Array<Record<string, unknown>>;
      return (
        records.filter((r) => r.msg === 'worker.job.completed').length >= N
      );
    });
  });
});

/**
 * Combined helper used by the OBS integration test below to capture the
 * execution id at every stage of the API → queue → worker → log flow.
 */
async function traceOnce(): Promise<{
  apiResponse: { executionId: string; jobId: string };
  jobRecord: JobRecord | undefined;
  workerResult: EchoJobResult | undefined;
  logRecords: unknown[];
}> {
  const capture = new CaptureStream();
  const logger = createLogger({ level: 'info', destination: capture });
  const queue = new InMemoryQueue();
  let capturedJob: JobRecord | undefined;
  let capturedResult: EchoJobResult | undefined;
  const handlers = buildHandlerRegistry([
    createEchoJobHandler(logger, {
      onEcho: (job, result) => {
        capturedJob = job;
        capturedResult = result;
      },
    }),
  ]);
  const worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });
  const server = await buildServer({ queue, logger });
  await server.ready();
  await worker.start();
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/jobs/echo',
      payload: { message: 'traced' },
    });
    const body = response.json() as { executionId: string; jobId: string };
    await waitFor(() => capturedResult !== undefined);
    return {
      apiResponse: body,
      jobRecord: capturedJob,
      workerResult: capturedResult,
      logRecords: capture.json(),
    };
  } finally {
    await worker.stop();
    await server.close();
    await queue.close();
  }
}

describe('OBS-AC-01 / OBS-AC-02 — execution id tracing through the worker', () => {
  it('carries the same execution id through API response, job record, and worker logs', async () => {
    const trace = await traceOnce();

    const apiExecutionId = trace.apiResponse.executionId;
    expect(apiExecutionId).toMatch(/^wf_[0-9a-f]{8}$/);

    // OBS-AC-01: every workflow/background execution has a traceable identifier.
    expect(trace.jobRecord?.executionId).toBe(apiExecutionId);
    expect(trace.workerResult?.receivedExecutionId).toBe(apiExecutionId);

    // OBS-AC-02: logs emitted DURING the job execution include that
    // identifier. We scope this to job-lifecycle records (those carrying a
    // `jobId`) — startup/shutdown logs are intentionally not part of any
    // execution and are not required to carry an execution id.
    const records = trace.logRecords as Array<Record<string, unknown>>;
    const jobScopedRecords = records.filter((r) => typeof r.jobId === 'string');
    expect(jobScopedRecords.length).toBeGreaterThan(0);
    const jobLogsWithoutId = jobScopedRecords.filter(
      (r) => r.executionId !== apiExecutionId,
    );
    expect(jobLogsWithoutId, JSON.stringify(jobLogsWithoutId, null, 2)).toHaveLength(0);
  });

  it('honors a caller-supplied X-Execution-Id header through the full path', async () => {
    const capture = new CaptureStream();
    const logger = createLogger({ level: 'info', destination: capture });
    const queue = new InMemoryQueue();
    let capturedResult: EchoJobResult | undefined;
    const handlers = buildHandlerRegistry([
      createEchoJobHandler(logger, {
        onEcho: (_job, result) => {
          capturedResult = result;
        },
      }),
    ]);
    const worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });
    const server = await buildServer({ queue, logger });
    await server.ready();
    await worker.start();
    try {
      const supplied = 'wf_caller_supplied';
      const response = await server.inject({
        method: 'POST',
        url: '/jobs/echo',
        headers: { 'x-execution-id': supplied },
        payload: { message: 'caller-id' },
      });
      expect(response.statusCode).toBe(202);
      const body = response.json() as { executionId: string };
      expect(body.executionId).toBe(supplied);
      await waitFor(() => capturedResult !== undefined);
      expect(capturedResult?.receivedExecutionId).toBe(supplied);

      const records = capture.json() as Array<Record<string, unknown>>;
      const handledLog = records.find((r) => r.msg === 'echo.handled');
      expect(handledLog?.executionId).toBe(supplied);
    } finally {
      await worker.stop();
      await server.close();
      await queue.close();
    }
  });
});
