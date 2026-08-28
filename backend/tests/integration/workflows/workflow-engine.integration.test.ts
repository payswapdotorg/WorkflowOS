import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { WorkflowState, TransitionResult } from '@modules/workflows/index.js';

describe('WORK-009 — workflow state machine', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let engine: DefaultWorkflowEngine;
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
      WFOS_TEST_KEY_A: 'raw-key-wf-a',
      WFOS_TEST_KEY_B: 'raw-key-wf-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'WF Org A' });
    orgB = await stack.organizationRepository.create({ name: 'WF Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'wf-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'wf-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'WF Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'WF Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'wf-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'wf-user-a', label: 'User A', rawKey: 'raw-key-wf-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'wf-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'wf-user-b', label: 'User B', rawKey: 'raw-key-wf-b',
    });
    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'WF Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'WF Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    engine = new DefaultWorkflowEngine(stack.db.client, stack.db.logger, (wiId) => depService.canBeginImplementation(wiId));

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
        workflowEngine: engine,
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

  async function fullHappyPath(workItemId: string) {
    const states: WorkflowState[] = ['ready', 'assigned', 'implementing', 'pr_open', 'verifying', 'architect_review', 'approved', 'merged', 'verified'];
    for (const to of states) {
      const result = await engine.transition({ workItemId, toState: to, actor: 'test' });
      expect(result.success, `${result.reason}`).toBe(true);
    }
  }

  it('a new work item starts in DRAFT', async () => {
    const wi = await createWorkItemA('WF-001');
    const exec = await engine.getOrCreate(wi.id);
    expect(exec.currentState).toBe('draft');
  });

  it('DRAFT → READY succeeds', async () => {
    const wi = await createWorkItemA('WF-002');
    const result = await engine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });
    expect(result.success).toBe(true);
    expect(result.toState).toBe('ready');
  });

  it('full happy path: DRAFT → ... → VERIFIED', async () => {
    const wi = await createWorkItemA('WF-003');
    await fullHappyPath(wi.id);
    const exec = await engine.getState(wi.id);
    expect(exec!.currentState).toBe('verified');
  });

  it('DRAFT → IMPLEMENTING is rejected (illegal)', async () => {
    const wi = await createWorkItemA('WF-004');
    const result = await engine.transition({ workItemId: wi.id, toState: 'implementing' });
    expect(result.success).toBe(false);
    expect(result.reason).toContain('illegal');
  });

  it('VERIFIED has no outbound transitions (terminal)', async () => {
    const wi = await createWorkItemA('WF-006');
    await fullHappyPath(wi.id);
    const result = await engine.transition({ workItemId: wi.id, toState: 'ready' });
    expect(result.success).toBe(false);
  });

  it('ARCHITECT_REVIEW → CHANGES_REQUESTED → IMPLEMENTING (correction cycle)', async () => {
    const wi = await createWorkItemA('WF-007');
    for (const s of ['ready', 'assigned', 'implementing', 'pr_open', 'verifying', 'architect_review'] as WorkflowState[]) {
      await engine.transition({ workItemId: wi.id, toState: s, actor: 'test' });
    }
    const changesRequested = await engine.transition({ workItemId: wi.id, toState: 'changes_requested', actor: 'architect' });
    expect(changesRequested.success).toBe(true);
    const backToImpl = await engine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'system' });
    expect(backToImpl.success).toBe(true);
  });

  it('VERIFYING → VERIFICATION_FAILED → IMPLEMENTING (failure cycle)', async () => {
    const wi = await createWorkItemA('WF-008');
    for (const s of ['ready', 'assigned', 'implementing', 'pr_open', 'verifying'] as WorkflowState[]) {
      await engine.transition({ workItemId: wi.id, toState: s, actor: 'test' });
    }
    const failed = await engine.transition({ workItemId: wi.id, toState: 'verification_failed', actor: 'verification' });
    expect(failed.success).toBe(true);
    const backToImpl = await engine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'system' });
    expect(backToImpl.success).toBe(true);
  });

  it('ASSIGNED → IMPLEMENTATION_BLOCKED → IMPLEMENTING (blocking recovery)', async () => {
    const wi = await createWorkItemA('WF-009');
    await engine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });
    await engine.transition({ workItemId: wi.id, toState: 'assigned', actor: 'test' });
    const blocked = await engine.transition({ workItemId: wi.id, toState: 'implementation_blocked', actor: 'agent' });
    expect(blocked.success).toBe(true);
    const recovered = await engine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'system' });
    expect(recovered.success).toBe(true);
  });

  it('ARCHITECT_REVIEW → ARCHITECTURE_CHANGE_REQUIRED → ARCHITECTURE_CHANGE_REQUEST (terminal)', async () => {
    const wi = await createWorkItemA('WF-011');
    for (const s of ['ready', 'assigned', 'implementing', 'pr_open', 'verifying', 'architect_review'] as WorkflowState[]) {
      await engine.transition({ workItemId: wi.id, toState: s, actor: 'test' });
    }
    const acr = await engine.transition({ workItemId: wi.id, toState: 'architecture_change_required', actor: 'architect' });
    expect(acr.success).toBe(true);
    const terminal = await engine.transition({ workItemId: wi.id, toState: 'architecture_change_request', actor: 'architect' });
    expect(terminal.success).toBe(true);
    const anyAttempt = await engine.transition({ workItemId: wi.id, toState: 'implementing' });
    expect(anyAttempt.success).toBe(false);
  });

  it('dependency eligibility: incomplete dependency blocks IMPLEMENTING', async () => {
    const a = await createWorkItemA('WF-012-DEP-A');
    const b = await createWorkItemA('WF-012-DEP-B');
    await stack.workItemDependencyRepository.add(a.id, b.id);
    await engine.transition({ workItemId: a.id, toState: 'ready' });
    await engine.transition({ workItemId: a.id, toState: 'assigned' });
    const result = await engine.transition({ workItemId: a.id, toState: 'implementing' });
    expect(result.success).toBe(false);
    expect(result.reason).toBe('dependency-eligibility-failed');
  });

  it('dependency eligibility: completed dependency allows IMPLEMENTING', async () => {
    const a = await createWorkItemA('WF-013-DEP-A');
    const b = await createWorkItemA('WF-013-DEP-B');
    await stack.workItemDependencyRepository.add(a.id, b.id);
    await stack.workItemCompletionService.markCompleted(b.id, true);
    await engine.transition({ workItemId: a.id, toState: 'ready' });
    await engine.transition({ workItemId: a.id, toState: 'assigned' });
    const result = await engine.transition({ workItemId: a.id, toState: 'implementing' });
    expect(result.success).toBe(true);
  });

  it('concurrency: two simultaneous transitions — only one succeeds', async () => {
    const wi = await createWorkItemA('WF-014');
    await engine.transition({ workItemId: wi.id, toState: 'ready' });
    await engine.transition({ workItemId: wi.id, toState: 'assigned' });
    const [r1, r2] = await Promise.all([
      engine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'req-a' }),
      engine.transition({ workItemId: wi.id, toState: 'implementation_blocked', actor: 'req-b' }),
    ]);
    expect(r1.success !== r2.success).toBe(true);
  });

  it('idempotency: duplicate transition with same key is no-op', async () => {
    const wi = await createWorkItemA('WF-015');
    const key = 'idemp-key-001';
    const r1 = await engine.transition({ workItemId: wi.id, toState: 'ready', idempotencyKey: key, actor: 'test' });
    expect(r1.success).toBe(true);
    const r2 = await engine.transition({ workItemId: wi.id, toState: 'ready', idempotencyKey: key, actor: 'test' });
    expect(r2.success).toBe(true);
    expect(r2.reason).toBe('idempotent-noop');
    const history = await engine.getHistory(wi.id);
    expect(history.filter((t) => t.idempotencyKey === key)).toHaveLength(1);
  });

  it('idempotency: same key on a different work item is NOT a no-op (scoped per work item)', async () => {
    const wiA = await createWorkItemA('WF-015-A');
    const wiB = await createWorkItemA('WF-015-B');
    const key = 'shared-idemp-key';
    // Work Item A uses the key to transition DRAFT → READY.
    const rA = await engine.transition({ workItemId: wiA.id, toState: 'ready', idempotencyKey: key, actor: 'test' });
    expect(rA.success).toBe(true);
    expect(rA.toState).toBe('ready');
    // Work Item B uses the SAME key — it must NOT resolve to A's transition.
    const rB = await engine.transition({ workItemId: wiB.id, toState: 'ready', idempotencyKey: key, actor: 'test' });
    expect(rB.success).toBe(true);
    expect(rB.reason).not.toBe('idempotent-noop');
    expect(rB.toState).toBe('ready');
    // Both work items are in 'ready'.
    const execA = await engine.getState(wiA.id);
    const execB = await engine.getState(wiB.id);
    expect(execA!.currentState).toBe('ready');
    expect(execB!.currentState).toBe('ready');
    // Each has its own transition history record with the key.
    const histA = await engine.getHistory(wiA.id);
    const histB = await engine.getHistory(wiB.id);
    expect(histA.filter((t) => t.idempotencyKey === key)).toHaveLength(1);
    expect(histB.filter((t) => t.idempotencyKey === key)).toHaveLength(1);
    // The transition records are for different work items.
    expect(histA[0]!.workItemId).toBe(wiA.id);
    expect(histB[0]!.workItemId).toBe(wiB.id);
  });

  it('transition history is append-only and reconstructable', async () => {
    const wi = await createWorkItemA('WF-016');
    await fullHappyPath(wi.id);
    const history = await engine.getHistory(wi.id);
    expect(history).toHaveLength(9);
    expect(history[0]!.fromState).toBe('draft');
    expect(history[0]!.toState).toBe('ready');
    expect(history[8]!.toState).toBe('verified');
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.fromState).toBe(history[i - 1]!.toState);
    }
  });

  it('tenant isolation: User A cannot transition User B work item', async () => {
    const wiB = await createWorkItemB('WF-017-B');
    await engine.transition({ workItemId: wiB.id, toState: 'ready', actor: 'user-b' });
    const res = await server.inject({
      method: 'POST', url: `/work-items/${wiB.id}/workflow/transitions`,
      headers: { 'x-api-key': 'raw-key-wf-a' },
      payload: { toState: 'assigned' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tenant isolation: User A cannot read User B workflow state', async () => {
    const wiB = await createWorkItemB('WF-018-B');
    const res = await server.inject({
      method: 'GET', url: `/work-items/${wiB.id}/workflow`,
      headers: { 'x-api-key': 'raw-key-wf-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('API: authorized transition succeeds (200)', async () => {
    const wi = await createWorkItemA('WF-019');
    const res = await server.inject({
      method: 'POST', url: `/work-items/${wi.id}/workflow/transitions`,
      headers: { 'x-api-key': 'raw-key-wf-a' },
      payload: { toState: 'ready' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TransitionResult;
    expect(body.success).toBe(true);
    expect(body.toState).toBe('ready');
  });

  it('API: illegal transition rejected (409)', async () => {
    const wi = await createWorkItemA('WF-020');
    const res = await server.inject({
      method: 'POST', url: `/work-items/${wi.id}/workflow/transitions`,
      headers: { 'x-api-key': 'raw-key-wf-a' },
      payload: { toState: 'verified' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('API: workflow state + history readable', async () => {
    const wi = await createWorkItemA('WF-022');
    await engine.transition({ workItemId: wi.id, toState: 'ready' });
    const stateRes = await server.inject({
      method: 'GET', url: `/work-items/${wi.id}/workflow`,
      headers: { 'x-api-key': 'raw-key-wf-a' },
    });
    expect(stateRes.statusCode).toBe(200);
    expect((stateRes.json() as { currentState: string }).currentState).toBe('ready');
    const histRes = await server.inject({
      method: 'GET', url: `/work-items/${wi.id}/workflow/history`,
      headers: { 'x-api-key': 'raw-key-wf-a' },
    });
    expect(histRes.statusCode).toBe(200);
    expect((histRes.json() as { transitions: unknown[] }).transitions).toHaveLength(1);
  });
});
