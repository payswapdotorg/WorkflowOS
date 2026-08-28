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

// --- WORK-051: Architecture checkpoint gate (the lifecycle gate contract) ---
//
// The checkpoint capability is APPLICATION-LAYER ORCHESTRATION ONLY. It owns
// no workflow state machine and no parallel evidence authority. This port is
// the CONTRACT /workflows consumes: the checkpoint subsystem (wired by the
// composition root) implements it, evaluates architectural conformance
// against the Work Item's immutable ArchitectureVersion + assertion set
// (owned by /architecture), persists evidence through /verification, and
// returns a GATING RESULT.
//
// The gate NEVER mutates workflow state — /workflows performs the legal
// transition only when the gate allows it (frozen architecture §13; design
// §8: "A checkpoint never creates or mutates workflow state directly").

/** The four lifecycle gates implemented in the initial increment (design §5, §11). */
export type ArchitectureCheckpointKind =
  | 'readiness' // before implementation assignment (READY → ASSIGNED)
  | 'work_order' // before an implementation agent starts (ASSIGNED → agent run)
  | 'pr_conformance' // before PR_OPEN
  | 'verification_entry'; // before/at entry to VERIFYING

export interface ArchitectureCheckpointGateInput {
  checkpointKind: ArchitectureCheckpointKind;
  workItemId: string;
  /**
   * The caller's project context. The checkpoint service resolves the
   * authoritative project SERVER-SIDE (work item → architecture version →
   * architecture → project) and rejects a mismatch BEFORE any detector
   * executes — caller-controlled tenant scope is impossible by construction.
   */
  expectedProjectId: string;
  /**
   * The exact implementation revision being gated (commit SHA). REQUIRED
   * semantically for 'pr_conformance' and 'verification_entry' (a checkpoint
   * evaluates an exact implementation revision); null is permitted only for
   * the pre-implementation kinds where no implementation revision exists
   * yet. A null revision at a revision-bound gate fails closed.
   */
  implementationRevision?: string | null;
  executionId: string;
  /**
   * Optional idempotency key derived from the convergence signal — repeated
   * processing of the SAME signal replays the recorded checkpoint result
   * instead of re-evaluating (a later revision is a different key and
   * evaluates fresh).
   */
  idempotencyKey?: string | null;
  /**
   * Optional Work Order context for the pre-implementation checkpoint kinds
   * (traceability only — the checkpoint service resolves all authoritative
   * state server-side; this field is never trusted as identity).
   */
  workOrderId?: string | null;
}

export interface ArchitectureCheckpointGateResult {
  /** Whether the gated lifecycle progression may proceed. */
  allowed: boolean;
  /** Whether this checkpoint kind applies to the work item's impact profile. */
  applicable: boolean;
  /** Checkpoint status (null when not applicable). */
  status: 'passed' | 'passed_with_advisories' | 'blocked' | 'inconclusive' | null;
  /** Traceability id (the /verification run id; null when not applicable). */
  checkpointId: string | null;
  /** Blocking findings + advisories (human-readable, deterministic order). */
  reasons: string[];
}

/**
 * The gate contract consumed by the WorkflowOrchestrator. Implemented by the
 * application-layer checkpoint subsystem (src/architecture-checkpoints/),
 * wired by the composition root.
 */
export interface ArchitectureCheckpointGate {
  evaluate(input: ArchitectureCheckpointGateInput): Promise<ArchitectureCheckpointGateResult>;
}

// --- WORK-051 round 2 (PR #52 review, BLOCKER 1 + BLOCKER 2): the governed
// PR-creation boundary ---
//
// The governed convergence path is a TWO-CAPABILITY protocol:
//
//   capability 1 — the pre-gate implementation phase: the agent execution
//     contract is STRUCTURALLY PR-INCAPABLE (no PR field on the request or
//     the result, no PR-creation capability handed to any provider adapter;
//     the gateway re-projects provider returns onto the contract). The
//     provider cannot create a PR through the platform in this phase at all
//     — there is no policy to violate;
//   capability 2 — PR creation, ONLY after the pr_conformance checkpoint
//     allows it, through THIS port: the actual PR-creation boundary owned by
//     the orchestrator's PR path, satisfied in production by the /github
//     authority's createPullRequest (repository coordinates resolved
//     SERVER-SIDE from the project's /github link). The port call is wrapped
//     by the DURABLE create-or-converge protocol (GovernedPullRequestService
//     + the wfos_pull_request_intents ledger): crash/retry/duplicate re-drives
//     of the same (work item, implementation revision) converge on ONE PR.
//
// The architectural property is structural: with a blocking architecture
// violation, ZERO createPullRequest side effects occur; a PR exists in the
// governed lifecycle only when the gate allowed it first. A pullRequestRef
// reported by an EXTERNAL actor (e.g. a human opening a PR on GitHub) is
// adopted by the webhook path — and is only associated + transitioned into
// the governed lifecycle after the same gate passes.

