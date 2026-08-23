import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { PgAgentProviderConfigRepository } from '../../../src/modules/agents/internal/pg-agent-provider-config-repository.js';
import { DefaultAgentProviderRegistryService } from '../../../src/modules/agents/internal/agent-provider-registry-service.js';
import { DefaultAgentProviderRegistry } from '../../../src/platform/default-agent-provider-registry.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type {
  AgentProviderConfig,
  AgentProviderConfigRecord,
} from '@modules/agents/index.js';

/**
 * WORK-026 SUB-H — /agents provider registry integration tests.
 *
 * Exercises the 3 agent provider endpoints:
 *   - GET  /agents/providers                       (platform-level)
 *   - GET  /projects/:projectId/agents/providers    (project-specific)
 *   - POST /projects/:projectId/agents/providers    (create per-project config)
 *
 * Verifies secret safety: the POST body + GET responses must NEVER contain
 * the secret value (only the secretRef). Verifies isDefault handling +
 * tenant isolation.
 */
describe('WORK-026 SUB-H — /agents provider registry integration', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let agentProviderConfigRepo: PgAgentProviderConfigRepository;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };

  beforeAll(async () => {
    // AGENT_API_KEY is intentionally NOT set so the platform registry
    // surfaces 'not-configured' in the first test. The per-project POST
    // test sets a separate env var (WFOS_TEST_AGENT_KEY) via buildAuthStack
    // to verify that the per-project secretRef resolves to 'ready'.
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-apr-a',
      WFOS_TEST_KEY_B: 'raw-key-apr-b',
      WFOS_TEST_AGENT_KEY: 'super-secret-agent-token-value',
    });
    orgA = await stack.organizationRepository.create({ name: 'APR Org A' });
    orgB = await stack.organizationRepository.create({ name: 'APR Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'apr-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'apr-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'APR Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'APR Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'apr-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'apr-user-a', label: 'User A', rawKey: 'raw-key-apr-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'apr-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'apr-user-b', label: 'User B', rawKey: 'raw-key-apr-b',
    });

    agentProviderConfigRepo = new PgAgentProviderConfigRepository(stack.db.client);
    const platformRegistry = new DefaultAgentProviderRegistry(stack.secretStore);
    const registryService = new DefaultAgentProviderRegistryService(
      platformRegistry,
      agentProviderConfigRepo,
      stack.secretStore,
    );

    // The /agents route requires an AgentGateway + WorkItemRepository
    // (existing 3 endpoints). We wire a minimal fake agent gateway so the
    // route registration proceeds; the new provider-registry endpoints are
    // gated on the presence of agentProviderRegistryService +
    // agentProviderConfigRepository only.
    const fakeAgent = new FakeAgentAdapter();
    const agentGateway = new DefaultAgentGateway(stack.db.client, stack.db.logger, [fakeAgent], 3);
    const agentRunRepo = new PgAgentRunRepository(stack.db.client);

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      agents: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        agentGateway,
        agentRunRepository: agentRunRepo,
        queue: stack.db.client as never,
        agentProviderRegistryService: registryService,
        agentProviderConfigRepository: agentProviderConfigRepo,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // --- GET /agents/providers (platform level) ---

  it('GET /agents/providers — when AGENT_API_KEY is unset, returns a single not-configured entry', async () => {
    // Ensure AGENT_API_KEY is not set in the environment.
    const before = process.env.AGENT_API_KEY;
    delete process.env.AGENT_API_KEY;
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/agents/providers',
        headers: { 'x-api-key': 'raw-key-apr-a' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { providers: AgentProviderConfig[] };
      expect(body.providers.length).toBeGreaterThanOrEqual(1);
      // The default platform registry surfaces 'not-configured' when
      // AGENT_API_KEY is absent.
      const notConfigured = body.providers.find((p) => p.status === 'not-configured');
      expect(notConfigured).toBeDefined();
    } finally {
      if (before !== undefined) process.env.AGENT_API_KEY = before;
    }
  });

  // --- GET /projects/:projectId/agents/providers (project-specific) ---

  it('GET /projects/:projectId/agents/providers — returns empty providers initially (platform fallback)', async () => {
    // With AGENT_API_KEY unset, project A has no per-project overrides + the
    // platform registry surfaces 'not-configured'.
    const before = process.env.AGENT_API_KEY;
    delete process.env.AGENT_API_KEY;
    try {
      const res = await server.inject({
        method: 'GET',
        url: `/projects/${projectA.id}/agents/providers`,
        headers: { 'x-api-key': 'raw-key-apr-a' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { providers: AgentProviderConfig[] };
      expect(body.providers.length).toBeGreaterThanOrEqual(1);
      // Platform fallback: the single 'not-configured' entry surfaces.
      expect(body.providers.every((p) => p.status === 'not-configured')).toBe(true);
    } finally {
      if (before !== undefined) process.env.AGENT_API_KEY = before;
    }
  });

  // --- POST /projects/:projectId/agents/providers ---

  it('POST /projects/:projectId/agents/providers — creates a project provider config (201)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/agents/providers`,
      headers: { 'x-api-key': 'raw-key-apr-a' },
      payload: {
        provider: 'openai',
        model: 'gpt-4o',
        secretRef: 'WFOS_TEST_AGENT_KEY',
        metadata: {},
        isDefault: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as AgentProviderConfigRecord;
    expect(body.id).toBeTruthy();
    expect(body.projectId).toBe(projectA.id);
    expect(body.provider).toBe('openai');
    expect(body.model).toBe('gpt-4o');
    expect(body.secretRef).toBe('WFOS_TEST_AGENT_KEY');
    expect(body.isDefault).toBe(true);
    expect(body.metadata).toEqual({});
  });

  it('POST — isDefault=true atomically replaces the prior default', async () => {
    // Insert a second config as default — the prior default (openai/gpt-4o)
    // must be cleared automatically (SUB-E atomic clear-then-insert).
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/agents/providers`,
      headers: { 'x-api-key': 'raw-key-apr-a' },
      payload: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        secretRef: 'WFOS_TEST_AGENT_KEY',
        isDefault: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as AgentProviderConfigRecord;
    expect(body.isDefault).toBe(true);

    // Verify the prior default was cleared.
    const priorDefault = await agentProviderConfigRepo.findByProjectProviderModel(
      projectA.id, 'openai', 'gpt-4o',
    );
    expect(priorDefault).not.toBeNull();
    expect(priorDefault!.isDefault).toBe(false);

    // Verify only ONE default exists for project A.
    const allRows = await agentProviderConfigRepo.findByProject(projectA.id);
    const defaults = allRows.filter((r) => r.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0]!.provider).toBe('anthropic');
  });

  it('GET after POST — returns the created config (project-specific override)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}/agents/providers`,
      headers: { 'x-api-key': 'raw-key-apr-a' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: AgentProviderConfig[] };
    // Project A now has per-project overrides (openai + anthropic). The
    // readiness check resolves via SecretStore.getSecret(WFOS_TEST_AGENT_KEY)
    // — both rows point at the same env var, so both should be 'ready'.
    expect(body.providers.length).toBe(2);
    const openai = body.providers.find((p) => p.provider === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.model).toBe('gpt-4o');
    expect(openai!.status).toBe('ready');
    const anthropic = body.providers.find((p) => p.provider === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.model).toBe('claude-3-5-sonnet');
    expect(anthropic!.status).toBe('ready');
  });

  // --- Tenant isolation ---

  it('tenant isolation: User A cannot read User B project providers (403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectB.id}/agents/providers`,
      headers: { 'x-api-key': 'raw-key-apr-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tenant isolation: User A cannot create a provider config for User B project (403)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectB.id}/agents/providers`,
      headers: { 'x-api-key': 'raw-key-apr-a' },
      payload: {
        provider: 'openai',
        model: 'gpt-4o',
        secretRef: 'WFOS_TEST_AGENT_KEY',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- Secret safety ---

  it('secret safety: POST response must NOT contain the secret value (only the secretRef name)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/agents/providers`,
      headers: { 'x-api-key': 'raw-key-apr-a' },
      payload: {
        provider: 'gemini',
        model: 'gemini-1.5-pro',
        secretRef: 'WFOS_TEST_AGENT_KEY',
      },
    });
    expect(res.statusCode).toBe(201);
    const bodyText = JSON.stringify(res.json());
    // The secretRef NAME surfaces (it's a key identifier, not the value).
    expect(bodyText).toContain('WFOS_TEST_AGENT_KEY');
    // The secret VALUE must NEVER appear in the response.
    expect(bodyText).not.toContain('super-secret-agent-token-value');
  });

  it('secret safety: GET responses must NOT contain secret values', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}/agents/providers`,
      headers: { 'x-api-key': 'raw-key-apr-a' },
    });
    expect(res.statusCode).toBe(200);
    const bodyText = JSON.stringify(res.json());
    // The secret VALUE must NEVER appear in the response — only the
    // readiness flag.
    expect(bodyText).not.toContain('super-secret-agent-token-value');
    // The POST'd secretRef name must NOT appear either in the readiness list
    // (the GET /providers endpoint returns readiness-only ProviderConfig —
    // no secretRef, no metadata).
    expect(bodyText).not.toContain('WFOS_TEST_AGENT_KEY');
  });
});
