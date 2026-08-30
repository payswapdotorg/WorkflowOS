# WORK-073 — Create Project Organization Selection

Status: planned.

Issued by: the 2026-08-30 customer dogfooding experiment's governed follow-up
(the dogfooding evidence artifact
`spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`,
finding F-4). This Work Order fixes the Create Project organization-selection
defect observed in the current frontend. It does NOT redesign organization
authorization — it exposes the valid organization selection/input path using
the EXISTING organizations authority. Activation requires the architect's
authorization and is recorded in `spec/development-state/program-state.json`
(this change records none).

Dependencies: none (hard). The defect exists in the current code
(`frontend/src/pages/ProjectListPage.tsx` `CreateProjectForm`) and the fix is
frontend-only. It uses the EXISTING organizations authority
(`organizations.listForUser()` — already complete, WORK-002) and the EXISTING
projects authority (`projects.create()` — already complete, WORK-004). It
does NOT require the runtime identity layer (WORK-074). It does NOT
depend on WORK-072 (different protected surfaces: ProjectListPage vs
LoginPage/useAuth).

Downstream: none directly. The fix removes a P2 UX defect that blocks project
creation entirely when no organizations are loaded (a dead-end with no
in-UI workaround).

## Objective

Fix the Create Project UI so it exposes the valid organization selection/input
path: when organizations are loaded, the user selects one through the existing
organizations authority; when no organizations are loaded OR the organization
authority is unavailable, the UI produces an EXPLICIT error (no fabricated
empty state) and exposes the valid path forward (create an organization first,
or enter an org ID if the product supports that path).

The fix uses the existing organizations authority and preserves tenant
isolation. The frontend NEVER invents organization membership — the backend's
`AuthorizationService` decision chain (user → membership → role → project
access, AUTHZ-AC-02) remains the ONE authority. The fix only changes how the
UI presents the organizations the backend authoritatively returns.

## Why this is a Work Order (the verified defect)

The dogfooding experiment (finding F-4) and the independent code verification
on this branch confirm the defect precisely:

- `frontend/src/pages/ProjectListPage.tsx:121-128` —
  `organizations.listForUser().then((orgs) => { setOrgList(orgs); ... })
  .catch(() => {})` — the `.catch(() => {})` SILENTLY swallows any failure
  (no `setError`, no explicit error UI). When the organization authority is
  unavailable (401, network, or the database not reachable), the UI shows the
  SAME "No organizations available" text as if the user genuinely had no
  organizations — a fabricated empty state (the very class of provenance
  defect F-5 records as correctly avoided elsewhere).
- `frontend/src/pages/ProjectListPage.tsx:153-167` — the render branch:
  `orgList.length > 0` renders a `<select>` for organization selection (good);
  ELSE renders `<p>No organizations available. Enter an org ID manually.</p>`
  with NO input field for an org ID. The text tells the user to "Enter an org
  ID manually" but exposes NO org-ID input — a dead end.
- `frontend/src/pages/ProjectListPage.tsx:130-135` — `handleSubmit` validates
  `if (!name.trim() || !selectedOrg) setError('Project name and organization
  are required')` — with no org and no org input, the form is a dead end; the
  user can NEVER create a project through the UI in this state.

The user experiences a Create Project form that tells them to do something
impossible (enter an org ID with no input field) and then rejects the
submission — a P2 UX defect with NO in-UI workaround (the only workaround is
out-of-band org creation).

## The fix (expose the valid organization selection/input path)

The fix exposes the valid organization selection path using the EXISTING
organizations authority and produces explicit errors when the authority is
unavailable:

- when `organizations.listForUser()` returns organizations: the user
  selects one through the existing `<select>` (unchanged);
