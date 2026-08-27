/**
 * WORK-043 (§33.3) — PR #48 round 4 / AR-043-05: THE DISPATCH ADMISSION
 * BOUNDARY.
 *
 * ============================================================================
 * THE FROZEN ADMISSION SEMANTICS (the architect's AR-043-05 ruling)
 * ============================================================================
 *
 *   1. ADVISORY ELIGIBILITY. The WORK-043 eligibility engine
 *      (DefaultExecutionPolicyService.recommend +
 *      evaluateCandidateEligibility) is ADVISORY point-in-time evaluation:
 *      it derives the CURRENT usage from the authoritative records and
 *      returns a snapshot verdict. `eligible=true` is NOT an admission
 *      reservation and NOT a dispatch guarantee — two concurrent callers
 *      can both observe `usage=0, limit=1`, both receive `eligible=true`,
 *      and both reach for the provider.
 *
 *   2. HARD ADMISSION LIVES AT THE DISPATCH MUTATION BOUNDARY — HERE. The
 *      single seam below, {@link assertDispatchAdmission}, is crossed
 *      ATOMICALLY (inside the mutation's own transaction, immediately
 *      before the durable dispatch mutation + the provider submit) by BOTH
 *      dispatch paths:
 *
 *        DIRECT execution     → PgExecutionRecordRepository.create
 *                                (the execution record's creation IS the
 *                                dispatch reservation: the row is created
 *                                ONLY when the dispatch is admitted)
 *
 *        CROSS-MODE HANDOFF   → PgCrossModeHandoffRepository.beginFencedDispatch
 *                                (the admission check is INSIDE the
 *                                gate-open transaction: the opened dispatch
 *                                gate IS the reservation; the check and the
 *                                gate CAS commit together)
 *
 *      Because the admission decision and the durable mutation commit in
 *      ONE transaction, and every admission for a project is serialized by
 *      a transaction-scoped PostgreSQL advisory lock on the project, two
 *      concurrent dispatch attempts against a one-unit limit CANNOT both
 *      be admitted: the second actor's pressure derivation observes the
 *      first actor's already-committed reservation.
 *
 *   3. NO PARALLEL USAGE LEDGER. The admission pressure is DERIVED at the
 *      boundary from the EXISTING authoritative structures — exactly the
 *      AR-043-01/AR-043-02 usage derivation (the dispatch predicate over
 *      wfos_agent_runs + package_json + the append-only handoff log) PLUS
 *      the in-flight reservations, which are themselves EXISTING durable
 *      rows:
 *
 *        - an OPEN dispatch gate (wfos_cross_mode_handoff_obligations
 *          .dispatch_state='in_flight') — a cross-mode dispatch in flight,
 *          held until completeFencedDispatch lands the dispatch artifact
 *          (the usage takes over) or a take-over re-drives the SAME keyed
 *          operation (one reservation per handoff obligation, lifecycle-
 *          managed by the WORK-042 claim/lease/reconcile machinery);
 *        - a CREATED-not-dispatched execution row within the reservation
 *          horizon — a direct-path dispatch in flight (create → submit →
 *          outcome write is synchronous; a crash between the create and
 *          the outcome write self-releases after the horizon).
 *
 *      No new table, no new column, no dual-write, no drift.
 *
 *   4. THE PRESSURE MODEL MIRRORS THE ENGINE'S FAMILIES, PLUS RESERVATIONS.
 *
 *        QUOTA pressure (per period) — LOGICAL EXECUTIONS: each execution
 *        row counted AT MOST ONCE when it dispatched (artifact evidence),
 *        is dispatching (open gate), or is reserved (created within the
 *          horizon, no artifact yet). The CURRENT logical execution's own
 *          row is EXCLUDED from its own admission (a handoff take-over
 *          re-drives the SAME logical execution — it must never be blocked
 *          by its own in-flight gate; its already-dispatched first phase is
 *          already part of the project's usage and stays counted for every
 *          OTHER admission).
 *
 *        RATE pressure (per provider, sliding window) — PROVIDER DISPATCH
 *        EVENTS: the three AR-043-02 arms (the AgentRun row's OWN provider;
 *        the current external phase's package OWN provider; the handed-off-
 *        away phase's package snapshot OWN provider — each gated by its OWN
 *        AUTHORITATIVE dispatch timestamp: the run row's creation (native) /
 *        the package's dispatchedAt (external, snapshots included) — never a
 *        reservation timestamp; a package without dispatchedAt counts
 *        fail-closed) PLUS the reservation events attributed to the provider
 *        each in-flight dispatch targets
 *        (the open gate's post-mutation execution row provider — the
 *        destination; the created row's provider — the direct target),
 *        again EXCLUDING the current logical execution's own contributions.
 *
 *   5. FAIL-CLOSED. An admission whose pressure cannot be derived (the
 *      query fails) throws — the enclosing transaction rolls back and the
 *      dispatch DOES NOT happen. An un-verifiable admission is not an
 *      admission. A policy row with NO active limits is a zero-cost fast
 *      path (nothing to enforce — the boundary is a no-op; pre-WORK-043
 *      deployments without policy rows are unaffected).
 *
 *   6. RECOVERY. An admission rejection is CLIENT-RETRYABLE state, not an
 *      execution failure: the quota period (UTC calendar month/day) or the
 *      rate window (seconds) rolls, or a concurrent dispatch's reservation
 *      completes/releases, and the attempt can be re-submitted. The direct
 *      path surfaces the typed {@link DispatchAdmissionRejectedError}
 *      (mapped to HTTP 429); the cross-mode handoff converts it to the
 *      typed 'handoff-admission-rejected' handoff error (429) with the
 *      obligation left PENDING for the existing reconcile/retry machinery.
 * ============================================================================
 */
