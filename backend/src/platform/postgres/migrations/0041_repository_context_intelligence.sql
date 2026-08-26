-- WORK-039: Repository and Context Intelligence — the revision-bound context
-- index + the explainable context-item layer that consumes WORK-038 Project
-- Baselines + the existing /architecture, /requirements, /work-items,
-- /github, /agents, /verification, /reviews authorities.
--
-- WORK-039 is an APPLICATION/CONTEXT-INTELLIGENCE CAPABILITY (analogous to
-- src/onboarding/ + src/execution-policy/ + src/benchmark/). It is NOT a new
-- frozen module, NOT a second project/repo/architecture/requirements/
-- workflow/verification/review authority. The context index is a PROJECT
-- artifact stored THROUGH the existing /projects authority (the same
-- precedent as ProjectBaseline in migration 0038). /projects remains the
-- single project authority.
--
-- THE MOST IMPORTANT DISTINCTION (the WORK-039 prompt):
--   SOURCE FACT            — "src/api/users.ts exists."           (the repo)
--   BASELINE OBSERVATION   — "The repository contains an Express API."
--   CONTEXT INDEX          — "These repository artifacts are relevant."  (this)
--   AUTHORITATIVE ARCH     — "ArchitectureVersion X declares this boundary."
-- These concepts are NEVER collapsed. The context index is a DERIVED view
-- over the baseline + the authorities; it never becomes architecture truth.
--
-- REPOSITORY REVISION IS FUNDAMENTAL. A context index is ALWAYS pinned to a
-- concrete baseline_commit_sha. Context from commit A is NEVER silently
-- presented as context from commit B. The detectStale advisory surfaces
-- "this baseline's commit is not the current repo HEAD" — it never swaps
-- the baseline under the caller.
--
-- PROVENANCE PRESERVATION. Every context item carries the SAME provenance
-- vocabulary as WORK-038 (observed | inferred | confirmed | proposed). The
-- ranker's relevance_score is ADVISORY ONLY — ranking NEVER promotes
-- provenance (observed+high stays observed; inferred+high stays inferred;
-- the ONLY path to 'confirmed' is the authorized confirmation route on the
-- baseline observation, never the ranker).
--
-- EXPLAINABLE RELEVANCE. Every item carries a non-empty relevance_reason —
-- a human-readable chain of the deterministic signals that selected it
-- (term_overlap, architecture_ref, requirement_ref, work_item_ref,
-- dependency_ref, baseline_observation, test_relationship,
-- repository_structure). No opaque AI-generated context.
--
-- TENANT ISOLATION. Every row is project_id + organization_id scoped (the
-- route layer resolves + authorizes + accesses; a UUID is NEVER a credential).
--
-- SECURITY / REDACTION. The capability operates on already-redacted baseline
-- evidence/observations (WORK-038 redaction). The redacted flag is preserved
-- on context items; no reversal of redaction is possible (the platform
-- observation-redaction util is the only redactor; the context layer never
-- holds raw secrets).
--
-- CONCURRENCY / DURABILITY.
--   * "two indexing jobs for the same baseline+query": the UNIQUE
--     (baseline_id, query_kind, query_ref) + the idempotent ensureIndex
--     upsert make a second request return the SAME row (no duplicate).
--   * "same repository revision analyzed twice": same baseline_commit_sha →
--     same baseline_id (WORK-038 UNIQUE) → same context index (idempotent).
--   * "process crash during indexing": the row sits in 'indexing'; a retry
--     re-enters ensureIndex, re-drives the ranker, and CAS-completes. Items
--     are append-only-idempotent (UNIQUE on (context_index_id, locator,
--     source, kind)) so a partial write is safe to re-drive.
--   * "policy changes": the baseline was already persisted under a WORK-038
--     policy fence; the context index reads COMPLETE baselines only (an
--     'analyzing'/'failed' baseline cannot be indexed). A policy change
--     affects FUTURE baselines, not the pinned revision this index cites.
--
-- NO FABRICATED TOOL EVIDENCE. When governed host inspection runs (optional,
-- via Workspace + ToolRuntime), the real toolInvocationIds are recorded on
-- the index row. When no host inspection runs, tool_invocation_ids is '[]'
-- (NEVER a fake ID). The capability does NOT claim an operation was
-- tool-governed when it was a direct baseline read.
--
-- NO workflow / verification / review / execution mutation. No provider SDKs.
-- No credentials. No scheduler. No continuous crawler. No vector database.

