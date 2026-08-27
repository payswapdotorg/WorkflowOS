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
   * Returns `{ handoff, claimed: true }` on the happy path (the obligation
   * is freshly created by the trigger, so the claim UPDATE always matches
   * within the transaction). On a 23505 UNIQUE violation, the transaction
   * rolls back (claim not applied) + the error is mapped to
   * 'cross-mode-handoff-already-exists' — the service re-queries for
   * idempotent convergence (returning `{ handoff: existing, claimed: false }`).
   * The caller MUST release the claim via
   * {@link releaseHandoffObligationClaim} after its critical section
   * (success OR failure — the lease auto-expires as a crash backstop).
   */
  createHandoffAndClaim(
    input: CreateCrossModeHandoffInput,
    owner: string,
    leaseMs: number,
  ): Promise<{ handoff: CrossModeHandoffRecord; claimed: boolean }>;
  /**
   * PR #46 round 4: claim an EXISTING obligation for the reconcile critical
   * section (the relay / boot-sweep path). A single conditional UPDATE
   * serializes concurrent actors: the WHERE clause
   * `discharged_at IS NULL AND (claimed_at IS NULL OR claim_expires_at < NOW())`
   * is the reclaim predicate — only one actor's UPDATE matches (PostgreSQL
   * row-locks the obligation row for the duration of the conflicting UPDATE;
   * the second actor's WHERE re-evaluates after the first commits + sees a
   * claimed row → 0 rows). Returns `{ claimed: true }` on success or
   * `{ claimed: false, activeOwner }` when another actor holds a live claim
   * (the reconcile returns early — NO mutate, NO dispatch — preventing two
   * concurrent handoff drivers). A crashed owner's expired lease is
   * reclaimable (the `claim_expires_at < NOW()` arm).
   */
  claimHandoffObligation(
    handoffId: string,
    owner: string,
    leaseMs: number,
  ): Promise<{ claimed: true } | { claimed: false; activeOwner: string | null }>;
  /**
   * PR #46 round 4: release the claim (clear claimed_at/claim_expires_at/
   * claim_owner). Called by the caller + the reconcile in a `finally` block
   * after their critical section (success OR failure). The `claim_owner`
   * guard ensures only the owner can release (defensive). A no-op when the
   * obligation was discharged (the `discharged_at IS NULL` guard) or the
   * claim already expired/released — both return false (not an error).
   */
  releaseHandoffObligationClaim(handoffId: string, owner: string): Promise<boolean>;
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
   * PR #46 review #2: idempotently discharge a cross-mode-handoff obligation
   * (set discharged_at). Called by the reconciliation when it confirms the
   * handoff is complete. A repeated discharge is a no-op (the obligation is
   * append-only; only the discharge column changes).
   */
  dischargeHandoffObligation(handoffId: string): Promise<boolean>;
}

/**
 * PR #46 round 4: the durable claim owner identifiers. The synchronous
 * caller uses {@link CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER}; the relay
 * reconcile uses {@link CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER}. Distinguishing
 * the owner makes the claim-lost diagnostics + the release guard explicit
 * (only the owner can release its own claim). The claim/lease columns +
 * the conditional UPDATE are the serialization boundary — see migration
 * 0044 + {@link CrossModeHandoffRepository.claimHandoffObligation}.
 */
export const CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER = 'cross-mode-handoff-caller';
export const CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER = 'cross-mode-handoff-relay';

/**
 * PR #46 round 4: the default claim lease duration (30s). The caller's
 * critical section is ms-scale (mutate + dispatch + session + enqueue),
 * but 30s covers a slow provider dispatch. A crashed owner's lease
 * auto-expires after this duration — the boot sweep reclaims + recovers.
 * Tests override this via `DefaultCrossModeHandoffServiceDeps.handoffClaimLeaseMs`
 * to exercise crash-reclaim quickly.
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
