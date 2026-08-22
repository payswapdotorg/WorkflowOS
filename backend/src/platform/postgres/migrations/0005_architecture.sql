-- WORK-005 schema: runtime /architecture domain — Architecture, ArchitectureVersion,
-- Architecture Decision Records, Architecture Change Requests (ARCH-001..004).
--
-- This migration implements the PROJECT-SPECIFIC runtime architecture domain
-- (spec/architecture.md §9). It is distinct from the frozen repository
-- governance documents (/spec/architecture.md, /spec/architecture-lock.md)
-- which are NOT modified.
--
-- All tables are tenant-scoped through the owning project's organization
-- (AUTHZ, reused from WORK-002). PostgreSQL is authoritative (§28).
-- Large immutable architecture content uses the existing ObjectStore
-- abstraction (DATA-003); only references + metadata live here.

-- ---------------------------------------------------------------------------
-- Architectures. A versioned project artifact (§9). Belongs to exactly one
-- tenant-owned project.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_architectures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, name)
);

CREATE INDEX wfos_architectures_project_idx ON wfos_architectures (project_id);

-- ---------------------------------------------------------------------------
-- Architecture Versions (ARCH-001, ARCH-AC-01/02). Each belongs to exactly
-- one Architecture. Lifecycle: DRAFT → FROZEN → SUPERSEDED (§9).
--
-- IMMUTABILITY (ARCH2-AC-01/02): a FROZEN version's content columns cannot be
-- updated. This is enforced at the PERSISTENCE level via a BEFORE UPDATE
-- trigger that raises an exception when state = 'FROZEN' and any content
-- column is being changed. This is NOT a service-layer check — a direct
-- UPDATE on a frozen row is rejected by PostgreSQL itself.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_architecture_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  architecture_id UUID NOT NULL REFERENCES wfos_architectures(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'draft',
  -- Content may be inline (small) or referenced from ObjectStore (large).
  content_inline  TEXT,
  storage_key     TEXT,
  storage_provider TEXT,
  content_length  BIGINT NOT NULL DEFAULT 0,
  content_type    TEXT,
  digest_sha256   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  frozen_at       TIMESTAMPTZ,
  frozen_by       UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (architecture_id, version_number)
);

-- CHECK constraint enforces the explicit lifecycle state set (ARCH-AC-02).
ALTER TABLE wfos_architecture_versions
  DROP CONSTRAINT IF EXISTS wfos_arch_versions_state_check;
ALTER TABLE wfos_architecture_versions
  ADD CONSTRAINT wfos_arch_versions_state_check
  CHECK (state IN ('draft', 'frozen', 'superseded'));

CREATE INDEX wfos_arch_versions_arch_idx ON wfos_architecture_versions (architecture_id);

-- ---------------------------------------------------------------------------
-- IMMUTABILITY TRIGGER (ARCH2-AC-01/02).
--
-- A BEFORE UPDATE trigger that rejects any mutation of content columns on a
-- FROZEN row. The `state` column itself may change (FROZEN → SUPERSEDED) but
-- the content (content_inline, storage_key, metadata, etc.) is locked.
--
-- This is a PERSISTENCE-LEVEL enforcement — even a direct
-- `UPDATE wfos_architecture_versions SET content_inline = 'tampered' WHERE
--  state = 'frozen'` is rejected by PostgreSQL. Not just a service check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_protect_frozen_version()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.state = 'frozen' THEN
    -- Content columns that must not change once frozen.
    IF NEW.content_inline IS DISTINCT FROM OLD.content_inline
       OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
       OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
       OR NEW.content_length IS DISTINCT FROM OLD.content_length
       OR NEW.content_type IS DISTINCT FROM OLD.content_type
       OR NEW.digest_sha256 IS DISTINCT FROM OLD.digest_sha256
       OR NEW.metadata IS DISTINCT FROM OLD.metadata
       OR NEW.version_number IS DISTINCT FROM OLD.version_number
       OR NEW.architecture_id IS DISTINCT FROM OLD.architecture_id THEN
      RAISE EXCEPTION 'cannot mutate frozen architecture version %', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_arch_versions_protect_frozen ON wfos_architecture_versions;
CREATE TRIGGER wfos_arch_versions_protect_frozen
  BEFORE UPDATE ON wfos_architecture_versions
  FOR EACH ROW EXECUTE FUNCTION wfos_protect_frozen_version();

-- ---------------------------------------------------------------------------
-- Architecture Decision Records (ARCH-003, ARCH3-AC-01/02). Each ADR belongs
-- to exactly one ArchitectureVersion; the FK enforces the relationship.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_architecture_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id      UUID NOT NULL REFERENCES wfos_architecture_versions(id) ON DELETE CASCADE,
  adr_number       INTEGER NOT NULL,
  title           TEXT NOT NULL,
  -- Decision content may be inline or in object storage.
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'proposed',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (version_id, adr_number)
);

CREATE INDEX wfos_arch_decisions_version_idx ON wfos_architecture_decisions (version_id);

-- ---------------------------------------------------------------------------
-- Architecture Change Requests (ARCH-004, ARCH4-AC-01/02/03). Explicit,
-- auditable lifecycle: REQUESTED → APPROVED/REJECTED (§40).
-- Only an APPROVED Change Request may initiate replacement-version creation.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_architecture_change_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  architecture_id     UUID NOT NULL REFERENCES wfos_architectures(id) ON DELETE CASCADE,
  affected_version_id UUID REFERENCES wfos_architecture_versions(id),
  requester_id        UUID,
  reason              TEXT NOT NULL,
  requested_change    TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'requested',
  approver_id         UUID,
  approved_at         TIMESTAMPTZ,
  -- The replacement version created by an approved change (null until created).
  replacement_version_id UUID REFERENCES wfos_architecture_versions(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wfos_architecture_change_requests
  DROP CONSTRAINT IF EXISTS wfos_arch_cr_status_check;
ALTER TABLE wfos_architecture_change_requests
  ADD CONSTRAINT wfos_arch_cr_status_check
  CHECK (status IN ('requested', 'approved', 'rejected'));

CREATE INDEX wfos_arch_cr_arch_idx ON wfos_architecture_change_requests (architecture_id);
CREATE INDEX wfos_arch_cr_status_idx ON wfos_architecture_change_requests (status);
