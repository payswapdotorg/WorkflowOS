/**
 * Reviews domain types (REVIEW-001, REVIEW-002).
 *
 * The /reviews module owns Architect Review + Review Finding persistence and
 * semantics. It does NOT:
 * - own architect execution (that's /llm — LLM-002);
 * - own canonical workflow state (that's /workflows);
 * - own verification semantics / evidence (that's /verification);
 * - own Work Item/Work Order (that's /work-items);
 * - own ArchitectureVersion (that's /architecture).
 *
 * Boundary ownership (frozen architecture §6, §19, §20; architecture-lock.md §61):
 *   /llm executes architect reasoning → /reviews persists the verdict + findings
 *   → /workflows consumes the public ReviewResult to drive state transitions.
 *
 * Traceability chain (frozen architecture §19, §25, §35):
 *   Review → Work Item → ArchitectureVersion → Architecture → Project → Organization
 *   Review → Work Order (where applicable)
 *   Review → Architect Execution (where the review originated from /llm)
 *
 * Review history / correction cycles (architecture §20, FINDING-AC-03):
 *   Reviews are append-oriented/historical. A finalized review's outcome is
 *   immutable. A later review's findings may reference the prior finding that
 *   caused the correction cycle via causedByFindingId.
 */

// --- Review verdicts (canonical, frozen architecture §19) ---
//
// These are the CANONICAL REVIEW VERDICTS — distinct from canonical workflow
// states. The mapping from verdict → workflow transition is /workflows'
// responsibility (WORK-018), NOT /reviews':
//
//   APPROVE                       → workflow proceeds to APPROVED → MERGED
//   REQUEST_CHANGES               → workflow transitions to CHANGES_REQUESTED → IMPLEMENTING
//   ARCHITECTURE_CHANGE_REQUIRED  → workflow transitions to ARCHITECTURE_CHANGE_REQUEST
//   IMPLEMENTATION_BLOCKED        → workflow may set IMPLEMENTATION_BLOCKED state
//
// /reviews does NOT define a competing WorkflowState enum. The verdict is a
// review-domain result; the workflow state is a workflows-domain result.

export type ReviewVerdict =
  | 'APPROVE'
  | 'REQUEST_CHANGES'
  | 'ARCHITECTURE_CHANGE_REQUIRED'
  | 'IMPLEMENTATION_BLOCKED';

// --- Review lifecycle status ---
//
// Distinct from the verdict. A review starts 'in_progress' and is finalized
// to 'completed' with an immutable outcome.

export type ReviewStatus = 'in_progress' | 'completed';

// --- Reviewer/actor source ---
//
// Distinguishes the origin of the review: LLM architect execution vs manual
// human reviewer vs agent-reported. Used for audit traceability
// (architecture §19, §31).

export type ReviewSource = 'architect-llm' | 'manual' | 'agent';

// --- Finding severity (frozen field name; enum values defined by WORK-016) ---
//
// The frozen spec does not enumerate severity values — only the field name
// 'severity' is frozen (architecture §20). WORK-016 defines a conservative
// set: blocker / major / minor / info.

export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'info';

// --- Finding disposition (for correction-cycle traceability) ---
//
// The frozen spec requires findings to persist so correction cycles remain
// traceable (architecture §20, FINDING-AC-03). A finding's disposition
// tracks whether the correction has been addressed.

export type FindingDisposition = 'open' | 'resolved' | 'wont_fix';

// --- Architect Review ---

