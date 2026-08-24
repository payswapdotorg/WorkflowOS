/**
 * WORK-034 integration — DefaultExecutionSessionService.
 *
 * The /agents-owned session lifecycle boundary: composes the repository's
 * CAS transitions with the append-only event store so every lifecycle
 * change is ATOMIC + observable. Used by the ExecutionService integration
 * (optional dep) + the external-ingestion terminal hook (composition
 * root) + future resume flows.
 *
 * Identity model: the service speaks the LOGICAL execution identity (the
 * TEXT executionId used by the routes, the AgentGateway, and the external
 * event boundary) and resolves the ExecutionRecord internally — the
 * session CONTINUES that one record; it never creates an ExecutionRecord
 * and can never be attached to a different one. Session identity ≠
 * provider/mode/model identity, so a future cross-mode handoff
 * (WORK-042) can move the execution between native and external without
 * re-identifying the session.
 *
 * Authority model: NEVER mutates workflow / verification / review / GitHub
 * state — a session reaching 'completed' does NOT mean Work Item=VERIFIED
 * (/verification owns that) nor PR=MERGED (GitHub owns that). Never
 * dispatches execution (ExecutionService remains the single execution
 * authority — no second engine).
 *
 * Crash/idempotency guarantees:
 *   - ensureSession is lookup-or-create: a retry after "session created →
 *     crash" returns the SAME session (the UNIQUE(execution_id) constraint
 *     makes duplicates impossible).
 *   - Every transition is repository-level CAS via the atomic
 *     transitionWithEvent statement (transition + event in ONE commit): a
 *     CAS loser performs NO side effects (no event, no state change), so
 *     concurrent starts/resumes have exactly one winner and retries never
 *     duplicate events.
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import type { Logger } from '@platform/logger.js';
import type {
  ExecutionSession,
  ExecutionSessionEvent,
  ExecutionSessionEventType,
  ExecutionSessionRepository,
  ExecutionSessionService,
  PendingSessionTerminal,
  SessionTransitionResult,
} from './execution-session.types.js';
import { ExecutionSessionError } from './execution-session.types.js';
import type { ExecutionRecordRepository } from './execution.types.js';
import { SESSION_TERMINAL_RELAY_JOB_TYPE } from './session-terminal-relay.js';
import type { Queue } from '@platform/index.js';

export interface DefaultExecutionSessionServiceDeps {
  readonly sessionRepository: ExecutionSessionRepository;
  /** Resolves the logical (TEXT) executionId → the ExecutionRecord. */
  readonly executionRecordRepository: ExecutionRecordRepository;
  readonly logger: Logger;
  /**
   * PR #38 review (durable terminalization): the existing durable queue —
   * completeSession/failSession enqueue the reconcile relay job (the
   * claim-time durable delivery). The obligation row itself is written by
   * migration 0035's trigger ATOMICALLY with the record's terminal
   * transition; the relay job + the WorkerHost boot sweep are the liveness
   * backstop. OPTIONAL so pure-unit constructions stay queueless.
   */
  readonly queue?: Queue;
}

export class DefaultExecutionSessionService implements ExecutionSessionService {
  constructor(private readonly deps: DefaultExecutionSessionServiceDeps) {}

  async ensureSession(executionId: string): Promise<ExecutionSession> {
    // Resolve the logical execution identity → the authoritative record.
    // The record's OWN identity tuple feeds createSession — callers cannot
    // supply a mismatched linkage (and the composite FK is the backstop).
    const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
    if (!record) {
      throw new ExecutionSessionError(
        'execution-session-not-found',
        `execution-session-not-found: no ExecutionRecord exists for executionId ${executionId} — a session continues an existing execution; it never creates one`,
        { executionId },
      );
    }
    const existing = await this.deps.sessionRepository.getSessionByExecutionId(record.id);
    if (existing) return existing;
    try {
      return await this.deps.sessionRepository.createSession({
        executionId: record.id,
        projectId: record.projectId,
        workItemId: record.workItemId,
        workOrderId: record.workOrderId,
      });
    } catch (err) {
      if (err instanceof ExecutionSessionError && err.code === 'execution-session-duplicate-execution') {
        // A concurrent creator won the ensure race — there is still exactly
        // one session; return it.
        const raced = await this.deps.sessionRepository.getSessionByExecutionId(record.id);
        if (raced) return raced;
      }
      throw err;
    }
  }

