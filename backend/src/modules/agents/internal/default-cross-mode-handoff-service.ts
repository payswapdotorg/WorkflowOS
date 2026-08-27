/**
 * WORK-042: DefaultCrossModeHandoffService.
 *
 * The cross-mode handoff boundary. ONE logical ExecutionRecord is preserved
 * (identity); the service transitions the existing record's `mode` + `status`
 * + the mode-specific authoritative fields, dispatches through the EXISTING
 * NativeExecutionProvider / ExternalExecutionProvider, and writes the
 * append-only handoff log row + an audit event.
 *
 * FLOW (per the WORK-042 plan):
 *   1. resolve record (findByExecutionId) -> 404 if absent.
 *   2. validate targetMode is native|external.
 *   3. validate targetMode != record.mode (a handoff must change mode).
 *   4. validate eligibility (the from-mode + status preconditions).
 *   5. idempotency check (findByIdempotencyKey + findByExecutionId).
 *   6. policy-gate (external -> agentPolicyEngine.evaluateExternalHandoff;
 *      native -> executionPolicy native_execution_allowed + registry native
 *      provider availability — fail-closed).
 *   7. resolve provider/model for the target.
 *   8. reserve + claim: INSERT append-only handoff log row (previous_*
 *      snapshot + idempotency_key) AND claim the durable obligation in ONE
 *      transaction (PR #46 round 4 — the claim is the serialization
 *      boundary shared by the caller + the relay; closes the boot-sweep
 *      race between reserve and the caller's mutation). Catch 23505 ->
 *      converge (same key, claimed:false) / reject (diff key). migration
 *      0043's AFTER INSERT trigger writes the durable handoff obligation
 *      ATOMICALLY with the reserve INSERT; migration 0044 adds the claim
 *      columns + the conditional UPDATE claim predicate.
 *   9-10. mutate record (transitionMode mode+status) THEN drive the session
 *        through the EXISTING non-terminal path THEN dispatch (provider
 *        submit) THEN updateStatus (provider outcome) — crash-safety: a crash
 *        after mutate but before dispatch is recoverable (retry sees the
 *        mutated record + re-dispatches); a crash after dispatch converges
 *        (the agentRunRepository.findByExecutionId guard skips a second
 *        AgentRun for external->native; the ExternalExecutionProvider
 *        regenerates the package idempotently for native->external).
 *        PR #46 round 4: the claim covers this whole critical section — a
 *        concurrent reconcile sees a CLAIMED obligation + returns early
 *        (NO re-mutate, NO re-dispatch). The `finally` releases the claim
 *        (success OR failure).
 *   10b. enqueue the durable relay job (PR #46 round 3 — the concurrency fix:
 *        enqueue AFTER the mutation+dispatch+session, NOT before — a live
 *        WorkerHost that picks up the job sees a COMPLETE handoff + the
 *        reconcile is a no-op discharge; the boot sweep is the recovery path
 *        for a crash between reserve and this enqueue).
 *   11. audit (best-effort — try/catch, never breaks flow).
 *   12. return { executionId, handoff, record (re-fetch) }.
 *
 * CONCURRENCY: the handoff log table UNIQUE(execution_record_id) is the hard
 * fence against a SECOND handoff for the same execution. The durable claim/
 * lease (migration 0044) is the serialization boundary for the
 * mutation/session/dispatch critical section — the caller + the relay
 * reconcile use the SAME claim primitive so a concurrent boot-sweep/relay
 * cannot re-mutate + re-dispatch the same obligation while the caller holds
 * the claim (PR #46 round 4 — the architect's required durable serialization
 * boundary). A crashed owner's lease auto-expires (claim_expires_at < NOW())
 * + the boot sweep reclaims + recovers.
 *
 * PR #46 round 5 (the lease-ownership + lease-expiry fixes):
 *   - the claim owner is a UNIQUE per-invocation identity
 *     (`<role-prefix>:<uuid>` — never a shared role constant): a stale
 *     invocation's owner+epoch-guarded `finally` release can NEVER clear a
 *     newer owner's live claim;
 *   - the lease is renewed by a HEARTBEAT (every claimLeaseMs/3) across the
 *     ENTIRE critical section — a LIVE owner's lease cannot expire
 *     mid-flight (a slow provider dispatch no longer forfeits the claim);
 *   - every claim increments claim_epoch (the fencing token — migration
 *     0045): a STALLED owner (heartbeat dead) whose expired lease was
 *     reclaimed fails its phase-boundary fence checks (the renewal's
 *     owner+epoch predicate returns 0 rows) + its discharge is REJECTED at
 *     the DB — it aborts with 'claim-fence-lost' BEFORE further side
 *     effects (zero duplicate dispatch / session transitions);
 *   - a CRASHED owner's lease still auto-expires + the boot sweep reclaims
 *     + recovers (the round-4 semantics are preserved).
 *
 * PR #46 round 6 (the side-effect-boundary fencing fix): the round-5
 * phase-boundary `ensureFence()` runs BEFORE the side-effecting provider
 * call, not ATOMICALLY with it — an owner that passed the pre-call check
 * and then stalled (heartbeat dead) could resume after a reclaim and
 * complete its ALREADY-STARTED dispatch (a second authoritative provider
 * operation). The DISPATCH SIDE-EFFECT BOUNDARY itself is now fenced
 * (migration 0046's dispatch gate on the obligation row):
 *   - beginFencedDispatch: the lease fence (owner + epoch) evaluated
 *     ATOMICALLY with the durable dispatch intent, BEFORE the provider
 *     submit — a fenced-out actor never reaches the provider;
 *   - completeFencedDispatch: the gate CAS AND the authoritative outcome
 *     write on wfos_executions in ONE transaction — a stale actor's
 *     resumed, already-started dispatch CANNOT commit its outcome (0 rows →
 *     rollback → NO write: neither a duplicate success NOR a failure
 *     clobber);
 *   - the provider call itself may still be duplicated across a stall (a
 *     non-transactional submit cannot be un-sent), but it converges to ONE
 *     authoritative operation: the external provider is a deterministic
 *     pure function (the outcome write is the authoritative operation —
 *     fence-gated); the native gateway's wfos_agent_runs.execution_id
 *     UNIQUE makes the run structurally singular + the colliding submit
 *     CONVERGES to the existing run (conflict recovery) instead of writing
 *     a stale failure;
 *   - an interrupted in-flight gate (a crashed/stalled owner that crossed
 *     but never completed) is TAKEN OVER by the next (monotonic) lease —
 *     liveness: an interrupted dispatch can never deadlock the gate.
 *
 * PR #46 round 7 (the provider-operation exactly-once boundary): the round-6
 * review REJECTED the "the provider call may still be duplicated, but it
 * converges to ONE authoritative operation" framing — the DB outcome being
 * singular does NOT make the PROVIDER OPERATION exactly-once: the submit runs
 * OUTSIDE the DB transaction, so a lease reclaimed while the first submit is
 * still in flight let the reclaiming owner's take-over re-dispatch start a
 * SECOND provider operation (two in-flight submits for ONE logical handoff).
 * The correction adopts the architect's contract option 1 — the exactly-once
 * side-effect boundary via a DURABLE IDEMPOTENCY KEY (migration 0047):
 *   - the dispatch derives `cross-mode-dispatch-<handoffId>` — from the
 *     LOGICAL HANDOFF IDENTITY ONLY (NEVER the volatile lease owner/epoch),
 *     so the original owner, a reclaiming owner, + a crash-recovery
 *     re-dispatch all derive the SAME key;
 *   - the key is recorded DURABLY, atomically with the gate-open
 *     (beginFencedDispatch's UPDATE also sets dispatch_idempotency_key), and
 *     stamped on the submitted ExecutionTask;
 *   - the provider boundary CONVERGES same-key submits onto ONE operation:
 *     the ExternalExecutionProvider's keyed registry returns the REGISTERED
 *     (first-generation) submission; the NativeExecutionProvider converges a
 *     keyed dispatch whose run already exists onto that run (no gateway
 *     call, no second adapter invocation) + a creation collision converges
 *     the loser to the winner's run — the convergence is a CONTRACT, not a
 *     determinism accident;
 *   - the round-6 fence + gate are RETAINED: even a converged submission
 *     commits its outcome ONLY through completeFencedDispatch (the lease
 *     owner wins; a stale actor's completion affects 0 rows).
 *
 * This file is private to /agents (PLAT-AC-02). It composes the EXISTING
 * boundaries — it is NOT an ExecutionService, it NEVER creates a second
 * ExecutionRecord, and it NEVER touches wfos_workflow_*, wfos_verification_*,
 * wfos_reviews_*.
 */
import type { Logger } from '@platform/logger.js';
import type { Queue } from '@platform/index.js';
import type { AuditService } from '@modules/audit/index.js';
// Type-only cross-module import (the work-items barrel re-imports the agents
// barrel for ExecutionTask/ExecutionMode; a runtime cycle is impossible — the
// type-only import is erased at compile time). Mirrors how DefaultExecutionService
// is composed (the start-implementation path consumes ExecutionTaskService).
import type {
  ExecutionTaskService,
} from '@modules/work-items/index.js';
import type {
  ExecutionMode,
  ExecutionRecord,
  ExecutionRecordRepository,
  ExecutionProvider,
} from './execution.types.js';
import type { AgentRunRepository } from './agent.types.js';
// PR #46 review #3: the WORK-034 ExecutionSession lifecycle port — the
// service resolves the session + drives it through the EXISTING non-terminal
// `interrupted` path on a cross-mode handoff (NEVER silently continues a
// terminal session). Type-only import (no runtime cycle — the agents barrel
// re-exports the same names for the composition root).
import type {
  ExecutionSession,
  SessionTransitionResult,
} from './execution-session.types.js';
// PR #46 review #1: the WORK-035 AgentWorkspace port — the service resolves
// the workspace + defends the physical-worktree continuity (rejects a terminal
// workspace whose working-tree state is gone).
import type { AgentWorkspace } from './agent-workspace.types.js';
// Reuse the existing narrow policy-evaluator port (DI cleanliness — mirrors
// the PolicyGatedExecutionHandoffService decorator precedent).
import type { AgentPolicyHandoffEvaluator } from './policy-gated-handoff-service.js';
// The frozen external-UI catalog (the agents catalog — provider names here are
// NOT hard-coded outside the catalog; the catalog IS the catalog). Used to
// resolve the default external provider when the caller omits `provider`.
import { EXTERNAL_UI_CATALOG } from './agent-provider-registry.types.js';
import type {
  CreateCrossModeHandoffInput,
  CrossModeHandoffInput,
  CrossModeHandoffRecord,
  CrossModeHandoffRepository,
  CrossModeHandoffResult,
  CrossModeHandoffService,
} from './cross-mode-handoff.types.js';
import { CrossModeHandoffError } from './cross-mode-handoff.types.js';
// PR #46 review #2: the durable relay job type (the claim-time enqueue at
// reserve — the boot sweep is the backstop; mirrors the WORK-034
// session-terminal relay's claim-time enqueue).
import { CROSS_MODE_HANDOFF_RELAY_JOB_TYPE } from './cross-mode-handoff.types.js';
// PR #46 round 4 + round 5: the durable claim/lease role prefixes + the
// default lease + the unique per-invocation owner generator. The caller +
// the relay reconcile use the SAME claim primitive (migration 0044 + the
// epoch fence in 0045) so the mutation/session/dispatch critical section is
// serialized — a concurrent boot-sweep/relay cannot re-mutate + re-dispatch
// the same obligation while the caller holds the claim (the round-4
// boot-sweep race). PR #46 round 5: every invocation composes a UNIQUE
// owner (`<role-prefix>:<uuid>`) so a stale invocation can never release a
// newer owner's claim (the round-5 lease-ownership fix), and the heartbeat
// renewal + the epoch fence keep a live owner's lease from expiring
// mid-flight while rejecting a stalled owner's authoritative mutations
// after a reclaim (the round-5 lease-expiry fix).
import {
  CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX,
  CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX,
  CROSS_MODE_HANDOFF_DEFAULT_CLAIM_LEASE_MS,
  newCrossModeHandoffClaimOwner,
} from './cross-mode-handoff.types.js';

/**
 * Narrow execution-policy port (DI cleanliness — the agents module does NOT
 * import the execution-policy module at runtime; the composition root passes
 * the concrete ExecutionPolicyService, which structurally satisfies this
 * port). Returns only the fields the cross-mode handoff needs for the native
 * native_execution_allowed gate.
 */
