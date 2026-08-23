-- WORK-025: Architect conversation sessions.
--
-- Persists the conversational Architect workspace so the user can leave the
-- page and return to continue the same architecture session. Each project
-- can have one active architect session at a time.

CREATE TABLE IF NOT EXISTS wfos_architect_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active', -- active | accepted | abandoned
  provider        TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- messages: [{ role: 'user'|'assistant', content: string, timestamp: string }]
  parsed_plan     JSONB, -- last parsed generated plan (architecture/reqs/work items)
  revision_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_architect_sessions_project
  ON wfos_architect_sessions(project_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_architect_sessions_active_project
  ON wfos_architect_sessions(project_id)
  WHERE status = 'active';
