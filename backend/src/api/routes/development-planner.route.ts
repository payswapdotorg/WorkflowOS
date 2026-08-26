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

/**
 * The FORBIDDEN signal-authority fields — a public caller MUST NOT supply
 * these. The server constructs them from the authenticated principal + the
 * frozen planner vocabulary (kind=developer-request, provenance=proposed,
 * originator=user.id). If ANY forbidden field is present, the request is
 * REJECTED with 400 (the boundary is explicit — the public route does NOT
 * silently ignore caller-supplied authority; it REJECTS it, so a public
 * caller can NEVER manufacture `observed` repository evidence, fake
 * evidenceRefs, an unverified baselineCommitSha, or a caller-controlled
 * blocksCount).
 *
 * This is the PR #44 round 4 authority/provenance boundary: the frozen
 * provenance rule is source-fact → baseline/context-evidence → planner
 * recommendation → authoritative Work Item. The planner MUST NOT turn
 * UNVERIFIED CLIENT ASSERTIONS into `observed` repository evidence. Only
 * trusted INTERNAL signal producers (WORK-038/039, /architecture,
 * /requirements, /github, /work-items subsystems) may create the full
 * signal vocabulary — and they call DevelopmentPlannerService.evaluate
 * DIRECTLY (programmatically), NOT through this public route.
 */
const FORBIDDEN_SIGNAL_FIELDS = [
  'kind', // server forces 'developer-request'
  'provenance', // server forces 'proposed'
  'evidenceRefs', // no caller-supplied evidence authority
  'blocksCount', // no caller-controlled priority input
  'relatedWorkItemIds', // no caller-supplied dependency references
  'originator', // server resolves from the authenticated user
  'baselineCommitSha', // no caller-supplied revision (not verified context)
] as const;

/**
 * The public user-request shape — the ONLY per-item shape the public route
 * accepts. A user request is { canonicalGoal, scope? }. The server constructs
 * the authoritative PlanningSignal from this + the authenticated principal:
 *   kind               = 'developer-request'
 *   provenance         = 'proposed'
 *   originator         = user.id (from the authenticated principal)
 *   evidenceRefs       = (none — the public route supplies no evidence authority)
 *   blocksCount        = (none — the prioritizer derives from validated refs)
 *   relatedWorkItemIds = (none — the public route supplies no dependency refs)
 *   baselineCommitSha  = (none — the public route does not verify a revision)
 *
 * Trusted INTERNAL signal producers call DevelopmentPlannerService.evaluate
 * DIRECTLY (programmatically) with the full PlanningSignal vocabulary — they
 * do NOT go through this public route. The programmatic path is unrestricted
 * (it is the trusted-producer entry point); ONLY the public HTTP route is
 * constrained to the user-request shape.
 */
interface PublicPlanningUserRequest {
  readonly canonicalGoal: string;
  readonly scope?: string;
}

/**
 * Parse + validate a public user request. Returns the constrained shape OR
 * null if the input is malformed OR contains a forbidden signal-authority
 * field. The caller-supplied provenance/kind/evidenceRefs/blocksCount/
 * relatedWorkItemIds/originator/baselineCommitSha are NEVER accepted — the
 * server constructs those from the authenticated principal + the frozen
 * planner vocabulary (kind=developer-request, provenance=proposed,
 * originator=user.id).
 */
function parsePublicUserRequest(raw: unknown): PublicPlanningUserRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  // canonicalGoal is the ONE required field (the user's intent).
  if (typeof s.canonicalGoal !== 'string' || s.canonicalGoal.trim() === '') {
    return null;
  }
  // scope is the ONE optional field (user-supplied context).
  const scope = typeof s.scope === 'string' ? s.scope : undefined;
  // REJECT any forbidden signal-authority field. The public route does NOT
  // turn unverified client assertions into observed repository evidence.
  for (const field of FORBIDDEN_SIGNAL_FIELDS) {
    if (field in s) return null;
  }
  return { canonicalGoal: s.canonicalGoal, scope };
}