  async startSession(sessionId: string): Promise<ExecutionSession | null> {
    // CAS created → running + turn_started. A read chooses the CAS
    // parameters (the write itself stays CAS-guarded); a session that is
    // already running/terminal (e.g. a retry) → null, NO duplicate
    // turn_started event, no side effects.
    const session = await this.deps.sessionRepository.getSession(sessionId);
    if (!session) {
      throw new ExecutionSessionError(
        'execution-session-not-found',
        `execution-session-not-found: ${sessionId}`,
        { sessionId },
      );
    }
    if (session.status !== 'created') return null;
    const result = await this.deps.sessionRepository.transitionWithEvent(
      sessionId, session.version, 'created', 'running', 'turn_started',
    );
    return result?.session ?? null;
  }

  async interruptSession(sessionId: string, expectedVersion: number): Promise<SessionTransitionResult | null> {
    // CAS running → interrupted + the interrupted event. Interruption is a
    // FIRST-CLASS resumable state — never a disguised success/failure.
    return this.deps.sessionRepository.transitionWithEvent(
      sessionId, expectedVersion, 'running', 'interrupted', 'interrupted',
    );
  }

  async resumeSession(sessionId: string, expectedVersion: number): Promise<SessionTransitionResult | null> {
    // CAS interrupted → running + the resumed event. The identity chain
    // (executionId / sessionId / WorkItem / WorkOrder) is untouched — the
    // session CONTINUES the same logical execution; no new
    // ExecutionRecord, no new Session.
    return this.deps.sessionRepository.transitionWithEvent(
      sessionId, expectedVersion, 'interrupted', 'running', 'resumed',
    );
  }

  async completeSession(executionId: string): Promise<ExecutionSession | null> {
    return this.terminalForExecution(executionId, 'completed');
  }

  async failSession(executionId: string, reason: string): Promise<ExecutionSession | null> {
    return this.terminalForExecution(executionId, 'failed', { reason });
  }

  async getSessionForExecution(executionId: string): Promise<ExecutionSession | null> {
    const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
    if (!record) return null;
    return this.deps.sessionRepository.getSessionByExecutionId(record.id);
  }

  async listSessionEvents(sessionId: string): Promise<readonly ExecutionSessionEvent[]> {
    return this.deps.sessionRepository.listEvents(sessionId);
  }

  // --- WORK-034 (PR #38 review): durable terminal reconciliation -------

  async reconcileTerminalForExecution(executionId: string): Promise<ExecutionSession | null> {
    // Idempotent, concurrency-safe reconciliation of ONE execution's
    // obligation (the relay job handler + per-execution recovery path):
    //   resolve logical id → record → session;
    //   if the session is already in the obligation's terminal state →
    //     just discharge (a repeated recovery never duplicates the event);
    //   if the session is running → CAS to the terminal state + event,
    //     then discharge;
    //   if the session is created/interrupted → leave it (the strict state
    //     machine forbids terminalizing a paused session; a later resume
    //     flow owns the outcome) — the obligation stays pending for the
    //     next pass;
    //   no record / no session → nothing to reconcile.
    const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
    if (!record) return null;
    const session = await this.deps.sessionRepository.getSessionByExecutionId(record.id);
    if (!session) return null;

    // Find the pending obligation for this execution (if any).
    const pending = await this.deps.sessionRepository.listPendingTerminalObligations();
    const obligation = pending.find((p) => p.session?.id === session.id);
    if (!obligation) {
      // No pending obligation: either already reconciled (discharged) or
      // the execution never terminalized. Nothing to do.
      return session;
    }
    return this.reconcileObligation(obligation);
  }

  async reconcileAllPendingTerminals(): Promise<number> {
    // One pass over the durable work list (the boot sweep / the batch job
    // entry). NOT a retry loop — anything still pending after the pass
    // stays durable for the next touch/sweep.
    const pending = await this.deps.sessionRepository.listPendingTerminalObligations();
    let stillPending = 0;
    for (const p of pending) {
      const result = await this.reconcileObligation(p);
      if (result === null) stillPending += 1;
    }
    return stillPending;
  }

