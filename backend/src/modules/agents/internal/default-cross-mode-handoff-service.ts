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
 *   8. reserve: INSERT append-only handoff log row (previous_* snapshot +
 *      idempotency_key). Catch 23505 -> converge (same key) / reject (diff key).
 *   9-10. mutate record (transitionMode mode+status) THEN dispatch (provider
 *        submit) THEN updateStatus (provider outcome) — crash-safety: a crash
 *        after mutate but before dispatch is recoverable (retry sees the
 *        mutated record + re-dispatches); a crash after dispatch converges
 *        (the agentRunRepository.findByExecutionId guard skips a second
 *        AgentRun for external->native; the ExternalExecutionProvider
 *        regenerates the package idempotently for native->external).
 *   11. audit (best-effort — try/catch, never breaks flow).
 *   12. return { executionId, handoff, record (re-fetch) }.
 *
 * CONCURRENCY: the handoff log table UNIQUE(execution_record_id) is the hard
 * fence. Two concurrent handoff requests -> the first INSERT wins; the second
 * gets a 23505 -> the service catches it -> same idempotency_key converges
 * (returns the first's result); different key -> 'already-handed-off' (409).
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
}

/**
 * Narrow agent-provider-registry port (DI cleanliness). The concrete
 * DefaultAgentProviderRegistryService (no separate interface) satisfies this
 * structurally. Used to resolve + validate the native provider availability
 * (fail-closed when no platform-native provider is configured).
 */
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
  /** Native provider availability (WORK-026) — the agent provider registry. */
  readonly agentProviderRegistryService: CrossModeAgentProviderRegistryPort;
  /** PR #46 review #3: the WORK-034 session lifecycle port. */
  readonly executionSessionService: CrossModeExecutionSessionPort;
  /** PR #46 review #1: the WORK-035 workspace port. */
  readonly agentWorkspaceService: CrossModeAgentWorkspacePort;
  readonly auditService: AuditService;
  readonly logger: Logger;
  /**
   * PR #46 review #2: the existing durable queue — the reserve step enqueues
   * the reconcile relay job (the claim-time durable delivery). The obligation
   * row itself is written by migration 0043's trigger ATOMICALLY with the
   * reserve INSERT; the relay job + the WorkerHost boot sweep are the
   * liveness backstop. OPTIONAL so pure-unit constructions stay queueless
   * (the boot sweep covers a missing/failed enqueue).
   */
  readonly queue?: Queue;
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

export class DefaultCrossModeHandoffService implements CrossModeHandoffService {
  private readonly now: () => Date;

