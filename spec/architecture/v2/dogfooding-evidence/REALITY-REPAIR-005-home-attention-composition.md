# REALITY-REPAIR-005 — Home Approval and Update Attention Composition (F-005)

**Work Order:** `spec/architecture/v2/work-orders/REALITY-REPAIR-005.md`
**Parent gate:** V2-REALITY-AUDIT-001 (Architect disposition F-005 ACCEPT — "Reuse
existing run/version/install reads and derivations. No aggregate authority.")
**Dispatch:** GitHub Issue #26
**Base:** `main` at worker start — `9cbfd12233dcc653459fd60751904fd30ab18fb2`
(the exact current main; `basePolicy: current-main-at-worker-start`; no rebase,
no merges)
**Branch:** `feat/REALITY-REPAIR-005-home-attention-composition`
**Commit sequence:** `931186c` (RED tests) → `51efd9e` (the repair) → `3ceb0c0`
(the real-topology browser smoke runner) → this evidence document
**Files:** frontend composition only — 5 product files + 1 test file + the
smoke runner + this evidence; **zero backend/src changes, zero route changes,
zero new commands (reads only, all existing), zero spec/development-state
changes, no new npm packages**

## 1. The defect (F-005, the audited UX defect)

The reality audit's Home walk (HOME-3/HOME-4) found Home rendering **"Pending
approvals"** and **"Updates"** as `UnavailableSurface` panels claiming:

- *"Approvals aren't shown here yet — they'll appear once approvals become
  part of the product."* — **FALSE**: the V2-005 approval gates ARE part of
  the product — `RunExperience` already derives the human state word
  **"Waiting for you"** from a paused run's reconstructed history (the
  `workflow.run.paused` entry's `detail.atStepId`) plus the run-pinned
  version's IR approval nodes, and `ProductActivityPage`'s Needs-me bucket
  uses the same derivation.
- *"Workflow and version updates aren't shown here yet — they'll appear once
  updates become part of the product."* — **FALSE**: the
  `VersionsExperience` §19 update banner already derives
  installed-behind-head from the V2-002 installation read + the public
  versions read, with the honest "pinned, never auto-updated" vocabulary.

The audit's expectation row for both surfaces was "composes existing
runs/approval / versions/installations reads"; the observed state was
"none fired" — the surfaces claimed product absence while every underlying
capability existed and was already consumed one page away. (The third panel —
**Device issues** — was found EXPECTED-UNAVAILABLE (F-006): no public
device-status read exists, an explicit deferral, not a defect.)

## 2. The repair (composition only — no aggregate authority, no duplicated attention state)

Per the Work Order ("Compose Home's Pending approvals and Updates surfaces
from existing V2-005/V2-002 reads and derivations already used by Workflow
Detail and RunExperience. Do not create an aggregate authority or duplicate
attention state. Preserve honest unavailable behavior for device issues.")
and the Issue #26 dispatch (the exact reads named: the paused runs +
`workflowRuns.getHistory` + the approval-gate derivation for approvals; the
installation read + `workflowRepository.listVersionsForWorkflow` for updates):

1. **`frontend/src/pages/HomePage.tsx`** — the two composed surfaces:
   - **Pending approvals** (`fetchPendingApprovals`): the paused runs of
     EVERY caller organization (the V2-005 run read, F-T2-001 all-or-error)
     → each paused run's reconstructed history (the V2-005 read whose
     `workflow.run.paused` entry carries the executor-reported pause point
     `detail.atStepId` — never guessed) → the run-pinned version's
     WorkflowIR (the public versions read) → the SHARED approval-waiting
     derivation → the public workflow read for the item's name. The card
     carries the shared §15 vocabulary ("Waiting for you" +
     `humanRunStateSentence`) and links **"Open the run"** to
     `/workflows/:workflowId?run=:runId` — the T10 F02 direct-link pattern
     `WorkflowDetailPage` already consumes. **No evidence — no claim**: a
     paused run without approval facts is simply not an item (it stays in
     Needs attention as *Paused*).
   - **Updates** (`fetchWorkflowUpdates`): the installations of every caller
     org (the V2-002 read, all-or-error), bound per (workflow, org) by the
     SAME rule the detail page uses (the T11 adoption rule: the enabled
     installation is the live pin — a retired row must never fabricate an
     update the caller already adopted) → the public versions read: an
     installation whose `pinnedVersion.versionNumber` is behind the
     workflow's head version number (the highest number — versions are
     immutable and append-only) is the update item → the public workflow
     read for the name. The item carries the honest §19 vocabulary
     ("Version N is available — your installed Version M stays pinned (it
     never auto-updates)", "Nothing changes until you approve the update.")
     and links **"Open the workflow"** to `/workflows/:id` — where the real
     adoption action lives. **The adoption action is NOT duplicated on
     Home** (no Approve/Install/Update button exists there — pinned by
     test).
   - Both surfaces keep the frozen honesty contract: loading /
     error-with-retry / successful empty / data; all-or-error aggregation
     (a partial collection is never presented as success); a failed read is
     NEVER a successful empty; fail-closed guards on authoritative reads
     that yield no usable record. Both refetch on the RR-002
     organization-created path.
   - **Device issues stays the honest `UnavailableSurface`** (F-006
     explicit deferral) — untouched copy, pinned by test.
