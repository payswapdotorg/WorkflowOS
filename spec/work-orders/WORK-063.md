# WORK-063 — Identity and Access Layer (Human Login and Scoped Machine Identity)

Status: planned.

Issued by: the 2026-08-30 identity-and-access architecture decision (the
second governance correction of 2026-08-30, after WORK-062). This Work Order
establishes the production Identity & Access model — it does NOT implement
runtime code. Activation requires the architect's authorization and is
recorded in `spec/development-state/program-state.json` (this change records
none).

Dependencies: WORK-002 (Identity, organizations, permissions, tenant
isolation — the frozen foundation this layer extends), WORK-048 (Developer
Workbench — the consumer whose bootstrap demo-key login this replaces).
Downstream: WORK-061 (Self-Hosting Conformance and Continuous Governance)
depends on this Work Order, because the customer-facing self-hosting
experience begins with a human signing in and ends with an authorized agent
running governed work — neither is possible on a shared demo key.

## Objective

Replace the bootstrap demo-key login with a production Identity & Access
layer: human login (OAuth/OIDC: Google and GitHub; email), real
organization/membership management, server-authoritative project
authorization, and scoped machine identity (service accounts with
capability-scoped API credentials) — WITHOUT becoming another workflow or
business authority of any kind.

The demo-key login was a bootstrap implementation: it exists because the
early architecture prioritized proving the workflow/execution/governance
system before spending effort on a full identity layer. WORK-002 already
built the load-bearing parts (the `AuthProvider` boundary, deterministic
identity resolution, organizations/memberships/roles/permissions, the
`AuthorizationService` decision chain with tenant isolation, digest-only
credential storage behind the `SecretStore`). WORK-063 completes that
foundation into the production model — it does not rebuild it.

## The identity model (the decision)

WorkflowOS serves two kinds of principals, and the distinction is permanent:

```text
                     WorkflowOS
                         │
              ┌──────────┴──────────┐
              │                     │
          Human users         Machine/agent clients
              │                     │
     Google / GitHub / Email   Scoped service-account
              │                API credentials
              └──────────┬──────────┘
                         ▼
                  Identity / Session
                         ▼
                Organization / Membership
                         ▼
                Project authorization
                         ▼
            existing WorkflowOS authorities
```

A human signs in with Google/GitHub/email. An implementation agent NEVER
pretends to be a human: it presents a scoped machine credential bound to a
service identity inside an organization.

Structural example (illustrative):

```text
Acme Inc.
 ├── Alice — owner          (human, org-level role)
 ├── Bob   — developer      (human, org-level role)
 └── CI    — service account (machine, explicit capabilities)

Projects
 ├── WorkflowOS
 ├── Client A
 └── Client B
```

Example capability set for an implementation-agent service account:

```text
z.ai worker
  can:
    read Work Orders
    create branch
    create PR
    read execution state

  cannot:
    modify architecture
    approve own PR
    alter verification evidence
    change tenant
```

## Authentication is separated from authorization

This separation is the point of the layer, because WorkflowOS has spent its
whole history establishing authority boundaries:

- **Authentication** answers: who are you? (a human login or a machine
  credential — producing an `AuthenticatedPrincipal`)
- **Authorization** answers: what are you allowed to do to this project?
  (a server-side decision; NEVER client-side)

```text
Google/GitHub/email login (or scoped API credential)
     ↓
User identity (deterministic externalId → wfos_users, AUTH-AC-01)
     ↓
Organization membership (wfos_organization_memberships)
     ↓
Project authorization (AuthorizationService: user → membership →
                       role/permission → project access)
     ↓
existing WorkflowOS authorities (workflows, execution, verification,
                                 review — unchanged)
```

The existing decision chain is exactly the target model: user →
organization membership → role → permission → explicit project access, with
tenant isolation enforced server-side (AUTHZ-AC-02: a cross-tenant
project_access row alone grants nothing without membership in the owning
organization). WORK-063 wires real human principals and scoped machine
principals into that existing chain; it does not add a parallel one.

## Layer-to-module mapping

The conceptual layer maps onto the EXISTING frozen module boundaries — the
identity layer is expressible WITHOUT changing them:

```text
/identity        →  /auth (providers, sessions, API credentials,
                        service accounts)
                    /users (users, linked identities)
                    /organizations (organizations, memberships)
/authorization   →  /auth AuthorizationService + /organizations
                    roles/permissions + /projects project access
existing domains →  /workflows, /runtime, /verification, /reviews, …
                    (authoritative for their own concerns, unchanged)
```

