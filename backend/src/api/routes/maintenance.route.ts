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
  CiEvidenceIngestionRepository,
} from '@modules/github/index.js';
import type { ProjectBaselineRepository } from '@modules/projects/index.js';
import type {
  MaintenanceService,
  MaintenanceContext,
  AdvisorySource,
} from '@maintenance/index.js';
import {
  MAINTENANCE_RUN_JOB_TYPE,
} from '@maintenance/index.js';
import type {
  DevelopmentPlannerService,
  PlanningContext,
  PlanningEvaluateInput,
  PlanningSignal,
} from '@development-planner/index.js';
import { PLANNING_EVALUATE_JOB_TYPE } from '@development-planner/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * WORK-041: Maintenance + Project Health Engine routes — surface the
 * maintenance capability over HTTP.
 *
 *   POST /projects/:projectId/maintenance/evaluate
 *     — the USER-REQUEST mutation trigger. Accepts the constrained user-request
 *       shape { canonicalGoal, scope? }; the server constructs
 *       kind=maintenance-request, provenance=proposed, originator=user.id +
 *       feeds the EXISTING planner (DevelopmentPlannerService.evaluate). This
 *       mirrors the WORK-040 round-4 authority/provenance boundary EXACTLY.
 *       Requires project.write.
 *   POST /projects/:projectId/maintenance/evaluate-async
 *     — enqueue a durable `planning.evaluate` job on the EXISTING platform
 *       Queue (the user-request signals go through the planner). Same
 *       constrained body shape. Returns 202.
 *   POST /projects/:projectId/maintenance/scan
 *     — the DETECTOR-TRIGGER mutation. Runs the configured detectors (CI
 *       regression, architecture drift, advisory) + feeds their full-vocabulary
 *       PlanningSignals to the planner via MaintenanceService.detectAndEvaluate.
 *       The body is { architectureVersionId, baselineId?, idempotencyKey? } —
 *       NO signal-authority fields. The caller CANNOT manufacture evidence.
 *       Requires project.write.
 *   POST /projects/:projectId/maintenance/scan-async
 *     — enqueue a durable `maintenance.run` job. Returns 202 + { jobId, type }.
 *   GET  /projects/:projectId/maintenance/signals?architectureVersionId=<uuid>
 *     — READ-ONLY list of maintenance-originated Work Items (those whose
 *       metadata.planner.maintenance exists). Requires project.read.
 *   GET  /projects/:projectId/maintenance/health?architectureVersionId=<uuid>
 *     — READ-ONLY summary of maintenance signals by category + severity.
 *       Requires project.read.
 *
 * AUTHORITY/PROVENANCE BOUNDARY (mirror of WORK-040 round 4): the PUBLIC
 * evaluate/evaluate-async routes accept ONLY the user-request shape. The
 * server constructs kind=maintenance-request, provenance=proposed,
 * originator=user.id. NO caller-supplied kind/provenance/evidenceRefs/
 * blocksCount/relatedWorkItemIds/originator/baselineCommitSha/maintenance. The
 * DETECTORS are TRUSTED INTERNAL PRODUCERS — they run via the scan/scan-async
 * routes (which accept NO signal-authority fields) OR via the programmatic
 * MaintenanceService.detectAndEvaluate call. The scan routes do NOT let a
 * caller manufacture evidence: the detectors' outputs are determined by
 * authoritative source facts, NOT by caller input.
 */
export interface MaintenanceRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  architectureRepository: ArchitectureRepository;
  requirementRepository: RequirementRepository;
  acceptanceCriterionRepository: AcceptanceCriterionRepository;
  workItemRepository: WorkItemRepository;
  workItemDependencyRepository: WorkItemDependencyRepository;
  ciEvidenceRepository: CiEvidenceIngestionRepository;
  projectBaselineRepository: ProjectBaselineRepository;
  advisorySource?: AdvisorySource;
  /** The EXISTING planner service — for the evaluate/evaluate-async routes (user requests → planner). */
  plannerService: DevelopmentPlannerService;
  /** The maintenance service — for the scan/scan-async routes (detector trigger → detectors → planner). */
  maintenanceService: MaintenanceService;
  logger: Logger;
  /** The EXISTING platform Queue — for evaluate-async + scan-async (NO new scheduler). */
  queue?: Queue;
}

/**
 * Resolve the PlanningContext for a project (for the planner call in the
 * evaluate route). Mirror of the WORK-040 resolvePlanningContext.
 */
