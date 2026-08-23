/**
 * WORK-025: ArchitectPlanApplier — transaction-scoped plan application.
 *
 * Owned by /llm. This service applies a generated architecture plan
 * atomically within a single database transaction. It receives
 * repository FACTORIES from the composition root (not the concrete
 * implementations themselves) so it can construct transaction-scoped
 * instances inside the transaction callback.
 *
 * The route calls this service — it never constructs repositories or
 * imports internal/ modules.
 */
import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { ArchitectSessionRepository, ArchitectParsedPlan } from './conversational-architect.types.js';
import { TxDatabaseClientAdapter } from '@platform/index.js';

// Repository interfaces (not concrete impls) — injected by app.ts.
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { RequirementRepository, AcceptanceCriterionRepository } from '@modules/requirements/index.js';
import type {
  WorkItemRepository,
  WorkOrderRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
  WorkItemDependencyRepository,
} from '@modules/work-items/index.js';

/**
 * Factory functions that create repository instances bound to a specific
 * DatabaseClient (either the root client or a transaction-scoped adapter).
 * The composition root provides these — the applier doesn't import concrete classes.
 */
export interface RepositoryFactories {
  createArchitectureRepository: (db: DatabaseClient) => ArchitectureRepository;
  createArchitectureVersionRepository: (db: DatabaseClient) => ArchitectureVersionRepository;
  createRequirementRepository: (db: DatabaseClient) => RequirementRepository;
  createAcceptanceCriterionRepository: (db: DatabaseClient) => AcceptanceCriterionRepository;
  createWorkItemRepository: (db: DatabaseClient) => WorkItemRepository;
  createWorkItemRequirementRepository: (db: DatabaseClient) => WorkItemRequirementRepository;
  createWorkItemCriterionRepository: (db: DatabaseClient) => WorkItemCriterionRepository;
  createWorkOrderRepository: (db: DatabaseClient) => WorkOrderRepository;
  createWorkItemDependencyRepository: (db: DatabaseClient) => WorkItemDependencyRepository;
}

export interface ApplyPlanResult {
  architectureId: string;
  architectureVersionId: string;
  requirements: Array<{ id: string; requirementId: string }>;
  criteria: Array<{ id: string; criterionId: string; requirementId: string }>;
  workItems: Array<{ id: string; workItemId: string }>;
  workOrders: Array<{ id: string; workItemId: string }>;
}

export class ArchitectPlanApplier {
  constructor(
    private readonly db: DatabaseClient,
    private readonly sessionRepository: ArchitectSessionRepository,
    private readonly factories: RepositoryFactories,
    _logger: Logger,
  ) {}

  async apply(projectId: string, plan: ArchitectParsedPlan): Promise<ApplyPlanResult> {
    const result = await this.db.transaction(async (tx) => {
      const txClient = new TxDatabaseClientAdapter(tx);

      // Construct TRANSACTION-SCOPED repositories using the injected factories.
      const archRepo = this.factories.createArchitectureRepository(txClient);
      const versionRepo = this.factories.createArchitectureVersionRepository(txClient);
      const reqRepo = this.factories.createRequirementRepository(txClient);
      const critRepo = this.factories.createAcceptanceCriterionRepository(txClient);
      const wiRepo = this.factories.createWorkItemRepository(txClient);
      const wiReqRepo = this.factories.createWorkItemRequirementRepository(txClient);
      const wiCritRepo = this.factories.createWorkItemCriterionRepository(txClient);
      const woRepo = this.factories.createWorkOrderRepository(txClient);
      const depRepo = this.factories.createWorkItemDependencyRepository(txClient);

      const arch = await archRepo.create({ projectId, name: plan.architecture!.name! });
      const version = await versionRepo.create({ architectureId: arch.id, contentInline: plan.architecture!.content! });

      const createdReqs: Array<{ id: string; requirementId: string }> = [];
      const createdCriteria: Array<{ id: string; criterionId: string; requirementId: string }> = [];
      for (const req of plan.requirements ?? []) {
        const created = await reqRepo.create({ architectureVersionId: version.id, requirementId: req.requirementId, title: req.title, description: req.description ?? undefined });
        createdReqs.push({ id: created.id, requirementId: req.requirementId });
        for (const crit of req.criteria ?? []) {
          const createdCrit = await critRepo.create({ requirementId: created.id, criterionId: crit.criterionId, description: crit.description });
          createdCriteria.push({ id: createdCrit.id, criterionId: crit.criterionId, requirementId: req.requirementId });
        }
      }

      const createdWorkItems: Array<{ id: string; workItemId: string }> = [];
      for (const wi of plan.workItems ?? []) {
        const created = await wiRepo.create({ architectureVersionId: version.id, workItemId: wi.workItemId, title: wi.title, objective: wi.objective, scope: wi.scope });
        createdWorkItems.push({ id: created.id, workItemId: wi.workItemId });
      }

      for (const wi of plan.workItems ?? []) {
        const workItem = createdWorkItems.find(c => c.workItemId === wi.workItemId);
        if (!workItem) continue;
        for (const reqId of wi.requirementIds ?? []) {
          const req = createdReqs.find(r => r.requirementId === reqId);
          if (req) await wiReqRepo.associate(workItem.id, req.id);
        }
        for (const critId of wi.criterionIds ?? []) {
          const crit = createdCriteria.find(c => c.criterionId === critId);
          if (crit) await wiCritRepo.associate(workItem.id, crit.id);
        }
      }

      for (const wi of plan.workItems ?? []) {
        if (!wi.dependencies) continue;
        const source = createdWorkItems.find(c => c.workItemId === wi.workItemId);
        if (!source) continue;
        for (const depId of wi.dependencies) {
          const target = createdWorkItems.find(c => c.workItemId === depId);
          if (target) await depRepo.add(source.id, target.id);
        }
      }

      const createdWorkOrders: Array<{ id: string; workItemId: string }> = [];
      for (const wi of createdWorkItems) {
        const wiInput = plan.workItems?.find(b => b.workItemId === wi.workItemId);
        const wo = await woRepo.create({
          workItemId: wi.id, projectId, architectureVersionId: version.id, scope: wiInput?.objective,
          requirementIds: wiInput?.requirementIds?.map(rid => createdReqs.find(r => r.requirementId === rid)?.id).filter((id): id is string => !!id),
          criterionIds: wiInput?.criterionIds?.map(cid => createdCriteria.find(c => c.criterionId === cid)?.id).filter((id): id is string => !!id),
        });
        createdWorkOrders.push({ id: wo.id, workItemId: wi.workItemId });
      }

      return { architectureId: arch.id, architectureVersionId: version.id, requirements: createdReqs, criteria: createdCriteria, workItems: createdWorkItems, workOrders: createdWorkOrders };
    });

    // Only mark session accepted AFTER the transaction commits.
    const session = await this.sessionRepository.findActiveByProject(projectId);
    if (session) await this.sessionRepository.markAccepted(session.id);

    return result;
  }
}
