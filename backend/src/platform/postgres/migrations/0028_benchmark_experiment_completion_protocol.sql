-- WORK-032 PR #36 review fix #2: experiment completion protocol.
--
-- PR #36 review found that `claimExperimentCompletion()` changed the
-- experiment to `completed` BEFORE integrity validation ran. If validation
-- then failed, WorkflowOS had already exposed a false successful completion
-- (the experiment row read `completed` + the BENCHMARK_COMPLETED audit had
-- already been written). The `completed` status MUST NOT become
-- authoritative until integrity passes.
--
-- The fix is a two-phase reservation/finalization protocol that preserves
-- the exactly-once behavior of the original CAS (two concurrent workers
-- cannot both run integrity validation) WITHOUT making `completed`
-- authoritative until integrity passes:
--
--   Phase 1 — RESERVATION (exactly-once CAS):
--     claimExperimentCompletion(): running → finalizing
--     Only the worker that wins (RETURNING row) may proceed to validation.
--     The loser (null) no-ops (a duplicate checkExperimentCompletion that
--     loses the race skips validation + audit entirely).
--
--   Phase 2 — INTEGRITY VALIDATION (winner only):
--     integrityService.validate(experimentId)
--     Returns a BenchmarkIntegrityRecord { valid: boolean }.
--
--   Phase 3 — FINALIZATION (CAS, makes the status authoritative):
--     validate.valid === true  → finalizeExperimentCompletion(): finalizing → completed
--                                + audit BENCHMARK_COMPLETED
--     validate.valid === false → finalizeExperimentInvalidation(): finalizing → invalidated
--                                + audit BENCHMARK_INVALIDATED
--
-- The `finalizing` status is the reservation state. It is non-terminal
-- (checkExperimentCompletion's all-terminal guard treats `finalizing` as
-- not-yet-terminal, so no second worker re-enters the protocol while the
-- winner is validating). It is distinct from `running` so the reservation
-- CAS (WHERE status='running') cannot be won twice. And it is distinct
-- from `completed`/`invalidated` so the authoritative terminal state is
-- only set AFTER integrity passes/fails.
--
-- This migration adds `finalizing` to the experiment status CHECK (the
-- constraint was created inline in migration 0025 as
-- `wfos_benchmark_experiments_status_check`). The drop+re-add is idempotent
-- (IF EXISTS) so re-running the migration is safe. No backfill is needed
-- — no existing experiment can be in `finalizing` (the status is new).

ALTER TABLE wfos_benchmark_experiments
  DROP CONSTRAINT IF EXISTS wfos_benchmark_experiments_status_check;

ALTER TABLE wfos_benchmark_experiments
  ADD CONSTRAINT wfos_benchmark_experiments_status_check
  CHECK (status IN (
    'created',
    'running',
    'paused',
    'finalizing',
    'completed',
    'cancelled',
    'invalidated'
  ));
