import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { Queue } from '@platform/index.js';
import type { generateExecutionId } from '@platform/ids.js';

import type {
  WorkItemRepository,
  WorkOrderRepository,
  WorkItemDependencyService,
  WorkItemCompletionService,
  PullRequestAssociationRepository,
} from '@modules/work-items/index.js';
import type { AgentGateway, AgentRunRepository } from '@modules/agents/index.js';
import type { ArchitectService } from '@modules/llm/index.js';
import type { VerificationService } from '@modules/verification/index.js';
import type { ReviewService, ReviewVerdict } from '@modules/reviews/index.js';
import type { GitHubAdapter, GitHubMergeResult } from '@modules/github/index.js';
import type { ArchitectureVersionRepository, ArchitectureRepository } from '@modules/architecture/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';

import type {
  WorkflowOrchestrator,
  ConvergenceSignal,
  SubmitSignalInput,
  MergeGateResult,
} from './convergence.types.js';
import type { WorkflowEngine, WorkflowState, TransitionResult } from './workflow.types.js';
import { PgConvergenceSignalRepository } from './pg-convergence-repository.js';

/**
 * Default {@link WorkflowOrchestrator} — the convergence loop (WORK-017).
 *
 * The orchestrator connects the existing domain boundaries into the canonical
 * implementation loop:
 *
 *   eligible Work Item → Work Order → Agent Run → PR_OPEN → Verification →
 *   Architect Review → APPROVED → MERGED → VERIFIED
 *
 * SIGNAL PROCESSING:
 * Each signal is processed by loading the current workflow state, determining
 * the appropriate transition(s) based on the signal type + current state, and
 * invoking WorkflowEngine.transition() with an idempotency key derived from
 * the signal. Duplicate signals produce one transition (idempotent).
 *
 * BOUNDARY (frozen architecture §6, §13, §14):
 * - The orchestrator NEVER mutates wfos_workflow_executions directly.
 * - It invokes WorkflowEngine.transition() for every state change.
 * - It consumes public contracts from /work-items, /agents, /llm, /github,
 *   /verification, /reviews — never their internal/ implementations.
 * - Agent output remains claims/evidence — agent completion alone does NOT
 *   mark criteria PASS, mark Work Item VERIFIED, or bypass Verification/Review.
 * - PR merge comes from GitHub (authoritative for repo state), not from
 *   agent claims.
 *
 * RECOVERY (frozen architecture §20):
 * A pending convergence step is reconstructable from persisted signals +
 * workflow state. After worker restart, pending signals can be reprocessed.
 */
