# REALITY-REPAIR-004 — Honest Creation Boundary and Expert Authoring (F-004a/F-004b)

**Work Order:** `spec/architecture/v2/work-orders/REALITY-REPAIR-004.md`
**Parent gate:** V2-REALITY-AUDIT-001 (Architect disposition: F-004a ACCEPT;
F-004b **composition-only expert authoring selected, AI generation deferred**)
**Dispatch:** GitHub Issue #25 (authorized after the REALITY-REPAIR-003
merge + reconciliation; `PARALLEL_AFTER_003`)
**Base:** `main` at worker start — `9cbfd12233dcc653459fd60751904fd30ab18fb2`
(the exact live head; no rebase, no merge — the branch grew from it directly)
**Branch:** `feat/REALITY-REPAIR-004-honest-creation-expert-authoring`
**Commit sequence:** RED `6339f51` → the repair `a89a39d` → the browser
smoke runner `20ae5bf` → this evidence
**Files:** frontend composition only — 3 product files
(`frontend/src/pages/CreatePage.tsx`, `frontend/src/pages/ExpertPage.tsx`,
`frontend/src/api/client.ts`) + 2 test files + the smoke runner + this
evidence; **zero backend/src changes (git-diff-verified byte-identical to
base), zero route changes, zero spec-authority changes, zero
authorization-semantics changes, zero new dependencies**

## 1. The defect (F-004a + F-004b, the audit's FINDING-004)

**F-004a (UX_DEFECT, the false promise sentence).** The Create preview's
honest-limitation paragraph promised: *"Your captured input is recorded as
the starting content: the durable workflow is created with immutable
Version 1, and executable authoring happens later from the workflow
surface."* False on both counts: no create POST is ever sent from the
captured-input flow (the F-T5-001 fail-closed boundary — nothing is
committed), and no authoring surface existed anywhere in the product.

**F-004b (TRUE_ARCHITECTURE_GAP / UX gap).** The ONLY user paths to a
workflow were marketplace install and fork; the ONLY path to a new version
was the optimization-proposal adoption. Raw authoring had no UX — while the
backend V2-002 `createWorkflow` / `createVersion` commands **exist and are
proven** (the dogfooding authored versions through them; the routes answer
201/200 with create-or-converge semantics and typed rejections). The
frontend `workflowRepository` client surface had **no** `createWorkflow` /
`createVersion` consumer.

The Architect's disposition (F-004b): the existing V2-002 commands and the
V2-003 IR contract are sufficient for a **composition-only expert authoring
surface**; the natural-language capture→WorkflowIR generation path requires
a future governed architecture change and is **deferred — NOT authorized**
by this Work Order.

## 2. The repair (composition-only — no new authority)

**Slice A — `frontend/src/pages/CreatePage.tsx` (F-004a, the truthful
boundary):**

- the preview limitation now states the fail-closed fact **explicitly**:
  natural-language capture is NOT converted into executable WorkflowIR —
  no generation authority exists — nothing is created from the page, and
  the captured input is never recorded as durable workflow content;
- the false promise sentences are **gone** ("the durable workflow is
  created with immutable Version 1", "executable authoring happens later
  from the workflow surface");
- the boundary card is re-scoped truthfully: *"Durable creation isn't
  available for captured input"* (durable creation **exists** for experts
  authoring WorkflowIR directly), keeps the missing-generation-authority
  fact, and **points to the real expert authoring entry** (`/expert`);
- the fail-closed behavior is **PRESERVED**: the captured input stays
  transient client-local state — the F-T5-001 zero-create-POST proof still
  holds (deterministically pinned by both the pre-existing and the new
  tests).

**Slice B — `frontend/src/pages/ExpertPage.tsx` (F-004b, the bounded
expert authoring surface):**

- the organization selection through the **existing**
  `organizations.listForUser` read (the product-shell pattern), with
  honest loading / error-with-retry / zero-org states — a zero-org expert
  gets the **existing RR-002 onboarding component** (the actionable state,
  never a silent dead end);
- the name / slug / description / visibility fields + the **empty
  WorkflowIR JSON editor the expert authors directly** (no generation, no
  node-graph builder, no compiler, no execution authority, no
  AI-generation authority) + the explicit `protocol.irSchemaVersion`
  declaration (defaulting to the current WorkflowIR descriptor);