- when `organizations.listForUser()` returns an empty list (the user genuinely
  has no organizations): the UI shows an explicit, actionable state
  ("You have no organizations. Create an organization first.") with a link/
  button to the organization-creation path (NOT a dead-end "enter an org ID
  manually" with no input);
- when `organizations.listForUser()` FAILS (the organization authority is
  unavailable — 401, 403, network, or the database not reachable): the UI
  produces an EXPLICIT error (the `ErrorState` component with the failure
  message), NOT a fabricated "No organizations available" empty state. The
  `.catch(() => {})` is REPLACED with an explicit `setError` so the failure
  is surfaced (the Workbench provenance discipline F-5 confirms is correct
  — applied here);
- IF the product supports an org-ID input path (e.g., for joining an
  existing org by ID): the UI exposes the org-ID input field that the current
  text claims but does not provide. IF the product does NOT support that
  path, the text is removed (do not tell the user to do something the product
  does not support).

The fix preserves tenant isolation: the backend's `AuthorizationService`
decision chain remains the ONE authority. The frontend NEVER invents
organization membership — it only presents the organizations the backend
authoritatively returns, and routes the user to the backend-authoritative
organization-creation path when none exist.

## Explicit prohibitions

WORK-073 must NEVER become:

- a **frontend organization-membership authority** — the frontend NEVER
  decides organization membership; it only presents the organizations the
  backend returns. The backend's `AuthorizationService` (AUTHZ-AC-01..03)
  remains the ONE authority;
- a **fabricated empty state** — the `.catch(() => {})` silent-swallow is
  REPLACED with an explicit error; an authority failure is NEVER converted
  into a "no organizations" empty state (the Workbench provenance discipline,
  confirmed working by F-5, applied here);
- a **redesign of organization authorization** — the fix uses the EXISTING
  `organizations.listForUser()` and `projects.create()` authorities; it does
  NOT add a new organization/project authority or a new membership model;
- a **dead-end UI** — the fix exposes a valid path forward in every state
  (organizations loaded → select; none → create one; authority failure →
  explicit error + retry).

## Required invariants

1. The Create Project form exposes a valid organization selection path in
   every state (no dead ends).
2. When organizations are loaded, the user selects one through the existing
   `<select>` using the existing `organizations.listForUser()` authority.
3. When no organizations are loaded (genuine empty list), the UI shows an
   explicit, actionable state with a link/button to the organization-creation
   path — NOT a dead-end "enter an org ID manually" with no input.
4. When the organization authority is unavailable (failure), the UI produces
   an EXPLICIT error (the `ErrorState` component) — NOT a fabricated "no
   organizations" empty state. The `.catch(() => {})` is REPLACED with an
   explicit `setError`.
5. The frontend NEVER invents organization membership; the backend's
   `AuthorizationService` decision chain (AUTHZ-AC-01..03) remains the ONE
   authority.
6. Tenant isolation is preserved: a project is created only against an
   organization the authenticated user is a member of (the backend enforces
   this; the frontend only presents valid orgs).

## Required proof

The implementation must prove, with objective evidence:

1. **organizations loaded → select** — when `organizations.listForUser()`
   returns organizations, the user selects one and creates a project (the
   existing happy path holds; no regression);
2. **no organizations → actionable state** — when the list is genuinely
   empty, the UI shows an explicit state with a path to create an
   organization (NOT a dead end);
3. **authority failure → explicit error** — when
   `organizations.listForUser()` rejects, the UI shows the `ErrorState`
   component with the failure message (NOT the empty state). Mutation-proven:
   removing the explicit `setError` (reverting to `.catch(() => {})`) makes
   the test FAIL (the silent-swallow is discriminating against the explicit-
   error path);
4. **no fabricated empty state** — an authority failure is NEVER recorded as
   "no organizations" (the Workbench provenance discipline; mutation-proven);
5. **no frontend membership invention** — the frontend only ever submits an
   `organizationId` that the backend returned in `organizations.listForUser()`
   (or, if an org-ID input is supported, the backend still enforces
   membership — a planted cross-tenant org ID is rejected by the backend's
   AUTHZ-AC-02);
6. **tenant isolation preserved** — creating a project against an org the
   user is NOT a member of is rejected by the backend (the existing
   invariant; no regression).

## Scope

Allowed: the `CreateProjectForm` refactor to expose the valid organization
selection/input path; the replacement of the `.catch(() => {})` silent-swallow
with an explicit `setError` + `ErrorState`; the actionable empty-list state
with a path to organization creation; the required proofs above. Frontend-only
changes if that is sufficient.

Forbidden: redesigning organization authorization; adding a new organization
or project authority; inventing organization membership on the frontend;
changing the backend `AuthorizationService`; changing the WORK-022 invariant;
changing the frozen v1.0 architecture version; implementing the runtime
identity layer (WORK-074's scope).

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - frontend/src/pages/ProjectListPage.tsx   # the CreateProjectForm
      - frontend/src/components/domain/error-state.ts   # if extended
      - frontend/src/components/domain/empty-state.ts   # if the boundary is clarified
      - spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md
    reason: the project-list/create-project frontend surface — concurrent
      authors must coordinate on the CreateProjectForm. No other planned Work
      Order authors this surface (WORK-074 is the auth surface;
      WORK-072 is the LoginPage/useAuth/App surface; WORK-071 is the backend
      composition root).
  - migrations: []
    # no schema migration in this Work Order — the fix is frontend-only.
  - authorities: []
    # the fix introduces NO new authority; it uses the existing
    # organizations.listForUser() and projects.create() authorities. The
    # backend /organizations and /projects authorities are unchanged.
  - dependencies: []
    # no hard dependencies — the defect exists in the current code and the
    # fix uses the existing (complete) organizations and projects authorities.
    reason: the fix does not require the runtime identity layer
      (WORK-074); it uses the existing v1.0 organizations/projects
      authorities (WORK-002, WORK-004 — both complete).
protectedSurfaces:
  - frontend/src/pages/ProjectListPage.tsx
  - spec/work-orders/WORK-073.md
  - spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md
```

An Architect LLM may mechanically determine the state of WORK-073 as: `READY`
(no hard dependencies — the defect exists in the current code and the fix uses
existing complete authorities); `BLOCKED` by nothing; `PARALLEL-SAFE` with
WORK-071 (different protected surfaces: the frontend ProjectListPage vs the
backend composition root), with WORK-074 (different protected
surfaces: the frontend ProjectListPage vs the auth/login surface), and with
WORK-072 (different protected surfaces: the ProjectListPage CreateProjectForm
vs the LoginPage/useAuth/App surface — the user's explicit example of safe
parallelism); `CONFLICTING` with any future Work Order that authors the
ProjectListPage CreateProjectForm.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a frontend organization-membership authority;
- a new organization or project authority;
- a fabricated empty state on authority failure;
- changing the backend `AuthorizationService` or the AUTHZ-AC-01..03
  invariants;
- changing the WORK-022 invariant;
- changing the frozen v1.0 architecture version;
- implementing the runtime identity layer (that is WORK-074's scope —
  if the fix cannot be done frontend-only against the existing authorities,
  STOP and reconsider whether the defect is actually a runtime-side concern).

## Definition of done

- The `CreateProjectForm` exposes a valid organization selection/input path
  in every state (no dead ends).
- The `.catch(() => {})` silent-swallow is REPLACED with an explicit
  `setError` + `ErrorState`; an authority failure is NEVER converted into a
  fabricated empty state.
- The actionable empty-list state has a path to organization creation.
- All required invariants hold with objective evidence (the mutation/
  discrimination tests above — especially the authority-failure → explicit-
  error path, mutation-proven).
- The frontend NEVER invents organization membership; tenant isolation is
  preserved (the backend's AUTHZ-AC-02 enforces it; no regression).
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-073 scope; independent Architect Review approves; the
  implementation PR is merged; WORK-073 is marked VERIFIED.

  (This Work Order does NOT by itself satisfy the dogfooding gate — the gate
  requires WORK-074 complete AND WORK-071 complete. WORK-073 is an
  independent frontend fix that may be done in parallel with WORK-072 and
  with the dogfooding-gate enablers; it removes a P2 UX defect that blocks
  project creation when no organizations are loaded.)
