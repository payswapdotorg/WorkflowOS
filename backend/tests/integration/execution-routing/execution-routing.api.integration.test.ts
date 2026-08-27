/**
 * WORK-044 — route-level API tests for the Adaptive Execution Router's two
 * DISTINCT caller intents (W044-AC08 evidence: "API/service integration
 * tests").
 *
 * Real fastify server (buildServer) + the real auth stack
 * (requireProjectAuthorization) + the real AdaptiveExecutionRouter backed
 * by the real DefaultExecutionPolicyService (real PgExecutionPolicyRepository
 * + real eligibility engine; stubbed registry + evidence provider — the
 * WORK-043 engine-test pattern).
 *
 * Proves:
 *   - GET  /work-items/:workItemId/execution/routing/recommendation returns
 *     the RECOMMENDATION-mode payload (inspectable ranking; advisory).
 *   - POST /work-items/:workItemId/execution/routing/selection returns the
 *     AUTOMATIC-SELECTION-mode payload (the selected candidate + why).
 *   - Both are backend-authorized: a missing key is 401, a cross-tenant key
 *     is 403, an unknown work item is 404.
 *   - An unknown benchmark-mode override is a 400 (validated at the route
 *     boundary — never a silent pass-through into the policy layer).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import {
  DefaultExecutionPolicyService,
  DefaultExecutionEligibilityService,
  DefaultExecutionRecommendationService,
  PgExecutionPolicyRepository,
} from '../../../src/execution-policy/index.js';
import { AdaptiveExecutionRouter } from '../../../src/execution-routing/index.js';
import type { HistoricalPerformance } from '../../../src/execution-policy/index.js';
import type { FastifyInstance } from 'fastify';

const NO_EVIDENCE: HistoricalPerformance = {
  sampleSize: 0,
  sufficient: false,
  observedQuality: null,
  ciFirstPassRate: null,
  verificationFirstPassRate: null,
  medianCorrectionCycles: null,
  medianTimeToVerifiedMs: null,
  humanInterventionCount: null,
  evidenceCells: [],
};

const ALPHA_EVIDENCE: HistoricalPerformance = {
  sampleSize: 6,
  sufficient: true,
  observedQuality: 90,
  ciFirstPassRate: 0.95,
  verificationFirstPassRate: 0.9,
  medianCorrectionCycles: 1,
  medianTimeToVerifiedMs: 600_000,
  humanInterventionCount: null,
  evidenceCells: [],
};

const BETA_EVIDENCE: HistoricalPerformance = {
  sampleSize: 5,
  sufficient: true,
  observedQuality: 70,
  ciFirstPassRate: 0.7,
  verificationFirstPassRate: 0.7,
  medianCorrectionCycles: 2,
  medianTimeToVerifiedMs: 900_000,
  humanInterventionCount: null,
  evidenceCells: [],
};

describe('WORK-044 — execution-routing API (recommendation + automatic selection)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let projectId: string;
  let workItemId: string;
  let rawKeyA: string;
  let rawKeyB: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-w044-a',
      WFOS_TEST_KEY_B: 'raw-key-w044-b',
    });
    const db = stack.db.client;

    const orgA = await stack.organizationRepository.create({ name: 'W044 API Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'W044 API Org B' });
    const userA = await stack.userRepository.upsertByExternalId({ externalId: 'w044-api-user-a', displayName: 'User A' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'w044-api-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W044 API Project A' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W044 API Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w044-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'w044-api-user-a', label: 'A', rawKey: 'raw-key-w044-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w044-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'w044-api-user-b', label: 'B', rawKey: 'raw-key-w044-b',
    });
    rawKeyA = 'raw-key-w044-a';
    rawKeyB = 'raw-key-w044-b';
    projectId = projectA.id;

    // The FK-valid chain for the work item.
    const arch = await stack.architectureRepository.create({ projectId, name: 'W044 API Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W044 API' });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id,
      workItemId: 'WORK-W044-API',
      title: 'W044 API fixture',
      objective: 'fixture',
      scope: 'src/x.ts',
      outOfScope: 'none',
      metadata: { baseCommit: 'w044-api-baseline-0000000000000001' },
    });
    workItemId = workItem.id;

    // The real policy service + router (registry + evidence stubbed).
    const evidenceMap = new Map<string, HistoricalPerformance>();
    evidenceMap.set(`${projectId}|alpha|native`, ALPHA_EVIDENCE);
    evidenceMap.set(`${projectId}|beta|native`, BETA_EVIDENCE);

    const policyService = new DefaultExecutionPolicyService({
      db,
      logger: stack.db.logger,
      repository: new PgExecutionPolicyRepository(db),
      projectOrganizationResolver: {
        resolveProjectOrganization: async (pid: string) => {
          const project = await stack.projectRepository.findById(pid);
          return project?.organizationId ?? null;
        },
      },
      eligibilityService: new DefaultExecutionEligibilityService(),
      recommendationService: new DefaultExecutionRecommendationService(),
      taskProfileBuilder: {
        build: () => Promise.resolve({
          language: 'typescript',
          framework: null,
          repositorySize: 'medium',
          complexity: 'medium',
          architectureSensitivity: 'low',
          securitySensitivity: 'low',
          browserRequired: false,
          terminalRequired: false,
          repositoryAccess: true,
          externalExecutionAllowed: true,
          nativeExecutionAllowed: true,
          requiredCapabilities: ['coding_agent'],
          humanInterventionLikely: false,
        } as never),
      },
      agentProviderRegistry: {
        getExecutionProviders: (pid?: string) =>
          Promise.resolve(pid === projectId
            ? [
                { name: 'Alpha', provider: 'alpha', model: 'alpha-model', nativeApi: 'ready', externalUi: 'not-supported' },
                { name: 'Beta', provider: 'beta', model: 'beta-model', nativeApi: 'ready', externalUi: 'not-supported' },
              ]
            : []),
        isExternalProviderSupported: () => Promise.resolve(true),
      },
      benchmarkEvidenceProvider: {
        historicalPerformanceForCell: (pid: string, prov: string) =>
          Promise.resolve(evidenceMap.get(`${pid}|${prov}|native`) ?? NO_EVIDENCE),
        aggregateForProject: () => Promise.resolve(NO_EVIDENCE),
      },
    });
    const routerService = new AdaptiveExecutionRouter({
      executionPolicyService: policyService,
      projectOrganizationResolver: {
        resolveProjectOrganization: async (pid: string) => {
          const project = await stack.projectRepository.findById(pid);
          return project?.organizationId ?? null;
        },
      },
      logger: stack.db.logger,
    });
    // The user's verified subscription posture for both providers.
    await policyService.upsertAccessProfile(orgA.id, userA.id, {
      provider: 'alpha', plan: 'pro', codingAgent: 'ready', externalUi: 'ready', nativeApi: 'ready', statusSource: 'verified',
    });
    await policyService.upsertAccessProfile(orgA.id, userA.id, {
      provider: 'beta', plan: 'pro', codingAgent: 'ready', externalUi: 'ready', nativeApi: 'ready', statusSource: 'verified',
    });

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      executionRouting: {
        authorizationService: stack.authorizationService,
        executionRouterService: routerService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  it('GET .../routing/recommendation → 200 with the RECOMMENDATION-mode payload (inspectable ranking, advisory)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${workItemId}/execution/routing/recommendation`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { routing: Record<string, unknown> };
    const routing = body.routing;
    expect(routing.mode).toBe('recommendation');
    expect(routing.decisionId).toBeTruthy();
    expect(Array.isArray(routing.ranked)).toBe(true);
    expect(routing.recommended).toBeTruthy();
    // The evidence-backed provider wins (alpha 90 > beta 70).
    expect((routing.recommended as { identity: { provider: string } }).identity.provider).toBe('alpha');
    expect((routing.explanation as { methodology: string }).methodology).toContain('lexicographic');
  });

  it('POST .../routing/selection → 200 with the AUTOMATIC-SELECTION-mode payload (the selected candidate + why it won)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/work-items/${workItemId}/execution/routing/selection`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { routing: Record<string, unknown> };
    const routing = body.routing;
    expect(routing.mode).toBe('automatic_selection');
    expect(routing.selected).toBeTruthy();
    expect((routing.selected as { identity: { provider: string } }).identity.provider).toBe('alpha');
    expect(Array.isArray(routing.alternatives)).toBe(true);
    expect((routing.alternatives as { identity: { provider: string } }[]).map((a) => a.identity.provider)).toEqual(['beta']);
    expect((routing.explanation as { selectionReason: string }).selectionReason).toContain('alpha');
  });

  it('the two modes are DISTINCT intents over ONE deterministic ranking (same winner, same order)', async () => {
    const rec = await server.inject({
      method: 'GET',
      url: `/work-items/${workItemId}/execution/routing/recommendation`,
      headers: { 'x-api-key': rawKeyA },
    });
    const sel = await server.inject({
      method: 'POST',
      url: `/work-items/${workItemId}/execution/routing/selection`,
      headers: { 'x-api-key': rawKeyA },
    });
    const recRouting = (rec.json() as { routing: { recommended: { identity: { provider: string } }; ranked: { identity: { provider: string } }[] } }).routing;
    const selRouting = (sel.json() as { routing: { selected: { identity: { provider: string } }; alternatives: { identity: { provider: string } }[] } }).routing;
    expect(selRouting.selected.identity.provider).toBe(recRouting.recommended.identity.provider);
    expect(selRouting.alternatives.map((a) => a.identity.provider)).toEqual(
      recRouting.ranked.slice(1).map((r) => r.identity.provider),
    );
  });

  it('a missing API key is 401 (backend-authorized)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${workItemId}/execution/routing/recommendation`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('a CROSS-TENANT API key is 403 (tenant/project scoping at the route boundary)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${workItemId}/execution/routing/recommendation`,
      headers: { 'x-api-key': rawKeyB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('an unknown work item is 404', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/work-items/00000000-0000-0000-0000-000000000000/execution/routing/recommendation',
      headers: { 'x-api-key': rawKeyA },
    });
    expect(res.statusCode).toBe(404);
  });

  it('an UNKNOWN benchmark-mode override is 400 (validated at the route boundary — never a silent pass-through)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${workItemId}/execution/routing/recommendation?benchmarkMode=nonsense_mode`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('invalid-benchmark-mode');
  });

  it('a VALID benchmark-mode override passes through to the WORK-043 contract (200)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/work-items/${workItemId}/execution/routing/recommendation?benchmarkMode=maximum_capability`,
      headers: { 'x-api-key': rawKeyA },
    });
    expect(res.statusCode).toBe(200);
  });
});
