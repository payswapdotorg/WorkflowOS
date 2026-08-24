/**
 * WORK-027 — Execution provider abstraction integration tests.
 *
 * Proves, against a REAL database + the REAL route stack:
 *
 *   1. NATIVE execution through the new provider abstraction:
 *      POST /work-items/:id/execution {mode:'native'} → 201 + agentRunId +
 *      execution record 'completed' + AgentRun persisted (existing AgentGateway
 *      behavior intact).
 *   2. EXTERNAL execution: POST …/execution {mode:'external', provider:'zai'}
 *      → 201 'handoff-ready' + SAFE metadata only (no package in the response).
 *   3. Secure handoff: issue token → redeem package (prompt, repository,
 *      branch suggestion, return callback) → replay rejected (409) →
 *      expired token rejected (410) → lazy execution expiry (410).
 *   4. External result ingestion: started→running, progress, completed→
 *      completed (+ benchmark metadata), native events rejected (409),
 *      idempotency, invalid states rejected.
 *   5. PROMPT DETERMINISM (§12): two executions on the same work item
 *      (revision 1 'initial' native + revision 2 'correction' external with a
 *      non-empty priorAgentRuns list) produce the SAME promptDigest — the
 *      prompt is a pure function of the §11 fields.
 *   6. Registry: GET /agents/execution-providers returns the catalog with
 *      native/external capability split; unsupported external provider → 400.
 *   7. Audit: EXECUTION_CREATED / EXECUTION_HANDOFF_READY / EXECUTION_STARTED /
 *      EXECUTION_COMPLETED / EXECUTION_EXPIRED events are written via /audit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultStartImplementationService } from '../../../src/modules/work-items/internal/start-implementation-service.js';
import { DefaultExecutionPromptBuilder } from '../../../src/modules/work-items/internal/execution-prompt-builder.js';
import { DefaultExecutionTaskService } from '../../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { PgAgentProviderConfigRepository } from '../../../src/modules/agents/internal/pg-agent-provider-config-repository.js';
import { DefaultAgentProviderRegistryService } from '../../../src/modules/agents/internal/agent-provider-registry-service.js';
import { DefaultAgentProviderRegistry } from '../../../src/platform/default-agent-provider-registry.js';
import {
  PgExecutionRecordRepository,
  PgExecutionEventRepository,
  PgExecutionHandoffRepository,
  PgExecutionCallbackRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { DefaultExecutionCallbackService } from '../../../src/modules/agents/internal/execution-callback-service.js';
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../../src/modules/agents/internal/external-execution-provider.js';
import { DefaultExecutionService } from '../../../src/modules/agents/internal/execution-service.js';
import { DefaultExecutionHandoffService } from '../../../src/modules/agents/internal/execution-handoff-service.js';
import { DefaultExecutionEventIngestionService } from '../../../src/modules/agents/internal/execution-event-ingestion-service.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

describe('WORK-027 — execution provider abstraction', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let executionRecordRepo: PgExecutionRecordRepository;
  let workflowEngine: DefaultWorkflowEngine;
  let auditService: DefaultAuditService;
  let fakeAgent: FakeAgentAdapter;
  let orgA: { id: string };
  let userA: User;
  let projectA: { id: string };
  let versionA: { id: string };
  let reqA: { id: string };
  let criterionA1Id: string;

  // Injectable clock shared by the external provider + handoff service so
  // TTL behaviour is tested deterministically (no sleeps).
  let clockNow = 1_700_000_000_000;
  const clock = () => new Date(clockNow);

  const API_KEY = 'raw-key-exec-a';

  beforeAll(async () => {
    process.env.AGENT_PROVIDER_NAME = 'fake';
    process.env.AGENT_API_KEY = 'test-agent-key';
    process.env.AGENT_DEFAULT_MODEL = 'test-model';

    stack = await buildAuthStack({
      WFOS_TEST_KEY_EXEC_A: API_KEY,
      AGENT_API_KEY: 'test-agent-key',
    });
    orgA = await stack.organizationRepository.create({ name: 'Exec Org A' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'exec-user-a', displayName: 'Exec User A' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Exec Project A' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'exec-key-a', secretRef: 'WFOS_TEST_KEY_EXEC_A', externalId: 'exec-user-a', label: 'Exec User A', rawKey: API_KEY,
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Exec Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Exec constraints A' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

    reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'REQ-EXEC-A-001',
      title: 'Auth works',
      description: 'Valid auth resolves identity',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-EXEC-1',
      description: 'Valid auth resolves identity',
      verificationExpectation: 'integration-test',
    }).then((c) => { criterionA1Id = c.id; });

    const contextRepo = new PgImplementationContextRepository(stack.db.client);
    const agentRunRepo = new PgAgentRunRepository(stack.db.client);
    const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, stack.db.logger);
    workflowEngine = new DefaultWorkflowEngine(stack.db.client, stack.db.logger);
    auditService = new DefaultAuditService(stack.db.client, stack.db.logger);

    fakeAgent = new FakeAgentAdapter();
    const agentGateway = new DefaultAgentGateway(stack.db.client, stack.db.logger, [fakeAgent], 3);

    const builder = new DefaultImplementationContextBuilder(
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
      undefined,
      undefined,
      undefined,
      async (workItemId: string) => {
        const reviews = await reviewService.listReviewsForWorkItem(workItemId);
        return Promise.all(
          reviews
            .filter((r) => r.status === 'completed' && r.outcome !== null)
            .map(async (r) => {
              const findings = await reviewService.listFindingsForReview(r.id);
              return {
                reviewId: r.id,
                verdict: r.outcome ?? '',
                summary: r.summary ?? '',
                findings: findings.map((f) => f.description),
                createdAt: r.createdAt.toISOString(),
              };
            }),
        );
      },
    );

    // WORK-027: execution provider abstraction wiring (mirrors app.ts).
    const executionTaskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder: builder,
      contextRepository: contextRepo,
      promptBuilder: new DefaultExecutionPromptBuilder(),
      logger: stack.db.logger,
    });
    const nativeExecutionProvider = new NativeExecutionProvider({
      agentGateway,
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
    });
    // Package TTL 60min — LONGER than the handoff token TTL (15min) so the
    // tests can distinguish token expiry from package expiry.
    const externalExecutionProvider = new ExternalExecutionProvider({
      packageTtlMs: 60 * 60 * 1000,
      now: clock,
    });
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    const executionEventRepo = new PgExecutionEventRepository(stack.db.client);
    const executionHandoffRepo = new PgExecutionHandoffRepository(stack.db.client);
    const executionService = new DefaultExecutionService({
      executionRecordRepository: executionRecordRepo,
      providers: [nativeExecutionProvider, externalExecutionProvider],
      auditService,
      logger: stack.db.logger,
    });
    const executionHandoffService = new DefaultExecutionHandoffService({
      executionRecordRepository: executionRecordRepo,
      handoffRepository: executionHandoffRepo,
      auditService,
      logger: stack.db.logger,
      handoffTtlMs: 15 * 60 * 1000,
      now: clock,
    });
    // PR #30 review fix #2: callback TTL 10min < package TTL 60min so tests
    // can distinguish token expiry from execution-window expiry.
    const executionCallbackService = new DefaultExecutionCallbackService({
      executionRecordRepository: executionRecordRepo,
      callbackRepository: new PgExecutionCallbackRepository(stack.db.client),
      auditService,
      logger: stack.db.logger,
      callbackTtlMs: 10 * 60 * 1000,
      now: clock,
    });
    const executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository: executionRecordRepo,
      eventRepository: executionEventRepo,
      auditService,
      logger: stack.db.logger,
      now: clock,
    });
    const startImplementationService = new DefaultStartImplementationService({
      executionTaskService,
      executionService,
      logger: stack.db.logger,
    });

    const agentProviderConfigRepository = new PgAgentProviderConfigRepository(stack.db.client);
    const agentProviderRegistry = new DefaultAgentProviderRegistry(stack.secretStore);
    const agentProviderRegistryService = new DefaultAgentProviderRegistryService(
      agentProviderRegistry,
      agentProviderConfigRepository,
      stack.secretStore,
    );

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: {
        authProvider: stack.authProvider,
        userRepository: stack.userRepository,
      },
      workflow: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workflowEngine,
        implementationContextBuilder: builder,
        startImplementationService,
        executionTaskService,
        executionService,
        agentProviderRegistryService,
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
        agentProviderConfigRepository,
      },
      execution: {
        authorizationService: stack.authorizationService,
        workItemRepository: stack.workItemRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        executionRecordRepository: executionRecordRepo,
        executionHandoffService,
        executionCallbackService,
        executionEventIngestionService,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
    delete process.env.AGENT_PROVIDER_NAME;
    delete process.env.AGENT_API_KEY;
    delete process.env.AGENT_DEFAULT_MODEL;
  });

  async function createReadyWorkItem(id: string) {
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: id,
      title: id,
      objective: `Objective for ${id}`,
      scope: `Scope for ${id}`,
    });
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    await stack.workItemCriterionRepository.associate(wi.id, criterionA1Id);
    await stack.workOrderRepository.create({
      workItemId: wi.id,
      projectId: projectA.id,
      architectureVersionId: versionA.id,
      scope: `Scope for ${id}`,
      outOfScope: 'Nothing',
      architectureConstraints: 'None',
      verificationRequirements: ['All tests pass'],
    });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });
    return wi;
  }

  // ------------------------------------------------------------------
  // 1. NATIVE execution through the new abstraction
  // ------------------------------------------------------------------

  it('POST /work-items/:id/execution (native) → 201 completed + agentRunId + execution record + AgentRun persisted', async () => {
    const wi = await createReadyWorkItem('EXEC-NATIVE-001');
    const baselineCalls = fakeAgent.getCallCount();

    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { mode: 'native' }, // provider/model default from the registry
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      executionId: string; mode: string; provider: string; status: string;
      agentRunId: string; implementationContextId: string; revision: number;
    };
    expect(body.mode).toBe('native');
    expect(body.status).toBe('completed');
    expect(body.agentRunId).toBeTruthy();
    expect(body.revision).toBe(1);
    // AgentGateway invoked exactly once (single native path).
    expect(fakeAgent.getCallCount()).toBe(baselineCalls + 1);
    // AgentRun persisted.
    const run = await new PgAgentRunRepository(stack.db.client).findById(body.agentRunId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('success');
    expect(run!.executionId).toBe(body.executionId);
    // Execution record persisted + completed + benchmark metadata.
    const record = await executionRecordRepo.findByExecutionId(body.executionId);
    expect(record).not.toBeNull();
    expect(record!.mode).toBe('native');
    expect(record!.status).toBe('completed');
    expect(record!.agentRunId).toBe(body.agentRunId);
    expect(record!.benchmarkMetadata).toMatchObject({
      mode: 'native',
      provider: 'fake',
      model: 'test-model',
    });
    expect(typeof record!.promptDigest).toBe('string');
    expect(record!.promptDigest).toHaveLength(64);
    // The workflow state is UNCHANGED (execution never mutates workflow).
    const wf = await workflowEngine.getState(wi.id);
    expect(wf!.currentState).toBe('ready');
  });

  it('native execution without a Work Order fails loudly (no silent success)', async () => {
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: 'EXEC-NOORDER-001',
      title: 'No order',
      objective: 'No order',
      scope: 'No order',
    });
    await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { mode: 'native' },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toBe('agent-gateway-failed');
  });

  // ------------------------------------------------------------------
  // 2. EXTERNAL execution
  // ------------------------------------------------------------------

  it('POST /work-items/:id/execution (external, zai) → 201 handoff-ready + SAFE metadata (no package)', async () => {
    const wi = await createReadyWorkItem('EXEC-EXT-001');

    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { mode: 'external', provider: 'zai' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      executionId: string; mode: string; provider: string; status: string;
      agentRunId: string | null; expiresAt: string;
    };
    expect(body.mode).toBe('external');
    expect(body.provider).toBe('zai');
    // §8 defines the execution state names ('handoff_ready'); §6's example
    // ('handoff-ready') is illustrative — the canonical state is snake_case.
    expect(body.status).toBe('handoff_ready');
    expect(body.agentRunId).toBeNull();
    expect(body.expiresAt).toBeTruthy();
    // SAFE metadata only — no package/token material in the create response.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/prompt/i);
    expect(raw).not.toMatch(/token/i);

    // The record carries the package server-side.
    const record = await executionRecordRepo.findByExecutionId(body.executionId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe('handoff_ready');
    expect(record!.packageValue).not.toBeNull();
    // Workflow state still unchanged.
    const wf = await workflowEngine.getState(wi.id);
    expect(wf!.currentState).toBe('ready');
  });

  it('external execution with a non-catalog provider → 400 external-provider-not-supported', async () => {
    const wi = await createReadyWorkItem('EXEC-EXT-BADPROVIDER');
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { mode: 'external', provider: 'not-a-catalog-provider' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('external-provider-not-supported');
  });

  it('execution from a non-ready workflow state → 400 invalid-state', async () => {
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: 'EXEC-DRAFT-001',
      title: 'Draft',
      objective: 'Draft',
      scope: 'Draft',
    });
    // Materialize the workflow execution row (starts in 'draft').
    await workflowEngine.getOrCreate(wi.id);
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { mode: 'external', provider: 'zai' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; currentState: string | null };
    expect(body.error).toBe('invalid-state');
    expect(body.currentState).toBe('draft');
  });

  // ------------------------------------------------------------------
  // 3. Secure handoff (one-time, short-lived, authenticated)
  // ------------------------------------------------------------------

  it('handoff lifecycle: issue → redeem package → replay rejected (409)', async () => {
    const wi = await createReadyWorkItem('EXEC-HANDOFF-001');
    const created = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'external', provider: 'zai' },
      })
    ).json() as { executionId: string };

    // No token → 403.
    const noToken = await server.inject({
      method: 'GET',
      url: `/execution/${created.executionId}/package`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(noToken.statusCode).toBe(403);

    // Issue a one-time token.
    const issue = await server.inject({
      method: 'POST',
      url: `/execution/${created.executionId}/handoff`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(issue.statusCode).toBe(201);
    const { handoffToken, expiresAt } = issue.json() as {
      handoffToken: string; expiresAt: string;
    };
    expect(handoffToken).toMatch(/^wfht_[0-9a-f]+$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(clockNow);

    // Malformed token → 403.
    const malformed = await server.inject({
      method: 'GET',
      url: `/execution/${created.executionId}/package`,
      headers: { 'x-api-key': API_KEY, 'x-handoff-token': 'garbage' },
    });
    expect(malformed.statusCode).toBe(403);
    expect((malformed.json() as { error: string }).error).toBe('handoff-token-invalid');

    // Redeem → full package.
    const redeem = await server.inject({
      method: 'GET',
      url: `/execution/${created.executionId}/package`,
      headers: { 'x-api-key': API_KEY, 'x-handoff-token': handoffToken },
    });
    expect(redeem.statusCode).toBe(200);
    const body = redeem.json() as {
      executionId: string;
      status: string;
      package: {
        mode: string; provider: string; workItemLabel: string;
        repository: { owner: string | null; name: string | null; url: string | null };
        branch: string; prompt: string;
        structuredInstructions: string[];
        verificationRequirements: string[];
        returnCallback: { eventsPath: string };
        expiration: string;
      };
    };
    expect(body.status).toBe('submitted');
    expect(body.package.mode).toBe('external');
    expect(body.package.workItemLabel).toBe('EXEC-HANDOFF-001');
    expect(body.package.branch).toBe('feat/exec-handoff-001');
    expect(body.package.prompt).toContain('# Implementation Instructions — EXEC-HANDOFF-001');
    expect(body.package.prompt).toContain('## Objective');
    expect(body.package.prompt).toContain('### 1. Auth works');
    expect(body.package.prompt).toContain('## Verification Requirements');
    expect(body.package.verificationRequirements).toEqual(['All tests pass']);
    expect(body.package.returnCallback.eventsPath).toBe(`/execution/${created.executionId}/events`);
    // NO secrets of any kind in the package.
    const pkgRaw = JSON.stringify(body.package).toLowerCase();
    expect(pkgRaw).not.toMatch(/githubtoken|api_?key|webhooksecret|access[_-]?token|password|credential/);

    // Replay the SAME one-time token → 409.
    const replay = await server.inject({
      method: 'GET',
      url: `/execution/${created.executionId}/package`,
      headers: { 'x-api-key': API_KEY, 'x-handoff-token': handoffToken },
    });
    expect(replay.statusCode).toBe(409);
    expect((replay.json() as { error: string }).error).toBe('handoff-token-already-used');

    // Re-prepare: a fresh token still works (record already 'submitted').
    const reissue = await server.inject({
      method: 'POST',
      url: `/execution/${created.executionId}/handoff`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(reissue.statusCode).toBe(201);
    const reissueBody = reissue.json() as { handoffToken: string };
    const redeem2 = await server.inject({
      method: 'GET',
      url: `/execution/${created.executionId}/package`,
      headers: { 'x-api-key': API_KEY, 'x-handoff-token': reissueBody.handoffToken },
    });
    expect(redeem2.statusCode).toBe(200);
  });

  it('expired handoff token → 410 (deterministic clock)', async () => {
    const wi = await createReadyWorkItem('EXEC-HANDOFF-EXP');
    const created = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'external', provider: 'chatgpt' },
      })
    ).json() as { executionId: string };

    const issue = await server.inject({
      method: 'POST',
      url: `/execution/${created.executionId}/handoff`,
      headers: { 'x-api-key': API_KEY },
    });
    const { handoffToken } = issue.json() as { handoffToken: string };

    // Advance the clock past the handoff TTL (15min) but BEFORE the package
    // TTL (60min) → handoff-token-expired specifically.
    clockNow += 16 * 60 * 1000;

    const redeem = await server.inject({
      method: 'GET',
      url: `/execution/${created.executionId}/package`,
      headers: { 'x-api-key': API_KEY, 'x-handoff-token': handoffToken },
    });
    expect(redeem.statusCode).toBe(410);
    expect((redeem.json() as { error: string }).error).toBe('handoff-token-expired');
  });

  it('expired external execution → 410 execution-expired + record flips to expired + audited', async () => {
    const wi = await createReadyWorkItem('EXEC-PKG-EXP');
    const created = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'external', provider: 'claude' },
      })
    ).json() as { executionId: string };

    // Advance past the package TTL (60min).
    clockNow += 61 * 60 * 1000;

    const issue = await server.inject({
      method: 'POST',
      url: `/execution/${created.executionId}/handoff`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(issue.statusCode).toBe(410);
    expect((issue.json() as { error: string }).error).toBe('execution-expired');

    const record = await executionRecordRepo.findByExecutionId(created.executionId);
    expect(record!.status).toBe('expired');

    // Audited via /audit.
    const events = await auditService.listForProject(projectA.id, {
      eventTypes: ['EXECUTION_EXPIRED'],
    });
    expect(events.some((e) => e.executionId === created.executionId)).toBe(true);
  });

  // ------------------------------------------------------------------
  // 4. External result ingestion
  // ------------------------------------------------------------------

  it('event lifecycle: started → running, progress, completed → completed + benchmark metadata', async () => {
    const wi = await createReadyWorkItem('EXEC-EVENTS-001');
    const created = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'external', provider: 'zai' },
      })
    ).json() as { executionId: string };
    const executionId = created.executionId;

    const post = (payload: Record<string, unknown>) =>
      server.inject({
        method: 'POST',
        url: `/execution/${executionId}/events`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload,
      });

    // started → running.
    const started = await post({ eventType: 'started', externalSessionRef: 'zai-session-1' });
    expect(started.statusCode).toBe(202);
    expect((started.json() as { status: string }).status).toBe('running');

    // progress → no state change.
    const progress = await post({ eventType: 'progress', output: 'Halfway done' });
    expect(progress.statusCode).toBe(202);
    expect((progress.json() as { status: string }).status).toBe('running');

    // completed → completed + reported observations as benchmark metadata ONLY.
    const completed = await post({
      eventType: 'completed',
      commitRef: 'abc123',
      branch: 'feat/exec-events-001',
      pullRequestRef: 'github:workflowos/repo#7',
      testSummary: { pass: 10, fail: 0, skip: 1 },
    });
    expect(completed.statusCode).toBe(202);
    expect((completed.json() as { status: string }).status).toBe('completed');

    const record = await executionRecordRepo.findByExecutionId(executionId);
    expect(record!.status).toBe('completed');
    expect(record!.externalSessionRef).toBe('zai-session-1');
    expect(record!.benchmarkMetadata).toMatchObject({
      reportedCommitRef: 'abc123',
      reportedPullRequestRef: 'github:workflowos/repo#7',
    });

    // Terminal: further events rejected.
    const after = await post({ eventType: 'started' });
    expect(after.statusCode).toBe(409);
    expect((after.json() as { error: string }).error).toBe('invalid-execution-state');

    // The workflow state was NEVER mutated by ingestion.
    const wf = await workflowEngine.getState(wi.id);
    expect(wf!.currentState).toBe('ready');
  });

  it('idempotencyKey dedupes events without re-applying effects', async () => {
    const wi = await createReadyWorkItem('EXEC-EVENTS-IDEM');
    const created = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'external', provider: 'zai' },
      })
    ).json() as { executionId: string };

    const first = await server.inject({
      method: 'POST',
      url: `/execution/${created.executionId}/events`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { eventType: 'started', idempotencyKey: 'idem-1' },
    });
    expect(first.statusCode).toBe(202);
    expect((first.json() as { duplicate: boolean }).duplicate).toBe(false);

    const dup = await server.inject({
      method: 'POST',
      url: `/execution/${created.executionId}/events`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { eventType: 'completed', idempotencyKey: 'idem-1' },
    });
    expect(dup.statusCode).toBe(202);
    expect((dup.json() as { duplicate: boolean; status: string }).duplicate).toBe(true);
    // The duplicate did NOT complete the execution.
    const record = await executionRecordRepo.findByExecutionId(created.executionId);
    expect(record!.status).toBe('running');
  });

  it('native executions reject external events (single authority over native run state)', async () => {
    const wi = await createReadyWorkItem('EXEC-EVENTS-NATIVE');
    const created = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'native' },
      })
    ).json() as { executionId: string };

    const res = await server.inject({
      method: 'POST',
      url: `/execution/${created.executionId}/events`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { eventType: 'started' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('native-execution-events-not-allowed');
  });

  it('invalid event type → 400', async () => {
    const wi = await createReadyWorkItem('EXEC-EVENTS-BADTYPE');
    const created = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'external', provider: 'zai' },
      })
    ).json() as { executionId: string };

    const res = await server.inject({
      method: 'POST',
      url: `/execution/${created.executionId}/events`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { eventType: 'declared-merged' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ------------------------------------------------------------------
  // 5. Prompt determinism (§12)
  // ------------------------------------------------------------------

  it('determinism: native (rev 1 initial) + external (rev 2 correction) executions produce the SAME promptDigest', async () => {
    const wi = await createReadyWorkItem('EXEC-DETERM-001');

    // First execution: NATIVE → context revision 1, kind 'initial'.
    const native = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'native' },
      })
    ).json() as { executionId: string; revision: number; kind: string };

    // Second execution: EXTERNAL → context revision 2, kind 'correction'
    // (prior context exists) and priorAgentRuns now includes the native run —
    // yet the deterministic prompt (§11 fields only) must be IDENTICAL.
    const external = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'external', provider: 'zai' },
      })
    ).json() as { executionId: string; revision: number; kind: string };

    expect(native.revision).toBe(1);
    expect(native.kind).toBe('initial');
    expect(external.revision).toBe(2);
    expect(external.kind).toBe('correction');

    const nativeRecord = await executionRecordRepo.findByExecutionId(native.executionId);
    const externalRecord = await executionRecordRepo.findByExecutionId(external.executionId);
    expect(nativeRecord!.promptDigest).toBe(externalRecord!.promptDigest);
    expect(nativeRecord!.prompt).toBe(externalRecord!.prompt);
  });

  // ------------------------------------------------------------------
  // 6. Provider registry capability surface
  // ------------------------------------------------------------------

  it('GET /agents/execution-providers returns catalog with native/external capabilities', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/agents/execution-providers',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const { providers } = res.json() as {
      providers: Array<{
        name: string; provider: string; model: string;
        nativeApi: string; externalUi: string;
      }>;
    };
    const zai = providers.find((p) => p.provider === 'zai');
    const chatgpt = providers.find((p) => p.provider === 'chatgpt');
    const claude = providers.find((p) => p.provider === 'claude');
    expect(zai).toMatchObject({ name: 'Z.ai', nativeApi: 'not-configured', externalUi: 'available' });
    expect(chatgpt).toMatchObject({ name: 'ChatGPT', externalUi: 'available' });
    expect(claude).toMatchObject({ name: 'Claude', externalUi: 'available' });
    // WORK-028: 'fake' is now ALSO in the external catalog (test-mode
    // external provider claimed by the Companion extension's fake adapter).
    const fake = providers.find((p) => p.provider === 'fake');
    expect(fake).toMatchObject({ nativeApi: 'ready', externalUi: 'available' });
  });

  // WORK-030 (PR #33 review): surface capabilities — implementation Work
  // Orders must run on the provider's CODING surface where required.
  it('execution providers expose surface capabilities (conversational-chat vs coding-agent)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/agents/execution-providers',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const providers = (res.json() as { providers: Array<{ provider: string; capabilities?: unknown }> }).providers;
    const zai = providers.find((p) => p.provider === 'zai');
    expect(zai?.capabilities).toEqual({
      conversationalChat: 'ready',
      codingAgent: 'unverified',
      implementationSurface: 'conversational-chat',
    });
    const chatgpt = providers.find((p) => p.provider === 'chatgpt');
    expect(chatgpt?.capabilities).toEqual({
      conversationalChat: 'ready',
      // 'unverified' until a live signed-in verification pass — fixture-only
      // proof is deliberately insufficient (PR #33 review).
      codingAgent: 'unverified',
      implementationSurface: 'coding-agent',
    });
    const fakeProvider = providers.find((p) => p.provider === 'fake');
    expect(
      (fakeProvider?.capabilities as { implementationSurface?: string } | undefined)
        ?.implementationSurface,
    ).toBe('conversational-chat');
  });

  // ------------------------------------------------------------------
  // 7. Listing + audit
  // ------------------------------------------------------------------

  it('GET /work-items/:id/executions lists safe execution metadata', async () => {
    const wi = await createReadyWorkItem('EXEC-LIST-001');
    await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { mode: 'external', provider: 'zai' },
    });
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${wi.id}/executions`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const { executions } = res.json() as { executions: Array<{ executionId: string; status: string; mode: string }> };
    expect(executions.length).toBe(1);
    expect(executions[0]!.mode).toBe('external');
    expect(executions[0]!.status).toBe('handoff_ready');
    // Safe metadata only.
    expect(JSON.stringify(executions[0])).not.toMatch(/prompt"\s*:/i);
  });

  it('execution lifecycle emits audit events via /audit', async () => {
    const wi = await createReadyWorkItem('EXEC-AUDIT-001');
    const created = (
      await server.inject({
        method: 'POST',
        url: `/work-items/${wi.id}/execution`,
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { mode: 'external', provider: 'zai' },
      })
    ).json() as { executionId: string };

    await server.inject({
      method: 'POST',
      url: `/execution/${created.executionId}/events`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { eventType: 'started' },
    });

    const events = await auditService.listForProject(projectA.id, {});
    const types = events
      .filter((e) => e.executionId === created.executionId)
      .map((e) => e.eventType);
    expect(types).toContain('EXECUTION_CREATED');
    expect(types).toContain('EXECUTION_HANDOFF_READY');
    expect(types).toContain('EXECUTION_STARTED');
  });
});
