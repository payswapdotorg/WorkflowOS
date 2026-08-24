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
  -- TERMINAL states are immutable: no status change, ever (the CAS
  -- predicate cannot transition FROM a terminal state either — this is
  -- the mechanical backstop against direct SQL).
  IF OLD.status IN ('completed', 'failed', 'cancelled')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'execution-session-terminal-immutable: session % is terminal (%) — no further transitions',
      OLD.id, OLD.status;
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

-- TERMINAL sessions accept NO further events. (Terminal events —
-- completed/failed/cancelled — are appended BEFORE the terminal CAS
-- transition; see the repository's documented composition order.)
CREATE OR REPLACE FUNCTION wfos_execution_session_event_terminal_guard() RETURNS trigger AS $$
DECLARE
  s TEXT;
BEGIN
  SELECT status INTO s FROM wfos_execution_sessions WHERE id = NEW.session_id;
  IF s IN ('completed', 'failed', 'cancelled') THEN
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
