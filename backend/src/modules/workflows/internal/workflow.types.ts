/**
 * Canonical workflow state machine types (WORKFLOW-001..005).
 *
 * /workflows is the EXCLUSIVE owner of canonical workflow state. No other
 * module may mutate it or define a competing state enum.
 *
 * The frozen state graph (spec/architecture.md §13, architecture-lock.md):
 *
 *   DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING
 *
 * From VERIFYING:
 *   VERIFICATION_FAILED → IMPLEMENTING
 *   ARCHITECT_REVIEW
 *
 * From ARCHITECT_REVIEW:
 *   CHANGES_REQUESTED → IMPLEMENTING
 *   ARCHITECTURE_CHANGE_REQUIRED → ARCHITECTURE_CHANGE_REQUEST (terminal)
 *   APPROVED → MERGED → VERIFIED
 *
 * IMPLEMENTATION_BLOCKED may occur during ASSIGNED, IMPLEMENTING, or VERIFYING
 * and returns to IMPLEMENTING when resolved.
 *
 * ARCHITECTURE_CHANGE_REQUIRED is terminal for the current implementation
 * attempt until the architecture change is resolved.
 */

export type WorkflowState =
  | 'draft'
  | 'ready'
  | 'assigned'
  | 'implementing'
  | 'pr_open'
  | 'verifying'
  | 'verification_failed'
  | 'architect_review'
  | 'changes_requested'
  | 'architecture_change_required'
  | 'architecture_change_request'
  | 'implementation_blocked'
  | 'approved'
  | 'merged'
  | 'verified';

/**
 * The frozen legal transition map. Keys are source states; values are sets
 * of legal target states. This is the single source of truth for the state
 * machine — derived directly from spec/architecture.md §13.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  draft: ['ready'],
  ready: ['assigned'],
  assigned: ['implementing', 'implementation_blocked'],
  implementing: ['pr_open', 'implementation_blocked'],
  pr_open: ['verifying'],
  verifying: ['verification_failed', 'architect_review', 'implementation_blocked'],
  verification_failed: ['implementing'],
  architect_review: ['changes_requested', 'architecture_change_required', 'approved'],
  changes_requested: ['implementing'],
  architecture_change_required: ['architecture_change_request'],
  architecture_change_request: [], // terminal until architecture change is resolved
  implementation_blocked: ['implementing'],
  approved: ['merged'],
  merged: ['verified'],
  verified: [], // terminal
};

export interface WorkflowExecution {
  readonly id: string;
  readonly workItemId: string;
  readonly currentState: WorkflowState;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkflowTransition {
  readonly id: string;
  readonly workflowExecutionId: string;
  readonly workItemId: string;
  readonly fromState: WorkflowState;
  readonly toState: WorkflowState;
  readonly transitionType: string | null;
  readonly actor: string | null;
  readonly executionId: string | null;
  readonly idempotencyKey: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface TransitionRequest {
  workItemId: string;
  toState: WorkflowState;
  transitionType?: string;
  actor?: string;
  executionId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface TransitionResult {
  success: boolean;
  fromState: WorkflowState;
  toState: WorkflowState;
  execution: WorkflowExecution;
  transition: WorkflowTransition | null;
  reason?: string;
}

export interface WorkflowExecutionRepository {
  findByWorkItem(workItemId: string): Promise<WorkflowExecution | null>;
  create(workItemId: string): Promise<WorkflowExecution>;
  transition(
    workItemId: string,
    fromState: WorkflowState,
    toState: WorkflowState,
    expectedVersion: number,
  ): Promise<WorkflowExecution | null>;
}

export interface WorkflowTransitionRepository {
  create(input: {
    workflowExecutionId: string;
    workItemId: string;
    fromState: WorkflowState;
    toState: WorkflowState;
    transitionType?: string;
    actor?: string;
    executionId?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }): Promise<WorkflowTransition>;
  listForWorkItem(workItemId: string): Promise<WorkflowTransition[]>;
  findByIdempotencyKey(key: string): Promise<WorkflowTransition | null>;
}

/**
 * The Workflow Engine is the exclusive owner of canonical workflow state.
 * Every transition must go through this interface.
 */
export interface WorkflowEngine {
  /**
   * Request a state transition. Validates:
   * - the transition is legal (per LEGAL_TRANSITIONS);
   * - preconditions (e.g. dependency eligibility for IMPLEMENTING);
   * - concurrency (optimistic version check + row locking);
   * - idempotency (duplicate idempotency key → no-op).
   *
   * Returns the result including the new execution state and transition record.
   */
  transition(request: TransitionRequest): Promise<TransitionResult>;

  /**
   * Get the current canonical workflow state for a work item.
   */
  getState(workItemId: string): Promise<WorkflowExecution | null>;

  /**
   * Get the transition history for a work item (append-only, chronological).
   */
  getHistory(workItemId: string): Promise<WorkflowTransition[]>;

  /**
   * Get or create a workflow execution for a work item (starts in DRAFT).
   */
  getOrCreate(workItemId: string): Promise<WorkflowExecution>;
}
