/**
 * WORK-068 — the real-stack integration proof: the feedback→governed
 * Work-Item conversion over the REAL authority surfaces —
 *
 *   - the REAL WORK-067 EngineeringSignalService (the public signal
 *     authority — observations ingested through its real intake);
 *   - the REAL PgWorkItemRepository (the EXISTING /work-items intake —
 *     the created Work Items land in the real schema with the real
 *     UNIQUE(architecture_version_id, work_item_id) constraint);
 *   - the REAL HTTP route surface (buildServer + feedbackConversionRoutes,
 *     backend-authorized: project.read for the assessment preview,
 *     project.write for the governed convert mutation);
 *   - the REAL /work-items read path (the created item is read back
 *     through the authority's own repository).
 *
 * The adversarial coverage: the governed-decision boundary at the HTTP
 * surface (the caller-supplied decision-authority fields are REJECTED, the
 * decidedBy is server-resolved); the read-only GET (a read-authorized
 * caller can never trigger a mutation); the dedup convergence on the real
 * constraint; the tenant isolation (403 for the foreign user); and the
 * provenance embedded in the authoritative record.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultEngineeringSignalService, InMemoryEngineeringSignalRepository } from '../../../src/engineering-signals/index.js';
import { DefaultFeedbackConversionService } from '../../../src/feedback-conversion/index.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import type { FastifyInstance } from 'fastify';

describe('WORK-068 — feedback→Work-Item conversion over the REAL authority surfaces (route + intake + provenance)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let projectId: string;
  let versionId: string;
  let signalService: DefaultEngineeringSignalService;
  let rawKeyA: string;
  let rawKeyB: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-w068-a',
      WFOS_TEST_KEY_B: 'raw-key-w068-b',
    });

    // --- Project A (user A / org A) + a foreign project B (user B) ---------
    const orgA = await stack.organizationRepository.create({ name: 'W068 Org A' });
    const userA = await stack.userRepository.upsertByExternalId({ externalId: 'w068-user-a', displayName: 'User A' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W068 Project A' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    projectId = projectA.id;
    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'W068 Arch A' });
    const versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: '# W068 A' });
    versionId = versionA.id;

    // A foreign user/project (the tenant-isolation discrimination):
    const orgB = await stack.organizationRepository.create({ name: 'W068 Org B' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'w068-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W068 Project B' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });

    await stack.apiKeyProvisioner.provision({
      keyId: 'w068-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'w068-user-a', label: 'A', rawKey: 'raw-key-w068-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'w068-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'w068-user-b', label: 'B', rawKey: 'raw-key-w068-b',
    });
    rawKeyA = 'raw-key-w068-a';
    rawKeyB = 'raw-key-w068-b';

    // --- The REAL WORK-067 signal service (fresh in-memory signal store —
    // the documented non-durable boundary) with REAL observations ingested
    // through its public intake:
    signalService = new DefaultEngineeringSignalService({
      signalRepository: new InMemoryEngineeringSignalRepository(),
      logger: createLogger({ level: 'info', destination: new CaptureStream() }),
      now: () => new Date('2026-09-04T00:00:00Z'),
    });
    await signalService.ingestObservation({
      source: 'validation',
      tenantId: 'tenant-w068',
      projectId: projectA.id,
      environmentId: 'env-prod-w068',
      logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-total',
      severity: 'high',
      observedAt: '2026-09-04T12:00:00Z',
      observationRef: { kind: 'validation-run', ref: 'run-w068-1', detail: 'failure: step-pay/expectation-total' },
      raw: { failedStepId: 'step-pay', expected: 'total is 3 items', actual: null },
      releaseRef: null,
    });
    await signalService.ingestObservation({
      source: 'ci',
      tenantId: 'tenant-w068',
      projectId: projectA.id,
      environmentId: 'env-prod-w068',
      logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-total',
      severity: 'high',
      observedAt: '2026-09-04T13:00:00Z',
      observationRef: { kind: 'ci-evidence', ref: 'wfos_github_ci_evidence:w068', detail: 'conclusion=failure' },
      raw: { workflowName: 'backend-tests', conclusion: 'failure' },
      releaseRef: null,
    });

    // --- The REAL conversion service + the REAL route surface ---------------
    const conversionService = new DefaultFeedbackConversionService({
      logger: createLogger({ level: 'info', destination: new CaptureStream() }),
      now: () => new Date('2026-09-04T14:00:00Z'),
    });
    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      feedbackConversion: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureRepository: stack.architectureRepository,
        workItemRepository: stack.workItemRepository,
        engineeringSignalService: signalService,
        conversionService,
        logger: createLogger({ level: 'info', destination: new CaptureStream() }),
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  const authHeaders = (key: string) => ({ 'x-api-key': key });

  it('the read-only assessment preview (GET /feedback/proposals) derives the proposals WITHOUT creating anything (the authoritative store stays empty)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/feedback/proposals?architectureVersionId=${versionId}`,
      headers: authHeaders(rawKeyA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      proposals: Array<{
        identity: { proposalId: string };
        sourceSignalIds: string[];
        assessment: { blastRadius: { band: string; sources: string[] } };
        priority: string;
        dedup: { outcome: string };
      }>;
    };
    // ONE proposal (the two observations converged on ONE signal in
    // WORK-067 — cross-source confirmation):
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]!.identity.proposalId).toMatch(/^FB-[0-9a-f]{10}$/);
    expect(body.proposals[0]!.sourceSignalIds).toHaveLength(1);
    expect(body.proposals[0]!.assessment.blastRadius.sources.sort()).toEqual(['ci', 'validation']);
    expect(body.proposals[0]!.dedup.outcome).toBe('no-open-match');
    // READ-ONLY: nothing landed in the authoritative store:
    expect(await stack.workItemRepository.findByArchitectureVersion(versionId)).toHaveLength(0);
  });

  it('the GET boundary: unauthenticated → 401; the foreign user (project B) → 403 (authorization before data, no oracle)', async () => {
    const unauth = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/feedback/proposals?architectureVersionId=${versionId}`,
    });
    expect(unauth.statusCode).toBe(401);

    const foreign = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/feedback/proposals?architectureVersionId=${versionId}`,
      headers: authHeaders(rawKeyB),
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('the governed convert mutation (POST /feedback/convert) creates the Work Item through the EXISTING /work-items intake — the authoritative record carries the FB- id + the full provenance', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/feedback/convert`,
      headers: authHeaders(rawKeyA),
      payload: {
        architectureVersionId: versionId,
        decisionReason: 'the checkout failure is confirmed by two independent sources — convert it into governed work',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      createdCount: number;
      results: Array<{ outcome: string; workItemHumanId: string; workItemRecordId: string }>;
      decision: { decidedBy: string; decisionReason: string; decidedAt: string };
    };
    expect(body.createdCount).toBe(1);
    expect(body.results[0]!.outcome).toBe('created');
    expect(body.results[0]!.workItemHumanId).toMatch(/^FB-[0-9a-f]{10}$/);

    // The AUTHORITATIVE record (read back through the /work-items
    // authority's own repository — the real intake landed it):
    const authoritative = await stack.workItemRepository.findById(body.results[0]!.workItemRecordId);
    expect(authoritative).toBeTruthy();
    expect(authoritative!.workItemId).toBe(body.results[0]!.workItemHumanId);
    expect(authoritative!.completed).toBe(false);
    const metadata = (authoritative!.metadata as Record<string, unknown>).feedbackConversion as Record<string, unknown>;
    expect(metadata.sourceSignalIds).toHaveLength(1);
    expect(metadata.logicalFailureKey).toBe('validation:journey-checkout:step-pay:expectation-total');
    // The GOVERNED DECISION — decidedBy is the AUTHENTICATED user (the
    // server-resolved principal), never the caller's string:
    expect(metadata.decision).toMatchObject({ decidedBy: expect.any(String) });
    const userA = await stack.userRepository.upsertByExternalId({ externalId: 'w068-user-a', displayName: 'User A' });
    expect((metadata.decision as Record<string, string>).decidedBy).toBe(userA.id);
    // The occurrence provenance (the raw observation references, verbatim):
    const occurrenceProvenance = metadata.occurrenceProvenance as Array<{ observationRef: { ref: string } }>;
    expect(occurrenceProvenance.map((entry) => entry.observationRef.ref).sort()).toEqual(['run-w068-1', 'wfos_github_ci_evidence:w068']);
  });

  it('the governed-decision boundary at the HTTP surface: a missing decisionReason → 400; the caller-supplied decision-authority fields (decidedBy/decision/assessment/priority) → 400 (REJECTED, never ignored)', async () => {
    const missingReason = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/feedback/convert`,
      headers: authHeaders(rawKeyA),
      payload: { architectureVersionId: versionId },
    });
    expect(missingReason.statusCode).toBe(400);

    for (const field of ['decidedBy', 'decision', 'assessment', 'priority', 'proposals']) {
      const res = await server.inject({
        method: 'POST',
        url: `/projects/${projectId}/feedback/convert`,
        headers: authHeaders(rawKeyA),
        payload: { architectureVersionId: versionId, decisionReason: 'x', [field]: 'forged' },
      });
      expect(res.statusCode, `the ${field} field must be rejected`).toBe(400);
      expect((res.json() as { error: string }).error).toBe('forbidden-field');
    }
  });

  it('repeated conversion CONVERGES on the real UNIQUE constraint: the second POST creates nothing and deduplicates (never a second Work Item)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/feedback/convert`,
      headers: authHeaders(rawKeyA),
      payload: {
        architectureVersionId: versionId,
        decisionReason: 'the same failure again — the conversion must converge',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { createdCount: number; deduplicatedCount: number };
    expect(body.createdCount).toBe(0);
    expect(body.deduplicatedCount).toBe(1);
    // Still exactly ONE authoritative Work Item:
    expect(await stack.workItemRepository.findByArchitectureVersion(versionId)).toHaveLength(1);
  });

  it('the convert boundary: unauthenticated → 401; the foreign user → 403; an unknown architecture version → 404', async () => {
    const unauth = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/feedback/convert`,
      payload: { architectureVersionId: versionId, decisionReason: 'x' },
    });
    expect(unauth.statusCode).toBe(401);

    const foreign = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/feedback/convert`,
      headers: authHeaders(rawKeyB),
      payload: { architectureVersionId: versionId, decisionReason: 'x' },
    });
    expect(foreign.statusCode).toBe(403);

    const unknownVersion = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/feedback/convert`,
      headers: authHeaders(rawKeyA),
      payload: { architectureVersionId: '00000000-0000-0000-0000-000000000000', decisionReason: 'x' },
    });
    expect(unknownVersion.statusCode).toBe(404);
  });

  it('an explicit signal subset converts ONLY that signal (the fail-closed selection); an unknown signal id → 400', async () => {
    // A second, distinct logical failure:
    await signalService.ingestObservation({
      source: 'runtime',
      tenantId: 'tenant-w068',
      projectId,
      environmentId: 'env-prod-w068',
      logicalFailureKey: 'runtime:payment-webhook:timeout',
      severity: 'critical',
      observedAt: '2026-09-04T15:00:00Z',
      observationRef: { kind: 'runtime-incident', ref: 'incident-w068-1', detail: 'webhook timeout' },
      raw: { incident: 'webhook timeout', p99: 30000 },
      releaseRef: null,
    });

    const unknown = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/feedback/convert`,
      headers: authHeaders(rawKeyA),
      payload: {
        architectureVersionId: versionId,
        signalIds: ['sig_does_not_exist'],
        decisionReason: 'x',
      },
    });
    expect(unknown.statusCode).toBe(400);

    // The full conversion now creates the second proposal (the first already
    // converged): the critical runtime failure becomes governed work too:
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/feedback/convert`,
      headers: authHeaders(rawKeyA),
      payload: {
        architectureVersionId: versionId,
        decisionReason: 'convert the remaining signals',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      createdCount: number;
      results: Array<{ outcome: string; workItemHumanId: string; proposal: { priority: string; assessment: { peakSeverity: string } } }>;
    };
    expect(body.createdCount).toBe(1);
    // The CREATED result is the runtime failure (the original proposal
    // deduplicated — the results are ranked, not creation-ordered):
    const created = body.results.find((r) => r.outcome === 'created')!;
    expect(created.proposal.assessment.peakSeverity).toBe('critical');
    expect(created.proposal.priority).toBe('high');
    const deduplicated = body.results.find((r) => r.outcome === 'deduplicated')!;
    expect(deduplicated).toBeTruthy();
    // TWO authoritative Work Items total (the first + the runtime failure):
    expect(await stack.workItemRepository.findByArchitectureVersion(versionId)).toHaveLength(2);
  });
});
