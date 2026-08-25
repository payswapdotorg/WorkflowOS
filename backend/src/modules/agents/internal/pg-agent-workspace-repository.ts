/**
 * WORK-035: PgAgentWorkspaceRepository — the durable workspace boundary.
 *
 * PR #39 REVIEW FIX #1 — the AUTHORITATIVE BASELINE:
 *   base_revision is the repository's default-branch HEAD COMMIT SHA,
 *   resolved at workspace creation through the EXISTING /github authority
 *   (the ProjectGitHubRepository row + the injected branch-head resolver —
 *   the same getBranch read the benchmark snapshot service uses). It is
 *   NEVER derived from prompt metadata (promptDigest is the SHA-256 of the
 *   implementation prompt, not a Git commit) and NEVER falls back to a
 *   placeholder: when the baseline cannot be resolved the ensure
 *   FAILS CLOSED (typed 'agent-workspace-baseline-unresolvable') — no
 *   workspace row, no worktree. The recorded baseline is immutable
 *   (migration 0036's identity guard) — the workspace is reproducible
 *   from a REAL commit for its entire lifetime.
 *
 * Mechanical properties (migration 0036's triggers are the backstop):
 *   * ensureWorkspace is lookup-or-create (UNIQUE(execution_id) — a retry
 *     after "record created → crash" returns the SAME row: no second
 *     workspace, no second worktree); the baseline resolves ONLY on first
 *     creation (existing rows return their immutable recorded baseline —
 *     retries never re-resolve and never diverge);
 *   * the worktree token is DERIVED DETERMINISTICALLY from (repository,
 *     execution) via the EXPLICIT layout module — UNIQUE(worktree_path):
 *     two executions never share a worktree, one execution never gets
 *     two, and re-materialization after a crash lands on the same path;
 *   * every state transition is a repository-level CAS (version + state
 *     predicate; lost CAS → null — no read-check-write ownership);
 *   * the preparing claim carries a lease (a crashed preparer is
 *     recoverable when it expires — reclaimStalePreparation); CANCELLATION
 *     is LEASE-GATED: a cancel from 'preparing' only wins when no live
 *     preparation is in flight (PR #39 review fix #3 — cleanup can never
 *     cancel an ACTIVE preparation out from under the materializer);
 *   * the repository linkage comes from the EXISTING /github authority
 *     row (fail-closed when the project has none).
 *
 * Boundary: internal/ — persistence only. Never mutates workflow /
 * verification / review state; never touches GitHub PR/merge state; never
 * stores credentials; never imports provider SDKs.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  AgentWorkspace,
  AgentWorkspaceRepository,
  AgentWorkspaceState,
  EnsureAgentWorkspaceInput,
} from './agent-workspace.types.js';
import {
  AGENT_WORKSPACE_TRANSITIONS,
  AgentWorkspaceError,
} from './agent-workspace.types.js';
import type { ExecutionRecordRepository } from './execution.types.js';
import { buildWorktreePathToken } from '@platform/workspace/worktree-layout.js';

/**
 * Resolves the project's /github repository row (safe coordinates only:
 * owner/name/defaultBranch/installationId — the fields the authoritative
 * baseline resolution needs; never credentials).
 */
export interface ProjectGitHubRepositoryLookup {
  findByProject(projectId: string): Promise<{
    readonly id: string;
    readonly projectId: string;
    readonly owner: string;
    readonly repository: string;
    readonly defaultBranch: string;
    readonly installationId: string;
  } | null>;
}

/**
 * The AUTHORITATIVE baseline-resolution contract (PR #39 review fix #1):
 * resolves a branch's HEAD COMMIT SHA through the EXISTING /github
 * adapter surface (a READ — structurally `GitHubAdapter.getBranch`; the
 * same source the benchmark snapshot service uses for baseCommit). The
 * workspace layer itself holds no GitHub credentials — the resolver is
 * injected at the composition root with /github's adapter.
 */
export interface WorkspaceBaselineResolver {
  getBranch(input: {
    readonly owner: string;
    readonly repository: string;
    readonly branchName: string;
    readonly installationId: string;
  }): Promise<{ readonly sha: string }>;
}

export interface PgAgentWorkspaceRepositoryFullDeps {
  readonly db: DatabaseClient;
  /** Resolves the logical (TEXT) executionId → the ExecutionRecord. */
  readonly executionRecordRepository: Pick<ExecutionRecordRepository, 'findByExecutionId'>;
  /** The EXISTING /github authority lookup (fail-closed when absent). */
  readonly projectGitHubRepositoryLookup: ProjectGitHubRepositoryLookup;
  /** The authoritative branch-head resolver (the /github adapter read). */
  readonly baselineResolver: WorkspaceBaselineResolver;
}

