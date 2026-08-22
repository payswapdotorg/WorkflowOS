-- WORK-008 schema: GitHub integration — webhook ingestion, event receipts,
-- idempotent processing (GITHUB-001..003).
--
-- The /github module owns GitHub-specific behavior. Webhook deliveries are
-- durably persisted in PostgreSQL (authoritative). Redis is used only for
-- the async queue (non-authoritative). Large payloads may use object storage.
--
-- PostgreSQL is authoritative (§28). All integrity rules are DB-enforced.

-- ---------------------------------------------------------------------------
-- GitHub webhook event receipts (GITHUB-002, idempotency).
-- Each delivery has a unique GitHub delivery ID (x-github-delivery header).
-- Duplicate deliveries with the same delivery_id are idempotent — the UNIQUE
-- constraint ensures only one receipt row per delivery_id.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_github_webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- GitHub delivery ID (x-github-delivery header). Unique — duplicate
  -- deliveries are rejected by the UNIQUE constraint (idempotency).
  delivery_id     TEXT NOT NULL UNIQUE,
  -- GitHub event type (x-github-event header, e.g. 'pull_request', 'push').
  event_type      TEXT NOT NULL,
  -- Repository identity from the payload (e.g. 'owner/repo' or repo id).
  repository_full_name TEXT,
  repository_id   TEXT,
  -- Signature validation result.
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  -- The raw payload may be stored inline (small) or in object storage (large).
  -- For WORK-008 we store inline; large payloads can use storage_key later.
  payload         TEXT NOT NULL,
  -- Processing state: 'received' → 'processing' → 'processed' / 'failed'.
  processing_state TEXT NOT NULL DEFAULT 'received',
  -- Error/retry metadata.
  error_message   TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  processed_at     TIMESTAMPTZ,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wfos_github_webhook_events
  DROP CONSTRAINT IF EXISTS wfos_github_webhook_events_state_check;
ALTER TABLE wfos_github_webhook_events
  ADD CONSTRAINT wfos_github_webhook_events_state_check
  CHECK (processing_state IN ('received', 'processing', 'processed', 'failed'));

CREATE INDEX wfos_github_webhook_events_type_idx ON wfos_github_webhook_events (event_type);
CREATE INDEX wfos_github_webhook_events_repo_idx ON wfos_github_webhook_events (repository_full_name);
CREATE INDEX wfos_github_webhook_events_state_idx ON wfos_github_webhook_events (processing_state);

-- ---------------------------------------------------------------------------
-- GitHub installation → project mapping (GITHUB-001).
-- Maps a GitHub App installation to a WorkflowOS project. This resolves
-- which project a webhook event belongs to (tenant isolation).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_github_installations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- GitHub installation ID (from the webhook payload or GitHub App config).
  installation_id     TEXT NOT NULL,
  -- The GitHub account/org that owns the installation.
  account_login       TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, installation_id)
);

CREATE INDEX wfos_github_installations_project_idx ON wfos_github_installations (project_id);
CREATE INDEX wfos_github_installations_installation_idx ON wfos_github_installations (installation_id);
