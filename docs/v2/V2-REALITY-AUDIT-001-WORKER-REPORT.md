# V2-REALITY-AUDIT-001 — Worker Reality-Audit Report

**Status:** reconnaissance complete — awaiting Architect reconciliation. No fixes were performed and no architecture changes were self-authorized during this audit, per the Work Order and the worker dispatch.

## Tested revision

- **Environment:** local staging composition — the REAL Fastify `buildServer` over the identity stack's real PGlite PostgreSQL (all migrations incl. 0060–0062), union of the V2-017 product route deps (identity + organizations + projects + V2-002 workflow-repository + V2-005 workflow-runs + V2-004/V2-009 workflow-deployments + V2-006 teaching + V2-010 reverse-teaching + V2-011 optimization + the V2-012 marketplace transport routes) on `127.0.0.1:3001`, plus the REAL Vite dev server serving the actual SPA on `:5173` with the `/api` proxy. Separately, the REAL deployment entry (`src/index.ts`, `WORKFLOWOS_DEV_RUNTIME=pglite`, role `all`) was booted and probed directly on `:3001`.
- **Main/PR head SHA:** `6c5eac013a5d508da154edd8d567c19ddcf6addd` (origin/main at audit start; branch `audit/V2-REALITY-AUDIT-001` created from it).
- **Browser/runtime:** Z.ai Agent Browser (headless Chromium), viewport 1280×800 primary; 390×844 for responsive legs.
- **Test data/fixture identifiers (non-secret):** publisher persona `ada-audit@dogfood.example.com` (org "Ada Audit Automation", public workflow `wfw_e0737bee…`, listing `audit1_1` @ $19 one-time); auditor persona `nova-audit@dogfood.example.com` (org "Nova Audit Co", fork `wfw_7276843…` with v1 + v2 `wfwv_0900d2…`, installation `wfin_6f5e3afd…`, runs incl. `wfr_5ef55ffd…` failed→retried); project `4a61f508-a112-4b51-8d35-70495a1d5e15`.
- **Start/end timestamps:** 2026-09-06T08:04:00Z → 2026-09-06T08:26:38Z.

## Summary

| Metric | Count |
|---|---:|
| Journeys exercised | 41 |
| Passed | 31 |
| Failed | 4 |
| Blocked | 3 |
| Expected unavailable | 3 |
| Findings | 10 |
| Critical findings | 4 |

## Journey matrix

