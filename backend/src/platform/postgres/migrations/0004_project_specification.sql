-- WORK-004 schema: authoritative project domain + specification lifecycle
-- (PROJ-001, SPEC-001).
--
-- This migration EVOLVES the existing WORK-002 `wfos_projects` table into the
-- authoritative project domain (PROJ-001) — it does NOT create a competing
-- project table. It adds:
--   - project lifecycle state (PROJ-AC-03)
--   - project metadata
--   - a provider-independent project repository association table (PROJ-AC-02)
--   - the specification domain (wfos_specifications + wfos_specification_versions)
--
-- All tables are tenant-scoped through the owning organization (AUTHZ). The
-- authorization boundary (AuthorizationService) is reused unchanged; no
-- project/spec-specific authorization logic is introduced.
--
-- PostgreSQL is authoritative (architecture §28). Large/immutable
-- specification bodies are stored via the existing ObjectStore abstraction
-- (DATA-003); only references + metadata live here.

-- ---------------------------------------------------------------------------
-- Evolve wfos_projects: add lifecycle state + metadata.
-- The existing columns (id, organization_id, name, created_at) are preserved
-- so WORK-002 project_access rows and authorization decisions remain valid.
-- ---------------------------------------------------------------------------
ALTER TABLE wfos_projects
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- CHECK constraint enforces the explicit lifecycle state set (PROJ-AC-03).
-- States are minimal and derived from the frozen specification's notion of
-- project activity (architecture §8) — a project is either active or
-- archived. No workflow state machine is implemented here.
ALTER TABLE wfos_projects
  DROP CONSTRAINT IF EXISTS wfos_projects_state_check;
ALTER TABLE wfos_projects
  ADD CONSTRAINT wfos_projects_state_check
  CHECK (state IN ('active', 'archived'));

-- Updated-at trigger so lifecycle transitions record a fresh timestamp.
CREATE OR REPLACE FUNCTION wfos_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_projects_touch_updated_at ON wfos_projects;
CREATE TRIGGER wfos_projects_touch_updated_at
  BEFORE UPDATE ON wfos_projects
  FOR EACH ROW EXECUTE FUNCTION wfos_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Provider-independent project repository association (PROJ-AC-02).
--
-- A project may be associated with one or more external repositories. The
-- association stores only a provider-independent reference (provider name +
-- external repository identifier + canonical location). It does NOT couple
-- to the GitHub SDK or any provider runtime — that belongs to WORK-008.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_project_repositories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- Provider name (e.g. 'github'). Provider-specific behavior lives in /github.
  provider        TEXT NOT NULL,
  -- Provider-specific external repository identifier (e.g. 'repo-id' or
  -- 'owner/name'). Opaque to /projects; interpreted only by the provider adapter.
  external_id     TEXT NOT NULL,
  -- Canonical location/reference (e.g. 'https://github.com/owner/repo').
  canonical_ref   TEXT NOT NULL,
  -- Free-form provider-independent metadata for the association.
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A project may not have two associations for the same (provider, external_id).
  UNIQUE (project_id, provider, external_id)
);

CREATE INDEX wfos_project_repositories_project_idx
  ON wfos_project_repositories (project_id);
CREATE INDEX wfos_project_repositories_provider_idx
  ON wfos_project_repositories (provider, external_id);

-- ---------------------------------------------------------------------------
-- Specifications (SPEC-001). A specification belongs to exactly one project
-- (architecture §6, /specifications module). Tenant-scoping is inherited
-- through the project's owning organization.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_specifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- Stable human-readable identifier within the project (e.g. 'spec-001').
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  -- Explicit lifecycle state (SPEC-AC-02). Minimal states derived from the
  -- frozen specification's notion of a document lifecycle: draft → published
  -- → archived. Validated by a CHECK constraint + application transition rules.
  state           TEXT NOT NULL DEFAULT 'draft',
  -- Current version number; increments on each published version
  -- (SPEC-AC-03 content/version traceability).
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, slug)
);

ALTER TABLE wfos_specifications
  DROP CONSTRAINT IF EXISTS wfos_specifications_state_check;
ALTER TABLE wfos_specifications
  ADD CONSTRAINT wfos_specifications_state_check
  CHECK (state IN ('draft', 'published', 'archived'));

DROP TRIGGER IF EXISTS wfos_specifications_touch_updated_at ON wfos_specifications;
CREATE TRIGGER wfos_specifications_touch_updated_at
  BEFORE UPDATE ON wfos_specifications
  FOR EACH ROW EXECUTE FUNCTION wfos_touch_updated_at();

CREATE INDEX wfos_specifications_project_idx ON wfos_specifications (project_id);

-- ---------------------------------------------------------------------------
-- Specification versions (SPEC-AC-03). Each version is an immutable record of
-- the specification's content at a point in time. Large content bodies are
-- stored via the ObjectStore abstraction (DATA-003); only the opaque
-- storage_key + metadata live here.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_specification_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  specification_id    UUID NOT NULL REFERENCES wfos_specifications(id) ON DELETE CASCADE,
  version_number      INTEGER NOT NULL,
  -- Provider-independent object-storage reference for large/immutable content.
  -- When the content is small, this may be null and `content_inline` is used.
  storage_key         TEXT,
  storage_provider    TEXT,
  -- For small specs, content may be stored inline. Large bodies MUST use
  -- object storage (architecture §30, DATA3-AC-02).
  content_inline      TEXT,
  content_length      BIGINT NOT NULL DEFAULT 0,
  content_type        TEXT,
  digest_sha256       TEXT,
  -- Author who created this version.
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (specification_id, version_number)
);

CREATE INDEX wfos_specification_versions_spec_idx
  ON wfos_specification_versions (specification_id);