2. **`frontend/src/components/activity/workflow-ir-facts.ts`** — the tiny
   shared derivation the dispatch anticipated: `lastPauseAtApprovalStep(
   timeline, content)` extracted from the two inline copies
   (`RunExperience`'s status-surface derivation and
   `ProductActivityPage`'s `needsYouWord`) so Home consumes the derivation
   instead of becoming a **third** copy — one source, three consumers, zero
   duplicated logic.
3. **`frontend/src/components/run/RunExperience.tsx`** and
   **`frontend/src/pages/ProductActivityPage.tsx`** — refactored to consume
   the shared derivation (behavior-identical; their existing suites prove
   it: 61/61 across the touched consumers).
4. **`frontend/src/components/activity/run-state-language.ts`** — the module
   doc note updated to point at the derivation's new single home (comment
   only).

**Non-goals honored:** no new read routes (every read is an existing public
or member-scoped one already consumed elsewhere), no aggregate authority,
no client-side authority, no adoption/resume controls on Home (RR-008's
scope), no See-all links beyond the dispatch, no library naming changes
(F-007/RR-006's scope), no device-status read invented (F-006).

## 3. Deterministic regression (RED at base → GREEN at head)

The RED commit (`931186c`) landed the failing tests first. **At base
`9cbfd12`** (run before any implementation): `HomePage.test.tsx` —
**11 failed / 19 passed (30 tests)**; every failure rendering the F-005
defect's own visible state (the `UnavailableSurface` panels with the false
"once … become part of the product" claims). The RED set:

- the approvals data test (the approval-waiting run's "Waiting for you"
  card + the Open-the-run `?run=` direct link never appear);
- the updates data test (the installed-behind-head item + the §19 pin
  vocabulary + the workflow-detail link never appear);
- the honest-state tests per surface (the successful empty, the
  error-with-retry, the F-T2-001 cross-org aggregation, and the all-or-error
  partial-failure guard);
- the no-false-copy test (the false claims still present at base);
- the device-issues-preserved test (its composition preconditions fail at
  base; its F-006 pin assertions hold by design).

**At head `3ceb0c0` — GREEN: 30/30 in `HomePage.test.tsx`** (11 new RR-005
tests + the 19 pre-existing). Two pre-existing tests were updated as the
honest consequence of the repair (both recorded in §6): the loading-count
pin (2 → 4 loading statuses — two more composed reads are honestly in
flight) and the old "surfaces without an exposed read stay honestly
Unavailable" test (narrowed to Device issues only — the old test pinned the
F-005 defect itself).

## 4. Verification matrix at the exact head `3ceb0c0`

