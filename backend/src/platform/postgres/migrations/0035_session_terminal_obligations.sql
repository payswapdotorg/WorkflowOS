-- WORK-034 (PR #38 review correction): durable session-terminal
-- obligations — the transactional-outbox fix for the terminal-session
-- reconciliation durability gap.
--
-- The review found a blocking durability issue: session terminalization
-- was BEST-EFFORT after the execution record became authoritative:
--
--     provider outcome
--         ↓
--     ExecutionRecord = completed / failed   (authoritative)
--         ↓
--     completeSession()/failSession()
--         ↓
--     catch + log                            ← the crash window
--
-- A crash or database failure in that window leaves the DURABLE session
-- inconsistent with the execution it represents:
--
--     ExecutionRecord = completed   |   ExecutionSession = running
--     ExecutionRecord = failed      |   ExecutionSession = running
--
-- The fix follows the same architecture the reviewer prescribed (and the
-- codebase already uses for the benchmark start-delivery outbox):
--
--     ExecutionRecord terminal
--         ↓
--     durable session-terminal obligation   (this table)
--         ↓
--     existing Queue / WorkerHost           (relay job + boot sweep)
--         ↓
--     CAS session terminalization           (idempotent reconciliation)
--
-- Semantics of an obligation row:
--   * created ATOMICALLY with the execution record's terminal transition
--     (the execution-status trigger below writes it in the same statement
--     that terminalizes the record — no window where the record is
--     terminal but no obligation exists);
--   * records the session-terminal outcome for EVERY execution terminal
--     state (completed→completed, failed→failed, cancelled→cancelled,
--     expired→failed-with-expired-reason — the complete mapping);
--   * discharged when the session reaches the matching terminal state
--     (discharged_at set). The incomplete set = the replay work list;
--   * APPEND-ONLY intent: an obligation is never mutated after creation
--     (only discharged via the discharge column — no UPDATE of the
--     recorded intent), and never deleted;
--   * UNIQUE(execution_id) — at most one obligation per execution: the
--     terminal transition happens once, and repeated recovery attempts
--     reconcile the SAME obligation.
--
-- NO scheduler, NO polling loop, NO second execution engine: the relay is
-- the existing generic OutboxRelay pattern (boot sweep + claim-time job),
-- and the reconciliation itself is the existing repository CAS.

CREATE TABLE IF NOT EXISTS wfos_execution_session_terminal_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The logical execution (the record's UUID — the session's target).
  execution_id UUID NOT NULL REFERENCES wfos_executions(id) ON DELETE CASCADE,
  -- The terminal outcome the session must reach — the COMPLETE mapping of
  -- the existing execution terminal state machine (PR #38 review
  -- correction #2: cancelled + expired must not be silently ignored —
  -- the session represents the lifecycle of the SAME logical execution,
  -- so every execution terminal state reconciles the session):
  --
  --   execution completed  → session completed
  --   execution failed     → session failed
  --   execution cancelled  → session cancelled
  --   execution expired    → session failed (with the explicit
  --                          execution-expired reason in the event payload
  --                          — the session vocabulary has no 'expired'
  --                          state; an expired execution is a FAILED
  --                          execution outcome, recorded precisely)
  terminal_state TEXT NOT NULL CHECK (terminal_state IN ('completed', 'failed', 'cancelled')),
  -- The SOURCE execution terminal status that created the obligation
  -- (PR #38 review round 3: preserve the expired distinction — the
  -- obligation maps expired→failed, but the session's terminal EVENT
  -- payload records the true source ('execution-expired') so the durable
  -- evidence never lies about WHY the session failed).
  source_execution_status TEXT NOT NULL CHECK (source_execution_status IN (
    'completed', 'failed', 'cancelled', 'expired')),
  -- The durable state of the reconciliation. NULL = pending (the replay
  -- work list); set once the session reaches the matching terminal state.
  discharged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wfos_execution_session_terminal_obligations_unique
    UNIQUE (execution_id)
);

-- The replay work list: obligations whose session has not yet reached the
-- recorded terminal state.
CREATE INDEX IF NOT EXISTS wfos_execution_session_terminal_obligations_pending_idx
  ON wfos_execution_session_terminal_obligations (execution_id)
  WHERE discharged_at IS NULL;

-- ---------------------------------------------------------------------------
-- Create the obligation ATOMICALLY with the execution record's terminal
-- transition. AFTER UPDATE trigger on wfos_executions: when the record
-- reaches completed/failed (from a non-terminal status), insert the
-- obligation IN THE SAME STATEMENT'S transaction. There is no moment where
-- the record is terminal but the obligation is missing — the reviewer's
-- crash window cannot produce an unrecoverable state.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wfos_session_terminal_obligation_on_execution_terminal()
RETURNS trigger AS $$
BEGIN
  -- The COMPLETE execution terminal-state mapping (PR #38 review
  -- correction #2): every terminal execution state creates the durable
  -- session-terminal obligation. 'expired' maps to session 'failed' (the
  -- session vocabulary has no 'expired'; an expired execution is a failed
  -- execution outcome — the reconciliation records the expired reason in
  -- the terminal event payload).
  IF NEW.status IN ('completed', 'failed', 'cancelled', 'expired')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO wfos_execution_session_terminal_obligations
      (execution_id, terminal_state, source_execution_status)
    VALUES (NEW.id,
            CASE WHEN NEW.status = 'expired' THEN 'failed' ELSE NEW.status END,
            NEW.status)
    ON CONFLICT (execution_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_session_terminal_obligation_trigger
  ON wfos_executions;

CREATE TRIGGER wfos_session_terminal_obligation_trigger
  AFTER UPDATE ON wfos_executions
  FOR EACH ROW
  EXECUTE FUNCTION wfos_session_terminal_obligation_on_execution_terminal();

-- ---------------------------------------------------------------------------
-- The obligation is append-only intent: no mutation of the recorded
-- execution/terminal-state, no deletion. Only the discharge column may
-- change (the reconciliation completing).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wfos_session_terminal_obligation_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'session-terminal-obligation-immutable: session terminal obligations are append-only — they are never deleted';
  END IF;
  IF NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.terminal_state IS DISTINCT FROM OLD.terminal_state
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'session-terminal-obligation-immutable: the recorded intent (execution, terminal state, created_at) is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_session_terminal_obligation_immutable_trigger
  ON wfos_execution_session_terminal_obligations;

CREATE TRIGGER wfos_session_terminal_obligation_immutable_trigger
  BEFORE UPDATE OR DELETE ON wfos_execution_session_terminal_obligations
  FOR EACH ROW EXECUTE FUNCTION wfos_session_terminal_obligation_immutable();
