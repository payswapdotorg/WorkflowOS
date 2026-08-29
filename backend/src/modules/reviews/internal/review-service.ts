import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type {
  Review,
  ReviewFinding,
  ReviewVerdict,
  CreateReviewInput,
  FinalizeReviewInput,
  CreateFindingInput,
  ArchitectReviewResult,
  ReviewService,
} from './review.types.js';
import { PgReviewRepository, PgReviewFindingRepository } from './pg-review-repository.js';

/**
 * Default {@link ReviewService} — owns the Architect Review lifecycle
 * (REVIEW-001, REVIEW-002).
 *
 * Pipeline:
 *
 *   create Review (in_progress)
 *       ↓
 *   add Findings
 *       ↓
 *   finalize Review (set immutable outcome + completed_at)
 *       ↓
 *   public ArchitectReviewResult (consumed by /workflows)
 *
 * FINALIZATION (frozen architecture §19, §20; FINDING-AC-03):
 *
 * Finalization is deterministic. Once finalized:
 * - The review's outcome is immutable — it cannot be changed.
 * - Findings cannot be added to a finalized review (the outcome + its
 *   supporting findings are frozen together).
 * - A subsequent review for the same Work Item creates a NEW review record
 *   (correction cycle). Both reviews remain independently persisted and
 *   historically retrievable.
 *
 * Repeated finalization is REJECTED (the review is already completed). The
 * caller must create a new review if they want to change the outcome.
 *
 * WORKFLOW BOUNDARY (frozen architecture §13, architecture-lock.md §17):
 *
 * The ReviewService does NOT mutate canonical workflow state. It exposes a
 * provider-independent {@link ArchitectReviewResult} that /workflows consumes
 * to drive state transitions (ARCHITECT_REVIEW → CHANGES_REQUESTED / APPROVED /
 * ARCHITECTURE_CHANGE_REQUIRED). /reviews never imports /workflows/internal.
 *
 * VERIFICATION BOUNDARY (frozen architecture §24):
 *
 * Reviews may REFERENCE persisted verification evidence/criteria (via finding
 * fields), but /reviews does NOT evaluate evidence or modify criterion status.
 * /verification remains authoritative for verification semantics.
 *
 * ARCHITECTURE BOUNDARY (frozen architecture §9):
 *
 * Reviews reference ArchitectureVersion but do NOT mutate it. A verdict of
 * ARCHITECTURE_CHANGE_REQUIRED signals that /architecture's Change Request
 * lifecycle should be invoked (by /workflows), but /reviews itself never
 * creates or mutates Architecture Change Requests.
 *
 * The frozen spec leaves the exact verdict enum to /reviews within the
 * canonical-verdict constraint (§19). No ARCHITECTURE_BLOCKER.
 */
export class DefaultReviewService implements ReviewService {
  private readonly reviewRepo: PgReviewRepository;
  private readonly findingRepo: PgReviewFindingRepository;

  constructor(
    db: DatabaseClient,
    private readonly workItemRepository: WorkItemRepository,
    private readonly logger: Logger,
  ) {
    this.reviewRepo = new PgReviewRepository(db);
    this.findingRepo = new PgReviewFindingRepository(db);
  }

  async createReview(input: CreateReviewInput): Promise<Review> {
    // Validate traceability: the Work Item must belong to the claimed
    // ArchitectureVersion. The persistence-layer trigger
    // (wfos_check_review_integrity) will also enforce this, but we validate
    // here for a cleaner error before the DB exception.
    const wi = await this.workItemRepository.findById(input.workItemId);
    if (!wi) {
      throw new Error(`review: work item ${input.workItemId} not found`);
    }
    if (wi.architectureVersionId !== input.architectureVersionId) {
      throw new Error(
        `review: work item ${input.workItemId} belongs to architecture version ${wi.architectureVersionId}, not ${input.architectureVersionId}`,
      );
    }
    return this.reviewRepo.create(input);
  }

  async findReview(id: string): Promise<Review | null> {
    return this.reviewRepo.findById(id);
  }

