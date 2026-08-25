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

  /**
   * CAS running → cancelled + the cancelled event — the session-terminal
   * mapping for an execution-record cancellation (PR #38 review
   * correction #2: the COMPLETE execution terminal-state mapping). Same
   * durable protocol as complete/fail.
   */
  async cancelSession(executionId: string): Promise<ExecutionSession | null> {
    return this.terminalForExecution(executionId, 'cancelled');
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
    //   resolve logical id → record;
    //   ENSURE the session exists (PR #38 review correction #1: a missing
    //     session is the recoverable crash window — create it from the
    //     record so the reconciliation is autonomous; it starts 'created'
    //     and the obligation stays pending until it can be driven to the
    //     terminal state below);
    //   if the session is already in the obligation's terminal state →
    //     just discharge (a repeated recovery never duplicates the event);
    //   if the session is running → CAS + event + DISCHARGE atomically;
    //   if the session is created/interrupted → leave it (the strict state
    //     machine forbids terminalizing a paused session; a later resume
    //     flow owns the outcome) — the obligation stays pending for the
    //     next pass;
    //   no record → nothing to reconcile.
    const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
    if (!record) return null;
    // Ensure the session (idempotent — one per record; the UNIQUE
    // constraint + the createSession linkage-FK make this safe).
    const session = await this.ensureSession(executionId);

    // Find the pending obligation for this execution (if any).
    const pending = await this.deps.sessionRepository.listPendingTerminalObligations();
    const obligation = pending.find((p) => p.session?.id === session.id);
    if (!obligation) {
      // No pending obligation: either already reconciled (discharged) or
      // the execution never terminalized. Nothing to do.
      return session;
    }
    // A newly-ensured session starts 'created' — the strict state machine
    // has NO created→terminal edge (a session must run before it can
    // terminally complete/fail). For the crash-window case (the record
    // terminalized before the session ever started), advance created →
    // running FIRST (CAS; idempotent — a loser means a concurrent path
    // already advanced it), then reconcile the terminal obligation. This
    // keeps every transition on the legal graph.
    if (session.status === 'created') {
      await this.startSession(session.id);
    }
    return this.reconcileObligation({
      obligation: obligation.obligation,
      session: await this.deps.sessionRepository.getSession(session.id),
    });
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
      // PR #38 review correction #1: a MISSING session is a recoverable
      // crash window (the record terminalized before/despite the session
      // creation). The obligation MUST REMAIN PENDING — discharging here
      // would orphan a session created later (created/running forever with
      // the obligation gone). The session becomes reconcilable the moment
      // the normal session-creation path (ensureSession) runs; the relay
      // ALSO ensures the session from the existing record below, so
      // recovery is autonomous even if the caller never retries.
      this.deps.logger.warn('execution-session.terminal-obligation-no-session', {
        obligationId: obligation.id,
        executionId: obligation.executionId,
      });
      return null;
    }
    if (session.status === obligation.terminalState) {
      // Already reconciled (a repeated recovery / a fast path that won the
      // race before the atomic-discharge correction): discharge WITHOUT a
      // duplicate terminal event.
      await this.deps.sessionRepository.dischargeTerminalObligation(obligation.id);
      return session;
    }
    if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
      // The session is terminal in a DIFFERENT state than the obligation
      // recorded (e.g. the session was cancelled while the execution
      // completed). The session is immutable — record the divergence
      // VISIBLY (a loud log; the obligation + the session are both durable
      // evidence of the divergence) + discharge so the work list drains.
      // The session's own terminal state stands: terminal immutability is
      // not negotiable, and the obligation is not a license to violate it.
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
      // terminalization (created→terminal is not an edge; a paused session
      // must be resumed first — the resume flow owns its outcome). Leave
      // the obligation pending.
      this.deps.logger.warn('execution-session.terminal-obligation-deferred-not-running', {
        obligationId: obligation.id,
        sessionId: session.id,
        status: session.status,
      });
      return null;
    }
    // running → the obligation's terminal state, ATOMICALLY (CAS + event +
    // DISCHARGE — one transaction, one authoritative outcome; PR #38
    // review correction #3). Concurrent reconciliations: the CAS has
    // exactly one winner; a loser performs NO writes (the obligation stays
    // pending for the next pass).
    // The terminal event payload preserves the TRUE execution outcome:
    // an expired execution is a failed SESSION, but the event records
    // 'execution-expired' (round 3: the durable evidence never lies about
    // WHY the session failed).
    const eventPayload =
      obligation.terminalState === 'failed'
        ? { reason: `execution-${obligation.sourceExecutionStatus}` }
        : {};
    const transition = await this.deps.sessionRepository.transitionWithEvent(
      session.id, session.version, 'running', obligation.terminalState,
      obligation.terminalState as ExecutionSessionEventType,
      eventPayload,
      obligation.id,
    );
    if (!transition) {
      // Lost the CAS to a concurrent reconciler. Leave pending.
      return null;
    }
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
    next: 'completed' | 'failed' | 'cancelled',
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
    // PR #38 review correction #3: the FAST PATH discharges the durable
    // obligation ATOMICALLY with the terminal transition + event (one
    // transaction, one authoritative outcome) — a successful synchronous
    // reconciliation leaves NO pending obligation behind. Resolve the
    // pending obligation for THIS execution (if any) + pass its id.
    const pending = await this.deps.sessionRepository.listPendingTerminalObligations();
    const obligation = pending.find((p) => p.session?.id === session.id);
    const eventType: ExecutionSessionEventType = next === 'cancelled' ? 'cancelled' : (next as ExecutionSessionEventType);
    const result = await this.deps.sessionRepository.transitionWithEvent(
      session.id, session.version, 'running', next, eventType, payload,
      obligation?.obligation.id,
    );
    // If the CAS lost (a concurrent reconciler won + discharged), leave
    // nothing pending — verify via a re-read (the winner's atomic discharge
    // covered it).
    return result?.session ?? null;
  }
}
