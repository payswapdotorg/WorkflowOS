-- WORK-033 / PR #37 review fix (final correction): constrained benchmark
-- modes must be MEANINGFUL — a mode is not allowed to persist while its
-- constraint is absent.
--
-- The previous fixes made eligibility FAIL CLOSED when a cap is active and
-- the evidence is unknown. But the system could still persist + return:
--
--     benchmarkMode = COST_CONSTRAINED  with maxCostCents    = NULL
--     benchmarkMode = LATENCY_CONSTRAINED with maxDurationMs = NULL
--
-- In both cases the fail-closed logic correctly does NOTHING (no active
-- cap) — the policy is labeled constrained while imposing no constraint,
-- which violates the meaning of the benchmark modes (§8).
--
-- The invariant is enforced at the POLICY BOUNDARY — the database row
-- itself must be semantically valid, so no application path (the service,
-- the route, a future CLI, manual SQL) can persist a meaningless
-- combination:
--
--   COST_CONSTRAINED    → requires max_cost_per_task_cents IS NOT NULL
--   LATENCY_CONSTRAINED → requires max_time_to_pr_ms       IS NOT NULL
--
-- The CHECK is symmetric — it also rejects REMOVING the cap while the mode
-- stays constrained (the row as a whole is validated on every write).
--
-- Safe to add without NOT VALID: the wfos_execution_policies table was
-- created in migration 0026 (this same PR — no deployment exists with
-- rows), and the default policy (maximum_capability + NULL caps) is valid
-- under the constraint. The service layer additionally validates BEFORE
-- the write (a clear domain error instead of a raw constraint violation)
-- and validates the RESOLVED mode at recommendation time (an explicit
-- ?benchmarkMode= request against a capless project is rejected rather
-- than silently producing an unconstrained-but-labeled-constrained
-- snapshot).

ALTER TABLE wfos_execution_policies
  DROP CONSTRAINT IF EXISTS wfos_execution_policy_constrained_mode_requires_cap;

ALTER TABLE wfos_execution_policies
  ADD CONSTRAINT wfos_execution_policy_constrained_mode_requires_cap
  CHECK (
    (default_benchmark_mode <> 'cost_constrained' OR max_cost_per_task_cents IS NOT NULL)
    AND
    (default_benchmark_mode <> 'latency_constrained' OR max_time_to_pr_ms IS NOT NULL)
  );
