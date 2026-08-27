/**
 * WORK-042: Cross-Mode Execution Handoff — the public contract types.
 *
 * PRIMARY INVARIANT: ONE logical ExecutionRecord (identity preserved). ONE
 * ExecutionSession (continues the logical execution). ONE AgentWorkspace (per
 * execution). The cross-mode handoff is a SUBORDINATE state transition + an
 * append-only history log. NO second Work Item, NO second workflow, NO
 * second ExecutionService, NO second AgentGateway, NO second session/workspace
 * engine.
 *
 * The handoff is a subordinate correction-chain transition between the two
 * execution modes (native <-> external) for the SAME logical execution. The
 * execution record's `mode`/`status`/`agent_run_id`/`external_session_ref`/
 * `package_json` columns reflect the CURRENT (active) phase; the append-only
 * `wfos_execution_mode_handoffs` row preserves the prior phase's authoritative
 * evidence snapshot so the correction chain remains visible.
 *
 * SCOPE: ONE cross-mode handoff per execution (either native->external OR
 * external->native, NOT chained). Enforced by UNIQUE(execution_record_id) on
 * the handoff log table.
 *
 * The CrossModeHandoffService composes the EXISTING boundaries — it reuses
 * NativeExecutionProvider + ExternalExecutionProvider + ExecutionTaskService +
 * AgentPolicyEngine + ExecutionPolicyService + AgentProviderRegistryService.
 * It is NOT an ExecutionService (it never creates a second ExecutionRecord;
 * it transitions the existing one). It NEVER touches wfos_workflow_*,
 * wfos_verification_*, wfos_reviews_* (no workflow/verification/review
 * mutation).
 *
 * SECURITY: the handoff log table stores NO secrets (previous_package_json is
 * the ExternalExecutionPackage which contains NO secrets per WORK-027). The
 * route accepts NO authoritative fields (executionId from path; projectId
 * resolved server-side; policy decision server-side; audit identity server-
 * side). The handoff tokens (for native->external) use the EXISTING one-time,
 * short-lived, hashed ExecutionHandoffService (no new token mechanism).
 *
 * This file is private to /agents (PLAT-AC-02). The barrel exports the types
 * below; concrete implementations stay in internal/.
 */
import type {
  ExecutionMode,
  ExecutionRecord,
  ExecutionState,
  ExternalExecutionPackage,
} from './execution.types.js';
// PR #46 round 5: the unique per-invocation claim owner generator (the
// lease-identity fix — the persisted claim_owner must identify the
// INDIVIDUAL lease holder, not merely its role).
import { randomUUID } from 'node:crypto';

/**
 * The directional label of a cross-mode handoff. Derived from
 * {@link CrossModeHandoffRecord.fromMode} + {@link CrossModeHandoffRecord.toMode}.
 */
export type CrossModeHandoffDirection = 'native-to-external' | 'external-to-native';

/**
 * The persisted append-only mode-transition log row. ONE row per execution
 * (UNIQUE(execution_record_id)). The `previous_*` snapshot columns preserve
 * the prior phase's authoritative evidence; the execution record's columns
 * reflect the CURRENT (active) phase.
 *
 * SECURITY: `previousPackageValue` is the ExternalExecutionPackage which
 * contains NO secrets (WORK-027). No tokens, no credentials are persisted
 * here. The row is immutable after insert (migration 0042 trigger rejects
 * UPDATE/DELETE).
 */
export interface CrossModeHandoffRecord {
  readonly id: string;
  /** FK -> wfos_executions.id (the UUID PK of the execution record). */
  readonly executionRecordId: string;
  /** The logical execution identity (TEXT `wf_xxxxxxxx`) — for the safe view. */
  readonly executionId: string;
  readonly fromMode: ExecutionMode;
  readonly toMode: ExecutionMode;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly source: string | null;
  /** The execution record's status BEFORE the handoff transition. */
  readonly previousStatus: ExecutionState;
  /** The execution record's status AFTER the handoff transition. */
  readonly resultingStatus: ExecutionState;
  /** The prior phase's AgentRun id (native->external preserves it). */
  readonly previousAgentRunId: string | null;
  /** The prior phase's external session ref (external->native preserves it). */
  readonly previousExternalSessionRef: string | null;
  /** The prior phase's ExternalExecutionPackage snapshot (NO secrets). */
  readonly previousPackageValue: ExternalExecutionPackage | null;
  /** Server-side policy gate result (true when the handoff was authorized). */
  readonly authorized: boolean;
  /** Stringified policy decision summary (advisory; the audit carries detail). */
  readonly policyDecision: string | null;
  /** Caller-supplied idempotency key (UNIQUE — convergent on retry). */
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}

