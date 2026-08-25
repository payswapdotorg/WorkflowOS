/**
 * WORK-035: the workspace-release outbox relay — the durable delivery
 * mechanism for workspace release obligations, using the EXISTING generic
 * OutboxRelay pattern (the same architecture as the benchmark
 * start-delivery relay + the WORK-034 session-terminal relay):
 *
 *     ExecutionRecord terminal
 *         ↓ migration 0036's AFTER UPDATE trigger — ATOMIC with the
 *           record's terminal transition (the release obligation row)
 *     durable workspace-release obligation
 *         ↓ claim-time relay job + the WorkerHost boot sweep
 *     existing Queue / WorkerHost
 *         ↓
 *     idempotent release reconciliation (remove worktree + CAS released
 *       + discharge)
 *
 * NO scheduler, NO second engine: the relay only delivers
 * already-authoritative durable intent; the reconciliation is the
 * existing repository CAS + the idempotent materializer port.
 */
import type { OutboxRelay, JobHandler, JobRecord, Queue } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { AgentWorkspaceRepository } from './agent-workspace.types.js';

/** The durable relay job type (registered in the WorkerHost registry). */
export const WORKSPACE_RELEASE_RELAY_JOB_TYPE = 'agents.workspace-release.reconcile';

/** Payload of a {@link WORKSPACE_RELEASE_RELAY_JOB_TYPE} job. */
export interface WorkspaceReleaseRelayJobPayload {
  /** The workspace id whose release obligation should reconcile. */
  readonly workspaceId: string;
}

export interface WorkspaceReleaseOutboxRelayDeps {
  readonly workspaceRepository: Pick<AgentWorkspaceRepository, 'listPendingReleaseObligations'>;
  readonly queue: Queue;
  readonly logger: Logger;
}

/**
 * The workspace-release outbox relay — implements the platform's generic
 * {@link OutboxRelay} contract. Injected into the WorkerHost at composition
 * time (app.ts) via `WorkerHostOptions.outboxRelays`.
 */
export class WorkspaceReleaseOutboxRelay implements OutboxRelay {
  readonly jobType = WORKSPACE_RELEASE_RELAY_JOB_TYPE;

  constructor(private readonly deps: WorkspaceReleaseOutboxRelayDeps) {}

  /**
   * The BOOT-SWEEP entry point (once per worker-process start — never
   * periodically). Enqueues one relay job per PENDING release obligation.
   * Idempotent: duplicate relay jobs are harmless (the reconciliation is
   * idempotent).
   */
  async enqueuePendingRelayJobs(): Promise<number> {
    const pending = await this.deps.workspaceRepository.listPendingReleaseObligations();
    for (const workspace of pending) {
      await this.deps.queue.enqueue(this.jobType, { workspaceId: workspace.id } satisfies WorkspaceReleaseRelayJobPayload);
    }
    if (pending.length > 0) {
      this.deps.logger.info('workspace-release.relay.swept', {
        obligations: pending.length,
      });
    }
    return pending.length;
  }
}

/**
 * Build the `agents.workspace-release.reconcile` job handler. The
 * reconciliation is IDEMPOTETIC per attempt (worktree removal +
 * CAS + discharge) — a transient failure is safely retried on the durable
 * queue (the opt-in redelivery policy; up to 5 total delivery attempts
 * without a process restart). Fire-once otherwise: no self-reenqueue, no
 * retry loop.
 */
export function createWorkspaceReleaseRelayJobHandler(
  reconciler: { reconcilePendingReleases(): Promise<number> },
  logger: Logger,
): JobHandler {
  return {
    type: WORKSPACE_RELEASE_RELAY_JOB_TYPE,
    redeliveryPolicy: { maxAttempts: 5 },
    async handle(job: JobRecord): Promise<void> {
      const payload = job.payload as WorkspaceReleaseRelayJobPayload | null;
      const workspaceId = payload?.workspaceId;
      if (!workspaceId) {
        logger.error('workspace-release.relay.missing_workspace_id', {
          jobId: job.id,
          executionId: job.executionId,
        });
        return;
      }
      // The reconciliation is the idempotent batch entry (safe for a
      // per-workspace job: the pending list drives it; an already-clean
      // obligation is a no-op).
      await reconciler.reconcilePendingReleases();
    },
  };
}
