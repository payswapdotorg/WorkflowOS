-- WORK-026: provider-independent deployment integration link.
-- One row per (project, deployment-provider) pair, e.g. a Vercel project link.
-- Holds the external project id + opaque metadata. Actual deployment records
-- live in wfos_deployments (migration 0020).
CREATE TABLE IF NOT EXISTS wfos_runtime_integrations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,            -- 'vercel' | 'fake' | future
  project_external_id TEXT NOT NULL,            -- the provider's project id
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_runtime_integrations_project
  ON wfos_runtime_integrations(project_id);
