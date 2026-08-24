/**
 * WORK-034 (first slice) — Persistent Session Core: the provider-independent
 * session contracts inside /agents.
 *
 * An ExecutionSession is the CONTINUATION CONTEXT for exactly ONE
 * ExecutionRecord — the same engineering-task identity chain:
 *
 *     WorkItem → WorkOrder → ExecutionRecord → ExecutionSession
 *                                                ├── event 1
 *                                                ├── event 2
 *                                                └── ...
 *
 * The session does NOT create another logical engineering task, another
 * execution engine, another workflow/verification/review authority, or any
 * provider-specific surface. It persists the durable turn/event state of
 * one execution so a later slice can resume it.
 *
 * State machine (strict; mechanically enforced by the migration-0034
 * transition-guard trigger; every transition is a repository-level CAS):
 *
 *     created → running
 *     running → interrupted → running (resumable)
 *     running → completed | failed | cancelled
 *     created | interrupted → cancelled
 *
 * Terminal states (completed/failed/cancelled) are immutable. `interrupted`
 * is always resumable. `version` is the optimistic-concurrency token —
 * every transition CAS-increments it; a lost CAS returns null.
 *
 * Boundary: pure types + the repository CONTRACT only. The Pg
 * implementation lives in pg-execution-session-repository.ts (also
 * internal/). The /agents barrel re-exports the public contract names
 * (ExecutionSession, ExecutionSessionStatus, ExecutionSessionEvent,
 * ExecutionSessionEventType, ExecutionSessionRepository) — nothing
 * provider-specific is exposed.
 */
import type { DatabaseClient } from '@platform/index.js';

/** §session-state-machine: the strict session status vocabulary. */
export type ExecutionSessionStatus =
  | 'created'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * The legal session state transitions (the strict graph). Anything else is
 * rejected — by the repository (a typed error, so callers get a precise
 * domain signal) and by the migration-0034 DB trigger (the mechanical
 * backstop against direct SQL).
 */
export const EXECUTION_SESSION_TRANSITIONS: Readonly<
  Record<ExecutionSessionStatus, readonly ExecutionSessionStatus[]>
