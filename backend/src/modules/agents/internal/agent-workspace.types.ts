/**
 * WORK-035: Agent Workspaces and Git Worktrees — the provider-independent
 * workspace contracts inside /agents.
 *
 * A Workspace is the FILESYSTEM / REPOSITORY ENVIRONMENT in which one
 * logical execution runs (spec §33.8 "isolated Git worktrees"). The
 * distinction the architecture requires:
 *
 *     ExecutionSession = the LOGICAL execution lifecycle (WORK-034)
 *     Workspace        = the filesystem/repository ENVIRONMENT that
 *                       execution runs in (WORK-035)
 *
 * The workspace NEVER creates another execution identity: it references
 * the existing ExecutionRecord (workspace.executionId → the record's id,
 * UNIQUE — exactly one workspace per execution, one worktree per
 * workspace). Repository information comes from the EXISTING /github
 * authority (the ProjectGitHubRepository row) — the workspace is NOT a
 * GitHub authority (no PR/merge state, no credentials).
 *
 * State machine (strict; CAS transitions; terminal states immutable):
 *
 *     requested → preparing → ready → released
 *                 preparing → failed
 *     any non-terminal → cancelled
 *
 *   requested : the durable intent; materialization not started.
 *   preparing : a worker CAS-claimed the materialization (lease-guarded —
 *               a crashed preparer is recoverable when the lease expires).
 *   ready     : the worktree is materialized; execution may run in it.
 *   released / failed / cancelled : terminal (immutable historical rows).
 *
 * Crash safety:
 *   * "workspace record created → crash": the row is 'requested'; a retry
 *     of ensureWorkspace returns the SAME row — no second worktree.
 *   * "worktree created → DB write crashes": the deterministic worktree
 *     path (UNIQUE) + the claim lease + the reconciliation make recovery
 *     idempotent — a re-claim finds the existing worktree or materializes
 *     it cleanly; an uncontrolled second worktree is impossible.
 *
 * Boundary: /agents owns this layer (the execution infrastructure
 * boundary; NOT a second GitHub authority, NOT a workflow engine, NOT a
 * tool runtime / permission system / router — those are WORK-036/037/
 * 042/043/044). The worktree MATERIALIZATION itself is behind the
 * WorktreeMaterializer port (provider-independent, test-fakeable; the
 * real git implementation is wired at the composition root and executes
 * `git worktree`-class operations — no host filesystem access beyond the
 * configured workspace root, no credentials).
 */
import type { DatabaseClient } from '@platform/index.js';
// WORK-035: the worktree-materializer PORT is platform-owned (the concrete
// implementations are execution infrastructure — git + filesystem — like
// platform/storage's ObjectStore; the dependency direction is
// domain → platform). /agents re-exports the contract through its barrel.
export type {
  WorktreeMaterializer,
  WorktreeMaterializerInput,
  WorktreeRemoveInput,
} from '@platform/workspace/worktree-materializer.types.js';
export { WorktreeMaterializerError } from '@platform/workspace/worktree-materializer.types.js';

/** §workspace-states: the strict workspace state vocabulary. */
export type AgentWorkspaceState =
  | 'requested'
  | 'preparing'
  | 'ready'
  | 'released'
  | 'failed'
  | 'cancelled';

/** The legal transition graph (terminal states have no outgoing edges). */
export const AGENT_WORKSPACE_TRANSITIONS: Readonly<
  Record<AgentWorkspaceState, readonly AgentWorkspaceState[]>
> = Object.freeze({
  requested: ['preparing', 'cancelled'],
  preparing: ['ready', 'failed', 'cancelled'],
  ready: ['released', 'cancelled'],
  released: [],
  failed: [],
  cancelled: [],
});

/** The persisted workspace row (the safe view — no credentials). */
export interface AgentWorkspace {
  readonly id: string;
  /** The ExecutionRecord's UUID this workspace belongs to (UNIQUE). */
  readonly executionId: string;
  readonly projectId: string;
  /** The /github authority row (ProjectGitHubRepository.id). */
  readonly projectGitHubRepositoryId: string;
  /** Safe repository coordinates (denormalized from the /github row). */
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  /**
   * The deterministic worktree identity token (UNIQUE across workspaces —
   * two executions never share a worktree; one execution never gets two).
   * Derived from (repository, execution); the materializer resolves it to
   * a host path under the configured workspace root.
   */
  readonly worktreePath: string;
  /** The branch checked out in the worktree. */
  readonly branch: string;
  /** The immutable base revision the worktree was materialized from. */
  readonly baseRevision: string;
  readonly state: AgentWorkspaceState;
  /** CAS token (>= 0); incremented by every transition. */
  readonly version: number;
  readonly prepareLeaseExpiresAt: Date | null;
  /** Where materialization failed (failed rows only). */
  readonly failureStage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly readyAt: Date | null;
  readonly releasedAt: Date | null;
  readonly terminalAt: Date | null;
}

