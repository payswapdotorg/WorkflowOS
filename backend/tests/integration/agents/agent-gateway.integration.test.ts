import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { createAgentJobHandler } from '../../../src/modules/agents/internal/agent-job-handler.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost, createLogger } from '@platform/index.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import { waitFor } from '../../helpers/test-app.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

describe('WORK-012 — Agent Gateway and Agent Runs', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let gateway: DefaultAgentGateway;
  let fakeAdapter: FakeAgentAdapter;
  let runRepo: PgAgentRunRepository;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
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
      WFOS_TEST_KEY_A: 'raw-key-agent-a',
      WFOS_TEST_KEY_B: 'raw-key-agent-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Agent Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Agent Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'agent-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'agent-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Agent Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Agent Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'agent-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'agent-user-a', label: 'User A', rawKey: 'raw-key-agent-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'agent-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'agent-user-b', label: 'User B', rawKey: 'raw-key-agent-b',
    });
    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Agent Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Agent Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    fakeAdapter = new FakeAgentAdapter();
    const capture = new CaptureStream();
    const logger = createLogger({ level: 'info', destination: capture });
    gateway = new DefaultAgentGateway(stack.db.client, logger, [fakeAdapter], 3);
    runRepo = new PgAgentRunRepository(stack.db.client);
    queue = new InMemoryQueue();
    const handlers = buildHandlerRegistry([createAgentJobHandler(gateway, logger)]);
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });

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
        architectureAssertionRepository: stack.architectureAssertionRepository,
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
      agents: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        agentGateway: gateway,
        agentRunRepository: runRepo,
        queue,
      },
    });
    await server.ready();
    await worker.start();
  });
  afterAll(async () => {
    await worker.stop();
    await server.close();
    await queue.close();
    await stack.teardown();
  });

  async function createWorkItemA(id: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionA.id, workItemId: id, title: id });
  }
  async function createWorkItemB(id: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionB.id, workItemId: id, title: id });
  }
  async function createWorkOrderFor(wi: { id: string }) {
    const wo = await stack.workOrderRepository.create({
      workItemId: wi.id, projectId: projectA.id, architectureVersionId: versionA.id,
    });
    return wo;
  }
  async function createWorkOrderForB(wi: { id: string }) {
    const wo = await stack.workOrderRepository.create({
      workItemId: wi.id, projectId: projectB.id, architectureVersionId: versionB.id,
    });
    return wo;
  }

  // --- Gateway contract ---

  it('gateway executes and returns a normalized result', async () => {
    const wi = await createWorkItemA('AG-001');
    const wo = await createWorkOrderFor(wi);
    fakeAdapter.setOutput('Agent completed successfully');
    const result = await gateway.execute({
      provider: 'fake', configuration: { model: 'test' },
      workItemId: wi.id, workOrderId: wo.id, executionId: 'agent-exec-001', input: 'Implement feature X',
    });
    expect(result.status).toBe('success');
    expect(result.output).toBe('Agent completed successfully');
    expect(result.provider).toBe('fake');
    expect(result.commitRef).toBe('abc123');
    expect(result.pullRequestRef).toBe('github:owner/repo#1');
    expect(result.reportedTests).toHaveLength(1);
    expect(result.reportedTests[0]!.status).toBe('pass');
  });

  it('unsupported provider fails with normalized error', async () => {
    const wi = await createWorkItemA('AG-002');
    await expect(
      gateway.execute({ provider: 'unknown', configuration: {}, workItemId: wi.id, workOrderId: 'unused', executionId: 'agent-exec-002', input: 'test' }),
    ).rejects.toMatchObject({ type: 'invalid_request', retryable: false });
  });

  // --- Agent Run persistence ---

  it('Agent Run persists with all required fields', async () => {
    const wi = await createWorkItemA('AG-003');
    const wo = await createWorkOrderFor(wi);
    fakeAdapter.setOutput('Persist test output');
    await gateway.execute({
      provider: 'fake', configuration: { key: 'value' },
      workItemId: wi.id, workOrderId: wo.id, executionId: 'agent-exec-003', input: 'test persist',
      repositoryRef: 'owner/repo', branch: 'feature-branch',
    });
    const run = await runRepo.findByExecutionId('agent-exec-003');
    expect(run).not.toBeNull();
    expect(run!.provider).toBe('fake');
    expect(run!.status).toBe('success');
    expect(run!.output).toBe('Persist test output');
    expect(run!.commitRef).toBe('abc123');
    expect(run!.pullRequestRef).toBe('github:owner/repo#1');
    expect(run!.reportedTests).toHaveLength(1);
    expect(run!.workItemId).toBe(wi.id);
    expect(run!.repositoryRef).toBe('owner/repo');
    expect(run!.branch).toBe('feature-branch');
  });

  // --- Retry behavior ---

  it('retryable failure retries and eventually succeeds', async () => {
    const wi = await createWorkItemA('AG-004');
    const wo = await createWorkOrderFor(wi);
    fakeAdapter.setOutput('Retry success');
    fakeAdapter.setFailure('rate_limit', 'Rate limited', true, 1);
    const result = await gateway.execute({
      provider: 'fake', configuration: {},
      workItemId: wi.id, workOrderId: wo.id, executionId: 'agent-exec-004', input: 'retry me',
    });
    expect(result.status).toBe('success');
    expect(fakeAdapter.getCallCount()).toBeGreaterThanOrEqual(2);
    const run = await runRepo.findByExecutionId('agent-exec-004');
    expect(run!.status).toBe('success');
  });

  it('non-retryable failure does NOT retry', async () => {
    const wi = await createWorkItemA('AG-005');
    const wo = await createWorkOrderFor(wi);
    fakeAdapter.setOutput('Should not reach');
    fakeAdapter.setFailure('authentication', 'Bad key', false, 99);
    const callsBefore = fakeAdapter.getCallCount();
    await expect(
      gateway.execute({ provider: 'fake', configuration: {}, workItemId: wi.id, workOrderId: wo.id, executionId: 'agent-exec-005', input: 'no retry' }),
    ).rejects.toMatchObject({ type: 'authentication', retryable: false });
    expect(fakeAdapter.getCallCount() - callsBefore).toBe(1);
    const run = await runRepo.findByExecutionId('agent-exec-005');
    expect(run!.status).toBe('failed');
    expect(run!.errorType).toBe('authentication');
  });

  // --- Async execution via API ---

  it('API: POST creates Agent Run + enqueues async (202)', async () => {
    // Reset the fake adapter to a clean state.
    fakeAdapter.reset();
    fakeAdapter.setOutput('Async output');
    const wi = await createWorkItemA('AG-006');
    const wo = await createWorkOrderFor(wi);
    const res = await server.inject({
      method: 'POST', url: `/work-items/${wi.id}/agent-runs`,
      headers: { 'x-api-key': 'raw-key-agent-a' },
      payload: { provider: 'fake', input: 'async test', workOrderId: wo.id },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { accepted: boolean; executionId: string };
    expect(body.accepted).toBe(true);
    // Wait for the worker to process — check for any terminal status.
    await waitFor(async () => {
      const r = await runRepo.findByExecutionId(body.executionId);
      return r?.status === 'success' || r?.status === 'failed';
    }, { timeoutMs: 20000 });
    const run = await runRepo.findByExecutionId(body.executionId);
    expect(run!.status).toBe('success');
    expect(run!.output).toBe('Async output');
  }, 30000);

  it('API: GET agent-runs list', async () => {
    const wi = await createWorkItemA('AG-007');
    const wo7 = await createWorkOrderFor(wi);
    await gateway.execute({ provider: 'fake', configuration: {}, workItemId: wi.id, workOrderId: wo7.id, executionId: 'agent-exec-007', input: 'list test' });
    const res = await server.inject({
      method: 'GET', url: `/work-items/${wi.id}/agent-runs`,
      headers: { 'x-api-key': 'raw-key-agent-a' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { agentRuns: unknown[] }).agentRuns).toHaveLength(1);
  });

  // --- Secret safety ---

  it('no raw credentials in Agent Run records', async () => {
    const wi = await createWorkItemA('AG-008');
    fakeAdapter.setOutput('Secret test');
    const wo8 = await createWorkOrderFor(wi);
    await gateway.execute({ provider: 'fake', configuration: {}, workItemId: wi.id, workOrderId: wo8.id, executionId: 'agent-exec-008', input: 'secret check' });
    const run = await runRepo.findByExecutionId('agent-exec-008');
    expect(JSON.stringify(run)).not.toContain('WFOS_TEST_KEY');
    expect(JSON.stringify(run)).not.toContain('raw-key-agent');
  });

  // --- Tenant isolation ---

  it('User A cannot read User B Agent Runs', async () => {
    const wiB = await createWorkItemB('AG-009-B');
    const wo9 = await createWorkOrderForB(wiB);
    await gateway.execute({ provider: 'fake', configuration: {}, workItemId: wiB.id, workOrderId: wo9.id, executionId: 'agent-exec-009', input: 'tenant test' });
    const res = await server.inject({
      method: 'GET', url: `/work-items/${wiB.id}/agent-runs`,
      headers: { 'x-api-key': 'raw-key-agent-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('User A cannot create Agent Run for User B work item', async () => {
    const wiB = await createWorkItemB('AG-010-B');
    const res = await server.inject({
      method: 'POST', url: `/work-items/${wiB.id}/agent-runs`,
      headers: { 'x-api-key': 'raw-key-agent-a' },
      payload: { provider: 'fake', input: 'cross-tenant' },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- Workflow authority ---

  it('Agent Run completion does NOT mutate workflow state', async () => {
    const wi = await createWorkItemA('AG-011');
    // Set the workflow to 'ready'.
    const { DefaultWorkflowEngine } = await import('../../../src/modules/workflows/internal/workflow-engine.js');
    const wfEngine = new DefaultWorkflowEngine(stack.db.client, stack.db.logger);
    await wfEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });
    // Execute an agent run.
    fakeAdapter.setOutput('Workflow authority test');
    const wo11 = await createWorkOrderFor(wi);
    await gateway.execute({ provider: 'fake', configuration: {}, workItemId: wi.id, workOrderId: wo11.id, executionId: 'agent-exec-011', input: 'test' });
    // The workflow state must still be 'ready' — agent execution does NOT
    // trigger a workflow transition.
    const exec = await wfEngine.getState(wi.id);
    expect(exec!.currentState).toBe('ready');
  });

  // --- Provider-independent public barrel ---

  it('public barrel does not export provider-specific types', async () => {
    const barrel = await import('@modules/agents/index.js');
    expect(barrel.agentsModule).toBeDefined();
    expect((barrel as Record<string, unknown>).FakeAgentAdapter).toBeUndefined();
    expect((barrel as Record<string, unknown>).DefaultAgentGateway).toBeUndefined();
  });

  // --- Work Order traceability (architect review PR #12) ---

  it('Agent Run without a Work Order is rejected (DB NOT NULL constraint)', async () => {
    const wi = await createWorkItemA('AG-012');
    fakeAdapter.reset();
    fakeAdapter.setOutput('Should not reach');
    // Direct DB insert without work_order_id — rejected by NOT NULL constraint.
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_agent_runs (execution_id, work_item_id, provider, status)
         VALUES ('exec-no-wo', $1, 'fake', 'pending')`,
        [wi.id],
      ),
    ).rejects.toThrow(/not-null|constraint|integrity/i);
  });

  it('Agent Run with a Work Order from a different Work Item is rejected (DB trigger)', async () => {
    const wiA = await createWorkItemA('AG-013-A');
    const wiB = await createWorkItemB('AG-013-B');
    const woB = await createWorkOrderForB(wiB); // belongs to wiB
    // Attempt to create an Agent Run for wiA but with woB's id.
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_agent_runs (execution_id, work_item_id, work_order_id, provider, status)
         VALUES ('exec-cross-wo', $1, $2, 'fake', 'pending')`,
        [wiA.id, woB.id],
      ),
    ).rejects.toThrow(/agent run integrity.*work order.*belongs to/i);
  });

  it('Agent Run with a valid Work Item + Work Order succeeds', async () => {
    const wi = await createWorkItemA('AG-014');
    const wo = await createWorkOrderFor(wi);
    fakeAdapter.reset();
    fakeAdapter.setOutput('Valid WO test');
    const result = await gateway.execute({
      provider: 'fake', configuration: {},
      workItemId: wi.id, workOrderId: wo.id,
      executionId: 'agent-exec-014', input: 'valid wo',
    });
    expect(result.status).toBe('success');
    const run = await runRepo.findByExecutionId('agent-exec-014');
    expect(run!.workOrderId).toBe(wo.id);
    expect(run!.workItemId).toBe(wi.id);
  });

  it('API: Agent Run without workOrderId is rejected (400)', async () => {
    const wi = await createWorkItemA('AG-015');
    const res = await server.inject({
      method: 'POST', url: `/work-items/${wi.id}/agent-runs`,
      headers: { 'x-api-key': 'raw-key-agent-a' },
      payload: { provider: 'fake', input: 'missing wo' },
    });
    expect(res.statusCode).toBe(400);
  });
});
