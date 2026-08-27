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

  /**
   * PR #46 round 4 (the concurrency-serialization fix): INSERT the handoff
   * log row AND claim the durable obligation in ONE transaction. The reserve
   * INSERT (0042) + migration 0043's AFTER INSERT trigger (the obligation
   * row) + the claim UPDATE are atomic — a concurrent reconcile cannot see
   * the obligation until the transaction commits, at which point the claim
   * is already held. This closes the round-4 boot-sweep race (a reconcile
   * that fired between the reserve commit and a separate claim commit could
   * previously claim + re-mutate the same obligation).
   *
   * The claim UPDATE within the transaction always matches (the obligation
   * is freshly created by the trigger — `claimed_at IS NULL` holds). On a
   * 23505 UNIQUE violation the whole transaction rolls back (claim not
   * applied) + the error is mapped by {@link mapCreateError}.
   */
  async createHandoffAndClaim(
    input: CreateCrossModeHandoffInput,
    owner: string,
    leaseMs: number,
  ): Promise<{ handoff: CrossModeHandoffRecord; claimed: boolean }> {
    try {
      return await this.db.transaction(async (tx) => {
        // 1. INSERT the handoff log row (0043's AFTER INSERT trigger writes
        //    the obligation row ATOMICALLY in this SAME transaction).
        const result = await tx.query<HandoffRow>(
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
        const handoff = rowToHandoff(result.rows[0]!);
        // 2. Claim the obligation in the SAME transaction (atomic with the
        //    reserve). The obligation is freshly created by the trigger, so
        //    `claimed_at IS NULL` holds + the UPDATE matches. The
        //    `claim_expires_at` is the crash-reclaim window — a crashed
        //    owner's lease auto-expires after `leaseMs`, after which the
        //    `claim_expires_at < NOW()` arm of the reclaim predicate lets
        //    the boot sweep reclaim.
        const claimResult = await tx.query<{ id: string }>(
          `UPDATE wfos_cross_mode_handoff_obligations
              SET claimed_at = NOW(),
                  claim_expires_at = NOW() + ($3::double precision / 1000.0) * INTERVAL '1 second',
                  claim_owner = $2
            WHERE handoff_id = $1
              AND discharged_at IS NULL
              AND (claimed_at IS NULL OR claim_expires_at < NOW())
           RETURNING id`,
          [handoff.id, owner, leaseMs],
        );
        return { handoff, claimed: claimResult.rows.length > 0 };
      });
    } catch (err) {
      throw mapCreateError(err, input);
    }
  }

  /**
   * PR #46 round 4: claim an EXISTING obligation for the reconcile critical
   * section (the relay / boot-sweep path). A single conditional UPDATE
   * serializes concurrent actors: PostgreSQL row-locks the obligation row
   * for the duration of a conflicting UPDATE; the second actor's WHERE
   * re-evaluates after the first commits + sees a claimed row → 0 rows. The
   * reclaim predicate (`claimed_at IS NULL OR claim_expires_at < NOW()`)
   * lets a crashed owner's expired lease be reclaimed by the next sweep.
   */
  async claimHandoffObligation(
    handoffId: string,
    owner: string,
    leaseMs: number,
  ): Promise<{ claimed: true } | { claimed: false; activeOwner: string | null }> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE wfos_cross_mode_handoff_obligations
          SET claimed_at = NOW(),
              claim_expires_at = NOW() + ($3::double precision / 1000.0) * INTERVAL '1 second',
              claim_owner = $2
        WHERE handoff_id = $1
          AND discharged_at IS NULL
          AND (claimed_at IS NULL OR claim_expires_at < NOW())
       RETURNING id`,
      [handoffId, owner, leaseMs],
    );
    if (result.rows.length > 0) {
      return { claimed: true } as const;
    }
    // Did not claim — read the active owner for diagnostics (another actor
    // holds a live claim, OR the obligation was already discharged).
    const existing = await this.db.query<{ claim_owner: string | null }>(
      `SELECT claim_owner FROM wfos_cross_mode_handoff_obligations WHERE handoff_id = $1`,
      [handoffId],
    );
    return {
      claimed: false as const,
      activeOwner: existing.rows[0]?.claim_owner ?? null,
    };
  }

  /**
   * PR #46 round 4: release the claim (clear the claim columns). The
   * `claim_owner` guard ensures only the owner can release (defensive — a
   * concurrent actor that stole an expired lease + released under a
   * different owner cannot clear the original owner's columns). A no-op
   * when the obligation was discharged (the `discharged_at IS NULL` guard
   * returns 0 rows) or the claim already expired/released.
   */
  async releaseHandoffObligationClaim(
    handoffId: string,
    owner: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE wfos_cross_mode_handoff_obligations
          SET claimed_at = NULL,
              claim_expires_at = NULL,
              claim_owner = NULL
        WHERE handoff_id = $1
          AND claim_owner = $2
          AND discharged_at IS NULL
       RETURNING id`,
      [handoffId, owner],
    );
    return result.rows.length > 0;
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
