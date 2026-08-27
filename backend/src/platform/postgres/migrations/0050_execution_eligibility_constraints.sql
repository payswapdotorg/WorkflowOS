-- WORK-043 — Execution Eligibility and Constraint Engine (§33.3).
--
-- The execution-policy layer is an APPLICATION-LAYER ORCHESTRATOR (mirrors
-- the §34 benchmark pattern): it lives at src/execution-policy/ OUTSIDE the
-- 17 frozen modules, consumes @modules/* public barrels + @platform/*, NEVER
-- mutates workflow state, NEVER stores credentials, and NEVER invents
-- provider capabilities.
--
-- This migration adds the §33.3 constraint families the eligibility engine
-- evaluates BEFORE performance ranking (spec/work-items.md WORK-043):
--
--   QUOTA         — max_executions_per_month / max_executions_per_day
--                   (project-wide period quotas; NULL = unlimited). Usage is
--                   DERIVED from the authoritative wfos_executions rows at
--                   evaluation time — there is deliberately NO parallel
--                   usage ledger (no dual-write, no drift; the executions
--                   table IS the usage source of truth).
--   RATE LIMITS   — rate_limit_max_requests per rate_limit_window_seconds
--                   sliding window, evaluated PER PROVIDER (dispatch counts
--                   from wfos_executions within the trailing window).
--   SECURITY      — security_classification (the project's data
--                   classification) + external_security_ceiling (the maximum
--                   classification EXTERNAL execution may carry; NULL = no
--                   restriction beyond the existing privacy constraints).
--                   The ladder is standard < confidential < restricted.
--
-- Quotas, rate limits, and security classifications are ELIGIBILITY INPUTS
-- (§33.3) — never quality scores. They hard-block candidates; they never
-- participate in ranking.
--
-- The rate-limit usage query (provider + created_at over wfos_executions)
-- gets a covering index — every eligibility evaluation (recommendation AND
-- the WORK-042 handoff destination gate) runs it against the trailing
-- window.

-- ============================================================================
-- §33.3 quota + rate-limit + security columns on the project policy
-- ============================================================================
ALTER TABLE wfos_execution_policies
  ADD COLUMN IF NOT EXISTS max_executions_per_month INTEGER,
  ADD COLUMN IF NOT EXISTS max_executions_per_day INTEGER,
  ADD COLUMN IF NOT EXISTS rate_limit_max_requests INTEGER,
  ADD COLUMN IF NOT EXISTS rate_limit_window_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS security_classification TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS external_security_ceiling TEXT;

ALTER TABLE wfos_execution_policies
  DROP CONSTRAINT IF EXISTS wfos_execution_policy_quota_nonnegative;
ALTER TABLE wfos_execution_policies
  ADD CONSTRAINT wfos_execution_policy_quota_nonnegative
  CHECK (
    (max_executions_per_month IS NULL OR max_executions_per_month >= 0)
    AND (max_executions_per_day IS NULL OR max_executions_per_day >= 0)
    AND (rate_limit_max_requests IS NULL OR rate_limit_max_requests >= 0)
  );

-- A rate limit carries BOTH halves (max requests AND a positive window) or
-- NEITHER — the same "constrained mode requires its cap" semantics as
-- migration 0033: a labeled constraint without the data to evaluate it is
-- meaningless and must not persist.
ALTER TABLE wfos_execution_policies
  DROP CONSTRAINT IF EXISTS wfos_execution_policy_rate_limit_requires_window;
ALTER TABLE wfos_execution_policies
  ADD CONSTRAINT wfos_execution_policy_rate_limit_requires_window
  CHECK (
    (rate_limit_max_requests IS NULL AND rate_limit_window_seconds IS NULL)
    OR (rate_limit_max_requests IS NOT NULL AND rate_limit_window_seconds IS NOT NULL
        AND rate_limit_window_seconds > 0)
  );

-- The classification ladder is closed: standard < confidential < restricted.
ALTER TABLE wfos_execution_policies
  DROP CONSTRAINT IF EXISTS wfos_execution_policy_security_classification_valid;
ALTER TABLE wfos_execution_policies
  ADD CONSTRAINT wfos_execution_policy_security_classification_valid
  CHECK (
    security_classification IN ('standard', 'confidential', 'restricted')
    AND (external_security_ceiling IS NULL
         OR external_security_ceiling IN ('standard', 'confidential', 'restricted'))
  );

-- ============================================================================
-- The usage-derivation index (quota periods + rate-limit windows read
-- wfos_executions by (project, provider, created_at))
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_executions_project_provider_created
  ON wfos_executions(project_id, provider, created_at DESC);
