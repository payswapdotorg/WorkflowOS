import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

/**
 * SPEC-AC-01 — Specification persists.
 * SPEC-AC-02 — Specification lifecycle is explicit.
 * SPEC-AC-03 — Specification content/version traceability.
 *
 * Evidence: specifications persist with project ownership; lifecycle
 * transitions are validated; versions are traceable; large content uses the
 * ObjectStore abstraction. Cross-tenant access is rejected through the
 * project's owning organization (reuses WORK-002 AuthorizationService).
 */
describe('SPEC-AC-01/02/03 — specification domain', () => {
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
      WFOS_TEST_KEY_A: 'raw-key-spec-a',
      WFOS_TEST_KEY_B: 'raw-key-spec-b',
    });

    orgA = await stack.organizationRepository.create({ name: 'Spec Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Spec Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'spec-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'spec-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });

    await stack.apiKeyProvisioner.provision({
      keyId: 'spec-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'spec-user-a', label: 'User A', rawKey: 'raw-key-spec-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'spec-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'spec-user-b', label: 'User B', rawKey: 'raw-key-spec-b',
    });

    // Grant project access: userA → projectA, userB → projectB.
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Spec Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Spec Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      projects: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        repositoryAssociationRepository: stack.repositoryAssociationRepository,
      },
      specifications: {
        authorizationService: stack.authorizationService,
        specificationRepository: stack.specificationRepository,
        specificationVersionRepository: stack.specificationVersionRepository,
        projectRepository: stack.projectRepository,
        objectStore: stack.objectStore,
      },
    });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // --- SPEC-AC-01: specification persists ---

  it('SPEC-AC-01: a specification persists with project ownership', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { slug: 'spec-001', title: 'Specification 001' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; projectId: string; slug: string; state: string; currentVersion: number };
    expect(body.projectId).toBe(projectA.id);
    expect(body.slug).toBe('spec-001');
    expect(body.state).toBe('draft');
    expect(body.currentVersion).toBe(0);

    // Recoverable by id.
    const fetched = await stack.specificationRepository.findById(body.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.projectId).toBe(projectA.id);
  });

  it('SPEC-AC-01 (cross-tenant): User B cannot access a specification on Project A', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { slug: 'spec-cross-tenant', title: 'Cross Tenant' },
    });
    const specId = (createRes.json() as { id: string }).id;
    // User B attempts to GET the spec through Project A.
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}/specifications/${specId}`,
      headers: { 'x-api-key': 'raw-key-spec-b' },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- SPEC-AC-02: lifecycle is explicit ---

  it('SPEC-AC-02: draft → published transition succeeds', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { slug: 'lifecycle-spec', title: 'Lifecycle Spec' },
    });
    const specId = (createRes.json() as { id: string }).id;
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications/${specId}/transition`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { to: 'published' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { from: string; to: string };
    expect(body.from).toBe('draft');
    expect(body.to).toBe('published');
  });

  it('SPEC-AC-02: published → archived transition succeeds', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { slug: 'archive-spec', title: 'Archive Spec' },
    });
    const specId = (createRes.json() as { id: string }).id;
    await server.inject({
      method: 'POST', url: `/projects/${projectA.id}/specifications/${specId}/transition`,
      headers: { 'x-api-key': 'raw-key-spec-a' }, payload: { to: 'published' },
    });
    const res = await server.inject({
      method: 'POST', url: `/projects/${projectA.id}/specifications/${specId}/transition`,
      headers: { 'x-api-key': 'raw-key-spec-a' }, payload: { to: 'archived' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { to: string }).to).toBe('archived');
  });

  it('SPEC-AC-02: invalid transition is rejected', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { slug: 'invalid-transition', title: 'Invalid' },
    });
    const specId = (createRes.json() as { id: string }).id;
    // draft → archived is NOT legal (must go through published first).
    const res = await server.inject({
      method: 'POST', url: `/projects/${projectA.id}/specifications/${specId}/transition`,
      headers: { 'x-api-key': 'raw-key-spec-a' }, payload: { to: 'archived' },
    });
    expect(res.statusCode).toBe(409);
  });

  // --- SPEC-AC-03: content/version traceability ---

  it('SPEC-AC-03: a small content version is stored inline and is traceable', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { slug: 'versioned-spec', title: 'Versioned Spec' },
    });
    const specId = (createRes.json() as { id: string }).id;
    const content = '# Spec\n\nSmall content body.';
    const versionRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications/${specId}/versions`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { content, contentType: 'text/markdown' },
    });
    expect(versionRes.statusCode).toBe(201);
    const version = versionRes.json() as { versionNumber: number; contentInline: string | null; storageKey: string | null; contentLength: number; digestSha256: string };
    expect(version.versionNumber).toBe(1);
    expect(version.contentInline).toBe(content);
    expect(version.storageKey).toBeNull();
    expect(version.contentLength).toBe(Buffer.byteLength(content, 'utf8'));
    expect(version.digestSha256).toMatch(/^[0-9a-f]{64}$/);

    // The spec's currentVersion is now 1.
    const spec = await stack.specificationRepository.findById(specId);
    expect(spec!.currentVersion).toBe(1);

    // The latest version is retrievable with content.
    const latestRes = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}/specifications/${specId}/versions/latest`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
    });
    expect(latestRes.statusCode).toBe(200);
    const latest = latestRes.json() as { content: string | null; versionNumber: number };
    expect(latest.versionNumber).toBe(1);
    expect(latest.content).toBe(content);
  });

  it('SPEC-AC-03: a large content body uses object storage (storage_key set, content not inline)', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { slug: 'large-spec', title: 'Large Spec' },
    });
    const specId = (createRes.json() as { id: string }).id;
    // Build a body larger than the inline threshold (8 KiB).
    const largeContent = '# Large\n\n' + 'x'.repeat(16 * 1024);
    const versionRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications/${specId}/versions`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { content: largeContent, contentType: 'text/plain' },
    });
    expect(versionRes.statusCode).toBe(201);
    const version = versionRes.json() as { storageKey: string | null; storageProvider: string | null; contentInline: string | null; contentLength: number };
    // Large body → stored in object storage, NOT inline.
    expect(version.storageKey).not.toBeNull();
    expect(version.storageProvider).toBe('memory');
    expect(version.contentInline).toBeNull();
    expect(version.contentLength).toBe(Buffer.byteLength(largeContent, 'utf8'));

    // The content is recoverable via the object store through the latest-version endpoint.
    const latestRes = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}/specifications/${specId}/versions/latest`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
    });
    expect(latestRes.statusCode).toBe(200);
    const latest = latestRes.json() as { content: string | null };
    expect(latest.content).toBe(largeContent);
  });

  it('SPEC-AC-03: multiple versions are traceable in order', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/specifications`,
      headers: { 'x-api-key': 'raw-key-spec-a' },
      payload: { slug: 'multi-version', title: 'Multi Version' },
    });
    const specId = (createRes.json() as { id: string }).id;
    await server.inject({
      method: 'POST', url: `/projects/${projectA.id}/specifications/${specId}/versions`,
      headers: { 'x-api-key': 'raw-key-spec-a' }, payload: { content: 'v1' },
    });
    await server.inject({
      method: 'POST', url: `/projects/${projectA.id}/specifications/${specId}/versions`,
      headers: { 'x-api-key': 'raw-key-spec-a' }, payload: { content: 'v2' },
    });
    await server.inject({
      method: 'POST', url: `/projects/${projectA.id}/specifications/${specId}/versions`,
      headers: { 'x-api-key': 'raw-key-spec-a' }, payload: { content: 'v3' },
    });

    const versions = await stack.specificationVersionRepository.listForSpecification(specId);
    expect(versions).toHaveLength(3);
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2, 3]);

    const latest = await stack.specificationVersionRepository.findLatest(specId);
    expect(latest!.versionNumber).toBe(3);

    const spec = await stack.specificationRepository.findById(specId);
    expect(spec!.currentVersion).toBe(3);
  });
});
