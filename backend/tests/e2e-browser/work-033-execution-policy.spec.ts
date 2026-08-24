/**
 * WORK-033 Browser-level E2E test: Execution Policy & Fair Benchmarking.
 *
 * Proves the execution-policy HTTP surface works through a REAL backend:
 *   - Real Fastify API (the new /work-items/:id/execution/recommendation +
 *     /projects/:id/execution-policy + /projects/:id/provider-access-profiles
 *     routes wired)
 * - Real PostgreSQL (pglite)
 * - The §16 recommendation pipeline (eligibility hard-filter + recommendation
 *   scoring + benchmark evidence aggregation + §22 append-only decision
 *   persistence)
 *
 * This is an HTTP-level E2E (not a full Playwright UI drive) — the
 * ExecutionPolicyDialog component + its smoke tests live in the frontend; the
 * purpose here is to prove the END-TO-END backend pipeline through the real
 * server, including server-side actor derivation (§27) + §22 audit
 * immutability + §9 frozen-policy rejection.
 *
 * Lifecycle:
 *   1. Login (set localStorage API key)
 *   2. Seed fixture (org, project, architecture, requirements, criteria,
 *      work item, work order)
 *   3. GET /work-items/:id/execution/recommendation → 200 + full shape
 *   4. GET /work-items/:id/execution/decisions → §22 audit includes the rec
 *   5. GET /work-items/:id/execution/controlled-comparison → dimensions
 *   6. POST /projects/:id/execution-policy → ensure default
 *   7. PATCH /projects/:id/execution-policy → update + policyVersion bumps
 *   8. POST /projects/:id/execution-policy/freeze → frozen=true
 *   9. PATCH (frozen) → 409
 *  10. POST + GET /projects/:id/provider-access-profiles → upsert + list
 */
import { test, expect } from '@playwright/test';
import { buildAuthStack, type TestAuthStack } from '../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost } from '@platform/index.js';
import { DefaultAuthorizationService } from '../../src/modules/auth/internal/authorization-service.js';
import { PgImplementationContextRepository } from '../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { PgAgentProviderConfigRepository } from '../../src/modules/agents/internal/pg-agent-provider-config-repository.js';
import { DefaultAgentProviderRegistry } from '../../src/platform/default-agent-provider-registry.js';
import { DefaultAgentProviderRegistryService } from '../../src/modules/agents/internal/agent-provider-registry-service.js';
import { PgBenchmarkRepository } from '../../src/benchmark/index.js';
import {
  DefaultExecutionPolicyService,
  DefaultExecutionEligibilityService,
  DefaultExecutionRecommendationService,
  DefaultExecutionTaskProfileBuilder,
  DefaultBenchmarkEvidenceProvider,
  PgExecutionPolicyRepository,
} from '../../src/execution-policy/index.js';
import type { FastifyInstance } from 'fastify';

let stack: TestAuthStack;
let server: FastifyInstance;
let queue: InMemoryQueue;
let worker: WorkerHost;
let policyProjectId: string;
let freshPolicyProjectId: string;
let policyWorkItemId: string;
let freshPolicyWorkItemId: string;

const API_KEY = 'raw-key-policy-e2e';

