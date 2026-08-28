-- WORK-051 round 1 (PR #52 review, BLOCKER 4) — the durable orchestration-run
-- identity owned by /verification.
--
-- The checkpoint subsystem advertises idempotent replay per logical
-- idempotency key, but the previous implementation searched run METADATA
-- after listing runs (read → create, no durable uniqueness). Two concurrent
-- callers with the same (work item, checkpoint kind, revision, idempotency
-- key) could both execute detectors and create separate verification runs.
--
-- /verification owns the fix at its own boundary: a first-class
-- `orchestration_key` column with a UNIQUE partial index. The identity is a
-- server-side /verification invariant — one orchestration run per key — and
-- the create-or-converge operation (INSERT ... ON CONFLICT DO NOTHING) makes
-- concurrent callers converge on the single run. NO second evidence store is
-- introduced: checkpoint evidence continues to live exclusively in
-- wfos_verification_runs + wfos_evidence.
--
-- The key is namespaced by construction (e.g.
-- "<workItemId>:checkpoint:<kind>:<sourceEventId>"), which makes it globally
-- unique across orchestration producers; the UNIQUE index enforces exactly
-- that. Runs created without an orchestration key (every pre-existing
-- createRun caller) store NULL and are exempt from the constraint (partial
-- index WHERE orchestration_key IS NOT NULL).

ALTER TABLE wfos_verification_runs
  ADD COLUMN orchestration_key TEXT;

ALTER TABLE wfos_verification_runs
  DROP CONSTRAINT IF EXISTS wfos_verification_runs_orchestration_key_valid;
ALTER TABLE wfos_verification_runs
  ADD CONSTRAINT wfos_verification_runs_orchestration_key_valid
  CHECK (orchestration_key IS NULL OR orchestration_key <> '');

CREATE UNIQUE INDEX wfos_verification_runs_orchestration_key_uidx
  ON wfos_verification_runs (orchestration_key)
  WHERE orchestration_key IS NOT NULL;
