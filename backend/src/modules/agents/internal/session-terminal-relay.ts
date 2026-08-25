/**
 * WORK-034 (PR #38 review correction): the session-terminal outbox relay —
 * the durable delivery mechanism for session-terminal obligations, using
 * the EXISTING generic OutboxRelay pattern (the same architecture as the
 * benchmark start-delivery relay):
 *
 *     ExecutionRecord terminal (atomic with the record's own transition —
 *         ↓             migration 0035's trigger writes the obligation)
 *     durable session-terminal obligation
 *         ↓
 *     existing Queue / WorkerHost (the relay job + the boot sweep)
 *         ↓
 *     CAS session terminalization (idempotent reconciliation)
 *
 * This closes the reviewer's blocking durability gap: the previous
 * terminal-session write was best-effort AFTER the execution record became
 * authoritative (catch + log), so a crash in that window left
 * ExecutionRecord=completed with ExecutionSession=running — permanently.
 * Now the obligation is durable BEFORE the window can open (the DB trigger
 * writes it inside the record's terminal statement), and the liveness
 * chain guarantees eventual delivery:
 *   1. claim-time relay job — completeSession/failSession enqueue the job
 *      onto the durable queue (RedisQueue in production);
 *   2. boot sweep — every worker start re-enqueues for ALL pending
 *      obligations (supervised restart ⇒ sweep ⇒ attempt);
 *   3. the fast path — the immediate best-effort attempt remains (it
 *      usually wins; the relay is the recovery backstop).
 *
 * NO scheduler, NO polling loop, NO second execution engine: the relay only
 * delivers ALREADY-AUTHORITATIVE durable intent; the reconciliation is the
 * existing repository CAS. Duplicate relay jobs are harmless by contract
 * (the reconciliation is idempotent: exactly one terminal event, one CAS
 * winner, one discharge).
 */
import type { OutboxRelay, JobHandler, JobRecord, Queue } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { ExecutionSessionRepository } from './execution-session.types.js';
import type { ExecutionRecordRepository } from './execution.types.js';

/** The reconciliation surface the relay's job handler needs. */
export interface SessionTerminalReconciler {
  reconcileTerminalForExecution(executionId: string): Promise<unknown>;
}

/** The durable relay job type (registered in the WorkerHost registry). */
export const SESSION_TERMINAL_RELAY_JOB_TYPE = 'agents.session-terminal.reconcile';

/** Payload of a {@link SESSION_TERMINAL_RELAY_JOB_TYPE} job. */
export interface SessionTerminalRelayJobPayload {
  /** The LOGICAL execution identity (the TEXT executionId). */
  readonly executionId: string;
}

export interface SessionTerminalOutboxRelayDeps {
  readonly sessionRepository: Pick<ExecutionSessionRepository, 'listPendingTerminalObligations'>;
  readonly executionRecordRepository: Pick<ExecutionRecordRepository, 'findById'>;
  readonly queue: Queue;
  readonly logger: Logger;
}

/**
 * The session-terminal outbox relay — implements the platform's generic
 * {@link OutboxRelay} contract. Injected into the WorkerHost at composition
 * time (app.ts) via `WorkerHostOptions.outboxRelays`.
 */
export class SessionTerminalOutboxRelay implements OutboxRelay {
  readonly jobType = SESSION_TERMINAL_RELAY_JOB_TYPE;

  constructor(private readonly deps: SessionTerminalOutboxRelayDeps) {}

  /**
   * The BOOT-SWEEP entry point (invoked exactly once per worker-process
   * start by the WorkerHost — never periodically). Enqueues one relay job
   * per PENDING obligation (resolving the record's UUID → the logical TEXT
   * executionId the reconciliation consumes). Idempotent: duplicate relay
   * jobs are harmless (the reconciliation is idempotent).
   */
  async enqueuePendingRelayJobs(): Promise<number> {
    const pending = await this.deps.sessionRepository.listPendingTerminalObligations();
    const withLogicalId: string[] = [];
    for (const p of pending) {
      const record = await this.deps.executionRecordRepository.findById(p.obligation.executionId);
      if (record) {
        await this.deps.queue.enqueue(this.jobType, { executionId: record.executionId } satisfies SessionTerminalRelayJobPayload);
        withLogicalId.push(record.executionId);
      } else {
        // The record was deleted (ON DELETE CASCADE drops the obligation
        // too — unreachable in practice); skip loudly.
        this.deps.logger.warn('session-terminal.relay.record-missing', {
          obligationId: p.obligation.id,
        });
      }
    }
    if (withLogicalId.length > 0) {
      this.deps.logger.info('session-terminal.relay.swept', {
        obligations: withLogicalId.length,
      });
    }
    return withLogicalId.length;
  }
}

/**
 * Build the `agents.session-terminal.reconcile` job handler. Registered
 * with the WorkerHost's HandlerRegistry at composition time (app.ts). Each
 * job carries `{ executionId: string }` (the LOGICAL execution identity);
 * the handler calls the idempotent reconcileTerminalForExecution. Fire-once
 * (no self-reenqueue, no retry loop): a failed attempt is re-attempted by
 * the next boot sweep or reconciliation touch point.
 */
export function createSessionTerminalRelayJobHandler(
  reconciler: { reconcileTerminalForExecution(executionId: string): Promise<unknown> },
  logger: Logger,
): JobHandler {
  return {
    type: SESSION_TERMINAL_RELAY_JOB_TYPE,
    async handle(job: JobRecord): Promise<void> {
      const payload = job.payload as SessionTerminalRelayJobPayload | null;
      const executionId = payload?.executionId;
      if (!executionId) {
        logger.error('session-terminal.relay.missing_execution_id', {
          jobId: job.id,
          executionId: job.executionId,
        });
        return;
      }
      await reconciler.reconcileTerminalForExecution(executionId);
    },
  };
}
