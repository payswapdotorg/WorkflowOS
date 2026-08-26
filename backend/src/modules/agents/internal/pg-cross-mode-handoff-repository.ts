/**
 * WORK-042: PostgreSQL persistence for the cross-mode handoff log
 * (`wfos_execution_mode_handoffs` — migration 0042).
 *
 * The repository is pure persistence — it contains no business rules. ONE
 * append-only row per execution (UNIQUE(execution_record_id)); the
 * immutability trigger (migration 0042) rejects UPDATE/DELETE so the
 * correction chain is preserved. A 23505 UNIQUE violation on
 * `execution_record_id` (a second handoff for the same execution) OR on
 * `idempotency_key` (a duplicate request) is typed as
 * {@link CrossModeHandoffError} with code 'cross-mode-handoff-already-exists'
 * + the execution record id in context; the service re-queries to decide
 * idempotent-convergence (same idempotency_key) vs reject (different key).
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  ExternalExecutionPackage,
  ExecutionMode,
  ExecutionState,
} from './execution.types.js';
import type {
  CreateCrossModeHandoffInput,
  CrossModeHandoffRecord,
  CrossModeHandoffRepository,
  PendingCrossModeHandoff,
} from './cross-mode-handoff.types.js';
import { CrossModeHandoffError } from './cross-mode-handoff.types.js';

const HANDOFF_COLUMNS = `
  h.id, h.execution_record_id, e.execution_id, h.from_mode, h.to_mode,
  h.reason, h.actor, h.source, h.previous_status, h.resulting_status,
  h.previous_agent_run_id, h.previous_external_session_ref,
  h.previous_package_json, h.authorized, h.policy_decision,
  h.idempotency_key, h.created_at
`;

interface HandoffRow {
  id: string;
  execution_record_id: string;
  execution_id: string;
  from_mode: string;
  to_mode: string;
  reason: string | null;
  actor: string | null;
  source: string | null;
  previous_status: string;
  resulting_status: string;
  previous_agent_run_id: string | null;
  previous_external_session_ref: string | null;
  previous_package_json: unknown;
  authorized: boolean;
  policy_decision: string | null;
  idempotency_key: string;
  created_at: Date;
}

function rowToHandoff(row: HandoffRow): CrossModeHandoffRecord {
  return {
    id: row.id,
    executionRecordId: row.execution_record_id,
    executionId: row.execution_id,
    fromMode: row.from_mode as ExecutionMode,
    toMode: row.to_mode as ExecutionMode,
    reason: row.reason,
    actor: row.actor,
    source: row.source,
    previousStatus: row.previous_status as ExecutionState,
    resultingStatus: row.resulting_status as ExecutionState,
    previousAgentRunId: row.previous_agent_run_id,
    previousExternalSessionRef: row.previous_external_session_ref,
    previousPackageValue:
      (row.previous_package_json as ExternalExecutionPackage | null) ?? null,
    authorized: row.authorized,
    policyDecision: row.policy_decision,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export class PgCrossModeHandoffRepository implements CrossModeHandoffRepository {
  constructor(private readonly db: DatabaseClient) {}

  async createHandoff(
    input: CreateCrossModeHandoffInput,
  ): Promise<CrossModeHandoffRecord> {
    try {
      // ONE statement: INSERT ... RETURNING the row, JOIN wfos_executions to
      // project the logical execution_id (the safe-view identity) alongside
      // the handoff's own columns. A CTE keeps the INSERT's RETURNING + the
      // join in a single round-trip (the immutability trigger is on the
      // handoff table; the CTE reads the just-inserted row).
      const result = await this.db.query<HandoffRow>(
        `WITH ins AS (
           INSERT INTO wfos_execution_mode_handoffs
             (execution_record_id, from_mode, to_mode, reason, actor, source,
              previous_status, resulting_status, previous_agent_run_id,
              previous_external_session_ref, previous_package_json, authorized,
              policy_decision, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id, execution_record_id, from_mode, to_mode, reason,
             actor, source, previous_status, resulting_status,
             previous_agent_run_id, previous_external_session_ref,
             previous_package_json, authorized, policy_decision,
             idempotency_key, created_at
         )
         SELECT ins.id, ins.execution_record_id, e.execution_id,
           ins.from_mode, ins.to_mode, ins.reason, ins.actor, ins.source,
           ins.previous_status, ins.resulting_status, ins.previous_agent_run_id,
           ins.previous_external_session_ref, ins.previous_package_json,
           ins.authorized, ins.policy_decision, ins.idempotency_key,
           ins.created_at
         FROM ins
         JOIN wfos_executions e ON e.id = ins.execution_record_id`,
        [
          input.executionRecordId,
          input.fromMode,
          input.toMode,
          input.reason,
          input.actor,
          input.source,
          input.previousStatus,
          input.resultingStatus,
          input.previousAgentRunId,
          input.previousExternalSessionRef,
          input.previousPackageValue
            ? JSON.stringify(input.previousPackageValue)
            : null,
          input.authorized,
          input.policyDecision,
          input.idempotencyKey,
        ],
      );
      return rowToHandoff(result.rows[0]!);
    } catch (err) {
      throw mapCreateError(err, input);
    }
  }

  async findByExecutionId(
    executionId: string,
  ): Promise<CrossModeHandoffRecord | null> {
    const result = await this.db.query<HandoffRow>(
      `SELECT ${HANDOFF_COLUMNS}
       FROM wfos_execution_mode_handoffs h
       JOIN wfos_executions e ON e.id = h.execution_record_id
       WHERE e.execution_id = $1
       LIMIT 1`,
      [executionId],
    );
    return result.rows[0] ? rowToHandoff(result.rows[0]) : null;
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<CrossModeHandoffRecord | null> {
    const result = await this.db.query<HandoffRow>(
      `SELECT ${HANDOFF_COLUMNS}
       FROM wfos_execution_mode_handoffs h
       JOIN wfos_executions e ON e.id = h.execution_record_id
       WHERE h.idempotency_key = $1
       LIMIT 1`,
      [key],
    );
    return result.rows[0] ? rowToHandoff(result.rows[0]) : null;
  }

  /**
   * PR #46 review #2: the boot-sweep query. Lists ALL pending cross-mode-
   * handoff obligations (discharged_at IS NULL) joined to the handoff log +
   * the execution to project the LOGICAL executionId the reconciliation
   * consumes. Idempotent: a duplicate sweep enqueues duplicate relay jobs,
   * which are harmless (the reconciliation is idempotent — a complete
   * handoff discharges + no-ops).
   */
  async listPendingHandoffObligations(): Promise<readonly PendingCrossModeHandoff[]> {
    const result = await this.db.query<{ obligation_id: string; handoff_id: string; execution_id: string }>(
      `SELECT o.id AS obligation_id, o.handoff_id, e.execution_id
       FROM wfos_cross_mode_handoff_obligations o
       JOIN wfos_execution_mode_handoffs h ON h.id = o.handoff_id
       JOIN wfos_executions e ON e.id = o.execution_id
       WHERE o.discharged_at IS NULL
       ORDER BY o.created_at ASC`,
    );
    return result.rows.map((r) => ({
      obligationId: r.obligation_id,
      handoffId: r.handoff_id,
      executionId: r.execution_id,
    }));
  }

  /**
   * PR #46 review #2: idempotently discharge a cross-mode-handoff obligation
   * (set discharged_at = NOW()). Returns true when a row was discharged,
   * false when the obligation was already discharged (a repeated recovery /
   * a fast path that won the race before the discharge). The obligation is
   * append-only — only the discharge column changes (the immutability trigger
   * on wfos_cross_mode_handoff_obligations enforces this).
   */
  async dischargeHandoffObligation(handoffId: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE wfos_cross_mode_handoff_obligations
         SET discharged_at = NOW()
       WHERE handoff_id = $1 AND discharged_at IS NULL
       RETURNING id`,
      [handoffId],
    );
    return result.rows.length > 0;
  }
}

/**
 * Map a raw PostgreSQL error from createHandoff to a typed
 * {@link CrossModeHandoffError}. A 23505 on EITHER the
 * `execution_record_id` UNIQUE (a second handoff for the same execution) OR
 * the `idempotency_key` UNIQUE (a duplicate request) is surfaced as
 * 'cross-mode-handoff-already-exists' with the execution record id in context
 * — the service re-queries (findByExecutionId / findByIdempotencyKey) to
 * decide idempotent convergence vs reject. Anything else passes through.
 */
function mapCreateError(
  err: unknown,
  input: CreateCrossModeHandoffInput,
): Error {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (
    e.code === '23505' &&
    (e.constraint === 'wfos_execution_mode_handoffs_execution_unique' ||
      e.constraint === 'wfos_execution_mode_handoffs_idempotency_unique')
  ) {
    return new CrossModeHandoffError(
      `cross-mode-handoff-already-exists: execution record ${input.executionRecordId} already has a handoff (UNIQUE violation on ${e.constraint})`,
      'cross-mode-handoff-already-exists',
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
