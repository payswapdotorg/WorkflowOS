-- V2-002 — Workflow Repository + Immutable Versioning (W1).
--
-- The Git-like durable repository model for V2 (spec/architecture/v2/
-- work-orders/V2-002.md; constitution §2 hierarchy, §14 repository/fork/
-- install, §19 forbidden drift):
--
--   WorkflowRepository-tenant (organization)
--     └── Workflow                          (durable identity; this migration)
--          ├── immutable WorkflowVersion    (content-addressed; this migration)
--          └── WorkflowInstallation         (pins ONE exact version; here as
--              └── WorkflowRun (V2-005 — NOT here)   the install/pin record)
--
-- Invariants enforced HERE (survive a buggy application caller):
--
--   1. IMMUTABLE VERSIONS: a BEFORE UPDATE OR DELETE trigger rejects EVERY
--      mutation of wfos_v2_workflow_versions — PostgreSQL itself makes
--      "silently alter immutable WorkflowVersions" (constitution §19)
--      structurally impossible. Editing creates a NEW version row.
--
--   2. CONTENT CONVERGENCE: the version identity is deterministic
--      (application-derived from workflow + content digest + protocol
--      descriptor) and UNIQUE (workflow_id, content_digest, protocol) —
--      duplicate version content converges on ONE immutable version row;
--      divergent duplicates are structurally unrepresentable.
--
--   3. INSTALL PINNING: an installation pins ONE exact version. The pin
--      columns (organization, workflow, version, installer) are immutable
--      by trigger; only the lifecycle status (enabled/disabled/uninstalled)
--      may change. DELETE is rejected — uninstall is a durable status, not
--      erasure (publisher edits can never mutate customer installs).
--
--   4. TUPLE INTEGRITY: composite foreign keys pin each installation to the
--      EXACT (workflow, version) pair — a version from another workflow is
--      structurally uninstallable.
--
-- V2 BOUNDARY NOTES (explicit, never silent):
--   - version `content` is an OPAQUE JSONB document. WorkflowIR semantics,
--     validation, and the SEMANTIC digest are owned by V2-003 (parallel
--     sibling, not consumed here). `content_digest` is the CONTENT digest
--     (SHA-256 over canonical JSON of the opaque document) — an
--     immutability/convergence proof, NEVER the semantic digest.
--   - `protocol` is the protocol-compatibility descriptor the version
--     author declares (currently `irSchemaVersion`, opaque to this layer).
--     It is persisted immutably and never interpreted here.
--   - no secret material is stored in ANY column here (constitution §16;
--     conformance checklist). Forks copy version content only — tenant
--     private state (installations/bindings) never transfers.
--   - PostgreSQL remains the authority (V2-002 work order); PGlite is the
--     Postgres-compatible test/dev implementation of the same boundary.
--
-- Naming: the wfos_v2_ prefix marks the V2 generation tables; no V1 table
-- (wfos_workflow_executions, …) is touched — this migration is purely
-- additive.

CREATE TABLE wfos_v2_workflows (
  -- Deterministic identity: application-derived from (organization, owner,
  -- slug) — authoritative inputs only, never randomUUID. Stored as TEXT (the
  -- prefixed hex identity form, e.g. wfw_<32hex>).
  id TEXT PRIMARY KEY,
  -- TENANT scope: the organization owning the workflow repository.
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  -- The durable owner (creator at fork time is the forker).
  owner_user_id UUID NOT NULL REFERENCES wfos_users(id),
  -- Immutable logical key within the tenant (the workflow "repo name").
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- Canonical visibility identifiers (V2-CTRL-003 registry: private |
  -- organization | public — no aliases).
  visibility TEXT NOT NULL
    CHECK (visibility IN ('private', 'organization', 'public')),
  -- The current head version (advanced only by creating a NEW version).
  head_version_id TEXT,
  -- FORK PROVENANCE (constitution §14: fork = NEW independent identity +
  -- preserved provenance). Both NULL for non-forks.
  forked_from_workflow_id TEXT REFERENCES wfos_v2_workflows(id),
  forked_from_version_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ONE workflow per slug per tenant: create-or-converge identity.
  CONSTRAINT wfos_v2_workflows_org_slug_uidx UNIQUE (organization_id, slug)
);

CREATE INDEX wfos_v2_workflows_org_idx ON wfos_v2_workflows (organization_id);
CREATE INDEX wfos_v2_workflows_owner_idx ON wfos_v2_workflows (owner_user_id);

