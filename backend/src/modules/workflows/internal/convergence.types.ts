/**
 * Workflow convergence types (WORK-017).
 *
 * The /workflows module owns the convergence orchestration layer that connects
 * the existing Work Item, Work Order, Agent Run, GitHub, Verification, and
 * Architect Review contracts into the canonical implementation loop.
 *
 * Boundary ownership (frozen architecture §6, §13, §14; architecture-lock.md §15-19):
 *   /workflows is the EXCLUSIVE owner of:
 *   - canonical workflow state;
 *   - legal workflow transitions;
 *   - orchestration decisions;
 *   - workflow convergence;
 *   - retry/correction routing;
 *   - progression from one lifecycle phase to the next.
 *
 * The orchestration layer CONSUMES public contracts from:
 *   /work-items (Work Item, Work Order, dependencies, PR associations)
 *   /agents (AgentGateway, AgentRunRepository)
 *   /llm (ArchitectService for Work Order generation)
 *   /github (provider-independent PR/CI contracts)
 *   /verification (VerificationService for evaluation results)
 *   /reviews (ReviewService for ArchitectReviewResult)
 *
 * It NEVER imports another module's internal/ implementation. It NEVER mutates
 * wfos_workflow_executions directly — every state change goes through
 * WorkflowEngine.transition().
 */

import type { WorkflowState, WorkflowEngine } from './workflow.types.js';

// --- Convergence signal types ---
//
// Provider-independent application signals representing domain events that
// need workflow action. These are NOT a generic event platform — they are the
// minimal set required by the convergence loop (frozen architecture §14, §27).

export type SignalType =
  | 'initiate'               // Start the convergence loop for a work item
  | 'agent_run_completed'    // Agent run finished (success or failure)
  | 'pull_request_merged'    // GitHub PR was merged
  | 'verification_completed' // Verification run finished
  | 'review_finalized'       // Architect review was finalized
  // WORK-018: verification/review orchestration signals
  | 'begin_verification'    // PR_OPEN → VERIFYING + create VerificationRun
  | 'begin_architect_review' // ARCHITECT_REVIEW → invoke ArchitectService + create + finalize Review
  // WORK-019: merge gating + advancement signals
  | 'request_merge'          // APPROVED → validate merge gates → request GitHub merge → MERGED
  | 'advance_to_verified';   // MERGED → check post-merge conditions → VERIFIED

export type SignalProcessingState = 'pending' | 'processed' | 'failed';

// --- Convergence signal record ---

export interface ConvergenceSignal {
  readonly id: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly signalType: SignalType;
  readonly sourceEventId: string;
  readonly idempotencyKey: string;
  readonly processingState: SignalProcessingState;
  readonly resultState: WorkflowState | null;
  readonly errorMessage: string | null;
  readonly payload: Record<string, unknown>;
  readonly executionId: string;
  readonly createdAt: Date;
  readonly processedAt: Date | null;
  readonly updatedAt: Date;
}

// --- Signal submission input ---

export interface SubmitSignalInput {
  workItemId: string;
  signalType: SignalType;
  /**
   * Stable id from the source domain event. Used with signalType for
   * idempotency. For 'initiate' signals, this can be the execution ID of
   * the API request that initiated the convergence.
   */
  sourceEventId: string;
  /**
   * Structured signal payload. The shape depends on signalType:
   * - 'initiate': { provider?, model?, agentConfiguration?, ... }
   * - 'agent_run_completed': { agentRunId, status, commitRef?, pullRequestRef? }
   * - 'pull_request_merged': { prAssociationId, mergedAt }
   * - 'verification_completed': { verificationRunId, allCriteriaPass, ... }
   * - 'review_finalized': { reviewId, outcome }
   */
  payload: Record<string, unknown>;
  /** Execution/correlation ID (architecture §35). */
  executionId: string;
}

// --- Signal repository ---

export interface ConvergenceSignalRepository {
  /**
   * Idempotent upsert. If a signal with the same (work_item_id, signal_type,
   * source_event_id) already exists, return the existing row. Otherwise create
   * a new row. Returns the signal + whether it was newly created.
   */
  upsert(input: SubmitSignalInput & { projectId: string; idempotencyKey: string }): Promise<{
    signal: ConvergenceSignal;
    created: boolean;
  }>;
  findById(id: string): Promise<ConvergenceSignal | null>;
  listForWorkItem(workItemId: string): Promise<ConvergenceSignal[]>;
  markProcessed(id: string, resultState: WorkflowState | null, errorMessage?: string | null): Promise<void>;
}

