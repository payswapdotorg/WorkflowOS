# V2-REALITY-AUDIT-001-R6 — The Full Reality Re-Audit (Repeat Audit)

**Work Order:** `spec/architecture/v2/work-orders/V2-REALITY-AUDIT-001-R6.md`
**Parent gate:** V2-REALITY-AUDIT-001 — R0–R4 complete, dispositioned, and
REPAIRED: all nine REALITY-REPAIR Work Orders are Architect-merged
(RR-001 `915ed1d0` · RR-002 `773ca7d8` · RR-003 `a9933dae` · RR-004
`288dffd` · RR-005 `ba95c83` · RR-006 `0dce4c8` · RR-007 `a2cc8ec` ·
RR-008 `3ee3e22` · RR-009 `cbbcacf`), per the canonical
`spec/development-state/v2-autonomous-execution-state.json`
(`REALITY_REPAIRS_COMPLETE_R6_AUTHORIZED`) and Git history itself.
**Base:** `main` at the exact merged head `5ec0a49` ("Finalize autonomous
execution state after reconciliation") — the first main head carrying ALL
NINE repairs.
**Branch:** `audit/V2-REALITY-AUDIT-001-R6`
**Runner:** `backend/tests/integration/deployment/run-reality-audit-r6-browser-smoke.ts`
(the R6 required-evidence producer; port discipline — the specialist
authored it and did NOT run it; the orchestrator ran it at the exact
head and applied eleven deterministic runner-pin corrections, all
committed with full explanations — see §5b)
**Run:** EXECUTED BY THE ORCHESTRATOR at the exact head `968eb85`
(2026-09-07T02:34:02.990Z → 2026-09-07T02:34:45.563Z, duration 42573ms)
— **exit code 0: 48 journeys, 45 PASS + 3 EXPECTED_UNAVAILABLE, 0 FAIL,
0 BLOCKED** (journey.json + 38 screenshots + sha-256 digests in
`assets/reality-audit-r6/`)
**Baselines compared against:**
`docs/v2/V2-REALITY-AUDIT-001-WORKER-REPORT.md` (the R0–R4 journey
matrix) and `docs/v2/V2-REALITY-AUDIT-001-ARCHITECT-DISPOSITION.md`
(the F-001..F-010 dispositions and release blockers).
**Files:** the audit runner (1 new test-family file) + this evidence
record + the assets README. **Zero product changes of any kind — R6 is
reconnaissance-only per the Work Order ("No implementation, ad-hoc
fixes, architecture changes, deployment provisioning, or roadmap
reinterpretation during the audit"). Any newly discovered defect becomes
a separate Architect-authorized corrective Work Order.**

## 1. The audit's job (the Work Order's own requirements)

> "Repeat the real-browser reality audit against the merged product and
> real deployment composition to determine whether the accepted findings
> are actually resolved and whether any critical UX-to-operational
> architecture mismatch remains."

Required evidence (the Work Order's list): fresh exact main head; real
deployment topology; real browser transcript; journey matrix with
pass/fail/blocked/unavailable status; evidence hashes; exact comparison
against R0–R4 findings; explicit confirmation that no critical mismatch
remains or a durable new finding set if one does.

The topology is the REAL one (identical to the repair smoke family):
the REAL deployment entry `bun src/index.ts`
(`WORKFLOWOS_DEV_RUNTIME=pglite`, `WORKFLOWOS_ROLE=all`, fresh temp data
dir, `:3001` — the Vite dev proxy's fixed target) + the ACTUAL Vite dev
server serving the product SPA (`:5188`) + a REAL headless Chromium
(Playwright; 1280×800 primary, 390×844 for RESP-1). Both personas act
through real routes and the real browser UI only.

**Honest inventory note (carried from the runner's header):** the R0–R4
report's summary row says "41 journeys (31 pass / 4 fail / 3 blocked /
3 expected-unavailable)" while its own matrix table enumerates **48
journey rows** (the summary arithmetic does not add up to the table).
The auditable inventory is the TABLE's journey-id enumeration, so R6
re-runs the COMPLETE matrix — all 48 journey ids — with the
POST-REPAIR expectations (the nine merged repairs changed what "correct"
looks like for the previously failing journeys).

## 2. The journey matrix (the R6 re-run)

Runner command:
`cd backend && bunx tsx tests/integration/deployment/run-reality-audit-r6-browser-smoke.ts`
— exit code 0 only when every leg passes (PASS or EXPECTED_UNAVAILABLE
as designed); non-zero otherwise with the failing journey ids printed.

| ID | Journey | R0–R4 status | R6 expected (post-repair) | R6 observed | R6 status |
|---|---|---|---|---|---|
| DEP-1 | the real deployment entry serves the V2 product routes (F-001/RR-001) | FAIL (F-001) | the real entry: /health 200, /health/ready 200, POST /auth/password/register 201, and after a real login an auth-gated 200 for one read per V2 product route group (the RR-001 route list); GET /marketplace/listings answers 401-not-404 unauthenticated | health 200; health/ready 200; register 201; auth-gated 200s: V2-002 org workflows read, public workflow read, versions read, V2-005 runs read, V2-009 deployments read, V2-006 teaching session create+read, V2-010 reverse-teaching session create+read, V2-011 analyze+proposals, V2-012 marketplace listings; unauthenticated GET /marketplace/listings 401-not-404 | **PASS** |
| AUTH-1 | register through the real UI → Home | PASS | account + session; lands on Home | registered through the real register UI; landed on Home ("What do you want to get done?") | **PASS** |
| HOME-1 | goal/search entry + mode buttons | PASS | entry renders with the three capture-mode buttons | the goal/search entry renders with the Describe it / Show me / Describe + show mode buttons (the RR-004-era honest labels) | **PASS** |
| HOME-2 | attention: honest empty states when empty | PASS | honest empty states (the fresh zero-org session) | the fresh session renders the honest empty states: "No workflows yet…", "Nothing needs your attention right now.", "No run is waiting at an approval step right now.", "No updates available right now…" | **PASS** |
| HOME-5 | attention: Device issues honest unavailable (F-006 assert-as-is) | EXPECTED UNAVAILABLE | honest unavailable — the deferral is the product decision, NOT a defect | the Device issues panel renders its honest Unavailable state ("Unavailable" + "…they’ll appear once device status becomes part of the product") — F-006 assert-as-is, unchanged | **EXPECTED_UNAVAILABLE** |
| AUTH-2 | sign out → the login screen | PASS | login screen | Sign Out returned the consumer to the real login screen | **PASS** |
| AUTH-3 | sign in with password → Home | PASS | Home | signed in with the password through the real login surface; landed on Home | **PASS** |
| AUTH-4 | wrong password → the honest error | PASS | "Invalid email or password." | the wrong password rendered the honest error "Invalid email or password." (the uniform 401, no enumeration); the correct password then signed in | **PASS** |
| AUTH-5 | duplicate registration → the honest error | PASS | "An account with this email already exists. Try signing in." | the duplicate registration rendered the honest 409 error "An account with this email already exists. Try signing in." | **PASS** |
| AUTH-6 | session survives reload | PASS | session retained (HttpOnly cookie) | the session survived a full page reload (still on Home behind the shell) | **PASS** |
| MKT-1 | Explore browse: listing cards render | PASS | card renders with price, model, publisher line, pinned version, trust sentence | the Explore card rendered: the listing name, $19.00 · One-time purchase, "Listed by another organization", Version 1, and the publication-is-not-proof sentence | **PASS** |
| MKT-2 | listing detail: full §22 disclosure | PASS | offers + boundary, needs-access incl. the sensitive messaging.send, works-with, version-and-trust | the listing detail rendered the full §22 disclosure: $19.00 One-time purchase + the entitlement boundary, Needs access to (github.repository.read + the SENSITIVE messaging.send flag + line), Works with (cloud_allowed), Version and trust (the pinned-version + digest sentence + publication-not-proof) | **PASS** |
| MKT-3 | purchase with NO organization → the first-run onboarding flow (F-002/RR-002) | BLOCKED (F-002) | no silent no-op: the actionable Organization onboarding renders in Your access; the org is created through the real UI; the per-org decision resolves | the no-org session at the listing: NO perpetual "Checking your access…" — the Organization onboarding rendered inside Your access ("Set up your organization"); the org was created through the real UI; the per-org decision resolved to the honest "This listing has no free offer." denial (an actionable decision, never a silent no-op) | **PASS** |
| MKT-4 | purchase with org → entitled | PASS | "You're entitled to this workflow." + the one-time-purchase basis | "Get workflow" drove the REAL offer acceptance (the deterministic reference payment adapter settled the $19.00 charge); the decision re-read shows "You’re entitled to this workflow." + "Access through your one-time purchase." | **PASS** |
| MKT-5 | install pinned version | PASS | installed, pinned; the execution-separate sentence | the EXISTING V2-002 Install pinned version 1 into the CONSUMER org: "Installed — pinned to version 1" + "Running it stays a separate decision…" + "Open in your Workflows library" | **PASS** |
| LIB-2 | Installed tab: the REAL workflow name (F-007/RR-006) | PASS (defect noted, F-007) | installed cards with the workflow’s real name — never the generic fallback | the Installed tab card shows the REAL name "R6 audit approval digest" (never the generic "Installed workflow" fallback) + "Version 1 — pinned" + "Enabled" + the Open link | **PASS** |
| DET-2 | INSTALLED (marketplace) workflow detail loads against caller-org reads (F-003/RR-003) | FAIL (F-003) | the detail loads (heading, description, Public line, steps, the consumer pin, honest no-facts states — no honest-error state) with ZERO publisher-org requests | the cross-org INSTALLED detail LOADED: heading + description + "Public — any signed-in user" + the 5 presentation-label steps + "Installed: Version 1 — pinned · Enabled" + "Not run yet" + "not deployed yet" + NO alert; the network capture: ZERO /api/organizations/{publisher}/ requests, the caller-org runs + installations reads present, the public workflow read present | **PASS** |
| CREATE-1 | Tell creation → preview → the truthful boundary (F-004a/RR-004) | PASS (honest boundary) | honest capture; the corrected boundary copy; the fail-closed commit boundary holds (ZERO create POSTs) | the Tell preview rendered "Here’s what I understood" with the corrected honest copy ("Natural-language capture isn’t converted into executable WorkflowIR — no generation authority exists — so nothing is created from this page", "Durable creation isn’t available for captured input", "Nothing is committed") — NO false promise; ZERO workflow-repository POSTs left the flow | **PASS** |
| CREATE-2 | Show creation: honest no-recording note | PASS | "No screen recording exists yet — describe what you did…"; steps captured; the same boundary | the Show mode rendered the honest no-recording note; a demonstration step was captured and echoed in the preview; the same fail-closed boundary rendered | **PASS** |
| CREATE-3 | Tell + Show combined capture, the same boundary, PLUS the RR-004 expert IR authoring path | PASS | combined capture, the fail-closed boundary, and the corrected expert entry leading to a REAL authoring surface: the expert authors a valid WorkflowIR through the V2-002 create path and the workflow appears in the library | the Tell+Show preview carried both inputs with the same boundary; the boundary’s expert entry navigated to /expert where the consumer authored a real WorkflowIR; the REAL V2-002 create route created "R6 audit expert digest" ("born with immutable version 1", a wfw_… id) and the created workflow resolves through the real reads | **PASS** |
| RUN-1 | run preview → request → start (Running) | PASS | consequential preview then Running (the real V2-005 request + start through the browser) | the Run preview rendered the 5 steps + Version 1 + "Approval required" + Needs access to + "Where it runs isn’t set up yet — this workflow has no deployment."; the confirm drove the REAL request+start; the run-status surface rendered Running (the API runs read agrees) | **PASS** |
| RUN-2 | Running + trust disclosure | PASS | honest evidence state: "How do you know?" + "No evidence records yet" + the advanced surface | the run-status surface carries the §17 trust presentation: "How do you know?" + "No evidence records yet for this run." + the "Advanced details" surface | **PASS** |
| RUN-3 | run state survives reload | PASS | state retained (Running) | a full page reload re-derived the run-status surface with Running retained (the authoritative runs read) | **PASS** |
| RUN-4 | the user drives the run lifecycle: Pause → Resume → the approval gate → Approve; Pause/Stop reachable (F-008/RR-007) | FAIL (F-008) | the user-facing Approve/Resume/Pause/Stop controls exist and drive the REAL V2-005 commands; the waiting run is resumable by the human | the user PAUSED (Paused, history-verified) → RESUMED (Running) → the run parked at the approval gate ("Waiting for you" + the Approve control) → the user’s APPROVE returned the run to execution (the ordered pause→resume→pause-at-review_gate→resumed timeline) → the Stop control opens the §2.4 explicit choice ("Keep it going" preserved the run) | **PASS** |
| HOME-3 | attention: Pending approvals composes real approvals content (F-005/RR-005) | FAIL (F-005) | a pending approval appears with actionable language (the RR-005 composed surface) | Home’s Pending approvals showed the approval-waiting run: "Waiting for you" + the workflow name + "It’s paused for your approval before it continues." + the "Open the run" link (href /workflows/{id}?run={runId}) — NO Unavailable claim, NO false "not part of the product" copy; Needs attention shows Paused; the Open-the-run deep link re-opened the waiting run and the user’s Ap… | **PASS** |
| RUN-5 | failure presentation + recovery (Try again works) | PASS | honest failure + recovery: the reason verbatim, "Try again" starts a new run, "Edit workflow" → /expert | the executor-side fail rendered "Couldn’t complete" + the recovery surface ("I couldn’t finish this." + the reason verbatim + "Try again" + "Edit workflow" → /expert); "Try again" started a NEW run (Running, a distinct run id) | **PASS** |
| WHEN-1 | schedule editor → save ("Runs every day · 9:00 AM UTC" + Pause; deployment + subscription created) | PASS | real V2-009 composition: the schedule sentence + Pause; the deployment + subscription created through the real routes | the When editor (On a schedule · Every day · 09:00 UTC) saved through the REAL create-or-converge routes: the subscription line "Runs every day · 9:00 AM UTC" with a Pause control; the caller-org deployment + schedule subscription verified through the real reads | **PASS** |
| TEACH-1 | lesson + checkpoints + pause/resume | PASS | governed lesson flow: Start lesson → the steps → "I've done it" × the lesson → pause/resume mid-lesson → All steps confirmed | Teach Me opened (bound to the pinned Version 1); Start lesson → "Step 1 of 5 — Collect the open tickets"; a mid-lesson Pause → the paused note → Resume; 5 × "I’ve done it" → "All steps confirmed" | **PASS** |
| TEACH-2 | practice feedback references the CORRECT step (F-009/RR-008) | PASS (defect noted, F-009) | the attempted question’s own verbatim feedback (the authority template names the ATTEMPTED step); the other question carries NO feedback | the send_report question answered wrong rendered its own verbatim feedback (naming send_report, quoting messaging.send); the collect_posts question’s section carried NO feedback; the collect_posts correct answer rendered "Correct: … for step \"collect_posts\""; the wire carried the attempted nodeId | **PASS** |
| TEACH-3 | assessment → Lesson complete | PASS | terminal on pass: "Lesson complete" with no lifecycle commands remaining | the exact-token assessment (5 ordered positions + 5 declared-semantics answers) passed → "Lesson complete"; no Pause/"I've done it" controls remain | **PASS** |
| TEACH-4 | teaching evidence visibly separate from run evidence | PASS | the distinct Teaching evidence surface with the separation vocabulary | the "Teaching evidence" region rendered with "Kept separate from run evidence — learning never counts as execution" | **PASS** |
| MKT-6 | Make my own (fork) with provenance | PASS | provenance-carrying copy: name input → "Create copy" → "Open your copy"; forkedFrom* verified through the real read | the "Make it my own" flow created the copy in the CONSUMER org ("Open your copy" appeared); the fork detail loads (Private — only you); the real read confirms forkedFromWorkflowId/forkedFromVersionId point at the publisher workflow + version 1 | **PASS** |
| LIB-1 | My Workflows tab: cards with facts | PASS | cards with facts (the fork + the expert-authored workflow: name, Last run, schedule word, Open) | the My Workflows tab lists the fork "My R6 audit copy" and the expert-authored "R6 audit expert digest" with the honest facts ("Not run yet", "Runs when you start it", the slug, the Open links) | **PASS** |
| LIB-3 | Drafts / Archived: honest unavailable | PASS (honest unavailable) | honest Unavailable sections (never fabricated) — the workflow model carries no draft/archived state | the Drafts and Archived tabs render their honest Unavailable states ("Drafts aren’t distinguishable in the workflow records yet — they’ll appear here once draft state becomes part of the product" / the archived twin) | **EXPECTED_UNAVAILABLE** |
| DET-1 | own-org workflow detail: full surface (the consumer’s fork + the publisher’s own-org content) | PASS | purpose, presentation steps, When/Where, Recent activity, Version, Access and safety, Updates, Improvements, primary actions — with real content on the publisher’s own-org pass | the consumer’s fork detail rendered the full surface (heading, Private line, the 5 steps, "Runs when you start it", "Not run yet", "Version 1 — immutable", "No installs — run it from the library", Access and safety, Updates, Improvements, Teach Me/Share/Edit); the publisher’s own-org detail (a second real browser session) rendered WITH content: the seeded schedule "Runs ever… | **PASS** |
| VER-1 | update banner with pin language (v2 available) | PASS | banner + pin language: "An update is available", Version 2, "Your installed version: Version 1 — pinned", "Nothing changes until you approve the update" | the publisher shipped v2 (the task-text change) through the REAL createVersion route; the consumer’s detail shows the §19 banner: "An update is available" + Version 2 + "Your installed version: Version 1 — pinned" + "Nothing changes until you approve the update" | **PASS** |
| VER-2 | Review update / What changed: the human-readable version diff (F-010/RR-009) | PASS (defect noted, F-010) | the EQUIVALENT posture stays "Task-for-task equivalent - verified"; the NON-EQUIVALENT posture renders the field-level readable diff (the step NAME, the field, the readable values — NO raw internal JSON) while the authoritative comparison payload remains on the wire | v1→v2 (the task-text change): "Task-for-task equivalent - verified" — no divergence block, no raw JSON; v1→v3 (the step-input literal change): "Not equivalent" + "Where the versions differ: the step \"Collect the open tickets\" — its inputs" + the readable Installed/New values (payswapdotorg/WorkflowOS → pectoraux/WorkflowOS) — NO \"!=\" blob, no raw node id; the wire captur… | **PASS** |
| HOME-4 | attention: Updates composes versions/installations reads (F-005/RR-005) | FAIL (F-005) | an installed-behind-head workflow appears in Updates with the pinned-never-auto-updated vocabulary + the Open-the-workflow link; NO adoption action on Home | Home’s Updates showed the installed-behind-head workflow: "Update available" + the name + "Version 3 is available — your installed Version 1 stays pinned (it never auto-updates)" + "Nothing changes until you approve the update" + the "Open the workflow" link — no adoption action on Home, no Unavailable claim | **PASS** |
| VER-3 | approve update → new pin | PASS | "You're on the newest version."; the Installed pin moves to Version 3 through the EXISTING commands | the user clicked "Approve update" → the EXISTING V2-002 install command re-pinned to Version 3 → "You’re on the newest version." + "Installed: Version 3 — pinned · Enabled" (verified through the real installations read) | **PASS** |
| ACT-1 | activity timeline: entries + links | PASS | version entries + run entries + "Open the run" | the Activity timeline lists the version entries (the fork + the expert workflow’s immutable v1s) and the run entries with their state words + the "Open the run" links | **PASS** |
| ACT-2 | activity → run deep link | PASS | navigates to /workflows/:id?run=:runId and shows the run-status surface | the "Open the run" link navigated to /workflows/{id}?run={runId} and the run-status surface rendered the selected run | **PASS** |
| ACT-3 | teaching/device on Activity: honest unavailable | EXPECTED UNAVAILABLE | "Teaching activity isn’t shown here yet — teaching records don’t offer a timeline read. Device events aren’t shown here yet either." | the Activity page renders the honest teaching/device disclosure sentence verbatim (no fabricated timeline entries) | **EXPECTED_UNAVAILABLE** |
| EXPERT-1 | expert bridge page renders | PASS | the bridge renders with the mode-crossing disclosure + the developer-workspace entry | the /expert surface renders the "Developer workspace" bridge card with the explicit mode-crossing sentence + the "Open developer workspace" link (and the RR-004 authoring surface beside it) | **PASS** |
| EXPERT-2 | project creation through the UI | PASS | project created; the engineering shell renders | the project was created through the real /projects form (New Project → the org + name → Create) and the Project Overview shell rendered | **PASS** |
| EXPERT-3 | engineering surfaces load against the REAL entry (the R0-R4 BLOCKED was a composition artifact) | BLOCKED (composition artifact) | the V1 engineering routes answer on the real entry: the Overview’s project + architectures reads resolve and the architect surface renders without "Error: Not found" | the project Overview consumed GET /projects/:id + GET /projects/:id/architectures and rendered (no ErrorState); the /projects/:id/architect surface rendered its "Architect" heading with NO "Error: Not found" — the V1 engineering routes were always wired in the real entry (R0-R4’s 404 was the product-test-composition artifact) | **PASS** |
| RESP-1 | mobile 390×844: Home/Detail/Create/Explore render with no horizontal overflow | PASS | no horizontal overflow; the mobile primary nav present | at 390×844 all four surfaces rendered with documentElement.scrollWidth ≤ clientWidth (no horizontal overflow) and the mobile primary nav (Home / Workflows / Create / Explore / Activity) present | **PASS** |
| NET-1 | in-app navigation while offline → honest degraded states | PASS | per-surface honest degraded states with Try again (never fabricated success) | offline in-app navigation rendered the honest degraded states: Workflows ("Couldn’t load this right now." + Try again), Explore ("Listings are unavailable" + the not-an-empty-result note + Try again), Activity ("Workflows unavailable — couldn’t load the workflow list." etc.), the workflow detail ("Couldn’t load this workflow right now." + Try again — reached through client-s… | **PASS** |
| COMP-1 | companion handoff deep link → the honest bridge | PASS | "Companion not installed" + instructions | the /companion/handoff deep link rendered the honest bridge: the "Companion not installed" badge + the "WorkflowOS Companion not installed" instruction card | **PASS** |

The runner emits the machine-readable transcript
(`journey.json` — one record per journey with id/journey/expected/
observed/status + every screenshot's sha-256 digest) and the full
screenshot set into
`spec/architecture/v2/dogfooding-evidence/assets/reality-audit-r6/`.

## 3. Exact comparison against the R0–R4 findings (F-001..F-010)

| Finding | R0–R4 classification | Architect disposition | Canonical repair (merged) | R6 evidencing journey(s) | Post-repair expectation |
|---|---|---|---|---|---|
| F-001 | MISSING_ADAPTER_OR_COMPOSITION (CRITICAL, release-blocking) | ACCEPT | RR-001 — deployment composition (`915ed1d0`) | DEP-1 (+ every journey runs behind the real entry) | the real deployment entry constructs and passes all seven V2 product route-deps groups; every product surface answers behind `src/index.ts` (the docker-compose CMD topology) |
| F-002 | MISSING_ADAPTER_OR_COMPOSITION (CRITICAL, release-blocking) | ACCEPT | RR-002 — first-run organization onboarding (`773ca7d8`) | MKT-3 (+ AUTH-1..6, HOME legs which need an org context) | a fresh user with no organization is onboarded through the real UI (existing `POST /organizations`); the silent no-op is gone |
| F-003 | WIRED_TO_WRONG_COMMAND_OR_READ (CRITICAL, release-blocking) | ACCEPT | RR-003 — caller-org detail reads (`a9933dae`) | DET-2 (+ the runner's network-capture assertion) | the installed cross-org workflow detail resolves org-scoped facts against the CALLER's org; zero publisher-org-scoped requests; own-org detail (DET-1) remains green |
| F-004a | UX_DEFECT (copy) | ACCEPT | RR-004 — creation copy correction (`288dffd`) | CREATE-1..3 | the false "later executable authoring" implication is removed; the fail-closed honest boundary is preserved verbatim |
| F-004b | TRUE_ARCHITECTURE_GAP | SPLIT / DEFER AI AUTHORITY | RR-004 (bounded expert IR authoring surface only) | CREATE-1 (expert authoring leg) | composition-only expert WorkflowIR authoring over V2-002 create/createVersion; the NL capture→IR path remains deferred (no new authority) |
| F-005 | UX_DEFECT (Home attention) | ACCEPT | RR-005 — Home approvals/updates composition (`ba95c83`) | HOME-3, HOME-4 | Pending approvals and Updates attention compose the EXISTING runs/approvals and versions/installations reads — real content, no aggregate authority, no fabrication |
| F-006 | EXPECTED_UNAVAILABLE_SURFACE | ACCEPT AS-IS (explicit deferral) | none (by disposition) | HOME-5 | Device issues REMAINS honestly unavailable — asserted as the expected state; a public device-status read stays deferred and must NOT be invented |
| F-007 | UX_DEFECT (installed naming) | ACCEPT | RR-006 — installed workflow naming (`0dce4c8`) | LIB-2 | installed cards consume the existing public workflow read and show the real workflow name |
| F-008 | MISSING_ADAPTER_OR_COMPOSITION (CRITICAL, release-blocking) | ACCEPT | RR-007 — run lifecycle controls (`a2cc8ec`) | RUN-4 | the human-approval loop is closable BY the human: user-facing Approve/Resume (+ safe Pause/Stop) controls compose the existing V2-005 command routes; no new approval authority |
| F-009 | UX_DEFECT (teaching feedback) | ACCEPT | RR-008 — teaching feedback step reference (`3ee3e22`) | TEACH-2 | practice feedback names the correct step reference |
| F-010 | UX_DEFECT (raw diff JSON) | ACCEPT | RR-009 — human-readable version diff (`cbbcacf`) | VER-2 | "What changed" renders a human-readable node/field summary; the authoritative comparison payload and honest non-equivalence statement are preserved |

## 4. The four release blockers (the disposition's explicit gate)

The Architect's disposition names these "open and release-blocking until
verified fixed on the real deployment topology and full browser
journey":

1. **F-001 — deployment composition gap** → evidenced by DEP-1 at R6:
   the real entry answered auth-gated 200s for EVERY product route group
   (and 401-not-404 unauthenticated). **R6 result: PASS — VERIFIED
   FIXED on the real deployment topology**
2. **F-002 — no organization onboarding** → evidenced by MKT-3 at R6:
   the no-org session was onboarded through the real UI (the
   OrganizationOnboarding flow; the silent no-op is gone). **R6 result:
   PASS — VERIFIED FIXED on the real topology + full browser journey**
3. **F-003 — marketplace installed-workflow detail uses publisher org
   reads** → evidenced by DET-2 at R6: the cross-org detail LOADED with
   caller-org reads (zero publisher-org-scoped requests in the wire
   capture). **R6 result: PASS — VERIFIED FIXED**
4. **F-008 — user-facing run lifecycle/approval controls absent** →
   evidenced by RUN-4 at R6: the user drove the FULL lifecycle — Pause →
   Resume → the approval gate ("Waiting for you") → Approve → the run
   continued — with Pause/Stop reachable. **R6 result: PASS — VERIFIED
   FIXED (the human-approval loop is closable by the human)**

## 5. The run record

**Status: RUN BY THE ORCHESTRATOR at the exact head `968eb85` — exit
code 0, 48 journeys: 45 PASS + 3 EXPECTED_UNAVAILABLE, 0 FAIL, 0
BLOCKED** (2026-09-07T02:34:02.990Z → 2026-09-07T02:34:45.563Z, duration
42573ms; the topology booted clean: the REAL deployment entry on :3001
in 6.6s, the REAL Vite SPA on :5188, the publisher seed through the
REAL routes in 0.7s; 51 journey steps). The machine-readable
transcript — every journey's id/journey/expected/observed/status plus
every screenshot's sha-256 digest — is persisted at
`spec/architecture/v2/dogfooding-evidence/assets/reality-audit-r6/journey.json`
alongside the 38 numbered screenshots (01-signup-home …
39-companion-handoff).

### 5b. The orchestrator's runner-pin corrections (eleven, all zero-product-code)

The first full run surfaced runner defects, NOT product defects — each
was diagnosed with an instrumented diagnostic copy (never committed),
corrected on the same branch with a full explanation, and re-run. The
fd014fa correction pattern from the repair wave:

| Commit | Correction | Product behavior (unchanged) |
|---|---|---|
| `8f7cb61` | DEP-1's listings assertion pinned the flat row shape; the route nests each row as `{listing: {id}}` | the route answered 200 with the published listing |
| `e5925ce` | RUN-5 read the runs list before the UI's async request→re-read→start Try-again flow landed (now polled); WHEN-1 over-pinned the editor's transient "Scheduled · …" note (dropped by the save's refetch remount) | Try again starts a new run; the subscription line + Pause persist — the R0–R4 audited expectation |
| `e63fba1` | DET-1 asserted the SOURCE's description on the FORK (the fork command carries the name only; the page honestly omits a null description) | the fork detail's full structural surface renders |
| `1394ea1` + `7a180bc` | The §19 section's accessible name is "Update available" (its heading reads "Updates"); the blanket rename was then restored for the HOME attention panel (whose region IS "Updates") | both surfaces render their honest states |
| `962195a` | VER-2 stored Playwright Response objects and read `.json()` after navigation (bodies invalidate on navigation); the capture now snapshots eagerly | the wire-vs-DOM F-010 proof held: raw envelopes on the wire, human-readable DOM |
| `df9c011` + `8d959f0` | VER-3's authoritative read pinned the wrong row shape and the first row; the re-pin is create-or-converge (old row → disabled, new row → enabled) | "Installed: Version 3 — pinned · Enabled" rendered; the enabled pin is version 3 |
| `d5521b8` + `54fc222` + `968eb85` | ACT-3's combined sentence spans JSX-split text nodes (Playwright matches per node) and the leg never returned to /activity after ACT-2's deep link | the disclosure paragraph renders verbatim |

**No product code was changed by any correction.** One minor
product-level observation is recorded honestly (no corrective Work
Order warranted — it is not a UX-to-operational mismatch): the When
editor's transient "Scheduled · …" confirmation note is dropped when
the save's refetch remounts the section; the authoritative subscription
line and Pause control persist.

## 6'. The explicit confirmation

Per the Work Order's exit criteria: **the audited journey set has NO
unresolved critical UX-to-operational architecture mismatch, and every
accepted repair claim is evidenced on the real deployment topology
through the real browser** — F-001 (DEP-1), F-002 (MKT-3), F-003
(DET-2), F-005 (HOME-3/HOME-4), F-007 (LIB-2), F-008 (RUN-4), F-009
(TEACH-2), F-010 (VER-2), F-004a/b (CREATE-1..3, honest boundary + the
bounded expert IR authoring path). F-006 remains honestly unavailable
exactly as the Architect dispositioned (ACCEPT AS-IS). EXPERT-3, BLOCKED
at R0–R4 as a composition artifact, now PASSES against the REAL entry
(the complete F-001 fix). **R6 disposition: PASS.** R7
(V2-REALITY-AUDIT-001-R7) must still record the Architect's
release-readiness decision; deployment remains locked until then.

## 6. Exit criteria mapping (the Work Order's own words)

- **PASS** when the audited journey set has no unresolved critical
  UX-to-operational architecture mismatch AND all accepted repair
  claims are evidenced (every previously-failing journey now passes
  with its post-repair expectation; the expected-unavailable surfaces
  remain honestly unavailable).
- **FAIL** when a critical mismatch remains: deployment stays locked
  and the smallest governed corrective packet(s) are created (a NEW
  finding discovered at R6 becomes a NEW Architect-authorized
  corrective Work Order — never a drive-by fix inside R6).
- **R6 does NOT itself unlock deployment.** R7
  (V2-REALITY-AUDIT-001-R7) must record the Architect's
  release-readiness decision; every DEP-* packet remains GATED until
  then.

## 7. CI / testing honesty (what the specialist ran — and did not)

- `backend` `bun run typecheck`: **2 pre-existing errors in
  `src/api/routes/workflow-deployments.route.ts`** (TS2739, present at
  the wave base `9cbfd12` and at every main head since the V2-009-era
  commit `85882da` — inherited baseline, NOT introduced by R6; the
  runner itself contributes zero type errors).
- `backend` `bunx eslint` on the runner: **0 errors, 13 no-console
  warnings** — the established family pattern (the runner prints the
  journey matrix to stdout).
- `frontend` `bun run typecheck`: clean (exit 0).
- The runner itself: **NOT executed** by the specialist (port
  discipline); no vitest battery run by the specialist (the
  orchestrator owns exact-head verification); no ports bound; no
  pushes; no product files touched.
- The ORCHESTRATOR then ran the runner at the exact head `968eb85`
  (exit 0 — the record in §5), applied the eleven zero-product-code
  runner-pin corrections of §5b (each committed with full
  explanations), and ran the exact-head verification battery recorded
  in the delivery record: `bun run typecheck` (backend: 0 new errors —
  the 2 pre-existing TS2739s are the inherited V2-009-era baseline,
  present at the wave base 9cbfd12; frontend: clean), `bunx eslint` on
  the runner (0 errors / 13 no-console warnings, the family pattern),
  and the full frontend deterministic battery at the exact head:
**437/437 (39 files) — every test green** (the merged sum of the nine
repairs' suites: the RR-009 branch recorded 398/398 at its own head;
the merged main adds the remaining repairs' suites).
