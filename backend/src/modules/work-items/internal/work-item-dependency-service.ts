import type { DatabaseClient } from '@platform/index.js';
import type { WorkItemDependencyService } from './work-item.types.js';
import { PgWorkItemDependencyRepository } from './pg-work-item-repository.js';

/**
 * Default {@link WorkItemDependencyService} (DEP-AC-02).
 *
 * Provides the reusable domain-level eligibility contract. Later /workflows
 * logic calls `canBeginImplementation(workItemId)` to determine whether a
 * work item's dependencies are satisfied.
 *
 * This does NOT implement the workflow state machine — it exposes the
 * dependency-eligibility contract only.
 *
 * Satisfaction model: a dependency is "satisfied" when the dependency work
 * item's `completed` column is `true`. This is a minimal persisted signal;
 * /workflows + /verification will later derive `completed` from verification
 * + review state, but for WORK-007 the signal is explicit and queryable.
 */
export class DefaultWorkItemDependencyService implements WorkItemDependencyService {
  private readonly depRepo: PgWorkItemDependencyRepository;
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
    this.depRepo = new PgWorkItemDependencyRepository(db);
  }

  async canBeginImplementation(workItemId: string): Promise<boolean> {
    const unsatisfied = await this.getUnsatisfiedDependencies(workItemId);
    return unsatisfied.length === 0;
  }

  async getUnsatisfiedDependencies(workItemId: string): Promise<string[]> {
    const deps = await this.depRepo.listForWorkItem(workItemId);
    if (deps.length === 0) return [];
    // Check each direct dependency's `completed` flag.
    const depIds = deps.map((d) => d.dependsOnId);
    const result = await this.db.query<{ id: string; completed: boolean }>(
      `SELECT id, completed FROM wfos_work_items WHERE id = ANY($1::uuid[])`,
      [depIds],
    );
    // Return the ids of dependencies that are NOT completed.
    return result.rows
      .filter((r) => !r.completed)
      .map((r) => r.id);
  }
}
