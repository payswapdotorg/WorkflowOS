/**
 * WORK-046 — the delegation plan service: idempotent plan creation (ONE
 * authoritative plan per (workItemId, planKey)) with fail-closed validation.
 *
 * Validation (all typed, all fail closed):
 *   - the Work Item must exist (the plan is bounded to ONE existing Work
 *     Item — the existing /work-items authority owns it);
 *   - every unit's role must resolve in the EXISTING WORK-045 catalog
 *     (resolveRole) — the (roleId, roleRevision) pair is PINNED at creation
 *     (W045-AC10: a historical role reference can never be silently
 *     reinterpreted);
 *   - at least one unit; unique unit keys; dependencies refer to units in
 *     the SAME plan; the dependency graph is ACYCLIC;
 *   - native units require a model (the existing execution path requires
 *     it).
 *
 * Idempotent create: INSERT ... ON CONFLICT (work_item_id, plan_key) DO
 * NOTHING + re-lock. A concurrent duplicate creator converges on the
 * winner's plan (W046-AC01). A pre-existing plan is returned as the
 * authoritative answer — the plan key IS the identity; a caller wanting a
 * different plan uses a different key.
 *
 * This service NEVER touches workflow state, execution records, or role
 * definitions (pinned by static invariants).
 */
import type { DatabaseClient } from '@platform/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { AgentRoleCatalogService } from '../../agent-roles/index.js';
import { DelegationError } from '../types.js';
import type {
  DelegationPlan,
  DelegationPlanInput,
} from '../types.js';
import { PgDelegationRepository, type InsertUnitInput } from './pg-delegation-repository.js';

export interface DefaultDelegationPlanServiceDeps {
  readonly db: DatabaseClient;
  readonly workItemRepository: WorkItemRepository;
  readonly roleCatalog: AgentRoleCatalogService;
}

export class DefaultDelegationPlanService {
  private readonly repo: PgDelegationRepository;

  constructor(private readonly deps: DefaultDelegationPlanServiceDeps) {
    this.repo = new PgDelegationRepository(deps.db);
  }

