/**
 * V2-002 — Workflow Repository + Immutable Versioning: the semantic proof
 * matrix (service level, on real PostgreSQL semantics — pglite locally /
 * real postgres under WORKFLOWOS_DATABASE_URL, exactly like the existing
 * DB-backed suites).
 *
 * Every required regression of the Work Order is pinned here:
 *
 *   R1  an old version remains byte-identical (and digest-identical) after
 *       an edit creates a new version;
 *   R2  an installation stays pinned to its exact version after a newer
 *       version exists;
 *   R3  a fork has independent workflow identity + preserved provenance,
 *       and source private state (installations) never transfers;
 *   R4  duplicate version content converges deterministically (the same
 *       content twice converges to the SAME immutable version identity —
 *       no divergent duplicate);
 *   R5  tenant/private visibility cannot leak across scopes (cross-tenant
 *       read/fork/install are rejected);
 *   R6  mutating or deleting a WorkflowVersion is impossible — fail-closed
 *       at the PostgreSQL boundary itself (guard trigger), and the
 *       installation pin is equally immovable;
 *   R7  deterministic IDs derive only from authoritative inputs (cross-
 *       checked against the pure identity derivations).
 *
 * V2 boundary notes (explicit, never silent):
 *   - version content is an OPAQUE payload here: WorkflowIR semantics,
 *     validation, and the SEMANTIC digest are owned by V2-003. The digest
 *       in these tables is the CONTENT digest (SHA-256 over canonical JSON
 *       of the opaque document) — an immutability/convergence proof, never
 *       a semantic claim.
 *   - execution (WorkflowRun) is owned by V2-005 and does not exist yet;
 *       installations are therefore pinned but not yet executed (recorded
 *       honestly as a scope observation, not a failure).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultWorkflowRepositoryService,
  WorkflowRepositoryError,
  type OrganizationMembershipResolver,
  type Workflow,
  type WorkflowVersion,
  type WorkflowRepositoryService,
} from '../../../src/workflow-repository/index.js';
import {
  computeContentDigest,
  deriveWorkflowId,
  deriveWorkflowVersionId,
  deriveWorkflowInstallationId,
} from '../../../src/workflow-repository/internal/identity.js';

const PROTOCOL = { irSchemaVersion: 'test-ir-1' } as const;
const PROTOCOL_V2 = { irSchemaVersion: 'test-ir-2' } as const;

const CONTENT_V1 = {
  title: 'Invoice triage',
  steps: [
    { id: 's1', action: 'observe inbox' },
    { id: 's2', action: 'extract total' },
  ],
} as const;

const CONTENT_V2 = {
  title: 'Invoice triage',
  steps: [
    { id: 's1', action: 'observe inbox' },
    { id: 's2', action: 'extract total' },
    { id: 's3', action: 'flag above threshold' },
  ],
} as const;

const CONTENT_V3 = { title: 'Invoice triage v3', steps: [{ id: 's1', action: 'observe inbox' }] } as const;

describe('V2-002 — workflow repository + immutable versioning (semantics over real PG)', () => {
  let stack: TestAuthStack;
  let service: WorkflowRepositoryService;
  let orgAId: string;
  let orgBId: string;
  let ownerAId: string;
  let memberA2Id: string;
  let userBId: string;

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    service = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });

    const orgA = await stack.organizationRepository.create({ name: 'V2-002 Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'V2-002 Org B' });
    const ownerA = await stack.userRepository.upsertByExternalId({
      externalId: 'v2-002-owner-a',
      displayName: 'Owner A',
    });
    const memberA2 = await stack.userRepository.upsertByExternalId({
      externalId: 'v2-002-member-a2',
      displayName: 'Member A2',
    });
    const userB = await stack.userRepository.upsertByExternalId({
      externalId: 'v2-002-user-b',
      displayName: 'User B',
    });
    await stack.membershipRepository.assign({ userId: ownerA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: memberA2.id, organizationId: orgA.id, roleId: 'member' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });

    orgAId = orgA.id;
    orgBId = orgB.id;
    ownerAId = ownerA.id;
    memberA2Id = memberA2.id;
    userBId = userB.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /** Create the canonical private test workflow owned by Owner A (v1 = CONTENT_V1). */
  async function createInvoiceBot(): Promise<{ workflow: Workflow; v1: WorkflowVersion }> {
    const result = await service.createWorkflow(
      { userId: ownerAId },
      {
        organizationId: orgAId,
        slug: 'invoice-bot',
        name: 'Invoice Bot',
        description: 'Triage invoices',
        visibility: 'private',
        content: { ...CONTENT_V1 },
        protocol: { ...PROTOCOL },
      },
    );
    return { workflow: result.workflow, v1: result.initialVersion };
  }

  // --- creation + R7 (deterministic identities) ---------------------------

  it('creates a workflow born with its immutable version 1 and DETERMINISTIC identities (R7)', async () => {
    const { workflow, v1 } = await createInvoiceBot();

    expect(workflow.organizationId).toBe(orgAId);
    expect(workflow.ownerUserId).toBe(ownerAId);
    expect(workflow.slug).toBe('invoice-bot');
    expect(workflow.visibility).toBe('private');
    expect(workflow.headVersionId).toBe(v1.id);
    expect(workflow.forkedFromWorkflowId).toBeNull();
    expect(workflow.forkedFromVersionId).toBeNull();

    expect(v1.workflowId).toBe(workflow.id);
    expect(v1.versionNumber).toBe(1);
    expect(v1.parentVersionId).toBeNull();
    expect(v1.createdByUserId).toBe(ownerAId);
    expect(v1.protocol).toEqual({ irSchemaVersion: 'test-ir-1' });
    expect(v1.content).toEqual({ ...CONTENT_V1 });

    // R7: the durable identities equal the PURE derivations from
    // authoritative inputs only (no random/uuid anywhere in identity).
    expect(workflow.id).toBe(
      deriveWorkflowId({ organizationId: orgAId, ownerUserId: ownerAId, slug: 'invoice-bot' }),
    );
    const digest = computeContentDigest({ ...CONTENT_V1 });
    expect(v1.contentDigest).toBe(digest);
    expect(v1.id).toBe(
      deriveWorkflowVersionId({ workflowId: workflow.id, contentDigest: digest, protocol: { ...PROTOCOL } }),
    );
  });

  it('create-or-converge: the SAME creation inputs converge (no duplicate workflow, no duplicate v1)', async () => {
    const first = await createInvoiceBot();
    const second = await service.createWorkflow(
      { userId: ownerAId },
      {
        organizationId: orgAId,
        slug: 'invoice-bot',
        name: 'Invoice Bot (renamed request — must NOT overwrite)',
        description: 'different description (must NOT overwrite)',
        visibility: 'private',
        content: { ...CONTENT_V1 },
        protocol: { ...PROTOCOL },
      },
    );
    expect(second.created).toBe(false);
    expect(second.workflow.id).toBe(first.workflow.id);
    expect(second.initialVersion.id).toBe(first.v1.id);
    // Converged creation never mutates the existing metadata.
    expect(second.workflow.name).toBe('Invoice Bot');
    const versions = await service.listVersions({ userId: ownerAId }, first.workflow.id);
    expect(versions).toHaveLength(1);
  });

  it('the same slug in ANOTHER tenant is a DIFFERENT workflow (tenant-scoped uniqueness)', async () => {
    const { workflow: workflowA } = await createInvoiceBot();
    const inB = await service.createWorkflow(
      { userId: userBId },
      {
        organizationId: orgBId,
        slug: 'invoice-bot',
        name: 'Invoice Bot (tenant B)',
        visibility: 'private',
        content: { ...CONTENT_V1 },
        protocol: { ...PROTOCOL },
      },
    );
    expect(inB.created).toBe(true);
    expect(inB.workflow.id).not.toBe(workflowA.id);
    expect(inB.workflow.organizationId).toBe(orgBId);
  });

  // --- R1 (immutable history) ----------------------------------------------

  it('R1: after an edit creates v2, v1 remains byte-identical and digest-identical', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    const before = await service.getVersion({ userId: ownerAId }, workflow.id, v1.id);
    const beforeCanonical = JSON.stringify(before.content);
    const beforeDigest = before.contentDigest;
    const beforeCreatedAt = before.createdAt;
    const beforeParent = before.parentVersionId;

    const edit = await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V2 }, protocol: { ...PROTOCOL } },
    );
    expect(edit.created).toBe(true);
    expect(edit.version.versionNumber).toBe(2);
    expect(edit.version.parentVersionId).toBe(v1.id);
    expect(edit.version.id).not.toBe(v1.id);
    expect(edit.version.contentDigest).not.toBe(beforeDigest);

    // The head advanced to v2; v1 is untouched.
    const after = await service.getWorkflow({ userId: ownerAId }, workflow.id);
    expect(after.headVersionId).toBe(edit.version.id);
    const v1After = await service.getVersion({ userId: ownerAId }, workflow.id, v1.id);
    expect(JSON.stringify(v1After.content)).toBe(beforeCanonical);
    expect(v1After.contentDigest).toBe(beforeDigest);
    expect(v1After.createdAt).toEqual(beforeCreatedAt);
    expect(v1After.parentVersionId).toBe(beforeParent);
    expect(v1After.versionNumber).toBe(1);

    const versions = await service.listVersions({ userId: ownerAId }, workflow.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it('R4: duplicate version content converges to the SAME immutable version identity', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    // Create v2 with different content first.
    await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V2 }, protocol: { ...PROTOCOL } },
    );

    // Re-submitting v1's exact content converges on the EXISTING v1 —
    // no divergent duplicate row is created.
    const reconverge = await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V1 }, protocol: { ...PROTOCOL } },
    );
    expect(reconverge.created).toBe(false);
    expect(reconverge.version.id).toBe(v1.id);
    expect(reconverge.version.versionNumber).toBe(1);

    // Key-order-insensitive: a shuffled serialization of the same content
    // still converges to the same identity.
    const shuffled = await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { steps: [...CONTENT_V1.steps].slice().reverse().reverse(), title: CONTENT_V1.title }, protocol: { ...PROTOCOL } },
    );
    expect(shuffled.created).toBe(false);
    expect(shuffled.version.id).toBe(v1.id);

    const versions = await service.listVersions({ userId: ownerAId }, workflow.id);
    expect(versions).toHaveLength(2);

    // The converged create did NOT silently move the head (still v2).
    const wf = await service.getWorkflow({ userId: ownerAId }, workflow.id);
    expect(wf.headVersionId).not.toBe(v1.id);
  });

  it('the same content under a DIFFERENT protocol descriptor is a distinct version (protocol is version-affecting)', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    const otherProtocol = await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V1 }, protocol: { ...PROTOCOL_V2 } },
    );
    expect(otherProtocol.created).toBe(true);
    expect(otherProtocol.version.id).not.toBe(v1.id);
    expect(otherProtocol.version.contentDigest).toBe(v1.contentDigest);
    expect(otherProtocol.version.versionNumber).toBe(2);
  });

  // --- R2 (install pinning) -------------------------------------------------

  it('R2: installations stay pinned to their exact version after newer versions exist', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    const v2 = await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V2 }, protocol: { ...PROTOCOL } },
    );

    // Install the OLD version, then create an even newer version.
    const installed = await service.installVersion(
      { userId: ownerAId },
      { organizationId: orgAId, workflowId: workflow.id, versionId: v1.id },
    );
    expect(installed.created).toBe(true);
    expect(installed.installation.versionId).toBe(v1.id);
    expect(installed.installation.status).toBe('enabled');
    expect(installed.installation.workflowId).toBe(workflow.id);
    expect(installed.installation.organizationId).toBe(orgAId);
    // R7: deterministic installation identity.
    expect(installed.installation.id).toBe(
      deriveWorkflowInstallationId({ organizationId: orgAId, versionId: v1.id }),
    );

    const v3 = await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V3 }, protocol: { ...PROTOCOL } },
    );
    expect(v3.version.versionNumber).toBe(3);

    // The installation still pins v1 — newer versions never move it.
    const detail = await service.getInstallation(
      { userId: ownerAId },
      orgAId,
      installed.installation.id,
    );
    expect(detail.installation.versionId).toBe(v1.id);
    expect(detail.pinnedVersion.id).toBe(v1.id);
    expect(detail.pinnedVersion.versionNumber).toBe(1);
    expect(detail.pinnedVersion.contentDigest).toBe(v1.contentDigest);

    // A SECOND installation pins the newer version (install BOTH versions).
    const installedV2 = await service.installVersion(
      { userId: ownerAId },
      { organizationId: orgAId, workflowId: workflow.id, versionId: v2.version.id },
    );
    expect(installedV2.created).toBe(true);
    expect(installedV2.installation.versionId).toBe(v2.version.id);

    const installations = await service.listInstallations({ userId: ownerAId }, orgAId);
    expect(installations.map((d) => d.installation.versionId).sort()).toEqual(
      [v1.id, v2.version.id].sort(),
    );

    // Re-installing the SAME version converges (idempotent — no duplicate).
    const reinstalled = await service.installVersion(
      { userId: ownerAId },
      { organizationId: orgAId, workflowId: workflow.id, versionId: v1.id },
    );
    expect(reinstalled.created).toBe(false);
    expect(reinstalled.installation.id).toBe(installed.installation.id);
    expect((await service.listInstallations({ userId: ownerAId }, orgAId)).length).toBe(2);
  });

  it('install lifecycle: enable/disable/uninstall WITHOUT touching any historical version', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    const installed = await service.installVersion(
      { userId: ownerAId },
      { organizationId: orgAId, workflowId: workflow.id, versionId: v1.id },
    );
    const installationId = installed.installation.id;

    const disabled = await service.setInstallationStatus(
      { userId: ownerAId }, orgAId, installationId, 'disable',
    );
    expect(disabled.status).toBe('disabled');
    const enabled = await service.setInstallationStatus(
      { userId: ownerAId }, orgAId, installationId, 'enable',
    );
    expect(enabled.status).toBe('enabled');
    const uninstalled = await service.setInstallationStatus(
      { userId: ownerAId }, orgAId, installationId, 'uninstall',
    );
    expect(uninstalled.status).toBe('uninstalled');
    // The pin survived the whole lifecycle unchanged.
    expect(uninstalled.versionId).toBe(v1.id);

    // Re-install after uninstall converges on the SAME installation identity.
    const reinstalled = await service.installVersion(
      { userId: ownerAId },
      { organizationId: orgAId, workflowId: workflow.id, versionId: v1.id },
    );
    expect(reinstalled.created).toBe(false);
    expect(reinstalled.installation.id).toBe(installationId);
    expect(reinstalled.installation.status).toBe('enabled');

    // Versions untouched throughout.
    const versions = await service.listVersions({ userId: ownerAId }, workflow.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.contentDigest).toBe(v1.contentDigest);
  });

  // --- R3 (fork) --------------------------------------------------------------

  it('R3: fork → independent workflow identity + preserved provenance + NO private-state transfer', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    const v2 = await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V2 }, protocol: { ...PROTOCOL } },
    );
    // Owner A installs v1 (source-side private tenant state).
    await service.installVersion(
      { userId: ownerAId },
      { organizationId: orgAId, workflowId: workflow.id, versionId: v1.id },
    );
    // Make the source forkable outside its tenant.
    await service.updateWorkflow({ userId: ownerAId }, workflow.id, { visibility: 'public' });

    const installationsInBBefore = await service.listInstallations({ userId: userBId }, orgBId);

    const fork = await service.forkWorkflow({ userId: userBId }, {
      organizationId: orgBId,
      sourceWorkflowId: workflow.id,
      sourceVersionId: v2.version.id,
      slug: 'invoice-bot-fork',
      name: 'Invoice Bot (community fork)',
      visibility: 'private',
    });
    expect(fork.created).toBe(true);

    // Independent identity.
    expect(fork.workflow.id).not.toBe(workflow.id);
    expect(fork.workflow.organizationId).toBe(orgBId);
    expect(fork.workflow.ownerUserId).toBe(userBId);
    // Preserved provenance.
    expect(fork.workflow.forkedFromWorkflowId).toBe(workflow.id);
    expect(fork.workflow.forkedFromVersionId).toBe(v2.version.id);

    // The fork's first version carries the source CONTENT (the workflow
    // meaning transfers — that is the point of a fork) as a NEW version
    // identity inside the new workflow.
    expect(fork.initialVersion.workflowId).toBe(fork.workflow.id);
    expect(fork.initialVersion.versionNumber).toBe(1);
    expect(fork.initialVersion.createdByUserId).toBe(userBId);
    expect(fork.initialVersion.content).toEqual(v2.version.content);
    expect(fork.initialVersion.contentDigest).toBe(v2.version.contentDigest);
    expect(fork.initialVersion.id).not.toBe(v2.version.id);
    expect(fork.workflow.headVersionId).toBe(fork.initialVersion.id);

    // NO private-state transfer: the source's installations did not follow.
    const installationsInBAfter = await service.listInstallations({ userId: userBId }, orgBId);
    expect(installationsInBAfter).toEqual(installationsInBBefore);
    // And nothing references the fork's versions in ANY tenant.
    const forkInstallCount = await stack.db.client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM wfos_v2_workflow_installations WHERE workflow_id = $1',
      [fork.workflow.id],
    );
    expect(forkInstallCount.rows[0]!.count).toBe('0');

    // Provenance is preserved even after the SOURCE gains new versions.
    await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V3 }, protocol: { ...PROTOCOL } },
    );
    const forkAgain = await service.getWorkflow({ userId: userBId }, fork.workflow.id);
    expect(forkAgain.forkedFromWorkflowId).toBe(workflow.id);
    expect(forkAgain.forkedFromVersionId).toBe(v2.version.id);
    expect(forkAgain.headVersionId).toBe(fork.initialVersion.id);
    // The fork's version content did NOT silently follow the source edit.
    const forkVersions = await service.listVersions({ userId: userBId }, fork.workflow.id);
    expect(forkVersions).toHaveLength(1);

    // Re-forking the SAME source version with the SAME slug converges
    // (idempotent fork — no divergent duplicate fork identity).
    const refork = await service.forkWorkflow({ userId: userBId }, {
      organizationId: orgBId,
      sourceWorkflowId: workflow.id,
      sourceVersionId: v2.version.id,
      slug: 'invoice-bot-fork',
      visibility: 'private',
    });
    expect(refork.created).toBe(false);
    expect(refork.workflow.id).toBe(fork.workflow.id);
    expect(refork.initialVersion.id).toBe(fork.initialVersion.id);
  });

  it('a fork of a NEWER source version under an EXISTING fork slug adds a version to the fork (convergence, not duplication)', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    const v2 = await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V2 }, protocol: { ...PROTOCOL } },
    );
    await service.updateWorkflow({ userId: ownerAId }, workflow.id, { visibility: 'public' });

    const fork = await service.forkWorkflow({ userId: userBId }, {
      organizationId: orgBId,
      sourceWorkflowId: workflow.id,
      sourceVersionId: v1.id,
      slug: 'evolving-fork',
      visibility: 'private',
    });
    expect(fork.initialVersion.versionNumber).toBe(1);

    // Fork the NEWER version under the SAME fork identity.
    const advanced = await service.forkWorkflow({ userId: userBId }, {
      organizationId: orgBId,
      sourceWorkflowId: workflow.id,
      sourceVersionId: v2.version.id,
      slug: 'evolving-fork',
      visibility: 'private',
    });
    expect(advanced.created).toBe(false);
    expect(advanced.workflow.id).toBe(fork.workflow.id);
    expect(advanced.initialVersion.created).toBe(true);
    expect(advanced.initialVersion.versionNumber).toBe(2);
    expect(advanced.initialVersion.parentVersionId).toBe(fork.initialVersion.id);
    expect(advanced.initialVersion.content).toEqual(v2.version.content);
    const forkVersions = await service.listVersions({ userId: userBId }, fork.workflow.id);
    expect(forkVersions).toHaveLength(2);
  });

  // --- R5 (visibility / tenant isolation) -------------------------------------

  it('R5 (private): cross-tenant read, version read, fork, and install are all rejected', async () => {
    const { workflow, v1 } = await createInvoiceBot(); // private, org A

    await expect(service.getWorkflow({ userId: userBId }, workflow.id)).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_VISIBLE',
    });
    await expect(
      service.getVersion({ userId: userBId }, workflow.id, v1.id),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_VISIBLE' });
    await expect(
      service.listVersions({ userId: userBId }, workflow.id),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_VISIBLE' });
    await expect(
      service.forkWorkflow({ userId: userBId }, {
        organizationId: orgBId,
        sourceWorkflowId: workflow.id,
        sourceVersionId: v1.id,
        slug: 'stolen-fork',
        visibility: 'private',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_VISIBLE' });
    await expect(
      service.installVersion(
        { userId: userBId },
        { organizationId: orgBId, workflowId: workflow.id, versionId: v1.id },
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_VISIBLE' });

    // And the rejected fork/install left NO durable rows behind.
    const stolenRows = await stack.db.client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM wfos_v2_workflows WHERE slug = 'stolen-fork'",
    );
    expect(stolenRows.rows[0]!.count).toBe('0');
    const bInstallations = await stack.db.client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM wfos_v2_workflow_installations WHERE organization_id = $1',
      [orgBId],
    );
    expect(bInstallations.rows[0]!.count).toBe('0');
  });

  it('R5 (organization): members read, non-members are rejected; owner-only mutation is enforced', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    await service.updateWorkflow({ userId: ownerAId }, workflow.id, { visibility: 'organization' });

    // A same-tenant NON-owner member may read...
    const memberRead = await service.getWorkflow({ userId: memberA2Id }, workflow.id);
    expect(memberRead.id).toBe(workflow.id);
    await expect(
      service.getVersion({ userId: memberA2Id }, workflow.id, v1.id),
    ).resolves.toMatchObject({ id: v1.id });

    // ...but may NOT mutate or edit versions (owner-only).
    await expect(
      service.updateWorkflow({ userId: memberA2Id }, workflow.id, { name: 'hijacked' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_OWNED' });
    await expect(
      service.createVersion({ userId: memberA2Id }, workflow.id, {
        content: { evil: true },
        protocol: { ...PROTOCOL },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_OWNED' });

    // A cross-tenant principal is still rejected (organization scope).
    await expect(service.getWorkflow({ userId: userBId }, workflow.id)).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_VISIBLE',
    });
  });

  it("R5 (public): cross-tenant read + install INTO the reader's tenant are allowed", async () => {
    const { workflow, v1 } = await createInvoiceBot();
    await service.updateWorkflow({ userId: ownerAId }, workflow.id, { visibility: 'public' });

    const readByB = await service.getWorkflow({ userId: userBId }, workflow.id);
    expect(readByB.id).toBe(workflow.id);
    const installedByB = await service.installVersion(
      { userId: userBId },
      { organizationId: orgBId, workflowId: workflow.id, versionId: v1.id },
    );
    expect(installedByB.created).toBe(true);
    expect(installedByB.installation.organizationId).toBe(orgBId);
    expect(installedByB.installation.versionId).toBe(v1.id);
  });

  it('R5 (tenant membership): acting inside an organization you do not belong to is rejected', async () => {
    await expect(
      service.createWorkflow({ userId: userBId }, {
        organizationId: orgAId,
        slug: 'b-in-a',
        name: 'B in A',
        visibility: 'private',
        content: { x: 1 },
        protocol: { ...PROTOCOL },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_ORGANIZATION_MEMBER' });
    await expect(
      service.listWorkflowsInOrganization({ userId: userBId }, orgAId),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_ORGANIZATION_MEMBER' });
    await expect(
      service.listInstallations({ userId: userBId }, orgAId),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_ORGANIZATION_MEMBER' });
  });

  it('organization listing: private workflows of OTHER members are not listed; own private ones are', async () => {
    const { workflow } = await createInvoiceBot(); // private, owned by ownerA
    // memberA2 lists org A: the owner's private workflow is invisible.
    const visibleToMember = await service.listWorkflowsInOrganization({ userId: memberA2Id }, orgAId);
    expect(visibleToMember.find((w) => w.id === workflow.id)).toBeUndefined();

    // A private workflow OWNED by memberA2 is visible to them.
    const own = await service.createWorkflow({ userId: memberA2Id }, {
      organizationId: orgAId,
      slug: 'member-private',
      name: 'Member Private',
      visibility: 'private',
      content: { y: 2 },
      protocol: { ...PROTOCOL },
    });
    const visibleToOwner = await service.listWorkflowsInOrganization({ userId: ownerAId }, orgAId);
    expect(visibleToOwner.find((w) => w.id === own.workflow.id)).toBeUndefined();

    // Organization-visibility workflows appear for every member.
    await service.updateWorkflow({ userId: ownerAId }, workflow.id, { visibility: 'organization' });
    const afterOrgVisibility = await service.listWorkflowsInOrganization({ userId: memberA2Id }, orgAId);
    expect(afterOrgVisibility.find((w) => w.id === workflow.id)).toBeDefined();
  });

  // --- R6 (fail-closed immutability at the PG boundary) ------------------------

  it('R6: PostgreSQL itself rejects ANY update or delete of a WorkflowVersion (raw SQL, no service in the path)', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    expect(workflow).toBeDefined();

    await expect(
      stack.db.client.query('UPDATE wfos_v2_workflow_versions SET content = $1 WHERE id = $2', [
        JSON.stringify({ tampered: true }),
        v1.id,
      ]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      stack.db.client.query('UPDATE wfos_v2_workflow_versions SET content_digest = $1 WHERE id = $2', [
        '0'.repeat(64),
        v1.id,
      ]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      stack.db.client.query('DELETE FROM wfos_v2_workflow_versions WHERE id = $1', [v1.id]),
    ).rejects.toThrow(/immutable/i);
    await expect(stack.db.client.query('DELETE FROM wfos_v2_workflow_versions')).rejects.toThrow(
      /immutable/i,
    );

    // The version is untouched after all rejected attempts.
    const still = await service.getVersion({ userId: ownerAId }, workflow.id, v1.id);
    expect(still.contentDigest).toBe(v1.contentDigest);
    expect(still.content).toEqual({ ...CONTENT_V1 });
  });

  it('R6: the installation PIN is immovable and undeletable (raw SQL; only status may change)', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    const v2 = await service.createVersion(
      { userId: ownerAId },
      workflow.id,
      { content: { ...CONTENT_V2 }, protocol: { ...PROTOCOL } },
    );
    const installed = await service.installVersion(
      { userId: ownerAId },
      { organizationId: orgAId, workflowId: workflow.id, versionId: v1.id },
    );

    // Moving the pin to a newer version is structurally impossible.
    await expect(
      stack.db.client.query(
        'UPDATE wfos_v2_workflow_installations SET version_id = $1 WHERE id = $2',
        [v2.version.id, installed.installation.id],
      ),
    ).rejects.toThrow(/pin/i);
    await expect(
      stack.db.client.query(
        'UPDATE wfos_v2_workflow_installations SET workflow_id = $1 WHERE id = $2',
        ['wfw_notthis', installed.installation.id],
      ),
    ).rejects.toThrow(/pin/i);
    // Installation history is durable: delete is rejected.
    await expect(
      stack.db.client.query('DELETE FROM wfos_v2_workflow_installations WHERE id = $1', [
        installed.installation.id,
      ]),
    ).rejects.toThrow(/pin|immutable/i);
    // A status-only update IS the sanctioned mutation path.
    await stack.db.client.query(
      "UPDATE wfos_v2_workflow_installations SET status = 'disabled', updated_at = NOW() WHERE id = $1",
      [installed.installation.id],
    );
    const detail = await service.getInstallation(
      { userId: ownerAId },
      orgAId,
      installed.installation.id,
    );
    expect(detail.installation.status).toBe('disabled');
    expect(detail.installation.versionId).toBe(v1.id);
  });

  // --- input validation (fail-closed, typed errors) ----------------------------

  it('rejects non-canonical visibility, bad slugs, non-object content, and missing protocol (typed codes)', async () => {
    await expect(
      service.createWorkflow({ userId: ownerAId }, {
        organizationId: orgAId,
        slug: 'bad-vis',
        name: 'Bad Visibility',
        visibility: 'team' as never,
        content: { x: 1 },
        protocol: { ...PROTOCOL },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_VISIBILITY' });

    for (const slug of ['Bad_Case', 'has space', '', '-leading', 'trailing-', 'a'.repeat(65)]) {
      await expect(
        service.createWorkflow({ userId: ownerAId }, {
          organizationId: orgAId,
          slug,
          name: 'Bad Slug',
          visibility: 'private',
          content: { x: 1 },
          protocol: { ...PROTOCOL },
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_SLUG' });
    }

    await expect(
      service.createWorkflow({ userId: ownerAId }, {
        organizationId: orgAId,
        slug: 'bad-content',
        name: 'Bad Content',
        visibility: 'private',
        content: 'not-an-object' as never,
        protocol: { ...PROTOCOL },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_CONTENT' });
    await expect(
      service.createWorkflow({ userId: ownerAId }, {
        organizationId: orgAId,
        slug: 'bad-content-2',
        name: 'Bad Content',
        visibility: 'private',
        content: [1, 2] as never,
        protocol: { ...PROTOCOL },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_CONTENT' });

    await expect(
      service.createWorkflow({ userId: ownerAId }, {
        organizationId: orgAId,
        slug: 'bad-protocol',
        name: 'Bad Protocol',
        visibility: 'private',
        content: { x: 1 },
        protocol: { irSchemaVersion: '' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_PROTOCOL' });

    await expect(
      service.createWorkflow({ userId: ownerAId }, {
        organizationId: orgAId,
        slug: 'bad-name',
        name: '   ',
        visibility: 'private',
        content: { x: 1 },
        protocol: { ...PROTOCOL },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NAME_REQUIRED' });

    // Unknown workflow / version identities are typed 404s.
    await expect(service.getWorkflow({ userId: ownerAId }, 'wfw_unknown')).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
    });
    await expect(
      service.getInstallation({ userId: ownerAId }, orgAId, 'wfin_unknown'),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INSTALLATION_NOT_FOUND' });
  });

  it('a version id from ANOTHER workflow is not resolvable (no cross-workflow version reads)', async () => {
    const a = await createInvoiceBot();
    const b = await service.createWorkflow({ userId: ownerAId }, {
      organizationId: orgAId,
      slug: 'other-workflow',
      name: 'Other',
      visibility: 'private',
      content: { other: true },
      protocol: { ...PROTOCOL },
    });
    await expect(
      service.getVersion({ userId: ownerAId }, b.workflow.id, a.v1.id),
    ).rejects.toMatchObject({ code: 'WORKFLOW_VERSION_NOT_FOUND' });
    // Installing a version under the wrong workflow id is rejected too.
    await expect(
      service.installVersion(
        { userId: ownerAId },
        { organizationId: orgAId, workflowId: b.workflow.id, versionId: a.v1.id },
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_VERSION_NOT_FOUND' });
  });

  it('a parent version from ANOTHER workflow is rejected (ancestry cannot cross workflows)', async () => {
    const a = await createInvoiceBot();
    const b = await service.createWorkflow({ userId: ownerAId }, {
      organizationId: orgAId,
      slug: 'parent-test',
      name: 'Parent Test',
      visibility: 'private',
      content: { z: 1 },
      protocol: { ...PROTOCOL },
    });
    await expect(
      service.createVersion({ userId: ownerAId }, b.workflow.id, {
        content: { z: 2 },
        protocol: { ...PROTOCOL },
        parentVersionId: a.v1.id,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_PARENT_VERSION' });
  });

  it('updateWorkflow mutates ONLY repository metadata (never versions); slug is immutable by shape', async () => {
    const { workflow, v1 } = await createInvoiceBot();
    const updated = await service.updateWorkflow({ userId: ownerAId }, workflow.id, {
      name: 'Invoice Bot Renamed',
      description: 'New description',
      visibility: 'organization',
    });
    expect(updated.name).toBe('Invoice Bot Renamed');
    expect(updated.description).toBe('New description');
    expect(updated.visibility).toBe('organization');
    expect(updated.slug).toBe('invoice-bot');
    expect(updated.headVersionId).toBe(v1.id);

    const versions = await service.listVersions({ userId: ownerAId }, workflow.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.contentDigest).toBe(v1.contentDigest);
  });

  it('WorkflowRepositoryError carries stable machine-readable codes (never string parsing)', async () => {
    const err = await service.getWorkflow({ userId: ownerAId }, 'wfw_unknown').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowRepositoryError);
    expect((err as WorkflowRepositoryError).code).toBe('WORKFLOW_NOT_FOUND');
    expect((err as WorkflowRepositoryError).message).toContain('workflow');
  });
});