import type { DatabaseTx } from '@platform/index.js';

/**
 * The reservation horizon for the DIRECT path's in-flight reservations: a
 * `created`-status execution row with no dispatch artifact counts as
 * admission pressure while (and only while) it is younger than this
 * horizon. The direct path is synchronous — create → provider submit →
 * outcome write — and BOTH dispatch artifacts (the external package write,
 * the native AgentRun row creation) land within milliseconds of the
 * submit; the horizon is three orders of magnitude of headroom. Its only
 * purpose is crash recovery: a process that dies between the create and
 * the outcome write leaves a `created` row that would otherwise hold
 * admission capacity forever; after the horizon it self-releases (the row
 * never dispatched — per AR-043-01 it is not usage, and it stops being
 * pressure).
 */
export const DISPATCH_RESERVATION_HORIZON_MS = 10 * 60 * 1000;

/** The rejection's constraint family (the engine's category vocabulary). */
export type DispatchAdmissionCategory = 'quota' | 'rate_limit';

/** The structured admission rejection — mirrors the engine's EligibilityBlock. */
export interface DispatchAdmissionRejectionDetail {
  readonly category: DispatchAdmissionCategory;
  readonly constraint: string;
  readonly reason: string;
  readonly usage: number;
  readonly limit: number;
}

/**
 * The typed ADMISSION REJECTION. Thrown by {@link assertDispatchAdmission}
 * from inside the dispatch mutation's transaction — the enclosing
 * transaction rolls back (NO dispatch mutation, NO provider call) and the
 * error propagates to the boundary's caller:
 *
 *   - the DIRECT path: ExecutionService.submit → the workflow route maps
 *     it to HTTP 429 (retryable — the window/period rolls);
 *   - the CROSS-MODE HANDOFF path: dispatchExternal/dispatchNative convert
 *     it to CrossModeHandoffError('handoff-admission-rejected') → 429,
 *     with the obligation left PENDING (the existing reconcile retries
 *     once the constraint frees capacity).
 */
export class DispatchAdmissionRejectedError extends Error {
  readonly code = 'execution-admission-rejected' as const;
  readonly detail: DispatchAdmissionRejectionDetail;

  constructor(detail: DispatchAdmissionRejectionDetail) {
    super(
      `execution-admission-rejected: ${detail.reason}`,
    );
    this.name = 'DispatchAdmissionRejectedError';
    this.detail = detail;
  }
}

/** The admission context: what is being admitted, and what is already its own. */
export interface DispatchAdmissionInput {
  /** The project whose policy limits govern the admission (tenant scope). */
  readonly projectId: string;
  /** The provider this dispatch targets (the rate window's scope). */
  readonly provider: string;
  /**
   * The logical execution this dispatch belongs to. Its OWN contributions
   * (prior-phase artifacts, its open gate, its created-row reservation) are
   * EXCLUDED from the pressure — a dispatch never blocks on itself. The
   * direct path passes undefined (the row does not exist yet — the admission
   * IS the row's creation); the cross-mode handoff passes the handoff's
   * execution record id (the take-over arm re-drives the SAME logical
   * execution).
   */
  readonly excludeExecutionRecordId?: string;
  /** The clock seam (period/window boundaries). */
  readonly now?: () => Date;
}

/** Resolved active limits (NULL halves = the family is inactive). */
interface ActiveLimits {
  readonly monthlyMaxExecutions: number | null;
  readonly dailyMaxExecutions: number | null;
  readonly rateLimitMaxRequests: number | null;
  readonly rateLimitWindowSeconds: number | null;
}

/**
 * THE ADMISSION SEAM. Must be called INSIDE the dispatch mutation's open
 * transaction (the advisory lock is transaction-scoped — it is held until
 * the enclosing transaction commits/rolls back, serializing every
 * concurrent admission for the same project). Throws
 * {@link DispatchAdmissionRejectedError} when an active limit would be
 * exceeded by admitting THIS dispatch; returns silently when admitted.
 */
