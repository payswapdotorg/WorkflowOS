/**
 * WORK-037: PgAgentPolicyRepository — the durable agent-policy persistence.
 *
 * Internal/ — persistence only. Mirrors the WORK-035 repository pattern:
 *   * scope resolution is read-only (execution → project → organization);
 *   * the effective document is project-override → org-default → null (the
 *     engine falls to the platform default when the repository returns null);
 *   * document upserts bump policy_version (migration 0037's trigger is the
 *     defensive backstop; the repository issues RETURNING policy_version so
 *     the caller never reads a stale version);
 *   * the pending-approval creation is idempotent under the partial unique
 *     index on (execution_id, subject_key) WHERE status='pending'
 *     (INSERT ... ON CONFLICT DO NOTHING RETURNING; on 0 rows, the SELECT
 *     returns the concurrent winner — exactly one pending row per subject);
 *     ensurePendingApproval also returns whether THIS call created the row
 *     so the engine can emit exactly ONE approval-requested audit event
 *     per pending DB row (architect's PR-#41 review: no duplicate audit
 *     evidence under concurrent asks);
 *   * supersedePendingApproval CAS-flips a stale pending to 'expired' so a
 *     new (policyVersion, ruleId) pending can be created for the same
 *     subject (architect's PR-#41 review: approvals are BOUND to the
 *     (policyVersion, ruleId) that produced them — a material policy
 *     change supersedes the prior pending; approved/denied stale rows
 *     stay as terminal evidence, untouched);
 *   * approval resolution is a CAS (status='pending' predicate; a resolved
 *     approval is terminal — the partial unique index permits a NEW pending
 *     row only after the prior row leaves 'pending');
 *   * no workflow/verification/review/github state is touched (enforced by
 *     the static-architecture SQL-level checks). No credentials.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  AgentPolicyApproval,
  AgentPolicyApprovalStatus,
  AgentPolicyDocument,
  AgentPolicyDomain,
  AgentPolicyRepository,
  AgentPolicyResolution,
  AgentPolicyRule,
  AgentPolicyScope,
} from './agent-policy.types.js';
import { AgentPolicyError } from './agent-policy.types.js';

interface PolicyRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  scope: 'organization' | 'project';
  document: unknown;
  policy_version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  organization_id: string;
  project_id: string;
  execution_id: string;
  subject_domain: AgentPolicyDomain;
  subject_family: string | null;
  subject_operation: string | null;
  subject_host: string | null;
  subject_key: string;
  rule_id: string;
  policy_version: number;
  status: AgentPolicyApprovalStatus;
  requested_at: string;
  requested_reason: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  expires_at: string | null;
}

const POLICY_COLUMNS =
  'id, organization_id, project_id, scope, document, policy_version, created_by, created_at, updated_at';
const APPROVAL_COLUMNS =
  'id, organization_id, project_id, execution_id, subject_domain, subject_family, subject_operation, subject_host, subject_key, rule_id, policy_version, status, requested_at, requested_reason, resolved_by, resolved_at, resolution_note, expires_at';

export interface PgAgentPolicyRepositoryDeps {
  readonly db: DatabaseClient;
}

export class PgAgentPolicyRepository implements AgentPolicyRepository {
  constructor(private readonly deps: PgAgentPolicyRepositoryDeps) {}

  async resolveScope(executionId: string): Promise<AgentPolicyScope | null> {
    const res = await this.deps.db.query(
      `SELECT e.project_id::text AS project_id, p.organization_id::text AS organization_id
         FROM wfos_executions e
         JOIN wfos_projects p ON p.id = e.project_id
        WHERE e.execution_id = $1`,
      [executionId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;
    return { organizationId: row.organization_id as string, projectId: row.project_id as string };
  }

  async getEffectivePolicy(organizationId: string, projectId: string): Promise<AgentPolicyResolution | null> {
    const project = await this.getProjectPolicy(organizationId, projectId);
    if (project) return project;
    return this.getOrganizationPolicy(organizationId);
  }

  async getProjectPolicy(organizationId: string, projectId: string): Promise<AgentPolicyResolution | null> {
    const res = await this.deps.db.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM wfos_agent_policies
        WHERE scope = 'project' AND organization_id = $1 AND project_id = $2`,
      [organizationId, projectId],
    );
    return res.rows[0] ? mapPolicy(res.rows[0]) : null;
  }

  async getOrganizationPolicy(organizationId: string): Promise<AgentPolicyResolution | null> {
    const res = await this.deps.db.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM wfos_agent_policies
        WHERE scope = 'organization' AND organization_id = $1`,
      [organizationId],
    );
    return res.rows[0] ? mapPolicy(res.rows[0]) : null;
  }

  // =========================================================================
  // PR #42 round-7 (the scope-resolution fence): every mutation that can
  // change the EFFECTIVE policy resolution for a project scope must acquire
  // the SAME anchor row lock the persistence fence holds. The anchor is the
  // `wfos_projects` (or `wfos_organizations`) row itself — the authoritative
  // scope boundary that EXISTS for every valid scope and that every policy
  // row references via FK. The fence holds `SELECT ... FOR UPDATE` on the
  // project + org anchor rows for the WHOLE persistence transaction; the
  // mutation paths below acquire the SAME `FOR UPDATE` lock BEFORE the
  // INSERT/UPDATE/DELETE so the two transactions SERIALIZE against each other
  // even when the EFFECTIVE policy changes because a policy row is CREATED
  // (setProjectPolicy when no row existed) or DELETED (clearProjectPolicy
  // when the row falls back to organization). The FK-induced `FOR KEY SHARE`
  // on the parent row, taken automatically by an INSERT, also conflicts
  // with the fence's `FOR UPDATE` (so the INSERT alone would block) — but
  // the explicit `FOR UPDATE` here (a) documents the invariant, (b) covers
  // the DELETE path (which PostgreSQL does NOT auto-lock the parent for),
  // and (c) survives a future schema change that drops or weakens the FK.
  // =========================================================================

  async setProjectPolicy(input: {
    organizationId: string;
    projectId: string;
    document: AgentPolicyDocument;
    userId: string;
  }): Promise<AgentPolicyResolution> {
    // PR #42 round-7: acquire the project-scope anchor lock (FOR UPDATE on
    // the wfos_projects row). The persistence fence holds this SAME lock
    // through its whole transaction; a concurrent baseline persistence run
    // BLOCKS this mutation until the fence commits (or this mutation
    // BLOCKS the fence — they serialize). This makes "create a NEW project
    // policy row" (the architect's missing-row case 1) a serialization
    // point, NOT a TOCTOU hole.
    await this.deps.db.query(
      `SELECT id FROM wfos_projects WHERE id = $1 FOR UPDATE`,
      [input.projectId],
    );
    const json = JSON.stringify(input.document);
    // ON CONFLICT on the partial unique index
    // (organization_id, project_id) WHERE scope='project'. The trigger
    // bumps policy_version on the UPDATE branch; INSERT sets it to 1.
    const res = await this.deps.db.query<PolicyRow>(
      `INSERT INTO wfos_agent_policies
         (organization_id, project_id, scope, document, created_by)
       VALUES ($1, $2, 'project', $3::jsonb, $4)
       ON CONFLICT (organization_id, project_id) WHERE scope = 'project'
       DO UPDATE SET document = EXCLUDED.document, created_by = EXCLUDED.created_by, updated_at = NOW()
       RETURNING ${POLICY_COLUMNS}`,
      [input.organizationId, input.projectId, json, input.userId],
    );
    return mapPolicy(res.rows[0]!);
  }

  async clearProjectPolicy(organizationId: string, projectId: string): Promise<boolean> {
    // PR #42 round-7: acquire the project-scope anchor lock (FOR UPDATE on
    // the wfos_projects row). The DELETE itself does NOT auto-lock the
    // parent (PostgreSQL's FK machinery locks the parent only on
    // INSERT/UPDATE of the FK column). The explicit lock makes
    // "clearProjectPolicy" (the architect's missing-row case 2 — the
    // project policy is deleted and resolution falls back to organization)
    // serialize against the persistence fence: the fence either sees the
    // project policy still present (commits under it) OR sees it gone (the
    // re-resolution sees the org fallback → source differs from the
    // snapshot's 'project' source → ROLLBACK → zero stale evidence).
    await this.deps.db.query(
      `SELECT id FROM wfos_projects WHERE id = $1 FOR UPDATE`,
      [projectId],
    );
    const res = await this.deps.db.query(
      `DELETE FROM wfos_agent_policies
        WHERE scope = 'project' AND organization_id = $1 AND project_id = $2`,
      [organizationId, projectId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setOrganizationPolicy(input: {
    organizationId: string;
    document: AgentPolicyDocument;
    userId: string;
  }): Promise<AgentPolicyResolution> {
    // PR #42 round-7: acquire the organization-scope anchor lock (FOR
    // UPDATE on the wfos_organizations row). The persistence fence holds
    // this SAME lock; creating or replacing the org default policy (which
    // can change the effective resolution for EVERY project in the org
    // that lacks a project override) serializes against any concurrent
    // baseline persistence in the org.
    await this.deps.db.query(
      `SELECT id FROM wfos_organizations WHERE id = $1 FOR UPDATE`,
      [input.organizationId],
    );
    const json = JSON.stringify(input.document);
    const res = await this.deps.db.query<PolicyRow>(
      `INSERT INTO wfos_agent_policies
         (organization_id, project_id, scope, document, created_by)
       VALUES ($1, NULL, 'organization', $2::jsonb, $3)
       ON CONFLICT (organization_id) WHERE scope = 'organization'
       DO UPDATE SET document = EXCLUDED.document, created_by = EXCLUDED.created_by, updated_at = NOW()
       RETURNING ${POLICY_COLUMNS}`,
      [input.organizationId, json, input.userId],
    );
    return mapPolicy(res.rows[0]!);
  }

  async clearOrganizationPolicy(organizationId: string): Promise<boolean> {
    // PR #42 round-7: acquire the organization-scope anchor lock (FOR
    // UPDATE on the wfos_organizations row). Clearing the org default
    // changes the effective resolution for every project in the org that
    // lacks a project override (falls back to platform-default). The
    // explicit lock serializes this against the persistence fence.
    await this.deps.db.query(
      `SELECT id FROM wfos_organizations WHERE id = $1 FOR UPDATE`,
      [organizationId],
    );
    const res = await this.deps.db.query(
      `DELETE FROM wfos_agent_policies WHERE scope = 'organization' AND organization_id = $1`,
      [organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getLatestApproval(executionId: string, subjectKey: string): Promise<AgentPolicyApproval | null> {
    const res = await this.deps.db.query<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM wfos_agent_policy_approvals
        WHERE execution_id = $1 AND subject_key = $2
        ORDER BY requested_at DESC
        LIMIT 1`,
      [executionId, subjectKey],
    );
    return res.rows[0] ? mapApproval(res.rows[0]) : null;
  }

  async getApproval(approvalId: string): Promise<AgentPolicyApproval | null> {
    const res = await this.deps.db.query<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM wfos_agent_policy_approvals WHERE id = $1`,
      [approvalId],
    );
    return res.rows[0] ? mapApproval(res.rows[0]) : null;
  }

  async ensurePendingApproval(input: {
    organizationId: string;
    projectId: string;
    executionId: string;
    subjectDomain: AgentPolicyDomain;
    subjectFamily: string | null;
    subjectOperation: string | null;
    subjectHost: string | null;
    subjectKey: string;
    ruleId: string;
    policyVersion: number;
    requestedReason: string | null;
    expiresAt: string | null;
  }): Promise<{ approval: AgentPolicyApproval; created: boolean }> {
    // Idempotent: ON CONFLICT DO NOTHING under the partial unique index on
    // (execution_id, subject_key) WHERE status='pending'. A concurrent ask
    // produces exactly one pending row.
    const res = await this.deps.db.query<ApprovalRow>(
      `INSERT INTO wfos_agent_policy_approvals
         (organization_id, project_id, execution_id,
          subject_domain, subject_family, subject_operation, subject_host, subject_key,
          rule_id, policy_version, status, requested_reason, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)
       ON CONFLICT (execution_id, subject_key) WHERE status = 'pending'
       DO NOTHING
       RETURNING ${APPROVAL_COLUMNS}`,
      [
        input.organizationId,
        input.projectId,
        input.executionId,
        input.subjectDomain,
        input.subjectFamily,
        input.subjectOperation,
        input.subjectHost,
        input.subjectKey,
        input.ruleId,
        input.policyVersion,
        input.requestedReason,
        input.expiresAt,
      ],
    );
    if (res.rows[0]) return { approval: mapApproval(res.rows[0]), created: true };
    // A concurrent ask won the race — return the existing pending row.
    // created=false so the engine does NOT emit a duplicate
    // 'agent-policy.approval-requested' audit event (exactly ONE audit
    // row per pending DB row, even under concurrent asks).
    const existing = await this.getLatestApproval(input.executionId, input.subjectKey);
    if (existing && existing.status === 'pending') return { approval: existing, created: false };
    // Extremely unlikely: the pending row resolved between the INSERT and the
    // SELECT. Re-read returns the latest (resolved) — the engine treats a
    // non-pending latest as terminal evidence. Return it; the engine decides.
    if (existing) return { approval: existing, created: false };
    throw new AgentPolicyError(
      'agent-policy-approval-not-found',
      'ensurePendingApproval: the pending approval could not be read after a no-op insert (subject state is inconsistent)',
      { executionId: input.executionId, subjectKey: input.subjectKey },
    );
  }

  async supersedePendingApproval(approvalId: string): Promise<void> {
    // CAS UPDATE: only flips a 'pending' row to 'expired'. Concurrent
    // supersedes are idempotent (the second UPDATE matches 0 rows). Does
    // NOT touch approved/denied rows (terminal evidence stays intact).
    // Does NOT require expires_at < NOW() (this is a policy-version
    // supersession, not a TTL expiry — see markExpired for the TTL path).
    await this.deps.db.query(
      `UPDATE wfos_agent_policy_approvals
          SET status = 'expired',
              resolution_note = 'superseded by policy-version change',
              resolved_at = NOW()
        WHERE id = $1
          AND status = 'pending'`,
      [approvalId],
    );
  }

  async listApprovals(
    projectId: string,
    status?: AgentPolicyApprovalStatus,
  ): Promise<readonly AgentPolicyApproval[]> {
    const res = status
      ? await this.deps.db.query<ApprovalRow>(
          `SELECT ${APPROVAL_COLUMNS} FROM wfos_agent_policy_approvals
            WHERE project_id = $1 AND status = $2
            ORDER BY requested_at DESC`,
          [projectId, status],
        )
      : await this.deps.db.query<ApprovalRow>(
          `SELECT ${APPROVAL_COLUMNS} FROM wfos_agent_policy_approvals
            WHERE project_id = $1
            ORDER BY requested_at DESC`,
          [projectId],
        );
    return res.rows.map(mapApproval);
  }

  async resolve(input: {
    approvalId: string;
    action: 'approve' | 'deny';
    userId: string;
    note?: string;
  }): Promise<AgentPolicyApproval> {
    // CAS resolution: a single UPDATE with a status='pending' predicate.
    // rowCount 0 → the approval is missing OR already resolved (terminal).
    const newStatus = input.action === 'approve' ? 'approved' : 'denied';
    const res = await this.deps.db.query<ApprovalRow>(
      `UPDATE wfos_agent_policy_approvals
          SET status = $2, resolved_by = $3, resolved_at = NOW(), resolution_note = $4
        WHERE id = $1 AND status = 'pending'
        RETURNING ${APPROVAL_COLUMNS}`,
      [input.approvalId, newStatus, input.userId, input.note ?? null],
    );
    if (res.rows[0]) return mapApproval(res.rows[0]);
    // No row updated — diagnose: not-found vs already-resolved.
    const existing = await this.deps.db.query<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM wfos_agent_policy_approvals WHERE id = $1`,
      [input.approvalId],
    );
    if (existing.rows.length === 0) {
      throw new AgentPolicyError(
        'agent-policy-approval-not-found',
        `agent-policy-approval-not-found: approval ${input.approvalId} does not exist`,
        { approvalId: input.approvalId },
      );
    }
    throw new AgentPolicyError(
      'agent-policy-approval-already-resolved',
      `agent-policy-approval-already-resolved: approval ${input.approvalId} is terminal (status '${existing.rows[0]!.status}') — resolutions are immutable`,
      { approvalId: input.approvalId, status: existing.rows[0]!.status },
    );
  }

  async markExpired(approvalId: string): Promise<void> {
    await this.deps.db.query(
      `UPDATE wfos_agent_policy_approvals
          SET status = 'expired'
        WHERE id = $1
          AND status IN ('pending', 'approved')
          AND expires_at IS NOT NULL
          AND expires_at < NOW()`,
      [approvalId],
    );
  }
}

// ---------------------------------------------------------------------------
// row → domain mapping
// ---------------------------------------------------------------------------

function mapPolicy(row: PolicyRow): AgentPolicyResolution {
  const doc = row.document as AgentPolicyDocument;
  return {
    source: row.scope === 'project' ? 'project' : 'organization',
    document: normalizeDocument(doc),
    policyVersion: row.policy_version,
    organizationId: row.organization_id,
    projectId: row.project_id,
  };
}

function mapApproval(row: ApprovalRow): AgentPolicyApproval {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    executionId: row.execution_id,
    subjectDomain: row.subject_domain,
    subjectFamily: row.subject_family,
    subjectOperation: row.subject_operation,
    subjectHost: row.subject_host,
    subjectKey: row.subject_key,
    ruleId: row.rule_id,
    policyVersion: row.policy_version,
    status: row.status,
    requestedAt: row.requested_at,
    requestedReason: row.requested_reason,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
    expiresAt: row.expires_at,
  };
}

/** Normalize a document read from JSONB (ensure rule arrays are not shared). */
function normalizeDocument(doc: AgentPolicyDocument): AgentPolicyDocument {
  const rules: readonly AgentPolicyRule[] =
    Array.isArray(doc?.rules) ? doc.rules.map((r) => ({ ...r })) : [];
  return {
    description: doc?.description,
    rules,
    defaultEffect: doc?.defaultEffect ?? 'allow',
  };
}
