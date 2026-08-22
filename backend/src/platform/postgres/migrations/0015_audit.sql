-- WORK-020 schema: Audit and privileged-event trail (AUDIT-001, WORKFLOW-005).
--
-- /audit owns durable AuditEvent persistence. The audit trail is append-oriented:
-- normal application operations must not UPDATE or DELETE audit events
-- (frozen architecture §31: "Audit history must not be casually editable
-- through normal application operations").
--
-- PostgreSQL is authoritative (§28). Redis is not used for audit durability.

-- ---------------------------------------------------------------------------
-- Audit events (AUDIT-001).
--
-- Each event captures: actor, timestamp, organization, project, entity,
-- action, source, before/after state, correlation/execution ID, and
-- structured metadata (architecture §31).
--
-- The table is append-only: a BEFORE UPDATE OR DELETE trigger rejects
-- normal application mutations (AUDIT-AC-02).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_audit_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping.
  organization_id   UUID REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  project_id        UUID REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- Event identity + type.
  event_type        TEXT NOT NULL,
  -- Actor/source metadata (architecture §31).
  actor             TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'system',
  -- Resource identification.
  resource_type     TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  -- Correlation/execution ID (architecture §35).
  execution_id      TEXT,
  correlation_id    TEXT,
  -- Safe before/after state (NOT full domain records — just safe identifiers).
  before_state      JSONB,
  after_state       JSONB,
  -- Structured metadata (safe: resource IDs, event type, safe summary,
  -- provider reference — NOT raw secrets, full payloads, or transcripts).
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Timestamp.
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Optional domain references (safe IDs only, not full records).
  work_item_id      UUID,
  work_order_id     UUID,
  architecture_version_id UUID,
  review_id         UUID,
  verification_run_id UUID,
  agent_run_id      UUID,
  pull_request_association_id UUID
);

CREATE INDEX wfos_audit_events_project_idx ON wfos_audit_events (project_id);
CREATE INDEX wfos_audit_events_org_idx ON wfos_audit_events (organization_id);
CREATE INDEX wfos_audit_events_type_idx ON wfos_audit_events (event_type);
CREATE INDEX wfos_audit_events_resource_idx ON wfos_audit_events (resource_type, resource_id);
CREATE INDEX wfos_audit_events_execution_idx ON wfos_audit_events (execution_id);
CREATE INDEX wfos_audit_events_created_at_idx ON wfos_audit_events (created_at DESC);

-- ---------------------------------------------------------------------------
-- Append-only protection (AUDIT-AC-02).
--
-- A BEFORE UPDATE OR DELETE trigger rejects normal application mutations.
-- Only a superuser-level override (e.g. database migration) can bypass this
-- — normal application code (including the AuditEventRepository) cannot
-- UPDATE or DELETE audit events.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_protect_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit append-only protection: UPDATE and DELETE on wfos_audit_events are forbidden (AUDIT-AC-02)'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_audit_events_no_update ON wfos_audit_events;
CREATE TRIGGER wfos_audit_events_no_update
  BEFORE UPDATE ON wfos_audit_events
  FOR EACH ROW EXECUTE FUNCTION wfos_protect_audit_append_only();

DROP TRIGGER IF EXISTS wfos_audit_events_no_delete ON wfos_audit_events;
CREATE TRIGGER wfos_audit_events_no_delete
  BEFORE DELETE ON wfos_audit_events
  FOR EACH ROW EXECUTE FUNCTION wfos_protect_audit_append_only();

