import { createLogger, type Logger } from '@platform/logger.js';
import { InMemoryQueue, type Queue } from '@platform/index.js';
import { buildHandlerRegistry, createEchoJobHandler, WorkerHost, type EchoListener } from '@platform/index.js';
import { CaptureStream } from './capture-stream.js';

/**
 * Test harness that wires the platform runtime with an in-memory queue and a
 * capturing pino destination. Used by integration tests for PLAT-AC-03,
 * OBS-AC-01, and OBS-AC-02.
 */
export interface TestApp {
  logger: Logger;
  queue: Queue;
  capture: CaptureStream;
  worker: WorkerHost;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface BuildTestAppOptions {
  /** Echo job listener; tests observe async completion and execution id. */
  onEcho?: EchoListener;
  /** Worker poll interval (ms). Defaults to 5ms (tight for fast tests). */
  pollIntervalMs?: number;
  /** Custom queue (tests may inject a RedisQueue backed by ioredis-mock). */
  queue?: Queue;
}

export async function buildTestApp(
  options: BuildTestAppOptions = {},
): Promise<TestApp> {
  const capture = new CaptureStream();
  const logger = createLogger({ level: 'info', destination: capture });
  const queue = options.queue ?? new InMemoryQueue();
  const handlers = buildHandlerRegistry([
    createEchoJobHandler(logger, { onEcho: options.onEcho }),
  ]);
  const worker = new WorkerHost(queue, handlers, logger, {
    pollIntervalMs: options.pollIntervalMs ?? 5,
  });
  return {
    logger,
    queue,
    capture,
    worker,
    start: () => worker.start(),
    stop: async () => {
      await worker.stop();
      await queue.close();
    },
  };
}

/** Wait for `predicate` to return true, polling every `intervalMs`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}
