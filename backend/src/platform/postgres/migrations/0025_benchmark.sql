-- WORK-032: Native vs External Execution Benchmark.
--
-- A first-class benchmarking system that measures Native API execution
-- versus External Companion execution using the SAME engineering task. The
-- benchmark harness is a CONSUMER of the 17 frozen domain modules — it does
-- NOT create another workflow/verification/review/CI engine. Authoritative
-- outcome state is always read through the existing public contracts:
--   - /workflows (workflowEngine.getState/getHistory)
--   - /verification (verificationService.listRunsForWorkItem)
--   - /reviews (reviewService.listReviewsForWorkItem)
--   - /github (pullRequestAssociationRepository + ciEvidenceIngestionRepository)
--   - /agents (agentRunRepository.findByWorkItem)
--   - /audit (auditService.listForWorkItem)
--
-- The benchmark domain lives at src/benchmark/ (application layer, OUTSIDE
-- src/modules/) so the frozen 17-module invariant (PLAT-AC-01) is preserved.
-- Benchmark code imports the frozen modules' public barrels only — never
-- their internal/ directories (enforced by a dedicated static check in
-- tests/architecture/static-architecture.test.ts, §34).
--
-- SECURITY: these tables NEVER store credentials, callback tokens, handoff
-- tokens, cookies, or provider auth keys. The external_session_ref column
-- is an opaque provider-side reference (e.g. a Claude conversation URL path)
-- that the user's own browser session already holds — it is not a credential.