const WS_COLUMNS = `id, execution_id, project_id, project_github_repository_id,
       repository_owner, repository_name, worktree_path, branch, base_revision,
       state, version, prepare_lease_expires_at, failure_stage,
       created_at, updated_at, ready_at, released_at, terminal_at`;

/** Qualify every column with an alias (for JOIN queries). */
function prefixedColumns(alias: string): string {
  return WS_COLUMNS.split(/[\n,]+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => `${alias}.${c}`)
    .join(', ');
}

interface WorkspaceRow {
  id: string;
  execution_id: string;
  project_id: string;
  project_github_repository_id: string;
  repository_owner: string;
  repository_name: string;
  worktree_path: string;
  branch: string;
  base_revision: string;
  state: string;
  version: number;
  prepare_lease_expires_at: Date | string | null;
  failure_stage: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  ready_at: Date | string | null;
  released_at: Date | string | null;
  terminal_at: Date | string | null;
}

export class PgAgentWorkspaceRepository implements AgentWorkspaceRepository {
  constructor(private readonly deps: PgAgentWorkspaceRepositoryFullDeps) {}

  async ensureWorkspace(input: EnsureAgentWorkspaceInput): Promise<AgentWorkspace> {
    // Resolve the logical execution → the authoritative record (the
    // workspace CONTINUES an existing execution — it never creates one).
    const record = await this.deps.executionRecordRepository.findByExecutionId(input.executionId);
    if (!record) {
      throw new AgentWorkspaceError(
        'agent-workspace-not-found',
        `agent-workspace-not-found: no ExecutionRecord exists for executionId ${input.executionId} — a workspace continues an existing execution; it never creates one`,
        { executionId: input.executionId },
      );
    }
    // The /github authority row (fail-closed: no linked repository = no
    // workspace — there is nothing to materialize a worktree from).
    const repo = await this.deps.projectGitHubRepositoryLookup.findByProject(record.projectId);
    if (!repo) {
      throw new AgentWorkspaceError(
        'agent-workspace-no-repository',
        `agent-workspace-no-repository: project ${record.projectId} has no linked GitHub repository — a workspace requires the /github repository authority row`,
        { projectId: record.projectId, executionId: input.executionId },
      );
    }
    // Idempotent lookup-or-create. An EXISTING row returns as-is — its
    // recorded baseline is immutable (retries never re-resolve).
    const existing = await this.getWorkspaceForExecution(input.executionId);
    if (existing) return existing;

    // PR #39 review fix #1 — the AUTHORITATIVE baseline: the default-branch
    // HEAD COMMIT SHA through the /github authority read. NEVER prompt
    // metadata; NEVER a placeholder; fail-closed below.
    const baseRevision = await this.resolveBaseline(repo, input.executionId);

    // The deterministic worktree token — derived ONLY by the explicit
    // layout module (stable across retries + crashes; UNIQUE: no
    // uncontrolled second worktree).
    const worktreeToken = buildWorktreePathToken({
      repositoryOwner: repo.owner,
      repositoryName: repo.repository,
      executionRecordId: record.id,
    });
    try {
      const res = await this.deps.db.query<WorkspaceRow>(
        `INSERT INTO wfos_agent_workspaces
           (execution_id, project_id, project_github_repository_id,
            repository_owner, repository_name, worktree_path, branch, base_revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${WS_COLUMNS}`,
        [
          record.id, record.projectId, repo.id,
          repo.owner, repo.repository, worktreeToken,
          input.branch, baseRevision,
        ],
      );
      return mapWorkspace(res.rows[0]!);
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (
        e.code === '23505' &&
        (e.constraint === 'wfos_agent_workspaces_execution_unique' ||
          e.constraint === 'wfos_agent_workspaces_worktree_path_unique')
      ) {
        // A concurrent creator won the ensure race — still exactly one.
        const raced = await this.getWorkspaceForExecution(input.executionId);
        if (raced) return raced;
      }
      throw err;
    }
  }

