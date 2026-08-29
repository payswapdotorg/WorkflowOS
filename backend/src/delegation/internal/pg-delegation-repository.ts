/**
 * WORK-046 — the delegation coordination repository.
 *
 * Durable coordination data ONLY (migration 0057): plans, units, attempts.
 * Every identity here REFERENCES an existing authority row:
 *
 *   plan.work_item_id  → wfos_work_items (ONE Work Item — P1)
 *   attempt.execution_id → wfos_executions (the EXISTING execution identity)
 *   unit.role_*        → the WORK-045 static catalog (pinned reference)
 *
 * This repository NEVER writes workflow tables, execution records, agent
 * runs, sessions, workspaces, verification, or review rows — it is
 * structurally incapable of becoming a second authority (pinned by static
 * invariants).
 *
 * Concurrency:
 *   - create-or-converge plan: INSERT ... ON CONFLICT (work_item_id,
 *     plan_key) DO NOTHING + SELECT ... FOR UPDATE re-lock — concurrent
 *     same-key creators serialize; the loser converges on the winner's plan.
 *   - attempt allocation: SELECT unit FOR UPDATE + UNIQUE (unit_id,
 *     attempt_no) — concurrent dispatchers of one unit serialize; exactly
 *     one attempt row per logical attempt.
 *   - attempt outcome recording is ATTEMPT-FENCED: the unit-state mutation
 *     fires ONLY when the recorded attempt IS the unit's CURRENT attempt
 *     (attempt_no = attempt_count — the allocation invariant), so a late
 *     result for a SUPERSEDED attempt (a retry allocated the next one)
 *     cannot change the unit's current state. The attempt row itself still
 *     records the late outcome as history (per-attempt truth); only the
 *     unit's CURRENT state is owned by the CURRENT attempt.
 *   - status transitions are guarded CAS (UPDATE ... WHERE status = expected)
 *     — a lost CAS returns null and the caller converges on the current row.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  DelegationAttempt,
  DelegationAttemptOutcome,
  DelegationPlan,
  DelegationPlanStatus,
  DelegationUnit,
  DelegationUnitStatus,
} from '../types.js';

/** A transaction-scoped query interface (what `db.transaction(fn)` passes). */
export type DelegationTx = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
/** db or tx — anything with `query`. */
interface Queryable {
  query<R extends { [column: string]: unknown } = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}
// Narrow row types are fine as query type parameters (structural).
type PlanRowQ = PlanRow & { [column: string]: unknown };
type UnitRowQ = UnitRow & { [column: string]: unknown };

interface PlanRow {
  id: string;
  work_item_id: string;
  plan_key: string;
  status: DelegationPlanStatus;
  created_at: Date;
  updated_at: Date;
}

interface UnitRow {
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

interface AttemptRow {
  id: string;
  unit_id: string;
  attempt_no: number;
  execution_id: string;
  mode: 'native' | 'external';
  provider: string;
  model: string | null;
  outcome: DelegationAttemptOutcome | null;
  outcome_detail: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const PLAN_COLUMNS = 'id, work_item_id, plan_key, status, created_at, updated_at';
// Every unit read joins its plan's work_item_id (the ONE Work Item — the
// unit's execution path needs it, and the join keeps the public
// DelegationUnit honest without a second query).
const UNIT_SELECT = `SELECT u.id, u.plan_id, p.work_item_id, u.unit_key, u.role_id,
       u.role_revision, u.mode, u.provider, u.model, u.depends_on, u.status,
       u.attempt_count, u.created_at, u.updated_at
   FROM wfos_delegation_units u
   JOIN wfos_delegation_plans p ON p.id = u.plan_id`;
const ATTEMPT_COLUMNS =
  'id, unit_id, attempt_no, execution_id, mode, provider, model, outcome, outcome_detail, created_at, updated_at';

export interface InsertUnitInput {
  unitKey: string;
  roleId: string;
  roleRevision: string;
  mode: 'native' | 'external';
  provider: string;
  model: string | null;
  dependsOn: readonly string[];
}

export interface AllocateAttemptInput {
  unitId: string;
  attemptNo: number;
  executionId: string;
  mode: 'native' | 'external';
  provider: string;
  model: string | null;
}

export class PgDelegationRepository {
  constructor(private readonly db: DatabaseClient) {}

  // --- plans ---------------------------------------------------------------

