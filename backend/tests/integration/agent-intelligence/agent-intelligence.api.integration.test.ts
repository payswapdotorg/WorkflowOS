/**
 * WORK-047 — route-level API tests for the agent-intelligence read-only
 * advisory surface (W047 evidence: the HTTP boundary authorizes within the
 * caller's project context, resolves the work item's project SERVER-SIDE,
 * validates the benchmark-mode override, and maps the typed errors
 * fail-closed — mirroring the delegation/routing route patterns).
 *
 * Real fastify server (buildServer) + the real auth stack
 * (requireProjectAuthorization) + a stubbed AgentIntelligenceService (the
 * service's full behavior is proven by the integration suite; here the
 * STUB records the calls so the route contract is proven exactly).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import type {
  AgentIntelligenceService,
  IntelligenceExecutionRecommendation,
  IntelligenceDelegationRecommendation,
  IntelligenceRequestInput,
} from '../../../src/agent-intelligence/index.js';

function executionFixture(projectId: string, workItemId: string): IntelligenceExecutionRecommendation {
  const t0 = new Date('2026-08-29T00:00:00Z');
  return {
    mode: 'recommendation',
    projectId,
    workItemId,
    recommended: {
      identity: { provider: 'alpha', model: 'alpha-model', executionMode: 'native' },
      score: 0.83,
      components: {
        routing: { value: 0.8, status: 'observed' },
        historicalSuccess: { value: 0.875, status: 'observed' },
      },
      historicalSignal: { successRate: 0.875, sampleSize: 8, sufficient: true, lastObservedAt: t0 },
      eligibility: { status: 'eligible', eligible: true, blockingReasons: [], satisfiedConstraints: ['capability:coding_agent'] },
      routingRank: 1,
    },
    ranked: [],
    fallbacks: [],
    rejectedAlternatives: [],
    provenance: {
      headline: 'recommended alpha',
      reasons: [],
      contributingEvidence: [
        {
          cell: 'alpha/alpha-model/native',
          kind: 'execution-history',
          attempts: 8,
          succeeded: 7,
          successRate: 0.875,
          firstObservedAt: t0,
          lastObservedAt: t0,
        },
      ],
      constraintsApplied: { decisionId: 'dec-1', satisfiedConstraints: ['capability:coding_agent'] },
      rejectedAlternatives: [],
      routing: { mode: 'recommendation', decisionId: 'dec-1', routingRecommended: null, eligibleCount: 1, routingOrder: [] },
      confidence: 'high',
    },
    evidence: {
      scope: { projectId },
      executionCells: [],
      roleCells: [],
      benchmark: {
        sampleSize: 0, sufficient: false, observedQuality: null, ciFirstPassRate: null,
        verificationFirstPassRate: null, medianCorrectionCycles: null, medianTimeToVerifiedMs: null,
        humanInterventionCount: null, evidenceCells: [],
      },
      taskProfile: {
        language: 'typescript', framework: null, repositorySize: 'medium', complexity: 'medium',
        architectureSensitivity: 'low', securitySensitivity: 'low', browserRequired: false,
        terminalRequired: false, repositoryAccess: true, externalExecutionAllowed: true,
        nativeExecutionAllowed: true, requiredCapabilities: ['coding_agent'], humanInterventionLikely: false,
      },
    },
    warnings: [],
  };
}

describe('WORK-047 — agent-intelligence API (read-only advisory surface)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let projectId: string;
  let projectBId: string;
  let workItemId: string;
  let rawKeyA: string;
  let rawKeyB: string;
  const calls: IntelligenceRequestInput[] = [];
  let service: AgentIntelligenceService;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-w047-a',
      WFOS_TEST_KEY_B: 'raw-key-w047-b',
    });

    const orgA = await stack.organizationRepository.create({ name: 'W047 API Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'W047 API Org B' });
    const userA = await stack.userRepository.upsertByExternalId({ externalId: 'w047-api-user-a', displayName: 'User A' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'w047-api-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W047 API Project A' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W047 API Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w047-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'w047-api-user-a', label: 'A', rawKey: 'raw-key-w047-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w047-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'w047-api-user-b', label: 'B', rawKey: 'raw-key-w047-b',
    });
    rawKeyA = 'raw-key-w047-a';
    rawKeyB = 'raw-key-w047-b';
    projectId = projectA.id;
    projectBId = projectB.id;

    // The work-item chain inside project A.
    const arch = await stack.architectureRepository.create({ projectId, name: 'W047 API Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# fixture' });
    const wi = await stack.workItemRepository.create({
      architectureVersionId: version.id,
      workItemId: 'WORK-W047-API',
      title: 'fixture',
      objective: 'fixture',
      scope: 'src/x.ts',
      outOfScope: 'none',
      metadata: { baseCommit: 'w047-api-baseline-000000000001' },
    });
    workItemId = wi.id;

    // The STUBBED intelligence service (the route contract under test).
    service = {
      async recommendExecution(input: IntelligenceRequestInput): Promise<IntelligenceExecutionRecommendation> {
        calls.push(input);
        return executionFixture(input.projectId, input.workItemId);
      },
      async recommendDelegation(input: IntelligenceRequestInput): Promise<IntelligenceDelegationRecommendation> {
        calls.push(input);
        return {
          mode: 'recommendation',
          projectId: input.projectId,
          workItemId: input.workItemId,
          planKey: 'intelligence-recommended',
          units: [
            {
              unitKey: 'implementer',
              role: 'implementer',
              roleRevision: 'rev',
              mode: 'native',
              provider: 'alpha',
              model: 'alpha-model',
              dependsOn: [],
              why: [{ dimension: 'task_profile', detail: 'always present' }],
              roleHistory: null,
            },
          ],
          rejectedRoles: [{ role: 'ux-reviewer', reason: 'no UX axis' }],
          execution: executionFixture(input.projectId, input.workItemId),
          evidence: executionFixture(input.projectId, input.workItemId).evidence,
          warnings: [],
          submissionPath: `/projects/${input.projectId}/work-items/${input.workItemId}/delegation-plans`,
        };
      },
    };

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      agentIntelligence: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        workItemRepository: stack.workItemRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        agentIntelligenceService: service,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  const authHeaders = (key: string) => ({ 'x-api-key': key });

  it('GET …/agent-intelligence/execution returns the serialized recommendation (dates ISO, provenance intact)', async () => {
    calls.length = 0;
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/work-items/${workItemId}/agent-intelligence/execution`,
      headers: authHeaders(rawKeyA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { intelligence: { mode: string; projectId: string; recommended: { identity: { provider: string } }; provenance: { contributingEvidence: { firstObservedAt: string }[] } } };
    expect(body.intelligence.mode).toBe('recommendation');
    expect(body.intelligence.projectId).toBe(projectId);
    expect(body.intelligence.recommended.identity.provider).toBe('alpha');
    expect(typeof body.intelligence.provenance.contributingEvidence[0]?.firstObservedAt).toBe('string');
    expect(body.intelligence.provenance.contributingEvidence[0]?.firstObservedAt).toBe('2026-08-29T00:00:00.000Z');
    // The service received the authorized user + the server-resolved project.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.projectId).toBe(projectId);
    expect(calls[0]!.workItemId).toBe(workItemId);
    expect(calls[0]!.userId).toBeTruthy();
  });

  it('GET …/agent-intelligence/delegation returns the serialized decomposition + the submission path', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/work-items/${workItemId}/agent-intelligence/delegation`,
      headers: authHeaders(rawKeyA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { intelligence: { planKey: string; units: { role: string }[]; submissionPath: string; execution: { recommended: { identity: { provider: string } } } } };
    expect(body.intelligence.planKey).toBe('intelligence-recommended');
    expect(body.intelligence.units[0]?.role).toBe('implementer');
    expect(body.intelligence.submissionPath).toBe(`/projects/${projectId}/work-items/${workItemId}/delegation-plans`);
    expect(body.intelligence.execution.recommended.identity.provider).toBe('alpha');
  });

  it('the optional benchmarkMode override is VALIDATED (unknown mode → 400, never a silent pass-through)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/work-items/${workItemId}/agent-intelligence/execution?benchmarkMode=nonsense`,
      headers: authHeaders(rawKeyA),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid-benchmark-mode');
    // The valid mode passes through to the service.
    calls.length = 0;
    const ok = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/work-items/${workItemId}/agent-intelligence/execution?benchmarkMode=cost_constrained`,
      headers: authHeaders(rawKeyA),
    });
    expect(ok.statusCode).toBe(200);
    expect(calls[0]!.benchmarkMode).toBe('cost_constrained');
  });

  it('a missing key is 401; a foreign tenant key is 403 (the advisory surface stays inside the authorized project)', async () => {
    const anon = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/work-items/${workItemId}/agent-intelligence/execution`,
    });
    expect(anon.statusCode).toBe(401);

    const foreign = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/work-items/${workItemId}/agent-intelligence/execution`,
      headers: authHeaders(rawKeyB),
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('the work item must belong to the URL project (server-side resolution — 403 on mismatch, 404 on unknown)', async () => {
    const mismatch = await server.inject({
      method: 'GET',
      url: `/projects/${projectBId}/work-items/${workItemId}/agent-intelligence/execution`,
      headers: authHeaders(rawKeyB),
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().error).toBe('work-item-not-in-project');

    const unknown = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/work-items/00000000-0000-0000-0000-000000000000/agent-intelligence/execution`,
      headers: authHeaders(rawKeyA),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('work-item-not-found');
  });

  it('typed intelligence errors map to 422 fail-closed (never a silent fallback)', async () => {
    const { AgentIntelligenceError } = await import('../../../src/agent-intelligence/index.js');
    const throwing: AgentIntelligenceService = {
      recommendExecution: async () => {
        throw new AgentIntelligenceError(
          'agent-intelligence-ineligible-candidate',
          'an ineligible candidate reached the seam (defense in depth)',
        );
      },
      recommendDelegation: async () => {
        throw new AgentIntelligenceError('agent-intelligence-unknown-role', 'unknown role');
      },
    };
    const localServer = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      agentIntelligence: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        workItemRepository: stack.workItemRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        agentIntelligenceService: throwing,
      },
    });
    try {
      const res = await localServer.inject({
        method: 'GET',
        url: `/projects/${projectId}/work-items/${workItemId}/agent-intelligence/execution`,
        headers: authHeaders(rawKeyA),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('agent-intelligence-ineligible-candidate');
    } finally {
      await localServer.close();
    }
  });
});