  /** Reconcile one obligation (returns null when it stays pending). */
  private async reconcileObligation(p: PendingSessionTerminal): Promise<ExecutionSession | null> {
    const { obligation, session } = p;
    if (!session) {
      // The execution has no session (a legacy execution, or the session
      // creation failed). Nothing to reconcile — discharge so the work
      // list drains (the obligation remains the auditable record that the
      // execution DID terminalize).
      await this.deps.sessionRepository.dischargeTerminalObligation(obligation.id);
      return null;
    }
    if (session.status === obligation.terminalState) {
      // Already reconciled (a repeated recovery / the fast path won the
      // race): discharge WITHOUT a duplicate terminal event.
      await this.deps.sessionRepository.dischargeTerminalObligation(obligation.id);
      return session;
    }
    if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
      // The session is terminal in a DIFFERENT state than the obligation
      // recorded (e.g. the session was cancelled while the execution
      // completed). The session is immutable — record the divergence
      // loudly + discharge (the session's own terminal state stands; the
      // obligation is not a license to violate terminal immutability).
      this.deps.logger.warn('execution-session.terminal-obligation-divergence', {
        obligationId: obligation.id,
        sessionId: session.id,
        obligationState: obligation.terminalState,
        sessionState: session.status,
      });
      await this.deps.sessionRepository.dischargeTerminalObligation(obligation.id);
      return session;
    }
    if (session.status !== 'running') {
      // created/interrupted: the strict state machine forbids direct
      // terminalization (a paused session must be resumed first — the
      // resume flow owns its outcome). Leave the obligation pending.
      this.deps.logger.warn('execution-session.terminal-obligation-deferred-not-running', {
        obligationId: obligation.id,
        sessionId: session.id,
        status: session.status,
      });
      return null;
    }
    // running → the obligation's terminal state, atomically (CAS + event),
    // then discharge. Concurrent reconciliations: the CAS has exactly one
    // winner; the loser sees null and leaves the discharge to the winner
    // (a later pass re-checks — already-terminal → discharge, no
    // duplicate event).
    const eventType: ExecutionSessionEventType = obligation.terminalState === 'completed' ? 'completed' : 'failed';
    const transition = await this.deps.sessionRepository.transitionWithEvent(
      session.id, session.version, 'running', obligation.terminalState, eventType,
    );
    if (!transition) {
      // Lost the CAS to a concurrent reconciler. Leave pending.
      return null;
    }
    await this.deps.sessionRepository.dischargeTerminalObligation(obligation.id);
    return transition.session;
  }

  // ------------------------------------------------------------------ private

  /**
   * Terminal transition for the execution's session. Idempotent:
   *   * no record / no session for the execution (e.g. a legacy execution
   *     created before WORK-034) → null, a NO-OP;
   *   * already terminal → the session as-is (a retry after a terminal
   *     transition must not duplicate side effects);
   *   * not currently running (created/interrupted) → the session as-is +
   *     a loud log: the strict state machine forbids terminalizing a
   *     paused session directly (an interrupted session must be resumed
   *     first — the resume flow owns its outcome).
   */
  private async terminalForExecution(
    executionId: string,
    next: 'completed' | 'failed',
    payload: Record<string, unknown> = {},
  ): Promise<ExecutionSession | null> {
    // PR #38 review (durable terminalization): the obligation row was
    // written ATOMICALLY with the record's terminal transition (migration
    // 0035's trigger — there is no moment where the record is terminal but
    // the obligation is missing). Enqueue the reconcile relay job FIRST
    // (the claim-time durable delivery): even if the process dies before
    // or during the session CAS below, the durable job + the boot sweep
    // recover it. Best-effort enqueue (the boot sweep covers a failed
    // enqueue).
    if (this.deps.queue) {
      try {
        await this.deps.queue.enqueue(SESSION_TERMINAL_RELAY_JOB_TYPE, { executionId });
      } catch (err) {
        this.deps.logger.error('session-terminal.relay-enqueue-failed', {
          executionId,
          error: (err as Error).message,
        });
      }
    }
    const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
    if (!record) return null;
    const session = await this.deps.sessionRepository.getSessionByExecutionId(record.id);
    if (!session) return null;
    if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
      return session;
    }
    if (session.status !== 'running') {
      this.deps.logger.warn('execution-session.terminal-skipped-not-running', {
        executionId,
        sessionId: session.id,
        status: session.status,
        next,
      });
      return session;
    }
    const eventType: ExecutionSessionEventType = next === 'completed' ? 'completed' : 'failed';
    const result = await this.deps.sessionRepository.transitionWithEvent(
      session.id, session.version, 'running', next, eventType, payload,
    );
    return result?.session ?? null;
  }
}
