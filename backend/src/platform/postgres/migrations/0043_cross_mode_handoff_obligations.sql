-- WORK-042 (PR #46 review correction): durable cross-mode-handoff
-- obligations — the transactional-outbox fix for the handoff crash-recovery
-- durability gap (the reviewer's blocking finding #2).
--
-- The review found a blocking durability issue: the cross-mode handoff
-- reconciliation method (reconcileCrossModeHandoffForExecution) existed but
-- the relay was explicitly described as OPTIONAL and was NOT wired into the
-- WorkerHost. A process crash in either window left a stranded handoff:
--
--     reserve handoff log row
--         ↓
--     process dies                        ← crash window #1 (no mutate)
--
--     reserve
--         ↓
--     transitionMode (mutate)
--         ↓
--     process dies before dispatch         ← crash window #2 (no dispatch)
--
-- The fix follows the SAME architecture the codebase already uses for the
-- WORK-034 session-terminal obligation + the WORK-035 workspace-release
-- obligation (the existing generic OutboxRelay pattern — NO new scheduler,
-- NO second execution engine):
--
--     handoff log INSERT (reserve)
--         ↓ (this migration's AFTER INSERT trigger — ATOMIC with the
--           reserve: no window where the handoff log exists but no
--           obligation exists)
--     durable cross-mode-handoff obligation
--         ↓ (claim-time relay job + the WorkerHost boot sweep)
--     existing Queue / WorkerHost
--         ↓
--     idempotent reconcileCrossModeHandoffForExecution (re-mutate /
--       re-dispatch / discharge)
--
-- Semantics of an obligation row:
--   * created ATOMICALLY with the handoff log row's INSERT (the trigger
--     below writes it in the SAME transaction — no window where the handoff
--     log exists but the obligation is missing);
--   * discharged when the handoff is complete (record.mode === toMode AND
--     the dispatch completed: package present for native->external, AgentRun
--     present / record terminal for external->native). discharged_at set;
--   * APPEND-ONLY intent: an obligation is never mutated after creation
--     (only discharged via the discharge column — no UPDATE of the recorded
--     intent), and never deleted;
--   * UNIQUE(handoff_id) — at most one obligation per handoff (the reserve
--     happens once; repeated recovery attempts reconcile the SAME
--     obligation).
--
-- NO scheduler, NO polling loop, NO second execution engine: the relay is
-- the existing generic OutboxRelay pattern (boot sweep + claim-time job),
-- and the reconciliation itself is the existing service's idempotent
-- replay (re-mutate if the record.mode !== toMode; re-dispatch if the
-- dispatch outcome is missing).

CREATE TABLE IF NOT EXISTS wfos_cross_mode_handoff_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The handoff log row this obligation reconciles (ONE obligation per
  -- handoff — UNIQUE). ON DELETE CASCADE drops the obligation with the
  -- handoff log row (the handoff log is itself append-only, so this is
  -- unreachable in practice).
  handoff_id UUID NOT NULL REFERENCES wfos_execution_mode_handoffs(id) ON DELETE CASCADE,
  -- The logical execution identity (denormalized from the handoff log's
  -- execution_record_id → wfos_executions.execution_id) so the relay can
  -- enqueue with the LOGICAL id the reconciliation consumes, without a
  -- per-row join at sweep time. Resolved in the trigger below.
  execution_id UUID NOT NULL REFERENCES wfos_executions(id) ON DELETE CASCADE,
  -- The durable state of the reconciliation. NULL = pending (the replay
  -- work list); set once the reconcile confirms the handoff is complete.
  discharged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wfos_cross_mode_handoff_obligations_unique
    UNIQUE (handoff_id)
);

-- The replay work list: obligations whose handoff has not yet been
-- reconciled to completion.
CREATE INDEX IF NOT EXISTS wfos_cross_mode_handoff_obligations_pending_idx
  ON wfos_cross_mode_handoff_obligations (execution_id)
  WHERE discharged_at IS NULL;

-- ---------------------------------------------------------------------------
-- Create the obligation ATOMICALLY with the handoff log row's INSERT. AFTER
-- INSERT trigger on wfos_execution_mode_handoffs: the obligation row is
-- written in the SAME statement's transaction. There is no moment where the
-- handoff log exists but the obligation is missing — the reviewer's crash
-- window cannot produce an unrecoverable state.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wfos_cross_mode_handoff_obligation_on_reserve()
RETURNS trigger AS $$
BEGIN
  INSERT INTO wfos_cross_mode_handoff_obligations (handoff_id, execution_id)
  VALUES (NEW.id, NEW.execution_record_id)
  ON CONFLICT (handoff_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_cross_mode_handoff_obligation_reserve_trigger
  ON wfos_execution_mode_handoffs;

CREATE TRIGGER wfos_cross_mode_handoff_obligation_reserve_trigger
  AFTER INSERT ON wfos_execution_mode_handoffs
  FOR EACH ROW
  EXECUTE FUNCTION wfos_cross_mode_handoff_obligation_on_reserve();

-- ---------------------------------------------------------------------------
-- The obligation is append-only intent: no mutation of the recorded
-- handoff/execution, no deletion. Only the discharge column may change
-- (the reconciliation completing). Mirrors 0035's obligation immutability.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wfos_cross_mode_handoff_obligation_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'cross-mode-handoff-obligation-immutable: cross-mode handoff obligations are append-only — they are never deleted';
  END IF;
  IF NEW.handoff_id IS DISTINCT FROM OLD.handoff_id
     OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'cross-mode-handoff-obligation-immutable: the recorded intent (handoff, execution, created_at) is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_cross_mode_handoff_obligation_immutable_trigger
  ON wfos_cross_mode_handoff_obligations;

CREATE TRIGGER wfos_cross_mode_handoff_obligation_immutable_trigger
  BEFORE UPDATE OR DELETE ON wfos_cross_mode_handoff_obligations
  FOR EACH ROW EXECUTE FUNCTION wfos_cross_mode_handoff_obligation_immutable();
