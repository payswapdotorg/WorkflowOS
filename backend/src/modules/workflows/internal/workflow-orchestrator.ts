import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { Queue } from '@platform/index.js';
import type { generateExecutionId } from '@platform/ids.js';

import type { WorkItemRepository, WorkOrderRepository, WorkItemDependencyService, PullRequestAssociationRepository } from '@modules/work-items/index.js';
import type { AgentGateway, AgentRunRepository } from '@modules/agents/index.js';
import type { ArchitectService } from '@modules/llm/index.js';
import type { VerificationService } from '@modules/verification/index.js';
import type { ReviewService, ReviewVerdict } from '@modules/reviews/index.js';
import type { ArchitectureVersionRepository, ArchitectureRepository } from '@modules/architecture/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';

import type {
  WorkflowOrchestrator,
  ConvergenceSignal,
  SubmitSignalInput,
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
    db: DatabaseClient,
    private readonly logger: Logger,
    private readonly queue: Queue,
    private readonly workflowEngine: WorkflowEngine,
    private readonly workItemRepository: WorkItemRepository,
    private readonly workOrderRepository: WorkOrderRepository,
    private readonly workItemDependencyService: WorkItemDependencyService,
    private readonly pullRequestAssociationRepository: PullRequestAssociationRepository,
    private readonly agentGateway: AgentGateway,
    agentRunRepository: AgentRunRepository,
    private readonly architectService: ArchitectService,
    verificationService: VerificationService,
    reviewService: ReviewService,
    private readonly architectureVersionRepository: ArchitectureVersionRepository,
    private readonly architectureRepository: ArchitectureRepository,
    projectRepository: ProjectRepository,
    private readonly genExecutionId: typeof generateExecutionId,
  ) {
    this.signalRepo = new PgConvergenceSignalRepository(db);
    // verificationService + reviewService + agentRunRepository +
    // projectRepository are accepted for future use (the orchestrator may
    // create verification runs / reviews automatically in future convergence
    // steps). They are intentionally wired now so downstream work items don't
    // need to re-plumb the dependencies. Currently the orchestrator reads
    // results from signal payloads rather than calling these services directly.
    void verificationService;
    void reviewService;
    void agentRunRepository;
    void projectRepository;
  }

  async submitSignal(input: SubmitSignalInput): Promise<ConvergenceSignal> {
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
  // APPROVED → MERGED → VERIFIED

  private async handlePullRequestMerged(signal: ConvergenceSignal): Promise<WorkflowState | null> {
    const exec = await this.workflowEngine.getState(signal.workItemId);
    if (!exec) return null;

    let currentState = exec.currentState;

    // APPROVED → MERGED
    if (currentState === 'approved') {
      const result = await this.transition(signal, 'merged');
      if (!result.success) return currentState;
      currentState = 'merged';
    }

    // MERGED → VERIFIED
    if (currentState === 'merged') {
      const result = await this.transition(signal, 'verified');
      if (result.success) currentState = 'verified';
    }

    return currentState;
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
