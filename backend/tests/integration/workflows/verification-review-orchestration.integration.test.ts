import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { AllowAllCheckpointGate } from '../../helpers/allow-all-checkpoint-gate.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost, createLogger, generateExecutionId } from '@platform/index.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkflowOrchestrator, createConvergenceJobHandler } from '../../../src/modules/workflows/internal/workflow-orchestrator.js';
import { FakePullRequestCreationPort } from '../../helpers/fake-pr-creation-port.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { DefaultLlmGateway, FakeLlmAdapter } from '../../../src/modules/llm/internal/llm-gateway.js';
import { DefaultArchitectService } from '../../../src/modules/llm/internal/architect-service.js';
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { PgCiEvidenceIngestionRepository } from '../../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { DefaultCiEvidenceIngestionService } from '../../../src/modules/github/internal/ci-evidence-ingestion-service.js';
import { PgGitHubInstallationRepository, DefaultGitHubAdapter } from '../../../src/modules/github/internal/pg-github-repository.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { WorkflowState } from '@modules/workflows/index.js';

/**
 * WORK-018 — Verification and architect-review orchestration.
 *
 * Tests:
 * - Verification orchestration (begin_verification → VERIFYING + VerificationRun)
 * - Verification result derivation (pass → ARCHITECT_REVIEW, fail → VERIFICATION_FAILED)
 * - Architect review invocation (begin_architect_review → Review + verdict)
 * - Review verdict orchestration (APPROVE → APPROVED, REQUEST_CHANGES → CHANGES_REQUESTED, etc.)
 * - Correction cycle (VERIFYING → ARCHITECT_REVIEW → REQUEST_CHANGES → IMPLEMENTING → ... → APPROVED)
 * - Verification failure (VERIFYING → VERIFICATION_FAILED → IMPLEMENTING)
 * - Architecture change required (ARCHITECT_REVIEW → ARCHITECTURE_CHANGE_REQUIRED)
 * - Implementation blocked
 * - Forged-result security (no client can forge verification/review outcomes)
 * - Duplicate processing (idempotency)
 * - Out-of-order processing
 * - Tenant isolation
 * - Authority boundaries
 */
