# WORK-002 — Identity, organizations, permissions, tenant isolation

**Status:** COMPLETE
**Acceptance criteria:** AUTH-AC-01, AUTH-AC-02, AUTH2-AC-01, AUTH2-AC-02, AUTHZ-AC-01, AUTHZ-AC-02, AUTHZ-AC-03, SEC-AC-01, SEC-AC-02
**Requirements:** AUTH-001, AUTH-002, AUTH-003, SEC-001
**Implementation:** `backend/src/modules/{auth,users,organizations,projects}/` + `backend/src/platform/secrets/` + `backend/src/api/plugins/auth.plugin.ts`

## What was built

The identity, organization membership, role-based authorization, tenant
isolation, and secret-management boundary required by the frozen architecture
(§7 Auth/Orgs, §32 Security, §33 Secrets, §34 Multi-Tenancy). Reuses the
WORK-001/003 platform infrastructure without duplication.

### 1. PostgreSQL schema (migration 0002 + 0003)

- `wfos_users` — WorkflowOS user identity (AUTH-001). Stable `external_id` for
  deterministic identity resolution (AUTH-AC-01).
- `wfos_organizations` — top of the ownership hierarchy (§7).
- `wfos_roles` / `wfos_permissions` / `wfos_role_permissions` — explicit
  role → permission mapping (AUTH2-AC-02). Seeded with `owner`/`admin`/`member`
  × `project.read`/`project.write`/`project.admin`/`org.admin`/`org.members`.
- `wfos_organization_memberships` — user ↔ org ↔ role (AUTH-002).
- `wfos_projects` — **minimal**: id + owning org + name only (PROJ-001 scope
  limit; full project domain is WORK-004).
- `wfos_project_access` — user ↔ project ↔ role (AUTHZ-AC-01..03).
- `wfos_api_key_credentials` (migration 0003) — holds ONLY `key_id`,
  `secret_ref` (opaque), `external_id`, `label`, `key_digest` (SHA-256). The
  raw key is NEVER stored (SEC-AC-02).

### 2. Authentication boundary (/auth)

- `AuthProvider` interface — provider-independent (AUTH-001). Domain logic
  depends on this, never on a concrete provider.
- `ApiKeyAuthProvider` — resolves an API key to an `AuthenticatedPrincipal` by
  matching the key's SHA-256 digest against `wfos_api_key_credentials`, then
  verifying the raw value via the `SecretStore` (SEC-AC-01). Distinguishes
  `missing-credentials` / `invalid-credentials` / `principal` (AUTH-AC-02).
- `AuthorizationService` + `DefaultAuthorizationService` — reusable backend
  RBAC (AUTHZ-AC-01..03). Decision chain:
  user → org membership → role → permission → project access.
- `ApiKeyCredentialProvisioner` — the ONLY sanctioned way to create a
  credential row; stores digest + opaque ref, never the raw key.

### 3. Identity / organizations / projects (/users, /organizations, /projects)

- `UserRepository` + `PgUserRepository` — `upsertByExternalId` is deterministic
  (same externalId → same persisted user) (AUTH-AC-01).
- `OrganizationRepository`, `MembershipRepository`, `RolePermissionRepository`
  — org + membership + explicit permission resolution (AUTH-002, AUTH2-AC-02).
- `ProjectRepository`, `ProjectAccessRepository` — minimal project ownership +
  project-scoped access (AUTHZ-AC-01..03). The `/projects` public interface is
  scope-limited (enforced statically) to prevent broadening into WORK-004.

### 4. Secret management (SEC-001)

- `SecretStore` interface — the ONLY sanctioned way to retrieve raw secret
  values. `SecretRef` is the only shape domain code may hold (opaque key, never
  the value).
- `EnvSecretStore` — local/test default (reads `process.env`). Production
  substitutes a real backend without changing domain code.
- Raw secrets never enter domain records, logs, or audit events (SEC-AC-02).
  Enforced by schema checks + a log-capture test.

### 5. API authorization (AUTHZ-AC-01..03)