  async listReviewsForWorkItem(workItemId: string): Promise<Review[]> {
    return this.reviewRepo.listForWorkItem(workItemId);
  }

  async listReviewsForProject(projectId: string, opts?: { limit?: number }): Promise<Review[]> {
    return this.reviewRepo.listForProject(projectId, opts);
  }

  async addFinding(input: CreateFindingInput): Promise<ReviewFinding> {
    // Verify the review exists + is still in_progress (findings cannot be
    // added to a finalized review — the outcome + supporting findings are
    // frozen together at finalization time).
    const review = await this.reviewRepo.findById(input.reviewId);
    if (!review) {
      throw new Error(`addFinding: review ${input.reviewId} not found`);
    }
    if (review.status === 'completed') {
      throw new Error(
        `addFinding: review ${input.reviewId} is already finalized — cannot add findings to a completed review`,
      );
    }
    // Tenant isolation: the finding's project_id must match the review's.
    if (review.projectId !== input.projectId) {
      throw new Error(
        `addFinding: cross-tenant finding rejected (review project ${review.projectId} vs finding project ${input.projectId})`,
      );
    }
    return this.findingRepo.create(input);
  }

  async listFindingsForReview(reviewId: string): Promise<ReviewFinding[]> {
    return this.findingRepo.listForReview(reviewId);
  }

  async finalizeReview(reviewId: string, input: FinalizeReviewInput): Promise<Review> {
    // Validate the verdict is a canonical verdict (REVIEW-AC-02).
    // The DB CHECK constraint also enforces this, but we validate here for a
    // cleaner error + to distinguish "invalid verdict" from "already finalized".
    if (!isCanonicalVerdict(input.outcome)) {
      throw new Error(
        `finalizeReview: invalid verdict "${input.outcome}" — only canonical verdicts are accepted (APPROVE, REQUEST_CHANGES, ARCHITECTURE_CHANGE_REQUIRED, IMPLEMENTATION_BLOCKED)`,
      );
    }

    const review = await this.reviewRepo.findById(reviewId);
    if (!review) {
      throw new Error(`finalizeReview: review ${reviewId} not found`);
    }
    if (review.status === 'completed') {
      // Repeated finalization is rejected — the outcome is immutable.
      // If the caller wants to change the outcome, they must create a new review.
      throw new Error(
        `finalizeReview: review ${reviewId} is already finalized with outcome "${review.outcome}" — cannot re-finalize. Create a new review to change the outcome (correction cycle).`,
      );
    }

    const finalized = await this.reviewRepo.finalize(reviewId, input);
    if (!finalized) {
      // Should be unreachable given the checks above.
      throw new Error(`finalizeReview: review ${reviewId} could not be finalized`);
    }

    this.logger.info('review.finalized', {
      reviewId: finalized.id,
      workItemId: finalized.workItemId,
      outcome: finalized.outcome,
    });

    return finalized;
  }

  async getReviewResult(reviewId: string): Promise<ArchitectReviewResult | null> {
    const review = await this.reviewRepo.findById(reviewId);
    if (!review || review.status !== 'completed') {
      return null;
    }
    // Load the finding IDs for the finalized review.
    const findings = await this.findingRepo.listForReview(reviewId);
    return {
      reviewId: review.id,
      workItemId: review.workItemId,
      architectureVersionId: review.architectureVersionId,
      outcome: review.outcome!,
      findingIds: findings.map((f) => f.id),
      summary: review.summary,
      completedAt: review.completedAt!,
    };
  }
}

// --- Verdict validation ---

/**
 * Returns true if the verdict is one of the canonical review verdicts
 * (frozen architecture §19). Used to validate finalization input (REVIEW-AC-02).
 */
export function isCanonicalVerdict(verdict: string): verdict is ReviewVerdict {
  return (
    verdict === 'APPROVE' ||
    verdict === 'REQUEST_CHANGES' ||
    verdict === 'ARCHITECTURE_CHANGE_REQUIRED' ||
    verdict === 'IMPLEMENTATION_BLOCKED'
  );
}
