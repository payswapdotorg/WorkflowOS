/**
 * WORK-041: Default Maintenance service — the orchestrator that COMPOSES the
 * configured maintenance detectors + the EXISTING WORK-040 planner to decide
 * "what maintenance should be done?" + convergently create authoritative
 * maintenance Work Items THROUGH the existing planner's
 * WorkItemRepository.create.
 *
 * AUTHORITY BOUNDARY (enforced statically in static-architecture.test.ts):
 *   * The maintenance capability CREATES maintenance Work Items THROUGH the
 *     planner (the planner calls WorkItemRepository.create — the single
 *     creation path). The maintenance capability NEVER calls
 *     WorkItemRepository.create directly + NEVER calls
 *     workItemDependencyRepository.add / remove. It delegates to
 *     DevelopmentPlannerService.evaluate (the trusted-internal-producer entry
 *     point the WORK-040 round-4 boundary carved out).
 *   * The maintenance capability owns NO tables. The maintenance evidence is
 *     embedded in the authoritative Work Item's existing `metadata` JSONB
 *     (field `metadata.planner.maintenance` — the planner passes the signal's
 *     `maintenance` payload through verbatim, like `baselineCommitSha`).
 *
 * DEDUP / CONCURRENCY MODEL. The maintenance capability reuses the planner's
 * deterministic dedup. Two maintenance scans that produce the same canonical
 * goal + scope produce the same proposedWorkItemId → the same Work Item (the
 * second scan converges to `already-exists`; NO duplicate). The existing DB
 * UNIQUE(architecture_version_id, work_item_id) constraint is the hard fence.
 *
 * The maintenance capability NEVER mutates the dependency graph, NEVER mutates
 * workflow / verification / review state, NEVER starts execution, NEVER selects
 * a provider.
 */
import type {
  MaintenanceContext,
  MaintenanceDetectInput,
  MaintenanceRunInput,
  MaintenanceRunResult,
  MaintenanceService,
  MaintenanceServiceDeps,
  MaintenanceSignalSummary,
} from '../maintenance.types.js';
import type {
  PlanningContext,
  PlanningEvaluateInput,
  PlanningMetadataPayload,
  PlanningSignal,
} from '@development-planner/index.js';

export class DefaultMaintenanceService implements MaintenanceService {
  private readonly detectors: MaintenanceServiceDeps['detectors'];
  private readonly plannerService: MaintenanceServiceDeps['plannerService'];
  private readonly workItemRepository: MaintenanceServiceDeps['workItemRepository'];
  private readonly workItemDependencyRepository: MaintenanceServiceDeps['workItemDependencyRepository'];
  private readonly architectureVersionRepository: MaintenanceServiceDeps['architectureVersionRepository'];
  private readonly architectureRepository: MaintenanceServiceDeps['architectureRepository'];
  private readonly requirementRepository: MaintenanceServiceDeps['requirementRepository'];
  private readonly acceptanceCriterionRepository: MaintenanceServiceDeps['acceptanceCriterionRepository'];
  private readonly ciEvidenceRepository: MaintenanceServiceDeps['ciEvidenceRepository'];
  private readonly projectBaselineRepository: MaintenanceServiceDeps['projectBaselineRepository'];
  private readonly advisorySource: MaintenanceServiceDeps['advisorySource'];
  private readonly logger: MaintenanceServiceDeps['logger'];

  constructor(deps: MaintenanceServiceDeps) {
    this.detectors = deps.detectors;
    this.plannerService = deps.plannerService;
    this.workItemRepository = deps.workItemRepository;
    this.workItemDependencyRepository = deps.workItemDependencyRepository;
    this.architectureVersionRepository = deps.architectureVersionRepository;
    this.architectureRepository = deps.architectureRepository;
    this.requirementRepository = deps.requirementRepository;
    this.acceptanceCriterionRepository = deps.acceptanceCriterionRepository;
    this.ciEvidenceRepository = deps.ciEvidenceRepository;
    this.projectBaselineRepository = deps.projectBaselineRepository;
    this.advisorySource = deps.advisorySource;
    this.logger = deps.logger;
  }

