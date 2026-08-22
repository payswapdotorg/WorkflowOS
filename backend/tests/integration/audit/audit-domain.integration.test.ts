import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import { generateExecutionId } from '@platform/ids.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { AuditEvent } from '@modules/audit/index.js';

describe('WORK-020 — Audit and privileged-event trail', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let auditService: DefaultAuditService;
  let workflowEngine: DefaultWorkflowEngine;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-aud-a',
      WFOS_TEST_KEY_B: 'raw-key-aud-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Aud Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Aud Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'aud-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'aud-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Aud Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Aud Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'aud-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'aud-user-a', label: 'User A', rawKey: 'raw-key-aud-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'aud-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'aud-user-b', label: 'User B', rawKey: 'raw-key-aud-b',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Aud Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Aud constraints A' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

    auditService = new DefaultAuditService(stack.db.client, stack.db.logger);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    workflowEngine = new DefaultWorkflowEngine(
      stack.db.client, stack.db.logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
      auditService,
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
        auditQuery: auditService,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  describe('Audit persistence (AUDIT-AC-01)', () => {
    it('creates an audit event with stable ID + all required fields', async () => {
      const event = await auditService.write({
        organizationId: orgA.id,
        projectId: projectA.id,
        eventType: 'PROJECT_CREATED',
        actor: userA.id,
        source: 'api',
        resourceType: 'project',
        resourceId: projectA.id,
        executionId: generateExecutionId(),
        metadata: { name: 'Aud Project A' },
      });
      expect(event.id).toBeTruthy();
      expect(event.eventType).toBe('PROJECT_CREATED');
      expect(event.actor).toBe(userA.id);
      expect(event.source).toBe('api');
      expect(event.resourceType).toBe('project');
      expect(event.resourceId).toBe(projectA.id);
      expect(event.organizationId).toBe(orgA.id);
      expect(event.projectId).toBe(projectA.id);
      expect(event.createdAt).toBeTruthy();
    });
  });

  describe('Append-only protection (AUDIT-AC-02)', () => {
    it('UPDATE on audit event is rejected at the DB level', async () => {
      const event = await auditService.write({
        projectId: projectA.id, eventType: 'TEST_EVENT', actor: 'test',
        resourceType: 'test', resourceId: 'append-update-001',
      });
      await expect(
        stack.db.client.query('UPDATE wfos_audit_events SET event_type = $1 WHERE id = $2', ['TAMPERED', event.id]),
      ).rejects.toThrow();
    });

    it('DELETE on audit event is rejected at the DB level', async () => {
      const event = await auditService.write({
        projectId: projectA.id, eventType: 'TEST_EVENT', actor: 'test',
        resourceType: 'test', resourceId: 'append-delete-001',
      });
      await expect(
        stack.db.client.query('DELETE FROM wfos_audit_events WHERE id = $1', [event.id]),
      ).rejects.toThrow();
    });

    it('INSERT remains possible (append works)', async () => {
      const event = await auditService.write({
        projectId: projectA.id, eventType: 'TEST_EVENT', actor: 'test',
        resourceType: 'test', resourceId: 'append-insert-001',
      });
      expect(event.id).toBeTruthy();
    });
  });

  describe('Workflow audit (WF-AUDIT-AC-01)', () => {
    it('workflow transition emits an audit event', async () => {
      const wi = await stack.workItemRepository.create({
        architectureVersionId: versionA.id, workItemId: 'AUD-WF-001', title: 'Audit WF Test',
      });
      await workflowEngine.transition({
        workItemId: wi.id, toState: 'ready', actor: 'test-user',
        executionId: 'audit-wf-exec-001',
      });
      await new Promise((r) => setTimeout(r, 200));

      const events = await auditService.listForWorkItem(wi.id);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const wfEvent = events.find((e) => e.eventType === 'WORKFLOW_TRANSITION');
      expect(wfEvent).toBeDefined();
      expect(wfEvent!.workItemId).toBe(wi.id);
      expect(wfEvent!.beforeState).toEqual({ state: 'draft' });
      expect(wfEvent!.afterState).toEqual({ state: 'ready' });
      expect(wfEvent!.actor).toBe('test-user');
      expect(wfEvent!.executionId).toBe('audit-wf-exec-001');
    });

    it('idempotent transition does NOT create a duplicate audit event (WF-AUDIT-AC-02)', async () => {
      const wi = await stack.workItemRepository.create({
        architectureVersionId: versionA.id, workItemId: 'AUD-WF-002', title: 'Audit Idem Test',
      });
      await workflowEngine.transition({
        workItemId: wi.id, toState: 'ready', actor: 'test-user',
        executionId: 'audit-idem-001', idempotencyKey: 'audit-idem-key-001',
      });
      await workflowEngine.transition({
        workItemId: wi.id, toState: 'ready', actor: 'test-user',
        executionId: 'audit-idem-001', idempotencyKey: 'audit-idem-key-001',
      });
      await new Promise((r) => setTimeout(r, 200));

      const events = await auditService.listForWorkItem(wi.id);
      const wfEvents = events.filter((e) => e.eventType === 'WORKFLOW_TRANSITION');
      expect(wfEvents.length).toBe(1);
    });
  });

  describe('Secret safety', () => {
    it('raw secret values are stripped from metadata', async () => {
      await auditService.write({
        projectId: projectA.id, eventType: 'TEST_EVENT', actor: 'test',
        resourceType: 'test', resourceId: 'secret-test-001',
        metadata: {
          apiKey: 'ghp_raw_api_key_12345',
          password: 'super-secret-password',
          safeField: 'this is safe',
          nested: { token: 'bearer-token-abc', safeNested: 'ok' },
        },
      });
      const found = await auditService.listForResource('test', 'secret-test-001');
      expect(found.length).toBe(1);
      const meta = found[0]!.metadata as Record<string, unknown>;
      expect(meta.apiKey).toBe('[REDACTED]');
      expect(meta.password).toBe('[REDACTED]');
      expect(meta.safeField).toBe('this is safe');
      const nested = meta.nested as Record<string, unknown>;
      expect(nested.token).toBe('[REDACTED]');
      expect(nested.safeNested).toBe('ok');
    });
  });

  describe('Tenant isolation', () => {
    it('cross-tenant audit read denied (403)', async () => {
      await auditService.write({
        projectId: projectA.id, eventType: 'TEST_EVENT', actor: 'test',
        resourceType: 'test', resourceId: 'tenant-test-001',
      });
      const res = await server.inject({
        method: 'GET', url: `/projects/${projectA.id}/audit`,
        headers: { 'x-api-key': 'raw-key-aud-b' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant work item reference is rejected at the DB level', async () => {
      const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Arch B' });
      const versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'B' });
      const wiB = await stack.workItemRepository.create({ architectureVersionId: versionB.id, workItemId: 'AUD-TEN-B-001', title: 'B' });

      await expect(
        auditService.write({
          projectId: projectA.id, eventType: 'TEST_EVENT', actor: 'test',
          resourceType: 'work_item', resourceId: wiB.id, workItemId: wiB.id,
        }),
      ).rejects.toThrow();
    });
  });

  describe('Audit query', () => {
    it('returns events in chronological order (newest first)', async () => {
      for (let i = 0; i < 5; i++) {
        await auditService.write({
          projectId: projectA.id, eventType: 'TEST_ORDER', actor: 'test',
          resourceType: 'test', resourceId: `order-test-${i}`,
        });
        await new Promise((r) => setTimeout(r, 10));
      }
      const events = await auditService.listForProject(projectA.id, { eventTypes: ['TEST_ORDER'] });
      expect(events.length).toBeGreaterThanOrEqual(5);
      for (let i = 1; i < events.length; i++) {
        expect(events[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(events[i]!.createdAt.getTime());
      }
    });

    it('API: authorized audit read succeeds (200)', async () => {
      await auditService.write({
        projectId: projectA.id, eventType: 'API_TEST', actor: 'test',
        resourceType: 'test', resourceId: 'api-test-001',
      });
      const res = await server.inject({
        method: 'GET', url: `/projects/${projectA.id}/audit`,
        headers: { 'x-api-key': 'raw-key-aud-a' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AuditEvent[];
      expect(body.length).toBeGreaterThan(0);
    });
  });
});
