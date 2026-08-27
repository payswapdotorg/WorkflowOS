import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

/**
 * REQ-AC-01 — Requirement IDs are unique (database constraint).
 * REQ-AC-02 — Requirement references exactly one ArchitectureVersion.
 * REQ-AC-03 — Requirement dependencies are valid.
 * AC-AC-01 — Criterion IDs are unique.
 * AC-AC-02 — Each Criterion belongs to exactly one Requirement.
 * AC-AC-03 — Criterion status is constrained (PENDING/PASS/FAIL/BLOCKED).
 * AC-AC-04 — Criteria can reference evidence records.
 *
 * Evidence: requirements persist with unique IDs (DB constraint); FK to
 * ArchitectureVersion enforced; dependencies reference existing requirements;
 * self-dependency rejected; criteria have unique IDs + status CHECK;
 * evidence references persist. Cross-tenant access denied.
 *
 * Traceability chain:
 *   Requirement → ArchitectureVersion → Architecture → Project → Organization
 */
describe('REQ/AC — requirements and acceptance criteria', () => {
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
      WFOS_TEST_KEY_A: 'raw-key-req-a',
      WFOS_TEST_KEY_B: 'raw-key-req-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Req Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Req Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'req-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'req-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Req Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Req Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'req-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'req-user-a', label: 'User A', rawKey: 'raw-key-req-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'req-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'req-user-b', label: 'User B', rawKey: 'raw-key-req-b',
    });

    // Create architectures + frozen versions for both orgs.
    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Arch B' });
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
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // --- REQ-AC-01: unique requirement IDs ---

  it('REQ-AC-01: a requirement persists with a unique ID per architecture version', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/architecture-versions/${versionA.id}/requirements`,
      headers: { 'x-api-key': 'raw-key-req-a' },
      payload: { requirementId: 'AUTH-001', title: 'OAuth Authentication' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; requirementId: string; architectureVersionId: string; status: string };
    expect(body.requirementId).toBe('AUTH-001');
    expect(body.architectureVersionId).toBe(versionA.id);
    expect(body.status).toBe('pending');
  });

  it('REQ-AC-01: a duplicate requirement ID within the same architecture version is rejected', async () => {
    await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'DUPLICATE-001',
      title: 'First',
    });
    await expect(
      stack.requirementRepository.create({
        architectureVersionId: versionA.id,
        requirementId: 'DUPLICATE-001',
        title: 'Second',
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('REQ-AC-01: the same requirement ID is allowed under a different architecture version', async () => {
    // AUTH-001 was created for versionA above; create it for versionB.
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionB.id,
      requirementId: 'SHARED-001',
      title: 'Shared requirement',
    });
    expect(req.requirementId).toBe('SHARED-001');
  });

  // --- REQ-AC-02: requirement references exactly one ArchitectureVersion ---

  it('REQ-AC-02: a requirement with a non-existent architecture version is rejected (FK)', async () => {
    await expect(
      stack.requirementRepository.create({
        architectureVersionId: '00000000-0000-0000-0000-000000000000',
        requirementId: 'ORPHAN-001',
        title: 'Orphan',
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('REQ-AC-02: the traceability chain resolves (requirement → version → architecture → project → org)', async () => {
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'TRACE-001',
      title: 'Traceability test',
    });
    // Walk the chain.
    const version = await stack.architectureVersionRepository.findById(req.architectureVersionId);
    expect(version).not.toBeNull();
    const arch = await stack.architectureRepository.findById(version!.architectureId);
    expect(arch).not.toBeNull();
    expect(arch!.projectId).toBe(projectA.id);
  });

  // --- REQ-AC-03: requirement dependencies ---

  it('REQ-AC-03: a requirement dependency persists and references existing requirements', async () => {
    const reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'DEP-A',
      title: 'Depends on B',
    });
    const reqB = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'DEP-B',
      title: 'Dependency target',
    });
    const dep = await stack.requirementDependencyRepository.add(reqA.id, reqB.id);
    expect(dep.requirementId).toBe(reqA.id);
    expect(dep.dependsOnId).toBe(reqB.id);

    // The dependency is queryable.
    const list = await stack.requirementDependencyRepository.listForRequirement(reqA.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.dependsOnId).toBe(reqB.id);
  });

  it('REQ-AC-03: self-dependency is rejected', async () => {
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'SELF-DEP',
      title: 'Self dependency test',
    });
    await expect(
      stack.requirementDependencyRepository.add(req.id, req.id),
    ).rejects.toThrow(/check.*constraint|violat/i);
  });

  it('REQ-AC-03: a dependency on a non-existent requirement is rejected (FK)', async () => {
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'ORPHAN-DEP',
      title: 'Orphan dependency',
    });
    await expect(
      stack.requirementDependencyRepository.add(req.id, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/foreign key|source or target requirement not found/i);
  });

  it('REQ-AC-03 (cross-tenant DB guard): a dependency across different architecture versions is rejected by PostgreSQL', async () => {
    // Source requirement in versionA (Org A), target in versionB (Org B).
    const reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'CROSS-DB-SOURCE',
      title: 'Cross-tenant source',
    });
    const reqB = await stack.requirementRepository.create({
      architectureVersionId: versionB.id,
      requirementId: 'CROSS-DB-TARGET',
      title: 'Cross-tenant target',
    });
    // The DB trigger rejects this at the persistence level — even a direct
    // repository call (bypassing the API) is rejected.
    await expect(
      stack.requirementDependencyRepository.add(reqA.id, reqB.id),
    ).rejects.toThrow(/cross-tenant|different architecture versions/i);
  });

  it('REQ-AC-03 (cross-tenant API guard): User A cannot create a dependency from Org A requirement to Org B requirement', async () => {
    // Source requirement in versionA (Org A), target in versionB (Org B).
    const reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'CROSS-API-SOURCE',
      title: 'Cross-tenant API source',
    });
    const reqB = await stack.requirementRepository.create({
      architectureVersionId: versionB.id,
      requirementId: 'CROSS-API-TARGET',
      title: 'Cross-tenant API target',
    });
    // User A attempts to create A → B dependency via the API.
    const res = await server.inject({
      method: 'POST',
      url: `/requirements/${reqA.id}/dependencies`,
      headers: { 'x-api-key': 'raw-key-req-a' },
      payload: { dependsOnId: reqB.id },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; reason: string };
    expect(body.error).toBe('forbidden');
    expect(body.reason).toBe('cross-tenant-dependency');
    // The dependency was NOT created.
    const list = await stack.requirementDependencyRepository.listForRequirement(reqA.id);
    expect(list.find((d) => d.dependsOnId === reqB.id)).toBeUndefined();
  });

  it('REQ-AC-03 (same-tenant): a dependency within the same architecture version succeeds', async () => {
    const reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'SAME-TENANT-SRC',
      title: 'Same tenant source',
    });
    const reqB = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'SAME-TENANT-TGT',
      title: 'Same tenant target',
    });
    const dep = await stack.requirementDependencyRepository.add(reqA.id, reqB.id);
    expect(dep.requirementId).toBe(reqA.id);
    expect(dep.dependsOnId).toBe(reqB.id);
  });

  // --- AC-AC-01/02/03: acceptance criteria ---

  it('AC-AC-01/02: a criterion persists with a unique ID belonging to exactly one requirement', async () => {
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'CRIT-001',
      title: 'Criterion test',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id,
      criterionId: 'AC-1',
      description: 'Valid auth resolves identity',
      verificationExpectation: 'integration test',
    });
    expect(crit.requirementId).toBe(req.id);
    expect(crit.criterionId).toBe('AC-1');
    expect(crit.status).toBe('pending');
  });

  it('AC-AC-01: a duplicate criterion ID within the same requirement is rejected', async () => {
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'DUP-CRIT',
      title: 'Dup crit',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: req.id,
      criterionId: 'AC-1',
      description: 'First',
    });
    await expect(
      stack.acceptanceCriterionRepository.create({
        requirementId: req.id,
        criterionId: 'AC-1',
        description: 'Second',
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('AC-AC-02: a criterion with a non-existent requirement is rejected (FK)', async () => {
    await expect(
      stack.acceptanceCriterionRepository.create({
        requirementId: '00000000-0000-0000-0000-000000000000',
        criterionId: 'AC-1',
        description: 'Orphan',
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('AC-AC-03: valid criterion statuses are accepted', async () => {
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'STATUS-001',
      title: 'Status test',
    });
    for (const status of ['pending', 'pass', 'fail', 'blocked']) {
      const crit = await stack.acceptanceCriterionRepository.create({
        requirementId: req.id,
        criterionId: `AC-${status}`,
        description: `Status ${status}`,
        status: status as never,
      });
      expect(crit.status).toBe(status);
    }
  });

  it('AC-AC-03: an invalid criterion status is rejected', async () => {
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'BAD-STATUS',
      title: 'Bad status',
    });
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_acceptance_criteria (requirement_id, criterion_id, description, status)
         VALUES ($1, 'AC-BAD', 'bad', 'invalid-status')`,
        [req.id],
      ),
    ).rejects.toThrow(/check.*constraint|violat/i);
  });

  // --- AC-AC-04: evidence references ---

  it('AC-AC-04: a criterion can reference evidence records (provider-independent)', async () => {
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'EVID-001',
      title: 'Evidence test',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id,
      criterionId: 'AC-1',
      description: 'Evidence reference',
    });
    const ref = await stack.evidenceReferenceRepository.add({
      criterionId: crit.id,
      evidenceType: 'ci',
      evidenceRef: 'check-run-12345',
      source: 'github-actions',
      metadata: { job: 'test' },
    });
    expect(ref.evidenceType).toBe('ci');
    expect(ref.evidenceRef).toBe('check-run-12345');
    expect(ref.source).toBe('github-actions');

    // The evidence reference is listable.
    const list = await stack.evidenceReferenceRepository.listForCriterion(crit.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.evidenceRef).toBe('check-run-12345');
  });

  it('AC-AC-04: an evidence reference with a non-existent criterion is rejected (FK)', async () => {
    await expect(
      stack.evidenceReferenceRepository.add({
        criterionId: '00000000-0000-0000-0000-000000000000',
        evidenceType: 'test',
        evidenceRef: 'ref',
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  // --- Tenant isolation ---

  it('tenant isolation: User A cannot read Requirement B (cross-tenant)', async () => {
    // Create a requirement under versionB (Org B).
    const reqB = await stack.requirementRepository.create({
      architectureVersionId: versionB.id,
      requirementId: 'TENANT-B',
      title: 'Org B requirement',
    });
    // User A attempts to read it.
    const res = await server.inject({
      method: 'GET',
      url: `/requirements/${reqB.id}`,
      headers: { 'x-api-key': 'raw-key-req-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tenant isolation: User A cannot create a requirement under Org B architecture version', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/architecture-versions/${versionB.id}/requirements`,
      headers: { 'x-api-key': 'raw-key-req-a' },
      payload: { requirementId: 'CROSS-TENANT', title: 'Cross tenant attempt' },
    });
    expect(res.statusCode).toBe(403);
    // The requirement was NOT created.
    const list = await stack.requirementRepository.findByArchitectureVersion(versionB.id);
    expect(list.find((r) => r.requirementId === 'CROSS-TENANT')).toBeUndefined();
  });

  it('tenant isolation: User A cannot mutate Requirement B', async () => {
    const reqB = await stack.requirementRepository.create({
      architectureVersionId: versionB.id,
      requirementId: 'MUTATE-B',
      title: 'Org B mutate test',
    });
    const res = await server.inject({
      method: 'PATCH',
      url: `/requirements/${reqB.id}`,
      headers: { 'x-api-key': 'raw-key-req-a' },
      payload: { title: 'Tampered' },
    });
    expect(res.statusCode).toBe(403);
    // The title was NOT changed.
    const fetched = await stack.requirementRepository.findById(reqB.id);
    expect(fetched!.title).toBe('Org B mutate test');
  });

  // --- API contract tests ---

  it('API: authorized User A can create + read requirements for Project A', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/architecture-versions/${versionA.id}/requirements`,
      headers: { 'x-api-key': 'raw-key-req-a' },
      payload: { requirementId: 'API-001', title: 'API Test', description: 'via API' },
    });
    expect(createRes.statusCode).toBe(201);
    const reqId = (createRes.json() as { id: string }).id;

    const getRes = await server.inject({
      method: 'GET',
      url: `/requirements/${reqId}`,
      headers: { 'x-api-key': 'raw-key-req-a' },
    });
    expect(getRes.statusCode).toBe(200);
    expect((getRes.json() as { requirementId: string }).requirementId).toBe('API-001');
  });

  it('API: authorized User A can create criteria + evidence references', async () => {
    const req = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'API-CRIT',
      title: 'API crit test',
    });
    const critRes = await server.inject({
      method: 'POST',
      url: `/requirements/${req.id}/criteria`,
      headers: { 'x-api-key': 'raw-key-req-a' },
      payload: { criterionId: 'AC-1', description: 'Test criterion' },
    });
    expect(critRes.statusCode).toBe(201);
    const critId = (critRes.json() as { id: string }).id;

    const evRes = await server.inject({
      method: 'POST',
      url: `/criteria/${critId}/evidence-references`,
      headers: { 'x-api-key': 'raw-key-req-a' },
      payload: { evidenceType: 'test', evidenceRef: 'vitest:auth-test', source: 'vitest' },
    });
    expect(evRes.statusCode).toBe(201);
  });
});
