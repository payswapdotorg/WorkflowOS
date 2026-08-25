-- WORK-035: Agent Workspaces and Git Worktrees — the durable
-- workspace/worktree boundary.
--
-- A Workspace is the FILESYSTEM / REPOSITORY ENVIRONMENT in which one
-- logical execution runs (spec/architecture.md §33.8 "isolated Git
-- worktrees"). It is NOT the execution lifecycle (that is the
-- ExecutionSession, WORK-034) and NOT a new execution identity:
--
--     Work Item → Work Order → ExecutionRecord → ExecutionSession
--                                                     ↓
--                                                Workspace
--                                                     ↓
--                                          Git worktree / checkout
--                                                     ↓
--                                            agent execution
--
-- Exactly ONE workspace per ExecutionRecord (UNIQUE(execution_id)) — two
-- executions can never share a mutable worktree, and one execution can
-- never acquire two.
--
-- The workspace references the repository through the EXISTING /github
-- authority (wfos_project_github_repositories — the ProjectGitHubRepository
-- row), storing only safe metadata: the owner/repository coordinates +
-- the base revision. The workspace layer is NOT a GitHub authority: no PR
-- state, no merge state, no credentials (the installation credential
-- stays in /github's SecretStore).
--
-- State machine (strict; every transition is a repository-level CAS on
-- (version, state); terminal states immutable):
--
--     requested → preparing → ready
--     requested → preparing → failed            (setup failure — retryable
--                                                 by a NEW workspace? NO:
--                                                 the failed row is the
--                                                 durable record; a retry
--                                                 RECONCILES it — see below)
--     ready     → released                     (cleanup)
--     any non-terminal → cancelled              (explicit cancellation)
--
--   requested : the durable intent (the record exists; the worktree
--               materialization has not started).
--   preparing : a worker owns the materialization (CAS-claimed; the claim
--               carries a lease so a crashed preparer is recoverable).
--   ready     : the worktree exists at `worktree_path`; execution may run
--               against it.
--   released  : terminal — cleaned up (the worktree is gone; the row is
--               the historical record).
--   failed    : terminal — materialization failed after all retries
--               (failure_stage records where).
--   cancelled : terminal — cancelled before/without release.
--
-- Crash safety (the two windows the spec calls out):
--   * "workspace record created → process crash": the row sits in
--     'requested' — a retry of ensureWorkspace returns the SAME row and
--     acquisition re-claims; NO second worktree is created.
--   * "git worktree created → database write crashes": the claim lease
--     (prepare_lease_expires_at) expires and a recovery pass re-claims
--     'preparing'; the worktree identity (worktree_path) is DERIVED
--     DETERMINISTICALLY from (repository, execution) — a re-claim either
--     finds the existing worktree at that path (idempotent re-use, the
--     `git worktree` port detects it) or materializes it cleanly. The
--     path is UNIQUE per execution (a UNIQUE constraint), so an
--     uncontrolled second worktree is impossible.
--
-- No workflow/verification/review mutation. No provider SDKs. No
-- credentials. No tool runtime, permissions, or routing (later work).

-- The (id, project_id) unique constraint the workspace linkage FK needs
-- (0034's identity-tuple unique covers a wider tuple; PostgreSQL requires
-- an EXACT match for composite FKs).
ALTER TABLE wfos_executions
  DROP CONSTRAINT IF EXISTS wfos_executions_id_project_unique;

ALTER TABLE wfos_executions
  ADD CONSTRAINT wfos_executions_id_project_unique
  UNIQUE (id, project_id);

CREATE TABLE IF NOT EXISTS wfos_agent_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The logical execution (the ExecutionRecord's UUID). Exactly one
  -- workspace per execution — never a second execution identity.
  execution_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- The repository environment, via the EXISTING /github authority row.
  project_github_repository_id UUID NOT NULL
    REFERENCES wfos_project_github_repositories(id) ON DELETE CASCADE,
  -- Safe repository coordinates (denormalized from the /github row for
  -- display + the deterministic worktree derivation; NOT credentials).
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  -- The deterministic worktree identity: the absolute-ish path token
  -- under the workspace root, derived from (repository, execution).
  -- UNIQUE: two executions never share a worktree; one execution never
  -- gets two. The concrete materializer resolves it to a host path.
  worktree_path TEXT NOT NULL,
  -- The branch checked out in the worktree (the execution's
  -- implementation branch — existing execution branch semantics).
  branch TEXT NOT NULL,
  -- The immutable base revision the worktree is materialized from
  -- (the branch HEAD at preparation time — reproducibility).
  base_revision TEXT NOT NULL,
  -- Strict state machine.
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN (
    'requested', 'preparing', 'ready', 'released', 'failed', 'cancelled')),
  -- Optimistic-concurrency token for CAS transitions.
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  -- The preparing-claim lease: set when a worker CAS-claims requested →
  -- preparing; a crashed preparer's lease expires and recovery re-claims.
  prepare_lease_expires_at TIMESTAMPTZ,
  -- Where materialization failed (failed rows only; the durable forensic).
  failure_stage TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  CONSTRAINT wfos_agent_workspaces_execution_unique UNIQUE (execution_id),
  CONSTRAINT wfos_agent_workspaces_worktree_path_unique UNIQUE (worktree_path),
  -- Linkage consistency: the workspace's (execution, project) tuple must
  -- match an actual execution row.
  CONSTRAINT wfos_agent_workspaces_execution_project_fkey
    FOREIGN KEY (execution_id, project_id)
    REFERENCES wfos_executions(id, project_id)
    ON DELETE CASCADE
);