export interface CrossModeExecutionPolicyPort {
  getProjectPolicy(
    projectId: string,
  ): Promise<{ nativeExecutionAllowed: boolean; policyVersion: number | null } | null>;
  /**
   * WORK-043 (§33.3): the point-in-time destination-candidate eligibility
   * seam (the full constraint engine — quota, rate limits, security,
   * subscription, capability, project policy — evaluated against the
   * RESOLVED destination provider+model+mode at handoff time). OPTIONAL so
   * pre-WORK-043 fakes/ports still satisfy the interface; the destination
   * gate is skipped when absent (the composition root always wires it).
   */
  evaluateCandidateEligibility(input: {
    organizationId: string;
    projectId: string;
    workItemId: string;
    provider: string;
    model: string | null;
    executionMode: 'native' | 'external';
    userId?: string | null;
  }): Promise<{
    eligibility: {
      status: string;
      eligible: boolean;
      blockingReasons: readonly {
        category: string;
        constraint: string;
        reason: string;
      }[];
    };
    policyVersion: number;
  }>;
}

/**
 * Narrow agent-provider-registry port (DI cleanliness). The concrete
 * DefaultAgentProviderRegistryService (no separate interface) satisfies this
 * structurally. Used to resolve + validate the native provider availability
 * (fail-closed when no platform-native provider is configured).
 */
/** WORK-043: authoritative Project → Organization resolver. */
export interface CrossModeProjectOrganizationResolver {
  getOrganizationId(projectId: string): Promise<string | null>;
}

export interface CrossModeAgentProviderRegistryPort {
  /** The platform-default ready provider name (undefined when none is ready). */
  getPlatformDefaultProvider(): string | undefined;
  /** The platform-default model for the ready provider (undefined when none). */
  getPlatformDefaultModel(): string | undefined;
  /** Validate that a provider+model is configured (platform or project layer). */
  isProviderConfigured(
    provider: string,
    model: string,
    projectId?: string,
  ): Promise<boolean>;
}

/**
 * PR #46 review #3: the narrow WORK-034 ExecutionSession lifecycle port. The
 * concrete {@link DefaultExecutionSessionService} satisfies this structurally
 * (the composition root passes the concrete service). The cross-mode handoff:
 *   - resolves the session (getSessionForExecution) — if it is TERMINAL
 *     (completed/failed/cancelled), the handoff is REJECTED (a terminalized
 *     session is immutable per WORK-034 — it cannot be continued across a
 *     mode handoff; the correction history is preserved, start a new
 *     execution). NEVER silently continues a terminal session.
 *   - on native→external, interrupts a `running` session (running →
 *     interrupted) — the EXISTING non-terminal interruption path. The
 *     session-terminal obligation (if pending) is DEFERRED by the existing
 *     reconcile (it sees `interrupted` + leaves it pending). The session is
 *     NOT terminalized by the handoff.
 *   - on external→native, resumes an `interrupted` session (interrupted →
 *     running) or starts a `created` session (created → running) — the
 *     EXISTING resume path.
 */
export interface CrossModeExecutionSessionPort {
  getSessionForExecution(executionId: string): Promise<ExecutionSession | null>;
  interruptSession(
    sessionId: string,
    expectedVersion: number,
  ): Promise<SessionTransitionResult | null>;
  resumeSession(
    sessionId: string,
    expectedVersion: number,
  ): Promise<SessionTransitionResult | null>;
  startSession(sessionId: string): Promise<ExecutionSession | null>;
}

/**
 * PR #46 review #1: the narrow WORK-035 AgentWorkspace port. The concrete
 * {@link DefaultAgentWorkspaceService} satisfies this structurally. The
 * cross-mode handoff resolves the workspace — if it is TERMINAL
 * (released/failed/cancelled), the handoff is REJECTED (the physical
 * working-tree state is gone; the workspace-release obligation already
 * discharged + the worktree was removed). Otherwise the worktree is
 * PRESERVED: the workspace-release trigger fires ONLY on an execution
 * terminal transition (migration 0036), and a cross-mode handoff →
 * `handoff_ready`/`running` does NOT terminalize, so NO release obligation
 * is created. The NativeExecutionProvider delegates to the AgentGateway
 * which does NOT touch the workspace — so the worktree + uncommitted
 * working-tree state stay on disk across the handoff. The continuity is
 * EXPLICIT (resolved + asserted) + DEFENDED (terminal rejected), not just
 * an implicit reuse of executionId/branch.
 */
export interface CrossModeAgentWorkspacePort {
  getWorkspaceForExecution(executionId: string): Promise<AgentWorkspace | null>;
}

export interface DefaultCrossModeHandoffServiceDeps {
  readonly executionRecordRepository: ExecutionRecordRepository;
  readonly crossModeHandoffRepository: CrossModeHandoffRepository;
  readonly executionTaskService: ExecutionTaskService;
  readonly nativeExecutionProvider: ExecutionProvider;
  readonly externalExecutionProvider: ExecutionProvider;
  readonly agentRunRepository: Pick<AgentRunRepository, 'findByExecutionId'>;
  /** External-handoff eligibility (WORK-037) — the agent-policy engine port. */
  readonly agentPolicyEvaluator: AgentPolicyHandoffEvaluator;
  /** native_execution_allowed gate (WORK-033) — the execution-policy service. */
  readonly executionPolicyService: CrossModeExecutionPolicyPort;
  readonly organizationResolver: CrossModeProjectOrganizationResolver;
  /** Native provider availability (WORK-026) — the agent provider registry. */
  readonly agentProviderRegistryService: CrossModeAgentProviderRegistryPort;
  /** PR #46 review #3: the WORK-034 session lifecycle port. */
  readonly executionSessionService: CrossModeExecutionSessionPort;
  /** PR #46 review #1: the WORK-035 workspace port. */
  readonly agentWorkspaceService: CrossModeAgentWorkspacePort;
  readonly auditService: AuditService;
  readonly logger: Logger;
  /**
   * PR #46 review #2 (round 2) + round 3 (the concurrency fix): the existing
   * durable queue. The service enqueues the reconcile relay job AFTER the
   * mutation+dispatch+session convergence (NOT at reserve — round 3: a live
   * WorkerHost can consume a relay job the instant it is enqueued; enqueuing
   * at reserve created a race where a live worker reconciled BETWEEN the
   * reserve and the caller's transitionMode, after which BOTH performed the
   * same mutation+dispatch). The obligation row itself is written by
   * migration 0043's trigger ATOMICALLY with the reserve INSERT; the relay
   * job + the WorkerHost boot sweep are the liveness backstop (the boot sweep
   * is the recovery path for a crash between reserve and the post-mutation
   * enqueue). REQUIRED (Finding #1 round 2): the queue is no longer optional
   * — a missing or failed enqueue is a hard error (the handoff fails fast;
   * the obligation row is the durable source of truth; the boot sweep
   * reconciles on the next worker start). The production durability guarantee
   * no longer depends on a later boot sweep: either the enqueue succeeds (a
   * live worker drains the job without any restart) OR the handoff fails
   * fast (the caller sees the failure; the obligation is pending; the boot
   * sweep reconciles).
   */
  readonly queue: Queue;
  /**
   * PR #46 round 4: the claim lease duration in milliseconds. The claim
   * covers the caller's mutation/session/dispatch critical section (the
   * synchronous path) + the reconcile's re-mutate/re-dispatch critical
   * section (the relay path). A crashed owner's lease auto-expires after
   * this duration — the boot sweep reclaims + recovers (the
   * `claim_expires_at < NOW()` arm of the reclaim predicate). Defaults to
   * {@link CROSS_MODE_HANDOFF_DEFAULT_CLAIM_LEASE_MS} (30s). Tests override
   * this to a short value (e.g. 200ms) to exercise crash-reclaim quickly.
   *
   * PR #46 round 5: the lease duration alone is NO LONGER the correctness
   * argument (a critical section may legitimately exceed it — the round-5
   * second blocker). The correctness comes from the heartbeat renewal +
   * the epoch fence: a LIVE owner's heartbeat keeps the lease from
   * expiring; a STALLED owner (no heartbeat) loses the lease + its next
   * renew/discharge is rejected at the DB by the owner+epoch predicate.
   */
  readonly handoffClaimLeaseMs?: number;
  /**
   * PR #46 round 5: the claim lease HEARTBEAT interval in milliseconds —
   * how often the critical section's lease is renewed while it runs.
   * Defaults to `claimLeaseMs / 3` (renew three times per lease lifetime:
   * a slow-but-alive owner's lease never expires mid-critical-section).
   * Tests override this to a huge value to SUPPRESS the heartbeat (simulating
   * a stalled owner whose heartbeat stopped — the lease then expires + a
   * concurrent actor reclaims, proving the epoch-fence abort).
   */
  readonly handoffClaimHeartbeatMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

/** Eligible from-statuses for a native->external handoff. */
const NATIVE_TO_EXTERNAL_ELIGIBLE = new Set([
  'created',
  'queued',
  'running',
  'failed',
]);

/** Eligible from-statuses for an external->native handoff. */
const EXTERNAL_TO_NATIVE_ELIGIBLE = new Set([
  'handoff_ready',
  'submitted',
  'failed',
  'expired',
]);

/**
 * WORK-043: compose an additive verdict block into the policy summary JSON
 * (the summary is always this service's own JSON.stringify output — the
 * parse is safe; a defensive fallback keeps the original summary if a
 * future shape ever diverges). The composed summary lands on the
 * append-only handoff log row (policy_decision) + the audit event.
 */
function composeSummary(policySummary: string, block: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(policySummary) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, ...block });
  } catch {
    return policySummary;
  }
}

/**
 * PR #46 round 5: the in-flight claim lease guard — the heartbeat renewal +
 * the fence for ONE critical-section invocation. Created by
 * {@link DefaultCrossModeHandoffService.startClaimLease} after a successful
 * claim; the owner + claimEpoch are the EXACT lease identity captured once
 * at the beginning of the critical section (the claim result) and reused
 * for the renewal, the fence checks, the discharge, and the `finally`
 * release.
 */
interface ClaimLeaseGuard {
  readonly handoffId: string;
  /** The unique per-invocation owner (`<role-prefix>:<uuid>`). */
  readonly owner: string;
  /** The fencing token of THIS lease (migration 0045's claim_epoch). */
  readonly claimEpoch: number;
  /**
   * Explicit renewal — ALSO the fence check. TRUE when this lease still
   * owns the claim (the lease was extended); FALSE when the lease was
   * reclaimed by another actor (the caller MUST abort its critical
   * section) or the obligation was discharged.
   */
  renew(): Promise<boolean>;
  /**
   * Synchronous lost-flag — set when a heartbeat renewal definitively
   * failed (0 rows: the lease was reclaimed). Checked at every phase
   * boundary before any side effect.
   */
  isLost(): boolean;
  /** Stop the heartbeat timer (called in the critical section's `finally`). */
  stop(): void;
}

export class DefaultCrossModeHandoffService implements CrossModeHandoffService {
  private readonly now: () => Date;
  /** PR #46 round 4: the claim lease duration (defaults to 30s). */
  private readonly claimLeaseMs: number;
  /** PR #46 round 5: the heartbeat interval (defaults to claimLeaseMs / 3). */
  private readonly claimHeartbeatMs: number;

  constructor(private readonly deps: DefaultCrossModeHandoffServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.claimLeaseMs =
      deps.handoffClaimLeaseMs ?? CROSS_MODE_HANDOFF_DEFAULT_CLAIM_LEASE_MS;
    // PR #46 round 5: renew three times per lease lifetime so a live (but
    // slow) owner's lease never expires mid-critical-section.
    this.claimHeartbeatMs =
      deps.handoffClaimHeartbeatMs ?? Math.max(1, Math.floor(this.claimLeaseMs / 3));
  }