-- ---------------------------------------------------------------------------
-- wfos_project_context_indices — the revision-bound index header (one per
-- project + baseline + query). Idempotent on (baseline_id, query_kind,
-- query_ref) so concurrent / retried indexing converges to a single row.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wfos_project_context_indices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scope (mirrors wfos_project_baselines).
  project_id UUID NOT NULL REFERENCES wfos_projects(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  -- The repository, via the EXISTING /github authority row.
  project_github_repository_id UUID NOT NULL REFERENCES wfos_project_github_repositories(id) ON DELETE CASCADE,
  -- The baseline this index is derived FROM (a COMPLETE WORK-038 baseline).
  -- ON DELETE CASCADE keeps indices consistent with baseline deletion.
  baseline_id UUID NOT NULL REFERENCES wfos_project_baselines(id) ON DELETE CASCADE,
  -- REPOSITORY REVISION IDENTITY (the central WORK-039 invariant). Pinned to
  -- the baseline's commit; never silently swapped to a newer revision.
  baseline_commit_sha TEXT NOT NULL,
  -- Deterministic identity: sha256 of the canonical (query_terms + item
  -- locators + sources + kinds + scores) tuple. Same baseline + same query
  -- → same content_digest → idempotent. Different revision → different
  -- baseline_id → different index → distinct (test invariant #1 + #3).
  content_digest TEXT,
  -- The query shape this index answers.
  query_kind TEXT NOT NULL CHECK (query_kind IN ('work_item','architecture','requirement','freeform')),
  -- The concrete authoritative ref (e.g. work_item_id; NULL for freeform).
  query_ref TEXT,
  -- The deterministic signal set the ranker consulted (explainable). Stored
  -- so a later "why was this selected?" can be answered from the row.
  query_terms_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- State machine (mirrors wfos_project_baselines.state).
  state TEXT NOT NULL DEFAULT 'indexing' CHECK (state IN ('indexing','complete','failed','stale')),
  -- CAS token (mirrors wfos_project_baselines.version).
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  -- The indexing run id (crash/retry recovery — a stale 'indexing' row can
  -- be reclaimed by a new run after the run id is no longer live).
  indexing_run_id TEXT,
  -- HONEST references to governed host-tool invocations (NEVER fabricated).
  -- '[]' when no host inspection ran (the default — the ranker works on
  -- baseline evidence only); ['inv-uuid', ...] when a real ToolRuntime
  -- produced observations that contributed to this index.
  tool_invocation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_stage TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  -- Idempotency: one index per (baseline, query_kind, query_ref). A
  -- re-index of the same baseline+query returns the SAME row.
  UNIQUE (baseline_id, query_kind, query_ref)
);

CREATE INDEX IF NOT EXISTS wfos_project_context_indices_project_idx
  ON wfos_project_context_indices (project_id);
CREATE INDEX IF NOT EXISTS wfos_project_context_indices_org_idx
  ON wfos_project_context_indices (organization_id);
CREATE INDEX IF NOT EXISTS wfos_project_context_indices_baseline_idx
  ON wfos_project_context_indices (baseline_id);
-- Tenant-scoped lookup by query (the route's GET entry).
CREATE INDEX IF NOT EXISTS wfos_project_context_indices_query_idx
  ON wfos_project_context_indices (project_id, query_kind, query_ref)
  WHERE terminal_at IS NULL;

-- The touch trigger (mirrors wfos_project_baselines).
CREATE OR REPLACE FUNCTION wfos_project_context_index_touch_trigger_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_project_context_index_touch_trigger
  ON wfos_project_context_indices;
CREATE TRIGGER wfos_project_context_index_touch_trigger
  BEFORE UPDATE ON wfos_project_context_indices
  FOR EACH ROW EXECUTE FUNCTION wfos_project_context_index_touch_trigger_fn();

-- The transition guard (mirrors wfos_project_baselines): terminal immutability
-- + strict legal edges (indexing → complete|failed|stale; complete/failed
-- are terminal) + identity immutability (baseline_id/query_kind/query_ref/
-- baseline_commit_sha never change after insert) + version monotonicity +
-- state/timestamp consistency + content_digest exactly-on-complete.
CREATE OR REPLACE FUNCTION wfos_project_context_index_transition_guard_fn()
RETURNS TRIGGER AS $$
BEGIN
  -- Terminal rows are immutable (no UPDATE; only the CASCADE DELETE from
  -- baseline deletion removes them).
  IF OLD.terminal_at IS NOT NULL THEN
    RAISE EXCEPTION 'wfos_project_context_indices: terminal row is immutable (id=%)', OLD.id;
  END IF;
  -- Identity immutability: the revision + query shape NEVER change.
  IF NEW.baseline_id IS DISTINCT FROM OLD.baseline_id THEN
    RAISE EXCEPTION 'wfos_project_context_indices: baseline_id is immutable (id=%)', OLD.id;
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'wfos_project_context_indices: project_id is immutable (id=%)', OLD.id;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'wfos_project_context_indices: organization_id is immutable (id=%)', OLD.id;
  END IF;
  IF NEW.query_kind IS DISTINCT FROM OLD.query_kind THEN
    RAISE EXCEPTION 'wfos_project_context_indices: query_kind is immutable (id=%)', OLD.id;
  END IF;
  IF NEW.query_ref IS DISTINCT FROM OLD.query_ref THEN
    RAISE EXCEPTION 'wfos_project_context_indices: query_ref is immutable (id=%)', OLD.id;
  END IF;
  IF NEW.baseline_commit_sha IS DISTINCT FROM OLD.baseline_commit_sha THEN
    RAISE EXCEPTION 'wfos_project_context_indices: baseline_commit_sha is immutable (id=%)', OLD.id;
  END IF;
  -- Version monotonicity.
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'wfos_project_context_indices: version cannot decrease (id=%)', OLD.id;
  END IF;
  -- Strict legal edges.
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'indexing' AND NEW.state IN ('complete','failed','stale'))
    ) THEN
      RAISE EXCEPTION 'wfos_project_context_indices: illegal transition % → % (id=%)', OLD.state, NEW.state, OLD.id;
    END IF;
  END IF;
  -- content_digest is exactly-on-complete (NULL before; set on complete; never
  -- rewritten for a terminal row).
  IF NEW.state = 'complete' AND NEW.content_digest IS NULL THEN
    RAISE EXCEPTION 'wfos_project_context_indices: content_digest required at complete (id=%)', OLD.id;
  END IF;
  IF NEW.state = 'indexing' AND NEW.content_digest IS NOT NULL THEN
    RAISE EXCEPTION 'wfos_project_context_indices: content_digest forbidden before complete (id=%)', OLD.id;
  END IF;
  -- finalized_at consistency.
  IF NEW.state IN ('complete','failed','stale') AND NEW.finalized_at IS NULL THEN
    NEW.finalized_at = NOW();
  END IF;
  IF NEW.state = 'indexing' AND NEW.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'wfos_project_context_indices: finalized_at forbidden while indexing (id=%)', OLD.id;
  END IF;
  -- terminal_at consistency (complete/failed/stale are terminal).
  IF NEW.state IN ('complete','failed','stale') AND NEW.terminal_at IS NULL THEN
    NEW.terminal_at = NOW();
  END IF;
  IF NEW.state = 'indexing' AND NEW.terminal_at IS NOT NULL THEN
    RAISE EXCEPTION 'wfos_project_context_indices: terminal_at forbidden while indexing (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_project_context_index_transition_guard_trigger
  ON wfos_project_context_indices;
