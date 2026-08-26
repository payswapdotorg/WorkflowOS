-- WORK-042: Cross-Mode Execution Handoff — the append-only mode-transition log.
--
-- ONE logical ExecutionRecord + ONE ExecutionSession + ONE AgentWorkspace are
-- PRESERVED across a cross-mode handoff (native <-> external). This table is
-- the subordinate correction-chain log: exactly ONE handoff row per execution
-- (UNIQUE(execution_record_id) — a second handoff is rejected; a duplicate
-- request with the same idempotency_key converges to the existing row).
--
-- The execution record's `mode`/`status`/`agent_run_id`/`external_session_ref`/
-- `package_json` columns reflect the CURRENT (active) phase; this log's
-- `previous_*` snapshot columns preserve the prior phase's authoritative
-- evidence so the correction chain remains visible ("never replace native
-- failure with external success as though native never happened").
--
-- The log stores NO secrets (previous_package_json is the ExternalExecutionPackage
-- which contains NO secrets per WORK-027). No tokens, no credentials.

CREATE TABLE IF NOT EXISTS wfos_execution_mode_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_record_id UUID NOT NULL REFERENCES wfos_executions(id) ON DELETE CASCADE,
  -- UNIQUE: exactly ONE handoff per execution. A second handoff (different
  -- idempotency_key) is rejected with a 23505 -> the service maps to
  -- 'already-handed-off' (409). A duplicate request with the SAME
  -- idempotency_key converges (the service returns the existing result).
  CONSTRAINT wfos_execution_mode_handoffs_execution_unique UNIQUE (execution_record_id),
  from_mode TEXT NOT NULL CHECK (from_mode IN ('native', 'external')),
  to_mode TEXT NOT NULL CHECK (to_mode IN ('native', 'external')),
  -- A handoff MUST change the mode (no native->native or external->external).
  CONSTRAINT wfos_execution_mode_handoffs_mode_change CHECK (from_mode <> to_mode),
  reason TEXT,
  actor TEXT,
  source TEXT,
  previous_status TEXT NOT NULL,
  resulting_status TEXT NOT NULL,
  -- The prior phase's authoritative evidence snapshot (preserves correction history).
  previous_agent_run_id UUID,
  previous_external_session_ref TEXT,
  previous_package_json JSONB,
  authorized BOOLEAN NOT NULL DEFAULT FALSE,
  policy_decision TEXT,
  idempotency_key TEXT NOT NULL,
  CONSTRAINT wfos_execution_mode_handoffs_idempotency_unique UNIQUE (idempotency_key),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_mode_handoffs_execution
  ON wfos_execution_mode_handoffs(execution_record_id, created_at DESC);

-- Append-only: the handoff log is immutable history (no UPDATE/DELETE).
CREATE OR REPLACE FUNCTION wfos_execution_mode_handoff_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'execution-mode-handoff-immutable: the handoff log is append-only history (no UPDATE/DELETE on wfos_execution_mode_handoffs)';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_mode_handoff_immutable_trigger ON wfos_execution_mode_handoffs;
CREATE TRIGGER wfos_execution_mode_handoff_immutable_trigger
  BEFORE UPDATE OR DELETE ON wfos_execution_mode_handoffs
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_mode_handoff_immutable();