| ID | Journey | Expected | Observed | Pass/Fail/Blocked | Evidence | Route | Backend diagnostic | Root classification |
|---|---|---|---|---|---|---|---|---|
| DEP-1 | Real deployment entry serves the V2 product | product routes served | `GET /workflows` 404, `/marketplace/listings` 404, `/teaching-sessions` 404, `/runs` 404, `/workflow-versions` 404; `/health` 200; `POST /auth/password/register` 201 | **FAIL** | probe log below | `/workflows` etc. on `src/index.ts` composition | `api/server.ts` registers V2 product routes only when optional deps are passed; `src/index.ts`/`docker-compose` pass none of them (migrations 0060–0062 DO run) | MISSING_ADAPTER_OR_COMPOSITION (F-001) |
| AUTH-1 | register through real UI | account + session | registered, landed on Home shell | PASS | transcript | `POST /auth/password/register` | 201 | — |
| AUTH-2 | sign out | login screen | login screen | PASS | transcript | `POST /auth/session/logout` | 204/200 | — |
| AUTH-3 | sign in with password | Home | Home | PASS | transcript | `POST /auth/password/login` | 200 | — |
| AUTH-4 | wrong password | honest error | "Invalid email or password." | PASS | transcript | `POST /auth/password/login` | 401 | — |
| AUTH-5 | duplicate registration | honest error | "An account with this email already exists." | PASS | transcript | `POST /auth/password/register` | 409 | — |
| AUTH-6 | session persistence (reload) | session retained | retained (HttpOnly cookie) | PASS | transcript | `GET /auth/session` | 200 | — |
| HOME-1 | goal/search entry + mode buttons | entry renders | renders with Tell/Show/Tell+Show | PASS | `home-attention-surfaces.png` | — | — | — |
| HOME-2 | attention: Recent workflows / Needs attention | honest empty states | honest empty states | PASS | `home-attention-surfaces.png` | `GET /organizations/:id/workflow-repository/workflows`, `/workflow-runs/runs` | 200 | — |
| HOME-3 | attention: Pending approvals | composes existing runs/approval reads | "Unavailable — Approvals aren't shown here yet… once approvals become part of the product" | **FAIL** | `home-attention-surfaces.png` | none fired | approvals ARE part of the product: V2-005 approval gates + the "Waiting for you" derivation already implemented in RunExperience; runs/history reads exist | UX_DEFECT (F-005) |
| HOME-4 | attention: Updates | composes existing versions/installations reads | "Unavailable … once updates become part of the product" | **FAIL** | `home-attention-surfaces.png` | none fired | update banner + approve-update flow already exist on workflow detail (V2-002/V2-011) | UX_DEFECT (F-005) |
| HOME-5 | attention: Device issues | honest unavailable | "Unavailable" | EXPECTED UNAVAILABLE | `home-attention-surfaces.png` | none fired | no public device/node-status read exists (workflow-deployments routes expose deployments/subscriptions only; node-capability heartbeats have no org-scoped read route) | EXPECTED_UNAVAILABLE_SURFACE (F-006) |
| CREATE-1 | Tell creation → preview → commit | honest capture; commit path | verbatim echo, correction fields, name/slug/description/visibility, fail-closed "Durable creation isn't available yet … Nothing is committed" | PASS (honest boundary) | `f002-creation-boundary.png` | none (no mutation fired) | V2-002 create accepts WorkflowIR `content`+`protocol` only; no NL→IR capability exists (agent-intelligence = deterministic ranking; reverse-teaching derives FROM IR) | boundary honest; see F-004 |
| CREATE-2 | Show creation | honest no-recording note | "No screen recording exists yet — describe what you did…" | PASS | transcript | none | — | — |
| CREATE-3 | Tell + Show | combined capture, same boundary | steps captured, same fail-closed boundary | PASS | transcript | none | — | — |
| MKT-1 | Explore browse | listing cards | card renders with price, "Listed by another organization", trust sentence | PASS | `listing-detail-installed.png` | `GET /marketplace/listings` | 200 | — |
| MKT-2 | listing detail §22 disclosure | full disclosure | needs-access (incl. sensitive `messaging.send`), works-with placements, pinned version, boundary sentences, "no free offer" denial | PASS | `listing-detail-installed.png` | `GET /marketplace/listings/:id` | 200 | — |
| MKT-3 | purchase with NO organization | actionable guidance or org creation | silent no-op: "Get workflow" click does nothing; "Checking your access…" never resolves | **BLOCKED** | transcript + network log (no POST fired) | none fired | `acceptOffer`/`loadAccess` early-return when `selectedOrgId` is null; fresh signup has zero orgs; the product UI never POSTs `/organizations` | MISSING_ADAPTER_OR_COMPOSITION (F-002) |
| MKT-4 | purchase with org | entitled state | "You're entitled to this workflow … one-time purchase" | PASS | `listing-detail-installed.png` | `POST /marketplace/listings/:id/offers/:offerId/accept` | 200/201 | — |
| MKT-5 | install pinned version | installed, pinned | "Installed — pinned to version 1" + execution-separate sentence | PASS | `listing-detail-installed.png` | `POST /organizations/:id/workflow-repository/installations` | 201 | — |
| MKT-6 | Make my own (fork) | provenance-carrying copy | name input → copy created with `forkedFrom*` provenance; "Open your copy" | PASS | transcript | `POST /organizations/:id/workflow-repository/forks` | 201 | — |
| LIB-1 | My Workflows tab | cards with facts | fork card with last-run/when-runs | PASS | transcript | org workflows/runs/installations/deployments reads | 200 | — |
| LIB-2 | Installed tab | installed cards with names | card renders but title falls back to generic "Installed workflow" | PASS (defect noted) | transcript | org installations read 200 | name available via public `GET /workflow-repository/workflows/:id` (used by the page it links to) but not consumed by the card | UX_DEFECT (F-007) |
| LIB-3 | Drafts / Archived | honest unavailable (never fabricated) | honest "Unavailable" sections (masked by generic empty state while library is empty) | PASS (minor note) | transcript | none | workflow model carries no draft/archived state — no second state machine invented | EXPECTED_UNAVAILABLE_SURFACE |
| DET-1 | own workflow detail | full detail surface | purpose, presentation steps, When/Where, Recent activity, Version, Access and safety, Updates, Improvements, primary actions | PASS | `mobile-detail.png` (also desktop) | `GET /workflow-repository/workflows/:id`, `/versions`, org runs/installations/deployments | 200 | — |
| DET-2 | INSTALLED (marketplace) workflow detail | same detail surface | whole page fails: "Couldn't load this workflow right now. Try again" | **FAIL** | `f003-installed-workflow-detail-broken.png` | `GET …/workflows/:id` 200, `/versions` 200, BUT org-scoped reads against the PUBLISHER's org → 403 | `WorkflowDetailPage.tsx` L162–167 passes `workflow.organizationId` (owner org) to runs/installations/deployments/workflows reads; membership authority correctly denies; page render fails for every cross-org installed workflow | WIRED_TO_WRONG_COMMAND_OR_READ (F-003) |
| RUN-1 | run preview → request → start | consequential preview then Running | preview (presentation steps, Version, Needs access, honest "Where it runs isn't set up yet") → Running | PASS | transcript | `POST /organizations/:id/workflow-runs/runs`, `POST /workflow-runs/runs/:id/start` | 201/200 | — |
| RUN-2 | Running + trust disclosure | honest evidence state | Running + "How do you know?" + "No evidence records yet" + Advanced verification | PASS | transcript | `GET /workflow-runs/runs`, `GET …/history` | 200 | — |
| RUN-3 | run state survives reload | state retained | Running retained | PASS | transcript | same reads | 200 | — |
| RUN-4 | user drives run lifecycle (approve/resume/pause/stop) | commands reachable in UX | NO user-facing lifecycle commands exist; "Waiting for you" is display-only | **FAIL** | transcript + client surface grep | none fired | backend V2-005 exposes `pause`/`resume`/`interrupt`/`cancel`/`complete`/`fail`/step commands; frontend `workflowRuns` client surface is only `listForOrganization/getHistory/request/start` | MISSING_ADAPTER_OR_COMPOSITION (F-008) |
| RUN-5 | failure presentation + recovery | honest failure + recovery | "Couldn't complete", reason verbatim, "Try again" (works — new run), "Edit workflow" → `/expert` | PASS (Edit leg = F-004) | transcript | `POST …/fail` (out-of-band executor fixture), then request/start again | 200 | — |
| WHEN-1 | schedule editor → save | real V2-009 composition | "Runs every day · 9:00 AM UTC" + Pause; real deployment + subscription created | PASS | transcript | `POST /organizations/:id/workflow-deployments/deployments`, `POST …/deployments/:id/subscriptions` | 201/201 | — |
| TEACH-1 | lesson + checkpoints + pause/resume | governed lesson flow | steps, "I've done it", pause, all confirmed | PASS | transcript | `POST /teaching-sessions/sessions`, `…/begin-lesson`, `…/checkpoints/confirm`, `…/pause` | 200 | — |
| TEACH-2 | practice | authority's own question | questions + Check + feedback (feedback names the wrong step — F-009) | PASS (defect noted) | transcript | `GET …/practice-questions`, `POST …/practice` | 200 | — |
| TEACH-3 | assessment → Lesson complete | terminal on pass | "Lesson complete" after exact-token answers; teaching evidence records listed | PASS | transcript | `POST …/assessment` | 200 | — |
| TEACH-4 | teaching evidence separation | visibly distinct | "TEACHING EVIDENCE … Kept separate from run evidence" | PASS | transcript | `GET /teaching-sessions/sessions/:id` | 200 | — |
| VER-1 | update banner (v2 available) | banner + pin language | "An update is available … Your installed version: Version 1 — pinned … Nothing changes until you approve the update." | PASS | transcript | versions + installations reads | 200 | — |
| VER-2 | Review update / What changed | V2-011 comparison, honest estimates | comparison rendered with modeled estimates; diff shown as raw internal JSON (F-010) | PASS (defect noted) | transcript | optimization transport route | 200 | — |
| VER-3 | Approve update | new pin via EXISTING commands | "You're on the newest version."; Installed → Version 2 | PASS | transcript | `POST …/installations` (V2-002) | 201 | — |
| ACT-1 | Activity timeline | entries + links | version entries + run entry + "Open the run" | PASS | transcript | runs/versions reads | 200 | — |
| ACT-2 | activity → run deep link | navigates to the run | `/workflows/:id?run=:runId` shows Running | PASS | transcript | same | 200 | — |
| ACT-3 | teaching/device on Activity | honest unavailable | "Teaching activity isn't shown here yet — teaching records don't offer a timeline read. Device events aren't shown here yet either." | EXPECTED UNAVAILABLE | transcript | none | teaching-sessions route surface has session-scoped reads only (no org timeline read); accurate | EXPECTED_UNAVAILABLE_SURFACE |
| EXPERT-1 | Expert bridge page | bridge renders | renders with disclosure | PASS | transcript | — | — | — |
| EXPERT-2 | project creation through UI | project created | project created, engineering shell renders | PASS | transcript | `POST /projects` | 201 | — |
| EXPERT-3 | engineering surfaces (architect/architecture/requirements/work-items) | surfaces load | "Error: Not found" on Overview — the V2 product test composition does not include the V1 engineering routes | **BLOCKED (composition artifact)** | transcript | `GET /projects/:id/architectures` | 404 in the product composition; exists in the real deployment entry (source-verified) | evidence for F-001 (no single composition serves both product and engineering surfaces) |
| RESP-1 | mobile 390×844 (Home/Detail/Create/Explore) | no overflow, usable nav | no horizontal overflow; mobile nav links present | PASS | `mobile-home.png`, `mobile-detail.png` | — | — | — |
| NET-1 | in-app navigation while offline | honest degraded states | "… unavailable — couldn't load … Try again" per surface | PASS | transcript | fetch failures | offline | — |
| COMP-1 | companion handoff deep link | honest bridge | "Companion not installed" + instructions | PASS | transcript | — | — | — |