-- The pending-work list: workspaces not yet terminal (the recovery sweep
-- + the acquisition queries).
CREATE INDEX IF NOT EXISTS wfos_agent_workspaces_pending_idx
  ON wfos_agent_workspaces (project_id)
  WHERE terminal_at IS NULL;

-- The stale-claim list: preparing rows whose lease has expired.
CREATE INDEX IF NOT EXISTS wfos_agent_workspaces_stale_preparing_idx
  ON wfos_agent_workspaces (prepare_lease_expires_at)
  WHERE state = 'preparing' AND prepare_lease_expires_at IS NOT NULL;

-- updated_at maintenance (version bumps stay owned by the CAS statements).
CREATE OR REPLACE FUNCTION wfos_agent_workspace_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_agent_workspace_touch_trigger ON wfos_agent_workspaces;
CREATE TRIGGER wfos_agent_workspace_touch_trigger
  BEFORE UPDATE ON wfos_agent_workspaces
  FOR EACH ROW EXECUTE FUNCTION wfos_agent_workspace_touch();

-- ---------------------------------------------------------------------------
-- The strict state machine + terminal immutability + identity immutability.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wfos_agent_workspace_transition_guard() RETURNS trigger AS $$
BEGIN
  -- TERMINAL states are FULLY immutable (any authoritative field).
  IF OLD.state IN ('released', 'failed', 'cancelled') THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.worktree_path IS DISTINCT FROM OLD.worktree_path
       OR NEW.branch IS DISTINCT FROM OLD.branch
       OR NEW.base_revision IS DISTINCT FROM OLD.base_revision
       OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.project_github_repository_id IS DISTINCT FROM OLD.project_github_repository_id
       OR NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
       OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
       OR NEW.prepare_lease_expires_at IS DISTINCT FROM OLD.prepare_lease_expires_at
       OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
       OR NEW.released_at IS DISTINCT FROM OLD.released_at
       OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at THEN
      RAISE EXCEPTION
        'agent-workspace-terminal-immutable: workspace % is terminal (%) — no authoritative field may change',
        OLD.id, OLD.state;
    END IF;
    RETURN NEW; -- a no-op update on a terminal row (harmless bookkeeping)
  END IF;

  -- Strict legal edges.
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
         (OLD.state = 'requested' AND NEW.state IN ('preparing', 'cancelled'))
      OR (OLD.state = 'preparing' AND NEW.state IN ('ready', 'failed', 'cancelled'))
      OR (OLD.state = 'ready'      AND NEW.state IN ('released', 'cancelled'))
    ) THEN
      RAISE EXCEPTION
        'agent-workspace-illegal-transition: % -> % is not a legal workspace transition',
        OLD.state, NEW.state;
    END IF;
  END IF;

  -- Identity + worktree identity are immutable (a workspace can never be
  -- re-targeted onto another execution, repository, branch, base, or path).
  IF NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.project_github_repository_id IS DISTINCT FROM OLD.project_github_repository_id
     OR NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
     OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
     OR NEW.worktree_path IS DISTINCT FROM OLD.worktree_path
     OR NEW.branch IS DISTINCT FROM OLD.branch
     OR NEW.base_revision IS DISTINCT FROM OLD.base_revision THEN
    RAISE EXCEPTION
      'agent-workspace-identity-immutable: the workspace identity (execution, project, repository, worktree path, branch, base revision) is immutable — a workspace can never be re-targeted';
  END IF;

  -- version is monotonic.
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION
      'agent-workspace-version-regression: version must not decrease (% -> %)',
      OLD.version, NEW.version;
  END IF;

  -- State/timestamp consistency.
  IF (NEW.state IN ('released', 'failed', 'cancelled')) <> (NEW.terminal_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'agent-workspace-terminal-timestamp: state % requires terminal_at to be %',
      NEW.state,
      CASE WHEN NEW.state IN ('released', 'failed', 'cancelled') THEN 'set' ELSE 'NULL' END;
  END IF;
  IF NEW.state = 'ready' AND NEW.ready_at IS NULL THEN
    RAISE EXCEPTION 'agent-workspace-ready-timestamp: ready state requires ready_at';
  END IF;
  IF NEW.state = 'released' AND NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'agent-workspace-released-timestamp: released state requires released_at';
  END IF;
  -- The preparing lease is set exactly in preparing (recovery re-claims renew it).
  IF (NEW.state = 'preparing') <> (NEW.prepare_lease_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'agent-workspace-prepare-lease: state % requires prepare_lease_expires_at to be %',
      NEW.state,
      CASE WHEN NEW.state = 'preparing' THEN 'set' ELSE 'NULL' END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_agent_workspace_transition_guard_trigger
  ON wfos_agent_workspaces;

CREATE TRIGGER wfos_agent_workspace_transition_guard_trigger
  BEFORE UPDATE ON wfos_agent_workspaces
  FOR EACH ROW EXECUTE FUNCTION wfos_agent_workspace_transition_guard();

-- ---------------------------------------------------------------------------
-- ExecutionRecord terminal → workspace release obligation (the durable
-- cleanup contract — mirrors the WORK-034 terminal-obligation pattern).
-- When an execution reaches a terminal state, a durable release
-- obligation is created ATOMICALLY (same statement): the workspace must
-- be released. The reconciliation (the existing Queue/WorkerHost via the
-- generic OutboxRelay) drives ready → released idempotently.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wfos_agent_workspace_release_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES wfos_agent_workspaces(id) ON DELETE CASCADE,
  discharged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wfos_agent_workspace_release_obligations_unique
    UNIQUE (workspace_id)
);

CREATE INDEX IF NOT EXISTS wfos_agent_workspace_release_obligations_pending_idx
  ON wfos_agent_workspace_release_obligations (workspace_id)
  WHERE discharged_at IS NULL;

-- Append-only intent (only the discharge column may change).
CREATE OR REPLACE FUNCTION wfos_agent_workspace_release_obligation_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'agent-workspace-release-obligation-immutable: release obligations are append-only — never deleted';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'agent-workspace-release-obligation-immutable: the recorded intent is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_agent_workspace_release_obligation_immutable_trigger
  ON wfos_agent_workspace_release_obligations;

CREATE TRIGGER wfos_agent_workspace_release_obligation_immutable_trigger
  BEFORE UPDATE OR DELETE ON wfos_agent_workspace_release_obligations
  FOR EACH ROW EXECUTE FUNCTION wfos_agent_workspace_release_obligation_immutable();

-- The release obligation is created ATOMICALLY with the execution's
-- terminal transition (AFTER UPDATE on wfos_executions — the same pattern
-- as 0035's terminal obligation).
CREATE OR REPLACE FUNCTION wfos_agent_workspace_release_obligation_on_execution_terminal()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('completed', 'failed', 'cancelled', 'expired')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO wfos_agent_workspace_release_obligations (workspace_id)
    SELECT w.id FROM wfos_agent_workspaces w
     WHERE w.execution_id = NEW.id
       AND w.state NOT IN ('released', 'failed', 'cancelled')
    ON CONFLICT (workspace_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_agent_workspace_release_obligation_trigger
  ON wfos_executions;

CREATE TRIGGER wfos_agent_workspace_release_obligation_trigger
  AFTER UPDATE ON wfos_executions
  FOR EACH ROW
  EXECUTE FUNCTION wfos_agent_workspace_release_obligation_on_execution_terminal();
