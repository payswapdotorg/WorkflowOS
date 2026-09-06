# REALITY-REPAIR-007 — User-Facing Run Lifecycle Controls (F-008)

**Work Order:** `spec/architecture/v2/work-orders/REALITY-REPAIR-007.md`
**Parent gate:** V2-REALITY-AUDIT-001 (Architect disposition F-008 ACCEPT)
**Dispatch:** GitHub Issue #28 (authorized by the REALITY-REPAIR-003 merge at
`a9933da`, advanced by the governance reconciliation commits `c6e7825` +
`9cbfd12`; `basePolicy: current-main-at-worker-start`)
**Base:** `main` at worker start — `9cbfd12233dcc653459fd60751904fd30ab18fb2`
(the exact live main at dispatch; no rebase, no merge, no sibling reads)
**Branch:** `feat/REALITY-REPAIR-007-run-lifecycle-controls`
**Commit sequence:** `1872ecc` (RED tests) → `9596acf` (the repair) →
`20bba8e` (the browser smoke runner) → this evidence commit
**Files:** 3 frontend files (`frontend/src/api/client.ts` +19 lines,
`frontend/src/components/run/RunExperience.tsx` +146,
`frontend/src/pages/RunExperience.test.tsx` +266) + the smoke runner
(`backend/tests/integration/deployment/run-reality-repair-007-browser-smoke.ts`
+862, a new file in the established runner family) + these evidence
artifacts; **all changes are pure insertions (0 deletions); zero
backend/src changes, zero route changes, zero spec-authority changes,
zero authorization-semantics changes, zero new npm packages**

## 1. The defect (F-008, the audit's CRITICAL release blocker)

The audit's RUN-4 journey (V2-REALITY-AUDIT-001, FINDING-008):
"a run that pauses at an approval gate can NEVER be resumed through the
product — 'Waiting for you' is display-only; there is no
Approve/Resume/Pause/Stop/Retry control anywhere in the run UX. The
human-approval loop is unclosable by the human."

`RunExperience.tsx` — the run-status surface — derives and renders the
§15 "Waiting for you" state (paused + the history-derived pause at an
approval step), but the derivation fed a `<p>` and nothing else: no
action control composed the V2-005 command side into the run UX. The
backend commands ALL existed and were route-tested
(`POST /workflow-runs/runs/:runId/{start,pause,resume,interrupt,cancel,complete,fail}`
+ the step/invocation/evidence/attestation records — the V2-005
command-envelope-guarded lifecycle); the E2E specs drove them
executor-side via the API. The run/start path had its UI composition
(`request` + `start` through the Run preview), and the T7 recovery
surface had its own Resume/Stop for the LATEST paused/failed/cancelled
run — but the run-status surface itself (the surface that presents the
approval gate, the `?run=` deep-link target, the Home "Open the run"
destination) offered the human nothing. A consumer who ran a workflow
with an approval node and reached "Waiting for you" could not close the
loop through the product.

**Provenance honesty on the audit's client-surface note:** the finding's
"the `workflowRuns` client surface contains only
`listForOrganization/getHistory/request/start`" predates V2-017 T7: at
this branch's base the client also carried `resume`/`cancel` (T7's
recovery-surface commands). The GENUINELY missing lifecycle consumer was
`pause` — added by this slice; `resume`/`cancel` are reused verbatim
(the RR-004 precedent: add the missing typed consumers, zero wire
invention). No V2-005 contract was re-implemented.

**Verified before implementing:** the V2-005 route/service surface
contains NO distinct approval command (`workflow-runs.route.ts`:
start/pause/resume/interrupt/cancel/complete/fail + records; the run
service's `resumeRun` implements the resume-with-human-confirmation
semantics — the same attempt continues at the recorded
`pausedAtStepId`, or a crash-retry new attempt). Per the Work Order's
own words, "Approve" is therefore implemented as the user-facing LABEL
for the EXISTING `resume` command — no new approval authority, no new
command, no semantics change.

## 2. The repair (frontend composition only — the Work Order's boundary)

1. **`frontend/src/api/client.ts`** — ONE added typed consumer:
   `workflowRuns.pause(runId)` → `POST /workflow-runs/runs/:runId/pause`
   with the deterministic `commandId` + `correlationId` envelope, modeled
   exactly on the existing T7 lifecycle consumers' shapes (typed,
   `ApiError`-preserving, zero wire invention — the diff is +19 lines of
   pure addition).