### Live probe log — the real deployment entry (F-001 primary evidence)

Run against `bunx tsx src/index.ts` with `WORKFLOWOS_DEV_RUNTIME=pglite WORKFLOWOS_ROLE=all` (migrations 0060–0062 applied, `app.api.listening` on :3001):

```text
GET  /health                    -> 200
GET  /health/ready              -> 200
POST /auth/password/register    -> 201          (identity runtime IS wired)
GET  /workflows                 -> 404
GET  /marketplace/listings      -> 404
GET  /teaching-sessions         -> 404
GET  /runs                      -> 404
GET  /workflow-versions         -> 404
```

`docker-compose.yml` runs the same `CMD ["bun", "src/index.ts"]`, so the container topology inherits the same gap.

## Finding record

### FINDING-001

**Journey IDs:** DEP-1 (and every product journey under the real deployment entry)
**Severity:** CRITICAL — release-blocking
**Classification:** MISSING_ADAPTER_OR_COMPOSITION (deployment composition seam)
**User impact:** a deployed WorkflowOS serves login and then dead-ends: every V2 product surface (workflows, runs, marketplace, teaching, versions) returns 404 behind the universal shell.
**Reproduction:** boot `src/index.ts` (pglite dev runtime or docker-compose topology); sign up; navigate to Workflows/Explore — all product reads 404.
**Frontend path:** all product pages via `/api` proxy.
**Backend route:** `/workflow-repository/*`, `/workflow-runs/*`, `/workflow-deployments/*`, `/teaching-sessions/*`, `/reverse-teaching/*`, `/workflow-optimization/*`, `/marketplace/*`.
**Service/adapter:** `DefaultWorkflowRepositoryService`, `DefaultWorkflowRunService`, `DefaultWorkflowDeploymentService`, `DefaultTeachingSessionService`, `DefaultReverseTeachingSessionService`, optimization + marketplace services — all implemented and E2E-tested under test compositions only.
**Authoritative owner:** V2-002/V2-005/V2-009/V2-006/V2-010/V2-011/V2-012 authorities (frozen, complete).
**Operational contract:** `api/server.ts` registers each product route group only when its optional deps object is passed.
**Observed behavior:** `src/index.ts` (and therefore `docker-compose.yml`) passes none of the V2 product deps; only identity/organizations/projects/architecture/requirements/work-items (V1 engineering) are wired.
**Expected behavior:** the deployment composition constructs the product services (the exact union the E2E specs and the V2-017 dogfooding runner prove) and passes them to `buildServer`.
**Root cause:** the V2 product slices were verified under per-spec test compositions; the production composition root was never extended.
**Existing capability overlooked?** yes — every capability exists; only the deployment composition is missing.
**Minimal proposed repair:** one bounded composition PR: extend `src/app.ts`/`src/index.ts` to construct the V2 product services over the shared `DatabaseClient` and pass the seven product route-deps groups to `buildServer` (mirroring the proven test union, including PG-backed teaching stores or a documented store decision). Zero route/service/authority changes.
**Alternative designs considered:** (a) a separate V2 product process/role — rejected: PLAT-001 modular monolith, and the E2E topology is single-process; (b) deploying the test harness — rejected: not a deployment artifact.
**Architecture impact:** none — pure composition.
**Security/authority impact:** none — the same auth plugin/membership checks govern the routes wherever composed.
**Regression tests:** boot the real entry; assert 200 (auth-gated) on one read per product route group; browser smoke of Workflows/Explore.
**Browser re-test:** full R6 repeat audit.
**Deployment implication:** blocks EVERY deployment slice — this is the first repair.

