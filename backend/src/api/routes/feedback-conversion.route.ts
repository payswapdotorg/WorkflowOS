import type { Logger } from '@platform/index.js';
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  ArchitectureVersionRepository,
  ArchitectureRepository,
} from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { EngineeringSignalService } from '../../engineering-signals/index.js';
import type {
  FeedbackConversionService,
  ConversionContext,
} from '../../feedback-conversion/index.js';
import { FeedbackConversionError } from '../../feedback-conversion/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * WORK-068 — Feedback → Governed Work Items routes — surface the
 * conversion capability over HTTP.
 *
 *   POST /projects/:projectId/feedback/convert
 *     — THE canonical MUTATION: the governed conversion decision. Requires
 *       project.write (it CREATES authoritative Work Items through the
 *       existing /work-items intake). The route FORCES decidedBy = the
 *       authenticated principal (server-resolved — a caller can NEVER
 *       supply the deciding principal) and requires the caller-supplied
 *       decisionReason (the governance trail). The service re-derives the
 *       assessment in the mutation path (no silent conversion) and
 *       deduplicates against the existing OPEN Work Items (convergence —
 *       never a second Work Item).
 *   GET  /projects/:projectId/feedback/proposals?architectureVersionId=<uuid>
 *     — READ-ONLY assessment preview: the assessed, deduplicated,
 *       prioritized proposals WITHOUT creating anything. Requires
 *       project.read. NEVER creates / mutates (the GET route calls only
 *       the read-only assessSignals).
 *
 * The governed-decision boundary (the planner PR #44 round-4 discipline):
 * the public route accepts ONLY { architectureVersionId, signalIds?,
 * decisionReason }. The server constructs the authoritative
 * ConversionDecision from the authenticated principal:
 *   decidedBy     = user.id (server-resolved — FORBIDDEN as a body field)
 *   decisionReason = the caller-supplied non-empty reason
 * A caller-supplied `decidedBy`, `decision`, `assessment`, or
 * `priority` field is REJECTED with 400 (the boundary is explicit — the
 * public route does not silently ignore caller-supplied authority; it
 * REJECTS it, so a public caller can NEVER manufacture a decision
 * provenance or an assessment).
 *
 * Every route is backend-authorized via the reusable AuthorizationService
 * (AUTHZ-AC-01..03). A project / version UUID is NOT an authorization
 * credential — every route resolves the resource, verifies authorization
 * server-side, then mutates. The route is THIN: it delegates to the
 * FeedbackConversionService (the conversion orchestrator that composes
 * the WORK-067 signal source + the /work-items + /architecture
 * authorities). No GitHub SDK, no credentials, no DB access here. The
 * conversion NEVER mutates the dependency graph, NEVER transitions
 * workflow state, NEVER starts execution, NEVER selects a provider.
 */
export interface FeedbackConversionRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  architectureRepository: ArchitectureRepository;
  workItemRepository: WorkItemRepository;
  engineeringSignalService: EngineeringSignalService;
  conversionService: FeedbackConversionService;
  logger: Logger;
}

/**
 * Resolve the ConversionContext for a project: load the project (→ orgId)
 * + verify it exists. The architecture version's ownership is verified by
 * the SERVICE itself (requireVersionOwnership — a UUID is NEVER a
 * credential).
 */
async function resolveConversionContext(
  deps: FeedbackConversionRouteDeps,
  projectId: string,
): Promise<ConversionContext> {
  const project = await deps.projectRepository.findById(projectId);
  if (!project) {
    throw new Error('project-not-found');
  }
  return {
    organizationId: project.organizationId,
    projectId: project.id,
    engineeringSignalService: deps.engineeringSignalService,
    workItemRepository: deps.workItemRepository,
    architectureVersionRepository: deps.architectureVersionRepository,
    architectureRepository: deps.architectureRepository,
    logger: deps.logger,
  };
}

/**
 * The FORBIDDEN decision-authority fields — a public caller MUST NOT
 * supply these. The server constructs decidedBy from the authenticated
 * principal; the assessment/priority are ALWAYS service-derived. If ANY
 * forbidden field is present, the request is REJECTED with 400 (the
 * explicit boundary: a public caller can NEVER manufacture a decision
 * provenance, an assessment, or a priority).
 */
const FORBIDDEN_DECISION_FIELDS = [
  'decidedBy', // server forces the authenticated principal
  'decision', // the server constructs the decision record
  'assessment', // ALWAYS service-derived (never caller-supplied)
  'priority', // ALWAYS service-derived (never caller-supplied)
  'proposals', // NEVER caller-supplied (derived state)
] as const;

