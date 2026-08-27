/**
 * WORK-042 (PR #46 review correction + round 3 + round 4): the cross-mode-
 * handoff outbox relay — the durable delivery mechanism for cross-mode-
 * handoff obligations, using the EXISTING generic OutboxRelay pattern (the
 * SAME architecture as the WORK-034 session-terminal relay + the WORK-035
 * workspace-release relay + the benchmark start-delivery relay):
 *
 *     handoff log INSERT (reserve — migration 0042)
 *         ↓  migration 0043's AFTER INSERT trigger writes the obligation
 *            ATOMICALLY with the reserve (no window where the handoff log
 *            exists but the obligation is missing)
 *     durable cross-mode-handoff obligation
 *         ↓  post-mutation relay job (PR #46 round 3 — the service enqueues
 *            AFTER the mutation+dispatch+session convergence, NOT at
 *            reserve; a live worker that picks up the job sees a COMPLETE
 *            handoff + the reconcile is a no-op discharge, NOT a competing
 *            mutation) + the WorkerHost boot sweep (every worker start
 *            re-enqueues for ALL pending obligations — supervised restart ⇒
 *            sweep ⇒ attempt; the recovery path for a crash between reserve
 *            and the post-mutation enqueue) + the durable claim/lease
 *            (PR #46 round 4 — migration 0044; the caller + the relay
 *            reconcile use the SAME claim primitive so a concurrent sweep /
 *            relay cannot re-mutate + re-dispatch the same obligation while
 *            the caller holds the claim)
 *     existing Queue / WorkerHost (the relay job + the boot sweep)
 *         ↓
 *     idempotent reconcileCrossModeHandoffForExecution (re-mutate if the
 *       record.mode !== toMode; re-dispatch if the dispatch outcome is
 *       missing; re-attempt the session transition when not converged;
 *       discharge when complete) — runs UNDER the claim (a failed claim
 *       returns early: NO re-mutate, NO re-dispatch — the structural
 *       prevention of two concurrent handoff drivers)
 *
 * PR #46 round 3 (the concurrency fix): the relay job is enqueued AFTER the
 * caller's synchronous mutation+dispatch+session convergence, NOT at
 * reserve. Enqueueing at reserve created a race — a live WorkerHost could
 * consume the relay BETWEEN the reserve and the caller's transitionMode,
 * after which BOTH the worker and the caller performed the same
 * mutation+dispatch (the handoff-row UNIQUE constraint does NOT serialize
 * these two executions — both operate on the same already-reserved handoff
 * row; it only fences creation of a SECOND handoff row). Now the relay job
 * is enqueued ONLY AFTER the caller's synchronous state transition is
 * safely committed: a live worker that picks up the job sees a COMPLETE (or
 * near-complete) handoff + the reconcile is a no-op discharge. The boot
 * sweep remains the recovery path for a crash between reserve and the
 * post-mutation enqueue (the obligation is durable; the next worker start
 * reconciles).
 *
 * PR #46 round 4 (the durable claim/lease): the round-3 reorder closed the
 * live-relay race but NOT the boot-sweep race — `reserve()` created a
 * pending obligation BEFORE the caller's mutation, and the boot sweep (or
 * an already-enqueued relay job) could claim + reconcile BETWEEN the
 * reserve and the caller's mutation (TWO concurrent handoff drivers). The
 * handoff-row UNIQUE constraint did NOT serialize this (both actors operated
 * on the SAME already-reserved handoff row). The fix introduces a durable
 * execution claim/lease on the obligation row (migration 0044): the caller
 * acquires the claim ATOMICALLY with the reserve (one transaction), and
 * the relay reconcile acquires the claim at entry. A failed claim means
 * another actor owns the obligation → return early (NO re-mutate, NO
 * re-dispatch). A crashed owner's lease auto-expires (claim_expires_at <
 * NOW()) and the boot sweep reclaims. This is the architect's required
 * durable serialization boundary. The PR description must reflect that
 * after round 4, the boot sweep is NOT merely a passive backstop — it is a
 * potential concurrent driver and therefore participates in the claim/
 * lease ownership semantics.
 *
 * NO scheduler, NO polling loop, NO second execution engine: the relay only
 * delivers ALREADY-AUTHORITATIVE durable intent (the obligation rows). It
 * never decides what work should exist. The reconciliation is the EXISTING
 * service's idempotent replay. Duplicate relay jobs are harmless by
 * contract (the reconciliation is idempotent: exactly one transition, one
 * dispatch, one discharge — AND the claim serializes concurrent attempts).
 */
