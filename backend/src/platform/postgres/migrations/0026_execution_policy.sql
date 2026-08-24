-- WORK-033 — Execution Policy & Fair Benchmarking
--
-- The execution-policy layer is an APPLICATION-LAYER ORCHESTRATOR (mirrors the
-- §34 benchmark pattern): it lives at src/execution-policy/ OUTSIDE the 17
-- frozen modules, consumes @modules/* public barrels + @platform/*, NEVER
-- mutates workflow state, NEVER stores credentials, and NEVER invents
-- provider capabilities (it composes ExecutionProviderInfo +
-- EXTERNAL_UI_CATALOG from @modules/agents).
--
-- Tables (all tenant-scoped by organization_id + project_id; no secrets):
--   wfos_execution_policies         — project-scoped hard-constraint policy
--   wfos_execution_preferences      — user-scoped preference weights
--   wfos_provider_access_profiles   — user-configured subscription capability
--   wfos_execution_policy_decisions — append-only recommendation audit
--                                     (§22 benchmark integrity: records
--                                      benchmarkMode, policyVersion,
--                                      taskProfile, eligible/excluded + why)

-- ============================================================================
-- wfos_execution_policies — PROJECT hard constraints (§4, §8, §31)
-- ============================================================================
CREATE TABLE IF NOT EXISTS wfos_execution_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- §8 benchmark mode the project defaults to for fair comparison.
  default_benchmark_mode TEXT NOT NULL DEFAULT 'maximum_capability'
    CHECK (default_benchmark_mode IN (
      'maximum_capability', 'controlled_comparison', 'cost_constrained',
      'latency_constrained', 'subscription_constrained', 'privacy_constrained')),
  -- §4 Project constraints.
  external_execution_allowed BOOLEAN NOT NULL DEFAULT true,
  native_execution_allowed   BOOLEAN NOT NULL DEFAULT true,
  -- §31 Budget.
  max_cost_per_task_cents    BIGINT,        -- NULL = unlimited (cents to avoid float)
  max_cost_per_trial_cents   BIGINT,        -- NULL = unlimited
  -- §26 Latency.
  max_time_to_pr_ms          INTEGER,       -- NULL = unlimited
  -- §26 Human intervention.
  human_intervention_allowed BOOLEAN NOT NULL DEFAULT true,
  -- §5/§6 Privacy.
  privacy_level TEXT NOT NULL DEFAULT 'standard'
    CHECK (privacy_level IN ('standard', 'private', 'local_only', 'regulated')),
  -- §4 Provider allowlist / denylist (stored as TEXT[]; empty = unrestricted).
  allowed_providers TEXT[] NOT NULL DEFAULT '{}',
  denied_providers  TEXT[] NOT NULL DEFAULT '{}',
  -- §4 Allowed execution modes (subset of {native,external}; empty = both).
  allowed_modes TEXT[] NOT NULL DEFAULT '{}',
  -- §32 Organization-level overrides (denormalized snapshot at policy-write
  -- time; the org-policy persistence layer is deferred per §32). NULL = unset.
  org_allowed_providers      TEXT[],
  org_max_cost_cents         BIGINT,
  org_required_privacy_level TEXT,
  -- §9 Immutable once any benchmark experiment in this project is RUNNING.
  -- The frozen flag is set by the benchmark layer on experiment start; the
  -- policy layer rejects updates once frozen = true.
  frozen BOOLEAN NOT NULL DEFAULT false,
  -- §9 policyVersion — monotonically increasing; bumped on every mutation.
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One active policy per project.
  UNIQUE (project_id)
);

CREATE INDEX IF NOT EXISTS idx_execution_policies_project
  ON wfos_execution_policies(project_id);

-- updated_at maintenance + policy_version bump.
CREATE OR REPLACE FUNCTION wfos_execution_policy_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  -- policy_version bumps ONLY on UPDATE (INSERT starts at 1).
  IF (TG_OP = 'UPDATE') THEN
    NEW.policy_version = OLD.policy_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_policy_touch_trigger ON wfos_execution_policies;
CREATE TRIGGER wfos_execution_policy_touch_trigger
  BEFORE INSERT OR UPDATE ON wfos_execution_policies
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_policy_touch();

-- Reject mutation of a frozen policy (§9 immutability once experiment starts).
CREATE OR REPLACE FUNCTION wfos_reject_frozen_execution_policy() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.frozen = true
      AND (NEW.default_benchmark_mode IS DISTINCT FROM OLD.default_benchmark_mode
        OR NEW.external_execution_allowed IS DISTINCT FROM OLD.external_execution_allowed
        OR NEW.native_execution_allowed IS DISTINCT FROM OLD.native_execution_allowed
        OR NEW.max_cost_per_task_cents IS DISTINCT FROM OLD.max_cost_per_task_cents
        OR NEW.max_cost_per_trial_cents IS DISTINCT FROM OLD.max_cost_per_trial_cents
        OR NEW.max_time_to_pr_ms IS DISTINCT FROM OLD.max_time_to_pr_ms
        OR NEW.human_intervention_allowed IS DISTINCT FROM OLD.human_intervention_allowed
        OR NEW.privacy_level IS DISTINCT FROM OLD.privacy_level
        OR NEW.allowed_providers IS DISTINCT FROM OLD.allowed_providers
        OR NEW.denied_providers IS DISTINCT FROM OLD.denied_providers
        OR NEW.allowed_modes IS DISTINCT FROM OLD.allowed_modes)) THEN
    RAISE EXCEPTION 'execution-policy-frozen: project % policy is immutable (benchmark experiment running); policy_version=%',
      NEW.project_id, OLD.policy_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_reject_frozen_execution_policy_trigger ON wfos_execution_policies;
CREATE TRIGGER wfos_reject_frozen_execution_policy_trigger
  BEFORE UPDATE ON wfos_execution_policies
  FOR EACH ROW EXECUTE FUNCTION wfos_reject_frozen_execution_policy();

-- ============================================================================
-- wfos_execution_preferences — USER preference weights (§12)
-- ============================================================================
CREATE TABLE IF NOT EXISTS wfos_execution_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES wfos_users(id) ON DELETE CASCADE,
  -- §12 Preference axes. Weights are non-negative; the service normalizes.
  quality_weight   REAL NOT NULL DEFAULT 0.6 CHECK (quality_weight >= 0),
  cost_weight      REAL NOT NULL DEFAULT 0.2 CHECK (cost_weight >= 0),
  latency_weight   REAL NOT NULL DEFAULT 0.1 CHECK (latency_weight >= 0),
  privacy_weight   REAL NOT NULL DEFAULT 0.1 CHECK (privacy_weight >= 0),
  -- §12 Discrete preferred surface (advisory; never overrides hard constraints).
  preferred_mode   TEXT CHECK (preferred_mode IN ('native', 'external') OR preferred_mode IS NULL),
  external_preferred BOOLEAN NOT NULL DEFAULT false,
  native_preferred   BOOLEAN NOT NULL DEFAULT false,
  -- §31 Defaults for the recommendation engine.
  default_benchmark_mode TEXT NOT NULL DEFAULT 'maximum_capability'
    CHECK (default_benchmark_mode IN (
      'maximum_capability', 'controlled_comparison', 'cost_constrained',
      'latency_constrained', 'subscription_constrained', 'privacy_constrained')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_execution_preferences_user
  ON wfos_execution_preferences(user_id);

CREATE OR REPLACE FUNCTION wfos_execution_preference_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_preference_touch_trigger ON wfos_execution_preferences;
CREATE TRIGGER wfos_execution_preference_touch_trigger
  BEFORE INSERT OR UPDATE ON wfos_execution_preferences
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_preference_touch();

-- ============================================================================
-- wfos_provider_access_profiles — USER-configured subscription capability (§5)
-- ============================================================================
-- statusSource: 'verified' (live-checked by a future WORK) | 'user_configured'
--   | 'unknown'. 'unknown' MUST NOT automatically become available (§5).
CREATE TABLE IF NOT EXISTS wfos_provider_access_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES wfos_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  -- §5 example: chatgpt/plus with codingAgent available.
  plan TEXT,                            -- 'free' | 'plus' | 'pro' | 'enterprise' | NULL
  coding_agent TEXT NOT NULL DEFAULT 'unverified'
    CHECK (coding_agent IN ('ready', 'unverified', 'unavailable')),
  external_ui TEXT NOT NULL DEFAULT 'unverified'
    CHECK (external_ui IN ('ready', 'unverified', 'unavailable')),
  native_api TEXT NOT NULL DEFAULT 'unverified'
    CHECK (native_api IN ('ready', 'unverified', 'unavailable')),
  status_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status_source IN ('verified', 'user_configured', 'unknown')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_provider_access_profiles_user
  ON wfos_provider_access_profiles(user_id);

CREATE OR REPLACE FUNCTION wfos_provider_access_profile_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_provider_access_profile_touch_trigger ON wfos_provider_access_profiles;
CREATE TRIGGER wfos_provider_access_profile_touch_trigger
  BEFORE INSERT OR UPDATE ON wfos_provider_access_profiles
  FOR EACH ROW EXECUTE FUNCTION wfos_provider_access_profile_touch();

-- ============================================================================
-- wfos_execution_policy_decisions — APPEND-ONLY recommendation audit (§22)
-- ============================================================================
-- Every benchmark result / recommendation must record benchmarkMode,
-- policyVersion, taskProfile, eligible/excluded candidates + exclusion
-- reasons (§22). This prevents later reinterpretation of why a provider was
-- absent. INSERT-only; UPDATE/DELETE rejected.
CREATE TABLE IF NOT EXISTS wfos_execution_policy_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  work_item_id UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  -- The user who requested the recommendation (server-derived; §27).
  requested_by UUID REFERENCES wfos_users(id),
  -- §9/§22 Snapshot of the policy at decision time.
  policy_version INTEGER NOT NULL,
  benchmark_mode TEXT NOT NULL CHECK (benchmark_mode IN (
    'maximum_capability', 'controlled_comparison', 'cost_constrained',
    'latency_constrained', 'subscription_constrained', 'privacy_constrained')),
  -- §15 Task profile (derived; JSONB — derived metadata only).
  task_profile JSONB NOT NULL,
  -- §22 Eligible + excluded candidates + exclusion reasons.
  eligible_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  excluded_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- §16 Recommended candidate + §19 Why explanation.
  recommended_candidate JSONB,
  why_explanation TEXT,
  -- §13 recommendationScore per candidate (so the audit is self-contained).
  scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- §14 Benchmark evidence snapshot at decision time.
  benchmark_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_policy_decisions_work_item
  ON wfos_execution_policy_decisions(work_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_policy_decisions_project
  ON wfos_execution_policy_decisions(project_id, created_at DESC);

-- §22 append-only: reject UPDATE / DELETE entirely.
CREATE OR REPLACE FUNCTION wfos_execution_policy_decision_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'execution-policy-decision-immutable: decisions are append-only (§22 benchmark integrity)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_policy_decision_immutable_upd ON wfos_execution_policy_decisions;
CREATE TRIGGER wfos_execution_policy_decision_immutable_upd
  BEFORE UPDATE ON wfos_execution_policy_decisions
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_policy_decision_immutable();

DROP TRIGGER IF EXISTS wfos_execution_policy_decision_immutable_del ON wfos_execution_policy_decisions;
CREATE TRIGGER wfos_execution_policy_decision_immutable_del
  BEFORE DELETE ON wfos_execution_policy_decisions
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_policy_decision_immutable();
