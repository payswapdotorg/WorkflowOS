# WorkflowOS — Customer Dogfooding Evidence: 2026-08-31 Full Customer Experiment

Status: evidence (a durable architecture/engineering evidence artifact under the
repository's existing governance/validation/evidence taxonomy — see
`spec/architecture/v1.1/artifact-taxonomy.json` → `classes.evidence`: "runtime
observations" + "user-feedback observations" + "validation observations"). This
artifact is **evidence**, not normative and not authoritative: it records what
was empirically observed. It does not directly mutate normative or authoritative
state. The dogfooding agent did NOT commit this file, did NOT activate Work
Orders, did NOT modify product code, did NOT merge anything, and did NOT modify
canonical governance state. It is left untracked in the working tree (and copied
outside the repository) for the next governed implementation session to persist
through the normal governed path.

Provenance: produced by the WorkflowOS Customer Dogfooding Experiment (the
empirical product experiment governed by `spec/architecture/v1.1/dogfooding-model.md`;
the gate in §8 was SATISFIED — WORK-074 merged `cdedd0ca` via PR #99 and
finalized, WORK-071 merged `8604c8a` via PR #96 — so the full
authenticated/local dogfooding experiment was PERMITTED).

---

## 0. Required explicit statement

> This was an empirical dogfooding experiment. The product was exercised as a
> real customer would use it: fresh browser, real sign-up, real project, real
> LLM providers (real API calls, real tokens billed), a real Vercel deployment,
> and real agent executions. No product code was modified during the
> experiment. Every defect was reproduced before being recorded.

The experiment progressed FURTHER than the 2026-08-30 attempt (which stopped at
onboarding): authentication, organization (via API), project creation, Vercel
integration, LLM configuration (two of four providers accepted), planning
(real LLM plan generated and applied), work items, native agent execution
(multiple, including concurrent), deployment recording and display all
WORKED. The governed PR→verification→review→merge loop is BLOCKED at the
GitHub boundary. Browser validation (WORK-064/065/066) and engineering signals
(WORK-067) are NOT EXERCISABLE — no product surface exists for them.

---

## 1. Experiment metadata

| Field | Value |
|---|---|
| Experiment date | 2026-08-31 (evening) |
| Experiment kind | Customer dogfooding (WorkflowOS-as-a-product, NOT self-hosting) |
| Product version / commit | `origin/main` = `bde33cc5e9a1b109951be9ec48aaef7e692c33c7` ("feat(work-067): Engineering Signal & Regression Correlation … (#103)"), clean checkout |
| Environment | WORK-071 supported local dev runtime: `WORKFLOWOS_DEV_RUNTIME=pglite` (DATABASE_URL unset), backend `bun run start` on :3001, frontend `bun run dev` (Vite) on :5173 proxying /api → :3001; PGlite persisted at `backend/.workflowos-dev-data/pglite`; fresh database at start (fresh-install experience); 59 migrations applied at startup |
| Browser | agent-browser (headless Chromium), dedicated isolated sessions (`dogfood`, `anon`, `second`, `final`); fresh contexts with no pre-seeded state |
| Customer identity | Real product sign-up through the UI: "Ama Mensah" <ama.mensah@example.com> (test identity; password not recorded here), plus a second test identity "Kofi Boateng" <kofi.boateng@example.com> for cross-tenant probes |
| Secrets stored | NONE. No credentials, tokens, API keys, or session material are recorded in this artifact. Provider credentials were injected only through backend environment variables (the product's documented supported path); verification results are recorded as accepted/rejected only. |
| Evidence screenshots | 16 browser screenshots (01–16) captured during the run (names listed in §9; stored outside the repo at /home/z/workflowos-dogfood-logs/shots/ during the experiment) |
| Journey attempted | The canonical dogfood acceptance journey from `dogfooding-model.md` §4: authentication → organization → project → GitHub → Vercel → LLM → agent → planning → work orders → execution → parallelism → verification → review → deployment → browser validation → engineering signals |
| Exact stopping point | Two boundaries: (a) the fresh-customer journey dead-ends at ORGANIZATION onboarding (F-1) and the created project is invisible on the dashboard (F-3); (b) the governed implementation loop dead-ends at the GitHub App installation boundary (F-2), which blocks PR creation → CI evidence → verification completion → architect review → merge. |

---

## 2. Journey record (summary)

```text
[step 1] Fresh browser → first visit.
         Expected: login surface.
         Observed: LoginPage renders; OAuth buttons honestly disabled
         ("Continue with Google (unavailable)" — fail-closed, matches backend
         config); email/password form; "Create one" (sign-up) present.
         Result: PASS.

[step 2] Wrong credentials.
         Expected: honest rejection.
         Observed: POST /api/auth/password/login → 401; visible alert
         "Invalid email or password."; no navigation.
         Result: PASS.

[step 3] New customer sign-up ("Create one").
         Expected: account created; synchronous transition to app.
         Observed: Name/Email/Password form → account created → synchronous
         transition to authenticated Projects page (no reload required).
         Result: PASS.

[step 4] Session security + persistence.
         Observed: httpOnly `wfos_session` cookie (document.cookie empty),
         SameSite=Lax, path=/, 14-day TTL (Secure=false — expected on http
         dev origin); session survives page reload AND full backend restart
         (DB-backed sessions). Sign Out clears the cookie and returns to
         login. Protected route /projects from a fresh unauthenticated
         context renders the login gate; /api/auth/session → 401.
         Result: PASS.

[step 5] Organization onboarding.
         Expected: create/select an organization through the UI.
         Observed: NO organization-creation UI exists anywhere. The New
         Project form states "No organizations available. Enter an org ID
         manually." but provides NO org-ID field (only Project Name).
         Submitting with just a name yields the client-side error "Project
         name and organization are required". GET /api/organizations → []
         (sign-up creates no personal org). POST /api/organizations works
         (201, creator becomes owner) — API-only.
         Result: FAIL (F-1, UX_DEFECT, journey-blocking dead-end for normal
         customers; capability exists server-side).

[step 6] Project creation (after out-of-band org creation via API).
         Observed: with an org present the form shows an Organization
         combobox (Mensah Digital); "Expense Tracker" created (201) and
         navigated to Project Overview with full app navigation
         (Workbench/Architect/Architecture/Requirements/Work Items/
         Activity/Settings), honest empty states
         ("No architecture yet", "No projects yet").
         Result: PASS — except the created project then does NOT appear in
         GET /api/projects (F-3): the dashboard lists nothing for the
         creator; the project is reachable only by direct URL or "Open by
         Project ID".

[step 7] GitHub integration.
         Observed: Integrations page GitHub card "Not Configured";
         "Create repository" and "Link existing" dialogs require a GitHub
         App installationId ("Owner, repository, and installationId are
         required" — client-side). With a bogus installationId the backend
         honestly rejects 400 `installation-not-found`. The dialog's own text
         instructs "The installation must be linked to this project (POST
         /github/installations)" — a route that DOES NOT EXIST (404
         observed); no product surface creates installation rows (only
         webhook processing reads them). GET /github/health →
         {"status":"not-configured"} (honest).
         Result: FAIL (F-2 PRODUCT_BUG + E-3 ENVIRONMENT_BLOCK — the
         experiment holds a PAT, not a GitHub App). No fake success at any
         step.

[step 8] Vercel integration.
         Observed: "Connect Vercel" dialog takes a manual Vercel project
         external ID ("WorkflowOS stores the link — it never stores your
         Vercel API token (that stays in the backend SecretStore)"). Token
         injected via the documented env path (VERCEL_API_TOKEN; backend
         logged `app.runtime.vercel configured=true`). A disposable test
         project was created on Vercel; linking through the UI → POST
         /runtime/integrations → 201; link persists across reload AND
         backend restarts; Integrations page shows "Connected".
         Result: PASS with friction (no project discovery — manual ID entry
         from the Vercel dashboard).

[step 9] LLM provider configuration (§8 of the experiment charter).
         Observed: the product's model is env-only secrets ("Secrets are
         managed via server-side environment variables — never through this
         UI"); the per-project provider config UI takes a SECRET REF (env
         var NAME) — "Enter the NAME of the env var that already holds the
         API key. Never enter the key itself." Provider readiness API
         returns status only (no secret material — verified). Results:
         Mistral = configured/ACCEPTED (a real, complete architecture/
         requirements/work-items plan was generated through the product);
         OpenRouter = configured/ACCEPTED (real conversation + real agent
         executions); OpenAI = configured/REJECTED (HTTP 403
         unsupported_country_region_territory — sandbox egress region);
         Z.ai = configured/REJECTED (error 1113 insufficient balance);
         invalid key = honest failure (HTTP 401 "Invalid API Key" classified
         `authentication`, retryable=false, surfaced as "Error 500" in the
         conversation; no fake success, no retry storm).
         Result: PASS for the product's env-based design (2/4 providers
         accepted end-to-end; 2 rejected for provider-side account/region
         reasons, honestly surfaced).

[step 10] Model selection / routing.
         Observed: per-project provider config (provider/model/secret-ref/
         default) persisted; the execution dialog selects provider+model per
         run (Native/External modes). DESYNC finding (F-5): the registry
         default (AGENT_PROVIDER_NAME/AGENT_DEFAULT_MODEL) and the adapter's
         actual model (AGENT_MODEL) are separate env vars — the dialog
         offered mistral/gpt-4o while the adapter actually served
         mistral-small-latest; requesting the adapter's REAL model
         (mistral/mistral-small-latest) was refused 400
         `provider-not-configured`, while the misleading gpt-4o default
         passed validation and the execution record then displays model
         "gpt-4o" although the adapter called mistral-small-latest.
         Result: WORKS WITH FRICTION (F-5).

[step 11] Agent configuration.
         Observed: "Add agent provider config" (openai/anthropic/gemini/
         fake registry) + per-run execution dialog; configs persisted
         (status flips not-configured → ready when the referenced env var
         is present — verified across a restart).
         Result: PASS.

[step 12] Planning journey.
         Observed: the conversational Architect (real LLM) generated a
         structured plan (architecture + constraints, 3 requirements with
         acceptance criteria, 3 work items with dependencies, summary);
         "Apply Plan" → POST /architect/apply → 201 → the plan materialized
         as 3 governed Work Items; Revisions (1) tracked; conversation
         persisted across reload and backend restart (DB-backed sessions —
         note: an exchange that ended ONLY in an LLM error did not persist).
         Result: PASS (real LLM, real governed output).

[step 13] Work item lifecycle.
         Observed: Draft → Ready via UI transition (POST workflow/
         transitions 200, audit event written); honest merge gates at every
         step ("work item is in 'ready' state, not 'approved'", "no approved
         (APPROVE) Architect Review found", "no active PR association
         found", "verification prerequisites not satisfied"); lifecycle
         stepper Draft→Ready→Implementation→Review→Merge→Verified; the
         canonical LEGAL_TRANSITIONS map is enforced (ready→assigned→
         implementing→pr_open→verifying→architect_review→…).
         Result: PASS.

[step 14] Execution journey.
         Observed: "Start Implementation" disabled in Draft (state-gated);
         dialog (Native/External, provider/model); native execution via the
         real agent adapter → agent.execute.success → execution.submitted
         (completed) with provenance (agentRunId, promptDigest, commitRef
         "agent-wf_…"); execution visible in Workbench Executions tab
         ("mistral / gpt-4o · native · completed") and on the work item
         Implementation tab with an honest advisory/actual separation
         ("Routing recommends: No eligible candidate (fail closed) …
         recommendations never decide this"). Starting implementation on a
         manually-created work item without a Work Order → honest 502
         `start-implementation-work-order-not-found` ("No fake AgentRun was
         recorded") (F-6: the UI offers no work-order generation path).
         Result: PASS for execution itself.

[step 15] Verification journey.
         Observed: "Begin Verification" → 202; a VerificationRun record
         created (source: orchestrator) and stays `pending` with empty
         summary — it awaits evidence (the PR/CI boundary that cannot exist
         without the GitHub link). No false "healthy/complete" state at any
         point.
         Result: HONEST BLOCKED (gated on the GitHub boundary).

[step 16] Review journey.
         Observed: "Begin Architect Review" → 202, but the convergence
         engine correctly NO-OPS it unless the workflow state is
         `architect_review` (verified in the orchestrator source and by the
         empty reviews list + `convergence.signal.already_processed` logs).
         "Request Merge" → 202 signal, merge gates stay honestly red; no
         merge occurs.
         Result: HONEST BLOCKED (correct governance — a blocked action is a
         valid finding, not a defect).

[step 17] Deployment journey.
         Observed: the product's model is record/observe (the Vercel
         provider implements health/createProject/linkRepository/
         getDeployment/getPreviewUrl/getDeploymentStatus — no deploy
         trigger). A REAL Vercel deployment was created on the disposable
         test project (deployment dpl_BB7xxaqwykEeKgYH3joPhencySyY, state
         READY, live URL), recorded through POST /runtime/deployments (201)
         with the TRUE observed values, and the Workbench Deployments tab
         displays it accurately ("dpl_BB7x…", "Ready", preview link, "— on —
         · created just now"). The integrations page shows "Vercel:
         Connected / Latest deployment: Ready". No fake deployment was
         recorded at any point.
         Result: PASS for the record/display chain (deployment triggering
         is external to the product by design).

[step 18] Parallelism.
         Observed: two simultaneous native executions (fired at the same
         instant on two work items) BOTH completed with DISTINCT execution
         IDs and DISTINCT agentRunIds — no cross-collision, no duplicate
         work. The Work Graph shows the dependency authority's verdict
         ("Blocked: 2 work items with unsatisfied dependencies"). HOWEVER
         (F-4): a dependency-BLOCKED work item (WORK-002, dependency on
         WORK-001 unsatisfied) was allowed to transition draft→ready AND
         start AND complete a native execution — the dependency verdict is
         displayed but NOT enforced at execution admission (merge gates DO
         enforce it).
         Result: PARTIAL (concurrency correct; dependency gating gap F-4).

[step 19] Browser validation (WORK-064/065/066).
         Observed: continuous-validation, browser-validation, and
         validation-scheduling modules are wired in app.ts but expose ZERO
         HTTP routes and ZERO UI surfaces (searched the entire backend route
         tree and the frontend). No customer path exists.
         Result: NOT EXERCISABLE (F-8, MISSING_CAPABILITY — consistent with
         WORK-068..070 being planned, not activated).

[step 20] Engineering signals (WORK-067).
         Observed: engineering-signals module present (merged as bde33cc,
         PR #103) but likewise ZERO routes/UI.
         Result: NOT EXERCISABLE (F-8).

[step 21] Full A→Z composite (fresh browser, fresh login).
         Observed: login → the project is NOT on the dashboard (F-3);
         "Open by Project ID" → full project surface; Integrations: GitHub
         Not Configured (honest), Vercel Connected + deployment Ready,
         Architect Connected; Workbench: executions + deployment visible;
         architect conversation persisted. The authenticated chain COMPOSES
         end-to-end; the fresh-customer-from-zero chain does NOT (F-1).
         Result: PARTIAL PASS.
```

---

## 3. Findings

Every defect below was reproduced (F-1 and F-3 reproduced again from a second
fresh browser session; F-4 reproduced once; F-2/F-5 verified by direct API
calls). No finding was patched during the experiment.

### F-1 — No organization-creation surface (journey dead-end)

- Severity: P1 (blocks the canonical fresh-customer journey at step 2)
- Classification: UX_DEFECT (the backend capability exists and works)
- Journey: §4 organization onboarding
- Expected: the customer can create or select an organization through the UI.
- Observed: after sign-up the customer lands on Projects. "New Project" →
  "No organizations available. Enter an org ID manually." — with NO org-ID
  field in the form (only Project Name). Submitting a name-only project →
  "Project name and organization are required". There is no organization page,
  no org switcher, no org creation anywhere in the frontend (15 pages audited
  — none is an Organizations page). GET /api/organizations → `[]`. The
  customer cannot obtain an org ID through the product.
- Reproduction: fresh browser → Create one → sign-up → Projects → New Project
  → observe the dead-end text and the missing org input. Deterministic.
  Reproduced for two independent fresh users (ama.mensah@…, kofi.boateng@…).
- Likely subsystem: frontend (missing Organizations surface); the backend
  POST /api/organizations works correctly (201, creator=owner).
- Evidence: shots 03/04; API observations in §2 steps 5–6.
- Recommended governed follow-up: a Work Order for an Organizations surface
  (create/select/switch) in the frontend (extends the planned WORK-073
  "Create Project Organization Selection" scope — see the 2026-08-30 evidence
  which issued WORK-072/073 for sibling findings F-3/F-4 of that run).

### F-2 — GitHub App installation cannot be linked; referenced route does not exist

- Severity: P2 (blocks the governed PR→verify→review→merge loop)
- Classification: PRODUCT_BUG (misleading customer-facing instruction +
  missing wiring surface), compounded by ENVIRONMENT_BLOCK (the experiment's
  GitHub credential is a PAT; the product requires a GitHub App: app ID +
  private key + installation)
- Journey: §6 GitHub integration
- Expected: "GitHub connect → authorization → repository discovery →
  repository selection → repository linked".
- Observed: the Create-repository/Link-existing dialogs require an
  installationId; the dialog text says "The installation must be linked to
  this project (POST /github/installations)" — that route does not exist
  (404 `Route POST:/projects/:id/github/installations not found` observed).
  No route anywhere creates `wfos_github_installations` rows (only
  webhook-processing reads them). With a bogus installationId the provisioning
  route honestly fails 400 `installation-not-found`; GET /github/health →
  `{"status":"not-configured"}`.
- Reproduction: open Integrations → Create repository → fill owner/repo →
  submit without installationId (client validation) → submit with
  installationId "999999" (400 installation-not-found) → POST the referenced
  /github/installations route (404). Deterministic.
- Likely subsystem: backend routes (missing installation-linking route or
  admin surface) + frontend copy.
- Evidence: shots 06 context; network log in §2 step 7.
- Recommended governed follow-up: a Work Order defining the supported
  installation-linking surface (admin route or GitHub-App webhook onboarding)
  and correcting the dialog copy.

### F-3 — Created project is invisible on the customer's dashboard

- Severity: P1 (the customer loses the project they just created from the
  primary navigation surface)
- Classification: PRODUCT_BUG
- Journey: §5 project creation + §19 composite
- Expected: after creating a project, GET /api/projects returns it and the
  dashboard lists it.
- Observed: POST /organizations/:orgId/projects creates the project (201) but
  grants NO project_access row to the creator; GET /projects is driven
  exclusively by `projectAccessRepository.listForUser()` → returns
  `{"projects":[]}`. The UI shows "No projects yet / Create your first
  project…". The project IS directly accessible (org-membership authorization
  path works — all project pages render), so the customer can only return to
  it via URL or "Open by Project ID". The dev-only provisioner
  (`backend/provision-key.ts`) grants access explicitly
  (`projectAccessRepo.grant({userId, projectId, roleId:'owner'})`) — the
  production route does not.
- Reproduction: create a project via the UI → GET /api/projects → empty.
  Reproduced again from a second fresh browser session after re-login
  (composite journey, shot 14) and for the same user across backend restarts.
  Deterministic.
- Likely subsystem: backend projects route (missing access grant on create) or
  the list query (should include org-scoped projects for org members).
- Evidence: shots 14/15; §2 steps 6 and 21.
- Recommended governed follow-up: a Work Order granting the creating user a
  project_access row (or extending the list authorization to org membership).

### F-4 — Execution is not gated by the dependency authority

- Severity: P2 (governance display/ enforcement mismatch)
- Classification: PRODUCT_BUG
- Journey: §13 parallelism
- Expected: a work item whose dependencies are unsatisfied ("Blocked" per the
  Work Graph and the merge gates) cannot start implementation.
- Observed: WORK-002 ("Implement Frontend", dependency on WORK-001
  unsatisfied — Work Graph shows "Blocked: 2 work items with unsatisfied
  dependencies"; merge gates show "dependencies not satisfied") was
  transitioned draft→ready (allowed), then started AND completed a native
  execution (execution wf_38064289, agentRunId 93dc79b1…). The dependency
  verdict is displayed in two places but not enforced at execution admission.
- Reproduction: open a dependency-blocked work item → Ready → Start
  Implementation → native run completes. Deterministic.
- Likely subsystem: execution admission (start-implementation service) — the
  dependency service is consulted for merge gates but not for execution
  admission.
- Evidence: §2 step 18; backend execution logs.
- Recommended governed follow-up: a Work Order enforcing dependency
  satisfaction at execution admission (fail-closed), or an explicit
  architecture decision documenting why execution is permitted while blocked
  (with the UI then not showing "Blocked" as an authority verdict).

### F-5 — Provider registry / adapter model desync

- Severity: P3 (configuration ergonomics; misleading execution metadata)
- Classification: UX_DEFECT
- Journey: §9 model selection
- Expected: the execution dialog offers models the configured adapter can
  actually serve; the execution record's model is the model actually used.
- Observed: AGENT_PROVIDER_NAME/AGENT_DEFAULT_MODEL (registry defaults) and
  AGENT_MODEL (the adapter's actual model) are independent env vars. With
  AGENT_PROVIDER_NAME=mistral and no AGENT_DEFAULT_MODEL, the dialog defaulted
  to mistral/gpt-4o (registry default) while the adapter actually called
  mistral-small-latest; requesting mistral/mistral-small-latest (the adapter's
  REAL model) was refused 400 `provider-not-configured`; the gpt-4o default
  passed validation and the persisted execution record shows model "gpt-4o"
  although the adapter used mistral-small-latest.
- Reproduction: configure AGENT_PROVIDER_NAME=mistral without
  AGENT_DEFAULT_MODEL; observe the dialog default and both submit outcomes.
- Likely subsystem: default-agent-provider-registry + execution dialog.
- Recommended governed follow-up: a Work Order unifying the model source of
  truth (single env var or registry-driven adapter construction).

### F-6 — Manually-created work items cannot start implementation (no Work Order path)

- Severity: P3
- Classification: UX_DEFECT
- Journey: §12 execution
- Expected: a work item created through the "New Work Item" UI can be
  implemented through the governed flow.
- Observed: starting implementation on a manually-created item → honest 502
  `start-implementation-work-order-not-found: … has no Work Order. Generate a
  Work Order before starting implementation` ("The implementation context was
  persisted but the agent execution failed. No fake AgentRun was recorded.").
  The UI exposes no work-order generation control (the only paths that create
  work orders are the architect plan-apply and the
  POST /architect/generate-work-order API, which with the tested model
  returned `no-work-order-candidate` — LLM-output-shape dependent).
- Reproduction: New Work Item → Ready → Start Implementation → 502. Deterministic.
- Likely subsystem: frontend (missing generate-work-order affordance) +
  work-order generation robustness.
- Recommended governed follow-up: a Work Order adding a UI path from a work
  item to its Work Order (and hardening the generation prompt/parse).

### F-7 — No surface for the agent run's implementation output

- Severity: P3
- Classification: UX_DEFECT / MISSING_CAPABILITY
- Journey: §12 execution, §14 verification
- Expected: the customer can inspect what the agent produced (the
  implementation content/evidence).
- Observed: the execution record exposes provenance (agentRunId,
  promptDigest, commitRef, implementationContextKind) but no route or UI
  displays the agent's output. (Related: an architect conversation consisting
  only of a failed LLM exchange is not persisted — only successful exchanges
  create durable session content.)
- Reproduction: complete a native execution; search the work item page,
  Workbench, and API for the output content.
- Recommended governed follow-up: a Work Order surfacing agent-run artifacts
  (note: the dev runtime's in-memory object store is non-durable by design —
  WORK-071 documented limitation).

### F-8 — WORK-064..067 capabilities have no product surface

- Severity: P2 (maturity gap; the repo's own governance knows this)
- Classification: MISSING_CAPABILITY (EXPECTED_BEHAVIOR relative to the
  planned WORK-068..070 — recorded so the maturity assessment is honest)
- Journey: §17 browser validation, §18 engineering signals
- Expected: the dogfood run exercises validation and signals "once
  implemented" (dogfooding-model §4).
- Observed: continuous-validation, browser-validation, validation-scheduling,
  and engineering-signals modules are composed in app.ts but expose ZERO HTTP
  routes and ZERO UI surfaces (verified by exhaustive route-tree search and
  frontend audit). Nothing invokes `validationScheduler.scheduleValidationTrigger`
  in the product runtime.
- Reproduction: search the backend route registrations and frontend API
  client for journey/validation/signal surfaces — none exist.
- Recommended governed follow-up: none beyond the already-planned
  WORK-068..070 (do NOT create duplicate Work Items for planned work).

### F-9 — No repository/project discovery for GitHub and Vercel

- Severity: P3
- Classification: MISSING_CAPABILITY (by-design manual entry; friction)
- Journey: §6, §7
- Observed: GitHub dialogs take manual owner/repo text; the Vercel dialog
  instructs the customer to read the project ID from the Vercel dashboard.
- Recommended governed follow-up: optional UX Work Order (low priority).

### F-10 — Wayfinding gaps

- Severity: P3
- Classification: UX_DEFECT
- Observed: the global Settings page renders empty (heading + Sign Out only);
  the Projects list page (pre-project) has no app navigation; the
  /settings/providers page is reachable only via a link on the project
  Integrations page; the account menu's "Settings" item leads to the empty
  Settings page.
- Recommended governed follow-up: optional UX Work Order consolidating
  navigation/settings.

---

## 4. Positive findings (no Work Items — recorded only)

- **P-1 Authentication works end-to-end** (WORK-074 runtime): real sign-up,
  login, wrong-credential honest 401 + visible alert, logout, session
  persistence across reload AND backend restart, protected-route gating.
  httpOnly + SameSite=Lax session cookie; server-side sessions.
- **P-2 Fail-closed OAuth**: unconfigured providers render as disabled
  "(unavailable)" with an honest explanation ("A provider marked unavailable
  is not configured on this deployment") — no half-working buttons.
- **P-3 Real LLM planning works through the product**: two providers
  (Mistral, OpenRouter) generated real structured plans; Apply Plan
  materialized governed Work Items with dependencies and acceptance criteria.
- **P-4 Native agent execution works** with full provenance (agentRunId,
  promptDigest, commitRef, implementation context kind/revision) and an
  honest advisory/actual separation in the UI.
- **P-5 Honest failure surfacing everywhere**: invalid LLM key → 401
  classified authentication/non-retryable (no retry storm); OpenAI region
  403 surfaced; missing work order → 502 "No fake AgentRun was recorded";
  verification stays `pending` rather than fake-completing; merge gates
  honestly enumerate every unsatisfied prerequisite.
- **P-6 Cross-tenant isolation is airtight**: a second authenticated user
  received 404/403 on every probe of the first user's project, deployments,
  GitHub link, and work item, and saw an empty organization list.
- **P-7 Secrets posture**: env-only secrets; the provider-config UI accepts
  only an env-var NAME; readiness APIs return status only (no key material
  observed in any response); the session cookie is httpOnly; no secrets in
  localStorage (it is empty).
- **P-8 WORK-071 PGlite dev runtime works**: the full product surface ran
  locally with no external services; 59 migrations applied; all state (orgs,
  projects, plans, work items, executions, provider configs, integrations,
  deployments, sessions) persisted across multiple backend restarts.
- **P-9 Vercel integration chain works** (connect → persisted link → real
  deployment recorded → accurate UI display with status and preview link).
- **P-10 Concurrency is clean**: two simultaneous native executions completed
  with distinct execution IDs and agentRunIds — no cross-collision, no
  duplicate work.
- **P-11 Governance is enforced, not decorative**: LEGAL_TRANSITIONS enforced
  server-side; architect review no-ops outside `architect_review` state;
  Request Merge accepted as a signal but no merge occurs with red gates; the
  workflow authority, not the UI, decides.
- **P-12 Audit trail**: every material transition wrote an audit event
  (WORKFLOW_TRANSITION with actor + execution id).

---

## 5. Blocked prerequisites

```text
PRODUCT BUG:
  F-1  (org creation UI missing)            — blocks fresh-customer onboarding
  F-2  (installation linking route absent)  — blocks the governed PR loop
  F-3  (project invisible on dashboard)     — blocks dashboard-based navigation
  F-4  (dependency gating not enforced at execution)

ENVIRONMENT BLOCK:
  E-1  OpenAI API rejects the sandbox egress region (403
       unsupported_country_region_territory) — provider-side, not a product
       defect; the product surfaced it honestly.
  E-2  Z.ai test credential has insufficient balance (error 1113) —
       provider-side; surfaced honestly.
  E-3  The experiment's GitHub credential is a PAT; the product's GitHub
       boundary is GitHub-App-based (app id + private key + installation).

MISSING CAPABILITY:
  M-1  WORK-064..067 product surfaces (validation/scheduling/signals) —
       planned future work (WORK-068..070), not defects.
  M-2  GitHub/Vercel repository/project discovery (manual entry by design).
```

---

## 6. Security summary

Credential/session/tenant protections behaved correctly: session cookie
httpOnly + SameSite=Lax (+ Secure in production per WORKFLOWOS_PUBLIC_URL);
server-side sessions surviving restart; no credentials in browser storage (localStorage
empty); no secret material in any observed API response (readiness-only);
provider secrets backend-side only; cross-tenant probes all denied
(404/403/empty); sign-out clears the session cookie; wrong credentials
rejected honestly. No credential values appear in this artifact, in
screenshots, or in logs captured as evidence.

---

## 7. Integration summary

| Integration | Credential state | Observed product behavior |
|---|---|---|
| GitHub | PAT accepted by GitHub directly; product requires GitHub App | Honest fail-closed at every step (disabled OAuth login, client validation, 400 installation-not-found, 404 on the referenced route, health "not-configured"). No fake linkage. |
| Vercel | configured / accepted | Provider registered and configured; project linked via UI; link persisted across reload+restart; real deployment recorded and displayed accurately. |
| Z.ai | configured / rejected | Provider-side insufficient balance (1113); honest error available via direct call; not exercised through the product (single-adapter env model). |
| OpenAI | configured / rejected | Provider-side region block (403); product classified the failure correctly (authentication, non-retryable) and surfaced "Error 500" in the conversation — no false success. |
| Mistral | configured / accepted | Real plan generated through the product (1305-token generation), applied, materialized as governed work items; agent execution succeeded. |
| OpenRouter | configured / accepted | Real conversation and real agent executions through the product; usage logged (llm.generate.success). |

---

## 8. Maturity assessment (evidence-based)

| Capability | Rating |
|---|---|
| Authentication | WORKS |
| Organization onboarding | BLOCKED (UI dead-end F-1; API-only path works) |
| Project onboarding | WORKS WITH FRICTION (creation works; F-3 makes the project invisible on the dashboard) |
| GitHub | BLOCKED (F-2 + E-3) |
| Vercel | WORKS WITH FRICTION |
| LLM configuration | WORKS (env-based by design; honest readiness; 2/4 providers accepted end-to-end) |
| Agent configuration | WORKS |
| Planning | WORKS |
| Work Orders | WORKS WITH FRICTION (honest gates; F-6 manual-item gap) |
| Execution | WORKS |
| Parallelism | WORKS WITH FRICTION (concurrency clean; F-4 gating gap) |
| Verification | BLOCKED (honest pending; gated on the GitHub/PR boundary) |
| Review | BLOCKED (correctly gated — no review generated without the PR/verification chain) |
| Deployment | WORKS WITH FRICTION (record/observe model; accurate display) |
| Browser validation | NOT EXERCISABLE (no surface — M-1) |
| Engineering signals | NOT EXERCISABLE (no surface — M-1) |
| Overall end-to-end composition | WORKS WITH FRICTION — the authenticated chain (login → project → providers → planning → execution → deployment display) composes and persists; the governed PR→verify→review→merge loop is BLOCKED at the GitHub boundary; the fresh-customer-from-zero chain is BLOCKED at organization onboarding |

---

## 9. Evidence inventory

Browser screenshots (stored during the experiment outside the repo at
`/home/z/workflowos-dogfood-logs/shots/`): 01-first-visit-login.png,
02-signup-form.png, 03-authenticated-projects-empty.png,
04-projects-page-full.png, 05-project-created.png,
06-vercel-connect-notconfigured.png, 07-vercel-connected.png,
08-architect-plan-mistral.png, 09-work-item-detail.png,
10-workbench-executions.png, 11-architect-openrouter.png,
12-deployment-recorded.png, 13-work-graph.png, 14-composite-login.png,
15-composite-project-open.png, 16-composite-workbench.png.

Backend runtime log (structured JSON) and product API observations are
summarized in §2. Product version: `bde33cc5e9a1b109951be9ec48aaef7e692c33c7`.
Repository state after the experiment: clean working tree (no code, no
governance state, no commits made by the dogfooding agent; this file is
untracked).

---

## 10. Recommended governed follow-ups (proposed — NOT activated)

The next implementation session should map these to Work Orders through the
architect's authority (do NOT treat this section as activation):

1. F-1 + F-10 — Organizations surface + navigation consolidation (frontend;
   related to planned WORK-073's scope).
2. F-3 — project_access grant on project creation (backend, small, P1).
3. F-2 — GitHub App installation-linking surface + dialog copy fix.
4. F-4 — dependency enforcement at execution admission (or an explicit
   architecture decision documenting the intended semantics).
5. F-5 — provider/model configuration single source of truth.
6. F-6 + F-7 — work-order generation affordance + agent-run output surface.

No Work Item was created, activated, or modified by this experiment.
