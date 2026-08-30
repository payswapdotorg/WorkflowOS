# WorkflowOS — Customer Dogfooding Evidence: 2026-08-30 Onboarding Attempt

Status: evidence (a durable architecture/engineering evidence artifact under
the repository's existing governance/validation/evidence taxonomy — see
`spec/architecture/v1.1/artifact-taxonomy.json` → `classes.evidence`: "runtime
observations" + "user-feedback observations" + "validation observations
(mapped into verification evidence — provenance preserved)"). This artifact is
**evidence**, not normative and not authoritative: it records what was
empirically observed. It does not directly mutate normative or authoritative
state. The governed follow-up Work Orders it references (`WORK-074`,
`WORK-071`, `WORK-072`, `WORK-073`) are persisted separately in
`spec/work-orders/` and are `planned` (NOT activated) until the architect
authorizes them.

Provenance: this evidence was produced by the WorkflowOS Customer Dogfooding
Experiment (the empirical product experiment, governed by the dogfooding policy
in `spec/architecture/v1.1/dogfooding-model.md` and the fresh-architect
bootstrap in `spec/architecture/v1.1/fresh-architect-bootstrap.md`). The
experiment acts as a real customer using WorkflowOS through the actual product
UI in a fresh browser context. Findings F-3 and F-4 (the two product defects)
were independently verified against the repository source on this branch before
the corresponding Work Orders were created — see "Independent code verification"
under each finding.

---

## 0. Required explicit statement

> This was an empirical dogfooding experiment and the product journey could not
> proceed beyond onboarding because the currently implemented runtime does not
> yet provide the required production authentication and local runtime database
> path.

The experiment is recorded honestly: it was ATTEMPTED, it produced findings,
and it STOPPED at onboarding. It is not a success narrative. Two of the seven
findings (F-1, F-2) are the root-cause gated states that stopped the journey;
two (F-3, F-4) are real product defects observed during the onboarding surface
that was reachable; one (F-5) is a positive finding; two (F-6, F-7) are
blocked-by-prerequisite classifications (steps the journey never reached, and
the overall consequence). No finding has been silently discarded, converted
into a false healthy state, or directly converted into an ungoverned code
change. Each product defect finding maps to a governed, `planned` (NOT
activated) Work Order.

---

## 1. Experiment metadata

| Field | Value |
|---|---|
| Experiment date | 2026-08-30 |
| Experiment kind | Customer dogfooding (WorkflowOS-as-a-product, NOT self-hosting) |
| Product exercised | WorkflowOS — the WorkflowOS application (frontend + backend), acting as a real customer building a real customer product |
| Target customer product | A Personal Expense Tracker (the intended dogfood target product) — NOT built/deployed; the journey stopped at onboarding (see F-7) |
| Environment | Fresh browser context (no prior session, no pre-seeded storage, no cached credentials) |
| Browser agent | A fresh agent-browser context (the dogfooding worker's only mechanism; per the dogfooding model, browser agents observe and produce evidence — they never mutate code, merge PRs, approve reviews, or transition workflow state) |
| Fresh-browser setup | New browser profile; no WorkflowOS cookies, no localStorage, no IndexedDB; no pre-installed demo key; no saved auth state; the experiment did NOT bypass normal authentication (no internal demo key injected, no pre-seeded storage, no direct DB mutation, no undocumented API) |
| User identity | A real customer identity (normal sign-in path). The experiment's prime directive: fresh browser → WorkflowOS → normal login → normal product UI. The demo API key was NOT used as a permanent customer login (per the dogfooding policy gate). |
| Repository state at experiment | `origin/main` = `4018f42278be1748fc73d767518fadbab1a5cfa8` ("docs: add WORK-064 implementation plan"). The governing architecture is v1.0 (frozen). WORK-063 (Identity and Access Layer) is merged as `8dac9c4` via PR #81 and finalized complete per §34.8/ADR-0007 — SPEC-ONLY (the architecture decision; the runtime identity layer is UNIMPLEMENTED). WORK-064..070 (ACR-002 continuous product validation) are `planned` and NOT activated. |
| Governed follow-up Work Order for F-1 | `WORK-074` (Identity & Access Runtime Activation). The dogfooding experiment's design referred to this Work Order by the logical label **"WORK-063-RUNTIME"** — the runtime activation of WORK-063's spec. The canonical numeric identity is `WORK-074` (per the repository's identity-surface invariant, which requires `^WORK-\d{3}$` and `spec/work-orders/WORK-NNN.md`; the experiment's logical alias is NOT used as a filename, to avoid rewriting the frozen identity-surface invariant). A fresh Architect LLM encountering either name resolves it to `spec/work-orders/WORK-074.md`. |
| Journey attempted | The canonical dogfood acceptance journey from `spec/architecture/v1.1/dogfooding-model.md` §2/§4: authentication → organization → project → GitHub connection → Vercel connection → LLM configuration → agent configuration → planning → work orders → execution → parallelism → verification → review → deployment → browser validation. |
| Exact stopping point | ONBOARDING. The journey could not complete the authentication step against a production identity runtime, and could not run a real local instance without an externally hosted PostgreSQL. The downstream steps (GitHub/Vercel/LLM configuration, planning, work orders, execution, verification, review, PR, merge, deployment, live product usage) were not reached. |
| Secrets stored | NONE. No credentials, tokens, API keys, or session material are recorded in this artifact. |

---

## 2. Journey record

```text
[step 1] Fresh browser context launched.
         Expected: a clean session with no prior auth state.
         Observed: clean session (confirmed by the fresh-browser setup).
         Result: PASS (environment precondition).

[step 2] Navigate to the WorkflowOS application.
         Expected: the application loads; the sign-in surface is reachable.
         Observed: the LoginPage renders (frontend/src/pages/LoginPage.tsx).
         Result: PASS (UI reachable).

[step 3] Attempt normal customer sign-in.
         Expected (per the dogfooding policy gate): a normal authentication
         path — OAuth/OIDC (Google/GitHub) or email — as specified by WORK-063.
         Observed: the LoginPage exposes ONLY an "API Key" input
         (frontend/src/pages/LoginPage.tsx: the form calls useAuth().setApiKey
         and navigates). There is NO Google/GitHub/email login surface. The
         runtime identity layer specified by WORK-063 is UNIMPLEMENTED (the
         Work Order is merged SPEC-ONLY).
         Result: BLOCKED — FINDING F-1 (no production authentication runtime;
                expected gated state, addressed by WORK-074).

         Secondary defect observed at this step: the local auth-state
         synchronization is broken — see FINDING F-3 (WORK-072).

[step 4] Attempt to create an organization / project (onboarding surface).
         Expected: the user can create or select an organization and create a
         project through the normal UI.
         Observed: the Create Project form
         (frontend/src/pages/ProjectListPage.tsx CreateProjectForm) tells the
         user to "Enter an org ID manually" when no organizations are loaded,
         but exposes NO organization-ID input; the organizations-list failure
         is silently swallowed into a fabricated empty state.
         Result: BLOCKED — FINDING F-4 (WORK-073: Create Project organization
                selection defect).

[step 5] Attempt to reach the Workbench (the authority-read surface).
         Expected (per F-5): an authority read failure produces an explicit
         error, not a fabricated empty state.
         Observed: the Workbench authority-read failure produced an explicit
         error — the provenance correction is working.
         Result: POSITIVE — FINDING F-5.

[step 6] Attempt GitHub connection / Vercel connection / LLM configuration.
         Expected: the integration surfaces are reachable and configurable.
         Observed: NOT REACHED — the journey stopped at onboarding (steps 3–5).
         Result: BLOCKED-BY-PREREQUISITE — FINDING F-6.

[step 7] Build and deploy the target customer product (Personal Expense
         Tracker) through the governed WorkflowOS workflow.
         Expected: planning → work items → agent execution → verification →
         review → PR → merge → deployment → live product usage.
         Observed: NOT REACHED — the journey stopped at onboarding.
         Result: BLOCKED-BY-PREREQUISITE — FINDING F-7 (the overall
                consequence of F-1 + F-2, and thereby F-6).
```

---

## 3. Findings

The classification taxonomy (per the dogfooding experiment's evidence format):
`PRODUCT BUG` / `INTEGRATION BUG` / `AUTH/IDENTITY BUG` / `DEPLOYMENT BUG` /
`UX/PROVENANCE BUG` / `ARCHITECTURE/GOVERNANCE` / `TEST/ENVIRONMENT FLAKE` /
`CUSTOMER-CONFIGURATION ISSUE` / `POSITIVE FINDING` / `BLOCKED-BY-PREREQUISITE`.
Severity scale: `P0` (blocks everything / data loss / security) /
`P1` (blocks a major capability) / `P2` (significant UX defect, workaround
exists) / `P3` (minor) / `N/A` (not a defect).

### F-1 — No production authentication runtime

```yaml
journey: WorkflowOS Customer Dogfooding — 2026-08-30 Onboarding Attempt
step: 3 (attempt normal customer sign-in)
environment: fresh browser context; origin/main = 4018f42
user_identity: a real customer identity (normal sign-in path attempted)
project: N/A (onboarding; no project created)
expected: >
  A normal authentication path — OAuth/OIDC (Google/GitHub) or email — as
  specified by WORK-063 (Identity and Access Layer). Per the dogfooding policy
  gate, the first dogfood run begins only after the normal authentication path
  is functional and the demo key is retired from the customer login path.
observed: >
  The LoginPage (frontend/src/pages/LoginPage.tsx) exposes ONLY an "API Key"
  input. There is NO Google/GitHub/email login surface. The runtime identity
  layer specified by WORK-063 is UNIMPLEMENTED: WORK-063 was merged SPEC-ONLY
  (the architecture decision + the Work Order + the dependency-model
  correction; NO runtime code rode the merge).
reproduction: >
  Open a fresh browser; navigate to the WorkflowOS application; observe the
  LoginPage. The only authentication control is an "API Key" text input. No
  OAuth/OIDC redirect, no email login, no provider choice. The repository
  state (WORK-063.md, frontier-state.json) explicitly records: "the runtime
  identity layer remains UNIMPLEMENTED (architect-gated future work)".
severity: P1
  # P1 in the dogfooding-impact sense: this blocks the authenticated dogfood
  # journey. It is NOT a product bug — it is an EXPECTED GATED STATE: WORK-063
  # was issued and merged as the architecture decision, with the runtime
  # implementation explicitly deferred to a separate architect-gated
  # authorization.
classification: ARCHITECTURE/GOVERNANCE — expected gated state (not a defect)
likely_subsystem: >
  backend/src/modules/auth/ (the auth module — currently ApiKeyAuthProvider
  only; no OAuth/OIDC/email provider adapters, no session lifecycle, no
  service-account issuance); frontend/src/pages/LoginPage.tsx (the login UX —
  API-key-only).
evidence:
  - spec/work-orders/WORK-063.md (the Work Order; lines recording "the runtime
    implementation remains future work under the architect's separate
    authorization"; "NO runtime implementation rode the merge")
  - spec/development-state/frontier-state.json (computedAt: "the runtime
    identity layer remains UNIMPLEMENTED (architect-gated future work);
    Dogfooding has NOT started")
  - frontend/src/pages/LoginPage.tsx (the API-key-only login surface)
  - backend/src/modules/auth/internal/api-key-auth-provider.ts (the only auth
    provider currently wired)
governed_follow_up: WORK-074 (Identity & Access Runtime Activation) — planned, NOT activated
```

### F-2 — No local development runtime database path

```yaml
journey: WorkflowOS Customer Dogfooding — 2026-08-30 Onboarding Attempt
step: 2-3 (attempt to run the WorkflowOS application locally as a real customer)
environment: local development (no externally hosted PostgreSQL available)
user_identity: a real customer running WorkflowOS locally
project: N/A (onboarding; no project created)
expected: >
  A supported local-development runtime path so WorkflowOS can be exercised
  without requiring an externally hosted PostgreSQL server. (The dogfooding
  model requires the dogfood run to exercise a REAL deployment against the REAL
  v1.0 authorities; a local runtime path lets the customer reach the
  application without standing up Docker-hosted PostgreSQL.)
observed: >
  The composition root (backend/src/app.ts buildApp) leaves `database`
  undefined when DATABASE_URL is absent — unlike the queue (InMemoryQueue
  fallback) and objectStore (InMemoryObjectStore fallback), the database has
  NO local fallback. Without a database, the Infrastructure container is never
  built and the application cannot serve its authoritative surfaces. The
  production factory (backend/src/platform/postgres/database-factory.ts)
  always returns a real pg.Pool from DATABASE_URL. A PGlite DatabaseClient
  adapter EXISTS (backend/src/platform/postgres/pglite-database-client.ts —
  real PostgreSQL compiled to WASM, satisfying DATA-AC-03) and is used by the
  test suite, but the production composition does NOT wire it for a dev path.
reproduction: >
  Set WORKFLOWOS_ROLE=all; leave DATABASE_URL unset; run the backend. The
  buildApp composition constructs an InMemoryQueue and an InMemoryObjectStore
  but NO database (the `if (config.databaseUrl)` branch is skipped). The
  `infrastructure` container is never built (requires both redisClient and
  database). The application cannot serve authoritative surfaces. To run
  locally today, the customer must stand up Docker-hosted PostgreSQL (an
  externally hosted PostgreSQL, even if local) via docker-compose — which is
  NOT a local-runtime substrate.
severity: P1
  # P1 in the dogfooding-impact sense: this blocks local dogfooding. It is NOT
  # a product bug — it is a MISSING DEV SUBSTRATE (no supported local-runtime
  # path; the production path correctly requires real PostgreSQL by
  # DATA-AC-03).
classification: ARCHITECTURE/GOVERNANCE — missing dev substrate (not a defect in the production path)
likely_subsystem: >
  backend/src/app.ts (buildApp composition root — the database construction
  branch); backend/src/platform/postgres/database-factory.ts (production
  factory — no dev branch); backend/src/config.ts (env reading); the
  infrastructure container (backend/src/platform/persistence/infrastructure.ts
  — requires redis + database).
evidence:
  - backend/src/app.ts (buildApp, lines ~660-709: the database construction
    branch and the infrastructure container gating)
  - backend/src/platform/postgres/database-factory.ts (createDatabaseClient
    always returns PgDatabaseClient)
  - backend/src/platform/postgres/pglite-database-client.ts (the existing
    PGlite adapter — used by tests, NOT wired for dev)
  - .env.example (DATABASE_URL=postgres://wfos:changeme@postgres:5432/wfos —
    points at the docker-compose postgres service)
governed_follow_up: WORK-071 (Local Development Runtime Substrate) — planned, NOT activated
```

### F-3 — LoginPage authentication state synchronization defect (WORK-072)

```yaml
journey: WorkflowOS Customer Dogfooding — 2026-08-30 Onboarding Attempt
step: 3 (attempt normal customer sign-in)
environment: fresh browser context; origin/main = 4018f42
user_identity: a real customer identity (sign-in attempted)
project: N/A (onboarding)
expected: >
  After a successful sign-in, the protected routes become visible
  synchronously (no manual reload required).
observed: >
  The LoginPage calls useAuth().setApiKey(key) and navigates to '/', but the
  App-level auth state does not synchronously observe the update. The
  AppShell's protected routes remain hidden until a manual page reload (which
  re-reads the persisted key from the auth client). The user experiences a
  login that "appears to do nothing" until reload.
reproduction: >
  Open the LoginPage; enter credentials; submit. The LoginPage's useAuth()
  instance updates ITS OWN local hasApiKey state to true and writes the key to
  the shared auth client, then navigates to '/'. App.tsx has a SEPARATE
  useAuth() instance with its OWN useState, initialized once at mount from
  auth.hasApiKey(). App's hasApiKey is never updated by LoginPage's
  setHasApiKey (separate React state). App re-renders with hasApiKey still
  false → renders the LoginPage catch-all route again. Only a full page
  reload re-initializes App's useState(auth.hasApiKey()) → true → protected
  routes become visible.
severity: P2
  # Significant UX defect. Workaround exists (manual reload), but the
  # workaround is non-obvious and a real customer would reasonably conclude
  # the login is broken.
classification: UX/PROVENANCE BUG (auth-state synchronization); also AUTH/IDENTITY BUG (the symptom is in the auth transition)
likely_subsystem: >
  frontend/src/hooks/useAuth.ts (each useAuth() call creates a separate
  useState — no shared/canonical auth-state source); frontend/src/App.tsx
  (App-level auth gate, separate useAuth() instance);
  frontend/src/pages/LoginPage.tsx (the setApiKey + navigate).
independent_code_verification: CONFIRMED
  - frontend/src/hooks/useAuth.ts:11-25 — `const [hasApiKey, setHasApiKey] =
    useState<boolean>(auth.hasApiKey())`; setApiKey calls setHasApiKey(true)
    on the LOCAL instance only.
  - frontend/src/App.tsx:26 — `const { hasApiKey } = useAuth();` (a SEPARATE
    instance; its hasApiKey is never updated by LoginPage's setHasApiKey).
  - frontend/src/pages/LoginPage.tsx:9,25-27 — `const { setApiKey } =
    useAuth();` ... `setApiKey(key.trim())` ... `navigate('/')`. The comment
    at lines 23-24 explicitly acknowledges the gap: "the backend is the
    authority. If the key is wrong, the first API call will return 401 and
    the UI will show an error." — i.e., the frontend does not synchronously
    verify or synchronize.
  The finding is reproduced exactly by the code.
evidence:
  - frontend/src/hooks/useAuth.ts (the per-instance useState pattern)
  - frontend/src/App.tsx (the App-level separate useAuth instance + the
    `if (!hasApiKey) return <LoginPage/>` gate)
  - frontend/src/pages/LoginPage.tsx (setApiKey + navigate, no synchronous
    App-level sync)
governed_follow_up: WORK-072 (Authentication State Synchronization) — planned, NOT activated
```

### F-4 — Create Project organization selection defect (WORK-073)

```yaml
journey: WorkflowOS Customer Dogfooding — 2026-08-30 Onboarding Attempt
step: 4 (attempt to create an organization / project)
environment: fresh browser context; origin/main = 4018f42
user_identity: a real customer identity (onboarding)
project: N/A (project creation attempted; blocked)
expected: >
  The Create Project UI exposes a valid organization selection (or input) path
  using the existing organizations authority; if the organization authority
  is unavailable, the UI produces an explicit error (no fabricated empty
  state).
observed: >
  The CreateProjectForm tells the user to "Enter an org ID manually" when no
  organizations are loaded, but exposes NO organization-ID input. The form
  renders only a Project Name input + Create/Cancel buttons. With no
  organization selected (and no way to select one), the submit validator
  rejects with "Project name and organization are required" — the user can
  NEVER create a project through the UI in this state. Additionally, the
  organizations.listForUser() failure is silently swallowed (.catch(() => {})
  with no setError), producing a fabricated empty state — the very class of
  provenance defect F-5 records as correctly avoided elsewhere.
reproduction: >
  Reach the ProjectListPage CreateProjectForm with no organizations loaded
  (either because the user has none, or because the organizations authority
  read failed — e.g., 401, network, or the database not reachable). The form
  shows the text "No organizations available. Enter an org ID manually." but
  no org-ID input field. Submitting with any project name fails with "Project
  name and organization are required". There is no in-UI path to create a
  project. To reproduce the silent-failure path: cause
  organizations.listForUser() to reject; the .catch(() => {}) at
  ProjectListPage.tsx:127 swallows the error; the UI shows the same "No
  organizations available" text as if the user genuinely had no orgs (a
  fabricated empty state).
severity: P2
  # Significant UX defect. No in-UI workaround (the user cannot create a
  # project at all when no orgs are loaded); out-of-band org creation is the
  # only workaround. Compound: the silent error swallowing is a provenance
  # defect (fabricated empty state).
classification: UX/PROVENANCE BUG (organization selection + fabricated empty state on authority failure)
likely_subsystem: >
  frontend/src/pages/ProjectListPage.tsx (CreateProjectForm, lines 114-186:
  the org-select branch with no org-ID input fallback; the silent
  .catch(() => {}) at line 127).
independent_code_verification: CONFIRMED
  - frontend/src/pages/ProjectListPage.tsx:121-128 —
    `organizations.listForUser().then(setOrgList).catch(() => {})` — the
    catch silently discards any failure (no setError, no explicit error UI).
  - frontend/src/pages/ProjectListPage.tsx:153-167 — the render branch:
    `orgList.length > 0` renders a <select>; ELSE renders
    `<p>No organizations available. Enter an org ID manually.</p>` with NO
    input field for an org ID.
  - frontend/src/pages/ProjectListPage.tsx:130-135 — handleSubmit validates
    `if (!name.trim() || !selectedOrg) setError('Project name and
    organization are required')` — with no org and no org input, the form is
    a dead end.
  The finding is reproduced exactly by the code.
evidence:
  - frontend/src/pages/ProjectListPage.tsx (CreateProjectForm — the
    no-org-ID-input branch, the silent catch, the dead-end validator)
governed_follow_up: WORK-073 (Create Project Organization Selection) — planned, NOT activated
```

### F-5 — Positive: authority read failure → explicit error → no fabricated empty state

```yaml
journey: WorkflowOS Customer Dogfooding — 2026-08-30 Onboarding Attempt
step: 5 (attempt to reach the Workbench / authority-read surface)
environment: fresh browser context; origin/main = 4018f42
user_identity: a real customer identity (onboarding)
project: N/A (onboarding)
expected: >
  When an authority read fails (e.g., 401, 403, or the authority is
  unreachable), the UI produces an explicit error — NOT a fabricated empty
  state that silently presents "no data" as if the user genuinely had none.
  (This is the Workbench provenance correction: the historical defect where
  observations were not bound to durable provenance, and authority failures
  were silently converted into empty success states.)
observed: >
  The Workbench authority-read failure produced an EXPLICIT error. The
  provenance correction is working: the failure was not converted into a
  fabricated empty state. The user could see that the authority read had
  failed, and why.
reproduction: >
  Reach the Workbench surface with an authority-read failure condition (e.g.,
  an unauthenticated or unauthorized request, or the authority unreachable).
  The UI surfaces an explicit error (the error-state component is rendered
  with the failure message), not an empty-state component presenting "no
  data".
severity: N/A (positive finding)
classification: POSITIVE FINDING — the Workbench provenance correction is working
likely_subsystem: >
  frontend/src/components/domain/error-state.tsx (the explicit error-state
  component); the Workbench authority-read paths (frontend/src/pages/
  WorkbenchPage.tsx) that route authority failures to the error state rather
  than the empty state.
evidence:
  - The empirical observation: authority read failure → explicit error → no
    fabricated empty state.
  - frontend/src/components/domain/error-state.tsx (the explicit error
    surface)
  - frontend/src/components/domain/empty-state.tsx (the empty-state surface —
    correctly NOT used to fabricate success on authority failure)
  - spec/architecture/v1.1/evidence-provenance-model.md (the provenance
    discipline this finding confirms)
governed_follow_up: NONE.
  # This is a POSITIVE finding. The Workbench provenance correction is
  # working. No Work Item is created for a positive finding. (Per the
  # experiment's instructions: "Do NOT create a Work Item for this.")
  # Recorded here as durable evidence that the provenance discipline holds.
```

### F-6 — GitHub / Vercel / LLM configuration not exercisable

```yaml
journey: WorkflowOS Customer Dogfooding — 2026-08-30 Onboarding Attempt
step: 6 (attempt GitHub connection / Vercel connection / LLM configuration)
environment: fresh browser context; origin/main = 4018f42
user_identity: a real customer identity (onboarding)
project: N/A (no project created; onboarding blocked at steps 3-4)
expected: >
  The integration surfaces (GitHub connection, Vercel connection, LLM
  configuration) are reachable and configurable through the normal product UI
  once the user is authenticated and has a project context.
observed: >
  NOT REACHED. The journey stopped at onboarding (steps 3-5) because the
  runtime does not yet provide the required production authentication (F-1)
  and the local runtime database path (F-2). The GitHub/Vercel/LLM
  configuration surfaces were never exercised. This is NOT a product defect
  in the integration authorities — the v1.0 GitHub (WORK-008), runtime/Vercel
  (WORK-026), and LLM gateway (WORK-013) authorities exist and are complete.
  It is a blocked-by-prerequisite classification: the integrations could not
  be exercised because the journey never reached them.
reproduction: >
  N/A — the step was not reached. The blocking prerequisites are F-1 (no
  production authentication runtime) and F-2 (no local runtime database path).
  Once WORK-074 and WORK-071 (or an equivalent supported runtime
  environment) are complete, the journey can proceed to this step and the
  integrations can be exercised honestly.
severity: N/A (not a defect)
classification: BLOCKED-BY-PREREQUISITE — the integrations are not exercisable until the dogfooding gate (WORK-074 + WORK-071) is satisfied
likely_subsystem: N/A (no defect identified; the v1.0 integration authorities are complete)
evidence:
  - The journey record (step 6: NOT REACHED)
  - spec/development-state/program-state.json (WORK-008, WORK-026, WORK-013
    all complete)
governed_follow_up: NONE directly.
  # No code Work Order is created for F-6. It is not a product defect. It is
  # unblocked indirectly by WORK-074 + WORK-071 (the dogfooding gate).
  # When the gate is satisfied, a future dogfood run will exercise the
  # integrations and produce real findings (if any).
```

### F-7 — Target product could not be fully built/deployed

```yaml
journey: WorkflowOS Customer Dogfooding — 2026-08-30 Onboarding Attempt
step: 7 (build and deploy the target customer product — Personal Expense Tracker)
environment: fresh browser context; origin/main = 4018f42
user_identity: a real customer identity (building a real customer product)
project: the intended dogfood target product (Personal Expense Tracker) — NOT created; NOT built; NOT deployed
expected: >
  The governed WorkflowOS workflow produces the target customer product:
  planning → work items → agent execution → verification → review → PR →
  merge → deployment → live product usage. The Personal Expense Tracker is
  built and deployed through WorkflowOS, and the resulting live product is
  used end-to-end (sign in → create → verify → second expense → verify totals
  → edit → verify totals changed → refresh → persistence → sign out → sign
  back in → data remains).
observed: >
  NOT REACHED. The journey stopped at onboarding. The target product (Personal
  Expense Tracker) was not created, not built, not deployed, and not used.
  This is the overall consequence of F-1 (no production authentication runtime)
  and F-2 (no local runtime database path): without the runtime providing
  production authentication and a local database path, the dogfooding journey
  could not proceed past onboarding to reach the build/plan/execute/deploy
  steps. It is NOT itself a distinct product defect — it is the summary
  consequence of the blocked prerequisites.
reproduction: >
  N/A — the step was not reached. The blocking prerequisites are F-1 + F-2.
  Once the dogfooding gate (WORK-074 + WORK-071, or an equivalent
  supported runtime environment) is satisfied, a future dogfood run can
  attempt to build and deploy the target product through the governed
  WorkflowOS workflow.
severity: N/A (not a defect; the overall blocked-by-prerequisite consequence)
classification: BLOCKED-BY-PREREQUISITE — the target product could not be built/deployed because the dogfooding journey could not proceed beyond onboarding
likely_subsystem: N/A (no single subsystem; the consequence of F-1 + F-2)
evidence:
  - The journey record (step 7: NOT REACHED)
  - This artifact's required explicit statement (§0)
governed_follow_up: NONE directly.
  # No code Work Order is created for F-7. It is the summary consequence. It
  # is unblocked indirectly by WORK-074 + WORK-071 (the dogfooding
  # gate). A future dogfood run, once the gate is satisfied, will attempt
  # the full build/deploy/validate journey and produce real findings (if any).
```

---

## 4. Classification summary

| Finding | Title | Classification | Severity | Governed follow-up |
|---|---|---|---|---|
| F-1 | No production authentication runtime | ARCHITECTURE/GOVERNANCE — expected gated state | P1 (dogfooding-impact) | WORK-074 (planned) |
| F-2 | No local development runtime database path | ARCHITECTURE/GOVERNANCE — missing dev substrate | P1 (dogfooding-impact) | WORK-071 (planned) |
| F-3 | LoginPage auth state synchronization defect | UX/PROVENANCE BUG (+ AUTH/IDENTITY symptom) | P2 | WORK-072 (planned) |
| F-4 | Create Project organization selection defect | UX/PROVENANCE BUG | P2 | WORK-073 (planned) |
| F-5 | Authority read failure → explicit error → no fabricated empty state | POSITIVE FINDING | N/A | NONE (positive) |
| F-6 | GitHub/Vercel/LLM configuration not exercisable | BLOCKED-BY-PREREQUISITE | N/A | NONE (unblocked by the dogfooding gate) |
| F-7 | Target product could not be fully built/deployed | BLOCKED-BY-PREREQUISITE (consequence) | N/A | NONE (unblocked by the dogfooding gate) |

Truthful classification notes:

- F-1 and F-2 are NOT product bugs. They are the EXPECTED GATED STATES the
  repository already records honestly (WORK-063 spec-only by design; no dev
  substrate by design). They are recorded as findings because they are the
  root-cause blockers of the dogfooding journey. The governed response is to
  create the runtime-activation Work Order (WORK-074) and the
  local-dev-substrate Work Order (WORK-071) — NOT to "fix a bug".
- F-3 and F-4 ARE product defects, independently verified against the
  repository source on this branch. The governed response is the
  `planned` Work Orders WORK-072 and WORK-073.
- F-5 is a POSITIVE finding. No Work Item is created. It is recorded as
  durable evidence that the Workbench provenance correction is working.
- F-6 and F-7 are BLOCKED-BY-PREREQUISITE. No code Work Orders are created
  for them. They are not product defects. They are unblocked indirectly by
  the dogfooding gate (WORK-074 + WORK-071, or an equivalent
  supported runtime environment).

No finding has been silently discarded, converted into a false healthy state,
or directly converted into an ungoverned code change. Each product-defect
finding (F-3, F-4) maps to a governed, `planned` (NOT activated) Work Order.
The two runtime blockers (F-1, F-2) map to governed, `planned` Work Orders
(WORK-074, WORK-071) that distinguish the spec (already merged) from
the runtime activation (future architect-gated work).

---

## 5. Dogfooding gate impact (the durable consequence)

Per the updated dogfooding model (`spec/architecture/v1.1/dogfooding-model.md`
§8, updated in this change), the canonical first full dogfooding journey now
requires:

```text
WORK-074 complete
AND
WORK-071 complete (or an equivalent supported runtime environment)
```

The repository no longer implies that merely merging WORK-063's architecture
specification means real authentication exists. The spec/runtime separation is
now durable: WORK-063 is the SPEC (merged, complete as the architecture
decision); WORK-074 is the RUNTIME ACTIVATION (planned, NOT activated,
architect-gated). The dogfooding gate references the RUNTIME Work Order, not
the spec.

This evidence artifact is the durable record that the dogfooding experiment was
ATTEMPTED on 2026-08-30, STOPPED at onboarding, and produced the findings
above. A fresh Architect LLM resuming the program reads
`spec/architecture/v1.1/fresh-architect-bootstrap.md` (updated in this change)
and this artifact to recover the full state without the dogfooding conversation.

---

## 6. Fresh-architect resumption note

A fresh Architect LLM taking over the program should:

1. Read `spec/architecture/v1.1/fresh-architect-bootstrap.md` (the bootstrap;
   updated in this change to record that dogfooding was attempted and where the
   findings live).
2. Read this artifact (the dogfooding evidence).
3. Read `spec/architecture/v1.1/dogfooding-model.md` §8 (the updated dogfooding
   gate).
4. Read the four `planned` Work Orders: `spec/work-orders/WORK-074.md`,
   `spec/work-orders/WORK-071.md`, `spec/work-orders/WORK-072.md`,
   `spec/work-orders/WORK-073.md`.
5. Read `spec/development-state/dependency-state.json` (the canonical
   dependency mapping — the four new Work Orders and their edges) and
   `spec/development-state/frontier-state.json` (the derived frontier —
   `plannedNext` now includes the dogfooding-gate Work Orders).
6. Run `cd backend && bun run governance:status` (the canonical governance
   summary from the repository alone).

The next architect's decision: which of the four `planned` Work Orders to
activate (WORK-074 and WORK-071 are the dogfooding-gate enablers;
WORK-072 and WORK-073 are independent frontend fixes that may run in parallel
with each other). Activation is the architect's non-delegable authorization,
recorded in `program-state.json`. Until activated, all four remain `planned`
and NOT started.
