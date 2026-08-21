-- WORK-003 infrastructure schema (DATA-001 / DATA-AC-02 / DATA3-AC-02).
--
-- This migration creates the *infrastructure-level* tables required to
-- demonstrate the persistence/storage boundaries. It does NOT create any
-- domain entities — those belong to later work items (WORK-004 onwards).
--
-- Two infrastructure concerns are covered here:
--
--   1. A parent/child FK fixture used by DATA-AC-02 to prove PostgreSQL
--      enforces referential integrity (not application code).
--   2. An `artifact_metadata` table that holds durable PostgreSQL references
--      to large/immutable objects stored in object storage (DATA3-AC-01 /
--      DATA3-AC-02). Core relational records reference the artifact by id
--      rather than embedding the full body.

-- ---------------------------------------------------------------------------
-- Migration tracking table (created idempotently by the runner, but defined
-- here so a fresh schema is self-contained for inspection).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- DATA-AC-02 fixture: a parent/child relationship with a real FOREIGN KEY.
-- Used by tests/integration/postgres/foreign-key.integration.test.ts to prove
-- PostgreSQL rejects invalid child references at the database level.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_fixture_parent (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wfos_fixture_child (
  id         SERIAL PRIMARY KEY,
  parent_id  INTEGER NOT NULL REFERENCES wfos_fixture_parent(id),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- DATA3-AC-01 / DATA3-AC-02: durable metadata for large/immutable artifacts
-- stored in object storage. The `storage_key` is the provider-independent
-- reference used by the ObjectStore abstraction to retrieve the object.
-- The `content_length`/`content_type`/`digest` columns carry provenance so
-- the relational record is self-describing WITHOUT holding the full body.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_artifact_metadata (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Provider-independent storage reference (e.g. bucket/key or path).
  -- Suffices to locate the stored object via ObjectStore.
  storage_key     TEXT NOT NULL,
  storage_provider TEXT NOT NULL,
  content_length  BIGINT NOT NULL,
  content_type    TEXT,
  digest_sha256   TEXT,
  -- Free-form provenance metadata. JSON is allowed for unstructured
  -- per-provider metadata; it does NOT replace relational modeling of core
  -- domain state (architecture §28).
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wfos_artifact_metadata_storage_key_idx
  ON wfos_artifact_metadata (storage_key);
