/**
 * WORK-041: Durable `maintenance.run` job handler — reuses the EXISTING
 * platform Queue + WorkerHost (NO new scheduler, NO setInterval, NO cron, NO
 * forever-loop). Registered with the WorkerHost's HandlerRegistry in app.ts so
 * async maintenance scans can enqueue detector runs via the existing Queue.
 *
 * The handler is IDEMPOTENT — the planner is convergent (the existing
 * UNIQUE(architecture_version_id, work_item_id) DB constraint fences concurrent
 * / redelivered runs → no duplicate Work Items). The redeliveryPolicy
 * (maxAttempts: 3) is therefore safe: a transient failure (e.g. a DB blip
 * during a detector or the planner evaluate) produces another DURABLE attempt
 * without a process restart; the boot outbox-relay sweep is the restart-time
 * backstop.
 *
 * The MaintenanceContext + PlanningContext (runtime authority handles) are NOT
 * serializable — the handler delegates to MaintenanceService.detectAndEvaluate
 * which builds both contexts from the service deps + the payload's
 * projectId/organizationId. The handler re-resolves the project (→ orgId) +
 * verifies it (defense in depth — a UUID is NEVER a credential) before
 * delegating.
 *
 * SECURITY: the payload carries NO credentials / tokens. The handler does NOT
 * reverse WORK-038 redaction (it passes signals through verbatim). It NEVER
 * mutates workflow / verification / review / execution state. The detectors
 * read authoritative source facts read-only (CI evidence, architecture digests,
 * baseline observations, advisory records).
 */
import type {
  JobHandler,
  JobRecord,
  Logger,
} from '@platform/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { MaintenanceService } from '../maintenance.types.js';
import type { MaintenanceRunJobPayload } from '../maintenance.types.js';
import {
  MAINTENANCE_RUN_JOB_TYPE,
  MAINTENANCE_RUN_REDELIVERY_POLICY,
} from '../maintenance.types.js';

/**
 * The authority handles the job handler needs to RE-RESOLVE the project +
 * delegate to the maintenance service at processing time. The handler is
 * constructed once in app.ts; the MaintenanceService holds the stable authority
 * handles (work-item, architecture, requirements, CI-evidence, baseline,
 * advisory-source). The handler re-resolves the project from the payload +
 * verifies the organizationId (defense in depth).
 */
export interface MaintenanceRunJobHandlerDeps {
  readonly maintenanceService: MaintenanceService;
  readonly projectRepository: ProjectRepository;
  readonly logger: Logger;
}

export class MaintenanceRunJobHandler implements JobHandler {
  readonly type = MAINTENANCE_RUN_JOB_TYPE;
  readonly redeliveryPolicy = MAINTENANCE_RUN_REDELIVERY_POLICY;

  constructor(private readonly deps: MaintenanceRunJobHandlerDeps) {}

  async handle(job: JobRecord): Promise<void> {
    const payload = job.payload as MaintenanceRunJobPayload;
    if (!payload || !payload.projectId || !payload.architectureVersionId) {
      // Malformed payload — record honestly + do NOT redeliver (the data is
      // structurally invalid; redelivery cannot fix it). The WorkerHost acks.
      this.deps.logger.error('maintenance.job.malformed-payload', {
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
      this.deps.logger.error('maintenance.job.project-not-found', {
        jobId: job.id,
        projectId: payload.projectId,
      });
      return;
    }
    // Defense in depth: the payload's organizationId must match the resolved
    // project's organizationId (a UUID is NEVER a credential; the maintenance
    // run operates in the project's tenant, not a payload-asserted tenant).
    if (project.organizationId !== payload.organizationId) {
      this.deps.logger.error('maintenance.job.organization-mismatch', {
        jobId: job.id,
        projectId: payload.projectId,
        payloadOrganizationId: payload.organizationId,
        resolvedOrganizationId: project.organizationId,
      });
      return;
    }
    // Delegate to the maintenance service — IDEMPOTENT (convergent via the
    // DB constraint). On a transient failure, throwing here lets the WorkerHost
    // redeliver per the redeliveryPolicy (maxAttempts: 3).
    const result = await this.deps.maintenanceService.detectAndEvaluate({
      projectId: payload.projectId,
      organizationId: payload.organizationId,
      architectureVersionId: payload.architectureVersionId,
      baselineId: payload.baselineId,
      baselineCommitSha: payload.baselineCommitSha,
      idempotencyKey: payload.idempotencyKey,
    });
    this.deps.logger.info('maintenance.job.completed', {
      jobId: job.id,
      projectId: payload.projectId,
      architectureVersionId: payload.architectureVersionId,
      detectedSignalCount: result.detectedSignalCount,
      createdCount: result.createdCount,
      alreadyExistsCount: result.alreadyExistsCount,
      failedCount: result.failedCount,
    });
  }
}