  constructor(private readonly deps: DefaultCrossModeHandoffServiceDeps) {
    this.now = deps.now ?? (() => new Date());
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

    // 8. Reserve: INSERT the append-only handoff log row (previous_* snapshot).
    //    PR #46 review #2: migration 0043's AFTER INSERT trigger writes the
    //    durable handoff obligation ATOMICALLY with this INSERT. The reserve
    //    ALSO enqueues the reconcile relay job (the claim-time durable
    //    delivery) — a live worker drains it without any restart; the boot
    //    sweep is the backstop.
    const resultingStatus: 'handoff_ready' | 'running' =
      input.targetMode === 'external' ? 'handoff_ready' : 'running';
    const reserved = await this.reserve({
      record,
      executionId,
      input,
      provider,
      resultingStatus,
      idempotencyKey,
      policySummary,
      actor,
    });
    // Claim-time durable relay job enqueue (best-effort — the boot sweep
    // covers a failed enqueue; the obligation row is the durable source of
    // truth either way).
    await this.enqueueRelayJob(executionId);

    // 9-10. Mutate (transitionMode) THEN drive the session through the
    //       EXISTING non-terminal path (interrupt on native→external; resume
    //       /start on external→native) THEN dispatch THEN updateStatus
    //       (provider outcome). Crash-safety: the mutated record is the
    //       recoverable intermediate state; the dispatch is idempotent on
    //       retry; the session transition is idempotent on retry (a CAS loss
    //       means a concurrent path already moved it — log + continue).
    await this.mutateAndDispatch(
      record,
      executionId,
      input,
      provider,
      model,
      resultingStatus,
      existingSession,
    );

    // 11. Audit (best-effort).
    await this.audit(record, executionId, input, reserved, actor, policySummary);

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
   * PR #46 review #2: idempotent reconciliation — the durable relay entry
   * point (driven by the {@link CrossModeHandoffOutboxRelay} job + the
   * WorkerHost boot sweep, both wired in app.ts). A complete handoff is a
   * no-op + discharges the durable obligation; an interrupted handoff
   * resumes from the appropriate step:
   *   - record.mode !== toMode → re-mutate + re-dispatch (crash window #1:
   *     after reserve, before mutate);
   *   - record.mode === toMode but dispatch outcome missing → re-dispatch
   *     (crash window #2: after mutate, before dispatch);
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

    let stage: 'mutate-and-dispatch' | 'dispatch-external' | 'dispatch-native' | 'complete' = 'complete';

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
      // Re-resolve the session (it may have moved since the reserve — e.g.
      // a concurrent path, or the crash happened mid-mutate). The
      // re-mutate's session transition is idempotent (a CAS loss means a
      // concurrent path already moved it — log + continue).
      const session = await this.deps.executionSessionService.getSessionForExecution(
        executionId,
      );
      // Re-mutate + re-dispatch using the reserved handoff's intent.
      const input: CrossModeHandoffInput = {
        targetMode: handoff.toMode,
        reason: handoff.reason ?? undefined,
        idempotencyKey: handoff.idempotencyKey,
      };
      // Re-derive the resultingStatus deterministically from the toMode (the
      // handoff log row's resultingStatus was set by the service to one of
      // these two values; re-deriving avoids a cast on the ExecutionState).
      const resultingStatus: 'handoff_ready' | 'running' =
        handoff.toMode === 'external' ? 'handoff_ready' : 'running';
      await this.mutateAndDispatch(
        record,
        executionId,
        input,
        record.provider,
        record.model,
        resultingStatus,
        session,
      );
      stage = 'mutate-and-dispatch';
      // Re-fetch the post-mutate+dispatch record for the complete-check.
      record = await this.deps.executionRecordRepository.findByExecutionId(
        executionId,
      );
      if (!record) return { executionId, reconciled: true, stage };
    }

    // Crash window #2: the mutate happened but the dispatch did not. Re-fetch
    // the record's current state + re-dispatch the missing piece.
    const targetMode = handoff.toMode;
    if (targetMode === 'external') {
      // native -> external: the dispatch is complete when the package is
      // present (record.packageValue is set). Otherwise re-dispatch.
      if (!record.packageValue) {
        this.deps.logger.info('cross-mode-handoff.reconcile.re-dispatch', {
          executionId,
          handoffId: handoff.id,
          targetMode,
        });
        await this.dispatchExternal(record, executionId);
        stage = stage === 'complete' ? 'dispatch-external' : stage;
        record = await this.deps.executionRecordRepository.findByExecutionId(
          executionId,
        );
        if (!record) return { executionId, reconciled: true, stage };
      }
    } else {
      // external -> native: the dispatch is complete when an AgentRun exists
      // OR the record reached a terminal native state (completed/failed).
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
        await this.dispatchNative(record, executionId, record.model);
        stage = stage === 'complete' ? 'dispatch-native' : stage;
      }
    }

