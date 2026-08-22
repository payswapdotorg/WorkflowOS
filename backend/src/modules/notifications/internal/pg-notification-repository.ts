import type { DatabaseClient } from '@platform/index.js';
import type {
  NotificationRequest,
  NotificationRepository,
  CreateNotificationInput,
  NotificationStatus,
} from './notification.types.js';

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateNotificationInput): Promise<NotificationRequest> {
    const result = await this.db.query<NotificationRow>(
      `INSERT INTO wfos_notification_requests
         (organization_id, project_id, notification_type, event_type,
          recipient, recipient_type, subject, body, metadata,
          source_type, source_id, work_item_id, review_id,
          verification_run_id, audit_event_id, execution_id, correlation_id,
          idempotency_key, status, max_retries)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'pending', 3)
       RETURNING *`,
      [
        input.organizationId ?? null,
        input.projectId ?? null,
        input.notificationType,
        input.eventType,
        input.recipient,
        input.recipientType ?? 'user',
        input.subject ?? null,
        input.body ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.sourceType,
        input.sourceId,
        input.workItemId ?? null,
        input.reviewId ?? null,
        input.verificationRunId ?? null,
        input.auditEventId ?? null,
        input.executionId ?? null,
        input.correlationId ?? null,
        input.idempotencyKey ?? null,
      ],
    );
    return mapNotification(result.rows[0]!);
  }

  async findById(id: string): Promise<NotificationRequest | null> {
    const result = await this.db.query<NotificationRow>(
      `SELECT * FROM wfos_notification_requests WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapNotification(result.rows[0]!);
  }

  async findByIdempotencyKey(key: string): Promise<NotificationRequest | null> {
    const result = await this.db.query<NotificationRow>(
      `SELECT * FROM wfos_notification_requests WHERE idempotency_key = $1`,
      [key],
    );
    if (result.rows.length === 0) return null;
    return mapNotification(result.rows[0]!);
  }

  async listForProject(projectId: string, opts?: { limit?: number }): Promise<NotificationRequest[]> {
    const limit = opts?.limit ?? 100;
    const result = await this.db.query<NotificationRow>(
      `SELECT * FROM wfos_notification_requests WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(mapNotification);
  }

  async listForWorkItem(workItemId: string, opts?: { limit?: number }): Promise<NotificationRequest[]> {
    const limit = opts?.limit ?? 100;
    const result = await this.db.query<NotificationRow>(
      `SELECT * FROM wfos_notification_requests WHERE work_item_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [workItemId, limit],
    );
    return result.rows.map(mapNotification);
  }

  async updateStatus(
    id: string,
    status: NotificationStatus,
    provider?: string | null,
    deliveryMetadata?: Record<string, unknown> | null,
    errorMessage?: string | null,
  ): Promise<NotificationRequest | null> {
    const result = await this.db.query<NotificationRow>(
      `UPDATE wfos_notification_requests
       SET status = $2, provider = COALESCE($3, provider),
           delivery_metadata = COALESCE($4, delivery_metadata),
           error_message = COALESCE($5, error_message),
           retry_count = CASE WHEN $2 = 'failed' THEN retry_count + 1 ELSE retry_count END
       WHERE id = $1
       RETURNING *`,
      [id, status, provider ?? null, deliveryMetadata ? JSON.stringify(deliveryMetadata) : null, errorMessage ?? null],
    );
    if (result.rows.length === 0) return null;
    return mapNotification(result.rows[0]!);
  }

  async findPending(opts?: { limit?: number }): Promise<NotificationRequest[]> {
    const limit = opts?.limit ?? 100;
    const result = await this.db.query<NotificationRow>(
      `SELECT * FROM wfos_notification_requests WHERE status IN ('pending', 'queued') ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapNotification);
  }
}

interface NotificationRow {
  id: string;
  organization_id: string | null;
  project_id: string | null;
  notification_type: string;
  event_type: string;
  recipient: string;
  recipient_type: string;
  subject: string | null;
  body: string | null;
  metadata: unknown;
  source_type: string;
  source_id: string;
  work_item_id: string | null;
  review_id: string | null;
  verification_run_id: string | null;
  audit_event_id: string | null;
  execution_id: string | null;
  correlation_id: string | null;
  status: string;
  idempotency_key: string | null;
  provider: string | null;
  delivery_metadata: unknown;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  created_at: Date;
  updated_at: Date;
}

function mapNotification(row: NotificationRow): NotificationRequest {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    notificationType: row.notification_type,
    eventType: row.event_type,
    recipient: row.recipient,
    recipientType: row.recipient_type,
    subject: row.subject,
    body: row.body,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    sourceType: row.source_type,
    sourceId: row.source_id,
    workItemId: row.work_item_id,
    reviewId: row.review_id,
    verificationRunId: row.verification_run_id,
    auditEventId: row.audit_event_id,
    executionId: row.execution_id,
    correlationId: row.correlation_id,
    status: row.status as NotificationStatus,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    deliveryMetadata: (row.delivery_metadata as Record<string, unknown> | null) ?? null,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