  async handoff(
    executionId: string,
    input: CrossModeHandoffInput,
    actor: { userId: string; source: string },
  ): Promise<CrossModeHandoffResult> {
    // 1. Resolve the record (404 if absent — the route layer also 404s, but
    //    the service re-resolves for defense-in-depth).
    const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
    if (!record) {
      throw new CrossModeHandoffError(
        `execution-not-found: ${executionId}`,
        'execution-not-found',
      );
    }

    // 2. Validate the target mode.
    if (input.targetMode !== 'native' && input.targetMode !== 'external') {
      throw new CrossModeHandoffError(
        `invalid-target-mode: targetMode must be 'native' or 'external' (got "${input.targetMode}")`,
        'invalid-target-mode',
      );
    }

    // 3. Idempotency + already-handed-off check (BEFORE the mode-change
    //    validation so a DUPLICATE request with the SAME idempotencyKey
    //    CONVERGES even when the record's mode has already been transitioned
    //    to the target mode by the first call — a retry must return the
    //    same result, not 'invalid-target-mode'). The default
    //    idempotencyKey is derived from executionId + targetMode so an
    //    omitted-key retry produces the same key (convergent); an explicit
    //    idempotencyKey asserts "this is the same logical request as
    //    before" (a duplicate converges).
    const idempotencyKey =
      input.idempotencyKey ?? `cross-mode-${executionId}-${input.targetMode}`;
    const existing = await this.deps.crossModeHandoffRepository.findByIdempotencyKey(
      idempotencyKey,
    );
    if (existing) {
      // Convergent retry — return the existing result (re-fetch the record).
      const current = await this.deps.executionRecordRepository.findByExecutionId(
        executionId,
      );
      this.deps.logger.info('cross-mode-handoff.convergent-retry', {
        executionId,
        idempotencyKey,
        handoffId: existing.id,
      });
      return {
        executionId,
        handoff: existing,
        record: current ?? record,
      };
    }
    const existingForExecution =
      await this.deps.crossModeHandoffRepository.findByExecutionId(executionId);
    if (existingForExecution && existingForExecution.idempotencyKey !== idempotencyKey) {
      throw new CrossModeHandoffError(
        `already-handed-off: execution ${executionId} already has a cross-mode handoff (idempotency_key ${existingForExecution.idempotencyKey}) — ONE handoff per execution (UNIQUE(execution_record_id))`,
        'already-handed-off',
      );
    }

    // 4. A handoff MUST change the mode (validated AFTER the idempotency
    //    check so a duplicate request with the same idempotencyKey does
    //    not throw 'invalid-target-mode' when the first call already
    //    transitioned the record to the target mode).
    if (input.targetMode === record.mode) {
      throw new CrossModeHandoffError(
        `invalid-target-mode: execution ${executionId} is already mode "${record.mode}" — a cross-mode handoff must change the mode`,
        'invalid-target-mode',
      );
    }

    // 5. Validate eligibility (the from-mode + status preconditions).
    this.assertEligible(record, executionId);

    // 5b. PR #46 review #1 + #3: the CONTINUITY gates. Resolve the existing
    //     AgentWorkspace + ExecutionSession for this logical execution. A
    //     TERMINAL workspace (released/failed/cancelled — the physical
    //     working-tree state is GONE) or a TERMINAL session (completed/failed/
    //     cancelled — WORK-034 immutability forbids continuing it) REJECTS
    //     the handoff: a terminalized execution cannot be handed off across
    //     modes (the correction history is preserved; start a new execution).
    //     A non-terminal / absent workspace + session is eligible — the
    //     worktree + session are PRESERVED across the handoff (the
    //     workspace-release trigger fires ONLY on an execution terminal; a
    //     handoff → handoff_ready/running does NOT terminalize). The session
    //     is driven through the EXISTING non-terminal `interrupted` path in
    //     mutateAndDispatch (NEVER silently continues a terminal session).
    const existingSession = await this.deps.executionSessionService.getSessionForExecution(
      executionId,
    );
    this.assertSessionContinuityEligible(existingSession, executionId);
    const existingWorkspace = await this.deps.agentWorkspaceService.getWorkspaceForExecution(
      executionId,
    );
    this.assertWorkspaceContinuityEligible(existingWorkspace, executionId);

    // 6. Policy-gate.
    const policySummary = await this.policyGate(record, executionId, input.targetMode);

    // 7. Resolve provider/model for the target.
    const { provider, model } = await this.resolveProviderModel(
      record,
      executionId,
      input,
    );

    // 7b. WORK-043 (§33.3): destination RE-ELIGIBILITY. The logical task
    //     continues in the OTHER mode; the RESOLVED destination candidate
    //     (provider + model + mode) must still clear the FULL constraint
    //     engine — quota, rate limits, security classification, capability,
    //     subscription, privacy, project policy — the SAME families the
    //     recommendation path evaluates BEFORE ranking. An ineligible
    //     destination rejects the handoff with every blocking reason named
    //     (the caller sees exactly WHY); an eligible verdict is composed into
    //     the policy summary recorded on the append-only handoff log row.
    //     This gate runs AFTER provider resolution (the verdict is about the
    //     CONCRETE destination) and BEFORE the reserve (no side effect has
    //     happened yet — the rejection is side-effect-free).
    const summaryWithDestination = await this.destinationEligibilityGate(
      record,
      executionId,
      input,
      provider,
      model,
      actor,
      policySummary,
    );

    // 8. Reserve + claim: INSERT the append-only handoff log row (previous_*
    //    snapshot) AND claim the durable obligation in ONE transaction (PR
    //    #46 round 4). migration 0043's AFTER INSERT trigger writes the
    //    obligation ATOMICALLY with the INSERT; the claim UPDATE is in the
    //    SAME transaction — a concurrent reconcile (boot sweep / relay)
    //    cannot see the obligation until the transaction commits, at which
    //    point the claim is already held. This closes the round-4 boot-sweep
    //    race (a reconcile that fired between the reserve commit and a
    //    separate claim commit could previously claim + re-mutate the same
    //    obligation while the caller was mid-mutation). The claim is the
    //    serialization boundary the caller + the relay SHARE — only the
    //    claim owner may perform the mutation/session/dispatch critical
    //    section. The obligation row is the durable source of truth — a
    //    crash after reserve+claim leaves a pending + claimed obligation
    //    whose lease auto-expires (the boot sweep reclaims + reconciles).
    const resultingStatus: 'handoff_ready' | 'running' =
      input.targetMode === 'external' ? 'handoff_ready' : 'running';
    // PR #46 round 5 (the lease-ownership fix): the claim owner is a UNIQUE
    // per-invocation identity (`cross-mode-handoff-caller:<uuid>`), captured
    // ONCE here — before the reserve+claim — and reused for the claim, the
    // heartbeat/fence checks, and the `finally` release. The role prefix is
    // diagnostics-only; the UUID identifies THIS invocation's lease. With
    // the reclaimable lease, a shared per-role owner string was UNSAFE: an
    // old invocation could outlive its expired lease, a new invocation of
    // the same role could reclaim under the SAME owner string, and the old
    // invocation's owner-guarded `finally` release would then clear the NEW
    // owner's live claim. Unique owners make that structurally impossible.
    const claimOwner = newCrossModeHandoffClaimOwner(
      CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX,
    );
    const { handoff: reserved, claimed, claimEpoch } = await this.reserveAndClaim({
      record,
      executionId,
      input,
      provider,
      resultingStatus,
      idempotencyKey,
      policySummary: summaryWithDestination,
      actor,
      claimOwner,
    });

    // PR #46 round 4: if the claim was NOT acquired (a concurrent path —
    // the boot sweep / a live relay job — already owns the obligation, OR
    // the reserve hit the idempotency UNIQUE + the original owner holds
    // the claim), the caller does NOT proceed to mutate. The claim owner
    // will complete the handoff; the caller converges by returning the
    // current state (the obligation row is the durable source of truth).
    // This is the structural prevention of two concurrent handoff drivers
    // (the architect's round-4 required correction).
    if (!claimed) {
      const current = await this.deps.executionRecordRepository.findByExecutionId(
        executionId,
      );
      this.deps.logger.info('cross-mode-handoff.claim-not-acquired', {
        executionId,
        handoffId: reserved.id,
      });
      return {
        executionId,
        handoff: reserved,
        record: current ?? record,
      };
    }

    // 9-10. Mutate (transitionMode) THEN drive the session through the
    //       EXISTING non-terminal path (interrupt on native→external; resume
    //       /start on external→native) THEN dispatch THEN updateStatus
    //       (provider outcome). Crash-safety: the mutated record is the
    //       recoverable intermediate state; the dispatch is idempotent on
    //       retry; the session transition is NOT best-effort (Finding #2
    //       round 2) — a failure PROPAGATES (the handoff fails fast; the
    //       obligation stays pending; the reconcile re-attempts the session
    //       transition until convergence — see crash window #3). A CAS loss
    //       (null result) is NOT an error (a concurrent path already moved
    //       the session; the convergence check re-evaluates on the next pass).
    //
    // PR #46 round 4: the claim (acquired atomically with the reserve
    //       above) covers this whole critical section. A concurrent
    //       reconcile that fires now sees a CLAIMED obligation → its claim
    //       attempt fails → it returns early (NO re-mutate, NO re-dispatch).
    //       The `finally` below releases the claim (success OR failure) so
    //       the relay job (enqueued next) can claim + converge. A crash
    //       between the claim + the release leaves the lease to auto-expire
    //       (the boot sweep reclaims after `claimLeaseMs`).
    // PR #46 round 5 (the lease-expiry fix): the heartbeat lease guard. The
    // claim was acquired atomically with the reserve above; the guard starts
    // a heartbeat timer that renews the lease every claimLeaseMs/3 for the
    // ENTIRE critical section — a LIVE owner's lease cannot expire
    // mid-flight (the round-5 second blocker: the fixed 30s lease could
    // previously expire under a legitimately slow dispatch, letting a second
    // actor reclaim + concurrently perform the same provider dispatch +
    // session transitions). The guard is stopped in the `finally`; a stalled
    // owner (no heartbeat) loses the lease + the phase-boundary fence checks
    // (see ensureFence) abort it before any further side effect.
    const lease = this.startClaimLease(reserved.id, claimOwner, claimEpoch);
    try {
      await this.mutateAndDispatch(
        record,
        executionId,
        input,
        provider,
        model,
        resultingStatus,
        existingSession,
        lease,
      );

      // 10b. PR #46 review #2 (round 2) + round 3 (the concurrency fix): the
      //      durable relay job enqueue — AFTER the mutation + session
      //      convergence + dispatch (NOT before). Round 3: the live WorkerHost
      //      can consume a relay job the instant it is enqueued. Enqueueing
      //      BEFORE the caller's synchronous mutation created a race — a live
      //      worker could reconcile (re-mutate + re-dispatch) BETWEEN the
      //      reserve and the caller's transitionMode, after which the caller
      //      performed its OWN mutation + dispatch (duplicate provider
      //      submission / conflicting session transitions). The handoff-row
      //      UNIQUE constraint did NOT serialize these two executions (both
      //      operated on the same already-reserved handoff row; it only fences
      //      creation of a SECOND handoff row). Now the relay job is enqueued
      //      ONLY AFTER the caller's synchronous state transition is safely
      //      committed: a live worker that picks up the job sees a COMPLETE (or
      //      near-complete) handoff + the reconcile is a no-op discharge (NOT a
      //      competing mutation). The boot sweep remains the recovery path for a
      //      crash between reserve and this enqueue (the obligation is pending;
      //      the next worker start reconciles). NOT best-effort (Finding #1
      //      round 2): the queue is REQUIRED + an enqueue failure PROPAGATES —
      //      the handoff fails fast; the obligation row (migration 0043's
      //      trigger, written ATOMICALLY with the reserve) is the durable source
      //      of truth; the boot sweep reconciles on the next worker start.
      //      PR #46 round 4: the claim is STILL held at enqueue time (the
      //      release happens in the `finally` after this). A worker that picks
      //      up the relay job in the microsecond window between enqueue + the
      //      finally release sees a CLAIMED obligation → its claim fails → it
      //      returns early (NO re-mutate). The boot sweep re-enqueues on the
      //      next worker start if that job was acked-and-gone. The durable
      //      obligation + the boot sweep are the liveness backstop; the claim
      //      is the correctness fence.
      await this.ensureFence(lease, 'relay-enqueue');
      await this.enqueueRelayJob(executionId);
    } finally {
      // PR #46 round 4 + round 5: release the claim (success OR failure).
      // The heartbeat is stopped first (no renewal can race the release).
      // On success, the relay job just enqueued will claim + converge (find
      // a complete handoff → discharge). On failure (mutate/dispatch/enqueue
      // threw), the obligation stays pending + the claim is released so the
      // boot sweep / relay can reclaim immediately (no lease wait). A crash
      // that skips this finally leaves the lease to auto-expire (the boot
      // sweep reclaims after `claimLeaseMs`). The release is guarded by the
      // EXACT lease identity (owner + epoch): if the lease expired + was
      // reclaimed while this invocation was stalled, the release is a NO-OP
      // (round 5: the stale invocation can NEVER clear the new owner's
      // live claim — the owner strings differ because every invocation's
      // owner is unique). The release is best-effort: a failure here is
      // logged + swallowed (the lease is the backstop).
      lease.stop();
      await this.releaseClaimSafely(reserved.id, claimOwner, claimEpoch);
    }

    // 11. Audit (best-effort).
    await this.audit(record, executionId, input, reserved, actor, summaryWithDestination);

    // 12. Return the post-handoff record (re-fetch).
    const finalRecord = await this.deps.executionRecordRepository.findByExecutionId(
      executionId,
    );
    return {
      executionId,
      handoff: reserved,
      record: finalRecord ?? record,
    };
  }