| Check | Result |
| --- | --- |
| `HomePage.test.tsx` (the touched suite) | **30/30 PASS** (11 new RR-005 tests GREEN after the 11 RED failures at base) |
| The refactored derivation consumers (`RunExperience.test.tsx` + `ProductActivityPage.test.tsx` + `WorkflowDetailPage.test.tsx`) | **61/61 PASS (3 files)** — behavior-identical refactor proven |
| Frontend full battery (`cd frontend && bun run test`) | **391/391 PASS (38 files)** — the 380 pre-existing + 11 new; zero regressions |
| `bun run typecheck` (frontend) | **clean (exit 0)** |
| `bun run lint` (frontend) | **0 errors / 1 warning** — the inherited `ArchitecturePage.tsx` exhaustive-deps warning, byte-identical at base |
| backend `src/` | **byte-identical to base** (`git diff 9cbfd12..HEAD -- backend/src` is empty); the backend battery/typecheck were NOT run by this worker (backend `node_modules` is not installed in this worktree — recorded honestly; zero backend surface changed) |
| Real-topology browser smoke (this slice's required evidence) | **committed, NOT RUN by this worker** (port discipline — the orchestrator runs it); §5 |

## 5. Real-topology browser proof (the Work Order's required evidence)

Runner: `backend/tests/integration/deployment/run-reality-repair-005-browser-smoke.ts`
— the REAL deployment entry spawned as a process (`bun src/index.ts`, the
docker-compose CMD, on the WORK-071 pglite dev runtime — real
PostgreSQL-WASM DatabaseClient + the SAME migrations as production —
`WORKFLOWOS_ROLE=all`, fresh temp data dir, `:3001`), the ACTUAL product
SPA via the Vite dev server (`:5188`, its `/api` proxy targeting `:3001`
exactly as deployed), and a REAL headless Chromium (Playwright, 1280×800).
Modeled exactly on the RR-003 smoke family (same topology, same
step()/shot()/journey.json transcript with sha-256 artifact digests under
`assets/reality-repair-005/`).

**Exit code: PENDING ORCHESTRATOR RUN.** The implementation worker did NOT
run the smoke (the dispatch's port discipline: a sibling specialist + port
collisions make that the orchestrator's job). The deterministic RED→GREEN
proofs (§3) are complete and locally executed; the browser proof legs are
armed for the orchestrator at the exact head:

| Leg | Proof (the Work Order's own required evidence in **bold**) |
| --- | --- |
| LEG0a/0b | the REAL entry boots + a V2 product route answers (401-not-404); the ACTUAL SPA is served |
| LEG1 | the consumer signs up through the real register UI → Home |
| LEG2 | the consumer creates their organization through the real Home onboarding (the RR-002 composed precondition) |
| LEG3 | Explore → the listing → the entitled free decision → **the EXISTING V2-002 install pins version 1 into the CONSUMER org** (the RR-003 journey) |
| LEG4 | the consumer RUNS the installed approval-gated workflow through the real browser Run flow (the real V2-005 request + start commands; the preview discloses the declared Approval-required consent fact) |
| LEG5 | the REAL V2-005 pause command (the t6 e2e pattern: the consumer's own session, `atStepId` = the IR approval node) parks the run in the waiting-for-approval state — verified through the reconstructed history read's `workflow.run.paused` `detail.atStepId` |
| LEG6 | **F-005 (a): the approval-waiting run APPEARS in Pending approvals** — "Waiting for you", the workflow name, the Open-the-run link — with NO Unavailable claim and NO false "not part of the product" copy; the record fact stays honest in Needs attention as Paused (screenshot `03`) |
| LEG7 | **the Open-the-run link navigates to `/workflows/:id?run=:runId`** and the run-status surface derives "Waiting for you" (the T10 F02 direct link, end-to-end; screenshot `04`) |
| LEG8 | the publisher creates the NEW HEAD VERSION through the REAL owner-only createVersion route (`POST /workflow-repository/workflows/:id/versions`) — a semantically different document (the V2-003 digest excludes presentation-only changes, so the literal binding changes to force a genuinely new immutable version row) |
| LEG9 | **F-005 (b): the installed workflow behind head version APPEARS in Updates** — "Update available", Version 2, the honest pinned-never-auto-updated vocabulary, the Open-the-workflow link — and NO adoption action duplicated on Home (screenshot `05`) |
| LEG10 | the Open-the-workflow link navigates to the workflow detail — where the REAL adoption action lives (the detail's own §19 update surface with Review update; `Version 2 — immutable`; `Installed: Version 1 — pinned · Enabled`; screenshot `06`) |
| LEG11 | **F-006 preserved: the Device issues panel still renders its honest Unavailable state** on the same Home (the TRUE deferral copy — unlike the two repaired false claims; screenshot `07`) |

## 6. Out-of-boundary observations (recorded for serialized successors)

- The runs read per caller org is issued independently by the Needs-attention
  surface and the Pending-approvals surface (the established per-surface read
  pattern in `HomePage` — `fetchRecentWorkflows`/`fetchAttentionRuns` already
  each re-read `organizations.listForUser`; each surface owns its own honesty
  states; no client-side shared attention state exists). A single shared
  read pipeline would couple the surfaces' error semantics — out of this
  slice's boundary.
- The workflow name on both new surfaces comes from the public V2-002
  workflow read (the F-007 architect-blessed name source, the same read the
  detail page consumes). The library's installed-card naming repair
  (F-007/REALITY-REPAIR-006) is untouched.
- A paused run NOT at an approval step stays only in Needs attention as
  *Paused* — no evidence, no claim. User-facing Approve/Resume/Pause/Cancel
  controls are REALITY-REPAIR-008's (F-008) scope; Home deliberately links
  to the run instead.
- Home does not add See-all links for the two new surfaces (not in the
  dispatch; Activity already owns the full timeline with the Needs-me
  filter).
- Two pre-existing HomePage tests were updated as the honest consequence of
  the repair (§3): the loading-count pin 2 → 4 (two more composed reads in
  flight) and the old Unavailable-surfaces test narrowed to Device issues
  (the old test pinned the defect itself).
- The smoke runner adds `console.*` statements in the backend's documented
  no-console runner-warning family (RR-002/RR-003 precedent: warnings, not
  errors). Backend `node_modules` is not installed in this worktree, so the
  backend battery/typecheck/lint were not run by this worker — with
  `backend/src` byte-identical to base (git-diff-verified), the risk surface
  is the committed smoke runner's TypeScript, which reuses the compiling
  RR-003/t6 patterns verbatim.

## 7. CI honesty

This worker executed no GitHub operations (no push, no PR, no review
triggers — the dispatch's hard prohibition). **No CI run exists for this
branch**: nothing was pushed, so no Actions execution was requested.
Missing CI runs are recorded as the external condition; they are never
claimed as a pass. All verification above was executed locally in the
development sandbox at the exact heads recorded (base `9cbfd12`, RED head
`931186c`, code head `51efd9e`, final head `3ceb0c0`).

## 8. Completion criteria mapping (the Work Order's own list)

| Work Order requirement | Evidence |
| --- | --- |
| "Compose Home's Pending approvals and Updates surfaces from existing V2-005/V2-002 reads and derivations already used by Workflow Detail and RunExperience" | §2 (the two fetchers over the existing run/history/versions/installation/workflow reads; the §15/§19 vocabularies; the T10 F02 link pattern) + §3 GREEN |
| "Do not create an aggregate authority or duplicate attention state" | §2 (no new routes/commands — reads only; the ONE shared derivation extracted into `workflow-ir-facts` so Home is not a third copy; per-surface presentation states only) |
| "Preserve honest unavailable behavior for device issues" | §2 (the untouched `UnavailableSurface`) + the F-006 pin test + smoke LEG11 |
| "Required browser proof: an approval-waiting run appears on Home and opens to the run" | smoke LEG6 + LEG7 (**exit code pending orchestrator run** — §5 records this honestly; the deterministic approvals tests are GREEN at head) |
| "…an installed workflow behind head version appears in Updates" | smoke LEG8 + LEG9 + LEG10 (**exit code pending orchestrator run**) + the deterministic updates tests GREEN at head |
| "…no false 'not part of the product' claims remain" | the no-false-copy test (GREEN) + smoke LEG6/LEG9's zero-claim assertions + the Device-issues TRUE deferral copy preserved |
| RED first, smallest conforming change, exact-head verification | `931186c` (RED, 11 failed / 19 passed at base) → `51efd9e` (the repair) → §4 matrix at `3ceb0c0` |
| The smoke script committed, not run by the worker | `3ceb0c0` (§5) |

**Worker conclusion:** REALITY-REPAIR-005 is implemented within its declared
boundary (frontend composition only, over the existing V2-005/V2-002 reads
and the derivations the workflow detail and RunExperience already hold; no
aggregate authority, no duplicated attention state, no adoption action on
Home, the device-issues deferral preserved), deterministically verified
(RED 11-failed/19-passed at base → GREEN 30/30 in the touched suite; full
frontend battery 391/391; typecheck clean; lint 0 errors / 1 inherited
warning), with the real-topology browser smoke runner committed and armed
for the orchestrator's run at the exact head. The gate now rests with the
Architect: exact-head review, the orchestrator's smoke execution, and merge
before REALITY-REPAIR-006..009 activate; deployment remains locked until
the serialized repairs + the R6 repeat audit + the R7 release decision
succeed.
