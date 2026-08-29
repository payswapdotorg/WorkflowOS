/**
 * WORK-046 — the delegation coordinator: dispatch, observe, retry, interrupt.
 *
 * COORDINATION, NOT AUTHORITY. The coordinator owns the sequencing of
 * delegated units and NOTHING else:
 *
 *   - every delegated execution is submitted through the EXISTING
 *     ExecutionService.submit() on a task built by the EXISTING
 *     ExecutionTaskService for the SAME Work Item (exactly one submit call
 *     site — pinned by static invariants);
 *   - attempt outcomes are OBSERVED from the EXISTING execution record (the
 *     outcome authority) — the coordinator never derives outcomes from its
 *     own engine and never writes execution/agent-run/session rows;
 *   - the coordinator never mutates workflow state (there is NO hidden
 *     lifecycle here — pinned by static invariants) and never drives itself
 *     (no scheduler: every drive is an explicit call, W046-AC12).
 *
 * THE CRASH-SAFE DISPATCH PROTOCOL (one attempt = ONE delegated execution):
 *
 *   1. DURABLE INTENT FIRST: inside one transaction (the unit row locked
 *      FOR UPDATE — concurrent dispatchers of the same unit serialize),
 *      allocate the attempt (attempt_no = attempt_count + 1), generate the
 *      execution identity, INSERT the attempt row, and CAS the unit
 *      'pending' → 'dispatched'. A crash after this transaction leaves the
 *      durable intent; nothing was submitted yet.
 *   2. SUBMIT through the existing authority: build the task
 *      (ExecutionTaskService.build — the SAME Work Item), attach the
 *      deterministic dispatch idempotency key
 *      `delegation-unit-<unitId>-attempt-<n>` (the provider-operation
 *      exactly-once boundary — PR #46 rounds 7/8), and submit.
 *   3. RECORD the observed outcome on the attempt + unit (guarded CAS).
 *
 * THE RE-DRIVE CONVERGENCE (a crashed dispatch, re-driven):
 *
 *   - attempt row exists, outcome NULL → observe the EXISTING execution
 *     record by its identity:
 *       • record ABSENT  — the crashed drive never created it → re-submit
 *         with the SAME identity + key (safe: nothing happened; the record
 *         creation is the first durable step of submit);
 *       • record terminal — record the mapped outcome (converged);
 *       • record in flight ('running' | 'handoff_ready' | 'submitted') —
 *         leave the unit 'dispatched' (the existing execution flow owns the
 *         outcome; the coordinator converges it on a later drive);
 *       • record limbo ('created' | 'queued') — consult the EXISTING native
 *         operation ledger (agentRuns by execution identity): a terminal run
 *         maps its outcome; an in-progress run is in flight; NO run means no
 *         provider side effect happened → the attempt is 'unresolved' (SAFE
 *         TO RETRY — a new attempt cannot duplicate work). For external
 *         limbo the same reasoning applies: a limbo record never handed
 *         anything off (the package generation is synchronous in submit) →
 *         'unresolved'.
 *
 * RETRY (W046-AC05): retrying a 'failed'/'unresolved' unit allocates a NEW
 * attempt (a NEW execution identity + key); the unit identity and its PINNED
 * role assignment stay stable.
 *
 * INTERRUPTION (W046-AC08): the plan becomes 'abandoned'; PENDING units
 * become 'cancelled'; in-flight executions are NOT touched (delegation never
 * cancels an execution — that belongs to the execution authority).
 */
import type { DatabaseClient, Logger } from '@platform/index.js';
import { generateExecutionId } from '@platform/ids.js';
import type {
  AgentRunRepository,
  ExecutionRecordRepository,
  ExecutionService,
} from '@modules/agents/index.js';
import type { ExecutionTaskService } from '@modules/work-items/index.js';
import type {
  DelegationCoordinator,
  DelegationDriveResult,
  DelegationPlan,
  DelegationUnit,
  DelegationUnitDriveResult,
  DelegationUnitStatus,
} from '../types.js';
import { DelegationError } from '../types.js';
import { PgDelegationRepository } from './pg-delegation-repository.js';

export interface DefaultDelegationCoordinatorDeps {
  readonly db: DatabaseClient;
  readonly executionTaskService: ExecutionTaskService;
  readonly executionService: ExecutionService;
  readonly executionRecordRepository: ExecutionRecordRepository;
  readonly agentRunRepository: AgentRunRepository;
  readonly logger: Logger;
}

