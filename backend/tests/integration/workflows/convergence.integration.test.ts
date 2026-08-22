import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost, createLogger } from '@platform/index.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkflowOrchestrator, createConvergenceJobHandler } from '../../../src/modules/workflows/internal/workflow-orchestrator.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { DefaultLlmGateway, FakeLlmAdapter } from '../../../src/modules/llm/internal/llm-gateway.js';
import { DefaultArchitectService } from '../../../src/modules/llm/internal/architect-service.js';
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { PgCiEvidenceIngestionRepository } from '../../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { DefaultCiEvidenceIngestionService } from '../../../src/modules/github/internal/ci-evidence-ingestion-service.js';
import { PgGitHubInstallationRepository } from '../../../src/modules/github/internal/pg-github-repository.js';
import { generateExecutionId } from '@platform/ids.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { WorkflowState, ConvergenceSignal } from '@modules/workflows/index.js';

/**
 * WORK-017 — Workflow convergence / automated execution loop.
 *
 * Tests:
 * - Happy-path convergence (DRAFT → ... → VERIFIED)
 * - Correction loop (REQUEST_CHANGES → IMPLEMENTING → ... → APPROVED)
 * - Verification failure loop (VERIFICATION_FAILED → IMPLEMENTING)
 * - Implementation blocked
 * - Architecture change required
 * - Dependency blocking
 * - Duplicate signal (idempotency)
 * - Out-of-order signal (deterministic rejection)
 * - Concurrency
 * - Worker recovery
 * - Tenant isolation
 * - Authority boundaries
 */
