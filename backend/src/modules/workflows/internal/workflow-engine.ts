import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { WorkflowAuditEmitter } from '@modules/audit/index.js';
import type {
  WorkflowEngine,
  WorkflowExecution,
  WorkflowState,
  WorkflowTransition,
  TransitionRequest,
  TransitionResult,
} from './workflow.types.js';
import { LEGAL_TRANSITIONS } from './workflow.types.js';
import { PgWorkflowExecutionRepository, PgWorkflowTransitionRepository } from './pg-workflow-repository.js';

/**
 * PR #35 review fix v2 / Blocker B: best-effort composition hook invoked
 * AFTER a real NEW transition is persisted (NOT for idempotent no-ops —
 * only when `transRepo.create` ran). The composition root (app.ts) wires
 * this to call `benchmarkService.advanceTrialsForWorkItem(workItemId)` so
 * any benchmark trial awaiting the work item's terminal transition
 * (`verified` / `verification_failed` / `implementation_blocked`) is
 * re-enqueued onto `benchmark.trial` and finalized. Wrap in try/catch +
 * log on error — a hook failure MUST NEVER break the core transition
 * operation (the state transition is already authoritative).
 */
export type WorkflowTransitionCallback = (
  workItemId: string,
  fromState: WorkflowState,
  toState: WorkflowState,
) => Promise<void>;

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
    private readonly auditEmitter?: WorkflowAuditEmitter,
    /**
     * PR #35 review fix v2 / Blocker B: best-effort transition callback
     * (composition hook). Invoked AFTER a real NEW transition is
     * persisted (NOT for idempotent no-ops or same-state transitions).
     * The composition root (app.ts) wires this so the benchmark service
     * can re-advance any trial pointing at the work item when the work
     * item reaches `verified` or a terminal failure state. Wrap in
     * try/catch + log on error — a callback failure MUST NEVER break the
     * core transition (the state transition is already authoritative).
     */
    private readonly onTransition?: WorkflowTransitionCallback,
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
        const existing = await transRepo.findByIdempotencyKey(request.workItemId, request.idempotencyKey);
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

      // WORK-020: emit audit event for the successful transition.
      // WF-AUDIT-AC-01: Material transitions emit audit events.
      // WF-AUDIT-AC-02: Replayed idempotent events do not create conflicting
      // audit state — the idempotency check above returns early for duplicates,
      // so this code only runs for NEW transitions.
      if (this.auditEmitter) {
        // Audit emission is best-effort: if it fails, the transition is still
        // authoritative (audit is supplementary forensic history). The
        // emitWorkflowTransition method catches errors internally.
        await this.auditEmitter.emitWorkflowTransition({
          workItemId: request.workItemId,
          fromState,
          toState: request.toState,
          transitionType: request.transitionType ?? null,
          actor: request.actor ?? null,
          executionId: request.executionId ?? null,
          metadata: request.metadata ?? {},
        });
      }

      // PR #35 review fix v2 / Blocker B: best-effort transition callback
      // (composition hook). Invoked AFTER a real NEW transition is
      // persisted (the transRepo.create call above ran). NOT invoked for
      // idempotent no-ops (the early return at the top of `transition` skips
      // this code path) + NOT for same-state transitions (the
      // `already-in-target-state` early return skips this code path). Wrap
      // in try/catch + log on error so a callback failure NEVER breaks the
      // core transition (the state transition is already authoritative +
      // the audit event already emitted).
      if (this.onTransition) {
        try {
          await this.onTransition(request.workItemId, fromState, request.toState);
        } catch (err) {
          this.logger.warn('workflow.on-transition-callback-failed', {
            workItemId: request.workItemId,
            fromState,
            toState: request.toState,
            error: (err as Error).message,
          });
        }
      }

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