CREATE TRIGGER wfos_project_context_index_transition_guard_trigger
  BEFORE UPDATE ON wfos_project_context_indices
  FOR EACH ROW EXECUTE FUNCTION wfos_project_context_index_transition_guard_fn();

-- ---------------------------------------------------------------------------
-- wfos_project_context_items — the explainable, provenance-preserving items.
-- Idempotent on (context_index_id, locator, source, kind) so a partial write
-- is safe to re-drive (crash/retry does not duplicate items).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wfos_project_context_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scope (denormalized for direct tenant filtering on reads).
  project_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  context_index_id UUID NOT NULL REFERENCES wfos_project_context_indices(id) ON DELETE CASCADE,
  -- The baseline this item is derived FROM (the provenance carrier). ON
  -- DELETE CASCADE keeps items consistent with baseline deletion.
  baseline_id UUID NOT NULL REFERENCES wfos_project_baselines(id) ON DELETE CASCADE,
  -- WHAT the item is (the SOURCE-FACT pointer — never the fact itself).
  kind TEXT NOT NULL CHECK (kind IN (
    'file','directory','module','configuration','test','ci_workflow',
    'documentation','architecture_observation','requirement','dependency_observation',
    'baseline_observation'
  )),
  -- The concrete locator (path / module id / observation id / requirement id).
  -- Together with source + kind this is the idempotency key.
  locator TEXT NOT NULL,
  -- WHERE the item came FROM (the authority reference; never the authority
  -- itself — the capability never duplicates architecture/requirements/etc).
  source TEXT NOT NULL CHECK (source IN (
    'baseline_evidence','baseline_observation','architecture','requirement',
    'work_item','dependency_graph','repository_structure','tool_observation'
  )),
  -- PROVENANCE PRESERVATION (the central WORK-039 invariant). Re-uses the
  -- WORK-038 vocabulary. The ranker NEVER mutates this field; relevance is
  -- advisory only (the relevance_score + relevance_reason columns).
  provenance TEXT NOT NULL CHECK (provenance IN ('observed','inferred','confirmed','proposed')),
  -- sha256 of the item's canonical content (NULL for pure references — e.g.
  -- an architecture_ref item that only points at an ArchitectureVersion id).
  content_digest TEXT,
  -- Redaction preserved from the underlying baseline evidence (NEVER
  -- reversed; the context layer never holds raw secrets).
  redacted BOOLEAN NOT NULL DEFAULT FALSE,
  -- ADVISORY RELEVANCE (deterministic, explainable, NEVER authority).
  -- Integer score (each signal contributes a discrete weight). The ranker
  -- never promotes provenance based on this score.
  relevance_score INTEGER NOT NULL DEFAULT 0 CHECK (relevance_score >= 0),
  -- The explainable reason chain (NEVER empty — test invariant #15). A
  -- human-readable trace of the signals that selected this item.
  relevance_reason TEXT NOT NULL CHECK (length(relevance_reason) > 0),
  -- HONEST references to baseline evidence rows (the WORK-038 evidence UUIDs
  -- that back this context item). '[]' for pure authority references.
  evidence_ref JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- REFERENCES to authoritative domains (NEVER the authority itself). Keys
  -- are optional: { architectureVersionId?, requirementId?, workItemId?,
  -- observationId?, dependencyObservationId? }. A context item POINTS at
  -- architecture/requirements/work-items; it never duplicates them.
  authority_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency: one item per (index, locator, source, kind). A re-index
  -- returns the SAME items (no duplication — crash/retry safe).
  UNIQUE (context_index_id, locator, source, kind)
);

