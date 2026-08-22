-- WORK-016 schema: Architect Reviews and Review Findings (REVIEW-001, REVIEW-002).
--
-- Boundary ownership (frozen architecture §6, §19, §20; architecture-lock.md §61):
--   /reviews owns Architect Review + Review Finding persistence and semantics.
--   /llm     owns architect role execution (LLM reasoning) — the review record
--            stores a reference to the architect execution, not the execution itself.
--   /verification owns evidence + criterion evaluation — findings reference
--                  evidence/criteria but /reviews does NOT evaluate them.
--   /workflows owns canonical workflow state — /reviews exposes a public
--              review-result contract that /workflows consumes; /reviews MUST NOT
--              mutate wfos_workflow_executions.
--   /work-items owns Work Item + Work Order — reviews reference them via FK.
--   /architecture owns ArchitectureVersion — reviews reference; a verdict of
--                  ARCHITECTURE_CHANGE_REQUIRED does NOT mutate the version.
--
-- PostgreSQL is authoritative (§28). Reviews + Findings are append-oriented /
-- historical — once finalized, a review's outcome is immutable (FINDING-AC-03
-- correction-cycle traceability requires prior reviews to remain retrievable).

-- ---------------------------------------------------------------------------
-- Architect Reviews (REVIEW-001).
--
-- A durable record of an architect review against a Work Item's implementation
-- attempt. References (does not duplicate) the Work Item, Work Order,
-- ArchitectureVersion, and the architect execution that produced the verdict.
--
-- Traceability chain (frozen architecture §19, §25, §35):
--   Review → Work Item → ArchitectureVersion → Architecture → Project → Organization
--   Review → Work Order (where applicable)
--   Review → Architect Execution (where the review originated from /llm)
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_reviews (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping (project the review belongs to).
  project_id               UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- Work Item being reviewed (FK to /work-items authority).
  work_item_id             UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  -- Work Order that drove the implementation being reviewed (optional).
  work_order_id            UUID REFERENCES wfos_work_orders(id) ON DELETE SET NULL,
  -- ArchitectureVersion the Work Item belongs to (denormalized for the
  -- self-contained review contract + traceability).
  architecture_version_id  UUID NOT NULL REFERENCES wfos_architecture_versions(id) ON DELETE CASCADE,
  -- Pull Request association (optional — the PR under review).
  pull_request_association_id UUID REFERENCES wfos_pull_request_associations(id) ON DELETE SET NULL,
  -- Architect execution reference (traceability to /llm). NULL when the review
  -- was recorded manually (not from an LLM execution).
  architect_execution_id   TEXT,
  -- Reviewer/actor/source metadata (architecture §19, §31).
  -- source: 'architect-llm' | 'manual' | 'agent'
  -- reviewer: the LLM provider+model identifier (e.g. 'fake/test-model') or
  --           the human actor's identifier.
  source                   TEXT NOT NULL,
  reviewer                 TEXT,
  -- Execution/correlation ID (architecture §35).
  execution_id             TEXT NOT NULL,
  -- Review lifecycle status: 'in_progress' | 'completed'.
  -- (Distinct from the verdict — a review starts 'in_progress' and is
  --  finalized to 'completed' with an immutable outcome.)
  status                   TEXT NOT NULL DEFAULT 'in_progress',
  -- Review verdict/outcome (frozen architecture §19 canonical verdicts).
  -- NULL while the review is 'in_progress'; set when finalized.
  -- Valid values: 'APPROVE' | 'REQUEST_CHANGES' | 'ARCHITECTURE_CHANGE_REQUIRED' | 'IMPLEMENTATION_BLOCKED'
  outcome                  TEXT,
  -- Summary/rationale (the architect's overall reasoning).
  summary                  TEXT,
  -- Structured input/context that produced the verdict (traceability to /llm).
  -- Includes the assembled architect context (requirements, criteria, evidence
  -- references) at the time of review.
  review_input             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Additional metadata.
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Lifecycle timestamps.
  started_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wfos_reviews
  DROP CONSTRAINT IF EXISTS wfos_reviews_status_check;
ALTER TABLE wfos_reviews
  ADD CONSTRAINT wfos_reviews_status_check
  CHECK (status IN ('in_progress', 'completed'));

ALTER TABLE wfos_reviews
  DROP CONSTRAINT IF EXISTS wfos_reviews_outcome_check;
ALTER TABLE wfos_reviews
  ADD CONSTRAINT wfos_reviews_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('APPROVE', 'REQUEST_CHANGES', 'ARCHITECTURE_CHANGE_REQUIRED', 'IMPLEMENTATION_BLOCKED'));

-- A finalized review (status='completed') MUST have an outcome.
ALTER TABLE wfos_reviews
  DROP CONSTRAINT IF EXISTS wfos_reviews_completed_requires_outcome;
ALTER TABLE wfos_reviews
  ADD CONSTRAINT wfos_reviews_completed_requires_outcome
  CHECK (status != 'completed' OR outcome IS NOT NULL);

CREATE INDEX wfos_reviews_project_idx ON wfos_reviews (project_id);
CREATE INDEX wfos_reviews_work_item_idx ON wfos_reviews (work_item_id);
CREATE INDEX wfos_reviews_execution_idx ON wfos_reviews (execution_id);

-- ---------------------------------------------------------------------------
-- Review → Work Item / Work Order / PR association integrity trigger.
--
-- Ensures:
-- 1. The review's architecture_version_id matches the Work Item's
--    architecture_version_id.
-- 2. project_id matches the architecture version → architecture → project chain.
-- 3. When work_order_id is set, the Work Order belongs to the same Work Item
--    (PR #15 architect review — gap 1: a caller could otherwise attach another
--    Work Item's Work Order to a review).
-- 4. When pull_request_association_id is set, the PR association belongs to
--    the same Work Item (PR #15 architect review — gap 2: a caller could
--    otherwise attach another Work Item's PR to a review, creating misleading
--    cross-work-item traceability).
--
-- PERSISTENCE-LEVEL enforcement (analogous to
-- wfos_check_work_order_integrity from WORK-007 and
-- wfos_check_verification_run_integrity from WORK-015).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_check_review_integrity()
RETURNS TRIGGER AS $$
DECLARE
  wi_version UUID;
  wi_project_id UUID;
  wo_work_item_id UUID;
  pra_work_item_id UUID;
BEGIN
  SELECT architecture_version_id INTO wi_version
    FROM wfos_work_items WHERE id = NEW.work_item_id;
  IF wi_version IS NULL THEN
    RAISE EXCEPTION 'review integrity: work item % not found', NEW.work_item_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.architecture_version_id <> wi_version THEN
    RAISE EXCEPTION 'review integrity: architecture_version_id % does not match work item %''s version %',
      NEW.architecture_version_id, NEW.work_item_id, wi_version
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.project_id INTO wi_project_id
    FROM wfos_architecture_versions v
    JOIN wfos_architectures a ON a.id = v.architecture_id
    WHERE v.id = wi_version;

  IF NEW.project_id <> wi_project_id THEN
    RAISE EXCEPTION 'review integrity: project_id % does not match work item %''s project %',
      NEW.project_id, NEW.work_item_id, wi_project_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Gap 1: Work Order must belong to the same Work Item.
  IF NEW.work_order_id IS NOT NULL THEN
    SELECT work_item_id INTO wo_work_item_id
      FROM wfos_work_orders WHERE id = NEW.work_order_id;
    IF wo_work_item_id IS NULL THEN
      RAISE EXCEPTION 'review integrity: work order % not found', NEW.work_order_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF wo_work_item_id <> NEW.work_item_id THEN
      RAISE EXCEPTION 'review integrity: work order % belongs to work item %, not work item %',
        NEW.work_order_id, wo_work_item_id, NEW.work_item_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Gap 2: PR association must belong to the same Work Item.
  IF NEW.pull_request_association_id IS NOT NULL THEN
    SELECT work_item_id INTO pra_work_item_id
      FROM wfos_pull_request_associations WHERE id = NEW.pull_request_association_id;
    IF pra_work_item_id IS NULL THEN
      RAISE EXCEPTION 'review integrity: pull request association % not found', NEW.pull_request_association_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF pra_work_item_id <> NEW.work_item_id THEN
      RAISE EXCEPTION 'review integrity: pull request association % belongs to work item %, not work item %',
        NEW.pull_request_association_id, pra_work_item_id, NEW.work_item_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_reviews_integrity_check ON wfos_reviews;
CREATE TRIGGER wfos_reviews_integrity_check
  BEFORE INSERT OR UPDATE ON wfos_reviews
  FOR EACH ROW EXECUTE FUNCTION wfos_check_review_integrity();

-- ---------------------------------------------------------------------------
-- Review Findings (REVIEW-002).
--
-- Findings are first-class persisted records. Each finding belongs to exactly
-- one Review. Findings reference (do not duplicate) requirements/criteria/
-- evidence owned by /requirements and /verification.
--
-- Correction-cycle traceability (FINDING-AC-03): a finding may reference the
-- prior finding that caused the correction cycle via caused_by_finding_id.
-- This links Review #2's findings back to Review #1's findings.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_review_findings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping.
  project_id               UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- The review this finding belongs to.
  review_id                UUID NOT NULL REFERENCES wfos_reviews(id) ON DELETE CASCADE,
  -- Severity (frozen field name; enum values defined by WORK-016 since the
  -- spec does not enumerate them).
  -- Valid values: 'blocker' | 'major' | 'minor' | 'info'
  severity                 TEXT NOT NULL DEFAULT 'major',
  -- Title/summary (short).
  title                    TEXT NOT NULL,
  -- Detailed description.
  description              TEXT NOT NULL,
  -- Affected scope: free-text description of what's affected.
  affected_scope           TEXT,
  -- Related Requirement (optional — FK to /requirements authority).
  requirement_id           UUID REFERENCES wfos_requirements(id) ON DELETE SET NULL,
  -- Related Acceptance Criterion (optional — FK to /requirements authority).
  criterion_id             UUID REFERENCES wfos_acceptance_criteria(id) ON DELETE SET NULL,
  -- Related evidence reference (optional — free-text reference to /verification
  -- evidence. /reviews does NOT own evidence; it references it by id/URL).
  evidence_ref             TEXT,
  -- Required correction (what needs to be fixed).
  required_correction      TEXT,
  -- Verification requirement (what verification should confirm the fix).
  verification_requirement TEXT,
  -- Finding disposition/status (for correction-cycle traceability).
  -- Valid values: 'open' | 'resolved' | 'wont_fix'
  disposition              TEXT NOT NULL DEFAULT 'open',
  -- Correction-cycle link-back (FINDING-AC-03): the prior finding that caused
  -- the correction cycle this finding addresses. NULL for original findings.
  caused_by_finding_id     UUID REFERENCES wfos_review_findings(id) ON DELETE SET NULL,
  -- Additional metadata.
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wfos_review_findings
  DROP CONSTRAINT IF EXISTS wfos_review_findings_severity_check;
ALTER TABLE wfos_review_findings
  ADD CONSTRAINT wfos_review_findings_severity_check
  CHECK (severity IN ('blocker', 'major', 'minor', 'info'));

ALTER TABLE wfos_review_findings
  DROP CONSTRAINT IF EXISTS wfos_review_findings_disposition_check;
ALTER TABLE wfos_review_findings
  ADD CONSTRAINT wfos_review_findings_disposition_check
  CHECK (disposition IN ('open', 'resolved', 'wont_fix'));

CREATE INDEX wfos_review_findings_project_idx ON wfos_review_findings (project_id);
CREATE INDEX wfos_review_findings_review_idx ON wfos_review_findings (review_id);
CREATE INDEX wfos_review_findings_criterion_idx ON wfos_review_findings (criterion_id);
CREATE INDEX wfos_review_findings_caused_by_idx ON wfos_review_findings (caused_by_finding_id);

-- ---------------------------------------------------------------------------
-- Finding → Review integrity trigger.
--
-- Ensures the finding's project_id matches the review's project_id (tenant
-- isolation — a cross-tenant finding is rejected at the DB level). Also
-- ensures the optional criterion belongs to the same project (cross-tenant
-- criterion reference rejected).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_check_review_finding_integrity()
RETURNS TRIGGER AS $$
DECLARE
  rev_project_id UUID;
  crit_project_id UUID;
  req_project_id UUID;
  caused_by_project_id UUID;
BEGIN
  SELECT project_id INTO rev_project_id
    FROM wfos_reviews WHERE id = NEW.review_id;
  IF rev_project_id IS NULL THEN
    RAISE EXCEPTION 'review finding integrity: review % not found', NEW.review_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF rev_project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'review finding integrity: cross-tenant finding rejected (review project % vs finding project %)',
      rev_project_id, NEW.project_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- If a criterion is referenced, it must belong to the same project.
  IF NEW.criterion_id IS NOT NULL THEN
    SELECT a.project_id INTO crit_project_id
      FROM wfos_acceptance_criteria c
      JOIN wfos_requirements r ON r.id = c.requirement_id
      JOIN wfos_architecture_versions v ON v.id = r.architecture_version_id
      JOIN wfos_architectures a ON a.id = v.architecture_id
      WHERE c.id = NEW.criterion_id;
    IF crit_project_id IS NULL THEN
      RAISE EXCEPTION 'review finding integrity: criterion % not found', NEW.criterion_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF crit_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'review finding integrity: cross-tenant criterion rejected (criterion project % vs finding project %)',
        crit_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Gap 3 (PR #15 architect review): if a requirement is referenced, it must
  -- belong to the same project as the finding. Resolves through:
  --   requirement → architecture_version → architecture → project
  -- A cross-tenant requirement reference is rejected at the DB level.
  IF NEW.requirement_id IS NOT NULL THEN
    SELECT a.project_id INTO req_project_id
      FROM wfos_requirements r
      JOIN wfos_architecture_versions v ON v.id = r.architecture_version_id
      JOIN wfos_architectures a ON a.id = v.architecture_id
      WHERE r.id = NEW.requirement_id;
    IF req_project_id IS NULL THEN
      RAISE EXCEPTION 'review finding integrity: requirement % not found', NEW.requirement_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF req_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'review finding integrity: cross-tenant requirement rejected (requirement project % vs finding project %)',
        req_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Gap 4 (PR #15 architect review): if caused_by_finding_id is set, the
  -- causing finding must belong to the same project as the new finding. This
  -- prevents cross-tenant correction-cycle links. The finding's project_id
  -- is stored directly on the finding row.
  IF NEW.caused_by_finding_id IS NOT NULL THEN
    SELECT project_id INTO caused_by_project_id
      FROM wfos_review_findings WHERE id = NEW.caused_by_finding_id;
    IF caused_by_project_id IS NULL THEN
      RAISE EXCEPTION 'review finding integrity: caused_by_finding % not found', NEW.caused_by_finding_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF caused_by_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'review finding integrity: cross-tenant caused_by_finding rejected (causing finding project % vs finding project %)',
        caused_by_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_review_findings_integrity_check ON wfos_review_findings;
CREATE TRIGGER wfos_review_findings_integrity_check
  BEFORE INSERT OR UPDATE ON wfos_review_findings
  FOR EACH ROW EXECUTE FUNCTION wfos_check_review_finding_integrity();

-- ---------------------------------------------------------------------------
-- updated_at triggers (consistent with the rest of the codebase).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_reviews_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_reviews_set_updated_at ON wfos_reviews;
CREATE TRIGGER wfos_reviews_set_updated_at
  BEFORE UPDATE ON wfos_reviews
  FOR EACH ROW EXECUTE FUNCTION wfos_reviews_set_updated_at();

DROP TRIGGER IF EXISTS wfos_review_findings_set_updated_at ON wfos_review_findings;
CREATE TRIGGER wfos_review_findings_set_updated_at
  BEFORE UPDATE ON wfos_review_findings
  FOR EACH ROW EXECUTE FUNCTION wfos_reviews_set_updated_at();
