import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  ArchitectureRepository,
  ArchitectureVersionRepository,
} from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type {
  ReviewService,
  ReviewVerdict,
} from '@modules/reviews/index.js';
import { generateExecutionId } from '@platform/ids.js';
import { requireProjectAuthorization, runAuthed } from '../plugins/auth.plugin.js';

/**
 * Protected review routes (REVIEW-001, REVIEW-002).
 *
 * All routes are backend-authorized via the reusable {@link AuthorizationService}
 * (reused from WORK-002). Authorization resolves through the traceability chain:
 *   Review → Work Item → ArchitectureVersion → Architecture → Project
 *
 * Boundary ownership:
 *   - /reviews OWNS review persistence (create review, add findings, finalize,
 *     retrieve review result).
 *   - /reviews does NOT mutate canonical workflow state — the public
 *     ArchitectReviewResult is exposed for /workflows consumption (WORK-018).
 *   - /reviews does NOT evaluate evidence or modify criterion status
 *     (/verification owns that).
 *   - /reviews does NOT execute architect reasoning (/llm owns that).
 *
 * No API may directly set workflow state or expose LLM provider details.
 */
export interface ReviewRouteDeps {
  authorizationService: AuthorizationService;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  reviewService: ReviewService;
}

async function resolveProjectForWorkItem(
  deps: ReviewRouteDeps,
  workItemId: string,
): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

async function resolveProjectForReview(
  deps: ReviewRouteDeps,
  reviewId: string,
): Promise<string | null> {
  const review = await deps.reviewService.findReview(reviewId);
  return review?.projectId ?? null;
}

export async function reviewRoutes(
  app: FastifyInstance,
  deps: ReviewRouteDeps,
): Promise<void> {
  // --- Create a Review for a Work Item ---

  app.post('/work-items/:workItemId/reviews', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        workOrderId?: string;
        pullRequestAssociationId?: string;
        architectExecutionId?: string;
        source?: 'architect-llm' | 'manual' | 'agent';
        reviewer?: string;
        summary?: string;
        reviewInput?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      };
      if (!body?.source) {
        return reply.code(400).send({ error: 'source required' });
      }
      const wi = await deps.workItemRepository.findById(workItemId);
      if (!wi) return reply.code(404).send({ error: 'work-item-not-found' });
      const executionId = generateExecutionId();
      const review = await deps.reviewService.createReview({
        projectId,
        workItemId,
        workOrderId: body.workOrderId ?? null,
        architectureVersionId: wi.architectureVersionId,
        pullRequestAssociationId: body.pullRequestAssociationId ?? null,
        architectExecutionId: body.architectExecutionId ?? null,
        source: body.source,
        reviewer: body.reviewer ?? null,
        executionId,
        summary: body.summary ?? null,
        reviewInput: body.reviewInput,
        metadata: body.metadata,
      });
      return reply.code(201).send(review);
    });
  });

  // --- Retrieve a Review ---

  app.get('/reviews/:reviewId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { reviewId } = req.params as { reviewId: string };
      const projectId = await resolveProjectForReview(deps, reviewId);
      if (!projectId) {
        return reply.code(404).send({ error: 'review-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const review = await deps.reviewService.findReview(reviewId);
      return reply.code(200).send(review);
    });
  });

  // --- List Review history for a Work Item ---

  app.get('/work-items/:workItemId/reviews', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const reviews = await deps.reviewService.listReviewsForWorkItem(workItemId);
      return reply.code(200).send(reviews);
    });
  });

  // --- Add a Finding to a Review ---

  app.post('/reviews/:reviewId/findings', async (req, reply) => {
    return runAuthed(req, async () => {
      const { reviewId } = req.params as { reviewId: string };
      const projectId = await resolveProjectForReview(deps, reviewId);
      if (!projectId) {
        return reply.code(404).send({ error: 'review-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        severity?: 'blocker' | 'major' | 'minor' | 'info';
        title?: string;
        description?: string;
        affectedScope?: string;
        requirementId?: string;
        criterionId?: string;
        evidenceRef?: string;
        requiredCorrection?: string;
        verificationRequirement?: string;
        causedByFindingId?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.title || !body?.description) {
        return reply.code(400).send({ error: 'title and description required' });
      }
      const finding = await deps.reviewService.addFinding({
        projectId,
        reviewId,
        severity: body.severity,
        title: body.title,
        description: body.description,
        affectedScope: body.affectedScope,
        requirementId: body.requirementId ?? null,
        criterionId: body.criterionId ?? null,
        evidenceRef: body.evidenceRef,
        requiredCorrection: body.requiredCorrection,
        verificationRequirement: body.verificationRequirement,
        causedByFindingId: body.causedByFindingId,
        metadata: body.metadata,
      });
      return reply.code(201).send(finding);
    });
  });

  // --- Retrieve Findings for a Review ---

  app.get('/reviews/:reviewId/findings', async (req, reply) => {
    return runAuthed(req, async () => {
      const { reviewId } = req.params as { reviewId: string };
      const projectId = await resolveProjectForReview(deps, reviewId);
      if (!projectId) {
        return reply.code(404).send({ error: 'review-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const findings = await deps.reviewService.listFindingsForReview(reviewId);
      return reply.code(200).send(findings);
    });
  });

  // --- Finalize a Review (record its outcome) ---

  app.post('/reviews/:reviewId/finalize', async (req, reply) => {
    return runAuthed(req, async () => {
      const { reviewId } = req.params as { reviewId: string };
      const projectId = await resolveProjectForReview(deps, reviewId);
      if (!projectId) {
        return reply.code(404).send({ error: 'review-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        outcome?: ReviewVerdict;
        summary?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.outcome) {
        return reply.code(400).send({ error: 'outcome required' });
      }
      try {
        const review = await deps.reviewService.finalizeReview(reviewId, {
          outcome: body.outcome,
          summary: body.summary,
          metadata: body.metadata,
        });
        return reply.code(200).send(review);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('already finalized')) {
          return reply.code(409).send({ error: 'review-already-finalized', reason: msg });
        }
        if (msg.includes('invalid verdict')) {
          return reply.code(400).send({ error: 'invalid-verdict', reason: msg });
        }
        throw err;
      }
    });
  });

  // --- Retrieve public Review Result (for /workflows consumption) ---

  app.get('/reviews/:reviewId/result', async (req, reply) => {
    return runAuthed(req, async () => {
      const { reviewId } = req.params as { reviewId: string };
      const projectId = await resolveProjectForReview(deps, reviewId);
      if (!projectId) {
        return reply.code(404).send({ error: 'review-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const result = await deps.reviewService.getReviewResult(reviewId);
      if (!result) {
        return reply.code(404).send({ error: 'review-not-finalized' });
      }
      return reply.code(200).send(result);
    });
  });
}
