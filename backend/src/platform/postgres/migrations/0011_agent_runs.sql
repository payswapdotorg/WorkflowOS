-- WORK-012 schema: Agent Gateway — Agent Run records (AGENT-001, AGENT-002).
--
-- /agents owns the Agent Gateway + Agent Runs. Provider-specific code stays
-- inside /agents internal/. Credentials via SecretStore (SEC-001). Large
-- outputs via ObjectStore (DATA-003). PostgreSQL is authoritative (§28).
-- Agent execution is asynchronous via the existing WORK-001 WorkerHost.

CREATE TABLE wfos_agent_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id    TEXT NOT NULL UNIQUE,
  work_item_id    UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  work_order_id   UUID NOT NULL REFERENCES wfos_work_orders(id) ON DELETE CASCADE,
  architecture_version_id UUID REFERENCES wfos_architecture_versions(id) ON DELETE SET NULL,
  -- Provider + configuration (provider-independent).
  provider        TEXT NOT NULL,
  configuration   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Repository context.
  repository_ref  TEXT,
  branch          TEXT,
  -- Execution status.
  status          TEXT NOT NULL DEFAULT 'pending',
  -- Agent output (normalized, provider-independent).
  output          TEXT,
  -- Large output may use object storage; this is the storage_key reference.
  output_storage_key TEXT,
  output_storage_provider TEXT,
  -- Reported commit + PR reference.
  commit_ref      TEXT,
  pull_request_ref TEXT,
  -- Reported tests + blockers.
  reported_tests  JSONB NOT NULL DEFAULT '[]'::jsonb,
  reported_blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Execution metadata.
  execution_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Error classification (when failed).
  error_type      TEXT,
  error_message   TEXT,
  -- Retry metadata.
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  -- Timestamps.
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wfos_agent_runs
  DROP CONSTRAINT IF EXISTS wfos_agent_runs_status_check;
ALTER TABLE wfos_agent_runs
  ADD CONSTRAINT wfos_agent_runs_status_check
  CHECK (status IN ('pending', 'in_progress', 'success', 'failed', 'cancelled'));

ALTER TABLE wfos_agent_runs
  DROP CONSTRAINT IF EXISTS wfos_agent_runs_error_type_check;
ALTER TABLE wfos_agent_runs
  ADD CONSTRAINT wfos_agent_runs_error_type_check
  CHECK (error_type IS NULL OR error_type IN (
    'retryable', 'non_retryable', 'authentication', 'rate_limit',
    'invalid_request', 'provider_unavailable', 'execution_failed',
    'blocked', 'cancelled', 'unknown'
  ));

CREATE INDEX wfos_agent_runs_work_item_idx ON wfos_agent_runs (work_item_id);
CREATE INDEX wfos_agent_runs_execution_id_idx ON wfos_agent_runs (execution_id);
CREATE INDEX wfos_agent_runs_status_idx ON wfos_agent_runs (status);
CREATE INDEX wfos_agent_runs_provider_idx ON wfos_agent_runs (provider);

-- ---------------------------------------------------------------------------
-- Work Order integrity trigger (architect review PR #12).
-- Ensures the work_order_id belongs to the same work_item_id. A work order
-- from a different work item / project is rejected at the persistence level.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_check_agent_run_work_order_integrity()
RETURNS TRIGGER AS $$
DECLARE
  wo_work_item_id UUID;
BEGIN
  SELECT work_item_id INTO wo_work_item_id
    FROM wfos_work_orders WHERE id = NEW.work_order_id;
  IF wo_work_item_id IS NULL THEN
    RAISE EXCEPTION 'agent run integrity: work order % not found', NEW.work_order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF wo_work_item_id <> NEW.work_item_id THEN
    RAISE EXCEPTION 'agent run integrity: work order % belongs to work item %, not %',
      NEW.work_order_id, wo_work_item_id, NEW.work_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_agent_runs_work_order_integrity_check
  ON wfos_agent_runs;
CREATE TRIGGER wfos_agent_runs_work_order_integrity_check
  BEFORE INSERT OR UPDATE ON wfos_agent_runs
  FOR EACH ROW EXECUTE FUNCTION wfos_check_agent_run_work_order_integrity();
