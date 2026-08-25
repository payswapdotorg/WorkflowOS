import type { Queue, JobRecord } from '../queue/queue.js';
import type { HandlerRegistry } from './job-handler.js';
import type { OutboxRelay } from './outbox-relay.js';
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
  /**
   * OUTBOX RELAY (transactional-outbox liveness): durable outbox
   * obligations whose enqueuer died before delivery. Each relay is
   * swept exactly ONCE per worker-process start (see
   * {@link OutboxRelay}) — process-startup recovery, NOT a periodic
   * poll. Defaults to none.
   */
  outboxRelays?: readonly OutboxRelay[];
}

export class WorkerHost {
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;
  private readonly queue: Queue;
  private readonly handlers: HandlerRegistry;
  private readonly outboxRelays: readonly OutboxRelay[];
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
    this.outboxRelays = options.outboxRelays ?? [];
  }

  /**
   * Start processing jobs. Returns immediately (the loop runs detached on the
   * Node event loop). Use {@link stopped} to await loop exit, or {@link stop}
   * to request shutdown.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info('worker.host.starting', {
      handlerTypes: [...this.handlers.keys()],
      pollIntervalMs: this.pollIntervalMs,
    });
    // OUTBOX RELAY BOOT SWEEP — exactly once per process start, BEFORE the
    // poll loop begins. This is process-startup recovery (the same class
    // of action as a database's crash-recovery pass at boot), NOT a
    // periodic poll: the sweep never re-runs inside the loop. It
    // guarantees the transactional-outbox liveness invariant — an outbox
    // row that exists is re-enqueued as a relay job the moment any
    // worker process boots, so a supervised restart after total process
    // death always re-attempts delivery. Each relay is swept
    // independently; a failing sweep is caught + logged and NEVER
    // prevents the worker (or the other relays) from starting.
    await this.sweepOutboxRelays();
    // Detach the loop so callers do not block on `start()`.
    this.loopPromise = this.loop();
    // Surface any unexpected loop rejection on the process, but do NOT make
    // `start()` await loop completion.
    this.loopPromise.catch((err) => {
      this.logger.error('worker.host.loop_rejected', { error: errorMessage(err) });
      errorTracker().capture(toError(err));
    });
  }

  /**
   * The one-time-per-start outbox relay sweep. See {@link OutboxRelay}.
   * Private + only called from {@link start} — the sweep is deliberately
   * NOT reachable from the poll loop (no periodic re-sweep).
   */
  private async sweepOutboxRelays(): Promise<void> {
    for (const relay of this.outboxRelays) {
      try {
        const enqueued = await relay.enqueuePendingRelayJobs();
        this.logger.info('worker.host.outbox_relay_swept', {
          jobType: relay.jobType,
          enqueued,
        });
      } catch (err) {
        this.logger.error('worker.host.outbox_relay_sweep_failed', {
          jobType: relay.jobType,
          error: errorMessage(err),
        });
        errorTracker().capture(toError(err));
      }
    }
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
        // PR #38 review (durable redelivery): for handlers that OPT IN via
        // a redeliveryPolicy, re-enqueue the job onto the SAME durable
        // queue with attempt+1 BEFORE the finally-ack consumes the failed
        // delivery — a transient failure therefore produces another
        // DURABLE attempt without a process restart (the boot sweep
        // remains the restart-time backstop; exhaustion leaves the durable
        // outbox row pending for the next sweep). Handlers WITHOUT a
        // policy are entirely unaffected (the historical ack-regardless
        // semantics).
        const policy = handler.redeliveryPolicy;
        const attempt = job.attempt ?? 1;
        if (policy && attempt < policy.maxAttempts) {
          try {
            await this.queue.enqueue(job.type, job.payload, {
              executionId: job.executionId,
              correlationId: job.correlationId,
              attempt: attempt + 1,
            });
            this.logger.warn('worker.job.redelivered', {
              jobId: job.id,
              jobType: job.type,
              attempt,
              nextAttempt: attempt + 1,
              maxAttempts: policy.maxAttempts,
            });
          } catch (redeliverErr) {
            // The queue itself is failing — the redelivery is lost until
            // the next boot sweep (a restart-time backstop, loudly logged).
            this.logger.error('worker.job.redelivery-failed', {
              jobId: job.id,
              jobType: job.type,
              attempt,
              error: errorMessage(redeliverErr),
            });
          }
        } else if (policy) {
          this.logger.error('worker.job.redelivery-exhausted', {
            jobId: job.id,
            jobType: job.type,
            attempt,
            maxAttempts: policy.maxAttempts,
          });
        }
      } finally {
        // The foundation acknowledges regardless of success/failure to keep
        // the queue moving. For redelivery-policy handlers the retry job
        // was already re-enqueued above, so the ack only retires THIS
        // delivery. Handlers without a policy are unchanged.
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