describe('WORK-017 — Workflow convergence / automated execution loop', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orchestrator: DefaultWorkflowOrchestrator;
  let workflowEngine: DefaultWorkflowEngine;
  let fakeLlm: FakeLlmAdapter;
  let fakeAgent: FakeAgentAdapter;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };
  let versionB: { id: string };
  let reqA: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-conv-a',
      WFOS_TEST_KEY_B: 'raw-key-conv-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Conv Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Conv Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'conv-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'conv-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Conv Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Conv Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'conv-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'conv-user-a', label: 'User A', rawKey: 'raw-key-conv-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'conv-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'conv-user-b', label: 'User B', rawKey: 'raw-key-conv-b',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Conv Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Conv constraints A' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);
    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'Conv Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'Conv constraints B' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    reqA = await stack.requirementRepository.create({
      architectureVersionId: versionA.id, requirementId: 'REQ-CONV-A-001', title: 'Auth works',
    });
    await stack.acceptanceCriterionRepository.create({
      requirementId: reqA.id, criterionId: 'AC-CONV-1', description: 'Valid auth resolves identity',
    });

    // GitHub installation for project A (for CI evidence ingestion).
    const installationRepo = new PgGitHubInstallationRepository(stack.db.client);
    await installationRepo.create({ projectId: projectA.id, installationId: '999', accountLogin: 'conv-org-a' });

    // Set up fakes + services.
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
    void new DefaultCiEvidenceIngestionService(ciIngestionRepo, installationRepo, logger);
    const verificationService = new DefaultVerificationService(
      stack.db.client, stack.requirementRepository, stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository, stack.workItemRepository,
      stack.workItemRequirementRepository, stack.workItemCriterionRepository,
      ciIngestionRepo, stack.objectStore, logger,
    );
    const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, logger);

    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    workflowEngine = new DefaultWorkflowEngine(
      stack.db.client, logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
    );

    orchestrator = new DefaultWorkflowOrchestrator(
      stack.db.client, logger, queue, workflowEngine,
      stack.workItemRepository, stack.workOrderRepository, depService,
      stack.pullRequestAssociationRepository, agentGateway, agentRunRepo,
      architectService, verificationService, reviewService,
      stack.architectureVersionRepository, stack.architectureRepository,
      stack.projectRepository, generateExecutionId,
    );

    const handlers = buildHandlerRegistry([
      createConvergenceJobHandler(orchestrator, logger),
    ]);
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
        ciEvidenceIngestionService: undefined as never,
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

  // Helper: submit + wait for a signal to be processed.
  async function submitAndWait(signal: {
    workItemId: string;
    signalType: 'initiate' | 'agent_run_completed' | 'pull_request_merged' | 'verification_completed' | 'review_finalized';
    sourceEventId: string;
    payload: Record<string, unknown>;
  }): Promise<ConvergenceSignal> {
    const submitted = await orchestrator.submitSignal({
      ...signal,
      executionId: generateExecutionId(),
    });
    // Wait for the worker to process the signal.
    await waitFor(async () => {
      const s = await orchestrator.getConvergenceStatus(signal.workItemId);
      const found = s.signals.find((sig) => sig.id === submitted.id);
      return found?.processingState === 'processed' || found?.processingState === 'failed';
    }, { timeout: 3000 });
    return submitted;
  }

  async function getState(workItemId: string): Promise<WorkflowState> {
    const exec = await workflowEngine.getState(workItemId);
    if (!exec) throw new Error(`no workflow state for ${workItemId}`);
    return exec.currentState;
  }

  // --- Happy-path convergence ---

  describe('Happy-path convergence', () => {
    it('drives the full loop: DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED', async () => {
      const wi = await createWorkItemA('CONV-HAPPY-001');
      // Set up the LLM fake to return a work order candidate.
      fakeLlm.setResponse(JSON.stringify({
        verdict: 'approve', summary: 'OK', reasoning: '',
        risks: [], constraints: [], corrections: [],
        architectureChangeRequired: false,
        workOrder: {
          scope: 'Implement', outOfScope: 'Nothing',
          constraints: 'Follow arch',
          requirementIds: [], criterionIds: [],
          verificationRequirements: [],
          implementationContext: {},
        },
      }));
      fakeAgent.setOutput('Implementation complete');

      // 1. Initiate → DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN
      await submitAndWait({
        workItemId: wi.id,
        signalType: 'initiate',
        sourceEventId: 'happy-initiate',
        payload: { provider: 'fake', model: 'test-model', agentProvider: 'fake' },
      });

      const stateAfterInit = await getState(wi.id);
      expect(stateAfterInit).toBe('pr_open');

      // 2. Manually transition PR_OPEN → VERIFYING (the orchestrator could
      //    also handle this via an 'agent_run_completed' signal, but for
      //    testing we drive it directly).
      await workflowEngine.transition({
        workItemId: wi.id, toState: 'verifying', actor: 'test',
        executionId: generateExecutionId(),
      });

      // 3. Verification completed (all criteria pass) → ARCHITECT_REVIEW
      await submitAndWait({
        workItemId: wi.id,
        signalType: 'verification_completed',
        sourceEventId: 'happy-verify',
        payload: { allCriteriaPass: true, verificationRunId: 'vr-001' },
      });

      expect(await getState(wi.id)).toBe('architect_review');

      // 4. Review finalized (APPROVE) → APPROVED
      await submitAndWait({
        workItemId: wi.id,
        signalType: 'review_finalized',
        sourceEventId: 'happy-review',
        payload: { outcome: 'APPROVE', reviewId: 'rev-001' },
      });

      expect(await getState(wi.id)).toBe('approved');

      // 5. PR merged → MERGED → VERIFIED
      await submitAndWait({
        workItemId: wi.id,
        signalType: 'pull_request_merged',
        sourceEventId: 'happy-merge',
        payload: { prAssociationId: 'pra-001' },
      });

      expect(await getState(wi.id)).toBe('verified');

      // Verify the workflow history is append-only and complete.
      const history = await workflowEngine.getHistory(wi.id);
      const transitions = history.map((t) => `${t.fromState}→${t.toState}`);
      expect(transitions).toContain('draft→ready');
      expect(transitions).toContain('ready→assigned');
      expect(transitions).toContain('assigned→implementing');
      expect(transitions).toContain('implementing→pr_open');
      expect(transitions).toContain('pr_open→verifying');
      expect(transitions).toContain('verifying→architect_review');
      expect(transitions).toContain('architect_review→approved');
      expect(transitions).toContain('approved→merged');
      expect(transitions).toContain('merged→verified');
    });
  });

  // --- Correction loop ---

  describe('Correction loop', () => {
    it('REQUEST_CHANGES → IMPLEMENTING → PR_OPEN → VERIFYING → ARCHITECT_REVIEW → APPROVED', async () => {
      const wi = await createWorkItemA('CONV-CORR-001');
      fakeLlm.setResponse(JSON.stringify({
        verdict: 'approve', summary: 'OK', reasoning: '',
        risks: [], constraints: [], corrections: [],
        architectureChangeRequired: false,
        workOrder: {
          scope: 'Implement', outOfScope: 'Nothing',
          constraints: 'Follow arch',
          requirementIds: [], criterionIds: [],
          verificationRequirements: [],
          implementationContext: {},
        },
      }));
      fakeAgent.setOutput('Implementation complete');

      // Drive to ARCHITECT_REVIEW.
      await submitAndWait({ workItemId: wi.id, signalType: 'initiate', sourceEventId: 'corr-init', payload: { provider: 'fake', model: 'test-model', agentProvider: 'fake' } });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'verifying', actor: 'test', executionId: generateExecutionId() });
      await submitAndWait({ workItemId: wi.id, signalType: 'verification_completed', sourceEventId: 'corr-verify', payload: { allCriteriaPass: true } });

      expect(await getState(wi.id)).toBe('architect_review');

      // Review 1: REQUEST_CHANGES → CHANGES_REQUESTED
      await submitAndWait({ workItemId: wi.id, signalType: 'review_finalized', sourceEventId: 'corr-review-1', payload: { outcome: 'REQUEST_CHANGES' } });
      expect(await getState(wi.id)).toBe('changes_requested');

      // Correction: CHANGES_REQUESTED → IMPLEMENTING
      await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'pr_open', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'verifying', actor: 'test', executionId: generateExecutionId() });

      // Review 2: APPROVE → APPROVED
      await submitAndWait({ workItemId: wi.id, signalType: 'verification_completed', sourceEventId: 'corr-verify-2', payload: { allCriteriaPass: true } });
      expect(await getState(wi.id)).toBe('architect_review');

      await submitAndWait({ workItemId: wi.id, signalType: 'review_finalized', sourceEventId: 'corr-review-2', payload: { outcome: 'APPROVE' } });
      expect(await getState(wi.id)).toBe('approved');

      // Verify both reviews' history is preserved (prior transitions remain).
      const history = await workflowEngine.getHistory(wi.id);
      const changesRequested = history.filter((t) => t.toState === 'changes_requested');
      expect(changesRequested).toHaveLength(1);
      const approved = history.filter((t) => t.toState === 'approved');
      expect(approved).toHaveLength(1);
    });
  });

  // --- Verification failure loop ---

  describe('Verification failure loop', () => {
    it('VERIFYING → VERIFICATION_FAILED → IMPLEMENTING', async () => {
      const wi = await createWorkItemA('CONV-FAIL-001');
      fakeLlm.setResponse(JSON.stringify({
        verdict: 'approve', summary: 'OK', reasoning: '',
        risks: [], constraints: [], corrections: [],
        architectureChangeRequired: false,
        workOrder: { scope: 'Implement', outOfScope: 'Nothing', constraints: 'Follow arch', requirementIds: [], criterionIds: [], verificationRequirements: [], implementationContext: {} },
      }));
      fakeAgent.setOutput('Implementation complete');

      await submitAndWait({ workItemId: wi.id, signalType: 'initiate', sourceEventId: 'fail-init', payload: { provider: 'fake', model: 'test-model', agentProvider: 'fake' } });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'verifying', actor: 'test', executionId: generateExecutionId() });

      // Verification failed → VERIFICATION_FAILED
      await submitAndWait({ workItemId: wi.id, signalType: 'verification_completed', sourceEventId: 'fail-verify', payload: { allCriteriaPass: false } });
      expect(await getState(wi.id)).toBe('verification_failed');

      // Recovery: VERIFICATION_FAILED → IMPLEMENTING
      await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });
      expect(await getState(wi.id)).toBe('implementing');
    });
  });

  // --- Implementation blocked ---

  describe('Implementation blocked', () => {
    it('IMPLEMENTING → IMPLEMENTATION_BLOCKED → IMPLEMENTING (recovery)', async () => {
      const wi = await createWorkItemA('CONV-BLK-001');
      // Manually drive to IMPLEMENTING.
      await workflowEngine.getOrCreate(wi.id);
      await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'assigned', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });

      // Agent failed → IMPLEMENTATION_BLOCKED (via agent_run_completed signal).
      await submitAndWait({
        workItemId: wi.id, signalType: 'agent_run_completed',
        sourceEventId: 'blk-agent-fail', payload: { status: 'failed' },
      });
      expect(await getState(wi.id)).toBe('implementation_blocked');

      // Recovery: IMPLEMENTATION_BLOCKED → IMPLEMENTING
      await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });
      expect(await getState(wi.id)).toBe('implementing');
    });
  });

  // --- Architecture change required ---

  describe('Architecture change required', () => {
    it('ARCHITECT_REVIEW → ARCHITECTURE_CHANGE_REQUIRED → ARCHITECTURE_CHANGE_REQUEST (terminal)', async () => {
      const wi = await createWorkItemA('CONV-ARCH-001');
      fakeLlm.setResponse(JSON.stringify({
        verdict: 'approve', summary: 'OK', reasoning: '',
        risks: [], constraints: [], corrections: [],
        architectureChangeRequired: false,
        workOrder: { scope: 'Implement', outOfScope: 'Nothing', constraints: 'Follow arch', requirementIds: [], criterionIds: [], verificationRequirements: [], implementationContext: {} },
      }));
      fakeAgent.setOutput('Implementation complete');

      await submitAndWait({ workItemId: wi.id, signalType: 'initiate', sourceEventId: 'arch-init', payload: { provider: 'fake', model: 'test-model', agentProvider: 'fake' } });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'verifying', actor: 'test', executionId: generateExecutionId() });
      await submitAndWait({ workItemId: wi.id, signalType: 'verification_completed', sourceEventId: 'arch-verify', payload: { allCriteriaPass: true } });
      expect(await getState(wi.id)).toBe('architect_review');

      // Review: ARCHITECTURE_CHANGE_REQUIRED
      await submitAndWait({ workItemId: wi.id, signalType: 'review_finalized', sourceEventId: 'arch-review', payload: { outcome: 'ARCHITECTURE_CHANGE_REQUIRED' } });
      expect(await getState(wi.id)).toBe('architecture_change_required');

      // Transition to terminal ARCHITECTURE_CHANGE_REQUEST
      await workflowEngine.transition({ workItemId: wi.id, toState: 'architecture_change_request', actor: 'test', executionId: generateExecutionId() });
      expect(await getState(wi.id)).toBe('architecture_change_request');

      // ArchitectureVersion state must be UNCHANGED (reviews reference, not mutate).
      const version = await stack.architectureVersionRepository.findById(versionA.id);
      expect(version!.state).toBe('frozen');
    });
  });

  // --- Dependency blocking ---

  describe('Dependency blocking', () => {
    it('incomplete dependencies prevent implementation', async () => {
      const wiA = await createWorkItemA('CONV-DEP-001A');
      const wiB = await createWorkItemA('CONV-DEP-001B');
      // wiB depends on wiA (which is not completed).
      await stack.workItemDependencyRepository.add(wiB.id, wiA.id);

      fakeLlm.setResponse(JSON.stringify({
        verdict: 'approve', summary: 'OK', reasoning: '',
        risks: [], constraints: [], corrections: [],
        architectureChangeRequired: false,
        workOrder: { scope: 'Implement', outOfScope: 'Nothing', constraints: 'Follow arch', requirementIds: [], criterionIds: [], verificationRequirements: [], implementationContext: {} },
      }));
      fakeAgent.setOutput('Implementation complete');

      // Initiate wiB — should stay in READY because wiA is not completed.
      await submitAndWait({ workItemId: wiB.id, signalType: 'initiate', sourceEventId: 'dep-init-blocked', payload: { provider: 'fake', model: 'test-model', agentProvider: 'fake' } });
      expect(await getState(wiB.id)).toBe('ready');

      // Complete wiA.
      await stack.workItemCompletionService.markCompleted(wiA.id, true);

      // Re-initiate wiB — should now proceed past READY.
      await submitAndWait({ workItemId: wiB.id, signalType: 'initiate', sourceEventId: 'dep-init-ready', payload: { provider: 'fake', model: 'test-model', agentProvider: 'fake' } });
      const stateAfter = await getState(wiB.id);
      expect(['assigned', 'implementing', 'pr_open']).toContain(stateAfter);
    });
  });

  // --- Duplicate signal (idempotency) ---

  describe('Duplicate signal', () => {
    it('same signal submitted twice → one transition, no duplicate downstream', async () => {
      const wi = await createWorkItemA('CONV-DUP-001');
      // Submit the same initiate signal twice with the same sourceEventId.
      const s1 = await orchestrator.submitSignal({
        workItemId: wi.id, signalType: 'initiate', sourceEventId: 'dup-001',
        executionId: generateExecutionId(), payload: {},
      });
      const s2 = await orchestrator.submitSignal({
        workItemId: wi.id, signalType: 'initiate', sourceEventId: 'dup-001',
        executionId: generateExecutionId(), payload: {},
      });
      // Same signal row (idempotent).
      expect(s1.id).toBe(s2.id);
      // Wait for processing.
      await waitFor(async () => {
        const status = await orchestrator.getConvergenceStatus(wi.id);
        const sig = status.signals.find((s) => s.id === s1.id);
        return sig?.processingState === 'processed' || sig?.processingState === 'failed';
      }, { timeout: 3000 });

      // Only one DRAFT→READY transition in history.
      const history = await workflowEngine.getHistory(wi.id);
      const readyTransitions = history.filter((t) => t.toState === 'ready');
      expect(readyTransitions.length).toBe(1);
    });
  });

  // --- Out-of-order signal ---

  describe('Out-of-order signal', () => {
    it('verification_completed signal while in DRAFT → no state corruption', async () => {
      const wi = await createWorkItemA('CONV-OoO-001');
      // Create the workflow execution first (DRAFT).
      await workflowEngine.getOrCreate(wi.id);
      // Submit verification_completed while the work item is still in DRAFT.
      await submitAndWait({
        workItemId: wi.id, signalType: 'verification_completed',
        sourceEventId: 'ooo-verify', payload: { allCriteriaPass: true },
      });
      // State should remain DRAFT (the signal is ignored — not in VERIFYING).
      expect(await getState(wi.id)).toBe('draft');
    });
  });

  // --- Concurrency ---

  describe('Concurrency', () => {
    it('two simultaneous converge signals → no contradictory transitions', async () => {
      const wi = await createWorkItemA('CONV-CONC-001');
      // Submit two different initiate signals simultaneously (different sourceEventIds).
      const p1 = orchestrator.submitSignal({
        workItemId: wi.id, signalType: 'initiate', sourceEventId: 'conc-001',
        executionId: generateExecutionId(), payload: { provider: 'fake', model: 'test-model', agentProvider: 'fake' },
      });
      const p2 = orchestrator.submitSignal({
        workItemId: wi.id, signalType: 'initiate', sourceEventId: 'conc-002',
        executionId: generateExecutionId(), payload: { provider: 'fake', model: 'test-model', agentProvider: 'fake' },
      });
      await Promise.all([p1, p2]);
      // Wait for both to process.
      await waitFor(async () => {
        const status = await orchestrator.getConvergenceStatus(wi.id);
        return status.signals.length >= 2 && status.signals.every((s) => s.processingState === 'processed' || s.processingState === 'failed');
      }, { timeout: 5000 });

      // The workflow state should be deterministic — both signals converge to
      // the same state. The second signal should be an idempotent no-op
      // (already past READY when the second signal tries).
      const state = await getState(wi.id);
      expect(['pr_open', 'implementing', 'assigned']).toContain(state);
    });
  });

  // --- Worker recovery ---

  describe('Worker recovery', () => {
    it('signal is reconstructable from PostgreSQL after restart', async () => {
      const wi = await createWorkItemA('CONV-RECOV-001');
      // Submit a signal but stop the worker before it processes.
      await worker.stop();
      const signal = await orchestrator.submitSignal({
        workItemId: wi.id, signalType: 'initiate', sourceEventId: 'recov-001',
        executionId: generateExecutionId(), payload: {},
      });
      // The signal is persisted in PostgreSQL but not yet processed.
      const status = await orchestrator.getConvergenceStatus(wi.id);
      const pending = status.signals.find((s) => s.id === signal.id);
      expect(pending).toBeDefined();
      expect(pending!.processingState).toBe('pending');

      // Restart the worker — the pending signal should be processable.
      // (In a real system, a recovery scan would re-enqueue pending signals.
      // For this test, we manually process the signal.)
      await orchestrator.processSignal(signal.id);

      // The signal is now processed.
      const statusAfter = await orchestrator.getConvergenceStatus(wi.id);
      const processed = statusAfter.signals.find((s) => s.id === signal.id);
      expect(processed!.processingState).toBe('processed');

      // Restart the worker for subsequent tests.
      const capture = new CaptureStream();
      const logger = createLogger({ level: 'info', destination: capture });
      const handlers = buildHandlerRegistry([
        createConvergenceJobHandler(orchestrator, logger),
      ]);
      worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });
      await worker.start();
    });
  });

  // --- Tenant isolation ---

  describe('Tenant isolation', () => {
    it('cross-tenant converge denied (403)', async () => {
      const wi = await createWorkItemA('CONV-TEN-001');
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/workflow/converge`,
        headers: { 'x-api-key': 'raw-key-conv-b' }, // User B → Project A
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant signal denied (403)', async () => {
      const wi = await createWorkItemA('CONV-TEN-002');
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/workflow/signals`,
        headers: { 'x-api-key': 'raw-key-conv-b' },
        payload: { signalType: 'verification_completed', sourceEventId: 'ten-sig' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('cross-tenant convergence status denied (403)', async () => {
      const wi = await createWorkItemA('CONV-TEN-003');
      const res = await server.inject({
        method: 'GET', url: `/work-items/${wi.id}/workflow/convergence`,
        headers: { 'x-api-key': 'raw-key-conv-b' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // --- Authority boundaries ---

  describe('Authority boundaries', () => {
    it('agent completion alone does NOT directly mutate workflow state (goes through orchestrator)', async () => {
      // The orchestrator handles agent_run_completed signals and invokes
      // WorkflowEngine.transition(). The agent gateway itself does NOT
      // touch workflow state (verified by static architecture check:
      // /agents does not mutate wfos_workflow_executions).
      const wi = await createWorkItemA('CONV-AUTH-001');
      // Manually drive to IMPLEMENTING.
      await workflowEngine.getOrCreate(wi.id);
      await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'assigned', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });

      // Submit agent_run_completed → orchestrator transitions to PR_OPEN.
      await submitAndWait({
        workItemId: wi.id, signalType: 'agent_run_completed',
        sourceEventId: 'auth-agent', payload: { status: 'success', commitRef: 'sha1', pullRequestRef: 'github:owner/repo#1' },
      });
      expect(await getState(wi.id)).toBe('pr_open');
    });

    it('review finalization goes through orchestrator → WorkflowEngine (not direct mutation)', async () => {
      const wi = await createWorkItemA('CONV-AUTH-002');
      // Drive to ARCHITECT_REVIEW.
      await workflowEngine.getOrCreate(wi.id);
      await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'assigned', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'implementing', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'pr_open', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'verifying', actor: 'test', executionId: generateExecutionId() });
      await workflowEngine.transition({ workItemId: wi.id, toState: 'architect_review', actor: 'test', executionId: generateExecutionId() });

      // Submit review_finalized → orchestrator transitions to APPROVED.
      await submitAndWait({
        workItemId: wi.id, signalType: 'review_finalized',
        sourceEventId: 'auth-review', payload: { outcome: 'APPROVE' },
      });
      expect(await getState(wi.id)).toBe('approved');
    });
  });

  // --- API ---

  describe('API', () => {
    it('API: authorized converge succeeds (202)', async () => {
      const wi = await createWorkItemA('CONV-API-001');
      fakeLlm.setResponse(JSON.stringify({
        verdict: 'approve', summary: 'OK', reasoning: '',
        risks: [], constraints: [], corrections: [],
        architectureChangeRequired: false,
        workOrder: { scope: 'Implement', outOfScope: 'Nothing', constraints: 'Follow arch', requirementIds: [], criterionIds: [], verificationRequirements: [], implementationContext: {} },
      }));
      fakeAgent.setOutput('API test');
      const res = await server.inject({
        method: 'POST', url: `/work-items/${wi.id}/workflow/converge`,
        headers: { 'x-api-key': 'raw-key-conv-a' },
        payload: { provider: 'fake', model: 'test-model', agentProvider: 'fake' },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { signalId: string; accepted: boolean };
      expect(body.accepted).toBe(true);
      expect(body.signalId).toBeTruthy();
    });

    it('API: get convergence status', async () => {
      const wi = await createWorkItemA('CONV-API-002');
      const res = await server.inject({
        method: 'GET', url: `/work-items/${wi.id}/workflow/convergence`,
        headers: { 'x-api-key': 'raw-key-conv-a' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { workflowState: string; signals: unknown[] };
      expect(body.workflowState).toBe('draft');
      expect(body.signals).toEqual([]);
    });
  });
});

// --- Helper: waitFor ---

async function waitFor<T>(
  fn: () => Promise<T>,
  opts: { timeout: number; interval?: number },
): Promise<T> {
  const interval = opts.interval ?? 50;
  const start = Date.now();
  while (Date.now() - start < opts.timeout) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      // Continue waiting.
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${opts.timeout}ms`);
}
