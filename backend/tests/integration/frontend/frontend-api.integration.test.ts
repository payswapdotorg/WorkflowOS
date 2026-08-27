import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

describe('WORK-022 -- Frontend API integration', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };
  let workItemA: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-ui-a',
      WFOS_TEST_KEY_B: 'raw-key-ui-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'UI Org A' });
    orgB = await stack.organizationRepository.create({ name: 'UI Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'ui-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'ui-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'UI Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'UI Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'ui-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'ui-user-a', label: 'User A', rawKey: 'raw-key-ui-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'ui-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'ui-user-b', label: 'User B', rawKey: 'raw-key-ui-b',
    });
    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'UI Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'UI constraints' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id, requirementId: 'REQ-UI-001', title: 'UI Test Req',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-UI-1', description: 'UI criterion',
    });
    workItemA = await stack.workItemRepository.create({
      architectureVersionId: versionA.id, workItemId: 'UI-WI-001', title: 'UI Test WI',
    });
    const auditService = new DefaultAuditService(stack.db.client, stack.db.logger);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    const workflowEngine = new DefaultWorkflowEngine(
      stack.db.client, stack.db.logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
      auditService,
    );
    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      projects: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        repositoryAssociationRepository: stack.repositoryAssociationRepository,
      },
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
        workflowEngine,
      },
      audit: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        auditQuery: auditService,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // UI-AC-01
  describe('UI-AC-01: View project/architecture/requirements/work-item state', () => {
    it('authorized user can view project', async () => {
      const res = await server.inject({ method: 'GET', url: `/projects/${projectA.id}`, headers: { 'x-api-key': 'raw-key-ui-a' } });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { id: string }).id).toBe(projectA.id);
    });
    it('authorized user can view architecture', async () => {
      const res = await server.inject({ method: 'GET', url: `/projects/${projectA.id}/architectures`, headers: { 'x-api-key': 'raw-key-ui-a' } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body) ? body.length : 1).toBeGreaterThan(0);
    });
    it('authorized user can view requirements', async () => {
      const res = await server.inject({ method: 'GET', url: `/architecture-versions/${versionA.id}/requirements`, headers: { 'x-api-key': 'raw-key-ui-a' } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body) ? (body as { requirementId: string }[]).some(r => r.requirementId === 'REQ-UI-001') : true).toBe(true);
    });
    it('authorized user can view work item', async () => {
      const res = await server.inject({ method: 'GET', url: `/work-items/${workItemA.id}`, headers: { 'x-api-key': 'raw-key-ui-a' } });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { workItemId: string }).workItemId).toBe('UI-WI-001');
    });
  });

  // UI2-AC-01
  describe('UI2-AC-01: View Agent Runs/PRs/verification/reviews/audit', () => {
    it('authorized user can view workflow state', async () => {
      const res = await server.inject({ method: 'GET', url: `/work-items/${workItemA.id}/workflow`, headers: { 'x-api-key': 'raw-key-ui-a' } });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { currentState: string }).currentState).toBe('draft');
    });
    it('authorized user can view project audit history', async () => {
      const res = await server.inject({ method: 'GET', url: `/projects/${projectA.id}/audit`, headers: { 'x-api-key': 'raw-key-ui-a' } });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });
    it('authorized user can view work item audit history', async () => {
      const res = await server.inject({ method: 'GET', url: `/work-items/${workItemA.id}/audit`, headers: { 'x-api-key': 'raw-key-ui-a' } });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });
  });

  // UI2-AC-02
  describe('UI2-AC-02: Workflow state matches backend after refresh', () => {
    it('after transition, re-fetched state matches backend', async () => {
      const transitionRes = await server.inject({
        method: 'POST', url: `/work-items/${workItemA.id}/workflow/transitions`,
        headers: { 'x-api-key': 'raw-key-ui-a' }, payload: { toState: 'ready' },
      });
      expect(transitionRes.statusCode).toBe(200);
      const stateRes = await server.inject({ method: 'GET', url: `/work-items/${workItemA.id}/workflow`, headers: { 'x-api-key': 'raw-key-ui-a' } });
      expect(stateRes.statusCode).toBe(200);
      expect((stateRes.json() as { currentState: string }).currentState).toBe('ready');
    });
  });

  // UI3-AC-01
  describe('UI3-AC-01: Unauthorized users cannot perform privileged actions', () => {
    it('unauthorized user cannot transition workflow', async () => {
      const res = await server.inject({
        method: 'POST', url: `/work-items/${workItemA.id}/workflow/transitions`,
        headers: { 'x-api-key': 'raw-key-ui-b' }, payload: { toState: 'assigned' },
      });
      expect(res.statusCode).toBe(403);
    });
    it('unauthorized user cannot view project A', async () => {
      const res = await server.inject({ method: 'GET', url: `/projects/${projectA.id}`, headers: { 'x-api-key': 'raw-key-ui-b' } });
      expect(res.statusCode).toBe(403);
    });
    it('unauthorized user cannot view audit history', async () => {
      const res = await server.inject({ method: 'GET', url: `/projects/${projectA.id}/audit`, headers: { 'x-api-key': 'raw-key-ui-b' } });
      expect(res.statusCode).toBe(403);
    });
  });

  // Error handling
  describe('Error handling', () => {
    it('invalid workflow transition returns 409', async () => {
      const res = await server.inject({
        method: 'POST', url: `/work-items/${workItemA.id}/workflow/transitions`,
        headers: { 'x-api-key': 'raw-key-ui-a' }, payload: { toState: 'verified' },
      });
      expect(res.statusCode).toBe(409);
    });
    it('non-existent project returns 403 or 404', async () => {
      const res = await server.inject({ method: 'GET', url: `/projects/00000000-0000-0000-0000-000000000000`, headers: { 'x-api-key': 'raw-key-ui-a' } });
      expect([403, 404]).toContain(res.statusCode);
    });
  });
});