  async getWorkspace(id: string): Promise<AgentWorkspace | null> {
    const res = await this.deps.db.query<WorkspaceRow>(
      `SELECT ${WS_COLUMNS} FROM wfos_agent_workspaces WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? mapWorkspace(res.rows[0]) : null;
  }

  async getWorkspaceForExecution(executionId: string): Promise<AgentWorkspace | null> {
    const res = await this.deps.db.query<WorkspaceRow>(
      `SELECT ${prefixedColumns('w')}
         FROM wfos_agent_workspaces w
         JOIN wfos_executions e ON e.id = w.execution_id
        WHERE e.execution_id = $1`,
      [executionId],
    );
    return res.rows[0] ? mapWorkspace(res.rows[0]) : null;
  }

  async claimForPreparation(id: string, expectedVersion: number, leaseTtlMs: number): Promise<AgentWorkspace | null> {
    const legal = AGENT_WORKSPACE_TRANSITIONS['requested'];
    void legal;
    const res = await this.deps.db.query<WorkspaceRow>(
      `UPDATE wfos_agent_workspaces
          SET state = 'preparing',
              version = version + 1,
              prepare_lease_expires_at = NOW() + ($3 || ' milliseconds')::interval
        WHERE id = $1
          AND version = $2
          AND state = 'requested'
          AND terminal_at IS NULL
        RETURNING ${WS_COLUMNS}`,
      [id, expectedVersion, String(leaseTtlMs)],
    );
    return res.rows[0] ? mapWorkspace(res.rows[0]) : null;
  }

  async reclaimStalePreparation(id: string, leaseTtlMs: number): Promise<AgentWorkspace | null> {
    const res = await this.deps.db.query<WorkspaceRow>(
      `UPDATE wfos_agent_workspaces
          SET version = version + 1,
              prepare_lease_expires_at = NOW() + ($2 || ' milliseconds')::interval
        WHERE id = $1
          AND state = 'preparing'
          AND terminal_at IS NULL
          AND prepare_lease_expires_at IS NOT NULL
          AND prepare_lease_expires_at < NOW()
        RETURNING ${WS_COLUMNS}`,
      [id, String(leaseTtlMs)],
    );
    return res.rows[0] ? mapWorkspace(res.rows[0]) : null;
  }

  async markReady(id: string, expectedVersion: number): Promise<AgentWorkspace | null> {
    const res = await this.deps.db.query<WorkspaceRow>(
      `UPDATE wfos_agent_workspaces
          SET state = 'ready',
              version = version + 1,
              ready_at = NOW(),
              prepare_lease_expires_at = NULL
        WHERE id = $1
          AND version = $2
          AND state = 'preparing'
          AND terminal_at IS NULL
        RETURNING ${WS_COLUMNS}`,
      [id, expectedVersion],
    );
    return res.rows[0] ? mapWorkspace(res.rows[0]) : null;
  }

  async markFailed(id: string, expectedVersion: number, failureStage: string): Promise<AgentWorkspace | null> {
    const res = await this.deps.db.query<WorkspaceRow>(
      `UPDATE wfos_agent_workspaces
          SET state = 'failed',
              version = version + 1,
              failure_stage = $3,
              prepare_lease_expires_at = NULL,
              terminal_at = NOW()
        WHERE id = $1
          AND version = $2
          AND state = 'preparing'
          AND terminal_at IS NULL
        RETURNING ${WS_COLUMNS}`,
      [id, expectedVersion, failureStage],
    );
    return res.rows[0] ? mapWorkspace(res.rows[0]) : null;
  }

  async release(id: string, expectedVersion: number): Promise<AgentWorkspace | null> {
    const res = await this.deps.db.query<WorkspaceRow>(
      `UPDATE wfos_agent_workspaces
          SET state = 'released',
              version = version + 1,
              released_at = NOW(),
              terminal_at = NOW()
        WHERE id = $1
          AND version = $2
          AND state = 'ready'
          AND terminal_at IS NULL
        RETURNING ${WS_COLUMNS}`,
      [id, expectedVersion],
    );
    return res.rows[0] ? mapWorkspace(res.rows[0]) : null;
  }

  async cancel(id: string, expectedVersion: number): Promise<AgentWorkspace | null> {
    // Terminal rows: idempotent (return as-is).
    const current = await this.getWorkspace(id);
    if (!current) return null;
    if (current.terminalAt !== null) return current;
    const legal = AGENT_WORKSPACE_TRANSITIONS[current.state] ?? [];
    if (!legal.includes('cancelled')) {
      throw new AgentWorkspaceError(
        'agent-workspace-illegal-transition',
        `agent-workspace-illegal-transition: ${current.state} -> cancelled is not a legal workspace transition`,
        { workspaceId: id, from: current.state, to: 'cancelled' },
      );
    }
    // PR #39 review fix #3 — the LEASE-GATED cancel: a cancellation from
    // 'preparing' only wins when NO live preparation is in flight (no
    // lease, or the lease already expired). While a materializer actively
    // holds the claim, cleanup CANNOT cancel it out from under the
    // in-flight `git worktree add` — the CAS loses and the release
    // obligation stays pending for a later reconciliation (after the
    // preparer reaches ready, or its lease expires).
    const res = await this.deps.db.query<WorkspaceRow>(
      `UPDATE wfos_agent_workspaces
          SET state = 'cancelled',
              version = version + 1,
              prepare_lease_expires_at = NULL,
              terminal_at = NOW()
        WHERE id = $1
          AND version = $2
          AND terminal_at IS NULL
          AND (state <> 'preparing'
               OR prepare_lease_expires_at IS NULL
               OR prepare_lease_expires_at < NOW())
        RETURNING ${WS_COLUMNS}`,
      [id, expectedVersion],
    );
    return res.rows[0] ? mapWorkspace(res.rows[0]) : null;
  }

  async listNonTerminalWorkspaces(projectId: string): Promise<readonly AgentWorkspace[]> {
    const res = await this.deps.db.query<WorkspaceRow>(
      `SELECT ${WS_COLUMNS} FROM wfos_agent_workspaces
        WHERE project_id = $1 AND terminal_at IS NULL
        ORDER BY created_at, id`,
      [projectId],
    );
    return res.rows.map(mapWorkspace);
  }

  async listPendingReleaseObligations(): Promise<readonly AgentWorkspace[]> {
    const res = await this.deps.db.query<WorkspaceRow>(
      `SELECT ${prefixedColumns('w')}
         FROM wfos_agent_workspaces w
         JOIN wfos_agent_workspace_release_obligations o ON o.workspace_id = w.id
        WHERE o.discharged_at IS NULL
        ORDER BY o.created_at, o.id`,
    );
    return res.rows.map(mapWorkspace);
  }

  async dischargeReleaseObligation(workspaceId: string): Promise<boolean> {
    const res = await this.deps.db.query(
      `UPDATE wfos_agent_workspace_release_obligations
          SET discharged_at = NOW()
        WHERE workspace_id = $1 AND discharged_at IS NULL`,
      [workspaceId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ------------------------------------------------------------------ private

  /**
   * The authoritative baseline (PR #39 review fix #1): the repository's
   * default-branch HEAD commit SHA, resolved through the injected
   * /github adapter read. FAIL-CLOSED: an unreachable repository, a
   * missing branch, or a non-SHA response yields the typed
   * 'agent-workspace-baseline-unresolvable' error — NO workspace row is
   * created (never a fabricated or placeholder baseline).
   */
  private async resolveBaseline(
    repo: {
      readonly owner: string;
      readonly repository: string;
      readonly defaultBranch: string;
      readonly installationId: string;
    },
    executionId: string,
  ): Promise<string> {
    let sha = '';
    try {
      const branch = await this.deps.baselineResolver.getBranch({
        owner: repo.owner,
        repository: repo.repository,
        branchName: repo.defaultBranch,
        installationId: repo.installationId,
      });
      sha = (branch?.sha ?? '').trim();
    } catch (err) {
      throw new AgentWorkspaceError(
        'agent-workspace-baseline-unresolvable',
        `agent-workspace-baseline-unresolvable: failed to resolve the default branch (${repo.defaultBranch}) HEAD for ${repo.owner}/${repo.repository} via the /github authority — ${err instanceof Error ? err.message : String(err)}`,
        { executionId, owner: repo.owner, repository: repo.repository, branch: repo.defaultBranch },
      );
    }
    // A real commit SHA only (GitHub SHA-1 or SHA-256 object ids) — the
    // baseline must be a materializable Git revision, never prompt
    // metadata or a placeholder.
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
      throw new AgentWorkspaceError(
        'agent-workspace-baseline-unresolvable',
        `agent-workspace-baseline-unresolvable: the /github authority returned a non-commit baseline for ${repo.owner}/${repo.repository}@${repo.defaultBranch} (${JSON.stringify(sha)}) — a workspace requires a real commit SHA`,
        { executionId, owner: repo.owner, repository: repo.repository, branch: repo.defaultBranch, resolved: sha },
      );
    }
    return sha;
  }
}

// ---------------------------------------------------------------------------
// mappers
// ---------------------------------------------------------------------------

function toDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

function mapWorkspace(r: WorkspaceRow): AgentWorkspace {
  return {
    id: String(r.id),
    executionId: String(r.execution_id),
    projectId: String(r.project_id),
    projectGitHubRepositoryId: String(r.project_github_repository_id),
    repositoryOwner: String(r.repository_owner),
    repositoryName: String(r.repository_name),
    worktreePath: String(r.worktree_path),
    branch: String(r.branch),
    baseRevision: String(r.base_revision),
    state: r.state as AgentWorkspaceState,
    version: Number(r.version),
    prepareLeaseExpiresAt: toDate(r.prepare_lease_expires_at),
    failureStage: r.failure_stage === null || r.failure_stage === undefined ? null : String(r.failure_stage),
    createdAt: toDate(r.created_at)!,
    updatedAt: toDate(r.updated_at)!,
    readyAt: toDate(r.ready_at),
    releasedAt: toDate(r.released_at),
    terminalAt: toDate(r.terminal_at),
  };
}
