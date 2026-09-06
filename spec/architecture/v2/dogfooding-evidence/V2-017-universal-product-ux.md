# V2-017 — Universal Product UX (T15 full verification + product dogfooding) — Evidence

**Work Order:** V2-017 — Universal Product UX (POST-W6-PRODUCT)
**Task:** T15 — full verification and real product dogfooding (dispatched durably as Issue #9 on `payswapdotorg/WorkflowOS`)
**Classification of capability:** verification/integration slice (the final cross-feature product gate before T16); presentation/verification composition ONLY — zero frozen semantic or authority changes
**Validation type:** the work order's full required-verification battery at the exact base and head + a real-browser dogfooding experiment through the ACTUAL product
**Status:** EVIDENCE PERSISTED — all verification surfaces recorded honestly at the exact base and head; worker completion is review-ready only (the Architect remains the sole merge authority; agents never mark COMPLETE)

## Work Order ID / task identity

V2-017 — Universal Product UX, program map `spec/architecture/v2/post-w6-product-roadmap.md` (T15 "Full verification and product dogfooding"), execution contract `docs/superpowers/plans/2026-09-04-v2-017-repository-only-execution.md`, resident-worker protocol `docs/implementation/RESIDENT-ZAI-WORKER-PROTOCOL.md`, dispatch Issue #9.

- **Base:** `26ca694fb138ab4e48e63a30b3c7d431807280e8` (live `main` re-read immediately before branching; still HEAD of origin/main at push time).
- **Dependencies:** T2–T14 all COMPLETE by actual Git merge (machine state `spec/development-state/implementation-state.json`; T10 → PR #6 `5664eb79…`, T11 → PR #3 `2ece3c32…`, T12 → PR #8 `1cc6a95b…`, T14 → PR #4 `b8493d41…`, plus T2–T9/T13 upstream merges recorded canonically).
- **Change surface:** verification corrections to 3 inherited test defects (frontend test files only), the dogfooding runner + persisted artifacts, and this evidence document. **Zero product-code changes; zero backend source changes; zero route/authority/semantic changes.**

## Verification matrix (exact base → exact head)

| Verification | Command | At base `26ca694` | At head | Disposition |
|---|---|---|---|---|
| frontend typecheck | `bun run typecheck` | clean | clean | pass at both |
| frontend lint | `bun run lint` | 0 errors, 1 warning (pre-existing `ArchitecturePage` exhaustive-deps) | identical | pass at both (inherited warning) |
| frontend unit/component | `bun run test` | 357/361 + 1 suite-level collection failure (4 failed tests) | **362/362 (37 files)** | the 4 failures were inherited TEST-side defects — corrected in-boundary (see below); product code untouched |
| backend typecheck | `bun run typecheck` | 2 errors (`workflow-deployments.route.ts` L100/L107, TS2739) | identical | inherited pair, byte-identical with the documented pre-existing CI baseline (T4–T11 era); unchanged by T15 |
| backend lint | `bun run lint` | 0 errors, 4 warnings (no-console in dogfooding runners/e2e specs) | 0 errors, 11 warnings (adds the T15 runner's transcript prints — the established dogfooding-runner pattern) | pass at both |
| backend full suite | `bunx vitest run` (all include globs, chunked) | **4936 tests: 4932 passed, 4 failed** (all WORK-052 governance pins) | arch re-run 914/915 (same single failure); the diff contains no backend test-eligible files, so the base result carries | 4 inherited failures recorded; NOT corrected (out of the V2-017 boundary — see below) |
| architecture/static no-drift | `bunx vitest run tests/architecture` | 914/915 (WORK-052) | 914/915 (identical) | no new drift from T15 |
| browser E2E product sweep | `bunx playwright test tests/e2e-browser` | product code identical base↔head (diff = test files + evidence only) | **43/43 tests, 17 spec files: lifecycle, t6, t7, t8, t9, t10, t11 (4), t12 (2), t14, work-026/027/032/033 (12), work-048/049/050/074 (21)** | full sweep green at head |
| real product dogfooding | `bunx tsx tests/integration/product-ux/run-v2-017-product-dogfooding.ts` | n/a (new in T15) | **26/26 legs, exit 0, run twice on fresh stacks with identical structured transcripts** | the work-order dogfooding requirement — PASS |
| exact-head CI | GitHub Actions API | **total_count = 0 runs repository-wide, 0 at base** | re-checked at the pushed head (recorded in the PR + below) | the documented external-blocker condition persists — recorded, never claimed as pass |

### Inherited failures at the exact base (recorded honestly, root-caused)

Frontend (4 failed + 1 collection failure — ALL corrected within the T15 boundary, test-side only):

1. `src/components/activity/TrustDisclosure.test.tsx` failed at COLLECTION: under the jsdom test environment the global `URL` constructor resolves relative specifiers against the jsdom document base (`http://localhost:3000/…`) instead of the module's file URL, so `fileURLToPath(new URL('./TrustDisclosure.tsx', import.meta.url))` throws `The URL must be of scheme file`. **Correction:** resolve via `path.join(dirname(fileURLToPath(import.meta.url)))` — the same discipline `backend/vitest.config.ts` documents for keeping module file lookups usable.
2. `src/responsive-focus.test.ts`: with vitest 2.1.2 (the frozen lockfile) and `css: false` in `frontend/vitest.config.ts`, the `import … from './index.css?raw'` module is stubbed to an EMPTY string, so the T14 focus-visible assertions failed against `''`. The stylesheet itself contains `a:focus-visible`/`button:focus-visible` (lines 51–52). **Correction:** read the resolved file from disk.
3–4. `src/pages/VersionsExperience.test.tsx` (3 tests): the §19/§20 assertions regexed `speed score 7 to 5` while the frozen honest-estimate language (`versions-language.ts` `scoreLine`, pinned by its own passing test) renders "Speed **estimated** score 7 to 5". **Correction:** the regexes now match the pinned wording (6 occurrences).

Backend (4 failed — recorded, NOT corrected; each is a WORK-052-era governance pin that went stale when the program advanced past WORK-069, NOT a V2-017 acceptance failure; modifying governance test pins for verification convenience is outside the T15 authority boundary and is left for Architect disposition):

- `tests/architecture/static-architecture.test.ts` — WORK-052 "the post-merge finalization protocol…" (README-language pin).
- `tests/integration/development-governance/parallel-eligibility.integration.test.ts` — W052-AC03 ×2 + governance-state.integration.test.ts W052-AC01: `expected [] to deeply equal ['WORK-069']` — `spec/development-state/program-state.json` records WORK-069 **complete + finalized** ("its handoff is removed"), while the tests still pin WORK-069 as the in-flight frontier.

## The dogfooding experiment

### Workflow / version under test

Two safe test workflows, both authored through the REAL V2-002 routes within the run:

- **digest** `weekly-ticket-digest-t15` (private): fetch (`github.repository.read`) → review gate (HUMAN approval, `human_confirmation`) → send (`messaging.send`) | log-rejection branch — the t10 shape, 4 nodes, presentation labels; v1 immutable, then **v2 = a presentation-layer change** (one step relabel: distinct content digest, IDENTICAL task surface) — and the run journey executes v1 to completion with REAL evidence + a REAL V2-014 Ed25519 attestation.
- **practice** `ticket-practice-t15` (private): fetch → human copy step (agentic task text) → send — the t9 shape for the Teach Me leg.

### Surface / host

The ACTUAL product, one process pair: the real Vite dev server serving the real SPA (port 5199) + the REAL Fastify `buildServer` (port 3001) over the identity stack's real pglite PostgreSQL with ALL migrations — real session auth, identity, organizations, projects, V2-002 repository (workflows/versions/installations), V2-005 runs (commands + history/evidence/attestations), V2-004/V2-009 deployment reads, V2-006/V2-010 teaching services, the V2-011 optimization transport route. The browser is a REAL headless Chromium. No API mocking; every product fact renders FROM authoritative responses.

### Exact task (the six legs, one continuous persona session)

1. CREATION — real signup through the product UI → the universal Create entry in Tell mode (typed goal, mode pre-selected) → the understanding preview (the captured goal echoed VERBATIM + correction fields + the honest "can't yet turn your description into executable steps") → the fail-closed durable boundary F-T5-001 ("Durable creation isn't available yet … Nothing is committed").
2. REVIEW — org + both workflows + the v1 installation through the REAL routes → the Workflows library (both cards) → the detail page (purpose, presentation-layer steps, Version 1 — immutable, Access and safety "Needs access to", primary actions Run/Teach Me/Edit).
3. EXECUTION — Run → the consequential-action preview (steps from presentation labels — never node IDs; Approval required; Needs access to; the honest "Where it runs isn't set up yet") → the REAL request+start commands → "Running" → executor pause AT the approval gate → reload → the history-derived "Waiting for you" (internal `paused` only under Advanced details) → executor resume + REAL evidence records (observation + human confirmation) + a REAL V2-014 Ed25519 attestation (bound to the run's ACTUAL installation identity) + complete → reload → "Completed" + "How do you know?" (concise evidence first; Advanced verification on demand: the statement action, Software-signed, the frozen trust boundary sentence).
4. TEACHING — Teach Me on the practice workflow ("You'll learn to do this yourself", "Version 1 — the lesson is bound to it") → lesson steps with checkpoints → pause/resume → practice (the authority's own question) → assessment (order + recall) → "Lesson complete" terminal; the teaching-evidence surface "kept separate from run evidence".
5. VERSION/UPDATE — v2 authored through the REAL V2-002 route → the update banner ("An update is available … Your installed version: Version 1 — pinned", "Nothing changes until you approve the update.") → Review update → What changed (the V2-011 comparison over the transport route: task-for-task equivalent + "modeled estimates, not measurements") → Approve update = the EXISTING V2-002 commands → "You're on the newest version" + "Installed: Version 2 — pinned · Enabled".
6. ACTIVITY — the universal timeline (the completed run entry + the workflow links).

### Expected outcome

Every leg passes its product-contract assertions; no second authority is exercised; the honest failure states are asserted as such; exit code 0.

### Observed outcome (verbatim run transcript — run 2 of 2, fresh stack)

Run: `cd backend && bunx tsx tests/integration/product-ux/run-v2-017-product-dogfooding.ts` — exit code 0, captured 2026-09-06T03:48:54.908Z → 03:49:07.806Z (12898 ms wall). Executed TWICE on fresh stacks (runs at 03:36Z development iterations excluded; the two consecutive clean-stack evidence runs: 03:47:5xZ and 03:48:54Z — both 26/26 PASS, and a diff of the two `journey.json` transcripts is EXACTLY the timestamp lines; every structured fact identical).

```text
INFO V2-017 T15 product dogfooding run starting at 2026-09-06T03:48:54.908Z
INFO artifacts dir: spec/architecture/v2/dogfooding-evidence/assets/v2-017
INFO REAL backend topology up: Fastify :3001 (identity + V2-002 repository + V2-005 runs + deployments + teaching + optimization)
INFO ACTUAL product frontend up: Vite dev server http://localhost:5199
PASS (2140ms) LEG1 goto the product
PASS (285ms)  LEG1 real signup through the product UI
PASS (374ms)  LEG1 the universal Create entry in Tell mode (goal pre-filled)
PASS (61ms)   LEG1 the understanding preview: the captured goal echoed VERBATIM + correction fields
PASS (18ms)   LEG1 F-T5-001 the honest fail-closed durable boundary (NO fabricated WorkflowIR commit)
PASS (23ms)   LEG2 create the organization through the REAL route
PASS (19ms)   LEG2 author the digest workflow through the REAL V2-002 route (v1 immutable)
PASS (14ms)   LEG2 install v1 (the immutable pin) through the REAL V2-002 installation route
PASS (13ms)   LEG2 author the practice workflow through the REAL V2-002 route (for the teaching leg)
PASS (476ms)  LEG2 the product Workflows library lists both workflows
PASS (516ms)  LEG2 the workflow detail page: purpose + presentation-layer steps + version + access/safety + primary actions
PASS (71ms)   LEG3 Run opens the consequential-action preview (presentation steps, approval, access, honest not-set-up)
PASS (193ms)  LEG3 Run sends the REAL V2-005 commands (request → start) → Running
PASS (32ms)   LEG3 the executor pauses AT the approval step (the REAL pause command with atStepId)
PASS (640ms)  LEG3 reload → the history-derived "Waiting for you" (the internal paused state stays in Advanced details)
PASS (99ms)   LEG3 the executor records REAL evidence + a REAL V2-014 attestation, then completes (the REAL lifecycle commands)
PASS (541ms)  LEG3 reload → Completed + the "How do you know?" trust disclosure (concise evidence first, advanced verification on demand)
PASS (545ms)  LEG4 Teach Me: the lesson entry beside Run, bound to the immutable version
PASS (348ms)  LEG4 the lesson: checkpoints → pause → resume → all steps confirmed
PASS (234ms)  LEG4 practice (the authority's own question) + assessment → Lesson complete (terminal)
PASS (8ms)    LEG4 the teaching evidence surface stays VISIBLY DISTINCT from execution evidence
PASS (14ms)   LEG5 v2 authored through the REAL V2-002 route (an explicit NEW immutable version)
PASS (492ms)  LEG5 the update banner: an update is available, the verbatim installed pin, "Nothing changes until you approve the update."
PASS (46ms)   LEG5 Review update → What changed (the V2-011 comparison over the transport route, honest modeled estimates)
PASS (182ms)  LEG5 Approve update = the EXISTING V2-002 commands → the new pin (v2, Enabled), the honest newest state
PASS (427ms)  LEG6 the Activity timeline: the run entries + the workflow links
DONE exitCode=0 duration=12898ms legs=26 passed / 0 failed
```

### Persisted artifacts (sha-256, byte sizes)

```text
0ef26e30c07caa28d6c34853258c9dce67b7f7674dbcd9dcc585ccc8de846ef1    83888  assets/v2-017/01-home.png
e75e13185ec90197d1f8b00bb3cd7f72292d2e514b9b075753857d078a62b552    99664  assets/v2-017/02-creation-honest-boundary.png
d19508fbcc967c886c98f6d7f1739f97dd40a7cafea4d25de0f1649f874dc4d2    72559  assets/v2-017/03-workflow-detail.png
61d7feee505cc09b97845ba086556775f0fee668d08ba8303c38a6419668c33d    72517  assets/v2-017/04-run-waiting-for-you.png
4191b1faffe44beabc43905293ce6ee3a34b088f862f5966cf0611ab9350f6c0    93905  assets/v2-017/05-run-completed-trust.png
34547f7384fc7fa2bc4d3fb2a636cbafc63b954176fb438ba1cb88a59aa6461e    78423  assets/v2-017/06-teach-me-lesson-complete.png
511ab1a972d9564285469328a7d150887000880da7a83b4a83c40d354941e49a    77466  assets/v2-017/07-update-what-changed.png
c8e31ef02cbb3bd22d489f6515a821178a7b2702254a86028864e5de6cce5d21    77314  assets/v2-017/08-update-adopted.png
bef190bd3df18bec593de543fd3ba68850a933b186f1217516dfb85b492d8812    66798  assets/v2-017/09-activity-timeline.png
```

`journey.json` (the full structured transcript + artifact digests) is persisted alongside.

## Acceptance-criteria reconciliation (V2-017 work order, line by line)

| # | Acceptance criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Primary navigation matches the approved human-facing model | VERIFIED | `App.tsx` routes (Home / Workflows / Explore / Activity + universal Create); `navigation.test.tsx`, `responsive-shell.test.tsx`; work-074 specs T2/T3; dogfooding LEG1/LEG2/LEG6 navigated the real shell |
| 2 | Internal architecture terms removed from primary UX; expert/inspection contexts only | VERIFIED | The §29 dictionary language modules (`versions-language`, `marketplace-language`) with their pinned tests; t6 E2E pins internal run-state words under "Advanced details" only; `WorkflowDetailPage` renders presentation labels, node IDs never primary (t6 pins `review_gate` absent from the preview) |
| 3 | Workflow detail communicates purpose, actions, state, steps, when/where, recent activity, version, access/safety | VERIFIED | `WorkflowDetailPage` regions (What it does / Where it runs / Recent activity / Version / Access and safety / Primary actions); t6 + work-074 T4 specs; dogfooding LEG2 |
| 4 | Tell / Show / Tell + Show entry points without a second workflow representation | VERIFIED | `CreatePage` capture→preview→fail-closed commit (F-T5-001: NO create POST without a WorkflowIR authority); CreatePage tests; work-074 T5; dogfooding LEG1 |
| 5 | Run, pause, resume, takeover and failure UX preserve the Run authority | VERIFIED | t6 E2E (request→start→pause→Waiting for you), t7 E2E (failure → §18 explanation → Try again / Take over / Resume / Stop over the real commands); dogfooding LEG3 |
| 6 | Scheduling/event UX human-readable while preserving canonical trigger/event semantics | VERIFIED | t8 E2E (manual → schedule create-or-converge → after-workflow → event; the subscription/trigger authorities unchanged) |
| 7 | Teach Me and reverse teaching first-class and visibly distinct from execution evidence | VERIFIED | t9 E2E (lesson → … → complete; reverse teaching → zero runs); dogfooding LEG4 asserts the distinct "Teaching evidence … kept separate from run evidence" surface |
| 8 | Access UX uses "Needs access to" while preserving capability/authorization/consent separation | VERIFIED | Detail "Access and safety" + t6 preview "Needs access to"; dogfooding LEG2/LEG3; capability disclosure from the IR (t12 §22 listing disclosure) |
| 9 | Update UX makes immutable version pinning visible | VERIFIED | t11 E2E + dogfooding LEG5: "Version 1 — immutable", "Your installed version: Version 1 — pinned", "Nothing changes until you approve the update." → post-adoption "Installed: Version 2 — pinned · Enabled" |
| 10 | Optimization UX presents proposals as new versions and requires adoption | VERIFIED | t11 E2E (improvements → review → approve → "created as a new version" → version history v3; no mutation); VersionsExperience §20 tests |
| 11 | Marketplace/share UX preserves entitlement vs installation vs execution boundaries | VERIFIED | t12 E2E two-persona journey (publish → listing disclosure → purchase → entitlement pins the exact version → Install the exact pin → Make my own fork; the boundary sentences asserted at every commerce/authority boundary); `marketplace-language.ts` pinned constants |
| 12 | "How do you know?" exposes concise evidence first, advanced verification on demand | VERIFIED | t10 E2E (timeline + run-status trust) + dogfooding LEG3 (records' own descriptions + "Verified by …" + Advanced verification: statement action, Software-signed, the frozen physical-world boundary sentence) |
| 13 | Expert workspace remains accessible | VERIFIED | T13 (expert transition; work-074 T13 spec: explicit mode crossing, labeled workspace, return path; `ExpertPage`) |
| 14 | Desktop/tablet/mobile layouts platform-appropriate | VERIFIED | t14 E2E (desktop shell → tablet keeps the shell → mobile bottom navigation, stacked detail, uncovered footer, same model every viewport) + `responsive-shell`/`responsive-focus` tests |
| 15 | Automated frontend tests cover navigation, disclosure, authorization language, unavailable-vs-empty, pinning, recovery | VERIFIED | frontend suite **362/362** at head: navigation/shell/focus tests, disclosure tests, language modules, unavailable-vs-empty assertions (e.g. VersionsExperience "What changed isn't available right now", WorkflowsPage Unavailable panels), pinning tests, RecoveryExperience tests |
| 16 | Real browser dogfooding proves at least one representative end-to-end journey | VERIFIED | The V2-017 runner: creation → review → execution → completion → teaching → version/update → activity through the ACTUAL product, 26/26 legs, twice, with persisted transcript + screenshots |

## Scope audit (authority boundaries)

- No second workflow protocol, execution engine, evidence/verification authority, marketplace/entitlement authority, or governance authority created.
- No frozen semantics modified: WorkflowIR, WorkflowVersion immutability, run state machine, attestation semantics, marketplace economics — untouched (the diff contains zero product/backend source changes).
- Corrections were confined to the verification surface (3 inherited test defects), each reviewable in this slice; the 4 backend WORK-052 inherited failures were recorded and LEFT for Architect disposition (governance-pin territory).
- T16 (the sole Architect gate) is not implemented; no successor work touched.

## CI honesty record

- The repository's 11 workflow definitions are `active` (API check 2026-09-06), but **total Actions runs = 0 repository-wide** and **0 at base `26ca694`** — the long-documented condition persists.
- The exact-head check for the pushed T15 head is recorded in the PR (this slice's final commit SHA): the condition is recorded AS AN EXTERNAL BLOCKER with the exact SHA if it persists — never as a pass, never with invented evidence.
- All verification above was executed locally on the exact base and head SHAs with the commands recorded in the matrix.

## Honest limitations

- The dogfooding topology composes the product services in-process (the same real-service composition the t6–t12 E2E suites use) rather than the deployed multi-process production topology; the browser, HTTP routes, persistence, and evidence/attestation chain are all real.
- The V2-014 attestation in LEG3 is a real Ed25519 signature over a real statement bound to the real run/installation identities, generated by a test attester key (the t10 precedent) — no production attester HSM is involved, and the product honestly discloses "Software-signed" + the physical-world boundary.
- Rubric trade-off numbers in the What-changed comparison are the frozen MODELED estimates (honest "estimates, not measurements" framing is asserted verbatim).
- The 4 inherited WORK-052 backend failures and the 2 inherited `workflow-deployments.route.ts` typecheck errors are recorded, not fixed — out of this slice's boundary.
- Zero Actions runs means no platform CI corroboration exists for ANY V2-017 head; the local exact-SHA evidence above is the complete verification record.
