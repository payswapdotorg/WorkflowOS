-- WORK-002 auth infrastructure: API-key credential registry (AUTH-001, SEC-001).
--
-- This table is /auth-owned infrastructure for authenticating API keys. It
-- holds ONLY:
--   - key_id (safe to log)
--   - secret_ref (opaque SecretStore reference — env var name / key id; NOT
--     the raw key)
--   - external_id (principal this key authenticates)
--   - label (human-readable, safe to log)
--   - key_digest (SHA-256 hex of the raw key, for lookup)
--
-- The raw key value itself is NEVER stored here (SEC-AC-02). It lives behind
-- the SecretStore abstraction (platform/secrets/) and is retrieved via
-- secret_ref only during authentication. A database leak does not expose
-- usable credentials.
--
-- NOTE: secret_ref is a plain TEXT column holding an opaque reference (e.g.
-- an env var name). The static check (SEC-AC-02) verifies that no domain
-- table holds the raw secret *value* — this column holds only a reference,
-- which is the sanctioned pattern.

CREATE TABLE wfos_api_key_credentials (
  key_id      TEXT PRIMARY KEY,
  secret_ref  TEXT NOT NULL,
  external_id TEXT NOT NULL,
  label       TEXT NOT NULL,
  key_digest  TEXT NOT NULL UNIQUE
);

CREATE INDEX wfos_api_key_credentials_digest_idx
  ON wfos_api_key_credentials (key_digest);