/**
 * The outcome of observing (or submitting) one attempt, mapped from the
 * EXISTING execution authority — never derived from delegation-internal
 * state:
 *
 *   terminal    — the existing execution record (or its native operation
 *                 ledger run) reached a terminal state
 *   in-flight   — the existing execution flow owns the ongoing outcome
 *   unresolved  — outcome undeterminable AND no provider side effect
 *                 provably happened (SAFE to retry)
 */
type ObservedOutcome =
  | { kind: 'terminal'; outcome: 'succeeded' | 'failed' }
  | { kind: 'in-flight' }
  | { kind: 'unresolved' };

export class DefaultDelegationCoordinator implements DelegationCoordinator {
  private readonly repo: PgDelegationRepository;

  constructor(private readonly deps: DefaultDelegationCoordinatorDeps) {
    this.repo = new PgDelegationRepository(deps.db);
  }

  async drivePlan(workItemId: string, planKey: string): Promise<DelegationDriveResult> {
    const plan = await this.requirePlan(workItemId, planKey);
    if (plan.status === 'abandoned') {
      // Interruption is durable — an abandoned plan no longer coordinates.
      return {
        planId: plan.id,
        planStatus: plan.status,
        units: plan.units.map((u) => driveResultFromUnit(u, null, 'skipped')),
      };
    }

    const byKey = new Map(plan.units.map((u) => [u.unitKey, u]));
    const results: DelegationUnitDriveResult[] = [];
    for (const unit of plan.units) {
      if (unit.status === 'pending') {
        // Sequencing (coordination only): dispatch when ALL dependencies
        // succeeded. A failed dependency does NOT fail dependents — they
        // stay pending until the dependency is retried to success (partial
        // completion is recoverable, W046-AC08).
        const ready = unit.dependsOn.every((dep) => byKey.get(dep)?.status === 'succeeded');
        if (!ready) {
          results.push(driveResultFromUnit(unit, null, 'skipped'));
          continue;
        }
        results.push(await this.dispatchUnit(unit));
        continue;
      }
      if (unit.status === 'dispatched' || unit.status === 'unresolved') {
        // The crash-recovery re-drive: observe-or-resubmit until converged.
        // An 'unresolved' unit's last attempt provably caused NO provider
        // side effect — re-submitting with the SAME identity + key is safe
        // (nothing happened; the record creation is submit's first durable
        // step), so the re-drive converges it without a new attempt.
        results.push(await this.redriveInFlightUnit(unit));
        continue;
      }
      // succeeded | failed | unresolved | cancelled — nothing to drive.
      results.push(driveResultFromUnit(unit, null, 'skipped'));
    }
    // The sequencing map may be stale after the drives (a unit converged to
    // succeeded this drive); re-read for the completion check.
    const refreshed = (await this.repo.findPlan(workItemId, planKey)) ?? plan;

    // Plan completion (coordination data only): every unit succeeded.
    if (
      refreshed.status === 'active' &&
      refreshed.units.length > 0 &&
      refreshed.units.every((u) => u.status === 'succeeded')
    ) {
      const completed = await this.repo.casPlanStatus(refreshed.id, 'active', 'completed');
      const finalStatus: DelegationPlan['status'] = completed ? 'completed' : 'abandoned';
      return { planId: refreshed.id, planStatus: finalStatus, units: results };
    }
    return { planId: refreshed.id, planStatus: refreshed.status, units: results };
  }

  async retryUnit(
    workItemId: string,
    planKey: string,
    unitKey: string,
  ): Promise<DelegationUnitDriveResult> {
    const plan = await this.requirePlan(workItemId, planKey);
    const unit = plan.units.find((u) => u.unitKey === unitKey);
    if (!unit) {
      throw new DelegationError(
        'DELEGATION_UNIT_NOT_FOUND',
        `unit '${unitKey}' is not part of plan '${planKey}'`,
      );
    }
    // The UNIT diagnosis first (the more precise error): a succeeded/
    // pending/cancelled unit is not retryable regardless of the plan state.
    if (unit.status !== 'failed' && unit.status !== 'unresolved') {
      throw new DelegationError(
        'DELEGATION_UNIT_NOT_RETRYABLE',
        `unit '${unitKey}' is ${unit.status} — only failed or unresolved units can be retried`,
      );
    }
    if (plan.status !== 'active') {
      throw new DelegationError(
        'DELEGATION_PLAN_NOT_ACTIVE',
        `plan '${planKey}' is ${plan.status} — only an active plan can retry units`,
      );
    }
    return this.dispatchUnit(unit);
  }

