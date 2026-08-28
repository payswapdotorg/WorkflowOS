import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultVerificationService, translateGithubConclusion, classifyEvidenceAuthority } from '../../../src/modules/verification/internal/verification-service.js';
import {
  PgEvidenceRepository,
} from '../../../src/modules/verification/internal/pg-verification-repository.js';
import { PgCiEvidenceIngestionRepository } from '../../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { DefaultCiEvidenceIngestionService } from '../../../src/modules/github/internal/ci-evidence-ingestion-service.js';
import { PgGitHubInstallationRepository } from '../../../src/modules/github/internal/pg-github-repository.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { Evidence } from '@modules/verification/index.js';

/**
 * WORK-015 — CI ingestion and verification engine (VERIFY-001..003, GITHUB-006).
 *
 * Tests:
 * - GitHub CI ingestion (provider-independent representation, idempotency, unknown repo)
 * - VerificationRun (creation, traceability, status, execution ID)
 * - Evidence (persistence, authority classification, ObjectStore large artifacts)
 * - Evidence mapping (valid, invalid criterion, cross-tenant, idempotency)
 * - Criterion evaluation (PASS/FAIL/PENDING/BLOCKED, agent-claim ≠ PASS)
 * - Requirement derivation (all pass, failing, pending, blocked)
 * - Tenant isolation (cross-tenant read/write/map/evaluate denied)
 * - Authority (Agent/LLM/GitHub claims cannot directly set PASS)
 * - Workflow boundary (verification does not mutate workflow state)
 * - Object storage (large CI artifact → ObjectStore → evidence.storageKey)
 */