  /**
   * Create-or-converge: insert the plan keyed by (work_item_id, plan_key)
   * with ON CONFLICT DO NOTHING, then re-read it FOR UPDATE. When the
   * conflict fired (a concurrent winner exists), the re-read returns the
   * winner's committed plan; the caller then converges (idempotent — the
   * loser does NOT insert units into a pre-existing plan).
   * Returns { plan, created }.
   */
  async insertOrLockPlan(
    tx: DelegationTx,
    workItemId: string,
    planKey: string,
  ): Promise<{ plan: PlanRow; created: boolean }> {
    const inserted = await tx.query<PlanRow>(
      `INSERT INTO wfos_delegation_plans (work_item_id, plan_key)
       VALUES ($1, $2)
       ON CONFLICT (work_item_id, plan_key) DO NOTHING
       RETURNING ${PLAN_COLUMNS}`,
      [workItemId, planKey],
    );
    if (inserted.rows.length > 0) {
      return { plan: inserted.rows[0]!, created: true };
    }
    // A plan exists (possibly just created by a concurrent winner — the
    // re-lock blocks until their transaction commits).
    const existing = await tx.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS}
       FROM wfos_delegation_plans
       WHERE work_item_id = $1 AND plan_key = $2
       FOR UPDATE`,
      [workItemId, planKey],
    );
    if (existing.rows.length === 0) {
      // Unreachable: ON CONFLICT DO NOTHING + the unique constraint guarantee
      // the row exists.
      throw new Error(
        `delegation: plan (${workItemId}, ${planKey}) vanished under lock — impossible`,
      );
    }
    return { plan: existing.rows[0]!, created: false };
  }

  async insertUnits(
    tx: DelegationTx,
    planId: string,
    units: readonly InsertUnitInput[],
  ): Promise<void> {
    // A FRESH plan (created by THIS transaction) — its unit set is empty and
    // the (plan_id, unit_key) unique constraint guarantees no duplicates.
    for (const u of units) {
      await tx.query(
        `INSERT INTO wfos_delegation_units
           (plan_id, unit_key, role_id, role_revision, mode, provider, model, depends_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [planId, u.unitKey, u.roleId, u.roleRevision, u.mode, u.provider, u.model, JSON.stringify(u.dependsOn)],
      );
    }
  }

  /** Read a full plan (plan + units) through a given query surface (db or tx). */
  async readPlan(
    q: Queryable,
    workItemId: string,
    planKey: string,
  ): Promise<DelegationPlan | null> {
    const result = await q.query<PlanRowQ>(
      `SELECT ${PLAN_COLUMNS}
       FROM wfos_delegation_plans
       WHERE work_item_id = $1 AND plan_key = $2`,
      [workItemId, planKey],
    );
    if (result.rows.length === 0) return null;
    const units = await this.readUnits(q, result.rows[0]!.id);
    return mapPlan(result.rows[0]!, units);
  }

  async findPlan(workItemId: string, planKey: string): Promise<DelegationPlan | null> {
    return this.readPlan(this.db, workItemId, planKey);
  }

  /**
   * WORK-050: list ALL delegation plans (with units) for a Work Item — the
   * READ side of the coordination data (ordered by creation, the durable
   * order; the plans of ONE work item are all parallel logical plans). A
   * work item with no plans answers [] (a GENUINE empty result). Pure read:
   * no locks, no CAS, no writes.
   */
  async listPlansForWorkItem(workItemId: string): Promise<DelegationPlan[]> {
    const plans = await this.db.query<PlanRowQ>(
      `SELECT ${PLAN_COLUMNS}
       FROM wfos_delegation_plans
       WHERE work_item_id = $1
       ORDER BY created_at, id`,
      [workItemId],
    );
    const result: DelegationPlan[] = [];
    for (const row of plans.rows) {
      const units = await this.readUnits(this.db, row.id);
      result.push(mapPlan(row, units));
    }
    return result;
  }

  private async readUnits(q: Queryable, planId: string): Promise<DelegationUnit[]> {
    const result = await q.query<UnitRowQ>(
      `${UNIT_SELECT} WHERE u.plan_id = $1 ORDER BY u.unit_key`,
      [planId],
    );
    return result.rows.map(mapUnit);
  }

