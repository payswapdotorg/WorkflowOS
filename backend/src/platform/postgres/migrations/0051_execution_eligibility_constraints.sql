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
--                   DERIVED from the authoritative records at evaluation
--                   time — there is deliberately NO parallel usage ledger
--                   (no dual-write, no drift; the existing ledgers ARE the
--                   usage source of truth).
--   RATE LIMITS   — rate_limit_max_requests per rate_limit_window_seconds
--                   sliding window, evaluated PER PROVIDER over the
--                   DISPATCHES within the trailing window.
--
-- The usage derivation (AR-043-01 + AR-043-02) applies the DISPATCH
-- PREDICATE over the EXISTING authoritative records — usage never counts
-- mere execution-row existence:
--
--     dispatched(e) :=
--       EXISTS (SELECT 1 FROM wfos_agent_runs r
--                WHERE r.execution_id = e.execution_id)
--       OR e.package_json IS NOT NULL
--
--   - NATIVE arm: wfos_agent_runs IS the durable native provider-operation
--     ledger (PR #46 round 8) — the AgentGateway creates the run row BEFORE
--     invoking the adapter, so a run row exists IFF the native provider
--     dispatch actually initiated (a FAILED run still dispatched; a
--     pre-dispatch rejection leaves no run row).
--   - EXTERNAL arm: package_json IS the external dispatch artifact — it is
--     persisted ONLY after ExternalExecutionProvider.submit() succeeded
--     (the handoff_ready outcome write / the fenced cross-mode dispatch
--     completion); a rejected-before-dispatch attempt leaves it NULL.
--
-- AR-043-02 — the two usage models are DISTINCT (the unit differs):
--
--   QUOTA usage        = LOGICAL EXECUTIONS — ONE per execution row that
--                        dispatched (project-wide; the
--                        max_executions_per_month/day unit). A cross-mode
--                        handed-off execution is ONE logical execution →
--                        ONE unit of quota.
--   RATE-LIMIT usage   = PROVIDER DISPATCH EVENTS — each ACTUAL dispatch
--                        attributed to the provider that dispatched it
--                        (the rate_limit_max_requests unit, per sliding
--                        window): the AgentRun row's OWN provider (native
--                        — immutable) + the package artifact's OWN
--                        provider field (external — ExternalExecution-
--                        Package is self-describing), including a handed-
--                        off-away external phase's snapshot in the
--                        append-only wfos_execution_mode_handoffs log.
--                        A cross-mode handed-off execution contributes ONE
--                        event to EACH provider that dispatched.
--
-- AR-043-03 — each rate-limit event is gated by ITS OWN AUTHORITATIVE
-- dispatch timestamp, never a reservation timestamp:
--
--   native event      → wfos_agent_runs.created_at (the run row is created
--                       immediately BEFORE the adapter invocation)
--   external event    → ExternalExecutionPackage.dispatchedAt — stamped by
--                       the provider at the dispatch initiation, carried by
--                       the package artifact into package_json, and
--                       PRESERVED by the append-only handoff log's
--                       previous_package_json snapshot when the external
--                       phase is handed off away
--
-- The execution row's created_at and the handoff log row's created_at are
-- RESERVATION timestamps: the sequence reserve → wait/scheduling gap →
-- submit → package persisted means both can precede the actual dispatch by
-- an arbitrary amount. Gating the window on them mis-times boundary events
-- (a dispatch 10 seconds ago counted at a 2-minute-old reservation time
-- falls out of the window; the inverse admits stale dispatches).
--
-- AR-043-03 (the timestamp's IMMUTABILITY — the preservation invariants):
-- the dispatchedAt value is the FIRST dispatch's stamp for the whole life
-- of the operation. The keyed (cross-mode) dispatch path stores the settled
-- submission (package + dispatchedAt) in the durable provider-operation
-- ledger, and every later same-key submit REPLAYS that stored package
-- verbatim — the reclaiming owner's re-dispatch after a lease expiry, the
-- idempotent post-completion replay, and the duplicate handoff call (which
-- never re-dispatches at all) can NEVER re-stamp it; a stale owner's late
-- completion is discarded by the dispatch-gate CAS (0 rows — no outcome
-- write). The handoff snapshot copies the package WHOLESALE, so a handed-
-- off-away external phase keeps its original dispatch time in the
-- append-only log. ONE authoritative dispatch event; NO parallel usage
-- ledger — the existing artifacts' exactly-once behavior IS the
-- preservation mechanism.
--
-- created execution without dispatch        → NOT counted (either model)
-- rejected before dispatch                  → NOT counted (either model)
-- actual provider dispatch                  → quota: once per LOGICAL
--                                              execution; rate: once per
--                                              PROVIDER (the dispatching
--                                              provider's own window, at
--                                              the event's OWN time)
--
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
-- The usage queries (the quota count over wfos_executions + the dispatch
-- predicate probe — wfos_agent_runs.execution_id carries its own UNIQUE
-- index, package_json is a direct column test; the rate count over the
-- same records + the append-only handoff log, attributed per artifact)
-- get a covering index on the driving columns — every eligibility
-- evaluation (recommendation AND the WORK-042 handoff destination gate)
-- runs them against the trailing window / quota periods.

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