Any implementation step that would require changing a frozen module
boundary goes through the architecture governance path (checkpoint/ACR),
never silent boundary drift.

## Human identity

- OAuth/OIDC providers — Google and GitHub first; provider adapters behind
  the existing provider-independent `AuthProvider` boundary (a new provider
  is a new adapter, never a new authority).
- Email — email/password or passwordless email.
- Deterministic identity resolution: the same provider subject always
  resolves to the same WorkflowOS user (AUTH-AC-01 generalized from the
  API-key precedent to OIDC subjects).
- Identity linking: multiple provider identities may link to one user; a
  linked re-login resolves to the SAME user.
- Sessions are server-side, authoritative, and revocable; logout/revocation
  actually removes access.
- Eventually SSO/SAML for organizations — explicitly a FUTURE extension,
  NOT part of this Work Order's scope or Definition of Done.

## Machine identity

- Service accounts are first-class principals (NOT users): a service
  identity belongs to an organization and holds an explicit capability set.
- API credentials for service accounts are scoped: each credential carries
  its granted capabilities, and authorization decisions for machine
  principals flow through the SAME server-side `AuthorizationService` path
  (capability → permission mapping), never a parallel authorization
  mechanism.
- Fail closed: a capability not granted is denied, with a typed denial.
- Credential material stays under the existing discipline: digest-only
  storage, opaque `SecretStore` references (SEC-AC-01/02) — raw keys are
  never stored in domain/workflow records.
- The distinction between human and machine principals becomes extremely
  important once WorkflowOS orchestrates dozens or hundreds of agents; it
  is built in from the start, not retrofitted.

## API keys remain

Automation keeps first-class programmatic access even after normal login
exists (the Vercel-like product model: a great interactive login experience
AND secure programmatic access). The existing `wfos_api_key_credentials`
mechanism is EXTENDED with scopes — never removed. The bootstrap demo key
becomes obsolete: the Workbench stops depending on it (removed, or
explicitly demoted to a documented development-only mechanism with no
production dependency).

## The self-hosting experience this enables

The end product supports the flow that WORK-061's self-hosting conformance
will exercise end-to-end:

```text
Sign in with GitHub
        ↓
Create organization
        ↓
Connect repository
        ↓
Create project
        ↓
Invite developers
        ↓
Authorize agents
        ↓
Run WorkflowOS
```

## Explicit prohibitions

WORK-063 must NEVER become:

- a **second workflow or business authority** — identity answers "who are
  you", authorization answers "what may you do to this project"; neither
  redefines Work Item/workflow/execution/verification/review semantics (the
  existing domains remain authoritative for their own concerns);
- an **"OAuth-only" replacement of machine credentials** — human identity
  AND machine identity are BOTH first-class; an implementation that removes
  API keys/service accounts to "simplify" violates this Work Order;
- a **client-side authorization mechanism** — every authorization decision
  remains server-side and authoritative (AUTHZ-AC-01..03); the browser never
  decides whether a user is authorized (the existing WORK-022 invariant);
- a **second tenant-isolation model** — org/project scoping stays
  server-authoritative through the existing decision chain (AUTHZ-AC-02
  unchanged and unweakened);
- a **credential store outside the SecretStore boundary** — raw keys,
  session secrets, and provider tokens never persist in domain/workflow
  records (digests and opaque references only, SEC-AC-01/02).

## Required invariants

1. Authentication and authorization remain separated. (Authentication
   produces a principal — human or machine; authorization is a server-side
   decision on membership + role/capabilities + project access.)
2. A human identity resolves deterministically to exactly one WorkflowOS
   user per provider subject. (AUTH-AC-01 generalized to OIDC providers.)
3. A machine principal is never a human user. (Service accounts are
   distinct principals with explicit capability sets; they never
   impersonate a human.)
4. No login path bypasses authorization. (Every authenticated session or
   API credential passes the same server-side decision chain before any
   protected operation.)
5. Sessions are server-side authoritative and revocable. (Logout/revocation
   actually removes access; there are no immortal tokens.)
6. Scoped credentials fail closed. (A capability not granted is denied with
   a typed denial.)
7. Capability separation holds. (An implementation-agent credential may
   read Work Orders, create branches, create PRs, and read execution state,
   but CANNOT modify architecture, approve its own PR, alter verification
   evidence, or change tenant — privileged governance surfaces stay behind
   separate human-owned permissions.)
8. Tenant isolation is unchanged and unweakened. (An authenticated member
   of Org A cannot access Org B's project, even with a planted cross-tenant
   project_access row — the AUTHZ-AC-02 membership requirement.)
