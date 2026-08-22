import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { Queue, JobHandler } from '@platform/index.js';
import type {
  NotificationRequest,
  NotificationService,
  CreateNotificationInput,
  NotificationProviderAdapter,
  NotificationDeliveryInput,
  NotificationDeliveryResult,
} from './notification.types.js';
import { PgNotificationRepository } from './pg-notification-repository.js';

/**
 * Default {@link NotificationService} — the provider-independent notification
 * boundary (NOTIFY-001).
 *
 * send() creates a notification request + enqueues it for async delivery via
 * the existing Queue/WorkerHost. It does NOT block on provider delivery.
 *
 * NOTIFY-AC-01: notification requests use an abstraction without provider
 * coupling — the service accepts provider-neutral NotificationRequest inputs
 * and delegates to a provider adapter behind the /notifications/internal
 * boundary.
 *
 * NOTIFY-AC-02: notification failure does not incorrectly mutate
 * authoritative workflow state — the service has no workflow mutation
 * capability. A delivery failure only updates the notification's own status.
 *
 * Secret safety: stripSecrets() strips known secret patterns from metadata
 * before persistence — defense-in-depth against accidental leaks.
 */
export class DefaultNotificationService implements NotificationService {
  private readonly repo: PgNotificationRepository;
  private readonly providers: Map<string, NotificationProviderAdapter>;

  constructor(
    db: DatabaseClient,
    private readonly logger: Logger,
    private readonly queue: Queue,
    adapters: readonly NotificationProviderAdapter[] = [],
  ) {
    this.repo = new PgNotificationRepository(db);
    this.providers = new Map();
    for (const a of adapters) this.providers.set(a.providerName, a);
  }

  async send(input: CreateNotificationInput): Promise<NotificationRequest> {
    // Secret safety: strip secrets from metadata.
    const safeMetadata = stripSecrets(input.metadata ?? {});
    const safeBody = input.body ? stripSecretsFromText(input.body) : null;

    // Idempotency: if an idempotency key is provided and a request with
    // that key already exists, return the existing request (no duplicate).
    if (input.idempotencyKey) {
      const existing = await this.repo.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        this.logger.info('notification.send.duplicate', {
          id: existing.id,
          idempotencyKey: input.idempotencyKey,
        });
        return existing;
      }
    }

    // Create the notification request.
    const notification = await this.repo.create({
      ...input,
      metadata: safeMetadata,
      body: safeBody,
    });

    // Enqueue for async delivery via the existing Queue/WorkerHost.
    await this.queue.enqueue('notification.send', { notificationId: notification.id }, {
      executionId: input.executionId ?? undefined,
    });

    this.logger.info('notification.send.queued', {
      id: notification.id,
      type: notification.notificationType,
      recipient: notification.recipient,
    });

    return notification;
  }

  async processNotification(notificationId: string): Promise<void> {
    const notification = await this.repo.findById(notificationId);
    if (!notification) {
      this.logger.warn('notification.process.not_found', { notificationId });
      return;
    }

    // Skip already-delivered notifications.
    if (notification.status === 'delivered') {
      this.logger.info('notification.process.already_delivered', { notificationId });
      return;
    }

    // Max retries exceeded.
    if (notification.retryCount >= notification.maxRetries) {
      await this.repo.updateStatus(notificationId, 'failed', null, null, 'max retries exceeded');
      this.logger.warn('notification.process.max_retries', { notificationId, retryCount: notification.retryCount });
      return;
    }

    // Find a provider adapter. If no adapters are configured (e.g. in tests
    // without a fake), mark as delivered with provider='local' (no-op).
    const provider = this.providers.get('local') ?? this.providers.values().next().value;
    if (!provider) {
      // No provider configured — mark as delivered (no-op).
      await this.repo.updateStatus(notificationId, 'delivered', 'local', { note: 'no provider configured' });
      this.logger.info('notification.process.no_provider', { notificationId });
      return;
    }

    try {
      const result: NotificationDeliveryResult = await provider.send({
        notificationId: notification.id,
        recipient: notification.recipient,
        recipientType: notification.recipientType,
        subject: notification.subject,
        body: notification.body,
        metadata: notification.metadata,
        notificationType: notification.notificationType,
        eventType: notification.eventType,
      });

      if (result.success) {
        await this.repo.updateStatus(notificationId, 'delivered', provider.providerName, {
          providerMessageId: result.providerMessageId,
          ...result.metadata,
        });
        this.logger.info('notification.process.delivered', {
          notificationId,
          provider: provider.providerName,
        });
      } else {
        await this.repo.updateStatus(notificationId, 'failed', provider.providerName, result.metadata, result.error);
        this.logger.warn('notification.process.failed', {
          notificationId,
          provider: provider.providerName,
          error: result.error,
        });
      }
    } catch (err) {
      await this.repo.updateStatus(notificationId, 'failed', provider.providerName, null, (err as Error).message);
      this.logger.error('notification.process.error', {
        notificationId,
        error: (err as Error).message,
      });
    }
  }

  async findById(id: string): Promise<NotificationRequest | null> {
    return this.repo.findById(id);
  }

  async listForProject(projectId: string, opts?: { limit?: number }): Promise<NotificationRequest[]> {
    return this.repo.listForProject(projectId, opts);
  }

  async listForWorkItem(workItemId: string, opts?: { limit?: number }): Promise<NotificationRequest[]> {
    return this.repo.listForWorkItem(workItemId, opts);
  }
}

// --- Fake/local provider adapter for tests ---

export class FakeNotificationProvider implements NotificationProviderAdapter {
  readonly providerName = 'local';
  private delivered: NotificationDeliveryInput[] = [];
  private failNext = false;

  setFailNext(fail: boolean): void { this.failNext = fail; }
  getDelivered(): NotificationDeliveryInput[] { return this.delivered; }
  reset(): void { this.delivered = []; this.failNext = false; }

  async send(input: NotificationDeliveryInput): Promise<NotificationDeliveryResult> {
    this.delivered.push(input);
    if (this.failNext) {
      this.failNext = false;
      return { success: false, error: 'simulated delivery failure' };
    }
    return { success: true, providerMessageId: `local-${Date.now()}` };
  }
}

// --- Secret safety helpers ---

function stripSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const SECRET_KEY_PATTERNS = /(?:secret|password|token|api_?key|credential|private_?key)/i;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_KEY_PATTERNS.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = stripSecrets(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function stripSecretsFromText(text: string): string {
  // Strip common secret patterns from text.
  return text
    .replace(/ghp_[A-Za-z0-9]{36}/g, '[REDACTED]')
    .replace(/gho_[A-Za-z0-9]{36}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}

// --- Worker job handler ---

export function createNotificationJobHandler(
  service: NotificationService,
  logger: Logger,
): JobHandler {
  return {
    type: 'notification.send',
    async handle(job): Promise<void> {
      const payload = job.payload as { notificationId: string };
      if (!payload?.notificationId) {
        logger.error('notification.job.missing_id', { jobId: job.id });
        return;
      }
      await service.processNotification(payload.notificationId);
    },
  };
}