  async createPlan(input: DelegationPlanInput): Promise<DelegationPlan> {
    // --- fail-closed validation BEFORE any durable write -------------------
    if (!input.workItemId || !input.planKey) {
      throw new DelegationError(
        'DELEGATION_WORK_ITEM_NOT_FOUND',
        'workItemId and planKey are required',
      );
    }
    const workItem = await this.deps.workItemRepository.findById(input.workItemId);
    if (!workItem) {
      throw new DelegationError(
        'DELEGATION_WORK_ITEM_NOT_FOUND',
        `work item ${input.workItemId} does not exist — a delegation plan is bounded to ONE existing Work Item`,
      );
    }
    if (!Array.isArray(input.units) || input.units.length === 0) {
      throw new DelegationError(
        'DELEGATION_EMPTY_PLAN',
        'a delegation plan requires at least one unit',
      );
    }

    // Unique unit keys.
    const keys = new Set<string>();
    for (const unit of input.units) {
      if (!unit.unitKey || keys.has(unit.unitKey)) {
        throw new DelegationError(
          'DELEGATION_DUPLICATE_UNIT_KEY',
          `unit key '${unit.unitKey}' is empty or duplicated within the plan`,
        );
      }
      keys.add(unit.unitKey);
    }

    // Role resolution + pinning through the EXISTING WORK-045 catalog
    // (consumed, never redefined). Unknown role ⇒ typed fail-closed.
    const resolvedUnits: InsertUnitInput[] = input.units.map((unit) => {
      const resolution = this.deps.roleCatalog.resolveRole(unit.role);
      if (!resolution) {
        throw new DelegationError(
          'DELEGATION_UNKNOWN_ROLE',
          `role '${unit.role}' (unit '${unit.unitKey}') is not in the closed WORK-045 role catalog`,
        );
      }
      if (unit.mode !== 'native' && unit.mode !== 'external') {
        throw new DelegationError(
          'DELEGATION_EMPTY_PLAN',
          `unit '${unit.unitKey}' has an invalid mode '${String(unit.mode)}' (native | external)`,
        );
      }
      if (unit.mode === 'native' && !unit.model) {
        throw new DelegationError(
          'DELEGATION_NATIVE_MODEL_REQUIRED',
          `native unit '${unit.unitKey}' requires a model (the existing execution path requires it)`,
        );
      }
      if (!unit.provider) {
        throw new DelegationError(
          'DELEGATION_EMPTY_PLAN',
          `unit '${unit.unitKey}' requires a provider`,
        );
      }
      return {
        unitKey: unit.unitKey,
        // PIN the (identity, revision) — the historical reference (W045-AC10).
        roleId: resolution.role.identity,
        roleRevision: resolution.role.lifecycle.revision,
        mode: unit.mode,
        provider: unit.provider,
        model: unit.model ?? null,
        dependsOn: unit.dependsOn ?? [],
      };
    });

    // Dependencies refer to units in the SAME plan.
    for (const unit of resolvedUnits) {
      for (const dep of unit.dependsOn) {
        if (!keys.has(dep)) {
          throw new DelegationError(
            'DELEGATION_UNKNOWN_DEPENDENCY',
            `unit '${unit.unitKey}' depends on '${dep}', which is not a unit in the same plan (multi-plan dependencies are out of scope — ONE bounded plan per request)`,
          );
        }
      }
    }

    // The dependency graph must be ACYCLIC (Kahn's algorithm).
    assertAcyclic(resolvedUnits);

    // --- durable create-or-converge (ONE authoritative plan) ---------------
    return this.deps.db.transaction(async (tx) => {
      const { plan, created } = await this.repo.insertOrLockPlan(
        tx,
        input.workItemId,
        input.planKey,
      );
      if (!created) {
        // The authoritative plan already exists (a prior request or a
        // concurrent winner — the FOR UPDATE re-lock blocked until their
        // transaction committed) — CONVERGE on it (W046-AC01: the same
        // delegation request ⇒ ONE authoritative plan). Its unit set is the
        // winner's; no duplicates are inserted.
        return (await this.repo.readPlan(tx, input.workItemId, input.planKey))!;
      }
      await this.repo.insertUnits(tx, plan.id, resolvedUnits);
      // Read through the SAME transaction (the rows are uncommitted yet).
      return (await this.repo.readPlan(tx, input.workItemId, input.planKey))!;
    });
  }

  async getPlan(workItemId: string, planKey: string): Promise<DelegationPlan | null> {
    return this.repo.findPlan(workItemId, planKey);
  }

  // WORK-050: the READ side for the unified execution UX — a pure repository
  // passthrough ([] is a GENUINE empty result; no validation, no writes).
  async listPlansForWorkItem(workItemId: string): Promise<DelegationPlan[]> {
    return this.repo.listPlansForWorkItem(workItemId);
  }
}

/**
 * Fail closed on a dependency cycle with the typed error (the remaining
 * non-topologically-ordered units are included for observability).
 */
function assertAcyclic(units: readonly InsertUnitInput[]): void {
  // indegree over unit keys
  const indegree = new Map<string, number>();
  for (const u of units) indegree.set(u.unitKey, 0);
  for (const u of units) {
    for (const _dep of u.dependsOn) {
      indegree.set(u.unitKey, (indegree.get(u.unitKey) ?? 0) + 1);
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    for (const u of units) {
      if (u.dependsOn.includes(key)) {
        const next = (indegree.get(u.unitKey) ?? 0) - 1;
        indegree.set(u.unitKey, next);
        if (next === 0) queue.push(u.unitKey);
      }
    }
  }
  if (order.length !== units.length) {
    const cycle = units
      .filter((u) => (indegree.get(u.unitKey) ?? 0) > 0)
      .map((u) => u.unitKey);
    throw new DelegationError(
      'DELEGATION_DEPENDENCY_CYCLE',
      `the dependency graph contains a cycle among units [${cycle.join(', ')}] — sequencing must be a DAG`,
    );
  }
}