> = Object.freeze({
  created: ['running', 'cancelled'],
  running: ['interrupted', 'completed', 'failed', 'cancelled'],
  interrupted: ['running', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

/** §session-events: the provider-independent event vocabulary. */
export type ExecutionSessionEventType =
  | 'turn_started'
  | 'model_interaction'
  | 'tool_call'
  | 'observation'
  | 'checkpoint'
  | 'interrupted'
  | 'resumed'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * A persisted execution session — the continuation context for exactly one
 * ExecutionRecord. `executionId` is the ExecutionRecord's id
 * (wfos_executions.id): the session continues THAT execution identity and
 * can never be re-targeted (UNIQUE(execution_id)).
 */
export interface ExecutionSession {
  readonly id: string;
  /** The ExecutionRecord this session continues (wfos_executions.id). */
  readonly executionId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly workOrderId: string;
  readonly status: ExecutionSessionStatus;
  /** Optimistic-concurrency token (>= 0); incremented by every CAS transition. */
  readonly version: number;
  /** The current turn number (0 before the first turn_started event). */
  readonly currentTurn: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The most recent interruption time (persisted across resumes). */
  readonly interruptedAt: Date | null;
  /** Set exactly when the session reached a terminal state; never after. */
  readonly terminalAt: Date | null;
}

/** One append-only event in a session's turn/event log. */
export interface ExecutionSessionEvent {
  readonly id: string;
  readonly sessionId: string;
  /** Per-session 1-based sequence; UNIQUE(session_id, sequence_number). */
  readonly sequenceNumber: number;
  readonly eventType: ExecutionSessionEventType;
  /** Provider-independent structured payload (safe metadata only — never secrets). */
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

/** Input for creating a session (the linkage must match the ExecutionRecord). */
export interface CreateExecutionSessionInput {
  /** The ExecutionRecord to continue (wfos_executions.id). */
  readonly executionId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly workOrderId: string;
}

/** An explicit-sequence event append (duplicate sequences are rejected). */
export interface AppendExecutionSessionEventInput {
  readonly sessionId: string;
  readonly eventType: ExecutionSessionEventType;
  readonly payload?: Record<string, unknown>;
}

/**
 * The session persistence contract. All state transitions are
 * repository-level compare-and-swap (WHERE version = $expected AND
 * status = $expected); a lost CAS returns null — there is NO read-check-write
 * session transition anywhere.
 *
 * Composition order for terminal flows (later slices): append the terminal
 * EVENT first (the session is still non-terminal), then CAS the status to
 * the terminal state. A terminal session accepts no further events (the
 * migration-0034 terminal guard rejects them).
 */
export interface ExecutionSessionRepository {
  /**
   * Create a session for an execution. Throws typed errors:
   *   'execution-session-duplicate-execution' — the execution already has a
   *     session (UNIQUE(execution_id): one session per ExecutionRecord);
   *   'execution-session-linkage-mismatch' — the project/work-item/work-order
   *     tuple does not match the execution record (composite FK).
   */
  createSession(input: CreateExecutionSessionInput): Promise<ExecutionSession>;

  getSession(id: string): Promise<ExecutionSession | null>;

  /** Look up the (single) session continuing an execution. */
  getSessionByExecutionId(executionId: string): Promise<ExecutionSession | null>;

  /**
   * CAS a state transition:
   *
   *   UPDATE ... SET status = $next, version = version + 1
   *    WHERE id = $id AND version = $expectedVersion AND status = $expectedStatus
   *    RETURNING *
   *
   * Returns the updated row, or NULL when the CAS lost (the version and/or
   * status no longer match — a concurrent transition won). Illegal
   * transition edges (per EXECUTION_SESSION_TRANSITIONS) throw a typed
   * 'execution-session-illegal-transition' error before touching the DB.
   * Timestamps are derived: →interrupted sets interrupted_at; →terminal sets
   * terminal_at; resumes keep the historical interrupted_at.
   */
  transitionSession(
    id: string,
    expectedVersion: number,
    expectedStatus: ExecutionSessionStatus,
    next: ExecutionSessionStatus,
  ): Promise<ExecutionSession | null>;

  /**
   * CAS the current-turn increment (only from the running status):
   * WHERE id = $id AND version = $expectedVersion AND status = 'running'.
   * Returns null when the CAS lost or the session is not running.
   */
  advanceTurn(id: string, expectedVersion: number): Promise<ExecutionSession | null>;

  /**
   * WORK-034 integration: ATOMIC transition + event append — ONE statement
   * (locked CTE → CAS predicate → event INSERT → CAS UPDATE). The winner's
   * transition and its event commit together; a CAS loser gets ZERO rows →
   * null with NO side effects (no event, no state change). Illegal edges
   * throw the typed error before the statement.
   */
  transitionWithEvent(
    id: string,
    expectedVersion: number,
    expectedStatus: ExecutionSessionStatus,
    next: ExecutionSessionStatus,
    eventType: ExecutionSessionEventType,
    payload?: Record<string, unknown>,
  ): Promise<SessionTransitionResult | null>;

  /**
   * Append an event with the NEXT sequence number (MAX+1; assigned under the
   * session row lock so concurrent appends serialize to unique sequences).
   * Throws typed errors:
   *   'execution-session-not-found';
   *   'execution-session-terminal' — the session is terminal (no further
   *     events; terminal events are appended BEFORE the terminal CAS).
   */
  appendEvent(
    sessionId: string,
    eventType: ExecutionSessionEventType,
    payload?: Record<string, unknown>,
  ): Promise<ExecutionSessionEvent>;

  /**
   * Append an event with an EXPLICIT sequence number. A duplicate
   * (session_id, sequence_number) throws the typed
   * 'execution-session-event-duplicate-sequence' error (the DB unique
   * constraint is the mechanical guarantee).
   */
  appendEventWithSequence(
    sessionId: string,
    sequenceNumber: number,
    eventType: ExecutionSessionEventType,
    payload?: Record<string, unknown>,
  ): Promise<ExecutionSessionEvent>;

  /** The session's events, ordered by sequence number (ascending). */
  listEvents(sessionId: string): Promise<readonly ExecutionSessionEvent[]>;
}

/** The atomic transition + event result (the winner's row + the appended event). */
export interface SessionTransitionResult {
  readonly session: ExecutionSession;
  readonly event: ExecutionSessionEvent;
}

/**
 * WORK-034 integration — the session lifecycle boundary owned by /agents.
 *
 * Composes the repository's CAS transitions with the append-only event
 * store so every lifecycle change is atomic + observable:
 *
 *   ensureSession  — idempotent create-or-get: exactly ONE session per
 *                    ExecutionRecord (duplicate creation is impossible —
 *                    the UNIQUE(execution_id) constraint is the backstop).
 *   startSession   — CAS created → running + 'turn_started' event.
 *   interruptSession — CAS running → interrupted + 'interrupted' event
 *                    (interrupted is resumable; it is NOT success).
 *   resumeSession  — CAS interrupted → running + 'resumed' event; the
 *                    SAME executionId / sessionId / Work Item / Work Order
 *                    identity — no second ExecutionRecord, no second
 *                    Session.
 *   completeSession / failSession — CAS running → terminal + the terminal
 *                    event; idempotent for already-terminal sessions; a
 *                    no-op when the execution has no session.
 *
 * Every transition uses repository-level CAS (lost CAS → null, NO side
 * effects — the atomic transitionWithEvent statement appends the event and
 * updates the state in ONE commit). Session terminal states are DISTINCT
 * from WorkflowOS authority: session=completed does NOT mean Work
 * Item=VERIFIED (verification stays owned by /verification) nor PR=MERGED
 * (GitHub stays authoritative).
 *
 * Session identity ≠ provider identity ≠ model identity ≠ execution-mode
 * identity: the session belongs to the LOGICAL execution (the
 * ExecutionRecord), so a future cross-mode handoff (WORK-042) can move the
 * execution between native and external without re-identifying the session.
 */
export interface ExecutionSessionService {
  /**
   * Idempotent: the ONE session for the logical execution (identified by
   * its TEXT executionId — the same logical identity the routes, the
   * AgentGateway, and the external event boundary use). Resolves the
   * ExecutionRecord, then looks up the session or creates it with the
   * record's OWN identity tuple (callers cannot supply a mismatched
   * linkage — the composite FK enforces consistency). A retry after
   * "session created → crash" returns the SAME session. Throws the typed
   * not-found error when no ExecutionRecord exists for the executionId
   * (the session CONTINUES an existing execution — it never creates one).
   */
  ensureSession(executionId: string): Promise<ExecutionSession>;
  /** CAS created → running + turn_started. Null when the CAS loses (e.g. a retry after the session already started). */
  startSession(sessionId: string): Promise<ExecutionSession | null>;
  /** CAS running → interrupted + the interrupted event. Null on CAS loss. */
  interruptSession(sessionId: string, expectedVersion: number): Promise<SessionTransitionResult | null>;
  /** CAS interrupted → running + the resumed event. Null on CAS loss (exactly one concurrent winner). */
  resumeSession(sessionId: string, expectedVersion: number): Promise<SessionTransitionResult | null>;
  /** CAS running → completed + the completed event. Idempotent for terminal sessions; null when the execution has no session. */
  completeSession(executionId: string): Promise<ExecutionSession | null>;
  /** CAS running → failed + the failed event. Idempotent for terminal sessions; null when the execution has no session. */
  failSession(executionId: string, reason: string): Promise<ExecutionSession | null>;
  /** The (single) session continuing the logical execution (TEXT executionId). */
  getSessionForExecution(executionId: string): Promise<ExecutionSession | null>;
  /** The session's events, ordered by sequence (the existing append-only store). */
  listSessionEvents(sessionId: string): Promise<readonly ExecutionSessionEvent[]>;
}

// ============================================================================
// §typed-errors — the session-domain error hierarchy
//
// PR-review correction: the repository contract documents typed errors; the
// implementation now delivers REAL typed errors — a discriminated
// ExecutionSessionError class with a stable machine-readable `code` (the
// single source of truth for programmatic handling). Consumers assert
// instanceof / switch on the code; they never parse message strings.
// Concrete PostgreSQL error details stay INTERNAL to the repository
// (mapped at the boundary — the domain error carries only the stable code
// + a human-readable message + structured context).
// ============================================================================

/** The stable machine-readable session-domain error codes. */
export const EXECUTION_SESSION_ERROR_CODES = [
  'execution-session-duplicate-execution',
  'execution-session-linkage-mismatch',
  'execution-session-illegal-transition',
  'execution-session-not-found',
  'execution-session-terminal',
  'execution-session-event-duplicate-sequence',
] as const;

export type ExecutionSessionErrorCode =
  (typeof EXECUTION_SESSION_ERROR_CODES)[number];

/**
 * The discriminated session-domain error. `code` is the stable
 * programmatic handle (EXECUTION_SESSION_ERROR_CODES); `context` carries
 * structured details (ids, expected/actual) — never raw driver errors.
 */
export class ExecutionSessionError extends Error {
  readonly code: ExecutionSessionErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: ExecutionSessionErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ExecutionSessionError';
    this.code = code;
    this.context = context;
  }
}

/** Constructor deps for the Pg implementation (internal). */
export interface PgExecutionSessionRepositoryDeps {
  readonly db: DatabaseClient;
}
