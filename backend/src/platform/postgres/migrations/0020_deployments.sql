-- WORK-026: per-commit deployment records (preview URL, status, commit sha).
-- Written by the deployment provider adapter after the provider accepts the
-- deployment; read by the runtime status endpoint + the frontend.
CREATE TABLE IF NOT EXISTS wfos_deployments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id    UUID NOT NULL REFERENCES wfos_runtime_integrations(id) ON DELETE CASCADE,
  external_id       TEXT NOT NULL,           -- provider's deployment id
  status            TEXT NOT NULL,            -- 'queued' | 'building' | 'ready' | 'error' | 'canceled'
  preview_url       TEXT,
  commit_sha        TEXT,
  branch            TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (integration_id, external_id)
);
ALTER TABLE wfos_deployments
  ADD CONSTRAINT wfos_deployments_status_check
  CHECK (status IN ('queued', 'building', 'ready', 'error', 'canceled'));
CREATE INDEX IF NOT EXISTS idx_deployments_integration
  ON wfos_deployments(integration_id, created_at DESC);