9. The Workbench no longer depends on the demo key. (The bootstrap path is
   removed or explicitly demoted to documented development-only use; no
   production dependency remains.)
10. API keys remain available for automation. (Programmatic access stays
    first-class alongside human login.)
11. Raw credentials never persist in domain/workflow records. (Key
    material, session secrets, and provider tokens live only as digests and
    opaque SecretStore references.)
12. Identity operations are audit-covered. (Login, credential
    issuance/revocation, membership and role changes are auditable
    privileged events on the existing /audit surface.)
13. The identity layer introduces NO new workflow, delegation, execution,
    or verification authority. (The no-second-authority matrix is
    unchanged.)
14. PostgreSQL remains authoritative for identity, membership, and
    authorization state. (External identity providers are authoritative
    only for THEIR authentication assertion — never for WorkflowOS
    authorization.)
15. The layer is expressible within the existing frozen module boundaries.
    (Any frozen-boundary change requires the architecture governance path
    — checkpoint/ACR — not silent boundary drift.)

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **human login end-to-end** — a real OAuth/OIDC (or email) login produces
   an authenticated session and a resolved WorkflowOS user; re-login
   resolves the SAME user;
2. **identity linking** — the same user with multiple linked provider
   identities resolves to one user;
3. **session lifecycle** — create/verify/revoke; a revoked session is
   rejected (discrimination-proven against the unrevoked behavior);
4. **authorization chain** — a human user's access follows user →
   membership → role/permission → project access on real routes (allowed
   AND denied cases);
5. **tenant isolation under login** — an authenticated member of Org A
   cannot access Org B's project even with a planted cross-tenant access
   row (AUTHZ-AC-02 discrimination);
6. **machine principal scoping** — a scoped service-account credential CAN
   exercise its granted capabilities and CANNOT exercise ungranted ones
   (typed denials; mutation-proven: removing the scope check makes the test
   fail);
7. **privilege separation** — the implementation-agent capability set
   cannot modify architecture, approve its own PR, alter verification
   evidence, or change tenant (each attempted violation fails closed);
8. **API-key automation path** — existing API-key authentication keeps
   working through the same authorization chain after the change (no
   regression);
9. **demo-key removal** — the Workbench functions with real login and the
   production path no longer accepts or depends on the demo key;
10. **credential safety** — raw key/session/provider-token material never
    appears in database records or logs (digest/reference only;
    discrimination-proven);
11. **audit coverage** — login, credential issuance/revocation, and
    membership/role-change events are recorded on the audit surface;
12. **static architecture invariants** — the module-boundary and
    no-second-authority matrix passes with the identity layer in place;
13. **real-PostgreSQL, mutation/discrimination tests** — the authorization
    and scoping claims are proven on real PostgreSQL with independent
    connections, and the invariants are discriminating: removing a scope
    check, the membership requirement, or the session-revocation check
    makes the corresponding test FAIL.

## Scope

Allowed: OAuth/OIDC and email provider adapters behind the existing
`AuthProvider` boundary; session lifecycle; identity linking on /users;
service accounts and scoped API credentials on /auth; the capability →
permission mapping through the existing AuthorizationService;
organization/membership management surfaces; project-authorization wiring;
Workbench login UX (human login, organization/project context, credential
management UI); migration off the demo-key bootstrap; the required proofs
above on real PostgreSQL.

Forbidden: everything in "Explicit prohibitions"; SSO/SAML (a recorded
future extension, out of scope); changing WORK-046/WORK-047 semantics;
GitHub merge/CI authority; any runtime implementation in THIS change (this
task delivers the Work Order and the dependency-model correction only).

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second workflow or business authority;
- client-side authorization decisions;
- storing raw credentials outside the SecretStore discipline;
- removing API keys or service accounts (an "OAuth-only" simplification);
- weakening tenant isolation;
- changing frozen module boundaries outside the architecture governance
  path;
- an external identity provider becoming an authorization authority.

## Definition of done

- All required invariants hold with objective evidence (the required proofs
  above, on real PostgreSQL, with mutation/discrimination tests).
- Static architecture invariants for the authority-boundary claims pass
  (including the no-second-authority matrix and the frozen-boundary
  discipline).
- The Workbench no longer depends on the demo key; API keys remain
  available for automation.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-063 scope; independent Architect Review approves;
  the implementation PR is merged; WORK-063 is marked VERIFIED before
  WORK-061 becomes eligible on it.