async function resolvePlanningContext(
  deps: MaintenanceRouteDeps,
  projectId: string,
): Promise<{ ctx: PlanningContext; organizationId: string }> {
  const project = await deps.projectRepository.findById(projectId);
  if (!project) {
    throw new Error('project-not-found');
  }
  const ctx: PlanningContext = {
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
  return { ctx, organizationId: project.organizationId };
}

/**
 * Resolve the MaintenanceContext (read-only authority handles for detectors)
 * for a project. Used by the scan + GET routes.
 */
async function resolveMaintenanceContext(
  deps: MaintenanceRouteDeps,
  projectId: string,
): Promise<{ ctx: MaintenanceContext; organizationId: string }> {
  const project = await deps.projectRepository.findById(projectId);
  if (!project) {
    throw new Error('project-not-found');
  }
  const ctx: MaintenanceContext = {
    organizationId: project.organizationId,
    projectId: project.id,
    ciEvidenceRepository: deps.ciEvidenceRepository,
    architectureVersionRepository: deps.architectureVersionRepository,
    architectureRepository: deps.architectureRepository,
    projectBaselineRepository: deps.projectBaselineRepository,
    advisorySource: deps.advisorySource,
    logger: deps.logger,
  };
  return { ctx, organizationId: project.organizationId };
}

/**
 * CROSS-TENANT BASELINE OWNERSHIP GUARD (PR #45 architect review). A
 * caller-supplied baselineId MUST NOT cause the detectors to read another
 * project's baseline observations. The scan + scan-async routes call this
 * BEFORE detectAndEvaluate (sync) / enqueue (async) + return a clean 403 if
 * the baseline does not exist OR belongs to a different project. This is
 * defense in depth alongside the AdvisoryDetector's own check (which protects
 * programmatic calls + the async job handler). A UUID is NEVER a credential.
 */
async function assertBaselineInProject(
  deps: MaintenanceRouteDeps,
  projectId: string,
  baselineId: string,
): Promise<boolean> {
  const baseline = await deps.projectBaselineRepository.findById(baselineId);
  return !!baseline && baseline.projectId === projectId;
}

/**
 * The FORBIDDEN signal-authority fields — a public caller MUST NOT supply
 * these on the evaluate/evaluate-async routes. The server constructs them from
 * the authenticated principal + the frozen maintenance vocabulary. The
 * `maintenance` field is ALSO forbidden — a public caller cannot manufacture
 * maintenance metadata (severity, advisoryId, etc.); only trusted internal
 * detectors supply that. Mirror of the WORK-040 round-4 FORBIDDEN_SIGNAL_FIELDS
 * + the new `maintenance` field.
 */
const FORBIDDEN_SIGNAL_FIELDS = [
  'kind',
  'provenance',
  'evidenceRefs',
  'blocksCount',
  'relatedWorkItemIds',
  'originator',
  'baselineCommitSha',
  'maintenance',
] as const;

/**
 * The public user-request shape — the ONLY per-item shape the public
 * evaluate/evaluate-async routes accept. Mirror of WORK-040's
 * PublicPlanningUserRequest.
 */
interface PublicMaintenanceUserRequest {
  readonly canonicalGoal: string;
  readonly scope?: string;
}

function parsePublicUserRequest(
  raw: unknown,
): PublicMaintenanceUserRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.canonicalGoal !== 'string' || s.canonicalGoal.trim() === '') {
    return null;
  }
  const scope = typeof s.scope === 'string' ? s.scope : undefined;
  for (const field of FORBIDDEN_SIGNAL_FIELDS) {
    if (field in s) return null;
  }
  return { canonicalGoal: s.canonicalGoal, scope };
}

/** Construct the constrained maintenance-request signals from parsed user requests. */
function buildConstrainedSignals(
  requests: readonly PublicMaintenanceUserRequest[],
  originator: string,
): PlanningSignal[] {
  return requests.map((r) => ({
    kind: 'maintenance-request' as const,
    provenance: 'proposed' as const,
    canonicalGoal: r.canonicalGoal,
    scope: r.scope,
    originator,
  }));
}