### FINDING-002

**Journey IDs:** MKT-3 (and implicitly CREATE, LIB, RUN for a fresh user)
**Severity:** CRITICAL — release-blocking
**Classification:** MISSING_ADAPTER_OR_COMPOSITION
**User impact:** a fresh user cannot reach any product value: no organization exists after signup, the product has no organization-creation surface, and every org-scoped capability silently no-ops ("Checking your access…" forever; "Get workflow" click does nothing).
**Reproduction:** register a new account; open a marketplace listing; click "Get workflow" — no request fires; the access panel stays "Checking…".
**Frontend path:** `MarketplaceListingDetail.tsx` — `acceptOffer`/`loadAccess` early-return when `selectedOrgId` is null; no org-creation path anywhere in `src/`.
**Backend route:** `POST /organizations` (exists, 201 when called).
**Service/adapter:** organizations route + `PgOrganizationRepository` (wired in every composition incl. the real deployment entry).
**Authoritative owner:** identity/organizations authority.
**Operational contract:** org-scoped product reads require membership.
**Observed behavior:** fresh signup → `GET /organizations` → `{"organizations":[]}`; no frontend consumer of `POST /organizations`.
**Expected behavior:** a first-run organization bootstrap (explicit create-org step, or auto-provision at signup) so org-scoped surfaces have a target.
**Root cause:** every E2E spec and the dogfooding runner seeds the organization out-of-band (`page.request.post('/api/organizations')`); the UX onboarding was never built.
**Existing capability overlooked?** yes — the organizations POST route exists.
**Minimal proposed repair:** an explicit "create your organization" step in onboarding (e.g., first product-shell entry or the Create flow) consuming the existing route; honest error (not silent no-op) when no org exists on org-scoped actions.
**Alternative designs considered:** auto-create a default org at signup (server-side) — larger semantic surface (naming, ownership) — Architect decision; the explicit UX step is the smallest seam.
**Architecture impact:** none.
**Security/authority impact:** none (route already enforces auth + ownership).
**Regression tests:** browser test: signup → create org via UI → listing access check resolves → purchase works.
**Browser re-test:** R6.
**Deployment implication:** blocks the marketplace journey for every new user.

