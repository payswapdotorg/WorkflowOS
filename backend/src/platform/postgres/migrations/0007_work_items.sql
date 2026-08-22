-- WORK-007 schema: runtime /work-items domain — Work Items, dependencies,
-- PR associations, Work Order state (WORK-001..003, WORK-AC-01..04, DEP-AC-01..03,
-- WO-AC-01/02).
--
-- The /work-items module owns Work Item + Work Order domain authority. It does
-- NOT own workflow state (later /workflows), verification semantics (later
-- /verification), or GitHub integration (later /github). Tenant scoping is
-- inherited through the ArchitectureVersion → Architecture → Project →
-- Organization chain (reused WORK-002 AuthorizationService).
--
-- PostgreSQL is authoritative (§28). All integrity rules are DB-enforced.

-- ---------------------------------------------------------------------------
-- Work Items (WORK-001, WORK-AC-01). Each belongs to exactly one
-- ArchitectureVersion. The FK provides the traceability chain:
--   Work Item → ArchitectureVersion → Architecture → Project → Organization
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_work_items (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  architecture_version_id UUID NOT NULL REFERENCES wfos_architecture_versions(id) ON DELETE CASCADE,
  -- Stable human-readable work item ID (e.g. 'WORK-007').
  work_item_id            TEXT NOT NULL,
  title                   TEXT NOT NULL,
  objective               TEXT,
  scope                   TEXT,
  out_of_scope            TEXT,
  architecture_constraints TEXT,
  -- Assignment / execution metadata (persisted for later /agents / /llm).
  assignee                TEXT,
  execution_metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Completion flag: when true, dependent work items become eligible for
  -- implementation (DEP-AC-02). This is a minimal persisted signal that the
  -- dependency service checks; it does NOT implement the workflow state
  -- machine — /workflows will later derive this from verification/review state.
  completed               BOOLEAN NOT NULL DEFAULT false,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (architecture_version_id, work_item_id)
);

CREATE INDEX wfos_work_items_version_idx ON wfos_work_items (architecture_version_id);

-- ---------------------------------------------------------------------------
-- Work Item ↔ Requirement associations (WORK-007 §7). A Work Item may be
-- associated with multiple Requirements. The FK validates the requirement
-- exists. A trigger enforces the requirement belongs to the same
-- architecture_version as the work item (cross-project association rejected).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_work_item_requirements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id    UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  requirement_id  UUID NOT NULL REFERENCES wfos_requirements(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_item_id, requirement_id)
);

CREATE INDEX wfos_work_item_reqs_wi_idx ON wfos_work_item_requirements (work_item_id);

-- Trigger: work item requirement must be in the same architecture version.
CREATE OR REPLACE FUNCTION wfos_check_wi_req_same_version()
RETURNS TRIGGER AS $$
DECLARE
  wi_version UUID;
  req_version UUID;
BEGIN
  SELECT architecture_version_id INTO wi_version FROM wfos_work_items WHERE id = NEW.work_item_id;
  SELECT architecture_version_id INTO req_version FROM wfos_requirements WHERE id = NEW.requirement_id;
  IF wi_version IS NULL OR req_version IS NULL THEN
    RAISE EXCEPTION 'cannot associate: work item or requirement not found'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF wi_version <> req_version THEN
    RAISE EXCEPTION 'cross-version association: work item % and requirement % belong to different architecture versions',
      NEW.work_item_id, NEW.requirement_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_work_item_reqs_same_version_check
  ON wfos_work_item_requirements;
CREATE TRIGGER wfos_work_item_reqs_same_version_check
  BEFORE INSERT OR UPDATE ON wfos_work_item_requirements
  FOR EACH ROW EXECUTE FUNCTION wfos_check_wi_req_same_version();

-- ---------------------------------------------------------------------------
-- Work Item ↔ Acceptance Criterion associations (WORK-007 §7). The FK
-- validates the criterion exists. A trigger enforces the criterion's
-- requirement belongs to the same architecture_version.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_work_item_criteria (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id    UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  criterion_id    UUID NOT NULL REFERENCES wfos_acceptance_criteria(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_item_id, criterion_id)
);

CREATE INDEX wfos_work_item_crit_wi_idx ON wfos_work_item_criteria (work_item_id);

