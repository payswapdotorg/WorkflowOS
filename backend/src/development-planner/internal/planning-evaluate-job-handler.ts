/**
 * WORK-040: Durable `planning.evaluate` job handler — reuses the EXISTING
 * platform Queue + WorkerHost (NO new scheduler, NO setInterval, NO cron, NO
 * forever-loop). Registered with the WorkerHost's HandlerRegistry in app.ts so
 * future async signals (completed-work, architecture-change, repository/context
 * refresh) can enqueue planner runs via the existing Queue.
 *
 * The handler is IDEMPOTENT — the planner is convergent (the existing
 * UNIQUE(architecture_version_id, work_item_id) DB constraint fences concurrent
 * / redelivered runs → no duplicate Work Items). The redeliveryPolicy
 * (maxAttempts: 3) is therefore safe: a transient failure (e.g. a DB blip
 * during evaluate) produces another DURABLE attempt without a process restart;
 * the boot outbox-relay sweep is the restart-time backstop.
 *
 * The PlanningContext (runtime authority handles) is NOT serializable — the
 * handler RE-RESOLVES it from the payload's projectId at processing time (the
 * handler is constructed in app.ts with the authority handles). The handler
 * resolves the project (→ organizationId), verifies the architecture version
 * belongs to the project (server-side ownership — a UUID is NEVER a credential),
 * builds the PlanningContext, and delegates to the planner service.
 *
 * SECURITY: the payload carries NO credentials / tokens. The handler does NOT
 * reverse WORK-038 redaction (it passes signals through verbatim). It NEVER
 * mutates workflow / verification / review / execution state.
 */
import type {
  JobHandler,
  JobRecord,
  Logger,
} from '@platform/index.js';
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
  PlanningEvaluateJobPayload,
} from '../development-planner.types.js';
import {
  PLANNING_EVALUATE_JOB_TYPE,
  PLANNING_EVALUATE_REDELIVERY_POLICY,
} from '../development-planner.types.js';

/**
 * The authority handles the job handler needs to RE-RESOLVE the PlanningContext
 * at processing time. The handler is constructed once in app.ts (the handles
 * are stable for the process lifetime); each job re-resolves the project +
 * version from the payload.
 */
export interface PlanningEvaluateJobHandlerDeps {
  readonly plannerService: DevelopmentPlannerService;
  readonly projectRepository: ProjectRepository;
  readonly workItemRepository: WorkItemRepository;
  readonly workItemDependencyRepository: WorkItemDependencyRepository;
  readonly architectureVersionRepository: ArchitectureVersionRepository;
  readonly architectureRepository: ArchitectureRepository;
  readonly requirementRepository: RequirementRepository;
  readonly acceptanceCriterionRepository: AcceptanceCriterionRepository;
  readonly logger: Logger;
}

export class PlanningEvaluateJobHandler implements JobHandler {
  readonly type = PLANNING_EVALUATE_JOB_TYPE;
  readonly redeliveryPolicy = PLANNING_EVALUATE_REDELIVERY_POLICY;

  constructor(private readonly deps: PlanningEvaluateJobHandlerDeps) {}

  async handle(job: JobRecord): Promise<void> {
    const payload = job.payload as PlanningEvaluateJobPayload;
    if (!payload || !payload.projectId || !payload.architectureVersionId) {
      // Malformed payload — record honestly + do NOT redeliver (the data is
      // structurally invalid; redelivery cannot fix it). The WorkerHost acks.
      this.deps.logger.error('development-planner.job.malformed-payload', {
        jobId: job.id,
      });
      return;
    }
    // Resolve the project (→ organizationId) for tenant scoping.
    const project = await this.deps.projectRepository.findById(
      payload.projectId,
    );
    if (!project) {
      // The project no longer exists — record honestly + do NOT redeliver.
      this.deps.logger.error('development-planner.job.project-not-found', {
        jobId: job.id,
        projectId: payload.projectId,
      });
      return;
    }
    // Defense in depth: the payload's organizationId must match the resolved
    // project's organizationId (a UUID is NEVER a credential; the planner
    // operates in the project's tenant, not a payload-asserted tenant).
    if (project.organizationId !== payload.organizationId) {
      this.deps.logger.error(
        'development-planner.job.organization-mismatch',
        {
          jobId: job.id,
          projectId: payload.projectId,
          payloadOrganizationId: payload.organizationId,
          resolvedOrganizationId: project.organizationId,
        },
      );
      return;
    }
    const ctx: PlanningContext = {
      organizationId: project.organizationId,
      projectId: project.id,
      workItemRepository: this.deps.workItemRepository,
      workItemDependencyRepository: this.deps.workItemDependencyRepository,
      architectureVersionRepository: this.deps.architectureVersionRepository,
      architectureRepository: this.deps.architectureRepository,
      requirementRepository: this.deps.requirementRepository,
      acceptanceCriterionRepository: this.deps.acceptanceCriterionRepository,
      logger: this.deps.logger,
    };
    // Delegate to the planner service — IDEMPOTENT (convergent via the DB
    // constraint). On a transient failure, throwing here lets the WorkerHost
    // redeliver per the redeliveryPolicy (maxAttempts: 3).
    const result = await this.deps.plannerService.evaluate(
      {
        projectId: payload.projectId,
        architectureVersionId: payload.architectureVersionId,
        signals: payload.signals,
        baselineCommitSha: payload.baselineCommitSha,
        idempotencyKey: payload.idempotencyKey,
      },
      ctx,
    );
    this.deps.logger.info('development-planner.job.completed', {
      jobId: job.id,
      projectId: payload.projectId,
      architectureVersionId: payload.architectureVersionId,
      createdCount: result.createdCount,
      alreadyExistsCount: result.alreadyExistsCount,
      failedCount: result.failedCount,
    });
  }
}
