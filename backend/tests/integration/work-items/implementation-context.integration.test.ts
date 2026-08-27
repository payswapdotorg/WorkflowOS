import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultStartImplementationService } from '../../../src/modules/work-items/internal/start-implementation-service.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { PgAgentProviderConfigRepository } from '../../../src/modules/agents/internal/pg-agent-provider-config-repository.js';
import { DefaultAgentProviderRegistryService } from '../../../src/modules/agents/internal/agent-provider-registry-service.js';
import { DefaultAgentProviderRegistry } from '../../../src/platform/default-agent-provider-registry.js';
// WORK-027: execution provider abstraction internals.
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import { DefaultExecutionService } from '../../../src/modules/agents/internal/execution-service.js';
import { DefaultExecutionPromptBuilder } from '../../../src/modules/work-items/internal/execution-prompt-builder.js';
import { DefaultExecutionTaskService } from '../../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { ImplementationContextContent } from '@modules/work-items/index.js';
import type { RequirementRepository } from '../../../src/modules/requirements/internal/requirement.types.js';
import type { WorkItemRepository } from '../../../src/modules/work-items/internal/work-item.types.js';

/**
 * WORK-026 — ImplementationContextBuilder + start-implementation route.
 *
 * PR #29 fix #1: the start-implementation route MUST actually invoke the
 * AgentGateway — there is NO production no-op path that returns success
 * without an AgentRun. These tests prove:
 *   - happy path: 201 + ImplementationContext revision 1 + kind 'initial'
 *     + AgentGateway invoked exactly once + AgentRun persisted + executionId
 *   - content shape: objective, scope, resolved requirements + criteria,
 *     resolved dependencies, instructions
 *   - second build() after a REQUEST_CHANGES review produces revision=2 +
 *     kind='correction'
 *   - workflow-state validation: NOT in 'ready' or 'changes_requested' → 400
 *   - 404 when the work item doesn't exist
 *   - tenant isolation
 *
 * PR #29 fix #1 regression: AgentGateway rejects → 502 + NO fake AgentRun
 * persisted as successful + workflow state unchanged.
 *
 * PR #29 fix #4 regression: builder fails loudly on missing requirement /
 * criterion / dependency target (no silent skip).
 */
