/**
 * work-items module — public interface.
 *
 * Canonical name: /work-items
 * Responsibility (spec/architecture.md): Work Items, Work Item Dependencies, Work Order state.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-007: implements the authoritative /work-items domain (WORK-001..003).
 * Owns Work Item + Work Item dependencies + Work Item↔Requirement/Criterion
 * associations + PR associations + Work Order + Work Order state. Does NOT
 * own workflow state (later /workflows) or verification semantics (later
 * /verification).
 *
 * Traceability chain:
 *   Work Item → ArchitectureVersion → Architecture → Project → Organization
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  WorkItem,
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItemRepository,
  WorkItemRequirementAssociation,
  WorkItemRequirementRepository,
  WorkItemCriterionAssociation,
  WorkItemCriterionRepository,
  WorkItemDependency,
  WorkItemDependencyRepository,
  PullRequestAssociation,
  CreatePrAssociationInput,
  PrAssociationStatus,
  PullRequestAssociationRepository,
  WorkOrder,
  CreateWorkOrderInput,
  WorkOrderState,
  WorkOrderRepository,
  WorkItemDependencyService,
  WorkItemCompletionService,
} from './internal/work-item.types.js';
// WORK-026: ImplementationContext — persisted snapshot consumed by the
// autonomous-implementation entry point (POST /work-items/:workItemId/start-implementation).
export type {
  ImplementationContext,
  ImplementationContextContent,
  ImplementationContextRepository,
  ImplementationContextBuilder,
} from './internal/implementation-context.types.js';

/**
 * Public capabilities exposed by the /work-items module to other modules.
 */
export interface WorkItemsModuleApi {
  // future: additional work-item-domain methods consumed by other modules
}

/**
 * Frozen module contract for /work-items.
 */
export const workItemsModule: ModuleContract & WorkItemsModuleApi = {
  name: '/work-items',
};

export default workItemsModule;
