-- WORK-017 schema: Workflow convergence / automated execution loop.
--
-- The /workflows module owns the convergence orchestration layer that connects
-- the existing Work Item, Work Order, Agent Run, GitHub, Verification, and
-- Architect Review contracts into the canonical implementation loop.
--
-- This table tracks convergence signals — provider-independent application
-- signals representing domain events that need workflow action (e.g.
-- "agent run completed", "verification completed", "review finalized").
--
-- PostgreSQL is authoritative (frozen architecture §28). Redis is transport/
-- coordination only. A pending convergence step is reconstructable from
-- persisted signals + workflow state (worker recovery).
--
-- Idempotency (frozen architecture §13, §22, invariant #16):
--   UNIQUE(work_item_id, signal_type, source_event_id) ensures a duplicate
--   signal delivery produces ONE signal row, not duplicates. The signal's
--   idempotency_key is also passed to WorkflowEngine.transition() so the
--   resulting workflow transition is idempotent too.

CREATE TABLE wfos_convergence_signals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping (project the signal belongs to, resolved from the work item).
  project_id        UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  work_item_id      UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  -- Signal type: 'initiate' | 'agent_run_completed' | 'pull_request_merged' |
  --              'verification_completed' | 'review_finalized'
  signal_type       TEXT NOT NULL,
  -- Stable id from the source domain event (e.g. agent run execution ID,
  -- verification run ID, review ID). Used with signal_type for idempotency.
  source_event_id   TEXT NOT NULL,
  -- Idempotency key passed to WorkflowEngine.transition(). Derived from
  -- work_item_id + signal_type + source_event_id. Scoped per work item.
  idempotency_key   TEXT NOT NULL,
  -- Processing state: 'pending' → 'processed' (or 'failed').
  processing_state  TEXT NOT NULL DEFAULT 'pending',
  -- The workflow state the signal led to (NULL if not yet processed or
  -- if the signal was a no-op).
  result_state      TEXT,
  -- Error message if processing failed.
  error_message     TEXT,
  -- Structured signal payload (provider-independent, domain-specific fields).
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Execution/correlation ID (architecture §35).
  execution_id      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency: one signal row per (work_item_id, signal_type, source_event_id).
  CONSTRAINT wfos_convergence_signals_idempotency_uniq
    UNIQUE (work_item_id, signal_type, source_event_id)
);

ALTER TABLE wfos_convergence_signals
  DROP CONSTRAINT IF EXISTS wfos_convergence_signals_state_check;
ALTER TABLE wfos_convergence_signals
  ADD CONSTRAINT wfos_convergence_signals_state_check
  CHECK (processing_state IN ('pending', 'processed', 'failed'));

CREATE INDEX wfos_convergence_signals_work_item_idx ON wfos_convergence_signals (work_item_id);
CREATE INDEX wfos_convergence_signals_project_idx ON wfos_convergence_signals (project_id);
CREATE INDEX wfos_convergence_signals_state_idx ON wfos_convergence_signals (processing_state);

-- updated_at trigger (consistent with the rest of the codebase).
CREATE OR REPLACE FUNCTION wfos_convergence_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_convergence_signals_set_updated_at ON wfos_convergence_signals;
CREATE TRIGGER wfos_convergence_signals_set_updated_at
  BEFORE UPDATE ON wfos_convergence_signals
  FOR EACH ROW EXECUTE FUNCTION wfos_convergence_set_updated_at();