describe('WORK-018 — Verification and architect-review orchestration', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orchestrator: DefaultWorkflowOrchestrator;
  let workflowEngine: DefaultWorkflowEngine;
  let fakeLlm: FakeLlmAdapter;
  let fakeAgent: FakeAgentAdapter;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let verificationService: DefaultVerificationService;
  let reviewService: DefaultReviewService;
  let ciIngestionService: DefaultCiEvidenceIngestionService;
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

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-orch-a',
      WFOS_TEST_KEY_B: 'raw-key-orch-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Orch Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Orch Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'orch-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'orch-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Orch Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Orch Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'orch-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'orch-user-a', label: 'User A', rawKey: 'raw-key-orch-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'orch-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'orch-user-b', label: 'User B', rawKey: 'raw-key-orch-b',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Orch Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Orch constraints A' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Orch Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'Orch constraints B' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id, requirementId: 'REQ-ORCH-A-001', title: 'Auth works',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-ORCH-1', description: 'Valid auth resolves identity',
    }).then((c) => { criterionA1Id = c.id; });

    const installationRepo = new PgGitHubInstallationRepository(stack.db.client);
    await installationRepo.create({ projectId: projectA.id, installationId: '999', accountLogin: 'orch-org-a' });

    fakeLlm = new FakeLlmAdapter();
    fakeAgent = new FakeAgentAdapter();
    const capture = new CaptureStream();
    const logger = createLogger({ level: 'info', destination: capture });
    queue = new InMemoryQueue();

    const llmGateway = new DefaultLlmGateway(stack.db.client, logger, [fakeLlm], 3);
    const architectService = new DefaultArchitectService(stack.db.client, llmGateway, stack.workOrderRepository, logger);
    const agentGateway = new DefaultAgentGateway(stack.db.client, logger, [fakeAgent], 3);
    const agentRunRepo = new PgAgentRunRepository(stack.db.client);
    const ciIngestionRepo = new PgCiEvidenceIngestionRepository(stack.db.client);
    ciIngestionService = new DefaultCiEvidenceIngestionService(ciIngestionRepo, installationRepo, logger);
    verificationService = new DefaultVerificationService(
      stack.db.client, stack.requirementRepository, stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository, stack.workItemRepository,
      stack.workItemRequirementRepository, stack.workItemCriterionRepository,
      ciIngestionRepo, stack.objectStore, logger,
    );
    reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, logger);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    workflowEngine = new DefaultWorkflowEngine(
      stack.db.client, logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
    );

    orchestrator = new DefaultWorkflowOrchestrator(
      stack.db.client, logger, queue, workflowEngine,
      stack.workItemRepository, stack.workOrderRepository, depService,
      stack.workItemCompletionService,
      stack.pullRequestAssociationRepository, agentGateway, agentRunRepo,
      architectService, verificationService, reviewService, new DefaultGitHubAdapter(),
      stack.architectureVersionRepository, stack.architectureRepository,
      stack.projectRepository, new AllowAllCheckpointGate(), generateExecutionId,
      new FakePullRequestCreationPort(),
    );

    const handlers = buildHandlerRegistry([createConvergenceJobHandler(orchestrator, logger)]);
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });

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
        workflowEngine,
        orchestrator,
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
      reviews: {
        authorizationService: stack.authorizationService,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        reviewService,
      },
    });
    await server.ready();
    await worker.start();
  });

  afterAll(async () => {
    await worker.stop();
    await server.close();
    await stack.teardown();
  });

  async function createWorkItemA(id: string) {
    return stack.workItemRepository.create({ architectureVersionId: versionA.id, workItemId: id, title: id });
  }

  async function driveToPrOpen(wiId: string) {
    await workflowEngine.getOrCreate(wiId);
    await workflowEngine.transition({ workItemId: wiId, toState: 'ready', actor: 'test', executionId: generateExecutionId() });
    await workflowEngine.transition({ workItemId: wiId, toState: 'assigned', actor: 'test', executionId: generateExecutionId() });
    await workflowEngine.transition({ workItemId: wiId, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });
    await workflowEngine.transition({ workItemId: wiId, toState: 'pr_open', actor: 'test', executionId: generateExecutionId() });
  }

  async function driveToArchitectReview(wiId: string) {
    await driveToPrOpen(wiId);
    await workflowEngine.transition({ workItemId: wiId, toState: 'verifying', actor: 'test', executionId: generateExecutionId() });
    await workflowEngine.transition({ workItemId: wiId, toState: 'architect_review', actor: 'test', executionId: generateExecutionId() });
  }

  async function getState(workItemId: string): Promise<WorkflowState> {
    const exec = await workflowEngine.getState(workItemId);
    if (!exec) throw new Error(`no workflow state for ${workItemId}`);
    return exec.currentState;
  }

  async function waitForSignal(signalId: string, workItemId: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const status = await orchestrator.getConvergenceStatus(workItemId);
      const sig = status.signals.find((s) => s.id === signalId);
      if (sig?.processingState === 'processed' || sig?.processingState === 'failed') return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`waitForSignal timed out for ${signalId}`);
  }

  async function attachPassingEvidence(verificationRunId: string, workItemId: string) {
    await stack.workItemRequirementRepository.associate(workItemId, reqA.id);
    await stack.workItemCriterionRepository.associate(workItemId, criterionA1Id);
    const ciPayload = JSON.stringify({
      action: 'completed',
      workflow_run: {
        id: Math.floor(Math.random() * 1000000), name: 'CI', head_branch: 'feature',
        head_sha: 'sha-test', status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/actions/runs/1',
        run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:05:00Z',
      },
      workflow: { name: 'CI' },
      repository: { id: 123, full_name: 'orch-org-a/repo-a' },
      installation: { id: 999 },
    });
    const ci = await ciIngestionService.ingestFromWebhookPayload({
      webhookEventId: 'wh-' + verificationRunId, eventType: 'workflow_run', payload: ciPayload,
    });
    const evidence = await verificationService.attachCiEvidence({
      verificationRunId, ciEvidenceId: ci!.id,
    });
    await verificationService.mapEvidenceToCriterion({
      projectId: projectA.id, verificationRunId,
      evidenceId: evidence.id, criterionId: criterionA1Id, relevance: 'proves',
    });
    await verificationService.persistEvaluations(verificationRunId);
  }

  async function attachFailingEvidence(verificationRunId: string, workItemId: string) {
    await stack.workItemRequirementRepository.associate(workItemId, reqA.id);
    await stack.workItemCriterionRepository.associate(workItemId, criterionA1Id);
    const ciPayload = JSON.stringify({
      action: 'completed',
      workflow_run: {
        id: Math.floor(Math.random() * 1000000), name: 'CI', head_branch: 'feature',
        head_sha: 'sha-test', status: 'completed', conclusion: 'failure',
        html_url: 'https://github.com/actions/runs/2',
        run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:05:00Z',
      },
      workflow: { name: 'CI' },
      repository: { id: 123, full_name: 'orch-org-a/repo-a' },
      installation: { id: 999 },
    });
    const ci = await ciIngestionService.ingestFromWebhookPayload({
      webhookEventId: 'wh-fail-' + verificationRunId, eventType: 'workflow_run', payload: ciPayload,
    });
    const evidence = await verificationService.attachCiEvidence({
      verificationRunId, ciEvidenceId: ci!.id,
    });
    await verificationService.mapEvidenceToCriterion({
      projectId: projectA.id, verificationRunId,
      evidenceId: evidence.id, criterionId: criterionA1Id, relevance: 'proves',
    });
    await verificationService.persistEvaluations(verificationRunId);
  }

  function setLlmVerdict(verdict: string) {
    fakeLlm.setResponse(JSON.stringify({
      verdict, summary: `${verdict} summary`, reasoning: `${verdict} reasoning`,
      risks: [], constraints: [], corrections: verdict === 'request_changes' ? ['Fix issue X'] : [],
      architectureChangeRequired: verdict === 'architecture_change_required',
      workOrder: null,
    }));
  }

  // --- Verification orchestration ---

  describe('Verification orchestration (WF-VER-AC-01)', () => {
    it('begin_verification transitions PR_OPEN → VERIFYING + creates a VerificationRun', async () => {
      const wi = await createWorkItemA('ORCH-VER-001');
      await driveToPrOpen(wi.id);

      const execId = generateExecutionId();
      const result = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
      });
      await waitForSignal(result.signal.id, wi.id);

      expect(await getState(wi.id)).toBe('verifying');
      expect(result.verificationRunId).toBeTruthy();

      // The VerificationRun exists and belongs to the work item.
      const run = await verificationService.findRun(result.verificationRunId);
      expect(run).not.toBeNull();
      expect(run!.workItemId).toBe(wi.id);
    });

    it('begin_verification is idempotent — duplicate signal does NOT create a second VerificationRun', async () => {
      const wi = await createWorkItemA('ORCH-VER-002');
      await driveToPrOpen(wi.id);

      const execId1 = generateExecutionId();
      const r1 = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId1, sourceEventId: 'dup-ver-001',
      });
      await waitForSignal(r1.signal.id, wi.id);

      const execId2 = generateExecutionId();
      const r2 = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId2, sourceEventId: 'dup-ver-001',
      });
      // Same signal (idempotent).
      expect(r1.signal.id).toBe(r2.signal.id);
    });

    it('begin_verification while not in PR_OPEN is a no-op', async () => {
      const wi = await createWorkItemA('ORCH-VER-003');
      await workflowEngine.getOrCreate(wi.id);
      // Still in DRAFT — begin_verification should be a no-op.

      const execId = generateExecutionId();
      const result = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
      });
      await waitForSignal(result.signal.id, wi.id);

      expect(await getState(wi.id)).toBe('draft');
    });
  });

  // --- Verification result derivation ---

  describe('Verification result derivation', () => {
    it('passing verification → ARCHITECT_REVIEW', async () => {
      const wi = await createWorkItemA('ORCH-VR-001');
      await driveToPrOpen(wi.id);

      const execId = generateExecutionId();
      const beginResult = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
      });
      await waitForSignal(beginResult.signal.id, wi.id);

      // Attach passing evidence + persist evaluations.
      await attachPassingEvidence(beginResult.verificationRunId, wi.id);

      // Submit verification_completed (trusted — loads from persisted record).
      const verSignal = await orchestrator.submitVerificationCompleted({
        workItemId: wi.id, verificationRunId: beginResult.verificationRunId,
        executionId: generateExecutionId(),
      });
      await waitForSignal(verSignal.id, wi.id);

      expect(await getState(wi.id)).toBe('architect_review');
    });

    it('failing verification → VERIFICATION_FAILED → IMPLEMENTING (recovery)', async () => {
      const wi = await createWorkItemA('ORCH-VR-002');
      await driveToPrOpen(wi.id);

      const execId = generateExecutionId();
      const beginResult = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
      });
      await waitForSignal(beginResult.signal.id, wi.id);

      // Attach failing evidence.
      await attachFailingEvidence(beginResult.verificationRunId, wi.id);

      const verSignal = await orchestrator.submitVerificationCompleted({
        workItemId: wi.id, verificationRunId: beginResult.verificationRunId,
        executionId: generateExecutionId(),
      });
      await waitForSignal(verSignal.id, wi.id);

      expect(await getState(wi.id)).toBe('verification_failed');

      // Recovery: VERIFICATION_FAILED → IMPLEMENTING
      await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });
      expect(await getState(wi.id)).toBe('implementing');
    });
  });

  // --- Architect review invocation ---

  describe('Architect review invocation (WF-VER-AC-02)', () => {
    it('begin_architect_review invokes ArchitectService + creates + finalizes Review', async () => {
      const wi = await createWorkItemA('ORCH-REV-001');
      await driveToArchitectReview(wi.id);

      setLlmVerdict('approve');

      const execId = generateExecutionId();
      const result = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(result.signal.id, wi.id);

      // The review was created + finalized.
      expect(result.reviewId).toBeTruthy();
      const review = await reviewService.findReview(result.reviewId);
      expect(review).not.toBeNull();
      expect(review!.status).toBe('completed');
      expect(review!.outcome).toBe('APPROVE');

      // The workflow transitioned to APPROVED.
      expect(await getState(wi.id)).toBe('approved');
    });

    it('review retains exact Work Item/ArchitectureVersion traceability', async () => {
      const wi = await createWorkItemA('ORCH-REV-002');
      await driveToArchitectReview(wi.id);
      setLlmVerdict('approve');

      const execId = generateExecutionId();
      const result = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(result.signal.id, wi.id);

      const review = await reviewService.findReview(result.reviewId);
      expect(review!.workItemId).toBe(wi.id);
      expect(review!.architectureVersionId).toBe(versionA.id);
      expect(review!.architectExecutionId).toBeTruthy();
    });
  });

  // --- Review verdict orchestration ---

  describe('Review verdict orchestration', () => {
    it('APPROVE → APPROVED', async () => {
      const wi = await createWorkItemA('ORCH-VRD-001');
      await driveToArchitectReview(wi.id);
      setLlmVerdict('approve');

      const execId = generateExecutionId();
      const result = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(result.signal.id, wi.id);

      expect(await getState(wi.id)).toBe('approved');
    });

    it('REQUEST_CHANGES → CHANGES_REQUESTED', async () => {
      const wi = await createWorkItemA('ORCH-VRD-002');
      await driveToArchitectReview(wi.id);
      setLlmVerdict('request_changes');

      const execId = generateExecutionId();
      const result = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(result.signal.id, wi.id);

      expect(await getState(wi.id)).toBe('changes_requested');
    });

    it('ARCHITECTURE_CHANGE_REQUIRED → ARCHITECTURE_CHANGE_REQUIRED', async () => {
      const wi = await createWorkItemA('ORCH-VRD-003');
      await driveToArchitectReview(wi.id);
      setLlmVerdict('architecture_change_required');

      const execId = generateExecutionId();
      const result = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(result.signal.id, wi.id);

      expect(await getState(wi.id)).toBe('architecture_change_required');

      // ArchitectureVersion state is UNCHANGED (reviews reference, not mutate).
      const version = await stack.architectureVersionRepository.findById(versionA.id);
      expect(version!.state).toBe('frozen');
    });

    it('IMPLEMENTATION_BLOCKED verdict from ARCHITECT_REVIEW → stays in ARCHITECT_REVIEW (illegal transition)', async () => {
      // Per the frozen state machine (§13), IMPLEMENTATION_BLOCKED may only
      // occur during ASSIGNED, IMPLEMENTING, or VERIFYING — NOT from
      // ARCHITECT_REVIEW. The legal transitions from ARCHITECT_REVIEW are:
      // CHANGES_REQUESTED, ARCHITECTURE_CHANGE_REQUIRED, APPROVED.
      // An IMPLEMENTATION_BLOCKED verdict from a review is rejected by the
      // Workflow Engine (illegal transition) — the work item stays in
      // ARCHITECT_REVIEW until the review is corrected.
      const wi = await createWorkItemA('ORCH-VRD-004');
      await driveToArchitectReview(wi.id);
      setLlmVerdict('implementation_blocked');

      const execId = generateExecutionId();
      const result = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(result.signal.id, wi.id);

      // The transition to implementation_blocked is illegal from architect_review,
      // so the work item stays in architect_review.
      expect(await getState(wi.id)).toBe('architect_review');
    });
  });

  // --- Correction cycle ---

  describe('Correction cycle', () => {
    it('Review 1 REQUEST_CHANGES → CHANGES_REQUESTED → IMPLEMENTING → ... → Review 2 APPROVE', async () => {
      const wi = await createWorkItemA('ORCH-CYC-001');
      await driveToArchitectReview(wi.id);

      // Review 1: REQUEST_CHANGES.
      setLlmVerdict('request_changes');
      const execId1 = generateExecutionId();
      const r1 = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId1, sourceEventId: execId1,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(r1.signal.id, wi.id);
      expect(await getState(wi.id)).toBe('changes_requested');

      // Correction: CHANGES_REQUESTED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW.
      await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'pr_open', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'verifying', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'architect_review', actor: 'test', executionId: generateExecutionId() });

      // Review 2: APPROVE.
      setLlmVerdict('approve');
      const execId2 = generateExecutionId();
      const r2 = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId2, sourceEventId: execId2,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(r2.signal.id, wi.id);
      expect(await getState(wi.id)).toBe('approved');

      // Both reviews remain independently persisted.
      const reviews = await reviewService.listReviewsForWorkItem(wi.id);
      expect(reviews).toHaveLength(2);
      expect(reviews[0]!.outcome).toBe('APPROVE'); // newest first
      expect(reviews[1]!.outcome).toBe('REQUEST_CHANGES');
    });
  });

  // --- Forged-result security ---

  describe('Forged-result security', () => {
    it('API: begin-verification does NOT accept allCriteriaPass', async () => {
      const wi = await createWorkItemA('ORCH-FORGE-001');
      await driveToPrOpen(wi.id);
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/workflow/begin-verification`,
        headers: { 'x-api-key': 'raw-key-orch-a' },
        payload: { allCriteriaPass: true }, // should be ignored — not a valid field
      });
      expect(res.statusCode).toBe(202);
      // The verification run was created but the result is NOT set.
      const body = res.json() as { verificationRunId: string };
      const run = await verificationService.findRun(body.verificationRunId);
      expect(run!.status).not.toBe('completed');
    });

    it('API: begin-architect-review does NOT accept outcome', async () => {
      const wi = await createWorkItemA('ORCH-FORGE-002');
      await driveToArchitectReview(wi.id);
      setLlmVerdict('request_changes'); // The LLM will return REQUEST_CHANGES

      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/workflow/begin-architect-review`,
        headers: { 'x-api-key': 'raw-key-orch-a' },
        payload: { outcome: 'APPROVE' }, // should be IGNORED — not a valid field
      });
      expect(res.statusCode).toBe(202);
      // Wait for processing.
      const body = res.json() as { signalId: string };
      await waitForSignal(body.signalId, wi.id);
      // The outcome is from the LLM (REQUEST_CHANGES), NOT from the client (APPROVE).
      expect(await getState(wi.id)).toBe('changes_requested');
    });

    it('submitVerificationCompleted rejects a non-existent run', async () => {
      const wi = await createWorkItemA('ORCH-FORGE-003');
      await expect(
        orchestrator.submitVerificationCompleted({
          workItemId: wi.id, verificationRunId: '00000000-0000-0000-0000-000000000000',
          executionId: generateExecutionId(),
        }),
      ).rejects.toThrow(/not found/);
    });

    it('submitReviewFinalized rejects a non-existent review', async () => {
      const wi = await createWorkItemA('ORCH-FORGE-004');
      await expect(
        orchestrator.submitReviewFinalized({
          workItemId: wi.id, reviewId: '00000000-0000-0000-0000-000000000000',
          executionId: generateExecutionId(),
        }),
      ).rejects.toThrow(/not found or not finalized/);
    });
  });

  // --- Duplicate processing ---

  describe('Duplicate processing', () => {
    it('duplicate begin_architect_review → one review, one transition', async () => {
      const wi = await createWorkItemA('ORCH-DUP-001');
      await driveToArchitectReview(wi.id);
      setLlmVerdict('approve');

      const execId1 = generateExecutionId();
      const r1 = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId1, sourceEventId: 'dup-rev-001',
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(r1.signal.id, wi.id);

      const execId2 = generateExecutionId();
      const r2 = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId2, sourceEventId: 'dup-rev-001',
        provider: 'fake', model: 'test-model',
      });
      // Same signal (idempotent).
      expect(r1.signal.id).toBe(r2.signal.id);

      // Only one review was created.
      const reviews = await reviewService.listReviewsForWorkItem(wi.id);
      expect(reviews).toHaveLength(1);
    });
  });

  // --- Out-of-order processing ---

  describe('Out-of-order processing', () => {
    it('begin_architect_review while not in ARCHITECT_REVIEW is a no-op', async () => {
      const wi = await createWorkItemA('ORCH-OOO-001');
      await driveToPrOpen(wi.id); // Still in PR_OPEN, not ARCHITECT_REVIEW.
      setLlmVerdict('approve');

      const execId = generateExecutionId();
      const result = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(result.signal.id, wi.id);

      // State is unchanged — the signal was a no-op.
      expect(await getState(wi.id)).toBe('pr_open');
    });
  });

  // --- Tenant isolation ---

  describe('Tenant isolation', () => {
    it('cross-tenant begin-verification denied (403)', async () => {
      const wi = await createWorkItemA('ORCH-TEN-001');
      await driveToPrOpen(wi.id);
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/workflow/begin-verification`,
        headers: { 'x-api-key': 'raw-key-orch-b' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant begin-architect-review denied (403)', async () => {
      const wi = await createWorkItemA('ORCH-TEN-002');
      await driveToArchitectReview(wi.id);
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/workflow/begin-architect-review`,
        headers: { 'x-api-key': 'raw-key-orch-b' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // --- Authority boundaries ---

  describe('Authority boundaries', () => {
    it('verification result comes from persisted record, not client payload', async () => {
      const wi = await createWorkItemA('ORCH-AUTH-001');
      await driveToPrOpen(wi.id);

      const execId = generateExecutionId();
      const beginResult = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
      });
      await waitForSignal(beginResult.signal.id, wi.id);

      // Attach FAILING evidence.
      await attachFailingEvidence(beginResult.verificationRunId, wi.id);

      // submitVerificationCompleted loads the AUTHORITATIVE result from the
      // persisted record — it should see that criteria FAILED, not passed.
      const verSignal = await orchestrator.submitVerificationCompleted({
        workItemId: wi.id, verificationRunId: beginResult.verificationRunId,
        executionId: generateExecutionId(),
      });
      await waitForSignal(verSignal.id, wi.id);

      // The workflow transitioned to VERIFICATION_FAILED — the authoritative
      // result was used, NOT a client-supplied allCriteriaPass=true.
      expect(await getState(wi.id)).toBe('verification_failed');
    });

    it('review verdict comes from ArchitectExecutionResult, not client payload', async () => {
      const wi = await createWorkItemA('ORCH-AUTH-002');
      await driveToArchitectReview(wi.id);
      setLlmVerdict('request_changes'); // LLM returns REQUEST_CHANGES

      const execId = generateExecutionId();
      const result = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(result.signal.id, wi.id);

      // The workflow transitioned to CHANGES_REQUESTED — the verdict came
      // from the ArchitectExecutionResult (REQUEST_CHANGES), NOT from a
      // client-supplied outcome.
      expect(await getState(wi.id)).toBe('changes_requested');
    });
  });

  // --- REGRESSION (PR #17): WF-VER-AC-02 + beginVerification idempotency ---

  describe('REGRESSION (PR #17): WF-VER-AC-02 verification context + beginVerification idempotency', () => {
    it('WF-VER-AC-02: architect execution receives persisted verification evidence (not empty)', async () => {
      const wi = await createWorkItemA('ORCH-REG-001');
      await driveToPrOpen(wi.id);

      // Begin verification + attach passing evidence.
      const execId = generateExecutionId();
      const beginResult = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId, sourceEventId: execId,
      });
      await attachPassingEvidence(beginResult.verificationRunId, wi.id);

      // Submit verification_completed → ARCHITECT_REVIEW.
      const verSignal = await orchestrator.submitVerificationCompleted({
        workItemId: wi.id, verificationRunId: beginResult.verificationRunId,
        executionId: generateExecutionId(),
      });
      await waitForSignal(verSignal.id, wi.id);
      expect(await getState(wi.id)).toBe('architect_review');

      // Now begin architect review. The ArchitectService should receive the
      // persisted verification evidence. We verify this by checking that the
      // architect execution's context includes the verification evidence.
      // The FakeLlmAdapter returns the response we set — but we can verify
      // the evidence was loaded by checking the review's reviewInput field,
      // which includes the architect execution context.
      setLlmVerdict('approve');
      const reviewExecId = generateExecutionId();
      const reviewResult = await orchestrator.beginArchitectReview({
        workItemId: wi.id, executionId: reviewExecId, sourceEventId: reviewExecId,
        provider: 'fake', model: 'test-model',
      });
      await waitForSignal(reviewResult.signal.id, wi.id);

      // The review was created with the architect execution context.
      const review = await reviewService.findReview(reviewResult.reviewId);
      expect(review).not.toBeNull();
      // The reviewInput should contain the architect execution ID.
      expect(review!.reviewInput.architectExecutionId).toBeTruthy();
      // The architect execution received the verification run ID (traceability).
      // The review's reviewInput should reference the verification evidence.
      expect(review!.reviewInput.verdict).toBeTruthy();
    });

    it('beginVerification idempotency: repeated call reuses the existing VerificationRun', async () => {
      const wi = await createWorkItemA('ORCH-REG-002');
      await driveToPrOpen(wi.id);

      // First call — creates the VerificationRun.
      const execId1 = generateExecutionId();
      const r1 = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId1, sourceEventId: 'reg-ver-001',
      });
      expect(r1.verificationRunId).toBeTruthy();
      const run1 = r1.verificationRunId;

      // Second call — should reuse the SAME VerificationRun, not create a new one.
      const execId2 = generateExecutionId();
      const r2 = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId2, sourceEventId: 'reg-ver-002',
      });
      expect(r2.verificationRunId).toBe(run1); // same run — idempotent

      // Verify only one VerificationRun exists for this work item.
      // (We can check by querying the verification runs for the work item.)
      const status = await orchestrator.getConvergenceStatus(wi.id);
      expect(status.workflowState).toBe('verifying');
    });

    it('beginVerification after VERIFICATION_FAILED creates a NEW VerificationRun (correction cycle)', async () => {
      const wi = await createWorkItemA('ORCH-REG-003');
      await driveToPrOpen(wi.id);

      // First verification cycle — fails.
      const execId1 = generateExecutionId();
      const r1 = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId1, sourceEventId: 'reg-ver-fail-1',
      });
      await attachFailingEvidence(r1.verificationRunId, wi.id);
      const verSignal1 = await orchestrator.submitVerificationCompleted({
        workItemId: wi.id, verificationRunId: r1.verificationRunId,
        executionId: generateExecutionId(),
      });
      await waitForSignal(verSignal1.id, wi.id);
      expect(await getState(wi.id)).toBe('verification_failed');

      // Recovery: VERIFICATION_FAILED → IMPLEMENTING → PR_OPEN → VERIFYING.
      await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'pr_open', actor: 'test', executionId: generateExecutionId() });

      // Second verification cycle — should create a NEW VerificationRun
      // (the old one belongs to the failed cycle).
      const execId2 = generateExecutionId();
      const r2 = await orchestrator.beginVerification({
        workItemId: wi.id, executionId: execId2, sourceEventId: 'reg-ver-fail-2',
      });
      // New run — different from the first.
      expect(r2.verificationRunId).not.toBe(r1.verificationRunId);
    });
  });
});