import type { OutboxRelay, JobHandler, JobRecord, Queue } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { CrossModeHandoffRepository } from './cross-mode-handoff.types.js';
// Import the constant for local use (the re-export below surfaces it for
// the composition root + the tests; the local import is the relay's own
// reference — mirrors how session-terminal-relay.ts references its own
// constant).
import { CROSS_MODE_HANDOFF_RELAY_JOB_TYPE } from './cross-mode-handoff.types.js';

/**
 * The reconciliation surface the relay's job handler needs. Satisfied
 * structurally by {@link DefaultCrossModeHandoffService} (the composition
 * root passes the concrete service).
 */
export interface CrossModeHandoffReconciler {
  reconcileCrossModeHandoffForExecution(executionId: string): Promise<unknown>;
}

/** Payload of a {@link CROSS_MODE_HANDOFF_RELAY_JOB_TYPE} job. */
export interface CrossModeHandoffRelayJobPayload {
  /** The LOGICAL execution identity (the TEXT executionId). */
  readonly executionId: string;
}

export interface CrossModeHandoffOutboxRelayDeps {
  readonly handoffRepository: Pick<
    CrossModeHandoffRepository,
    'listPendingHandoffObligations'
  >;
  readonly queue: Queue;
  readonly logger: Logger;
}

/**
 * The cross-mode-handoff outbox relay — implements the platform's generic
 * {@link OutboxRelay} contract. Injected into the WorkerHost at composition
 * time (app.ts) via `WorkerHostOptions.outboxRelays`.
 */
export class CrossModeHandoffOutboxRelay implements OutboxRelay {
  readonly jobType = CROSS_MODE_HANDOFF_RELAY_JOB_TYPE;

  constructor(private readonly deps: CrossModeHandoffOutboxRelayDeps) {}

  /**
   * The BOOT-SWEEP entry point (invoked exactly once per worker-process
   * start by the WorkerHost — never periodically). Enqueues one relay job
   * per PENDING cross-mode-handoff obligation. Idempotent: duplicate relay
   * jobs are harmless (the reconciliation is idempotent — re-mutate /
   * re-dispatch converge, and a complete handoff discharges + no-ops).
   */
  async enqueuePendingRelayJobs(): Promise<number> {
    const pending = await this.deps.handoffRepository.listPendingHandoffObligations();
    for (const p of pending) {
      await this.deps.queue.enqueue(
        this.jobType,
        { executionId: p.executionId } satisfies CrossModeHandoffRelayJobPayload,
      );
    }
    if (pending.length > 0) {
      this.deps.logger.info('cross-mode-handoff.relay.swept', {
        obligations: pending.length,
      });
    }
    return pending.length;
  }
}

/**
 * Build the `agents.cross-mode-handoff.reconcile` job handler. Registered
 * with the WorkerHost's HandlerRegistry at composition time (app.ts). Each
 * job carries `{ executionId: string }` (the LOGICAL execution identity);
 * the handler calls the idempotent
 * {@link CrossModeHandoffReconciler.reconcileCrossModeHandoffForExecution}.
 * Fire-once (no self-reenqueue, no retry loop): a failed attempt is
 * re-attempted by the next boot sweep or reconciliation touch point.
 */
export function createCrossModeHandoffRelayJobHandler(
  reconciler: CrossModeHandoffReconciler,
  logger: Logger,
): JobHandler {
  return {
    type: CROSS_MODE_HANDOFF_RELAY_JOB_TYPE,
    // The cross-mode-handoff reconciliation is IDEMPOTETIC per attempt
    // (the reserve UNIQUE fence + the idempotent dispatch guards), so a
    // transient failure (e.g. a DB blip) is safely retried on the durable
    // queue — up to 5 total delivery attempts without a process restart.
    // Exhaustion leaves the obligation pending for the boot sweep; the
    // obligation row is the durable source of truth either way.
    redeliveryPolicy: { maxAttempts: 5 },
    async handle(job: JobRecord): Promise<void> {
      const payload = job.payload as CrossModeHandoffRelayJobPayload | null;
      const executionId = payload?.executionId;
      if (!executionId) {
        logger.error('cross-mode-handoff.relay.missing_execution_id', {
          jobId: job.id,
          executionId: job.executionId,
        });
        return;
      }
      await reconciler.reconcileCrossModeHandoffForExecution(executionId);
    },
  };
}
