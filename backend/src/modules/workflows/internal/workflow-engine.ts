import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type {
  WorkflowEngine,
  WorkflowExecution,
  WorkflowTransition,
  TransitionRequest,
  TransitionResult,
} from './workflow.types.js';
import { LEGAL_TRANSITIONS } from './workflow.types.js';
import { PgWorkflowExecutionRepository, PgWorkflowTransitionRepository } from './pg-workflow-repository.js';

/**
 * Default {@link WorkflowEngine} — the exclusive owner of canonical workflow
 * state (WORKFLOW-001..005).
 *
 * Every transition:
 * 1. Loads authoritative current state from PostgreSQL.
 * 2. Verifies the transition is legal (per LEGAL_TRANSITIONS).
 * 3. Verifies preconditions (dependency eligibility for IMPLEMENTING).
 * 4. Persists the new state (optimistic concurrency + row locking).
 * 5. Persists transition history (append-only).
 * 6. Is concurrency-safe (two simultaneous transitions from the same state
 *    — only one succeeds).
 * 7. Is idempotent (duplicate idempotency key → no-op).
 */
export class DefaultWorkflowEngine implements WorkflowEngine {
  private readonly execRepo: PgWorkflowExecutionRepository;
  private readonly transRepo: PgWorkflowTransitionRepository;

  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
    private readonly canBeginImplementation?: (workItemId: string) => Promise<boolean>,
  ) {
    this.execRepo = new PgWorkflowExecutionRepository(db);
    this.transRepo = new PgWorkflowTransitionRepository(db);
  }

  async getOrCreate(workItemId: string): Promise<WorkflowExecution> {
    return this.execRepo.create(workItemId);
  }

  async getState(workItemId: string): Promise<WorkflowExecution | null> {
    return this.execRepo.findByWorkItem(workItemId);
  }

  async getHistory(workItemId: string): Promise<WorkflowTransition[]> {
    return this.transRepo.listForWorkItem(workItemId);
  }

  async transition(request: TransitionRequest): Promise<TransitionResult> {
    return this.db.transaction(async (tx) => {
      const execRepo = new PgWorkflowExecutionRepository(tx as DatabaseClient);
      const transRepo = new PgWorkflowTransitionRepository(tx as DatabaseClient);

      // Idempotency: if an idempotency key was provided and a transition
      // with that key already exists, return it as a no-op success.
      if (request.idempotencyKey) {
        const existing = await transRepo.findByIdempotencyKey(request.idempotencyKey);
        if (existing) {
          const exec = await execRepo.findByWorkItem(request.workItemId);
          return {
            success: true,
            fromState: existing.fromState,
            toState: existing.toState,
            execution: exec!,
            transition: existing,
            reason: 'idempotent-noop',
          };
        }
      }

      // 1. Load authoritative current state.
      let execution = await execRepo.findByWorkItem(request.workItemId);
      if (!execution) {
        execution = await execRepo.create(request.workItemId);
      }

      const fromState = execution.currentState;

      // 2. Verify the transition is legal.
      if (fromState === request.toState) {
        // Same-state transition is a no-op (idempotent).
        return {
          success: true,
          fromState,
          toState: fromState,
          execution,
          transition: null,
          reason: 'already-in-target-state',
        };
      }

      const legalTargets = LEGAL_TRANSITIONS[fromState] ?? [];
      if (!legalTargets.includes(request.toState)) {
        return {
          success: false,
          fromState,
          toState: request.toState,
          execution,
          transition: null,
          reason: `illegal transition: ${fromState} → ${request.toState}`,
        };
      }

      // 3. Verify preconditions.
      // Dependency eligibility: before entering IMPLEMENTING, verify the work
      // item is eligible (dependencies satisfied). This uses the existing
      // WORK-007 WorkItemDependencyService.
      if (request.toState === 'implementing' && this.canBeginImplementation) {
        const eligible = await this.canBeginImplementation(request.workItemId);
        if (!eligible) {
          return {
            success: false,
            fromState,
            toState: request.toState,
            execution,
            transition: null,
            reason: 'dependency-eligibility-failed',
          };
        }
      }

      // 4. Persist the new state (optimistic concurrency).
      const updated = await execRepo.transition(
        request.workItemId,
        fromState,
        request.toState,
        execution.version,
      );

      if (!updated) {
        // Concurrency conflict — another transition won.
        return {
          success: false,
          fromState,
          toState: request.toState,
          execution,
          transition: null,
          reason: 'concurrency-conflict',
        };
      }

      // 5. Persist transition history (append-only).
      const transition = await transRepo.create({
        workflowExecutionId: updated.id,
        workItemId: request.workItemId,
        fromState,
        toState: request.toState,
        transitionType: request.transitionType,
        actor: request.actor,
        executionId: request.executionId,
        idempotencyKey: request.idempotencyKey,
        metadata: request.metadata,
      });

      this.logger.info('workflow.transition', {
        workItemId: request.workItemId,
        fromState,
        toState: request.toState,
        version: updated.version,
        actor: request.actor,
      });

      return {
        success: true,
        fromState,
        toState: request.toState,
        execution: updated,
        transition,
      };
    });
  }
}
