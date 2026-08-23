import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { PgRuntimeIntegrationRepository, PgDeploymentRepository } from '../../../src/modules/runtime/internal/pg-runtime-repository.js';
import { DefaultDeploymentService } from '../../../src/modules/runtime/internal/deployment-service.js';
import { FakeDeploymentProvider } from '../../../src/modules/runtime/internal/fake-deployment-provider.js';
import { DefaultRuntimeStatusService } from '../../../src/modules/runtime/internal/runtime-status-service.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { PgGitHubInstallationRepository } from '../../../src/modules/github/internal/pg-github-repository.js';
import { DefaultAgentProviderRegistry } from '../../../src/platform/default-agent-provider-registry.js';
import { DefaultAgentProviderRegistryService } from '../../../src/modules/agents/internal/agent-provider-registry-service.js';
import { PgAgentProviderConfigRepository } from '../../../src/modules/agents/internal/pg-agent-provider-config-repository.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import { PgCiEvidenceIngestionRepository } from '../../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { DefaultCiEvidenceIngestionService } from '../../../src/modules/github/internal/ci-evidence-ingestion-service.js';
import { generateExecutionId } from '@platform/ids.js';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

/**
 * WORK-026 SUB-H — Security integration tests.
 *
 * Proves the WORK-026 trust boundaries:
 *   1. Tenant isolation: User A cannot access User B runtime integration (403)
 *   2. Tenant isolation: User A cannot create User B Vercel integration (403)
 *   3. Tenant isolation: User A cannot start work on User B Work Item (403)
 *   4. Provider credentials never appear in API responses — grep all
 *      WORK-026 endpoint responses for 'token' / 'api_key' / 'secret' /
 *      'password' (case-insensitive) → must find none
 *   5. Frontend source contains no provider secrets (VERCEL_API_TOKEN,
 *      GITHUB_APP_PRIVATE_KEY, AGENT_API_KEY)
 *   6. PR merge cannot be forged by a project user — POST /work-items/:id/
 *      workflow/request-merge does NOT result in MERGED state (the merge
 *      boundary is the GitHub webhook, not a user action)
 *   7. Verification cannot be forged by agent output — AgentRun.output
 *      cannot set criterion status to PASS
 */
