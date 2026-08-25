-- WORK-037 — Agent Policy and Permissions
--
-- The durable execution-policy authority the WORK-036 ToolPolicyGate seam
-- deferred. This is AGENT-CAPABILITY policy (what agents may do inside an
-- execution): allow | deny | ask | constrained across the four control
-- domains (tools, network, secrets, deployment). It is DISTINCT from
-- WORK-002 project authorization (which users may act) — the engine never
-- imports the authorization service; only the route layer calls
-- requireProjectAuthorization to gate WHO may resolve approvals / mutate
-- policy documents. The dependency direction is strictly one-way:
--
--   Auth / Project Authorization → Execution Policy → Tool Runtime → Sandbox
--
-- No reverse dependency (enforced by static-architecture checks).
--
-- Decisions themselves are durable evidence in the EXISTING ExecutionSession
-- observation records (policy:{decision,reason}) — NO parallel tool-decision
-- store is introduced. These two tables persist (a) the versioned policy
-- DOCUMENTS (org + project scoped) and (b) the durable ASK approvals.
--
-- No secrets. The document is policy configuration (rule selectors + effects
-- + reasons); approvals carry only subject identifiers + resolution identity.
-- Both are tenant-scoped (organization_id + project_id).

-- ============================================================================
-- wfos_agent_policies — versioned policy documents (org default OR project override)
-- ============================================================================
CREATE TABLE IF NOT EXISTS wfos_agent_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  -- NULL = the organization-level default document (scope = 'organization').
  -- NOT NULL = a project-scoped override (scope = 'project').
  project_id UUID REFERENCES wfos_projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('organization', 'project')),
  -- The policy document: { description?, rules[], defaultEffect }.
  -- rules: ordered; FIRST match decides (the policy author owns precedence).
  -- defaultEffect ∈ {'allow','deny','ask'} — applied when no rule matches.
  document JSONB NOT NULL,
  -- Monotonically increasing per (organization_id, scope, project_id); bumped
  -- on every mutation (mirrors the WORK-033 execution-policy version pattern).
  policy_version INTEGER NOT NULL DEFAULT 1,
  -- The user who created/last-mutated this version (audit; never client-trusted
  -- — derived server-side from requireProjectAuthorization at the route).
  created_by UUID REFERENCES wfos_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exactly ONE organization-scope default per organization, and exactly ONE
-- project-scope override per project (partial unique indexes — NULL
-- project_id rows are treated as distinct by plain UNIQUE, so we partition
-- by scope).
CREATE UNIQUE INDEX IF NOT EXISTS wfos_agent_policies_org_unique
  ON wfos_agent_policies(organization_id)
  WHERE scope = 'organization';
CREATE UNIQUE INDEX IF NOT EXISTS wfos_agent_policies_project_unique
  ON wfos_agent_policies(organization_id, project_id)
  WHERE scope = 'project';
CREATE INDEX IF NOT EXISTS wfos_agent_policies_scope_idx
  ON wfos_agent_policies(organization_id, scope, project_id);

-- Bump policy_version on every UPDATE of the document (one CTE: the new row
-- carries prior_version + 1). The repository issues UPDATE ... SET
-- policy_version = policy_version + 1, document = $1, updated_at = NOW(),
-- created_by = $2 RETURNING policy_version — this trigger is a defensive
-- guarantee the version NEVER stays stale even under a direct SQL edit.
CREATE OR REPLACE FUNCTION wfos_agent_policies_bump_version()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.document IS DISTINCT FROM OLD.document THEN
    NEW.policy_version := OLD.policy_version + 1;
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wfos_agent_policies_bump_version ON wfos_agent_policies;
CREATE TRIGGER wfos_agent_policies_bump_version
  BEFORE UPDATE ON wfos_agent_policies
  FOR EACH ROW
  EXECUTE FUNCTION wfos_agent_policies_bump_version();

-- ============================================================================
-- wfos_agent_policy_approvals — the durable ASK interaction
-- ============================================================================
-- When the gate returns 'ask', a pending approval is created (idempotent on
-- (execution_id, subject_key) WHERE status='pending'). A human resolves it
-- (approve/deny) through the route layer (requireProjectAuthorization
-- 'project.admin'). Resolution is immutable: a resolved approval is terminal
-- evidence; a NEW ask for the same subject creates a new pending row only
-- after the prior row is no longer 'pending' (the partial unique index
-- permits this). An APPROVED (unexpired) row makes subsequent invocations
-- of the same subject 'allow' (with the approval reference in the reason);
-- a DENIED row makes them 'deny' (a human denial is durable for that
-- execution+subject).
CREATE TABLE IF NOT EXISTS wfos_agent_policy_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  -- The logical execution identity (TEXT — matches wfos_executions.execution_id).
  execution_id TEXT NOT NULL,
  -- The policy subject this approval blesses (durable + replay-stable):
  --   '<domain>:<family|"" >:<operation|"" >:<host|"" >'
  -- e.g. 'tool:terminal:terminal.exec:', 'network:http:http.POST:api.github.com',
  --      'secrets:::', 'deployment:git:git.push:', 'external:::'.
  -- Lookups are by (execution_id, subject_key) ordered by requested_at DESC.
  subject_domain TEXT NOT NULL CHECK (subject_domain IN (
    'tool', 'network', 'secrets', 'deployment', 'external')),
  subject_family TEXT,
  subject_operation TEXT,
  subject_host TEXT,
  subject_key TEXT NOT NULL,
  -- The rule id + policy version that produced the 'ask' (audit provenance).
  rule_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'denied', 'expired')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_reason TEXT,
  resolved_by UUID REFERENCES wfos_users(id),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  -- NULL = no expiry; an expiry bounds how long an approval authorizes the
  -- subject (a re-invocation past expires_at treats the approval as absent
  -- and the row is lazily flipped to 'expired').
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exactly ONE pending approval per (execution_id, subject_key) — the
-- idempotent no-duplicate-pending-request contract under concurrent asks.
CREATE UNIQUE INDEX IF NOT EXISTS wfos_agent_policy_approvals_pending_unique
  ON wfos_agent_policy_approvals(execution_id, subject_key)
  WHERE status = 'pending';
-- The lookup path: latest approval for an (execution, subject) — any status
-- (approved/denied are terminal evidence; pending is the active ask).
CREATE INDEX IF NOT EXISTS wfos_agent_policy_approvals_subject_idx
  ON wfos_agent_policy_approvals(execution_id, subject_key, requested_at DESC);
CREATE INDEX IF NOT EXISTS wfos_agent_policy_approvals_project_status_idx
  ON wfos_agent_policy_approvals(project_id, status, requested_at DESC);