- the create flows through the **REAL V2-002 createWorkflow route**; the
  only local gate is JSON syntax (an unparseable/non-object document is
  never sent — transport, not validation); the **semantic validation stays
  server-side** and typed rejections render **verbatim** (the ApiError
  message the transport preserves) with the editor staying open;
- success renders **FROM THE AUTHORITATIVE RESPONSE** (the created
  workflow identity: name/slug/id + the Version-1 facts: content digest +
  the durable library links `/workflows/:id` and `/workflows`);
  create-or-converge is stated honestly (`created: false` says the workflow
  already existed — never a fabricated new creation);
- a second section composes the **second EXISTING command** (POST
  `/workflow-repository/workflows/:workflowId/versions`) for an existing
  workflow, auto-carrying the created workflow id forward (user-owned,
  editable), rendering the new immutable version's facts from the response.

**`frontend/src/api/client.ts`** — the two missing client functions for the
two EXISTING commands (`createWorkflow` / `createVersion`), modeled on
`fork` / `installVersion`: typed, ApiError-preserving, zero wire invention.
No other client changes.

**Non-goals honored (the Work Order's own prohibitions):** no new workflow
model, no compiler, no node-graph builder, no execution authority, no
AI-generation authority, no natural-language capture→WorkflowIR generation
(deferred to a governed architecture change), no backend change of any
kind.

## 3. Deterministic regression (RED at base → GREEN at head)

The RED commit (`6339f51`) lands the failing tests first. **At base
`9cbfd12`** (run before any implementation):

- `CreatePage.test.tsx` — **2 failed / 9 passed (11)**: the two new Slice A
  tests fail on the defect's own visible state (the false promise copy
  renders; no expert entry exists; the truthful phrases are absent);
- `ExpertPage.test.tsx` — **10 failed / 0 passed (10)**: the whole Slice B
  contract fails — the expert workspace renders only the developer bridge
  (the failure output shows the base DOM: the bridge card and nothing
  else);

**12 failed / 9 passed (21)** across the two suites — every failure
rendering one of the two defects' own visible states.

**At head — GREEN:** the touched suites are
`CreatePage.test.tsx` **11/11** and `ExpertPage.test.tsx` **10/10**. The
new contract pins: the truthful copy (both sentences of the false promise
absent; the fail-closed facts present; the `/expert` entry), the honest
surface states (loading/error-with-retry/zero-org-onboarding), the exact
POST bodies (content PARSED from the editor — never the raw text; protocol
declaring irSchemaVersion; the org-scoped URL), the authoritative-response
rendering (identity + Version-1 facts + library links; the converged-create
honesty), typed 400 rejections rendered verbatim with the editor staying
open, invalid JSON never sent, and the version command's body + rendered
facts.

## 4. Verification matrix at the exact head

| Check | Result |
| --- | --- |
| RED at base `9cbfd12` (the two suites) | **12 failed / 9 passed (21)** — `CreatePage.test.tsx` 2 failed / 9 passed; `ExpertPage.test.tsx` 10 failed / 0 passed (§3) |
| Touched suites at head | **21/21 PASS** — `CreatePage.test.tsx` 11/11; `ExpertPage.test.tsx` 10/10 |
| Frontend full battery (`bun run test`, 39 files) | **392/392 PASS** — the 380 pre-existing tests + 12 new (2 Slice A + 10 Slice B); the pre-existing creation/install/fork contract tests (CreatePage fail-closed, MarketplaceListingDetail install/fork, WorkflowsPage library) all green at this head |
| `tsc --noEmit` (frontend) | **clean** |
| `eslint .` (frontend) | **0 errors / 1 inherited warning** (ArchitecturePage `react-hooks/exhaustive-deps`, untouched — the documented pre-existing warning) |
| `git diff base -- backend/ spec/development-state/` | **empty** — backend/src and every governance artifact byte-identical to base |
| Backend `tsc --noEmit` (the smoke runner + the byte-identical backend) | **the 2 documented inherited `workflow-deployments.route.ts` TS2739 errors only** — the same family recorded at the RR-002/RR-003 merges; **zero errors in the new runner** (verified by borrowing the main clone's identical, lockfile-matching `node_modules` read-only through a temporary symlink — removed after verification; this worktree's backend `node_modules` is not provisioned by dispatch) |
| Backend `eslint` on the new smoke runner | **0 errors / 9 warnings** — the documented `no-console` runner family (8) + `no-explicit-any` on the verification-channel `json` helper (1), the same pattern RR-003's runner records |
| Backend full battery / e2e-browser sweep | **NOT run at this head by this worker** — this worktree's backend `node_modules` is not provisioned (by dispatch, the specialist verifies the frontend battery; the orchestrator owns the real-topology runs). Recorded honestly; never claimed as a pass. The deterministic creation/install/fork regression is carried by the 392/392 frontend battery (§4 row 3) |
| Real-topology browser smoke (this slice's required evidence) | **pending the orchestrator run** (port discipline — see §5) |

## 5. Real-topology browser proof (the Work Order's required evidence)

Runner: `backend/tests/integration/deployment/run-reality-repair-004-browser-smoke.ts`
— modeled exactly on the RR-003 runner: the REAL deployment entry spawned
as a process (`bun src/index.ts`, the docker-compose CMD, on the WORK-071
pglite dev runtime — real PostgreSQL-WASM DatabaseClient + the SAME
migrations as production — `WORKFLOWOS_ROLE=all`, fresh temp data dir,
`:3001`), the ACTUAL product SPA via the Vite dev server (`:5188`, its
`/api` proxy targeting `:3001` exactly as deployed), and a REAL headless
Chromium (Playwright, 1280×800); `step()`/`shot()` transcript +
sha-256 digests into `assets/reality-repair-004/` (journey.json +
screenshots).

**Status: written and committed, NOT run by this worker — the run is the
orchestrator's** (port discipline: a sibling specialist shares the port
space; the smoke owns `:3001`/`:5188`). The evidence below is the runner's
deterministic leg design, to be filled by the orchestrator's
`journey.json`/exit code — **the exit-code line is deliberately left as the
orchestrator's to fill; no run is claimed.**