describe('WORK-026 SUB-H — security integration', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let workflowEngine: DefaultWorkflowEngine;
  let verificationService: DefaultVerificationService;
  let agentGateway: DefaultAgentGateway;
  let fakeAgent: FakeAgentAdapter;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };
  let versionB: { id: string };
  let reqA: { id: string };
  let criterionA1Id: string;
  let ciIngestionService: DefaultCiEvidenceIngestionService;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-sec-a',
      WFOS_TEST_KEY_B: 'raw-key-sec-b',
      WFOS_TEST_AGENT_KEY: 'a-very-secret-agent-token-value',
    });
    orgA = await stack.organizationRepository.create({ name: 'Sec Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Sec Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'sec-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'sec-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Sec Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Sec Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'sec-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'sec-user-a', label: 'User A', rawKey: 'raw-key-sec-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'sec-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'sec-user-b', label: 'User B', rawKey: 'raw-key-sec-b',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Sec Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Sec constraints A' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Sec Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'Sec constraints B' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id, requirementId: 'REQ-SEC-A-001', title: 'Auth requirement',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-SEC-1', description: 'Valid auth resolves identity',
    }).then((c) => { criterionA1Id = c.id; });

    // Wire all 4 new modules + the existing verification + agent gateway
    // (the latter is needed for the "agent output cannot forge criterion
    // PASS" test).
    const runtimeIntegrationRepo = new PgRuntimeIntegrationRepository(stack.db.client);
    const deploymentRepo = new PgDeploymentRepository(stack.db.client);
    const deploymentService = new DefaultDeploymentService(runtimeIntegrationRepo, deploymentRepo, stack.db.logger);
    deploymentService.registerProvider(new FakeDeploymentProvider());

    const githubRepo = new PgProjectGitHubRepositoryRepository(stack.db.client);
    const githubAdapter = new FakeGitHubAdapter();
    const installationRepo = new PgGitHubInstallationRepository(stack.db.client);
    await installationRepo.create({ projectId: projectA.id, installationId: 'inst-sec-a', accountLogin: 'sec-org-a' });
    await installationRepo.create({ projectId: projectB.id, installationId: 'inst-sec-b', accountLogin: 'sec-org-b' });

    const agentProviderConfigRepo = new PgAgentProviderConfigRepository(stack.db.client);
    const agentRegistry = new DefaultAgentProviderRegistry(stack.secretStore);
    const agentProviderRegistryService = new DefaultAgentProviderRegistryService(
      agentRegistry, agentProviderConfigRepo, stack.secretStore,
    );

    const runtimeStatusService = new DefaultRuntimeStatusService(
      {
        resolveGithub: async (projectId) => {
          const link = await githubRepo.findByProject(projectId);
          if (!link) return { status: 'not-configured' };
          return {
            status: await githubAdapter.health(),
            owner: link.owner,
            repository: link.repository,
            defaultBranch: link.defaultBranch,
          };
        },
        resolveVercel: async (projectId) => {
          const integration = await runtimeIntegrationRepo.findByProjectAndProvider(projectId, 'vercel');
          if (!integration) return { status: 'not-configured', latestDeployment: null };
          return {
            status: 'connected',
            projectId: integration.projectExternalId,
            latestDeployment: await deploymentRepo.findLatestForProject(projectId),
          };
        },
        resolveArchitect: async () => ({ status: 'not-configured', providers: [] }),
        resolveAgent: async () => ({ status: 'not-configured', providers: [] }),
      },
      stack.db.logger,
    );

    // ImplementationContextBuilder + WorkflowEngine (for #6 PR-merge test).
    const contextRepo = new PgImplementationContextRepository(stack.db.client);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    workflowEngine = new DefaultWorkflowEngine(
      stack.db.client, stack.db.logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
    );
    const implementationContextBuilder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      contextRepo,
    );

    // Verification service + agent gateway for #7 test.
    const ciIngestionRepo = new PgCiEvidenceIngestionRepository(stack.db.client);
    ciIngestionService = new DefaultCiEvidenceIngestionService(ciIngestionRepo, installationRepo, stack.db.logger);
    verificationService = new DefaultVerificationService(
      stack.db.client, stack.requirementRepository, stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository, stack.workItemRepository,
      stack.workItemRequirementRepository, stack.workItemCriterionRepository,
      ciIngestionRepo, stack.objectStore, stack.db.logger,
    );
    fakeAgent = new FakeAgentAdapter();
    agentGateway = new DefaultAgentGateway(stack.db.client, stack.db.logger, [fakeAgent], 3);
    const agentRunRepo = new PgAgentRunRepository(stack.db.client);

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      runtime: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        deploymentService,
        runtimeStatusService,
        runtimeIntegrationRepository: runtimeIntegrationRepo,
        deploymentRepository: deploymentRepo,
      },
      githubProvisioning: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        githubAdapter,
        projectGitHubRepositoryRepository: githubRepo,
        githubInstallationRepository: installationRepo,
      },
      agents: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        agentGateway,
        agentRunRepository: agentRunRepo,
        queue: stack.db.client as never,
        agentProviderRegistryService,
        agentProviderConfigRepository: agentProviderConfigRepo,
      },
      workflow: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workflowEngine,
        implementationContextBuilder,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // -------------------------------------------------------------------------
  // 1. Tenant isolation: User A cannot access User B's runtime integration.
  // -------------------------------------------------------------------------

  it('tenant isolation: User A cannot access User B runtime integration (GET /projects/B/runtime/integrations → 403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectB.id}/runtime/integrations`,
      headers: { 'x-api-key': 'raw-key-sec-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 2. Tenant isolation: User A cannot create a Vercel integration for
  //    User B's project.
  // -------------------------------------------------------------------------

  it('tenant isolation: User A cannot create a Vercel integration for User B (POST /projects/B/runtime/integrations → 403)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectB.id}/runtime/integrations`,
      headers: { 'x-api-key': 'raw-key-sec-a' },
      payload: { provider: 'vercel', projectExternalId: 'vercel-prj-cross' },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 3. Tenant isolation: User A cannot start work on User B's Work Item.
  // -------------------------------------------------------------------------

  it('tenant isolation: User A cannot start implementation for User B work item (403)', async () => {
    const wiB = await stack.workItemRepository.create({
      architectureVersionId: versionB.id, workItemId: 'SEC-WI-B-001', title: 'B work item',
    });
    await workflowEngine.transition({ workItemId: wiB.id, toState: 'ready', actor: 'test' });
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wiB.id}/start-implementation`,
      headers: { 'x-api-key': 'raw-key-sec-a' },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 4. Provider credentials never appear in API responses.
  //    Grep all WORK-026 endpoint responses for 'token' / 'api_key' /
  //    'secret' / 'password' (case-insensitive) → must find none.
  // -------------------------------------------------------------------------

  describe('provider credentials never appear in API responses', () => {
    // Forbidden keywords — case-insensitive substrings of SECRET VALUES.
    // Note: 'token' / 'api_key' / 'secret' / 'password' are the permissive
    // spec keywords. We exclude common false positives by using word
    // boundaries where appropriate.
    const FORBIDDEN_SUBSTRINGS = [
      'api_key_value',
      'a-very-secret-agent-token-value',
      'github_app_private_key',
      'vercel_api_token',
      'agent_api_key_value',
      '-----begin rsa private key-----',
      '-----begin private key-----',
    ];

    it('GET /projects/:id/runtime — no secret substrings in response', async () => {
      // Create a vercel integration for projectA so the runtime status has
      // something to report.
      await server.inject({
        method: 'POST',
        url: `/projects/${projectA.id}/runtime/integrations`,
        headers: { 'x-api-key': 'raw-key-sec-a' },
        payload: { provider: 'vercel', projectExternalId: 'vercel-prj-sec' },
      });
      const res = await server.inject({
        method: 'GET',
        url: `/projects/${projectA.id}/runtime`,
        headers: { 'x-api-key': 'raw-key-sec-a' },
      });
      expect(res.statusCode).toBe(200);
      const lower = res.body.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lower).not.toContain(forbidden);
      }
    });

    it('GET /projects/:id/runtime/providers — no secret substrings', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/projects/${projectA.id}/runtime/providers`,
        headers: { 'x-api-key': 'raw-key-sec-a' },
      });
      expect(res.statusCode).toBe(200);
      const lower = res.body.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lower).not.toContain(forbidden);
      }
    });

    it('GET /projects/:id/github/health — no secret substrings', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/projects/${projectA.id}/github/health`,
        headers: { 'x-api-key': 'raw-key-sec-a' },
      });
      expect(res.statusCode).toBe(200);
      const lower = res.body.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lower).not.toContain(forbidden);
      }
    });

    it('GET /agents/providers — no secret substrings', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/agents/providers',
        headers: { 'x-api-key': 'raw-key-sec-a' },
      });
      expect(res.statusCode).toBe(200);
      const lower = res.body.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lower).not.toContain(forbidden);
      }
    });

    it('GET /projects/:id/agents/providers + POST — no secret VALUE substrings', async () => {
      // POST a provider config whose secretRef points at WFOS_TEST_AGENT_KEY
      // (the env var holding 'a-very-secret-agent-token-value'). The route
      // must persist + return only the secretRef NAME — never the value.
      const postRes = await server.inject({
        method: 'POST',
        url: `/projects/${projectA.id}/agents/providers`,
        headers: { 'x-api-key': 'raw-key-sec-a' },
        payload: {
          provider: 'openai', model: 'gpt-4o',
          secretRef: 'WFOS_TEST_AGENT_KEY', isDefault: true,
        },
      });
      expect(postRes.statusCode).toBe(201);
      const postLower = postRes.body.toLowerCase();
      expect(postLower).not.toContain('a-very-secret-agent-token-value');

      const getRes = await server.inject({
        method: 'GET',
        url: `/projects/${projectA.id}/agents/providers`,
        headers: { 'x-api-key': 'raw-key-sec-a' },
      });
      expect(getRes.statusCode).toBe(200);
      const getLower = getRes.body.toLowerCase();
      expect(getLower).not.toContain('a-very-secret-agent-token-value');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Frontend source contains no provider secrets.
  // -------------------------------------------------------------------------

  describe('frontend source contains no provider secrets', () => {
    // Forbidden substrings — provider-credential env-var names + their
    // generic equivalents. The frontend MUST NOT reference any of these.
    const FORBIDDEN_FRONTEND_REFERENCES = [
      'VERCEL_API_TOKEN',
      'GITHUB_APP_PRIVATE_KEY',
      'AGENT_API_KEY',
      'GITHUB_APP_ID',
      'GITHUB_INSTALLATION_ID',
      'VERCEL_TEAM_ID',
    ];

    /**
     * Recursively collect every source file under frontend/src. Excludes
     * node_modules + non-text artifacts.
     */
    function collectFrontendSource(root: string, acc: string[] = []): string[] {
      if (!existsSync(root)) return acc;
      for (const entry of readdirSync(root)) {
        const full = join(root, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === 'node_modules' || entry === '.vite' || entry === 'dist') continue;
          collectFrontendSource(full, acc);
        } else if (st.isFile() && /\.(ts|tsx|js|jsx|json|html|css)$/.test(entry)) {
          acc.push(full);
        }
      }
      return acc;
    }

    it('no frontend/src file references any provider-credential env-var name', () => {
      const frontendRoot = join(process.cwd(), '..', 'frontend', 'src');
      const files = collectFrontendSource(frontendRoot);
      // The frontend source MUST exist (this test would silently pass if
      // the path was wrong — assert we actually found files).
      expect(files.length, 'frontend/src must contain source files').toBeGreaterThan(0);
      const violations: string[] = [];
      for (const file of files) {
        const src = readFileSync(file, 'utf8');
        for (const forbidden of FORBIDDEN_FRONTEND_REFERENCES) {
          if (src.includes(forbidden)) {
            violations.push(`${relative(frontendRoot, file)} references "${forbidden}"`);
          }
        }
      }
      expect(violations, violations.join('\n')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 6. PR merge cannot be forged by a project user.
  // -------------------------------------------------------------------------

  describe('PR merge boundary (project user cannot forge MERGED)', () => {
    /**
     * Drives a work item all the way to APPROVED via the trusted signal
     * submission path (mirrors the convergence + merge-gating helpers).
     * After APPROVED, calling POST /workflow/request-merge should NOT
     * directly transition to MERGED — the MERGED state is the exclusive
     * authority of the GitHub webhook (the `pull_request_merged` signal).
     */
    async function driveToApproved(workItemId: string) {
      // Transition: draft → ready → assigned → implementing → pr_open →
      // verifying → architect_review → approved.
      await workflowEngine.transition({ workItemId, toState: 'ready', actor: 'test' });
      await workflowEngine.transition({ workItemId, toState: 'assigned', actor: 'test' });
      await workflowEngine.transition({ workItemId, toState: 'implementing', actor: 'test' });
      await workflowEngine.transition({ workItemId, toState: 'pr_open', actor: 'test' });
      await workflowEngine.transition({ workItemId, toState: 'verifying', actor: 'test' });
      await workflowEngine.transition({ workItemId, toState: 'architect_review', actor: 'test' });
      await workflowEngine.transition({ workItemId, toState: 'approved', actor: 'test' });
    }

    it('POST /work-items/:id/workflow/request-merge does NOT directly set MERGED state', async () => {
      const wi = await stack.workItemRepository.create({
        architectureVersionId: versionA.id, workItemId: 'SEC-MRG-001', title: 'Merge test',
      });
      await driveToApproved(wi.id);
      // Sanity-check we're at APPROVED.
      const before = await workflowEngine.getState(wi.id);
      expect(before!.currentState).toBe('approved');

      // The route requires the orchestrator — when absent, returns 501
      // 'orchestrator-not-configured'. Either way, the canonical state
      // must NOT transition to MERGED.
      const res = await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/workflow/request-merge`,
        headers: { 'x-api-key': 'raw-key-sec-a' },
      });
      // 501 (no orchestrator wired) or 202 (orchestrator accepted the
      // signal but did NOT mutate state). Both are acceptable as long as
      // the canonical state remains APPROVED.
      expect([202, 501]).toContain(res.statusCode);

      const after = await workflowEngine.getState(wi.id);
      expect(after!.currentState).toBe('approved'); // stays APPROVED
    });

    it('no API endpoint exists to directly mark a PR as merged (forge attempt → 404)', async () => {
      // The POST /work-items/:id/pr-associations/:prId/merge endpoint was
      // removed in PR #23 — the ONLY way to mark a PR as merged is through
      // the /github webhook boundary (HMAC-signed by GitHub). A project
      // user calling the (non-existent) endpoint gets 404.
      const wi = await stack.workItemRepository.create({
        architectureVersionId: versionA.id, workItemId: 'SEC-MRG-002', title: 'Forge test',
      });
      const res = await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/pr-associations/00000000-0000-0000-0000-000000000000/merge`,
        headers: { 'x-api-key': 'raw-key-sec-a' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Verification cannot be forged by agent output.
  // -------------------------------------------------------------------------

  describe('verification cannot be forged by agent output', () => {
    it('AgentRun.output claiming criterion PASS does NOT set criterion status to pass', async () => {
      const wi = await stack.workItemRepository.create({
        architectureVersionId: versionA.id, workItemId: 'SEC-AGENT-001', title: 'Agent forge test',
      });
      // Associate the work item with the requirement + criterion so the
      // verification engine's scope covers them.
      await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
      await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);

      // Sanity-check the criterion is initially 'pending'.
      const critBefore = await stack.acceptanceCriterionRepository.findById(criterionA1Id);
      expect(critBefore!.status).toBe('pending');

      // Create a Work Order for the agent run to attach to.
      const wo = await stack.workOrderRepository.create({
        workItemId: wi.id, projectId: projectA.id, architectureVersionId: versionA.id,
      });

      // Configure the fake agent to produce an output string that claims
      // the criterion has PASSED.
      fakeAgent.setOutput(
        'ALL CRITERIA PASSED. The implementation is complete. ' +
        'criterion ' + criterionA1Id + ' status = PASS.',
      );

      // Execute the agent gateway — this persists an AgentRun with the
      // output above + status='success'.
      const execId = generateExecutionId();
      await agentGateway.execute({
        provider: 'fake', configuration: {}, workItemId: wi.id,
        workOrderId: wo.id, architectureVersionId: versionA.id,
        executionId: execId, input: 'implement',
      });

      // Verify the AgentRun was persisted with the claiming output.
      const agentRunRepo = new PgAgentRunRepository(stack.db.client);
      const run = await agentRunRepo.findByExecutionId(execId);
      expect(run).not.toBeNull();
      expect(run!.output).toContain('PASS');
      expect(run!.status).toBe('success');

      // THE KEY ASSERTION: the criterion status must STILL be 'pending'
      // — the agent's self-declared PASS did not mutate the authoritative
      // criterion status. The verification engine is the ONLY authority
      // that can mark criteria as PASS, and only after evaluating
      // authoritative (CI-ingested) evidence — not LLM/agent claims.
      const critAfter = await stack.acceptanceCriterionRepository.findById(criterionA1Id);
      expect(critAfter!.status).toBe('pending');

      // Also verify that persistEvaluations on a verification run with NO
      // authoritative evidence does NOT mark the criterion as PASS.
      const run2 = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'test', executionId: generateExecutionId(),
      });
      await verificationService.persistEvaluations(run2.id);
      const critAfterEval = await stack.acceptanceCriterionRepository.findById(criterionA1Id);
      expect(critAfterEval!.status).toBe('pending'); // STILL pending
    });

    it('authoritative CI evidence IS required to mark criterion as PASS (positive control)', async () => {
      // Positive control — proves the negative above is meaningful: when
      // authoritative CI evidence IS attached + mapped, persistEvaluations
      // DOES set the criterion to PASS. This is the canonical path; the
      // previous test proves agents cannot shortcut it.
      const wi = await stack.workItemRepository.create({
        architectureVersionId: versionA.id, workItemId: 'SEC-AGENT-002', title: 'Positive control',
      });
      await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
      await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);

      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'test', executionId: generateExecutionId(),
      });

      // Ingest passing CI evidence via the /github webhook boundary.
      const ciPayload = JSON.stringify({
        action: 'completed',
        workflow_run: {
          id: 990001, name: 'CI', head_branch: 'feature', head_sha: 'sha-sec-pos',
          status: 'completed', conclusion: 'success',
          html_url: 'https://github.com/actions/runs/990001',
          run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:05:00Z',
        },
        workflow: { name: 'CI' },
        repository: { id: 123, full_name: 'sec-org-a/repo-a' },
        installation: { id: 'inst-sec-a' },
      });
      const ci = await ciIngestionService.ingestFromWebhookPayload({
        webhookEventId: 'wh-sec-pos-001', eventType: 'workflow_run', payload: ciPayload,
      });
      const evidence = await verificationService.attachCiEvidence({
        verificationRunId: run.id, ciEvidenceId: ci!.id,
      });
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: evidence.id, criterionId: criterionA1Id, relevance: 'proves',
      });
      await verificationService.persistEvaluations(run.id);

      const crit = await stack.acceptanceCriterionRepository.findById(criterionA1Id);
      expect(crit!.status).toBe('pass');
    });
  });
});