/**
 * Caller-controlled INTENT for a cross-mode handoff. NONE of these fields are
 * authoritative execution state — the server resolves the record, projectId,
 * policy decision, and audit identity server-side. `provider` + `model` are
 * advisory overrides (validated against the registry); when omitted, the
 * service resolves platform/project defaults.
 */
export interface CrossModeHandoffInput {
  /** The target execution mode (must differ from the record's current mode). */
  readonly targetMode: ExecutionMode;
  /** Free-form reason for the handoff (audited). */
  readonly reason?: string;
  /** A caller-supplied user instruction (audited; advisory to the runtime). */
  readonly userInstruction?: string;
  /**
   * Idempotency key. A retry with the same key converges to the existing
   * result. When omitted, the service derives a deterministic key from the
   * execution + target mode.
   */
  readonly idempotencyKey?: string;
  /** Advisory provider override (validated against the registry). */
  readonly provider?: string;
  /** Advisory model override (required for native; optional for external). */
  readonly model?: string | null;
}

/** The result of a cross-mode handoff — the post-handoff record + the log row. */
export interface CrossModeHandoffResult {
  readonly executionId: string;
  /** The append-only handoff log row (the correction-chain evidence). */
  readonly handoff: CrossModeHandoffRecord;
  /** The post-handoff execution record (reflects the CURRENT phase). */
  readonly record: ExecutionRecord;
}

/**
 * Input for {@link CrossModeHandoffRepository.createHandoff}. All authoritative
 * snapshot fields are server-resolved — the caller cannot supply them.
 */
export interface CreateCrossModeHandoffInput {
  readonly executionRecordId: string;
  readonly fromMode: ExecutionMode;
  readonly toMode: ExecutionMode;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly source: string | null;
  readonly previousStatus: ExecutionState;
  readonly resultingStatus: ExecutionState;
  readonly previousAgentRunId: string | null;
  readonly previousExternalSessionRef: string | null;
  readonly previousPackageValue: ExternalExecutionPackage | null;
  readonly authorized: boolean;
  readonly policyDecision: string | null;
  readonly idempotencyKey: string;
}

/**
 * Append-only persistence for the cross-mode handoff log. The repository is
 * pure persistence — it contains no business rules. The 23505 UNIQUE violation
 * on `execution_record_id` (a second handoff for the same execution) is typed
 * as {@link CrossModeHandoffError} with code 'cross-mode-handoff-already-exists'
 * so the service can decide idempotent-convergence vs reject.
 *
 * PR #46 review correction #2 (durable crash recovery): the repository ALSO
 * owns the cross-mode-handoff obligation surface (migration 0043 — the
 * transactional-outbox row written ATOMICALLY with the reserve by an AFTER
 * INSERT trigger). {@link listPendingHandoffObligations} is the boot-sweep
 * query; {@link dischargeHandoffObligation} is the idempotent discharge. The
 * obligation row is the durable source of truth for an in-flight handoff; the
 * relay + the boot sweep guarantee eventual delivery (mirrors the WORK-034
 * session-terminal obligation + the WORK-035 workspace-release obligation).
 */
