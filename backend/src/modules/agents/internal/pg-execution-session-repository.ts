/**
 * WORK-034 (first slice) — Persistent Session Core: the Pg repository.
 *
 * Mechanical properties (mirrored by migration 0034's triggers as the
 * backstop):
 *   * Every state transition is a repository-level CAS
 *     (WHERE version = $expected AND status = $expected; SET
 *     version = version + 1) — a lost CAS returns null. There is NO
 *     read-check-write session transition anywhere.
 *   * Illegal transition edges throw BEFORE touching the DB (the DB trigger
 *     is the backstop for direct SQL).
 *   * Event appends assign the next sequence under the session row lock
 *     (SELECT ... FOR UPDATE inside a transaction), so concurrent appends
 *     serialize to unique, gap-free-per-writer sequences. Explicit-sequence
 *     appends collide on the DB UNIQUE constraint → typed error.
 *   * Duplicate executions (UNIQUE(execution_id)) + linkage mismatches
 *     (the composite identity FK) map to typed errors.
 *
 * Boundary: internal/ — persistence only. Never mutates workflow /
 * verification / review state; never creates executions (the session
 * REFERENCES an existing ExecutionRecord — it never INSERTs into
 * wfos_executions); never imports provider SDKs; stores no secrets.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  CreateExecutionSessionInput,
  ExecutionSession,
  ExecutionSessionEvent,
  ExecutionSessionEventType,
  ExecutionSessionRepository,
  ExecutionSessionStatus,
  SessionTransitionResult,
} from './execution-session.types.js';
import { EXECUTION_SESSION_TRANSITIONS, ExecutionSessionError } from './execution-session.types.js';

const SESSION_COLUMNS = `id, execution_id, project_id, work_item_id, work_order_id,
       status, version, current_turn, created_at, updated_at,
       interrupted_at, terminal_at`;
const EVENT_COLUMNS = `id, session_id, sequence_number, event_type, payload, created_at`;

interface SessionRow {
  id: string;
  execution_id: string;
  project_id: string;
  work_item_id: string;
  work_order_id: string;
  status: string;
  version: number;
  current_turn: number;
  created_at: Date | string;
  updated_at: Date | string;
  interrupted_at: Date | string | null;
  terminal_at: Date | string | null;
}

interface EventRow {
  id: string;
  session_id: string;
  sequence_number: number;
  event_type: string;
  payload: unknown;
  created_at: Date | string;
}

export class PgExecutionSessionRepository implements ExecutionSessionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async createSession(input: CreateExecutionSessionInput): Promise<ExecutionSession> {
    try {
      const res = await this.db.query<SessionRow>(
        `INSERT INTO wfos_execution_sessions
           (execution_id, project_id, work_item_id, work_order_id)
         VALUES ($1, $2, $3, $4)
         RETURNING ${SESSION_COLUMNS}`,
        [input.executionId, input.projectId, input.workItemId, input.workOrderId],
      );
      return mapSession(res.rows[0]!);
    } catch (err) {
      throw mapCreateError(err, input);
    }
  }

  async getSession(id: string): Promise<ExecutionSession | null> {
    const res = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM wfos_execution_sessions WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? mapSession(res.rows[0]) : null;
  }

  async getSessionByExecutionId(executionId: string): Promise<ExecutionSession | null> {
    const res = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM wfos_execution_sessions WHERE execution_id = $1`,
      [executionId],
    );
    return res.rows[0] ? mapSession(res.rows[0]) : null;
  }

  async transitionSession(
    id: string,
    expectedVersion: number,
    expectedStatus: ExecutionSessionStatus,
    next: ExecutionSessionStatus,
  ): Promise<ExecutionSession | null> {
    // Illegal edges are domain errors — reject BEFORE the DB round-trip so
    // callers get a precise signal (the migration-0034 trigger is the
    // mechanical backstop for direct SQL).
    const legal = EXECUTION_SESSION_TRANSITIONS[expectedStatus] ?? [];
    if (!legal.includes(next)) {
      throw new ExecutionSessionError(
        'execution-session-illegal-transition',
        `execution-session-illegal-transition: ${expectedStatus} -> ${next} is not a legal session transition`,
        { sessionId: id, from: expectedStatus, to: next },
      );
    }
    // The CAS: version + status predicate, version increment, derived
    // timestamps. Lost CAS (version and/or status advanced concurrently)
    // → zero rows → null.
    const res = await this.db.query<SessionRow>(
      `UPDATE wfos_execution_sessions
          SET status = $3,
              version = version + 1,
              interrupted_at = CASE WHEN $3 = 'interrupted' THEN NOW() ELSE interrupted_at END,
              terminal_at = CASE
                              WHEN $3 IN ('completed', 'failed', 'cancelled') THEN COALESCE(terminal_at, NOW())
                              ELSE terminal_at
                            END
        WHERE id = $1
          AND version = $2
          AND status = $4
        RETURNING ${SESSION_COLUMNS}`,
      [id, expectedVersion, next, expectedStatus],
    );
    return res.rows[0] ? mapSession(res.rows[0]) : null;
  }

  async transitionWithEvent(
    id: string,
    expectedVersion: number,
    expectedStatus: ExecutionSessionStatus,
    next: ExecutionSessionStatus,
    eventType: ExecutionSessionEventType,
    payload?: Record<string, unknown>,
  ): Promise<SessionTransitionResult | null> {
    // WORK-034 integration: ATOMIC transition + event append — ONE
    // transaction under the session row lock (the same serialized pattern
    // appendEvent uses):
    //
    //   * the CAS check happens UNDER the lock — after any concurrent
    //     writer commits, the locked read sees the NEWEST committed row, so
    //     a stale snapshot loses cleanly to null with NO side effects;
    //   * the winner's transition + event commit TOGETHER (no crash window
    //     between them);
    //   * the row lock serializes against concurrent appendEvent /
    //     transitionWithEvent callers, so the MAX+1 sequence is
    //     collision-free.
    //
    // STATEMENT ORDERING (deliberate, per transition kind):
    //   * NON-TERMINAL transitions (start/interrupt/resume): the CAS UPDATE
    //     runs FIRST and the event is appended ONLY when the update returns
    //     a row — a CAS loser performs NO writes at all, so even fully
    //     interleaved executions (e.g. a single-session driver) can never
    //     duplicate the event.
    //   * TERMINAL transitions (complete/fail/cancel): the event is
    //     appended FIRST — the migration's terminal-event guard rejects
    //     events once the session row is terminal, so the event must land
    //     while the row is still non-terminal INSIDE this transaction.
    //
    // Illegal transition edges are rejected BEFORE the transaction (same
    // typed pre-validation as transitionSession; the DB trigger is the
    // backstop). The UPDATE retains the full CAS predicate (version +
    // status) as belt-and-braces under the lock.
    const legal = EXECUTION_SESSION_TRANSITIONS[expectedStatus] ?? [];
    if (!legal.includes(next)) {
      throw new ExecutionSessionError(
        'execution-session-illegal-transition',
        `execution-session-illegal-transition: ${expectedStatus} -> ${next} is not a legal session transition`,
        { sessionId: id, from: expectedStatus, to: next },
      );
    }
    const isTerminal = next === 'completed' || next === 'failed' || next === 'cancelled';
    return this.db.transaction(async (tx) => {
      // Lock the session row; READ COMMITTED locked-read semantics return
      // the newest committed version after waiting on any concurrent writer.
      const locked = await tx.query<{ status: string; version: number }>(
        `SELECT status, version FROM wfos_execution_sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!locked.rows[0]) {
        throw new ExecutionSessionError(
          'execution-session-not-found',
          `execution-session-not-found: ${id}`,
          { sessionId: id },
        );
      }
      const currentStatus = String(locked.rows[0].status);
      const currentVersion = Number(locked.rows[0].version);
      if (currentStatus !== expectedStatus || currentVersion !== expectedVersion) {
        // Lost the CAS (a concurrent transition advanced the row). NO side
        // effects: the transaction ends without appending or updating.
        return null;
      }

      const appendEvent = () =>
        tx.query<EventRow>(
          `INSERT INTO wfos_execution_session_events
              (session_id, sequence_number, event_type, payload)
           SELECT $1, COALESCE(MAX(e.sequence_number), 0) + 1, $2, $3::jsonb
             FROM wfos_execution_session_events e
            WHERE e.session_id = $1
           RETURNING ${EVENT_COLUMNS}`,
          [id, eventType, JSON.stringify(payload ?? {})],
        );
      const casUpdate = () =>
        tx.query<SessionRow>(
          `UPDATE wfos_execution_sessions
              SET status = $3,
                  version = version + 1,
                  interrupted_at = CASE WHEN $3 = 'interrupted' THEN NOW() ELSE interrupted_at END,
                  terminal_at = CASE
                                  WHEN $3 IN ('completed', 'failed', 'cancelled') THEN COALESCE(terminal_at, NOW())
                                  ELSE terminal_at
                                END
            WHERE id = $1
              AND version = $2
              AND status = $4
            RETURNING ${SESSION_COLUMNS}`,
          [id, expectedVersion, next, expectedStatus],
        );

      if (isTerminal) {
        // Terminal: event first (the row is still non-terminal inside this
        // transaction — the terminal-event guard passes), then the CAS.
        const evRes = await appendEvent();
        const updRes = await casUpdate();
        if (!updRes.rows[0]) return null; // unreachable under the lock
        return { session: mapSession(updRes.rows[0]), event: mapEvent(evRes.rows[0]!) };
      }
      // Non-terminal: CAS first; the event is appended ONLY by the winner
      // (a lost CAS writes nothing).
      const updRes = await casUpdate();
      if (!updRes.rows[0]) return null;
      const evRes = await appendEvent();
      return { session: mapSession(updRes.rows[0]), event: mapEvent(evRes.rows[0]!) };
    });
  }

  async advanceTurn(id: string, expectedVersion: number): Promise<ExecutionSession | null> {
    // CAS the turn increment — only from the running status.
    const res = await this.db.query<SessionRow>(
      `UPDATE wfos_execution_sessions
          SET current_turn = current_turn + 1,
              version = version + 1
        WHERE id = $1
          AND version = $2
          AND status = 'running'
        RETURNING ${SESSION_COLUMNS}`,
      [id, expectedVersion],
    );
    return res.rows[0] ? mapSession(res.rows[0]) : null;
  }

  async appendEvent(
    sessionId: string,
    eventType: ExecutionSessionEventType,
    payload?: Record<string, unknown>,
  ): Promise<ExecutionSessionEvent> {
    // The next sequence is assigned UNDER THE SESSION ROW LOCK inside a
    // transaction: concurrent appends serialize (the second waits for the
    // first's commit, then reads the new MAX) — unique, collision-free
    // sequences with no retry loop.
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<{ status: string }>(
        `SELECT status FROM wfos_execution_sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      if (!locked.rows[0]) {
        throw new ExecutionSessionError(
          'execution-session-not-found',
          `execution-session-not-found: ${sessionId}`,
          { sessionId },
        );
      }
      const status = locked.rows[0].status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        throw new ExecutionSessionError(
          'execution-session-terminal',
          `execution-session-terminal: session ${sessionId} is terminal (${status}) — no further events`,
          { sessionId, status },
        );
      }
      const res = await tx.query<EventRow>(
        `INSERT INTO wfos_execution_session_events
            (session_id, sequence_number, event_type, payload)
         SELECT $1, COALESCE(MAX(e.sequence_number), 0) + 1, $2, $3::jsonb
           FROM wfos_execution_session_events e
          WHERE e.session_id = $1
         RETURNING ${EVENT_COLUMNS}`,
        [sessionId, eventType, JSON.stringify(payload ?? {})],
      );
      return mapEvent(res.rows[0]!);
    });
  }

  async appendEventWithSequence(
    sessionId: string,
    sequenceNumber: number,
    eventType: ExecutionSessionEventType,
    payload?: Record<string, unknown>,
  ): Promise<ExecutionSessionEvent> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<{ status: string }>(
        `SELECT status FROM wfos_execution_sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      if (!locked.rows[0]) {
        throw new ExecutionSessionError(
          'execution-session-not-found',
          `execution-session-not-found: ${sessionId}`,
          { sessionId },
        );
      }
      const status = locked.rows[0].status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        throw new ExecutionSessionError(
          'execution-session-terminal',
          `execution-session-terminal: session ${sessionId} is terminal (${status}) — no further events`,
          { sessionId, status },
        );
      }
      try {
        const res = await tx.query<EventRow>(
          `INSERT INTO wfos_execution_session_events
              (session_id, sequence_number, event_type, payload)
           VALUES ($1, $2, $3, $4::jsonb)
           RETURNING ${EVENT_COLUMNS}`,
          [sessionId, sequenceNumber, eventType, JSON.stringify(payload ?? {})],
        );
        return mapEvent(res.rows[0]!);
      } catch (err) {
        const dup = err as { code?: string; constraint?: string };
        if (dup.code === '23505' && dup.constraint === 'wfos_execution_session_events_sequence_unique') {
          throw new ExecutionSessionError(
            'execution-session-event-duplicate-sequence',
            `execution-session-event-duplicate-sequence: sequence ${sequenceNumber} already exists for session ${sessionId}`,
            { sessionId, sequenceNumber },
          );
        }
        throw err;
      }
    });
  }

  async listEvents(sessionId: string): Promise<readonly ExecutionSessionEvent[]> {
    const res = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM wfos_execution_session_events
        WHERE session_id = $1
        ORDER BY sequence_number ASC`,
      [sessionId],
    );
    return res.rows.map(mapEvent);
  }
}

// ---------------------------------------------------------------------------
// error mapping + row mappers
// ---------------------------------------------------------------------------

function mapCreateError(err: unknown, input: CreateExecutionSessionInput): Error {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === '23505' && e.constraint === 'wfos_execution_sessions_execution_unique') {
    return new ExecutionSessionError(
      'execution-session-duplicate-execution',
      `execution-session-duplicate-execution: execution ${input.executionId} already has a session (one session per ExecutionRecord)`,
      { executionId: input.executionId },
    );
  }
  if (e.code === '23503' && e.constraint === 'wfos_execution_sessions_execution_linkage_fkey') {
    return new ExecutionSessionError(
      'execution-session-linkage-mismatch',
      `execution-session-linkage-mismatch: the (execution, project, work item, work order) tuple does not match execution ${input.executionId}`,
      { executionId: input.executionId, projectId: input.projectId, workItemId: input.workItemId, workOrderId: input.workOrderId },
    );
  }
  // Anything else (including ExecutionSessionError already thrown by the
  // caller) passes through unchanged.
  return err instanceof Error ? err : new Error(String(err));
}

function toDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

function mapSession(r: SessionRow): ExecutionSession {
  return {
    id: String(r.id),
    executionId: String(r.execution_id),
    projectId: String(r.project_id),
    workItemId: String(r.work_item_id),
    workOrderId: String(r.work_order_id),
    status: r.status as ExecutionSessionStatus,
    version: Number(r.version),
    currentTurn: Number(r.current_turn),
    createdAt: toDate(r.created_at)!,
    updatedAt: toDate(r.updated_at)!,
    interruptedAt: toDate(r.interrupted_at),
    terminalAt: toDate(r.terminal_at),
  };
}

function mapEvent(r: EventRow): ExecutionSessionEvent {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    sequenceNumber: Number(r.sequence_number),
    eventType: r.event_type as ExecutionSessionEventType,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    createdAt: toDate(r.created_at)!,
  };
}
