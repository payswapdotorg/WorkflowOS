import type { DatabaseClient } from '@platform/index.js';
import type {
  WorkItem,
  WorkItemRepository,
  WorkItemCompletionService,
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItemRequirementAssociation,
  WorkItemRequirementRepository,
  WorkItemCriterionAssociation,
  WorkItemCriterionRepository,
  WorkItemDependency,
  WorkItemDependencyRepository,
  PullRequestAssociation,
  PullRequestAssociationRepository,
  CreatePrAssociationInput,
  PrAssociationStatus,
  WorkOrder,
  WorkOrderRepository,
  CreateWorkOrderInput,
  WorkOrderState,
} from './work-item.types.js';

// ===========================================================================
// Work Item repository
// ===========================================================================

export class PgWorkItemRepository implements WorkItemRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    const result = await this.db.query<WiRow>(
      `INSERT INTO wfos_work_items
         (architecture_version_id, work_item_id, title, objective, scope,
          out_of_scope, architecture_constraints, assignee, execution_metadata, metadata,
          architecture_impact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, architecture_version_id, work_item_id, title, objective, scope,
                 out_of_scope, architecture_constraints, assignee, execution_metadata,
                 completed, metadata, architecture_impact, created_at, updated_at`,
      [
        input.architectureVersionId,
        input.workItemId,
        input.title,
        input.objective ?? null,
        input.scope ?? null,
        input.outOfScope ?? null,
        input.architectureConstraints ?? null,
        input.assignee ?? null,
        JSON.stringify(input.executionMetadata ?? {}),
        JSON.stringify(input.metadata ?? {}),
        // WORK-051 round 1 (HIGH — protected impact): the governed, monotonic
        // declaration. Deliberately absent from UpdateWorkItemInput; the
        // migration-0054 trigger rejects any weakening at the persistence
        // layer.
        input.architectureImpact ?? null,
      ],
    );
    return mapWi(result.rows[0]!);
  }

  async findById(id: string): Promise<WorkItem | null> {
    const result = await this.db.query<WiRow>(
      `SELECT id, architecture_version_id, work_item_id, title, objective, scope,
              out_of_scope, architecture_constraints, assignee, execution_metadata,
              completed, metadata, architecture_impact, created_at, updated_at
       FROM wfos_work_items WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapWi(result.rows[0]!);
  }

  async findByArchitectureVersion(architectureVersionId: string): Promise<WorkItem[]> {
    const result = await this.db.query<WiRow>(
      `SELECT id, architecture_version_id, work_item_id, title, objective, scope,
              out_of_scope, architecture_constraints, assignee, execution_metadata,
              completed, metadata, architecture_impact, created_at, updated_at
       FROM wfos_work_items WHERE architecture_version_id = $1
       ORDER BY work_item_id`,
      [architectureVersionId],
    );
    return result.rows.map(mapWi);
  }

  async update(id: string, input: UpdateWorkItemInput): Promise<WorkItem | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let pIdx = 2;
    if (input.title !== undefined) { sets.push(`title = $${pIdx++}`); params.push(input.title); }
    if (input.objective !== undefined) { sets.push(`objective = $${pIdx++}`); params.push(input.objective); }
    if (input.scope !== undefined) { sets.push(`scope = $${pIdx++}`); params.push(input.scope); }
    if (input.outOfScope !== undefined) { sets.push(`out_of_scope = $${pIdx++}`); params.push(input.outOfScope); }
    if (input.architectureConstraints !== undefined) { sets.push(`architecture_constraints = $${pIdx++}`); params.push(input.architectureConstraints); }
    if (input.assignee !== undefined) { sets.push(`assignee = $${pIdx++}`); params.push(input.assignee); }
    if (input.executionMetadata !== undefined) { sets.push(`execution_metadata = $${pIdx++}`); params.push(JSON.stringify(input.executionMetadata)); }
    if (input.metadata !== undefined) { sets.push(`metadata = $${pIdx++}`); params.push(JSON.stringify(input.metadata)); }
    // NOTE: `completed` is deliberately NOT settable through update(). Use
    // markCompleted() for the internal completion signal (architect review PR #8).
    if (sets.length === 0) return this.findById(id);
    const result = await this.db.query<WiRow>(
      `UPDATE wfos_work_items SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, architecture_version_id, work_item_id, title, objective, scope,
                 out_of_scope, architecture_constraints, assignee, execution_metadata,
                 completed, metadata, architecture_impact, created_at, updated_at`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapWi(result.rows[0]!);
  }

  async markCompleted(id: string, completed: boolean): Promise<WorkItem | null> {
    const result = await this.db.query<WiRow>(
      `UPDATE wfos_work_items SET completed = $1 WHERE id = $2
       RETURNING id, architecture_version_id, work_item_id, title, objective, scope,
                 out_of_scope, architecture_constraints, assignee, execution_metadata,
                 completed, metadata, architecture_impact, created_at, updated_at`,
      [completed, id],
    );
    if (result.rows.length === 0) return null;
    return mapWi(result.rows[0]!);
  }
}

/**
 * INTERNAL completion service (architect review PR #8). Implements
 * {@link WorkItemCompletionService} — NOT part of the public /work-items
 * barrel. Only the composition root / test harness / future /workflows
 * integration constructs this. Other domain modules cannot reach it through
 * the public `WorkItemRepository` interface.
 */
export class DefaultWorkItemCompletionService implements WorkItemCompletionService {
  constructor(private readonly repo: PgWorkItemRepository) {}

  async markCompleted(id: string, completed: boolean): Promise<WorkItem | null> {
    return this.repo.markCompleted(id, completed);
  }
}

// ===========================================================================
// Work Item ↔ Requirement associations
// ===========================================================================

export class PgWorkItemRequirementRepository implements WorkItemRequirementRepository {
  constructor(private readonly db: DatabaseClient) {}

  async associate(workItemId: string, requirementId: string): Promise<WorkItemRequirementAssociation> {
    const result = await this.db.query<AssocRow>(
      `INSERT INTO wfos_work_item_requirements (work_item_id, requirement_id)
       VALUES ($1, $2)
       ON CONFLICT (work_item_id, requirement_id) DO NOTHING
       RETURNING id, work_item_id, requirement_id, created_at`,
      [workItemId, requirementId],
    );
    if (result.rows.length === 0) {
      const existing = await this.db.query<AssocRow>(
        `SELECT id, work_item_id, requirement_id, created_at
         FROM wfos_work_item_requirements WHERE work_item_id = $1 AND requirement_id = $2`,
        [workItemId, requirementId],
      );
      return mapAssoc(existing.rows[0]!);
    }
    return mapAssoc(result.rows[0]!);
  }

  async listForWorkItem(workItemId: string): Promise<WorkItemRequirementAssociation[]> {
    const result = await this.db.query<AssocRow>(
      `SELECT id, work_item_id, requirement_id, created_at
       FROM wfos_work_item_requirements WHERE work_item_id = $1`,
      [workItemId],
    );
    return result.rows.map(mapAssoc);
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM wfos_work_item_requirements WHERE id = $1', [id]);
  }
}

// ===========================================================================
// Work Item ↔ Acceptance Criterion associations
// ===========================================================================

export class PgWorkItemCriterionRepository implements WorkItemCriterionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async associate(workItemId: string, criterionId: string): Promise<WorkItemCriterionAssociation> {
    const result = await this.db.query<CritAssocRow>(
      `INSERT INTO wfos_work_item_criteria (work_item_id, criterion_id)
       VALUES ($1, $2)
       ON CONFLICT (work_item_id, criterion_id) DO NOTHING
       RETURNING id, work_item_id, criterion_id, created_at`,
      [workItemId, criterionId],
    );
    if (result.rows.length === 0) {
      const existing = await this.db.query<CritAssocRow>(
        `SELECT id, work_item_id, criterion_id, created_at
         FROM wfos_work_item_criteria WHERE work_item_id = $1 AND criterion_id = $2`,
        [workItemId, criterionId],
      );
      return mapCritAssoc(existing.rows[0]!);
    }
    return mapCritAssoc(result.rows[0]!);
  }

  async listForWorkItem(workItemId: string): Promise<WorkItemCriterionAssociation[]> {
    const result = await this.db.query<CritAssocRow>(
      `SELECT id, work_item_id, criterion_id, created_at
       FROM wfos_work_item_criteria WHERE work_item_id = $1`,
      [workItemId],
    );
    return result.rows.map(mapCritAssoc);
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM wfos_work_item_criteria WHERE id = $1', [id]);
  }
}

// ===========================================================================
// Work Item dependencies (DEP-AC-01..03)
// ===========================================================================

export class PgWorkItemDependencyRepository implements WorkItemDependencyRepository {
  constructor(private readonly db: DatabaseClient) {}

  async add(workItemId: string, dependsOnId: string): Promise<WorkItemDependency> {
    // Check for cycles BEFORE inserting (the trigger enforces same-version).
    if (await this.wouldCreateCycle(workItemId, dependsOnId)) {
      throw new Error(`circular dependency detected: ${workItemId} → ${dependsOnId}`);
    }
    const result = await this.db.query<DepRow>(
      `INSERT INTO wfos_work_item_dependencies (work_item_id, depends_on_id)
       VALUES ($1, $2)
       ON CONFLICT (work_item_id, depends_on_id) DO NOTHING
       RETURNING id, work_item_id, depends_on_id, created_at`,
      [workItemId, dependsOnId],
    );
    if (result.rows.length === 0) {
      const existing = await this.db.query<DepRow>(
        `SELECT id, work_item_id, depends_on_id, created_at
         FROM wfos_work_item_dependencies WHERE work_item_id = $1 AND depends_on_id = $2`,
        [workItemId, dependsOnId],
      );
      return mapDep(existing.rows[0]!);
    }
    return mapDep(result.rows[0]!);
  }

  async listForWorkItem(workItemId: string): Promise<WorkItemDependency[]> {
    const result = await this.db.query<DepRow>(
      `SELECT id, work_item_id, depends_on_id, created_at
       FROM wfos_work_item_dependencies WHERE work_item_id = $1`,
      [workItemId],
    );
    return result.rows.map(mapDep);
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM wfos_work_item_dependencies WHERE id = $1', [id]);
  }

  async wouldCreateCycle(workItemId: string, dependsOnId: string): Promise<boolean> {
    if (workItemId === dependsOnId) return true;
    // Recursive CTE: walk the dependency graph from dependsOnId. If we reach
    // workItemId, adding workItemId → dependsOnId creates a cycle.
    const result = await this.db.query<{ id: string }>(
      `WITH RECURSIVE dep_chain AS (
         SELECT depends_on_id AS id FROM wfos_work_item_dependencies WHERE work_item_id = $1
         UNION
         SELECT d.depends_on_id FROM wfos_work_item_dependencies d
         JOIN dep_chain c ON d.work_item_id = c.id
       )
       SELECT $2 AS id FROM dep_chain WHERE id = $2
       UNION ALL
       SELECT $2 WHERE $2 = $1`,
      [dependsOnId, workItemId],
    );
    return result.rows.length > 0;
  }

  async listTransitiveDependencies(workItemId: string): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(
      `WITH RECURSIVE dep_chain AS (
         SELECT depends_on_id AS id FROM wfos_work_item_dependencies WHERE work_item_id = $1
         UNION
         SELECT d.depends_on_id FROM wfos_work_item_dependencies d
         JOIN dep_chain c ON d.work_item_id = c.id
       )
       SELECT id FROM dep_chain`,
      [workItemId],
    );
    return result.rows.map((r) => r.id);
  }
}

// ===========================================================================
// Pull Request associations (WORK-AC-02..04)
// ===========================================================================

export class PgPullRequestAssociationRepository implements PullRequestAssociationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreatePrAssociationInput): Promise<PullRequestAssociation> {
    return this.db.transaction(async (tx) => {
      // Supersede any existing active PR for this work item (WORK-AC-03).
      await tx.query(
        `UPDATE wfos_pull_request_associations
         SET status = 'superseded', superseded_at = NOW()
         WHERE work_item_id = $1 AND status = 'active'`,
        [input.workItemId],
      );
      const result = await tx.query<PrRow>(
        `INSERT INTO wfos_pull_request_associations
           (work_item_id, external_pr_id, provider, repository_ref, branch,
            base_branch, head_commit, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         RETURNING id, work_item_id, external_pr_id, provider, repository_ref,
                   branch, base_branch, head_commit, status, created_at, superseded_at`,
        [
          input.workItemId,
          input.externalPrId,
          input.provider ?? 'github',
          input.repositoryRef ?? null,
          input.branch ?? null,
          input.baseBranch ?? null,
          input.headCommit ?? null,
        ],
      );
      return mapPr(result.rows[0]!);
    });
  }

  async findById(id: string): Promise<PullRequestAssociation | null> {
    const result = await this.db.query<PrRow>(
      `SELECT id, work_item_id, external_pr_id, provider, repository_ref,
              branch, base_branch, head_commit, status, created_at, superseded_at
       FROM wfos_pull_request_associations WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapPr(result.rows[0]!);
  }

  async listForWorkItem(workItemId: string): Promise<PullRequestAssociation[]> {
    const result = await this.db.query<PrRow>(
      `SELECT id, work_item_id, external_pr_id, provider, repository_ref,
              branch, base_branch, head_commit, status, created_at, superseded_at
       FROM wfos_pull_request_associations WHERE work_item_id = $1
       ORDER BY created_at`,
      [workItemId],
    );
    return result.rows.map(mapPr);
  }

  async supersedeActive(workItemId: string): Promise<void> {
    await this.db.query(
      `UPDATE wfos_pull_request_associations
       SET status = 'superseded', superseded_at = NOW()
       WHERE work_item_id = $1 AND status = 'active'`,
      [workItemId],
    );
  }

  async findActiveForWorkItem(workItemId: string): Promise<PullRequestAssociation | null> {
    const result = await this.db.query<PrRow>(
      `SELECT id, work_item_id, external_pr_id, provider, repository_ref,
              branch, base_branch, head_commit, status, created_at, superseded_at
       FROM wfos_pull_request_associations WHERE work_item_id = $1 AND status = 'active'
       LIMIT 1`,
      [workItemId],
    );
    if (result.rows.length === 0) return null;
    return mapPr(result.rows[0]!);
  }
}

// ===========================================================================
// Work Orders (WO-AC-01/02)
// ===========================================================================

export class PgWorkOrderRepository implements WorkOrderRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateWorkOrderInput): Promise<WorkOrder> {
    const result = await this.db.query<WoRow>(
      `INSERT INTO wfos_work_orders
         (work_item_id, project_id, architecture_version_id, requirement_ids,
          criterion_ids, architecture_constraints, implementation_context, scope,
          out_of_scope, verification_requirements, state, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11)
       RETURNING id, work_item_id, project_id, architecture_version_id, requirement_ids,
                 criterion_ids, architecture_constraints, implementation_context, scope,
                 out_of_scope, verification_requirements, state, metadata, created_at, updated_at`,
      [
        input.workItemId,
        input.projectId,
        input.architectureVersionId,
        JSON.stringify(input.requirementIds ?? []),
        JSON.stringify(input.criterionIds ?? []),
        input.architectureConstraints ?? null,
        JSON.stringify(input.implementationContext ?? {}),
        input.scope ?? null,
        input.outOfScope ?? null,
        JSON.stringify(input.verificationRequirements ?? []),
        JSON.stringify({}),
      ],
    );
    return mapWo(result.rows[0]!);
  }

  async findById(id: string): Promise<WorkOrder | null> {
    const result = await this.db.query<WoRow>(
      `SELECT id, work_item_id, project_id, architecture_version_id, requirement_ids,
              criterion_ids, architecture_constraints, implementation_context, scope,
              out_of_scope, verification_requirements, state, metadata, created_at, updated_at
       FROM wfos_work_orders WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapWo(result.rows[0]!);
  }

  async listForWorkItem(workItemId: string): Promise<WorkOrder[]> {
    const result = await this.db.query<WoRow>(
      `SELECT id, work_item_id, project_id, architecture_version_id, requirement_ids,
              criterion_ids, architecture_constraints, implementation_context, scope,
              out_of_scope, verification_requirements, state, metadata, created_at, updated_at
       FROM wfos_work_orders WHERE work_item_id = $1 ORDER BY created_at`,
      [workItemId],
    );
    return result.rows.map(mapWo);
  }

  async updateState(id: string, state: WorkOrderState): Promise<WorkOrder | null> {
    const result = await this.db.query<WoRow>(
      `UPDATE wfos_work_orders SET state = $1 WHERE id = $2
       RETURNING id, work_item_id, project_id, architecture_version_id, requirement_ids,
                 criterion_ids, architecture_constraints, implementation_context, scope,
                 out_of_scope, verification_requirements, state, metadata, created_at, updated_at`,
      [state, id],
    );
    if (result.rows.length === 0) return null;
    return mapWo(result.rows[0]!);
  }
}

// ===========================================================================
// Row mappers
// ===========================================================================

interface WiRow {
  id: string;
  architecture_version_id: string;
  work_item_id: string;
  title: string;
  objective: string | null;
  scope: string | null;
  out_of_scope: string | null;
  architecture_constraints: string | null;
  assignee: string | null;
  execution_metadata: Record<string, unknown>;
  completed: boolean;
  metadata: Record<string, unknown>;
  architecture_impact: string | null;
  created_at: Date;
  updated_at: Date;
}
interface AssocRow {
  id: string;
  work_item_id: string;
  requirement_id: string;
  created_at: Date;
}
interface CritAssocRow {
  id: string;
  work_item_id: string;
  criterion_id: string;
  created_at: Date;
}
interface DepRow {
  id: string;
  work_item_id: string;
  depends_on_id: string;
  created_at: Date;
}
interface PrRow {
  id: string;
  work_item_id: string;
  external_pr_id: string;
  provider: string;
  repository_ref: string | null;
  branch: string | null;
  base_branch: string | null;
  head_commit: string | null;
  status: string;
  created_at: Date;
  superseded_at: Date | null;
}
interface WoRow {
  id: string;
  work_item_id: string;
  project_id: string;
  architecture_version_id: string;
  requirement_ids: string[];
  criterion_ids: string[];
  architecture_constraints: string | null;
  implementation_context: Record<string, unknown>;
  scope: string | null;
  out_of_scope: string | null;
  verification_requirements: unknown[];
  state: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function mapWi(row: WiRow): WorkItem {
  return {
    id: row.id,
    architectureVersionId: row.architecture_version_id,
    workItemId: row.work_item_id,
    title: row.title,
    objective: row.objective,
    scope: row.scope,
    outOfScope: row.out_of_scope,
    architectureConstraints: row.architecture_constraints,
    assignee: row.assignee,
    executionMetadata: row.execution_metadata ?? {},
    completed: row.completed,
    metadata: row.metadata ?? {},
    architectureImpact: (row.architecture_impact as WorkItem['architectureImpact']) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssoc(row: AssocRow): WorkItemRequirementAssociation {
  return { id: row.id, workItemId: row.work_item_id, requirementId: row.requirement_id, createdAt: row.created_at };
}

function mapCritAssoc(row: CritAssocRow): WorkItemCriterionAssociation {
  return { id: row.id, workItemId: row.work_item_id, criterionId: row.criterion_id, createdAt: row.created_at };
}

function mapDep(row: DepRow): WorkItemDependency {
  return { id: row.id, workItemId: row.work_item_id, dependsOnId: row.depends_on_id, createdAt: row.created_at };
}

function mapPr(row: PrRow): PullRequestAssociation {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    externalPrId: row.external_pr_id,
    provider: row.provider,
    repositoryRef: row.repository_ref,
    branch: row.branch,
    baseBranch: row.base_branch,
    headCommit: row.head_commit,
    status: row.status as PrAssociationStatus,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  };
}

function mapWo(row: WoRow): WorkOrder {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    projectId: row.project_id,
    architectureVersionId: row.architecture_version_id,
    requirementIds: row.requirement_ids ?? [],
    criterionIds: row.criterion_ids ?? [],
    architectureConstraints: row.architecture_constraints,
    implementationContext: row.implementation_context ?? {},
    scope: row.scope,
    outOfScope: row.out_of_scope,
    verificationRequirements: row.verification_requirements ?? [],
    state: row.state as WorkOrderState,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
