-- WORK-032 PR #35 follow-up: benchmark trial idempotency / concurrency fix.
--
-- PR #35 (already merged) introduced the event-driven async trial lifecycle
-- (Blocker A + Blocker B). The event hooks (`onExecutionTerminal` on the
-- ingestion service + `onTransition` on the workflow engine) legitimately
-- cause multiple `benchmark.trial` advancement jobs to exist close together
-- — redelivery + concurrent worker races are EXPECTED, not exceptional.
--
-- However the lifecycle was NOT idempotent at two boundaries:
--
--   1. queued → running CLAIM race: the orchestrator's first update was
--      `UPDATE wfos_benchmark_trials SET status='running' WHERE id=$1`
--      (NO `AND status='queued'` guard). Two deliveries of the same
--      `benchmark.trial` job both observed `queued`, both passed the
--      update, and both proceeded to clone / branch / submit — producing
--      DUPLICATE logical executions against the same trial.
--
--   2. running → terminal FINALIZATION race: `finalizeTrial()` did an
--      unconditional `UPDATE ... SET status='completed'|'failed' WHERE id=$1`.
--      Two terminal-advancement jobs both finalized the same trial and both
--      collected metrics + inserted findings + wrote audit events.
--      `upsertMetrics()` is protected by the trial_id PK, but
--      `insertFinding()` is a plain INSERT and `auditService.write()` is
--      append-only — so duplicate jobs produced DUPLICATE findings + audit.
--
-- This migration introduces an EXPLICIT, PERSISTED phase lifecycle so that
-- duplicate job delivery observes an already-claimed / already-advanced state
-- and produces NO side effects (the invariant the review requires):
--
--   queued → starting → execution_wait → delivery_wait → completed | failed
--
-- Each transition is a COMPARE-AND-SWAP owned by the benchmark application
-- layer (WHERE id=$1 AND lifecycle_phase=$expected). Only the worker that
-- receives a RETURNING row may perform the side effects for that phase. A
-- duplicate delivery observes the advanced phase + no-ops.
--
-- The existing `status` column semantics are PRESERVED for backward
-- compatibility (existing queries, UIs, the recommendation service's cell
-- statistics, the §30 failure_kind taxonomy all read `status`). The
-- `lifecycle_phase` column is a STRICTER companion that the benchmark
-- application layer uses for concurrency control.
--
-- CRITICAL — the two columns are NOT a "dual-state model" left to the
-- application layer to keep aligned. The canonical relationship is
-- MECHANICALLY ENFORCED at the persistence boundary by the
-- `wfos_benchmark_trials_status_phase_invariant` CHECK constraint added
-- below (after the backfill, so existing rows are canonical first). The DB
-- physically REJECTS any divergent pair such as
--   (status='running', lifecycle_phase='completed')
--   (status='failed',    lifecycle_phase='delivery_wait')
-- so the race cannot move into a subtle state-divergence problem. The
-- application layer still updates both columns in the same statement (so
-- the CHECK never fires in normal operation), but the CHECK is the
-- mechanical guarantee that a future code path cannot silently introduce a
-- divergent row. Canonical mapping:
--   lifecycle_phase='queued'         → status='queued'
--   lifecycle_phase='starting'        → status='running'
--   lifecycle_phase='execution_wait' → status='running'
--   lifecycle_phase='delivery_wait'   → status='running'
--   lifecycle_phase='completed'      → status='completed'
--   lifecycle_phase='failed'         → status IN ('failed','unavailable')
-- (the 'unavailable' high-level status is the one legacy pairing: it is a
-- terminal configuration-unavailability marker produced by a pre-flight,
-- never by a CAS path; the backfill below maps it to lifecycle_phase='failed'
-- and the invariant allows that exact pair.)
--
-- This is NOT a second execution engine (§34 invariant preserved): the
-- benchmark still consumes ExecutionService (owned by /agents) and reads
-- authoritative workflow / verification / review state. The phase column is
-- bookkeeping for exactly-once logical execution, not a new orchestration
-- authority.