export interface CrossModeHandoffRepository {
  /**
   * INSERT the append-only handoff row. Throws
   * {@link CrossModeHandoffError} with code
   * 'cross-mode-handoff-already-exists' on a 23505 UNIQUE violation on
   * `execution_record_id` (the service re-queries to decide convergence vs
   * reject). A 23505 on `idempotency_key` is also surfaced the same way (the
   * service resolves it via {@link findByIdempotencyKey}).
   *
   * PR #46 review #2: migration 0043's AFTER INSERT trigger writes the
   * durable handoff obligation ATOMICALLY with this INSERT — there is no
   * window where the handoff log exists but the obligation is missing.
   */
  createHandoff(input: CreateCrossModeHandoffInput): Promise<CrossModeHandoffRecord>;
  /**
   * PR #46 round 4 (the concurrency-serialization fix): INSERT the append-only
   * handoff row AND claim the durable obligation in ONE transaction. The
   * reserve INSERT (0042) + migration 0043's AFTER INSERT trigger (the
   * obligation row) + the claim UPDATE are atomic — a concurrent reconcile
   * (boot sweep / relay) cannot see the obligation until the transaction
   * commits, at which point the claim is already held. This closes the
   * round-4 boot-sweep race (a reconcile that fired between the reserve
   * commit and a separate claim commit could previously claim + re-mutate).
   *
   * PR #46 round 5: the `owner` MUST be a unique per-invocation identity
   * ({@link newCrossModeHandoffClaimOwner}) — never a shared role constant.
   * The claim increments `claim_epoch` (the fencing token) + the returned
   * `claimEpoch` identifies THIS lease: the caller uses it for the heartbeat
   * renewal + the `finally` release.
   *
   * Returns `{ handoff, claimed: true, claimEpoch }` on the happy path (the
   * obligation is freshly created by the trigger, so the claim UPDATE always
   * matches within the transaction). On a 23505 UNIQUE violation, the
   * transaction rolls back (claim not applied) + the error is mapped to
   * 'cross-mode-handoff-already-exists' — the service re-queries for
   * idempotent convergence (returning `{ handoff: existing, claimed: false,
   * claimEpoch: null }`). The caller MUST release the claim via
   * {@link releaseHandoffObligationClaim} after its critical section
   * (success OR failure — the lease auto-expires as a crash backstop).
   */
  createHandoffAndClaim(
    input: CreateCrossModeHandoffInput,
    owner: string,
    leaseMs: number,
  ): Promise<
    | { handoff: CrossModeHandoffRecord; claimed: true; claimEpoch: number }
    | { handoff: CrossModeHandoffRecord; claimed: false; claimEpoch: null }
  >;
  /**
   * PR #46 round 4: claim an EXISTING obligation for the reconcile critical
   * section (the relay / boot-sweep path). A single conditional UPDATE
   * serializes concurrent actors: the WHERE clause
   * `discharged_at IS NULL AND (claimed_at IS NULL OR claim_expires_at < NOW())`
   * is the reclaim predicate — only one actor's UPDATE matches (PostgreSQL
   * row-locks the obligation row for the duration of the conflicting UPDATE;
   * the second actor's WHERE re-evaluates after the first commits + sees a
   * claimed row → 0 rows). Returns `{ claimed: true, claimEpoch }` on success
   * or `{ claimed: false, activeOwner }` when another actor holds a live
   * claim (the reconcile returns early — NO mutate, NO dispatch — preventing
   * two concurrent handoff drivers). A crashed owner's expired lease is
   * reclaimable (the `claim_expires_at < NOW()` arm).
   *
   * PR #46 round 5: the `owner` MUST be a unique per-invocation identity
   * ({@link newCrossModeHandoffClaimOwner}). Every claim — fresh OR reclaim
   * — increments `claim_epoch`; the returned `claimEpoch` is the fencing
   * token for THIS lease (used by the heartbeat renewal
   * {@link renewHandoffObligationClaim} + the fenced discharge
   * {@link dischargeHandoffObligation}).
   */
  claimHandoffObligation(
    handoffId: string,
    owner: string,
    leaseMs: number,
  ): Promise<
    | { claimed: true; claimEpoch: number }
    | { claimed: false; activeOwner: string | null }
  >;
  /**
   * PR #46 round 5 (the lease-expiry fix): renew the claim lease — the
   * HEARTBEAT. A conditional UPDATE guarded by `claim_owner = $owner AND
   * claim_epoch = $epoch` extending `claim_expires_at`. Returns TRUE when
   * this lease still owns the claim (the lease was extended); FALSE when the
   * lease was RECLAIMED by another actor (owner/epoch mismatch — the fencing
   * check fails) or the obligation was discharged. The service renews every
   * lease/3 while the critical section runs (a LIVE owner's lease cannot
   * expire mid-flight) + at every side-effect phase boundary (the explicit
   * fence check: a STALLED owner learns it lost the fence + aborts before
   * further mutations/dispatch). A renewal of an expired-but-unreclaimed
   * lease is legitimate (the owner is alive again + no other actor took it);
   * a concurrent renew/reclaim pair is serialized by the row lock (exactly
   * one matches).
   */
  renewHandoffObligationClaim(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    leaseMs: number,
  ): Promise<boolean>;
  /**
   * PR #46 round 4 + round 5: release the claim (clear claimed_at/
   * claim_expires_at/claim_owner). Called by the caller + the reconcile in a
   * `finally` block after their critical section (success OR failure). The
   * `claim_owner` + `claim_epoch` guard ensures ONLY the individual lease
   * holder can release — a stale invocation (whose lease expired + was
   * reclaimed under a NEW unique owner + epoch) can NEVER clear the new
   * owner's live claim. A no-op (false, not an error) when the obligation
   * was discharged (the `discharged_at IS NULL` guard) or the claim was
   * already reclaimed/released. The epoch is intentionally NOT reset —
   * fencing tokens are never reused across leases.
   */
  releaseHandoffObligationClaim(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): Promise<boolean>;
  /** Find the (at most one) handoff row for an execution's record UUID. */
  findByExecutionId(executionId: string): Promise<CrossModeHandoffRecord | null>;
  /** Find a handoff row by its idempotency key (convergence check). */
  findByIdempotencyKey(key: string): Promise<CrossModeHandoffRecord | null>;
  /**
   * PR #46 review #2: list ALL pending cross-mode-handoff obligations (the
   * boot-sweep query — relay jobs are enqueued per obligation on every
   * worker start). A pending obligation = the handoff log row exists but the
   * reconciliation has not yet confirmed completion (record.mode === toMode
   * AND the dispatch outcome is present). Returns the LOGICAL executionId
   * per obligation (the relay payload). Idempotent: duplicate sweeps are
   * harmless (the reconciliation is idempotent).
   */
  listPendingHandoffObligations(): Promise<readonly PendingCrossModeHandoff[]>;
  /**
   * PR #46 review #2 + round 5 (the epoch fence): idempotently discharge a
   * cross-mode-handoff obligation (set discharged_at). Called by the
   * reconciliation when it confirms the handoff is complete. PR #46 round 5:
   * the discharge is FENCED by the claim owner + epoch
   * (`claim_owner = $owner AND claim_epoch = $epoch` in the WHERE clause) —
   * ONLY the live lease holder can discharge. A STALE owner (whose lease
   * expired + was reclaimed under a new owner/epoch) affects 0 rows → false:
   * it cannot complete the authoritative obligation transition even if its
   * phase-boundary fence check raced. A repeated discharge by the same lease
   * is a no-op (false; the `discharged_at IS NULL` guard). The obligation is
   * append-only — only the discharge column changes (the immutability
   * trigger on wfos_cross_mode_handoff_obligations enforces this).
   */
  dischargeHandoffObligation(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): Promise<boolean>;
  /**
   * PR #46 round 6 (the side-effect-boundary fencing fix) + round 7 (the
   * provider-operation exactly-once boundary): CROSS the fenced dispatch
   * gate — the durable intent record for the provider dispatch, evaluated
   * ATOMICALLY with the lease fence (ONE conditional UPDATE, no
   * check-then-act window). Called by the dispatch boundary BEFORE the
   * provider submit.
   *
   * The round-6 review established that the round-5 phase-boundary
   * `ensureFence()` runs BEFORE the side-effecting provider call, not
   * atomically with it — a stalled owner that passed the pre-call check
   * could resume after a reclaim and complete its ALREADY-STARTED dispatch
   * (a second authoritative provider operation). The gate closes that
   * window at the architecture level:
   *
   *   - the WHERE clause carries the EXACT lease identity (`claim_owner` +
   *     `claim_epoch` + not discharged): an actor whose lease was reclaimed
   *     affects 0 rows → returns FALSE → the caller aborts
   *     'claim-fence-lost' BEFORE the provider call (zero provider
   *     operations from a fenced-out actor);
   *   - a FRESH gate (dispatch_state IS NULL) opens at the caller's epoch;
   *   - a STALE in-flight gate (dispatch_state = 'in_flight' AND
   *     dispatch_epoch < the caller's epoch — a crashed/stalled owner that
   *     crossed but never completed) is TAKEN OVER by the new lease (the
   *     epochs are monotonic fencing tokens — a new lease always out-ranks
   *     an older in-flight dispatch; liveness: an interrupted dispatch can
   *     never deadlock the gate);
   *   - a COMPLETED gate is never re-entered (the outcome write is atomic
   *     with completion — see {@link completeFencedDispatch}).
   *
   * PR #46 round 7: the gate-open ALSO records the DURABLE DISPATCH
   * IDEMPOTENCY KEY (migration 0047's `dispatch_idempotency_key` column) in
   * the SAME atomic UPDATE — the durable record that this dispatch's
   * provider operation is identified by the LOGICAL HANDOFF IDENTITY (the
   * key is derived from the handoff id — NEVER from the volatile lease
   * owner/epoch — so the original owner, a reclaiming owner, and a
   * crash-recovery re-dispatch all record + submit under the SAME key, and
   * the provider boundary CONVERGES their submits onto ONE operation).
   */
  beginFencedDispatch(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    dispatchIdempotencyKey: string,
  ): Promise<boolean>;
  /**
   * PR #46 round 6 (the side-effect-boundary fencing fix): COMPLETE the
   * fenced dispatch — the gate CAS AND the AUTHORITATIVE OUTCOME WRITE on
   * `wfos_executions` in ONE transaction (mirrors updateStatus semantics:
   * `status` is set; agent_run_id/package_json/started_at/completed_at/
   * expires_at COALESCE; benchmark_metadata is jsonb-merged). Called by the
   * dispatch boundary AFTER the provider submit, with the submission's
   * outcome payload.
   *
   * The transaction is the side-effect boundary itself:
   *   - the gate CAS requires the gate to still be 'in_flight' at THIS
   *     actor's owner + epoch AND the lease to still be owned by THIS actor
   *     (`claim_owner` + `claim_epoch` + not discharged);
   *   - 0 rows → FALSE → the transaction ROLLED BACK — NO outcome write
   *     happened. A stale actor whose lease was reclaimed mid-dispatch
   *     (the architect's round-6 interleaving: T1 passes the fence → T1
   *     stalls during the dispatch → the lease expires → T2 reclaims → T2
   *     completes the dispatch → T1 resumes) CANNOT commit its
   *     already-computed outcome: not a duplicate success write, and not
   *     the legacy failure-clobber either;
   *   - 1 row → TRUE → the outcome write committed in the SAME transaction
   *     — `dispatch_state = 'completed'` is the durable proof the
   *     authoritative provider outcome landed exactly once.
   */
  completeFencedDispatch(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    executionRecordId: string,
    outcome: CrossModeHandoffFencedDispatchOutcome,
  ): Promise<boolean>;
}