CREATE INDEX IF NOT EXISTS wfos_project_context_items_index_idx
  ON wfos_project_context_items (context_index_id);
CREATE INDEX IF NOT EXISTS wfos_project_context_items_baseline_idx
  ON wfos_project_context_items (baseline_id);
CREATE INDEX IF NOT EXISTS wfos_project_context_items_project_idx
  ON wfos_project_context_items (project_id);
-- Tenant-scoped relevance lookup (the ranker's retrieval surface).
CREATE INDEX IF NOT EXISTS wfos_project_context_items_relevance_idx
  ON wfos_project_context_items (context_index_id, relevance_score DESC);

-- The append-only guard (mirrors wfos_project_baseline_observation_guard):
-- items are append-only-idempotent. A direct UPDATE of provenance / score /
-- reason / content is forbidden (re-indexing creates a NEW index row — the
-- old index becomes 'stale' terminal; items are NEVER rewritten in place).
-- A direct DELETE is also forbidden; the ONLY legitimate removal path is
-- the CASCADE from index/baseline deletion (mirrors the WORK-038 trigger).
CREATE OR REPLACE FUNCTION wfos_project_context_item_guard_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Items are append-only. A DIRECT DELETE is forbidden — re-indexing
    -- creates a NEW index row (the old becomes 'stale' terminal); it never
    -- deletes individual items. The ONLY legitimate removal path is the
    -- CASCADE from context_index / baseline deletion. When the CASCADE
    -- fires, the parent index row is already gone — so we check: if the
    -- parent index still exists, this is a direct DELETE and must be refused.
    PERFORM 1 FROM wfos_project_context_indices WHERE id = OLD.context_index_id;
    IF FOUND THEN
      RAISE EXCEPTION
        'project-context-item-append-only: direct DELETE on items is forbidden (the parent index % still exists); items are append-only — the only legitimate removal path is the CASCADE from index/baseline deletion',
        OLD.context_index_id;
    END IF;
    RETURN OLD;
  END IF;
  -- TG_OP = 'UPDATE' — no in-place rewrite of an item is ever permitted.
  -- The provenance is immutable (the ranker never promotes it); the
  -- relevance_score / relevance_reason / content_digest are immutable (a
  -- re-index creates a NEW index row, it never rewrites items in place).
  RAISE EXCEPTION
    'project-context-item-immutable: items are append-only — UPDATE is forbidden (re-index creates a new index row; the old row becomes stale terminal, items are never rewritten in place) (id=%)',
    OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_project_context_item_guard_trigger
  ON wfos_project_context_items;
CREATE TRIGGER wfos_project_context_item_guard_trigger
  BEFORE UPDATE OR DELETE ON wfos_project_context_items
  FOR EACH ROW EXECUTE FUNCTION wfos_project_context_item_guard_fn();
-- NOTE: the BEFORE INSERT path is NOT guarded — inserts are idempotent
-- (the UNIQUE on (context_index_id, locator, source, kind) + the
-- repository's ON CONFLICT DO NOTHING makes a re-write a no-op). The
-- CASCADE from context_index deletion still removes items (the trigger's
-- DELETE branch checks the parent index existence — by the time the
-- CASCADE fires, the parent index is already gone, so the check passes).
