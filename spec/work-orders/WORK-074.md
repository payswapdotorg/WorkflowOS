# WORK-074 — Identity & Access Runtime Activation

Status: in flight (activated 2026-08-30 by the architect's implementation
instruction — the dogfooding gate's authentication precondition, finding F-1;
the activation is recorded in
`spec/development-state/program-state.json`, branch
`feat/work-074-identity-access-runtime`, implementation PR #99). The implementation delivers the WORK-063 identity
model as RUNTIME — nothing re-architected, no second authority:

1. **Human login** — the WORK-063 providers behind the SAME `AuthProvider`
   boundary: Google (OIDC) and GitHub (OAuth app) adapters (confidential
   clients; server-side code exchange; assertion retrieval over TLS; a provider
   is an adapter, never an authority), plus the **email/password** mechanism
   (scrypt verifiers only; the smaller production-appropriate option that needs
   no mail infrastructure — WORK-063 allows either). Unconfigured providers
   surface as honestly "unavailable" on the login page (fail closed). OAuth
   callbacks validate + atomically consume a single-use server-side CSRF state
   (`wfos_oauth_states`); a replayed/unknown state never yields a session.
2. **Identity** — deterministic provider-subject → user resolution
   (`wfos_linked_identities`, owned by /users; AUTH-AC-01 generalized to OIDC
   subjects) and identity linking: a provider-VERIFIED email links to an
   existing VERIFIED account (one human, multiple providers, same user);
   linking NEVER auto-attaches to an unverified (password-created) account — a
   typed `email-conflict` rejection (no takeover path).
3. **Sessions** — server-side, authoritative, revocable (`wfos_sessions`):
   opaque 256-bit tokens in HttpOnly SameSite=Lax cookies (Secure in
   production), SHA-256 digest-only persistence, sliding refresh, typed
   expired/revoked/invalid verification, logout actually removes access.
4. **Authorization** — ONE chain, unchanged: humans flow through the existing
   `AuthorizationService.authorize` (user → membership → role → permission →
   project access; AUTHZ-AC-01..03 untouched); machine principals flow through
   `authorizeForMachinePrincipal` INSIDE the same service (resource → owning
   org → tenant anchor → closed capability → permission mapping; typed
   `capability-not-granted`; machine access requires explicit route opt-in —
   undeclared routes deny machines fail-closed). Governance capabilities
   (`architecture.modify`, `review.approve`, `verification.evidence.write`,
   `tenant.change`, `org.admin`, `org.members`) are deliberately UNGRANTABLE
   (privilege separation).
5. **Machine identity** — `wfos_service_accounts` are first-class NON-user
   principals (never a `wfos_users` row; the plugin never resolves them to
   users) with explicit capability ceilings; scoped keys EXTEND
   `wfos_api_key_credentials` (scopes + service_account_id + revoked_at +
   created_at) — never removed; legacy unscoped keys keep their exact behavior
   (API-key automation preserved). Raw key material is shown exactly once and
   lives only behind the SecretStore boundary (an OPTIONAL `putSecret`
   capability was added to `platform/secrets`; a non-writable store cannot
   issue keys — fail closed).
6. **Workbench off the demo key** — the LoginPage is the human login (NO
   API-key input); the API client holds NO credential material (the canonical
   auth-state source is an observable session client — the App gate re-renders
   synchronously after sign-in, NO manual reload: proof #15). The
   **WORK-072 overlap is documented, not silently absorbed**: the canonical
   auth-state source + synchronous propagation are REQUIRED by WORK-074's own
   proof 15; WORK-072's fuller discrimination suite remains that Work Order's
   scope. `provision-key.ts` carries an explicit DEVELOPMENT-ONLY banner.
7. **Audit** — identity.login/logout, service-account creation, key
   issuance/revocation, membership assignment/removal are recorded through the
   EXISTING /audit surface (invariant #12).

Migration `0059_identity_runtime` (the identity/session/machine-identity
schema); the self-host head pin and the static-architecture baseline pins
advance to 59 / 34 route files with credit comments. Verification on the
branch: WORK-074 suites 73/73 (sessions 8, identity-providers 11,
machine-identity 15, routes 18, browser E2E 2, frontend login/auth 19);
static architecture 809/809 (WORK-074 boundary invariants: one authorization
authority, cookie-only sessions, no demo-key login surface, identity files
inside the frozen /auth + /users boundaries, digest-only persistence);
governance suites clean; full backend regression clean; backend + frontend
typecheck/lint clean (pre-existing warnings untouched). Browser evidence: a
fresh-context Playwright journey (honest login surface → email sign-up →
authenticated shell WITHOUT reload → reload persistence → logout →
protected-route rejection) plus a manual agent-browser pass (desktop + mobile)
on the live topology. NOT in this change: WORK-071/072/073, SSO/SAML (a
recorded future extension), and the dogfooding run itself (the gate also
requires WORK-071).

**Security remediation (architect review of PR #99 — login-CSRF):** the
original OAuth state proved single-use but did NOT bind the authorization
request to the initiating browser — an attacker could obtain a valid state and
have a victim's browser present the callback (OAuth login-CSRF / session
swapping). Remediation: `/auth/oauth/:provider/start` now mints (or reuses) a
cryptographically random pre-auth transaction cookie (`wfos_oauth_tx`,
HttpOnly, SameSite=Lax, Secure in production, Max-Age locked to the state TTL)
and the state row stores its SHA-256 DIGEST (`transaction_digest`); the
callback REQUIRES the presenting browser to carry the SAME transaction value
and the consume checks state + provider + binding + expiry in ONE atomic
single-use DELETE, BEFORE any provider assertion is accepted — a state minted
for browser A is rejected when presented by browser B (no session, no user
row; an unmatched attempt leaves A's transaction intact for A to complete).
Regression discriminations added: cross-browser (no cookie / foreign cookie)
rejection with no session and no identity resolution, the honest same-browser
success, replay-with-correct-binding rejection, cookie attribute + one-time
value checks, and digest-only persistence (the raw transaction value appears
in no `wfos_*` column). A static-architecture invariant pins the boundary
(binding checked before exchange, atomic digest-bound consume, cookie
discipline, TTL agreement).

> **Canonical identity and the WORK-063-RUNTIME alias.** WORK-074 is the
> canonical numeric identity for this Work Order, per the repository's
> identity-surface invariant (the 2026-08-29 architect verdict, enforced in
> `backend/src/architecture-checkpoints/internal/governance-validation.ts`:
> authoritative Work Order identities match `^WORK-\d{3}$` and live as
> `spec/work-orders/WORK-NNN.md`). In the dogfooding experiment's design
> (`spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`,
> finding F-1), this Work Order is referred to by the logical label
> **"WORK-063-RUNTIME"** — the runtime activation of WORK-063's spec. The
> canonical ID is `WORK-074`; the logical alias is `WORK-063-RUNTIME`. A fresh
> Architect LLM encountering either name resolves it to this file. The numeric
> ID was chosen (rather than reusing the `WORK-063-RUNTIME` string as a
> filename) precisely because the repo's identity surface is closed to strict
> `WORK-NNN` identities, and this Work Order does NOT rewrite that invariant.

Issued by: the 2026-08-30 customer dogfooding experiment's governed follow-up
(the dogfooding evidence artifact
`spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`,
finding F-1 — the "WORK-063-RUNTIME" of the experiment's design). This Work
Order is the RUNTIME ACTIVATION of the identity-and-access architecture
decision that WORK-063 already merged as SPEC-ONLY. It establishes the
implementation Work Order for the runtime identity layer — it does NOT
re-decide the architecture (WORK-063 is the architecture authority for the
identity model; this Work Order implements it). Activation requires the
architect's authorization and is recorded in
`spec/development-state/program-state.json` (this change records none).

Dependencies: WORK-063 (Identity and Access Layer — the SPEC: merged by the
architect as `8dac9c4` via PR #81 on 2026-08-30, spec-only, finalized
§34.8/ADR-0007; this Work Order implements what that spec specifies). The
frozen identity foundation the runtime extends — WORK-002 (Identity,
organizations, permissions, tenant isolation) — and the Workbench whose
bootstrap demo-key login this retires — WORK-048 (Developer Workbench) — are
transitive through WORK-063 (both already complete).

Downstream: the dogfooding gate
(`spec/architecture/v1.1/dogfooding-model.md` §8, updated in this change) —
the canonical first full dogfooding journey now requires this Work Order
complete AND WORK-071 complete (or an equivalent supported runtime
environment). WORK-061 (Self-Hosting Conformance and Continuous Governance)
depends on the runtime identity layer this Work Order implements (the
customer-facing self-hosting experience begins with a human signing in and ends
with an authorized agent running governed work — neither is possible on a
shared demo key). The authenticated ValidationJourneys of WORK-064 (Continuous
Product Validation) exercise the runtime identity layer this Work Order
provides.

## Objective

Implement and activate the production Identity & Access runtime that WORK-063
specified: Google authentication, GitHub authentication, email/password or
passwordless email login; server-side session management; organization
onboarding and membership/role enforcement; server-authoritative project
authorization; scoped machine identity (service accounts with capability-scoped
API credentials); and the removal of the demo-key login as the customer-facing
bootstrap — WITHOUT becoming another workflow or business authority of any
kind, WITHOUT a second authorization engine, WITHOUT client-side authorization,
and WITHOUT agents impersonating humans.

WORK-063 is the SPEC (the architecture decision — the identity model, the
layer-to-module mapping, the explicit prohibitions, the required invariants,
the required proofs). WORK-074 (the "WORK-063-RUNTIME" of the dogfooding
experiment) is the RUNTIME: the authentication code, the provider adapters,
the session lifecycle, the service-account issuance, the Workbench migration
off the demo key, and the required proofs on real PostgreSQL. The repository
already records this separation explicitly: WORK-063.md states "the runtime
implementation remains future work under the architect's separate
authorization." This Work Order IS that separate, architect-gated runtime
implementation.

## Why this is a distinct Work Order (the spec/runtime separation)

The repository's identity model confirms that spec/runtime separation is
required:

- WORK-063 was issued and merged as the architecture decision (the SPEC-ONLY
  delivery: the identity-and-access architecture decision, the Work Order,
  and the dependency-model correction). Its `Definition of done` explicitly
  distinguishes the merged governance decision from the future runtime
  implementation: "The obligations above are the Definition of Done of the
  FUTURE RUNTIME IMPLEMENTATION of this Work Order — the proof contract the
  architect will hold that implementation to. The merged PR #81 delivery … is
  complete as the governance decision it was issued as; the runtime
  implementation remains future work under the architect's separate
  authorization."
- WORK-063.md's `Post-merge finalization record` records: "The delivery
  merged by PR #81 is SPEC-ONLY: … NO runtime implementation rode the merge —
  no authentication code, no OAuth/OIDC or email provider adapters, no service
  accounts, no session lifecycle, no Workbench login changes, and no removal
  of the demo key from the runtime; the required proofs above remain the
  obligations of the future runtime implementation (architect-gated)."
- `spec/development-state/frontier-state.json` records: "The runtime identity
  layer specified by WORK-063 remains UNIMPLEMENTED (the architect-gated
  runtime activation is WORK-074, PLANNED); dogfooding was ATTEMPTED on
  2026-08-30 and STOPPED at onboarding."
- The dogfooding experiment (2026-08-30) confirmed empirically: the LoginPage
  exposes ONLY an API-key input; there is NO Google/GitHub/email login surface;
  the runtime identity layer is UNIMPLEMENTED (finding F-1).

Because WORK-063's completion record is explicitly SPEC-ONLY and the runtime
implementation is explicitly deferred to "the architect's separate
authorization," creating WORK-074 (the "WORK-063-RUNTIME") as the distinct
implementation Work Order is the faithful representation of the repository's
own separation. It does NOT duplicate WORK-063's identity — `WORK-074` is a
distinct numeric identity from `WORK-063` (no identity collision; the
work-order-identity check passes: `^WORK-\d{3}$`). It does NOT re-decide the
architecture — WORK-063 remains the architecture authority for the identity
model; this Work Order implements it.

## The four layers this Work Order activates (mapped to the existing authority)

This Work Order explicitly distinguishes the four concerns WORK-063 separated,
and maps each to the existing repository authority:

```text
authentication
  → WHO are you? (a human login or a machine credential — producing an
    AuthenticatedPrincipal).
  → existing authority: backend/src/modules/auth/ (the AuthProvider boundary
    and the ApiKeyAuthProvider; this Work Order ADDS the OAuth/OIDC and email
    provider adapters behind the SAME boundary — a new provider is a new
    adapter, never a new authority).

identity / session
  → the resolved WorkflowOS user (deterministic externalId → wfos_users,
    AUTH-AC-01 generalized to OIDC subjects); the server-side, authoritative,
    revocable session.
  → existing authority: backend/src/modules/users/ (users, linked identities)
    and backend/src/modules/auth/ (sessions). PostgreSQL remains
    authoritative for identity and session state.

authorization
  → WHAT are you allowed to do to this project? (a server-side decision on
    membership + role/capabilities + project access — NEVER client-side).
  → existing authority: backend/src/modules/auth/AuthorizationService (the
    decision chain: user → organization membership → role/permission →
    project access, with tenant isolation enforced server-side,
    AUTHZ-AC-01..03). This Work Order wires real human principals and scoped
    machine principals INTO that existing chain; it does NOT add a parallel
    authorization mechanism.

machine identity
  → a service account is a first-class principal (NOT a user): a service
    identity belongs to an organization and holds an explicit capability set;
    API credentials are scoped; authorization decisions for machine
    principals flow through the SAME server-side AuthorizationService path
    (capability → permission mapping).
  → existing authority: backend/src/modules/auth/ (the ApiKeyCredentialProvisioner
    and the wfos_api_key_credentials mechanism; this Work Order EXTENDS it
    with scopes — never removes it).
```

The runtime activation maps each concern onto the EXISTING frozen module
boundaries (`/auth`, `/users`, `/organizations`, `/projects`). Any
implementation step that would require changing a frozen module boundary goes
through the architecture governance path (checkpoint/ACR), never silent
boundary drift.

## Explicit prohibitions

WORK-074 must NEVER become:

- a **second workflow or business authority** — identity answers "who are you",
  authorization answers "what may you do to this project"; neither redefines
  Work Item/workflow/execution/verification/review semantics;
- an **"OAuth-only" replacement of machine credentials** — human identity AND
  machine identity are BOTH first-class; an implementation that removes API
  keys/service accounts to "simplify" violates this Work Order (and
  WORK-063's invariant #10);
- a **client-side authorization mechanism** — every authorization decision
  remains server-side and authoritative (AUTHZ-AC-01..03); the browser never
  decides whether a user is authorized (the existing WORK-022 invariant);
- a **second tenant-isolation model** — org/project scoping stays
  server-authoritative through the existing decision chain (AUTHZ-AC-02
  unchanged and unweakened);
- a **credential store outside the SecretStore boundary** — raw keys, session
  secrets, and provider tokens never persist in domain/workflow records
  (digests and opaque references only, SEC-AC-01/02);
- an **agent-impersonates-human path** — an implementation agent NEVER
  pretends to be a human; it presents a scoped machine credential bound to a
  service identity inside an organization;
- a **second identity authority** — external identity providers are
  authoritative only for THEIR authentication assertion, never for WorkflowOS
  authorization; PostgreSQL remains authoritative for identity, membership,
  and authorization state.

## Required invariants (the runtime must prove these hold)

These are the invariants WORK-063 specified (the SPEC's `Required invariants`
#1–#15); this Work Order's runtime implementation must prove each holds with
objective evidence. They are restated here only by reference to avoid
duplication — see `spec/work-orders/WORK-063.md` `Required invariants`. The
runtime implementation must satisfy:

1. Authentication and authorization remain separated.
2. A human identity resolves deterministically to exactly one WorkflowOS user
   per provider subject.
3. A machine principal is never a human user.
4. No login path bypasses authorization.
5. Sessions are server-side authoritative and revocable.
6. Scoped credentials fail closed.
7. Capability separation holds.
8. Tenant isolation is unchanged and unweakened.
9. The Workbench no longer depends on the demo key.
10. API keys remain available for automation.
11. Raw credentials never persist in domain/workflow records.
12. Identity operations are audit-covered.
13. The identity layer introduces NO new workflow, delegation, execution, or
    verification authority.
14. PostgreSQL remains authoritative for identity, membership, and
    authorization state.
15. The layer is expressible within the existing frozen module boundaries.

## Required proof (verification obligations of this Work Order's implementation)

The runtime implementation must prove, with objective evidence (these are the
proofs WORK-063 specified as the future runtime's obligations — see
`spec/work-orders/WORK-063.md` `Required proof`; restated by reference to
avoid duplication):

1. human login end-to-end — a real Google and GitHub OAuth/OIDC login produces
   an authenticated session and a resolved WorkflowOS user; re-login resolves
   the SAME user;
2. email login — a real email/password or passwordless email login produces an
   authenticated session and a resolved WorkflowOS user;
3. identity linking — the same user with multiple linked provider identities
   resolves to one user;
4. session lifecycle — create/verify/revoke; a revoked session is rejected
   (discrimination-proven against the unrevoked behavior);
5. authorization chain — a human user's access follows user → membership →
   role/permission → project access on real routes (allowed AND denied cases);
6. tenant isolation under login — an authenticated member of Org A cannot
   access Org B's project even with a planted cross-tenant access row
   (AUTHZ-AC-02 discrimination);
7. machine principal scoping — a scoped service-account credential CAN
   exercise its granted capabilities and CANNOT exercise ungranted ones
   (typed denials; mutation-proven: removing the scope check makes the test
   fail);
8. privilege separation — the implementation-agent capability set cannot
   modify architecture, approve its own PR, alter verification evidence, or
   change tenant (each attempted violation fails closed);
9. API-key automation path — existing API-key authentication keeps working
   through the same authorization chain after the change (no regression);
10. demo-key removal — the Workbench functions with real login and the
    production path no longer accepts or depends on the demo key;
11. credential safety — raw key/session/provider-token material never appears
    in database records or logs (digest/reference only;
    discrimination-proven);
12. audit coverage — login, credential issuance/revocation, and
    membership/role-change events are recorded on the audit surface;
13. static architecture invariants — the module-boundary and
    no-second-authority matrix passes with the identity layer in place;
14. real-PostgreSQL, mutation/discrimination tests — the authorization and
    scoping claims are proven on real PostgreSQL with independent connections,
    and the invariants are discriminating: removing a scope check, the
    membership requirement, or the session-revocation check makes the
    corresponding test FAIL;
15. the dogfooding gate's authentication precondition — a fresh-browser
    normal sign-in (Google/GitHub/email) produces an authenticated session
    synchronously observable by the application shell, with NO manual reload
    and NO demo key (the empirical proof that finding F-1 is resolved).

## Scope

Allowed: the OAuth/OIDC (Google, GitHub) and email provider adapters behind
the existing `AuthProvider` boundary; the session lifecycle (server-side,
authoritative, revocable); identity linking on `/users`; service accounts and
scoped API credentials on `/auth`; the capability → permission mapping through
the existing `AuthorizationService`; organization/membership management
surfaces; project-authorization wiring; the Workbench login UX migration off
the demo key (the human login surface, the organization/project context, the
credential management UI); the required proofs above on real PostgreSQL.

Forbidden: everything in "Explicit prohibitions"; SSO/SAML (a recorded future
extension, out of scope); changing WORK-046/WORK-047 semantics; GitHub
merge/CI authority; changing the frozen v1.0 architecture version; re-deciding
the identity model (WORK-063 is the architecture authority — this Work Order
implements, it does not re-architect); introducing a second identity/session/
authorization/machine-identity authority.

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - backend/src/modules/auth/
      - backend/src/modules/users/
      - backend/src/modules/organizations/
      - frontend/src/pages/LoginPage.tsx
      - frontend/src/hooks/useAuth.ts
      - frontend/src/App.tsx
      - spec/architecture/v1.1/dogfooding-model.md
      - spec/architecture/v1.1/dogfooding-evidence/
    reason: the identity/auth surface — concurrent authors must coordinate on
      the shared auth/provider/session/login surface (one canonical identity
      runtime, one login UX). WORK-072 (Authentication State Synchronization)
      CONFLICTS on frontend/src/pages/LoginPage.tsx and
      frontend/src/hooks/useAuth.ts and frontend/src/App.tsx — if both are
      active, coordinate (the natural sequencing is WORK-074 first,
      then WORK-072; or WORK-072 first to establish the canonical auth-state
      source this runtime's login UX will also use).
  - migrations:
      - wfos_users (linked identities)
      - wfos_sessions (server-side sessions)
      - wfos_service_accounts
      - wfos_api_key_credentials (scopes extension)
      - wfos_organization_memberships (if extended)
    reason: schema migrations for the identity/session/service-account tables
      — concurrent Work Orders touching the same migrations must coordinate.
  - authorities:
      - /auth          # the identity/session/authorization authority
      - /users         # users, linked identities
      - /organizations # memberships, roles
    reason: this Work Order IMPLEMENTS the /auth, /users, /organizations
      authority's runtime; it must not duplicate it. No other Work Order
      authors these authorities concurrently.
  - dependencies:
      - WORK-063   # complete — the spec this implements (merged 8dac9c4, spec-only, finalized §34.8/ADR-0007)
    reason: the dependency surface itself; WORK-063 is the load-bearing spec.
protectedSurfaces:
  - backend/src/modules/auth/
  - backend/src/modules/users/
  - backend/src/modules/organizations/
  - backend/src/platform/secrets/
  - frontend/src/pages/LoginPage.tsx
  - frontend/src/hooks/useAuth.ts
  - frontend/src/App.tsx
  - spec/work-orders/WORK-074.md
  - spec/architecture/v1.1/dogfooding-model.md
  - spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md
```

An Architect LLM may mechanically determine the state of WORK-074 as: `READY`
(WORK-063 is complete — merged as `8dac9c4`, spec-only, finalized
§34.8/ADR-0007 — so the spec dependency is satisfied; the runtime
implementation is dependency-eligible immediately); `BLOCKED` if WORK-063 were
incomplete (it is not); `PARALLEL-SAFE` with WORK-071 (different protected
surfaces: the identity/auth runtime vs the platform/runtime substrate);
`PARALLEL-SAFE` with WORK-073 (different protected surfaces: the auth/login
surface vs the ProjectListPage); `CONFLICTING` with WORK-072 (shared
LoginPage/useAuth/App.tsx surface — coordinate, or sequence WORK-074
before/after WORK-072).

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second workflow, business, or identity authority;
- client-side authorization decisions;
- storing raw credentials outside the SecretStore discipline;
- removing API keys or service accounts (an "OAuth-only" simplification);
- weakening tenant isolation;
- changing frozen module boundaries outside the architecture governance path;
- an external identity provider becoming an authorization authority;
- an agent impersonating a human;
- re-deciding the identity model (WORK-063 is the architecture authority —
  if the spec is wrong, the fix is an ACR against WORK-063, not a silent
  rewrite by this Work Order).

## Definition of done

- All required invariants (WORK-063's #1–#15) hold with objective evidence (the
  required proofs above, on real PostgreSQL, with mutation/discrimination
  tests).
- Static architecture invariants for the authority-boundary claims pass
  (including the no-second-authority matrix and the frozen-boundary
  discipline).
- The Workbench no longer depends on the demo key; API keys remain available
  for automation; Google/GitHub/email login works end-to-end.
- The dogfooding gate's authentication precondition is empirically satisfied
  (fresh-browser normal sign-in → authenticated session synchronously
  observable, no manual reload, no demo key).
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-074 scope; independent Architect Review approves; the
  implementation PR is merged; WORK-074 is marked VERIFIED before the
  dogfooding gate is satisfied on it.

  (These obligations are the Definition of Done of the RUNTIME IMPLEMENTATION
  of WORK-063's spec — the "WORK-063-RUNTIME" of the dogfooding experiment's
  design. WORK-063's own Definition of Done — the spec delivery — is already
  complete. This Work Order's Definition of Done is satisfied only when the
  runtime is implemented, proven, and merged.)