### FINDING-003

**Journey IDs:** DET-2 (terminal state of MKT-5, LIB-2 "Open")
**Severity:** CRITICAL — release-blocking
**Classification:** WIRED_TO_WRONG_COMMAND_OR_READ (wrong read scope: owner org vs caller org)
**User impact:** after purchasing and installing a marketplace workflow, "Open in your Workflows library" and the Installed tab's "Open" both land on a broken page ("Couldn't load this workflow right now"). The entire purchase journey dead-ends.
**Reproduction:** purchase + install any listing as customer; open the installed workflow detail.
**Frontend path:** `src/pages/WorkflowDetailPage.tsx` L162–167 — `workflowRuns.listForOrganization(workflow.organizationId)`, `workflowRepository.listInstallationsForOrganization(workflow.organizationId)`, `workflowDeployments.listForOrganization(workflow.organizationId)`, `workflowRepository.listForOrganization(workflow.organizationId)`.
**Backend route:** `/organizations/:orgId/workflow-runs/runs` etc.
**Service/adapter:** V2-005/V2-002/V2-009 org-scoped reads.
**Authoritative owner:** membership authority — CORRECTLY denies the caller the publisher's org facts (403).
**Operational contract:** org-scoped reads are membership-guarded; public workflow/version reads are open.
**Observed behavior:** page loads the workflow + versions (200) then 403s on the four org-scoped reads against the PUBLISHER's org and renders the failure state for the whole page.
**Expected behavior:** run/installation/deployment facts resolve against the CALLER's organization (where the customer's installations and runs live); the page renders.
**Root cause:** org-scope confusion — the page conflates the workflow's owner org with the caller's org.
**Existing capability overlooked?** yes — the correct reads exist and work for own-org workflows (the library uses the caller's org).
**Minimal proposed repair:** resolve the caller's organizations (the same `organizations.listForUser` read the library/listing pages use; single-org selection or picker) for the org-scoped facts; keep workflow/versions reads as-is.
**Alternative designs considered:** server-side "installations for workflow" read — new route surface, larger; caller-org resolution is the existing seam.
**Architecture impact:** none.
**Security/authority impact:** none — strictly narrowing reads to the caller's own org.
**Regression tests:** browser test: customer purchases listing → opens installed workflow detail → page renders with pinned version + caller's run facts (the t12 E2E never opened the installed detail — add it).
**Browser re-test:** R6.
**Deployment implication:** blocks the marketplace purchase→use path.

### FINDING-004

**Journey IDs:** CREATE-1/2/3, RUN-5 ("Edit workflow"), DET-1 ("Edit")
**Severity:** HIGH
**Classification:** UX_DEFECT (the false promise sentence) + TRUE_ARCHITECTURE_GAP (product-grade authoring is genuinely absent — Worker-level analysis; Architect confirms)
**User impact:** creation is a dead end (honest), but the preview additionally promises "executable authoring happens later from the workflow surface", which is false — no authoring surface exists anywhere; the Edit action abandons the workflow context for a generic expert bridge.
**Reproduction:** Create → Tell → preview (read the boundary sentence); then search the product for any authoring surface; click Edit on any workflow.
**Frontend path:** `CreatePage` boundary; `WorkflowDetailPage` Edit → `/expert`; frontend `workflowRepository` client surface = list/get/versions/installations/install/setInstallationStatus/fork/update — NO `createWorkflow`/`createVersion` consumer.
**Backend route:** `POST /organizations/:orgId/workflow-repository/workflows` and `POST /workflow-repository/workflows/:id/versions` EXIST and are proven (the dogfooding authored v1/v2 through them).
**Service/adapter:** V2-002 repository service + V2-003 IR builder (server-side).
**Authoritative owner:** V2-002/V2-003.
**Operational contract:** workflow content must be valid WorkflowIR with a truthful protocol declaration.
**Observed behavior:** the ONLY user paths to a workflow are marketplace install and fork; the ONLY path to a new version is the optimization-proposal adoption. Raw authoring has no UX.
**Expected behavior:** either an authoring surface exists (even an expert JSON-IR editor over the existing create/createVersion routes), or the boundary language stops implying one does.
**Root cause:** V2-017 shipped the universal UX against the honest-boundary design; the promised follow-on authoring surface was never built; the Work Order's reconciliation question is answered: capture→IR conversion is genuinely missing (agent-intelligence is deterministic ranking — "NEVER imports @modules/llm"; reverse-teaching derives FROM installed IR), and manual authoring is also absent from the UX.
**Existing capability overlooked?** partially — the raw V2-002 create/createVersion routes exist with NO frontend consumer; a product-grade authoring experience does not exist and is a genuine gap.
**Minimal proposed repair:** (a) bounded copy repair — replace the false sentence with the honest statement that workflows currently enter through Explore-install, fork, or (expert) the repository routes; (b) Architect decision on the authoring slice: an expert IR editor consuming existing routes vs a governed capture→IR authority (architecture change) vs deferral.
**Alternative designs considered:** capture→WorkflowIR authority (new authority — REQUIRES the governed V2 architecture-change mechanism; not self-authorized here); expert raw-IR editor (composition only); deferral with honest copy.
**Architecture impact:** (a) none; (b) depends on Architect disposition.
**Security/authority impact:** none for (a).
**Regression tests:** copy assertions on the boundary text.
**Browser re-test:** R6 (boundary leg).
**Deployment implication:** blocks nothing by itself; gates the creation value proposition.

### FINDING-005

**Journey IDs:** HOME-3, HOME-4
**Severity:** HIGH
**Classification:** UX_DEFECT (unwired existing reads + false "not part of the product" claims)
**User impact:** the Home attention panel tells users approvals and updates are not part of the product, while the product implements approval gates ("Waiting for you") and version updates (banner + approve) elsewhere.
**Reproduction:** sign in; read the Home attention surfaces.
**Frontend path:** Home attention surfaces — no API calls fired.
**Backend route:** runs + history + versions + installations reads (all existing, all already consumed by other pages).
**Service/adapter:** V2-005/V2-002 reads.
**Authoritative owner:** V2-005/V2-002.
**Observed behavior:** "Approvals aren't shown here yet — they'll appear once approvals become part of the product." / same for updates.
**Expected behavior:** Home composes the same derivations the library/detail already render (runs paused at approval steps; installations behind head version).
**Root cause:** Home attention surfaces were written before the derivation code existed elsewhere; never revisited.
**Existing capability overlooked?** yes.
**Minimal proposed repair:** derive the two surfaces from the existing org-scoped reads (reusing the "Waiting for you" and update-derivation helpers).
**Alternative designs considered:** a dedicated attention aggregate route — larger surface, unnecessary.
**Architecture impact:** none.
**Security/authority impact:** none.
**Regression tests:** browser assertions: waiting run → Home "Pending approvals" entry; behind-version install → Home "Updates" entry.
**Browser re-test:** R6.
**Deployment implication:** none standalone; honesty defect.

### FINDING-006

**Journey IDs:** HOME-5
**Severity:** MEDIUM
**Classification:** EXPECTED_UNAVAILABLE_SURFACE (honest as-is)
**User impact:** none — accurate disclosure.
**Reproduction:** read Home "Device issues".
**Frontend path:** Home attention surfaces.
**Backend route:** none exists.
**Service/adapter:** V2-004 node-capability heartbeats (service-level records) + V2-009 deployment reads — no org-scoped public device-status read.
**Authoritative owner:** V2-004/V2-009.
**Observed behavior:** "Unavailable … once device status becomes part of the product."
**Expected behavior:** exactly this, UNLESS the Architect wants device issues on Home — which would require a new public read (MISSING_PUBLIC_AUTHORITY_CONTRACT) as a governed decision.
**Root cause:** no public read route composes node health per org.
**Existing capability overlooked?** no (no public contract exists to wire).
**Minimal proposed repair:** none (honest). Optional governed slice: an org device-status read if the product wants the surface.
**Architecture impact:** only if the optional slice is chosen.
**Security/authority impact:** none.
**Regression tests:** n/a.
**Browser re-test:** n/a.
**Deployment implication:** none.

### FINDING-007

**Journey IDs:** LIB-2
**Severity:** MINOR
**Classification:** UX_DEFECT (presentation-level unwiring)
**User impact:** installed cards show "Installed workflow" instead of the workflow name.
**Reproduction:** install a marketplace workflow; open the Installed tab.
**Frontend path:** `WorkflowsPage.tsx` L338 — name resolved only from the org-scoped repository read; the public `get(workflowId)` read (used by the detail page it links to) is not consumed.
**Backend route:** `GET /workflow-repository/workflows/:id` (public).
**Root cause / existing capability overlooked?** yes — the public read exists.
**Minimal proposed repair:** resolve installed-card names via the public workflow read (batch or per-card).
**Architecture impact / Security impact:** none / none.

### FINDING-008

**Journey IDs:** RUN-4 ( Waiting-for-you users; every running/paused run)
**Severity:** CRITICAL — release-blocking
**Classification:** MISSING_ADAPTER_OR_COMPOSITION
**User impact:** a run that pauses at an approval gate can NEVER be resumed through the product — "Waiting for you" is display-only; there is no Approve/Resume/Pause/Stop/Retry control anywhere in the run UX. The human-approval loop is unclosable by the human.
**Reproduction:** start a run on a workflow with an approval step; wait for "Waiting for you"; observe the absence of any action control.
**Frontend path:** `RunExperience.tsx` — derives and renders the waiting state; the `workflowRuns` client surface contains only `listForOrganization/getHistory/request/start`.
**Backend route:** `POST /workflow-runs/runs/:runId/{pause,resume,interrupt,cancel,complete,fail}` + step commands — ALL exist.
**Service/adapter:** V2-005 run lifecycle commands (command-envelope-guarded).
**Authoritative owner:** V2-005.
**Observed behavior:** display-only states; the E2E specs drive lifecycle commands executor-side via API.
**Expected behavior:** the waiting/running presentations compose the existing resume (approve), pause, and cancel commands with the command-envelope contract.
**Root cause:** the UX shipped the read/derive side of V2-005; the command side was left to executor fixtures.
**Existing capability overlooked?** yes.
**Minimal proposed repair:** compose `resume` (+ `cancel`) into the waiting/running presentations with the envelope contract; an Approve action at the waiting surface. (Whether "approve" should be a distinct semantic vs resume-with-confirmation is an Architect question — the V2-005 pause/resume contract already exists.)
**Alternative designs considered:** a dedicated approval command (new authority concept — REQUIRES governed change; not proposed); resume-with-human-confirmation (existing contract).
**Architecture impact:** none for the composition repair.
**Security/authority impact:** none — same org-scoped command routes.
**Regression tests:** browser test: waiting run → user approves/resumes → run proceeds (today only executor-side tests cover this).
**Browser re-test:** R6.
**Deployment implication:** blocks the run journey's core loop.

### FINDING-009

**Journey IDs:** TEACH-2
**Severity:** MINOR
**Classification:** UX_DEFECT (feedback copy bug)
**User impact:** practice feedback for the `collect_posts` question says "…for step \"send_report\"".
**Frontend path:** TeachExperience practice feedback template.
**Root cause:** step reference in the feedback string.
**Minimal proposed repair:** correct the referenced step id/name.
**Architecture/Security impact:** none.

### FINDING-010

**Journey IDs:** VER-2
**Severity:** MINOR
**Classification:** UX_DEFECT (presentation)
**User impact:** "What changed" renders raw internal JSON (`Not equivalent: node collect_posts inputs: [{…}] != [{…}]`).
**Frontend path:** VersionsExperience "What changed" rendering of the V2-011 comparison payload.
**Root cause:** the transport payload is rendered verbatim.
**Minimal proposed repair:** human-readable diff summary (node/field names), keeping the honest non-equivalence statement.
**Architecture/Security impact:** none.

### Recorded observations (not classified as defects)

1. **Assessment exact-token grading** (TEACH-3): the recall assessment is graded by exact string equality with the declared semantics token, while the prompt says "describe each one from memory"; the corrections then disclose the expected token, making the final pass a copy-through. Completable and honest, but the interaction design is Architect-disposition territory.
2. **Drafts/Archived masking** (LIB-3): the honest Unavailable sections are masked by the generic library empty state until at least one workflow exists.
3. **Offline full-page loads** show the browser error page (in-app SPA degradation is honest — NET-1).
4. **React Router v7 future-flag warnings** in console (benign, upgrade notice).

## Architectural proposals

| Finding | Worker proposal | Existing authority reused | New authority proposed | Minimal alternative | Confidence |
|---|---|---|---|---|---|
| F-001 | extend deployment composition root to pass the seven V2 product route-deps groups | all V2 product authorities as-is | no | — (no alternative serves deployment) | high |
| F-002 | explicit org-creation onboarding step consuming `POST /organizations` | organizations authority | no | server-side default-org auto-provision (larger semantic surface) | high |
| F-003 | caller-org resolution for detail-page org-scoped reads | V2-002/V2-005/V2-009 reads + membership | no | server workflow-scoped installations read (new route) | high |
| F-004a | correct the false boundary sentence (copy) | — | no | — | high |
| F-004b | authoring: Architect chooses expert-IR-editor (composition) vs governed capture→IR authority vs deferral | V2-002 create/createVersion (option a) | possibly (option b, governed) | deferral with honest copy | medium (disposition required) |
| F-005 | derive Home approvals/updates from existing reads | V2-005/V2-002 reads + existing derivations | no | dedicated aggregate route | high |
| F-006 | none (honest); optional governed device-status read if wanted | — | optional (governed) | keep honest unavailable | high |
| F-007 | installed-card names via public workflow read | V2-002 public read | no | — | high |
| F-008 | compose resume/cancel into waiting/running UX with command envelopes | V2-005 lifecycle commands | no | governed approval-command concept (not proposed) | high |
| F-009 | fix feedback step reference | — | no | — | high |
| F-010 | human-readable What-changed rendering | V2-011 comparison payload | no | — | high |

## Explicit list of existing capabilities the current UX fails to consume

1. **The entire V2 product route surface in deployment** (F-001): V2-002/V2-005/V2-009/V2-006/V2-010/V2-011/V2-012 route deps are never passed by `src/index.ts`/docker-compose.
2. **`POST /organizations`** (F-002): no onboarding consumer.
3. **V2-005 lifecycle commands** (F-008): pause/resume/interrupt/cancel/complete/fail have no frontend consumer.
4. **V2-002 `createWorkflow`/`createVersion` routes** (F-004): proven in dogfooding; no frontend consumer (workflows enter only via install/fork; versions only via optimization adoption).
5. **Public `GET /workflow-repository/workflows/:id`** (F-007): available for installed-card name resolution; not consumed by the card.
6. **Runs/versions/installations reads for Home attention surfaces** (F-005): consumed elsewhere; not by Home.

## Release-blocking findings

- F-001 — deployment composition gap (all V2 product routes 404 on every deployment entry).
- F-002 — no organization onboarding (fresh users silently blocked from all product value).
- F-003 — installed-workflow detail page 403s on publisher-org reads (marketplace purchase journey dead-ends).
- F-008 — run lifecycle commands absent from the UX (approval loop unclosable by the user).

## Worker conclusion

**The V2 product is NOT release-ready.** Four composition-level release blockers (F-001, F-002, F-003, F-008) and one honesty defect (F-004a) stand between the current state and a deployable product. Every blocker is a wiring/composition defect over ALREADY-IMPLEMENTED frozen authorities — per this worker's analysis none requires a new authority or architecture change; the one genuine product gap (capture→WorkflowIR authoring, F-004b) is currently surfaced honestly by the fail-closed boundary except for the single false promise sentence.

Unresolved blockers for the Architect: (1) the F-004b authoring disposition (composition vs governed authority vs deferral); (2) whether F-006's device surface should become a governed public read; (3) the assessment exact-token interaction design; (4) sequencing of the four repair slices (worker's suggested order: F-001 → F-002 → F-003 → F-008, with copy fixes F-004a/F-009/F-010 ride-along-eligible only if the Architect permits in-boundary corrections, else separate slices).

