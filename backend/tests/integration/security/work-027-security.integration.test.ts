/**
 * WORK-027 — Execution security integration tests.
 *
 * Proves the external-handoff security requirements (§7 + §17):
 *   - user A cannot inspect/prepare/event user B's execution (403),
 *   - the external package NEVER crosses project boundaries — a stolen
 *     one-time token alone is insufficient (project auth runs FIRST),
 *   - malformed token → 403; expired → 410; replayed one-time token → 409,
 *   - unauthenticated access → 401,
 *   - the package response contains NO secret-shaped keys at any depth.
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
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import { PgCiEvidenceIngestionRepository } from '../../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { DefaultCiEvidenceIngestionService } from '../../../src/modules/github/internal/ci-evidence-ingestion-service.js';
import { PgGitHubInstallationRepository } from '../../../src/modules/github/internal/pg-github-repository.js';
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

const KEY_A = 'raw-key-w27-sec-a';
const KEY_B = 'raw-key-w27-sec-b';

/** Recursively assert no secret-shaped keys exist at ANY depth. */
function assertNoSecretKeys(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    expect(
      /(?:api[_-]?key|apikey|secret|github[_-]?token|access[_-]?token|webhook[_-]?secret|password|credential|private[_-]?key|handoff_?token)/i.test(
        key,
      ),
      `secret-shaped key found in package response: ${childPath}`,
    ).toBe(false);
    assertNoSecretKeys(child, childPath);
  }
}