/**
 * PR #46 round 6: the authoritative provider-dispatch OUTCOME payload written
 * by {@link CrossModeHandoffRepository.completeFencedDispatch} in the SAME
 * transaction as the dispatch-gate completion. Field semantics mirror
 * {@link ExecutionRecordRepository.updateStatus}: `status` is always set;
 * the optional fields COALESCE (null keeps the current column value);
 * `benchmarkMetadata` is MERGED over the current row.
 */
export interface CrossModeHandoffFencedDispatchOutcome {
  /** The post-dispatch execution status (always written). */
  readonly status: ExecutionState;
  /** The native dispatch's AgentRun id (COALESCE — null keeps the current). */
  readonly agentRunId?: string | null;
  /** The external dispatch's package (COALESCE — null keeps the current). */
  readonly packageValue?: ExternalExecutionPackage | null;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly expiresAt?: Date | null;
  /** Merged over the record's current benchmark_metadata (jsonb ||). */
  readonly benchmarkMetadata?: Record<string, unknown> | null;
}

/**
 * PR #46 round 4 + round 5: the durable claim owner ROLE PREFIXES. The
 * synchronous caller path composes its owner from
 * {@link CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX}; the relay reconcile
 * path composes its owner from
 * {@link CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX}.
 *
 * PR #46 round 5 (the lease-ownership fix): these constants are PREFIXES,
 * NOT complete owner identities. The persisted `claim_owner` must identify
 * the INDIVIDUAL LEASE HOLDER, not merely its role — every invocation
 * composes a unique owner via {@link newCrossModeHandoffClaimOwner}
 * (`<role-prefix>:<uuid>`). With a reclaimable lease, a fixed per-role
 * owner string was UNSAFE: an old invocation could outlive its expired
 * lease, a new invocation of the SAME role could reclaim under the SAME
 * owner string, and the old invocation's owner-guarded `finally` release
 * would then clear the NEW owner's live claim (the serialization boundary
 * was gone). Unique per-invocation owners make a stale release structurally
 * unable to clear a newer owner's claim (different owner strings), and the
 * role prefix is retained purely for diagnostics.
 */
