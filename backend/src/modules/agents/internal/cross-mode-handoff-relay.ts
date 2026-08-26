/**
 * WORK-042 (PR #46 review correction): the cross-mode-handoff outbox relay —
 * the durable delivery mechanism for cross-mode-handoff obligations, using
 * the EXISTING generic OutboxRelay pattern (the SAME architecture as the
 * WORK-034 session-terminal relay + the WORK-035 workspace-release relay +
 * the benchmark start-delivery relay):
 *
 *     handoff log INSERT (reserve — migration 0042)
 *         ↓  migration 0043's AFTER INSERT trigger writes the obligation
 *            ATOMICALLY with the reserve (no window where the handoff log
 *            exists but the obligation is missing)
 *     durable cross-mode-handoff obligation
 *         ↓  claim-time relay job (the service enqueues on reserve) + the
 *            WorkerHost boot sweep (every worker start re-enqueues for ALL
 *            pending obligations — supervised restart ⇒ sweep ⇒ attempt)
 *     existing Queue / WorkerHost (the relay job + the boot sweep)
 *         ↓
 *     idempotent reconcileCrossModeHandoffForExecution (re-mutate if the
 *       record.mode !== toMode; re-dispatch if the dispatch outcome is
 *       missing; discharge when complete)
 *
 * This closes the reviewer's blocking durability gap (#2): the relay was
 * previously declared OPTIONAL and was NOT wired into the WorkerHost, so a
 * crash in the reserve→mutate or mutate→dispatch window left a stranded
 * handoff (durable handoff log row, but no guaranteed recovery mechanism).
 * Now the obligation is durable BEFORE the window can open (migration
 * 0043's trigger writes it inside the reserve INSERT), and the liveness
 * chain guarantees eventual delivery:
 *   1. claim-time relay job — the service enqueues the job onto the
 *      durable queue at reserve time, so a live worker drains it without
 *      any restart;
 *   2. boot sweep — every worker start re-enqueues for ALL pending
 *      obligations (supervised restart ⇒ sweep ⇒ attempt);
 *   3. the fast path — the synchronous mutate+dispatch usually wins; the
 *      relay is the recovery backstop.
 *
 * NO scheduler, NO polling loop, NO second execution engine: the relay only
 * delivers ALREADY-AUTHORITATIVE durable intent (the obligation rows). It
 * never decides what work should exist. The reconciliation is the EXISTING
 * service's idempotent replay. Duplicate relay jobs are harmless by
 * contract (the reconciliation is idempotent: exactly one transition, one
 * dispatch, one discharge).
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
