-- WORK-034 (first slice): Persistent Session Core — the session
-- persistence boundary inside /agents.
--
-- An ExecutionSession is the CONTINUATION CONTEXT for exactly one
-- ExecutionRecord (the same engineering-task identity chain):
--
--     WorkItem → WorkOrder → ExecutionRecord → ExecutionSession
--                                                ├── event 1
--                                                ├── event 2
--                                                └── ...
--
-- The session does NOT create another logical engineering task, another
-- execution engine, or another workflow/verification/review authority —
-- it persists the durable conversation/turn state of ONE execution so a
-- later slice can resume it.
--
-- Mechanical invariants (this migration):
--   * UNIQUE(execution_id) — exactly ONE session per ExecutionRecord
--     (enforced by a unique constraint, not application discipline).
--   * Composite FK (execution_id, project_id, work_item_id, work_order_id)
--     → wfos_executions(id, project_id, work_item_id, work_order_id) —
--     the project/work-item/work-order linkage is mechanically consistent
--     with the execution record: a session cannot claim a different
--     project/work item/work order than its execution.
--   * version >= 0 (optimistic-concurrency token; transitions are
--     repository-level CAS: WHERE version = $expected AND status = $expected).
--   * STRICT session state machine:
--       created → running
--       running → interrupted → running (resumable)
--       running → completed | failed | cancelled
--       created/interrupted → cancelled
--     enforced by a BEFORE UPDATE trigger (illegal edges rejected);
--     TERMINAL states (completed/failed/cancelled) are IMMUTABLE (any
--     status change from a terminal state is rejected); version never
--     regresses; terminal ⇔ terminal_at; interrupted ⇒ interrupted_at.
--   * Append-only event/turn store (wfos_execution_session_events):
--     BEFORE UPDATE OR DELETE trigger rejects ALL historical mutation;
--     UNIQUE(session_id, sequence_number); event types are the fixed
--     provider-independent vocabulary; a terminal session accepts NO
--     further events (terminal events are appended BEFORE the terminal
--     CAS transition — the composition order documented in the repository).
--
-- No workflow/verification/review tables are touched. No provider
-- specifics are stored (the payload is provider-independent JSONB).

-- ---------------------------------------------------------------------------
-- (1) Identity-tuple uniqueness on executions (for the composite FK below).
-- ---------------------------------------------------------------------------

ALTER TABLE wfos_executions
  DROP CONSTRAINT IF EXISTS wfos_executions_identity_tuple_unique;

ALTER TABLE wfos_executions
  ADD CONSTRAINT wfos_executions_identity_tuple_unique
  UNIQUE (id, project_id, work_item_id, work_order_id);