  /**
   * PR #46 review #2 (+ round 2): idempotent reconciliation — the durable
   * relay entry point (driven by the {@link CrossModeHandoffOutboxRelay}
   * job + the WorkerHost boot sweep, both wired in app.ts). A complete
   * handoff is a no-op + discharges the durable obligation; an interrupted
   * handoff resumes from the appropriate step:
   *   - record.mode !== toMode → re-mutate + re-dispatch (crash window #1:
   *     after reserve, before mutate);
   *   - record.mode === toMode but dispatch outcome missing → re-dispatch
   *     (crash window #2: after mutate, before dispatch);
   *   - record.mode === toMode + dispatch outcome present but session has
   *     NOT converged → re-attempt the session transition (crash window #3:
   *     after record mutate, before session transition — Finding #2 round 2).
   *     The obligation STAYS PENDING until the session converges.
   *   - complete → discharge + no-op.
   * Mirrors {@link DefaultExecutionSessionService.reconcileTerminalForExecution}.
   * The relay is NOT optional: the obligation row (migration 0043) is the
   * durable source of truth, and the boot sweep guarantees eventual delivery.
   */
  async reconcileCrossModeHandoffForExecution(executionId: string): Promise<unknown> {
    const handoff =
      await this.deps.crossModeHandoffRepository.findByExecutionId(executionId);
    if (!handoff) return null;
    let record = await this.deps.executionRecordRepository.findByExecutionId(
      executionId,
    );
    if (!record) return null;

    // PR #46 round 4 + round 5: claim the obligation for the reconcile
    // critical section. The claim is the SAME primitive the synchronous
    // caller uses (migration 0044 + the epoch fence in 0045) — only the
    // claim owner may perform the mutation/session/dispatch critical
    // section. A failed claim means the synchronous caller (or another
    // concurrent reconcile) holds the obligation; the relay returns early
    // (NO re-mutate, NO re-dispatch) — this is the structural prevention of
    // two concurrent handoff drivers (the architect's round-4 required
    // correction). The claim-lost return is NOT an error: the owner will
    // complete + discharge, OR the lease auto-expires + the next boot sweep
    // reclaims. The `finally` below releases the claim (success OR
    // failure). A crash that skips the finally leaves the lease to
    // auto-expire (the boot sweep reclaims).
    //
    // PR #46 round 5 (the lease-ownership fix): the claim owner is a UNIQUE
    // per-invocation identity (`cross-mode-handoff-relay:<uuid>`), captured
    // ONCE here + reused for the heartbeat/fence checks, the epoch-fenced
    // discharge, and the `finally` release — two relay deliveries NEVER
    // share an owner, so a stale delivery's release can never clear a
    // newer delivery's live claim.
    const claimOwner = newCrossModeHandoffClaimOwner(
      CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX,
    );
    const claim = await this.deps.crossModeHandoffRepository.claimHandoffObligation(
      handoff.id,
      claimOwner,
      this.claimLeaseMs,
    );
    if (!claim.claimed) {
      this.deps.logger.info('cross-mode-handoff.reconcile.claim-held', {
        executionId,
        handoffId: handoff.id,
        activeOwner: claim.activeOwner,
      });
      return { executionId, reconciled: false, stage: 'claim-held' };
    }
    // PR #46 round 5 (the lease-expiry fix): the heartbeat lease guard — the
    // renewal covers the ENTIRE reconcile critical section (a live relay
    // delivery's lease cannot expire mid-flight); the phase-boundary fence
    // checks + the epoch-fenced discharge abort a stalled delivery whose
    // lease was reclaimed.
    const lease = this.startClaimLease(handoff.id, claimOwner, claim.claimEpoch);
    try {
      // The ENTIRE existing round-2/3 reconcile body (re-mutate /
      // re-dispatch / session-convergence / discharge) runs UNDER the claim
      // — a concurrent caller / reconcile cannot interleave its own
      // mutation/dispatch on the same obligation. The `record` local is
      // nullable-typed (inferred from the fetch above) + narrowed by the
      // null check; re-fetches reassign nullable → nullable naturally.

      let stage: 'mutate-and-dispatch' | 'dispatch-external' | 'dispatch-native' | 'session-convergence' | 'complete' = 'complete';

      // Crash window #1: the mutate did not happen (record.mode !== toMode) →
      // re-mutate + re-dispatch. Re-fetch the record + fall through to the
      // complete-check (a single reconcile call drives the handoff to
      // completion when the dispatch is synchronous — the external package is
      // generated inline; the native AgentRun is created inline).
      if (record.mode !== handoff.toMode) {
        this.deps.logger.info('cross-mode-handoff.reconcile.re-mutate', {
          executionId,
          handoffId: handoff.id,
          currentMode: record.mode,
          toMode: handoff.toMode,
        });
        const session = await this.deps.executionSessionService.getSessionForExecution(
          executionId,
        );
        const input: CrossModeHandoffInput = {
          targetMode: handoff.toMode,
          reason: handoff.reason ?? undefined,
          idempotencyKey: handoff.idempotencyKey,
        };
        const resultingStatus: 'handoff_ready' | 'running' =
          handoff.toMode === 'external' ? 'handoff_ready' : 'running';
        // PR #46 round 5: the fence check BEFORE the re-mutate — if the lease
        // expired + was reclaimed while this delivery was stalled, abort
        // BEFORE any mutation (the reclaiming actor owns the obligation).
        await this.ensureFence(lease, 're-mutate');
        await this.mutateAndDispatch(
          record,
          executionId,
          input,
          record.provider,
          record.model,
          resultingStatus,
          session,
          lease,
        );
        stage = 'mutate-and-dispatch';
        record = await this.deps.executionRecordRepository.findByExecutionId(
          executionId,
        );
        if (!record) return { executionId, reconciled: true, stage };
      }

      // Crash window #2: the mutate happened but the dispatch did not. Re-fetch
      // the record's current state + re-dispatch the missing piece. PR #46
      // round 5: the fence check BEFORE each re-dispatch — a stalled delivery
      // (whose lease was reclaimed) aborts BEFORE the provider side effect.
      const targetMode = handoff.toMode;
      if (targetMode === 'external') {
        if (!record.packageValue) {
          this.deps.logger.info('cross-mode-handoff.reconcile.re-dispatch', {
            executionId,
            handoffId: handoff.id,
            targetMode,
          });
          await this.ensureFence(lease, 're-dispatch-external');
          // PR #46 round 6: the re-dispatch goes through the FENCED dispatch
          // boundary (beginFencedDispatch BEFORE the submit + the atomic
          // completeFencedDispatch outcome write) — a stalled delivery whose
          // lease was reclaimed mid-dispatch cannot complete a second
          // authoritative provider operation after the reclaim.
          await this.dispatchExternal(record, executionId, lease);
          stage = stage === 'complete' ? 'dispatch-external' : stage;
          record = await this.deps.executionRecordRepository.findByExecutionId(
            executionId,
          );
          if (!record) return { executionId, reconciled: true, stage };
        }
      } else {
        const existingRun = await this.deps.agentRunRepository.findByExecutionId(
          executionId,
        );
        const terminalNative =
          record.status === 'completed' || record.status === 'failed';
        if (!existingRun && !terminalNative) {
          this.deps.logger.info('cross-mode-handoff.reconcile.re-dispatch', {
            executionId,
            handoffId: handoff.id,
            targetMode,
          });
          await this.ensureFence(lease, 're-dispatch-native');
          // PR #46 round 6: the re-dispatch goes through the FENCED dispatch
          // boundary (see dispatchNative — the gateway submit is gated by
          // beginFencedDispatch + the outcome write is the atomic
          // completeFencedDispatch; a UNIQUE-colliding duplicate submit
          // CONVERGES to the existing run instead of clobbering).
          await this.dispatchNative(record, executionId, record.model, lease);
          stage = stage === 'complete' ? 'dispatch-native' : stage;
        }
      }

      // Crash window #3 (PR #46 review #2 round 2): the session has NOT
      // converged. Re-resolve the session + re-attempt the transition when
      // it has not converged. The obligation stays pending until the session
      // converges (the complete-check now includes session convergence —
      // see {@link handoffComplete}).
      const sessionForConvergence = await this.deps.executionSessionService.getSessionForExecution(
        executionId,
      );
      if (sessionForConvergence && !this.sessionConverged(sessionForConvergence, record, handoff)) {
        this.deps.logger.info('cross-mode-handoff.reconcile.re-session', {
          executionId,
          handoffId: handoff.id,
          sessionStatus: sessionForConvergence.status,
          toMode: handoff.toMode,
        });
        // PR #46 round 5: the fence check BEFORE the session transition — a
        // stalled delivery aborts BEFORE the WORK-034 session side effect.
        await this.ensureFence(lease, 'session-convergence');
        await this.transitionSessionForHandoff(
          sessionForConvergence,
          handoff.toMode,
          executionId,
        );
        stage = stage === 'complete' ? 'session-convergence' : stage;
      }

      // PR #46 review #2 (+ round 2) + round 5 (the epoch fence): complete —
      // discharge the durable obligation. The handoff is complete when:
      // record.mode === toMode + the dispatch outcome is present + the
      // session has converged. A complete handoff discharges (the
      // boot-sweep work list drains; a repeated recovery is a no-op). An
      // incomplete handoff leaves the obligation pending for the next pass.
      //
      // PR #46 round 5: the discharge is FENCED at the DB by the exact lease
      // identity (`claim_owner` + `claim_epoch` in the WHERE clause). A
      // FALSE result means this lease was reclaimed mid-flight (or the
      // obligation was already discharged by the reclaiming actor): the
      // stale delivery returns `fence-lost` WITHOUT treating the obligation
      // as complete — the new owner owns the completion.
      const complete = await this.handoffComplete(record, handoff);
      if (complete) {
        const discharged = await this.deps.crossModeHandoffRepository.dischargeHandoffObligation(
          handoff.id,
          lease.owner,
          lease.claimEpoch,
        );
        if (!discharged) {
          this.deps.logger.info('cross-mode-handoff.reconcile.fence-lost', {
            executionId,
            handoffId: handoff.id,
            owner: lease.owner,
            claimEpoch: lease.claimEpoch,
          });
          return { executionId, reconciled: false, stage: 'fence-lost' };
        }
        return { executionId, reconciled: false, stage: 'complete' };
      }
      return { executionId, reconciled: true, stage };
    } catch (err) {
      // PR #46 round 5: a phase-boundary fence check detected the lease was
      // reclaimed mid-flight (the stall-then-reclaim interleaving). NOT an
      // error: another actor owns the obligation + will complete it. Return
      // `fence-lost` (the relay job can ack — the obligation is in good
      // hands; the next sweep re-drives it if the new owner also fails).
      if (err instanceof CrossModeHandoffError && err.code === 'claim-fence-lost') {
        this.deps.logger.info('cross-mode-handoff.reconcile.fence-lost', {
          executionId,
          handoffId: handoff.id,
          owner: lease.owner,
          claimEpoch: lease.claimEpoch,
          phase: err.message,
        });
        return { executionId, reconciled: false, stage: 'fence-lost' };
      }
      throw err;
    } finally {
      // PR #46 round 4 + round 5: release the claim (success OR failure).
      // The heartbeat is stopped first (no renewal can race the release).
      // On success the obligation is discharged (the release's
      // `discharged_at IS NULL` guard makes it a no-op — not an error). On
      // failure the obligation stays pending + the claim is released so the
      // next sweep can reclaim immediately. A crash that skips this finally
      // leaves the lease to auto-expire (the boot sweep reclaims after
      // `claimLeaseMs`). The release is guarded by the EXACT lease identity
      // (owner + epoch): a stalled delivery whose lease was reclaimed can
      // NEVER clear the new owner's live claim (unique owner strings).
      lease.stop();
      await this.releaseClaimSafely(handoff.id, claimOwner, claim.claimEpoch);
    }
  }

  /**
   * PR #46 review #2 (+ round 2): the complete-check. The handoff is
   * complete when ALL of:
   *   - record.mode === toMode (the mutate landed), AND
   *   - the dispatch outcome is present: package for native→external,
   *     AgentRun-or-terminal for external→native, AND
   *   - the ExecutionSession has CONVERGED to the expected post-handoff
   *     state (Finding #2 round 2): a crash after the record mutation but
   *     before the session transition leaves the session in the pre-handoff
   *     state — the obligation MUST stay pending + the reconcile MUST
   *     re-attempt the session transition until convergence. Without this
   *     check the obligation would discharge + the session would stay
   *     mismatched indefinitely.
   * Used by {@link reconcileCrossModeHandoffForExecution} to decide discharge.
   */
  private async handoffComplete(
    record: ExecutionRecord,
    handoff: CrossModeHandoffRecord,
  ): Promise<boolean> {
    if (record.mode !== handoff.toMode) return false;
    if (handoff.toMode === 'external') {
      if (record.packageValue == null) return false;
    } else {
      // external → native: complete when an AgentRun exists OR the record
      // reached a terminal native state.
      const existingRun = await this.deps.agentRunRepository.findByExecutionId(
        record.executionId,
      );
      const terminalNative =
        record.status === 'completed' || record.status === 'failed';
      if (!existingRun && !terminalNative) return false;
    }
    // Session convergence (Finding #2 round 2): the handoff is NOT complete
    // until the session reached the expected post-handoff state. A crash
    // after the record mutate but before the session transition leaves the
    // session in the pre-handoff state — the obligation stays pending.
    const session = await this.deps.executionSessionService.getSessionForExecution(
      record.executionId,
    );
    if (!this.sessionConverged(session, record, handoff)) return false;
    return true;
  }

