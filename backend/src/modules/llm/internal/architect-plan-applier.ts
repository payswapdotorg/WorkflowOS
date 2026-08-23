/**
 * WORK-025: ArchitectPlanApplier — transaction-scoped plan application.
 *
 * Owned by /llm. This service applies a generated architecture plan
 * atomically within a single database transaction. It receives repository
 * FACTORIES from the composition root (not the concrete implementations
 * themselves) so it can construct transaction-scoped instances inside the
 * transaction callback.
 *
 * The route calls this service — it never constructs repositories or
 * imports internal/ modules.
 *
 * ATOMICITY CONTRACT (WORK-025 PR #28 correction):
 * The following artifacts ALL commit or ALL roll back together inside a
 * single database transaction:
 *
 *   1. Architecture
 *   2. ArchitectureVersion
 *   3. Requirements
 *   4. Acceptance Criteria
 *   5. Work Items
 *   6. Work Item ↔ Requirement associations
 *   7. Work Item ↔ Criterion associations
 *   8. Work Item dependencies
 *   9. Work Orders
 *  10. Architect Session acceptance (status: active → accepted)
 *
 * If ANY of these steps throws, the transaction rolls back: no plan
 * artifacts remain AND the session stays active. There is no code path
 * where the plan commits successfully while session acceptance fails,
 * because session acceptance is performed by a TRANSACTION-SCOPED
 * ArchitectSessionRepository constructed inside the same db.transaction
 * callback as the other repositories.
 */
import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type {
  ArchitectSessionRepository,
  ArchitectParsedPlan,
} from './conversational-architect.types.js';
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
 * Input shape for the apply endpoint. This is the SAME structured plan the
 * Architect produces (ArchitectParsedPlan) — exposed as a named type so the
 * route and the applier share a single contract. The route MUST NOT pass
 * `body as any`; it must pass `body as ArchitectPlanInput`.
 *
 * It is structurally identical to ArchitectParsedPlan (all fields optional
 * because the route validates required fields before delegating). Re-using
 * the same type means any change to the plan shape is reflected in both the
 * route and the applier without an `any` escape hatch.
 */
export type ArchitectPlanInput = ArchitectParsedPlan;

/**
 * Factory functions that create repository instances bound to a specific
 * DatabaseClient (either the root client or a transaction-scoped adapter).
 * The composition root provides these — the applier doesn't import concrete classes.
 *
 * `createArchitectSessionRepository` is included so the applier can construct
 * a TRANSACTION-SCOPED session repository inside the db.transaction callback.
 * This is the key fix for PR #28's atomicity violation: previously the
 * applier accepted the session OUTSIDE the transaction (after COMMIT), so a
 * successful plan commit could coexist with a failed session acceptance.
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
  createArchitectSessionRepository: (db: DatabaseClient) => ArchitectSessionRepository;
}

export interface ApplyPlanResult {
  architectureId: string;
  architectureVersionId: string;
  requirements: Array<{ id: string; requirementId: string }>;
  criteria: Array<{ id: string; criterionId: string; requirementId: string }>;
  workItems: Array<{ id: string; workItemId: string }>;
  workOrders: Array<{ id: string; workItemId: string }>;
  /** IDs of sessions marked accepted inside the same transaction (max 1). */
  acceptedSessionIds: string[];
}

export class ArchitectPlanApplier {
  constructor(
    private readonly db: DatabaseClient,
    /**
     * Root (non-transactional) session repository. Used ONLY to look up the
     * active session for the project BEFORE entering the transaction so we
     * can pass its id into the transaction-scoped accept step. The accept
     * itself is performed by a transaction-scoped repository.
     */
    private readonly sessionRepository: ArchitectSessionRepository,
    private readonly factories: RepositoryFactories,
    _logger: Logger,
  ) {}

  async apply(projectId: string, plan: ArchitectPlanInput): Promise<ApplyPlanResult> {
    // Look up the active session BEFORE the transaction. The lookup is a
    // read, so it doesn't need to be transactional — but the accept does.
    const session = await this.sessionRepository.findActiveByProject(projectId);

    return this.db.transaction(async (tx) => {
      const txClient = new TxDatabaseClientAdapter(tx);

      // Construct TRANSACTION-SCOPED repositories using the injected factories.
      // Every write below — including session acceptance — goes through one of
      // these transaction-bound instances. None of them can commit independently
      // of the others.
      const archRepo = this.factories.createArchitectureRepository(txClient);
      const versionRepo = this.factories.createArchitectureVersionRepository(txClient);
      const reqRepo = this.factories.createRequirementRepository(txClient);
      const critRepo = this.factories.createAcceptanceCriterionRepository(txClient);
      const wiRepo = this.factories.createWorkItemRepository(txClient);
      const wiReqRepo = this.factories.createWorkItemRequirementRepository(txClient);
      const wiCritRepo = this.factories.createWorkItemCriterionRepository(txClient);
      const woRepo = this.factories.createWorkOrderRepository(txClient);
      const depRepo = this.factories.createWorkItemDependencyRepository(txClient);
      // Transaction-scoped session repo — markAccepted() runs on the SAME
      // connection as the plan writes. If accept fails, the entire
      // transaction (including the plan artifacts) rolls back.
      const sessionRepo = this.factories.createArchitectSessionRepository(txClient);

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

      // Architect Session acceptance — INSIDE the transaction.
      // This is the key atomicity fix (PR #28): if markAccepted throws, the
      // entire transaction rolls back — including all plan artifacts above.
      // There is no path where the plan commits but the session is not accepted.
      const acceptedSessionIds: string[] = [];
      if (session) {
        await sessionRepo.markAccepted(session.id);
        acceptedSessionIds.push(session.id);
      }

      return {
        architectureId: arch.id,
        architectureVersionId: version.id,
        requirements: createdReqs,
        criteria: createdCriteria,
        workItems: createdWorkItems,
        workOrders: createdWorkOrders,
        acceptedSessionIds,
      };
    });
  }
}
