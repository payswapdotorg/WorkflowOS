-- WORK-032 start-delivery durability: the transactional outbox for
-- experiment start.
--
-- The PR #35 review found that startExperiment() was not crash-safe:
--
--     claimExperimentStart()        (atomic CAS — durable)
--         ↓
--     status = 'running'
--         ↓
--     BENCHMARK_STARTED audit       (in-memory intent — LOST on crash)
--         ↓
--     enqueue trials                (in-memory intent — LOST on crash)
--
-- A crash after the CAS but before (or midway through) the side effects
-- left the experiment 'running' with NO audit and only SOME (or zero)
-- trial jobs delivered — an unrecoverable, silently-incomplete start.
--
-- The fix is the classic TRANSACTIONAL OUTBOX pattern, scoped to §34 (NO
-- polling sweep, NO second execution engine — replay is triggered by the
-- existing touch points: startExperiment itself, the runTrialJob worker
-- path, and the post-authorization recoverExperimentIfStale read path):
--
--     atomic start claim  (single statement: CAS + intent record — the
--     ↓                    repository owns BOTH, inseparably)
--     durable intent      (wfos_benchmark_start_deliveries +
--     ↓                    wfos_benchmark_start_trial_deliveries rows)
--     replayable delivery
--     ├── BENCHMARK_STARTED exactly once
--         (deliverStartAudit: flag-CAS + deterministic-id INSERT
--          ON CONFLICT (id) DO NOTHING — one atomic statement)
--     └── benchmark.trial jobs delivered idempotently
--         (enqueue-then-mark: a crash between enqueue and mark replays
--          the job — DUPLICATE JOB DELIVERY IS TOLERATED BY DESIGN, the
--          trial claim CAS from PR #36 makes the consumer idempotent)
--
-- Invariants (a start is recoverable after ANY crash point):
--   before CAS                → nothing happened (no rows)
--   after CAS / before audit  → delivery row exists; replay writes the audit
--   after audit / mid-enqueue → audit flag set (atomic with the audit row);
--                                replay enqueues only UNDELIVERED obligations
--   after all enqueue         → complete; replay is a no-op
--
-- Repeated delivery produces:
--   one logical start          → one delivery row per successful CAS win
--   one BENCHMARK_STARTED      → deterministic audit id = the delivery id
--                                (INSERT ... ON CONFLICT (id) DO NOTHING)
--   one enqueue obligation per
--   trial                      → UNIQUE (start_delivery_id, trial_id)
--
-- A pause → re-start cycle is a NEW logical start (the CAS wins
-- paused → running): it creates a NEW delivery row with NEW obligations
-- for the trials still queued at claim time — preserving the existing
-- re-start-after-partial-run semantics, now crash-safely.

-- One row per logical start (per successful claimExperimentStart win).
CREATE TABLE IF NOT EXISTS wfos_benchmark_start_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id     UUID NOT NULL REFERENCES wfos_benchmark_experiments(id) ON DELETE CASCADE,
  -- Denormalized for the audit write (the BENCHMARK_STARTED audit is
  -- project-scoped; organization_id is intentionally absent — the
  -- existing BENCHMARK_STARTED audits leave it NULL).
  project_id        UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- The audit obligation: exactly one BENCHMARK_STARTED per logical start.
  -- Flipped atomically WITH the audit INSERT by deliverStartAudit (a
  -- single CTE statement) — the flag is never set without the audit row
  -- existing, and the audit row cannot be duplicated (deterministic id).
  audit_delivered   BOOLEAN NOT NULL DEFAULT FALSE,
  audit_delivered_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Best-effort completion marker (set when the audit is delivered AND no
  -- undelivered trial obligation remains). Not load-bearing for
  -- correctness — the per-obligation flags are — but it makes the
  -- incomplete-delivery lookup a single partial-index scan.
  completed_at      TIMESTAMPTZ
);

-- Incomplete deliveries per experiment (the replay lookup).
CREATE INDEX IF NOT EXISTS wfos_benchmark_start_deliveries_incomplete_idx
  ON wfos_benchmark_start_deliveries (experiment_id)
  WHERE completed_at IS NULL;

-- One row per (logical start × trial queued at claim time): the DURABLE
-- enqueue obligation. The claim-time snapshot of queued trials — at
-- replay time the trial phases may have advanced; the obligation set is
-- what the start promised to deliver, frozen at claim time.
CREATE TABLE IF NOT EXISTS wfos_benchmark_start_trial_deliveries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_delivery_id  UUID NOT NULL REFERENCES wfos_benchmark_start_deliveries(id) ON DELETE CASCADE,
  trial_id           UUID NOT NULL REFERENCES wfos_benchmark_trials(id) ON DELETE CASCADE,
  delivered          BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ONE logical enqueue obligation per trial per logical start. Repeated
  -- replay of the SAME delivery can never create a second obligation for
  -- the same trial (and the claim CTE inserts a fresh delivery id each
  -- win, so this constraint is per-start, allowing a pause → re-start to
  -- re-enqueue still-queued trials under a NEW obligation).
  CONSTRAINT wfos_benchmark_start_trial_deliveries_unique_obligation
    UNIQUE (start_delivery_id, trial_id)
);

-- Undelivered obligations per delivery (the replay work list).
CREATE INDEX IF NOT EXISTS wfos_benchmark_start_trial_deliveries_pending_idx
  ON wfos_benchmark_start_trial_deliveries (start_delivery_id)
  WHERE delivered = FALSE;