Persona: ONE EXPERT USER does everything through the real browser UI —
signup included; nothing is pre-seeded (no publisher, no listing; the
existing creation/install/fork regression is carried by §4's deterministic
battery).

| Leg | Proof |
| --- | --- |
| LEG1 | the expert **signs up through the real register surface** (Create one → Create account) and lands on Home |
| LEG2 | the expert creates their organization through the real Home onboarding (the RR-002 composed precondition of the org-scoped create) |
| LEG3 | `/create` (Tell): capture → preview → **the truthful creation boundary renders (F-004a)** — "Natural-language capture isn't converted into executable WorkflowIR", "Durable creation isn't available for captured input", "Nothing is committed", the false-promise sentences absent, and the expert entry link present (screenshot `02`) |
| LEG3b | **the browser's own network capture: ZERO workflow-repository commands during the whole captured-input journey** — the F-T5-001 fail-closed behavior preserved through the copy repair |
| LEG4 | the boundary entry opens `/expert`: **the bounded authoring surface renders** — the org selection auto-resolved through the product-shell read, the EMPTY WorkflowIR editor, the "generates nothing" copy, the protocol declaration, the version surface |
| LEG5 | the expert **authors the WorkflowIR document directly** (the textarea) + the metadata → Create workflow → **the REAL V2-002 createWorkflow route** creates the workflow with immutable Version 1; the created facts render FROM THE 201 RESPONSE with the durable library links (screenshot `03`) |
| LEG5b | **the REAL routes resolve the SAME created facts** — the workflow read (id/slug/name/description/visibility), the versions read (Version 1 with its content digest), and the org repository read lists it |
| LEG6 | the version surface (the created workflow id carried forward) + the second authored WorkflowIR document → Create version → **the REAL V2-002 createVersion route** creates Version 2; its facts render from the response (screenshot `04`) |
| LEG6b | **the REAL routes confirm Version 2** — 2 versions in stable order with distinct content digests, the workflow `headVersionId` moved to the new version, the exact immutable version read resolving it |
| LEG7 | **the existing library/detail journey for the CREATED workflow**: `/workflows` lists it (My Workflows) → Open → the detail loads — heading, description, Private line, the head version's presentation-label steps, "Version 2 — immutable", the honest no-install state, the 2-entry version history, no error state (screenshot `05`) |

Exit code at the exact head: **pending orchestrator run** (fill from
`assets/reality-repair-004/journey.json`).

## 6. Out-of-boundary observations (recorded for serialized successors)

- The natural-language capture→WorkflowIR generation path remains honestly
  absent (deferred to a governed architecture change): the Create boundary
  says so, the expert editor generates nothing, and the smoke's LEG3/LEG3b
  prove the captured input never becomes a command.
