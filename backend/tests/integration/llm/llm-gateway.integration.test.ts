import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultLlmGateway, FakeLlmAdapter } from '../../../src/modules/llm/internal/llm-gateway.js';
import { PgLlmExecutionRecordRepository } from '../../../src/modules/llm/internal/pg-llm-repository.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { LlmResponse } from '@modules/llm/index.js';

describe('WORK-013 — LLM Gateway', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let gateway: DefaultLlmGateway;
  let fakeAdapter: FakeLlmAdapter;
  let recordRepo: PgLlmExecutionRecordRepository;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };
  let versionB: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-llm-a',
      WFOS_TEST_KEY_B: 'raw-key-llm-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'LLM Org A' });
    orgB = await stack.organizationRepository.create({ name: 'LLM Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'llm-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'llm-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'LLM Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'LLM Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'llm-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'llm-user-a', label: 'User A', rawKey: 'raw-key-llm-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'llm-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'llm-user-b', label: 'User B', rawKey: 'raw-key-llm-b',
    });
    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'LLM Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'LLM Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    fakeAdapter = new FakeLlmAdapter();
    gateway = new DefaultLlmGateway(stack.db.client, stack.db.logger, [fakeAdapter], 3);
    recordRepo = new PgLlmExecutionRecordRepository(stack.db.client);

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      architecture: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureDecisionRepository: stack.architectureDecisionRepository,
        architectureChangeRequestRepository: stack.architectureChangeRequestRepository,
        architectureService: stack.architectureService,
      },
      workItems: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workItemRequirementRepository: stack.workItemRequirementRepository,
        workItemCriterionRepository: stack.workItemCriterionRepository,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
        workOrderRepository: stack.workOrderRepository,
      },
      workflow: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workflowEngine: new (await import('../../../src/modules/workflows/internal/workflow-engine.js')).DefaultWorkflowEngine(stack.db.client, stack.db.logger),
      },
      llm: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        llmGateway: gateway,
        executionRecordRepository: recordRepo,
      },
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  async function createWorkItemA(id: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionA.id, workItemId: id, title: id });
  }
  async function createWorkItemB(id: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionB.id, workItemId: id, title: id });
  }

  // --- Gateway contract ---

  it('gateway generates a normalized response', async () => {
    const wi = await createWorkItemA('LLM-001');
    fakeAdapter.setResponse('Test response content');
    const response = await gateway.generate({
      provider: 'fake',
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      executionId: 'exec-001',
      workItemId: wi.id,
    });
    expect(response.content).toBe('Test response content');
    expect(response.provider).toBe('fake');
    expect(response.model).toBe('test-model');
    expect(response.finishReason).toBe('stop');
    expect(response.usage.totalTokens).toBe(30);
    expect(response.executionId).toBe('exec-001');
  });

  it('unsupported provider/model fails with a normalized error', async () => {
    await expect(
      gateway.generate({
        provider: 'unknown',
        model: 'nope',
        messages: [{ role: 'user', content: 'test' }],
        executionId: 'exec-002',
      }),
    ).rejects.toMatchObject({ type: 'invalid_request', retryable: false });
  });

  // --- Retry behavior ---

  it('retryable failure retries and eventually succeeds', async () => {
    fakeAdapter.setResponse('Fake LLM response');
    fakeAdapter.setFailure('rate_limit', 'Rate limited', true, 1);
    const wi = await createWorkItemA('LLM-002');
    const response = await gateway.generate({
      provider: 'fake',
      model: 'test-model',
      messages: [{ role: 'user', content: 'retry me' }],
      executionId: 'exec-003',
      workItemId: wi.id,
    });
    expect(response.content).toBe('Fake LLM response');
    expect(fakeAdapter.getCallCount()).toBeGreaterThanOrEqual(2);
    // Execution record shows success.
    const record = await recordRepo.findByExecutionId('exec-003');
    expect(record!.status).toBe('success');
  });

  it('non-retryable failure does NOT retry', async () => {
    fakeAdapter.setResponse('Fake LLM response');
    fakeAdapter.setFailure('authentication', 'Invalid API key', false, 99);
    const wi = await createWorkItemA('LLM-003');
    const callCountBefore = fakeAdapter.getCallCount();
    await expect(
      gateway.generate({
        provider: 'fake',
        model: 'test-model',
        messages: [{ role: 'user', content: 'no retry' }],
        executionId: 'exec-004',
        workItemId: wi.id,
      }),
    ).rejects.toMatchObject({ type: 'authentication', retryable: false });
    // Only 1 call was made (no retries).
    expect(fakeAdapter.getCallCount() - callCountBefore).toBe(1);
    const record = await recordRepo.findByExecutionId('exec-004');
    expect(record!.status).toBe('failed');
    expect(record!.errorType).toBe('authentication');
  });

  // --- Usage persistence ---

  it('execution record persists with provider, model, usage, and status', async () => {
    fakeAdapter.setResponse('Usage test response');
    fakeAdapter.setFailure('rate_limit', '', true, 0); // reset — no failure
    const wi = await createWorkItemA('LLM-004');
    await gateway.generate({
      provider: 'fake',
      model: 'test-model',
      messages: [{ role: 'user', content: 'usage' }],
      executionId: 'exec-005',
      workItemId: wi.id,
    });
    const record = await recordRepo.findByExecutionId('exec-005');
    expect(record).not.toBeNull();
    expect(record!.provider).toBe('fake');
    expect(record!.model).toBe('test-model');
    expect(record!.status).toBe('success');
    expect(record!.responseContent).toBe('Usage test response');
    expect(record!.usageMetadata.totalTokens).toBe(30);
    expect(record!.workItemId).toBe(wi.id);
  });

  it('no raw secret is persisted in the execution record', async () => {
    fakeAdapter.setResponse('Secret test');
    const wi = await createWorkItemA('LLM-005');
    await gateway.generate({
      provider: 'fake',
      model: 'test-model',
      messages: [{ role: 'user', content: 'secret check' }],
      executionId: 'exec-006',
      workItemId: wi.id,
    });
    const record = await recordRepo.findByExecutionId('exec-006');
    expect(JSON.stringify(record!.requestMetadata)).not.toContain('WFOS_TEST_KEY');
    expect(JSON.stringify(record!.usageMetadata)).not.toContain('secret');
    expect(record!.responseContent).not.toContain('WFOS_TEST_KEY');
  });

  // --- API ---

  it('API: authorized generate succeeds (200)', async () => {
    fakeAdapter.setResponse('API response');
    const wi = await createWorkItemA('LLM-006');
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/llm/generate`,
      headers: { 'x-api-key': 'raw-key-llm-a' },
      payload: {
        provider: 'fake',
        model: 'test-model',
        messages: [{ role: 'user', content: 'via API' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LlmResponse;
    expect(body.content).toBe('API response');
  });

  it('API: execution records listable', async () => {
    const wi = await createWorkItemA('LLM-007');
    await gateway.generate({
      provider: 'fake', model: 'test-model',
      messages: [{ role: 'user', content: 'list' }],
      executionId: 'exec-007', workItemId: wi.id,
    });
    const res = await server.inject({
      method: 'GET', url: `/work-items/${wi.id}/llm/executions`,
      headers: { 'x-api-key': 'raw-key-llm-a' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { executions: unknown[] }).executions).toHaveLength(1);
  });

  // --- Tenant isolation ---

  it('tenant isolation: User A cannot read User B LLM executions', async () => {
    const wiB = await createWorkItemB('LLM-008-B');
    await gateway.generate({
      provider: 'fake', model: 'test-model',
      messages: [{ role: 'user', content: 'tenant test' }],
      executionId: 'exec-008', workItemId: wiB.id,
    });
    const res = await server.inject({
      method: 'GET', url: `/work-items/${wiB.id}/llm/executions`,
      headers: { 'x-api-key': 'raw-key-llm-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tenant isolation: User A cannot generate LLM for User B work item', async () => {
    const wiB = await createWorkItemB('LLM-009-B');
    const res = await server.inject({
      method: 'POST', url: `/work-items/${wiB.id}/llm/generate`,
      headers: { 'x-api-key': 'raw-key-llm-a' },
      payload: { provider: 'fake', model: 'test-model', messages: [{ role: 'user', content: 'cross-tenant' }] },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- Provider-independent types ---

  it('public barrel does not export provider-specific types', async () => {
    // The /llm barrel exports only types (LlmGateway, LlmRequest, LlmResponse, etc.)
    // It does NOT export FakeLlmAdapter or LlmProviderAdapter.
    const barrel = await import('@modules/llm/index.js');
    expect(barrel.llmModule).toBeDefined();
    // These are type-only exports; no runtime values for the gateway/adapter.
    expect((barrel as Record<string, unknown>).FakeLlmAdapter).toBeUndefined();
    expect((barrel as Record<string, unknown>).DefaultLlmGateway).toBeUndefined();
  });
});