    // PR #46 review #2: complete — discharge the durable obligation. After a
    // re-mutate+re-dispatch OR a re-dispatch, fall through to the
    // complete-check (the handoff is now complete: record.mode === toMode +
    // the dispatch outcome is present). A complete handoff discharges (the
    // boot-sweep work list drains; a repeated recovery is a no-op). An
    // incomplete handoff (e.g. the dispatch is async + not yet landed) leaves
    // the obligation pending for the next pass.
    const complete = await this.handoffComplete(record, handoff);
    if (complete) {
      await this.deps.crossModeHandoffRepository.dischargeHandoffObligation(handoff.id);
      return { executionId, reconciled: false, stage: 'complete' };
    }
    return { executionId, reconciled: true, stage };
  }

  /**
   * PR #46 review #2: the complete-check. The handoff is complete when:
   *   - record.mode === toMode (the mutate landed), AND
   *   - the dispatch outcome is present: package for native→external,
   *     AgentRun-or-terminal for external→native.
   * Used by {@link reconcileCrossModeHandoffForExecution} to decide discharge.
   */
  private async handoffComplete(
    record: ExecutionRecord,
    handoff: CrossModeHandoffRecord,
  ): Promise<boolean> {
    if (record.mode !== handoff.toMode) return false;
    if (handoff.toMode === 'external') {
      return record.packageValue != null;
    }
    // external → native: complete when an AgentRun exists OR the record
    // reached a terminal native state.
    const existingRun = await this.deps.agentRunRepository.findByExecutionId(
      record.executionId,
    );
    const terminalNative =
      record.status === 'completed' || record.status === 'failed';
    return existingRun != null || terminalNative;
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
   * PR #46 review #2: the claim-time durable relay job enqueue (mirrors the
   * WORK-034 session-terminal relay's claim-time enqueue in
   * {@link DefaultExecutionSessionService.terminalForExecution}). Best-effort:
   * the obligation row (migration 0043) is the durable source of truth; the
   * boot sweep covers a failed enqueue. A live worker drains the job without
   * any restart; the relay + the boot sweep guarantee eventual delivery of an
   * interrupted handoff.
   */
  private async enqueueRelayJob(executionId: string): Promise<void> {
    if (!this.deps.queue) return; // queueless construction (pure-unit tests) —
    // the boot sweep is the backstop. Production wires the RedisQueue.
    try {
      await this.deps.queue.enqueue(CROSS_MODE_HANDOFF_RELAY_JOB_TYPE, { executionId });
    } catch (err) {
      this.deps.logger.error('cross-mode-handoff.relay-enqueue-failed', {
        executionId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * PR #46 review #3: drive the ExecutionSession through the EXISTING
   * non-terminal path on a cross-mode handoff (NEVER silently continues a
   * terminal session — the eligibility gate already rejected that).
   *   - native→external: interrupt a `running` session (running → interrupted)
   *     — the legitimate non-terminal interruption path. The session-terminal
   *     obligation (if pending) is DEFERRED by the existing reconcile (it sees
   *     `interrupted` + leaves it pending). The session is NOT terminalized.
   *   - external→native: resume an `interrupted` session (interrupted →
   *     running), or start a `created` session (created → running) — the
   *     legitimate resume path.
   * Idempotent on retry: a CAS loss (null result) means a concurrent path
   * already moved the session — log + continue (the handoff is still
   * authoritative on the record). No session (null) → no-op (the external
   * phase has no native session; a native handoff may create one downstream).
   */
  private async transitionSessionForHandoff(
    session: ExecutionSession | null,
    targetMode: ExecutionMode,
    executionId: string,
  ): Promise<void> {
    if (!session) return;
    try {
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
          // null → a concurrent path already moved it (or the CAS lost) — log.
        }
        // created / interrupted → leave (no transition needed; the external
        // phase does not drive the native session).
      } else {
        // external → native: resume an interrupted session, or start a
        // created session.
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
        } else if (session.status === 'created') {
          const result = await this.deps.executionSessionService.startSession(
            session.id,
          );
          if (result) {
            this.deps.logger.info('cross-mode-handoff.session.started', {
              executionId, sessionId: session.id,
            });
          }
        }
        // running → leave (already running — no transition needed).
      }
    } catch (err) {
      // The session transition is best-effort w.r.t. the handoff flow: a
      // failure here does NOT roll back the record mutation (the record is
      // the authoritative handoff state; the session is the continuation
      // context). Log + continue — the reconcile relay + the boot sweep will
      // re-attempt the session transition on the next pass if needed (the
      // session stays non-terminal; the obligation stays pending).
      this.deps.logger.warn('cross-mode-handoff.session-transition-failed', {
        executionId, sessionId: session.id, targetMode,
        error: (err as Error).message,
      });
    }
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
   * Reserve: INSERT the append-only handoff log row with the previous_*
   * snapshot. Catch the 23505 ('cross-mode-handoff-already-exists') -> the
   * service re-resolves convergence vs reject.
   */
  private async reserve(args: {
    record: ExecutionRecord;
    executionId: string;
    input: CrossModeHandoffInput;
    provider: string;
    resultingStatus: 'handoff_ready' | 'running';
    idempotencyKey: string;
    policySummary: string;
    actor: { userId: string; source: string };
  }): Promise<CrossModeHandoffRecord> {
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
      return await this.deps.crossModeHandoffRepository.createHandoff(createInput);
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
          this.deps.logger.info('cross-mode-handoff.reserve.convergent', {
            executionId: args.executionId,
            idempotencyKey: args.idempotencyKey,
            handoffId: existing.id,
          });
          return existing;
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
   * Mutate the record to the target mode + status (transitionMode), THEN
   * drive the ExecutionSession through the EXISTING non-terminal path
   * (interrupt on native→external; resume/start on external→native — PR #46
   * review #3), THEN dispatch through the appropriate provider, THEN
   * updateStatus with the provider outcome. Crash-safety: the mutated
   * record is the recoverable intermediate state (a retry sees
   * record.mode=targetMode, status=resultingStatus, and re-dispatches); the
   * session transition is idempotent on retry (a CAS loss means a concurrent
   * path already moved it — log + continue).
   */
  private async mutateAndDispatch(
    record: ExecutionRecord,
    executionId: string,
    input: CrossModeHandoffInput,
    provider: string,
    model: string | null,
    resultingStatus: 'handoff_ready' | 'running',
    session: ExecutionSession | null,
  ): Promise<void> {
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

    // 9b. PR #46 review #3: drive the ExecutionSession through the EXISTING
    //     non-terminal path (NEVER silently continues a terminal session —
    //     the eligibility gate already rejected that). native→external
    //     interrupts a running session (running → interrupted); external→
    //     native resumes an interrupted session (interrupted → running) or
    //     starts a created session (created → running). Best-effort w.r.t.
    //     the handoff flow (a CAS loss + a failure log + continue — the
    //     record mutation is authoritative; the session stays non-terminal).
    await this.transitionSessionForHandoff(session, input.targetMode, executionId);

    // 10. Dispatch through the target provider. The dispatch sub-methods
    //    use the POST-MUTATE record (provider/model already set) + the
    //    caller-resolved model for native (the NativeExecutionProvider
    //    requires a non-null model).
    if (input.targetMode === 'external') {
      await this.dispatchExternal(mutated, executionId);
    } else {
      await this.dispatchNative(mutated, executionId, model);
    }
  }

  /**
   * native -> external dispatch: rebuild the task (mode=external, reuse the
   * ImplementationContext), submit through the ExternalExecutionProvider
   * (deterministic package), then updateStatus with the package + expires_at.
   * The ExternalExecutionProvider is idempotent (regenerates the package) —
   * a retry re-dispatch is safe.
   */
  private async dispatchExternal(
    record: ExecutionRecord,
    executionId: string,
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
      const submission = await this.deps.externalExecutionProvider.submit(
        built.task,
      );
      const pkg = submission.package ?? null;
      const expiresAt = submission.expiresAt ?? null;
      if (!pkg) {
        throw new Error(
          `cross-mode-handoff-external-package-missing: the ExternalExecutionProvider returned no package for execution ${executionId}`,
        );
      }
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: 'handoff_ready',
        packageValue: pkg,
        expiresAt,
      });
    } catch (err) {
      // The dispatch failed — the record stays at mode=external/status=
      // handoff_ready (the mutated intermediate state). Surface a typed
      // 'handoff-dispatch-failed' so the route returns 500. The handoff LOG
      // row preserves the intent (the correction chain is visible).
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
   * AgentGateway — NO second gateway). On success, updateStatus with the
   * agentRunId + completed; on failure, updateStatus to failed + propagate
   * 'handoff-dispatch-failed'.
   */
  private async dispatchNative(
    record: ExecutionRecord,
    executionId: string,
    model: string | null,
  ): Promise<void> {
    // Crash-retry guard: if a native AgentRun already exists for this
    // execution, skip dispatch + use it (a second submit would hit the
    // wfos_agent_runs.execution_id UNIQUE).
    const existingRun = await this.deps.agentRunRepository.findByExecutionId(
      executionId,
    );
    if (existingRun) {
      this.deps.logger.info('cross-mode-handoff.dispatch-native-existing-run', {
        executionId,
        agentRunId: existingRun.id,
      });
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: 'completed',
        agentRunId: existingRun.id,
        startedAt: existingRun.startedAt,
        completedAt: existingRun.completedAt,
      });
      return;
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
      const submission = await this.deps.nativeExecutionProvider.submit(
        built.task,
      );
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: submission.status === 'completed' ? 'completed' : submission.status,
        agentRunId: submission.agentRunId ?? null,
        startedAt: submission.startedAt ?? null,
        completedAt: submission.completedAt ?? null,
      });
    } catch (err) {
      // Native dispatch failed — persist the failure (the record is the
      // authoritative failure record), then propagate 'handoff-dispatch-
      // failed'. The handoff LOG row preserves the intent.
      const now = this.now();
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: 'failed',
        completedAt: now,
        benchmarkMetadata: {
          failureStage: 'cross-mode-native-dispatch',
          errorMessage: (err as Error).message,
        },
      });
      this.deps.logger.error('cross-mode-handoff.dispatch-native-failed', {
        executionId,
        error: (err as Error).message,
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