export async function feedbackConversionRoutes(
  app: FastifyInstance,
  deps: FeedbackConversionRouteDeps,
): Promise<void> {
  // GET /projects/:projectId/feedback/proposals — the READ-ONLY assessment
  // preview. project.read ONLY: a read-authorized caller can NEVER trigger
  // a mutation (the route calls only the read-only assessSignals).
  app.get('/projects/:projectId/feedback/proposals', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const query = req.query as { architectureVersionId?: string } | undefined;
      if (!query?.architectureVersionId) {
        return reply.code(400).send({ error: 'architectureVersionId required' });
      }
      try {
        const ctx = await resolveConversionContext(deps, projectId);
        const result = await deps.conversionService.assessSignals(
          { projectId, architectureVersionId: query.architectureVersionId },
          ctx,
        );
        return reply.send(result);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('project-not-found')) {
          return reply.code(404).send({ error: 'project-not-found' });
        }
        if (msg.includes('conversion-architecture-version-not-found')) {
          return reply.code(404).send({ error: 'architecture-version-not-found' });
        }
        if (msg.includes('conversion-architecture-version-not-in-project')) {
          return reply.code(403).send({ error: 'forbidden', reason: 'version-not-in-project' });
        }
        return reply
          .code(500)
          .send({ error: 'feedback-assessment-failed', message: msg.slice(0, 500) });
      }
    });
  });

  // POST /projects/:projectId/feedback/convert — THE canonical MUTATION (the
  // governed conversion decision). project.write: it CREATES authoritative
  // Work Items through the existing /work-items intake.
  app.post('/projects/:projectId/feedback/convert', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        architectureVersionId?: string;
        signalIds?: unknown;
        decisionReason?: unknown;
      } | undefined;
      if (!body?.architectureVersionId) {
        return reply.code(400).send({ error: 'architectureVersionId required' });
      }
      // REJECT any forbidden decision-authority field (the explicit
      // boundary: decidedBy/decision/assessment/priority/proposals are
      // NEVER caller-supplied).
      for (const field of FORBIDDEN_DECISION_FIELDS) {
        if (body && field in body) {
          return reply.code(400).send({
            error: 'forbidden-field',
            reason: 'public-route-constructs-the-decision-server-side',
            field,
          });
        }
      }
      // The caller-supplied decision reason (the governance trail) —
      // REQUIRED, non-empty (no silent conversion).
      if (typeof body.decisionReason !== 'string' || body.decisionReason.trim() === '') {
        return reply.code(400).send({
          error: 'decisionReason required',
          reason: 'the governed conversion decision requires a non-empty recorded reason',
        });
      }
      // The optional explicit signal subset (each must exist + belong to
      // the project — the service validates fail-closed).
      let signalIds: readonly string[] | undefined;
      if (body.signalIds !== undefined) {
        if (
          !Array.isArray(body.signalIds) ||
          body.signalIds.some((id) => typeof id !== 'string' || id.trim() === '')
        ) {
          return reply.code(400).send({ error: 'signalIds must be an array of signal ids' });
        }
        signalIds = body.signalIds as readonly string[];
      }
      try {
        const ctx = await resolveConversionContext(deps, projectId);
        const result = await deps.conversionService.convertSignals(
          {
            projectId,
            architectureVersionId: body.architectureVersionId,
            signalIds,
            // THE GOVERNED DECISION — the server constructs it from the
            // AUTHENTICATED principal + the caller-supplied reason. A
            // public caller can NEVER manufacture the deciding principal.
            decision: {
              decidedBy: user.id,
              decisionReason: body.decisionReason,
            },
          },
          ctx,
        );
        return reply.code(result.createdCount > 0 ? 201 : 200).send(result);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('project-not-found')) {
          return reply.code(404).send({ error: 'project-not-found' });
        }
        if (msg.includes('conversion-architecture-version-not-found')) {
          return reply.code(404).send({ error: 'architecture-version-not-found' });
        }
        if (msg.includes('conversion-architecture-version-not-in-project')) {
          return reply.code(403).send({ error: 'forbidden', reason: 'version-not-in-project' });
        }
        if (err instanceof FeedbackConversionError) {
          return reply.code(400).send({ error: err.code, message: err.message.slice(0, 500) });
        }
        return reply
          .code(500)
          .send({ error: 'feedback-conversion-failed', message: msg.slice(0, 500) });
      }
    });
  });
}