// --- Workflow orchestrator ---

/**
 * The WorkflowOrchestrator owns the convergence loop (WORK-017).
 *
 * For each signal, it:
 * 1. Loads the current workflow state from PostgreSQL (authoritative).
 * 2. Loads the relevant domain state (agent run, verification run, review, etc.).
 * 3. Determines the appropriate workflow transition(s) based on the signal
 *    + current state + frozen legal transitions.
 * 4. May initiate a domain operation (launch agent run, create verification
 *    run, create review) as part of the convergence step.
 * 5. Invokes WorkflowEngine.transition() with an idempotency key derived from
 *    the signal — duplicate signals produce one transition.
 *
 * The orchestrator does NOT:
 * - mutate wfos_workflow_executions directly (uses WorkflowEngine.transition());
 * - evaluate evidence or modify criterion status (/verification owns that);
 * - execute architect reasoning (/llm owns that);
 * - import any module's internal/ implementation.
 *
 * Recovery (frozen architecture §20):
 * A pending convergence step is reconstructable from persisted signals +
 * workflow state. After worker restart, pending signals can be reprocessed.
 */
export interface WorkflowOrchestrator {
  /**
   * Submit an `initiate` signal — the ONLY client-facing convergence operation.
   * Starts the convergence loop for a work item (DRAFT → READY → ASSIGNED →
   * IMPLEMENTING → PR_OPEN). This is NOT a trusted-outcome signal — it only
   * starts the loop; all downstream transitions require trusted domain signals.
   *
   * Idempotent — duplicate signals with the same
   * (work_item_id, signal_type, source_event_id) are no-ops.
   */
  initiateConvergence(input: {
    workItemId: string;
    sourceEventId: string;
    executionId: string;
    payload?: Record<string, unknown>;
  }): Promise<ConvergenceSignal>;

  /**
   * INTERNAL — submit a trusted `agent_run_completed` signal.
   *
   * Validates the AgentRun exists, belongs to the work item, and loads its
   * authoritative status/commitRef/pullRequestRef from the persisted record.
   * A client cannot forge this — the signal payload is populated from the
   * AgentRun record, not from client input.
   */
  submitAgentRunCompleted(input: {
    workItemId: string;
    agentRunId: string;
    executionId: string;
  }): Promise<ConvergenceSignal>;

  /**
   * INTERNAL — submit a trusted `verification_completed` signal.
   *
   * Validates the VerificationRun exists, belongs to the work item, is
   * completed, and loads the authoritative criteria-pass/fail result from
   * the persisted run summary. A client cannot forge this.
   */
  submitVerificationCompleted(input: {
    workItemId: string;
    verificationRunId: string;
    executionId: string;
  }): Promise<ConvergenceSignal>;

  /**
   * INTERNAL — submit a trusted `review_finalized` signal.
   *
   * Validates the Review exists, belongs to the work item, is finalized, and
   * loads the authoritative outcome from the persisted ReviewResult. A client
   * cannot forge this.
   */
  submitReviewFinalized(input: {
    workItemId: string;
    reviewId: string;
    executionId: string;
  }): Promise<ConvergenceSignal>;

  /**
   * INTERNAL — submit a trusted `pull_request_merged` signal.
   *
   * Validates the PR association exists, belongs to the work item, and its
   * status is 'merged'. A client cannot forge this.
   */
  submitPullRequestMerged(input: {
    workItemId: string;
    prAssociationId: string;
    executionId: string;
  }): Promise<ConvergenceSignal>;

  // --- WORK-018: Verification/Review orchestration ---

  /**
   * Begin verification for a Work Item: transitions PR_OPEN → VERIFYING and
   * creates a VerificationRun using the existing `/verification` contract.
   *
   * The orchestrator does NOT evaluate evidence — it only creates the run.
   * The verification result comes later via `submitVerificationCompleted`
   * (which loads the authoritative persisted result).
   *
   * Returns the verification run ID so the caller can attach evidence.
   */
  beginVerification(input: {
    workItemId: string;
    executionId: string;
    sourceEventId: string;
  }): Promise<{ signal: ConvergenceSignal; verificationRunId: string }>;