export const CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX = 'cross-mode-handoff-caller';
export const CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX = 'cross-mode-handoff-relay';

/**
 * PR #46 round 5: generate a UNIQUE claim owner for ONE logical invocation
 * of the handoff critical section (the caller path or the relay reconcile
 * path). The returned owner is `<rolePrefix>:<randomUUID>` — the role prefix
 * is diagnostics-only; the UUID identifies the individual lease holder.
 *
 * The service MUST capture the generated owner ONCE at the beginning of the
 * critical section and reuse the EXACT value for the claim, the fence
 * checks (renewal), and the `finally` release — see migration 0045 + the
 * `claim_epoch` fencing token for the full lease-ownership model.
 */
export function newCrossModeHandoffClaimOwner(rolePrefix: string): string {
  return `${rolePrefix}:${randomUUID()}`;
}

/**
 * PR #46 round 4: the default claim lease duration (30s). The caller's
 * critical section is ms-scale (mutate + dispatch + session + enqueue),
 * but 30s covers a slow provider dispatch. PR #46 round 5: the lease no
 * longer relies on being longer than the critical section — the heartbeat
 * renewal (every lease/3) keeps a LIVE owner's lease from expiring
 * mid-flight, and the epoch fence rejects a STALLED owner's authoritative
 * mutations after a reclaim. A crashed owner's lease auto-expires after
 * this duration — the boot sweep reclaims + recovers. Tests override this
 * via `DefaultCrossModeHandoffServiceDeps.handoffClaimLeaseMs` to exercise
 * crash-reclaim + fence-loss quickly.
 */
