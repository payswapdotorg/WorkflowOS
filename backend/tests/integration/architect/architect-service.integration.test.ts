import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultLlmGateway, FakeLlmAdapter } from '../../../src/modules/llm/internal/llm-gateway.js';
import { DefaultArchitectService } from '../../../src/modules/llm/internal/architect-service.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { ArchitectExecutionResult } from '@modules/llm/index.js';

describe('WORK-014 — Architect execution and Work Order generation', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let architectService: DefaultArchitectService;
  let fakeLlm: FakeLlmAdapter;
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
      WFOS_TEST_KEY_A: 'raw-key-arch-a',
      WFOS_TEST_KEY_B: 'raw-key-arch-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Arch Exec Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Arch Exec Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'arch-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'arch-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Arch Exec Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Arch Exec Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'arch-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'arch-user-a', label: 'User A', rawKey: 'raw-key-arch-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'arch-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'arch-user-b', label: 'User B', rawKey: 'raw-key-arch-b',
    });
    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Arch Exec Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Architecture constraints v1' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Arch Exec Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'Architecture constraints B' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    // Create requirements + criteria for project A.
    const reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id, requirementId: 'REQ-A-001', title: 'Auth requirement',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-1', description: 'Valid auth resolves identity',
    });

    fakeLlm = new FakeLlmAdapter();
    const llmGateway = new DefaultLlmGateway(stack.db.client, stack.db.logger, [fakeLlm], 3);
    architectService = new DefaultArchitectService(
      stack.db.client,
      llmGateway,
      stack.workOrderRepository,
      stack.db.logger,
    );

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
      requirements: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        requirementRepository: stack.requirementRepository,
        requirementDependencyRepository: stack.requirementDependencyRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        evidenceReferenceRepository: stack.evidenceReferenceRepository,
      },
      workflow: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workflowEngine: new (await import('../../../src/modules/workflows/internal/workflow-engine.js')).DefaultWorkflowEngine(stack.db.client, stack.db.logger),
      },
      architect: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workOrderRepository: stack.workOrderRepository,
        workItemRequirementRepository: stack.workItemRequirementRepository,
        workItemCriterionRepository: stack.workItemCriterionRepository,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        requirementRepository: stack.requirementRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        llmGateway,
        architectService,
        conversationalArchitectService: new (await import('../../../src/modules/llm/internal/conversational-architect-service.js')).DefaultConversationalArchitectService(
          stack.db.client, llmGateway, stack.projectRepository,
          stack.architectureRepository, stack.architectureVersionRepository,
          stack.requirementRepository, stack.acceptanceCriterionRepository,
          stack.workItemRepository, new (await import('../../../src/platform/default-provider-registry.js')).DefaultProviderRegistry(stack.secretStore), stack.db.logger,
        ),
        sessionRepository: new (await import('../../../src/modules/llm/internal/pg-architect-session-repository.js')).PgArchitectSessionRepository(stack.db.client),
        db: stack.db.client,
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

  // --- Context assembly ---

  it('architect execution assembles context from persistent state', async () => {
    fakeLlm.setResponse(JSON.stringify({
      verdict: 'approve', summary: 'Context assembled correctly',
      reasoning: 'All requirements satisfied',
      risks: ['minor risk'], constraints: ['use existing abstractions'],
      corrections: [], architectureChangeRequired: false,
      workOrder: {
        scope: 'Implement auth', outOfScope: 'No frontend',
        constraints: 'Reuse existing patterns',
        requirementIds: ['req-id'], criterionIds: ['crit-id'],
        verificationRequirements: ['integration test'],
        implementationContext: { repository: 'owner/repo' },
      },
    }));
    const wi = await createWorkItemA('ARCH-001');
    const result = await architectService.execute({
      projectId: projectA.id, architectureVersionId: versionA.id,
      workItemId: wi.id, task: 'Generate work order for auth',
      executionId: 'arch-exec-001', provider: 'fake', model: 'test-model',
    });
    expect(result.executionId).toBe('arch-exec-001');
    expect(result.provider).toBe('fake');
    expect(result.model).toBe('test-model');
    expect(result.verdict).toBe('approve');
    expect(result.summary).toBe('Context assembled correctly');
    expect(result.workOrderCandidate).not.toBeNull();
    expect(result.workOrderCandidate!.scope).toBe('Implement auth');
  });

  // --- Work Order generation ---

  it('Work Order is generated from architect result with exact ArchitectureVersion reference', async () => {
    const wi = await createWorkItemA('ARCH-002');
    fakeLlm.setResponse(JSON.stringify({
      verdict: 'approve', summary: 'WO generation test',
      reasoning: 'OK', risks: [], constraints: ['constraint-1'],
      corrections: [], architectureChangeRequired: false,
      workOrder: {
        scope: 'Implement feature', outOfScope: 'No deployment',
        constraints: 'Follow architecture',
        requirementIds: [], criterionIds: [],
        verificationRequirements: ['unit test'],
        implementationContext: { branch: 'main' },
      },
    }));
    const archResult = await architectService.execute({
      projectId: projectA.id, architectureVersionId: versionA.id,
      workItemId: wi.id, task: 'Generate WO',
      executionId: 'arch-exec-002', provider: 'fake', model: 'test-model',
    });
    const woResult = await architectService.generateWorkOrder({
      projectId: projectA.id, architectureVersionId: versionA.id,
      workItemId: wi.id, task: 'Generate WO',
      executionId: 'arch-exec-002', provider: 'fake', model: 'test-model',
    }, archResult);
    expect(woResult.workOrderId).toBeTruthy();
    expect(woResult.architectExecutionId).toBe('arch-exec-002');
    // Verify the Work Order references the exact ArchitectureVersion.
    const wo = await stack.workOrderRepository.findById(woResult.workOrderId);
    expect(wo!.architectureVersionId).toBe(versionA.id);
    expect(wo!.workItemId).toBe(wi.id);
    expect(wo!.projectId).toBe(projectA.id);
    expect(wo!.scope).toBe('Implement feature');
    expect(wo!.state).toBe('generated');
  });

  // --- Evidence distinction: LLM output cannot mark criteria PASS ---

  it('architect execution does NOT mutate workflow state', async () => {
    const wi = await createWorkItemA('ARCH-003');
    const { DefaultWorkflowEngine } = await import('../../../src/modules/workflows/internal/workflow-engine.js');
    const wfEngine = new DefaultWorkflowEngine(stack.db.client, stack.db.logger);
    await wfEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });
    fakeLlm.setResponse(JSON.stringify({
      verdict: 'approve', summary: 'Workflow authority test',
      reasoning: '', risks: [], constraints: [], corrections: [],
      architectureChangeRequired: false, workOrder: null,
    }));
    await architectService.execute({
      projectId: projectA.id, architectureVersionId: versionA.id,
      workItemId: wi.id, task: 'Test workflow authority',
      executionId: 'arch-exec-003', provider: 'fake', model: 'test-model',
    });
    const exec = await wfEngine.getState(wi.id);
    expect(exec!.currentState).toBe('ready');
  });

  // --- Frozen architecture safety ---

  it('architect execution cannot mutate frozen ArchitectureVersion', async () => {
    const wi = await createWorkItemA('ARCH-004');
    const versionBefore = await stack.architectureVersionRepository.findById(versionA.id);
    fakeLlm.setResponse('{"verdict":"approve","summary":"frozen test","reasoning":"","risks":[],"constraints":[],"corrections":[],"architectureChangeRequired":false}');
    await architectService.execute({
      projectId: projectA.id, architectureVersionId: versionA.id,
      workItemId: wi.id, task: 'Frozen arch test',
      executionId: 'arch-exec-004', provider: 'fake', model: 'test-model',
    });
    const versionAfter = await stack.architectureVersionRepository.findById(versionA.id);
    expect(versionAfter!.state).toBe(versionBefore!.state);
    expect(versionAfter!.contentInline).toBe(versionBefore!.contentInline);
  });

  // --- API: authorized execution ---

  it('API: authorized architect execution succeeds (200)', async () => {
    fakeLlm.setResponse(JSON.stringify({
      verdict: 'approve', summary: 'API test', reasoning: '',
      risks: [], constraints: [], corrections: [],
      architectureChangeRequired: false, workOrder: null,
    }));
    const res = await server.inject({
      method: 'POST', url: `/projects/${projectA.id}/architect/execute`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { architectureVersionId: versionA.id, task: 'API test', provider: 'fake', model: 'test-model' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ArchitectExecutionResult;
    expect(body.verdict).toBe('approve');
  });

  it('API: mismatched ArchitectureVersion is rejected (403)', async () => {
    const res = await server.inject({
      method: 'POST', url: `/projects/${projectA.id}/architect/execute`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { architectureVersionId: versionB.id, task: 'Cross-project', provider: 'fake', model: 'test-model' },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- Tenant isolation ---

  it('tenant isolation: User A cannot execute architect for Project B', async () => {
    const res = await server.inject({
      method: 'POST', url: `/projects/${projectB.id}/architect/execute`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { architectureVersionId: versionB.id, task: 'cross-tenant', provider: 'fake', model: 'test-model' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tenant isolation: User A cannot generate Work Order for Project B', async () => {
    const res = await server.inject({
      method: 'POST', url: `/projects/${projectB.id}/architect/generate-work-order`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { architectureVersionId: versionB.id, workItemId: 'fake', task: 'cross-tenant', provider: 'fake', model: 'test-model' },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- Secret safety ---

  it('no raw credentials in architect result', async () => {
    const wi = await createWorkItemA('ARCH-005');
    fakeLlm.setResponse(JSON.stringify({
      verdict: 'approve', summary: 'Secret test', reasoning: '',
      risks: [], constraints: [], corrections: [],
      architectureChangeRequired: false, workOrder: null,
    }));
    const result = await architectService.execute({
      projectId: projectA.id, architectureVersionId: versionA.id,
      workItemId: wi.id, task: 'Secret check',
      executionId: 'arch-exec-005', provider: 'fake', model: 'test-model',
    });
    expect(JSON.stringify(result)).not.toContain('WFOS_TEST_KEY');
    expect(JSON.stringify(result)).not.toContain('raw-key-arch');
  });
});
