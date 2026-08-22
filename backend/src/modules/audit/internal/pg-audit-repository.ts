import type { DatabaseClient } from '@platform/index.js';
import type {
  AuditEvent,
  AuditEventRepository,
  WriteAuditEventInput,
} from './audit.types.js';

// ===========================================================================
// Audit event repository (AUDIT-001).
//
// The wfos_audit_events table is append-only: BEFORE UPDATE OR DELETE
// triggers reject normal application mutations (AUDIT-AC-02). Only INSERT
// is allowed.
// ===========================================================================

export class PgAuditEventRepository implements AuditEventRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: WriteAuditEventInput): Promise<AuditEvent> {
    const result = await this.db.query<AuditEventRow>(
      `INSERT INTO wfos_audit_events
         (organization_id, project_id, event_type, actor, source,
          resource_type, resource_id, execution_id, correlation_id,
          before_state, after_state, metadata,
          work_item_id, work_order_id, architecture_version_id,
          review_id, verification_run_id, agent_run_id,
          pull_request_association_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id, organization_id, project_id, event_type, actor, source,
                 resource_type, resource_id, execution_id, correlation_id,
                 before_state, after_state, metadata,
                 work_item_id, work_order_id, architecture_version_id,
                 review_id, verification_run_id, agent_run_id,
                 pull_request_association_id, created_at`,
      [
        input.organizationId ?? null,
        input.projectId ?? null,
        input.eventType,
        input.actor,
        input.source ?? 'system',
        input.resourceType,
        input.resourceId,
        input.executionId ?? null,
        input.correlationId ?? null,
        input.beforeState ? JSON.stringify(input.beforeState) : null,
        input.afterState ? JSON.stringify(input.afterState) : null,
        JSON.stringify(input.metadata ?? {}),
        input.workItemId ?? null,
        input.workOrderId ?? null,
        input.architectureVersionId ?? null,
        input.reviewId ?? null,
        input.verificationRunId ?? null,
        input.agentRunId ?? null,
        input.pullRequestAssociationId ?? null,
      ],
    );
    return mapAuditEvent(result.rows[0]!);
  }

  async findById(id: string): Promise<AuditEvent | null> {
    const result = await this.db.query<AuditEventRow>(
      `SELECT id, organization_id, project_id, event_type, actor, source,
              resource_type, resource_id, execution_id, correlation_id,
              before_state, after_state, metadata,
              work_item_id, work_order_id, architecture_version_id,
              review_id, verification_run_id, agent_run_id,
              pull_request_association_id, created_at
       FROM wfos_audit_events WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapAuditEvent(result.rows[0]!);
  }

  async listForProject(projectId: string, opts?: { eventTypes?: string[]; limit?: number }): Promise<AuditEvent[]> {
    const limit = opts?.limit ?? 100;
    if (opts?.eventTypes && opts.eventTypes.length > 0) {
      const result = await this.db.query<AuditEventRow>(
        `SELECT id, organization_id, project_id, event_type, actor, source,
                resource_type, resource_id, execution_id, correlation_id,
                before_state, after_state, metadata,
                work_item_id, work_order_id, architecture_version_id,
                review_id, verification_run_id, agent_run_id,
                pull_request_association_id, created_at
         FROM wfos_audit_events WHERE project_id = $1 AND event_type = ANY($2::text[])
         ORDER BY created_at DESC LIMIT $3`,
        [projectId, opts.eventTypes, limit],
      );
      return result.rows.map(mapAuditEvent);
    }
    const result = await this.db.query<AuditEventRow>(
      `SELECT id, organization_id, project_id, event_type, actor, source,
              resource_type, resource_id, execution_id, correlation_id,
              before_state, after_state, metadata,
              work_item_id, work_order_id, architecture_version_id,
              review_id, verification_run_id, agent_run_id,
              pull_request_association_id, created_at
       FROM wfos_audit_events WHERE project_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(mapAuditEvent);
  }

  async listForResource(resourceType: string, resourceId: string, opts?: { limit?: number }): Promise<AuditEvent[]> {
    const limit = opts?.limit ?? 100;
    const result = await this.db.query<AuditEventRow>(
      `SELECT id, organization_id, project_id, event_type, actor, source,
              resource_type, resource_id, execution_id, correlation_id,
              before_state, after_state, metadata,
              work_item_id, work_order_id, architecture_version_id,
              review_id, verification_run_id, agent_run_id,
              pull_request_association_id, created_at
       FROM wfos_audit_events WHERE resource_type = $1 AND resource_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [resourceType, resourceId, limit],
    );
    return result.rows.map(mapAuditEvent);
  }

  async listForWorkItem(workItemId: string, opts?: { limit?: number }): Promise<AuditEvent[]> {
    const limit = opts?.limit ?? 100;
    const result = await this.db.query<AuditEventRow>(
      `SELECT id, organization_id, project_id, event_type, actor, source,
              resource_type, resource_id, execution_id, correlation_id,
              before_state, after_state, metadata,
              work_item_id, work_order_id, architecture_version_id,
              review_id, verification_run_id, agent_run_id,
              pull_request_association_id, created_at
       FROM wfos_audit_events WHERE work_item_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [workItemId, limit],
    );
    return result.rows.map(mapAuditEvent);
  }
}

// ===========================================================================
// Row mapper
// ===========================================================================

interface AuditEventRow {
  id: string;
  organization_id: string | null;
  project_id: string | null;
  event_type: string;
  actor: string;
  source: string;
  resource_type: string;
  resource_id: string;
  execution_id: string | null;
  correlation_id: string | null;
  before_state: unknown;
  after_state: unknown;
  metadata: unknown;
  work_item_id: string | null;
  work_order_id: string | null;
  architecture_version_id: string | null;
  review_id: string | null;
  verification_run_id: string | null;
  agent_run_id: string | null;
  pull_request_association_id: string | null;
  created_at: Date;
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    eventType: row.event_type,
    actor: row.actor,
    source: row.source,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    executionId: row.execution_id,
    correlationId: row.correlation_id,
    beforeState: (row.before_state as Record<string, unknown> | null) ?? null,
    afterState: (row.after_state as Record<string, unknown> | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    workItemId: row.work_item_id,
    workOrderId: row.work_order_id,
    architectureVersionId: row.architecture_version_id,
    reviewId: row.review_id,
    verificationRunId: row.verification_run_id,
    agentRunId: row.agent_run_id,
    pullRequestAssociationId: row.pull_request_association_id,
    createdAt: row.created_at,
  };
}
