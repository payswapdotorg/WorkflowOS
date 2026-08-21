import type { Queue, JobRecord } from '../queue/queue.js';
import type { HandlerRegistry } from './job-handler.js';
import type { Logger } from '../logger.js';
import { runWithExecutionContext, type ExecutionContext } from '../execution-context.js';
import { errorTracker } from '../error-tracker.js';
import { metrics } from '../metrics.js';

/**
 * Background worker host.
 *
 * Polls a {@link Queue}, dispatches each job to its registered handler, and
 * acknowledges completion. Each job is processed inside a fresh
 * {@link ExecutionContext} carrying the job's `executionId` so that any log
 * line emitted by the handler (or any downstream call) automatically includes
 * the traceable identifier (OBS-AC-01 / OBS-AC-02).
 *
 * The host is non-blocking: a single instance runs its loop on the Node event
 * loop and does not hold a thread. The API request path enqueues a job and
 * returns immediately (PLAT-AC-03); this host picks it up asynchronously.
 */
export interface WorkerHostOptions {
  /** Polling interval (ms) when the queue is empty. Defaults to 25ms. */
  pollIntervalMs?: number;
}

export class WorkerHost {
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;
  private readonly queue: Queue;
  private readonly handlers: HandlerRegistry;
  private loopPromise: Promise<void> | null = null;

  constructor(
    queue: Queue,
    handlers: HandlerRegistry,
    logger: Logger,
    options: WorkerHostOptions = {},
  ) {
    this.queue = queue;
    this.handlers = handlers;
    this.logger = logger;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
  }

  /**
   * Start processing jobs. Returns immediately (the loop runs detached on the
   * Node event loop). Use {@link stopped} to await loop exit, or {@link stop}
   * to request shutdown.
   */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    this.logger.info('worker.host.starting', {
      handlerTypes: [...this.handlers.keys()],
      pollIntervalMs: this.pollIntervalMs,
    });
    // Detach the loop so callers do not block on `start()`.
    this.loopPromise = this.loop();
    // Surface any unexpected loop rejection on the process, but do NOT make
    // `start()` await loop completion.
    this.loopPromise.catch((err) => {
      this.logger.error('worker.host.loop_rejected', { error: errorMessage(err) });
      errorTracker().capture(toError(err));
    });
    return Promise.resolve();
  }

  /**
   * Resolves when the loop has exited (after {@link stop}). Useful for the
   * worker process entrypoint that wants to keep the process alive until the
   * loop ends.
   */
  stopped(): Promise<void> {
    return this.loopPromise ?? Promise.resolve();
  }

  /**
   * Signal the host to stop after the current poll cycle. Resolves once the
   * loop has exited.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.logger.info('worker.host.stopping');
    if (this.loopPromise) await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let job: JobRecord | null = null;
      try {
        job = await this.queue.dequeue();
      } catch (err) {
        this.logger.error('worker.host.dequeue_failed', {
          error: errorMessage(err),
        });
        errorTracker().capture(toError(err));
        await sleep(this.pollIntervalMs);
        continue;
      }

      if (!job) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      await this.processJob(job);
    }
  }

  private async processJob(job: JobRecord): Promise<void> {
    const ctx: ExecutionContext = {
      executionId: job.executionId,
      correlationId: job.correlationId ?? job.executionId,
    };
    const startedAt = Date.now();
    await runWithExecutionContext(ctx, async () => {
      this.logger.info('worker.job.started', {
        jobId: job.id,
        jobType: job.type,
        enqueuedAt: job.enqueuedAt,
      });
      const handler = this.handlers.get(job.type);
      if (!handler) {
        this.logger.error('worker.job.no_handler', { jobId: job.id, jobType: job.type });
        metrics().counter('worker.job.no_handler', 1, { jobType: job.type });
        await this.queue.ack(job.id);
        return;
      }
      try {
        await handler.handle(job);
        metrics().counter('worker.job.completed', 1, { jobType: job.type });
        metrics().timing('worker.job.duration_ms', Date.now() - startedAt, { jobType: job.type });
        this.logger.info('worker.job.completed', {
          jobId: job.id,
          jobType: job.type,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        metrics().counter('worker.job.failed', 1, { jobType: job.type });
        errorTracker().capture(toError(err), { jobId: job.id, jobType: job.type });
        this.logger.error('worker.job.failed', {
          jobId: job.id,
          jobType: job.type,
          error: errorMessage(err),
          durationMs: Date.now() - startedAt,
        });
      } finally {
        // The foundation acknowledges regardless of success/failure to keep
        // the queue moving. Future work items may implement retries / DLQs by
        // extending the Queue interface — out of scope for WORK-001.
        await this.queue.ack(job.id);
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}
