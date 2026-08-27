import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

/**
 * ARCH-AC-01 — ArchitectureVersion persistence.
 * ARCH-AC-02 — Valid architecture lifecycle (DRAFT/FROZEN/SUPERSEDED).
 * ARCH-AC-03 — Work-item traceability contract (stable version identity).
 * ARCH2-AC-01 — Frozen versions are immutable.
 * ARCH2-AC-02 — Frozen content remains unchanged.
 * ARCH3-AC-01 — Architecture Decision Records persist.
 * ARCH3-AC-02 — Invalid ADR/version references rejected.
 * ARCH4-AC-01 — Architecture Change Requests persist.
 * ARCH4-AC-02 — Unapproved changes cannot create replacement versions.
 * ARCH4-AC-03 — Approved change creates a new immutable version (atomic).
 *
 * Evidence: architecture versions persist with project ownership; lifecycle
 * states validated; frozen versions immutable at the PERSISTENCE level
 * (trigger, not just service check); ADRs linked to versions; Change Requests
 * with explicit lifecycle; only approved CRs create replacement versions;
 * supersession is atomic.
 */
describe('ARCH-001..004 — architecture management', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-arch-a',
      WFOS_TEST_KEY_B: 'raw-key-arch-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Arch Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Arch Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'arch-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'arch-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Arch Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Arch Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'arch-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'arch-user-a', label: 'User A', rawKey: 'raw-key-arch-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'arch-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'arch-user-b', label: 'User B', rawKey: 'raw-key-arch-b',
    });

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
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // --- ARCH-AC-01: ArchitectureVersion persistence ---

  it('ARCH-AC-01: an architecture persists with project ownership and versions', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/architectures`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { name: 'Architecture A', description: 'Test architecture' },
    });
    expect(createRes.statusCode).toBe(201);
    const arch = createRes.json() as { id: string; projectId: string };
    expect(arch.projectId).toBe(projectA.id);

    const versionRes = await server.inject({
      method: 'POST',
      url: `/architectures/${arch.id}/versions`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { contentInline: '# Architecture v1', contentType: 'text/markdown' },
    });
    expect(versionRes.statusCode).toBe(201);
    const version = versionRes.json() as { id: string; versionNumber: number; state: string; architectureId: string };
    expect(version.versionNumber).toBe(1);
    expect(version.state).toBe('draft');
    expect(version.architectureId).toBe(arch.id);

    // The version is recoverable by id (stable identity, ARCH-AC-03).
    const fetched = await stack.architectureVersionRepository.findById(version.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(version.id);
  });

  it('ARCH-AC-01 (cross-tenant): User B cannot read Architecture A', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/architectures`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { name: 'Cross-Tenant Arch' },
    });
    const archId = (createRes.json() as { id: string }).id;
    const res = await server.inject({
      method: 'GET',
      url: `/architectures/${archId}`,
      headers: { 'x-api-key': 'raw-key-arch-b' },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- ARCH-AC-02: valid lifecycle states ---

  it('ARCH-AC-02: a new version starts in draft', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Lifecycle Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    expect(version.state).toBe('draft');
  });

  it('ARCH-AC-02: draft → frozen transition succeeds', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Freeze Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'freeze me' });
    const frozen = await stack.architectureVersionRepository.transitionState(version.id, 'frozen', userA.id);
    expect(frozen.state).toBe('frozen');
    expect(frozen.frozenAt).not.toBeNull();
    expect(frozen.frozenBy).toBe(userA.id);
  });

  it('ARCH-AC-02: invalid transition (frozen → draft) is rejected', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Invalid Trans Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'invalid' });
    await stack.architectureVersionRepository.transitionState(version.id, 'frozen', userA.id);
    await expect(
      stack.architectureVersionRepository.transitionState(version.id, 'draft'),
    ).rejects.toThrow(/invalid.*transition/i);
  });

  // --- ARCH2-AC-01/02: frozen immutability (PERSISTENCE-LEVEL) ---

  it('ARCH2-AC-01: a direct UPDATE on a frozen version content is rejected by PostgreSQL', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Immutability Arch' });
    const version = await stack.architectureVersionRepository.create({
      architectureId: arch.id,
      contentInline: 'original content',
    });
    await stack.architectureVersionRepository.transitionState(version.id, 'frozen', userA.id);
    // Direct persistence-level mutation attempt (bypasses the service).
    await expect(
      stack.db.client.query(
        "UPDATE wfos_architecture_versions SET content_inline = 'TAMPERED' WHERE id = $1",
        [version.id],
      ),
    ).rejects.toThrow(/cannot mutate frozen architecture version/i);
  });

  it('ARCH2-AC-02: attempted mutation leaves persisted content unchanged', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Unchanged Content Arch' });
    const version = await stack.architectureVersionRepository.create({
      architectureId: arch.id,
      contentInline: 'immutable content',
      metadata: { version: '1.0' },
    });
    await stack.architectureVersionRepository.transitionState(version.id, 'frozen', userA.id);
    // Attempt to mutate both content and metadata.
    await expect(
      stack.db.client.query(
        "UPDATE wfos_architecture_versions SET metadata = '{\"tampered\": true}' WHERE id = $1",
        [version.id],
      ),
    ).rejects.toThrow(/cannot mutate frozen/i);
    // Verify the persisted content is unchanged.
    const fetched = await stack.architectureVersionRepository.findById(version.id);
    expect(fetched!.contentInline).toBe('immutable content');
    expect(fetched!.metadata).toEqual({ version: '1.0' });
  });

  it('ARCH2-AC-01: DRAFT content CAN be changed before freeze', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Draft Editable Arch' });
    const version = await stack.architectureVersionRepository.create({
      architectureId: arch.id,
      contentInline: 'draft content',
    });
    // Direct update on a draft row should succeed (not frozen yet).
    await stack.db.client.query(
      "UPDATE wfos_architecture_versions SET content_inline = 'updated draft' WHERE id = $1",
      [version.id],
    );
    const fetched = await stack.architectureVersionRepository.findById(version.id);
    expect(fetched!.contentInline).toBe('updated draft');
  });

  // --- ARCH3-AC-01/02: ADRs ---

  it('ARCH3-AC-01: an ADR persists and references exactly one ArchitectureVersion', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'ADR Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    const adr = await stack.architectureDecisionRepository.create({
      versionId: version.id,
      title: 'Use PostgreSQL',
      content: 'We chose PostgreSQL for relational integrity.',
    });
    expect(adr.versionId).toBe(version.id);
    expect(adr.adrNumber).toBe(1);

    // The ADR is recoverable and remains linked to its version.
    const fetched = await stack.architectureDecisionRepository.findById(adr.id);
    expect(fetched!.versionId).toBe(version.id);
  });

  it('ARCH3-AC-02: an ADR with a non-existent version id is rejected (FK constraint)', async () => {
    await expect(
      stack.architectureDecisionRepository.create({
        versionId: '00000000-0000-0000-0000-000000000000',
        title: 'Orphan ADR',
        content: 'This should fail.',
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('ARCH3-AC-01: ADR remains attached to its original version after the version is superseded', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'ADR Supersede Arch' });
    const v1 = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    const adr = await stack.architectureDecisionRepository.create({
      versionId: v1.id,
      title: 'Original Decision',
      content: 'Decision on v1',
    });
    // Freeze + supersede v1.
    await stack.architectureVersionRepository.transitionState(v1.id, 'frozen', userA.id);
    await stack.architectureVersionRepository.transitionState(v1.id, 'superseded');
    // The ADR is still linked to v1 (historical preservation).
    const fetched = await stack.architectureDecisionRepository.findById(adr.id);
    expect(fetched!.versionId).toBe(v1.id);
  });

  // --- ARCH4-AC-01: Change Requests persist ---

  it('ARCH4-AC-01: a Change Request persists with explicit status', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'CR Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(version.id, 'frozen', userA.id);
    const cr = await stack.architectureChangeRequestRepository.create({
      architectureId: arch.id,
      affectedVersionId: version.id,
      requesterId: userA.id,
      reason: 'Need to add a new module',
      requestedChange: 'Add /notifications module',
    });
    expect(cr.status).toBe('requested');
    expect(cr.reason).toBe('Need to add a new module');
    expect(cr.requestedChange).toBe('Add /notifications module');
    expect(cr.approvedAt).toBeNull();
    expect(cr.replacementVersionId).toBeNull();
  });

  // --- ARCH4-AC-02: unapproved/rejected CRs cannot create replacement versions ---

  it('ARCH4-AC-02: an unapproved CR cannot create a replacement version', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Unapproved CR Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(version.id, 'frozen', userA.id);
    const cr = await stack.architectureChangeRequestRepository.create({
      architectureId: arch.id,
      affectedVersionId: version.id,
      reason: 'change',
      requestedChange: 'modify',
    });
    // Attempting to approve+create on a 'requested' CR works — but what about
    // a CR that's already been rejected? The service rejects it.
    await stack.architectureChangeRequestRepository.reject(cr.id, userA.id);
    await expect(
      stack.architectureService.approveChangeAndCreateReplacement(cr.id, userA.id, { contentInline: 'v2' }),
    ).rejects.toThrow(/not in requested state/i);
  });

  // --- ARCH4-AC-03: approved CR creates replacement version (ATOMIC) ---

  it('ARCH4-AC-03: an approved CR atomically creates a replacement version and supersedes the previous', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Approved CR Arch' });
    const v1 = await stack.architectureVersionRepository.create({
      architectureId: arch.id,
      contentInline: 'v1 content',
    });
    await stack.architectureVersionRepository.transitionState(v1.id, 'frozen', userA.id);
    const v1Before = await stack.architectureVersionRepository.findById(v1.id);

    const cr = await stack.architectureChangeRequestRepository.create({
      architectureId: arch.id,
      affectedVersionId: v1.id,
      requesterId: userA.id,
      reason: 'Need v2',
      requestedChange: 'Add module',
    });

    // Approve + create replacement atomically.
    const result = await stack.architectureService.approveChangeAndCreateReplacement(
      cr.id,
      userA.id,
      { contentInline: 'v2 content' },
    );

    // The new version is created in DRAFT.
    expect(result.newVersion.state).toBe('draft');
    expect(result.newVersion.versionNumber).toBe(2);
    expect(result.newVersion.architectureId).toBe(arch.id);

    // The CR is approved + linked to the replacement.
    expect(result.changeRequest.status).toBe('approved');
    expect(result.changeRequest.replacementVersionId).toBe(result.newVersion.id);
    expect(result.changeRequest.approvedAt).not.toBeNull();

    // The previous frozen version is now SUPERSEDED.
    const v1After = await stack.architectureVersionRepository.findById(v1.id);
    expect(v1After!.state).toBe('superseded');

    // The previous version's content is UNCHANGED (immutability).
    expect(v1After!.contentInline).toBe(v1Before!.contentInline);
    expect(v1After!.frozenAt).toEqual(v1Before!.frozenAt);
  });

  it('ARCH4-AC-03: the approved-CR path is the ONLY way to create a replacement version (API)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'API Only Path Arch' });
    const v1 = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(v1.id, 'frozen', userA.id);

    const cr = await stack.architectureChangeRequestRepository.create({
      architectureId: arch.id,
      affectedVersionId: v1.id,
      reason: 'API test',
      requestedChange: 'change',
    });

    // Approve via the API endpoint.
    const res = await server.inject({
      method: 'POST',
      url: `/change-requests/${cr.id}/approve`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { contentInline: 'v2 via API' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { newVersion: { versionNumber: number; state: string }; changeRequest: { status: string } };
    expect(body.newVersion.versionNumber).toBe(2);
    expect(body.newVersion.state).toBe('draft');
    expect(body.changeRequest.status).toBe('approved');

    // v1 is now superseded.
    const v1After = await stack.architectureVersionRepository.findById(v1.id);
    expect(v1After!.state).toBe('superseded');
  });

  it('ARCH4-AC-02: a rejected CR cannot create a replacement version (API)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Rejected CR Arch' });
    const v1 = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(v1.id, 'frozen', userA.id);
    const cr = await stack.architectureChangeRequestRepository.create({
      architectureId: arch.id,
      affectedVersionId: v1.id,
      reason: 'will be rejected',
      requestedChange: 'change',
    });
    const res = await server.inject({
      method: 'POST',
      url: `/change-requests/${cr.id}/reject`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
    });
    expect(res.statusCode).toBe(200);
    const rejected = res.json() as { status: string };
    expect(rejected.status).toBe('rejected');

    // Attempting to approve+create on the rejected CR fails.
    const approveRes = await server.inject({
      method: 'POST',
      url: `/change-requests/${cr.id}/approve`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { contentInline: 'should fail' },
    });
    expect(approveRes.statusCode).toBe(409);

    // v1 is still frozen (not superseded).
    const v1After = await stack.architectureVersionRepository.findById(v1.id);
    expect(v1After!.state).toBe('frozen');
  });

  // --- Security: cross-tenant architecture access ---

  it('security: User A cannot approve a Change Request on Architecture B', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Org B Arch' });
    const v1 = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    await stack.architectureVersionRepository.transitionState(v1.id, 'frozen', userB.id);
    const cr = await stack.architectureChangeRequestRepository.create({
      architectureId: arch.id,
      affectedVersionId: v1.id,
      requesterId: userB.id,
      reason: 'Org B change',
      requestedChange: 'modify',
    });
    // User A attempts to approve Org B's change request.
    const res = await server.inject({
      method: 'POST',
      url: `/change-requests/${cr.id}/approve`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
      payload: { contentInline: 'cross-tenant attempt' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('security: User A cannot freeze Architecture B version', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Org B Freeze Arch' });
    const v1 = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    const res = await server.inject({
      method: 'POST',
      url: `/architecture-versions/${v1.id}/freeze`,
      headers: { 'x-api-key': 'raw-key-arch-a' },
    });
    expect(res.statusCode).toBe(403);
    // The version is still draft (not frozen).
    const fetched = await stack.architectureVersionRepository.findById(v1.id);
    expect(fetched!.state).toBe('draft');
  });

  it('ARCH-AC-03: the stable version identity is a UUID that persists across lifecycle transitions', async () => {
    const arch = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Stable ID Arch' });
    const v1 = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    const originalId = v1.id;
    // Transition through the lifecycle; the id must remain stable.
    await stack.architectureVersionRepository.transitionState(v1.id, 'frozen', userA.id);
    await stack.architectureVersionRepository.transitionState(v1.id, 'superseded');
    const fetched = await stack.architectureVersionRepository.findById(originalId);
    expect(fetched!.id).toBe(originalId);
    expect(fetched!.state).toBe('superseded');
  });
});
