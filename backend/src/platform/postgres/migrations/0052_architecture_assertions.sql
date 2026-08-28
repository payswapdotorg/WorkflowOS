-- WORK-051 — Architecture Governance and Checkpoints.
--
-- The /architecture module remains the SOLE authority for architecture
-- definitions, ArchitectureVersions, assertions, and Architecture Change
-- Requests. This migration adds the ASSERTION table owned by /architecture
-- (issue #51: "Assertions are version-scoped metadata owned by /architecture").
--
-- DESIGN (docs/superpowers/specs/2026-08-27-architecture-governance-
-- checkpoints-design.md §4.1):
--
--   An Architecture Assertion is a versioned architectural rule owned by
--   /architecture and attached to an IMMUTABLE ArchitectureVersion. It
--   describes a condition that must remain true for implementations governed
--   by that version.
--
-- IMMUTABILITY — two persistence-enforced layers (mirrors the WORK-005
-- frozen-version trigger pattern — enforcement lives in PostgreSQL, NOT in
-- the service layer):
--
--   1. ROW immutability: an assertion row can NEVER be UPDATEd or DELETEd.
--      A BEFORE UPDATE OR DELETE trigger raises unconditionally. Assertions
--      are append-only facts.
--
--   2. SET immutability with the ArchitectureVersion: an assertion can be
--      ATTACHED only while the version is DRAFT. Once the version is FROZEN
--      (or SUPERSEDED) its assertion set is closed — a BEFORE INSERT trigger
--      joins the version and rejects the attach. Intentional architecture
--      change follows the existing Architecture Change Request → approved →
--      NEW immutable ArchitectureVersion path (ARCH-004); the frozen set is
--      never edited in place.
--
-- The checkpoint subsystem (application layer, src/architecture-checkpoints/)
-- reads assertions through the /architecture public barrel ONLY. It has no
-- table of its own: checkpoint EVIDENCE is persisted through /verification
-- (existing wfos_verification_runs + wfos_evidence rows — NO new evidence
-- store, NO parallel authority). See migration 0012 for those tables.
--
-- detector_config is opaque JSON metadata consumed by the deterministic
-- detector identified by detector_kind. It contains NO credentials and NO
-- provider coupling (detectors are file-tree/contract evaluators).

-- ---------------------------------------------------------------------------
-- Architecture Assertions (version-scoped metadata owned by /architecture).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_architecture_assertions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  architecture_version_id UUID NOT NULL REFERENCES wfos_architecture_versions(id) ON DELETE CASCADE,
  -- Stable human-facing identifier, unique per version (e.g. 'ARCH-051-001').
  assertion_id           TEXT NOT NULL,
  severity               TEXT NOT NULL,
  scope                  TEXT NOT NULL,
  statement              TEXT NOT NULL,
  detector_kind          TEXT NOT NULL,
  detector_config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (architecture_version_id, assertion_id)
);

CREATE INDEX wfos_arch_assertions_version_idx
  ON wfos_architecture_assertions (architecture_version_id);

ALTER TABLE wfos_architecture_assertions
  DROP CONSTRAINT IF EXISTS wfos_arch_assertion_severity_valid;
ALTER TABLE wfos_architecture_assertions
  ADD CONSTRAINT wfos_arch_assertion_severity_valid
  CHECK (severity IN ('blocking', 'advisory'));

ALTER TABLE wfos_architecture_assertions
  DROP CONSTRAINT IF EXISTS wfos_arch_assertion_scope_valid;
ALTER TABLE wfos_architecture_assertions
  ADD CONSTRAINT wfos_arch_assertion_scope_valid
  CHECK (scope IN ('repository', 'module', 'interface', 'data', 'workflow', 'security', 'execution', 'other'));

-- ---------------------------------------------------------------------------
-- SET immutability: assertions attach only to DRAFT versions. The moment a
-- version is FROZEN its assertion set is closed; any later change requires
-- the Architecture Change Request → new immutable version path.
--
-- PR #52 round 1 (BLOCKER 3): the state read takes a FOR SHARE lock on the
-- version row, so EVERY insert path (repository or direct SQL) serializes
-- against version freezing (transitionState/freezeVersion update the same
-- row under FOR UPDATE inside their transaction). The interleaving
--
--   T1: trigger reads draft → T2: freeze commits → T1: insert commits
--
-- is no longer possible: T1's FOR SHARE either observes the freeze's
-- committed state (rejected) or holds the row against the freeze's UPDATE
-- until T1 commits (the attach serialized BEFORE the freeze).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_arch_assertions_require_draft_version()
RETURNS TRIGGER AS $$
DECLARE
  v_state TEXT;
BEGIN
  SELECT state INTO v_state
    FROM wfos_architecture_versions
   WHERE id = NEW.architecture_version_id
     FOR SHARE;
  IF v_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'cannot attach architecture assertion to % version % — the assertion set is immutable with a frozen/superseded version; use the Architecture Change Request path',
      v_state, NEW.architecture_version_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_arch_assertions_draft_only ON wfos_architecture_assertions;
CREATE TRIGGER wfos_arch_assertions_draft_only
  BEFORE INSERT ON wfos_architecture_assertions
  FOR EACH ROW
  EXECUTE FUNCTION wfos_arch_assertions_require_draft_version();

-- ---------------------------------------------------------------------------
-- ROW immutability: assertion rows are append-only. No UPDATE. No DELETE.
-- (Proof 8: intentional architecture changes must NOT mutate the frozen
-- version's assertion set — they create a NEW version.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_arch_assertions_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'architecture assertion rows are immutable (append-only): no UPDATE or DELETE is permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_arch_assertions_protect ON wfos_architecture_assertions;
CREATE TRIGGER wfos_arch_assertions_protect
  BEFORE UPDATE OR DELETE ON wfos_architecture_assertions
  FOR EACH ROW
  EXECUTE FUNCTION wfos_arch_assertions_immutable();