-- ============================================================================
-- 1. BenchmarkTaskSnapshot (§4) — immutable task baseline.
-- ============================================================================
-- Captures the exact task definition at freeze time: project, architecture
-- version, requirements, criteria, work item, work order, repository,
-- baseline commit, implementation context, promptDigest, promptVersion,
-- verification requirements, snapshotHash (§32 integrity), harness version,
-- scoring version. IMMUTABLE — once frozen, never mutated. If the task
-- changes, create a NEW snapshot (never mutate an old one).
CREATE TABLE IF NOT EXISTS wfos_benchmark_task_snapshots (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  project_id               UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  architecture_version_id UUID NOT NULL REFERENCES wfos_architecture_versions(id) ON DELETE CASCADE,
  -- The TEMPLATE work item used to build the snapshot. Each trial clones a
  -- fresh work item from this definition so trials have independent workflow
  -- state (§6 trial isolation). The snapshot's workItemId is the template.
  work_item_id             UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  work_order_id            UUID NOT NULL REFERENCES wfos_work_orders(id) ON DELETE CASCADE,
  -- ImplementationContext that produced the canonical promptDigest.
  implementation_context_id UUID NOT NULL REFERENCES wfos_implementation_contexts(id) ON DELETE CASCADE,
  -- Requirement + criterion ids captured at freeze time (denormalized so the
  -- snapshot is self-describing even if the underlying rows are later
  -- superseded by a new architecture version).
  requirement_ids         TEXT[] NOT NULL DEFAULT '{}',
  criterion_ids           TEXT[] NOT NULL DEFAULT '{}',
  -- Repository (owner/name) + immutable baseline commit SHA (§28 equality).
  repository              TEXT NOT NULL,
  base_commit             TEXT NOT NULL,
  target_branch_prefix   TEXT NOT NULL,
  -- Canonical prompt digest (SHA-256) + prompt builder version (§27 equality).
  prompt_digest           TEXT NOT NULL,
  prompt_version          TEXT NOT NULL,
  -- Verification requirements captured at freeze time (§4).
  verification_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Integrity: SHA-256 of the canonical snapshot content (§32). Before
  -- scoring, the integrity service validates this hash against a recomputed
  -- value; if mutated, the experiment is marked invalid.
  snapshot_hash           TEXT NOT NULL,
  harness_version        TEXT NOT NULL,
  scoring_version        TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Snapshots are immutable (§4). Reject any UPDATE or DELETE at the DB level.
CREATE OR REPLACE FUNCTION wfos_reject_benchmark_snapshot_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'wfos_benchmark_task_snapshots is immutable (WORK-032 §4): snapshots cannot be UPDATEd or DELETEd. Create a new snapshot instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_benchmark_snapshot_no_update ON wfos_benchmark_task_snapshots;
CREATE TRIGGER wfos_benchmark_snapshot_no_update
  BEFORE UPDATE OR DELETE ON wfos_benchmark_task_snapshots
  FOR EACH ROW EXECUTE FUNCTION wfos_reject_benchmark_snapshot_mutation();

CREATE INDEX IF NOT EXISTS idx_benchmark_snapshots_project
  ON wfos_benchmark_task_snapshots(project_id, created_at DESC);

-- ============================================================================
-- 2. BenchmarkExperiment (§5) — one experiment = one or more trials against
--    a single snapshot.
-- ============================================================================
CREATE TABLE IF NOT EXISTS wfos_benchmark_experiments (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  project_id                  UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  benchmark_task_snapshot_id  UUID NOT NULL REFERENCES wfos_benchmark_task_snapshots(id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  description                 TEXT,
  created_by                  UUID REFERENCES wfos_users(id) ON DELETE SET NULL,
  -- 'created' | 'running' | 'paused' | 'completed' | 'cancelled' | 'invalidated'
  status                      TEXT NOT NULL DEFAULT 'created',
  -- §21: optional trial ordering randomization. NULL = sequential (no shuffle).
  randomization_seed          TEXT,
  -- §22: number of repetitions per (provider, mode) cell. Default 1.
  repetitions                 INTEGER NOT NULL DEFAULT 1 CHECK (repetitions >= 1),
  -- §32: integrity record linkage (one experiment has one integrity record).
  -- Denormalized here for fast lookup; the full integrity row is in
  -- wfos_benchmark_integrity.
  -- Timestamps (§16): server timestamps only.
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at                  TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  -- Audit-visible lifecycle: BENCHMARK_CREATED → BENCHMARK_STARTED →
  -- BENCHMARK_COMPLETED | BENCHMARK_INVALIDATED (§47).
  CHECK (status IN ('created','running','paused','completed','cancelled','invalidated'))
);

CREATE INDEX IF NOT EXISTS idx_benchmark_experiments_project
  ON wfos_benchmark_experiments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_experiments_snapshot
  ON wfos_benchmark_experiments(benchmark_task_snapshot_id);

-- ============================================================================
-- 3. BenchmarkTrial (§5, §6, §7) — one execution of one (provider, mode, rep)
--    cell against the experiment's snapshot.
-- ============================================================================
-- Each trial MUST start from the same repository baseline (§6) on an isolated
-- branch. The trial's work_item_id is a CLONE of the snapshot's template work
-- item — independent workflow state, independent execution records, independent
-- agent runs, independent reviews, independent verification runs, independent
-- PR associations. No cross-trial contamination (§7).
CREATE TABLE IF NOT EXISTS wfos_benchmark_trials (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id               UUID NOT NULL REFERENCES wfos_benchmark_experiments(id) ON DELETE CASCADE,
  benchmark_task_snapshot_id  UUID NOT NULL REFERENCES wfos_benchmark_task_snapshots(id) ON DELETE CASCADE,
  organization_id             UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  project_id                  UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- Provider matrix (§2): zai | chatgpt | claude | fake (deterministic CI).
  provider                    TEXT NOT NULL,
  model                       TEXT,
  -- 'native' | 'external'
  execution_mode              TEXT NOT NULL CHECK (execution_mode IN ('native','external')),
  -- §22: 0-based repetition index within this (provider, mode) cell.
  repetition_index            INTEGER NOT NULL DEFAULT 0,
  -- §21: 0-based execution order within the experiment (for randomization).
  execution_order             INTEGER NOT NULL,
  randomization_seed          TEXT,
  -- 'queued' | 'running' | 'completed' | 'failed' | 'unavailable' (§30)
  status                      TEXT NOT NULL DEFAULT 'queued',
  -- §6: isolated trial branch (e.g. 'benchmark/work-001/zai-native/0').
  trial_branch                TEXT NOT NULL,
  -- §28: baseline commit equality — copied from the snapshot at creation time
  -- so the integrity check (§32) can prove all trials share the same baseline
  -- without re-reading the snapshot.
  baseline_commit             TEXT NOT NULL,
  -- §27: prompt digest equality — copied from the snapshot.
  prompt_digest               TEXT NOT NULL,
  -- The trial's OWN work item (a clone of the snapshot's template).
  work_item_id                UUID REFERENCES wfos_work_items(id) ON DELETE SET NULL,
  -- Linkage to the authoritative execution/agent/PR/order/context records.
  execution_id                TEXT,  -- wf_<8hex> (NOT a DB FK — executionId is a string key)
  agent_run_id                UUID REFERENCES wfos_agent_runs(id) ON DELETE SET NULL,
  pull_request_association_id UUID REFERENCES wfos_pull_request_associations(id) ON DELETE SET NULL,
  work_order_id               UUID REFERENCES wfos_work_orders(id) ON DELETE SET NULL,
  implementation_context_id  UUID REFERENCES wfos_implementation_contexts(id) ON DELETE SET NULL,
  -- §30: distinguish infrastructure failure vs engineering failure vs
  -- configuration unavailability. A provider failure due to missing
  -- configuration → 'unavailable' (not scored as success). A provider
  -- execution failure during work → 'failed' with failure_kind.
  failure_kind                 TEXT,
  failure_reason               TEXT,
  -- §31: external execution can require human interaction. Track it visibly.
  human_intervention_count    INTEGER NOT NULL DEFAULT 0,
  intervention_duration_ms    INTEGER,
  -- §17: external mode metadata. NEVER stores cookies/callback tokens/handoff
  -- tokens/provider auth tokens/API keys. external_session_ref is an opaque
  -- provider-side reference (e.g. a Claude conversation URL path) that the
  -- user's own browser session already holds.
  companion_version           TEXT,
  provider_adapter_version    TEXT,
  browser                     TEXT,
  provider_surface            TEXT,
  external_session_ref        TEXT,
  handoff_issued_at           TIMESTAMPTZ,
  handoff_redeemed_at         TIMESTAMPTZ,
  -- §18: native mode metadata. NEVER stores provider API keys.
  adapter_version             TEXT,
  model_configuration_version TEXT,
  -- Timestamps (§16): server timestamps.
  started_at                  TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('queued','running','completed','failed','unavailable')),
  CHECK (failure_kind IS NULL OR failure_kind IN ('infrastructure','engineering','configuration')),
  -- Unique cell: (experiment, provider, mode, repetition) — no duplicate trials.
  UNIQUE (experiment_id, provider, execution_mode, repetition_index)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_trials_experiment
  ON wfos_benchmark_trials(experiment_id, execution_order);
CREATE INDEX IF NOT EXISTS idx_benchmark_trials_work_item
  ON wfos_benchmark_trials(work_item_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_trials_status
  ON wfos_benchmark_trials(status, created_at DESC);

-- ============================================================================
-- 4. BenchmarkTrialMetrics (§10) — one row per trial, all metric groups.
-- ============================================================================
-- Persisted by the metric collector AFTER a trial completes (or fails). The
-- collector reads ONLY from authoritative sources (§9): workflowEngine,
-- verificationService, reviewService, pullRequestAssociationRepository,
-- ciEvidenceIngestionRepository, agentRunRepository, auditService. A provider
-- claiming "all tests passed" does NOT count unless authoritative CI confirms
-- it (§9).
CREATE TABLE IF NOT EXISTS wfos_benchmark_trial_metrics (
  trial_id UUID PRIMARY KEY REFERENCES wfos_benchmark_trials(id) ON DELETE CASCADE,

  -- §10 Execution metrics
  queue_time_ms         INTEGER,
  start_latency_ms      INTEGER,
  execution_duration_ms INTEGER,

  -- §10 Engineering metrics (from GitHub PullRequestAssociation + webhook events)
  files_changed   INTEGER,
  lines_added     INTEGER,
  lines_deleted   INTEGER,
  commits         INTEGER,
  pull_requests   INTEGER,

  -- §15 CI metrics (from ciEvidenceIngestionRepository — authoritative)
  ci_runs               INTEGER,
  ci_failures           INTEGER,
  ci_first_pass         BOOLEAN,
  total_ci_duration_ms  INTEGER,
  -- Classified failure categories (§15): typecheck/lint/unit/integration/E2E/build/deployment.
  ci_failure_categories JSONB,

  -- §14 Verification metrics (from verificationService — authoritative)
  verification_runs     INTEGER,
  criteria_passed       INTEGER,
  criteria_failed       INTEGER,
  verification_first_pass BOOLEAN,
  final_pass            BOOLEAN,
  total_criteria        INTEGER,

  -- §13 Review metrics (from reviewService — authoritative)
  review_count            INTEGER,
  request_changes_count   INTEGER,
  approval_count          INTEGER,
  -- §13: severity counts: {blocker, major, minor, info}
  severity_counts        JSONB,

  -- §12 Correction cycles (from authoritative workflow/review state)
  correction_cycles     INTEGER,
  agent_runs            INTEGER,

  -- §10 Completion time metrics (from workflowEngine.getHistory — authoritative)
  time_to_pr_ms        INTEGER,
  time_to_approved_ms  INTEGER,
  time_to_merged_ms   INTEGER,
  time_to_verified_ms INTEGER,

  -- §11 Derived quality score (versioned; never tuned after seeing results)
  engineering_quality_score REAL,
  score_version             TEXT,

  -- §16 Timestamps (server) for the trial lifecycle phases
  execution_started_at   TIMESTAMPTZ,
  execution_completed_at TIMESTAMPTZ,
  pr_created_at          TIMESTAMPTZ,
  ci_started_at          TIMESTAMPTZ,
  ci_completed_at        TIMESTAMPTZ,
  verification_started_at TIMESTAMPTZ,
  verification_completed_at TIMESTAMPTZ,
  review_started_at      TIMESTAMPTZ,
  review_completed_at    TIMESTAMPTZ,
  merged_at              TIMESTAMPTZ,
  verified_at            TIMESTAMPTZ,

  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 5. BenchmarkReviewFinding (§13) — per-trial review findings.
-- ============================================================================
-- Denormalized from the authoritative /reviews findings so comparison views
-- can render findings without re-querying every trial's review. The canonical
-- findings remain in wfos_review_findings; this table is a benchmark-scoped
-- projection. NEVER replaces the actual findings with a score (§13).
CREATE TABLE IF NOT EXISTS wfos_benchmark_review_findings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_id    UUID NOT NULL REFERENCES wfos_benchmark_trials(id) ON DELETE CASCADE,
  review_id   UUID REFERENCES wfos_reviews(id) ON DELETE SET NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('blocker','major','minor','info')),
  category    TEXT,
  file        TEXT,
  line        INTEGER,
  description TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_benchmark_review_findings_trial
  ON wfos_benchmark_review_findings(trial_id, severity);

-- ============================================================================
-- 6. BenchmarkIntegrity (§32) — integrity record per experiment.
-- ============================================================================
-- Before scoring: validate integrity. If the snapshot_hash, prompt_digest,
-- baseline_commit, scoring_version, or harness_version have been mutated
-- (e.g. by a faulty migration or direct DB edit), mark the experiment invalid.
CREATE TABLE IF NOT EXISTS wfos_benchmark_integrity (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   UUID NOT NULL UNIQUE REFERENCES wfos_benchmark_experiments(id) ON DELETE CASCADE,
  snapshot_hash   TEXT NOT NULL,
  prompt_digest   TEXT NOT NULL,
  baseline_commit TEXT NOT NULL,
  scoring_version TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  valid           BOOLEAN NOT NULL DEFAULT TRUE,
  validated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalidation_reason TEXT
);

-- updated_at maintenance trigger for trials.
CREATE OR REPLACE FUNCTION wfos_benchmark_trial_touch_updated()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_benchmark_trial_touch ON wfos_benchmark_trials;
CREATE TRIGGER wfos_benchmark_trial_touch
  BEFORE UPDATE ON wfos_benchmark_trials
  FOR EACH ROW EXECUTE FUNCTION wfos_benchmark_trial_touch_updated();