export async function maintenanceRoutes(
  app: FastifyInstance,
  deps: MaintenanceRouteDeps,
): Promise<void> {
  // POST /projects/:projectId/maintenance/evaluate — the USER-REQUEST mutation.
  // Mirrors WORK-040 POST /planning/evaluate exactly. The server constructs
  // kind=maintenance-request, provenance=proposed, originator=user.id + feeds
  // the planner directly (NOT the detectors).
  app.post('/projects/:projectId/maintenance/evaluate', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        architectureVersionId?: string;
        requests?: unknown[];
        idempotencyKey?: string;
      } | undefined;
      if (
        body &&
        ('signals' in body ||
          'baselineCommitSha' in body ||
          'maintenance' in body)
      ) {
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
      const parsed: PublicMaintenanceUserRequest[] = [];
      for (const raw of body.requests) {
        const p = parsePublicUserRequest(raw);
        if (!p) {
          return reply
            .code(400)
            .send({ error: 'invalid-user-request', request: raw });
        }
        parsed.push(p);
      }
      const signals = buildConstrainedSignals(parsed, user.id);
      const { ctx } = await resolvePlanningContext(deps, projectId);
      try {
        const input: PlanningEvaluateInput = {
          projectId,
          architectureVersionId: body.architectureVersionId,
          signals,
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
          .send({ error: 'maintenance-evaluate-failed', message: msg.slice(0, 500) });
      }
    });
  });

  // POST /projects/:projectId/maintenance/evaluate-async — enqueue a durable
  // planning.evaluate job (the user-request signals go through the planner).
  app.post(
    '/projects/:projectId/maintenance/evaluate-async',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId } = req.params as { projectId: string };
        const user = await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.write',
          projectId,
        });
        if (!deps.queue) {
          return reply
            .code(503)
            .send({ error: 'maintenance-async-unavailable', message: 'no queue configured' });
        }
        const body = req.body as {
          architectureVersionId?: string;
          requests?: unknown[];
          idempotencyKey?: string;
        } | undefined;
        if (
          body &&
          ('signals' in body ||
            'baselineCommitSha' in body ||
            'maintenance' in body)
        ) {
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
        const parsed: PublicMaintenanceUserRequest[] = [];
        for (const raw of body.requests) {
          const p = parsePublicUserRequest(raw);
          if (!p) {
            return reply
              .code(400)
              .send({ error: 'invalid-user-request', request: raw });
          }
          parsed.push(p);
        }
        const signals = buildConstrainedSignals(parsed, user.id);
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
            idempotencyKey: body.idempotencyKey,
          },
          { correlationId: req.id },
        );
        return reply.code(202).send({ jobId: job.id, type: job.type });
      });
    },
  );

  // POST /projects/:projectId/maintenance/scan — the DETECTOR-TRIGGER mutation.
  // Runs the detectors + feeds their full-vocabulary PlanningSignals to the
  // planner via MaintenanceService.detectAndEvaluate. The body is the detector-
  // trigger shape — NO signal-authority fields. The caller CANNOT manufacture
  // evidence.
  app.post('/projects/:projectId/maintenance/scan', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        architectureVersionId?: string;
        baselineId?: string;
        idempotencyKey?: string;
      } | undefined;
      // REJECT any signal-authority field (the scan route accepts ONLY the
      // detector-trigger shape — NO signals, NO baselineCommitSha, NO maintenance).
      if (
        body &&
        ('signals' in body ||
          'baselineCommitSha' in body ||
          'maintenance' in body ||
          'kind' in body ||
          'provenance' in body ||
          'evidenceRefs' in body)
      ) {
        return reply.code(400).send({
          error: 'forbidden-field',
          reason: 'scan-route-accepts-only-detector-trigger-shape',
        });
      }
      if (!body?.architectureVersionId) {
        return reply
          .code(400)
          .send({ error: 'architectureVersionId required' });
      }
      // CROSS-TENANT BASELINE OWNERSHIP GUARD (PR #45): if a caller supplied a
      // baselineId, verify it belongs to the authorized projectId BEFORE
      // detectAndEvaluate. A foreign baselineId returns 403 + the detectors
      // are NEVER invoked (no listObservations call). This is the route-layer
      // gate; the AdvisoryDetector ALSO checks (defense in depth).
      if (body.baselineId) {
        const ok = await assertBaselineInProject(deps, projectId, body.baselineId);
        if (!ok) {
          return reply
            .code(403)
            .send({ error: 'forbidden', reason: 'baseline-not-in-project' });
        }
      }
      const { organizationId } = await resolveMaintenanceContext(
        deps,
        projectId,
      );
      try {
        const result = await deps.maintenanceService.detectAndEvaluate({
          projectId,
          organizationId,
          architectureVersionId: body.architectureVersionId,
          baselineId: body.baselineId,
          idempotencyKey: body.idempotencyKey,
        });
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
        // Defense in depth: if the detector's own ownership check fires
        // (maintenance-baseline-not-in-project) despite the route gate above
        // (e.g. a race where the baseline was deleted between the route check
        // + the detector call), surface it as a 403 too.
        if (msg.includes('maintenance-baseline-not-in-project')) {
          return reply
            .code(403)
            .send({ error: 'forbidden', reason: 'baseline-not-in-project' });
        }
        return reply
          .code(500)
          .send({ error: 'maintenance-scan-failed', message: msg.slice(0, 500) });
      }
    });
  });

  // POST /projects/:projectId/maintenance/scan-async — enqueue a durable
  // maintenance.run job (the detector trigger). Returns 202 + { jobId, type }.
  app.post(
    '/projects/:projectId/maintenance/scan-async',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId } = req.params as { projectId: string };
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.write',
          projectId,
        });
        if (!deps.queue) {
          return reply
            .code(503)
            .send({ error: 'maintenance-async-unavailable', message: 'no queue configured' });
        }
        const body = req.body as {
          architectureVersionId?: string;
          baselineId?: string;
          idempotencyKey?: string;
        } | undefined;
        if (
          body &&
          ('signals' in body ||
            'baselineCommitSha' in body ||
            'maintenance' in body ||
            'kind' in body)
        ) {
          return reply.code(400).send({
            error: 'forbidden-field',
            reason: 'scan-route-accepts-only-detector-trigger-shape',
          });
        }
        if (!body?.architectureVersionId) {
          return reply
            .code(400)
            .send({ error: 'architectureVersionId required' });
        }
        // CROSS-TENANT BASELINE OWNERSHIP GUARD (PR #45): same gate as the
        // sync scan route, applied BEFORE enqueue so a foreign baselineId is
        // rejected with 403 immediately + the maintenance.run job is NEVER
        // enqueued (the async job handler's detector ALSO checks — defense in
        // depth — but the route gate gives clean HTTP semantics + avoids
        // enqueuing a job that would only fail).
        if (body.baselineId) {
          const ok = await assertBaselineInProject(deps, projectId, body.baselineId);
          if (!ok) {
            return reply
              .code(403)
              .send({ error: 'forbidden', reason: 'baseline-not-in-project' });
          }
        }
        const project = await deps.projectRepository.findById(projectId);
        if (!project) {
          return reply.code(404).send({ error: 'project-not-found' });
        }
        const job = await deps.queue.enqueue(
          MAINTENANCE_RUN_JOB_TYPE,
          {
            projectId: project.id,
            organizationId: project.organizationId,
            architectureVersionId: body.architectureVersionId,
            baselineId: body.baselineId,
            idempotencyKey: body.idempotencyKey,
          },
          { correlationId: req.id },
        );
        return reply.code(202).send({ jobId: job.id, type: job.type });
      });
    },
  );

  // GET /projects/:projectId/maintenance/signals?architectureVersionId=...
  // READ-ONLY — never creates / mutates. project.read.
  app.get('/projects/:projectId/maintenance/signals', async (req, reply) => {
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
        const { ctx } = await resolveMaintenanceContext(deps, projectId);
        const signals = await deps.maintenanceService.listMaintenanceSignals(
          q.architectureVersionId,
          ctx,
        );
        return { signals };
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('project-not-found')) {
          return reply.code(404).send({ error: 'project-not-found' });
        }
        if (msg.includes('maintenance-architecture-version-not-found')) {
          return reply
            .code(404)
            .send({ error: 'architecture-version-not-found' });
        }
        if (msg.includes('maintenance-architecture-version-not-in-project')) {
          return reply
            .code(403)
            .send({ error: 'forbidden', reason: 'version-not-in-project' });
        }
        return reply
          .code(500)
          .send({ error: 'maintenance-list-failed', message: msg.slice(0, 500) });
      }
    });
  });

  // GET /projects/:projectId/maintenance/health?architectureVersionId=...
  // READ-ONLY summary of maintenance signals by category + severity.
  app.get('/projects/:projectId/maintenance/health', async (req, reply) => {
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
        const { ctx } = await resolveMaintenanceContext(deps, projectId);
        const signals = await deps.maintenanceService.listMaintenanceSignals(
          q.architectureVersionId,
          ctx,
        );
        const byCategory: Record<string, number> = {};
        const bySeverity: Record<string, number> = {};
        for (const s of signals) {
          const cat = s.maintenance.category;
          byCategory[cat] = (byCategory[cat] ?? 0) + 1;
          const sev = s.maintenance.severity ?? 'unknown';
          bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
        }
        return {
          architectureVersionId: q.architectureVersionId,
          totalSignals: signals.length,
          byCategory,
          bySeverity,
          signals,
        };
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('project-not-found')) {
          return reply.code(404).send({ error: 'project-not-found' });
        }
        return reply
          .code(500)
          .send({ error: 'maintenance-health-failed', message: msg.slice(0, 500) });
      }
    });
  });
}