  /**
   * Build the PlanningContext (for the planner) from the service deps + the
   * resolved project. The planner needs the work-item / architecture /
   * requirements authority handles. The maintenance capability owns NONE of
   * these — it delegates to the planner which uses them read-only (for dedup
   * pre-check + dependency-aware explanation).
   */
  private buildPlanningContext(
    input: MaintenanceRunInput,
  ): PlanningContext {
    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      workItemRepository: this.workItemRepository,
      workItemDependencyRepository: this.workItemDependencyRepository,
      architectureVersionRepository: this.architectureVersionRepository,
      architectureRepository: this.architectureRepository,
      requirementRepository: this.requirementRepository,
      acceptanceCriterionRepository: this.acceptanceCriterionRepository,
      logger: this.logger,
    };
  }

  /**
   * Build the MaintenanceContext (for the detectors) from the service deps +
   * the resolved project. The detectors need the CI evidence / architecture /
   * baseline / advisory-source handles (all read-only).
   */
  private buildMaintenanceContext(
    input: MaintenanceRunInput,
  ): MaintenanceContext {
    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      ciEvidenceRepository: this.ciEvidenceRepository,
      architectureVersionRepository: this.architectureVersionRepository,
      architectureRepository: this.architectureRepository,
      projectBaselineRepository: this.projectBaselineRepository,
      advisorySource: this.advisorySource,
      logger: this.logger,
    };
  }

  async detectAndEvaluate(
    input: MaintenanceRunInput,
  ): Promise<MaintenanceRunResult> {
    const planningCtx = this.buildPlanningContext(input);
    const maintenanceCtx = this.buildMaintenanceContext(input);
    const detectInput: MaintenanceDetectInput = {
      projectId: input.projectId,
      architectureVersionId: input.architectureVersionId,
      baselineId: input.baselineId,
      baselineCommitSha: input.baselineCommitSha,
    };
    // Run the configured detectors → collect their PlanningSignals. The
    // detectors are TRUSTED INTERNAL PRODUCERS — they produce full-vocabulary
    // PlanningSignals (kind, provenance, evidenceRefs, baselineCommitSha,
    // blocksCount, maintenance). The maintenance capability does NOT filter or
    // rewrite them — it passes them through to the planner verbatim.
    const allSignals: PlanningSignal[] = [];
    for (const detector of this.detectors) {
      try {
        const detected = await detector.detect(detectInput, maintenanceCtx);
        allSignals.push(...detected);
      } catch (err) {
        // A detector failure is recorded honestly — the maintenance run
        // continues with the remaining detectors (a single detector failure
        // does NOT abort the whole run; the planner still receives the
        // successfully-detected signals).
        this.logger.error('maintenance.detector-failed', {
          detector: detector.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const detectedSignalCount = allSignals.length;
    // Delegate to the EXISTING planner (the trusted-internal-producer entry
    // point). The planner's prioritizer turns each signal into a candidate;
    // the planner's orchestrator dedups + creates authoritative Work Items
    // through the existing WorkItemRepository.create. Convergent (the DB
    // constraint fences concurrent runs).
    const plannerInput: PlanningEvaluateInput = {
      projectId: input.projectId,
      architectureVersionId: input.architectureVersionId,
      signals: allSignals,
      baselineCommitSha: input.baselineCommitSha,
      idempotencyKey: input.idempotencyKey,
    };
    const plannerResult = await this.plannerService.evaluate(
      plannerInput,
      planningCtx,
    );
    return {
      ...plannerResult,
      detectedSignalCount,
    };
  }

  async listMaintenanceSignals(
    architectureVersionId: string,
    ctx: MaintenanceContext,
  ): Promise<readonly MaintenanceSignalSummary[]> {
    // READ-ONLY — never creates / mutates. List maintenance-originated Work
    // Items (those whose metadata.planner.maintenance exists). The route has
    // already verified the version belongs to ctx.projectId; the orchestrator
    // re-asserts it (defense in depth — a UUID is NEVER a credential).
    const version =
      await ctx.architectureVersionRepository.findById(architectureVersionId);
    if (!version) {
      throw new Error('maintenance-architecture-version-not-found');
    }
    const arch = await ctx.architectureRepository.findById(version.architectureId);
    if (!arch || arch.projectId !== ctx.projectId) {
      throw new Error('maintenance-architecture-version-not-in-project');
    }
    const items =
      await this.workItemRepository.findByArchitectureVersion(architectureVersionId);
    const summaries: MaintenanceSignalSummary[] = [];
    for (const wi of items) {
      const planner = (wi.metadata as { planner?: PlanningMetadataPayload })
        ?.planner;
      if (!planner) continue; // a manually-created Work Item (no planner evidence)
      if (!planner.maintenance) continue; // not a maintenance-originated Work Item
      summaries.push({
        workItemId: wi.id,
        workItemHumanId: wi.workItemId,
        title: wi.title,
        objective: wi.objective,
        scope: wi.scope,
        completed: wi.completed,
        planner,
        maintenance: planner.maintenance,
        createdAt: wi.createdAt,
        updatedAt: wi.updatedAt,
      });
    }
    return summaries;
  }
}
