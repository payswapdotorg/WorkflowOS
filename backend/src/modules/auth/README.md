# /auth

**Responsibility (frozen):** Authentication, WorkflowOS user identity boundary (paired with /users).

This directory is a frozen backend module boundary (spec/architecture.md §6).
Cross-module communication must go through `index.ts`; `internal/` is private.

## WORK-074 — Identity & Access runtime (the WORK-063 spec activated)

The runtime pieces added by WORK-074, all behind the SAME provider-independent
boundaries (a new provider is a new adapter, never a new authority):

- `internal/session-service.ts` — server-side, authoritative, revocable
  sessions (`wfos_sessions`; digest-only token storage; refresh persistence;
  login/logout audit through /audit).
- `internal/password-credential-service.ts` — the email/password mechanism
  (scrypt verifiers only; fail-closed registration semantics).
- `internal/identity-resolution-service.ts` — deterministic provider-subject →
  user resolution (AUTH-AC-01 generalized to OIDC subjects) + verified-email
  identity linking (fail-closed against takeover; typed `email-conflict`).
- `internal/oauth-provider.ts` — the Google (OIDC) and GitHub OAuth adapters
  (confidential clients; server-side code exchange; assertion retrieval over
  TLS). `internal/oauth-state-store.ts` — the single-use CSRF state store.
- `internal/session-auth-provider.ts` — the session token verified through the
  SAME `AuthProvider` boundary as the API-key provider.
- `internal/machine-identity-service.ts` — scoped machine identity: service
  accounts (first-class principals, NOT users) + capability-scoped API keys
  (closed grantable set; digest-only; issuance/revocation audited).
- `internal/authorization-service.ts` — `authorizeForMachinePrincipal`: the
  machine decision path INSIDE the ONE `DefaultAuthorizationService` chain
  (tenant anchor → closed capability → permission mapping; typed fail-closed
  denials). No second authorization engine exists.

The HTTP surface lives at `/auth/*` (api/routes/auth.route.ts): password
register/login, OAuth start/callback, session whoami/refresh/logout, provider
configuration, and the service-account + key management (human org-admins
only).
