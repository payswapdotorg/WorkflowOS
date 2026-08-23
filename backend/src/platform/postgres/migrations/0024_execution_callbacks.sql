-- WORK-027 (PR #30 review fix #2): scoped execution callback credentials.
--
-- The ExternalExecutionPackage's returnCallback instructs the future
-- Companion extension to POST execution events with a CALLBACK TOKEN — never
-- the user's general WorkflowOS API key. Callback tokens are:
--   - scoped to EXACTLY ONE execution (execution_record_id) and to event
--     ingestion ONLY (only the POST /execution/:id/events route reads them),
--   - short-lived (expires_at, capped at the execution's handoff window),
--   - multi-use by design (started → progress → completed are separate
--     events; idempotency is enforced per-event via idempotencyKey in
--     wfos_execution_events),
--   - stored as a SHA-256 hash (the raw token is returned exactly once at
--     preparation time and never logged),
--   - unable to read projects, read packages, mutate workflow/verification/
--     review state, or perform any other project operation — no other route
--     consumes x-callback-token.

CREATE TABLE IF NOT EXISTS wfos_execution_callbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_record_id UUID NOT NULL REFERENCES wfos_executions(id) ON DELETE CASCADE,
  -- SHA-256 hex of the raw callback token (prefix wfct_). Never the raw value.
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_callbacks_record
  ON wfos_execution_callbacks(execution_record_id, created_at DESC);