CREATE TABLE wfos_v2_workflow_versions (
  -- Deterministic content-addressed identity: application-derived from
  -- (workflow_id, content_digest, protocol descriptor). Never random.
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES wfos_v2_workflows(id),
  -- Per-workflow human-friendly sequence (allocated from durable state;
  -- NOT the identity — the id above is).
  version_number INT NOT NULL CHECK (version_number > 0),
  -- CONTENT digest: SHA-256 (64 lowercase hex) over canonical JSON of the
  -- opaque content document. NOT the semantic digest (V2-003 owns that).
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  -- The OPAQUE version content (V2-003 owns semantics; structurally a JSON
  -- object here — a storage-shape constraint, not semantic validation).
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  -- The protocol-compatibility descriptor the author declared (opaque here).
  protocol JSONB NOT NULL CHECK (jsonb_typeof(protocol) = 'object'),
  -- Ancestry: the version this version was created after (NULL = root).
  parent_version_id TEXT REFERENCES wfos_v2_workflow_versions(id),
  created_by_user_id UUID NOT NULL REFERENCES wfos_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- CONTENT CONVERGENCE: the same content + protocol in one workflow can
  -- exist exactly ONCE (the deterministic id derives from these — this
  -- constraint is the persistence-layer defense in depth).
  CONSTRAINT wfos_v2_workflow_versions_content_uidx
    UNIQUE (workflow_id, content_digest, protocol),
  -- Sequence stability (allocation is transactional + retried on race).
  CONSTRAINT wfos_v2_workflow_versions_number_uidx
    UNIQUE (workflow_id, version_number),
  -- Tuple key for the installation composite FK (unique by construction:
  -- id is the primary key).
  CONSTRAINT wfos_v2_workflow_versions_workflow_id_uidx
    UNIQUE (workflow_id, id)
);

CREATE INDEX wfos_v2_workflow_versions_workflow_idx
  ON wfos_v2_workflow_versions (workflow_id);
CREATE INDEX wfos_v2_workflow_versions_parent_idx
  ON wfos_v2_workflow_versions (parent_version_id);

-- The head pointer is added AFTER the versions table exists (circular
-- reference workflows.head_version_id → versions.id ↔ versions.workflow_id
-- → workflows.id; PostgreSQL resolves it via ALTER TABLE).
ALTER TABLE wfos_v2_workflows
  ADD CONSTRAINT wfos_v2_workflows_head_version_fk
  FOREIGN KEY (head_version_id) REFERENCES wfos_v2_workflow_versions(id);

-- Fork provenance: the source VERSION must exist (it always already does —
-- a fork references an EXISTING source version, so this never deadlocks
-- creation order).
ALTER TABLE wfos_v2_workflows
  ADD CONSTRAINT wfos_v2_workflows_fork_version_fk
  FOREIGN KEY (forked_from_version_id) REFERENCES wfos_v2_workflow_versions(id);

CREATE TABLE wfos_v2_workflow_installations (
  -- Deterministic identity: application-derived from (tenant organization,
  -- pinned version) — authoritative inputs only.
  id TEXT PRIMARY KEY,
  -- The TENANT that installed (installs are tenant-scoped; the source
  -- workflow may belong to another tenant when visibility allows).
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  -- The pinned version (ONE exact immutable version per installation —
  -- constitution §2 hierarchy; publisher edits can never move it).
  workflow_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  installed_by_user_id UUID NOT NULL REFERENCES wfos_users(id),
  -- Install lifecycle (never mutates any historical version):
  --   enabled    — installed and active
  --   disabled   — installed, execution-paused (a later engine consumes it)
  --   uninstalled— removed from active use; durable history retained
  status TEXT NOT NULL DEFAULT 'enabled'
    CHECK (status IN ('enabled', 'disabled', 'uninstalled')),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ONE installation per (tenant, exact version): duplicate installs
  -- converge (idempotent).
  CONSTRAINT wfos_v2_workflow_installations_org_version_uidx
    UNIQUE (organization_id, version_id),
  -- TUPLE INTEGRITY: the installation's (workflow, version) pair must be a
  -- REAL version row of EXACTLY that workflow — a version from another
  -- workflow is structurally uninstallable.
  CONSTRAINT wfos_v2_workflow_installations_version_fk
    FOREIGN KEY (workflow_id, version_id)
    REFERENCES wfos_v2_workflow_versions (workflow_id, id)
);

CREATE INDEX wfos_v2_workflow_installations_org_idx
  ON wfos_v2_workflow_installations (organization_id);
CREATE INDEX wfos_v2_workflow_installations_workflow_idx
  ON wfos_v2_workflow_installations (workflow_id);

-- ---------------------------------------------------------------------------
-- INVARIANT 1 — immutable WorkflowVersions (constitution §19: "silently
-- alter immutable WorkflowVersions" is forbidden drift; this makes it
-- structurally impossible, even for a raw SQL writer).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_v2_workflow_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'WorkflowVersion % is immutable: % is forbidden (V2-002 — editing creates a NEW version)',
    COALESCE(OLD.id, NEW.id), TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER wfos_v2_workflow_version_immutable_trg
  BEFORE UPDATE OR DELETE ON wfos_v2_workflow_versions
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_workflow_version_immutable();

-- ---------------------------------------------------------------------------
-- INVARIANT 3 — the installation pin never moves and history is never
-- erased. Only the lifecycle status (+ updated_at) may change: enable /
-- disable / uninstall are policy states; the pinned version identity is
-- immutable for the installation's whole life.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_v2_workflow_installation_pin_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'WorkflowInstallation % pins version %: the pin is immutable and cannot be deleted (V2-002 — uninstall is a durable status, never erasure)',
      OLD.id, OLD.version_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.installed_by_user_id IS DISTINCT FROM OLD.installed_by_user_id
     OR NEW.installed_at IS DISTINCT FROM OLD.installed_at THEN
    RAISE EXCEPTION
      'WorkflowInstallation % pins version %: the pin is immutable (V2-002 — only the status may change)',
      OLD.id, OLD.version_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wfos_v2_workflow_installation_pin_trg
  BEFORE UPDATE OR DELETE ON wfos_v2_workflow_installations
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_workflow_installation_pin_immutable();