-- ---------------------------------------------------------------------------
-- (2) The session table.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wfos_execution_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The continuation identity: wfos_executions.id (the ExecutionRecord).
  -- Exactly ONE session per execution — a session is never re-targeted.
  execution_id UUID NOT NULL,
  -- Denormalized identity chain (mechanically consistent via the composite
  -- FK — a session can never claim a different project/work item/work
  -- order than its execution).
  project_id   UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  work_item_id UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  work_order_id UUID NOT NULL REFERENCES wfos_work_orders(id) ON DELETE CASCADE,
  -- Strict state machine status.
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'running', 'interrupted', 'completed', 'failed', 'cancelled')),
  -- Optimistic-concurrency token. Every CAS transition increments it;
  -- lost-CAS callers see null. Never negative, never regressing.
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  -- The current turn number (0 before the first turn_started event).
  current_turn INTEGER NOT NULL DEFAULT 0 CHECK (current_turn >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Last interruption time (persisted across resumes — the historical record
  -- of the most recent interruption).
  interrupted_at TIMESTAMPTZ,
  -- Set exactly when the session reaches a terminal state; never after.
  terminal_at TIMESTAMPTZ,
  -- Exactly one session per ExecutionRecord.
  CONSTRAINT wfos_execution_sessions_execution_unique UNIQUE (execution_id),
  -- The linkage-consistency FK: the execution + identity tuple must match
  -- an actual execution row (wrong project/work-item/work-order linkage is
  -- rejected by the database).
  CONSTRAINT wfos_execution_sessions_execution_linkage_fkey
    FOREIGN KEY (execution_id, project_id, work_item_id, work_order_id)
    REFERENCES wfos_executions(id, project_id, work_item_id, work_order_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wfos_execution_sessions_project_idx
  ON wfos_execution_sessions(project_id);

-- updated_at maintenance (does NOT touch version — version increments are
-- owned exclusively by the repository's CAS statements).
CREATE OR REPLACE FUNCTION wfos_execution_session_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_session_touch_trigger ON wfos_execution_sessions;
CREATE TRIGGER wfos_execution_session_touch_trigger
  BEFORE UPDATE ON wfos_execution_sessions
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_session_touch();

-- ---------------------------------------------------------------------------
-- (3) The strict state machine + terminal immutability (BEFORE UPDATE).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wfos_execution_session_transition_guard() RETURNS trigger AS $$
BEGIN
  -- TERMINAL states are FULLY immutable: once a session is terminal, NO
  -- authoritative field may change — status, version, current_turn,
  -- interrupted_at, terminal_at, and the execution identity tuple (guarded
  -- below). This is the system-of-record backstop: direct SQL cannot tamper
  -- with a terminal session's state. (The updated_at maintenance trigger is
  -- deliberately retained — it is bookkeeping, not authoritative state.)
  IF OLD.status IN ('completed', 'failed', 'cancelled') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.current_turn IS DISTINCT FROM OLD.current_turn
       OR NEW.interrupted_at IS DISTINCT FROM OLD.interrupted_at
       OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at
       OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
       OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id THEN
      RAISE EXCEPTION
        'execution-session-terminal-immutable: session % is terminal (%) — no authoritative field may change (status, version, current_turn, interrupted_at, terminal_at, or the execution identity)',
        OLD.id, OLD.status;
    END IF;
    -- A terminal row with NO authoritative change: harmless (e.g. the
    -- updated_at touch on a no-op UPDATE). Allow.
    RETURN NEW;
  END IF;

  -- Strict transition graph (only the legal edges; a no-op status UPDATE
  -- is not a transition and is allowed).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'created'     AND NEW.status IN ('running', 'cancelled'))
      OR (OLD.status = 'running'     AND NEW.status IN ('interrupted', 'completed', 'failed', 'cancelled'))
      OR (OLD.status = 'interrupted' AND NEW.status IN ('running', 'cancelled'))
    ) THEN
      RAISE EXCEPTION
        'execution-session-illegal-transition: % -> % is not a legal session transition',
        OLD.status, NEW.status;
    END IF;
  END IF;

  -- version is monotonic (never regresses).
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION
      'execution-session-version-regression: version must not decrease (% -> %)',
      OLD.version, NEW.version;
  END IF;

  -- Terminal <=> terminal_at (a terminal status always carries the
  -- terminal timestamp; a non-terminal status never does).
  IF (NEW.status IN ('completed', 'failed', 'cancelled')) <> (NEW.terminal_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'execution-session-terminal-timestamp: status % requires terminal_at to be %',
      NEW.status,
      CASE WHEN NEW.status IN ('completed', 'failed', 'cancelled') THEN 'set' ELSE 'NULL' END;
  END IF;

  -- interrupted => interrupted_at (running after a resume keeps the
  -- historical interrupted_at).
  IF NEW.status = 'interrupted' AND NEW.interrupted_at IS NULL THEN
    RAISE EXCEPTION
      'execution-session-interrupted-timestamp: interrupted status requires interrupted_at';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_session_transition_guard_trigger
  ON wfos_execution_sessions;

CREATE TRIGGER wfos_execution_session_transition_guard_trigger
  BEFORE UPDATE ON wfos_execution_sessions
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_session_transition_guard();

-- ---------------------------------------------------------------------------
-- (3b) IMMUTABLE execution identity tuple.
--
-- The session's continuation identity is fixed at insertion:
--   (execution_id, project_id, work_item_id, work_order_id)
-- A session can NEVER be re-targeted onto a different ExecutionRecord —
-- not by the repository (no such method exists), not by direct SQL. The
-- composite FK guarantees the tuple is CONSISTENT with a real execution;
-- this guard guarantees the tuple is IMMUTABLE. Together: the chain
--   WorkItem → WorkOrder → ExecutionRecord → ExecutionSession
-- is a database invariant, not an application convention.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wfos_execution_session_identity_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
     OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id THEN
    RAISE EXCEPTION
      'execution-session-identity-immutable: the execution identity tuple (execution, project, work item, work order) of session % is immutable — a session can never be re-targeted onto a different ExecutionRecord',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_session_identity_guard_trigger
  ON wfos_execution_sessions;

CREATE TRIGGER wfos_execution_session_identity_guard_trigger
  BEFORE UPDATE ON wfos_execution_sessions
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_session_identity_guard();

-- ---------------------------------------------------------------------------
-- (4) The append-only event/turn store.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wfos_execution_session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES wfos_execution_sessions(id) ON DELETE CASCADE,
  -- Per-session monotonically increasing sequence (1-based). UNIQUE with
  -- session_id: a duplicate sequence is rejected by the database.
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
  -- The provider-independent event vocabulary (turn lifecycle, model
  -- interactions, tool calls, observations, checkpoints, terminal events).
  event_type TEXT NOT NULL CHECK (event_type IN (
    'turn_started', 'model_interaction', 'tool_call', 'observation',
    'checkpoint', 'interrupted', 'resumed', 'completed', 'failed', 'cancelled')),
  -- Provider-independent structured payload (safe metadata only — never
  -- credentials, never raw secrets).
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wfos_execution_session_events_sequence_unique
    UNIQUE (session_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS wfos_execution_session_events_session_idx
  ON wfos_execution_session_events(session_id);

-- APPEND-ONLY: historical events are never updated or deleted.
CREATE OR REPLACE FUNCTION wfos_execution_session_event_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'execution-session-event-immutable: session events are append-only (session % sequence %) — historical events must never be updated or deleted',
    OLD.session_id, OLD.sequence_number;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_session_event_immutable_trigger
  ON wfos_execution_session_events;

CREATE TRIGGER wfos_execution_session_event_immutable_trigger
  BEFORE UPDATE OR DELETE ON wfos_execution_session_events
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_session_event_immutable();

-- TERMINAL sessions accept NO further events — with ONE precise exception:
-- the TERMINAL EVENT ITSELF. A terminal event whose event_type equals the
-- session's CURRENT terminal status is allowed (the repository's
-- transitionWithEvent appends the terminal event in the same transaction
-- as, and keyed to, the CAS transition that terminalized the row — the
-- (status, version) predicate inside the INSERT guarantees the event
-- belongs to exactly that transition). Any OTHER event on a terminal
-- session — a post-terminal observation, direct SQL, a stale append — is
-- rejected. This keeps the append-only store the single authority for the
-- session's lifecycle evidence while allowing the atomic
-- transition+event composition the WORK-034 integration requires.
CREATE OR REPLACE FUNCTION wfos_execution_session_event_terminal_guard() RETURNS trigger AS $$
DECLARE
  s TEXT;
  v INTEGER;
BEGIN
  SELECT status, version INTO s, v FROM wfos_execution_sessions WHERE id = NEW.session_id;
  IF s IN ('completed', 'failed', 'cancelled') THEN
    IF NEW.event_type = s THEN
      RETURN NEW; -- the terminal event itself (see above)
    END IF;
    RAISE EXCEPTION
      'execution-session-terminal: session % is terminal (%) — no further events',
      NEW.session_id, s;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_execution_session_event_terminal_guard_trigger
  ON wfos_execution_session_events;

CREATE TRIGGER wfos_execution_session_event_terminal_guard_trigger
  BEFORE INSERT ON wfos_execution_session_events
  FOR EACH ROW EXECUTE FUNCTION wfos_execution_session_event_terminal_guard();