- `auth.plugin.ts` — Fastify onRequest hook resolves `Authorization: Bearer
  <key>` or `X-API-Key` → `AuthenticatedPrincipal` → persisted `User`. Does NOT
  make authorization decisions (that's `AuthorizationService`).
- `requireProjectAuthorization` route helper — calls
  `AuthorizationService.authorize` and 403s on denial.
- `GET /projects/:projectId` — protected route demonstrating backend-owned
  authorization. Frontend state is irrelevant (AUTHZ-AC-03).

### 6. Tenant isolation (AUTHZ-AC-02)

The `DefaultAuthorizationService` requires the user to be a member of the
organization that owns the project. A cross-tenant `project_access` row alone
is NOT sufficient — User A (Org A) cannot access Project B (Org B) even if a
stray grant exists, because User A has no membership in Org B.

## Acceptance-criteria → evidence map

| Criterion | Evidence |
| --- | --- |
| **AUTH-AC-01** | `tests/integration/auth/authentication.integration.test.ts` — valid auth resolves to principal; same externalId resolves deterministically to the same persisted user. |
| **AUTH-AC-02** | same test — missing + invalid credentials rejected; tampered key (digest match but secret mismatch) rejected. |
| **AUTH2-AC-01** | `tests/integration/auth/organizations.integration.test.ts` — membership persists; recoverable by user+org; idempotent upsert. |
| **AUTH2-AC-02** | same test — roles resolve to explicit permissions via `wfos_role_permissions`; member role does NOT get admin permissions; owner gets the full seeded set. |
| **AUTHZ-AC-01** | `tests/integration/auth/authorization.integration.test.ts` — service + API: permitted access succeeds (200); unauthenticated → 401; non-existent project → denied. |
| **AUTHZ-AC-02** | same test — User A (Org A) → Project B (Org B) denied (`not-a-member`); a stray cross-tenant `project_access` row does NOT grant access. |
| **AUTHZ-AC-03** | same test — `requireProjectAuthorization` enforces server-side; `AuthorizationService.authorize` is testable without HTTP; direct API call with no project_access is denied. |
| **SEC-AC-01** | `tests/integration/auth/secrets.integration.test.ts` — raw key retrieved ONLY via `SecretStore.getSecret`; authentication exercises the abstraction. |
| **SEC-AC-02** | same test — `wfos_api_key_credentials` has no raw-key column (schema check); raw secret never appears in captured logs; no domain table has a raw-secret column; migration SQL static check. |

## Static architecture invariants (WORK-002 additions)

`tests/architecture/static-architecture.test.ts` adds a
`WORK-002 invariants — identity/authorization module boundaries` block:

1. `/auth`, `/users`, `/organizations`, `/projects` exist as explicit boundaries.
2. WORK-002 modules do not reach into each other's `internal/`.
3. Domain modules do not import `@modules/<X>/internal/` subpaths.
4. Only `src/modules/auth/` declares an `AuthorizationService` implementation.
5. No frontend/client source declares an auth-provider or authorization impl.
6. `/projects` exposes only the minimal ownership/access contracts (PROJ-001
   scope limit — enforced by name).
7. Concrete WORK-002 implementations (`ApiKeyAuthProvider`,
   `DefaultAuthorizationService`, `PgUserRepository`, `EnvSecretStore`, etc.)
   are in `FORBIDDEN_CONCRETE_EXPORTS` and `PROVIDER_IMPLEMENTATION_FILES`.

## Verification

```
cd backend
bun install
bun run test        # 181 tests pass (147 from WORK-001/003 + 34 new for WORK-002)
bun run typecheck   # tsc --noEmit — clean
bun run lint        # eslint — clean
```

CI (`.github/workflows/backend.yml`) runs against real PostgreSQL + Redis
service containers (unchanged from WORK-003).

## Architecture conformance

- PostgreSQL is authoritative for identity, membership, permission, and
  tenant-access state (§28, AUTH-001..003). Redis holds none of it (§29).
- Provider independence (§2.5): domain modules depend on `AuthProvider`,
  `AuthorizationService`, `SecretStore`, repository interfaces — never on
  concrete implementations. Enforced statically.
- Secrets are not ordinary application data (§33): the `SecretStore`
  abstraction is the only sanctioned access path; raw values never enter
  domain records/logs.
- Tenant boundaries enforced server-side (§34, AUTHZ-AC-02): a different
  tenant/resource id does not bypass the authorization chain.
- No duplicate database, Redis, worker, or persistence infrastructure
  (reuses WORK-001/003).
- Minimal project representation (PROJ-001 scope limit): only ownership +
  access; full project domain is WORK-004.
- No frozen architecture document modified.
