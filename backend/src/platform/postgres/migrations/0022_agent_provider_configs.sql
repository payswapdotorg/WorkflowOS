-- WORK-026: optional per-project agent provider config row.
-- When absent, the platform DefaultAgentProviderRegistry (env-var backed) is
-- used. When present, it overrides per-project (e.g. one project uses Gemini,
-- another uses Claude). Stores NO secret values — only readiness-relevant
-- metadata + a SecretStore ref name. The actual key lives in EnvSecretStore
-- or a future Vault-backed SecretStore.
CREATE TABLE IF NOT EXISTS wfos_agent_provider_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  -- Name of the SecretStore ref that holds the API key. NOT the key value.
  secret_ref      TEXT NOT NULL,
  -- Readiness metadata (display name, base url, max tokens, etc.) — no secrets.
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, provider, model)
);
-- At most one default per project.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_provider_configs_default
  ON wfos_agent_provider_configs(project_id)
  WHERE is_default = true;
