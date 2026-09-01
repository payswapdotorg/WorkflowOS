/**
 * V2-002 — route-level API tests for the workflow repository HTTP surface.
 *
 * Real Fastify server (buildServer) + the real auth stack (API-key provider +
 * user resolution) + the real WorkflowRepositoryService over real PostgreSQL
 * semantics (pglite locally / real postgres under WORKFLOWOS_DATABASE_URL).
 *
 * Proves through the REAL route paths (app.inject):
 *   - the create → read → edit (new immutable version) → install/pin BOTH
 *     versions → fork lifecycle works end-to-end through HTTP;
 *   - R1/R2 invariants observable over HTTP: old version payload is
 *     byte-stable across an edit; an installation's pinned version id and
 *     digest are unchanged after newer versions exist;
 *   - R3: the fork response carries a NEW workflow identity + preserved
 *     provenance, and the fork pins none of the source's installs;
 *   - R5: cross-tenant private read/fork/install → 404 (no existence leak),
 *     non-owner mutation → 403, non-member org actions → 403, missing key →
 *     401, invalid input → 400;
 *   - R6 (API level): NO route can mutate or delete a WorkflowVersion —
 *     PUT/PATCH/DELETE on version paths do not exist (fail-closed 404).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
} from '../../../src/workflow-repository/index.js';
import type { FastifyInstance } from 'fastify';

const PROTOCOL = { irSchemaVersion: 'test-ir-1' } as const;

const CONTENT_V1 = {
  title: 'Weekly report',
  steps: [
    { id: 's1', action: 'gather metrics' },
    { id: 's2', action: 'draft summary' },
  ],
} as const;

const CONTENT_V2 = {
  title: 'Weekly report',
  steps: [
    { id: 's1', action: 'gather metrics' },
    { id: 's2', action: 'draft summary' },
    { id: 's3', action: 'email stakeholders' },
  ],
} as const;

const CONTENT_V3 = { title: 'Weekly report v3', steps: [{ id: 's1', action: 'gather metrics' }] } as const;

interface WorkflowPayload {
  id: string;
  organizationId: string;
  ownerUserId: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: 'private' | 'organization' | 'public';
  headVersionId: string | null;
  forkedFromWorkflowId: string | null;
  forkedFromVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
  protocol: { irSchemaVersion: string };
  parentVersionId: string | null;
  createdByUserId: string;
  createdAt: string;
}

interface InstallationDetailPayload {
  installation: {
    id: string;
    organizationId: string;
    workflowId: string;
    versionId: string;
    installedByUserId: string;
    status: string;
    installedAt: string;
    updatedAt: string;
  };
  pinnedVersion: {
    id: string;
    workflowId: string;
    versionNumber: number;
    contentDigest: string;
    protocol: { irSchemaVersion: string };
  };
}

describe('V2-002 — workflow repository API (real routes, real PG)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgAId: string;
  let orgBId: string;
  let rawKeyA: string;
  let rawKeyB: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-v2-002-a',
      WFOS_TEST_KEY_B: 'raw-key-v2-002-b',
      WFOS_TEST_KEY_MEMBER: 'raw-key-v2-002-member',
    });

    const orgA = await stack.organizationRepository.create({ name: 'V2-002 API Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'V2-002 API Org B' });
    const userA = await stack.userRepository.upsertByExternalId({
      externalId: 'v2-002-api-owner-a',
      displayName: 'API Owner A',
    });
    const userB = await stack.userRepository.upsertByExternalId({
      externalId: 'v2-002-api-user-b',
      displayName: 'API User B',
    });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-002-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'v2-002-api-owner-a', label: 'A', rawKey: 'raw-key-v2-002-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-002-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'v2-002-api-user-b', label: 'B', rawKey: 'raw-key-v2-002-b',
    });
    orgAId = orgA.id;
    orgBId = orgB.id;
    rawKeyA = 'raw-key-v2-002-a';
    rawKeyB = 'raw-key-v2-002-b';

    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    const service = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      workflowRepository: { workflowRepositoryService: service },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  const createWorkflow = async (overrides: Record<string, unknown> = {}) => {
    const res = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/workflows`,
      headers: { 'x-api-key': rawKeyA },
      payload: {
        slug: 'weekly-report',
        name: 'Weekly Report',
        description: 'Weekly reporting workflow',
        visibility: 'private',
        content: { ...CONTENT_V1 },
        protocol: { ...PROTOCOL },
        ...overrides,
      },
    });
    return res;
  };

  it('POST create → 201 with the workflow + its immutable version 1', async () => {
    const res = await createWorkflow();
    expect(res.statusCode).toBe(201);
    const body = res.json() as { workflow: WorkflowPayload; initialVersion: VersionPayload; created: boolean };
    expect(body.created).toBe(true);
    expect(body.workflow.slug).toBe('weekly-report');
    expect(body.workflow.visibility).toBe('private');
    expect(body.workflow.organizationId).toBe(orgAId);
    expect(body.workflow.headVersionId).toBe(body.initialVersion.id);
    expect(body.initialVersion.versionNumber).toBe(1);
    expect(body.initialVersion.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.initialVersion.protocol).toEqual({ irSchemaVersion: 'test-ir-1' });
    expect(body.initialVersion.content).toEqual({ ...CONTENT_V1 });
  });

  it('duplicate create converges (201 → 200 with created=false, identical identities)', async () => {
    const first = await createWorkflow();
    const firstBody = first.json() as { workflow: WorkflowPayload; initialVersion: VersionPayload };
    const second = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/workflows`,
      headers: { 'x-api-key': rawKeyA },
      payload: {
        slug: 'weekly-report',
        name: 'Weekly Report',
        visibility: 'private',
        content: { ...CONTENT_V1 },
        protocol: { ...PROTOCOL },
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { workflow: WorkflowPayload; initialVersion: VersionPayload; created: boolean };
    expect(secondBody.created).toBe(false);
    expect(secondBody.workflow.id).toBe(firstBody.workflow.id);
    expect(secondBody.initialVersion.id).toBe(firstBody.initialVersion.id);
  });

  it('the full product lifecycle: edit → install BOTH versions → fork → old install still pinned', async () => {
    const created = await createWorkflow();
    const { workflow, initialVersion: v1 } = created.json() as {
      workflow: WorkflowPayload;
      initialVersion: VersionPayload;
    };

    // --- read the workflow + v1 (byte-stable snapshots before the edit) ----
    const wfBefore = (await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflow.id}`,
      headers: { 'x-api-key': rawKeyA },
    })).json() as { workflow: WorkflowPayload };
    const v1Before = (await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflow.id}/versions/${v1.id}`,
      headers: { 'x-api-key': rawKeyA },
    })).json() as { version: VersionPayload };
    const v1BodyBefore = JSON.stringify(v1Before);

    // --- edit: a new immutable version ------------------------------------
    const editRes = await server.inject({
      method: 'POST',
      url: `/workflow-repository/workflows/${workflow.id}/versions`,
      headers: { 'x-api-key': rawKeyA },
      payload: { content: { ...CONTENT_V2 }, protocol: { ...PROTOCOL } },
    });
    expect(editRes.statusCode).toBe(201);
    const { version: v2 } = editRes.json() as { version: VersionPayload; created: boolean };
    expect(v2.versionNumber).toBe(2);
    expect(v2.parentVersionId).toBe(v1.id);

    // R1 over HTTP: v1's full payload is byte-identical after the edit.
    const v1After = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflow.id}/versions/${v1.id}`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(v1After.statusCode).toBe(200);
    expect(v1After.body).toBe(v1BodyBefore);
    const v1PayloadAfter = v1After.json() as { version: VersionPayload };
    expect(v1PayloadAfter.version.contentDigest).toBe(v1Before.version.contentDigest);

    // The head moved to v2.
    const wfAfter = (await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflow.id}`,
      headers: { 'x-api-key': rawKeyA },
    })).json() as { workflow: WorkflowPayload };
    expect(wfAfter.workflow.headVersionId).toBe(v2.id);
    expect(wfAfter.workflow.updatedAt >= wfBefore.workflow.updatedAt).toBe(true);

    // --- install BOTH versions (each installation pins ONE exact version) --
    const installV1 = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/installations`,
      headers: { 'x-api-key': rawKeyA },
      payload: { workflowId: workflow.id, versionId: v1.id },
    });
    expect(installV1.statusCode).toBe(201);
    const { installation: instV1 } = installV1.json() as { installation: InstallationDetailPayload['installation'] };
    expect(instV1.versionId).toBe(v1.id);
    expect(instV1.status).toBe('enabled');

    const installV2 = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/installations`,
      headers: { 'x-api-key': rawKeyA },
      payload: { workflowId: workflow.id, versionId: v2.id },
    });
    expect(installV2.statusCode).toBe(201);
    expect((installV2.json() as { installation: InstallationDetailPayload['installation'] }).installation.versionId).toBe(v2.id);

    // --- a NEWER version exists after the installs ------------------------
    const editRes2 = await server.inject({
      method: 'POST',
      url: `/workflow-repository/workflows/${workflow.id}/versions`,
      headers: { 'x-api-key': rawKeyA },
      payload: { content: { ...CONTENT_V3 }, protocol: { ...PROTOCOL } },
    });
    expect(editRes2.statusCode).toBe(201);

    // R2 over HTTP: the v1 installation STILL pins v1 (id + digest).
    const detail = await server.inject({
      method: 'GET',
      url: `/organizations/${orgAId}/workflow-repository/installations/${instV1.id}`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as InstallationDetailPayload;
    expect(detailBody.installation.versionId).toBe(v1.id);
    expect(detailBody.pinnedVersion.id).toBe(v1.id);
    expect(detailBody.pinnedVersion.versionNumber).toBe(1);
    expect(detailBody.pinnedVersion.contentDigest).toBe(v1Before.version.contentDigest);

    const list = await server.inject({
      method: 'GET',
      url: `/organizations/${orgAId}/workflow-repository/installations`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { installations: InstallationDetailPayload[] };
    expect(listBody.installations).toHaveLength(2);
    expect(
      listBody.installations.map((d) => d.installation.versionId).sort(),
    ).toEqual([v1.id, v2.id].sort());

    // --- publish + fork (cross-tenant, public source) ----------------------
    const patch = await server.inject({
      method: 'PATCH',
      url: `/workflow-repository/workflows/${workflow.id}`,
      headers: { 'x-api-key': rawKeyA },
      payload: { visibility: 'public' },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { workflow: WorkflowPayload }).workflow.visibility).toBe('public');

    const forkRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgBId}/workflow-repository/forks`,
      headers: { 'x-api-key': rawKeyB },
      payload: {
        sourceWorkflowId: workflow.id,
        sourceVersionId: v2.id,
        slug: 'weekly-report-fork',
        name: 'Weekly Report (B fork)',
        visibility: 'private',
      },
    });
    expect(forkRes.statusCode).toBe(201);
    const forkBody = forkRes.json() as { workflow: WorkflowPayload; initialVersion: VersionPayload; created: boolean };
    expect(forkBody.created).toBe(true);
    // R3: independent identity + preserved provenance.
    expect(forkBody.workflow.id).not.toBe(workflow.id);
    expect(forkBody.workflow.organizationId).toBe(orgBId);
    expect(forkBody.workflow.ownerUserId).not.toBe(wfAfter.workflow.ownerUserId);
    expect(forkBody.workflow.forkedFromWorkflowId).toBe(workflow.id);
    expect(forkBody.workflow.forkedFromVersionId).toBe(v2.id);
    // The fork's first version copies the source CONTENT as a NEW identity.
    expect(forkBody.initialVersion.content).toEqual(v2.content);
    expect(forkBody.initialVersion.contentDigest).toBe(v2.contentDigest);
    expect(forkBody.initialVersion.id).not.toBe(v2.id);
    expect(forkBody.initialVersion.versionNumber).toBe(1);

    // R2 once more, after the fork: the old installation is still pinned.
    const detailAfterFork = await server.inject({
      method: 'GET',
      url: `/organizations/${orgAId}/workflow-repository/installations/${instV1.id}`,
      headers: { 'x-api-key': rawKeyA },
    });
    const afterFork = detailAfterFork.json() as InstallationDetailPayload;
    expect(afterFork.installation.versionId).toBe(v1.id);
    expect(afterFork.pinnedVersion.contentDigest).toBe(v1Before.version.contentDigest);
  });

  it('installation lifecycle over HTTP: disable → enable → uninstall → re-install converges', async () => {
    const created = await createWorkflow({ slug: 'lifecycle-api' });
    const { workflow, initialVersion: v1 } = created.json() as {
      workflow: WorkflowPayload;
      initialVersion: VersionPayload;
    };
    const installRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/installations`,
      headers: { 'x-api-key': rawKeyA },
      payload: { workflowId: workflow.id, versionId: v1.id },
    });
    const { installation } = installRes.json() as { installation: InstallationDetailPayload['installation'] };
    const base = `/organizations/${orgAId}/workflow-repository/installations/${installation.id}`;

    const disabled = await server.inject({
      method: 'POST', url: `${base}/disable`, headers: { 'x-api-key': rawKeyA },
    });
    expect(disabled.statusCode).toBe(200);
    expect((disabled.json() as { installation: { status: string } }).installation.status).toBe('disabled');

    const enabled = await server.inject({
      method: 'POST', url: `${base}/enable`, headers: { 'x-api-key': rawKeyA },
    });
    expect((enabled.json() as { installation: { status: string } }).installation.status).toBe('enabled');

    const uninstalled = await server.inject({
      method: 'POST', url: `${base}/uninstall`, headers: { 'x-api-key': rawKeyA },
    });
    expect((uninstalled.json() as { installation: { status: string; versionId: string } }).installation).toMatchObject({
      status: 'uninstalled',
      versionId: v1.id,
    });

    const reinstalled = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/installations`,
      headers: { 'x-api-key': rawKeyA },
      payload: { workflowId: workflow.id, versionId: v1.id },
    });
    expect(reinstalled.statusCode).toBe(200);
    const reBody = reinstalled.json() as { installation: InstallationDetailPayload['installation']; created: boolean };
    expect(reBody.created).toBe(false);
    expect(reBody.installation.id).toBe(installation.id);
    expect(reBody.installation.status).toBe('enabled');
  });

  it('R6 (API): NO route mutates or deletes a WorkflowVersion — PUT/PATCH/DELETE are 404 (fail-closed)', async () => {
    const created = await createWorkflow({ slug: 'no-mutation-api' });
    const { workflow, initialVersion: v1 } = created.json() as {
      workflow: WorkflowPayload;
      initialVersion: VersionPayload;
    };
    const versionUrl = `/workflow-repository/workflows/${workflow.id}/versions/${v1.id}`;

    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await server.inject({
        method,
        url: versionUrl,
        headers: { 'x-api-key': rawKeyA, 'content-type': 'application/json' },
        payload: method === 'DELETE' ? undefined : { content: { tampered: true } },
      });
      expect(res.statusCode, `${method} on a version must not exist`).toBe(404);
    }

    // The version is untouched after the rejected attempts.
    const still = await server.inject({
      method: 'GET', url: versionUrl, headers: { 'x-api-key': rawKeyA },
    });
    const stillBody = still.json() as { version: VersionPayload };
    expect(stillBody.version.content).toEqual({ ...CONTENT_V1 });
    expect(stillBody.version.contentDigest).toBe(v1.contentDigest);
  });

  it('R5 (API): cross-tenant read/version/fork/install of a PRIVATE workflow → 404 (no existence leak)', async () => {
    const created = await createWorkflow({ slug: 'private-api' });
    const { workflow, initialVersion: v1 } = created.json() as {
      workflow: WorkflowPayload;
      initialVersion: VersionPayload;
    };

    const read = await server.inject({
      method: 'GET', url: `/workflow-repository/workflows/${workflow.id}`, headers: { 'x-api-key': rawKeyB },
    });
    expect(read.statusCode).toBe(404);
    expect((read.json() as { error: string }).error).toBe('workflow-not-found');

    const versionRead = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflow.id}/versions/${v1.id}`,
      headers: { 'x-api-key': rawKeyB },
    });
    expect(versionRead.statusCode).toBe(404);

    const fork = await server.inject({
      method: 'POST',
      url: `/organizations/${orgBId}/workflow-repository/forks`,
      headers: { 'x-api-key': rawKeyB },
      payload: { sourceWorkflowId: workflow.id, sourceVersionId: v1.id, slug: 'private-fork-attempt' },
    });
    expect(fork.statusCode).toBe(404);

    const install = await server.inject({
      method: 'POST',
      url: `/organizations/${orgBId}/workflow-repository/installations`,
      headers: { 'x-api-key': rawKeyB },
      payload: { workflowId: workflow.id, versionId: v1.id },
    });
    expect(install.statusCode).toBe(404);
  });

  it('R5 (API): a non-owner member of the SAME org cannot edit versions or metadata', async () => {
    // Create a member of org A (non-owner).
    const memberUser = await stack.userRepository.upsertByExternalId({
      externalId: 'v2-002-api-member-a',
      displayName: 'API Member A',
    });
    await stack.membershipRepository.assign({ userId: memberUser.id, organizationId: orgAId, roleId: 'member' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-002-key-member', secretRef: 'WFOS_TEST_KEY_MEMBER', externalId: 'v2-002-api-member-a', label: 'M', rawKey: 'raw-key-v2-002-member',
    });
    const rawKeyMember = 'raw-key-v2-002-member';

    // Organization visibility so the member CAN see it (then mutation is a
    // pure authority question, not a visibility one).
    const created = await createWorkflow({ slug: 'org-vis-api', visibility: 'organization' });
    const { workflow } = created.json() as { workflow: WorkflowPayload };

    const patch = await server.inject({
      method: 'PATCH',
      url: `/workflow-repository/workflows/${workflow.id}`,
      headers: { 'x-api-key': rawKeyMember },
      payload: { name: 'hijacked' },
    });
    expect(patch.statusCode).toBe(403);
    expect((patch.json() as { error: string }).error).toBe('workflow-not-owned');

    const edit = await server.inject({
      method: 'POST',
      url: `/workflow-repository/workflows/${workflow.id}/versions`,
      headers: { 'x-api-key': rawKeyMember },
      payload: { content: { evil: true }, protocol: { ...PROTOCOL } },
    });
    expect(edit.statusCode).toBe(403);

    // But the member CAN read it.
    const read = await server.inject({
      method: 'GET', url: `/workflow-repository/workflows/${workflow.id}`, headers: { 'x-api-key': rawKeyMember },
    });
    expect(read.statusCode).toBe(200);
  });

  it('R5 (API): acting in an organization you do not belong to → 403', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${orgAId}/workflow-repository/workflows`,
      headers: { 'x-api-key': rawKeyB },
    });
    expect(res.statusCode).toBe(403);
    const create = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/workflows`,
      headers: { 'x-api-key': rawKeyB },
      payload: { slug: 'b-in-a', name: 'B in A', visibility: 'private', content: {}, protocol: { ...PROTOCOL } },
    });
    expect(create.statusCode).toBe(403);
  });

  it('missing API key → 401 (backend-authorized surface)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${orgAId}/workflow-repository/workflows`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('invalid input → 400 with typed error identifiers', async () => {
    const badVisibility = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/workflows`,
      headers: { 'x-api-key': rawKeyA },
      payload: { slug: 'bad-vis-api', name: 'X', visibility: 'team', content: {}, protocol: { ...PROTOCOL } },
    });
    expect(badVisibility.statusCode).toBe(400);
    expect((badVisibility.json() as { error: string }).error).toBe('workflow-invalid-visibility');

    const badSlug = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/workflows`,
      headers: { 'x-api-key': rawKeyA },
      payload: { slug: 'Bad_Slug', name: 'X', visibility: 'private', content: {}, protocol: { ...PROTOCOL } },
    });
    expect(badSlug.statusCode).toBe(400);
    expect((badSlug.json() as { error: string }).error).toBe('workflow-invalid-slug');

    const badContent = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/workflows`,
      headers: { 'x-api-key': rawKeyA },
      payload: { slug: 'bad-content-api', name: 'X', visibility: 'private', content: 'nope', protocol: { ...PROTOCOL } },
    });
    expect(badContent.statusCode).toBe(400);
    expect((badContent.json() as { error: string }).error).toBe('workflow-invalid-content');

    const missingFields = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/workflow-repository/workflows`,
      headers: { 'x-api-key': rawKeyA },
      payload: { name: 'X' },
    });
    expect(missingFields.statusCode).toBe(400);
  });

  it('unknown workflow / version / installation identities → 404', async () => {
    const wf = await server.inject({
      method: 'GET',
      url: '/workflow-repository/workflows/wfw_unknown',
      headers: { 'x-api-key': rawKeyA },
    });
    expect(wf.statusCode).toBe(404);
    const inst = await server.inject({
      method: 'GET',
      url: `/organizations/${orgAId}/workflow-repository/installations/wfin_unknown`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(inst.statusCode).toBe(404);
  });
});