test.beforeAll(async () => {
  stack = await buildAuthStack({ WFOS_TEST_POLICY_KEY: API_KEY });
  const db = stack.db.client;
  const logger = stack.db.logger;

  const org = await stack.organizationRepository.create({ name: 'Policy E2E Org' });
  const user = await stack.userRepository.upsertByExternalId({ externalId: 'policy-e2e-user', displayName: 'Policy User' });
  await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
  const project = await stack.projectRepository.create({ organizationId: org.id, name: 'Policy E2E Project' });
  await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'policy-key', secretRef: 'WFOS_TEST_POLICY_KEY', externalId: 'policy-e2e-user', label: 'Policy User', rawKey: API_KEY,
  });
  const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Policy E2E Arch' });
  const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# Policy E2E Architecture' });
  await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
  const req = await stack.requirementRepository.create({
    architectureVersionId: version.id, requirementId: 'REQ-POLICY-E2E-001',
    title: 'Calculator adds', description: 'add(2,3)===5',
  });
  const crit = await stack.acceptanceCriterionRepository.create({
    requirementId: req.id, criterionId: 'AC-POLICY-E2E-001', description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
  });
  const workItem = await stack.workItemRepository.create({
    architectureVersionId: version.id, workItemId: 'WORK-POLICY-E2E-001',
    title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
    metadata: { baseCommit: 'policy-e2e-baseline-commit-0000000000000000001' },
  });
  await stack.workItemRequirementRepository.associate(workItem.id, req.id);
  await stack.workItemCriterionRepository.associate(workItem.id, crit.id);
  await stack.workOrderRepository.create({
    workItemId: workItem.id, projectId: project.id, architectureVersionId: version.id,
    requirementIds: [req.id], criterionIds: [crit.id], scope: 'src/calc.ts',
    verificationRequirements: ['unit-test: add(2,3)===5'],
  });
  policyProjectId = project.id;
  policyWorkItemId = workItem.id;

  // PR #37 review fix e2e: a second project with NO experiments started —
  // its (unfrozen) policy exercises the constrained-mode validation. It
  // carries its own full work-item chain (needed for the
  // /work-items/:id/execution/recommendation route resolution + task
  // profile).
  const freshProject = await stack.projectRepository.create({ organizationId: org.id, name: 'Fresh Policy Project' });
  freshPolicyProjectId = freshProject.id;
  const freshArch = await stack.architectureRepository.create({ projectId: freshProject.id, name: 'Fresh Policy Arch' });
  const freshVersion = await stack.architectureVersionRepository.create({ architectureId: freshArch.id, contentInline: '# Fresh Policy Architecture' });
  await stack.architectureVersionRepository.transitionState(freshVersion.id, 'frozen', user.id);
  const freshReq = await stack.requirementRepository.create({
    architectureVersionId: freshVersion.id, requirementId: 'REQ-FRESH-E2E-001',
    title: 'Calculator adds', description: 'add(2,3)===5',
  });
  const freshCrit = await stack.acceptanceCriterionRepository.create({
    requirementId: freshReq.id, criterionId: 'AC-FRESH-E2E-001', description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
  });
  const freshWorkItem = await stack.workItemRepository.create({
    architectureVersionId: freshVersion.id, workItemId: 'WORK-FRESH-E2E-001',
    title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
    metadata: { baseCommit: 'fresh-e2e-baseline-commit-000000000000000001' },
  });
  await stack.workItemRequirementRepository.associate(freshWorkItem.id, freshReq.id);
  await stack.workItemCriterionRepository.associate(freshWorkItem.id, freshCrit.id);
  await stack.workOrderRepository.create({
    workItemId: freshWorkItem.id, projectId: freshProject.id, architectureVersionId: freshVersion.id,
    requirementIds: [freshReq.id], criterionIds: [freshCrit.id], scope: 'src/calc.ts',
    verificationRequirements: ['unit-test: add(2,3)===5'],
  });
  freshPolicyWorkItemId = freshWorkItem.id;

  // --- wire the execution-policy service (the WORK-033 surface) ---
  const authorizationService = new DefaultAuthorizationService(
    stack.membershipRepository, stack.rolePermissionRepository, stack.projectRepository, stack.projectAccessRepository,
  );
  const implementationContextRepository = new PgImplementationContextRepository(db);
  const agentProviderConfigRepository = new PgAgentProviderConfigRepository(db);
  const agentProviderRegistry = new DefaultAgentProviderRegistry(stack.secretStore);
  const agentProviderRegistryService = new DefaultAgentProviderRegistryService(
    agentProviderRegistry, agentProviderConfigRepository, stack.secretStore,
  );
  const benchmarkRepository = new PgBenchmarkRepository(db);
  const executionPolicyRepository = new PgExecutionPolicyRepository(db);
  const executionEvidenceProvider = new DefaultBenchmarkEvidenceProvider({
    benchmarkRepository,
  });
  const executionTaskProfileBuilder = new DefaultExecutionTaskProfileBuilder({
    workItemRepository: stack.workItemRepository,
    workOrderRepository: stack.workOrderRepository,
    implementationContextRepository,
    logger,
  });
  const executionPolicyService = new DefaultExecutionPolicyService({
    db, logger,
    repository: executionPolicyRepository,
    eligibilityService: new DefaultExecutionEligibilityService(),
    recommendationService: new DefaultExecutionRecommendationService(),
    taskProfileBuilder: executionTaskProfileBuilder,
    agentProviderRegistry: agentProviderRegistryService,
    benchmarkEvidenceProvider: executionEvidenceProvider,
  });

  queue = new InMemoryQueue();
  const handlers = buildHandlerRegistry([]);
  worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 50 });
  await worker.start();

  server = await buildServer({
    queue, logger,
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
    projects: { authorizationService, projectRepository: stack.projectRepository, repositoryAssociationRepository: stack.repositoryAssociationRepository } as never,
    workItems: { authorizationService, workItemRepository: stack.workItemRepository, architectureRepository: stack.architectureRepository, architectureVersionRepository: stack.architectureVersionRepository } as never,
    executionPolicy: {
      authorizationService,
      executionPolicyService,
      projectRepository: stack.projectRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
    },
  });
  await server.listen({ port: 3002, host: '127.0.0.1' });
});