- The repository's `protocol` descriptor is transported opaquely (V2-002
  stores it as the version author's declaration); the expert surface
  defaults the field to the current WorkflowIR descriptor and leaves the
  truthful declaration to the author — a future governed change could
  constrain it server-side if desired.
- The expert surface's editor is a raw JSON textarea by disposition (the
  Work Order selected "edit truthful WorkflowIR directly"); a structured
  IR inspector would be a UX-successor question, not an authority change.
- The backend full battery / e2e-browser sweep at this exact head remain
  the orchestrator's verification (this worktree's backend `node_modules`
  is not provisioned; the branch touches zero backend files, so the
  RR-003-recorded backend state carries unchanged — recorded, never
  claimed).
- GitHub Actions has **zero executions** repository-wide (see §7) — the
  canonical review trigger and CI conditions remain the orchestrator's
  delivery steps (no push/PR was performed by this worker, by dispatch).

## 7. CI honesty

The repository's GitHub Actions has **zero executions** repository-wide at
base and at this branch head (the RR-001/RR-002/RR-003 evidence records the
same external condition; this worker performed no GitHub API calls at
all). Missing CI runs are recorded as the external condition; they are
never claimed as a pass. All verification above was executed locally in
the development sandbox at the exact heads recorded, and every number in
this document comes from a command actually run there (§3, §4) — except
the smoke exit code, which is explicitly pending the orchestrator's run
(§5).

## 8. Completion criteria mapping (the Work Order's own list)

| Work Order requirement | Evidence |
| --- | --- |
| Slice A: correct the false Create boundary copy; explicitly state that natural-language capture is not yet converted into executable WorkflowIR | §2 Slice A + §3 (the RED failure on the old copy → the GREEN truthful copy) + LEG3 (the real-browser boundary) |
| Preserve fail-closed behavior | §2 (F-T5-001 preserved) + §3 (the zero-create-POST proofs, pre-existing and new) + LEG3b (the browser network capture) |
| Slice B: bounded composition-only expert authoring over the existing V2-002 createWorkflow / createVersion commands and V2-003 validation | §2 Slice B (the surface composes the two EXISTING commands; the semantic validation stays server-side) + §3 (the exact POST bodies + verbatim typed rejections) + LEG5/LEG6 (the real routes) |
| Edit truthful WorkflowIR directly; no new workflow model, compiler, execution authority, or AI-generation authority | §2 (the empty JSON editor; the prohibitions honored) + the byte-identical backend diff (§4) + LEG4/LEG5 (the expert authors the IR text themselves) |
| Deferred: natural-language capture→WorkflowIR generation NOT authorized | §2/§6 (no generation anywhere; the boundary states it; the editor generates nothing) |
| Browser proof of truthful creation boundary and successful expert authoring/version creation through real V2 routes | LEG3/LEG3b (the boundary) + LEG5/LEG5b/LEG6/LEG6b (authoring + version creation through the REAL routes) — **pending the orchestrator's run of the committed runner** |
| Deterministic validation | §3 (RED 12 failed / 9 passed at base → GREEN 21/21) + §4 (the full frontend battery 392/392, typecheck clean, lint 0 errors) |
| Regression of existing creation/install/fork flows | §4 row 3 (the 392/392 battery including the pre-existing CreatePage fail-closed, MarketplaceListingDetail install/fork, and library contract tests) + LEG7 (the existing library/detail journey for the created workflow) |
| Exact-head Architect review trigger | the orchestrator's delivery step after this branch (no push/PR/review-trigger emission was performed by this worker, by dispatch) |

**Worker conclusion:** REALITY-REPAIR-004 is implemented within its
declared boundary (frontend composition only, over the existing
`organizations.listForUser` selection, the existing V2-002
createWorkflow/createVersion commands, and the existing server-side
validation; no new authority, persistence model, authorization semantics,
or route changes), deterministically verified (RED at base → GREEN at
head; the full frontend battery 392/392; typecheck clean; lint 0 errors),
with the real-topology browser smoke runner committed for the
orchestrator's port-disciplined run. The F-004a honesty defect is repaired
and the F-004b bounded expert authoring path exists over the real routes.
The gate now rests with the orchestrator (the smoke run + the delivery)
and then the Architect: exact-head review and merge before
REALITY-REPAIR-005..009 activate; deployment remains locked until the
serialized repairs + the R6 repeat audit + the R7 release decision succeed.
