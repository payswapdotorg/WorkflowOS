/**
 * WORK-045 — route-level API tests for the agent-roles read-only surface
 * (W045-AC11/AC13 evidence: request-scoped resolution is exposed and must
 * stay inside the caller's authorized project context).
 *
 * Real fastify server (buildServer) + the real auth stack
 * (requireProjectAuthorization) + the real DefaultAgentRoleCatalogService
 * (the real closed catalog — no stubs at all: the role layer is pure static
 * data).
 *
 * Proves:
 *   - GET /projects/:projectId/agent-roles returns the closed catalog in the
 *     DECLARED deterministic order, each role with its declaration
 *     semantics (byte-stable payload across calls — W045-AC03/AC13).
 *   - GET /projects/:projectId/agent-roles/:roleId resolves ONE role
 *     deterministically (same revision as the catalog) — W045-AC10.
 *   - An unknown role identity is 404 (no fallback, no nearest-match).
 *   - Backend-authorized: a missing key is 401, a cross-tenant key is 403
 *     (W045-AC11 — request-scoped resolution stays inside the authorized
 *     project context), an authorized-but-unknown project is 403 (no
 *     membership — fail-closed).
 *   - The two tenants see the IDENTICAL catalog payload (the catalog is
 *     global truth; no tenant metadata affects it — W045-AC11).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultAgentRoleCatalogService } from '../../../src/agent-roles/index.js';
import type { FastifyInstance } from 'fastify';

const REQUIRED_IDENTITIES: readonly string[] = [
  'architect',
  'planner',
  'implementer',
  'tester',
  'security-reviewer',
  'performance-reviewer',
  'ux-reviewer',
  'release-engineer',
];

interface RolePayload {
  identity: string;
  displayName: string;
  purpose: string;
  responsibilities: string[];
  requiredCapabilities: string[];
  advisoryConstraints: { kind: string; description: string }[];
  expectedInputs: { name: string; description: string; required: boolean }[];
  expectedOutputs: { name: string; description: string; required: boolean }[];
  execution: { supportedModes: string[]; semantics: string };
  lifecycle: { contractVersion: number; revision: string; status: string };
  extensions: { delegation: Record<string, unknown>; intelligence: Record<string, unknown> };
}

interface ListPayload {
  roles: { role: RolePayload; declarationSemantics: Record<string, string> }[];
}

describe('WORK-045 — agent-roles API (read-only catalog surface)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let projectId: string;
  let projectBId: string;
  let rawKeyA: string;
  let rawKeyB: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-w045-a',
      WFOS_TEST_KEY_B: 'raw-key-w045-b',
    });

    const orgA = await stack.organizationRepository.create({ name: 'W045 API Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'W045 API Org B' });
    const userA = await stack.userRepository.upsertByExternalId({ externalId: 'w045-api-user-a', displayName: 'User A' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'w045-api-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W045 API Project A' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W045 API Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w045-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'w045-api-user-a', label: 'A', rawKey: 'raw-key-w045-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w045-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'w045-api-user-b', label: 'B', rawKey: 'raw-key-w045-b',
    });
    rawKeyA = 'raw-key-w045-a';
    rawKeyB = 'raw-key-w045-b';
    projectId = projectA.id;
    projectBId = projectB.id;

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      agentRoles: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        agentRoleCatalogService: new DefaultAgentRoleCatalogService(),
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  it('GET /projects/:projectId/agent-roles → 200: the closed catalog in the DECLARED deterministic order, each role with its declaration semantics', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/agent-roles`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListPayload;
    expect(body.roles.map((r) => r.role.identity)).toEqual(REQUIRED_IDENTITIES);
    for (const entry of body.roles) {
      const role = entry.role;
      // W045-AC01: the full contract.
      expect(role.displayName.length).toBeGreaterThan(0);
      expect(role.purpose.length).toBeGreaterThan(0);
      expect(role.responsibilities.length).toBeGreaterThanOrEqual(3);
      expect(role.requiredCapabilities.length).toBeGreaterThanOrEqual(1);
      expect(role.expectedInputs.length).toBeGreaterThanOrEqual(2);
      expect(role.expectedOutputs.length).toBeGreaterThanOrEqual(2);
      // W045-AC06: symmetric advisory modes.
      expect(role.execution.supportedModes).toEqual(['native', 'external']);
      expect(role.execution.semantics).toBe('advisory');
      // W045-AC10: version + revision.
      expect(role.lifecycle.contractVersion).toBe(1);
      expect(role.lifecycle.revision).toMatch(/^[0-9a-f]{16}$/);
      // W045-AC14: the EMPTY extension seam.
      expect(role.extensions.delegation).toEqual({});
      expect(role.extensions.intelligence).toEqual({});
      // W045-AC13: the advisory-vs-authoritative semantics.
      expect(entry.declarationSemantics.requiredCapabilities).toBe('declarative-requirement');
      expect(entry.declarationSemantics.requiredCapabilitiesEvaluatedBy).toContain('WORK-043');
      expect(entry.declarationSemantics.dispatchAuthority).toContain('never dispatches');
    }
  });

  it('the LIST payload is BYTE-STABLE across repeated calls (deterministic ordering + content)', async () => {
    const first = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/agent-roles`,
      headers: { 'x-api-key': rawKeyA },
    });
    for (let i = 0; i < 3; i += 1) {
      const repeat = await server.inject({
        method: 'GET',
        url: `/projects/${projectId}/agent-roles`,
        headers: { 'x-api-key': rawKeyA },
      });
      expect(repeat.body).toBe(first.body);
    }
  });

  it('GET /projects/:projectId/agent-roles/:roleId → 200: ONE role resolved deterministically (the same revision as the catalog)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/agent-roles/architect`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { role: RolePayload; declarationSemantics: Record<string, string> };
    expect(body.role.identity).toBe('architect');
    expect(body.role.displayName).toBe('Architect');
    expect(body.role.lifecycle.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(body.declarationSemantics.versioning).toContain('revision');
    // The revision matches the catalog's authoritative revision.
    const catalog = new DefaultAgentRoleCatalogService();
    expect(body.role.lifecycle.revision).toBe(catalog.resolveRole('architect')!.role.lifecycle.revision);
  });

  it('an UNKNOWN role identity is 404 — the closed catalog has NO fallback and no nearest-match', async () => {
    for (const unknown of ['nonexistent', 'ARCHITECT', 'architect-v2', '']) {
      const res = await server.inject({
        method: 'GET',
        url: `/projects/${projectId}/agent-roles/${encodeURIComponent(unknown)}`,
        headers: { 'x-api-key': rawKeyA },
      });
      expect(res.statusCode, `identity '${unknown}' must be 404`).toBe(404);
      expect((res.json() as { error: string }).error).toBe('role-not-found');
    }
  });

  it('a MISSING API key is 401 (backend-authorized)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/agent-roles`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('a CROSS-TENANT API key is 403 (request-scoped resolution stays inside the authorized project context — W045-AC11)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/agent-roles`,
      headers: { 'x-api-key': rawKeyB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('an authorized key on an UNKNOWN project is 403 (fail-closed: no membership → no resolution)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/projects/00000000-0000-0000-0000-000000000000/agent-roles',
      headers: { 'x-api-key': rawKeyA },
    });
    expect(res.statusCode).toBe(403);
  });

  it('W045-AC11: the TWO TENANTS see the IDENTICAL catalog payload (global truth; no tenant metadata affects it)', async () => {
    const fromA = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/agent-roles`,
      headers: { 'x-api-key': rawKeyA },
    });
    const fromB = await server.inject({
      method: 'GET',
      url: `/projects/${projectBId}/agent-roles`,
      headers: { 'x-api-key': rawKeyB },
    });
    expect(fromA.statusCode).toBe(200);
    expect(fromB.statusCode).toBe(200);
    // Byte-identical: the request context authorizes ACCESS but never
    // affects CONTENT.
    expect(fromB.body).toBe(fromA.body);
  });
});
