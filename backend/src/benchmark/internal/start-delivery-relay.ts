/**
 * WORK-032 start-delivery durability (outbox relay liveness): the generic
 * OutboxRelay implementation for the benchmark start-delivery outbox.
 *
 * The PR #35 review found the remaining blocker: the outbox was durable +
 * idempotent but had NO GUARANTEED RELAY — delivery was replayed only from
 * existing touch points (startExperiment / runTrialJob /
 * recoverExperimentIfStale), so the exact crash the outbox was built to
 * solve still lost liveness:
 *
 *     CAS + outbox commit → process dies before any queue job is
 *     delivered → NO trial job exists → NO worker touches the experiment
 *     → NO user reads the experiment → outbox permanently incomplete.
 *
 * The state was recoverable, but not AUTONOMOUSLY recoverable. A durable
 * outbox without a guaranteed relay is just a durable note saying
 * "something needs to happen".
 *
 * This file connects the outbox to WorkflowOS's EXISTING durable job
 * infrastructure (the Queue + WorkerHost) through the platform's generic
 * {@link OutboxRelay} contract — the reviewer's required hierarchy:
 *
 *     existing WorkflowOS durable job infrastructure (Queue + WorkerHost)
 *         ↓
 *     generic outbox relay / delivery mechanism (OutboxRelay + boot sweep)
 *         ↓
 *     Benchmark start-delivery obligation (replayStartDeliveries)
 *
 * The relay is NOT a scheduler and NOT a second execution engine (§34): it
 * only guarantees DELIVERY of already-authoritative durable intent. It
 * never decides what work should exist, never executes trials, and never
 * polls — its two invocation paths are:
 *
 *   1. BOOT SWEEP (WorkerHost.start → OutboxRelay.enqueuePendingRelayJobs,
 *      exactly once per process start): re-enqueue a relay job for every
 *      experiment with an incomplete delivery. Under process supervision,
 *      total process death ⇒ restart ⇒ sweep ⇒ delivery attempt — the
 *      liveness guarantee, with no user read or surviving trial job
 *      required.
 *
 *   2. CLAIM-TIME RELAY JOB (startExperiment, immediately after the atomic
 *      claim): the relay job is enqueued onto the durable queue BEFORE the
 *      immediate replay begins, so a crash at ANY point after the claim
 *      leaves a live worker able to drain the relay job from the durable
 *      queue — recovery WITHOUT a restart.
 *
 * The relay job handler is an ordinary JobHandler in the existing
 * WorkerHost registry: it calls the idempotent replay
 * (replayStartDeliveries — the consumer-side repair path) and returns.
 * Duplicate relay jobs are harmless by design (the replay is idempotent:
 * exactly-once audit via the deterministic-id flag-CAS; per-trial
 * obligations via the UNIQUE constraint + delivered flags).
 *
 * Boundary: imports @platform/* (OutboxRelay, JobHandler, Queue) + the
 * benchmark internal contracts. Never reaches into frozen module
 * internals; constructs NO worker, NO timer, NO loop.
 */
import type { OutboxRelay, JobHandler, JobRecord, Queue } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type {
  BenchmarkRepository,
  BenchmarkStartDeliveryReplayer,
} from './benchmark.types.js';

/** The durable relay job type (registered in the WorkerHost registry). */
export const BENCHMARK_START_DELIVERY_RELAY_JOB_TYPE = 'benchmark.start-delivery.relay';

/** Payload of a {@link BENCHMARK_START_DELIVERY_RELAY_JOB_TYPE} job. */
export interface BenchmarkStartDeliveryRelayJobPayload {
  readonly experimentId: string;
}

export interface BenchmarkStartDeliveryRelayDeps {
  readonly repository: Pick<BenchmarkRepository, 'listExperimentsWithIncompleteStartDeliveries'>;
  readonly queue: Queue;
  readonly logger: Logger;
}

/**
 * The benchmark start-delivery outbox relay — implements the platform's
 * generic {@link OutboxRelay} contract. Injected into the WorkerHost at
 * composition time (app.ts) via `WorkerHostOptions.outboxRelays`.
 */
export class BenchmarkStartDeliveryOutboxRelay implements OutboxRelay {
  readonly jobType = BENCHMARK_START_DELIVERY_RELAY_JOB_TYPE;

  constructor(private readonly deps: BenchmarkStartDeliveryRelayDeps) {}

  /**
   * The BOOT-SWEEP entry point (invoked exactly once per worker-process
   * start by the WorkerHost — never periodically). Enqueues one relay job
   * per experiment that still has an incomplete start delivery. Idempotent:
   * duplicate relay jobs are harmless (the consumer-side replay is
   * idempotent), so racing a concurrent claim-time relay job or a live
   * worker's in-flight replay is safe.
   */
  async enqueuePendingRelayJobs(): Promise<number> {
    const experimentIds = await this.deps.repository.listExperimentsWithIncompleteStartDeliveries();
    for (const experimentId of experimentIds) {
      await this.deps.queue.enqueue(this.jobType, { experimentId } satisfies BenchmarkStartDeliveryRelayJobPayload);
    }
    if (experimentIds.length > 0) {
      this.deps.logger.info('benchmark.start-delivery.relay.swept', {
        experiments: experimentIds.length,
      });
    }
    return experimentIds.length;
  }
}

/**
 * Build the `benchmark.start-delivery.relay` job handler. Registered with
 * the WorkerHost's HandlerRegistry at composition time (app.ts), next to
 * the `benchmark.trial` handler. Each job carries
 * `{ experimentId: string }`; the handler calls the idempotent
 * replayStartDeliveries (the consumer-side repair path). The handler is
 * fire-once: it does NOT re-enqueue itself and has no retry loop — a
 * failed attempt is re-attempted by the next boot sweep or touch point.
 */
export function createStartDeliveryRelayJobHandler(
  replayer: BenchmarkStartDeliveryReplayer,
  logger: Logger,
): JobHandler {
  return {
    type: BENCHMARK_START_DELIVERY_RELAY_JOB_TYPE,
    async handle(job: JobRecord): Promise<void> {
      const payload = job.payload as BenchmarkStartDeliveryRelayJobPayload | null;
      const experimentId = payload?.experimentId;
      if (!experimentId) {
        logger.error('benchmark.start-delivery.relay.missing_experiment_id', {
          jobId: job.id,
          executionId: job.executionId,
        });
        return;
      }
      await replayer.replayStartDeliveries(experimentId);
    },
  };
}
