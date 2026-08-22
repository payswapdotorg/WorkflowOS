import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

/**
 * AUTHZ-AC-01 — Unauthorized project access fails.
 * AUTHZ-AC-02 — Cross-tenant identifiers do not grant access.
 * AUTHZ-AC-03 — Backend authorization remains effective when frontend checks are bypassed.
 *
 * Evidence: cross-tenant fixtures (Org A / User A / Project A vs Org B / User
 * B / Project B) prove that User A cannot access Project B. A direct API
 * request receives the same authorization decision regardless of frontend.
 *
 * The AuthorizationService is the reusable backend authorization mechanism;
 * decisions are testable without HTTP (AUTHZ-AC-03 service-level tests) AND
 * enforced through the real Fastify route (AUTHZ-AC-01 API contract tests).
 */
describe('AUTHZ-AC-01 / AUTHZ-AC-02 / AUTHZ-AC-03 — authorization + tenant isolation', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let userNoPerm: User;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-user-a',
      WFOS_TEST_KEY_B: 'raw-key-user-b',
      WFOS_TEST_KEY_NOPERM: 'raw-key-noperm',
    });

    // --- Cross-tenant fixtures: Org A / User A / Project A vs Org B / User B / Project B ---
    orgA = await stack.organizationRepository.create({ name: 'Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Org B' });

    userA = await stack.userRepository.upsertByExternalId({
      externalId: 'user-a',
      displayName: 'User A',
    });
    userB = await stack.userRepository.upsertByExternalId({
      externalId: 'user-b',
      displayName: 'User B',
    });
    userNoPerm = await stack.userRepository.upsertByExternalId({
      externalId: 'user-noperm',
      displayName: 'User NoPerm',
    });

    // User A is an owner of Org A; User B is an owner of Org B.
    await stack.membershipRepository.assign({
      userId: userA.id,
      organizationId: orgA.id,
      roleId: 'owner',
    });
    await stack.membershipRepository.assign({
      userId: userB.id,
      organizationId: orgB.id,
      roleId: 'owner',
    });
    // userNoPerm is a member of Org A but has no project_access.
    await stack.membershipRepository.assign({
      userId: userNoPerm.id,
      organizationId: orgA.id,
      roleId: 'member',
    });

    projectA = await stack.projectRepository.create({
      organizationId: orgA.id,
      name: 'Project A',
    });
    projectB = await stack.projectRepository.create({
      organizationId: orgB.id,
      name: 'Project B',
    });

    // Grant project_access: userA → projectA (owner); userB → projectB (owner).
    await stack.projectAccessRepository.grant({
      userId: userA.id,
      projectId: projectA.id,
      roleId: 'owner',
    });
    await stack.projectAccessRepository.grant({
      userId: userB.id,
      projectId: projectB.id,
      roleId: 'owner',
    });

    // Provision API keys for all three users.
    await stack.apiKeyProvisioner.provision({
      keyId: 'key-a',
      secretRef: 'WFOS_TEST_KEY_A',
      externalId: 'user-a',
      label: 'User A',
      rawKey: 'raw-key-user-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'key-b',
      secretRef: 'WFOS_TEST_KEY_B',
      externalId: 'user-b',
      label: 'User B',
      rawKey: 'raw-key-user-b',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'key-noperm',
      secretRef: 'WFOS_TEST_KEY_NOPERM',
      externalId: 'user-noperm',
      label: 'User NoPerm',
      rawKey: 'raw-key-noperm',
    });

    // Build the Fastify server with auth + protected /projects route.
    server = await buildServer({
      queue: stack.db.client as never, // unused for these tests; pass a no-op
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

  // --- AUTHZ-AC-01: unauthorized project access fails ---

  it('AUTHZ-AC-01 (service): a user with project.read permission on projectA is allowed', async () => {
    const decision = await stack.authorizationService.authorize({
      user: userA,
      permission: 'project.read',
      resource: { kind: 'project', projectId: projectA.id },
    });
    expect(decision.allowed).toBe(true);
  });

  it('AUTHZ-AC-01 (API): GET /projects/:id with valid permission returns 200', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}`,
      headers: { 'x-api-key': 'raw-key-user-a' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; organizationId: string; name: string };
    expect(body.id).toBe(projectA.id);
    expect(body.organizationId).toBe(orgA.id);
  });

  it('AUTHZ-AC-01 (API): GET /projects/:id without authentication returns 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}`,
    });
    expect(res.statusCode).toBe(401);
  });

  // --- AUTHZ-AC-02: cross-tenant identifiers do not grant access ---

  it('AUTHZ-AC-02 (service): User A (Org A) cannot access Project B (Org B)', async () => {
    const decision = await stack.authorizationService.authorize({
      user: userA,
      permission: 'project.read',
      resource: { kind: 'project', projectId: projectB.id },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('not-a-member');
  });

  it('AUTHZ-AC-02 (API): User A requesting Project B gets 403', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectB.id}`,
      headers: { 'x-api-key': 'raw-key-user-a' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; reason: string };
    expect(body.error).toBe('forbidden');
    expect(body.reason).toBe('not-a-member');
  });

  it('AUTHZ-AC-02 (service): a stray cross-tenant project_access row does NOT grant access', async () => {
    // Insert a project_access row granting User A access to Project B. The
    // AuthorizationService MUST still deny because User A is not a member of
    // Org B (the project's owner).
    await stack.projectAccessRepository.grant({
      userId: userA.id,
      projectId: projectB.id,
      roleId: 'owner',
    });
    const decision = await stack.authorizationService.authorize({
      user: userA,
      permission: 'project.read',
      resource: { kind: 'project', projectId: projectB.id },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('not-a-member');
  });

  // --- AUTHZ-AC-03: backend authorization remains effective when frontend checks are bypassed ---

  it('AUTHZ-AC-03 (API): a direct API call with no project_access is denied regardless of frontend', async () => {
    // userNoPerm is a member of Org A but has NO project_access on Project A.
    // A direct API call (simulating a bypassed frontend) is still denied.
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}`,
      headers: { 'x-api-key': 'raw-key-noperm' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; reason: string };
    // userNoPerm is a member of Org A with the 'member' role, which has
    // project.read. But they have no project_access row. The service denies
    // with 'no-project-access' because members need explicit project access.
    expect(['no-project-access', 'missing-permission']).toContain(body.reason);
  });

  it('AUTHZ-AC-03 (service): authorization decisions are testable without HTTP', async () => {
    // The AuthorizationService is a pure backend service — no HTTP/controller
    // code is needed to make a decision. This proves frontend state is
    // irrelevant to the backend authorization decision.
    const allowed = await stack.authorizationService.authorize({
      user: userB,
      permission: 'project.read',
      resource: { kind: 'project', projectId: projectB.id },
    });
    expect(allowed.allowed).toBe(true);
    const denied = await stack.authorizationService.authorize({
      user: userB,
      permission: 'project.read',
      resource: { kind: 'project', projectId: projectA.id },
    });
    expect(denied.allowed).toBe(false);
  });

  it('AUTHZ-AC-01 (service): a non-existent project is denied with resource-not-found', async () => {
    const decision = await stack.authorizationService.authorize({
      user: userA,
      permission: 'project.read',
      resource: { kind: 'project', projectId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('resource-not-found');
  });
});