describe('WORK-027 — execution handoff security + tenant isolation', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let executionRecordRepo: PgExecutionRecordRepository;
  let workflowEngine: DefaultWorkflowEngine;
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };
  let versionB: { id: string };
  let reqA: { id: string };
  let criterionA1Id: string;

  let clockNow = 1_700_000_000_000;
  const clock = () => new Date(clockNow);

  beforeAll(async () => {
    process.env.AGENT_PROVIDER_NAME = 'fake';
    process.env.AGENT_API_KEY = 'test-agent-key';
    process.env.AGENT_DEFAULT_MODEL = 'test-model';

    stack = await buildAuthStack({
      WFOS_TEST_KEY_W27_A: KEY_A,
      WFOS_TEST_KEY_W27_B: KEY_B,
      AGENT_API_KEY: 'test-agent-key',
    });
    const orgA = await stack.organizationRepository.create({ name: 'W27 Sec Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'W27 Sec Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'w27-sec-a', displayName: 'Sec A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'w27-sec-b', displayName: 'Sec B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W27 Sec Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W27 Sec Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w27-sec-a', secretRef: 'WFOS_TEST_KEY_W27_A', externalId: 'w27-sec-a', label: 'Sec A', rawKey: KEY_A,
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w27-sec-b', secretRef: 'WFOS_TEST_KEY_W27_B', externalId: 'w27-sec-b', label: 'Sec B', rawKey: KEY_B,
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'W27 Sec Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Sec A constraints' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'W27 Sec Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'Sec B constraints' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'REQ-W27SEC-001',
      title: 'Auth works',
      description: 'Valid auth resolves identity',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-W27SEC-1',
      description: 'Valid auth resolves identity',
      verificationExpectation: 'integration-test',
    }).then((c) => { criterionA1Id = c.id; });

    const contextRepo = new PgImplementationContextRepository(stack.db.client);
    const agentRunRepo = new PgAgentRunRepository(stack.db.client);
    const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, stack.db.logger);
    workflowEngine = new DefaultWorkflowEngine(stack.db.client, stack.db.logger);
    const auditService = new DefaultAuditService(stack.db.client, stack.db.logger);

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
    });
    const executionHandoffService = new DefaultExecutionHandoffService({
      executionRecordRepository: executionRecordRepo,
      handoffRepository: new PgExecutionHandoffRepository(stack.db.client),
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
      // PR #30 review fix #2: registered so the callback-token scoping tests
      // can prove workflow/verification/review routes reject it (401 — the
      // scoped token is consumed by NO route other than the events route).
      verification: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        requirementRepository: stack.requirementRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        verificationService: new DefaultVerificationService(
          stack.db.client,
          stack.requirementRepository,
          stack.acceptanceCriterionRepository,
          stack.architectureVersionRepository,
          stack.workItemRepository,
          stack.workItemRequirementRepository,
          stack.workItemCriterionRepository,
          new PgCiEvidenceIngestionRepository(stack.db.client),
          stack.objectStore,
          stack.db.logger,
        ),
        ciEvidenceIngestionService: new DefaultCiEvidenceIngestionService(
          new PgCiEvidenceIngestionRepository(stack.db.client),
          new PgGitHubInstallationRepository(stack.db.client),
          stack.db.logger,
        ),
      },
      reviews: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        reviewService,
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

  async function createExternalExecution(key: string, wiId: string, label: string) {
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wiId}/execution`,
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      payload: { mode: 'external', provider: 'zai' },
    });
    expect(res.statusCode, `external execution for ${label} should succeed`).toBe(201);
    return (res.json() as { executionId: string }).executionId;
  }

  async function issueToken(key: string, executionId: string) {
    const res = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/handoff`,
      headers: { 'x-api-key': key },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { handoffToken: string }).handoffToken;
  }

  // ------------------------------------------------------------------
  // Unauthenticated access
  // ------------------------------------------------------------------

  it('execution endpoints reject unauthenticated callers (401)', async () => {
    const wi = await createReadyWorkItemA('W27SEC-UNAUTH');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'unauth');

    const list = await server.inject({ method: 'GET', url: `/execution/${executionId}` });
    expect(list.statusCode).toBe(401);
    const handoff = await server.inject({ method: 'POST', url: `/execution/${executionId}/handoff` });
    expect(handoff.statusCode).toBe(401);
    const pkg = await server.inject({ method: 'GET', url: `/execution/${executionId}/package` });
    expect(pkg.statusCode).toBe(401);
    const event = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: { 'content-type': 'application/json' },
      payload: { eventType: 'started' },
    });
    expect(event.statusCode).toBe(401);
    const createRoute = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'content-type': 'application/json' },
      payload: { mode: 'external', provider: 'zai' },
    });
    expect(createRoute.statusCode).toBe(401);
  });

  // ------------------------------------------------------------------
  // Tenant isolation (§17)
  // ------------------------------------------------------------------

  it('user B cannot inspect / prepare / event user A execution (403)', async () => {
    const wi = await createReadyWorkItemA('W27SEC-ISOLATION');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'isolation');

    // Inspect.
    const inspect = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}`,
      headers: { 'x-api-key': KEY_B },
    });
    expect(inspect.statusCode).toBe(403);

    // Prepare handoff.
    const prepare = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/handoff`,
      headers: { 'x-api-key': KEY_B },
    });
    expect(prepare.statusCode).toBe(403);

    // Submit events.
    const event = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: { 'x-api-key': KEY_B, 'content-type': 'application/json' },
      payload: { eventType: 'started' },
    });
    expect(event.statusCode).toBe(403);
    // No event row was written.
    const record = await executionRecordRepo.findByExecutionId(executionId);
    expect(record!.status).toBe('handoff_ready');

    // List for the work item.
    const list = await server.inject({
      method: 'GET',
      url: `/work-items/${wi.id}/executions`,
      headers: { 'x-api-key': KEY_B },
    });
    expect(list.statusCode).toBe(403);

    // B cannot START an execution on A's work item.
    const create = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'x-api-key': KEY_B, 'content-type': 'application/json' },
      payload: { mode: 'external', provider: 'zai' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('a stolen VALID one-time token is worthless without project authorization', async () => {
    const wi = await createReadyWorkItemA('W27SEC-STOLEN');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'stolen-token');
    // A issues a perfectly valid token...
    const token = await issueToken(KEY_A, executionId);

    // ...B steals it. Project authorization runs FIRST → 403, and the token
    // is NOT consumed (A can still redeem it).
    const stolen = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-api-key': KEY_B, 'x-handoff-token': token },
    });
    expect(stolen.statusCode).toBe(403);
    expect((stolen.json() as { error: string }).error).toBe('forbidden');

    // A redeems the same token successfully — B's attempt consumed nothing.
    const legit = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-api-key': KEY_A, 'x-handoff-token': token },
    });
    expect(legit.statusCode).toBe(200);
  });

  it('the redeemed package contains NO secret-shaped keys at any depth', async () => {
    const wi = await createReadyWorkItemA('W27SEC-PACKAGE-SCAN');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'package-scan');
    const token = await issueToken(KEY_A, executionId);

    const res = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-api-key': KEY_A, 'x-handoff-token': token },
    });
    expect(res.statusCode).toBe(200);
    assertNoSecretKeys(res.json());
  });

  // ------------------------------------------------------------------
  // Handoff token attacks (§7)
  // ------------------------------------------------------------------

  it('malformed / unknown / foreign tokens are rejected (403)', async () => {
    const wi = await createReadyWorkItemA('W27SEC-TOKEN-ATTACKS');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'token-attacks');
    const goodToken = await issueToken(KEY_A, executionId);

    // Malformed (too short / wrong shape).
    for (const bad of ['', 'x', 'wfht_short', 'Bearer ' + goodToken, goodToken.slice(0, -2)]) {
      const res = await server.inject({
        method: 'GET',
        url: `/execution/${executionId}/package`,
        headers: { 'x-api-key': KEY_A, 'x-handoff-token': bad },
      });
      expect(res.statusCode, `token "${bad.slice(0, 12)}…" should be rejected`).toBe(403);
      expect((res.json() as { error: string }).error).toBe('handoff-token-invalid');
    }

    // Well-formed but issued for a DIFFERENT execution → invalid for this one.
    const wiOther = await createReadyWorkItemA('W27SEC-TOKEN-OTHER');
    const otherExecutionId = await createExternalExecution(KEY_A, wiOther.id, 'token-other');
    const foreignToken = await issueToken(KEY_A, otherExecutionId);
    const foreign = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-api-key': KEY_A, 'x-handoff-token': foreignToken },
    });
    expect(foreign.statusCode).toBe(403);
    expect((foreign.json() as { error: string }).error).toBe('handoff-token-invalid');
  });

  it('replaying a redeemed one-time token is rejected (409) — replay protection', async () => {
    const wi = await createReadyWorkItemA('W27SEC-REPLAY');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'replay');
    const token = await issueToken(KEY_A, executionId);

    const first = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-api-key': KEY_A, 'x-handoff-token': token },
    });
    expect(first.statusCode).toBe(200);

    const replay = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-api-key': KEY_A, 'x-handoff-token': token },
    });
    expect(replay.statusCode).toBe(409);
    expect((replay.json() as { error: string }).error).toBe('handoff-token-already-used');
  });

  it('expired one-time token is rejected (410)', async () => {
    const wi = await createReadyWorkItemA('W27SEC-TOKEN-EXP');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'token-exp');
    const token = await issueToken(KEY_A, executionId);

    // Advance past the 15-minute token TTL but before the 60-minute package TTL.
    clockNow += 16 * 60 * 1000;

    const res = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-api-key': KEY_A, 'x-handoff-token': token },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe('handoff-token-expired');
  });

  it('handoff on a NATIVE execution is rejected (409 not-external-execution)', async () => {
    const wi = await createReadyWorkItemA('W27SEC-NATIVE-HANDOFF');
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/execution`,
      headers: { 'x-api-key': KEY_A, 'content-type': 'application/json' },
      payload: { mode: 'native' },
    });
    expect(res.statusCode).toBe(201);
    const executionId = (res.json() as { executionId: string }).executionId;

    const handoff = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/handoff`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(handoff.statusCode).toBe(409);
    expect((handoff.json() as { error: string }).error).toBe('not-external-execution');
  });


  // ------------------------------------------------------------------
  // PR #30 review fix #1: execution LIST authorization (empty-list oracle).
  // Authorization resolves WorkItem → ArchitectureVersion → Architecture →
  // Project and runs BEFORE any execution query — even with zero executions.
  // ------------------------------------------------------------------

  it('execution list: cross-tenant Work Item with ZERO executions → 403 (no existence oracle)', async () => {
    // Work item in Project B (created by user B).
    const wiB = await stack.workItemRepository.create({
      architectureVersionId: versionB.id,
      workItemId: 'W27SEC-EMPTY-B',
      title: 'W27SEC-EMPTY-B',
      objective: 'Empty B',
      scope: 'Empty B',
    });
    // User A lists B's work item → 403 EVEN THOUGH zero executions exist.
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${wiB.id}/executions`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('forbidden');
  });

  it('execution list: same-tenant Work Item with ZERO executions → 200 []', async () => {
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: 'W27SEC-EMPTY-A',
      title: 'W27SEC-EMPTY-A',
      objective: 'Empty A',
      scope: 'Empty A',
    });
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${wi.id}/executions`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { executions: unknown[] }).executions).toEqual([]);
  });

  it('execution list: same-tenant Work Item WITH executions → 200 with data', async () => {
    const wi = await createReadyWorkItemA('W27SEC-LIST-WITH-DATA');
    await createExternalExecution(KEY_A, wi.id, 'list-with-data');
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${wi.id}/executions`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(200);
    const { executions } = res.json() as { executions: Array<{ mode: string; status: string }> };
    expect(executions.length).toBe(1);
    expect(executions[0]!.mode).toBe('external');
  });

  it('execution list: unknown Work Item → 404 (still authorized shape)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/00000000-0000-0000-0000-000000000000/executions`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('work-item-not-found');
  });

  // ------------------------------------------------------------------
  // PR #30 review fix #2: scoped execution CALLBACK credentials.
  // ------------------------------------------------------------------

  async function prepareExternalSession(executionId: string) {
    const res = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/handoff`,
      headers: { 'x-api-key': KEY_A },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as {
      handoffToken: string;
      callbackToken: string;
      callbackExpiresAt: string;
    };
  }

  it('prepare issues BOTH the one-time handoff token AND a scoped callback token', async () => {
    const wi = await createReadyWorkItemA('W27SEC-CB-ISSUE');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'cb-issue');
    const prepared = await prepareExternalSession(executionId);
    expect(prepared.handoffToken).toMatch(/^wfht_[0-9a-f]+$/);
    expect(prepared.callbackToken).toMatch(/^wfct_[0-9a-f]+$/);
    expect(new Date(prepared.callbackExpiresAt).getTime()).toBeGreaterThan(clockNow);
    // The prepare response is the ONLY place the raw callback token appears.
    // (The package itself contains no token — proven by the package scan test.)
  });

  it('callback token: posting events with x-callback-token (NO API key) succeeds and is multi-use', async () => {
    const wi = await createReadyWorkItemA('W27SEC-CB-LIFECYCLE');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'cb-lifecycle');
    const { callbackToken } = await prepareExternalSession(executionId);

    // started — callback token ONLY (no x-api-key header at all).
    const started = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: { 'x-callback-token': callbackToken, 'content-type': 'application/json' },
      payload: { eventType: 'started', externalSessionRef: 'zai-session-cb' },
    });
    expect(started.statusCode).toBe(202);
    expect((started.json() as { status: string }).status).toBe('running');

    // progress — SAME token (multi-use by design; per-event idempotency via key).
    const progress = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: { 'x-callback-token': callbackToken, 'content-type': 'application/json' },
      payload: { eventType: 'progress', output: 'halfway' },
    });
    expect(progress.statusCode).toBe(202);

    // completed — SAME token, reports observations (never authority).
    const completed = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: { 'x-callback-token': callbackToken, 'content-type': 'application/json' },
      payload: { eventType: 'completed', commitRef: 'def456' },
    });
    expect(completed.statusCode).toBe(202);
    expect((completed.json() as { status: string }).status).toBe('completed');

    const record = await executionRecordRepo.findByExecutionId(executionId);
    expect(record!.externalSessionRef).toBe('zai-session-cb');
  });

  it('callback token: WRONG execution → 403 (scoped to exactly one execution)', async () => {
    const wiA = await createReadyWorkItemA('W27SEC-CB-SCOPE-A');
    const wiB = await createReadyWorkItemA('W27SEC-CB-SCOPE-B');
    const executionA = await createExternalExecution(KEY_A, wiA.id, 'cb-scope-a');
    const executionB = await createExternalExecution(KEY_A, wiB.id, 'cb-scope-b');
    const { callbackToken: tokenB } = await prepareExternalSession(executionB);

    // B's callback token used against A's events route → 403.
    const res = await server.inject({
      method: 'POST',
      url: `/execution/${executionA}/events`,
      headers: { 'x-callback-token': tokenB, 'content-type': 'application/json' },
      payload: { eventType: 'started' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('callback-token-invalid');
  });

  it('callback token: expired → 410 (token TTL shorter than execution window)', async () => {
    const wi = await createReadyWorkItemA('W27SEC-CB-EXPIRED');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'cb-expired');
    const { callbackToken } = await prepareExternalSession(executionId);

    // Callback TTL is 10min; package window is 60min. Advance 11min → the
    // TOKEN is expired but the execution is still alive.
    clockNow += 11 * 60 * 1000;

    const res = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: { 'x-callback-token': callbackToken, 'content-type': 'application/json' },
      payload: { eventType: 'started' },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe('callback-token-expired');
  });

  it('callback token: malformed → 403; a valid API key does NOT rescue an invalid callback header', async () => {
    const wi = await createReadyWorkItemA('W27SEC-CB-MALFORMED');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'cb-malformed');

    const malformed = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: { 'x-callback-token': 'garbage', 'content-type': 'application/json' },
      payload: { eventType: 'started' },
    });
    expect(malformed.statusCode).toBe(403);
    expect((malformed.json() as { error: string }).error).toBe('callback-token-invalid');

    // Present-but-invalid callback token is rejected even WITH a valid API
    // key — the header is the credential when present, never a bonus.
    const withKey = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: {
        'x-callback-token': 'garbage',
        'x-api-key': KEY_A,
        'content-type': 'application/json',
      },
      payload: { eventType: 'started' },
    });
    expect(withKey.statusCode).toBe(403);
  });

  it('callback token CANNOT be used on workflow / verification / review / package routes (scoped to events only)', async () => {
    const wi = await createReadyWorkItemA('W27SEC-CB-SCOPE-ROUTES');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'cb-scope-routes');
    const { callbackToken } = await prepareExternalSession(executionId);
    // The work item exists and user A owns it — but these calls present ONLY
    // the scoped callback token (no API key), so they must 401.
    const onlyCallback = {
      'x-callback-token': callbackToken,
      'content-type': 'application/json',
    } as const;

    // Workflow transition (would mutate workflow state).
    const transition = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/workflow/transitions`,
      headers: onlyCallback,
      payload: { toState: 'ready' },
    });
    expect(transition.statusCode).toBe(401);

    // Workflow begin-verification (would create verification state).
    const verify = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/workflow/begin-verification`,
      headers: onlyCallback,
      payload: {},
    });
    expect(verify.statusCode).toBe(401);

    // Verification route (would mutate verification state).
    const verRun = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/verification-runs`,
      headers: onlyCallback,
      payload: {},
    });
    expect(verRun.statusCode).toBe(401);

    // Review route (would create review state).
    const review = await server.inject({
      method: 'POST',
      url: `/work-items/${wi.id}/reviews`,
      headers: onlyCallback,
      payload: { source: 'architect' },
    });
    expect(review.statusCode).toBe(401);

    // Package redemption (handoff-token gated; callback token is worthless).
    const pkg = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}/package`,
      headers: { 'x-callback-token': callbackToken },
    });
    expect(pkg.statusCode).toBe(401);

    // Execution metadata read.
    const meta = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}`,
      headers: { 'x-callback-token': callbackToken },
    });
    expect(meta.statusCode).toBe(401);

    // Execution list (project read).
    const list = await server.inject({
      method: 'GET',
      url: `/work-items/${wi.id}/executions`,
      headers: { 'x-callback-token': callbackToken },
    });
    expect(list.statusCode).toBe(401);
  });

  it('API-key path (project.write) still works on the events route', async () => {
    const wi = await createReadyWorkItemA('W27SEC-CB-APIKEY');
    const executionId = await createExternalExecution(KEY_A, wi.id, 'cb-apikey');
    const res = await server.inject({
      method: 'POST',
      url: `/execution/${executionId}/events`,
      headers: { 'x-api-key': KEY_A, 'content-type': 'application/json' },
      payload: { eventType: 'started' },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { status: string }).status).toBe('running');
  });

  it('project B user cannot route project A work item executions through their own project context', async () => {
    // B creates a work item in project B and A creates one in project A.
    const wiA = await createReadyWorkItemA('W27SEC-CROSS-A');
    const wiB = await stack.workItemRepository.create({
      architectureVersionId: versionB.id,
      workItemId: 'W27SEC-CROSS-B',
      title: 'W27SEC-CROSS-B',
      objective: 'Cross B',
      scope: 'Cross B',
    });
    await stack.workOrderRepository.create({
      workItemId: wiB.id,
      projectId: projectB.id,
      architectureVersionId: versionB.id,
      scope: 'Cross B',
      outOfScope: 'Nothing',
      architectureConstraints: 'None',
      verificationRequirements: [],
    });
    await workflowEngine.transition({ workItemId: wiB.id, toState: 'ready', actor: 'test' });

    // B cannot execute A's work item even with a valid provider payload.
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${wiA.id}/execution`,
      headers: { 'x-api-key': KEY_B, 'content-type': 'application/json' },
      payload: { mode: 'external', provider: 'zai' },
    });
    expect(res.statusCode).toBe(403);

    // B CAN execute their own work item (positive control).
    const own = await server.inject({
      method: 'POST',
      url: `/work-items/${wiB.id}/execution`,
      headers: { 'x-api-key': KEY_B, 'content-type': 'application/json' },
      payload: { mode: 'external', provider: 'zai' },
    });
    expect(own.statusCode).toBe(201);
  });
});