describe('WORK-015 — CI ingestion and verification engine', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let verificationService: DefaultVerificationService;
  let ciIngestionRepo: PgCiEvidenceIngestionRepository;
  let ciIngestionService: DefaultCiEvidenceIngestionService;
  let evidenceRepo: PgEvidenceRepository;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };
  let versionB: { id: string };
  let reqA: { id: string };
  let criterionA1: { id: string };
  let criterionA2: { id: string };
  let reqB: { id: string };
  let criterionB1: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-verify-a',
      WFOS_TEST_KEY_B: 'raw-key-verify-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Verify Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Verify Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'verify-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'verify-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Verify Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Verify Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'verify-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'verify-user-a', label: 'User A', rawKey: 'raw-key-verify-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'verify-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'verify-user-b', label: 'User B', rawKey: 'raw-key-verify-b',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Verify Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Verify constraints A' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Verify Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'Verify constraints B' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id, requirementId: 'REQ-VERIFY-A-001', title: 'Auth works',
    });
    criterionA1 = await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-VERIFY-1', description: 'Valid auth resolves identity',
    });
    criterionA2 = await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-VERIFY-2', description: 'Invalid auth rejected',
    });

    reqB = await stack.requirementRepository.create({
      architectureVersionId: versionB.id, requirementId: 'REQ-VERIFY-B-001', title: 'B works',
    });
    criterionB1 = await stack.acceptanceCriterionRepository.create({
      requirementId: reqB.id, criterionId: 'AC-VERIFY-B-1', description: 'B criterion',
    });

    const installationRepoA = new PgGitHubInstallationRepository(stack.db.client);
    await installationRepoA.create({
      projectId: projectA.id, installationId: '999', accountLogin: 'verify-org-a',
    });

    ciIngestionRepo = new PgCiEvidenceIngestionRepository(stack.db.client);
    ciIngestionService = new DefaultCiEvidenceIngestionService(
      ciIngestionRepo,
      installationRepoA,
      stack.db.logger,
    );

    verificationService = new DefaultVerificationService(
      stack.db.client,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.workItemRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      ciIngestionRepo,
      stack.objectStore,
      stack.db.logger,
    );
    evidenceRepo = new PgEvidenceRepository(stack.db.client);

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      architecture: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureDecisionRepository: stack.architectureDecisionRepository,
        architectureChangeRequestRepository: stack.architectureChangeRequestRepository,
        architectureAssertionRepository: stack.architectureAssertionRepository,
      architectureService: stack.architectureService,
      },
      workItems: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workItemRequirementRepository: stack.workItemRequirementRepository,
        workItemCriterionRepository: stack.workItemCriterionRepository,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
        workOrderRepository: stack.workOrderRepository,
      },
      requirements: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        requirementRepository: stack.requirementRepository,
        requirementDependencyRepository: stack.requirementDependencyRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        evidenceReferenceRepository: stack.evidenceReferenceRepository,
      },
      workflow: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workflowEngine: new DefaultWorkflowEngine(stack.db.client, stack.db.logger),
      },
      verification: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        requirementRepository: stack.requirementRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        verificationService,
        ciEvidenceIngestionService: ciIngestionService,
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  async function createWorkItemA(id: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionA.id, workItemId: id, title: id });
  }

  // Helper: create a Work Item AND associate it with the given criteria + their
  // parent requirement. This is needed because evaluateForRun()/persistEvaluations()
  // scope to the Work Item's associated criteria (PR #14 additional finding —
  // evaluation must not touch unrelated criteria/requirements).
  async function createWorkItemAWithCriteria(
    id: string,
    ...criterionIds: string[]
  ) {
    const wi = await stack.workItemRepository.create({ architectureVersionId: versionA.id, workItemId: id, title: id });
    // Associate the Work Item with the requirement (reqA) so requirement
    // derivation works.
    await stack.workItemRequirementRepository.associate(wi.id, reqA.id);
    // Associate the Work Item with each criterion.
    for (const cid of criterionIds) {
      await stack.workItemCriterionRepository.associate(wi.id, cid);
    }
    return wi;
  }

  function buildWorkflowRunPayload(opts: {
    runId: number;
    conclusion?: string | null;
    status?: string;
    headSha?: string;
    workflowName?: string;
    repoFullName?: string;
    installationId?: number;
  }): string {
    return JSON.stringify({
      action: 'completed',
      workflow_run: {
        id: opts.runId,
        name: opts.workflowName ?? 'CI',
        head_branch: 'feature',
        head_sha: opts.headSha ?? 'abc123',
        status: opts.status ?? 'completed',
        conclusion: opts.conclusion ?? 'success',
        html_url: `https://github.com/actions/runs/${opts.runId}`,
        run_started_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:05:00Z',
      },
      workflow: { name: opts.workflowName ?? 'CI' },
      repository: { id: 123, full_name: opts.repoFullName ?? 'verify-org-a/repo-a' },
      installation: { id: opts.installationId ?? 999 },
    });
  }

  // Helper: attach authoritative CI evidence with a specific result to a run.
  // This routes through the TRUSTED /github CI ingestion path (not the
  // public/manual attachEvidence path) — the only way to produce
  // `authority: 'authoritative'` evidence (PR #14 architect review).
  //
  // Maps the desired EvidenceResult to the appropriate GitHub conclusion:
  //   pass    → 'success'
  //   fail    → 'failure'
  //   blocked → 'cancelled'
  //   unknown → 'neutral'
  let ciRunCounter = 500000;
  async function attachAuthoritativeCi(
    runId: string,
    desiredResult: 'pass' | 'fail' | 'blocked' | 'unknown',
  ): Promise<Evidence> {
    ciRunCounter++;
    const conclusionMap: Record<typeof desiredResult, string> = {
      pass: 'success',
      fail: 'failure',
      blocked: 'cancelled',
      unknown: 'neutral',
    };
    const ci = await ciIngestionService.ingestFromWebhookPayload({
      webhookEventId: `wh-ci-${ciRunCounter}`,
      eventType: 'workflow_run',
      payload: buildWorkflowRunPayload({
        runId: ciRunCounter,
        conclusion: conclusionMap[desiredResult],
      }),
    });
    if (!ci) throw new Error(`attachAuthoritativeCi: CI ingestion returned null for result ${desiredResult}`);
    return verificationService.attachCiEvidence({
      verificationRunId: runId,
      ciEvidenceId: ci.id,
    });
  }

  // --- GitHub CI ingestion ---

  describe('GitHub CI ingestion (GITHUB-006, GH6-AC-01)', () => {
    it('ingests a GitHub Actions workflow_run as provider-independent CI evidence', async () => {
      const payload = buildWorkflowRunPayload({ runId: 100001, conclusion: 'success', headSha: 'sha-verify-1' });
      const result = await ciIngestionService.ingestFromWebhookPayload({
        webhookEventId: 'wh-1', eventType: 'workflow_run', payload,
      });
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('github');
      expect(result!.externalRunId).toBe('workflow_run:100001');
      expect(result!.workflowName).toBe('CI');
      expect(result!.headSha).toBe('sha-verify-1');
      expect(result!.status).toBe('completed');
      expect(result!.conclusion).toBe('success');
      expect(result!.projectId).toBe(projectA.id);
    });

    it('duplicate CI event is idempotent (same external_run_id → one row, updated)', async () => {
      const payload1 = buildWorkflowRunPayload({ runId: 100002, conclusion: 'success' });
      const r1 = await ciIngestionService.ingestFromWebhookPayload({
        webhookEventId: 'wh-2a', eventType: 'workflow_run', payload: payload1,
      });
      const payload2 = buildWorkflowRunPayload({ runId: 100002, conclusion: 'failure' });
      const r2 = await ciIngestionService.ingestFromWebhookPayload({
        webhookEventId: 'wh-2b', eventType: 'workflow_run', payload: payload2,
      });
      expect(r1!.id).toBe(r2!.id);
      expect(r2!.conclusion).toBe('failure');
      const byExt = await ciIngestionRepo.findByExternalRunId('github', 'workflow_run:100002');
      expect(byExt).not.toBeNull();
      expect(byExt!.id).toBe(r1!.id);
    });

    it('invalid/unknown repository mapping (no installation) → no CI evidence created', async () => {
      const payload = buildWorkflowRunPayload({ runId: 100003, installationId: 999999 });
      const result = await ciIngestionService.ingestFromWebhookPayload({
        webhookEventId: 'wh-3', eventType: 'workflow_run', payload,
      });
      expect(result).toBeNull();
    });

    it('non-CI event types are ignored (not ingested as CI evidence)', async () => {
      const result = await ciIngestionService.ingestFromWebhookPayload({
        webhookEventId: 'wh-4',
        eventType: 'pull_request',
        payload: JSON.stringify({ action: 'opened', pull_request: { number: 1 } }),
      });
      expect(result).toBeNull();
    });

    it('API: authorized CI ingestion succeeds (201)', async () => {
      const res = await server.inject({
        method: 'POST', url: `/projects/${projectA.id}/ci-evidence`,
        headers: { 'x-api-key': 'raw-key-verify-a' },
        payload: {
          payload: buildWorkflowRunPayload({ runId: 100004, conclusion: 'success' }),
          eventType: 'workflow_run',
          webhookDeliveryId: 'wh-api-1',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { ingested: boolean; ciEvidence: { externalRunId: string } };
      expect(body.ingested).toBe(true);
      expect(body.ciEvidence.externalRunId).toBe('workflow_run:100004');
    });

    it('API: cross-tenant CI ingestion denied (403)', async () => {
      const res = await server.inject({
        method: 'POST', url: `/projects/${projectB.id}/ci-evidence`,
        headers: { 'x-api-key': 'raw-key-verify-a' },
        payload: {
          payload: buildWorkflowRunPayload({ runId: 100005 }),
          eventType: 'workflow_run',
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // --- VerificationRun ---

  describe('VerificationRun (VERIFY-RUN-AC-01)', () => {
    it('creates a VerificationRun for a Work Item with traceability + execution ID', async () => {
      const wi = await createWorkItemA('VERIFY-RUN-001');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', sourceRef: 'sha-verify-run-1', executionId: 'verify-exec-001',
      });
      expect(run.id).toBeTruthy();
      expect(run.workItemId).toBe(wi.id);
      expect(run.projectId).toBe(projectA.id);
      expect(run.architectureVersionId).toBe(versionA.id);
      expect(run.status).toBe('pending');
      expect(run.executionId).toBe('verify-exec-001');
      expect(run.startedAt).not.toBeNull();
    });

    it('rejects a VerificationRun with mismatched ArchitectureVersion (traceability)', async () => {
      const wi = await createWorkItemA('VERIFY-RUN-002');
      await expect(
        verificationService.createRun({
          projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionB.id,
          source: 'github-actions', executionId: 'verify-exec-002',
        }),
      ).rejects.toThrow();
    });

    it('persists VerificationRun with Work Order reference when provided', async () => {
      const wi = await createWorkItemA('VERIFY-RUN-003');
      const wo = await stack.workOrderRepository.create({
        workItemId: wi.id, projectId: projectA.id, architectureVersionId: versionA.id,
      });
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, workOrderId: wo.id,
        architectureVersionId: versionA.id, source: 'github-actions', executionId: 'verify-exec-003',
      });
      expect(run.workOrderId).toBe(wo.id);
    });
  });

  // --- Evidence ---

  describe('Evidence (VERIFY-RUN-AC-02, VERIFY-RUN-AC-03)', () => {
    it('persists Evidence with provider/reference metadata + result', async () => {
      const wi = await createWorkItemA('VERIFY-EV-001');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'manual', executionId: 'verify-ev-001',
      });
      const evidence = await verificationService.attachEvidence({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceType: 'manual', provider: 'manual',
        externalRef: 'manual-check-1', result: 'pass',
        contentSummary: 'Reviewer verified the auth flow',
      });
      expect(evidence.id).toBeTruthy();
      expect(evidence.verificationRunId).toBe(run.id);
      // PR #14 architect review: manual evidence via the public path is always
      // `claim` — authority is determined server-side, not client-supplied.
      expect(evidence.authority).toBe('claim');
      expect(evidence.result).toBe('pass');
      expect(evidence.provider).toBe('manual');
    });

    it('attaches CI evidence (ingested by /github) to a VerificationRun', async () => {
      const wi = await createWorkItemA('VERIFY-EV-002');
      const ciPayload = buildWorkflowRunPayload({ runId: 200001, conclusion: 'success' });
      const ci = await ciIngestionService.ingestFromWebhookPayload({
        webhookEventId: 'wh-ev-2', eventType: 'workflow_run', payload: ciPayload,
      });
      expect(ci).not.toBeNull();
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-ev-002',
      });
      const evidence = await verificationService.attachCiEvidence({
        verificationRunId: run.id, ciEvidenceId: ci!.id,
      });
      expect(evidence.evidenceType).toBe('ci');
      expect(evidence.authority).toBe('authoritative');
      expect(evidence.result).toBe('pass');
      expect(evidence.provider).toBe('github');
      expect(evidence.headSha).toBe('abc123');
    });

    it('large artifacts can reference ObjectStore (storage_key) — body not in core row', async () => {
      const wi = await createWorkItemA('VERIFY-EV-003');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-ev-003',
      });
      const largeBody = Buffer.from('x'.repeat(100_000));
      const stored = await verificationService.storeLargeArtifact({
        body: largeBody, contentType: 'text/plain',
      });
      expect(stored.key).toBeTruthy();
      expect(stored.contentLength).toBe(100_000);
      const evidence = await verificationService.attachEvidence({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceType: 'test', provider: 'github',
        result: 'pass', contentSummary: 'Large test report (body in ObjectStore)',
        storageKey: stored.key, storageProvider: stored.provider,
        artifactDigest: stored.digestSha256, artifactSizeBytes: stored.contentLength,
        artifactContentType: 'text/plain',
      });
      expect(evidence.storageKey).toBe(stored.key);
      expect(evidence.artifactSizeBytes).toBe(100_000);
      const retrieved = await stack.objectStore.get(stored.key);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.body.length).toBe(100_000);
    });
  });

  // --- Evidence mapping ---

  describe('Evidence → Criterion mapping (VERIFY-MAP-AC-01, VERIFY-MAP-AC-02)', () => {
    it('maps evidence to a valid criterion with relevance', async () => {
      const wi = await createWorkItemA('VERIFY-MAP-001');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-map-001',
      });
      const evidence = await attachAuthoritativeCi(run.id, 'pass');
      const mapping = await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: evidence.id, criterionId: criterionA1.id, relevance: 'proves',
        source: 'auto:github-check',
      });
      expect(mapping.criterionId).toBe(criterionA1.id);
      expect(mapping.evidenceId).toBe(evidence.id);
      expect(mapping.relevance).toBe('proves');
      expect(mapping.mappingStatus).toBe('active');
    });

    it('invalid criterion (nonexistent) is rejected', async () => {
      const wi = await createWorkItemA('VERIFY-MAP-002');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-map-002',
      });
      const evidence = await attachAuthoritativeCi(run.id, 'pass');
      await expect(
        verificationService.mapEvidenceToCriterion({
          projectId: projectA.id, verificationRunId: run.id,
          evidenceId: evidence.id, criterionId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow();
    });

    it('cross-tenant mapping is rejected (mapping integrity trigger)', async () => {
      const wi = await createWorkItemA('VERIFY-MAP-003');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-map-003',
      });
      const evidence = await attachAuthoritativeCi(run.id, 'pass');
      await expect(
        verificationService.mapEvidenceToCriterion({
          projectId: projectA.id, verificationRunId: run.id,
          evidenceId: evidence.id, criterionId: criterionB1.id,
        }),
      ).rejects.toThrow();
    });

    it('duplicate mapping (same evidence + criterion) is idempotent', async () => {
      const wi = await createWorkItemA('VERIFY-MAP-004');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-map-004',
      });
      const evidence = await attachAuthoritativeCi(run.id, 'pass');
      const m1 = await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: evidence.id, criterionId: criterionA1.id,
      });
      const m2 = await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: evidence.id, criterionId: criterionA1.id,
      });
      expect(m1.id).toBe(m2.id);
    });
  });

  // --- Criterion evaluation ---

  describe('Criterion evaluation (VERIFY-EVAL-AC-01, VERIFY-EVAL-AC-02)', () => {
    it('sufficient passing authoritative evidence → PASS', async () => {
      const wi = await createWorkItemA('VERIFY-EVAL-001');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-eval-001',
      });
      const evidence = await attachAuthoritativeCi(run.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: evidence.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      const evalResult = await verificationService.evaluateCriterion({
        verificationRunId: run.id, criterionId: criterionA1.id,
      });
      expect(evalResult.derivedStatus).toBe('pass');
      expect(evalResult.authoritativeEvidencePresent).toBe(true);
      expect(evalResult.supportingEvidenceIds).toContain(evidence.id);
    });

    it('failing authoritative evidence → FAIL', async () => {
      const wi = await createWorkItemA('VERIFY-EVAL-002');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-eval-002',
      });
      const evidence = await attachAuthoritativeCi(run.id, 'fail');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: evidence.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      const evalResult = await verificationService.evaluateCriterion({
        verificationRunId: run.id, criterionId: criterionA1.id,
      });
      expect(evalResult.derivedStatus).toBe('fail');
    });

    it('insufficient evidence → PENDING', async () => {
      const wi = await createWorkItemA('VERIFY-EVAL-003');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-eval-003',
      });
      const evalResult = await verificationService.evaluateCriterion({
        verificationRunId: run.id, criterionId: criterionA2.id,
      });
      expect(evalResult.derivedStatus).toBe('pending');
      expect(evalResult.authoritativeEvidencePresent).toBe(false);
    });

    it('blocked authoritative evidence → BLOCKED', async () => {
      const wi = await createWorkItemA('VERIFY-EVAL-004');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-eval-004',
      });
      const evidence = await attachAuthoritativeCi(run.id, 'blocked');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: evidence.id, criterionId: criterionA1.id, relevance: 'blocks',
      });
      const evalResult = await verificationService.evaluateCriterion({
        verificationRunId: run.id, criterionId: criterionA1.id,
      });
      expect(evalResult.derivedStatus).toBe('blocked');
    });

    it('agent claim without authoritative evidence does NOT produce PASS', async () => {
      const wi = await createWorkItemA('VERIFY-EVAL-005');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-eval-005',
      });
      const claimEvidence = await verificationService.attachEvidence({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceType: 'agent-claim', provider: 'agent',
        result: 'pass', contentSummary: 'Agent claims the tests pass',
      });
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: claimEvidence.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      const evalResult = await verificationService.evaluateCriterion({
        verificationRunId: run.id, criterionId: criterionA1.id,
      });
      expect(evalResult.derivedStatus).toBe('pending');
      expect(evalResult.authoritativeEvidencePresent).toBe(false);
    });

    it('passing CI alone cannot mark UNRELATED criteria PASS (no mapping)', async () => {
      const wi = await createWorkItemA('VERIFY-EVAL-006');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-eval-006',
      });
      const evidence = await attachAuthoritativeCi(run.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: evidence.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      // criterionA2 has NO mapping to this evidence → must be PENDING, not PASS.
      const evalA2 = await verificationService.evaluateCriterion({
        verificationRunId: run.id, criterionId: criterionA2.id,
      });
      expect(evalA2.derivedStatus).toBe('pending');
    });
  });

  // --- Requirement derivation ---

  describe('Requirement derivation (VERIFY-EVAL-AC-03)', () => {
    it('all criteria PASS → requirement satisfied', async () => {
      const wi = await createWorkItemAWithCriteria('VERIFY-REQ-001', criterionA1.id, criterionA2.id);
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-req-001',
      });
      const ev1 = await attachAuthoritativeCi(run.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: ev1.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      const ev2 = await attachAuthoritativeCi(run.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: ev2.id, criterionId: criterionA2.id, relevance: 'proves',
      });
      const result = await verificationService.evaluateForRun(run.id);
      const reqDerivation = result.requirements.find((r) => r.requirementId === reqA.id);
      expect(reqDerivation).toBeDefined();
      expect(reqDerivation!.derivedStatus).toBe('satisfied');
    });

    it('a failing criterion → requirement pending (not satisfied)', async () => {
      const wi = await createWorkItemAWithCriteria('VERIFY-REQ-002', criterionA1.id, criterionA2.id);
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-req-002',
      });
      const ev1 = await attachAuthoritativeCi(run.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: ev1.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      const ev2 = await attachAuthoritativeCi(run.id, 'fail');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: ev2.id, criterionId: criterionA2.id, relevance: 'proves',
      });
      const result = await verificationService.evaluateForRun(run.id);
      const reqDerivation = result.requirements.find((r) => r.requirementId === reqA.id);
      expect(reqDerivation!.derivedStatus).toBe('pending');
    });

    it('a blocked criterion → requirement blocked', async () => {
      const wi = await createWorkItemAWithCriteria('VERIFY-REQ-003', criterionA1.id, criterionA2.id);
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-req-003',
      });
      const ev = await attachAuthoritativeCi(run.id, 'blocked');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: ev.id, criterionId: criterionA1.id, relevance: 'blocks',
      });
      const result = await verificationService.evaluateForRun(run.id);
      const reqDerivation = result.requirements.find((r) => r.requirementId === reqA.id);
      expect(reqDerivation!.derivedStatus).toBe('blocked');
    });

    it('requirement completion does not rely solely on agent claims', async () => {
      const wi = await createWorkItemAWithCriteria('VERIFY-REQ-004', criterionA1.id, criterionA2.id);
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-req-004',
      });
      const claim1 = await verificationService.attachEvidence({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceType: 'agent-claim', provider: 'agent', result: 'pass',
      });
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: claim1.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      const claim2 = await verificationService.attachEvidence({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceType: 'agent-claim', provider: 'agent', result: 'pass',
      });
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: claim2.id, criterionId: criterionA2.id, relevance: 'proves',
      });
      const result = await verificationService.evaluateForRun(run.id);
      const reqDerivation = result.requirements.find((r) => r.requirementId === reqA.id);
      expect(reqDerivation!.derivedStatus).toBe('pending');
    });
  });

  // --- Authority tests ---

  describe('Authority (Agent/LLM/GitHub claims cannot directly set PASS)', () => {
    it('LLM claim evidence cannot produce criterion PASS', async () => {
      const wi = await createWorkItemA('VERIFY-AUTH-001');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-auth-001',
      });
      const llmClaim = await verificationService.attachEvidence({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceType: 'llm-claim', provider: 'llm', result: 'pass',
        contentSummary: 'Architect LLM claims the criterion is met',
      });
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: llmClaim.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      const evalResult = await verificationService.evaluateCriterion({
        verificationRunId: run.id, criterionId: criterionA1.id,
      });
      expect(evalResult.derivedStatus).not.toBe('pass');
      expect(evalResult.derivedStatus).toBe('pending');
    });

    it('GitHub CI ingestion does not directly set criterion status (only /verification evaluates)', async () => {
      const _wi = await createWorkItemA('VERIFY-AUTH-002');
      void _wi;
      const ciPayload = buildWorkflowRunPayload({ runId: 300001, conclusion: 'success' });
      const ci = await ciIngestionService.ingestFromWebhookPayload({
        webhookEventId: 'wh-auth-2', eventType: 'workflow_run', payload: ciPayload,
      });
      expect(ci).not.toBeNull();
      const critBefore = await stack.acceptanceCriterionRepository.findById(criterionA1.id);
      const statusBefore = critBefore!.status;
      const critAfter = await stack.acceptanceCriterionRepository.findById(criterionA1.id);
      expect(critAfter!.status).toBe(statusBefore);
      expect(['pending', 'pass', 'fail', 'blocked']).toContain(statusBefore);
    });

    it('persistEvaluations routes derived statuses through /requirements contract', async () => {
      const wi = await createWorkItemAWithCriteria('VERIFY-AUTH-003', criterionA1.id);
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-auth-003',
      });
      const ev = await attachAuthoritativeCi(run.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: ev.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      const critBefore = await stack.acceptanceCriterionRepository.findById(criterionA1.id);
      expect(critBefore!.status).not.toBe('pass');
      await verificationService.persistEvaluations(run.id);
      const critAfter = await stack.acceptanceCriterionRepository.findById(criterionA1.id);
      expect(critAfter!.status).toBe('pass');
    });
  });

  // --- Workflow boundary ---

  describe('Workflow boundary (verification does not mutate workflow state)', () => {
    it('evaluation does not mutate canonical workflow state', async () => {
      const wi = await createWorkItemA('VERIFY-WF-001');
      const wfEngine = new DefaultWorkflowEngine(stack.db.client, stack.db.logger);
      await wfEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test' });
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-wf-001',
      });
      const ev = await attachAuthoritativeCi(run.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: ev.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      await verificationService.persistEvaluations(run.id);
      const wfState = await wfEngine.getState(wi.id);
      expect(wfState!.currentState).toBe('ready');
    });
  });

  // --- Tenant isolation ---

  describe('Tenant isolation', () => {
    it('cross-tenant verification run creation denied (API 403)', async () => {
      const wi = await createWorkItemA('VERIFY-TENANT-001');
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/verification-runs`,
        headers: { 'x-api-key': 'raw-key-verify-b' },
        payload: { source: 'github-actions' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant evidence attachment denied (API 403)', async () => {
      const wi = await createWorkItemA('VERIFY-TENANT-002');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-tenant-002',
      });
      const res = await server.inject({
        method: 'POST', url: `/verification-runs/${run.id}/evidence`,
        headers: { 'x-api-key': 'raw-key-verify-b' },
        payload: { evidenceType: 'ci', provider: 'github', result: 'pass' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant mapping denied (API 403)', async () => {
      const wi = await createWorkItemA('VERIFY-TENANT-003');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-tenant-003',
      });
      const ev = await attachAuthoritativeCi(run.id, 'pass');
      const res = await server.inject({
        method: 'POST', url: `/verification-runs/${run.id}/evidence-mappings`,
        headers: { 'x-api-key': 'raw-key-verify-b' },
        payload: { evidenceId: ev.id, criterionId: criterionA1.id },
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant evaluate denied (API 403)', async () => {
      const wi = await createWorkItemA('VERIFY-TENANT-004');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-tenant-004',
      });
      const res = await server.inject({
        method: 'POST', url: `/verification-runs/${run.id}/evaluate`,
        headers: { 'x-api-key': 'raw-key-verify-b' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('identifier substitution cannot bypass authorization (cross-tenant criterion)', async () => {
      const wi = await createWorkItemA('VERIFY-TENANT-005');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-tenant-005',
      });
      const ev = await attachAuthoritativeCi(run.id, 'pass');
      await expect(
        verificationService.mapEvidenceToCriterion({
          projectId: projectA.id, verificationRunId: run.id,
          evidenceId: ev.id, criterionId: criterionB1.id,
        }),
      ).rejects.toThrow();
    });
  });

  // --- Object storage ---

  describe('Object storage boundary (DATA3-AC-01, VERIFY-RUN-AC-03)', () => {
    it('large CI artifact → ObjectStore → evidence.storageKey → PostgreSQL (body not in core row)', async () => {
      const wi = await createWorkItemA('VERIFY-OBJ-001');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-obj-001',
      });
      const body = Buffer.from('{"tests":' + JSON.stringify(Array(1000).fill({ pass: true })) + '}');
      const stored = await verificationService.storeLargeArtifact({
        body, contentType: 'application/json',
      });
      const evidence = await verificationService.attachEvidence({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceType: 'test', provider: 'github',
        result: 'pass', contentSummary: 'Large test report',
        storageKey: stored.key, storageProvider: stored.provider,
        artifactDigest: stored.digestSha256, artifactSizeBytes: stored.contentLength,
        artifactContentType: 'application/json',
      });
      const evRow = await evidenceRepo.findById(evidence.id);
      expect(evRow!.storageKey).toBe(stored.key);
      expect(evRow!.artifactSizeBytes).toBe(body.length);
      const retrieved = await stack.objectStore.get(stored.key);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.body).toEqual(body);
    });
  });

  // --- Evaluation scope regression (PR #14 additional finding) ---

  describe('REGRESSION (PR #14 additional): evaluation scoped to Work Item associations', () => {
    it('persistEvaluations does NOT touch unrelated criteria under the same ArchitectureVersion', async () => {
      // Work Item A is associated with criterionA1 ONLY (not criterionA2).
      // Both criteria are under the same requirement (reqA) + ArchitectureVersion.
      const wi = await createWorkItemAWithCriteria('VERIFY-SCOPE-001', criterionA1.id);
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-scope-001',
      });
      // Attach authoritative PASS evidence to criterionA1.
      const ev = await attachAuthoritativeCi(run.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: ev.id, criterionId: criterionA1.id, relevance: 'proves',
      });

      // Record criterionA2's status BEFORE persistEvaluations.
      const critA2Before = await stack.acceptanceCriterionRepository.findById(criterionA2.id);
      const critA2StatusBefore = critA2Before!.status;

      // Persist evaluations for Work Item A's run.
      await verificationService.persistEvaluations(run.id);

      // criterionA1 → PASS (it was in scope + had passing evidence).
      const critA1After = await stack.acceptanceCriterionRepository.findById(criterionA1.id);
      expect(critA1After!.status).toBe('pass');

      // criterionA2 → UNCHANGED (it was NOT associated with Work Item A).
      const critA2After = await stack.acceptanceCriterionRepository.findById(criterionA2.id);
      expect(critA2After!.status).toBe(critA2StatusBefore);
      // Specifically, it must NOT have been overwritten to 'pass' or 'pending'
      // just because criterionA1 (under the same requirement) passed.
      expect(critA2After!.status).not.toBe('pass');
    });

    it('persistEvaluations does NOT persist requirement status when not all criteria are in scope', async () => {
      // reqA has 2 criteria (criterionA1 + criterionA2). Work Item A is
      // associated with criterionA1 ONLY. Even if criterionA1 passes, reqA
      // must NOT be marked 'satisfied' because criterionA2 was not evaluated.
      const wi = await createWorkItemAWithCriteria('VERIFY-SCOPE-002', criterionA1.id);
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-scope-002',
      });
      const ev = await attachAuthoritativeCi(run.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: ev.id, criterionId: criterionA1.id, relevance: 'proves',
      });

      // Record reqA's status BEFORE persistEvaluations.
      const reqABefore = await stack.requirementRepository.findById(reqA.id);
      const reqAStatusBefore = reqABefore!.status;

      // Persist evaluations for Work Item A's run.
      const result = await verificationService.persistEvaluations(run.id);

      // reqA must NOT appear in the requirement derivations — it was skipped
      // because not all its criteria (criterionA2) are in scope.
      const reqADerivation = result.requirements.find((r) => r.requirementId === reqA.id);
      expect(reqADerivation).toBeUndefined();

      // reqA's persisted status must be UNCHANGED.
      const reqAAfter = await stack.requirementRepository.findById(reqA.id);
      expect(reqAAfter!.status).toBe(reqAStatusBefore);
      // Specifically, it must NOT have been marked 'satisfied'.
      expect(reqAAfter!.status).not.toBe('satisfied');
    });

    it('a second Work Item with different criterion associations does not overwrite the first', async () => {
      // Work Item A is associated with criterionA1; Work Item B is associated
      // with criterionA2. Both are under the same requirement (reqA).
      const wiA = await createWorkItemAWithCriteria('VERIFY-SCOPE-003A', criterionA1.id);
      const wiB = await createWorkItemAWithCriteria('VERIFY-SCOPE-003B', criterionA2.id);

      // Run 1 for Work Item A: criterionA1 → PASS.
      const runA = await verificationService.createRun({
        projectId: projectA.id, workItemId: wiA.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-scope-003a',
      });
      const evA = await attachAuthoritativeCi(runA.id, 'pass');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: runA.id,
        evidenceId: evA.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      await verificationService.persistEvaluations(runA.id);

      // criterionA1 → PASS.
      const critA1AfterRunA = await stack.acceptanceCriterionRepository.findById(criterionA1.id);
      expect(critA1AfterRunA!.status).toBe('pass');

      // Run 2 for Work Item B: criterionA2 → FAIL.
      const runB = await verificationService.createRun({
        projectId: projectA.id, workItemId: wiB.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-scope-003b',
      });
      const evB = await attachAuthoritativeCi(runB.id, 'fail');
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: runB.id,
        evidenceId: evB.id, criterionId: criterionA2.id, relevance: 'proves',
      });
      await verificationService.persistEvaluations(runB.id);

      // criterionA2 → FAIL (updated by run B).
      const critA2AfterRunB = await stack.acceptanceCriterionRepository.findById(criterionA2.id);
      expect(critA2AfterRunB!.status).toBe('fail');

      // criterionA1 → STILL PASS (run B did NOT touch criterionA1 — it was
      // not associated with Work Item B).
      const critA1AfterRunB = await stack.acceptanceCriterionRepository.findById(criterionA1.id);
      expect(critA1AfterRunB!.status).toBe('pass');
    });
  });

  // --- Translation helpers ---

  describe('Translation helpers', () => {
    it('translateGithubConclusion maps success → pass, failure → fail, etc.', () => {
      expect(translateGithubConclusion('success', 'completed')).toBe('pass');
      expect(translateGithubConclusion('failure', 'completed')).toBe('fail');
      expect(translateGithubConclusion('timed_out', 'completed')).toBe('fail');
      expect(translateGithubConclusion('cancelled', 'completed')).toBe('blocked');
      expect(translateGithubConclusion('action_required', 'completed')).toBe('blocked');
      expect(translateGithubConclusion('neutral', 'completed')).toBe('unknown');
      expect(translateGithubConclusion('skipped', 'completed')).toBe('unknown');
      expect(translateGithubConclusion(null, 'in_progress')).toBe('unknown');
      expect(translateGithubConclusion('success', 'queued')).toBe('unknown');
    });

    it('classifyEvidenceAuthority: CI via github → authoritative; manual/agent/llm → claim', () => {
      // PR #14 architect review: only CI via /github is authoritative.
      // Manual evidence is now `claim` (not authoritative) — the public
      // attachEvidence path always produces claim evidence.
      expect(classifyEvidenceAuthority('github', 'ci')).toBe('authoritative');
      expect(classifyEvidenceAuthority('manual', 'manual')).toBe('claim');
      expect(classifyEvidenceAuthority('agent', 'agent-claim')).toBe('claim');
      expect(classifyEvidenceAuthority('llm', 'llm-claim')).toBe('claim');
    });
  });

  // --- Authority bypass regression (PR #14 architect review) ---

  describe('REGRESSION (PR #14): verification-authority bypass', () => {
    it('a project writer cannot self-declare authoritative evidence via the API', async () => {
      const wi = await createWorkItemA('VERIFY-BYPASS-001');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-bypass-001',
      });
      // Attempt to manufacture authoritative PASS evidence by sending
      // `authority: 'authoritative'` in the request body.
      const res = await server.inject({
        method: 'POST', url: `/verification-runs/${run.id}/evidence`,
        headers: { 'x-api-key': 'raw-key-verify-a' },
        payload: {
          evidenceType: 'manual',
          provider: 'manual',
          authority: 'authoritative', // ← self-declared — must be IGNORED
          result: 'pass',
          contentSummary: 'I claim this passes',
        },
      });
      expect(res.statusCode).toBe(201);
      const evidence = res.json() as Evidence;
      // The evidence MUST be `claim`, NOT `authoritative` — the client-supplied
      // `authority` field was ignored by the server.
      expect(evidence.authority).toBe('claim');
      expect(evidence.result).toBe('pass'); // result is still pass (claim pass)
      expect(evidence.evidenceType).toBe('manual');
    });

    it('self-declared authoritative evidence + mapping + evaluate does NOT produce criterion PASS', async () => {
      const wi = await createWorkItemA('VERIFY-BYPASS-002');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-bypass-002',
      });
      // Step 1: manufacture "authoritative pass" evidence via the API.
      const evRes = await server.inject({
        method: 'POST', url: `/verification-runs/${run.id}/evidence`,
        headers: { 'x-api-key': 'raw-key-verify-a' },
        payload: {
          evidenceType: 'manual',
          provider: 'manual',
          authority: 'authoritative', // ← self-declared — must be IGNORED
          result: 'pass',
        },
      });
      expect(evRes.statusCode).toBe(201);
      const evidence = evRes.json() as Evidence;
      expect(evidence.authority).toBe('claim'); // NOT authoritative — bypass blocked

      // Step 2: map the evidence to a criterion with relevance 'proves'.
      const mapRes = await server.inject({
        method: 'POST', url: `/verification-runs/${run.id}/evidence-mappings`,
        headers: { 'x-api-key': 'raw-key-verify-a' },
        payload: {
          evidenceId: evidence.id,
          criterionId: criterionA1.id,
          relevance: 'proves',
        },
      });
      expect(mapRes.statusCode).toBe(201);

      // Step 3: evaluate the criterion — it MUST be PENDING, not PASS.
      const evalResult = await verificationService.evaluateCriterion({
        verificationRunId: run.id, criterionId: criterionA1.id,
      });
      expect(evalResult.derivedStatus).toBe('pending');
      expect(evalResult.derivedStatus).not.toBe('pass');
      expect(evalResult.authoritativeEvidencePresent).toBe(false);
    });

    it('only the trusted CI ingestion path produces authoritative evidence', async () => {
      const wi = await createWorkItemA('VERIFY-BYPASS-003');
      const run = await verificationService.createRun({
        projectId: projectA.id, workItemId: wi.id, architectureVersionId: versionA.id,
        source: 'github-actions', executionId: 'verify-bypass-003',
      });
      // Route through the trusted CI ingestion path.
      const evidence = await attachAuthoritativeCi(run.id, 'pass');
      expect(evidence.authority).toBe('authoritative');
      expect(evidence.result).toBe('pass');
      // Map + evaluate → PASS (authoritative evidence present).
      await verificationService.mapEvidenceToCriterion({
        projectId: projectA.id, verificationRunId: run.id,
        evidenceId: evidence.id, criterionId: criterionA1.id, relevance: 'proves',
      });
      const evalResult = await verificationService.evaluateCriterion({
        verificationRunId: run.id, criterionId: criterionA1.id,
      });
      expect(evalResult.derivedStatus).toBe('pass');
      expect(evalResult.authoritativeEvidencePresent).toBe(true);
    });
  });
});