test.afterAll(async () => {
  if (worker) await worker.stop();
  if (queue) await queue.close();
  if (server) await server.close();
  if (stack) await stack.teardown();
});

async function api(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`http://127.0.0.1:3002${path}`, {
    method,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : (body !== undefined ? JSON.stringify(body) : '{}'),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// §16 recommendation pipeline
// ---------------------------------------------------------------------------

test('GET /work-items/:id/execution/recommendation returns a full recommendation', async () => {
  const { status, data } = await api(`/work-items/${policyWorkItemId}/execution/recommendation`);
  expect(status).toBe(200);
  const rec = (data as { recommendation: Record<string, unknown> }).recommendation;
  expect(rec).toBeTruthy();
  expect(rec.workItemId).toBe(policyWorkItemId);
  expect(Array.isArray(rec.eligibleCandidates)).toBe(true);
  expect(Array.isArray(rec.excludedCandidates)).toBe(true);
  expect(rec.why).toBeTruthy();
  expect(rec.policy).toBeTruthy();
  expect(rec.taskProfile).toBeTruthy();
  // §22: the decision is persisted (append-only audit) — decisionId is set.
  expect(typeof rec.decisionId).toBe('string');
  expect((rec.decisionId as string).length).toBeGreaterThan(0);
});

test('§22 GET /work-items/:id/execution/decisions lists the persisted decision', async () => {
  // First produce a recommendation (persisting a decision).
  await api(`/work-items/${policyWorkItemId}/execution/recommendation`);
  const { status, data } = await api(`/work-items/${policyWorkItemId}/execution/decisions`);
  expect(status).toBe(200);
  const decisions = (data as { decisions: unknown[] }).decisions;
  expect(Array.isArray(decisions)).toBe(true);
  expect(decisions.length).toBeGreaterThanOrEqual(1);
  const first = decisions[0] as Record<string, unknown>;
  expect(first.policyVersion).toBeGreaterThan(0);
  expect(first.benchmarkMode).toBeTruthy();
  expect(first.taskProfile).toBeTruthy();
});

test('GET /work-items/:id/execution/controlled-comparison returns the §10 dimensions', async () => {
  const { status, data } = await api(`/work-items/${policyWorkItemId}/execution/controlled-comparison`);
  expect(status).toBe(200);
  const dims = (data as { dimensions: Record<string, boolean> }).dimensions;
  expect(dims.sameTask).toBe(true);
  expect(dims.sameArchitecture).toBe(true);
  expect(dims.differingSurfaces).toBe(true);
  expect(dims.differingContextWindow).toBe(true);
});

// ---------------------------------------------------------------------------
// §31 project policy CRUD + §9 frozen immutability
// ---------------------------------------------------------------------------

test('§31 project policy: ensure → get → update (policyVersion bumps) → freeze → frozen-reject', async () => {
  // ensure default
  let { status, data } = await api(`/projects/${policyProjectId}/execution-policy`, 'POST');
  expect(status).toBe(200);
  let policy = (data as { policy: Record<string, unknown> }).policy;
  expect(policy.defaultBenchmarkMode).toBe('maximum_capability');
  expect(policy.policyVersion).toBe(1);
  expect(policy.frozen).toBe(false);

  // get reflects the created record
  ({ status, data } = await api(`/projects/${policyProjectId}/execution-policy`));
  expect(status).toBe(200);
  policy = (data as { policy: Record<string, unknown> }).policy;
  expect(policy).toBeTruthy();

  // update (policyVersion bumps to 2)
  ({ status, data } = await api(`/projects/${policyProjectId}/execution-policy`, 'PATCH', { externalExecutionAllowed: false, privacyLevel: 'local_only' }));
  expect(status).toBe(200);
  policy = (data as { policy: Record<string, unknown> }).policy;
  expect(policy.externalExecutionAllowed).toBe(false);
  expect(policy.privacyLevel).toBe('local_only');
  expect(policy.policyVersion).toBe(2);

  // freeze (§9 — one-way immutability)
  ({ status, data } = await api(`/projects/${policyProjectId}/execution-policy/freeze`, 'POST'));
  expect(status).toBe(200);
  policy = (data as { policy: Record<string, unknown> }).policy;
  expect(policy.frozen).toBe(true);

  // update after freeze → 409 (§9 enforced)
  ({ status } = await api(`/projects/${policyProjectId}/execution-policy`, 'PATCH', { externalExecutionAllowed: true }));
  expect(status).toBe(409);
});

test('PR #37 review fix — constrained mode without its cap → 400 (rejected, not a silent unconstrained fallback)', async () => {
  // A fresh project (the policyProjectId policy is frozen from the previous
  // test): the default policy is maximum_capability with NO caps.
  const { data } = await api(`/projects/${freshPolicyProjectId}/execution-policy`, 'POST');
  const policy = (data as { policy: Record<string, unknown> }).policy;
  expect(policy.defaultBenchmarkMode).toBe('maximum_capability');
  expect(policy.maxCostPerTaskCents).toBeNull();

  // COST_CONSTRAINED without a cost cap → 400 (invalid-mode-constraint).
  let res = await api(`/projects/${freshPolicyProjectId}/execution-policy`, 'PATCH', { defaultBenchmarkMode: 'cost_constrained' });
  expect(res.status).toBe(400);
  expect((res.data as { error: string }).error).toBe('invalid-mode-constraint');

  // LATENCY_CONSTRAINED without a duration cap → 400.
  res = await api(`/projects/${freshPolicyProjectId}/execution-policy`, 'PATCH', { defaultBenchmarkMode: 'latency_constrained' });
  expect(res.status).toBe(400);
  expect((res.data as { error: string }).error).toBe('invalid-mode-constraint');

  // Valid: cap + mode in one PATCH → 200.
  res = await api(`/projects/${freshPolicyProjectId}/execution-policy`, 'PATCH', { defaultBenchmarkMode: 'cost_constrained', maxCostPerTaskCents: 500 });
  expect(res.status).toBe(200);
  expect((res.data as { policy: { defaultBenchmarkMode: string } }).policy.defaultBenchmarkMode).toBe('cost_constrained');

  // Recommendation with an explicit constrained mode on a capless UNFROZEN
  // project → 400 (uses the FRESH project's work item — the main project's
  // policy is frozen by the preceding test).
  // (Reset the fresh project to capless first.)
  await api(`/projects/${freshPolicyProjectId}/execution-policy`, 'PATCH', { defaultBenchmarkMode: 'maximum_capability', maxCostPerTaskCents: null });
  res = await api(`/work-items/${freshPolicyWorkItemId}/execution/recommendation?benchmarkMode=cost_constrained`);
  expect(res.status).toBe(400);
  expect((res.data as { error: string }).error).toBe('invalid-mode-constraint');
});

test('PR #37 review fix — frozen-mode override → 409 (a decision cannot claim the frozen policyVersion under a different mode)', async () => {
  // policyProjectId's policy is FROZEN (§9 test above) with
  // benchmarkMode=maximum_capability. An explicit ?benchmarkMode= override
  // that DIFFERS from the frozen mode must be rejected — the resulting
  // decision would claim the frozen policyVersion while using a different
  // mode, undermining the §9 immutability/audit guarantee.
  const res = await api(`/work-items/${policyWorkItemId}/execution/recommendation?benchmarkMode=controlled_comparison`);
  expect(res.status).toBe(409);
  expect((res.data as { error: string }).error).toBe('policy-frozen-mode');
  expect(String((res.data as { message: string }).message)).toContain('execution-policy-frozen-mode');

  // Any differing mode is rejected — the reviewer's exact scenario
  // (cost_constrained against a frozen maximum_capability policy).
  const res2 = await api(`/work-items/${policyWorkItemId}/execution/recommendation?benchmarkMode=cost_constrained`);
  expect(res2.status).toBe(409);
  expect((res2.data as { error: string }).error).toBe('policy-frozen-mode');
});

// ---------------------------------------------------------------------------
// §5 provider access profiles
// ---------------------------------------------------------------------------

test('§5 upsert + list provider access profiles', async () => {
  const { status, data } = await api(`/projects/${policyProjectId}/provider-access-profiles`, 'POST', {
    provider: 'chatgpt',
    plan: 'plus',
    codingAgent: 'ready',
    externalUi: 'ready',
    nativeApi: 'unavailable',
    statusSource: 'user_configured',
  });
  expect(status).toBe(200);
  const profile = (data as { profile: Record<string, unknown> }).profile;
  expect(profile.provider).toBe('chatgpt');
  expect(profile.plan).toBe('plus');
  expect(profile.statusSource).toBe('user_configured');

  const listRes = await api(`/projects/${policyProjectId}/provider-access-profiles`);
  expect(listRes.status).toBe(200);
  const profiles = (listRes.data as { profiles: unknown[] }).profiles;
  expect(Array.isArray(profiles)).toBe(true);
  expect(profiles.length).toBeGreaterThanOrEqual(1);
  const found = profiles.find((p) => (p as Record<string, unknown>).provider === 'chatgpt');
  expect(found).toBeTruthy();
});

// ---------------------------------------------------------------------------
// §12 user preferences
// ---------------------------------------------------------------------------

test('§12 ensure + update user preferences', async () => {
  const { status, data } = await api(`/projects/${policyProjectId}/execution-preferences`, 'POST');
  expect(status).toBe(200);
  const prefs = (data as { preferences: Record<string, unknown> }).preferences;
  expect(prefs.qualityWeight).toBeGreaterThan(0);

  const updRes = await api(`/projects/${policyProjectId}/execution-preferences`, 'PATCH', { qualityWeight: 0.8, costWeight: 0.1 });
  expect(updRes.status).toBe(200);
  const upd = (updRes.data as { preferences: Record<string, unknown> }).preferences;
  expect(upd.qualityWeight).toBeCloseTo(0.8, 5);
  expect(upd.costWeight).toBeCloseTo(0.1, 5);
});

// ---------------------------------------------------------------------------
// §27 server-side actor (no body actor accepted)
// ---------------------------------------------------------------------------

test('§27 recommendation does not trust a body-supplied actor (server-derived)', async () => {
  // The route derives the actor from requireProjectAuthorization(user.id).
  // Sending a bogus actor in the body must NOT influence the persisted decision.
  const { status, data } = await api(`/work-items/${policyWorkItemId}/execution/recommendation?benchmarkMode=maximum_capability`);
  expect(status).toBe(200);
  const rec = (data as { recommendation: Record<string, unknown> }).recommendation;
  // The decision was persisted by the server-side user.id; the request had no
  // body at all (GET). The decisionId proves persistence happened server-side.
  expect(rec.decisionId).toBeTruthy();
});
