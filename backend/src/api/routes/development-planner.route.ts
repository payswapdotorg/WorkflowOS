import type {
  Logger,
  Queue,
} from '@platform/index.js';
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  ArchitectureVersionRepository,
  ArchitectureRepository,
} from '@modules/architecture/index.js';
import type {
  RequirementRepository,
  AcceptanceCriterionRepository,
} from '@modules/requirements/index.js';
import type {
  WorkItemRepository,
  WorkItemDependencyRepository,
} from '@modules/work-items/index.js';
import type {
  DevelopmentPlannerService,
  PlanningContext,
  PlanningEvaluateInput,
  PlanningSignal,
  PlanningMetadataPayload,
} from '@development-planner/index.js';
import { PLANNING_EVALUATE_JOB_TYPE } from '@development-planner/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * WORK-040: Continuous Development Planner routes — surface the planning
 * capability over HTTP.
 *
 *   POST /projects/:projectId/planning/evaluate
 *     — the canonical MUTATION trigger. Evaluate planning signals, dedup
 *       against existing Work Items in the target architecture version, create
 *       authoritative Work Items THROUGH the existing /work-items
 *       WorkItemRepository.create (metadata.planner embedded), and return the
 *       recommendation list. Requires project.write (it CREATES authoritative
 *       Work Items — a state mutation). Convergent + idempotent (the existing
 *       UNIQUE(architecture_version_id, work_item_id) constraint + the
 *       deterministic proposedWorkItemId fence concurrent runs).
 *   POST /projects/:projectId/planning/evaluate-async
 *     — enqueue a durable `planning.evaluate` job on the EXISTING platform
 *       Queue (reuses WorkerHost; NO new scheduler). Returns 202 + { jobId }.
 *       Requires project.write (it triggers a planner run that will create
 *       Work Items). The job is idempotent (redeliveryPolicy maxAttempts: 3).
 *   GET  /projects/:projectId/planning/recommendations
 *          ?architectureVersionId=<uuid>
 *     — READ-ONLY list of planner-originated Work Items (metadata.planner
 *       present). Requires project.read. NEVER creates / mutates (the GET
 *       route calls only listRecommendations — a read-only service method).
 *   GET  /projects/:projectId/planning/recommendations/:workItemId
 *     — READ-ONLY inspect one planner-originated Work Item. Server-side
 *       ownership (resolve WorkItem→ArchitectureVersion→Architecture→Project;
 *       must match the route's projectId). Requires project.read.
 *
 * Every route is backend-authorized via the reusable AuthorizationService
 * (AUTHZ-AC-01..03). A project / version / work-item UUID is NOT an
 * authorization credential — every mutation resolves the resource, verifies
 * authorization server-side, then mutates. The route is THIN: it delegates to
 * the DevelopmentPlannerService (the orchestrator that composes /work-items +
 * /architecture + /requirements + /projects). No GitHub SDK, no credentials,
 * no DB access here. The planner NEVER mutates the dependency graph, NEVER
 * mutates workflow / verification / review state, NEVER starts execution, NEVER
 * selects a provider.
 */
export interface DevelopmentPlannerRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  architectureRepository: ArchitectureRepository;
  requirementRepository: RequirementRepository;
  acceptanceCriterionRepository: AcceptanceCriterionRepository;
  workItemRepository: WorkItemRepository;
  workItemDependencyRepository: WorkItemDependencyRepository;
  plannerService: DevelopmentPlannerService;
  /** The shared logger (carried into the PlanningContext for the prioritizer's honest failure logging). */
  logger: Logger;
  /** The EXISTING platform Queue — for evaluate-async (NO new scheduler). */
  queue?: Queue;
}

/**
 * Resolve the PlanningContext for a project: load the project (→ orgId) +
 * verify it exists. The architecture version's ownership is verified by the
 * caller (the route checks version.architectureId → architecture.projectId ===
 * projectId). A UUID is NEVER a credential.
 */
async function resolvePlanningContext(
  deps: DevelopmentPlannerRouteDeps,
  projectId: string,
): Promise<PlanningContext> {
  const project = await deps.projectRepository.findById(projectId);
  if (!project) {
    throw new Error('project-not-found');
  }
  return {
    organizationId: project.organizationId,
    projectId: project.id,
    workItemRepository: deps.workItemRepository,
    workItemDependencyRepository: deps.workItemDependencyRepository,
    architectureVersionRepository: deps.architectureVersionRepository,
    architectureRepository: deps.architectureRepository,
    requirementRepository: deps.requirementRepository,
    acceptanceCriterionRepository: deps.acceptanceCriterionRepository,
    logger: deps.logger,
  };
}

