-- WORK-051 round 1 (PR #52 review, HIGH — protected impact profile) — the
-- governed, monotonic architecture-impact declaration on the Work Item.
--
-- The impact profile controls WHICH checkpoints run (the applicability
-- matrix). The previous implementation derived it from
-- WorkItem.metadata.architectureImpact — but metadata is mutable through the
-- existing Work Item persistence contract, so a later mutation
-- high → low could silently remove readiness/work-order/verification
-- checkpoints without touching the ArchitectureVersion.
--
-- The impact declaration becomes a FIRST-CLASS governed column on the work
-- item row:
--
--   * declared at creation (CreateWorkItemInput.architectureImpact);
--   * NOT part of UpdateWorkItemInput (the update contract cannot touch it);
--   * persistence-enforced MONOTONIC: a BEFORE UPDATE trigger allows
--     NULL → declared (first declaration) and strict-direction STRENGTHENING
--     (low → medium → high), and rejects any WEAKENING (high → medium/low,
--     medium → low) or clearing. Impact can only ever become STRICTER;
--   * unset (NULL) derives fail-closed to 'high' — the strictest checkpoint
--     frequency — at evaluation time.
--
-- Migration of existing declarations: WorkItem.metadata.architectureImpact
-- was introduced by this same unmerged WORK-051 branch (migration 0052 era),
-- so no production data carries it; nothing to backfill. The checkpoint
-- derivation now reads ONLY this column — mutable metadata is no longer a
-- governance input.

ALTER TABLE wfos_work_items
  ADD COLUMN architecture_impact TEXT;

ALTER TABLE wfos_work_items
  DROP CONSTRAINT IF EXISTS wfos_work_items_architecture_impact_valid;
ALTER TABLE wfos_work_items
  ADD CONSTRAINT wfos_work_items_architecture_impact_valid
  CHECK (architecture_impact IS NULL OR architecture_impact IN ('low', 'medium', 'high'));

-- ---------------------------------------------------------------------------
-- Monotonic impact: strengthening only, never weakening, never clearing.
-- Direct SQL attempts to weaken are rejected at the persistence layer (the
-- same enforcement pattern as the frozen-version and assertion triggers).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_work_items_impact_monotonic()
RETURNS TRIGGER AS $$
DECLARE
  old_rank INT;
  new_rank INT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.architecture_impact IS DISTINCT FROM OLD.architecture_impact THEN
    old_rank := CASE OLD.architecture_impact
      WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 ELSE 0 END;
    new_rank := CASE NEW.architecture_impact
      WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 ELSE 0 END;
    -- Weakening (rank decreases) or clearing a declared value (rank → 0) is
    -- rejected. First declaration (0 → n) and strengthening (n → m, m > n)
    -- are the only legal moves.
    IF new_rank < old_rank THEN
      RAISE EXCEPTION
        'work item architecture impact is monotonic: cannot move from % to % (impact only ever strengthens; use a new work item under a new ArchitectureVersion for lower-impact work)',
        COALESCE(OLD.architecture_impact, 'unset'), COALESCE(NEW.architecture_impact, 'unset');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_work_items_impact_monotonic ON wfos_work_items;
CREATE TRIGGER wfos_work_items_impact_monotonic
  BEFORE UPDATE ON wfos_work_items
  FOR EACH ROW
  EXECUTE FUNCTION wfos_work_items_impact_monotonic();
