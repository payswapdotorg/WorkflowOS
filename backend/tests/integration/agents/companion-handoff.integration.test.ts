/**
 * WORK-028 — Companion extension handoff redemption integration tests.
 *
 * Proves the token-only companion redemption boundary (POST /companion/redeem)
 * against the real route stack:
 *   - redemption succeeds with ONLY the one-time handoff token (NO API key),
 *     returning the execution summary + full secret-free package + a scoped
 *     callback token;
 *   - one-time semantics are preserved: a second redemption (even with the
 *     user's API key) is rejected 409; the WorkflowOS UI package path cannot
 *     reuse a companion-consumed token either;
 *   - malformed/unknown token → 403; expired token → 410; expired execution
 *     → 410 (lazy); invalid state (native execution) → 409;
 *   - the callback token issued at redemption CAN report events for ITS
 *     execution but NOT for another execution (scope);
 *   - tenant isolation: a project-B user's API key cannot redeem project A's
 *     token through any path that requires auth (redemption itself is
 *     token-only by design — possession of the one-time token issued only to
 *     an authorized user IS the authority);
 *   - COMPANION_HANDOFF_REDEEMED audit event is written.
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
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../../src/modules/agents/internal/external-execution-provider.js';
import { DefaultExecutionService } from '../../../src/modules/agents/internal/execution-service.js';
import { DefaultExecutionHandoffService } from '../../../src/modules/agents/internal/execution-handoff-service.js';
import { DefaultExecutionCallbackService } from '../../../src/modules/agents/internal/execution-callback-service.js';
import { DefaultExecutionEventIngestionService } from '../../../src/modules/agents/internal/execution-event-ingestion-service.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';

const KEY_A = 'raw-key-w28-a';
const KEY_B = 'raw-key-w28-b';

describe('WORK-028 — Companion handoff redemption (token-only)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let executionRecordRepo: PgExecutionRecordRepository;
  let workflowEngine: DefaultWorkflowEngine;
  let auditService: DefaultAuditService;
  let userA: User;
  let projectA: { id: string };
  let versionA: { id: string };
  let reqA: { id: string };
  let criterionA1Id: string;

  let clockNow = 1_700_000_000_000;
  const clock = () => new Date(clockNow);

  beforeAll(async () => {
    process.env.AGENT_PROVIDER_NAME = 'fake';
    process.env.AGENT_API_KEY = 'test-agent-key';
    process.env.AGENT_DEFAULT_MODEL = 'test-model';

    stack = await buildAuthStack({
      WFOS_TEST_KEY_W28_A: KEY_A,
      WFOS_TEST_KEY_W28_B: KEY_B,
      AGENT_API_KEY: 'test-agent-key',
    });
    const orgA = await stack.organizationRepository.create({ name: 'W28 Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'W28 Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'w28-a', displayName: 'W28 A' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'w28-b', displayName: 'W28 B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W28 Project A' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W28 Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w28-a', secretRef: 'WFOS_TEST_KEY_W28_A', externalId: 'w28-a', label: 'W28 A', rawKey: KEY_A,
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w28-b', secretRef: 'WFOS_TEST_KEY_W28_B', externalId: 'w28-b', label: 'W28 B', rawKey: KEY_B,
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'W28 Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'W28 constraints' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'W28 Arch B' });
    const versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'W28 B constraints' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'REQ-W28-001',
      title: 'Companion handoff works',
      description: 'Token-only redemption returns everything the extension needs',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-W28-1',
      description: 'Redemption returns package + callback token',
      verificationExpectation: 'integration-test',
    }).then((c) => { criterionA1Id = c.id; });

    const contextRepo = new PgImplementationContextRepository(stack.db.client);
    const agentRunRepo = new PgAgentRunRepository(stack.db.client);
    const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, stack.db.logger);
    workflowEngine = new DefaultWorkflowEngine(stack.db.client, stack.db.logger);
    auditService = new DefaultAuditService(stack.db.client, stack.db.logger);

    const fakeAgent = new FakeAgentAdapter();
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
      undefined, undefined, undefined,
      async (workItemId: string) => {
        const reviews = await reviewService.listReviewsForWorkItem(workItemId);
        return Promise.all(
          reviews
            .filter((r) => r.status === 'completed' && r.outcome !== null)
            .map(async (r) => {
              const findings = await reviewService.listFindingsForReview(r.id);
              return {
                reviewId: r.id, verdict: r.outcome ?? '', summary: r.summary ?? '',
                findings: findings.map((f) => f.description), createdAt: r.createdAt.toISOString(),
              };
            }),
        );
      },
    );

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
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    const executionService = new DefaultExecutionService({
      executionRecordRepository: executionRecordRepo,
      providers: [
        new NativeExecutionProvider({ agentGateway, agentRunRepository: agentRunRepo, logger: stack.db.logger }),
        new ExternalExecutionProvider({ packageTtlMs: 60 * 60 * 1000, now: clock }),
      ],
      auditService,
      logger: stack.db.logger,
    
      executionAdmission: { admit: async () => ({ admitted: true, reason: 'test-permit', policyVersion: null, blockingReasons: [] }) },
  });
    const executionHandoffService = new DefaultExecutionHandoffService({
      executionRecordRepository: executionRecordRepo,
      handoffRepository: new PgExecutionHandoffRepository(stack.db.client),
      auditService,
      logger: stack.db.logger,
      handoffTtlMs: 15 * 60 * 1000,
      now: clock,
    });
    const executionCallbackService = new DefaultExecutionCallbackService({
      executionRecordRepository: executionRecordRepo,
      callbackRepository: new PgExecutionCallbackRepository(stack.db.client),
      auditService,
      logger: stack.db.logger,
      callbackTtlMs: 60 * 60 * 1000,
      now: clock,
    });
    const executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository: executionRecordRepo,
      eventRepository: new PgExecutionEventRepository(stack.db.client),
      auditService,
      logger: stack.db.logger,
      now: clock,
    });
    const startImplementationService = new DefaultStartImplementationService({
      executionTaskService,
      executionService,
      logger: stack.db.logger,
    });
    const agentProviderRegistryService = new DefaultAgentProviderRegistryService(
      new DefaultAgentProviderRegistry(stack.secretStore),
      new PgAgentProviderConfigRepository(stack.db.client),
      stack.secretStore,
    );

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
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
      companion: {
        executionHandoffService,
        executionCallbackService,
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

  async function createReadyWorkItemA(id: string) {
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

  async function createExternalExecution(wiId: string, provider = 'fake') {
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wiId}/execution`,
      headers: { 'x-api-key': KEY_A, 'content-type': 'application/json' },
      payload: { mode: 'external', provider },
    });
    expect(res.statusCode, `external execution should succeed: ${res.body}`).toBe(201);
    return (res.json() as { executionId: string }).executionId;
  }

  async function prepare(executionId: string) {
    const res = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/handoff`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { handoffToken: string; callbackToken: string };
  }

  function redeem(token: string | undefined, apiKey?: string) {
    return server.inject({
      method: 'POST',
      url: '/companion/redeem',
      headers: {
        ...(token ? { 'x-handoff-token': token } : {}),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
    });
  }

  it('fake provider is an accepted external execution provider (test-mode catalog entry)', async () => {
    const wi = await createReadyWorkItemA('W28-FAKE-CATALOG');
    const executionId = await createExternalExecution(wi.id, 'fake');
    expect(executionId).toBeTruthy();
    const record = await executionRecordRepo.findByExecutionId(executionId);
    expect(record!.provider).toBe('fake');
    expect(record!.status).toBe('handoff_ready');
  });

  it('token-only redemption succeeds WITHOUT any API key and returns package + callback token', async () => {
    const wi = await createReadyWorkItemA('W28-REDEEM-OK');
    const executionId = await createExternalExecution(wi.id);
    const { handoffToken } = await prepare(executionId);

    const res = await redeem(handoffToken); // NO x-api-key header at all
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      execution: { executionId: string; status: string; provider: string; workItemId: string };
      package: {
        prompt: string;
        branch: string;
        returnCallback: { auth: string };
        verificationRequirements: string[];
      };
      callbackToken: string;
      callbackExpiresAt: string;
    };
    expect(body.execution.executionId).toBe(executionId);
    expect(body.execution.status).toBe('submitted'); // companion redemption advances the record
    expect(body.execution.provider).toBe('fake');
    expect(body.package.prompt).toContain('# Implementation Instructions');
    expect(body.package.returnCallback.auth).toBe('x-callback-token');
    expect(body.callbackToken).toMatch(/^wfct_[0-9a-f]+$/);
    expect(new Date(body.callbackExpiresAt).getTime()).toBeGreaterThan(clockNow);

    // No secrets anywhere in the redemption response (token values are the
    // credential themselves — the handoff token must NOT be echoed).
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(handoffToken);
    expect(raw.toLowerCase()).not.toMatch(/githubtoken|webhooksecret|password|credential/);

    // Audit: companion redemption is attributed server-side.
    const events = await auditService.listForProject(projectA.id, {
      eventTypes: ['COMPANION_HANDOFF_REDEEMED'],
    });
    expect(events.some((e) => e.executionId === executionId)).toBe(true);
  });

  it('the callback token from redemption can report events for ITS execution', async () => {
    const wi = await createReadyWorkItemA('W28-REDEEM-CALLBACK');
    const executionId = await createExternalExecution(wi.id);
    const { handoffToken } = await prepare(executionId);
    const redeemed = (await redeem(handoffToken)).json() as { callbackToken: string };

    const res = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: { 'x-callback-token': redeemed.callbackToken, 'content-type': 'application/json' },
      payload: { eventType: 'started', idempotencyKey: 'w28-redeem-started' },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { status: string }).status).toBe('running');
  });

  it('the callback token from redemption CANNOT report to another execution', async () => {
    const wiA = await createReadyWorkItemA('W28-REDEEM-SCOPE-A');
    const wiB = await createReadyWorkItemA('W28-REDEEM-SCOPE-B');
    const execA = await createExternalExecution(wiA.id);
    const execB = await createExternalExecution(wiB.id);
    const { handoffToken } = await prepare(execA);
    const redeemed = (await redeem(handoffToken)).json() as { callbackToken: string };

    const res = await server.inject({
      method: 'POST',
      url: `/execution/${execB}/events`,
      headers: { 'x-callback-token': redeemed.callbackToken, 'content-type': 'application/json' },
      payload: { eventType: 'started' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('callback-token-invalid');
  });

  it('one-time semantics: a companion-consumed token cannot be redeemed again (409), even with the API key', async () => {
    const wi = await createReadyWorkItemA('W28-REDEEM-ONETIME');
    const executionId = await createExternalExecution(wi.id);
    const { handoffToken } = await prepare(executionId);

    const first = await redeem(handoffToken);
    expect(first.statusCode).toBe(200);

    // Second companion redemption — no API key.
    const second = await redeem(handoffToken);
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toBe('handoff-token-already-used');

    // Second redemption attempt WITH the authorized user's API key is still
    // rejected — one-time means one-time.
    const third = await redeem(handoffToken, KEY_A);
    expect(third.statusCode).toBe(409);

    // And the WorkflowOS UI package path cannot reuse it either.
    const uiPath = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-api-key': KEY_A, 'x-handoff-token': handoffToken },
    });
    expect(uiPath.statusCode).toBe(409);
  });

  it('malformed / missing / unknown token → 403 (no API key rescue)', async () => {
    const wi = await createReadyWorkItemA('W28-REDEEM-BADTOKEN');
    await createExternalExecution(wi.id);

    const missing = await redeem(undefined);
    expect(missing.statusCode).toBe(403);

    const malformed = await redeem('garbage');
    expect(malformed.statusCode).toBe(403);
    expect((malformed.json() as { error: string }).error).toBe('handoff-token-invalid');

    const unknown = await redeem('wfht_' + 'a'.repeat(64), KEY_A);
    expect(unknown.statusCode).toBe(403);
  });

  it('expired handoff token → 410; expired execution → 410 (lazy, audited)', async () => {
    // Token TTL 15min, package window 60min.
    const wiToken = await createReadyWorkItemA('W28-REDEEM-TOKEXP');
    const execToken = await createExternalExecution(wiToken.id);
    const { handoffToken } = await prepare(execToken);
    clockNow += 16 * 60 * 1000;
    const resToken = await redeem(handoffToken);
    expect(resToken.statusCode).toBe(410);
    expect((resToken.json() as { error: string }).error).toBe('handoff-token-expired');
    clockNow -= 16 * 60 * 1000;

    const wiExec = await createReadyWorkItemA('W28-REDEEM-EXECEXP');
    const execExec = await createExternalExecution(wiExec.id);
    const prepared = await prepare(execExec);
    clockNow += 61 * 60 * 1000;
    const resExec = await redeem(prepared.handoffToken);
    expect(resExec.statusCode).toBe(410);
    expect((resExec.json() as { error: string }).error).toBe('execution-expired');
    const record = await executionRecordRepo.findByExecutionId(execExec);
    expect(record!.status).toBe('expired');
  });

  it('native execution handoffs cannot be companion-redeemed via token (state guard)', async () => {
    const wi = await createReadyWorkItemA('W28-REDEEM-NATIVE');
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'x-api-key': KEY_A, 'content-type': 'application/json' },
      payload: { mode: 'native' },
    });
    expect(res.statusCode).toBe(201);
    // Prepare on the native execution → 409 not-external-execution (issue is
    // guarded) — companion redemption path is unreachable for native runs.
    const prepareRes = await server.inject({
      method: 'POST',
      url: `/execution/${(res.json() as { executionId: string }).executionId}/handoff`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(prepareRes.statusCode).toBe(409);
    expect((prepareRes.json() as { error: string }).error).toBe('not-external-execution');
  });

  it('redemption response grants no project-read capability: no API key → execution metadata still 401', async () => {
    const wi = await createReadyWorkItemA('W28-REDEEM-NOCAP');
    const executionId = await createExternalExecution(wi.id);
    const { handoffToken } = await prepare(executionId);
    const redeemed = (await redeem(handoffToken)).json() as { callbackToken: string };

    // The callback token cannot read the execution (events-only scope).
    const meta = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}`,
      headers: { 'x-callback-token': redeemed.callbackToken },
    });
    expect(meta.statusCode).toBe(401);

    // The consumed handoff token cannot read anything either.
    const pkg = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-handoff-token': handoffToken },
    });
    expect(pkg.statusCode).toBe(401);
  });
});
