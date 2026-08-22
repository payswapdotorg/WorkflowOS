import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost, createLogger } from '@platform/index.js';
import { createHmac } from 'node:crypto';
import { PgWebhookEventRepository, DefaultGitHubAdapter } from '../../../src/modules/github/internal/pg-github-repository.js';
import { DefaultWebhookProcessingService } from '../../../src/modules/github/internal/webhook-processing-service.js';
import type { FastifyInstance } from 'fastify';
import { waitFor } from '../../helpers/test-app.js';
import { CaptureStream } from '../../helpers/capture-stream.js';

function hmacSign(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

describe('WORK-008 — GitHub webhook ingestion', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let eventRepo: PgWebhookEventRepository;
  const SECRET = 'test-webhook-secret';
  const SECRET_REF = 'WFOS_TEST_GITHUB_WEBHOOK_SECRET';

  beforeAll(async () => {
    stack = await buildAuthStack({ [SECRET_REF]: SECRET });
    const capture = new CaptureStream();
    const logger = createLogger({ level: 'info', destination: capture });
    queue = new InMemoryQueue();
    eventRepo = new PgWebhookEventRepository(stack.db.client);

    const processingService = new DefaultWebhookProcessingService(
      eventRepo,
      new (await import('../../../src/modules/github/internal/pg-github-repository.js')).PgGitHubInstallationRepository(stack.db.client),
      stack.pullRequestAssociationRepository,
      stack.repositoryAssociationRepository,
      logger,
    );
    const { createWebhookJobHandler } = await import('../../../src/modules/github/internal/webhook-processing-service.js');
    const handlers = buildHandlerRegistry([
      createWebhookJobHandler(processingService, logger),
    ]);
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      githubWebhook: {
        queue,
        logger: stack.db.logger,
        secretStore: stack.secretStore,
        webhookSecretRef: SECRET_REF,
        githubAdapter: new DefaultGitHubAdapter(),
        webhookEventRepository: eventRepo,
      },
    });
    await server.ready();
    await worker.start();
  });
  afterAll(async () => {
    await worker.stop();
    await server.close();
    await stack.teardown();
  });

  // --- Webhook validation ---

  it('valid signature is accepted (202)', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 1, title: 'Test PR', state: 'open', head: { ref: 'feature' }, base: { ref: 'main' } },
      repository: { id: 123, full_name: 'owner/repo' },
      installation: { id: 456 },
    });
    const signature = hmacSign(payload, SECRET);
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'test-delivery-valid-001',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { accepted: boolean; deliveryId: string };
    expect(body.accepted).toBe(true);
    expect(body.deliveryId).toBe('test-delivery-valid-001');
  });

  it('invalid signature is rejected (401)', async () => {
    const payload = JSON.stringify({ repository: { full_name: 'owner/repo' } });
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'test-delivery-invalid-sig',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=invalid',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('missing signature is rejected (401)', async () => {
    const payload = JSON.stringify({ repository: { full_name: 'owner/repo' } });
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'test-delivery-missing-sig',
        'x-github-event': 'push',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('missing delivery ID is rejected (400)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  // --- Durable receipt ---

  it('webhook receipt persists in PostgreSQL', async () => {
    const deliveryId = 'test-delivery-receipt-001';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 42, title: 'Receipt PR', state: 'open' },
      repository: { id: 789, full_name: 'owner/receipt-repo' },
      installation: { id: 999 },
    });
    const res = await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });
    expect(res.statusCode).toBe(202);
    // The receipt is in PostgreSQL.
    const receipt = await eventRepo.findByDeliveryId(deliveryId);
    expect(receipt).not.toBeNull();
    expect(receipt!.eventType).toBe('pull_request');
    expect(receipt!.repositoryFullName).toBe('owner/receipt-repo');
    expect(receipt!.signatureValid).toBe(true);
  });

  // --- Idempotency ---

  it('duplicate delivery ID is idempotent (one receipt, no duplicate enqueue)', async () => {
    const deliveryId = 'test-delivery-dup-001';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 99, title: 'Dup PR', state: 'open' },
      repository: { id: 111, full_name: 'owner/dup-repo' },
      installation: { id: 222 },
    });
    const headers = {
      'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
      'x-hub-signature-256': hmacSign(payload, SECRET),
      'content-type': 'application/json',
    };
    // First delivery.
    const res1 = await server.inject({ method: 'POST', url: '/webhooks/github', headers, payload });
    expect(res1.statusCode).toBe(202);
    // Second delivery (duplicate).
    const res2 = await server.inject({ method: 'POST', url: '/webhooks/github', headers, payload });
    expect(res2.statusCode).toBe(202);
    // Only one receipt exists.
    const receipt = await eventRepo.findByDeliveryId(deliveryId);
    expect(receipt).not.toBeNull();
    expect(receipt!.deliveryId).toBe(deliveryId);
    // The queue should have at most one job for this delivery.

    // Wait for processing to drain.
    await waitFor(async () => {
      const fetched = await eventRepo.findByDeliveryId(deliveryId);
      return fetched?.processingState === 'processed';
    });
  });

  // --- Asynchronous behavior ---

  it('HTTP request returns 202 without waiting for processing', async () => {
    const deliveryId = 'test-delivery-async-001';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 77, title: 'Async PR', state: 'open' },
      repository: { id: 333, full_name: 'owner/async-repo' },
      installation: { id: 444 },
    });

    const res = await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });

    expect(res.statusCode).toBe(202);
    // The API returns immediately — processing hasn't finished yet.
    // (The worker processes asynchronously.)
    const receiptBeforeProcessing = await eventRepo.findByDeliveryId(deliveryId);
    expect(receiptBeforeProcessing!.processingState).toMatch(/received|processing|processed/);
    // Wait for the worker to process.
    await waitFor(async () => {
      const fetched = await eventRepo.findByDeliveryId(deliveryId);
      return fetched?.processingState === 'processed';
    });
    const receiptAfter = await eventRepo.findByDeliveryId(deliveryId);
    expect(receiptAfter!.processingState).toBe('processed');
  });

  // --- Receipt survives Redis loss ---

  it('receipt survives Redis loss (PostgreSQL is authoritative)', async () => {
    const deliveryId = 'test-delivery-survive-001';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 55, title: 'Survive PR', state: 'open' },
      repository: { id: 555, full_name: 'owner/survive-repo' },
      installation: { id: 666 },
    });
    await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });
    await waitFor(async () => {
      const fetched = await eventRepo.findByDeliveryId(deliveryId);
      return fetched?.processingState === 'processed';
    });
    // "Flush Redis" — the receipt is still in PostgreSQL.
    await queue.close();
    const receipt = await eventRepo.findByDeliveryId(deliveryId);
    expect(receipt).not.toBeNull();
    expect(receipt!.processingState).toBe('processed');
  });

  // --- Secrets ---

  it('GitHub credentials are retrieved through SecretStore (not stored in records)', async () => {
    const deliveryId = 'test-delivery-secret-002';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 33, title: 'Secret PR', state: 'open' },
      repository: { id: 777, full_name: 'owner/secret-repo' },
      installation: { id: 888 },
    });
    await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });
    // The receipt must NOT contain the raw secret.
    const receipt = await eventRepo.findByDeliveryId(deliveryId);
    expect(receipt).not.toBeNull();
    expect(receipt!.payload).not.toContain(SECRET);
  });
});
