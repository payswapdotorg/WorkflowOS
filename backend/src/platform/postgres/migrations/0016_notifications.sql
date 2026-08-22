-- WORK-021 schema: Notification boundary (NOTIFY-001).
--
-- /notifications owns durable NotificationRequest persistence + delivery
-- status. Notifications are a side effect — they are NOT authoritative for
-- workflow/domain state (frozen architecture: "Notifications are a side
-- effect"). PostgreSQL is authoritative for durable notification records;
-- Redis is transport/coordination only.

CREATE TABLE wfos_notification_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping.
  organization_id   UUID REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  project_id        UUID REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- Notification identity.
  notification_type TEXT NOT NULL,
  -- Event type that triggered the notification (e.g. 'WORKFLOW_TRANSITION',
  -- 'REVIEW_FINALIZED', 'VERIFICATION_COMPLETED').
  event_type        TEXT NOT NULL,
  -- Recipient (provider-neutral reference: user ID, email, channel, etc.).
  recipient         TEXT NOT NULL,
  recipient_type    TEXT NOT NULL DEFAULT 'user',
  -- Safe message payload (subject, body, etc. — no secrets).
  subject           TEXT,
  body              TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Source traceability.
  source_type       TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  -- Optional domain references.
  work_item_id      UUID,
  review_id         UUID,
  verification_run_id UUID,
  audit_event_id    UUID,
  -- Execution/correlation ID.
  execution_id      TEXT,
  correlation_id    TEXT,
  -- Delivery status.
  status            TEXT NOT NULL DEFAULT 'pending',
  -- Idempotency key (scoped per source event + type + recipient).
  idempotency_key   TEXT,
  -- Provider that handled delivery (set when delivered).
  provider          TEXT,
  -- Delivery metadata (provider message ID, timestamps, etc.).
  delivery_metadata JSONB,
  -- Error message if delivery failed.
  error_message     TEXT,
  -- Retry tracking.
  retry_count       INTEGER NOT NULL DEFAULT 0,
  max_retries       INTEGER NOT NULL DEFAULT 3,
  -- Timestamps.
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency: one notification per (idempotency_key).
  -- NULL idempotency_key means no dedup (always create).
  CONSTRAINT wfos_notification_requests_idempotency_uniq UNIQUE (idempotency_key) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE wfos_notification_requests
  DROP CONSTRAINT IF EXISTS wfos_notification_requests_status_check;
ALTER TABLE wfos_notification_requests
  ADD CONSTRAINT wfos_notification_requests_status_check
  CHECK (status IN ('pending', 'queued', 'delivered', 'failed'));

CREATE INDEX wfos_notification_requests_project_idx ON wfos_notification_requests (project_id);
CREATE INDEX wfos_notification_requests_org_idx ON wfos_notification_requests (organization_id);
CREATE INDEX wfos_notification_requests_status_idx ON wfos_notification_requests (status);
CREATE INDEX wfos_notification_requests_source_idx ON wfos_notification_requests (source_type, source_id);
CREATE INDEX wfos_notification_requests_work_item_idx ON wfos_notification_requests (work_item_id);

-- updated_at trigger.
CREATE OR REPLACE FUNCTION wfos_notifications_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_notification_requests_set_updated_at ON wfos_notification_requests;
CREATE TRIGGER wfos_notification_requests_set_updated_at
  BEFORE UPDATE ON wfos_notification_requests
  FOR EACH ROW EXECUTE FUNCTION wfos_notifications_set_updated_at();
