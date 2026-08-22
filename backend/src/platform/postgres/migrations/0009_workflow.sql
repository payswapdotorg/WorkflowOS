-- WORK-009 schema: canonical workflow state machine (WORKFLOW-001..005).
--
-- /workflows owns canonical workflow state. No other module may mutate it.
-- PostgreSQL is authoritative (§28). Concurrency safety via row locking +
-- optimistic versioning. Transition history is append-only.

-- ---------------------------------------------------------------------------
-- Workflow executions (one per work item). Stores the current canonical
-- workflow state + a version column for optimistic concurrency.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_workflow_executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id    UUID NOT NULL UNIQUE REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  -- Canonical workflow state (frozen architecture §13).
  current_state   TEXT NOT NULL DEFAULT 'draft',
  -- Optimistic concurrency version — incremented on every transition.
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wfos_workflow_executions
  DROP CONSTRAINT IF EXISTS wfos_workflow_executions_state_check;
ALTER TABLE wfos_workflow_executions
  ADD CONSTRAINT wfos_workflow_executions_state_check
  CHECK (current_state IN (
    'draft', 'ready', 'assigned', 'implementing', 'pr_open',
    'verifying', 'verification_failed', 'architect_review',
    'changes_requested', 'architecture_change_required',
    'architecture_change_request', 'implementation_blocked',
    'approved', 'merged', 'verified'
  ));

-- ---------------------------------------------------------------------------
-- Workflow transition history (append-only). Each transition records
-- previous state, new state, actor, reason, execution id, and timestamp.
-- A later transition must not erase earlier history.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_workflow_transitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_execution_id UUID NOT NULL REFERENCES wfos_workflow_executions(id) ON DELETE CASCADE,
  work_item_id    UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  from_state      TEXT NOT NULL,
  to_state        TEXT NOT NULL,
  -- Transition type/reason (e.g. 'implementation_complete', 'verification_failed').
  transition_type TEXT,
  -- Actor/source (user id, 'system', 'github-webhook', etc.).
  actor           TEXT,
  -- Execution/correlation ID when available.
  execution_id    TEXT,
  -- Idempotency key — duplicate requests with the same key are no-ops.
  idempotency_key TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wfos_workflow_transitions_execution_idx
  ON wfos_workflow_transitions (workflow_execution_id);
CREATE INDEX wfos_workflow_transitions_work_item_idx
  ON wfos_workflow_transitions (work_item_id);
CREATE INDEX wfos_workflow_transitions_idempotency_idx
  ON wfos_workflow_transitions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
