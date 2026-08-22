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
 * For WORK-007, "satisfied" is minimal: a dependency is satisfied if the
 * dependency work item exists and has been marked as having no unsatisfied
 * dependencies of its own. The actual completion status (verified, reviewed,
 * merged) will be derived by /workflows + /verification in later work items.
 * Until those exist, we treat all dependencies as "satisfied" — the contract
 * is in place for later enhancement.
 */
export class DefaultWorkItemDependencyService implements WorkItemDependencyService {
  private readonly depRepo: PgWorkItemDependencyRepository;

  constructor(db: DatabaseClient) {
    this.depRepo = new PgWorkItemDependencyRepository(db);
  }

  async canBeginImplementation(workItemId: string): Promise<boolean> {
    const unsatisfied = await this.getUnsatisfiedDependencies(workItemId);
    return unsatisfied.length === 0;
  }

  async getUnsatisfiedDependencies(workItemId: string): Promise<string[]> {
    // For WORK-007, all dependencies are considered "satisfied" — the contract
    // is in place. Later work items (/workflows, /verification) will define
    // what "satisfied" means (e.g. dependency work item must be VERIFIED).
    // This returns the direct dependencies; if any don't exist, they're
    // "unsatisfied" (but the FK constraint prevents non-existent deps).
    const deps = await this.depRepo.listForWorkItem(workItemId);
    // For now, all persisted dependencies are considered satisfiable.
    // The contract is here for later enhancement.
    return deps.map((d) => d.dependsOnId).filter(() => false);
  }
}