/**
 * The result of a governed PR creation.
 */
export interface CreatedPullRequest {
  /** The provider-independent PR identity (e.g. 'github:owner/repo#12'). */
  readonly externalPrId: string;
  /** The PR head commit reported by the PR authority (null when unknown). */
  readonly headCommit: string | null;
}

/**
 * PR #52 round 3 (review, BLOCKER 3) — an EXTERNALLY OBSERVED pull request,
 * resolved to its AUTHORITATIVE identity through the /github boundary.
 *
 * A raw external PR reference (`github:owner/repo#12`) is NOT an
 * implementation revision — it cannot enter the checkpoint binding or the
 * governed-creation identity until the external PR's authoritative head
 * COMMIT SHA has been resolved through /github. This type carries that
 * resolved identity.
 */
export interface ResolvedExternalPullRequest {
  /** The canonical provider-independent PR identity. */
  readonly externalPrId: string;
  /** The PR's authoritative head commit SHA (null when the authority reports none). */
  readonly headCommit: string | null;
  /** The PR state at the authority (adoption into PR_OPEN requires 'open'). */
  readonly state: 'open' | 'closed';
  /** Whether the authority reports the PR merged. */
  readonly merged: boolean;
}

/**
 * The PR-creation boundary consumed by the governed PR-creation protocol.
 * Called ONLY after the pr_conformance checkpoint gate allows progression —
 * never before, never as an agent side effect.
 *
 * PR #52 round 2 (BLOCKER 2): the port is BOTH halves of the external
 * boundary — the convergence READ and the create. The deterministic head
 * branch (a pure function of the work item + implementation revision — see
 * {@link governedHeadBranch}) is the convergence marker that ties them
 * together: after a crash between the external create and the durable
 * record, the retry finds the already-created PR by that branch and
 * converges instead of creating a second PR.
 *
 * PR #52 round 4 (review, BLOCKER 3): BOTH halves validate the COMPLETE
 * governed identity — the deterministic head BRANCH **and** the
 * AUTHORITATIVE head SHA === the requested headRevision. A branch match
 * with a mismatched (or missing) SHA is NON-CONVERGENT: the production port
 * throws {@link GovernedConvergenceMismatchError} (fail closed) instead of
 * returning a PR whose content is not the revision the architecture
 * checkpoint gated on. The convergence claim never asserts more provenance
 * than the external authority actually proves.
 */
export interface PullRequestCreationPort {
  /**
   * The CONVERGENCE READ: find the PR this boundary already created for the
   * (workItemId, headRevision) pair. Returns null when no such PR exists.
   * Read-only — no side effects.
   *
   * Round 4 (BLOCKER 3): a PR found on the deterministic governed branch
   * whose AUTHORITATIVE head SHA does not equal the requested headRevision
   * (or reports none) is NOT the converged PR — the implementation throws
   * {@link GovernedConvergenceMismatchError} (non-convergent, fail closed).
   */
  findExistingPullRequest(input: {
    /** The work item's project (repository coordinates are resolved SERVER-SIDE). */
    projectId: string;
    workItemId: string;
    /** The EXACT implementation revision the checkpoint gated on. */
    headRevision: string;
  }): Promise<CreatedPullRequest | null>;

  /**
   * The CREATE: open the governed PR. The head branch is DERIVED
   * deterministically from (workItemId, headRevision) — the convergence
   * marker — so a create is idempotent at the provider boundary (GitHub
   * itself rejects a second open PR for the same head).
   *
   * Round 4 (BLOCKER 3): the creation result's AUTHORITATIVE head SHA must
   * equal the requested headRevision — the created PR must deliver exactly
   * the gated implementation revision. A mismatched (or missing) head SHA
   * throws {@link GovernedConvergenceMismatchError} and the durable record
   * is NOT written (the external PR is left unassociated — an observable
   * anomaly, never a false provenance claim).
   */
  createPullRequest(input: {
    /** The work item's project (repository coordinates are resolved SERVER-SIDE). */
    projectId: string;
    workItemId: string;
    /** The EXACT implementation revision the checkpoint gated on. */
    headRevision: string;
    title: string;
    body?: string | null;
  }): Promise<CreatedPullRequest>;

  /**
   * PR #52 round 3 (review, BLOCKER 3) — the EXTERNAL-OBSERVATION RESOLUTION
   * read: resolve an externally observed PR reference to its AUTHORITATIVE
   * identity (the PR's real head commit SHA, state, and merged flag) through
   * /github. Read-only — no side effects.
   *
   * Returns null when the authority holds no such PR (an honest 404 — an
   * unresolvable observation). Throws on a malformed reference, a missing
   * project repository link, a reference to a repository OTHER than the
   * project's linked repository, or any authority transport failure — the
   * caller fails closed in every one of those cases.
   *
   * The orchestrator calls this BEFORE the pr_conformance gate whenever only
   * an external PR observation (no commit revision) is available: only the
   * resolved commit SHA may enter the checkpoint binding and the
   * governed-creation identity.
   */
  resolveExternalPullRequest(input: {
    /** The work item's project (repository coordinates are resolved SERVER-SIDE). */
    projectId: string;
    /** The external PR reference (e.g. 'github:owner/repo#12'). */
    externalPrRef: string;
  }): Promise<ResolvedExternalPullRequest | null>;
}