  // ====================================================================
  // private helpers
  // ====================================================================

  private assertEligible(record: ExecutionRecord, executionId: string): void {
    const fromMode = record.mode;
    if (fromMode === 'native') {
      // native -> external
      if (!NATIVE_TO_EXTERNAL_ELIGIBLE.has(record.status)) {
        throw new CrossModeHandoffError(
          `handoff-ineligible-state: execution ${executionId} is native/${record.status} — a native->external handoff requires the native phase to be in-flight or failed (not ${record.status})`,
          'handoff-ineligible-state',
        );
      }
    } else {
      // external -> native
      if (!EXTERNAL_TO_NATIVE_ELIGIBLE.has(record.status)) {
        throw new CrossModeHandoffError(
          `handoff-ineligible-state: execution ${executionId} is external/${record.status} — an external->native handoff requires the external phase to be in handoff_ready/submitted/failed/expired (not ${record.status})`,
          'handoff-ineligible-state',
        );
      }
    }
  }

  /**
   * PR #46 review #3: the WORK-034 session continuity gate. A TERMINAL
   * session (completed/failed/cancelled) is IMMUTABLE per WORK-034 — it
   * CANNOT be continued across a mode handoff. Reject with
   * 'handoff-ineligible-state' (the correction history is preserved; start a
   * new execution for the new mode). A non-terminal / absent session is
   * eligible — the session is driven through the EXISTING non-terminal
   * `interrupted` path in {@link transitionSessionForHandoff} (NEVER silently
   * continues a terminal session).
   */
  private assertSessionContinuityEligible(
    session: ExecutionSession | null,
    executionId: string,
  ): void {
    if (!session) return; // no session yet — eligible (external phase, or the
    // native execution never started a session). The handoff may create one
    // via ensureSession downstream; the continuity gate only REJECTS a
    // terminal session.
    if (
      session.status === 'completed' ||
      session.status === 'failed' ||
      session.status === 'cancelled'
    ) {
      throw new CrossModeHandoffError(
        `handoff-ineligible-state: execution ${executionId} has a TERMINAL ExecutionSession (status=${session.status}, sessionId=${session.id}) — WORK-034 terminal immutability forbids continuing a terminalized session across a mode handoff. The correction history is preserved; start a new execution for the new mode.`,
        'handoff-ineligible-state',
      );
    }
  }

  /**
   * PR #46 review #1: the WORK-035 workspace continuity gate. A TERMINAL
   * workspace (released/failed/cancelled) has its physical worktree REMOVED
   * (the workspace-release obligation discharged) — the uncommitted
   * working-tree state is GONE + cannot be recovered from branch HEAD.
   * Reject with 'handoff-ineligible-state'. A non-terminal / absent workspace
   * is eligible — the worktree is PRESERVED across the handoff (the
   * workspace-release trigger fires ONLY on an execution terminal; a handoff
   * → handoff_ready/running does NOT terminalize; the NativeExecutionProvider
   * delegates to the AgentGateway which does NOT touch the workspace).
   */
  private assertWorkspaceContinuityEligible(
    workspace: AgentWorkspace | null,
    executionId: string,
  ): void {
    if (!workspace) return; // no workspace yet — eligible (the execution may
    // not have acquired one — e.g. an external phase never had a native
    // worktree). The continuity gate only REJECTS a terminal workspace.
    if (workspace.terminalAt !== null) {
      throw new CrossModeHandoffError(
        `handoff-ineligible-state: execution ${executionId} has a TERMINAL AgentWorkspace (state=${workspace.state}, workspaceId=${workspace.id}) — the physical worktree was released/removed; the uncommitted working-tree state cannot be recovered across a mode handoff. The correction history is preserved; start a new execution for the new mode.`,
        'handoff-ineligible-state',
      );
    }
  }