-- Trigger: work item criterion's requirement must be in the same architecture version.
CREATE OR REPLACE FUNCTION wfos_check_wi_crit_same_version()
RETURNS TRIGGER AS $$
DECLARE
  wi_version UUID;
  crit_req UUID;
  req_version UUID;
BEGIN
  SELECT architecture_version_id INTO wi_version FROM wfos_work_items WHERE id = NEW.work_item_id;
  SELECT requirement_id INTO crit_req FROM wfos_acceptance_criteria WHERE id = NEW.criterion_id;
  IF crit_req IS NOT NULL THEN
    SELECT architecture_version_id INTO req_version FROM wfos_requirements WHERE id = crit_req;
  END IF;
  IF wi_version IS NULL OR req_version IS NULL THEN
    RAISE EXCEPTION 'cannot associate: work item or criterion not found'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF wi_version <> req_version THEN
    RAISE EXCEPTION 'cross-version association: work item % and criterion % belong to different architecture versions',
      NEW.work_item_id, NEW.criterion_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_work_item_crit_same_version_check
  ON wfos_work_item_criteria;
CREATE TRIGGER wfos_work_item_crit_same_version_check
  BEFORE INSERT OR UPDATE ON wfos_work_item_criteria
  FOR EACH ROW EXECUTE FUNCTION wfos_check_wi_crit_same_version();

-- ---------------------------------------------------------------------------
-- Work Item dependencies (WORK-002, DEP-AC-01..03). Self-dependency prevented
-- by CHECK. FKs ensure targets exist. A trigger enforces same-version
-- (cross-tenant dependency prevention, matching WORK-006's pattern).
-- Cycle detection is enforced at the application layer (recursive CTE query)
-- because PostgreSQL CHECK constraints cannot express graph invariants.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_work_item_dependencies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id    UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  depends_on_id   UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_item_id, depends_on_id),
  CHECK (work_item_id <> depends_on_id)
);

CREATE INDEX wfos_work_item_deps_wi_idx ON wfos_work_item_dependencies (work_item_id);
CREATE INDEX wfos_work_item_deps_dep_idx ON wfos_work_item_dependencies (depends_on_id);

-- Trigger: work item dependency must be in the same architecture version.
CREATE OR REPLACE FUNCTION wfos_check_wi_dep_same_version()
RETURNS TRIGGER AS $$
DECLARE
  src_version UUID;
  tgt_version UUID;
BEGIN
  SELECT architecture_version_id INTO src_version FROM wfos_work_items WHERE id = NEW.work_item_id;
  SELECT architecture_version_id INTO tgt_version FROM wfos_work_items WHERE id = NEW.depends_on_id;
  IF src_version IS NULL OR tgt_version IS NULL THEN
    RAISE EXCEPTION 'cannot create dependency: source or target work item not found'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF src_version <> tgt_version THEN
    RAISE EXCEPTION 'cross-version dependency: work item % and dependency % belong to different architecture versions',
      NEW.work_item_id, NEW.depends_on_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_work_item_deps_same_version_check
  ON wfos_work_item_dependencies;
CREATE TRIGGER wfos_work_item_deps_same_version_check
  BEFORE INSERT OR UPDATE ON wfos_work_item_dependencies
  FOR EACH ROW EXECUTE FUNCTION wfos_check_wi_dep_same_version();

-- ---------------------------------------------------------------------------
-- Pull Request associations (WORK-AC-02..04). Provider-independent.
-- A Work Item may have many PR associations over time (WORK-AC-02).
-- At most ONE active PR per work item (WORK-AC-03) — enforced by a partial
-- unique index on (work_item_id) WHERE status = 'active'.
-- A PR may associate with multiple work items (WORK-AC-04).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_pull_request_associations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id    UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  -- Provider-independent external PR reference (e.g. 'github:owner/repo#123').
  external_pr_id  TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'github',
  repository_ref  TEXT,
  branch          TEXT,
  base_branch     TEXT,
  head_commit     TEXT,
  -- Status distinguishes active from historical (superseded/closed).
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at   TIMESTAMPTZ
);

ALTER TABLE wfos_pull_request_associations
  DROP CONSTRAINT IF EXISTS wfos_pr_assoc_status_check;
ALTER TABLE wfos_pull_request_associations
  ADD CONSTRAINT wfos_pr_assoc_status_check
  CHECK (status IN ('active', 'superseded', 'closed', 'merged'));

