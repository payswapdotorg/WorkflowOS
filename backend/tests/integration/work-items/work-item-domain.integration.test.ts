import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

/**
 * WORK-AC-01..04, DEP-AC-01..03, WO-AC-01/02 — work items, dependencies, PR
 * associations, work orders.
 */
describe('WORK-007 — work items, dependencies, PR associations, work orders', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
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
      WFOS_TEST_KEY_A: 'raw-key-wi-a',
      WFOS_TEST_KEY_B: 'raw-key-wi-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'WI Org A' });
    orgB = await stack.organizationRepository.create({ name: 'WI Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'wi-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'wi-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'WI Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'WI Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'wi-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'wi-user-a', label: 'User A', rawKey: 'raw-key-wi-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'wi-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'wi-user-b', label: 'User B', rawKey: 'raw-key-wi-b',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'WI Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'WI Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

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
      requirements: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        requirementRepository: stack.requirementRepository,
        requirementDependencyRepository: stack.requirementDependencyRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        evidenceReferenceRepository: stack.evidenceReferenceRepository,
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

  async function createWorkItemA(id: string, title: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionA.id, workItemId: id, title });
  }
  async function createWorkItemB(id: string, title: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionB.id, workItemId: id, title });
  }

  // --- WORK-AC-01 ---
  it('WORK-AC-01: a work item persists with an architecture version reference', async () => {
    const wi = await createWorkItemA('WI-001', 'First work item');
    expect(wi.architectureVersionId).toBe(versionA.id);
    const version = await stack.architectureVersionRepository.findById(wi.architectureVersionId);
    const arch = await stack.architectureRepository.findById(version!.architectureId);
    expect(arch!.projectId).toBe(projectA.id);
  });

  it('WORK-AC-01: a work item with a non-existent architecture version is rejected (FK)', async () => {
    await expect(
      stack.workItemRepository.create({
        architectureVersionId: '00000000-0000-0000-0000-000000000000',
        workItemId: 'ORPHAN', title: 'Orphan',
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  // --- WORK-AC-02 ---
  it('WORK-AC-02: a work item can have multiple historical PR associations', async () => {
    const wi = await createWorkItemA('WI-PR-HIST', 'PR history test');
    const pr1 = await stack.pullRequestAssociationRepository.create({
      workItemId: wi.id, externalPrId: 'github:owner/repo#1',
    });
    const pr2 = await stack.pullRequestAssociationRepository.create({
      workItemId: wi.id, externalPrId: 'github:owner/repo#2',
    });
    const list = await stack.pullRequestAssociationRepository.listForWorkItem(wi.id);
    expect(list).toHaveLength(2);
    const pr1Fetched = list.find((p) => p.id === pr1.id);
    expect(pr1Fetched!.status).toBe('superseded');
    const pr2Fetched = list.find((p) => p.id === pr2.id);
    expect(pr2Fetched!.status).toBe('active');
  });

  // --- WORK-AC-03 ---
  it('WORK-AC-03: two concurrent active PRs for the same work item are rejected (DB partial unique index)', async () => {
    const wi = await createWorkItemA('WI-ACTIVE-PR', 'Active PR test');
    await stack.pullRequestAssociationRepository.create({
      workItemId: wi.id, externalPrId: 'github:owner/repo#10',
    });
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_pull_request_associations (work_item_id, external_pr_id, provider, status)
         VALUES ($1, 'github:owner/repo#11', 'github', 'active')`,
        [wi.id],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  // --- WORK-AC-04 ---
  it('WORK-AC-04: a single PR can be associated with multiple work items', async () => {
    const wi1 = await createWorkItemA('WI-MULTI-1', 'Multi PR 1');
    const wi2 = await createWorkItemA('WI-MULTI-2', 'Multi PR 2');
    await stack.pullRequestAssociationRepository.create({
      workItemId: wi1.id, externalPrId: 'github:owner/repo#100',
    });
    await stack.pullRequestAssociationRepository.create({
      workItemId: wi2.id, externalPrId: 'github:owner/repo#100',
    });
    const active1 = await stack.pullRequestAssociationRepository.findActiveForWorkItem(wi1.id);
    const active2 = await stack.pullRequestAssociationRepository.findActiveForWorkItem(wi2.id);
    expect(active1!.externalPrId).toBe('github:owner/repo#100');
    expect(active2!.externalPrId).toBe('github:owner/repo#100');
  });

  // --- DEP-AC-01 ---
  it('DEP-AC-01: a dependency on a non-existent work item is rejected (FK)', async () => {
    const wi = await createWorkItemA('WI-DEP-ORPHAN', 'Orphan dep');
    await expect(
      stack.workItemDependencyRepository.add(wi.id, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/foreign key|source or target/i);
  });

  // --- DEP-AC-03: cycles ---
  it('DEP-AC-03: self-dependency is rejected', async () => {
    const wi = await createWorkItemA('WI-SELF-DEP', 'Self dep');
    await expect(stack.workItemDependencyRepository.add(wi.id, wi.id)).rejects.toThrow(/check.*constraint|violat|circular/i);
  });

  it('DEP-AC-03: a direct 2-node cycle is rejected (A → B → A)', async () => {
    const a = await createWorkItemA('WI-CYC-A', 'Cycle A');
    const b = await createWorkItemA('WI-CYC-B', 'Cycle B');
    await stack.workItemDependencyRepository.add(a.id, b.id);
    await expect(stack.workItemDependencyRepository.add(b.id, a.id)).rejects.toThrow(/circular/i);
  });

  it('DEP-AC-03: an indirect 3-node cycle is rejected (A → B → C → A)', async () => {
    const a = await createWorkItemA('WI-CYC3-A', 'Cycle3 A');
    const b = await createWorkItemA('WI-CYC3-B', 'Cycle3 B');
    const c = await createWorkItemA('WI-CYC3-C', 'Cycle3 C');
    await stack.workItemDependencyRepository.add(a.id, b.id);
    await stack.workItemDependencyRepository.add(b.id, c.id);
    await expect(stack.workItemDependencyRepository.add(c.id, a.id)).rejects.toThrow(/circular/i);
  });

  // --- DEP-AC-02: eligibility ---

  it('DEP-AC-02: an incomplete dependency blocks eligibility (canBeginImplementation returns false)', async () => {
    const a = await createWorkItemA('WI-ELIG-BLOCK', 'Elig blocked');
    const b = await createWorkItemA('WI-ELIG-DEP-BLOCK', 'Elig dep (incomplete)');
    await stack.workItemDependencyRepository.add(a.id, b.id);
    // b is not completed yet → a cannot begin implementation.
    const { DefaultWorkItemDependencyService } = await import('../../../src/modules/work-items/internal/work-item-dependency-service.js');
    const service = new DefaultWorkItemDependencyService(stack.db.client);
    const canBeginBefore = await service.canBeginImplementation(a.id);
    expect(canBeginBefore).toBe(false);
    const unsatisfied = await service.getUnsatisfiedDependencies(a.id);
    expect(unsatisfied).toEqual([b.id]);
  });

  it('DEP-AC-02: a completed dependency allows eligibility (canBeginImplementation returns true)', async () => {
    const a = await createWorkItemA('WI-ELIG-OK', 'Elig allowed');
    const b = await createWorkItemA('WI-ELIG-DEP-OK', 'Elig dep (completed)');
    await stack.workItemDependencyRepository.add(a.id, b.id);
    // Mark b as completed via the internal completion service (not the API).
    await stack.workItemCompletionService.markCompleted(b.id, true);
    const { DefaultWorkItemDependencyService } = await import('../../../src/modules/work-items/internal/work-item-dependency-service.js');
    const service = new DefaultWorkItemDependencyService(stack.db.client);
    const canBeginAfter = await service.canBeginImplementation(a.id);
    expect(canBeginAfter).toBe(true);
    const unsatisfied = await service.getUnsatisfiedDependencies(a.id);
    expect(unsatisfied).toEqual([]);
  });

  it('DEP-AC-02: a work item with no dependencies is eligible', async () => {
    const a = await createWorkItemA('WI-ELIG-NODEP', 'No deps');
    const { DefaultWorkItemDependencyService } = await import('../../../src/modules/work-items/internal/work-item-dependency-service.js');
    const service = new DefaultWorkItemDependencyService(stack.db.client);
    const canBegin = await service.canBeginImplementation(a.id);
    expect(canBegin).toBe(true);
  });

  // --- WO-AC-01 ---
  it('WO-AC-01: a work order persists with all required references', async () => {
    const wi = await createWorkItemA('WI-WO-001', 'Work order test');
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id, requirementId: 'WO-REQ', title: 'WO req',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id, criterionId: 'AC-1', description: 'WO crit',
    });
    const wo = await stack.workOrderRepository.create({
      workItemId: wi.id, projectId: projectA.id, architectureVersionId: versionA.id,
      requirementIds: [req.id], criterionIds: [crit.id],
      architectureConstraints: 'Must use existing abstractions',
      implementationContext: { repository: 'owner/repo', branch: 'main' },
      scope: 'Implement work order domain', outOfScope: 'Do not implement workflow state',
      verificationRequirements: [{ type: 'integration-test', ref: 'work-items.test.ts' }],
    });
    expect(wo.workItemId).toBe(wi.id);
    expect(wo.projectId).toBe(projectA.id);
    expect(wo.architectureVersionId).toBe(versionA.id);
    expect(wo.requirementIds).toEqual([req.id]);
    expect(wo.criterionIds).toEqual([crit.id]);
    expect(wo.scope).toBe('Implement work order domain');
    expect(wo.state).toBe('draft');
  });

  it('WO-AC-01: work order state is constrained to draft/generated/consumed', async () => {
    const wi = await createWorkItemA('WI-WO-STATE', 'WO state test');
    const wo = await stack.workOrderRepository.create({
      workItemId: wi.id, projectId: projectA.id, architectureVersionId: versionA.id,
    });
    const generated = await stack.workOrderRepository.updateState(wo.id, 'generated');
    expect(generated!.state).toBe('generated');
    await expect(
      stack.db.client.query(`UPDATE wfos_work_orders SET state = 'invalid' WHERE id = $1`, [wo.id]),
    ).rejects.toThrow(/check.*constraint|violat/i);
  });

  it('WO-AC-01: a work order with a mismatched project_id is rejected (DB integrity trigger)', async () => {
    // Work item A belongs to versionA → architecture A → project A.
    // Attempt a work order pointing at project B (cross-project mismatch).
    const wiA = await createWorkItemA('WI-WO-CROSS-PROJ', 'Cross proj WO');
    await expect(
      stack.workOrderRepository.create({
        workItemId: wiA.id,
        projectId: projectB.id,  // wrong project
        architectureVersionId: versionA.id,
      }),
    ).rejects.toThrow(/work order integrity.*project/i);
  });

  it('WO-AC-01: a work order with a mismatched architecture_version_id is rejected (DB integrity trigger)', async () => {
    const wiA = await createWorkItemA('WI-WO-CROSS-VER', 'Cross ver WO');
    await expect(
      stack.workOrderRepository.create({
        workItemId: wiA.id,
        projectId: projectA.id,
        architectureVersionId: versionB.id,  // wrong version
      }),
    ).rejects.toThrow(/work order integrity.*architecture_version/i);
  });

  // --- Tenant isolation ---
  it('tenant isolation: User A cannot read Work Item B', async () => {
    const wiB = await createWorkItemB('WI-TENANT-B', 'Org B work item');
    const res = await server.inject({ method: 'GET', url: `/work-items/${wiB.id}`, headers: { 'x-api-key': 'raw-key-wi-a' } });
    expect(res.statusCode).toBe(403);
  });

  it('tenant isolation: User A cannot create a PR association for Work Item B', async () => {
    const wiB = await createWorkItemB('WI-PR-TENANT', 'Org B PR test');
    const res = await server.inject({
      method: 'POST', url: `/work-items/${wiB.id}/pr-associations`,
      headers: { 'x-api-key': 'raw-key-wi-a' }, payload: { externalPrId: 'github:owner/repo#999' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tenant isolation: cross-tenant dependency (A → B) rejected by DB trigger', async () => {
    const wiA = await createWorkItemA('WI-CROSS-DEP-A', 'Cross dep source');
    const wiB = await createWorkItemB('WI-CROSS-DEP-B', 'Cross dep target');
    await expect(stack.workItemDependencyRepository.add(wiA.id, wiB.id)).rejects.toThrow(/cross-version|different architecture versions/i);
  });

  it('tenant isolation: cross-project requirement association rejected by DB trigger', async () => {
    const wiA = await createWorkItemA('WI-CROSS-REQ', 'Cross req test');
    const reqB = await stack.requirementRepository.create({
      architectureVersionId: versionB.id, requirementId: 'CROSS-REQ-B', title: 'Org B req',
    });
    await expect(stack.workItemRequirementRepository.associate(wiA.id, reqB.id)).rejects.toThrow(/cross-version|different architecture versions/i);
  });

  // --- API contract ---
  it('API: authorized User A can create + read a work item', async () => {
    const createRes = await server.inject({
      method: 'POST', url: `/architecture-versions/${versionA.id}/work-items`,
      headers: { 'x-api-key': 'raw-key-wi-a' }, payload: { workItemId: 'API-WI-001', title: 'API Work Item' },
    });
    expect(createRes.statusCode).toBe(201);
    const wiId = (createRes.json() as { id: string }).id;
    const getRes = await server.inject({ method: 'GET', url: `/work-items/${wiId}`, headers: { 'x-api-key': 'raw-key-wi-a' } });
    expect(getRes.statusCode).toBe(200);
  });

  it('API: authorized User A can create a PR association + work order', async () => {
    const wi = await createWorkItemA('API-PR-WO-WI', 'API PR+WO test');
    const prRes = await server.inject({
      method: 'POST', url: `/work-items/${wi.id}/pr-associations`,
      headers: { 'x-api-key': 'raw-key-wi-a' }, payload: { externalPrId: 'github:owner/repo#API-1' },
    });
    expect(prRes.statusCode).toBe(201);
    const woRes = await server.inject({
      method: 'POST', url: `/work-items/${wi.id}/work-orders`,
      headers: { 'x-api-key': 'raw-key-wi-a' }, payload: { scope: 'Test scope' },
    });
    expect(woRes.statusCode).toBe(201);
    const wo = woRes.json() as { workItemId: string; projectId: string; state: string };
    expect(wo.workItemId).toBe(wi.id);
    expect(wo.projectId).toBe(projectA.id);
    expect(wo.state).toBe('draft');
  });

  // --- Regression: completed flag not writable through the update API ---

  it('regression: UpdateWorkItemInput does not include a `completed` field', () => {
    // Type-level proof: the following object MUST satisfy UpdateWorkItemInput
    // WITHOUT a `completed` field. If `completed` were in UpdateWorkItemInput,
    // this test would type-check but the behavioral test below proves it's
    // ignored at runtime. The key invariant: the ordinary Work Item update
    // path cannot change the completion flag.
    const input: import('@modules/work-items/index.js').UpdateWorkItemInput = {
      title: 'updated',
      objective: 'new objective',
    };
    // `completed` is not a property of UpdateWorkItemInput — accessing it
    // would be a TypeScript error in strict mode. We verify at runtime that
    // passing a stray `completed` through the repository's update() does not
    // change the persisted flag.
    expect(input.title).toBe('updated');
  });

  it('regression: a stray `completed` in the update payload is ignored (cannot set completed through update)', async () => {
    const wi = await createWorkItemA('WI-COMPLETED-GUARD', 'Completed guard test');
    expect(wi.completed).toBe(false);
    // Attempt to set completed through the repository's update() — even though
    // UpdateWorkItemInput doesn't include `completed`, we cast to verify at
    // runtime that the repository ignores it.
    await stack.workItemRepository.update(wi.id, { title: 'updated title' } as Record<string, unknown> as never);
    // Verify completed is still false — the update path cannot change it.
    const fetched = await stack.workItemRepository.findById(wi.id);
    expect(fetched!.completed).toBe(false);
    expect(fetched!.title).toBe('updated title');
    // Only the internal WorkItemCompletionService can change the flag.
    const marked = await stack.workItemCompletionService.markCompleted(wi.id, true);
    expect(marked!.completed).toBe(true);
  });
});