/**
 * Typed error thrown by the orchestrator when a lifecycle operation is
 * refused because the architecture checkpoint gate denied progression
 * (WORK-051). Carries the deterministic denial reasons for the API layer
 * (mapped to HTTP 409 by the workflow route — the route duck-types the
 * `code` field; the class itself is NOT exported through the public barrel).
 */
export class ArchitectureCheckpointGateDeniedError extends Error {
  readonly code = 'architecture-checkpoint-gate-denied';
  readonly checkpointKind: ArchitectureCheckpointKind;
  readonly reasons: string[];

  constructor(checkpointKind: ArchitectureCheckpointKind, reasons: string[]) {
    super(
      `architecture checkpoint gate denied ${checkpointKind}: ${reasons.join('; ')}`,
    );
    this.name = 'ArchitectureCheckpointGateDeniedError';
    this.checkpointKind = checkpointKind;
    this.reasons = reasons;
  }
}

/**
 * PR #52 round 4 (review, BLOCKER 2) — typed conflict thrown by the durable
 * governed-PR identity protocol when TWO DIFFERENT PR identities claim the
 * SAME convergence key (work item, authoritative head revision).
 *
 * The ledger (`wfos_pull_request_intents`) permits exactly ONE recorded PR
 * identity per key: whichever governed path records first (create or adopt)
 * wins, and the other path CONVERGES on the recorded identity. A path that
 * arrives with a DIFFERENT PR for the same key is not a convergence — it is
 * an identity conflict, and it fails CLOSED (no association, no PR_OPEN).
 * The work item stays in its current lifecycle state; the conflict is
 * observable (logged with both identities) and never silently resolves into
 * a second PR association.
 */
export class GovernedPrIdentityConflictError extends Error {
  readonly code = 'governed-pr-identity-conflict';
  readonly workItemId: string;
  readonly headRevision: string;
  readonly recordedExternalPrId: string;
  readonly claimedExternalPrId: string;

  constructor(input: {
    workItemId: string;
    headRevision: string;
    recordedExternalPrId: string;
    claimedExternalPrId: string;
  }) {
    super(
      `governed-pr-identity-conflict: the convergence key (work item ${input.workItemId}, ` +
        `head revision ${input.headRevision}) is already durably bound to ` +
        `${input.recordedExternalPrId}; the observed PR ${input.claimedExternalPrId} is a ` +
        'DIFFERENT identity for the same key — one (work item, authoritative head commit) ' +
        'converges on exactly one PR association (fail closed)',
    );
    this.name = 'GovernedPrIdentityConflictError';
    this.workItemId = input.workItemId;
    this.headRevision = input.headRevision;
    this.recordedExternalPrId = input.recordedExternalPrId;
    this.claimedExternalPrId = input.claimedExternalPrId;
  }
}

/**
 * PR #52 round 4 (review, BLOCKER 3) — typed failure thrown by the governed
 * convergence boundary when the external authority's answer does not PROVE
 * the provenance the governed path requires:
 *
 *   - the convergence read found an OPEN PR on the deterministic governed
 *     head branch, but the PR's ACTUAL head commit differs from the
 *     requested implementation revision (same branch, different SHA — a
 *     stale or force-pushed branch must never be adopted as the converged
 *     PR for the gated revision); or
 *   - the authority returned no head SHA at all (unprovable provenance).
 *
 * A branch match with a mismatched SHA is NON-CONVERGENT: the protocol fails
 * closed instead of associating a PR whose content is not the revision the
 * architecture checkpoint gated on.
 */
export class GovernedConvergenceMismatchError extends Error {
  readonly code = 'governed-pr-convergence-mismatch';
  readonly workItemId: string;
  readonly headRevision: string;
  readonly governedBranch: string;
  readonly observedHeadCommit: string | null;

  constructor(input: {
    workItemId: string;
    headRevision: string;
    governedBranch: string;
    observedHeadCommit: string | null;
    reason: string;
  }) {
    super(
      `governed-pr-convergence-mismatch: ${input.reason} ` +
        `(work item ${input.workItemId}, gated revision ${input.headRevision}, ` +
        `governed branch ${input.governedBranch}, observed head commit ` +
        `${input.observedHeadCommit ?? 'none'}) — the convergence marker matches but the ` +
        'authoritative head SHA does not correspond to the requested governed revision ' +
        '(non-convergent, fail closed)',
    );
    this.name = 'GovernedConvergenceMismatchError';
    this.workItemId = input.workItemId;
    this.headRevision = input.headRevision;
    this.governedBranch = input.governedBranch;
    this.observedHeadCommit = input.observedHeadCommit;
  }
}