2. **`frontend/src/components/run/RunExperience.tsx`** — the run-status
   surface now composes the lifecycle controls next to the §15 state
   word:
   - **waiting at an approval gate** (paused + the history-derived
     "Waiting for you") → the **Approve** action — the user-facing label
     for the existing V2-005 `resume` (the resume-with-human-confirmation
     semantics; one click — the consent act itself, matching the T7
     recovery surface's one-click Resume discipline);
   - **paused elsewhere** → the generic **Resume** label (the same real
     command);
   - **running** → **Pause** (running → paused is the only transition the
     frozen run state machine admits into paused);
   - **requested/running/paused** → **Stop** behind the §2.4 explicit
     choice (the recovery surface's exact consequential-action pattern:
     "This ends the run — it can't be restarted." → Stop it / Keep it
     going);
   - **terminal** (completed/failed/cancelled) → no controls (lifecycle
     immutability).

   Discipline preserved: the offered actions only FOLLOW the frozen
   transition table for presentation — the UI never re-implements
   legality. Idempotency and forbidden transitions stay enforced
   SERVER-SIDE by the V2-005 command envelopes (the backend owns every
   transition decision). One in-flight guard prevents a double command;
   a typed rejection (e.g. 409 `workflow-run-terminal` on a concurrently
   terminal run) renders verbatim as an alert — never a fabricated
   success, never a parallel run state; the authoritative refetch
   (`onRunsChanged` → the page's runs re-read) governs the next state
   word — never the command's echo.

**Non-goals honored:** no new approval route, no workflow state machine,
no execution authority, no command-semantics changes, no V2-005
lifecycle rule changes, no backend/src changes, no
spec/development-state changes, no new packages. The T7 recovery surface
is untouched (its pinned journeys remain green — §4).

## 3. Deterministic regression (RED at base → GREEN at head)

The RED commit (`1872ecc`) lands the failing tests first — a new
`REALITY-REPAIR-007 — the run lifecycle controls (F-008)` block in
`RunExperience.test.tsx` (9 tests). **At base `9cbfd12`** (run before any
implementation): **8 failed / 30 passed (38 total)** — the 29
pre-existing T6/T10 tests stay green; the one passing new test is the
terminal-runs boundary pin. Every failure renders the defect's own
visible state — the waiting / running / paused run-status surface with
NO action control:

- the waiting-for-you state offers NO Approve control (the F-008 core);
- Approve does not send the REAL V2-005 resume command (the
  commandId+correlationId envelope + the refetched Running record);
- the typed envelope rejection is not rendered verbatim (no fabricated
  success);
- a running run offers NO Pause control (the safe-pause boundary);
- a paused non-approval run offers NO generic Resume control;
- Stop does not carry the §2.4 explicit choice → the REAL cancel command
  → the terminal state with no controls;
- a requested (Ready) run offers no Stop (the frozen-table boundary);
- no in-flight disabling (the double-command guard).

**At the repair head (`9596acf`) — GREEN:** **38/38** in the suite (the
29 pre-existing + 9 new), the refetch-derived state transitions asserted
from the authoritative mocked reads (never the command echoes), and the
envelope bodies asserted on every command POST.

## 4. Verification matrix at the exact head

Every number below is from a command actually run in this worktree (the
frontend `node_modules` and backend `node_modules` are symlinks to the
main clone's lockfile-identical installs — a read-only borrow, never
mutated, exactly as the RR-004 precedent discloses; this worktree
provisions no installs of its own):

| Check | Result |
| --- | --- |
| Frontend suite (`bun run test`, `frontend/`) | **389/389 PASS (38 files)** — the 380 at base (verified at `9cbfd12` before any change: 380/380) + 9 new; includes the existing **run/start journey** (`RunExperience.test.tsx`, 38/38) and the **recovery/failure journey** (`RecoveryExperience.test.tsx`) suites green — the Work Order's "existing run/start/recovery/failure journeys remain green" |
| `bun run typecheck` (frontend) | **clean** (exit 0) |
| `bun run lint` (frontend) | **0 errors / 1 inherited warning** (ArchitecturePage `react-hooks/exhaustive-deps`, byte-identical at base) |
| `bunx tsc --noEmit` (backend) | **ONLY the 2 documented inherited `workflow-deployments.route.ts` TS2739 errors** (zero errors in the new runner; `backend/src` is byte-identical to base) |
| `bunx eslint tests/integration/deployment/run-reality-repair-007-browser-smoke.ts` (backend) | **0 errors / 9 warnings** (the `no-console`/`no-explicit-any` runner family — the RR-003/RR-004 runner family records the same) |
| `git diff 9cbfd12..HEAD -- backend/src spec/development-state/` | **EMPTY** — byte-identical to base (0 lines) |
| `git diff 9cbfd12..HEAD -- backend/` | **ONLY the new smoke runner** under `backend/tests/integration/deployment/` (+862, a new file — the dispatch's own mandated path); zero src/route/config/manifest/package changes |
| `git diff 9cbfd12..HEAD -- frontend/src/api/client.ts` | **ONLY the added `pause` typed consumer** (+19 lines, pure addition — the RR-004 "client consumers added, zero wire invention" precedent) |
| Backend full battery / e2e-browser (t6/t7 real-browser journeys) | **honestly NOT RUN by this worker** — the e2e specs and the smoke spawn the `:3001` backend and dev servers, which belong to the orchestrator under this dispatch's port discipline; never claimed as a pass. The deterministic journey suites above are green and the static checks prove zero backend surface changed |
| Real-topology browser smoke (this slice's required evidence) | **committed, NOT RUN — §5, PENDING ORCHESTRATOR RUN** |

## 5. Real-topology browser proof (the Work Order's required evidence)

Runner: `backend/tests/integration/deployment/run-reality-repair-007-browser-smoke.ts`
— modeled EXACTLY on the merged RR-003 runner family: the REAL deployment
entry spawned as a process (`bun src/index.ts`, the docker-compose CMD,
on the WORK-071 pglite dev runtime — real PostgreSQL-WASM DatabaseClient
+ the SAME migrations as production — `WORKFLOWOS_ROLE=all`, fresh temp
data dir, `:3001`), the ACTUAL product SPA via the Vite dev server (its
`/api` proxy targets `:3001` exactly as deployed, `:5188`), and a REAL
headless Chromium (Playwright, 1280×800). The **publisher** is seeded
through the REAL HTTP routes only (register → login → org → public
approval-gated workflow → free listing → publish); **the consumer gets
NOTHING pre-seeded** and does everything through the real browser UI.

**Run: PENDING ORCHESTRATOR RUN** (port discipline — `:3001`/`:5188`
belong to the orchestrator, who owns the smoke execution and the
delivery). The runner is committed, compiles clean (backend `tsc`: only
the 2 documented inherited errors; eslint: 0 errors), and writes its
transcript + sha-256 digests to
`spec/architecture/v2/dogfooding-evidence/assets/reality-repair-007/journey.json`
on its run. The designed legs:

| Leg | Proof |
| --- | --- |
| LEG1 | the consumer **signs up through the real register surface** and lands on Home |
| LEG2 | the RR-002 first-run onboarding creates the consumer's organization through the real browser UI (the composed precondition) |
| LEG3 | Explore → the listing → the entitled free decision → the EXISTING V2-002 install pins the **approval-gated** version 1 into the CONSUMER organization |
| LEG4 | the library Installed tab → Open: the cross-org approval-gated workflow detail loads (the RR-003 regression — the existing run journey base) |
| LEG5 | the EXISTING run journey regression: the real Run preview → confirm → the REAL V2-005 request+start through the browser → Running (network capture + the API runs read) |
| LEG6 | **safe pause through the USER's control**: the user clicks Pause → the REAL pause command → Paused, verified through the history read (`workflow.run.paused`) |
| LEG7 | the user's Resume (the generic label) → the REAL resume command → the run returns to execution (runs + history reads) |
| LEG8 | the run reaches the **waiting-for-user/approval state** (the RR-005 LEG5 / t6 pattern: the consumer's OWN session drives the REAL executor-side pause AT the IR approval node, `atStepId = review_gate`) → reload → the history-derived "Waiting for you" |
| LEG9 | **THE F-008 CORE**: the user clicks **Approve** in the browser → the REAL V2-005 resume command (the resume-with-human-confirmation semantics) → the run **returns to execution**, verified through the history read (the ordered pause-at-approval → resumed timeline) and the runs read |
| LEG10 | **safe cancel through the USER's control**: the waiting run → Stop → the §2.4 explicit choice → Stop it → the REAL cancel command → Cancelled with NO lifecycle control remaining (terminal honesty) |
| LEG11 | the **honest forbidden-transition boundary**: a concurrently-cancelled waiting run → the user's stale Approve → the envelope's typed 409 `workflow-run-terminal` rejection rendered VERBATIM (never a fabricated success) → the re-read record shows Cancelled |
| LEG12 | the **envelope's idempotency** (server-side, the REAL routes the UI composes): the SAME pause envelope re-delivered converges (`executed: false`, the same run identity) and the timeline records the pause ONCE |

## 6. Out-of-boundary observations (recorded for serialized successors)

- The T7 recovery surface still renders its own Resume/Stop for the
  LATEST paused/failed/cancelled run (untouched by this slice — its
  pinned journeys stay green). For a paused latest run the detail page
  now presents the run-status controls AND the recovery controls: two
  surfaces, one vocabulary, the same real commands. Consolidating them
  is a presentation question for a successor, NOT an authorization
  change.
- No "Reject" action is offered at the approval gate: V2-005 has no
  reject command (the IR's rejected-outcome edge is the executor's
  step-outcome territory). Stop is the honest don't-continue action.
  A governed change would be required to invent anything else — not
  proposed.
- The UI's Pause command sends no `atStepId` (the executor's report of
  where execution stands is the executor's fact; the UI never fabricates
  the step). The approval-gate pause in the smoke is therefore driven
  executor-side (the t6 pattern) — honest to the command semantics.
- After a typed lifecycle rejection the surface does not auto-refetch
  (the T7 recovery surface's same discipline): the verbatim rejection is
  the honest signal, and a reload presents the authoritative record. A
  refetch-on-rejection is a presentation polish question for a successor.
- The e2e-browser t6/t7 real-browser journeys could not be executed by
  this worker (they spawn `:3001` + dev servers — the orchestrator's
  territory under this dispatch). Their selectors were re-audited
  statically against the new controls (all t6/t7 selectors are scoped to
  their own regions; the one unscoped `page.getByRole('button', { name:
  'Stop it' })` in t7 resolves to the recovery panel's confirm — the
  run-status panel is closed at that point in t7's journey).
- The backend full battery was not run by this worker (zero backend
  surface changed — byte-identical `backend/src`, verified by git diff).

## 7. CI honesty

The repository's GitHub Actions has **zero executions** repository-wide
(recorded as the external condition at the RR-003 merge; this worker
performed **zero GitHub operations** — no push, no `gh` CLI, no API
calls; delivery is the orchestrator's per the dispatch). Missing CI runs
are never claimed as a pass. All verification above was executed locally
in the development sandbox at the exact heads recorded.

## 8. Completion criteria mapping (the Work Order's own list)

| Work Order requirement | Evidence |
| --- | --- |
| "Browser proof of a run reaching a waiting-for-user/approval state, then user action returning it to execution" | LEG8 → LEG9 (the user's Approve → the real resume command → execution, verified through the history + runs reads) + the deterministic Approve tests (§3) |
| "Browser proof of safe cancel/pause where applicable" | LEG6 (the user's Pause → the real command → Paused) + LEG10 (Stop → the §2.4 choice → the real cancel → Cancelled, no controls remain) |
| "Idempotency and forbidden-transition behavior remain enforced by V2-005 command envelopes" | LEG11 (the typed 409 `workflow-run-terminal` rendered verbatim — never a fabricated success) + LEG12 (the converged re-delivery, `executed: false`, one timeline entry); the UI only FOLLOWS the frozen transition table for presentation — legality stays server-side |
| "Existing run/start/recovery/failure journeys remain green" | the deterministic run/start journey 38/38 (incl. the 29 pre-existing T6/T10 tests) + the recovery/failure suite green in the full battery **389/389**; the e2e-browser family honestly not run by this worker (port discipline, §4/§6) |
| "Deterministic tests plus real browser proof" | §3 (RED 8-failed/30-passed at base → GREEN 38/38) + §5 (the real-topology runner committed; its RUN is the orchestrator's — the exit line is honestly PENDING) |
| "Approve / Resume ... implemented through the existing V2-005 resume command/envelope; no separate approval authority" | verified against the route/service surface first (no approve command exists); Approve IS the resume label (§2) — LEG9 proves the real resume command |
| "Do not alter V2-005 lifecycle rules" | `backend/src` byte-identical to base (git-diff-verified, §4); the frozen transition table is only FOLLOWED for presentation |

**Worker conclusion:** REALITY-REPAIR-007 is implemented within its
declared boundary (frontend composition only — one added typed client
consumer and the run-status lifecycle controls over the EXISTING V2-005
command routes with their command envelope; no new authority, no
approval command, no state machine, no backend change), deterministically
verified (RED at base → GREEN at head; the full frontend battery
389/389; typecheck clean; lint 0 errors). The real-topology browser
smoke runner is committed and armed for the orchestrator (exit code
pending its run — port discipline). The human approval loop is now
closable by the human: the waiting surface offers Approve (the resume
label), the running surface offers Pause, and the non-terminal states
offer Stop behind the explicit choice — with the envelope's typed
rejections rendered honestly. The gate now rests with the orchestrator
(the smoke run + the exact-head review-trigger delivery) and then the
Architect: exact-head review and merge before REALITY-REPAIR-008..009
activate; deployment remains locked until the serialized repairs + the
R6 repeat audit + the R7 release decision succeed.