/** Input for ensureWorkspace (the idempotent create-or-get). */
export interface EnsureAgentWorkspaceInput {
  /** The LOGICAL execution identity (the TEXT executionId). */
  readonly executionId: string;
  readonly branch: string;
}

/** A claimed workspace acquisition (the winner's row + the lease). */
export interface AgentWorkspaceClaim {
  readonly workspace: AgentWorkspace;
  /** The resolved host path (from the materializer). */
  readonly hostPath: string;
}

/**
 * The workspace persistence contract. All state transitions are
 * repository-level CAS (lost CAS → null); ownership changes are
 * claim-based (never read-check-write).
 */
export interface AgentWorkspaceRepository {
  /**
   * Idempotent: the ONE workspace for the logical execution (resolves the
   * record + the /github repository row; creates the row on first call
   * with the deterministic worktree token). Typed errors:
   *   'agent-workspace-not-found' — no ExecutionRecord for the executionId;
   *   'agent-workspace-no-repository' — the project has no linked /github
   *     repository row (fail-closed: no repository = no workspace).
   */
  ensureWorkspace(input: EnsureAgentWorkspaceInput): Promise<AgentWorkspace>;

  getWorkspace(id: string): Promise<AgentWorkspace | null>;

  /** The (single) workspace for a logical execution (TEXT id). */
  getWorkspaceForExecution(executionId: string): Promise<AgentWorkspace | null>;

  /**
   * CAS-claim the materialization (requested → preparing) with a lease:
   * WHERE id AND version = $expected AND state = 'requested'. Lost CAS →
   * null (another worker is preparing — exactly one winner).
   */
  claimForPreparation(id: string, expectedVersion: number, leaseTtlMs: number): Promise<AgentWorkspace | null>;

  /**
   * Recovery CAS: re-claim a 'preparing' row whose lease expired (the
   * preparer crashed). WHERE id AND state = 'preparing' AND
   * prepare_lease_expires_at < NOW() → renew the lease. Lost/expired-less
   * → null.
   */
  reclaimStalePreparation(id: string, leaseTtlMs: number): Promise<AgentWorkspace | null>;

  /**
   * CAS preparing → ready (the materializer succeeded): sets ready_at +
   * records the resolved host path in the workspace's durable metadata is
   * NOT stored (host paths are machine-local — the TOKEN is the durable
   * identity; the materializer re-resolves). Lost CAS → null.
   */
  markReady(id: string, expectedVersion: number): Promise<AgentWorkspace | null>;

  /** CAS preparing → failed (the materializer failed; failure_stage recorded). */
  markFailed(id: string, expectedVersion: number, failureStage: string): Promise<AgentWorkspace | null>;

  /**
   * CAS → released (cleanup; from ready) / → cancelled (from any
   * non-terminal). Idempotent for terminal rows (returns the row).
   */
  release(id: string, expectedVersion: number): Promise<AgentWorkspace | null>;
  cancel(id: string, expectedVersion: number): Promise<AgentWorkspace | null>;

  /** Every non-terminal workspace for a project (the recovery sweep list). */
  listNonTerminalWorkspaces(projectId: string): Promise<readonly AgentWorkspace[]>;

  // --- the durable release-obligation contract (the execution-terminal
  //     cleanup pattern; mirrors WORK-034's terminal obligations) ---

  listPendingReleaseObligations(): Promise<readonly AgentWorkspace[]>;
  dischargeReleaseObligation(workspaceId: string): Promise<boolean>;
}

/** Constructor deps for the Pg implementation (internal). */
export interface PgAgentWorkspaceRepositoryDeps {
  readonly db: DatabaseClient;
}

// ============================================================================
// §typed-errors — the workspace-domain error hierarchy (the WORK-034
// pattern: discriminated class + stable codes + structured context).
// ============================================================================

export const AGENT_WORKSPACE_ERROR_CODES = [
  'agent-workspace-not-found',
  'agent-workspace-no-repository',
  'agent-workspace-illegal-transition',
  'agent-workspace-materialization-failed',
] as const;

export type AgentWorkspaceErrorCode = (typeof AGENT_WORKSPACE_ERROR_CODES)[number];

/** The discriminated workspace-domain error. */
export class AgentWorkspaceError extends Error {
  readonly code: AgentWorkspaceErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: AgentWorkspaceErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AgentWorkspaceError';
    this.code = code;
    this.context = context;
  }
}

