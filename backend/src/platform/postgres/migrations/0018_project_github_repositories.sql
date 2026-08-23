-- WORK-026: project ↔ GitHub repository provisioning link.
-- Records the GitHub repo that was created for (or linked to) a project.
-- Distinct from wfos_project_repositories (the provider-independent association)
-- because this row carries GitHub-specific write metadata (installation_id,
-- default_branch, owner/repo) that the autonomous implementation loop needs.
CREATE TABLE IF NOT EXISTS wfos_project_github_repositories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  installation_id   TEXT NOT NULL,
  owner             TEXT NOT NULL,
  repository        TEXT NOT NULL,
  default_branch    TEXT NOT NULL DEFAULT 'main',
  -- 'created' (provisioned by WORK-026) | 'linked' (user-supplied existing repo)
  link_type         TEXT NOT NULL DEFAULT 'linked',
  external_repo_id  TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, installation_id, owner, repository)
);
ALTER TABLE wfos_project_github_repositories
  ADD CONSTRAINT wfos_project_github_repositories_link_type_check
  CHECK (link_type IN ('created', 'linked'));
CREATE INDEX IF NOT EXISTS idx_project_github_repositories_project
  ON wfos_project_github_repositories(project_id);
