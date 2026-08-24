-- WORK-033 / PR #37 review fix: connect the authoritative benchmark START
-- transition to execution-policy freezing (§9).
--
-- The review found that migration 0026's freeze MECHANISM existed (the
-- frozen column + the reject-frozen-mutation trigger) and the service
-- exposed freezeProjectPolicy(), but NOTHING in the actual benchmark start
-- path invoked it. The real system could do:
--
--     project policy (frozen = false)
--         ↓
--     benchmark experiment starts (status = running)
--         ↓
--     project policy still mutable
--
-- violating the WORK-033 §9 invariant: a policy is IMMUTABLE once any
-- benchmark experiment in its project is RUNNING (the policy version that
-- produced benchmark evidence must not change under the evidence).
--
-- The fix connects the freeze to the AUTHORITATIVE start transition at the
-- persistence boundary — the same governed boundary that owns the
-- created|paused → running CAS (claimExperimentStart). A database trigger
-- fires atomically WITH the transition:
--
--   * wfos_benchmark_experiments AFTER UPDATE (status → 'running')
--       → freeze the project's unfrozen policy row(s).
--
--     This is process-startup-recovery-grade enforcement: no application
--     code path can bypass it (the service-level start, a future CLI, a
--     manual SQL start all fire the same trigger), and there is no crash
--     window between "experiment running" and "policy frozen" — they commit
--     together. It introduces no circular dependency: the benchmark domain
--     code never imports the execution-policy domain; the cross-domain
--     invariant lives in the database (the same pattern as §4 snapshot
--     immutability + §22 append-only decisions).
--
--   * wfos_execution_policies BEFORE INSERT (born-frozen)
--       → a policy row created for a project that ALREADY has a started
--         experiment (started_at IS NOT NULL) is born frozen. This closes
--     the remaining hole: without it, a policy created AFTER an experiment
--     started would be mutable while the experiment runs.
--
-- The freeze is PERMANENT (one-way) — 0026's reject-frozen trigger never
-- unfreezes, and this migration adds no unfreeze path: benchmark evidence
-- integrity requires the producing policy version to stay immutable.
--
-- The freeze UPDATE bumps policy_version via 0026's touch trigger (one
-- final bump, recording the freeze transition); the reject-frozen trigger
-- permits it because it only rejects SUBSTANTIVE mutations of an
-- ALREADY-frozen row (OLD.frozen = true) — the freeze itself targets
-- unfrozen rows.
--
-- The existing POST /projects/:id/execution-policy/freeze endpoint remains
-- valid as an EXPLICIT pre-freeze (freezing earlier than any experiment);
-- it is no longer load-bearing for the §9 guarantee.

-- (1) Freeze on the authoritative start transition -------------------------
CREATE OR REPLACE FUNCTION wfos_freeze_execution_policy_on_benchmark_start()
RETURNS trigger AS $$
BEGIN
  IF (NEW.status = 'running' AND OLD.status IN ('created', 'paused')) THEN
    UPDATE wfos_execution_policies
       SET frozen = true
     WHERE project_id = NEW.project_id
       AND frozen = false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_policy_freeze_on_benchmark_start
  ON wfos_benchmark_experiments;

CREATE TRIGGER wfos_execution_policy_freeze_on_benchmark_start
  AFTER UPDATE ON wfos_benchmark_experiments
  FOR EACH ROW
  EXECUTE FUNCTION wfos_freeze_execution_policy_on_benchmark_start();

-- (2) Born-frozen: a policy created after an experiment already started ----
CREATE OR REPLACE FUNCTION wfos_execution_policy_born_frozen_if_started()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM wfos_benchmark_experiments
     WHERE project_id = NEW.project_id
       AND started_at IS NOT NULL
  ) THEN
    NEW.frozen := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_policy_born_frozen_if_started
  ON wfos_execution_policies;

CREATE TRIGGER wfos_execution_policy_born_frozen_if_started
  BEFORE INSERT ON wfos_execution_policies
  FOR EACH ROW
  EXECUTE FUNCTION wfos_execution_policy_born_frozen_if_started();