-- ---------------------------------------------------------------------------
-- Resource integrity trigger.
--
-- WORK-020 correction (PR #19 issue 3): ensures that ALL persisted resource
-- references (work_item, work_order, architecture_version, review,
-- verification_run, agent_run, pull_request_association) belong to the same
-- project as the audit event's project_id. This prevents cross-tenant
-- resource references in audit events.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_check_audit_event_integrity()
RETURNS TRIGGER AS $$
DECLARE
  wi_project_id UUID;
  wo_project_id UUID;
  av_project_id UUID;
  rev_project_id UUID;
  vr_project_id UUID;
  ar_project_id UUID;
  pra_project_id UUID;
BEGIN
  -- Work Item: resolve via work_item → architecture_version → architecture → project
  IF NEW.work_item_id IS NOT NULL AND NEW.project_id IS NOT NULL THEN
    SELECT a.project_id INTO wi_project_id
      FROM wfos_work_items wi
      JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
      JOIN wfos_architectures a ON a.id = av.architecture_id
      WHERE wi.id = NEW.work_item_id;
    IF wi_project_id IS NOT NULL AND wi_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'audit event integrity: work item % belongs to project %, not project %',
        NEW.work_item_id, wi_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Work Order: resolve via work_order.project_id (denormalized)
  IF NEW.work_order_id IS NOT NULL AND NEW.project_id IS NOT NULL THEN
    SELECT project_id INTO wo_project_id
      FROM wfos_work_orders WHERE id = NEW.work_order_id;
    IF wo_project_id IS NOT NULL AND wo_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'audit event integrity: work order % belongs to project %, not project %',
        NEW.work_order_id, wo_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ArchitectureVersion: resolve via architecture_version → architecture → project
  IF NEW.architecture_version_id IS NOT NULL AND NEW.project_id IS NOT NULL THEN
    SELECT a.project_id INTO av_project_id
      FROM wfos_architecture_versions av
      JOIN wfos_architectures a ON a.id = av.architecture_id
      WHERE av.id = NEW.architecture_version_id;
    IF av_project_id IS NOT NULL AND av_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'audit event integrity: architecture version % belongs to project %, not project %',
        NEW.architecture_version_id, av_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Review: resolve via review.project_id
  IF NEW.review_id IS NOT NULL AND NEW.project_id IS NOT NULL THEN
    SELECT project_id INTO rev_project_id
      FROM wfos_reviews WHERE id = NEW.review_id;
    IF rev_project_id IS NOT NULL AND rev_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'audit event integrity: review % belongs to project %, not project %',
        NEW.review_id, rev_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- VerificationRun: resolve via verification_run.project_id
  IF NEW.verification_run_id IS NOT NULL AND NEW.project_id IS NOT NULL THEN
    SELECT project_id INTO vr_project_id
      FROM wfos_verification_runs WHERE id = NEW.verification_run_id;
    IF vr_project_id IS NOT NULL AND vr_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'audit event integrity: verification run % belongs to project %, not project %',
        NEW.verification_run_id, vr_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- AgentRun: resolve via agent_run.work_item_id → work_item → ... → project
  IF NEW.agent_run_id IS NOT NULL AND NEW.project_id IS NOT NULL THEN
    SELECT a.project_id INTO ar_project_id
      FROM wfos_agent_runs ar
      JOIN wfos_work_items wi ON wi.id = ar.work_item_id
      JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
      JOIN wfos_architectures a ON a.id = av.architecture_id
      WHERE ar.id = NEW.agent_run_id;
    IF ar_project_id IS NOT NULL AND ar_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'audit event integrity: agent run % belongs to project %, not project %',
        NEW.agent_run_id, ar_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- PullRequestAssociation: resolve via pull_request_association.work_item_id → ... → project
  IF NEW.pull_request_association_id IS NOT NULL AND NEW.project_id IS NOT NULL THEN
    SELECT a.project_id INTO pra_project_id
      FROM wfos_pull_request_associations pra
      JOIN wfos_work_items wi ON wi.id = pra.work_item_id
      JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
      JOIN wfos_architectures a ON a.id = av.architecture_id
      WHERE pra.id = NEW.pull_request_association_id;
    IF pra_project_id IS NOT NULL AND pra_project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'audit event integrity: pull request association % belongs to project %, not project %',
        NEW.pull_request_association_id, pra_project_id, NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_audit_events_integrity_check ON wfos_audit_events;
CREATE TRIGGER wfos_audit_events_integrity_check
  BEFORE INSERT ON wfos_audit_events
  FOR EACH ROW EXECUTE FUNCTION wfos_check_audit_event_integrity();
