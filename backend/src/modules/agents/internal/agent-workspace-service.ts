/**
 * WORK-035: DefaultAgentWorkspaceService — the workspace lifecycle
 * boundary owned by /agents.
 *
 * Composes the repository's CAS transitions with the WorktreeMaterializer
 * port so workspace acquisition is ATOMIC, IDEMPOTENT, and CRASH-SAFE:
 *
 *   acquireWorkspace (the idempotent entry):
 *     1. ensureWorkspace (lookup-or-create; a retry after "record created
 *        → crash" returns the SAME row — no second worktree);
 *     2. if 'requested' → CAS-claim (requested → preparing, lease) →
 *        materialize (idempotent port) → CAS (preparing → ready). A CAS
 *        loser returns the CURRENT row (another worker won — exactly one
 *        worktree materialization);
 *     3. if 'preparing' with an EXPIRED lease → reclaim + materialize
 *        (the "worktree created → DB write crashed" window: the
 *        deterministic path makes re-materialization idempotent);
 *     4. if 'ready' → return as-is (acquisition is idempotent);
 *     5. terminal → return as-is (the durable historical record; callers
 *        observe failed/cancelled/released and decide).
 *
 *   releaseWorkspace (cleanup):
 *     remove the worktree (the idempotent port: absent = success) → CAS
 *     (ready → released) → discharge the release obligation. A retry
 *     after any crash point re-enters idempotently (an already-released
 *     row is returned as-is; the obligation discharge is a CAS).
 *
 *   reconcilePendingReleases (the durable execution-terminal cleanup —
 *     the existing Queue/WorkerHost via the generic OutboxRelay):
 *     for each pending release obligation, drive the workspace to
 *     'released' (or observe a non-ready state + discharge per policy).
 *
 * Authority: NEVER mutates workflow / verification / review state; never
 * touches GitHub PR/merge state (the /github boundary stays authoritative);
 * never stores credentials; provider-independent (native + external
 * execution reference the same workspace abstraction).
 *
 * This file is private to /agents.
 */
import type { Logger } from '@platform/logger.js';
import type {
  AgentWorkspace,
  AgentWorkspaceClaim,
  AgentWorkspaceRepository,
  EnsureAgentWorkspaceInput,
  WorktreeMaterializer,
} from './agent-workspace.types.js';
import { AgentWorkspaceError, WorktreeMaterializerError } from './agent-workspace.types.js';

export interface DefaultAgentWorkspaceServiceDeps {
  readonly workspaceRepository: AgentWorkspaceRepository;
  readonly materializer: WorktreeMaterializer;
  readonly logger: Logger;
  /** The preparing-claim lease TTL (default 5 minutes). */
  readonly prepareLeaseTtlMs?: number;
}

const DEFAULT_PREPARE_LEASE_TTL_MS = 300_000;

export class DefaultAgentWorkspaceService {
  private readonly leaseTtlMs: number;

  constructor(private readonly deps: DefaultAgentWorkspaceServiceDeps) {
    this.leaseTtlMs = deps.prepareLeaseTtlMs ?? DEFAULT_PREPARE_LEASE_TTL_MS;
  }

  /**
   * The idempotent acquisition: exactly one workspace + one worktree per
   * execution. Returns the workspace + the resolved host path when
   * 'ready' (or the transition succeeded); a terminal workspace is
   * returned with hostPath '' (the caller observes the terminal state).
   */
  async acquireWorkspace(input: EnsureAgentWorkspaceInput): Promise<AgentWorkspaceClaim> {
    const workspace = await this.deps.workspaceRepository.ensureWorkspace(input);

    // Terminal: the durable historical record — nothing to acquire.
    if (workspace.terminalAt !== null) {
      return { workspace, hostPath: '' };
    }

    // Ready: idempotent acquisition — re-resolve the host path.
    if (workspace.state === 'ready') {
      const hostPath = await this.materializeSafe(workspace);
      return { workspace, hostPath };
    }

    // Requested: the fresh claim path.
    if (workspace.state === 'requested') {
      const claimed = await this.deps.workspaceRepository.claimForPreparation(
        workspace.id, workspace.version, this.leaseTtlMs,
      );
      if (!claimed) {
        // Lost the claim race — a concurrent worker is preparing. Return
        // the CURRENT row (its 'preparing'/'ready' state is observable);
        // the caller may poll or proceed when ready.
        const current = await this.deps.workspaceRepository.getWorkspace(workspace.id);
        return { workspace: current ?? workspace, hostPath: current?.state === 'ready' ? await this.materializeSafe(current) : '' };
      }
      return this.materializeAndReady(claimed);
    }

    // Preparing: the crash-recovery window. If the lease expired, reclaim
    // + re-materialize (idempotent — the deterministic path). If the lease
    // is LIVE, another worker owns the materialization: return the row.
    if (workspace.state === 'preparing') {
      const leaseExpired =
        workspace.prepareLeaseExpiresAt !== null &&
        workspace.prepareLeaseExpiresAt.getTime() < Date.now();
      if (leaseExpired) {
        const reclaimed = await this.deps.workspaceRepository.reclaimStalePreparation(
          workspace.id, this.leaseTtlMs,
        );
        if (reclaimed) {
          return this.materializeAndReady(reclaimed);
        }
        // Another recovery worker won the reclaim — return the current row.
        const current = await this.deps.workspaceRepository.getWorkspace(workspace.id);
        return { workspace: current ?? workspace, hostPath: '' };
      }
      return { workspace, hostPath: '' };
    }

    return { workspace, hostPath: '' };
  }

