import type { DatabaseClient } from '@platform/index.js';
import type {
  Review,
  ReviewStatus,
  ReviewVerdict,
  ReviewSource,
  CreateReviewInput,
  FinalizeReviewInput,
  ReviewRepository,
  ReviewFinding,
  FindingSeverity,
  FindingDisposition,
  CreateFindingInput,
  ReviewFindingRepository,
} from './review.types.js';

// ===========================================================================
// Review repository (REVIEW-001).
//
// The wfos_check_review_integrity trigger enforces that the review's
// architecture_version_id matches the Work Item's version, and project_id
// matches the architecture version → architecture → project chain. This is
// PERSISTENCE-LEVEL enforcement — a direct INSERT with mismatched IDs is
// rejected by PostgreSQL, not just app logic.
// ===========================================================================

export class PgReviewRepository implements ReviewRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateReviewInput): Promise<Review> {
    const result = await this.db.query<ReviewRow>(
      `INSERT INTO wfos_reviews
         (project_id, work_item_id, work_order_id, architecture_version_id,
          pull_request_association_id, architect_execution_id, source, reviewer,
          execution_id, status, summary, review_input, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'in_progress', $10, $11, $12)
       RETURNING id, project_id, work_item_id, work_order_id, architecture_version_id,
                 pull_request_association_id, architect_execution_id, source, reviewer,
                 execution_id, status, outcome, summary, review_input, metadata,
                 started_at, completed_at, created_at, updated_at`,
      [
        input.projectId,
        input.workItemId,
        input.workOrderId ?? null,
        input.architectureVersionId,
        input.pullRequestAssociationId ?? null,
        input.architectExecutionId ?? null,
        input.source,
        input.reviewer ?? null,
        input.executionId,
        input.summary ?? null,
        JSON.stringify(input.reviewInput ?? {}),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapReview(result.rows[0]!);
  }

  async findById(id: string): Promise<Review | null> {
    const result = await this.db.query<ReviewRow>(
      `SELECT id, project_id, work_item_id, work_order_id, architecture_version_id,
              pull_request_association_id, architect_execution_id, source, reviewer,
              execution_id, status, outcome, summary, review_input, metadata,
              started_at, completed_at, created_at, updated_at
       FROM wfos_reviews WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapReview(result.rows[0]!);
  }

  async listForWorkItem(workItemId: string): Promise<Review[]> {
    const result = await this.db.query<ReviewRow>(
      `SELECT id, project_id, work_item_id, work_order_id, architecture_version_id,
              pull_request_association_id, architect_execution_id, source, reviewer,
              execution_id, status, outcome, summary, review_input, metadata,
              started_at, completed_at, created_at, updated_at
       FROM wfos_reviews WHERE work_item_id = $1 ORDER BY created_at DESC`,
      [workItemId],
    );
    return result.rows.map(mapReview);
  }

  async finalize(id: string, input: FinalizeReviewInput): Promise<Review | null> {
    // Finalization is idempotent-rejecting: if the review is already completed,
    // the UPDATE matches 0 rows (WHERE status = 'in_progress') and returns null.
    // The caller can then decide to treat that as "already finalized" vs error.
    const result = await this.db.query<ReviewRow>(
      `UPDATE wfos_reviews
       SET status = 'completed',
           outcome = $2,
           summary = COALESCE($3, summary),
           metadata = COALESCE($4, metadata),
           completed_at = NOW()
       WHERE id = $1 AND status = 'in_progress'
       RETURNING id, project_id, work_item_id, work_order_id, architecture_version_id,
                 pull_request_association_id, architect_execution_id, source, reviewer,
                 execution_id, status, outcome, summary, review_input, metadata,
                 started_at, completed_at, created_at, updated_at`,
      [
        id,
        input.outcome,
        input.summary ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
    if (result.rows.length === 0) return null;
    return mapReview(result.rows[0]!);
  }
}

// ===========================================================================
// Review Finding repository (REVIEW-002).
// ===========================================================================

export class PgReviewFindingRepository implements ReviewFindingRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateFindingInput): Promise<ReviewFinding> {
    const result = await this.db.query<FindingRow>(
      `INSERT INTO wfos_review_findings
         (project_id, review_id, severity, title, description, affected_scope,
          requirement_id, criterion_id, evidence_ref, required_correction,
          verification_requirement, disposition, caused_by_finding_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', $12, $13)
       RETURNING id, project_id, review_id, severity, title, description, affected_scope,
                 requirement_id, criterion_id, evidence_ref, required_correction,
                 verification_requirement, disposition, caused_by_finding_id, metadata,
                 created_at, updated_at`,
      [
        input.projectId,
        input.reviewId,
        input.severity ?? 'major',
        input.title,
        input.description,
        input.affectedScope ?? null,
        input.requirementId ?? null,
        input.criterionId ?? null,
        input.evidenceRef ?? null,
        input.requiredCorrection ?? null,
        input.verificationRequirement ?? null,
        input.causedByFindingId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapFinding(result.rows[0]!);
  }

  async findById(id: string): Promise<ReviewFinding | null> {
    const result = await this.db.query<FindingRow>(
      `SELECT id, project_id, review_id, severity, title, description, affected_scope,
              requirement_id, criterion_id, evidence_ref, required_correction,
              verification_requirement, disposition, caused_by_finding_id, metadata,
              created_at, updated_at
       FROM wfos_review_findings WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapFinding(result.rows[0]!);
  }

  async listForReview(reviewId: string): Promise<ReviewFinding[]> {
    const result = await this.db.query<FindingRow>(
      `SELECT id, project_id, review_id, severity, title, description, affected_scope,
              requirement_id, criterion_id, evidence_ref, required_correction,
              verification_requirement, disposition, caused_by_finding_id, metadata,
              created_at, updated_at
       FROM wfos_review_findings WHERE review_id = $1 ORDER BY created_at`,
      [reviewId],
    );
    return result.rows.map(mapFinding);
  }

  async updateDisposition(id: string, disposition: FindingDisposition): Promise<ReviewFinding | null> {
    const result = await this.db.query<FindingRow>(
      `UPDATE wfos_review_findings SET disposition = $2 WHERE id = $1
       RETURNING id, project_id, review_id, severity, title, description, affected_scope,
                 requirement_id, criterion_id, evidence_ref, required_correction,
                 verification_requirement, disposition, caused_by_finding_id, metadata,
                 created_at, updated_at`,
      [id, disposition],
    );
    if (result.rows.length === 0) return null;
    return mapFinding(result.rows[0]!);
  }
}

// ===========================================================================
// Row mappers
// ===========================================================================

interface ReviewRow {
  id: string;
  project_id: string;
  work_item_id: string;
  work_order_id: string | null;
  architecture_version_id: string;
  pull_request_association_id: string | null;
  architect_execution_id: string | null;
  source: string;
  reviewer: string | null;
  execution_id: string;
  status: string;
  outcome: string | null;
  summary: string | null;
  review_input: unknown;
  metadata: unknown;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapReview(row: ReviewRow): Review {
  return {
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    workOrderId: row.work_order_id,
    architectureVersionId: row.architecture_version_id,
    pullRequestAssociationId: row.pull_request_association_id,
    architectExecutionId: row.architect_execution_id,
    source: row.source as ReviewSource,
    reviewer: row.reviewer,
    executionId: row.execution_id,
    status: row.status as ReviewStatus,
    outcome: row.outcome as ReviewVerdict | null,
    summary: row.summary,
    reviewInput: (row.review_input as Record<string, unknown>) ?? {},
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface FindingRow {
  id: string;
  project_id: string;
  review_id: string;
  severity: string;
  title: string;
  description: string;
  affected_scope: string | null;
  requirement_id: string | null;
  criterion_id: string | null;
  evidence_ref: string | null;
  required_correction: string | null;
  verification_requirement: string | null;
  disposition: string;
  caused_by_finding_id: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

function mapFinding(row: FindingRow): ReviewFinding {
  return {
    id: row.id,
    projectId: row.project_id,
    reviewId: row.review_id,
    severity: row.severity as FindingSeverity,
    title: row.title,
    description: row.description,
    affectedScope: row.affected_scope,
    requirementId: row.requirement_id,
    criterionId: row.criterion_id,
    evidenceRef: row.evidence_ref,
    requiredCorrection: row.required_correction,
    verificationRequirement: row.verification_requirement,
    disposition: row.disposition as FindingDisposition,
    causedByFindingId: row.caused_by_finding_id,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