export interface Review {
  readonly id: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly workOrderId: string | null;
  readonly architectureVersionId: string;
  readonly pullRequestAssociationId: string | null;
  /** Architect execution reference (traceability to /llm). NULL when manual. */
  readonly architectExecutionId: string | null;
  /** Reviewer/actor/source metadata (architecture §19, §31). */
  readonly source: ReviewSource;
  /** LLM provider+model identifier or human actor identifier. */
  readonly reviewer: string | null;
  /** Execution/correlation ID (architecture §35). */
  readonly executionId: string;
  /** Lifecycle status — see {@link ReviewStatus}. */
  readonly status: ReviewStatus;
  /** Review verdict/outcome — NULL while in_progress; set when finalized. */
  readonly outcome: ReviewVerdict | null;
  /** Summary/rationale. */
  readonly summary: string | null;
  /** Structured input/context that produced the verdict. */
  readonly reviewInput: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateReviewInput {
  projectId: string;
  workItemId: string;
  workOrderId?: string | null;
  architectureVersionId: string;
  pullRequestAssociationId?: string | null;
  /** Architect execution reference (traceability to /llm). NULL when manual. */
  architectExecutionId?: string | null;
  source: ReviewSource;
  reviewer?: string | null;
  executionId: string;
  summary?: string | null;
  reviewInput?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface FinalizeReviewInput {
  /** The verdict/outcome to set. Must be a canonical verdict. */
  outcome: ReviewVerdict;
  /** Optional summary update at finalization time. */
  summary?: string | null;
  /** Optional metadata update at finalization time. */
  metadata?: Record<string, unknown>;
}

export interface ReviewRepository {
  create(input: CreateReviewInput): Promise<Review>;
  findById(id: string): Promise<Review | null>;
  listForWorkItem(workItemId: string): Promise<Review[]>;
  /** Finalize a review — set the immutable outcome + completed_at. */
  finalize(id: string, input: FinalizeReviewInput): Promise<Review | null>;
}

// --- Review Finding ---

export interface ReviewFinding {
  readonly id: string;
  readonly projectId: string;
  readonly reviewId: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly description: string;
  readonly affectedScope: string | null;
  /** Related Requirement (optional — FK to /requirements authority). */
  readonly requirementId: string | null;
  /** Related Acceptance Criterion (optional — FK to /requirements authority). */
  readonly criterionId: string | null;
  /** Related evidence reference (free-text ref to /verification evidence). */
  readonly evidenceRef: string | null;
  /** Required correction (what needs to be fixed). */
  readonly requiredCorrection: string | null;
  /** Verification requirement (what verification should confirm the fix). */
  readonly verificationRequirement: string | null;
  /** Finding disposition (for correction-cycle traceability). */
  readonly disposition: FindingDisposition;
  /** Correction-cycle link-back (FINDING-AC-03). */
  readonly causedByFindingId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateFindingInput {
  projectId: string;
  reviewId: string;
  severity?: FindingSeverity;
  title: string;
  description: string;
  affectedScope?: string | null;
  requirementId?: string | null;
  criterionId?: string | null;
  evidenceRef?: string | null;
  requiredCorrection?: string | null;
  verificationRequirement?: string | null;
  /** Correction-cycle link-back (FINDING-AC-03). */
  causedByFindingId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ReviewFindingRepository {
  create(input: CreateFindingInput): Promise<ReviewFinding>;
  findById(id: string): Promise<ReviewFinding | null>;
  listForReview(reviewId: string): Promise<ReviewFinding[]>;
  /** Update disposition (for correction-cycle traceability). */
  updateDisposition(id: string, disposition: FindingDisposition): Promise<ReviewFinding | null>;
}

// --- Public Review Result (consumed by /workflows) ---

/**
 * Provider-independent public review result for /workflows consumption.
 *
 * This is the ONLY contract /workflows may consume from /reviews. It contains
 * the review's final outcome + finding references — no internal persistence
 * details, no LLM provider details, no workflow state.
 *
 * /workflows consumes this to drive canonical state transitions:
 *   APPROVE                       → workflow proceeds to APPROVED → MERGED
 *   REQUEST_CHANGES               → workflow transitions to CHANGES_REQUESTED
 *   ARCHITECTURE_CHANGE_REQUIRED  → workflow transitions to ARCHITECTURE_CHANGE_REQUEST
 *   IMPLEMENTATION_BLOCKED        → workflow may set IMPLEMENTATION_BLOCKED state
 */
export interface ArchitectReviewResult {
  readonly reviewId: string;
  readonly workItemId: string;
  readonly architectureVersionId: string;
  readonly outcome: ReviewVerdict;
  readonly findingIds: string[];
  readonly summary: string | null;
  readonly completedAt: Date;
}

// --- ReviewService ---

/**
 * The ReviewService owns the review lifecycle:
 *
 *   create Review (in_progress)
 *       ↓
 *   add Findings
 *       ↓
 *   finalize Review (set immutable outcome + completed_at)
 *       ↓
 *   public ArchitectReviewResult (consumed by /workflows)
 *
 * Finalization is deterministic. Once finalized, the review's outcome is
 * immutable — a subsequent review for the same Work Item creates a NEW review
 * record (correction cycle). Both reviews remain independently persisted and
 * historically retrievable (architecture §20, FINDING-AC-03).
 *
 * The ReviewService does NOT:
 * - mutate canonical workflow state (/workflows owns that);
 * - evaluate evidence or modify criterion status (/verification owns that);
 * - execute architect reasoning (/llm owns that);
 * - mutate ArchitectureVersion state (/architecture owns that).
 */
export interface ReviewService {
  /** Create a new Review (in_progress) for a Work Item's implementation attempt. */
  createReview(input: CreateReviewInput): Promise<Review>;

  /** Find a Review by id. Returns null when not found. */
  findReview(id: string): Promise<Review | null>;

  /** List Review history for a Work Item (newest first). */
  listReviewsForWorkItem(workItemId: string): Promise<Review[]>;

  /**
   * Add a Finding to a Review. The review must be 'in_progress' (findings
   * cannot be added to a finalized review — the outcome is immutable).
   */
  addFinding(input: CreateFindingInput): Promise<ReviewFinding>;

  /** List Findings for a Review. */
  listFindingsForReview(reviewId: string): Promise<ReviewFinding[]>;

  /**
   * Finalize a Review — set the immutable outcome + completed_at. Once
   * finalized, the outcome cannot be changed. Repeated finalization is
   * rejected (the review is already completed).
   */
  finalizeReview(reviewId: string, input: FinalizeReviewInput): Promise<Review>;

  /**
   * Get the provider-independent public Review Result for /workflows
   * consumption. Returns null when the review is not finalized.
   */
  getReviewResult(reviewId: string): Promise<ArchitectReviewResult | null>;
}
