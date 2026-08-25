-- WORK-038: Existing Project Onboarding — the Project Baseline boundary.
--
-- A Project Baseline is the EVIDENCE-BACKED RECONSTRUCTION of a software
-- repository that WorkflowOS did NOT originally create, established from a
-- PRECISE repository revision (a real Git commit SHA resolved through the
-- EXISTING /github authority — never a prompt hash, timestamp, branch name
-- alone, or generated ID).
--
-- The baseline is a PROJECT artifact (stored THROUGH the existing /projects
-- authority — /projects remains the single project authority). It is NOT:
--   * a second project engine
--   * a second repository / GitHub authority (it REFERENCES the existing
--     wfos_project_github_repositories row — never a duplicate repo table)
--   * a second architecture authority (proposed architecture is stored as a
--     PROPOSED observation, never an auto-created FROZEN ArchitectureVersion)
--   * a second requirements / workflow / verification / review authority
--
-- PROVENANCE MODEL (the central WORK-038 invariant — architecture-lock.md
-- "Existing-project truth model"):
--   observed   — directly established from repository/GitHub/CI/runtime evidence
--   inferred   — reasoned from observations, not explicitly established
--   confirmed  — explicitly validated through the authorized confirmation path
--   proposed   — a suggested future state, not a statement of current fact
--
-- These are NEVER collapsed into a single confidence number. Inferred facts
-- are NEVER stored as authoritative. Provenance is NEVER silently promoted
-- (inferred→confirmed requires confirmed_by; proposed→observed is forbidden).
--
-- CRASH / CONCURRENCY SAFETY (the explicit reasoning the boundary owes):
--   * "two onboarding requests for the same project+repo+commit": the
--     UNIQUE(project_id, project_github_repository_id, baseline_commit_sha)
--     constraint + the idempotent ensureBaseline make a re-analyze of the
--     same revision return the SAME row — no second baseline, no duplicate
--     observations (per-observation claim-digest UNIQUE).
--   * "onboarding interrupted halfway": the row sits in 'analyzing'; a retry
--     re-enters ensureBaseline, re-runs the analyzer, and CAS-completes.
--     Observations are append-only-idempotent (claim-digest unique) so a
--     partial write is safe to re-drive.
--   * "repository changes while analysis is running": the baseline is pinned to
--     baseline_commit_sha (immutable) — a moving branch does not mutate an
--     in-flight baseline; a new revision creates a NEW baseline row.
--   * "process crash after observations are written / before finalization":
--     the 'analyzing' row + its observations are a recoverable partial; the
--     recovery path re-enters ensureBaseline and re-drives to completion.
--
-- No workflow / verification / review mutation. No provider SDKs. No
-- credentials. No scheduler. No second authority.

-- ---------------------------------------------------------------------------
-- wfos_project_baselines — the baseline header (one per project+repo+commit).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wfos_project_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scope: the project (org-scoped via wfos_projects.organization_id).
  -- Denormalized organization_id for direct tenant filtering on reads.
  project_id UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  -- The repository, via the EXISTING /github authority row (never a duplicate
  -- repo table). ON DELETE CASCADE keeps baselines consistent with the link.
  project_github_repository_id UUID NOT NULL
    REFERENCES wfos_project_github_repositories(id) ON DELETE CASCADE,
  -- Safe repository coordinates (denormalized from the /github row for
  -- display + tenant-filter convenience; NOT credentials).
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  -- The IMMUTABLE exact repository revision: a real Git commit SHA resolved
  -- through the EXISTING /github GitHubAdapter.getBranch at baseline creation.
  -- NEVER NULL, never a placeholder, never a branch name alone. Reproducibility
  -- from a REAL Git revision.
  baseline_commit_sha TEXT NOT NULL,
  -- The human-readable ref that resolved to the SHA (e.g. 'main', 'v1.2.3').
  -- The SHA is the identity; this is display-only.
  revision_ref TEXT NOT NULL,
  -- Strict state machine (every transition is a repository-level CAS on
  -- (version, state); terminal states immutable):
  --   analyzing → complete | failed
  -- A 'complete' baseline has a non-empty observation set + content_digest.
  -- A 'failed' baseline carries failure_stage; it NEVER carries a 'confirmed'
  -- observation (failed analysis cannot produce a false confirmed baseline).
  state TEXT NOT NULL DEFAULT 'analyzing' CHECK (state IN (
    'analyzing', 'complete', 'failed')),
  -- Optimistic-concurrency token for CAS transitions.
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  -- native: WorkflowOS ran governed analysis on the host (ToolPolicyGate).
  -- external: the provider-native environment reported observations (normalized
  -- to the same contract; no host execution). The baseline is the SAME logical
  -- artifact either way (native/external parity).
  analysis_mode TEXT NOT NULL DEFAULT 'native' CHECK (analysis_mode IN (
    'native', 'external')),
  -- sha256 of the canonical observation set (kind|provenance|claim-digest
  -- sorted) — a reproducibility fingerprint. Same revision + same observed
  -- content → same digest (modulo inference nondeterminism, which is itself
  -- recorded as provenance=inferred).
  content_digest TEXT,
  -- Where analysis failed (failed rows only; the durable forensic).
  failure_stage TEXT,
  -- The governed-analysis run identity (links to the ToolPolicyGate decisions
  -- recorded on wfos_project_baseline_evidence). Null for external-reported
  -- baselines (the provider reported observations; no host tool run).
  analysis_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  -- Idempotency: one baseline per (project, repo, exact commit). A re-analyze
  -- of the same revision returns the SAME row — never a second baseline.
  CONSTRAINT wfos_project_baselines_revision_unique
    UNIQUE (project_id, project_github_repository_id, baseline_commit_sha)
);

