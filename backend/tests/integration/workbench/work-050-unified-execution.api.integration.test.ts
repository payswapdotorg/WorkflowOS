/**
 * WORK-050 — route-level API tests for the two READ-ONLY unified-execution
 * endpoints + the work-item project resolution.
 *
 * The work order's adversarial coverage at the HTTP boundary:
 *
 *   - GET /execution/:executionId/cross-mode-handoff — the WORK-042 handoff
 *     log READ: 401 unauthenticated; 404 unknown execution (BEFORE auth — no
 *     oracle); 403 cross-project (tenant isolation — authorization runs
 *     BEFORE any handoff data is queried); 200 {handoff: null} — the
 *     authority's GENUINE empty answer (never an error); 200 {handoff: …} —
 *     the log row's own values verbatim.
 *   - GET /projects/:projectId/work-items/:workItemId/delegation-plans — the
 *     WORK-046 plans list READ: 401; 403 cross-project; 404 unknown work
 *     item; 403 work-item-not-in-project (a stale URL identifier cannot
 *     bypass authorization); 200 {plans: []} — GENUINE empty; 200 with the
 *     plans + units (the delegation records' own values).
 *   - GET /work-items/:workItemId — now carries the work item's PROJECT
 *     (resolved server-side through the authoritative chain) so consumers can
 *     address the project-scoped read surfaces; 403 isolation holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { PgCrossModeHandoffRepository } from '../../../src/modules/agents/internal/pg-cross-mode-handoff-repository.js';
import type { CrossModeHandoffService } from '../../../src/modules/agents/index.js';
import { DefaultDelegationPlanService } from '../../../src/delegation/index.js';
import { DefaultAgentRoleCatalogService } from '../../../src/agent-roles/index.js';

const KEY_A = 'raw-key-w050-a';
const KEY_B = 'raw-key-w050-b';

describe('WORK-050 — unified execution read surfaces (cross-mode handoff + delegation plans + project resolution)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let projectAId: string;
  let projectBId: string;
  let orgBId: string;
  let wiAId: string;
  let executionAId = 'exec-w050-a-1';
  let handoffRepo: PgCrossModeHandoffRepository;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: KEY_A,
      WFOS_TEST_KEY_B: KEY_B,
    });

    // --- Project A (user A) ---------------------------------------------------
    const orgA = await stack.organizationRepository.create({ name: 'W050 Org A' });
    const userA = await stack.userRepository.upsertByExternalId({ externalId: 'w050-user-a', displayName: 'User A' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W050 Project A' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    projectAId = projectA.id;
    await stack.apiKeyProvisioner.provision({
      keyId: 'w050-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'w050-user-a', label: 'A', rawKey: KEY_A,
    });

    const archA = await stack.architectureRepository.create({ projectId: projectAId, name: 'W050 Arch A' });
    const versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: '# W050 A' });
    const wiA = await stack.workItemRepository.create({
      architectureVersionId: versionA.id, workItemId: 'W050-A-001',
      title: 'A unified item', objective: 'objective', scope: 'src/a.ts',
      metadata: { baseCommit: 'w050-a-baseline-000000000000000000000001' },
    });
    wiAId = wiA.id;

    // An execution (the /agents authority) — needs the work-order + context FKs.
    const workOrderA = await stack.workOrderRepository.create({
      workItemId: wiAId, projectId: projectAId, architectureVersionId: versionA.id,
      scope: 'src/a.ts', verificationRequirements: ['unit-test'],
    });
    const contextRepo = new PgImplementationContextRepository(stack.db.client);
    const ctxA = await contextRepo.create({
      workItemId: wiAId, revision: 1, kind: 'initial',
      content: { prompt: 'w050 context A' } as never,
    });
    const executionRepo = new PgExecutionRecordRepository(stack.db.client);
    await executionRepo.create({
      executionId: executionAId, projectId: projectAId, workItemId: wiAId,
      workOrderId: workOrderA.id, implementationContextId: ctxA.id,
      mode: 'native', provider: 'fake', model: 'fake-model',
      repositoryRef: 'pectoraux/W050-A', branch: 'feat/w050-a-1',
      prompt: 'SECRET-FREE-PROMPT', promptDigest: 'digest-a-1',
    });

    // --- Project B (user B — the isolation partner) ----------------------------
    const orgB = await stack.organizationRepository.create({ name: 'W050 Org B' });
    orgBId = orgB.id;
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'w050-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W050 Project B' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    projectBId = projectB.id;
    await stack.apiKeyProvisioner.provision({
      keyId: 'w050-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'w050-user-b', label: 'B', rawKey: KEY_B,
    });

    // --- The server: execution (with the cross-mode handoff read) + delegation --
    handoffRepo = new PgCrossModeHandoffRepository(stack.db.client);
    // The cross-mode handoff READ goes through the real repository; the
    // mutation surface (handoff/reconcile) is not under test here (its own
    // regression suites cover it) and fails closed if invoked.
    const crossModeHandoffService: CrossModeHandoffService = {
      getHandoffForExecution: (executionId: string) => handoffRepo.findByExecutionId(executionId),
      handoff: () => {
        throw new Error('the handoff mutation is not under test in the WORK-050 read suite');
      },
      reconcileCrossModeHandoffForExecution: async () => {
        throw new Error('the reconcile mutation is not under test in the WORK-050 read suite');
      },
    };
    const delegationPlanService = new DefaultDelegationPlanService({
      db: stack.db.client,
      workItemRepository: stack.workItemRepository,
      roleCatalog: new DefaultAgentRoleCatalogService(),
    });

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      execution: {
        authorizationService: stack.authorizationService,
        workItemRepository: stack.workItemRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        executionRecordRepository: executionRepo,
        executionHandoffService: {
          issue: async () => {
            throw new Error('not under test');
          },
          redeem: async () => {
            throw new Error('not under test');
          },
        } as never,
        executionCallbackService: {
          issue: async () => {
            throw new Error('not under test');
          },
        } as never,
        executionEventIngestionService: {
          ingest: async () => {
            throw new Error('not under test');
          },
        } as never,
        crossModeHandoffService,
      },
      delegation: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        workItemRepository: stack.workItemRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        delegationPlanService,
        delegationCoordinator: {
          drivePlan: async () => {
            throw new Error('not under test');
          },
          retryUnit: async () => {
            throw new Error('not under test');
          },
          interruptPlan: async () => {
            throw new Error('not under test');
          },
        } as never,
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
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // --- GET /execution/:executionId/cross-mode-handoff -------------------------

  it('401 unauthenticated (no API key)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/execution/${executionAId}/cross-mode-handoff`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 unknown execution (the record does not exist — no oracle)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/execution/exec-w050-does-not-exist/cross-mode-handoff',
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'execution-not-found' });
  });

  it('ADVERSARIAL #9 (tenant isolation): user B is 403 on user A\'s execution handoff read (authorization BEFORE any handoff data)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/execution/${executionAId}/cross-mode-handoff`,
      headers: { 'x-api-key': KEY_B },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(JSON.stringify(body)).not.toContain('native');
    expect(JSON.stringify(body)).not.toContain('external');
  });

  it('200 {handoff: null} — the authority\'s GENUINE empty answer (never an error, never fabricated)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/execution/${executionAId}/cross-mode-handoff`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ handoff: null });
  });

  it('200 {handoff: …} — the WORK-042 log row\'s own values, verbatim (after the handoff exists)', async () => {
    // Insert the append-only handoff log row through the REPOSITORY (the
    // mutation route is not under test — this is the read-side proof).
    const record = await (server as unknown as { [k: string]: unknown });
    void record;
    const created = await handoffRepo.createHandoff({
      executionRecordId: (
        await new PgExecutionRecordRepository(stack.db.client).findByExecutionId(executionAId)
      )!.id,
      fromMode: 'native',
      toMode: 'external',
      reason: 'native provider degraded',
      actor: 'w050-fixture',
      source: 'w050-test',
      previousStatus: 'running',
      resultingStatus: 'handoff_ready',
      previousAgentRunId: null,
      previousExternalSessionRef: null,
      previousPackageValue: null,
      authorized: true,
      policyDecision: 'allowed',
      idempotencyKey: 'w050-idem-1',
    });
    expect(created.fromMode).toBe('native');

    const res = await server.inject({
      method: 'GET',
      url: `/execution/${executionAId}/cross-mode-handoff`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.handoff).toMatchObject({
      executionId: executionAId,
      fromMode: 'native',
      toMode: 'external',
      reason: 'native provider degraded',
      resultingStatus: 'handoff_ready',
      authorized: true,
    });
    // The safe field set: NO package snapshot, NO secrets.
    expect(body.handoff.previousPackageValue).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('SECRET-FREE-PROMPT');
  });

  it('REFRESH CONSISTENCY: the handoff read reflects fresh backend state on re-query (never a cached verdict)', async () => {
    // The handoff row now exists — the SECOND read returns it (the read
    // always reflects the current authoritative state).
    const res = await server.inject({
      method: 'GET',
      url: `/execution/${executionAId}/cross-mode-handoff`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().handoff).not.toBeNull();
    expect(res.json().handoff.idempotencyKey).toBe('w050-idem-1');
  });

  // --- GET /projects/:projectId/work-items/:workItemId/delegation-plans -------

  it('401 unauthenticated (no API key)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectAId}/work-items/${wiAId}/delegation-plans`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('ADVERSARIAL #9 (tenant isolation): user B is 403 on user A\'s delegation plans read', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectAId}/work-items/${wiAId}/delegation-plans`,
      headers: { 'x-api-key': KEY_B },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 unknown work item', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectAId}/work-items/00000000-0000-0000-0000-000000000000/delegation-plans`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('work-item-not-found');
  });

  it('403 work-item-not-in-project: a stale URL identifier (the wrong project) cannot bypass authorization', async () => {
    // User A is granted access to project B as well — so the project-level
    // authorization PASSES and the WORK-ITEM-IN-PROJECT guard itself fires
    // (the discrimination: the work item belongs to project A, not B).
    const userA = await stack.userRepository.upsertByExternalId({ externalId: 'w050-user-a', displayName: 'User A' });
    // User A needs BOTH the org-B membership (AUTHZ step 2) and the
    // project-B access (step 4) so the project-level authorization PASSES
    // and the WORK-ITEM-IN-PROJECT guard itself fires.
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgBId, roleId: 'member' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectBId, roleId: 'owner' });
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectBId}/work-items/${wiAId}/delegation-plans`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('work-item-not-in-project');
  });

  it('200 {plans: []} — the authority\'s GENUINE empty answer (never an error)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectAId}/work-items/${wiAId}/delegation-plans`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plans: [] });
  });

  it('200 with the plans + units — the WORK-046 records\' own values, verbatim', async () => {
    // Create a plan through the EXISTING service (createPlan — the authority).
    const planService = new DefaultDelegationPlanService({
      db: stack.db.client,
      workItemRepository: stack.workItemRepository,
      roleCatalog: new DefaultAgentRoleCatalogService(),
    });
    // Resolve a real WORK-045 role from the catalog.
    const catalog = new DefaultAgentRoleCatalogService();
    const roles = catalog.listRoles();
    expect(roles.length).toBeGreaterThan(0);
    const roleId = roles[0]!.role.identity;

    const plan = await planService.createPlan({
      workItemId: wiAId,
      planKey: 'w050-default',
      units: [
        {
          unitKey: 'implement',
          role: roleId,
          mode: 'native',
          provider: 'fake',
          model: 'fake-model',
          dependsOn: [],
        },
      ],
    });
    expect(plan.units.length).toBe(1);

    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectAId}/work-items/${wiAId}/delegation-plans`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plans.length).toBe(1);
    expect(body.plans[0]).toMatchObject({
      workItemId: wiAId,
      planKey: 'w050-default',
      status: 'active',
    });
    expect(body.plans[0].units[0]).toMatchObject({
      unitKey: 'implement',
      role: { roleId },
      mode: 'native',
      provider: 'fake',
      model: 'fake-model',
      status: 'pending',
      attemptCount: 0,
    });
  });

  // --- GET /work-items/:workItemId — the project resolution -------------------

  it('the work-item GET carries the PROJECT (resolved server-side — the project-scoped reads are addressable)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${wiAId}`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projectId).toBe(projectAId);
    expect(body.id).toBe(wiAId);
  });

  it('the work-item GET stays project-isolated (user B is 403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${wiAId}`,
      headers: { 'x-api-key': KEY_B },
    });
    expect(res.statusCode).toBe(403);
  });
});
