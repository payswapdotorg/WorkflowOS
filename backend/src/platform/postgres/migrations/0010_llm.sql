-- WORK-010 schema: LLM Gateway — execution/usage records (LLM-001..005).
--
-- /llm owns the LLM Gateway: provider selection, model selection, request/response
-- normalization, retries, usage recording, error handling. Provider-specific
-- SDK code stays inside /llm internal/. Credentials via SecretStore (SEC-001).
-- PostgreSQL is authoritative (§28).

-- ---------------------------------------------------------------------------
-- LLM execution records (LLM-003). Each record tracks a single LLM request
-- lifecycle including retries. Provider-specific details stay in metadata;
-- core fields are provider-independent.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_llm_execution_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Provider-independent execution/correlation ID.
  execution_id    TEXT NOT NULL UNIQUE,
  -- Optional Work Item reference (when the LLM call is work-item-scoped).
  work_item_id    UUID REFERENCES wfos_work_items(id) ON DELETE SET NULL,
  -- Provider + model (normalized, not SDK-specific).
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  -- Request metadata (system instruction hash, message count, etc. — NOT raw credentials).
  request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Response content (the generated text / structured output).
  response_content TEXT,
  -- Usage metadata (token counts, cost — provider-normalized).
  usage_metadata  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Execution status.
  status          TEXT NOT NULL DEFAULT 'pending',
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

ALTER TABLE wfos_llm_execution_records
  DROP CONSTRAINT IF EXISTS wfos_llm_exec_status_check;
ALTER TABLE wfos_llm_execution_records
  ADD CONSTRAINT wfos_llm_exec_status_check
  CHECK (status IN ('pending', 'in_progress', 'success', 'failed'));

ALTER TABLE wfos_llm_execution_records
  DROP CONSTRAINT IF EXISTS wfos_llm_exec_error_type_check;
ALTER TABLE wfos_llm_execution_records
  ADD CONSTRAINT wfos_llm_exec_error_type_check
  CHECK (error_type IS NULL OR error_type IN (
    'retryable', 'non_retryable', 'authentication', 'rate_limit',
    'invalid_request', 'provider_unavailable', 'unknown'
  ));

CREATE INDEX wfos_llm_exec_work_item_idx ON wfos_llm_execution_records (work_item_id);
CREATE INDEX wfos_llm_exec_provider_idx ON wfos_llm_execution_records (provider);
CREATE INDEX wfos_llm_exec_status_idx ON wfos_llm_execution_records (status);
