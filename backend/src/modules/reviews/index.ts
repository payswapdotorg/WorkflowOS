/**
 * reviews module — public interface.
 *
 * Canonical name: /reviews
 * Responsibility (spec/architecture.md §6, §19, §20): Architect Reviews and
 * Review Findings.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-016: implements the authoritative /reviews domain (REVIEW-001, REVIEW-002).
 * Owns Architect Review + Review Finding persistence and semantics. Does NOT:
 * - own architect execution (that's /llm — LLM-002);
 * - own canonical workflow state (that's /workflows);
 * - own verification semantics / evidence (that's /verification);
 * - own Work Item/Work Order (that's /work-items);
 * - own ArchitectureVersion (that's /architecture).
 *
 * Boundary ownership (frozen architecture §6, §19, §20; architecture-lock.md §61):
 *   /llm executes architect reasoning → /reviews persists the verdict + findings
 *   → /workflows consumes the public ArchitectReviewResult to drive state
 *     transitions.
 *
 * Traceability chain (frozen architecture §19, §25, §35):
 *   Review → Work Item → ArchitectureVersion → Architecture → Project → Organization
 *
 * Review history / correction cycles (architecture §20, FINDING-AC-03):
 *   Reviews are append-oriented/historical. A finalized review's outcome is
 *   immutable. A later review's findings may reference the prior finding that
 *   caused the correction cycle via causedByFindingId.
 */
import type { ModuleContract } from '@platform/module-contract.js';

export type {
  ReviewVerdict,
  ReviewStatus,
  ReviewSource,
  FindingSeverity,
  FindingDisposition,
  Review,
  CreateReviewInput,
  FinalizeReviewInput,
  ReviewRepository,
  ReviewFinding,
  CreateFindingInput,
  ReviewFindingRepository,
  ArchitectReviewResult,
  ReviewService,
} from './internal/review.types.js';

/**
 * Public capabilities exposed by the /reviews module to other modules.
 */
export interface ReviewsModuleApi {
  // future: additional review-domain methods consumed by other modules
}

/**
 * Frozen module contract for /reviews.
 */
export const reviewsModule: ModuleContract & ReviewsModuleApi = {
  name: '/reviews',
};

export default reviewsModule;
