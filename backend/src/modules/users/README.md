# /users

**Responsibility (frozen):** WorkflowOS user records and identity resolution.

This directory is a frozen backend module boundary (spec/architecture.md §6).
Cross-module communication must go through `index.ts`; `internal/` is private.

## WORK-074 — linked identities

`internal/pg-linked-identity-repository.ts` + the `LinkedIdentityRepository`
contract: the (provider, subject) → user mapping behind deterministic identity
resolution (AUTH-AC-01 generalized to OIDC subjects) and identity linking
(WORK-063: multiple provider identities may link to one user). PostgreSQL
remains the authoritative store (architecture §28); the /auth identity runtime
consumes the declared contract — never this module's internals.