export async function assertDispatchAdmission(
  tx: DatabaseTx,
  input: DispatchAdmissionInput,
): Promise<void> {
  const now = input.now ? input.now() : new Date();

  // --- serialize every admission for this project (transaction-scoped) ---
  // hashtextextended(projectId) → a stable bigint key. The lock is acquired
  // BEFORE any pressure read: a concurrent admission for the same project
  // blocks here until this transaction commits, after which its pressure
  // derivation observes THIS actor's committed reservation.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    input.projectId,
  ]);

  // --- resolve the project's active limits (the same columns the engine reads) ---
  const policyRes = await tx.query<{
    max_executions_per_month: number | null;
    max_executions_per_day: number | null;
    rate_limit_max_requests: number | null;
    rate_limit_window_seconds: number | null;
  }>(
    `SELECT max_executions_per_month, max_executions_per_day,
            rate_limit_max_requests, rate_limit_window_seconds
       FROM wfos_execution_policies
      WHERE project_id = $1`,
    [input.projectId],
  );
  const policyRow = policyRes.rows[0];
  if (!policyRow) return; // no policy row → no active limits → fast path
  const limits: ActiveLimits = {
    monthlyMaxExecutions: policyRow.max_executions_per_month ?? null,
    dailyMaxExecutions: policyRow.max_executions_per_day ?? null,
    rateLimitMaxRequests: policyRow.rate_limit_max_requests ?? null,
    rateLimitWindowSeconds: policyRow.rate_limit_window_seconds ?? null,
  };
  const quotaActive =
    limits.monthlyMaxExecutions != null || limits.dailyMaxExecutions != null;
  const rateActive =
    limits.rateLimitMaxRequests != null && limits.rateLimitWindowSeconds != null;
  if (!quotaActive && !rateActive) return; // limits configured but inactive

  const exclude = input.excludeExecutionRecordId ?? null;

  // --- QUOTA pressure: LOGICAL EXECUTIONS (each row at most once) ---
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const quotaPressure = async (since: Date): Promise<number> => {
    const res = await tx.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c
         FROM wfos_executions e
        WHERE e.project_id = $1
          AND e.created_at >= $2
          AND ($4::uuid IS NULL OR e.id <> $4)
          AND (
               -- dispatched (the AR-043-01 artifact predicate):
               EXISTS (SELECT 1 FROM wfos_agent_runs r
                        WHERE r.execution_id = e.execution_id)
               OR e.package_json IS NOT NULL
               -- OR dispatching (an OPEN dispatch gate — the handoff reservation):
               OR EXISTS (SELECT 1 FROM wfos_cross_mode_handoff_obligations o
                           JOIN wfos_execution_mode_handoffs h
                             ON h.id = o.handoff_id
                          WHERE h.execution_record_id = e.id
                            AND o.dispatch_state = 'in_flight'
                            AND o.discharged_at IS NULL)
               -- OR reserved (a direct-path dispatch in flight within the horizon):
               OR (
                 e.status = 'created'
                 AND e.package_json IS NULL
                 AND e.created_at >= $3
                 AND NOT EXISTS (SELECT 1 FROM wfos_agent_runs r
                                  WHERE r.execution_id = e.execution_id)
               )
          )`,
      [input.projectId, since, new Date(now.getTime() - DISPATCH_RESERVATION_HORIZON_MS), exclude],
    );
    return Number(res.rows[0]?.c ?? 0);
  };

  // --- RATE pressure: PROVIDER DISPATCH EVENTS + reservation events ---
  const ratePressure = async (windowStart: Date): Promise<number> => {
    const res = await tx.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM (
             -- (1) NATIVE dispatch events — the AgentRun ledger row's OWN
             --     provider + OWN creation time (a FAILED run still dispatched).
             SELECT 1
               FROM wfos_agent_runs r
               JOIN wfos_executions e ON e.execution_id = r.execution_id
              WHERE e.project_id = $1
                AND r.provider = $2
                AND r.created_at >= $3
                AND ($5::uuid IS NULL OR e.id <> $5)
             UNION ALL
             -- (2) EXTERNAL dispatch events — the CURRENT external phase's
             --     package artifact (self-describing provider field). Event
             --     time = the package's OWN dispatchedAt — the AUTHORITATIVE
             --     dispatch timestamp (the a1b88a9 event-time anchors), NEVER
             --     the execution/handoff-log row creation (reservations).
             --     COALESCE(..., TRUE): a package without dispatchedAt counts
             --     FAIL-CLOSED (assumed in-window).
             SELECT 1
               FROM wfos_executions e
              WHERE e.project_id = $1
                AND e.mode = 'external'
                AND e.package_json IS NOT NULL
                AND e.package_json->>'provider' = $2
                AND COALESCE((e.package_json->>'dispatchedAt')::timestamptz >= $3, TRUE)
                AND ($5::uuid IS NULL OR e.id <> $5)
             UNION ALL
             -- (3) EXTERNAL dispatch events — the HANDED-OFF-AWAY external
             --     phase's package snapshot in the append-only handoff log.
             --     Event time = the SNAPSHOT's OWN dispatchedAt (preserved);
             --     COALESCE(..., TRUE): fail-closed as in arm (2).
             SELECT 1
               FROM wfos_execution_mode_handoffs h
               JOIN wfos_executions e ON e.id = h.execution_record_id
              WHERE e.project_id = $1
                AND h.to_mode = 'native'
                AND h.previous_package_json IS NOT NULL
                AND h.previous_package_json->>'provider' = $2
                AND COALESCE((h.previous_package_json->>'dispatchedAt')::timestamptz >= $3, TRUE)
                AND ($5::uuid IS NULL OR e.id <> $5)
             UNION ALL
             -- (4) ADMISSION RESERVATION — an OPEN dispatch gate (a
             --     cross-mode dispatch in flight), attributed to the
             --     destination provider (the execution row's post-mutation
             --     provider column).
             SELECT 1
               FROM wfos_cross_mode_handoff_obligations o
               JOIN wfos_execution_mode_handoffs h ON h.id = o.handoff_id
               JOIN wfos_executions e ON e.id = h.execution_record_id
              WHERE e.project_id = $1
                AND e.provider = $2
                AND o.dispatch_state = 'in_flight'
                AND o.discharged_at IS NULL
                AND ($5::uuid IS NULL OR e.id <> $5)
             UNION ALL
             -- (5) ADMISSION RESERVATION — a direct-path dispatch in flight
             --     (created, no artifact, within the horizon), attributed to
             --     the row's provider (the dispatch target).
             SELECT 1
               FROM wfos_executions e
              WHERE e.project_id = $1
                AND e.provider = $2
                AND e.status = 'created'
                AND e.package_json IS NULL
                AND e.created_at >= $4
                AND NOT EXISTS (SELECT 1 FROM wfos_agent_runs r
                                 WHERE r.execution_id = e.execution_id)
                AND ($5::uuid IS NULL OR e.id <> $5)
           ) dispatch_pressure`,
      [
        input.projectId,
        input.provider,
        windowStart,
        new Date(now.getTime() - DISPATCH_RESERVATION_HORIZON_MS),
        exclude,
      ],
    );
    return Number(res.rows[0]?.c ?? 0);
  };

  // --- THE DECISION (the engine's quota/rate family semantics, at the boundary) ---
  if (quotaActive && limits.monthlyMaxExecutions != null) {
    const used = await quotaPressure(monthStart);
    if (used >= limits.monthlyMaxExecutions) {
      throw new DispatchAdmissionRejectedError({
        category: 'quota',
        constraint: 'monthly_quota_exhausted',
        reason: `Monthly execution quota exhausted (${used}/${limits.monthlyMaxExecutions} dispatched or dispatching this period) — the dispatch is not admitted (retry after the period rolls or capacity frees).`,
        usage: used,
        limit: limits.monthlyMaxExecutions,
      });
    }
  }
  if (quotaActive && limits.dailyMaxExecutions != null) {
    const used = await quotaPressure(dayStart);
    if (used >= limits.dailyMaxExecutions) {
      throw new DispatchAdmissionRejectedError({
        category: 'quota',
        constraint: 'daily_quota_exhausted',
        reason: `Daily execution quota exhausted (${used}/${limits.dailyMaxExecutions} dispatched or dispatching today) — the dispatch is not admitted (retry after the day rolls or capacity frees).`,
        usage: used,
        limit: limits.dailyMaxExecutions,
      });
    }
  }
  if (rateActive && limits.rateLimitMaxRequests != null && limits.rateLimitWindowSeconds != null) {
    const windowStart = new Date(now.getTime() - limits.rateLimitWindowSeconds * 1000);
    const used = await ratePressure(windowStart);
    if (used >= limits.rateLimitMaxRequests) {
      throw new DispatchAdmissionRejectedError({
        category: 'rate_limit',
        constraint: 'rate_limit_window_exhausted',
        reason: `Provider ${input.provider} is rate limited (${used}/${limits.rateLimitMaxRequests} dispatches or in-flight dispatches in the last ${limits.rateLimitWindowSeconds}s window) — the dispatch is not admitted.`,
        usage: used,
        limit: limits.rateLimitMaxRequests,
      });
    }
  }
  // Admitted: the caller's enclosing transaction commits the durable dispatch
  // mutation (the reservation) and proceeds to the provider submit.
}