  async interruptPlan(workItemId: string, planKey: string): Promise<DelegationPlan> {
    const plan = await this.requirePlan(workItemId, planKey);
    if (plan.status === 'abandoned') {
      return plan; // idempotent
    }
    if (plan.status === 'completed') {
      // A completed plan has nothing in flight; abandoning it would only
      // rewrite history — refuse (typed) so the coordination record stays
      // honest.
      throw new DelegationError(
        'DELEGATION_PLAN_NOT_ACTIVE',
        `plan '${planKey}' is completed — a completed coordination record cannot be interrupted`,
      );
    }
    const updated = await this.repo.casPlanStatus(plan.id, 'active', 'abandoned');
    if (!updated) {
      // A concurrent driver changed the state first — return the truth.
      const reread = await this.repo.findPlan(workItemId, planKey);
      return reread ?? plan;
    }
    // Cancel PENDING units. In-flight executions are NOT touched — their
    // outcomes remain owned by the EXISTING execution authority.
    await this.repo.cancelPendingUnits(plan.id);
    const reread = await this.repo.findPlan(workItemId, planKey);
    return reread ?? plan;
  }

  // -------------------------------------------------------------------------
  // The dispatch protocol
  // -------------------------------------------------------------------------

  /**
   * Dispatch a unit (allocate the durable attempt + submit through the
   * EXISTING execution authority + record the observed outcome). The unit
   * row lock serializes concurrent dispatchers; a loser converges on the
   * winner's state.
   */
  private async dispatchUnit(unit: DelegationUnit): Promise<DelegationUnitDriveResult> {
    // (1) DURABLE INTENT FIRST — one transaction: lock the unit row, allocate
    // the attempt (fresh execution identity), CAS → 'dispatched'.
    const allocation = await this.deps.db.transaction(async (tx) => {
      const locked = await this.repo.lockUnit(tx, unit.id);
      if (!locked) return { kind: 'vanished' as const };
      if (
        locked.status !== 'pending' &&
        locked.status !== 'failed' &&
        locked.status !== 'unresolved'
      ) {
        // A concurrent driver won — converge on the current state.
        return { kind: 'converged' as const, unit: locked };
      }
      const attemptNo = locked.attempt_count + 1;
      const executionId = generateExecutionId();
      const updated = await this.repo.allocateAttempt(tx, {
        unitId: unit.id,
        attemptNo,
        executionId,
        mode: unit.mode,
        provider: unit.provider,
        model: unit.model,
        expectedStatus: locked.status,
      });
      if (!updated) {
        // Lost the CAS — impossible under the row lock, but converge anyway.
        const reread = await this.repo.lockUnit(tx, unit.id);
        return { kind: 'converged' as const, unit: reread ?? locked };
      }
      return { kind: 'allocated' as const, executionId, attemptNo };
    });

    if (allocation.kind === 'vanished') {
      throw new DelegationError('DELEGATION_UNIT_NOT_FOUND', `unit ${unit.id} vanished`);
    }
    if (allocation.kind === 'converged') {
      return driveResultFromUnit(unitRowToUnit(allocation.unit), null, 'skipped');
    }

    // (2) SUBMIT through the EXISTING authority (outside the allocation
    // transaction — the existing ExecutionService owns its own durability).
    const observed = await this.submitAttempt(unit, allocation.executionId, allocation.attemptNo);
    return this.applyObservedOutcome(unit, allocation.executionId, observed, 'dispatched');
  }