CREATE INDEX wfos_pr_assoc_wi_idx ON wfos_pull_request_associations (work_item_id);
CREATE INDEX wfos_pr_assoc_external_idx ON wfos_pull_request_associations (external_pr_id);

-- Partial unique index: at most ONE active PR per work item (WORK-AC-03).
-- This is a PERSISTENCE-LEVEL enforcement — two concurrent inserts of active
-- PRs for the same work item are rejected by PostgreSQL, not just app logic.
CREATE UNIQUE INDEX wfos_pr_assoc_one_active_per_wi
  ON wfos_pull_request_associations (work_item_id)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Work Orders (WO-AC-01/02). Owned by /work-items. A Work Order is the
-- implementation instruction for an agent. It references project, work item,
-- architecture version, requirements, criteria, constraints, verification
-- requirements, scope/out-of-scope. State is minimal: 'draft' / 'generated' /
-- 'consumed' (the frozen spec does not define an exhaustive list).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_work_orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id            UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  -- Project / architecture version are denormalized for the work order's
  -- self-contained contract (consumed by /llm /agents without re-walking
  -- the chain).
  project_id               UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  architecture_version_id  UUID NOT NULL REFERENCES wfos_architecture_versions(id) ON DELETE CASCADE,
  -- Requirement / criterion / constraint references stored as JSON arrays
  -- of UUIDs. The work order is a snapshot of the context needed by the agent.
  requirement_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  criterion_ids           JSONB NOT NULL DEFAULT '[]'::jsonb,
  architecture_constraints TEXT,
  -- Implementation context (repository context, scope, out-of-scope).
  implementation_context   JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope                    TEXT,
  out_of_scope            TEXT,
  -- Verification requirements for this work order.
  verification_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Work Order state (owned by /work-items, NOT /workflows).
  state                   TEXT NOT NULL DEFAULT 'draft',
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wfos_work_orders
  DROP CONSTRAINT IF EXISTS wfos_work_orders_state_check;
ALTER TABLE wfos_work_orders
  ADD CONSTRAINT wfos_work_orders_state_check
  CHECK (state IN ('draft', 'generated', 'consumed'));

CREATE INDEX wfos_work_orders_wi_idx ON wfos_work_orders (work_item_id);

-- ---------------------------------------------------------------------------
-- Work Order traceability/tenant-integrity trigger (architect review PR #8).
--
-- Ensures the work_order's architecture_version_id matches the work_item's
-- architecture_version_id, and the project_id matches the architecture
-- version's architecture's project. A work order whose project_id or
-- architecture_version_id describes a different project than the work item
-- is rejected by PostgreSQL at the persistence level — NOT just app logic.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_check_work_order_integrity()
RETURNS TRIGGER AS $$
DECLARE
  wi_version UUID;
  wi_arch_id UUID;
  wi_project_id UUID;
BEGIN
  -- Resolve the work item's architecture version.
  SELECT architecture_version_id INTO wi_version
    FROM wfos_work_items WHERE id = NEW.work_item_id;
  IF wi_version IS NULL THEN
    RAISE EXCEPTION 'work order integrity: work item % not found', NEW.work_item_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The work order's architecture_version_id must match the work item's.
  IF NEW.architecture_version_id <> wi_version THEN
    RAISE EXCEPTION 'work order integrity: architecture_version_id % does not match work item %''s version %',
      NEW.architecture_version_id, NEW.work_item_id, wi_version
      USING ERRCODE = 'check_violation';
  END IF;

  -- Resolve the project from the architecture version → architecture chain.
  SELECT a.project_id INTO wi_project_id
    FROM wfos_architecture_versions v
    JOIN wfos_architectures a ON a.id = v.architecture_id
    WHERE v.id = wi_version;

  -- The work order's project_id must match the work item's project.
  IF NEW.project_id <> wi_project_id THEN
    RAISE EXCEPTION 'work order integrity: project_id % does not match work item %''s project %',
      NEW.project_id, NEW.work_item_id, wi_project_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_work_orders_integrity_check ON wfos_work_orders;
CREATE TRIGGER wfos_work_orders_integrity_check
  BEFORE INSERT OR UPDATE ON wfos_work_orders
  FOR EACH ROW EXECUTE FUNCTION wfos_check_work_order_integrity();
