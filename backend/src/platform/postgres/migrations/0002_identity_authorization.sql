-- WORK-002 schema: identity, organizations, permissions, tenant isolation (AUTH-001..003, SEC-001).
--
-- This migration creates the persistence structures required for WORK-002
-- ONLY. It reuses the WORK-003 database client / migration system; it does
-- NOT introduce a second database or persistence framework.
--
-- Tables here are authoritative WorkflowOS application state (architecture §28,
-- §2.1). Redis MUST NOT hold authoritative identity/membership/permission/
-- tenant state (architecture §29, DATA2-AC-02).
--
-- Provider credentials and secrets are NOT stored here (architecture §33,
-- SEC-AC-02). The secret-management abstraction (platform/secrets/) is the
-- only sanctioned way to access raw secret values; ordinary domain records
-- hold only opaque secret *references* (e.g. an env var name or a key id),
-- never the secret itself.

-- ---------------------------------------------------------------------------
-- Users (AUTH-001). WorkflowOS user identity resolved from authentication.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable external principal identifier supplied by the AuthProvider
  -- (e.g. an API key fingerprint, an OIDC subject). Used to resolve a
  -- presented credential to the same persisted user (AUTH-AC-01).
  external_id   TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  email         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Organizations (AUTH-002). Top of the ownership hierarchy (architecture §7).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Roles. A small, system-defined set (owner / admin / member). Roles are
-- referenced by name from memberships and project_access rows; the canonical
-- set is seeded below so permission resolution is explicit, not inferred.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_roles (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

INSERT INTO wfos_roles (id, name) VALUES
  ('owner', 'Owner'),
  ('admin', 'Administrator'),
  ('member', 'Member')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Permissions (AUTH2-AC-02). Explicit, system-defined capabilities. A role
-- resolves to a set of permissions via wfos_role_permissions; the
-- AuthorizationService consults that mapping rather than hard-coding checks.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_permissions (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

INSERT INTO wfos_permissions (id, name) VALUES
  ('project.read',   'Read project'),
  ('project.write',  'Write project'),
  ('project.admin',  'Administer project'),
  ('org.admin',      'Administer organization'),
  ('org.members',    'Manage organization membership')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Role → Permission mapping (AUTH2-AC-02). Explicit; the source of truth for
-- "what can a role do".
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_role_permissions (
  role_id       TEXT NOT NULL REFERENCES wfos_roles(id),
  permission_id TEXT NOT NULL REFERENCES wfos_permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

INSERT INTO wfos_role_permissions (role_id, permission_id) VALUES
  ('owner', 'project.read'),
  ('owner', 'project.write'),
  ('owner', 'project.admin'),
  ('owner', 'org.admin'),
  ('owner', 'org.members'),
  ('admin', 'project.read'),
  ('admin', 'project.write'),
  ('admin', 'project.admin'),
  ('admin', 'org.members'),
  ('member', 'project.read'),
  ('member', 'project.write')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Organization membership (AUTH-002). Associates a user with an organization
-- under a role. FK constraints enforce that the user, organization, and role
-- all exist (DATA-AC-02).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_organization_memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES wfos_users(id),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  role_id         TEXT NOT NULL REFERENCES wfos_roles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, organization_id)
);

CREATE INDEX wfos_org_memberships_user_idx
  ON wfos_organization_memberships (user_id);
CREATE INDEX wfos_org_memberships_org_idx
  ON wfos_organization_memberships (organization_id);

-- ---------------------------------------------------------------------------
-- Minimal project representation (AUTHZ-AC-01..03).
--
-- The backlog lists PROJ-001 as a dependency, but WORK-002 is NOT a
-- project-domain implementation task. Only the minimal project ownership/
-- access relationship required to establish the authorization contract is
-- introduced here. Full project configuration, repository associations, and
-- lifecycle belong to WORK-004.
--
-- A project belongs to exactly one organization (architecture §7, §8).
-- Tenant isolation is enforced through this ownership: a user in Org A has
-- no access to a project owned by Org B unless an explicit project_access
-- row grants it (and even then only through the user's own org membership —
-- cross-tenant project_access is rejected by the AuthorizationService).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wfos_projects_org_idx ON wfos_projects (organization_id);

-- ---------------------------------------------------------------------------
-- Project access (AUTHZ-AC-01..03). Grants a user a role on a specific
-- project. The AuthorizationService resolves permissions through:
--   user → membership(role) → role_permissions → permission
-- AND requires the project's organization to match a membership the user
-- holds, so a cross-tenant project_access row alone does NOT grant access
-- (AUTHZ-AC-02).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_project_access (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES wfos_users(id),
  project_id  UUID NOT NULL REFERENCES wfos_projects(id),
  role_id     TEXT NOT NULL REFERENCES wfos_roles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, project_id)
);

CREATE INDEX wfos_project_access_user_idx ON wfos_project_access (user_id);
CREATE INDEX wfos_project_access_project_idx ON wfos_project_access (project_id);
