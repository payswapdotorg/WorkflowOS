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
import { assertDispatchAdmission } from './dispatch-admission.js';
import type {
  ExternalExecutionPackage,
  ExecutionMode,
  ExecutionState,
} from './execution.types.js';
import type {
  CreateCrossModeHandoffInput,
  CrossModeHandoffFencedDispatchOutcome,
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
   * PR #46 round 4 (the concurrency-serialization fix) + round 5 (the
   * lease-ownership fix): INSERT the handoff log row AND claim the durable
   * obligation in ONE transaction. The reserve INSERT (0042) + migration
   * 0043's AFTER INSERT trigger (the obligation row) + the claim UPDATE are
   * atomic — a concurrent reconcile cannot see the obligation until the
   * transaction commits, at which point the claim is already held.
   *
   * PR #46 round 5: the claim UPDATE increments `claim_epoch` (migration
   * 0045 — the fencing token) + RETURNs it. The `owner` is the unique
   * per-invocation identity (`<role-prefix>:<uuid>` — the service composes
   * it via newCrossModeHandoffClaimOwner); the returned `claimEpoch`
   * identifies THIS lease and is required for the heartbeat renewal + the
   * `finally` release (a stale invocation can never release a newer lease:
   * different owner AND different epoch).
   */
  async createHandoffAndClaim(
    input: CreateCrossModeHandoffInput,
    owner: string,
    leaseMs: number,
  ): Promise<
    | { handoff: CrossModeHandoffRecord; claimed: true; claimEpoch: number }
    | { handoff: CrossModeHandoffRecord; claimed: false; claimEpoch: null }
  > {
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
        //    the boot sweep reclaim. PR #46 round 5: the claim ALSO
        //    increments `claim_epoch` (the fencing token — migration 0045)
        //    + RETURNs it so the caller identifies its individual lease for
        //    the renewal + the release.
        const claimResult = await tx.query<{ id: string; claim_epoch: string | number }>(
          `UPDATE wfos_cross_mode_handoff_obligations
              SET claimed_at = NOW(),
                  claim_expires_at = NOW() + ($3::double precision / 1000.0) * INTERVAL '1 second',
                  claim_owner = $2,
                  claim_epoch = COALESCE(claim_epoch, 0) + 1
            WHERE handoff_id = $1
              AND discharged_at IS NULL
              AND (claimed_at IS NULL OR claim_expires_at < NOW())
           RETURNING id, claim_epoch`,
          [handoff.id, owner, leaseMs],
        );
        const claimedRow = claimResult.rows[0];
        if (!claimedRow) {
          return { handoff, claimed: false as const, claimEpoch: null };
        }
        return {
          handoff,
          claimed: true as const,
          claimEpoch: Number(claimedRow.claim_epoch),
        };
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
   *
   * PR #46 round 5: the claim increments `claim_epoch` (the fencing token —
   * migration 0045) + RETURNs it. The `owner` is the unique per-invocation
   * identity; the returned `claimEpoch` identifies THIS lease (used by the
   * heartbeat renewal + the epoch-fenced discharge). The epoch is NEVER
   * reset — each successive lease gets a strictly greater token, so a stale
   * owner's renewal/discharge/release predicates can never match a newer
   * lease.
   */
  async claimHandoffObligation(
    handoffId: string,
    owner: string,
    leaseMs: number,
  ): Promise<
    | { claimed: true; claimEpoch: number }
    | { claimed: false; activeOwner: string | null }
  > {
    const result = await this.db.query<{ id: string; claim_epoch: string | number }>(
      `UPDATE wfos_cross_mode_handoff_obligations
          SET claimed_at = NOW(),
              claim_expires_at = NOW() + ($3::double precision / 1000.0) * INTERVAL '1 second',
              claim_owner = $2,
              claim_epoch = COALESCE(claim_epoch, 0) + 1
        WHERE handoff_id = $1
          AND discharged_at IS NULL
          AND (claimed_at IS NULL OR claim_expires_at < NOW())
       RETURNING id, claim_epoch`,
      [handoffId, owner, leaseMs],
    );
    const claimedRow = result.rows[0];
    if (claimedRow) {
      return { claimed: true as const, claimEpoch: Number(claimedRow.claim_epoch) };
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
   * PR #46 round 5 (the lease-expiry fix): renew the claim lease — the
   * HEARTBEAT + the fence check. A conditional UPDATE guarded by the exact
   * lease identity (`claim_owner = $2 AND claim_epoch = $3`) extending
   * `claim_expires_at`. Returns TRUE when this lease still owns the claim;
   * FALSE when another actor reclaimed it (owner/epoch mismatch — the
   * caller MUST abort its critical section) or the obligation was
   * discharged. The renewal does NOT require the lease to be un-expired: an
   * expired-but-unreclaimed lease may be renewed by its (alive-again) owner;
   * a concurrent renew/reclaim pair is serialized by the row lock (the
   * second UPDATE's WHERE re-evaluates after the first commits — exactly
   * one matches).
   */
  async renewHandoffObligationClaim(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE wfos_cross_mode_handoff_obligations
          SET claim_expires_at = NOW() + ($4::double precision / 1000.0) * INTERVAL '1 second'
        WHERE handoff_id = $1
          AND claim_owner = $2
          AND claim_epoch = $3
          AND discharged_at IS NULL
       RETURNING id`,
      [handoffId, owner, claimEpoch, leaseMs],
    );
    return result.rows.length > 0;
  }

  /**
   * PR #46 round 4 + round 5: release the claim (clear the claim columns).
   * Guarded by the EXACT lease identity (`claim_owner = $2 AND claim_epoch =
   * $3`) — only the individual lease holder can release. A stale invocation
   * whose lease expired + was reclaimed (new unique owner + new epoch)
   * affects 0 rows: it can NEVER clear the new owner's live claim. A no-op
   * (false, not an error) when the obligation was discharged (the
   * `discharged_at IS NULL` guard) or the claim was already
   * reclaimed/released. The epoch is intentionally NOT reset — fencing
   * tokens are never reused across leases.
   */
  async releaseHandoffObligationClaim(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE wfos_cross_mode_handoff_obligations
          SET claimed_at = NULL,
              claim_expires_at = NULL,
              claim_owner = NULL
        WHERE handoff_id = $1
          AND claim_owner = $2
          AND claim_epoch = $3
          AND discharged_at IS NULL
       RETURNING id`,
      [handoffId, owner, claimEpoch],
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
   * PR #46 review #2 + round 5 (the epoch fence): idempotently discharge a
   * cross-mode-handoff obligation (set discharged_at = NOW()). PR #46 round
   * 5: the discharge is FENCED by the exact lease identity
   * (`claim_owner = $2 AND claim_epoch = $3`) — only the LIVE lease holder
   * can discharge. A stale owner (whose lease expired + was reclaimed under
   * a new owner/epoch) affects 0 rows → false: it cannot complete the
   * authoritative obligation transition. Returns true when this lease
   * discharged the obligation, false when fenced out (reclaimed) or already
   * discharged (a repeated recovery / a fast path that won the race before
   * the discharge). The obligation is append-only — only the discharge
   * column changes (the immutability trigger on
   * wfos_cross_mode_handoff_obligations enforces this).
   */
  async dischargeHandoffObligation(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE wfos_cross_mode_handoff_obligations
         SET discharged_at = NOW()
       WHERE handoff_id = $1
         AND claim_owner = $2
         AND claim_epoch = $3
         AND discharged_at IS NULL
       RETURNING id`,
      [handoffId, owner, claimEpoch],
    );
    return result.rows.length > 0;
  }

  /**
   * PR #46 round 6 (the side-effect-boundary fencing fix) + round 7 (the
   * provider-operation exactly-once boundary) + WORK-043 round 4 (the
   * DISPATCH ADMISSION BOUNDARY — AR-043-05): CROSS the fenced dispatch
   * gate — ONE transaction that evaluates the lease fence (the EXACT owner
   * + epoch + not discharged) ATOMICALLY with opening the durable dispatch
   * intent (migration 0046's dispatch_state/dispatch_epoch columns +
   * migration 0047's dispatch_idempotency_key — the durable record of the
   * dispatch operation identity, derived from the LOGICAL HANDOFF IDENTITY
   * so every actor driving the same handoff records + submits under the SAME
   * key) AND with the WORK-043 quota/rate-limit ADMISSION CHECK
   * ({@link assertDispatchAdmission} — the architect's AR-043-05 hard
   * admission boundary; the opened gate IS the durable dispatch
   * reservation). This replaces the check-then-act window between the
   * round-5 pre-call `ensureFence()` and the provider submit: an actor
   * whose lease was reclaimed between the check and the submit affects
   * 0 rows HERE and aborts BEFORE the provider call; an actor whose
   * dispatch would exceed an active project quota/rate limit is REJECTED
   * HERE — before the gate opens and before the provider call, with the
   * obligation left PENDING for the existing reconcile/retry machinery.
   *
   * The state arms:
   *   - `dispatch_state IS NULL` — a fresh gate opens at this lease's epoch;
   *   - `dispatch_state = 'in_flight' AND dispatch_epoch < $epoch` — a STALE
   *     in-flight dispatch (a crashed/stalled owner that crossed but never
   *     completed) is TAKEN OVER by this (newer, monotonic) lease — an
   *     interrupted dispatch can never deadlock the gate; the take-over
   *     re-records the SAME idempotency key (the deterministic handoff-
   *     identity derivation makes every actor's key identical);
   *   - `dispatch_state = 'completed'` — never re-entered (the authoritative
   *     outcome write is atomic with completion, so a completed gate implies
   *     the outcome is present; the reconcile's outcome checks skip the
   *     re-dispatch).
   *
   * A concurrent begin/reclaim pair is serialized by the obligation row lock
   * (the second UPDATE's WHERE re-evaluates after the first commits —
   * exactly one matches).
   */
  async beginFencedDispatch(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    dispatchIdempotencyKey: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Resolve THIS handoff's dispatch context (the project whose policy
      // limits govern the admission + the destination provider the dispatch
      // targets + the logical execution whose own contributions are excluded
      // from its own admission). Resolved INSIDE the transaction — the join
      // is consistent with the gate CAS that follows.
      const ctx = await tx.query<{ execution_record_id: string; project_id: string; provider: string }>(
        `SELECT e.id AS execution_record_id, e.project_id, e.provider
           FROM wfos_cross_mode_handoff_obligations o
           JOIN wfos_execution_mode_handoffs h ON h.id = o.handoff_id
           JOIN wfos_executions e ON e.id = h.execution_record_id
          WHERE o.handoff_id = $1`,
        [handoffId],
      );
      const context = ctx.rows[0];
      if (!context) {
        // Unknown handoff (or a torn obligation) — the gate CAS below would
        // match 0 rows anyway; skip both the admission check and the UPDATE.
        return false;
      }
      // AR-043-05 — THE ADMISSION GATE: the check is ATOMIC with the
      // gate-open. Throws DispatchAdmissionRejectedError (rolling the whole
      // transaction back — NO gate opens, NO provider call) when an active
      // project quota/rate limit would be exceeded by admitting THIS
      // dispatch. The advisory lock inside serializes concurrent admissions
      // for the same project; the opened gate IS the durable reservation.
      await assertDispatchAdmission(tx, {
        projectId: context.project_id,
        provider: context.provider,
        // The CURRENT logical execution's own contributions (its prior-phase
        // artifacts, its own open gate) are excluded — a handoff dispatch
        // (including a take-over re-drive of the SAME keyed operation) never
        // blocks on itself.
        excludeExecutionRecordId: context.execution_record_id,
      });
      const result = await tx.query<{ id: string }>(
        `UPDATE wfos_cross_mode_handoff_obligations
            SET dispatch_state = 'in_flight',
                dispatch_epoch = $3,
                dispatch_idempotency_key = $4
          WHERE handoff_id = $1
            AND claim_owner = $2
            AND claim_epoch = $3
            AND discharged_at IS NULL
            AND (
              dispatch_state IS NULL
              OR (dispatch_state = 'in_flight' AND dispatch_epoch < $3)
            )
         RETURNING id`,
        [handoffId, owner, claimEpoch, dispatchIdempotencyKey],
      );
      return result.rows.length > 0;
    });
  }

  /**
   * PR #46 round 6 (the side-effect-boundary fencing fix): COMPLETE the
   * fenced dispatch — the gate CAS AND the AUTHORITATIVE OUTCOME WRITE on
   * `wfos_executions` in ONE transaction. This IS the side-effect boundary:
   * the fence is not a pre-call check but the commit condition of the
   * authoritative write itself.
   *
   * Transaction shape:
   *   1. The gate CAS: `dispatch_state 'in_flight' @ THIS owner+epoch →
   *      'completed'`, guarded by the lease identity (`claim_owner` +
   *      `claim_epoch` + not discharged). 0 rows → ROLLBACK → FALSE — NO
   *      outcome write happened (a stale actor whose lease was reclaimed
   *      mid-dispatch cannot commit its already-computed outcome, and cannot
   *      clobber the new owner's state with a failure write either).
   *   2. The outcome write on wfos_executions — mirrors
   *      {@link PgExecutionRecordRepository.updateStatus} semantics: status
   *      is always set; agent_run_id/package_json/started_at/completed_at/
   *      expires_at COALESCE (null keeps the current column value);
   *      benchmark_metadata is merged with the jsonb `||` concatenation
   *      (right-biased, top-level — identical to updateStatus's JS merge),
   *      so the merge is itself atomic inside the transaction.
   *
   * The two row locks (the obligation row + the execution row) are both held
   * until COMMIT: a concurrent reclaim UPDATE on the obligation row blocks
   * until this transaction commits, after which its WHERE re-evaluates —
   * either the lease already expired (the reclaim succeeds, but the outcome
   * is already durably present → the reclaiming actor's reconcile converges
   * + discharges) or the lease is still live (the reclaim fails).
   */
  async completeFencedDispatch(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    executionRecordId: string,
    outcome: CrossModeHandoffFencedDispatchOutcome,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const gate = await tx.query<{ id: string }>(
        `UPDATE wfos_cross_mode_handoff_obligations
            SET dispatch_state = 'completed'
          WHERE handoff_id = $1
            AND claim_owner = $2
            AND claim_epoch = $3
            AND discharged_at IS NULL
            AND dispatch_state = 'in_flight'
            AND dispatch_epoch = $3
         RETURNING id`,
        [handoffId, owner, claimEpoch],
      );
      if (gate.rows.length === 0) {
        // Fenced out: the lease was reclaimed mid-dispatch (or the gate was
        // already completed / the obligation discharged). NO outcome write.
        return false;
      }
      await tx.query(
        `UPDATE wfos_executions SET
           status = $2,
           agent_run_id = COALESCE($3, agent_run_id),
           package_json = COALESCE($4::jsonb, package_json),
           started_at = COALESCE($5, started_at),
           completed_at = COALESCE($6, completed_at),
           expires_at = COALESCE($7, expires_at),
           benchmark_metadata = COALESCE(benchmark_metadata, '{}'::jsonb)
                                 || COALESCE($8::jsonb, '{}'::jsonb),
           updated_at = NOW()
         WHERE id = $1`,
        [
          executionRecordId,
          outcome.status,
          outcome.agentRunId ?? null,
          outcome.packageValue != null ? JSON.stringify(outcome.packageValue) : null,
          outcome.startedAt ?? null,
          outcome.completedAt ?? null,
          outcome.expiresAt ?? null,
          outcome.benchmarkMetadata != null
            ? JSON.stringify(outcome.benchmarkMetadata)
            : null,
        ],
      );
      return true;
    });
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
