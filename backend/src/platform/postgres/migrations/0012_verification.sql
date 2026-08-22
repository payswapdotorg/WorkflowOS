-- WORK-015 schema: CI ingestion + verification engine (VERIFY-001..003, GITHUB-006).
--
-- Boundary ownership (frozen architecture §24, §25; architecture-lock.md §51):
--   /github   owns GitHub integration + CI result ingestion (GITHUB-006).
--   /verification owns VerificationRun, Evidence, evidence→criterion mapping,
--                  criterion/requirement evaluation (VERIFY-001..003).
--
-- PostgreSQL is authoritative (§28). Large CI/verification artifacts go to
-- the existing ObjectStore abstraction (§30, DATA-003); PostgreSQL holds
-- metadata + storage references only. No duplicate artifact store is created.

-- ---------------------------------------------------------------------------
-- GitHub CI evidence ingestion (GITHUB-006).
--
-- `/github` translates GitHub Actions check_run / workflow_run webhook events
-- into provider-independent CI evidence rows. The table is owned by /github;
-- /verification READS these rows (via the provider-independent
-- CiEvidenceIngestionRepository contract) and copies the canonical fields it
-- needs into its own wfos_evidence table when creating a VerificationRun.
--
-- Idempotency (§22, GITHUB-004): a UNIQUE(provider, external_run_id) constraint
-- ensures a re-delivered GitHub Actions event produces one CI evidence row, not
-- duplicates. Re-processing updates the same row.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_github_ci_evidence (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping (resolved from the installation → project association).
  project_id            UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- Provider is always 'github' for this table; kept as a column so the
  -- provider-independent contract can later support other CI providers
  -- without a schema change.
  provider              TEXT NOT NULL DEFAULT 'github',
  -- GitHub-native run identity. Used for idempotency (UNIQUE below).
  external_run_id       TEXT NOT NULL,
  -- GitHub workflow / check name (e.g. 'CI', 'build-and-test').
  workflow_name         TEXT,
  check_name            TEXT,
  -- Repository reference (provider-independent canonical form).
  repository_full_name  TEXT,
  -- Commit / SHA the CI run evaluated.
  head_sha              TEXT,
  -- Branch / ref (when applicable).
  branch                TEXT,
  -- GitHub Actions status + conclusion (provider-native values preserved
  -- verbatim so the translation layer is the only place that maps them to
  -- the /verification evidence result vocabulary).
  status                TEXT,
  conclusion            TEXT,
  -- Run URL (provider-native).
  run_url               TEXT,
  -- Run timestamps (GitHub-provided).
  run_started_at       TIMESTAMPTZ,
  run_completed_at      TIMESTAMPTZ,
  -- Artifact references (JSONB array of provider-independent
  -- { name, content_type, storage_key?, external_url?, size_bytes? } objects).
  -- Large artifact BODIES live in ObjectStore; only references live here.
  artifact_references   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Raw provider metadata (kept for traceability; never interpreted by
  -- /verification — /github is the only module that translates it).
  provider_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The webhook delivery that produced this CI evidence (traceability).
  -- Stored as TEXT (not a UUID FK) because:
  -- - the manual ingestion path may not have a real webhook event;
  -- - the CI evidence is self-contained (has its own external_run_id for
  --   idempotency);
  -- - the traceability is also captured in provider_metadata.
  -- When the ingestion comes from a real webhook event, this field holds the
  -- webhook event's UUID (as a string).
  webhook_event_id      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency: one CI evidence row per (provider, external_run_id).
  CONSTRAINT wfos_github_ci_evidence_provider_run_uniq UNIQUE (provider, external_run_id)
);

CREATE INDEX wfos_github_ci_evidence_project_idx ON wfos_github_ci_evidence (project_id);
CREATE INDEX wfos_github_ci_evidence_sha_idx ON wfos_github_ci_evidence (head_sha);
CREATE INDEX wfos_github_ci_evidence_repo_idx ON wfos_github_ci_evidence (repository_full_name);

