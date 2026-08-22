/**
 * Notification domain types (NOTIFY-001, NOTIFY-AC-01..02).
 *
 * /notifications owns the provider-independent notification boundary.
 * Notifications are a side effect -- they are NOT authoritative for workflow
 * or domain state (frozen architecture: "Notifications are a side effect").
 */

// --- Notification request ---

export interface NotificationRequest {
  readonly id: string;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly notificationType: string;
  readonly eventType: string;
  readonly recipient: string;
  readonly recipientType: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly metadata: Record<string, unknown>;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly workItemId: string | null;
  readonly reviewId: string | null;
  readonly verificationRunId: string | null;
  readonly auditEventId: string | null;
  readonly executionId: string | null;
  readonly correlationId: string | null;
  readonly status: NotificationStatus;
  readonly idempotencyKey: string | null;
  readonly provider: string | null;
  readonly deliveryMetadata: Record<string, unknown> | null;
  readonly errorMessage: string | null;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NotificationStatus = 'pending' | 'queued' | 'delivered' | 'failed';

// --- Create input ---

export interface CreateNotificationInput {
  organizationId?: string | null;
  projectId?: string | null;
  notificationType: string;
  eventType: string;
  recipient: string;
  recipientType?: string;
  subject?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown>;
  sourceType: string;
  sourceId: string;
  workItemId?: string | null;
  reviewId?: string | null;
  verificationRunId?: string | null;
  auditEventId?: string | null;
  executionId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
}

// --- Notification provider adapter (internal) ---

export interface NotificationProviderAdapter {
  readonly providerName: string;
  send(input: NotificationDeliveryInput): Promise<NotificationDeliveryResult>;
}

export interface NotificationDeliveryInput {
  readonly notificationId: string;
  readonly recipient: string;
  readonly recipientType: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly metadata: Record<string, unknown>;
  readonly notificationType: string;
  readonly eventType: string;
}

export interface NotificationDeliveryResult {
  readonly success: boolean;
  readonly providerMessageId?: string;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
}

// --- Notification repository ---

export interface NotificationRepository {
  create(input: CreateNotificationInput): Promise<NotificationRequest>;
  findById(id: string): Promise<NotificationRequest | null>;
  findByIdempotencyKey(key: string): Promise<NotificationRequest | null>;
  listForProject(projectId: string, opts?: { limit?: number }): Promise<NotificationRequest[]>;
  listForWorkItem(workItemId: string, opts?: { limit?: number }): Promise<NotificationRequest[]>;
  updateStatus(id: string, status: NotificationStatus, provider?: string | null, deliveryMetadata?: Record<string, unknown> | null, errorMessage?: string | null): Promise<NotificationRequest | null>;
  findPending(opts?: { limit?: number }): Promise<NotificationRequest[]>;
}

// --- Notification service (the public application boundary) ---

/**
 * The NotificationService is the provider-independent application boundary.
 * Other modules receive this via dependency injection and call `send()` to
 * emit notification requests. Delivery is asynchronous via the existing
 * Queue/WorkerHost -- `send()` does NOT block on provider delivery.
 *
 * NOTIFY-AC-01: notification requests use an abstraction without provider
 * coupling.
 *
 * NOTIFY-AC-02: notification failure does not incorrectly mutate
 * authoritative workflow state -- the service has no workflow mutation
 * capability.
 */
export interface NotificationService {
  /**
   * Create a notification request + enqueue it for async delivery.
   * Idempotent -- if an idempotencyKey is provided and a request with that
   * key already exists, return the existing request (no duplicate delivery).
   */
  send(input: CreateNotificationInput): Promise<NotificationRequest>;

  /**
   * Process a pending notification request (called by the worker handler).
   * Delivers via the provider adapter and updates the status.
   */
  processNotification(notificationId: string): Promise<void>;

  /**
   * Find a notification by ID.
   */
  findById(id: string): Promise<NotificationRequest | null>;

  /**
   * List notifications for a project.
   */
  listForProject(projectId: string, opts?: { limit?: number }): Promise<NotificationRequest[]>;

  /**
   * List notifications for a work item.
   */
  listForWorkItem(workItemId: string, opts?: { limit?: number }): Promise<NotificationRequest[]>;
}