  /**
   * Begin architect review for a Work Item: invokes the existing ArchitectService
   * (via /llm), creates a Review (via /reviews), finalizes it with the
   * architect's verdict, and submits a `review_finalized` signal that drives
   * the correct canonical workflow transition.
   *
   * The verdict is loaded from the AUTHORITATIVE ArchitectExecutionResult +
   * persisted Review — NOT from client input. A client cannot forge the outcome.
   *
   * The architect execution + review creation use the Work Item's existing
   * Work Order / ArchitectureVersion traceability.
   */
  beginArchitectReview(input: {
    workItemId: string;
    executionId: string;
    sourceEventId: string;
    provider?: string;
    model?: string;
    task?: string;
  }): Promise<{ signal: ConvergenceSignal; reviewId: string }>;

  /**
   * Process a convergence signal. Loads the signal + current workflow state,
   * determines the appropriate action, performs any domain operation, and
   * invokes WorkflowEngine.transition(). Marks the signal as processed.
   *
   * This is the core convergence logic. Called by the convergence job handler.
   */
  processSignal(signalId: string): Promise<void>;

  /**
   * Get convergence status for a work item — the current workflow state +
   * recent signals.
   */
  getConvergenceStatus(workItemId: string): Promise<{
    workflowState: WorkflowState | null;
    signals: ConvergenceSignal[];
  }>;

  // --- WORK-019: Merge gating and workflow advancement ---

  /**
   * Request a merge for a Work Item in APPROVED state. Validates all frozen
   * merge gates (approved review, active PR association, verification
   * prerequisites, dependency satisfaction) before requesting the GitHub merge
   * through the existing provider-independent /github boundary.
   *
   * The merge is NOT set optimistically — MERGED is entered only when the PR
   * association status is 'merged' (set by authoritative GitHub webhook
   * processing).
   *
   * Returns the merge readiness result + whether a merge was requested.
   */
  requestMerge(input: {
    workItemId: string;
    executionId: string;
    sourceEventId: string;
  }): Promise<{
    signal: ConvergenceSignal;
    mergeReady: boolean;
    gates: MergeGateResult;
  }>;

  /**
   * Inspect merge readiness without requesting a merge. Returns the gate
   * check results.
   */
  inspectMergeReadiness(workItemId: string): Promise<MergeGateResult>;

  /**
   * Advance a MERGED Work Item to VERIFIED if the frozen post-merge conditions
   * are satisfied. The frozen spec does NOT require post-merge verification if
   * verification was already satisfied before merge (§13: APPROVED → MERGED →
   * VERIFIED is a direct chain).
   *
   * This method checks the frozen conditions and transitions to VERIFIED if
   * they are met. It also marks the Work Item as completed.
   */
  advanceToVerified(input: {
    workItemId: string;
    executionId: string;
    sourceEventId: string;
  }): Promise<{ signal: ConvergenceSignal; verified: boolean; reason?: string }>;

  /**
   * Select the next eligible Work Item for a project. Uses the existing
   * /work-items dependency/eligibility contract. Deterministic ordering by
   * work_item_id (lexicographic).
   *
   * Returns the next eligible Work Item ID, or null if none is eligible.
   */
  selectNextWorkItem(projectId: string): Promise<string | null>;
}

/**
 * Merge gate check result (WORK-019). Each gate is checked independently.
 */
export interface MergeGateResult {
  /** Whether ALL gates are satisfied. */
  ready: boolean;
  /** The current workflow state. */
  currentState: WorkflowState | null;
  /** Whether an approved Architect Review exists for this work item. */
  hasApprovedReview: boolean;
  /** Whether an active (non-merged) PR association exists. */
  hasActivePrAssociation: boolean;
  /** Whether the PR association belongs to the correct work item. */
  prAssociationMatchesWorkItem: boolean;
  /** Whether verification prerequisites are satisfied. */
  verificationSatisfied: boolean;
  /** Whether all dependencies are satisfied. */
  dependenciesSatisfied: boolean;
  /** The approved review ID (if found). */
  approvedReviewId: string | null;
  /** The active PR association ID (if found). */
  activePrAssociationId: string | null;
  /** Failure reasons (if any gate failed). */
  reasons: string[];
}

// --- Re-export for convenience ---

export type { WorkflowState, WorkflowEngine };