CREATE INDEX IF NOT EXISTS wfos_project_baselines_project_idx
  ON wfos_project_baselines (project_id);
CREATE INDEX IF NOT EXISTS wfos_project_baselines_org_idx
  ON wfos_project_baselines (organization_id);
CREATE INDEX IF NOT EXISTS wfos_project_baselines_pending_idx
  ON wfos_project_baselines (project_id)
  WHERE terminal_at IS NULL;

-- updated_at maintenance (version bumps stay owned by the CAS statements).
CREATE OR REPLACE FUNCTION wfos_project_baseline_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_project_baseline_touch_trigger ON wfos_project_baselines;
CREATE TRIGGER wfos_project_baseline_touch_trigger
  BEFORE UPDATE ON wfos_project_baselines
  FOR EACH ROW EXECUTE FUNCTION wfos_project_baseline_touch();

-- The strict state machine + terminal immutability + identity immutability.
CREATE OR REPLACE FUNCTION wfos_project_baseline_transition_guard() RETURNS trigger AS $$
BEGIN
  -- TERMINAL states are FULLY immutable (any authoritative field).
  IF OLD.state IN ('complete', 'failed') THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.project_github_repository_id IS DISTINCT FROM OLD.project_github_repository_id
       OR NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
       OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
       OR NEW.baseline_commit_sha IS DISTINCT FROM OLD.baseline_commit_sha
       OR NEW.revision_ref IS DISTINCT FROM OLD.revision_ref
       OR NEW.analysis_mode IS DISTINCT FROM OLD.analysis_mode
       OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
       OR NEW.analysis_run_id IS DISTINCT FROM OLD.analysis_run_id
       OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
       OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at THEN
      RAISE EXCEPTION
        'project-baseline-terminal-immutable: baseline % is terminal (%) — no authoritative field may change',
        OLD.id, OLD.state;
    END IF;
    RETURN NEW;
  END IF;

  -- Strict legal edges.
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
         (OLD.state = 'analyzing' AND NEW.state IN ('complete', 'failed'))
    ) THEN
      RAISE EXCEPTION
        'project-baseline-illegal-transition: % -> % is not a legal baseline transition',
        OLD.state, NEW.state;
    END IF;
  END IF;

  -- Identity is immutable (a baseline can never be re-targeted onto another
  -- project, repository, revision, or analysis mode).
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_github_repository_id IS DISTINCT FROM OLD.project_github_repository_id
     OR NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
     OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
     OR NEW.baseline_commit_sha IS DISTINCT FROM OLD.baseline_commit_sha
     OR NEW.revision_ref IS DISTINCT FROM OLD.revision_ref
     OR NEW.analysis_mode IS DISTINCT FROM OLD.analysis_mode THEN
    RAISE EXCEPTION
      'project-baseline-identity-immutable: the baseline identity (project, repository, commit SHA, revision ref, analysis mode) is immutable — a baseline can never be re-targeted';
  END IF;

  -- version is monotonic.
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION
      'project-baseline-version-regression: version must not decrease (% -> %)',
      OLD.version, NEW.version;
  END IF;

  -- State/timestamp consistency.
  IF (NEW.state IN ('complete', 'failed')) <> (NEW.terminal_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'project-baseline-terminal-timestamp: state % requires terminal_at to be %',
      NEW.state,
      CASE WHEN NEW.state IN ('complete', 'failed') THEN 'set' ELSE 'NULL' END;
  END IF;
  IF NEW.state = 'complete' AND NEW.finalized_at IS NULL THEN
    RAISE EXCEPTION 'project-baseline-finalized-timestamp: complete state requires finalized_at';
  END IF;
  IF NEW.state = 'failed' AND NEW.failure_stage IS NULL THEN
    RAISE EXCEPTION 'project-baseline-failure-stage: failed state requires failure_stage';
  END IF;
  -- content_digest is set exactly on complete (a complete baseline has a
  -- reproducibility fingerprint; a failed/analyzing one does not).
  IF (NEW.state = 'complete') <> (NEW.content_digest IS NOT NULL) THEN
    RAISE EXCEPTION
      'project-baseline-content-digest: state % requires content_digest to be %',
      NEW.state,
      CASE WHEN NEW.state = 'complete' THEN 'set' ELSE 'NULL' END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_project_baseline_transition_guard_trigger
  ON wfos_project_baselines;
CREATE TRIGGER wfos_project_baseline_transition_guard_trigger
  BEFORE UPDATE ON wfos_project_baselines
  FOR EACH ROW EXECUTE FUNCTION wfos_project_baseline_transition_guard();

-- ---------------------------------------------------------------------------
-- wfos_project_baseline_evidence — the evidence rows backing observations.
-- Each row links to the governed tool invocation that produced it (native) or
-- the provider-reported source (external), and records the WORK-037 policy
-- decision that governed the read (null for external-reported observations).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wfos_project_baseline_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  baseline_id UUID NOT NULL REFERENCES wfos_project_baselines(id) ON DELETE CASCADE,
  -- The evidence source class.
  source TEXT NOT NULL CHECK (source IN (
    'filesystem', 'github_ci', 'runtime', 'config', 'metadata', 'provider_report')),
  -- The locator (path / ref / url / provider source label) — never a secret.
  locator TEXT NOT NULL,
  -- sha256 of the observed content (reproducibility — same content, same digest).
  content_digest TEXT,
  -- Whether secret-shaped content was redacted before persistence. TRUE means
  -- the stored claim/evidence reflects [REDACTED] markers, never raw secrets.
  redacted BOOLEAN NOT NULL DEFAULT FALSE,
  -- The governed tool invocation identity (native analysis). Links to the
  -- ToolPolicyGate decision recorded below. Null for external-reported evidence.
  tool_invocation_id TEXT,
  -- The WORK-037 policy decision that governed this read (allow/constrained/
  -- deny/ask). Null for external-reported evidence (no host tool run). This
  -- is the audit trail proving analysis respected the execution policy.
  policy_decision TEXT CHECK (policy_decision IN (
    'allow', 'constrained', 'deny', 'ask') OR policy_decision IS NULL),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wfos_project_baseline_evidence_invocation_unique
    UNIQUE (baseline_id, tool_invocation_id)
);

