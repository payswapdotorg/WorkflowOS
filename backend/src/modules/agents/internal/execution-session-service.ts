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
  SessionTransitionResult,
} from './execution-session.types.js';
import { ExecutionSessionError } from './execution-session.types.js';
import type { ExecutionRecordRepository } from './execution.types.js';

export interface DefaultExecutionSessionServiceDeps {
  readonly sessionRepository: ExecutionSessionRepository;
  /** Resolves the logical (TEXT) executionId → the ExecutionRecord. */
  readonly executionRecordRepository: ExecutionRecordRepository;
  readonly logger: Logger;
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