  async findPlanById(planId: string): Promise<PlanRow | null> {
    const result = await this.db.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM wfos_delegation_plans WHERE id = $1`,
      [planId],
    );
    return result.rows[0] ?? null;
  }

  /** CAS the plan status; returns the updated plan row or null on a lost CAS. */
  async casPlanStatus(
    planId: string,
    from: DelegationPlanStatus,
    to: DelegationPlanStatus,
  ): Promise<PlanRow | null> {
    const result = await this.db.query<PlanRow>(
      `UPDATE wfos_delegation_plans
         SET status = $2, updated_at = NOW()
       WHERE id = $1 AND status = $3
       RETURNING ${PLAN_COLUMNS}`,
      [planId, to, from],
    );
    return result.rows[0] ?? null;
  }

  // --- units ----------------------------------------------------------------

  async listUnitsByPlan(planId: string): Promise<DelegationUnit[]> {
    return this.readUnits(this.db, planId);
  }

  /** One unit by id (joined with its plan's work_item_id), or null. */
  async findUnitById(unitId: string): Promise<DelegationUnit | null> {
    const result = await this.db.query<UnitRow>(
      `${UNIT_SELECT} WHERE u.id = $1`,
      [unitId],
    );
    return result.rows[0] ? mapUnit(result.rows[0]) : null;
  }

  /**
   * Lock one unit row FOR UPDATE inside a transaction (the dispatch
   * serialization domain: concurrent dispatchers/re-drivers of one unit
   * serialize here; exactly one attempt allocation survives).
   */
  async lockUnit(tx: DelegationTx, unitId: string): Promise<UnitRow | null> {
    const result = await tx.query<UnitRow>(
      `${UNIT_SELECT} WHERE u.id = $1 FOR UPDATE OF u`,
      [unitId],
    );
    return result.rows[0] ?? null;
  }

  async findUnitByPlanAndKey(planId: string, unitKey: string): Promise<UnitRow | null> {
    const result = await this.db.query<UnitRow>(
      `${UNIT_SELECT} WHERE u.plan_id = $1 AND u.unit_key = $2`,
      [planId, unitKey],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Allocate an attempt: under the unit row lock — bump attempt_count and
   * mark the unit 'dispatched' atomically; insert the attempt row (the
   * durable intent BEFORE submission). The UNIQUE (unit_id, attempt_no) is
   * the CAS backstop.
   */
  async allocateAttempt(
    tx: DelegationTx,
    input: AllocateAttemptInput & { expectedStatus: DelegationUnitStatus },
  ): Promise<UnitRow | null> {
    const updated = await tx.query<UnitRow>(
      `UPDATE wfos_delegation_units
         SET status = 'dispatched', attempt_count = attempt_count + 1, updated_at = NOW()
       WHERE id = $1 AND status = $2
       RETURNING id, plan_id, ''::text AS work_item_id, unit_key, role_id,
                 role_revision, mode, provider, model, depends_on, status,
                 attempt_count, created_at, updated_at`,
      [input.unitId, input.expectedStatus],
    );
    if (updated.rows.length === 0) return null; // lost CAS — the caller converges
    await tx.query(
      `INSERT INTO wfos_delegation_attempts
         (unit_id, attempt_no, execution_id, mode, provider, model)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.unitId, input.attemptNo, input.executionId, input.mode, input.provider, input.model],
    );
    // The UPDATE ... RETURNING cannot join the plan — re-read the joined row
    // through the same transaction for a complete mapping.
    const reread = await tx.query<UnitRow>(
      `${UNIT_SELECT} WHERE u.id = $1`,
      [input.unitId],
    );
    return reread.rows[0] ?? updated.rows[0]!;
  }

  /**
   * Record an attempt outcome + update the unit coordination status.
   *
   * ATTEMPT-FENCED (the retry contract): the unit-state mutation fires ONLY
   * when the recorded attempt IS the unit's CURRENT attempt — the row being
   * mutated must satisfy `a.attempt_no = u.attempt_count` for the very
   * attempt whose outcome is recorded (`a.id = $3`). A late result for a
   * SUPERSEDED attempt (a retry already allocated the next attempt —
   * `attempt_count` moved past it) is INCAPABLE of changing the unit's
   * current state: the EXISTS fence rejects it, the UPDATE matches zero
   * rows, and this method returns null (the caller converges on the current
   * row). The late outcome is still recorded on the attempt row itself —
   * per-attempt history is truthful — but the unit's current state stays
   * owned by the CURRENT attempt (and, through it, the plan-completion
   * check can only complete through current-attempt outcomes).
   *
   * Under READ COMMITTED the fenced UPDATE is also correct when it BLOCKS
   * on a concurrent retry's allocation lock: PostgreSQL re-evaluates the
   * WHERE (including the EXISTS fence) against the NEW committed row
   * version, so a unit whose current attempt just became N+1 rejects a
   * result for attempt N even in the blocked-then-reevaluated interleaving.
   */
  async recordAttemptOutcome(input: {
    attemptId: string;
    outcome: DelegationAttemptOutcome;
    outcomeDetail: Record<string, unknown>;
    unitId: string;
    unitStatus: DelegationUnitStatus;
  }): Promise<UnitRow | null> {
    return this.db.transaction(async (tx) => {
      await tx.query(
        // outcome IS NULL (in flight) OR 'unresolved' (the honest limbo — a
        // re-drive may resolve the SAME attempt once its record appears or
        // its re-submit succeeds; a terminal outcome is NEVER overwritten).
        // NOTE: this is the PER-ATTEMPT historical record — it is fenced by
        // attemptId only. The unit's CURRENT state is fenced by the
        // attempt-generation fence below.
        `UPDATE wfos_delegation_attempts
           SET outcome = $2, outcome_detail = $3::jsonb, updated_at = NOW()
         WHERE id = $1 AND (outcome IS NULL OR outcome = 'unresolved')`,
        [input.attemptId, input.outcome, JSON.stringify(input.outcomeDetail)],
      );
      // THE ATTEMPT-GENERATION FENCE: the unit mutation additionally
      // requires the recorded attempt to BE the unit's current attempt
      // (attempt_no = attempt_count — the allocation transaction bumps
      // attempt_count and inserts that very attempt_no atomically under the
      // unit row lock, so the equality holds for exactly one live attempt).
      // A result for attempt N-1 after a retry allocated attempt N matches
      // ZERO rows here — the unit stays on attempt N's state.
      const updated = await tx.query<UnitRow>(
        `UPDATE wfos_delegation_units u
           SET status = $2, updated_at = NOW()
         WHERE u.id = $1
           AND u.status IN ('dispatched', 'failed', 'unresolved')
           AND EXISTS (
             SELECT 1
               FROM wfos_delegation_attempts a
              WHERE a.id = $3
                AND a.unit_id = u.id
                AND a.attempt_no = u.attempt_count
           )
         RETURNING u.id, u.plan_id, ''::text AS work_item_id, u.unit_key, u.role_id,
                   u.role_revision, u.mode, u.provider, u.model, u.depends_on, u.status,
                   u.attempt_count, u.created_at, u.updated_at`,
        [input.unitId, input.unitStatus, input.attemptId],
      );
      if (updated.rows.length === 0) return null;
      const reread = await tx.query<UnitRow>(
        `${UNIT_SELECT} WHERE u.id = $1`,
        [input.unitId],
      );
      return reread.rows[0] ?? updated.rows[0]!;
    });
  }

  /** Cancel every PENDING unit of a plan (interruption). */
  async cancelPendingUnits(planId: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE wfos_delegation_units
         SET status = 'cancelled', updated_at = NOW()
       WHERE plan_id = $1 AND status = 'pending'`,
      [planId],
    );
    return result.rowCount ?? 0;
  }

  // --- attempts -------------------------------------------------------------

  async listAttemptsByUnit(unitId: string): Promise<DelegationAttempt[]> {
    const result = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS}
       FROM wfos_delegation_attempts
       WHERE unit_id = $1
       ORDER BY attempt_no`,
      [unitId],
    );
    return result.rows.map(mapAttempt);
  }

  async findAttemptByExecutionId(executionId: string): Promise<AttemptRow | null> {
    const result = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS}
       FROM wfos_delegation_attempts
       WHERE execution_id = $1`,
      [executionId],
    );
    return result.rows[0] ?? null;
  }

  async listAttemptsByPlan(planId: string): Promise<DelegationAttempt[]> {
    const result = await this.db.query<AttemptRow>(
      `SELECT a.id, a.unit_id, a.attempt_no, a.execution_id, a.mode, a.provider,
              a.model, a.outcome, a.outcome_detail, a.created_at, a.updated_at
       FROM wfos_delegation_attempts a
       JOIN wfos_delegation_units u ON u.id = a.unit_id
       WHERE u.plan_id = $1
       ORDER BY u.unit_key, a.attempt_no`,
      [planId],
    );
    return result.rows.map(mapAttempt);
  }
}

// --- row mappers -------------------------------------------------------------

function mapPlan(row: PlanRow, units: readonly DelegationUnit[]): DelegationPlan {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    planKey: row.plan_key,
    status: row.status,
    units,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUnit(row: UnitRow): DelegationUnit {
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

function mapAttempt(row: AttemptRow): DelegationAttempt {
  return {
    id: row.id,
    unitId: row.unit_id,
    attemptNo: row.attempt_no,
    executionId: row.execution_id,
    mode: row.mode,
    provider: row.provider,
    model: row.model,
    outcome: row.outcome,
    outcomeDetail: row.outcome_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