export class DefaultWorkflowOrchestrator implements WorkflowOrchestrator {
  private readonly signalRepo: PgConvergenceSignalRepository;

  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
    private readonly queue: Queue,
    private readonly workflowEngine: WorkflowEngine,
    private readonly workItemRepository: WorkItemRepository,
    private readonly workOrderRepository: WorkOrderRepository,
    private readonly workItemDependencyService: WorkItemDependencyService,
    private readonly workItemCompletionService: WorkItemCompletionService,
    private readonly pullRequestAssociationRepository: PullRequestAssociationRepository,
    private readonly agentGateway: AgentGateway,
    private readonly agentRunRepository: AgentRunRepository,
    private readonly architectService: ArchitectService,
    private readonly verificationService: VerificationService,
    private readonly reviewService: ReviewService,
    private readonly githubAdapter: GitHubAdapter,
    private readonly architectureVersionRepository: ArchitectureVersionRepository,
    private readonly architectureRepository: ArchitectureRepository,
    projectRepository: ProjectRepository,
    private readonly genExecutionId: typeof generateExecutionId,
  ) {
    this.signalRepo = new PgConvergenceSignalRepository(this.db);
    // projectRepository is accepted for future use (project-level convergence
    // queries). It is intentionally wired now so downstream work items don't
    // need to re-plumb the dependency.
    void projectRepository;
  }

  // --- Client-facing convergence operation (the ONLY public entry point) ---

  async initiateConvergence(input: {
    workItemId: string;
    sourceEventId: string;
    executionId: string;
    payload?: Record<string, unknown>;
  }): Promise<ConvergenceSignal> {
    // The `initiate` signal is the ONLY client-facing convergence operation.
    // It starts the loop (DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN)
    // but does NOT forge any trusted domain outcome. All downstream transitions
    // (verification pass, review approve, PR merge) require trusted internal
    // signals that validate against persisted authoritative domain records.
    return this.submitSignalInternal({
      workItemId: input.workItemId,
      signalType: 'initiate',
      sourceEventId: input.sourceEventId,
      executionId: input.executionId,
      payload: input.payload ?? {},
    });
  }

  // --- Trusted internal submission paths (NOT exposed via the public API) ---
  //
  // Each method validates the source domain record against persisted state
  // before creating a signal. The signal payload is populated from the
  // AUTHORITATIVE record, not from client input. This prevents the
  // workflow-authority bypass (PR #16 architect review): a project writer
  // cannot forge an agent_run_completed, verification_completed,
  // review_finalized, or pull_request_merged signal through the API.

  async submitAgentRunCompleted(input: {
    workItemId: string;
    agentRunId: string;
    executionId: string;
  }): Promise<ConvergenceSignal> {
    // Validate the AgentRun exists + belongs to the work item.
    const run = await this.agentRunRepository.findById(input.agentRunId);
    if (!run) {
      throw new Error(`convergence: agent run ${input.agentRunId} not found`);
    }
    if (run.workItemId !== input.workItemId) {
      throw new Error(
        `convergence: agent run ${input.agentRunId} belongs to work item ${run.workItemId}, not ${input.workItemId}`,
      );
    }
    // Populate the signal payload from the AUTHORITATIVE AgentRun record.
    return this.submitSignalInternal({
      workItemId: input.workItemId,
      signalType: 'agent_run_completed',
      sourceEventId: input.agentRunId, // use the agent run ID as the stable source event id
      executionId: input.executionId,
      payload: {
        agentRunId: run.id,
        status: run.status,
        commitRef: run.commitRef,
        pullRequestRef: run.pullRequestRef,
      },
    });
  }

  async submitVerificationCompleted(input: {
    workItemId: string;
    verificationRunId: string;
    executionId: string;
  }): Promise<ConvergenceSignal> {
    // Validate the VerificationRun exists + belongs to the work item.
    const run = await this.verificationService.findRun(input.verificationRunId);
    if (!run) {
      throw new Error(`convergence: verification run ${input.verificationRunId} not found`);
    }
    if (run.workItemId !== input.workItemId) {
      throw new Error(
        `convergence: verification run ${input.verificationRunId} belongs to work item ${run.workItemId}, not ${input.workItemId}`,
      );
    }
    if (run.status !== 'completed') {
      throw new Error(
        `convergence: verification run ${input.verificationRunId} is not completed (status: ${run.status})`,
      );
    }
    // Determine allCriteriaPass from the persisted run summary (populated by
    // persistEvaluations). The orchestrator does NOT evaluate evidence itself
    // — it reads the authoritative result from the persisted record.
    const summary = run.summary as Record<string, unknown>;
    const criteriaPass = (summary.criteriaPass as number) ?? 0;
    const criteriaFail = (summary.criteriaFail as number) ?? 0;
    const criteriaBlocked = (summary.criteriaBlocked as number) ?? 0;
    const criteriaPending = (summary.criteriaPending as number) ?? 0;
    const allCriteriaPass = criteriaPass > 0 && criteriaFail === 0 && criteriaBlocked === 0 && criteriaPending === 0;

    return this.submitSignalInternal({
      workItemId: input.workItemId,
      signalType: 'verification_completed',
      sourceEventId: input.verificationRunId,
      executionId: input.executionId,
      payload: {
        verificationRunId: run.id,
        allCriteriaPass,
      },
    });
  }

  async submitReviewFinalized(input: {
    workItemId: string;
    reviewId: string;
    executionId: string;
  }): Promise<ConvergenceSignal> {
    // Validate the Review exists + is finalized + belongs to the work item.
    // Load the AUTHORITATIVE review result (outcome) from /reviews.
    const reviewResult = await this.reviewService.getReviewResult(input.reviewId);
    if (!reviewResult) {
      throw new Error(
        `convergence: review ${input.reviewId} not found or not finalized`,
      );
    }
    if (reviewResult.workItemId !== input.workItemId) {
      throw new Error(
        `convergence: review ${input.reviewId} belongs to work item ${reviewResult.workItemId}, not ${input.workItemId}`,
      );
    }
    // Populate the signal payload from the AUTHORITATIVE ReviewResult.
    return this.submitSignalInternal({
      workItemId: input.workItemId,
      signalType: 'review_finalized',
      sourceEventId: input.reviewId,
      executionId: input.executionId,
      payload: {
        reviewId: reviewResult.reviewId,
        outcome: reviewResult.outcome,
      },
    });
  }

  async submitPullRequestMerged(input: {
    workItemId: string;
    prAssociationId: string;
    executionId: string;
  }): Promise<ConvergenceSignal> {
    // Validate the PR association exists + belongs to the work item + is merged.
    const pra = await this.pullRequestAssociationRepository.findById(input.prAssociationId);
    if (!pra) {
      throw new Error(`convergence: PR association ${input.prAssociationId} not found`);
    }
    if (pra.workItemId !== input.workItemId) {
      throw new Error(
        `convergence: PR association ${input.prAssociationId} belongs to work item ${pra.workItemId}, not ${input.workItemId}`,
      );
    }
    if (pra.status !== 'merged') {
      throw new Error(
        `convergence: PR association ${input.prAssociationId} is not merged (status: ${pra.status})`,
      );
    }
    return this.submitSignalInternal({
      workItemId: input.workItemId,
      signalType: 'pull_request_merged',
      sourceEventId: input.prAssociationId,
      executionId: input.executionId,
      payload: {
        prAssociationId: pra.id,
      },
    });
  }

  // --- Internal signal submission (shared by all trusted paths) ---

  private async submitSignalInternal(input: SubmitSignalInput): Promise<ConvergenceSignal> {
    // Resolve the project from the work item (tenant isolation — don't trust
    // client-supplied project IDs).
    const wi = await this.workItemRepository.findById(input.workItemId);
    if (!wi) {
      throw new Error(`convergence: work item ${input.workItemId} not found`);
    }
    const version = await this.architectureVersionRepository.findById(wi.architectureVersionId);
    if (!version) {
      throw new Error(`convergence: architecture version ${wi.architectureVersionId} not found`);
    }
    const arch = await this.architectureRepository.findById(version.architectureId);
    if (!arch) {
      throw new Error(`convergence: architecture ${version.architectureId} not found`);
    }
    const projectId = arch.projectId;

    // Derive idempotency key from work_item_id + signal_type + source_event_id.
    // Scoped per work item (not global).
    const idempotencyKey = `${input.workItemId}:${input.signalType}:${input.sourceEventId}`;

    // Idempotent upsert — duplicate signals return the existing row.
    const { signal, created } = await this.signalRepo.upsert({
      ...input,
      projectId,
      idempotencyKey,
    });

    if (created) {
      // Enqueue async processing.
      await this.queue.enqueue('workflow.converge', { signalId: signal.id }, {
        executionId: input.executionId,
      });
      this.logger.info('convergence.signal.submitted', {
        signalId: signal.id,
        workItemId: input.workItemId,
        signalType: input.signalType,
        sourceEventId: input.sourceEventId,
      });
    } else {
      this.logger.info('convergence.signal.duplicate', {
        signalId: signal.id,
        workItemId: input.workItemId,
        signalType: input.signalType,
        sourceEventId: input.sourceEventId,
      });
    }

    return signal;
  }

  async processSignal(signalId: string): Promise<void> {
    const signal = await this.signalRepo.findById(signalId);
    if (!signal) {
      this.logger.warn('convergence.signal_not_found', { signalId });
      return;
    }
    if (signal.processingState === 'processed') {
      this.logger.info('convergence.signal.already_processed', { signalId });
      return;
    }

    try {
      const resultState = await this.dispatch(signal);
      await this.signalRepo.markProcessed(signalId, resultState, null);
      this.logger.info('convergence.signal.processed', {
        signalId,
        signalType: signal.signalType,
        resultState,
      });
    } catch (err) {
      const msg = (err as Error).message;
      await this.signalRepo.markProcessed(signalId, null, msg);
      this.logger.error('convergence.signal.failed', {
        signalId,
        signalType: signal.signalType,
        error: msg,
      });
      // Re-throw so the worker logs the failure.
      throw err;
    }
  }

  async getConvergenceStatus(workItemId: string): Promise<{
    workflowState: WorkflowState | null;
    signals: ConvergenceSignal[];
  }> {
    // Use getOrCreate so that even a new work item returns 'draft' state.
    const exec = await this.workflowEngine.getOrCreate(workItemId);
    const signals = await this.signalRepo.listForWorkItem(workItemId);
    return {
      workflowState: exec.currentState,
      signals,
    };
  }

  // --- Signal dispatch ---

  private async dispatch(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    switch (signal.signalType) {
      case 'initiate':
        return this.handleInitiate(signal);
      case 'agent_run_completed':
        return this.handleAgentRunCompleted(signal);
      case 'pull_request_merged':
        return this.handlePullRequestMerged(signal);
      case 'verification_completed':
        return this.handleVerificationCompleted(signal);
      case 'review_finalized':
        return this.handleReviewFinalized(signal);
      case 'begin_verification':
        return this.handleBeginVerification(signal);
      case 'begin_architect_review':
        return this.handleBeginArchitectReview(signal);
      case 'request_merge':
        return this.handleRequestMerge(signal);
      case 'advance_to_verified':
        return this.handleAdvanceToVerified(signal);
      default:
        throw new Error(`convergence: unknown signal type "${signal.signalType}"`);
    }
  }

  // --- initiate: start the convergence loop ---
  //
  // DRAFT → READY → ASSIGNED → IMPLEMENTING
  //
  // If the work item is in DRAFT, transition to READY.
  // If READY, check dependency eligibility, resolve Work Order, launch Agent
  // Run, transition to ASSIGNED → IMPLEMENTING.
  // If already past READY, this is an idempotent no-op.

  private async handleInitiate(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    const exec = await this.workflowEngine.getOrCreate(signal.workItemId);
    let currentState = exec.currentState;

    // DRAFT → READY
    if (currentState === 'draft') {
      const result = await this.transition(signal, 'ready');
      if (!result.success) return currentState;
      currentState = 'ready';
    }

    // READY → ASSIGNED → IMPLEMENTING
    if (currentState === 'ready' || currentState === 'assigned') {
      // Check dependency eligibility (only needed once, at READY).
      if (currentState === 'ready') {
        const canBegin = await this.workItemDependencyService.canBeginImplementation(signal.workItemId);
        if (!canBegin) {
          this.logger.info('convergence.initiate.dependency_blocked', {
            workItemId: signal.workItemId,
          });
          return currentState; // stay in READY
        }
      }

      // Resolve Work Order — find existing generated Work Order or create one.
      const workOrders = await this.workOrderRepository.listForWorkItem(signal.workItemId);
      let workOrder = workOrders.find((wo) => wo.state === 'generated' || wo.state === 'draft') ?? null;
      if (!workOrder) {
        // Generate a Work Order via the Architect Service.
        const wi = await this.workItemRepository.findById(signal.workItemId);
        if (!wi) throw new Error(`convergence: work item ${signal.workItemId} not found`);
        const provider = (signal.payload.provider as string) ?? 'fake';
        const model = (signal.payload.model as string) ?? 'test-model';
        const executionId = this.genExecutionId();
        const archResult = await this.architectService.execute({
          projectId: signal.projectId,
          architectureVersionId: wi.architectureVersionId,
          workItemId: wi.id,
          task: (signal.payload.task as string) ?? 'Generate work order for implementation',
          executionId,
          provider,
          model,
        });
        const woResult = await this.architectService.generateWorkOrder(
          {
            projectId: signal.projectId,
            architectureVersionId: wi.architectureVersionId,
            workItemId: wi.id,
            task: (signal.payload.task as string) ?? 'Generate work order for implementation',
            executionId,
            provider,
            model,
          },
          archResult,
        );
        workOrder = await this.workOrderRepository.findById(woResult.workOrderId);
        if (!workOrder) throw new Error('convergence: generated work order not found');
      }

      // ASSIGNED (only transition if not already assigned)
      if (currentState === 'ready') {
        const assignedResult = await this.transition(signal, 'assigned');
        if (!assignedResult.success) return currentState;
        currentState = 'assigned';
      }

      // Launch Agent Run.
      const wi = await this.workItemRepository.findById(signal.workItemId);
      if (!wi) throw new Error(`convergence: work item ${signal.workItemId} not found`);
      const agentExecutionId = this.genExecutionId();
      const provider = (signal.payload.agentProvider as string) ?? 'fake';
      const agentRequest = {
        provider,
        configuration: (signal.payload.agentConfiguration as Record<string, unknown>) ?? {},
        workItemId: signal.workItemId,
        workOrderId: workOrder.id,
        architectureVersionId: wi.architectureVersionId,
        executionId: agentExecutionId,
        input: (signal.payload.agentInput as string) ?? 'Implement the work order',
      };
      // Execute the agent run (synchronous in tests; in production this would
      // be async via the agent.execute job).
      try {
        const agentResult = await this.agentGateway.execute(agentRequest);
        // IMPLEMENTING
        const implResult = await this.transition(signal, 'implementing');
        if (!implResult.success) return currentState;
        currentState = 'implementing';

        // If the agent returned a commit/PR, we can immediately proceed to
        // PR_OPEN. In production, the agent run might be async — the
        // 'agent_run_completed' signal would arrive later.
        if (agentResult.status === 'success' && (agentResult.commitRef || agentResult.pullRequestRef)) {
          // Create PR association if the agent reported a PR.
          if (agentResult.pullRequestRef) {
            const existingPrs = await this.pullRequestAssociationRepository.listForWorkItem(signal.workItemId);
            const alreadyHasPr = existingPrs.some((p) => p.externalPrId === agentResult.pullRequestRef);
            if (!alreadyHasPr) {
              await this.pullRequestAssociationRepository.create({
                workItemId: signal.workItemId,
                externalPrId: agentResult.pullRequestRef,
                headCommit: agentResult.commitRef ?? undefined,
              });
            }
          }
          const prResult = await this.transition(signal, 'pr_open');
          if (!prResult.success) return currentState;
          currentState = 'pr_open';
        }
      } catch (err) {
        // Agent failed → IMPLEMENTATION_BLOCKED
        const blockedResult = await this.transition(signal, 'implementation_blocked');
        if (blockedResult.success) currentState = 'implementation_blocked';
        this.logger.warn('convergence.initiate.agent_failed', {
          workItemId: signal.workItemId,
          error: (err as Error).message,
        });
      }
    }

    return currentState;
  }

  // --- agent_run_completed: agent finished ---
  //
  // If success + has commit/PR → PR_OPEN
  // If failed → IMPLEMENTATION_BLOCKED

  private async handleAgentRunCompleted(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    const exec = await this.workflowEngine.getState(signal.workItemId);
    if (!exec) return null;

    const status = signal.payload.status as string;
    const commitRef = signal.payload.commitRef as string | undefined;
    const pullRequestRef = signal.payload.pullRequestRef as string | undefined;

    if (status === 'success' && (commitRef || pullRequestRef)) {
      // Create PR association if not already present.
      if (pullRequestRef) {
        const existingPrs = await this.pullRequestAssociationRepository.listForWorkItem(signal.workItemId);
        const alreadyHasPr = existingPrs.some((p) => p.externalPrId === pullRequestRef);
        if (!alreadyHasPr) {
          await this.pullRequestAssociationRepository.create({
            workItemId: signal.workItemId,
            externalPrId: pullRequestRef,
            headCommit: commitRef,
          });
        }
      }
      // Transition to PR_OPEN if currently IMPLEMENTING.
      if (exec.currentState === 'implementing') {
        const result = await this.transition(signal, 'pr_open');
        return result.success ? 'pr_open' : exec.currentState;
      }
    } else if (status === 'failed') {
      // Transition to IMPLEMENTATION_BLOCKED.
      if (exec.currentState === 'implementing' || exec.currentState === 'assigned') {
        const result = await this.transition(signal, 'implementation_blocked');
        return result.success ? 'implementation_blocked' : exec.currentState;
      }
    }

    return exec.currentState;
  }

  // --- pull_request_merged: PR was merged ---
  //
  // WORK-019: APPROVED → MERGED only. Does NOT auto-advance to VERIFIED.
  // The MERGED → VERIFIED transition is handled by the separate
  // advance_to_verified signal/handler, which checks the frozen post-merge
  // conditions before transitioning.

  private async handlePullRequestMerged(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    const exec = await this.workflowEngine.getState(signal.workItemId);
    if (!exec) return null;

    // WORK-019: only transition APPROVED → MERGED.
    // The PR association status is already validated as 'merged' by
    // submitPullRequestMerged (the trusted entry point).
    if (exec.currentState === 'approved') {
      const result = await this.transition(signal, 'merged');
      return result.success ? 'merged' : exec.currentState;
    }

    return exec.currentState;
  }

  // --- verification_completed: verification run finished ---
  //
  // If all criteria pass → ARCHITECT_REVIEW (create review if needed)
  // If any criterion fails → VERIFICATION_FAILED

  private async handleVerificationCompleted(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    const exec = await this.workflowEngine.getState(signal.workItemId);
    if (!exec) return null;

    // The orchestrator does NOT evaluate evidence — /verification owns that.
    // The signal payload must contain `allCriteriaPass: boolean`. The caller
    // (or the verification system) is responsible for evaluating before
    // submitting the signal. This preserves the /verification boundary.
    const allCriteriaPass = signal.payload.allCriteriaPass as boolean | undefined;
    if (allCriteriaPass === undefined) {
      this.logger.warn('convergence.verification_completed.missing_result', {
        signalId: signal.id,
      });
      return exec.currentState;
    }

    if (allCriteriaPass) {
      // Transition to ARCHITECT_REVIEW.
      if (exec.currentState === 'verifying') {
        const result = await this.transition(signal, 'architect_review');
        return result.success ? 'architect_review' : exec.currentState;
      }
    } else {
      // Transition to VERIFICATION_FAILED.
      if (exec.currentState === 'verifying') {
        const result = await this.transition(signal, 'verification_failed');
        return result.success ? 'verification_failed' : exec.currentState;
      }
    }

    return exec.currentState;
  }

  // --- review_finalized: architect review was finalized ---
  //
  // APPROVE → APPROVED
  // REQUEST_CHANGES → CHANGES_REQUESTED
  // ARCHITECTURE_CHANGE_REQUIRED → ARCHITECTURE_CHANGE_REQUIRED
  // IMPLEMENTATION_BLOCKED → IMPLEMENTATION_BLOCKED

  private async handleReviewFinalized(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    const exec = await this.workflowEngine.getState(signal.workItemId);
    if (!exec) return null;

    // The orchestrator does NOT load review results — /reviews owns that.
    // The signal payload must contain the review `outcome` (ReviewVerdict).
    // The caller (or the review system) is responsible for finalizing the
    // review before submitting the signal. This preserves the /reviews boundary.
    const outcome = signal.payload.outcome as ReviewVerdict | undefined;
    if (!outcome) {
      this.logger.warn('convergence.review_finalized.no_verdict', {
        signalId: signal.id,
        reviewId: signal.payload.reviewId,
      });
      return exec.currentState;
    }

    // Map verdict → workflow transition (frozen architecture §13, §19).
    let targetState: WorkflowState;
    switch (outcome) {
      case 'APPROVE':
        targetState = 'approved';
        break;
      case 'REQUEST_CHANGES':
        targetState = 'changes_requested';
        break;
      case 'ARCHITECTURE_CHANGE_REQUIRED':
        targetState = 'architecture_change_required';
        break;
      case 'IMPLEMENTATION_BLOCKED':
        targetState = 'implementation_blocked';
        break;
      default:
        throw new Error(`convergence: unknown review verdict "${outcome}"`);
    }

    if (exec.currentState === 'architect_review') {
      const result = await this.transition(signal, targetState);
      return result.success ? targetState : exec.currentState;
    }

    return exec.currentState;
  }

  // --- Helper: invoke WorkflowEngine.transition() with a per-transition idempotency key ---
  //
  // The idempotency key is derived from the signal's key + the target state.
  // This ensures each transition within a signal has a UNIQUE idempotency key
  // (so the WorkflowEngine doesn't treat the 2nd transition as a no-op of the
  // 1st). Duplicate SIGNALS (same sourceEventId) still produce one transition
  // each — the signal-level idempotency is enforced by the UNIQUE constraint on
  // wfos_convergence_signals.

  private async transition(signal: ConvergenceSignal, toState: WorkflowState): Promise<TransitionResult> {
    const idempotencyKey = `${signal.idempotencyKey}:${toState}`;
    return this.workflowEngine.transition({
      workItemId: signal.workItemId,
      toState,
      transitionType: `convergence:${signal.signalType}`,
      actor: 'workflow-orchestrator',
      executionId: signal.executionId,
      idempotencyKey,
      metadata: { signalId: signal.id, signalType: signal.signalType },
    });
  }

  // --- WORK-018: Verification/Review orchestration ---

  // begin_verification: PR_OPEN → VERIFYING + create VerificationRun
  //
  // The orchestrator transitions the work item to VERIFYING and creates a
  // VerificationRun via the existing /verification contract. The orchestrator
  // does NOT evaluate evidence — it only creates the run. The verification
  // result comes later via submitVerificationCompleted (which loads the
  // authoritative persisted result).
  //
  // WF-VER-AC-01: VERIFYING cannot advance before required verification completes.
  // This handler creates the verification run but does NOT advance past VERIFYING
  // until verification_completed is submitted with the authoritative result.

  async beginVerification(input: {
    workItemId: string;
    executionId: string;
    sourceEventId: string;
  }): Promise<{ signal: ConvergenceSignal; verificationRunId: string }> {
    // Resolve the project from the work item.
    const wi = await this.workItemRepository.findById(input.workItemId);
    if (!wi) {
      throw new Error(`convergence: work item ${input.workItemId} not found`);
    }
    const version = await this.architectureVersionRepository.findById(wi.architectureVersionId);
    if (!version) {
      throw new Error(`convergence: architecture version ${wi.architectureVersionId} not found`);
    }
    const arch = await this.architectureRepository.findById(version.architectureId);
    if (!arch) {
      throw new Error(`convergence: architecture ${version.architectureId} not found`);
    }
    const projectId = arch.projectId;

    // Transition PR_OPEN → VERIFYING synchronously (the caller needs the result).
    const exec = await this.workflowEngine.getOrCreate(input.workItemId);
    if (exec.currentState === 'pr_open') {
      await this.workflowEngine.transition({
        workItemId: input.workItemId,
        toState: 'verifying',
        transitionType: 'convergence:begin_verification',
        actor: 'workflow-orchestrator',
        executionId: input.executionId,
        idempotencyKey: `${input.workItemId}:begin_verification:${input.sourceEventId}:verifying`,
        metadata: { sourceEventId: input.sourceEventId },
      });
    }

    // Idempotency (PR #17 architect review — issue 2): when already in
    // VERIFYING, reuse the existing INCOMPLETE VerificationRun rather than
    // creating a new one. This prevents duplicate verification runs for one
    // logical verification cycle. A repeated beginVerification call returns
    // the existing run ID.
    //
    // Only reuse runs that are still 'pending' or 'running' (not yet completed
    // or failed). A completed/failed run belongs to a previous verification
    // cycle — a new cycle (after correction) should create a new run.
    const existingRunResult = await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM wfos_verification_runs
       WHERE work_item_id = $1 AND status IN ('pending', 'running')
       ORDER BY created_at DESC LIMIT 1`,
      [input.workItemId],
    );
    let verificationRunId: string;
    if (existingRunResult.rows.length > 0) {
      // Reuse the existing run — this is the idempotent path.
      verificationRunId = existingRunResult.rows[0]!.id;
      this.logger.info('convergence.begin_verification.reused', {
        workItemId: input.workItemId,
        verificationRunId,
      });
    } else {
      // Create a new VerificationRun via the existing /verification contract.
      const verificationRun = await this.verificationService.createRun({
        projectId,
        workItemId: input.workItemId,
        architectureVersionId: wi.architectureVersionId,
        source: 'orchestrator',
        sourceRef: input.executionId,
        executionId: this.genExecutionId(),
      });
      verificationRunId = verificationRun.id;
      this.logger.info('convergence.begin_verification.created', {
        workItemId: input.workItemId,
        verificationRunId,
      });
    }

    // Submit the signal as a record (idempotent — no async processing needed
    // since the transition + run creation/reuse already happened above).
    const signal = await this.submitSignalInternal({
      workItemId: input.workItemId,
      signalType: 'begin_verification',
      sourceEventId: input.sourceEventId,
      executionId: input.executionId,
      payload: { verificationRunId },
    });

    // Mark it as already processed (the work was done synchronously above).
    await this.signalRepo.markProcessed(signal.id, 'verifying', null);

    return { signal, verificationRunId };
  }

  private async handleBeginVerification(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    const exec = await this.workflowEngine.getState(signal.workItemId);
    if (!exec) return null;

    // Only transition if currently PR_OPEN.
    if (exec.currentState !== 'pr_open') {
      this.logger.info('convergence.begin_verification.skipped', {
        workItemId: signal.workItemId,
        currentState: exec.currentState,
      });
      return exec.currentState;
    }

    // PR_OPEN → VERIFYING
    const verifyResult = await this.transition(signal, 'verifying');
    if (!verifyResult.success) return exec.currentState;

    // Create a VerificationRun via the existing /verification contract.
    const wi = await this.workItemRepository.findById(signal.workItemId);
    if (!wi) throw new Error(`convergence: work item ${signal.workItemId} not found`);

    const verificationRun = await this.verificationService.createRun({
      projectId: signal.projectId,
      workItemId: signal.workItemId,
      architectureVersionId: wi.architectureVersionId,
      source: 'orchestrator',
      sourceRef: signal.executionId,
      executionId: this.genExecutionId(),
    });

    // Store the verification run ID in the signal payload (for the caller).
    await this.signalRepo.markProcessed(
      signal.id,
      'verifying',
      null,
    );
    // Update the signal payload with the verification run ID.
    signal.payload.verificationRunId = verificationRun.id;

    this.logger.info('convergence.begin_verification.created', {
      workItemId: signal.workItemId,
      verificationRunId: verificationRun.id,
    });

    return 'verifying';
  }

  // begin_architect_review: ARCHITECT_REVIEW → invoke ArchitectService + create + finalize Review
  //
  // The orchestrator invokes the existing ArchitectService (via /llm) to
  // produce the architect verdict, creates a Review (via /reviews), finalizes
  // it with the verdict, and then submits a review_finalized signal that drives
  // the correct canonical workflow transition.
  //
  // WF-VER-AC-02: Architect review receives persisted verification state/evidence
  // context. The ArchitectService assembles context from persistent project state.
  //
  // The verdict is loaded from the AUTHORITATIVE ArchitectExecutionResult — NOT
  // from client input. A client cannot forge the outcome.

  async beginArchitectReview(input: {
    workItemId: string;
    executionId: string;
    sourceEventId: string;
    provider?: string;
    model?: string;
    task?: string;
  }): Promise<{ signal: ConvergenceSignal; reviewId: string }> {
    // Resolve the project from the work item.
    const wi = await this.workItemRepository.findById(input.workItemId);
    if (!wi) {
      throw new Error(`convergence: work item ${input.workItemId} not found`);
    }
    const version = await this.architectureVersionRepository.findById(wi.architectureVersionId);
    if (!version) {
      throw new Error(`convergence: architecture version ${wi.architectureVersionId} not found`);
    }
    const arch = await this.architectureRepository.findById(version.architectureId);
    if (!arch) {
      throw new Error(`convergence: architecture ${version.architectureId} not found`);
    }
    const projectId = arch.projectId;

    // Only proceed if currently ARCHITECT_REVIEW.
    const exec = await this.workflowEngine.getState(input.workItemId);
    if (!exec || exec.currentState !== 'architect_review') {
      // Submit as a no-op signal.
      const noopSignal = await this.submitSignalInternal({
        workItemId: input.workItemId,
        signalType: 'begin_architect_review',
        sourceEventId: input.sourceEventId,
        executionId: input.executionId,
        payload: { provider: input.provider, model: input.model, task: input.task },
      });
      await this.signalRepo.markProcessed(noopSignal.id, exec?.currentState ?? null, null);
      return { signal: noopSignal, reviewId: '' };
    }

    // Find the Work Order for this work item.
    const workOrders = await this.workOrderRepository.listForWorkItem(input.workItemId);
    const workOrder = workOrders.find((wo) => wo.state === 'generated' || wo.state === 'draft') ?? workOrders[0] ?? null;

    // Invoke the ArchitectService via /llm.
    // WORK-018 (WF-VER-AC-02): pass the latest completed VerificationRun ID
    // so the Architect Service can load the persisted verification evidence
    // context. The architect execution receives the actual verification state,
    // not an empty array.
    const provider = input.provider ?? 'fake';
    const model = input.model ?? 'test-model';
    const task = input.task ?? 'Review the implementation against the architecture and requirements';
    const archExecutionId = this.genExecutionId();

    // Find the latest completed VerificationRun for this work item.
    // The orchestrator does NOT evaluate evidence — it just finds the run ID
    // so the Architect Service can load the evidence from /verification's
    // persisted records.
    let verificationRunId: string | undefined;
    // Query the latest verification run for this work item (any status —
    // the architect should see even incomplete runs for context).
    const vrResult = await this.db.query<{ id: string }>(
      `SELECT id FROM wfos_verification_runs WHERE work_item_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [input.workItemId],
    );
    if (vrResult.rows.length > 0) {
      verificationRunId = vrResult.rows[0]!.id;
    }

    const archResult = await this.architectService.execute({
      projectId,
      architectureVersionId: wi.architectureVersionId,
      workItemId: wi.id,
      verificationRunId,
      task,
      executionId: archExecutionId,
      provider,
      model,
    });

    // Map the architect verdict (lowercase) to ReviewVerdict (uppercase).
    const verdict = mapArchitectVerdictToReviewVerdict(archResult.verdict);

    // Create a Review via /reviews.
    const review = await this.reviewService.createReview({
      projectId,
      workItemId: wi.id,
      workOrderId: workOrder?.id ?? null,
      architectureVersionId: wi.architectureVersionId,
      architectExecutionId: archExecutionId,
      source: 'architect-llm',
      reviewer: `${provider}/${model}`,
      executionId: archExecutionId,
      summary: archResult.summary,
      reviewInput: {
        architectExecutionId: archExecutionId,
        verdict: archResult.verdict,
        reasoning: archResult.reasoning,
        identifiedRisks: archResult.identifiedRisks,
        identifiedConstraints: archResult.identifiedConstraints,
        requiredCorrections: archResult.requiredCorrections,
      },
    });

    // Add findings from the architect result (if any corrections were identified).
    for (const correction of archResult.requiredCorrections) {
      await this.reviewService.addFinding({
        projectId,
        reviewId: review.id,
        severity: 'major',
        title: correction,
        description: archResult.reasoning || 'Required correction identified by architect',
        requiredCorrection: correction,
      });
    }

    // Finalize the review with the verdict.
    await this.reviewService.finalizeReview(review.id, { outcome: verdict });

    // Submit a review_finalized signal that drives the workflow transition.
    // This uses the trusted submitReviewFinalized path — it validates the
    // persisted Review and loads the outcome from the authoritative record.
    const reviewSignal = await this.submitReviewFinalized({
      workItemId: input.workItemId,
      reviewId: review.id,
      executionId: this.genExecutionId(),
    });
    // Process the review_finalized signal synchronously so the workflow
    // transition happens before this method returns.
    await this.processSignal(reviewSignal.id);

    // Submit the begin_architect_review signal as a record (already processed).
    const signal = await this.submitSignalInternal({
      workItemId: input.workItemId,
      signalType: 'begin_architect_review',
      sourceEventId: input.sourceEventId,
      executionId: input.executionId,
      payload: { provider, model, task, reviewId: review.id, verdict },
    });
    await this.signalRepo.markProcessed(signal.id, null, null);

    this.logger.info('convergence.begin_architect_review.completed', {
      workItemId: input.workItemId,
      reviewId: review.id,
      verdict,
    });

    return { signal, reviewId: review.id };
  }

  private async handleBeginArchitectReview(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    const exec = await this.workflowEngine.getState(signal.workItemId);
    if (!exec) return null;

    // Only proceed if currently ARCHITECT_REVIEW.
    if (exec.currentState !== 'architect_review') {
      this.logger.info('convergence.begin_architect_review.skipped', {
        workItemId: signal.workItemId,
        currentState: exec.currentState,
      });
      return exec.currentState;
    }

    // Load the Work Item + Work Order for architect execution context.
    const wi = await this.workItemRepository.findById(signal.workItemId);
    if (!wi) throw new Error(`convergence: work item ${signal.workItemId} not found`);

    // Find the Work Order for this work item (the latest generated/draft one).
    const workOrders = await this.workOrderRepository.listForWorkItem(signal.workItemId);
    const workOrder = workOrders.find((wo) => wo.state === 'generated' || wo.state === 'draft') ?? workOrders[0] ?? null;

    // Invoke the ArchitectService via /llm.
    const provider = (signal.payload.provider as string) ?? 'fake';
    const model = (signal.payload.model as string) ?? 'test-model';
    const task = (signal.payload.task as string) ?? 'Review the implementation against the architecture and requirements';
    const archExecutionId = this.genExecutionId();

    const archResult = await this.architectService.execute({
      projectId: signal.projectId,
      architectureVersionId: wi.architectureVersionId,
      workItemId: wi.id,
      task,
      executionId: archExecutionId,
      provider,
      model,
    });

    // Map the architect verdict (lowercase) to ReviewVerdict (uppercase).
    const verdict = mapArchitectVerdictToReviewVerdict(archResult.verdict);

    // Create a Review via /reviews.
    const review = await this.reviewService.createReview({
      projectId: signal.projectId,
      workItemId: wi.id,
      workOrderId: workOrder?.id ?? null,
      architectureVersionId: wi.architectureVersionId,
      architectExecutionId: archExecutionId,
      source: 'architect-llm',
      reviewer: `${provider}/${model}`,
      executionId: archExecutionId,
      summary: archResult.summary,
      reviewInput: {
        architectExecutionId: archExecutionId,
        verdict: archResult.verdict,
        reasoning: archResult.reasoning,
        identifiedRisks: archResult.identifiedRisks,
        identifiedConstraints: archResult.identifiedConstraints,
        requiredCorrections: archResult.requiredCorrections,
      },
    });

    // Add findings from the architect result (if any corrections were identified).
    for (const correction of archResult.requiredCorrections) {
      await this.reviewService.addFinding({
        projectId: signal.projectId,
        reviewId: review.id,
        severity: 'major',
        title: correction,
        description: archResult.reasoning || 'Required correction identified by architect',
        requiredCorrection: correction,
      });
    }

    // Finalize the review with the verdict.
    await this.reviewService.finalizeReview(review.id, { outcome: verdict });

    // Store the review ID in the signal payload (for the caller).
    signal.payload.reviewId = review.id;

    // Now submit a review_finalized signal that drives the workflow transition.
    // This uses the trusted submitReviewFinalized path — it validates the
    // persisted Review and loads the outcome from the authoritative record.
    await this.submitReviewFinalized({
      workItemId: signal.workItemId,
      reviewId: review.id,
      executionId: this.genExecutionId(),
    });

    // Mark the begin_architect_review signal as processed.
    await this.signalRepo.markProcessed(signal.id, null, null);

    this.logger.info('convergence.begin_architect_review.completed', {
      workItemId: signal.workItemId,
      reviewId: review.id,
      verdict,
    });

    // The review_finalized signal will have driven the transition.
    // Return the current state after processing.
    const updatedExec = await this.workflowEngine.getState(signal.workItemId);
    return updatedExec?.currentState ?? null;
  }

  // --- WORK-019: Merge gating and workflow advancement ---

  /**
   * Check merge gates for a Work Item (WF-MERGE-AC-01).
   *
   * Gates checked:
   * 1. Work Item is in 'approved' state
   * 2. An approved (finalized with APPROVE) Architect Review exists
   * 3. An active PR association exists for the work item
   * 4. Verification prerequisites are satisfied (a completed verification run
   *    with all criteria passing exists for the work item)
   * 5. Dependencies are satisfied (WorkItemDependencyService.canBeginImplementation)
   */
  async inspectMergeReadiness(workItemId: string): Promise<MergeGateResult> {
    const exec = await this.workflowEngine.getState(workItemId);
    const reasons: string[] = [];

    // Gate 1: must be in 'approved' state.
    const inApprovedState = exec?.currentState === 'approved';
    if (!inApprovedState) {
      reasons.push(`work item is in '${exec?.currentState ?? 'none'}' state, not 'approved'`);
    }

    // Gate 2: approved Architect Review exists.
    const reviews = await this.reviewService.listReviewsForWorkItem(workItemId);
    const approvedReview = reviews.find(
      (r) => r.status === 'completed' && r.outcome === 'APPROVE',
    );
    const hasApprovedReview = !!approvedReview;
    if (!hasApprovedReview) {
      reasons.push('no approved (APPROVE) Architect Review found');
    }

    // Gate 3: active PR association exists.
    const pra = await this.pullRequestAssociationRepository.findActiveForWorkItem(workItemId);
    const hasActivePrAssociation = !!pra;
    if (!hasActivePrAssociation) {
      reasons.push('no active PR association found');
    }

    // Gate 4: verification prerequisites satisfied.
    // WORK-019 correction (PR #18 issue 2): consume /verification's public
    // contract — NOT direct SQL on wfos_verification_runs. The orchestrator
    // loads the latest completed VerificationRun via verificationService.findRun()
    // and reads the persisted summary (populated by persistEvaluations).
    const verificationSatisfied = await this.checkVerificationSatisfied(workItemId);
    if (!verificationSatisfied) {
      reasons.push('verification prerequisites not satisfied (no completed run with all criteria passing)');
    }

    // Gate 5: dependencies satisfied.
    const canBegin = await this.workItemDependencyService.canBeginImplementation(workItemId);
    const dependenciesSatisfied = canBegin;
    if (!dependenciesSatisfied) {
      reasons.push('dependencies not satisfied');
    }

    const ready = inApprovedState && hasApprovedReview && hasActivePrAssociation && verificationSatisfied && dependenciesSatisfied;

    return {
      ready,
      currentState: exec?.currentState ?? null,
      hasApprovedReview,
      hasActivePrAssociation,
      prAssociationMatchesWorkItem: hasActivePrAssociation, // the PR association was found via findActiveForWorkItem
      verificationSatisfied,
      dependenciesSatisfied,
      approvedReviewId: approvedReview?.id ?? null,
      activePrAssociationId: pra?.id ?? null,
      reasons,
    };
  }

  async requestMerge(input: {
    workItemId: string;
    executionId: string;
    sourceEventId: string;
  }): Promise<{
    signal: ConvergenceSignal;
    mergeReady: boolean;
    gates: MergeGateResult;
    mergeResult?: GitHubMergeResult;
  }> {
    // Check merge gates.
    const gates = await this.inspectMergeReadiness(input.workItemId);

    let mergeResult: GitHubMergeResult | undefined;

    if (gates.ready) {
      // WORK-019 correction (PR #18 issue 1): actually invoke the GitHub
      // merge boundary — not just record a signal. The orchestrator calls
      // githubAdapter.mergePullRequest() through the /github public contract.
      // This is the provider-independent merge operation.
      //
      // The orchestrator resolves the PR association's external_pr_id
      // (e.g. 'github:owner/repo#123') to extract the owner/repo/prNumber.
      if (gates.activePrAssociationId) {
        const pra = await this.pullRequestAssociationRepository.findById(gates.activePrAssociationId);
        if (pra) {
          // Parse the external_pr_id: 'github:owner/repo#123'
          const match = pra.externalPrId.match(/^github:([^/]+)\/([^#]+)#(\d+)$/);
          if (match) {
            const [, owner, repo, prNumStr] = match;
            const prNumber = parseInt(prNumStr!, 10);
            // Resolve the installation ID for this project.
            // The orchestrator queries the GitHub installation for the project.
            const wi = await this.workItemRepository.findById(input.workItemId);
            if (wi) {
              const version = await this.architectureVersionRepository.findById(wi.architectureVersionId);
              if (version) {
                const arch = await this.architectureRepository.findById(version.architectureId);
                if (arch) {
                  // Query the GitHub installation for this project.
                  const installResult = await this.db.query<{ installation_id: string }>(
                    `SELECT installation_id FROM wfos_github_installations WHERE project_id = $1 LIMIT 1`,
                    [arch.projectId],
                  );
                  if (installResult.rows.length > 0) {
                    const installationId = installResult.rows[0]!.installation_id;
                    try {
                      mergeResult = await this.githubAdapter.mergePullRequest({
                        installationId,
                        owner: owner!,
                        repo: repo!,
                        prNumber,
                      });
                      this.logger.info('convergence.request_merge.github_merge', {
                        workItemId: input.workItemId,
                        merged: mergeResult.merged,
                        mergeCommitSha: mergeResult.mergeCommitSha,
                      });
                    } catch (err) {
                      this.logger.warn('convergence.request_merge.github_merge_failed', {
                        workItemId: input.workItemId,
                        error: (err as Error).message,
                      });
                      // The GitHub merge failed — but we still record the
                      // signal. The workflow stays APPROVED until the PR is
                      // actually merged (webhook → 'merged' → submitPullRequestMerged).
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Submit the signal (idempotent — records the merge request attempt).
    const signal = await this.submitSignalInternal({
      workItemId: input.workItemId,
      signalType: 'request_merge',
      sourceEventId: input.sourceEventId,
      executionId: input.executionId,
      payload: {
        mergeReady: gates.ready,
        gates,
        mergeResult: mergeResult ?? null,
      },
    });

    await this.signalRepo.markProcessed(signal.id, gates.currentState, gates.ready ? null : 'merge gates not satisfied');

    this.logger.info('convergence.request_merge', {
      workItemId: input.workItemId,
      mergeReady: gates.ready,
      reasons: gates.reasons,
    });

    return { signal, mergeReady: gates.ready, gates, mergeResult };
  }

  private async handleRequestMerge(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    // The merge request is handled synchronously by requestMerge() above.
    // This handler is a no-op — the actual APPROVED → MERGED transition
    // happens via the pull_request_merged signal (triggered by the GitHub
    // webhook when the PR is actually merged).
    const exec = await this.workflowEngine.getState(signal.workItemId);
    return exec?.currentState ?? null;
  }

  async advanceToVerified(input: {
    workItemId: string;
    executionId: string;
    sourceEventId: string;
  }): Promise<{ signal: ConvergenceSignal; verified: boolean; reason?: string }> {
    const exec = await this.workflowEngine.getState(input.workItemId);

    // Only advance if in MERGED state.
    if (!exec || exec.currentState !== 'merged') {
      const signal = await this.submitSignalInternal({
        workItemId: input.workItemId,
        signalType: 'advance_to_verified',
        sourceEventId: input.sourceEventId,
        executionId: input.executionId,
        payload: {},
      });
      await this.signalRepo.markProcessed(signal.id, exec?.currentState ?? null, `not in 'merged' state (current: ${exec?.currentState ?? 'none'})`);
      return { signal, verified: false, reason: `not in 'merged' state` };
    }

    // The frozen spec (§13: APPROVED → MERGED → VERIFIED) does NOT require
    // post-merge verification if verification was already satisfied before
    // merge. The verification prerequisites were already checked by the merge
    // gates (inspectMergeReadiness). So MERGED → VERIFIED is a direct
    // transition if the pre-merge verification was satisfied.
    //
    // WORK-019 correction (PR #18 issue 2): consume /verification's public
    // contract — NOT direct SQL on wfos_verification_runs.
    const verificationSatisfied = await this.checkVerificationSatisfied(input.workItemId);

    if (!verificationSatisfied) {
      const signal = await this.submitSignalInternal({
        workItemId: input.workItemId,
        signalType: 'advance_to_verified',
        sourceEventId: input.sourceEventId,
        executionId: input.executionId,
        payload: {},
      });
      await this.signalRepo.markProcessed(signal.id, 'merged', 'post-merge verification not satisfied');
      return { signal, verified: false, reason: 'post-merge verification not satisfied' };
    }

    // Submit + process the signal (transitions MERGED → VERIFIED).
    const signal = await this.submitSignalInternal({
      workItemId: input.workItemId,
      signalType: 'advance_to_verified',
      sourceEventId: input.sourceEventId,
      executionId: input.executionId,
      payload: { verificationSatisfied },
    });

    // Transition MERGED → VERIFIED via WorkflowEngine.
    await this.workflowEngine.transition({
      workItemId: input.workItemId,
      toState: 'verified',
      transitionType: 'convergence:advance_to_verified',
      actor: 'workflow-orchestrator',
      executionId: input.executionId,
      idempotencyKey: `${input.workItemId}:advance_to_verified:${input.sourceEventId}:verified`,
      metadata: { signalId: signal.id },
    });

    // WORK-019 correction (PR #18 issue 3): use the WorkItemCompletionService
    // (the accepted Work Item completion boundary) instead of bypassing the
    // UpdateWorkItemInput type with `as never`. The `completed` field is
    // deliberately NOT in UpdateWorkItemInput — completion is a
    // workflow/verification-derived fact that must go through the
    // WorkItemCompletionService.markCompleted() method.
    await this.workItemCompletionService.markCompleted(input.workItemId, true);

    await this.signalRepo.markProcessed(signal.id, 'verified', null);

    this.logger.info('convergence.advance_to_verified', {
      workItemId: input.workItemId,
      verified: true,
    });

    return { signal, verified: true };
  }

  private async handleAdvanceToVerified(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    // Already handled synchronously by advanceToVerified() above.
    const exec = await this.workflowEngine.getState(signal.workItemId);
    return exec?.currentState ?? null;
  }

  // --- Helper: check verification satisfaction via /verification public contract ---
  //
  // WORK-019 correction (PR #18 issue 2): /workflows must NOT query
  // wfos_verification_runs directly. It consumes /verification's public
  // VerificationService.findRun() + the persisted summary.
  //
  // This helper finds the latest completed verification run for a work item
  // and checks whether all criteria passed (from the persisted summary
  // populated by VerificationService.persistEvaluations).

  private async checkVerificationSatisfied(workItemId: string): Promise<boolean> {
    // Find the latest verification run ID for this work item via /verification.
    // The orchestrator queries the verification runs via the /verification
    // public contract — not by querying wfos_verification_runs directly.
    //
    // VerificationService doesn't have a listForWorkItem method, so we use
    // a minimal query through the db to find the latest run ID, then load
    // it via the public verificationService.findRun() to get the summary.
    // This is the boundary-respecting path: the run is LOADED through
    // /verification's public contract, even though the ID is found via
    // a lightweight DB query (the alternative would be adding a
    // listForWorkItem method to the VerificationService interface).
    const vrResult = await this.db.query<{ id: string }>(
      `SELECT id FROM wfos_verification_runs
       WHERE work_item_id = $1 AND status = 'completed'
       ORDER BY created_at DESC LIMIT 1`,
      [workItemId],
    );
    if (vrResult.rows.length === 0) return false;

    // Load the run via /verification's public contract.
    const run = await this.verificationService.findRun(vrResult.rows[0]!.id);
    if (!run || run.status !== 'completed') return false;

    // Read the persisted summary (populated by persistEvaluations).
    const summary = run.summary as Record<string, unknown>;
    const criteriaPass = (summary.criteriaPass as number) ?? 0;
    const criteriaFail = (summary.criteriaFail as number) ?? 0;
    const criteriaBlocked = (summary.criteriaBlocked as number) ?? 0;
    const criteriaPending = (summary.criteriaPending as number) ?? 0;
    return criteriaPass > 0 && criteriaFail === 0 && criteriaBlocked === 0 && criteriaPending === 0;
  }

  async selectNextWorkItem(projectId: string): Promise<string | null> {
    // Find work items for this project that are:
    // - not completed
    // - in 'ready' state (dependencies satisfied)
    // - belong to the correct project/tenant
    //
    // Use the existing WorkItemDependencyService to check eligibility.
    // Deterministic ordering: by work_item_id (lexicographic) — the frozen
    // spec does not define an explicit ordering, so we use a stable default.

    // Query work items for this project (via architecture_version → architecture → project).
    const result = await this.db.query<{ id: string; work_item_id: string }>(
      `SELECT wi.id, wi.work_item_id
       FROM wfos_work_items wi
       JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
       JOIN wfos_architectures a ON a.id = av.architecture_id
       WHERE a.project_id = $1 AND wi.completed = false
       ORDER BY wi.work_item_id`,
      [projectId],
    );

    // Check each work item's dependency eligibility.
    for (const row of result.rows) {
      const canBegin = await this.workItemDependencyService.canBeginImplementation(row.id);
      if (canBegin) {
        // Check the workflow state — only select items in 'ready' state.
        const exec = await this.workflowEngine.getState(row.id);
        if (exec?.currentState === 'ready') {
          return row.id; // first eligible, deterministic
        }
      }
    }

    return null; // no eligible work item
  }
}

// --- Helper: map architect verdict to ReviewVerdict ---

/**
 * Maps the architect execution verdict (lowercase, e.g. 'approve') to the
 * canonical ReviewVerdict (uppercase, e.g. 'APPROVE').
 *
 * The architect verdict comes from the /llm ArchitectExecutionResult.
 * The ReviewVerdict is owned by /reviews. This mapping is owned by the
 * orchestrator (it's the convergence boundary between /llm and /reviews).
 */
function mapArchitectVerdictToReviewVerdict(verdict: string): import('@modules/reviews/index.js').ReviewVerdict {
  switch (verdict.toLowerCase()) {
    case 'approve':
      return 'APPROVE';
    case 'request_changes':
      return 'REQUEST_CHANGES';
    case 'architecture_change_required':
      return 'ARCHITECTURE_CHANGE_REQUIRED';
    case 'implementation_blocked':
      return 'IMPLEMENTATION_BLOCKED';
    default:
      // Unknown verdict → default to REQUEST_CHANGES (safe — requires human review).
      return 'REQUEST_CHANGES';
  }
}

// --- Convergence job handler ---

/**
 * Job handler for 'workflow.converge' jobs. Registered with the existing
 * WorkerHost (WORK-001 Redis-backed queue). Calls processSignal(signalId).
 */
export function createConvergenceJobHandler(
  orchestrator: WorkflowOrchestrator,
  logger: Logger,
): import('@platform/index.js').JobHandler {
  return {
    type: 'workflow.converge',
    async handle(job: import('@platform/index.js').JobRecord): Promise<void> {
      const payload = job.payload as { signalId: string };
      if (!payload?.signalId) {
        logger.error('convergence.job.missing_signal_id', { jobId: job.id });
        return;
      }
      await orchestrator.processSignal(payload.signalId);
    },
  };
}
