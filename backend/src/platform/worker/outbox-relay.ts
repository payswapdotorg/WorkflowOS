/**
 * Generic outbox relay contract — the platform's half of the
 * transactional-outbox liveness guarantee.
 *
 * A durable outbox row says "something needs to happen". That is not,
 * by itself, a guarantee that something WILL happen — the process that
 * created the obligation may die before delivering it, and if no job
 * exists, no worker touches the resource, and no user reads it, the
 * obligation would sit incomplete forever (recoverable, but not
 * AUTONOMOUSLY recoverable).
 *
 * This contract connects durable outbox obligations to WorkflowOS's
 * EXISTING durable job infrastructure (the Queue + WorkerHost): a relay
 * enqueues ordinary jobs of its `jobType` onto the existing queue, and
 * the existing worker host processes them like any other job.
 *
 * The relay is NOT a scheduler and NOT a second execution engine:
 *
 * - It only delivers ALREADY-AUTHORITATIVE durable intent (the outbox
 *   rows). It never decides what work should exist.
 * - The {@link WorkerHost} invokes {@link OutboxRelay.enqueuePendingRelayJobs}
 *   exactly ONCE per process start (the BOOT SWEEP — process-startup
 *   recovery, the same class of action as a database's crash-recovery
 *   pass). It is NOT invoked periodically from the poll loop; there is
 *   no timer, no interval, no self-perpetuation.
 *
 * Liveness chain (any one link delivers):
 *
 *   1. claim-time durable relay job — the obligation's creator enqueues a
 *      relay job onto the durable queue at claim time, so a live worker
 *      drains it without any restart;
 *   2. boot sweep — every worker process start re-enqueues relay jobs for
 *      ALL incomplete obligations, covering the claim → relay-job-enqueue
 *      crash window and any lost relay jobs (supervised restarts make
 *      process death ⇒ restart ⇒ sweep);
 *   3. consumer-side repair — the idempotent replay paths that run on
 *      existing touch points.
 *
 * The crucial invariant:
 *
 *   outbox row exists ⇒ some existing durable mechanism is guaranteed to
 *   eventually attempt delivery.
 *
 * Domain implementations live in the domain layer (e.g. the benchmark
 * start-delivery relay) and are injected into the WorkerHost at
 * composition time (app.ts). Duplicate relay jobs are safe by contract —
 * implementations must be idempotent (the underlying replay is).
 */
export interface OutboxRelay {
  /**
   * The durable job type this relay enqueues (and that a matching
   * JobHandler in the worker's registry processes). Must be unique
   * across the registry.
   */
  readonly jobType: string;

  /**
   * Idempotently enqueue relay jobs for EVERY incomplete durable outbox
   * obligation (one job per outstanding unit of work is typical).
   * Invoked once per worker-process start by the WorkerHost boot sweep.
   * Returns the number of relay jobs enqueued.
   *
   * MUST be idempotent: duplicate relay jobs must be harmless (the
   * consumer-side replay is idempotent). MUST NOT block indefinitely —
   * a failing sweep is caught + logged by the WorkerHost and never
   * prevents the worker from starting.
   */
  enqueuePendingRelayJobs(): Promise<number>;
}