describe('WORK-026 — ImplementationContext + start-implementation', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let contextRepo: PgImplementationContextRepository;
  let agentRunRepo: PgAgentRunRepository;
  let workflowEngine: DefaultWorkflowEngine;
  let reviewService: DefaultReviewService;
  let fakeAgent: FakeAgentAdapter;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };
  let versionB: { id: string };
  let reqA: { id: string };
  let criterionA1Id: string;

  beforeAll(async () => {
    // Configure a ready agent provider so the route can validate provider/model.
    process.env.AGENT_PROVIDER_NAME = 'fake';
    process.env.AGENT_API_KEY = 'test-agent-key';
    process.env.AGENT_DEFAULT_MODEL = 'test-model';

    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-impl-a',
      WFOS_TEST_KEY_B: 'raw-key-impl-b',
      AGENT_API_KEY: 'test-agent-key',
    });
    orgA = await stack.organizationRepository.create({ name: 'Impl Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Impl Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'impl-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'impl-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Impl Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Impl Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'impl-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'impl-user-a', label: 'User A', rawKey: 'raw-key-impl-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'impl-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'impl-user-b', label: 'User B', rawKey: 'raw-key-impl-b',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Impl Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Impl constraints A' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Impl Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'Impl constraints B' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'REQ-IMPL-A-001',
      title: 'Auth works',
      description: 'Valid auth resolves identity',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-IMPL-1',
      description: 'Valid auth resolves identity',
      verificationExpectation: 'integration-test',
    }).then((c) => { criterionA1Id = c.id; });

    contextRepo = new PgImplementationContextRepository(stack.db.client);
    agentRunRepo = new PgAgentRunRepository(stack.db.client);
    reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, stack.db.logger);
    workflowEngine = new DefaultWorkflowEngine(
      stack.db.client,
      stack.db.logger,
    );

    // Fake agent adapter — deterministic for tests.
    fakeAgent = new FakeAgentAdapter();
    const agentGateway = new DefaultAgentGateway(stack.db.client, stack.db.logger, [fakeAgent], 3);

    // Build the ImplementationContextBuilder.
    const builder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      contextRepo,
      undefined,
      undefined,
      undefined,
      async (workItemId: string) => {
        const reviews = await reviewService.listReviewsForWorkItem(workItemId);
        return Promise.all(
          reviews
            .filter((r) => r.status === 'completed' && r.outcome !== null)
            .map(async (r) => {
              const findings = await reviewService.listFindingsForReview(r.id);
              return {
                reviewId: r.id,
                verdict: r.outcome ?? '',
                summary: r.summary ?? '',
                findings: findings.map((f) => f.description),
                createdAt: r.createdAt.toISOString(),
              };
            }),
        );
      },
    );

    // PR #29 fix #1 + WORK-027 refactor: wire the StartImplementationService
    // through the ExecutionService boundary (NativeExecutionProvider wraps
    // the real AgentGateway — the single native execution path).
    const executionPromptBuilder = new DefaultExecutionPromptBuilder();
    const executionTaskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder: builder,
      contextRepository: contextRepo,
      promptBuilder: executionPromptBuilder,
      logger: stack.db.logger,
    });
    const nativeExecutionProvider = new NativeExecutionProvider({
      agentGateway,
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
    });
    const executionRecordRepository = new PgExecutionRecordRepository(stack.db.client);
    const executionService = new DefaultExecutionService({
      executionRecordRepository,
      providers: [nativeExecutionProvider],
      auditService: new DefaultAuditService(stack.db.client, stack.db.logger),
      logger: stack.db.logger,
    
      executionAdmission: { admit: async () => ({ admitted: true, reason: 'test-permit', policyVersion: null, blockingReasons: [] }) },
  });
    const startImplementationService = new DefaultStartImplementationService({
      executionTaskService,
      executionService,
      logger: stack.db.logger,
    });

    // PR #29 fix #1: wire the AgentProviderRegistryService so the route can
    // validate provider/model.
    const agentProviderConfigRepository = new PgAgentProviderConfigRepository(stack.db.client);
    const agentProviderRegistry = new DefaultAgentProviderRegistry(stack.secretStore);
    const agentProviderRegistryService = new DefaultAgentProviderRegistryService(
      agentProviderRegistry,
      agentProviderConfigRepository,
      stack.secretStore,
    );

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      workflow: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workflowEngine,
        implementationContextBuilder: builder,
        startImplementationService,
        agentProviderRegistryService,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
    delete process.env.AGENT_PROVIDER_NAME;
    delete process.env.AGENT_API_KEY;
    delete process.env.AGENT_DEFAULT_MODEL;
  });

  async function createWorkItemA(id: string) {
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: id,
      title: id,
      objective: `Objective for ${id}`,
      scope: `Scope for ${id}`,
    });
    // AgentRun requires a non-null work_order_id (FK integrity trigger).
    // Create a Work Order for every work item so start-implementation can
    // persist the AgentRun.
    await stack.workOrderRepository.create({
      workItemId: wi.id,
      projectId: projectA.id,
      architectureVersionId: versionA.id,
      scope: `Scope for ${id}`,
      outOfScope: 'Nothing',
      architectureConstraints: 'None',
      verificationRequirements: [],
    });
    return wi;
  }

  // --- Happy path ---

  it('POST /work-items/:id/start-implementation — happy path returns 201 with revision 1 + kind initial + agentRunId + executionId', async () => {
    const wi = await createWorkItemA('IMPL-001');
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });

    const baselineCalls = fakeAgent.getCallCount();
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/start-implementation`,
      headers: { 'x-api-key': 'raw-key-impl-a' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      implementationContextId: string;
      workItemId: string;
      revision: number;
      kind: 'initial' | 'correction';
      agentRunId: string;
      executionId: string;
    };
    expect(body.implementationContextId).toBeTruthy();
    expect(body.workItemId).toBe(wi.id);
    expect(body.revision).toBe(1);
    expect(body.kind).toBe('initial');
    // PR #29 fix #1: agentRunId + executionId MUST be present.
    expect(body.agentRunId).toBeTruthy();
    expect(body.executionId).toBeTruthy();
    // AgentGateway invoked exactly once.
    expect(fakeAgent.getCallCount()).toBe(baselineCalls + 1);
    // AgentRun persisted in the repository.
    const run = await agentRunRepo.findById(body.agentRunId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('success');
    expect(run!.executionId).toBe(body.executionId);
  });

  it('implementation context content contains objective, scope, resolved requirements + criteria + dependencies + instructions', async () => {
    const wi = await createWorkItemA('IMPL-002');
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);
    await stack.workOrderRepository.create({
      workItemId: wi.id,
      projectId: projectA.id,
      architectureVersionId: versionA.id,
      scope: 'Implement the auth flow',
      outOfScope: 'No frontend UI changes',
      architectureConstraints: 'Reuse the existing SecretStore',
      verificationRequirements: ['integration test', { description: 'E2E login test' }],
    });
    const wiPrev = await stack.workItemRepository.create({
      architectureVersionId: versionA.id, workItemId: 'IMPL-DEP-PREV', title: 'Prev item',
    });
    await stack.workItemDependencyRepository.add(wi.id, wiPrev.id);
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });

    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/start-implementation`,
      headers: { 'x-api-key': 'raw-key-impl-a' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { implementationContextId: string };
    const ctx = await contextRepo.findById(body.implementationContextId);
    expect(ctx).not.toBeNull();
    const content = ctx!.content as ImplementationContextContent;
    expect(content.objective).toBe('Objective for IMPL-002');
    expect(content.scope).toBe('Implement the auth flow');
    expect(content.outOfScope).toBe('No frontend UI changes');
    expect(content.architectureConstraints).toBe('Reuse the existing SecretStore');
    expect(content.requirements.length).toBe(1);
    expect(content.requirements[0]!.requirementId).toBe(reqA.id);
    expect(content.requirements[0]!.title).toBe('Auth works');
    expect(content.requirements[0]!.criteria.length).toBe(1);
    expect(content.requirements[0]!.criteria[0]!.criterionId).toBe(criterionA1Id);
    expect(content.dependencies.length).toBe(1);
    expect(content.dependencies[0]!.workItemId).toBe(wiPrev.id);
    expect(content.dependencies[0]!.title).toBe('Prev item');
    expect(content.instructions.length).toBeGreaterThanOrEqual(7);
    expect(content.instructions).toContain('Run the repository test suite.');
    expect(content.instructions).toContain('Do not mark verification criteria as PASS.');
    expect(content.verificationRequirements).toContain('integration test');
    expect(content.expectedTests).toContain('integration-test');
  });

  // --- Correction cycle ---

  it('second build() after a REQUEST_CHANGES review produces revision=2 + kind=correction', async () => {
    const wi = await createWorkItemA('IMPL-003');
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });

    const first = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/start-implementation`,
      headers: { 'x-api-key': 'raw-key-impl-a' },
    });
    expect(first.statusCode).toBe(201);
    expect((first.json() as { revision: number; kind: string }).revision).toBe(1);
    expect((first.json() as { revision: number; kind: string }).kind).toBe('initial');

    const review = await reviewService.createReview({
      projectId: projectA.id,
      workItemId: wi.id,
      architectureVersionId: versionA.id,
      source: 'architect-llm',
      executionId: 'impl-review-001',
    });
    await reviewService.addFinding({
      projectId: projectA.id,
      reviewId: review.id,
      title: 'Bug in auth flow',
      description: 'Token expiry not handled',
    });
    await reviewService.finalizeReview(review.id, { outcome: 'REQUEST_CHANGES' });

    await workflowEngine.transition({ workItemId: wi.id, toState: 'assigned', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'pr_open', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'verifying', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'architect_review', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'changes_requested', actor: 'test' });

    const second = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/start-implementation`,
      headers: { 'x-api-key': 'raw-key-impl-a' },
    });
    expect(second.statusCode).toBe(201);
    const body = second.json() as {
      implementationContextId: string;
      workItemId: string;
      revision: number;
      kind: string;
      agentRunId: string;
    };
    expect(body.revision).toBe(2);
    expect(body.kind).toBe('correction');
    expect(body.agentRunId).toBeTruthy();

    const ctx = await contextRepo.findById(body.implementationContextId);
    expect(ctx).not.toBeNull();
    expect(ctx!.content.priorReviewFindings.length).toBe(1);
    expect(ctx!.content.priorReviewFindings[0]!.verdict).toBe('REQUEST_CHANGES');
    expect(ctx!.content.priorReviewFindings[0]!.findings).toContain('Token expiry not handled');
  });

  // --- Workflow state validation ---

  it('workflow-state validation: 400 when the work item is NOT in ready or changes_requested', async () => {
    const wi = await createWorkItemA('IMPL-004');
    await workflowEngine.getOrCreate(wi.id);
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/start-implementation`,
      headers: { 'x-api-key': 'raw-key-impl-a' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; currentState: string; expectedStates: string[] };
    expect(body.error).toBe('invalid-state');
    expect(body.expectedStates).toEqual(['ready', 'changes_requested']);
    expect(body.currentState).toBe('draft');
  });

  it('404 when the work item does not exist', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/work-items/00000000-0000-0000-0000-000000000000/start-implementation',
      headers: { 'x-api-key': 'raw-key-impl-a' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe('work-item-not-found');
  });

  it('tenant isolation: User A cannot start implementation for User B work item (403)', async () => {
    const wiB = await stack.workItemRepository.create({
      architectureVersionId: versionB.id, workItemId: 'IMPL-B-001', title: 'B',
    });
    await workflowEngine.transition({ workItemId: wiB.id, toState: 'ready', actor: 'test' });
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wiB.id}/start-implementation`,
      headers: { 'x-api-key': 'raw-key-impl-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- PR #29 fix #1 regression: AgentGateway rejects → 502 + no fake success ---

  it('regression (PR #29 fix #1): AgentGateway rejects → 502 agent-gateway-failed + no fake AgentRun + workflow state unchanged', async () => {
    const wi = await createWorkItemA('IMPL-FAIL-001');
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });

    // Capture the workflow state BEFORE the failed call.
    const stateBefore = await workflowEngine.getState(wi.id);
    expect(stateBefore!.currentState).toBe('ready');

    // Configure the fake agent to fail (non-retryable).
    fakeAgent.setFailure('non_retryable', 'agent-failure-for-regression-test', false, 5);

    const baselineCalls = fakeAgent.getCallCount();
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/start-implementation`,
      headers: { 'x-api-key': 'raw-key-impl-a' },
    });

    // The route returns 502 agent-gateway-failed — NOT a fake 201 success.
    expect(res.statusCode).toBe(502);
    const body = res.json() as {
      error: string;
      message: string;
      implementationContextId: string;
      detail: string;
    };
    expect(body.error).toBe('agent-gateway-failed');
    expect(body.message).toContain('agent-failure-for-regression-test');
    expect(body.implementationContextId).toBeTruthy();
    expect(body.detail).toContain('No fake AgentRun was recorded');

    // AgentGateway WAS invoked (proving the service tried to run the agent).
    expect(fakeAgent.getCallCount()).toBeGreaterThan(baselineCalls);

    // NO fake successful AgentRun was persisted for this work item.
    const runs = await agentRunRepo.findByWorkItem(wi.id);
    const recentRun = runs.length > 0 ? runs[runs.length - 1] : null;
    if (recentRun) {
      // If a run was persisted (from the create() call before execute), it
      // MUST NOT be in 'success' state.
      expect(recentRun.status).not.toBe('success');
    }

    // Workflow state is UNCHANGED — the failure did NOT mutate it.
    const stateAfter = await workflowEngine.getState(wi.id);
    expect(stateAfter!.currentState).toBe('ready');

    // Reset the fake agent for subsequent tests.
    fakeAgent.reset();
  });

  // --- PR #29 fix #4 regression: builder fails loudly on missing refs ---

  it('regression (PR #29 fix #4): builder throws when a work_item_requirements association references a missing requirement', async () => {
    // Create a work item. Associate it with a requirement that exists, then
    // delete the requirement (cascade removes the association), then
    // manually insert an association referencing a requirement id that
    // doesn't resolve. We can't use a random UUID because of the FK —
    // instead, we create a second requirement, associate it, then delete
    // ONLY the requirement row after temporarily disabling the FK check.
    // Simplest: create the association directly via SQL bypassing the repo,
    // referencing a requirement that belongs to a DIFFERENT architecture
    // version (so it exists in wfos_requirements but the builder's
    // requirementRepository.findById will still find it — not what we want).
    //
    // The actual scenario: the builder calls requirementRepository.findById
    // which returns null when the requirement doesn't exist. We simulate
    // this by creating a work item with NO requirement association, then
    // calling the builder directly (not via HTTP) — the builder produces
    // an empty requirements array, which is NOT a failure. So the real
    // fail-loudly scenario is when the association EXISTS but the requirement
    // was deleted.
    //
    // Since the FK prevents this, we test via a mock: construct a builder
    // with a requirementRepository that returns null for a specific id.
    const wi = await createWorkItemA('IMPL-FAIL-REQ-001');
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });

    // Build a context with a requirementRepository that returns null for
    // findById (simulating a missing requirement). We wrap the real repo.
    const realReqRepo = stack.requirementRepository;
    const nullRequirementRepo: RequirementRepository = {
      create: (i) => realReqRepo.create(i),
      findByArchitectureVersion: (id) => realReqRepo.findByArchitectureVersion(id),
      update: (id, i) => realReqRepo.update(id, i),
      findById: async () => null,
    };
    const failingBuilder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      nullRequirementRepo,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      contextRepo,
    );

    await expect(failingBuilder.build(wi.id)).rejects.toThrow(
      'implementation-context-requirement-missing',
    );
  });

  it('regression (PR #29 fix #4): builder throws when a work_item_dependencies association references a missing target', async () => {
    const wi = await createWorkItemA('IMPL-FAIL-DEP-001');
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });

    // Build a context with a workItemRepository that returns null for
    // findById when called with the dependency target's id (simulating a
    // missing dependency target). The builder first calls findById(workItemId)
    // to load the work item itself — so we need a repo that returns the work
    // item for the source id but null for the target id.
    const realWiRepo = stack.workItemRepository;
    const partialNullRepo: WorkItemRepository = {
      create: (i) => realWiRepo.create(i),
      findByArchitectureVersion: (id) => realWiRepo.findByArchitectureVersion(id),
      update: (id, i) => realWiRepo.update(id, i),
      findById: async (id: string) => {
        if (id === wi.id) return realWiRepo.findById(id);
        return null; // simulate missing target
      },
    };
    // Create a second work item to be the dependency target, then add the dep.
    const wiTarget = await stack.workItemRepository.create({
      architectureVersionId: versionA.id, workItemId: 'IMPL-FAIL-DEP-TARGET', title: 'Target',
    });
    await stack.workItemDependencyRepository.add(wi.id, wiTarget.id);

    const failingBuilder = new DefaultImplementationContextBuilder(
      partialNullRepo,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      contextRepo,
    );

    await expect(failingBuilder.build(wi.id)).rejects.toThrow(
      'implementation-context-dependency-missing',
    );
  });
});