export const CROSS_MODE_HANDOFF_DEFAULT_CLAIM_LEASE_MS = 30_000;

/**
 * PR #46 review #2: one pending cross-mode-handoff obligation (the durable
 * replay work list). The {@link executionId} is the LOGICAL identity (TEXT
 * `wf_xxxxxxxx`) the reconciliation consumes; the {@link handoffId} is the
 * append-only handoff log row the obligation tracks.
 */
export interface PendingCrossModeHandoff {
  /** The append-only handoff log row UUID (the obligation's UNIQUE key). */
  readonly handoffId: string;
  /** The LOGICAL execution identity (TEXT) — the relay payload + the reconcile key. */
  readonly executionId: string;
  /** The obligation row UUID (for audit / discharge tracing). */
  readonly obligationId: string;
}

/**
 * The cross-mode handoff boundary. ONE logical execution is preserved; the
 * service transitions the existing ExecutionRecord's mode + status + provider
 * fields, dispatches through the EXISTING NativeExecutionProvider /
 * ExternalExecutionProvider, and writes the append-only handoff log row + an
 * audit event. It NEVER creates a second ExecutionRecord, NEVER touches
 * workflow/verification/review state, and NEVER persists secrets.
 */
export interface CrossModeHandoffService {
  handoff(
    executionId: string,
    input: CrossModeHandoffInput,
    actor: { userId: string; source: string },
  ): Promise<CrossModeHandoffResult>;
  /**
   * PR #46 review correction #2 (durable crash recovery): the idempotent
   * reconciliation entry point driven by the durable relay job + the
   * WorkerHost boot sweep (wired in app.ts via the
   * {@link CrossModeHandoffOutboxRelay} + {@link createCrossModeHandoffRelayJobHandler}).
   * Resumes an interrupted handoff from the appropriate step:
   *     - record.mode !== toMode → re-mutate + re-dispatch (crash window #1:
   *       after reserve, before mutate);
   *     - record.mode === toMode but dispatch outcome missing → re-dispatch
   *       (crash window #2: after mutate, before dispatch);
   *     - complete → discharge the obligation + no-op.
   * A complete handoff is a no-op. Mirrors
   * {@link DefaultExecutionSessionService.reconcileTerminalForExecution}.
   * The relay is NOT optional: the obligation row (migration 0043) is the
   * durable source of truth, and the boot sweep guarantees eventual
   * delivery — a caller retry cannot substitute for durable recovery.
   */
  reconcileCrossModeHandoffForExecution(executionId: string): Promise<unknown>;
}

/**
 * Typed cross-mode-handoff failure — the route maps `code` to an HTTP status.
 * Mirrors the {@link ExecutionHandoffError} constructor shape (message + a
 * stable machine-readable `code`). The internal-only code
 * 'cross-mode-handoff-already-exists' (the repository's 23505 surface) is
 * handled by the service and never reaches the route.
 */
