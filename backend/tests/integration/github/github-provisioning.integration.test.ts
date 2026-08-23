import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import { PgGitHubInstallationRepository } from '../../../src/modules/github/internal/pg-github-repository.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { ProjectGitHubRepository, CreateRepositoryResult } from '@modules/github/index.js';

/**
 * WORK-026 SUB-H — /github provisioning integration tests.
 *
 * Exercises the 4 /github provisioning endpoints (link existing repo / create
 * repo via FakeGitHubAdapter / read association / health) on top of the
 * WORK-002 auth stack (pglite locally / real pg in CI). The FakeGitHubAdapter
 * produces deterministic outputs without calling the real GitHub API.
 */
describe('WORK-026 SUB-H — /github provisioning integration', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let projectGitHubRepo: PgProjectGitHubRepositoryRepository;
  let githubAdapter: FakeGitHubAdapter;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-gh-a',
      WFOS_TEST_KEY_B: 'raw-key-gh-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'GH Org A' });
    orgB = await stack.organizationRepository.create({ name: 'GH Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'gh-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'gh-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'GH Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'GH Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'gh-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'gh-user-a', label: 'User A', rawKey: 'raw-key-gh-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'gh-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'gh-user-b', label: 'User B', rawKey: 'raw-key-gh-b',
    });

    projectGitHubRepo = new PgProjectGitHubRepositoryRepository(stack.db.client);
    githubAdapter = new FakeGitHubAdapter();

    // Pre-link a GitHub installation to both projects so the
    // `installation-not-found` validation can be exercised.
    const installationRepo = new PgGitHubInstallationRepository(stack.db.client);
    await installationRepo.create({
      projectId: projectA.id,
      installationId: 'inst-123',
      accountLogin: 'test-org-a',
    });
    await installationRepo.create({
      projectId: projectB.id,
      installationId: 'inst-456',
      accountLogin: 'test-org-b',
    });

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      githubProvisioning: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        githubAdapter,
        projectGitHubRepositoryRepository: projectGitHubRepo,
        githubInstallationRepository: installationRepo,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // --- POST /github/link ---

  it('POST /github/link — links an existing repo (201)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/github/link`,
      headers: { 'x-api-key': 'raw-key-gh-a' },
      payload: {
        owner: 'test-org',
        repository: 'test-repo',
        installationId: 'inst-123',
        defaultBranch: 'main',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { repository: ProjectGitHubRepository };
    expect(body.repository.id).toBeTruthy();
    expect(body.repository.projectId).toBe(projectA.id);
    expect(body.repository.owner).toBe('test-org');
    expect(body.repository.repository).toBe('test-repo');
    expect(body.repository.installationId).toBe('inst-123');
    expect(body.repository.defaultBranch).toBe('main');
    expect(body.repository.linkType).toBe('linked');
  });

  it('POST /github/link — 400 when installationId does not belong to the project', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/github/link`,
      headers: { 'x-api-key': 'raw-key-gh-a' },
      payload: {
        owner: 'test-org',
        repository: 'another-repo',
        installationId: 'inst-not-linked',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('installation-not-found');
  });

  // --- GET /github/repository ---

  it('GET /github/repository — returns the previously-linked association', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}/github/repository`,
      headers: { 'x-api-key': 'raw-key-gh-a' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { repository: ProjectGitHubRepository | null };
    expect(body.repository).not.toBeNull();
    expect(body.repository!.owner).toBe('test-org');
    expect(body.repository!.repository).toBe('test-repo');
    expect(body.repository!.linkType).toBe('linked');
  });

  // --- GET /github/health ---

  it('GET /github/health — returns { status: "test-mode" } when FakeGitHubAdapter is wired', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}/github/health`,
      headers: { 'x-api-key': 'raw-key-gh-a' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('test-mode');
  });

  // --- POST /github/repository ---

  it('POST /github/repository — creates a repo via the adapter + persists with linkType="created"', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectB.id}/github/repository`,
      headers: { 'x-api-key': 'raw-key-gh-b' },
      payload: {
        owner: 'test-org-b',
        repository: 'provisioned-repo',
        visibility: 'private',
        defaultBranch: 'main',
        installationId: 'inst-456',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      repository: ProjectGitHubRepository;
      github: CreateRepositoryResult;
    };
    // The association is persisted with linkType='created'.
    expect(body.repository.projectId).toBe(projectB.id);
    expect(body.repository.owner).toBe('test-org-b');
    expect(body.repository.repository).toBe('provisioned-repo');
    expect(body.repository.linkType).toBe('created');
    expect(body.repository.externalRepoId).toBe('fake-repo-provisioned-repo');
    // The github result shape (from FakeGitHubAdapter):
    expect(body.github.owner).toBe('test-org-b');
    expect(body.github.repository).toBe('provisioned-repo');
    expect(body.github.url).toBe('https://github.com/test-org-b/provisioned-repo');
    expect(body.github.defaultBranch).toBe('main');
    expect(body.github.installationId).toBe('inst-456');
  });

  it('POST /github/repository — 400 when installationId is not linked to the project', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/github/repository`,
      headers: { 'x-api-key': 'raw-key-gh-a' },
      payload: {
        owner: 'test-org',
        repository: 'should-fail',
        installationId: 'inst-belonging-to-B', // belongs to projectB, not projectA
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('installation-not-found');
  });

  // --- Tenant isolation ---

  it('tenant isolation: User A cannot link a repo for User B project (403)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectB.id}/github/link`,
      headers: { 'x-api-key': 'raw-key-gh-a' },
      payload: {
        owner: 'cross-tenant-org',
        repository: 'cross-tenant-repo',
        installationId: 'inst-456',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tenant isolation: User A cannot read User B github association (403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectB.id}/github/repository`,
      headers: { 'x-api-key': 'raw-key-gh-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tenant isolation: User A cannot read User B github health (403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectB.id}/github/health`,
      headers: { 'x-api-key': 'raw-key-gh-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- Secret safety ---

  it('secret safety: github provisioning responses do not leak secret env-var names or values', async () => {
    // Use fixture data that does NOT itself contain the secret keywords the
    // assertion greps for (so a true positive surfaces only when the backend
    // actually leaks a secret-bearing identifier).
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/github/repository`,
      headers: { 'x-api-key': 'raw-key-gh-a' },
      payload: {
        owner: 'verify-safe-org',
        repository: 'verify-safe-repo',
        installationId: 'inst-123',
      },
    });
    expect(res.statusCode).toBe(201);
    const bodyText = JSON.stringify(res.json());
    const lower = bodyText.toLowerCase();
    // No GitHub-App private-key material, no Vercel API token, no AGENT_API_KEY
    // value, no password leaks. The GitHub App private key stays inside the
    // adapter boundary (SUB-C invariant).
    expect(lower).not.toContain('github_app_private_key');
    expect(lower).not.toContain('private_key');
    expect(lower).not.toContain('vercel_api_token');
    expect(lower).not.toContain('agent_api_key');
    expect(lower).not.toContain('password');
    expect(lower).not.toContain('-----begin');
  });
});