  /**
   * Re-drive a 'dispatched' or 'unresolved' unit (the crash-recovery
   * convergence): observe the existing execution record; re-submit ONLY
   * when the record is absent (the crashed drive never created it —
   * nothing happened).
   *
   * An 'unresolved' attempt (its outcome was honestly recorded as a limbo)
   * re-enters the SAME convergence: its record may have appeared since (a
   * concurrent driver) — observe it — or may still be absent — re-submit
   * with the SAME identity + key (provably safe: no provider side effect
   * happened). The attempt row is re-used (NO new attempt is allocated).
   */
  private async redriveInFlightUnit(unit: DelegationUnit): Promise<DelegationUnitDriveResult> {
    const attempts = await this.repo.listAttemptsByUnit(unit.id);
    const current = attempts.at(-1);
    if (!current) {
      // No attempt row — the unit row's status is authoritative.
      return driveResultFromUnit(unit, null, 'converged');
    }
    if (current.outcome === 'succeeded' || current.outcome === 'failed') {
      // A terminal attempt — the unit row's status is authoritative.
      return driveResultFromUnit(unit, current.executionId, 'converged');
    }

    const record = await this.deps.executionRecordRepository.findByExecutionId(current.executionId);
    if (!record) {
      // The crashed drive never created the execution record → re-submit
      // with the SAME identity + key (safe: nothing happened).
      const observed = await this.submitAttempt(unit, current.executionId, current.attemptNo);
      if (observed.kind === 'in-flight') {
        const fresh = await this.repo.findUnitById(unit.id);
        return driveResultFromUnit(fresh ?? unit, current.executionId, 'dispatched');
      }
      return this.applyObservedOutcome(unit, current.executionId, observed, 'converged');
    }

    const observed = await this.observeExecution(record.status, current.executionId, unit.mode);
    if (observed.kind === 'in-flight') {
      const fresh = await this.repo.findUnitById(unit.id);
      return driveResultFromUnit(fresh ?? unit, current.executionId, 'in-flight');
    }
    return this.applyObservedOutcome(unit, current.executionId, observed, 'converged');
  }

  /** Submit one attempt through the EXISTING execution authority. */
  private async submitAttempt(
    unit: DelegationUnit,
    executionId: string,
    attemptNo: number,
  ): Promise<ObservedOutcome> {
    try {
      // The EXISTING task builder — the SAME Work Item, the EXISTING
      // deterministic prompt + ImplementationContext construction.
      const built = await this.deps.executionTaskService.build({
        workItemId: unit.workItemId,
        mode: unit.mode,
        provider: unit.provider,
        model: unit.model,
        executionId,
      });
      // The deterministic provider-operation idempotency key for THIS
      // logical attempt — the exactly-once side-effect boundary.
      const task = {
        ...built.task,
        dispatchIdempotencyKey: `delegation-unit-${unit.id}-attempt-${attemptNo}`,
      };
      const result = await this.deps.executionService.submit(task);
      return this.mapSubmissionStatus(result.status);
    } catch (err) {
      // A submission error is ACCEPTANCE-UNKNOWN unless the existing record
      // proves otherwise — observe the record (the outcome authority):
      // absent ⇒ nothing durable happened; terminal ⇒ converged;
      // non-terminal ⇒ in flight.
      this.deps.logger.warn('delegation.attempt.submission_error', {
        unitId: unit.id,
        executionId,
        error: (err as Error).message,
      });
      const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
      if (!record) {
        // Nothing durable happened — safely re-submittable on the next
        // drive (record absent ⇒ the same convergence path). Report the
        // honest limbo outcome.
        return { kind: 'unresolved' };
      }
      return this.observeExecution(record.status, executionId, unit.mode);
    }
  }

  /**
   * Map the EXISTING execution record's status to the delegation outcome
   * (observation ONLY — the execution record + the native operation ledger
   * are the outcome authorities).
   */
  private async observeExecution(
    recordStatus: string,
    executionId: string,
    unitMode: 'native' | 'external',
  ): Promise<ObservedOutcome> {
    if (recordStatus === 'completed') return { kind: 'terminal', outcome: 'succeeded' };
    if (recordStatus === 'failed' || recordStatus === 'cancelled' || recordStatus === 'expired') {
      return { kind: 'terminal', outcome: 'failed' };
    }
    if (
      recordStatus === 'running' ||
      recordStatus === 'handoff_ready' ||
      recordStatus === 'submitted'
    ) {
      return { kind: 'in-flight' };
    }
    // 'created' | 'queued' — the LIMBO window (a crashed submission between
    // record creation and provider dispatch). Did a provider side effect
    // provably happen?
    if (unitMode === 'native') {
      // wfos_agent_runs IS the durable native provider-operation ledger:
      // a run existing means the operation happened; NO run means nothing
      // happened (safe to retry).
      const run = await this.deps.agentRunRepository.findByExecutionId(executionId);
      if (!run) return { kind: 'unresolved' };
      if (run.status === 'success') return { kind: 'terminal', outcome: 'succeeded' };
      if (run.status === 'failed' || run.status === 'cancelled') {
        return { kind: 'terminal', outcome: 'failed' };
      }
      return { kind: 'in-flight' }; // pending | in_progress
    }
    // External limbo: the package generation is synchronous in submit — a
    // limbo record never handed anything off. Nothing was issued ⇒ safe to
    // retry.
    return { kind: 'unresolved' };
  }