export class CrossModeHandoffError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'execution-not-found'
      | 'already-handed-off'
      | 'invalid-target-mode'
      | 'handoff-ineligible-state'
      | 'handoff-policy-denied'
      | 'handoff-policy-approval-required'
      | 'native-provider-unavailable'
      | 'handoff-dispatch-failed'
      // PR #46 round 5: the claim/lease fence was lost mid-critical-section
      // (the lease expired + another actor reclaimed it while this actor was
      // stalled). The stale actor aborts BEFORE further mutations/dispatch;
      // the route maps it to 409 (a concurrent actor owns the obligation —
      // the client can retry + converge on the owner's completed state).
      | 'claim-fence-lost'
      // WORK-043 (§33.3): the RESOLVED destination candidate (provider +
      // model + mode) failed the full constraint-engine re-eligibility
      // (quota, rate limits, security, capability, subscription, project
      // policy...) or the evaluation itself failed (fail-closed). The route
      // maps it to 409 — the logical task cannot continue on this
      // destination under the current constraints; every blocking reason is
      // named in the message.
      | 'handoff-ineligible-destination'
      // WORK-043 round 4 (AR-043-05 — the dispatch admission boundary): the
      // dispatch was NOT ADMITTED at the mutation boundary — an active
      // project quota/rate limit would be exceeded. The advisory
      // eligibility verdict passed earlier; the HARD boundary rejected at
      // beginFencedDispatch (before any provider call). The route maps it
      // to 429 (retryable); the obligation stays PENDING for the reconcile.
      | 'handoff-admission-rejected'
      // Internal-only: the repository's 23505 surface (the service catches +
      // re-resolves convergence; never reaches the route).
      | 'cross-mode-handoff-already-exists'
      // Reserved: the route maps a non-external record on the external-handoff
      // token path to this (mirrors 'not-external-execution'). Not thrown by
      // the service today; the route maps it to 409.
      | 'cross-mode-handoff-not-external',
  ) {
    super(message);
    this.name = 'CrossModeHandoffError';
  }
}

/** The stable error-code vocabulary (IMPL-2 static-arch invariant). */
export const CROSS_MODE_HANDOFF_ERROR_CODES = [
  'execution-not-found',
  'already-handed-off',
  'invalid-target-mode',
  'handoff-ineligible-state',
  'handoff-policy-denied',
  'handoff-policy-approval-required',
  'native-provider-unavailable',
  'handoff-dispatch-failed',
  'claim-fence-lost',
  // WORK-043 (§33.3): the destination candidate failed the full
  // constraint-engine re-eligibility (or the evaluation failed — fail-closed).
  'handoff-ineligible-destination',
  // WORK-043 round 4 (AR-043-05): the dispatch was NOT ADMITTED at the
  // dispatch mutation boundary — an active project quota/rate limit would
  // be exceeded by this dispatch (advisory eligibility passed earlier; the
  // HARD admission boundary rejected at the gate). Retryable: the quota
  // period / rate window rolls or a concurrent dispatch's reservation
  // completes; the obligation stays PENDING for the reconcile.
  'handoff-admission-rejected',
  'cross-mode-handoff-already-exists',
  'cross-mode-handoff-not-external',
] as const;

/** The stable cross-mode-handoff error-code type (the route maps it to HTTP). */
export type CrossModeHandoffErrorCode =
  (typeof CROSS_MODE_HANDOFF_ERROR_CODES)[number];

/**
 * PR #46 review correction #2 (durable crash recovery): the durable relay
 * job type for the cross-mode-handoff reconciliation relay (mirrors
 * SESSION_TERMINAL_RELAY_JOB_TYPE + WORKSPACE_RELEASE_RELAY_JOB_TYPE). The
 * relay job handler ({@link createCrossModeHandoffRelayJobHandler}) is
 * registered in the WorkerHost's HandlerRegistry at composition time; the
 * boot sweep ({@link CrossModeHandoffOutboxRelay}) is registered in
 * `WorkerHostOptions.outboxRelays`. The obligation row (migration 0043) is
 * created ATOMICALLY with the reserve by an AFTER INSERT trigger — the
 * relay + the boot sweep guarantee eventual delivery of an interrupted
 * handoff (a caller retry cannot substitute for durable recovery).
 */
export const CROSS_MODE_HANDOFF_RELAY_JOB_TYPE = 'agents.cross-mode-handoff.reconcile';
