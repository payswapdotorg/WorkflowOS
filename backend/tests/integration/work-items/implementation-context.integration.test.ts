import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { ImplementationContextContent } from '@modules/work-items/index.js';

/**
 * WORK-026 SUB-H — ImplementationContextBuilder + start-implementation route.
 *
 * Exercises the POST /work-items/:workItemId/start-implementation endpoint
 * (added by SUB-D) on top of the WORK-002 auth stack (pglite locally / real
 * pg in CI). Verifies:
 *   - happy path: 201 + persisted ImplementationContext revision 1 + kind 'initial'
 *   - content shape: objective, scope, resolved requirements + criteria, resolved
 *     dependencies, instructions
 *   - second build() after a REQUEST_CHANGES review produces revision=2 +
 *     kind='correction'
 *   - workflow-state validation: NOT in 'ready' or 'changes_requested' → 400
 *   - 404 when the work item doesn't exist
 *   - tenant isolation
 *
 * The GET endpoint for retrieving the latest implementation context is NOT
 * exposed via HTTP (the SUB-D task spec left the GET route optional). The
 * tests read the persisted context via the ImplementationContextRepository
 * directly (the same pattern architect-plan-apply-atomicity.regression.test.ts
 * uses to inspect internal state).
 */
describe('WORK-026 SUB-H — ImplementationContext + start-implementation', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let contextRepo: PgImplementationContextRepository;
  let workflowEngine: DefaultWorkflowEngine;
  let reviewService: DefaultReviewService;
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
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-impl-a',
      WFOS_TEST_KEY_B: 'raw-key-impl-b',
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

    // Requirement + criterion for project A — used to verify the builder
    // resolves requirements + criteria correctly.
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
    reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, stack.db.logger);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    workflowEngine = new DefaultWorkflowEngine(
      stack.db.client,
      stack.db.logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
    );

    // Build the ImplementationContextBuilder. The 4 optional resolvers
    // are wired minimally — only the reviewResolver is needed for the
    // correction-cycle test. The repository/PR/agentRun resolvers are
    // omitted (the builder falls back to safe defaults).
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
      // repositoryResolver — omitted (no github link in this test)
      undefined,
      // pullRequestResolver — omitted (no PR association)
      undefined,
      // agentRunResolver — omitted (no prior agent runs)
      undefined,
      // reviewResolver — wired so the 'correction' kind can be derived
      // when a REQUEST_CHANGES review exists.
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
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  async function createWorkItemA(id: string) {
    return stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: id,
      title: id,
      objective: `Objective for ${id}`,
      scope: `Scope for ${id}`,
    });
  }

  // --- Happy path ---

  it('POST /work-items/:id/start-implementation — happy path returns 201 with revision 1 + kind initial', async () => {
    const wi = await createWorkItemA('IMPL-001');
    // Associate requirement + criterion so the context can resolve them.
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);
    // Transition to 'ready' (the workflow-state validation requires 'ready'
    // or 'changes_requested').
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });

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
    };
    expect(body.implementationContextId).toBeTruthy();
    expect(body.workItemId).toBe(wi.id);
    expect(body.revision).toBe(1);
    expect(body.kind).toBe('initial');
  });

  it('implementation context content contains objective, scope, resolved requirements + criteria + dependencies + instructions', async () => {
    const wi = await createWorkItemA('IMPL-002');
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);

    // Create a Work Order to provide scope/outOfScope/verificationRequirements.
    await stack.workOrderRepository.create({
      workItemId: wi.id,
      projectId: projectA.id,
      architectureVersionId: versionA.id,
      scope: 'Implement the auth flow',
      outOfScope: 'No frontend UI changes',
      architectureConstraints: 'Reuse the existing SecretStore',
      verificationRequirements: ['integration test', { description: 'E2E login test' }],
    });

    // Add a dependency on IMPL-001 (created in the previous test).
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
    // Read back the persisted context via the repository directly.
    const ctx = await contextRepo.findById(body.implementationContextId);
    expect(ctx).not.toBeNull();
    const content = ctx!.content as ImplementationContextContent;

    // Core work-order data.
    expect(content.objective).toBe('Objective for IMPL-002');
    expect(content.scope).toBe('Implement the auth flow');
    expect(content.outOfScope).toBe('No frontend UI changes');
    expect(content.architectureConstraints).toBe('Reuse the existing SecretStore');

    // Resolved requirements + criteria.
    expect(content.requirements.length).toBe(1);
    expect(content.requirements[0]!.requirementId).toBe(reqA.id);
    expect(content.requirements[0]!.title).toBe('Auth works');
    expect(content.requirements[0]!.description).toBe('Valid auth resolves identity');
    expect(content.requirements[0]!.criteria.length).toBe(1);
    expect(content.requirements[0]!.criteria[0]!.criterionId).toBe(criterionA1Id);
    expect(content.requirements[0]!.criteria[0]!.description).toBe('Valid auth resolves identity');

    // Resolved dependencies.
    expect(content.dependencies.length).toBe(1);
    expect(content.dependencies[0]!.workItemId).toBe(wiPrev.id);
    expect(content.dependencies[0]!.title).toBe('Prev item');

    // Instructions (the constant default set).
    expect(content.instructions.length).toBeGreaterThanOrEqual(7);
    expect(content.instructions).toContain('Run the repository test suite.');
    expect(content.instructions).toContain('Do not mark verification criteria as PASS.');

    // Verification requirements stringified from the Work Order.
    expect(content.verificationRequirements).toContain('integration test');
    expect(content.verificationRequirements).toContain('E2E login test');

    // Expected tests derived from criteria's verificationExpectation.
    expect(content.expectedTests).toContain('integration-test');
  });

  // --- Correction cycle ---

  it('second build() after a REQUEST_CHANGES review produces revision=2 + kind=correction', async () => {
    const wi = await createWorkItemA('IMPL-003');
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });

    // First build → revision 1, kind 'initial'.
    const first = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/start-implementation`,
      headers: { 'x-api-key': 'raw-key-impl-a' },
    });
    expect(first.statusCode).toBe(201);
    expect((first.json() as { revision: number; kind: string }).revision).toBe(1);
    expect((first.json() as { revision: number; kind: string }).kind).toBe('initial');

    // Create a finalized REQUEST_CHANGES review on the work item.
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

    // Transition to changes_requested (the only other valid state).
    // REVIEW → CHANGES_REQUESTED. First transition the work item into
    // architect_review via the workflow engine.
    await workflowEngine.transition({ workItemId: wi.id, toState: 'assigned', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'pr_open', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'verifying', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'architect_review', actor: 'test' });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'changes_requested', actor: 'test' });

    // Second build → revision 2, kind 'correction'.
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
    };
    expect(body.revision).toBe(2);
    expect(body.kind).toBe('correction');

    // The persisted context should also surface the prior review findings.
    const ctx = await contextRepo.findById(body.implementationContextId);
    expect(ctx).not.toBeNull();
    expect(ctx!.content.priorReviewFindings.length).toBe(1);
    expect(ctx!.content.priorReviewFindings[0]!.verdict).toBe('REQUEST_CHANGES');
    expect(ctx!.content.priorReviewFindings[0]!.findings).toContain('Token expiry not handled');
  });

  // --- Workflow state validation ---

  it('workflow-state validation: 400 when the work item is NOT in ready or changes_requested', async () => {
    const wi = await createWorkItemA('IMPL-004');
    // Work item is in 'draft' state (default after workflowEngine.getOrCreate).
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

  // --- 404 if work item doesn't exist ---

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

  // --- Tenant isolation ---

  it('tenant isolation: User A cannot start implementation for User B work item (403)', async () => {
    // Create a work item in project B + transition it to 'ready'.
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
});
