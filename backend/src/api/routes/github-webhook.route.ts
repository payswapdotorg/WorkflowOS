import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from '@platform/logger.js';
import type { Queue } from '@platform/index.js';
import type { SecretStore } from '@platform/index.js';
import type { GitHubAdapter } from '@modules/github/index.js';
import type { WebhookEventRepository, WebhookProcessingService } from '@modules/github/index.js';

/**
 * GitHub webhook ingress boundary (GITHUB-002).
 *
 * Flow:
 *   GitHub → webhook endpoint → signature validation → durable receipt →
 *   enqueue → return 202.
 *
 * The HTTP request MUST NOT perform long-running processing synchronously.
 * Processing happens asynchronously via the Redis-backed worker.
 *
 * The webhook endpoint is isolated from ordinary authenticated user APIs —
 * it does not use the auth plugin. Instead it validates the GitHub webhook
 * signature using the SecretStore.
 */
export interface WebhookRouteDeps {
  queue: Queue;
  logger: Logger;
  secretStore: SecretStore;
  /** The env var name holding the GitHub webhook secret. */
  webhookSecretRef: string;
  githubAdapter: GitHubAdapter;
  webhookEventRepository: WebhookEventRepository;
  /** Not used directly by the route but wired for the worker handler. */
  webhookProcessingService?: WebhookProcessingService;
}

export async function githubWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRouteDeps,
): Promise<void> {
  app.post('/webhooks/github', async (req: FastifyRequest, reply: FastifyReply) => {
    // 1. Extract headers.
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;
    const eventType = req.headers['x-github-event'] as string | undefined;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    // 2. Validate required headers.
    if (!deliveryId || !eventType) {
      return reply.code(400).send({ error: 'missing-required-headers' });
    }

    // 3. Get the raw payload.
    const rawBody = typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body ?? '');

    // 4. Validate the signature.
    const secretValue = await deps.secretStore.getSecret({ key: deps.webhookSecretRef });
    if (!secretValue) {
      deps.logger.error('webhook.secret_not_found', { ref: deps.webhookSecretRef });
      return reply.code(500).send({ error: 'webhook-secret-not-configured' });
    }

    const signatureValid = deps.githubAdapter.verifyWebhookSignature(rawBody, signature ?? '', secretValue);
    if (!signatureValid) {
      deps.logger.warn('webhook.invalid_signature', { deliveryId });
      await deps.webhookEventRepository.createReceipt({
        deliveryId,
        eventType,
        signatureValid: false,
        payload: rawBody,
      });
      return reply.code(401).send({ error: 'invalid-signature' });
    }

    // 5. Parse repository identity from the payload.
    let repoFullName: string | null = null;
    let repoId: string | null = null;
    try {
      const parsed = JSON.parse(rawBody) as { repository?: { id?: number; full_name?: string } };
      repoFullName = parsed.repository?.full_name ?? null;
      repoId = parsed.repository?.id?.toString() ?? null;
    } catch {
      // Invalid JSON — persist the receipt but mark as failed.
    }

    // 6. Persist the durable receipt (idempotent on delivery_id).
    const receipt = await deps.webhookEventRepository.createReceipt({
      deliveryId,
      eventType,
      repositoryFullName: repoFullName,
      repositoryId: repoId,
      signatureValid: true,
      payload: rawBody,
    });

    // 7. Enqueue asynchronous processing (if not already processed).
    if (receipt.processingState === 'received') {
      await deps.queue.enqueue('github.webhook', { deliveryId }, {
        executionId: deliveryId,
      });
    }

    // 8. Return immediately — do NOT wait for processing.
    return reply.code(202).send({
      accepted: true,
      deliveryId,
      eventId: receipt.id,
    });
  });
}
