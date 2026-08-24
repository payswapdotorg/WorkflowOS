-- WORK-032 PR #36 review fix #3: crash-safe recovery for the `finalizing`
-- reservation state (the third + final PR #36 review blocker).
--
-- Migration 0028 introduced the two-phase experiment completion protocol:
--
--   Phase 1 — RESERVATION (exactly-once CAS): claimExperimentCompletion
--              running → finalizing (NOT running → completed).
--   Phase 2 — INTEGRITY VALIDATION (winner only): integrityService.validate.
--   Phase 3 — FINALIZATION (CAS, makes status authoritative):
--              valid===true  → finalizeExperimentCompletion  (finalizing → completed)
--              valid===false → finalizeExperimentInvalidation (finalizing → invalidated)
--
-- The reviewer's remaining blocker: `running → finalizing` is a DURABLE
-- reservation, but there was NO recovery path if the worker that won the
-- reservation DIED after acquiring `finalizing` and before completing
-- validation/finalization. That left the experiment permanently stuck in
-- `finalizing`, because:
--
--   * `claimExperimentCompletion` only matches `WHERE status='running'`, so
--     no other worker could re-enter the protocol via the fresh-claim path.
--   * `checkExperimentCompletion` is only triggered when a trial reaches a
--     terminal state — but ALL trials were already terminal (that was the
--     precondition for entering the protocol), so no trial would finish
--     again to re-trigger the check.
--
-- The fix is a PERSISTED LEASE on the `finalizing` reservation:
--
--   * `claimExperimentCompletion` now sets
--     `finalizing_lease_expires_at = NOW() + ttl` alongside the
--     `running → finalizing` CAS.
--   * A new `recoverStaleFinalizingExperiment` CAS claims `finalizing` rows
--     whose lease has expired (`WHERE status='finalizing' AND
--     finalizing_lease_expires_at < NOW()'`) and RENEWS the lease so the
--     recovering worker has exclusive ownership. The winner re-enters the
--     protocol at phase 2 (validation + finalization). If the recovering
--     worker also dies, the renewed lease eventually expires and another
--     recovery attempt can claim it again — forward progress is preserved.
--   * Lazy recovery is triggered on `getExperiment` reads: if the experiment
--     is in `finalizing` with a stale lease, `checkExperimentCompletion`
--     runs the recovery path before returning. NO polling sweep, NO second
--     execution engine (§34 invariant intact). The recovery is best-effort
--     in the read path — a recovery failure logs + returns the stuck row
--     (a visible, debuggable stuck-state, NOT a false completion).
--
-- This migration adds the `finalizing_lease_expires_at` column (nullable —
-- only set when status='finalizing') + a partial index scoped to
-- `status='finalizing'` for the stale-lease sweep query. No backfill is
-- needed — no existing experiment can be in `finalizing` with a lease set
-- (the column is new; existing `finalizing` rows from migration 0028, if
-- any, have NULL leases and are reclaimable immediately, which is safe
-- because the protocol is idempotent under the recovery CAS).

ALTER TABLE wfos_benchmark_experiments
  ADD COLUMN IF NOT EXISTS finalizing_lease_expires_at TIMESTAMPTZ;

-- Partial index scoped to status='finalizing' — the only rows the
-- stale-lease sweep queries. Keeps the index small (finalizing is a
-- transient reservation state, not a steady-state) and makes the recovery
-- CAS a fast indexed lookup.
CREATE INDEX IF NOT EXISTS idx_benchmark_experiments_finalizing_stale
  ON wfos_benchmark_experiments (finalizing_lease_expires_at)
  WHERE status = 'finalizing';