-- ---------------------------------------------------------------------------
-- VerificationRun (VERIFY-001).
--
-- A durable record of a verification execution against one Work Item's
-- implementation attempt. Owned by /verification.
--
-- Traceability chain (frozen architecture §25):
--   VerificationRun → Work Item → ArchitectureVersion → Architecture → Project
--   VerificationRun → Work Order (where applicable)
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_verification_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping.
  project_id               UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- Work Item being verified (FK to /work-items authority).
  work_item_id             UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  -- Work Order that drove the implementation being verified (optional —
  -- a verification run may be triggered without a Work Order, e.g. ad-hoc).
  work_order_id            UUID REFERENCES wfos_work_orders(id) ON DELETE SET NULL,
  -- ArchitectureVersion the Work Item belongs to (denormalized for the
  -- self-contained verification contract).
  architecture_version_id  UUID NOT NULL REFERENCES wfos_architecture_versions(id) ON DELETE CASCADE,
  -- Source/reference context (e.g. 'github-actions', 'manual', 'agent').
  source                   TEXT NOT NULL,
  -- Provider-independent reference (commit SHA, PR ref, etc.).
  source_ref               TEXT,
  -- Verification status: 'pending' | 'running' | 'completed' | 'failed'.
  -- (These are VerificationRun lifecycle states, NOT criterion statuses. The
  --  criterion status enum PENDING/PASS/FAIL/BLOCKED is owned by /requirements.)
  status                   TEXT NOT NULL DEFAULT 'pending',
  -- Execution/correlation ID (architecture §35).
  execution_id             TEXT NOT NULL,
  -- Lifecycle timestamps.
  started_at               TIMESTAMPTZ,
  finished_at              TIMESTAMPTZ,
  -- Summary/result metadata (counts, derived signals, etc.).
  summary                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Failure/error metadata (when status='failed').
  error_metadata           JSONB,
  -- Additional metadata (provider, version, etc.).
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wfos_verification_runs
  DROP CONSTRAINT IF EXISTS wfos_verification_runs_status_check;
ALTER TABLE wfos_verification_runs
  ADD CONSTRAINT wfos_verification_runs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed'));

CREATE INDEX wfos_verification_runs_project_idx ON wfos_verification_runs (project_id);
CREATE INDEX wfos_verification_runs_work_item_idx ON wfos_verification_runs (work_item_id);
CREATE INDEX wfos_verification_runs_execution_idx ON wfos_verification_runs (execution_id);

-- ---------------------------------------------------------------------------
-- VerificationRun ↔ Work Item integrity trigger.
--
-- Ensures the verification run's architecture_version_id matches the Work
-- Item's architecture_version_id, and project_id matches the architecture
-- version → architecture → project chain. This is PERSISTENCE-LEVEL
-- enforcement (analogous to wfos_check_work_order_integrity from WORK-007) —
-- a direct INSERT with mismatched IDs is rejected by PostgreSQL itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_check_verification_run_integrity()
RETURNS TRIGGER AS $$
DECLARE
  wi_version UUID;
  wi_project_id UUID;
BEGIN
  SELECT architecture_version_id INTO wi_version
    FROM wfos_work_items WHERE id = NEW.work_item_id;
  IF wi_version IS NULL THEN
    RAISE EXCEPTION 'verification run integrity: work item % not found', NEW.work_item_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.architecture_version_id <> wi_version THEN
    RAISE EXCEPTION 'verification run integrity: architecture_version_id % does not match work item %''s version %',
      NEW.architecture_version_id, NEW.work_item_id, wi_version
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.project_id INTO wi_project_id
    FROM wfos_architecture_versions v
    JOIN wfos_architectures a ON a.id = v.architecture_id
    WHERE v.id = wi_version;

  IF NEW.project_id <> wi_project_id THEN
    RAISE EXCEPTION 'verification run integrity: project_id % does not match work item %''s project %',
      NEW.project_id, NEW.work_item_id, wi_project_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_verification_runs_integrity_check ON wfos_verification_runs;
CREATE TRIGGER wfos_verification_runs_integrity_check
  BEFORE INSERT OR UPDATE ON wfos_verification_runs
  FOR EACH ROW EXECUTE FUNCTION wfos_check_verification_run_integrity();

