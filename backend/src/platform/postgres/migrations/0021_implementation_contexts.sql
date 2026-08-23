-- WORK-026: persisted ImplementationContext per Work Item.
-- revision increments each time the builder runs (initial + each correction
-- cycle), giving the agent a stable, traceable input snapshot.
CREATE TABLE IF NOT EXISTS wfos_implementation_contexts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL DEFAULT 1,
  content_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 'initial' | 'correction' — set by the builder based on prior review state
  kind          TEXT NOT NULL DEFAULT 'initial',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wfos_implementation_contexts
  ADD CONSTRAINT wfos_implementation_contexts_kind_check
  CHECK (kind IN ('initial', 'correction'));
-- The LATEST revision is the one consumed by the next agent run. We do NOT
-- enforce UNIQUE(work_item_id, revision) because revision is monotonic per
-- work_item; the builder uses SELECT MAX(revision) inside its transaction
-- to derive the next value.
CREATE INDEX IF NOT EXISTS idx_implementation_contexts_work_item
  ON wfos_implementation_contexts(work_item_id, revision DESC);