  /**
   * PR #46 review #2 (round 2) + round 3 (the concurrency fix): the durable
   * relay job enqueue — AFTER the mutation + session convergence + dispatch
   * (NOT before — mirrors the architecture-consistent ordering the architect
   * prescribed for round 3). Round 3: the live WorkerHost can consume a relay
   * job the instant it is enqueued. Enqueueing BEFORE the caller's synchronous
   * mutation created a race — a live worker could reconcile (re-mutate +
   * re-dispatch) BETWEEN the reserve and the caller's transitionMode, after
   * which the caller performed its OWN mutation + dispatch (duplicate provider
   * submission / conflicting session transitions); the handoff-row UNIQUE
   * constraint did NOT serialize these two executions (both operated on the
   * same already-reserved handoff row). Now the relay job is enqueued ONLY
   * AFTER the caller's synchronous state transition is safely committed: a
   * live worker that picks up the job sees a COMPLETE (or near-complete)
   * handoff + the reconcile is a no-op discharge (NOT a competing mutation).
   * The boot sweep remains the recovery path for a crash between reserve and
   * this enqueue (the obligation is pending; the next worker start
   * reconciles).
   *
   * NOT best-effort (Finding #1 round 2): an enqueue failure PROPAGATES — the
   * handoff fails fast, the obligation row (migration 0043's trigger, written
   * ATOMICALLY with the reserve INSERT) is the durable source of truth, and
   * the boot sweep reconciles on the next worker start. The production
   * durability guarantee no longer depends on a later boot sweep: either the
   * enqueue succeeds (a live worker drains the job without any restart) OR
   * the handoff fails fast (the caller sees the failure; the obligation is
   * pending; the boot sweep reconciles). A failed enqueue is logged BEFORE
   * the throw so the operator has visibility.
   */
  private async enqueueRelayJob(executionId: string): Promise<void> {
    // The queue is REQUIRED (Finding #1 round 2): no queueless construction +
    // no swallowed enqueue failure. The durability guarantee is structural.
    try {
      await this.deps.queue.enqueue(CROSS_MODE_HANDOFF_RELAY_JOB_TYPE, { executionId });
    } catch (err) {
      // Log BEFORE the throw so the operator has visibility into the exact
      // enqueue failure (the obligation row is already durable — the boot
      // sweep reconciles on the next worker start regardless).
      this.deps.logger.error('cross-mode-handoff.relay-enqueue-failed', {
        executionId,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * PR #46 review #3 (+ round 2): drive the ExecutionSession through the
   * EXISTING non-terminal path on a cross-mode handoff (NEVER silently
   * continues a terminal session — the eligibility gate already rejected
   * that).
   *   - native→external: interrupt a `running` session (running → interrupted)
   *     — the legitimate non-terminal interruption path. The session-terminal
   *     obligation (if pending) is DEFERRED by the existing reconcile (it sees
   *     `interrupted` + leaves it pending). The session is NOT terminalized.
   *   - external→native: resume an `interrupted` session (interrupted →
   *     running), or start a `created` session (created → running) — the
   *     legitimate resume path.
   *
   * NOT best-effort (Finding #2 round 2): a session transition FAILURE
   * PROPAGATES — the handoff fails fast (the record mutation is authoritative
   * + already committed; the obligation row is durable; the boot sweep
   * reconciles + re-attempts the session transition on the next pass). The
   * obligation stays pending until {@link sessionConverged} confirms the
   * session reached the expected post-handoff state. A CAS loss (null result)
   * is NOT an error — it means a concurrent path already moved the session;
   * the convergence check re-evaluates on the next pass. No session (null) →
   * no-op (the external phase has no native session; a native handoff may
   * create one downstream). A terminal session is a no-op (immutable — the
   * eligibility gate should have rejected it at the start; if a concurrent
   * path terminalized it mid-handoff, accept it as converged).
   */
  private async transitionSessionForHandoff(
    session: ExecutionSession | null,
    targetMode: ExecutionMode,
    executionId: string,
  ): Promise<void> {
    if (!session) return; // no session — nothing to transition.
    if (targetMode === 'external') {
      // native → external: interrupt a running session.
      if (session.status === 'running') {
        const result = await this.deps.executionSessionService.interruptSession(
          session.id,
          session.version,
        );
        if (result) {
          this.deps.logger.info('cross-mode-handoff.session.interrupted', {
            executionId, sessionId: session.id, version: session.version,
          });
        }
        // null → a concurrent path already moved it (CAS loss) — the
        // convergence check re-evaluates on the next pass.
      }
      // created / interrupted / terminal → no-op (the external phase does not
      // drive the native session; a terminal session is immutable).
      return;
    }
    // external → native: resume an interrupted session, or start a created
    // session. A running session is already converged (no-op). A terminal
    // session is immutable (no-op — accept as converged).
    if (session.status === 'interrupted') {
      const result = await this.deps.executionSessionService.resumeSession(
        session.id,
        session.version,
      );
      if (result) {
        this.deps.logger.info('cross-mode-handoff.session.resumed', {
          executionId, sessionId: session.id, version: session.version,
        });
      }
      return;
    }
    if (session.status === 'created') {
      const result = await this.deps.executionSessionService.startSession(
        session.id,
      );
      if (result) {
        this.deps.logger.info('cross-mode-handoff.session.started', {
          executionId, sessionId: session.id,
        });
      }
      return;
    }
    // running → already running (no-op). terminal → immutable (no-op).
  }

  /**
   * PR #46 review #2 (round 2) + round 3 (secondary): the session convergence
   * check. The handoff is NOT complete until the ExecutionSession has reached
   * the EXPECTED post-handoff state. A crash after the record mutation
   * (transitionMode) but before the session transition leaves the session in
   * the pre-handoff state — the obligation MUST stay pending + the reconcile
   * MUST re-attempt the session transition. The convergence rules:
   *   - no session (null) → converged (nothing to transition — the external
   *     phase has no native session; a native handoff may create one
   *     downstream);
   *   - native→external: a `running` session is NOT converged (it should
   *     have been interrupted); created/interrupted/terminal → converged
   *     (the interrupt is moot for a terminal session — the execution is no
   *     longer running; the package submission is the authoritative dispatch
   *     outcome);
   *   - external→native: a `running` session is converged (resumed/started);
   *     a terminal native RECORD (completed/failed) is converged (the
   *     execution finished — the authoritative signal). A TERMINAL SESSION
   *     that arose mid-handoff (concurrent terminalization) is NOT converged
   *     by itself — the obligation stays pending until the record reaches a
   *     terminal state or an operator resolves it (PR #46 round 3 secondary:
   *     terminalization cannot accidentally discharge a handoff); created/
   *     interrupted → NOT converged (should be running).
   */
  private sessionConverged(
    session: ExecutionSession | null,
    record: ExecutionRecord,
    handoff: CrossModeHandoffRecord,
  ): boolean {
    if (!session) return true; // no session — converged.
    if (handoff.toMode === 'external') {
      // native→external: a running session is NOT converged (it should have
      // been interrupted). created/interrupted/terminal → converged (the
      // interrupt is moot for a terminal session — the execution is no
      // longer running; the package submission is the authoritative
      // dispatch outcome).
      return session.status !== 'running';
    }
    // external→native: a running session is converged (resumed/started).
    if (session.status === 'running') return true;
    // A terminal native RECORD means the execution finished — converged
    // (the session may have terminalized concurrently; the record's terminal
    // state is the authoritative signal that the execution is done). This is
    // the ONLY way a terminal session discharges a handoff (PR #46 round 3
    // secondary: a terminal session cannot accidentally discharge a handoff —
    // a terminal session that arose mid-handoff does NOT discharge unless the
    // record is also terminal).
    if (record.status === 'completed' || record.status === 'failed') {
      return true;
    }
    // created / interrupted / terminal-session-with-non-terminal-record →
    // NOT converged. A terminal session that arose mid-handoff (concurrent
    // terminalization) does NOT discharge the obligation — the obligation
    // stays pending until the record reaches a terminal state or an operator
    // resolves it.
    return false;
  }

  /**
   * The policy gate. targetMode='external' -> agentPolicyEngine.
   * evaluateExternalHandoff (deny/ask/constrained/allow). targetMode='native'
   * -> executionPolicy native_execution_allowed + registry native availability
   * (fail-closed). Returns a stringified summary for the handoff log row.
   */
  private async policyGate(
    record: ExecutionRecord,
    executionId: string,
    targetMode: ExecutionMode,
  ): Promise<string> {
    if (targetMode === 'external') {
      const decision = await this.deps.agentPolicyEvaluator.evaluateExternalHandoff({
        executionId,
      });
      if (decision.decision === 'deny') {
        throw new CrossModeHandoffError(
          `handoff-policy-denied: external handoff for execution ${executionId} is denied by agent policy (${decision.reason})`,
          'handoff-policy-denied',
        );
      }
      if (decision.decision === 'ask') {
        throw new CrossModeHandoffError(
          `handoff-policy-approval-required: external handoff for execution ${executionId} requires approval (${decision.reason})`,
          'handoff-policy-approval-required',
        );
      }
      // allow | constrained -> proceed (constrained is advisory — recorded).
      return JSON.stringify({
        target: 'external',
        decision: decision.decision,
        policyVersion: decision.policyVersion,
        scopeSource: decision.scopeSource,
        approvalId: decision.approvalId,
        constraints: decision.constraints,
      });
    }
    // targetMode === 'native' -> fail-closed native availability + the
    // project execution-policy native_execution_allowed gate.
    const projectPolicy = await this.deps.executionPolicyService.getProjectPolicy(
      record.projectId,
    );
    const nativeAllowed = projectPolicy?.nativeExecutionAllowed ?? false;
    if (!nativeAllowed) {
      throw new CrossModeHandoffError(
        `handoff-policy-denied: native execution is not allowed for project ${record.projectId} (execution-policy native_execution_allowed=false) — the external->native handoff is denied`,
        'handoff-policy-denied',
      );
    }
    return JSON.stringify({
      target: 'native',
      nativeExecutionAllowed: nativeAllowed,
      policyVersion: projectPolicy?.policyVersion ?? null,
    });
  }

  /**
   * WORK-043 (§33.3): the destination RE-ELIGIBILITY gate. Evaluates the
   * RESOLVED destination candidate (provider + model + target mode) through
   * the execution-policy constraint engine — the SAME engine the
   * recommendation path applies BEFORE ranking. Rejection is
   * side-effect-free (this runs before the reserve) and names EVERY
   * blocking reason (the caller sees exactly why the destination is
   * ineligible). An eligible verdict is composed into the policy summary
   * (recorded on the append-only handoff log row + the audit event).
   *
   * Fail-closed: a THROWING engine rejects the handoff (an unresolvable
   * constraint evaluation is NOT neutral — the destination cannot be
   * declared eligible). When the port lacks the WORK-043 seam (pre-WORK-043
   * fakes), the gate is skipped (the composition root always wires it).
   */
  private async destinationEligibilityGate(
    record: ExecutionRecord,
    executionId: string,
    input: CrossModeHandoffInput,
    provider: string,
    model: string | null,
    actor: { userId: string; source: string },
    policySummary: string,
  ): Promise<string> {
    const organizationId = await this.deps.organizationResolver.getOrganizationId(record.projectId);
    if (!organizationId) {
      throw new CrossModeHandoffError(
        `handoff-ineligible-destination: organization for project ${record.projectId} could not be resolved — failing closed`,
        'handoff-ineligible-destination',
      );
    }
    let verdict;
    try {
      verdict = await this.deps.executionPolicyService.evaluateCandidateEligibility({
        organizationId,
        projectId: record.projectId,
        workItemId: record.workItemId,
        provider,
        model,
        executionMode: input.targetMode,
        userId: actor.userId,
      });
    } catch (err) {
      throw new CrossModeHandoffError(
        `handoff-ineligible-destination: the destination eligibility evaluation failed for execution ${executionId} (${(err as Error).message}) — failing closed`,
        'handoff-ineligible-destination',
      );
    }
    if (!verdict.eligibility.eligible) {
      const reasons = verdict.eligibility.blockingReasons
        .map((b) => `${b.category}/${b.constraint}: ${b.reason}`)
        .join('; ');
      throw new CrossModeHandoffError(
        `handoff-ineligible-destination: the ${input.targetMode} destination ${provider}${model ? `/${model}` : ''} is ineligible for execution ${executionId} (${verdict.eligibility.status}: ${reasons || 'no reason surfaced'}) — the logical task cannot continue on this destination under the current constraints`,
        'handoff-ineligible-destination',
      );
    }
    return composeSummary(policySummary, {
      destinationEligibility: {
        status: verdict.eligibility.status,
        eligible: true,
        policyVersion: verdict.policyVersion,
        provider,
        model,
        mode: input.targetMode,
      },
    });
  }

  /**
   * Resolve the provider + model for the target mode. For native, the model
   * is REQUIRED (the NativeExecutionProvider throws if absent); fail-closed
   * with 'native-provider-unavailable' when no platform-native provider/model
   * can be resolved. For external, the model is optional (null is fine).
   */
  private async resolveProviderModel(
    record: ExecutionRecord,
    executionId: string,
    input: CrossModeHandoffInput,
  ): Promise<{ provider: string; model: string | null }> {
    if (input.targetMode === 'external') {
      const provider =
        input.provider ?? EXTERNAL_UI_CATALOG[0]?.provider;
      if (!provider) {
        // Unreachable in practice (the catalog is non-empty); a deployment
        // with no external surface cannot hand off to external.
        throw new CrossModeHandoffError(
          `native-provider-unavailable: no external-UI catalog provider is configured for execution ${executionId} — cannot resolve the external handoff provider`,
          'native-provider-unavailable',
        );
      }
      return { provider, model: input.model ?? null };
    }
    // native
    const provider =
      input.provider ?? this.deps.agentProviderRegistryService.getPlatformDefaultProvider();
    if (!provider) {
      throw new CrossModeHandoffError(
        `native-provider-unavailable: no platform-native provider is configured for execution ${executionId} — cannot resolve the native handoff provider`,
        'native-provider-unavailable',
      );
    }
    const model =
      input.model ?? this.deps.agentProviderRegistryService.getPlatformDefaultModel();
    if (!model) {
      throw new CrossModeHandoffError(
        `native-provider-unavailable: no platform-native model is configured for provider ${provider} (execution ${executionId}) — native execution requires a validated provider + model`,
        'native-provider-unavailable',
      );
    }
    // Validate the resolved provider+model is actually configured (fail-closed).
    const configured =
      await this.deps.agentProviderRegistryService.isProviderConfigured(
        provider,
        model,
        record.projectId,
      );
    if (!configured) {
      throw new CrossModeHandoffError(
        `native-provider-unavailable: provider ${provider}/${model} is not configured for execution ${executionId} (project ${record.projectId}) — the external->native handoff cannot dispatch`,
        'native-provider-unavailable',
      );
    }
    return { provider, model };
  }

  /**
   * PR #46 round 4 + round 5: Reserve + claim in ONE call. INSERTs the
   * append-only handoff log row (previous_* snapshot) AND claims the durable
   * obligation atomically (via
   * {@link CrossModeHandoffRepository.createHandoffAndClaim}) under the
   * caller's UNIQUE per-invocation owner. Catches the 23505
   * ('cross-mode-handoff-already-exists') → the service re-resolves
   * convergence vs reject. On the idempotency-convergence path, returns
   * `{ handoff: existing, claimed: false, claimEpoch: null }` (the caller
   * did NOT win the reserve — the original owner holds the claim or has
   * discharged).
   */
  private async reserveAndClaim(args: {
    record: ExecutionRecord;
    executionId: string;
    input: CrossModeHandoffInput;
    provider: string;
    resultingStatus: 'handoff_ready' | 'running';
    idempotencyKey: string;
    policySummary: string;
    actor: { userId: string; source: string };
    /** PR #46 round 5: the unique per-invocation claim owner. */
    claimOwner: string;
  }): Promise<
    | { handoff: CrossModeHandoffRecord; claimed: true; claimEpoch: number }
    | { handoff: CrossModeHandoffRecord; claimed: false; claimEpoch: null }
  > {
    const createInput: CreateCrossModeHandoffInput = {
      executionRecordId: args.record.id,
      fromMode: args.record.mode,
      toMode: args.input.targetMode,
      reason: args.input.reason ?? null,
      actor: args.actor.userId,
      source: args.actor.source,
      previousStatus: args.record.status,
      resultingStatus: args.resultingStatus,
      previousAgentRunId: args.record.agentRunId,
      previousExternalSessionRef: args.record.externalSessionRef,
      previousPackageValue: args.record.packageValue,
      authorized: true,
      policyDecision: args.policySummary,
      idempotencyKey: args.idempotencyKey,
    };
    try {
      return await this.deps.crossModeHandoffRepository.createHandoffAndClaim(
        createInput,
        args.claimOwner,
        this.claimLeaseMs,
      );
    } catch (err) {
      if (
        err instanceof CrossModeHandoffError &&
        err.code === 'cross-mode-handoff-already-exists'
      ) {
        // Re-resolve: same idempotency_key -> converge; different key -> reject.
        const existing =
          await this.deps.crossModeHandoffRepository.findByIdempotencyKey(
            args.idempotencyKey,
          );
        if (existing) {
          // Idempotency convergence — the caller did NOT win the reserve
          // (the original owner's transaction committed first). Return the
          // existing handoff + claimed:false + claimEpoch:null (the caller
          // does NOT own the claim; the original owner will complete OR the
          // lease will expire + the boot sweep will reclaim).
          this.deps.logger.info('cross-mode-handoff.reserve.convergent', {
            executionId: args.executionId,
            idempotencyKey: args.idempotencyKey,
            handoffId: existing.id,
          });
          return { handoff: existing, claimed: false, claimEpoch: null };
        }
        const existingForExecution =
          await this.deps.crossModeHandoffRepository.findByExecutionId(args.executionId);
        if (existingForExecution) {
          throw new CrossModeHandoffError(
            `already-handed-off: execution ${args.executionId} already has a cross-mode handoff (idempotency_key ${existingForExecution.idempotencyKey}) — ONE handoff per execution (UNIQUE(execution_record_id))`,
            'already-handed-off',
          );
        }
      }
      throw err;
    }
  }

  /**
   * PR #46 round 4 + round 5: release the claim in a non-throwing wrapper.
   * Called in a `finally` block (success OR failure of the critical
   * section). The release is guarded by the EXACT lease identity (owner +
   * epoch) — a stale invocation whose lease was reclaimed is a silent NO-OP
   * (it can never clear the new owner's live claim). A failure here is
   * logged + swallowed — the lease auto-expires as the crash backstop (the
   * boot sweep reclaims after `claimLeaseMs`). A no-op return (false) when
   * the obligation was discharged or the claim was already
   * reclaimed/released is NOT logged (it is the expected post-discharge /
   * fenced-out state).
   */
  private async releaseClaimSafely(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): Promise<void> {
    try {
      await this.deps.crossModeHandoffRepository.releaseHandoffObligationClaim(
        handoffId,
        owner,
        claimEpoch,
      );
    } catch (err) {
      this.deps.logger.error('cross-mode-handoff.claim-release-failed', {
        handoffId,
        owner,
        claimEpoch,
        error: (err as Error).message,
      });
      // The lease will auto-expire; the boot sweep reclaims.
    }
  }

  /**
   * PR #46 round 5 (the lease-expiry fix): start the claim lease guard for
   * ONE critical section — the heartbeat renewal + the fence. The returned
   * guard captures the EXACT lease identity (the unique per-invocation
   * owner + the epoch from the claim) and starts a timer that renews the
   * lease every `claimHeartbeatMs` (claimLeaseMs/3 by default) for the
   * ENTIRE critical section:
   *
   *   - a LIVE owner's lease cannot expire mid-flight (the round-5 second
   *     blocker: a legitimately slow provider dispatch previously outlived
   *     the fixed 30s lease, letting a second actor reclaim + concurrently
   *     perform the same dispatch/session transitions);
   *   - a STALLED owner (event loop blocked / heartbeat dead) stops renewing
   *     → the lease expires → another actor reclaims (epoch bump) → this
   *     owner's heartbeat renewal returns false → `lost` is set → the next
   *     phase-boundary {@link ensureFence} aborts BEFORE any further side
   *     effect, and the epoch-fenced discharge rejects its completion.
   *
   * A heartbeat renewal THROWS (transient DB error) only logs — it does NOT
   * declare the fence lost (the next heartbeat retries; a definitive loss
   * is the 0-rows false). The timer is unref'd (it never holds the process
   * open) + stopped by the guard's `stop()` in the critical section's
   * `finally`.
   */
  private startClaimLease(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): ClaimLeaseGuard {
    let lost = false;
    const renew = async (): Promise<boolean> => {
      const renewed =
        await this.deps.crossModeHandoffRepository.renewHandoffObligationClaim(
          handoffId,
          owner,
          claimEpoch,
          this.claimLeaseMs,
        );
      if (!renewed) {
        // Definitive fence loss: the lease was reclaimed (owner/epoch
        // mismatch) or the obligation was discharged by another actor.
        lost = true;
      }
      return renewed;
    };
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      void renew().catch((err: unknown) => {
        // Transient (DB error): NOT a definitive fence loss — the next
        // heartbeat retries; a definitive loss is the 0-rows false.
        this.deps.logger.warn('cross-mode-handoff.claim-heartbeat-error', {
          handoffId,
          owner,
          claimEpoch,
          error: (err as Error).message,
        });
      });
    }, this.claimHeartbeatMs);
    // The heartbeat must never hold the process (or the vitest worker) open.
    timer.unref?.();
    return {
      handoffId,
      owner,
      claimEpoch,
      renew,
      isLost: () => lost,
      stop: () => clearInterval(timer),
    };
  }

  /**
   * PR #46 round 5 (the lease-expiry fix): the phase-boundary FENCE CHECK.
   * Called before EVERY side-effect phase of the critical section (the
   * record mutate, the session transition, the provider dispatch, the relay
   * enqueue, and — via the epoch-fenced discharge — the obligation
   * completion). Renews the lease (an eager extension) + verifies this
   * invocation still owns it:
   *
   *   - TRUE  → proceed with the phase (the fence held at this boundary);
   *   - FALSE → throw 'claim-fence-lost' → the caller path fails fast (the
   *     route maps it to 409: a concurrent actor owns the obligation; the
   *     client retries + converges) and the reconcile path returns
   *     `{ stage: 'fence-lost' }` (the new owner completes the handoff).
   *
   * The residual window between a fence check and the following side effect
   * is bounded to a single phase (the check is a DB round-trip immediately
   * before the phase), and the downstream effects are idempotent by design
   * (the deterministic external package, the wfos_agent_runs UNIQUE guard,
   * the WORK-034 session CAS) — the authoritative obligation transition
   * (the discharge) is HARD-fenced at the DB by the owner+epoch predicate.
   */
  private async ensureFence(lease: ClaimLeaseGuard, phase: string): Promise<void> {
    if (lease.isLost()) {
      throw new CrossModeHandoffError(
        `claim-fence-lost: the cross-mode-handoff claim for handoff ${lease.handoffId} was reclaimed by another actor (owner ${lease.owner}, epoch ${lease.claimEpoch} — the heartbeat renewal already failed) — aborting BEFORE the ${phase} phase to prevent a second concurrent handoff driver`,
        'claim-fence-lost',
      );
    }
    const renewed = await lease.renew();
    if (!renewed) {
      throw new CrossModeHandoffError(
        `claim-fence-lost: the cross-mode-handoff claim for handoff ${lease.handoffId} was reclaimed by another actor before the ${phase} phase (owner ${lease.owner}, epoch ${lease.claimEpoch}) — aborting to prevent a second concurrent handoff driver`,
        'claim-fence-lost',
      );
    }
  }

  /**
   * Mutate the record to the target mode + status (transitionMode), THEN
   * drive the ExecutionSession through the EXISTING non-terminal path
   * (interrupt on native→external; resume/start on external→native — PR #46
   * review #3), THEN dispatch through the appropriate provider, THEN
   * updateStatus with the provider outcome. Crash-safety: the mutated
   * record is the recoverable intermediate state (a retry sees
   * record.mode=targetMode, status=resultingStatus, and re-dispatches); the
   * session transition is NOT best-effort (Finding #2 round 2) — a failure
   * PROPAGATES (the handoff fails fast; the obligation stays pending; the
   * reconcile re-attempts the session transition until convergence). A CAS
   * loss (null result) is NOT an error (a concurrent path already moved the
   * session; the convergence check re-evaluates on the next pass).
   */
  private async mutateAndDispatch(
    record: ExecutionRecord,
    executionId: string,
    input: CrossModeHandoffInput,
    provider: string,
    model: string | null,
    resultingStatus: 'handoff_ready' | 'running',
    session: ExecutionSession | null,
    lease: ClaimLeaseGuard,
  ): Promise<void> {
    // PR #46 round 5 (the lease-expiry fix): the fence check BEFORE every
    // side-effect phase of the critical section. A stalled owner (whose
    // lease expired + was reclaimed) aborts HERE — before the record
    // mutate, before the session transition, before the provider dispatch —
    // preventing the second concurrent handoff driver.
    await this.ensureFence(lease, 'record-mutate');
    // 9. Mutate the record (mode + status + provider + model). The package
    //    (native->external) and agentRunId (external->native) are set AFTER
    //    dispatch (the provider generates them) — transitionMode here leaves
    //    them at their current value via COALESCE.
    const mutated = await this.deps.executionRecordRepository.transitionMode(
      record.id,
      {
        mode: input.targetMode,
        status: resultingStatus,
        provider,
        model,
      },
    );
    if (!mutated) {
      // The record vanished between the reserve + the mutate — extremely
      // unlikely (ON DELETE CASCADE); surface a clear error.
      throw new CrossModeHandoffError(
        `execution-not-found: execution ${executionId} record ${record.id} vanished during the cross-mode handoff mutate`,
        'execution-not-found',
      );
    }

    // 9b. PR #46 review #3 (+ round 2): drive the ExecutionSession through
    //     the EXISTING non-terminal path (NEVER silently continues a terminal
    //     session — the eligibility gate already rejected that). native→
    //     external interrupts a running session (running → interrupted);
    //     external→native resumes an interrupted session (interrupted →
    //     running) or starts a created session (created → running). NOT
    //     best-effort (Finding #2 round 2): a session-transition failure
    //     PROPAGATES — the handoff fails fast; the obligation stays pending;
    //     the reconcile re-attempts the session transition until convergence
    //     (crash window #3). A CAS loss (null result) is NOT an error.
    //     PR #46 round 5: the fence check BEFORE the session transition.
    await this.ensureFence(lease, 'session-transition');
    await this.transitionSessionForHandoff(session, input.targetMode, executionId);

    // 10. Dispatch through the target provider. The dispatch sub-methods
    //    use the POST-MUTATE record (provider/model already set) + the
    //    caller-resolved model for native (the NativeExecutionProvider
    //    requires a non-null model). PR #46 round 5: the fence check BEFORE
    //    the provider dispatch (the eager pre-check — a fast abort). PR #46
    //    round 6: the pre-call check is NO LONGER the whole protection — the
    //    dispatch sub-methods cross the FENCED DISPATCH GATE
    //    (beginFencedDispatch — the lease fence evaluated ATOMICALLY with
    //    the durable dispatch intent, BEFORE the provider submit) and
    //    commit their authoritative outcome write THROUGH
    //    completeFencedDispatch (the gate CAS + the outcome write in ONE
    //    transaction). A stalled owner that passes THIS check but loses the
    //    lease mid-dispatch can no longer complete its already-started
    //    dispatch (see dispatchExternal / dispatchNative).
    await this.ensureFence(lease, 'dispatch');
    if (input.targetMode === 'external') {
      await this.dispatchExternal(mutated, executionId, lease);
    } else {
      await this.dispatchNative(mutated, executionId, model, lease);
    }
  }

  /**
   * PR #46 round 7: derive the DURABLE DISPATCH IDEMPOTENCY KEY for a
   * handoff dispatch — from the LOGICAL HANDOFF IDENTITY ONLY (the handoff
   * row id), NEVER from the volatile lease owner/epoch. This is the
   * architect's round-7 contract option 1 (the exactly-once side-effect
   * boundary): every actor that dispatches the same logical handoff — the
   * original owner, a reclaiming owner (a newer owner + epoch), a
   * crash-recovery re-dispatch — derives the SAME key, records it atomically
   * with the gate-open, and submits it to the provider, so the provider
   * boundary CONVERGES all of their submits onto ONE provider operation
   * (never a second independent operation for one logical handoff).
   */
  private dispatchIdempotencyKey(lease: ClaimLeaseGuard): string {
    return `cross-mode-dispatch-${lease.handoffId}`;
  }

  /**
   * native -> external dispatch: rebuild the task (mode=external, reuse the
   * ImplementationContext), submit through the ExternalExecutionProvider
   * (deterministic package), then commit the authoritative outcome (the
   * package + expires_at) THROUGH the fenced dispatch boundary.
   *
   * PR #46 round 6 (the side-effect-boundary fencing fix): the round-5
   * `ensureFence('dispatch')` was a PRE-CALL check — an owner that passed it
   * and then stalled (heartbeat dead) could resume after a reclaim and
   * complete its ALREADY-STARTED dispatch (a second authoritative provider
   * operation: a duplicate package/expires_at write clobbering the new
   * owner's outcome). The boundary itself is now fenced:
   *
   *   1. {@link CrossModeHandoffRepository.beginFencedDispatch} — the lease
   *      fence (owner + epoch) evaluated ATOMICALLY with the durable
   *      dispatch intent (migration 0046). 0 rows → this actor no longer
   *      owns the lease → abort BEFORE the provider submit (zero provider
   *      operations from a fenced-out actor).
   *   2. the provider submit — round 7: the task carries the DURABLE
   *      DISPATCH IDEMPOTENCY KEY (derived from the handoff identity), and
   *      the ExternalExecutionProvider's operation registry CONVERGES a
   *      same-key submit onto the REGISTERED operation (the first
   *      generation's stored submission): a reclaiming owner's take-over
   *      re-dispatch NEVER starts a second provider operation — both actors
   *      observe the SAME operation (the same package + the same expiry),
   *      and only the lease owner can commit its outcome (step 3).
   *   3. {@link CrossModeHandoffRepository.completeFencedDispatch} — the
   *      gate CAS + the authoritative outcome write in ONE transaction. 0
   *      rows → ROLLBACK — NO write happened: a stale actor's
   *      already-computed package is discarded (it aborts
   *      'claim-fence-lost'; the reclaiming owner owns the outcome).
   *
   * A submit failure leaves the gate in_flight at THIS actor's epoch with NO
   * outcome write — the obligation stays pending; the next claim (a strictly
   * greater epoch) TAKES OVER the stale in-flight gate and retries (the
   * take-over arm of beginFencedDispatch) — converging onto the SAME
   * keyed provider operation. The typed 'handoff-dispatch-failed' error
   * propagates (the route returns 500; the boot sweep reconciles).
   */
  private async dispatchExternal(
    record: ExecutionRecord,
    executionId: string,
    lease: ClaimLeaseGuard,
  ): Promise<void> {
    try {
      const built = await this.deps.executionTaskService.build({
        workItemId: record.workItemId,
        mode: 'external',
        provider: record.provider,
        model: record.model,
        executionId,
        implementationContextId: record.implementationContextId,
      });
      // PR #46 round 7: the DURABLE dispatch idempotency key — derived from
      // the LOGICAL HANDOFF IDENTITY (stable across owners/epochs/reclaims).
      // Recorded atomically with the gate-open below + stamped on the
      // submitted task, so the provider boundary converges every actor's
      // dispatch of this handoff onto ONE provider operation.
      const dispatchKey = this.dispatchIdempotencyKey(lease);
      // PR #46 round 6: cross the FENCED DISPATCH GATE — the lease fence is
      // evaluated ATOMICALLY with the durable dispatch intent, immediately
      // BEFORE the provider submit (no check-then-act window). A FALSE here
      // means the lease was reclaimed between the pre-call fence check and
      // this boundary: abort BEFORE the submit.
      const began =
        await this.deps.crossModeHandoffRepository.beginFencedDispatch(
          lease.handoffId,
          lease.owner,
          lease.claimEpoch,
          dispatchKey,
        );
      if (!began) {
        throw new CrossModeHandoffError(
          `claim-fence-lost: the cross-mode-handoff claim for handoff ${lease.handoffId} was reclaimed before the external dispatch boundary (owner ${lease.owner}, epoch ${lease.claimEpoch}) — aborting BEFORE the provider submit to prevent a second concurrent handoff driver`,
          'claim-fence-lost',
        );
      }
      // PR #46 round 7: the KEYED submit — the task carries the dispatch
      // idempotency key, so a same-key submit (a reclaiming owner's take-over
      // re-dispatch racing this in-flight submit) CONVERGES onto the SAME
      // registered provider operation instead of starting a second one.
      const submission = await this.deps.externalExecutionProvider.submit({
        ...built.task,
        dispatchIdempotencyKey: dispatchKey,
      });
      const pkg = submission.package ?? null;
      const expiresAt = submission.expiresAt ?? null;
      if (!pkg) {
        throw new Error(
          `cross-mode-handoff-external-package-missing: the ExternalExecutionProvider returned no package for execution ${executionId}`,
        );
      }
      // PR #46 round 6: the atomic completion — the gate CAS AND the
      // authoritative outcome write (status + package + expires_at) in ONE
      // transaction. FALSE means fenced out mid-dispatch (the lease was
      // reclaimed while this submit ran): the transaction rolled back — NO
      // outcome write happened. This is the architect's round-6 invariant:
      // a resumed stale dispatch MUST NOT create a second authoritative
      // provider operation.
      const completed =
        await this.deps.crossModeHandoffRepository.completeFencedDispatch(
          lease.handoffId,
          lease.owner,
          lease.claimEpoch,
          record.id,
          {
            status: 'handoff_ready',
            packageValue: pkg,
            expiresAt,
          },
        );
      if (!completed) {
        throw new CrossModeHandoffError(
          `claim-fence-lost: the cross-mode-handoff claim for handoff ${lease.handoffId} was reclaimed while the external dispatch was in flight (owner ${lease.owner}, epoch ${lease.claimEpoch}) — the already-started dispatch's outcome was DISCARDED (no second authoritative provider operation); the reclaiming owner owns the dispatch`,
          'claim-fence-lost',
        );
      }
    } catch (err) {
      // Fence losses propagate as-is (the caller path maps them to 409; the
      // reconcile path converts them to stage 'fence-lost').
      if (err instanceof CrossModeHandoffError && err.code === 'claim-fence-lost') {
        throw err;
      }
      // The dispatch failed — the record stays at mode=external/status=
      // handoff_ready (the mutated intermediate state); the gate stays
      // in_flight at this actor's epoch (the next claim takes it over).
      // Surface a typed 'handoff-dispatch-failed' so the route returns 500.
      // The handoff LOG row preserves the intent (the correction chain is
      // visible).
      this.deps.logger.error('cross-mode-handoff.dispatch-external-failed', {
        executionId,
        error: (err as Error).message,
      });
      throw new CrossModeHandoffError(
        `handoff-dispatch-failed: the native->external dispatch for execution ${executionId} failed (${(err as Error).message})`,
        'handoff-dispatch-failed',
      );
    }
  }

  /**
   * external -> native dispatch: rebuild the task (mode=native, reuse the
   * ImplementationContext), check whether an AgentRun already exists (crash-
   * retry guard — wfos_agent_runs.execution_id is UNIQUE), else submit
   * through the NativeExecutionProvider (which delegates to the existing
   * AgentGateway — NO second gateway). The authoritative outcome (the
   * agentRunId + status, or the failure record) commits THROUGH the fenced
   * dispatch boundary.
   *
   * PR #46 round 6 (the side-effect-boundary fencing fix): identical shape
   * to {@link dispatchExternal} —
   *   1. {@link CrossModeHandoffRepository.beginFencedDispatch} BEFORE the
   *      gateway submit (the lease fence evaluated ATOMICALLY with the
   *      durable dispatch intent; a fenced-out actor never reaches the
   *      provider);
   *   2. the provider submit — round 7: the task carries the DURABLE
   *      DISPATCH IDEMPOTENCY KEY (derived from the handoff identity), and
   *      the NativeExecutionProvider keys its convergence on the durable
   *      EXECUTION identity (wfos_agent_runs.execution_id is UNIQUE): a
   *      keyed dispatch whose run already exists CONVERGES to that run (NO
   *      gateway call, NO second adapter invocation), and a run-creation
   *      collision (the residual race) converges the loser to the winner's
   *      run — the provider operation (the adapter execution) is
   *      structurally AT-MOST-ONCE per execution;
   *   3. {@link CrossModeHandoffRepository.completeFencedDispatch} — the
   *      gate CAS + the authoritative outcome write in ONE transaction. A
   *      stale actor's already-started dispatch is fenced out (0 rows → NO
   *      write — neither a duplicate success write NOR the legacy failure
   *      clobber).
   *
   * CONFLICT RECOVERY (round 6): when the submit throws AND an AgentRun now
   * exists, the authoritative native provider operation ALREADY happened
   * (this submit collided with a concurrent/taken-over dispatch on the
   * UNIQUE, or the gateway persisted the run before failing) — the handler
   * CONVERGES to the existing run through the fenced completion instead of
   * writing a stale 'failed' record over the new owner's outcome. Only a
   * genuinely run-less failure writes the authoritative failure record
   * (still through the fence).
   */
  private async dispatchNative(
    record: ExecutionRecord,
    executionId: string,
    model: string | null,
    lease: ClaimLeaseGuard,
  ): Promise<void> {
    // PR #46 round 10: the service-level existing-run pre-check/guard is
    // REMOVED. The guard wrote `status: 'completed'` for ANY existing run —
    // including a NON-TERMINAL one (pending/in_progress — premature
    // convergence while the run was still executing, and could still later
    // fail) and even a FAILED one. ALL existing-run convergence now flows
    // through the PROVIDER boundary (the keyed submit below), which preserves
    // the AgentRun lifecycle: a terminal run maps to its terminal submission
    // (success → completed; failed/cancelled → failed), a non-terminal run is
    // AWAITED until terminal, and a stuck run fails closed. The crash-retry
    // guard's original concern ("a second submit would hit the
    // wfos_agent_runs.execution_id UNIQUE") is structurally handled by the
    // provider's keyed pre-check (converge-on-the-existing-run, round 7).
    // PR #46 round 7: the DURABLE dispatch idempotency key — derived from
    // the LOGICAL HANDOFF IDENTITY (stable across owners/epochs/reclaims);
    // recorded atomically with the gate-open + stamped on the submitted task
    // so the native provider boundary converges every actor's dispatch of
    // this handoff onto the ONE run (the durable execution identity).
    const dispatchKey = this.dispatchIdempotencyKey(lease);
    // PR #46 round 6: cross the FENCED DISPATCH GATE — the lease fence
    // evaluated ATOMICALLY with the durable dispatch intent, BEFORE any
    // provider call.
    const began =
      await this.deps.crossModeHandoffRepository.beginFencedDispatch(
        lease.handoffId,
        lease.owner,
        lease.claimEpoch,
        dispatchKey,
      );
    if (!began) {
      throw new CrossModeHandoffError(
        `claim-fence-lost: the cross-mode-handoff claim for handoff ${lease.handoffId} was reclaimed before the native dispatch boundary (owner ${lease.owner}, epoch ${lease.claimEpoch}) — aborting BEFORE the provider submit to prevent a second concurrent handoff driver`,
        'claim-fence-lost',
      );
    }

    const built = await this.deps.executionTaskService.build({
      workItemId: record.workItemId,
      mode: 'native',
      provider: record.provider,
      // The NativeExecutionProvider requires a non-null model.
      model: model ?? record.model,
      executionId,
      implementationContextId: record.implementationContextId,
    });

    try {
      // PR #46 round 7: the KEYED submit — the task carries the dispatch
      // idempotency key, so the native provider boundary converges a
      // same-key dispatch whose run already exists onto that ONE run (no
      // gateway call, no second adapter invocation) instead of colliding.
      const submission = await this.deps.nativeExecutionProvider.submit({
        ...built.task,
        dispatchIdempotencyKey: dispatchKey,
      });
      // PR #46 round 6: the atomic completion — the gate CAS AND the
      // authoritative outcome write in ONE transaction. FALSE → fenced out
      // mid-dispatch → NO write happened (the stale dispatch's outcome is
      // discarded; the reclaiming owner owns the dispatch).
      const completed =
        await this.deps.crossModeHandoffRepository.completeFencedDispatch(
          lease.handoffId,
          lease.owner,
          lease.claimEpoch,
          record.id,
          {
            status: submission.status === 'completed' ? 'completed' : submission.status,
            agentRunId: submission.agentRunId ?? null,
            startedAt: submission.startedAt ?? null,
            completedAt: submission.completedAt ?? null,
          },
        );
      if (!completed) {
        throw new CrossModeHandoffError(
          `claim-fence-lost: the cross-mode-handoff claim for handoff ${lease.handoffId} was reclaimed while the native dispatch was in flight (owner ${lease.owner}, epoch ${lease.claimEpoch}) — the already-started dispatch's outcome was DISCARDED (no second authoritative provider operation); the reclaiming owner owns the dispatch`,
          'claim-fence-lost',
        );
      }
    } catch (err) {
      // Fence losses propagate as-is (the caller path maps them to 409; the
      // reconcile path converts them to stage 'fence-lost').
      if (err instanceof CrossModeHandoffError && err.code === 'claim-fence-lost') {
        throw err;
      }
      // PR #46 round 6 CONFLICT RECOVERY + round 10 (the LIFECYCLE
      // correction): the submit failed. An AgentRun may nevertheless EXIST —
      // either this invocation's own run (the gateway persists the run BEFORE
      // executing the adapter, so a failed adapter leaves a 'failed' run) or
      // a concurrent/taken-over dispatch's run (this submit collided on the
      // wfos_agent_runs.execution_id UNIQUE). The authoritative native
      // provider operation is the RUN — converge to it through the FENCED
      // completion when its outcome is KNOWABLE (a TERMINAL run):
      //   - 'success'        → the completed converge outcome;
      //   - failed/cancelled → the authoritative failure record.
      // PR #46 round 10 — EXISTING ≠ COMPLETED: a NON-TERMINAL run
      // (pending/in_progress — the winner's adapter still executing, or an
      // orphaned run whose driver died) has NO knowable outcome: the handler
      // performs NO write of EITHER polarity (a 'completed' write would be a
      // manufactured success while the run may still fail; a 'failed' write
      // would clobber a run that may still succeed) — it rethrows, the
      // obligation stays pending, and a later reconcile retries the
      // convergence once the run is terminal (the handoffComplete
      // existing-run rule discharges when the handoff goal is achieved).
      // Only a genuinely run-less dispatch writes the authoritative failure
      // record (still through the fence).
      const run = await this.deps.agentRunRepository.findByExecutionId(
        executionId,
      );
      if (run && run.status !== 'success' && run.status !== 'failed' && run.status !== 'cancelled') {
        // A NON-TERMINAL existing run: no outcome is knowable — fail closed
        // WITHOUT any authoritative write.
        this.deps.logger.warn('cross-mode-handoff.dispatch-native-existing-run-non-terminal', {
          executionId,
          agentRunId: run.id,
          runStatus: run.status,
          error: (err as Error).message,
        });
        throw new CrossModeHandoffError(
          `handoff-dispatch-failed: the external->native dispatch for execution ${executionId} failed (${(err as Error).message}) and the existing AgentRun ${run.id} is still non-terminal ('${run.status}') — EXISTING ≠ COMPLETED: no authoritative outcome is written for a non-terminal run (the obligation stays pending; the convergence retries when the run reaches a terminal state)`,
          'handoff-dispatch-failed',
        );
      }
      const outcome = run
        ? run.status === 'success'
          ? {
              status: 'completed' as const,
              agentRunId: run.id,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
            }
          : {
              status: 'failed' as const,
              agentRunId: run.id,
              completedAt: run.completedAt ?? this.now(),
              benchmarkMetadata: {
                failureStage: 'cross-mode-native-dispatch',
                errorMessage: (err as Error).message,
              },
            }
        : {
            status: 'failed' as const,
            completedAt: this.now(),
            benchmarkMetadata: {
              failureStage: 'cross-mode-native-dispatch',
              errorMessage: (err as Error).message,
            },
          };
      const completed =
        await this.deps.crossModeHandoffRepository.completeFencedDispatch(
          lease.handoffId,
          lease.owner,
          lease.claimEpoch,
          record.id,
          outcome,
        );
      if (!completed) {
        // Fenced out mid-failure-handling: NO failure write happened either
        // (the transaction rolled back) — the new owner owns the record.
        throw new CrossModeHandoffError(
          `claim-fence-lost: the cross-mode-handoff claim for handoff ${lease.handoffId} was reclaimed while the native dispatch failure was being recorded (owner ${lease.owner}, epoch ${lease.claimEpoch}) — NO outcome write happened; the reclaiming owner owns the record`,
          'claim-fence-lost',
        );
      }
      // Native dispatch failed — the fenced failure outcome is now the
      // authoritative record (terminal; the reconcile converges + discharges
      // on the terminal native state). The handoff LOG row preserves the
      // intent. Propagate 'handoff-dispatch-failed'.
      this.deps.logger.error('cross-mode-handoff.dispatch-native-failed', {
        executionId,
        error: (err as Error).message,
        convergedToExistingRun: run != null && run.status !== 'failed',
      });
      throw new CrossModeHandoffError(
        `handoff-dispatch-failed: the external->native dispatch for execution ${executionId} failed (${(err as Error).message})`,
        'handoff-dispatch-failed',
      );
    }
  }

  /**
   * Audit (best-effort — try/catch, never breaks flow). Mirrors the
   * DefaultExecutionHandoffService.audit pattern.
   */
  private async audit(
    record: ExecutionRecord,
    executionId: string,
    input: CrossModeHandoffInput,
    handoff: CrossModeHandoffRecord,
    actor: { userId: string; source: string },
    policySummary: string,
  ): Promise<void> {
    try {
      await this.deps.auditService.write({
        projectId: record.projectId,
        eventType: 'EXECUTION_CROSS_MODE_HANDOFF',
        actor: actor.userId,
        source: actor.source,
        resourceType: 'execution',
        resourceId: record.id,
        executionId,
        workItemId: record.workItemId,
        workOrderId: record.workOrderId,
        metadata: {
          fromMode: handoff.fromMode,
          toMode: handoff.toMode,
          reason: handoff.reason,
          previousStatus: handoff.previousStatus,
          resultingStatus: handoff.resultingStatus,
          authorized: handoff.authorized,
          policyDecision: policySummary,
          idempotencyKey: handoff.idempotencyKey,
          userInstruction: input.userInstruction ?? null,
          provider: record.provider,
          model: record.model,
        },
      });
    } catch (err) {
      this.deps.logger.warn('cross-mode-handoff.audit-write-failed', {
        executionId,
        handoffId: handoff.id,
        error: (err as Error).message,
      });
    }
  }
}