export async function developmentPlannerRoutes(
  app: FastifyInstance,
  deps: DevelopmentPlannerRouteDeps,
): Promise<void> {
  // POST /projects/:projectId/planning/evaluate — the canonical MUTATION.
  // AUTHORITY/PROVENANCE BOUNDARY (PR #44 round 4): the public route accepts
  // ONLY the user-request shape { canonicalGoal, scope? }. The server
  // constructs the authoritative PlanningSignal from this + the
  // authenticated principal: kind=developer-request, provenance=proposed,
  // originator=user.id. NO caller-supplied provenance/kind/evidenceRefs/
  // blocksCount/relatedWorkItemIds/baselineCommitSha/originator — the public
  // route does NOT turn unverified client assertions into observed repository
  // evidence. Trusted internal producers call DevelopmentPlannerService.evaluate
  // DIRECTLY (programmatically) with the full vocabulary.
  app.post('/projects/:projectId/planning/evaluate', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      // Resolve the authenticated user (the originator).
      // requireProjectAuthorization returns the User; its id is the canonical
      // originator. A UUID is NEVER a credential — the route resolves the
      // principal server-side.
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        architectureVersionId?: string;
        requests?: unknown[];
        idempotencyKey?: string;
      } | undefined;
      // REJECT the old full-vocabulary body shape (top-level `signals` or
      // `baselineCommitSha`). The public route accepts ONLY the user-request
      // shape. Trusted internal producers call DevelopmentPlannerService.evaluate
      // DIRECTLY — they do NOT go through this public route.
      if (body && ('signals' in body || 'baselineCommitSha' in body)) {
        return reply.code(400).send({
          error: 'forbidden-field',
          reason: 'public-route-accepts-only-user-requests',
        });
      }
      if (!body?.architectureVersionId) {
        return reply
          .code(400)
          .send({ error: 'architectureVersionId required' });
      }
      if (!Array.isArray(body.requests)) {
        return reply.code(400).send({ error: 'requests array required' });
      }
      // Construct the authoritative PlanningSignals from the constrained
      // user requests + the authenticated principal. The public route FORCES
      // kind=developer-request + provenance=proposed + originator=user.id. NO
      // caller-supplied evidenceRefs/blocksCount/relatedWorkItemIds/
      // baselineCommitSha (the parsePublicUserRequest parser REJECTS any of
      // these if a caller supplies them).
      const signals: PlanningSignal[] = [];
      for (const raw of body.requests) {
        const parsed = parsePublicUserRequest(raw);
        if (!parsed) {
          return reply
            .code(400)
            .send({ error: 'invalid-user-request', request: raw });
        }
        signals.push({
          kind: 'developer-request',
          provenance: 'proposed',
          canonicalGoal: parsed.canonicalGoal,
          scope: parsed.scope,
          originator: user.id,
        });
      }
      try {
        const ctx = await resolvePlanningContext(deps, projectId);
        const input: PlanningEvaluateInput = {
          projectId,
          architectureVersionId: body.architectureVersionId,
          signals,
          idempotencyKey: body.idempotencyKey,
          // NO baselineCommitSha — the public route does NOT accept a caller-
          // supplied revision (it is not verified context). The planner
          // records null. Trusted internal producers that have resolved a
          // real revision call DevelopmentPlannerService.evaluate DIRECTLY
          // with baselineCommitSha.
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
  // Same AUTHORITY/PROVENANCE BOUNDARY as the sync route (PR #44 round 4): the
  // public async route accepts ONLY the user-request shape; the server
  // constructs kind=developer-request, provenance=proposed, originator=user.id;
  // NO caller-supplied provenance/kind/evidenceRefs/blocksCount/
  // relatedWorkItemIds/baselineCommitSha/originator. The job carries the
  // CONSTRAINED signals (the public async path cannot manufacture observed
  // evidence). Trusted internal producers that want async enqueues call
  // queue.enqueue(PLANNING_EVALUATE_JOB_TYPE, ...) DIRECTLY with full-vocabulary
  // signals — a server-internal mechanism, NOT this public route.
  app.post('/projects/:projectId/planning/evaluate-async', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
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
        requests?: unknown[];
        idempotencyKey?: string;
      } | undefined;
      // REJECT the old full-vocabulary body shape (top-level `signals` or
      // `baselineCommitSha`).
      if (body && ('signals' in body || 'baselineCommitSha' in body)) {
        return reply.code(400).send({
          error: 'forbidden-field',
          reason: 'public-route-accepts-only-user-requests',
        });
      }
      if (!body?.architectureVersionId) {
        return reply
          .code(400)
          .send({ error: 'architectureVersionId required' });
      }
      if (!Array.isArray(body.requests)) {
        return reply.code(400).send({ error: 'requests array required' });
      }
      // Construct the constrained signals (same as the sync route).
      const signals: PlanningSignal[] = [];
      for (const raw of body.requests) {
        const parsed = parsePublicUserRequest(raw);
        if (!parsed) {
          return reply
            .code(400)
            .send({ error: 'invalid-user-request', request: raw });
        }
        signals.push({
          kind: 'developer-request',
          provenance: 'proposed',
          canonicalGoal: parsed.canonicalGoal,
          scope: parsed.scope,
          originator: user.id,
        });
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
          // NO baselineCommitSha — the public async route does NOT accept a
          // caller-supplied revision. The planner records null.
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