  private mapSubmissionStatus(status: string): ObservedOutcome {
    if (status === 'completed') return { kind: 'terminal', outcome: 'succeeded' };
    if (status === 'failed' || status === 'cancelled' || status === 'expired') {
      return { kind: 'terminal', outcome: 'failed' };
    }
    // running | handoff_ready | submitted | created | queued — the existing
    // flow owns the outcome from here (async/handoff paths); a later drive
    // observes the terminal state.
    return { kind: 'in-flight' };
  }

  /** Record an observed outcome on the attempt + unit (guarded CAS). */
  private async applyObservedOutcome(
    unit: DelegationUnit,
    executionId: string,
    observed: ObservedOutcome,
    action: DelegationUnitDriveResult['action'],
  ): Promise<DelegationUnitDriveResult> {
    if (observed.kind === 'in-flight') {
      // The attempt was dispatched and is now in flight (the existing
      // execution flow owns the outcome): the action reports what THIS drive
      // did ('dispatched' on the first submission, 'in-flight' when a
      // re-drive merely observed). The unit row was CAS'd to 'dispatched' by
      // the allocation — read it fresh (the in-memory `unit` is pre-drive).
      const fresh = await this.repo.findUnitById(unit.id);
      return driveResultFromUnit(fresh ?? unit, executionId, action);
    }
    const outcome: 'succeeded' | 'failed' | 'unresolved' =
      observed.kind === 'terminal' ? observed.outcome : 'unresolved';
    const attempts = await this.repo.listAttemptsByUnit(unit.id);
    const current = attempts.find((a) => a.executionId === executionId);
    if (current) {
      const updated = await this.repo.recordAttemptOutcome({
        attemptId: current.id,
        outcome,
        outcomeDetail: {
          observedAt: new Date().toISOString(),
          executionId,
          attemptNo: current.attemptNo,
          mode: current.mode,
          provider: current.provider,
        },
        unitId: unit.id,
        unitStatus: outcome,
      });
      if (updated) {
        return driveResultFromUnit(unitRowToUnit(updated), executionId, action);
      }
    }
    // The fenced mutation did not fire. Two honest causes: a concurrent
    // driver recorded THIS attempt's outcome first (the status CAS lost), or
    // a retry SUPERSEDED this attempt (the attempt-generation fence in
    // recordAttemptOutcome rejected a stale result — the unit's current state
    // is owned by the newer attempt). Either way THIS attempt no longer owns
    // the unit's current state — converge on the row.
    const fresh = await this.repo.findUnitById(unit.id);
    return driveResultFromUnit(fresh ?? unit, executionId, 'converged');
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async requirePlan(workItemId: string, planKey: string): Promise<DelegationPlan> {
    const plan = await this.repo.findPlan(workItemId, planKey);
    if (!plan) {
      throw new DelegationError(
        'DELEGATION_PLAN_NOT_FOUND',
        `no delegation plan '${planKey}' exists for work item ${workItemId}`,
      );
    }
    return plan;
  }
}

// --- row mapping (internal) ---------------------------------------------------

/** A unit row as read by the repository (work_item_id joined from the plan). */
export interface DelegationUnitRow {
  id: string;
  plan_id: string;
  work_item_id: string;
  unit_key: string;
  role_id: string;
  role_revision: string;
  mode: 'native' | 'external';
  provider: string;
  model: string | null;
  depends_on: string[];
  status: DelegationUnitStatus;
  attempt_count: number;
  created_at: Date;
  updated_at: Date;
}

function unitRowToUnit(row: DelegationUnitRow): DelegationUnit {
  return {
    id: row.id,
    planId: row.plan_id,
    workItemId: row.work_item_id,
    unitKey: row.unit_key,
    role: { roleId: row.role_id as DelegationUnit['role']['roleId'], roleRevision: row.role_revision },
    mode: row.mode,
    provider: row.provider,
    model: row.model,
    dependsOn: row.depends_on,
    status: row.status,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function driveResultFromUnit(
  unit: DelegationUnit,
  executionId: string | null,
  action: DelegationUnitDriveResult['action'],
): DelegationUnitDriveResult {
  return {
    unitId: unit.id,
    unitKey: unit.unitKey,
    status: unit.status,
    executionId,
    outcome: null,
    action,
  };
}