  /**
   * Cleanup (idempotent): remove the worktree + CAS ready → released +
   * discharge the obligation. Terminal rows return as-is. A worktree
   * removal failure PROPAGATES (typed) — the workspace stays 'ready' and
   * the obligation stays pending for the next reconciliation attempt.
   */
  async releaseWorkspace(workspaceId: string): Promise<AgentWorkspace | null> {
    const workspace = await this.deps.workspaceRepository.getWorkspace(workspaceId);
    if (!workspace) return null;
    if (workspace.terminalAt !== null) {
      // Idempotent: already released/cancelled/failed. Discharge any
      // lingering obligation (e.g. a cancelled workspace).
      await this.deps.workspaceRepository.dischargeReleaseObligation(workspace.id);
      return workspace;
    }
    if (workspace.state !== 'ready') {
      // Not materialized: nothing to remove. Cancel (the explicit
      // non-terminal → cancelled cleanup edge) + discharge.
      const cancelled = await this.deps.workspaceRepository.cancel(workspace.id, workspace.version);
      if (cancelled) {
        await this.deps.workspaceRepository.dischargeReleaseObligation(workspace.id);
      }
      return cancelled ?? workspace;
    }
    // Ready → released: remove the worktree FIRST (the durable state must
    // not claim released while the worktree may still exist), then CAS.
    await this.deps.materializer.remove({ worktreePathToken: workspace.worktreePath });
    const released = await this.deps.workspaceRepository.release(workspace.id, workspace.version);
    if (released) {
      await this.deps.workspaceRepository.dischargeReleaseObligation(workspace.id);
    } else {
      // Lost the release CAS (a concurrent release/recovery won). The
      // worktree is removed (idempotent port) — discharge if terminal.
      const current = await this.deps.workspaceRepository.getWorkspace(workspaceId);
      if (current?.terminalAt !== null && current) {
        await this.deps.workspaceRepository.dischargeReleaseObligation(workspaceId);
      }
      return current;
    }
    return released;
  }

  /**
   * The durable execution-terminal cleanup (the release-obligation
   * reconciliation — one pass, no retry loop; the relay job + the boot
   * sweep drive it). Returns the still-pending count (normally 0).
   */
  async reconcilePendingReleases(): Promise<number> {
    const pending = await this.deps.workspaceRepository.listPendingReleaseObligations();
    let stillPending = 0;
    for (const workspace of pending) {
      try {
        const result = await this.releaseWorkspace(workspace.id);
        if (result === null || result.terminalAt === null) stillPending += 1;
      } catch (err) {
        this.deps.logger.error('agent-workspace.release-reconciliation-failed', {
          workspaceId: workspace.id,
          error: (err as Error).message,
        });
        stillPending += 1;
      }
    }
    return stillPending;
  }

  async getWorkspaceForExecution(executionId: string): Promise<AgentWorkspace | null> {
    return this.deps.workspaceRepository.getWorkspaceForExecution(executionId);
  }

  // ------------------------------------------------------------------ private

  /** Materialize (idempotent) + CAS preparing → ready. */
  private async materializeAndReady(claimed: AgentWorkspace): Promise<AgentWorkspaceClaim> {
    try {
      const hostPath = await this.deps.materializer.materialize({
        worktreePathToken: claimed.worktreePath,
        repositoryOwner: claimed.repositoryOwner,
        repositoryName: claimed.repositoryName,
        branch: claimed.branch,
        baseRevision: claimed.baseRevision,
      });
      const ready = await this.deps.workspaceRepository.markReady(claimed.id, claimed.version);
      if (!ready) {
        // Lost the markReady CAS (e.g. a recovery re-claimed after our
        // lease expired mid-materialization + won the race to ready).
        const current = await this.deps.workspaceRepository.getWorkspace(claimed.id);
        return { workspace: current ?? claimed, hostPath: current?.state === 'ready' ? hostPath : '' };
      }
      return { workspace: ready, hostPath };
    } catch (err) {
      if (err instanceof WorktreeMaterializerError) {
        // The materialization failed — record the failure durably (the
        // workspace → failed; failure_stage = where). The typed error
        // then propagates so the caller knows acquisition failed.
        await this.deps.workspaceRepository
          .markFailed(claimed.id, claimed.version, err.stage)
          .catch((markErr) => {
            this.deps.logger.error('agent-workspace.mark-failed-error', {
              workspaceId: claimed.id,
              error: (markErr as Error).message,
            });
          });
        throw new AgentWorkspaceError(
          'agent-workspace-materialization-failed',
          `agent-workspace-materialization-failed: ${err.message}`,
          { workspaceId: claimed.id, stage: err.stage },
        );
      }
      throw err;
    }
  }

  /** Re-resolve the host path for an already-ready workspace. */
  private async materializeSafe(workspace: AgentWorkspace): Promise<string> {
    try {
      return await this.deps.materializer.materialize({
        worktreePathToken: workspace.worktreePath,
        repositoryOwner: workspace.repositoryOwner,
        repositoryName: workspace.repositoryName,
        branch: workspace.branch,
        baseRevision: workspace.baseRevision,
      });
    } catch (err) {
      this.deps.logger.error('agent-workspace.reresolve-failed', {
        workspaceId: workspace.id,
        error: (err as Error).message,
      });
      return '';
    }
  }
}
