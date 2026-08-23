-- WORK-025: Architect conversation sessions + revisions.
--
-- Persists the conversational Architect workspace so the user can leave the
-- page and return to continue the same architecture session. Each project
-- can have one active architect session at a time.
--
-- Revisions are immutable history entries — one per user message + architect
-- response. They support the "Revision 1 → feedback → Revision 2 → Accept"
-- workflow.

CREATE TABLE IF NOT EXISTS wfos_architect_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active', -- active | accepted | abandoned
  provider        TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
  parsed_plan     JSONB,
  revision_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_architect_sessions_project
  ON wfos_architect_sessions(project_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_architect_sessions_active_project
  ON wfos_architect_sessions(project_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS wfos_architect_revisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES wfos_architect_sessions(id) ON DELETE CASCADE,
  revision_number   INTEGER NOT NULL,
  user_prompt       TEXT NOT NULL,
  architect_response TEXT NOT NULL,
  parsed_plan       JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_architect_revisions_session
  ON wfos_architect_revisions(session_id);
