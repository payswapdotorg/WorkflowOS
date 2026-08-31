-- WORK-074 — Identity & Access Runtime Activation (the RUNTIME of WORK-063's
-- spec). This migration adds ONLY the identity/session/machine-identity
-- structures WORK-063 specifies. It does NOT alter any existing domain table
-- except wfos_api_key_credentials, which is EXTENDED with scopes (never
-- removed — WORK-063 invariant #10: API keys remain available for automation).
--
-- All credential material in these tables is DIGEST-ONLY (SEC-AC-01/02): raw
-- keys, session tokens, passwords, and provider tokens never persist here.
-- Raw values live behind the SecretStore abstraction (platform/secrets/).
--
-- PostgreSQL remains authoritative for identity, membership, session, and
-- authorization state (WORK-063 invariant #14).

-- ---------------------------------------------------------------------------
-- Linked identities (WORK-063: identity linking on /users). Maps an external
-- provider subject (OIDC `sub`, GitHub user id, or the email of a password
-- account) to a WorkflowOS user. The SAME provider subject always resolves to
-- the SAME user (AUTH-AC-01 generalized to OIDC subjects); multiple provider
-- identities MAY link to ONE user.
--
-- email_verified records whether the provider attested the email for THIS
-- identity. Verified identities may link to an existing verified account by
-- email; unverified ones never do (fail-closed against takeover).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_linked_identities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES wfos_users(id),
  provider       TEXT NOT NULL,
  subject        TEXT NOT NULL,
  email          TEXT,
  display_name   TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, subject)
);

CREATE INDEX wfos_linked_identities_user_idx ON wfos_linked_identities (user_id);
CREATE INDEX wfos_linked_identities_email_idx ON wfos_linked_identities (email)
  WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Server-side sessions (WORK-063: "Sessions are server-side, authoritative,
-- and revocable"). The token is presented by the client (HttpOnly cookie);
-- ONLY its SHA-256 digest is stored. Revocation sets revoked_at — a revoked
-- session never verifies again. Expiry is enforced server-side (expires_at).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES wfos_users(id),
  token_digest      TEXT NOT NULL UNIQUE,
  provider          TEXT NOT NULL DEFAULT 'password',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  last_refreshed_at TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ
);

CREATE INDEX wfos_sessions_user_idx ON wfos_sessions (user_id);

-- ---------------------------------------------------------------------------
-- Email/password credentials (WORK-063: "email/password or passwordless
-- email" — the email/password mechanism). ONLY the scrypt-encoded verifier is
-- stored (never the raw password).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_password_credentials (
  user_id         UUID PRIMARY KEY REFERENCES wfos_users(id),
  password_digest TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Service accounts (WORK-063 machine identity: "Service accounts are
-- first-class principals (NOT users)"). A service identity belongs to an
-- organization (its tenant anchor) and holds an explicit capability set.
-- A service account NEVER gets a wfos_users row.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_service_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  name            TEXT NOT NULL,
  capabilities    TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wfos_service_accounts_org_idx ON wfos_service_accounts (organization_id);

-- ---------------------------------------------------------------------------
-- API-key credentials EXTENSION (WORK-063 invariant #10 — extended, never
-- removed). Legacy rows (scopes IS NULL) keep their exact existing behavior:
-- they authenticate a human external principal through the same chain.
-- Scoped rows carry the granted capability set and are bound to a service
-- account; a revoked key (revoked_at set) fails closed.
-- ---------------------------------------------------------------------------
ALTER TABLE wfos_api_key_credentials
  ADD COLUMN scopes TEXT[] NULL,
  ADD COLUMN service_account_id UUID NULL REFERENCES wfos_service_accounts(id),
  ADD COLUMN revoked_at TIMESTAMPTZ NULL,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX wfos_api_key_credentials_service_account_idx
  ON wfos_api_key_credentials (service_account_id)
  WHERE service_account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- OAuth authorization-request states (WORK-074: callback state/CSRF
-- protection; PR #99 remediation). Short-lived, single-use server-side
-- records binding the authorization redirect to THIS initiating browser:
-- transaction_digest is the SHA-256 of the pre-auth transaction cookie the
-- /start response issued, and the callback consume REQUIRES the same value —
-- a state presented by any other browser never yields a session (login-CSRF
-- protection). The digest is checked in the SAME atomic single-use DELETE as
-- the state itself. Nothing here is secret material: the state is a random
-- CSRF nonce and the transaction digest is not invertible — the raw
-- transaction id never persists.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_oauth_states (
  state              TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  redirect_to        TEXT NOT NULL DEFAULT '/',
  transaction_digest TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL
);
