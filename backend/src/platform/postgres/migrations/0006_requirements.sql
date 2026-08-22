-- WORK-006 schema: runtime /requirements domain — Requirements, Acceptance Criteria,
-- requirement dependencies, evidence references (REQ-001, REQ-002).
--
-- The /requirements module owns Requirement + AcceptanceCriterion domain authority.
-- It does NOT own verification semantics (later /verification) or work-item state
-- (later /work-items). Tenant scoping is inherited through the ArchitectureVersion
-- → Architecture → Project → Organization chain (reused WORK-002 AuthorizationService).
--
-- PostgreSQL is authoritative (§28). All integrity rules are database-enforced.

-- ---------------------------------------------------------------------------
-- Requirements (REQ-001). Each belongs to exactly one ArchitectureVersion.
-- The architecture_version FK provides the traceability chain:
--   Requirement → ArchitectureVersion → Architecture → Project → Organization
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_requirements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  architecture_version_id UUID NOT NULL REFERENCES wfos_architecture_versions(id) ON DELETE CASCADE,
  -- Stable human-readable identifier (e.g. 'AUTH-001'). Unique within an
  -- architecture version (REQ-AC-01). The same ID may appear under a different
  -- architecture version (a new version may re-state a requirement).
  requirement_id        TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  -- Verification-requirement metadata: what evidence/verification is expected.
  verification_requirement TEXT,
  -- Requirement status (distinct from criterion status). The frozen spec says
  -- "requirement status must not be based solely on an implementation agent's
  -- statement." We persist a status field that /verification will later derive
  -- from evidence, not from agent claims.
  status                TEXT NOT NULL DEFAULT 'pending',
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (architecture_version_id, requirement_id)
);

ALTER TABLE wfos_requirements
  DROP CONSTRAINT IF EXISTS wfos_requirements_status_check;
ALTER TABLE wfos_requirements
  ADD CONSTRAINT wfos_requirements_status_check
  CHECK (status IN ('pending', 'satisfied', 'blocked'));

CREATE INDEX wfos_requirements_version_idx ON wfos_requirements (architecture_version_id);

-- ---------------------------------------------------------------------------
-- Requirement dependencies (REQ-AC-03). A requirement may depend on another
-- requirement within the same architecture version. Self-dependency is prevented
-- by a CHECK constraint. The FK references ensure dependencies point to existing
-- requirements.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_requirement_dependencies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id      UUID NOT NULL REFERENCES wfos_requirements(id) ON DELETE CASCADE,
  depends_on_id       UUID NOT NULL REFERENCES wfos_requirements(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (requirement_id, depends_on_id),
  -- Prevent self-dependency (REQ-AC-03).
  CHECK (requirement_id <> depends_on_id)
);

CREATE INDEX wfos_requirement_deps_req_idx ON wfos_requirement_dependencies (requirement_id);
CREATE INDEX wfos_requirement_deps_dep_idx ON wfos_requirement_dependencies (depends_on_id);

-- ---------------------------------------------------------------------------
-- DB-level cross-tenant dependency guard (architect review PR #7).
--
-- A BEFORE INSERT/UPDATE trigger that verifies the source and target
-- requirements belong to the SAME architecture_version. Since each
-- architecture_version belongs to exactly one architecture → one project →
-- one organization, same-version implies same-tenant. A cross-tenant
-- dependency (Tenant A requirement → Tenant B requirement) is rejected by
-- PostgreSQL at the persistence level — NOT just a service/API check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_check_dependency_same_version()
RETURNS TRIGGER AS $$
DECLARE
  source_version UUID;
  target_version UUID;
BEGIN
  SELECT architecture_version_id INTO source_version
    FROM wfos_requirements WHERE id = NEW.requirement_id;
  SELECT architecture_version_id INTO target_version
    FROM wfos_requirements WHERE id = NEW.depends_on_id;
  IF source_version IS NULL OR target_version IS NULL THEN
    RAISE EXCEPTION 'cannot create dependency: source or target requirement not found'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF source_version <> target_version THEN
    RAISE EXCEPTION 'cross-tenant dependency: requirement % and dependency % belong to different architecture versions',
      NEW.requirement_id, NEW.depends_on_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_requirement_deps_same_version_check
  ON wfos_requirement_dependencies;
CREATE TRIGGER wfos_requirement_deps_same_version_check
  BEFORE INSERT OR UPDATE ON wfos_requirement_dependencies
  FOR EACH ROW EXECUTE FUNCTION wfos_check_dependency_same_version();

-- ---------------------------------------------------------------------------
-- Acceptance Criteria (REQ-002, AC-AC-01..04). Each belongs to exactly one
-- Requirement. Status constrained to PENDING/PASS/FAIL/BLOCKED (AC-AC-03).
-- Criterion IDs are unique per requirement (AC-AC-01).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_acceptance_criteria (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  UUID NOT NULL REFERENCES wfos_requirements(id) ON DELETE CASCADE,
  -- Stable criterion identifier (e.g. 'AC-1'). Unique per requirement.
  criterion_id    TEXT NOT NULL,
  description     TEXT NOT NULL,
  -- What verification is expected for this criterion to pass.
  verification_expectation TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (requirement_id, criterion_id)
);

ALTER TABLE wfos_acceptance_criteria
  DROP CONSTRAINT IF EXISTS wfos_criteria_status_check;
ALTER TABLE wfos_acceptance_criteria
  ADD CONSTRAINT wfos_criteria_status_check
  CHECK (status IN ('pending', 'pass', 'fail', 'blocked'));

CREATE INDEX wfos_acceptance_criteria_req_idx ON wfos_acceptance_criteria (requirement_id);

-- ---------------------------------------------------------------------------
-- Evidence references (AC-AC-04). Provider-independent references to evidence
-- that may later be produced by /verification. The /requirements module stores
-- only the reference; it does NOT interpret evidence (§9 of the WORK-006 prompt).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_criterion_evidence_references (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_id    UUID NOT NULL REFERENCES wfos_acceptance_criteria(id) ON DELETE CASCADE,
  -- Provider-independent evidence type (e.g. 'ci', 'test', 'static-analysis').
  evidence_type   TEXT NOT NULL,
  -- Provider-independent reference (e.g. a check-run id, a test name, an artifact key).
  evidence_ref    TEXT NOT NULL,
  -- The source/provider that produced the evidence (e.g. 'github-actions', 'vitest').
  source          TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wfos_criterion_evidence_criterion_idx ON wfos_criterion_evidence_references (criterion_id);