**Delivery note (honest limitation):** the worker's GitHub PAT (`GITHUB_TOKEN`) was rejected by the GitHub API with `401 Bad credentials` during this session (both `token` and `Bearer` schemes), and no git push credentials are configured on the clone; the durable report is therefore committed to the local audit branch `audit/V2-REALITY-AUDIT-001` (branch head recorded below) and could NOT be pushed or posted to Issue #15. The Architect must either re-issue a token (environment variable only — never committed) or pull/merge the branch directly; the report content above is the complete durable artifact either way.

## Evidence artifacts (sha-256)

```text
e295dab43038df1c36d1614f96b3f669ab2c1aa941c9bd06c8090852fa07582a  assets/v2-reality-audit-001/f002-creation-boundary.png
9fe5207d7984c30fac0c3f9125753975d600931a599a73f71ba53b23c37d212f  assets/v2-reality-audit-001/f003-installed-workflow-detail-broken.png
d0348525acb4312f6a6d1accbb039697b8fdd079a580d41a908cf0c60923bd92  assets/v2-reality-audit-001/home-attention-surfaces.png
0ecf95eddfbf855eb1ab4ff33a97e03e0c84f815ff872da4e7fd1d8d9f96d280  assets/v2-reality-audit-001/listing-detail-installed.png
5e2e72bb25a371d5e15527e9cacbb4efbe20427cac54c08be2b196c5b3d5b6d8  assets/v2-reality-audit-001/mobile-home.png
1ffb5eb544363f50adc3527f27512c0eee6fcd8cbc08ef5f596c6ca46c6e132a  assets/v2-reality-audit-001/mobile-detail.png
```

Additional in-repo reconstruction evidence: the V2-017 dogfooding transcript (`spec/architecture/v2/dogfooding-evidence/V2-017-universal-product-ux.md`), the E2E spec compositions (`backend/tests/e2e-browser/*.spec.ts` — each composes a subset server; none opens an installed workflow's detail page), and the route-deps optionality in `backend/src/api/server.ts` vs the composition root `backend/src/index.ts`.
