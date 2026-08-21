import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

/**
 * PROJ-AC-01 — Tenant-owned projects persist.
 * PROJ-AC-02 — Repository association persists.
 * PROJ-AC-03 — Project lifecycle is explicit.
 *
 * Evidence: projects persist with owning org; repository associations persist
 * through the provider-independent contract; lifecycle state transitions are
 * explicit and validated. Cross-tenant access is rejected (reuses WORK-002
 * AuthorizationService).
 */
describe('PROJ-AC-01/02/03 — project domain', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-proj-a',
      WFOS_TEST_KEY_B: 'raw-key-proj-b',
    });

    orgA = await stack.organizationRepository.create({ name: 'Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });

    await stack.apiKeyProvisioner.provision({
      keyId: 'key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'user-a', label: 'User A', rawKey: 'raw-key-proj-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'user-b', label: 'User B', rawKey: 'raw-key-proj-b',
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
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // --- PROJ-AC-01: tenant-owned projects persist ---

  it('PROJ-AC-01: a project persists with an owning organization', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { name: 'Project A', metadata: { kind: 'demo' } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; organizationId: string; name: string; state: string };
    expect(body.organizationId).toBe(orgA.id);
    expect(body.name).toBe('Project A');
    expect(body.state).toBe('active');

    // The project is recoverable by id through the repository.
    const fetched = await stack.projectRepository.findById(body.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.organizationId).toBe(orgA.id);
  });

  it('PROJ-AC-01 (cross-tenant): User B cannot GET Project A', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { name: 'Project A2' },
    });
    const projectId = (createRes.json() as { id: string }).id;
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { 'x-api-key': 'raw-key-proj-b' },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- PROJ-AC-02: repository association persists ---

  it('PROJ-AC-02: a project can be associated with an external repository (provider-independent)', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { name: 'Project With Repo' },
    });
    const projectId = (createRes.json() as { id: string }).id;

    const assocRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/repositories`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: {
        provider: 'github',
        externalId: 'pectoraux/workflowos-demo',
        canonicalRef: 'https://github.com/pectoraux/workflowos-demo',
        metadata: { defaultBranch: 'main' },
      },
    });
    expect(assocRes.statusCode).toBe(201);
    const assoc = assocRes.json() as { id: string; provider: string; externalId: string; canonicalRef: string };
    expect(assoc.provider).toBe('github');
    expect(assoc.externalId).toBe('pectoraux/workflowos-demo');

    // The association is listable.
    const listRes = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/repositories`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as { repositories: Array<{ provider: string; externalId: string }> };
    expect(list.repositories).toHaveLength(1);
    expect(list.repositories[0]!.provider).toBe('github');
  });

  it('PROJ-AC-02: association is idempotent on (project, provider, externalId)', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { name: 'Project Idempotent' },
    });
    const projectId = (createRes.json() as { id: string }).id;
    const payload = {
      provider: 'github',
      externalId: 'pectoraux/idempotent',
      canonicalRef: 'https://github.com/pectoraux/idempotent',
    };
    await server.inject({
      method: 'POST', url: `/projects/${projectId}/repositories`,
      headers: { 'x-api-key': 'raw-key-proj-a' }, payload,
    });
    const second = await server.inject({
      method: 'POST', url: `/projects/${projectId}/repositories`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { ...payload, canonicalRef: 'https://github.com/pectoraux/idempotent-v2' },
    });
    expect(second.statusCode).toBe(201);
    const list = (await server.inject({
      method: 'GET', url: `/projects/${projectId}/repositories`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
    })).json() as { repositories: Array<{ canonicalRef: string }> };
    expect(list.repositories).toHaveLength(1);
    expect(list.repositories[0]!.canonicalRef).toBe('https://github.com/pectoraux/idempotent-v2');
  });

  // --- PROJ-AC-03: project lifecycle is explicit ---

  it('PROJ-AC-03: a new project starts in the active state', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { name: 'Lifecycle Project' },
    });
    const body = createRes.json() as { state: string };
    expect(body.state).toBe('active');
  });

  it('PROJ-AC-03: active → archived transition succeeds', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { name: 'Archive Me' },
    });
    const projectId = (createRes.json() as { id: string }).id;
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/transition`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { to: 'archived' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { from: string; to: string };
    expect(body.from).toBe('active');
    expect(body.to).toBe('archived');
  });

  it('PROJ-AC-03: archived → active transition succeeds (revive)', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { name: 'Revive Me' },
    });
    const projectId = (createRes.json() as { id: string }).id;
    await server.inject({
      method: 'POST', url: `/projects/${projectId}/transition`,
      headers: { 'x-api-key': 'raw-key-proj-a' }, payload: { to: 'archived' },
    });
    const res = await server.inject({
      method: 'POST', url: `/projects/${projectId}/transition`,
      headers: { 'x-api-key': 'raw-key-proj-a' }, payload: { to: 'active' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { to: string };
    expect(body.to).toBe('active');
  });

  it('PROJ-AC-03: invalid state value is rejected', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { name: 'Invalid State' },
    });
    const projectId = (createRes.json() as { id: string }).id;
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/transition`,
      headers: { 'x-api-key': 'raw-key-proj-a' },
      payload: { to: 'deleted' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PROJ-AC-01 (service): projects list for an organization', async () => {
    await stack.projectRepository.create({ organizationId: orgA.id, name: 'List Project 1' });
    await stack.projectRepository.create({ organizationId: orgA.id, name: 'List Project 2' });
    const list = await stack.projectRepository.listForOrganization(orgA.id);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.every((p) => p.organizationId === orgA.id)).toBe(true);
  });
});