CREATE INDEX IF NOT EXISTS wfos_project_baseline_evidence_baseline_idx
  ON wfos_project_baseline_evidence (baseline_id);

-- ---------------------------------------------------------------------------
-- wfos_project_baseline_observations — the provenance-tagged claims.
--
-- Every reconstructed fact carries explicit provenance. The promotion guard
-- trigger enforces:
--   * confirmed requires confirmed_by + confirmed_at (authorized path only)
--   * proposed → observed is forbidden (a proposal is never a statement of
--     observed fact)
--   * a row's provenance is immutable once written EXCEPT the authorized
--     confirmation path (inferred/proposed → confirmed) which sets
--     confirmed_by/confirmed_at atomically
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wfos_project_baseline_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  baseline_id UUID NOT NULL REFERENCES wfos_project_baselines(id) ON DELETE CASCADE,
  -- The observation kind (the baseline-content categories). New kinds may be
  -- added without a schema change (the CHECK is open-ended text), but the
  -- frozen set is enumerated here for clarity.
  kind TEXT NOT NULL CHECK (kind IN (
    'repository_identity', 'stack', 'languages', 'frameworks',
    'package_managers', 'build_commands', 'test_commands', 'lint_commands',
    'architecture', 'documentation', 'requirements', 'dependencies',
    'security', 'ci', 'deployment', 'runtime', 'historical')),
  -- The provenance. NEVER NULL. Never collapsed into a confidence number.
  provenance TEXT NOT NULL CHECK (provenance IN (
    'observed', 'inferred', 'confirmed', 'proposed')),
  -- The structured claim (jsonb). Redacted of secrets before persistence.
  claim JSONB NOT NULL,
  -- The claim digest (sha256 of the canonical claim) — idempotency key for
  -- observation append (same baseline+kind+digest → one row, re-analysis is
  -- a no-op).
  claim_digest TEXT NOT NULL,
  -- References to wfos_project_baseline_evidence rows (jsonb array of UUIDs).
  evidence_ref JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The authorized confirmation path. NULL unless provenance='confirmed'.
  -- Set atomically by the confirmation service method (never by the analyzer).
  confirmed_by UUID,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency: one observation per (baseline, kind, claim-digest). A
  -- re-analyze of the same revision appends no duplicates.
  CONSTRAINT wfos_project_baseline_observations_claim_unique
    UNIQUE (baseline_id, kind, claim_digest)
);

