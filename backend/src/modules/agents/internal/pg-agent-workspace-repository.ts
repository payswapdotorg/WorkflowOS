/**
 * WORK-035: PgAgentWorkspaceRepository — the durable workspace boundary.
 *
 * Mechanical properties (migration 0036's triggers are the backstop):
 *   * ensureWorkspace is lookup-or-create (UNIQUE(execution_id) — a retry
 *     after "record created → crash" returns the SAME row: no second
 *     workspace, no second worktree);
 *   * the worktree token is DERIVED DETERMINISTICALLY from (repository,
 *     execution) — UNIQUE(worktree_path): two executions never share a
 *     worktree, one execution never gets two, and re-materialization after
 *     a crash lands on the same path;
 *   * every state transition is a repository-level CAS (version + state
 *     predicate; lost CAS → null — no read-check-write ownership);
 *   * the preparing claim carries a lease (a crashed preparer is
 *     recoverable when it expires — reclaimStalePreparation);
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

/** Resolves the project's /github repository row (safe coordinates only). */
export interface ProjectGitHubRepositoryLookup {
  findByProject(projectId: string): Promise<{
    readonly id: string;
    readonly projectId: string;
    readonly owner: string;
    readonly repository: string;
  } | null>;
}

export interface PgAgentWorkspaceRepositoryFullDeps {
  readonly db: DatabaseClient;
  /** Resolves the logical (TEXT) executionId → the ExecutionRecord. */
  readonly executionRecordRepository: Pick<ExecutionRecordRepository, 'findByExecutionId'>;
  /** The EXISTING /github authority lookup (fail-closed when absent). */
  readonly projectGitHubRepositoryLookup: ProjectGitHubRepositoryLookup;
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
    // Idempotent lookup-or-create.
    const existing = await this.getWorkspaceForExecution(input.executionId);
    if (existing) return existing;
    // The deterministic worktree token: (owner/repo, executionId) — stable
    // across retries + crashes (UNIQUE: no uncontrolled second worktree).
    const worktreeToken = `${repo.owner}/${repo.repository}/exec/${record.id}`;
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
          input.branch, record.promptDigest || 'unknown',
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
    const res = await this.deps.db.query<WorkspaceRow>(
      `UPDATE wfos_agent_workspaces
          SET state = 'cancelled',
              version = version + 1,
              prepare_lease_expires_at = NULL,
              terminal_at = NOW()
        WHERE id = $1
          AND version = $2
          AND terminal_at IS NULL
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