ALTER TABLE wfos_benchmark_trials
  ADD COLUMN IF NOT EXISTS lifecycle_phase TEXT NOT NULL DEFAULT 'queued'
  CHECK (lifecycle_phase IN (
    'queued',
    'starting',
    'execution_wait',
    'delivery_wait',
    'completed',
    'failed'
  ));

-- Backfill: existing rows map their current `status` to the closest phase.
--   queued      → queued
--   completed   → completed
--   failed      → failed
--   unavailable → failed           (terminal configuration failure)
--
--   running     → MODE-DEPENDENT (PR #36 review fix #1):
--     native    → delivery_wait     (native execution is synchronous-completed
--                                    by the orchestrator — a `running` native
--                                    trial has ALREADY submitted + is awaiting
--                                    the verified workflow delivery, NOT
--                                    awaiting external execution completion.
--                                    Backfilling it to execution_wait would
--                                    misclassify it as still-external-pending,
--                                    so runTrialJob would re-read a non-existent
--                                    execution record + finalize it as
--                                    'execution-record-not-found'.)
--     external  → execution_wait   (external execution is async — the
--                                    orchestrator advanced starting →
--                                    execution_wait + is awaiting the
--                                    onExecutionTerminal ingestion hook. A
--                                    `running` external trial IS genuinely
--                                    awaiting external execution completion.)
UPDATE wfos_benchmark_trials SET lifecycle_phase = 'queued'
  WHERE status = 'queued' AND lifecycle_phase = 'queued';
UPDATE wfos_benchmark_trials SET lifecycle_phase = 'delivery_wait'
  WHERE status = 'running' AND execution_mode = 'native' AND lifecycle_phase = 'queued';
UPDATE wfos_benchmark_trials SET lifecycle_phase = 'execution_wait'
  WHERE status = 'running' AND execution_mode = 'external' AND lifecycle_phase = 'queued';
UPDATE wfos_benchmark_trials SET lifecycle_phase = 'completed'
  WHERE status = 'completed' AND lifecycle_phase = 'queued';
UPDATE wfos_benchmark_trials SET lifecycle_phase = 'failed'
  WHERE status IN ('failed', 'unavailable') AND lifecycle_phase = 'queued';

-- MECHANICAL INVARIANT between `status` and `lifecycle_phase`. Added AFTER
-- the backfill so every existing row is already canonical — otherwise the
-- ADD would reject the pre-backfill divergent rows. This is the guarantee
-- that the two columns can NEVER diverge: the DB itself rejects a write
-- that sets e.g. lifecycle_phase='completed' while leaving status='running'.
-- The application-layer CAS paths update both columns in the same statement
-- and so never trip this constraint in normal operation; the CHECK exists so
-- a future buggy code path (a raw UPDATE touching only one column, a trigger,
-- a manual fixup) cannot silently introduce a divergent row that the
-- concurrency model does not know how to route.
ALTER TABLE wfos_benchmark_trials
  ADD CONSTRAINT wfos_benchmark_trials_status_phase_invariant
  CHECK (
       (lifecycle_phase = 'queued'         AND status = 'queued')
    OR (lifecycle_phase = 'starting'       AND status = 'running')
    OR (lifecycle_phase = 'execution_wait' AND status = 'running')
    OR (lifecycle_phase = 'delivery_wait'  AND status = 'running')
    OR (lifecycle_phase = 'completed'      AND status = 'completed')
    OR (lifecycle_phase = 'failed'         AND status IN ('failed','unavailable'))
  );

-- Index for the experiment-completion check (listTrials + every-terminal
-- filter) + the phase-routing state machine in runTrialJob.
CREATE INDEX IF NOT EXISTS idx_benchmark_trials_lifecycle
  ON wfos_benchmark_trials(experiment_id, lifecycle_phase);