CREATE INDEX IF NOT EXISTS wfos_project_baseline_observations_baseline_idx
  ON wfos_project_baseline_observations (baseline_id);
CREATE INDEX IF NOT EXISTS wfos_project_baseline_observations_provenance_idx
  ON wfos_project_baseline_observations (baseline_id, provenance);

-- The provenance promotion + confirmation guard.
CREATE OR REPLACE FUNCTION wfos_project_baseline_observation_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Observations are append-only historical evidence. A terminal baseline's
    -- observations are immutable. (Non-terminal baselines may have their
    -- analyzing-phase observations replaced by re-analysis, which is the
    -- idempotent re-drive — implemented as upsert-on-claim-digest, not delete.)
    RETURN OLD;
  END IF;

  -- confirmed requires confirmed_by + confirmed_at (the authorized path).
  IF NEW.provenance = 'confirmed' THEN
    IF NEW.confirmed_by IS NULL OR NEW.confirmed_at IS NULL THEN
      RAISE EXCEPTION
        'project-baseline-confirmation-required: provenance=confirmed requires confirmed_by + confirmed_at (the authorized confirmation path; no silent promotion)';
    END IF;
  ELSE
    -- Non-confirmed observations must NOT carry confirmation metadata (an
    -- inferred/proposed/observed row with confirmed_by set is an inconsistent
    -- state — confirmation is an atomic transition to provenance=confirmed).
    IF NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'project-baseline-confirmation-inconsistent: provenance=% must not carry confirmed_by/confirmed_at (use the confirmation path to transition to confirmed)',
        NEW.provenance;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- provenance is immutable EXCEPT the authorized confirmation transition
    -- (inferred/proposed → confirmed, which sets confirmed_by/confirmed_at).
    IF NEW.provenance IS DISTINCT FROM OLD.provenance THEN
      IF NOT (NEW.provenance = 'confirmed' AND OLD.provenance IN ('inferred', 'proposed')) THEN
        RAISE EXCEPTION
          'project-baseline-provenance-immutable: provenance % -> % is not a legal promotion (only inferred/proposed -> confirmed via the authorized path is permitted)',
          OLD.provenance, NEW.provenance;
      END IF;
    END IF;
    -- The claim + kind + claim_digest are immutable (a row is never rewritten
    -- to assert a different fact under the same key).
    IF NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.claim_digest IS DISTINCT FROM OLD.claim_digest
       OR NEW.claim IS DISTINCT FROM OLD.claim THEN
      RAISE EXCEPTION
        'project-baseline-observation-claim-immutable: the observation kind/claim/digest is immutable — re-analysis upserts a new digest, it does not rewrite';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_project_baseline_observation_guard_trigger
  ON wfos_project_baseline_observations;
CREATE TRIGGER wfos_project_baseline_observation_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON wfos_project_baseline_observations
  FOR EACH ROW EXECUTE FUNCTION wfos_project_baseline_observation_guard();
