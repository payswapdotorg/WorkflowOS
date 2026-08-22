/**
 * Work Items domain types (WORK-001..003, WORK-AC-01..04, DEP-AC-01..03, WO-AC-01/02).
 *
 * The /work-items module owns Work Item + Work Order domain authority. It does
 * NOT own workflow state (later /workflows), verification semantics (later
 * /verification), or GitHub integration (later /github).
 *
 * Traceability chain (WORK-AC-01):
 *   Work Item → ArchitectureVersion → Architecture → Project → Organization
 */

// --- Work Item ---

export interface WorkItem {
  readonly id: string;
  readonly architectureVersionId: string;
  readonly workItemId: string;
  readonly title: string;
  readonly objective: string | null;
  readonly scope: string | null;
  readonly outOfScope: string | null;
  readonly architectureConstraints: string | null;
  readonly assignee: string | null;
  readonly executionMetadata: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateWorkItemInput {
  architectureVersionId: string;
  workItemId: string;
  title: string;
  objective?: string;
  scope?: string;
  outOfScope?: string;
  architectureConstraints?: string;
  assignee?: string;
  executionMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UpdateWorkItemInput {
  title?: string;
  objective?: string;
  scope?: string;
  outOfScope?: string;
  architectureConstraints?: string;
  assignee?: string;
  executionMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface WorkItemRepository {
  create(input: CreateWorkItemInput): Promise<WorkItem>;
  findById(id: string): Promise<WorkItem | null>;
  findByArchitectureVersion(architectureVersionId: string): Promise<WorkItem[]>;
  update(id: string, input: UpdateWorkItemInput): Promise<WorkItem | null>;
}

// --- Work Item ↔ Requirement associations ---

export interface WorkItemRequirementAssociation {
  readonly id: string;
  readonly workItemId: string;
  readonly requirementId: string;
  readonly createdAt: Date;
}

export interface WorkItemRequirementRepository {
  associate(workItemId: string, requirementId: string): Promise<WorkItemRequirementAssociation>;
  listForWorkItem(workItemId: string): Promise<WorkItemRequirementAssociation[]>;
  remove(id: string): Promise<void>;
}

// --- Work Item ↔ Acceptance Criterion associations ---

export interface WorkItemCriterionAssociation {
  readonly id: string;
  readonly workItemId: string;
  readonly criterionId: string;
  readonly createdAt: Date;
}

export interface WorkItemCriterionRepository {
  associate(workItemId: string, criterionId: string): Promise<WorkItemCriterionAssociation>;
  listForWorkItem(workItemId: string): Promise<WorkItemCriterionAssociation[]>;
  remove(id: string): Promise<void>;
}

// --- Work Item dependencies (DEP-AC-01..03) ---

export interface WorkItemDependency {
  readonly id: string;
  readonly workItemId: string;
  readonly dependsOnId: string;
  readonly createdAt: Date;
}

export interface WorkItemDependencyRepository {
  add(workItemId: string, dependsOnId: string): Promise<WorkItemDependency>;
  listForWorkItem(workItemId: string): Promise<WorkItemDependency[]>;
  remove(id: string): Promise<void>;
  /** Check if adding A→B would create a cycle (direct or indirect). */
  wouldCreateCycle(workItemId: string, dependsOnId: string): Promise<boolean>;
  /** List all transitive dependencies of a work item (for eligibility). */
  listTransitiveDependencies(workItemId: string): Promise<string[]>;
}

// --- Pull Request associations (WORK-AC-02..04) ---

export type PrAssociationStatus = 'active' | 'superseded' | 'closed' | 'merged';

export interface PullRequestAssociation {
  readonly id: string;
  readonly workItemId: string;
  readonly externalPrId: string;
  readonly provider: string;
  readonly repositoryRef: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly headCommit: string | null;
  readonly status: PrAssociationStatus;
  readonly createdAt: Date;
  readonly supersededAt: Date | null;
}

export interface CreatePrAssociationInput {
  workItemId: string;
  externalPrId: string;
  provider?: string;
  repositoryRef?: string;
  branch?: string;
  baseBranch?: string;
  headCommit?: string;
}

export interface PullRequestAssociationRepository {
  create(input: CreatePrAssociationInput): Promise<PullRequestAssociation>;
  findById(id: string): Promise<PullRequestAssociation | null>;
  listForWorkItem(workItemId: string): Promise<PullRequestAssociation[]>;
  /** Supersede the currently-active PR for a work item (sets it to 'superseded'). */
  supersedeActive(workItemId: string): Promise<void>;
  /** Get the active PR for a work item (or null). */
  findActiveForWorkItem(workItemId: string): Promise<PullRequestAssociation | null>;
}

// --- Work Orders (WO-AC-01/02) ---

export type WorkOrderState = 'draft' | 'generated' | 'consumed';

export interface WorkOrder {
  readonly id: string;
  readonly workItemId: string;
  readonly projectId: string;
  readonly architectureVersionId: string;
  readonly requirementIds: string[];
  readonly criterionIds: string[];
  readonly architectureConstraints: string | null;
  readonly implementationContext: Record<string, unknown>;
  readonly scope: string | null;
  readonly outOfScope: string | null;
  readonly verificationRequirements: unknown[];
  readonly state: WorkOrderState;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateWorkOrderInput {
  workItemId: string;
  projectId: string;
  architectureVersionId: string;
  requirementIds?: string[];
  criterionIds?: string[];
  architectureConstraints?: string;
  implementationContext?: Record<string, unknown>;
  scope?: string;
  outOfScope?: string;
  verificationRequirements?: unknown[];
}

export interface WorkOrderRepository {
  create(input: CreateWorkOrderInput): Promise<WorkOrder>;
  findById(id: string): Promise<WorkOrder | null>;
  listForWorkItem(workItemId: string): Promise<WorkOrder[]>;
  updateState(id: string, state: WorkOrderState): Promise<WorkOrder | null>;
}

// --- Dependency eligibility (DEP-AC-02) ---

/**
 * The WorkItemDependencyService provides the reusable domain-level eligibility
 * contract. Later /workflows logic can call `canBeginImplementation(workItemId)`
 * to determine whether a work item's dependencies are satisfied.
 *
 * This does NOT implement the workflow state machine — it exposes the
 * dependency-eligibility contract only.
 */
export interface WorkItemDependencyService {
  /**
   * Returns true if all dependencies of the work item are satisfied (i.e.,
   * the dependency work items exist and have been completed).
   *
   * The definition of "completed" is minimal for WORK-007: a dependency is
   * satisfied if the dependency work item has no unsatisfied dependencies
   * of its own. The actual completion status will be derived by /workflows
   * + /verification in later work items.
   */
  canBeginImplementation(workItemId: string): Promise<boolean>;
  /** Returns the list of unsatisfied dependency work item ids (if any). */
  getUnsatisfiedDependencies(workItemId: string): Promise<string[]>;
}