/** Walk the traceability chain to resolve a Work Item's project (ownership). */
async function resolveProjectForWorkItem(
  deps: DevelopmentPlannerRouteDeps,
  workItemId: string,
): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(
    wi.architectureVersionId,
  );
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

/** Parse + validate a signal from the request body. */
function parseSignal(raw: unknown): PlanningSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.canonicalGoal !== 'string' || s.canonicalGoal.trim() === '') {
    return null;
  }
  if (typeof s.kind !== 'string') return null;
  if (
    typeof s.provenance !== 'string' ||
    !['observed', 'inferred', 'proposed'].includes(s.provenance)
  ) {
    return null;
  }
  const evidenceRefs = Array.isArray(s.evidenceRefs)
    ? s.evidenceRefs
        .map((e) => {
          if (!e || typeof e !== 'object') return null;
          const er = e as Record<string, unknown>;
          if (typeof er.kind !== 'string' || typeof er.ref !== 'string') return null;
          return {
            kind: er.kind as PlanningSignal['evidenceRefs'] extends
              | readonly (infer E)[]
              | undefined
              ? E extends { kind: infer K }
                ? K
                : never
              : never,
            ref: er.ref,
            detail: typeof er.detail === 'string' ? er.detail : undefined,
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
    : undefined;
  const relatedWorkItemIds = Array.isArray(s.relatedWorkItemIds)
    ? s.relatedWorkItemIds.filter((x): x is string => typeof x === 'string')
    : undefined;
  return {
    kind: s.kind as PlanningSignal['kind'],
    canonicalGoal: s.canonicalGoal,
    scope: typeof s.scope === 'string' ? s.scope : undefined,
    provenance: s.provenance as PlanningSignal['provenance'],
    evidenceRefs,
    relatedWorkItemIds,
    originator: typeof s.originator === 'string' ? s.originator : undefined,
    baselineCommitSha:
      typeof s.baselineCommitSha === 'string' ? s.baselineCommitSha : undefined,
    blocksCount:
      typeof s.blocksCount === 'number' ? s.blocksCount : undefined,
  };
}

export async function developmentPlannerRoutes(
  app: FastifyInstance,
  deps: DevelopmentPlannerRouteDeps,
): Promise<void> {
  // POST /projects/:projectId/planning/evaluate — the canonical MUTATION.
  app.post('/projects/:projectId/planning/evaluate', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        architectureVersionId?: string;
        signals?: unknown[];
        baselineCommitSha?: string;
        idempotencyKey?: string;
      } | undefined;
      if (!body?.architectureVersionId) {
        return reply
          .code(400)
          .send({ error: 'architectureVersionId required' });
      }
      if (!Array.isArray(body.signals)) {
        return reply.code(400).send({ error: 'signals array required' });
      }
      const signals: PlanningSignal[] = [];
      for (const raw of body.signals) {
        const parsed = parseSignal(raw);
        if (!parsed) {
          return reply
            .code(400)
            .send({ error: 'invalid-signal', signal: raw });
        }
        signals.push(parsed);
      }
      try {
        const ctx = await resolvePlanningContext(deps, projectId);
        const input: PlanningEvaluateInput = {
          projectId,
          architectureVersionId: body.architectureVersionId,
          signals,
          baselineCommitSha: body.baselineCommitSha,
          idempotencyKey: body.idempotencyKey,
        };
        const result = await deps.plannerService.evaluate(input, ctx);
        return reply
          .code(result.createdCount > 0 ? 201 : 200)
          .send(result);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('project-not-found')) {
          return reply.code(404).send({ error: 'project-not-found' });
        }
        if (msg.includes('planning-architecture-version-not-found')) {
          return reply
            .code(404)
            .send({ error: 'architecture-version-not-found' });
        }
        if (msg.includes('planning-architecture-version-not-in-project')) {
          return reply
            .code(403)
            .send({ error: 'forbidden', reason: 'version-not-in-project' });
        }
        return reply
          .code(500)
          .send({ error: 'planning-evaluate-failed', message: msg.slice(0, 500) });
      }
    });
  });

  // POST /projects/:projectId/planning/evaluate-async — enqueue a durable job
  // on the EXISTING platform Queue (reuses WorkerHost; NO new scheduler).
  app.post('/projects/:projectId/planning/evaluate-async', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      if (!deps.queue) {
        return reply
          .code(503)
          .send({ error: 'planning-async-unavailable', message: 'no queue configured' });
      }
      const body = req.body as {
        architectureVersionId?: string;
        signals?: unknown[];
        baselineCommitSha?: string;
        idempotencyKey?: string;
      } | undefined;
      if (!body?.architectureVersionId) {
        return reply
          .code(400)
          .send({ error: 'architectureVersionId required' });
      }
      if (!Array.isArray(body.signals)) {
        return reply.code(400).send({ error: 'signals array required' });
      }
      const signals: PlanningSignal[] = [];
      for (const raw of body.signals) {
        const parsed = parseSignal(raw);
        if (!parsed) {
          return reply
            .code(400)
            .send({ error: 'invalid-signal', signal: raw });
        }
        signals.push(parsed);
      }
      // Resolve the project for the organizationId (the job handler re-verifies
      // it on processing — a UUID is NEVER a credential).
      const project = await deps.projectRepository.findById(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'project-not-found' });
      }
      const job = await deps.queue.enqueue(
        PLANNING_EVALUATE_JOB_TYPE,
        {
          projectId: project.id,
          organizationId: project.organizationId,
          architectureVersionId: body.architectureVersionId,
          signals,
          baselineCommitSha: body.baselineCommitSha,
          idempotencyKey: body.idempotencyKey,
        },
        { correlationId: req.id },
      );
      return reply.code(202).send({ jobId: job.id, type: job.type });
    });
  });

  // GET /projects/:projectId/planning/recommendations?architectureVersionId=...
  // READ-ONLY — never creates / mutates. The GET route calls only
  // listRecommendations (a read-only service method). project.read.
  app.get('/projects/:projectId/planning/recommendations', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const q = req.query as { architectureVersionId?: string };
      if (!q.architectureVersionId) {
        return reply
          .code(400)
          .send({ error: 'architectureVersionId query param required' });
      }
      try {
        const ctx = await resolvePlanningContext(deps, projectId);
        const recommendations =
          await deps.plannerService.listRecommendations(
            q.architectureVersionId,
            ctx,
          );
        return { recommendations };
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('project-not-found')) {
          return reply.code(404).send({ error: 'project-not-found' });
        }
        if (msg.includes('planning-architecture-version-not-found')) {
          return reply
            .code(404)
            .send({ error: 'architecture-version-not-found' });
        }
        if (msg.includes('planning-architecture-version-not-in-project')) {
          return reply
            .code(403)
            .send({ error: 'forbidden', reason: 'version-not-in-project' });
        }
        return reply
          .code(500)
          .send({ error: 'planning-list-failed', message: msg.slice(0, 500) });
      }
    });
  });

  // GET /projects/:projectId/planning/recommendations/:workItemId — READ-ONLY
  // inspect one planner-originated Work Item. Server-side ownership: resolve
  // WorkItem→ArchitectureVersion→Architecture→Project (must match the route's
  // projectId). Returns the Work Item + its metadata.planner (or 404 if the
  // Work Item is not planner-originated — no metadata.planner).
  app.get(
    '/projects/:projectId/planning/recommendations/:workItemId',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId, workItemId } = req.params as {
          projectId: string;
          workItemId: string;
        };
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.read',
          projectId,
        });
        // Server-side ownership — a UUID is NEVER a credential.
        const resolvedProjectId = await resolveProjectForWorkItem(deps, workItemId);
        if (!resolvedProjectId) {
          return reply.code(404).send({ error: 'not-found' });
        }
        if (resolvedProjectId !== projectId) {
          return reply
            .code(403)
            .send({ error: 'forbidden', reason: 'cross-tenant-work-item' });
        }
        const wi = await deps.workItemRepository.findById(workItemId);
        if (!wi) return reply.code(404).send({ error: 'not-found' });
        const planner = (wi.metadata as { planner?: PlanningMetadataPayload })
          ?.planner;
        if (!planner) {
          // Not a planner-originated Work Item.
          return reply
            .code(404)
            .send({ error: 'not-a-planner-recommendation', workItemId });
        }
        return {
          workItem: wi,
          planner,
        };
      });
    },
  );
}