-- ---------------------------------------------------------------------------
-- Evidence (VERIFY-001).
--
-- Provider-independent evidence records owned by /verification. An Evidence
-- row is the canonical, durable record that supports a criterion evaluation.
--
-- Large bodies (CI logs, test output, build artifacts) live in ObjectStore;
-- the `storage_key` + `storage_provider` columns hold the reference. The full
-- artifact body is NEVER required in this row (DATA3-AC-02).
--
-- Authority distinction (architecture §2.2, §15, §25; VERIFY-EVAL-AC-02/03):
--   evidence.authority = 'authoritative'   → CI results ingested via /github,
--                                              manual verification by an
--                                              authorized reviewer, etc.
--   evidence.authority = 'claim'           → agent-reported test results,
--                                              LLM/Architect output, GitHub
--                                              labels/comments — NEVER
--                                              sufficient alone for PASS.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_evidence (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping (project the evidence belongs to).
  project_id            UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- The verification run this evidence was attached to. Evidence always
  -- belongs to exactly one VerificationRun (per the pipeline).
  verification_run_id   UUID NOT NULL REFERENCES wfos_verification_runs(id) ON DELETE CASCADE,
  -- Evidence type/source classification:
  --   'ci' | 'test' | 'static-analysis' | 'architecture-check' |
  --   'manual' | 'agent-claim' | 'llm-claim' | 'other'
  evidence_type         TEXT NOT NULL,
  -- Authority classification ('authoritative' | 'claim'). See block comment.
  authority             TEXT NOT NULL DEFAULT 'authoritative',
  -- Provider that produced the evidence ('github', 'agent', 'llm', 'manual').
  provider              TEXT NOT NULL,
  -- Provider-native external reference (e.g. GitHub check run URL).
  external_ref          TEXT,
  -- Commit / SHA the evidence applies to (when applicable).
  head_sha              TEXT,
  -- Result/status of this evidence (provider-independent vocabulary owned by
  -- /verification). Values: 'pass' | 'fail' | 'blocked' | 'unknown'.
  result                TEXT NOT NULL DEFAULT 'unknown',
  -- Content/summary (small, inline). For large bodies use storage_key.
  content_summary       TEXT,
  -- ObjectStore reference for the full artifact body (NULL when the evidence
  -- has no large body — e.g. a simple CI pass/fail row).
  storage_key           TEXT,
  storage_provider      TEXT,
  -- Artifact metadata (digest / size / content-type) for the stored body.
  artifact_digest       TEXT,
  artifact_size_bytes   BIGINT,
  artifact_content_type TEXT,
  -- Flexible metadata (provider-specific fields kept for traceability).
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wfos_evidence
  DROP CONSTRAINT IF EXISTS wfos_evidence_authority_check;
ALTER TABLE wfos_evidence
  ADD CONSTRAINT wfos_evidence_authority_check
  CHECK (authority IN ('authoritative', 'claim'));

ALTER TABLE wfos_evidence
  DROP CONSTRAINT IF EXISTS wfos_evidence_result_check;
ALTER TABLE wfos_evidence
  ADD CONSTRAINT wfos_evidence_result_check
  CHECK (result IN ('pass', 'fail', 'blocked', 'unknown'));

CREATE INDEX wfos_evidence_project_idx ON wfos_evidence (project_id);
CREATE INDEX wfos_evidence_run_idx ON wfos_evidence (verification_run_id);
CREATE INDEX wfos_evidence_type_idx ON wfos_evidence (evidence_type);

-- ---------------------------------------------------------------------------
-- CriterionEvidenceMapping (VERIFY-002).
--
-- Explicit, persisted evidence→criterion mapping. A mapping says "this
-- specific evidence row proves/supports this specific acceptance criterion".
--
-- This is the core of the frozen rule (architecture §25 line 737): "The
-- verification layer must associate evidence with the criteria it actually
-- proves." A passing CI run cannot blanket-mark unrelated criteria PASS
-- (VERIFY-EVAL-AC-02) — every PASS must be backed by an explicit mapping to
-- authoritative evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_criterion_evidence_mappings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping.
  project_id            UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- The verification run this mapping belongs to.
  verification_run_id   UUID NOT NULL REFERENCES wfos_verification_runs(id) ON DELETE CASCADE,
  -- The evidence being mapped.
  evidence_id           UUID NOT NULL REFERENCES wfos_evidence(id) ON DELETE CASCADE,
  -- The criterion the evidence proves/supports. FK to /requirements authority.
  criterion_id          UUID NOT NULL REFERENCES wfos_acceptance_criteria(id) ON DELETE CASCADE,
  -- Relevance/relationship: 'proves' | 'supports' | 'contradicts' | 'blocks'.
  relevance             TEXT NOT NULL DEFAULT 'supports',
  -- Mapping status: 'active' | 'superseded'. Allows historical mappings to be
  -- preserved (per the idempotency rule — repeated processing doesn't
  -- overwrite history) while only 'active' mappings drive evaluation.
  mapping_status        TEXT NOT NULL DEFAULT 'active',
  -- Source metadata (who/what created the mapping — e.g. 'auto:github-check',
  -- 'manual', 'agent-suggestion').
  source                TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A single evidence row may map to multiple criteria, but the
  -- (evidence_id, criterion_id, mapping_status='active') tuple must be
  -- unique — re-processing the same mapping is idempotent.
  CONSTRAINT wfos_criterion_evidence_mappings_active_uniq UNIQUE (evidence_id, criterion_id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE wfos_criterion_evidence_mappings
  DROP CONSTRAINT IF EXISTS wfos_criterion_evidence_mappings_relevance_check;
ALTER TABLE wfos_criterion_evidence_mappings
  ADD CONSTRAINT wfos_criterion_evidence_mappings_relevance_check
  CHECK (relevance IN ('proves', 'supports', 'contradicts', 'blocks'));

ALTER TABLE wfos_criterion_evidence_mappings
  DROP CONSTRAINT IF EXISTS wfos_criterion_evidence_mappings_status_check;
ALTER TABLE wfos_criterion_evidence_mappings
  ADD CONSTRAINT wfos_criterion_evidence_mappings_status_check
  CHECK (mapping_status IN ('active', 'superseded'));

CREATE INDEX wfos_criterion_evidence_mappings_run_idx ON wfos_criterion_evidence_mappings (verification_run_id);
CREATE INDEX wfos_criterion_evidence_mappings_evidence_idx ON wfos_criterion_evidence_mappings (evidence_id);
CREATE INDEX wfos_criterion_evidence_mappings_criterion_idx ON wfos_criterion_evidence_mappings (criterion_id);

-- ---------------------------------------------------------------------------
-- Mapping integrity trigger.
--
-- Ensures the evidence being mapped belongs to the same verification_run_id
-- claimed on the mapping row, AND that the evidence's project_id matches the
-- mapping's project_id (tenant isolation — a cross-tenant mapping is rejected
-- at the persistence layer, not just at the service layer).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_check_criterion_evidence_mapping_integrity()
RETURNS TRIGGER AS $$
DECLARE
  ev_run_id UUID;
  ev_project_id UUID;
  crit_project_id UUID;
BEGIN
  SELECT verification_run_id, project_id INTO ev_run_id, ev_project_id
    FROM wfos_evidence WHERE id = NEW.evidence_id;
  IF ev_run_id IS NULL THEN
    RAISE EXCEPTION 'criterion evidence mapping integrity: evidence % not found', NEW.evidence_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF ev_run_id <> NEW.verification_run_id THEN
    RAISE EXCEPTION 'criterion evidence mapping integrity: evidence % belongs to run %, not run %',
      NEW.evidence_id, ev_run_id, NEW.verification_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF ev_project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'criterion evidence mapping integrity: cross-tenant mapping rejected (evidence project % vs mapping project %)',
      ev_project_id, NEW.project_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Criterion ↔ project consistency (tenant isolation): the criterion must
  -- belong to the same project as the mapping. Resolves through:
  --   criterion → requirement → architecture_version → architecture → project
  -- A cross-tenant criterion substitution (e.g. project A's evidence mapped
  -- to project B's criterion) is rejected at the persistence layer.
  SELECT a.project_id INTO crit_project_id
    FROM wfos_acceptance_criteria c
    JOIN wfos_requirements r ON r.id = c.requirement_id
    JOIN wfos_architecture_versions v ON v.id = r.architecture_version_id
    JOIN wfos_architectures a ON a.id = v.architecture_id
    WHERE c.id = NEW.criterion_id;

  IF crit_project_id IS NULL THEN
    RAISE EXCEPTION 'criterion evidence mapping integrity: criterion % not found', NEW.criterion_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF crit_project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'criterion evidence mapping integrity: cross-tenant criterion rejected (criterion project % vs mapping project %)',
      crit_project_id, NEW.project_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_criterion_evidence_mappings_integrity_check ON wfos_criterion_evidence_mappings;
CREATE TRIGGER wfos_criterion_evidence_mappings_integrity_check
  BEFORE INSERT OR UPDATE ON wfos_criterion_evidence_mappings
  FOR EACH ROW EXECUTE FUNCTION wfos_check_criterion_evidence_mapping_integrity();

-- ---------------------------------------------------------------------------
-- updated_at triggers (consistent with the rest of the codebase).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_verification_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_verification_runs_set_updated_at ON wfos_verification_runs;
CREATE TRIGGER wfos_verification_runs_set_updated_at
  BEFORE UPDATE ON wfos_verification_runs
  FOR EACH ROW EXECUTE FUNCTION wfos_verification_set_updated_at();

DROP TRIGGER IF EXISTS wfos_evidence_set_updated_at ON wfos_evidence;
CREATE TRIGGER wfos_evidence_set_updated_at
  BEFORE UPDATE ON wfos_evidence
  FOR EACH ROW EXECUTE FUNCTION wfos_verification_set_updated_at();

DROP TRIGGER IF EXISTS wfos_criterion_evidence_mappings_set_updated_at ON wfos_criterion_evidence_mappings;
CREATE TRIGGER wfos_criterion_evidence_mappings_set_updated_at
  BEFORE UPDATE ON wfos_criterion_evidence_mappings
  FOR EACH ROW EXECUTE FUNCTION wfos_verification_set_updated_at();

DROP TRIGGER IF EXISTS wfos_github_ci_evidence_set_updated_at ON wfos_github_ci_evidence;
CREATE TRIGGER wfos_github_ci_evidence_set_updated_at
  BEFORE UPDATE ON wfos_github_ci_evidence
  FOR EACH ROW EXECUTE FUNCTION wfos_verification_set_updated_at();
