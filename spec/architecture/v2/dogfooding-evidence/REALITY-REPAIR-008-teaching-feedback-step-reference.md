# REALITY-REPAIR-008 — Teaching Feedback Step Reference (F-009)

**Work Order:** `spec/architecture/v2/work-orders/REALITY-REPAIR-008.md`
**Parent gate:** V2-REALITY-AUDIT-001 (Architect disposition F-009 ACCEPT)
**Dispatch:** GitHub Issue #29 (authorized after the REALITY-REPAIR-003 merge;
`PARALLEL_AFTER_003`; canonical state reconciled at `9cbfd12`)
**Base:** `main` at worker start — `9cbfd12233dcc659fd60751904fd30ab18fb2`
(the exact live main at dispatch; never rebased, never merged)
**Branch:** `feat/REALITY-REPAIR-008-teaching-feedback-step-reference`
**Code head:** the commit sequence on this branch — `5f3fed5` (RED tests) →
`dfcc41b` (the repair) → `c8113be` (the browser smoke runner) → the evidence
commit (this document)
**Files:** 2 frontend files (the component + its test) + the smoke runner +
this evidence + the assets README; **zero backend/src changes, zero route
changes, zero client.ts wire changes, zero teaching-authority or protocol
changes, zero spec/development-state changes, zero new packages**

## 1. The defect (F-009, MINOR — UX copy bug)

The audit's TEACH-2 journey (worker report FINDING-009): *practice feedback
for the `collect_posts` question says "…for step \"send_report\""*. The
audited surface: the TeachExperience practice feedback template.

**Root cause (frontend presentation state — NOT the teaching authority):**
`frontend/src/components/teach/TeachExperience.tsx` held the practice
feedback in **one question-unscoped React state** —
`useState<string | null>(null)` — set by whichever practice question was
attempted **last** and rendered inside **every** practice question's
`<section aria-label="Practice">` template:

```tsx
{practiceFeedback && (
  <p className="text-xs text-muted-foreground">{practiceFeedback}</p>
)}
```

The backend feedback string is correct **by construction**: the V2-006
teaching-session service's fixed templates interpolate the **attempted**
step id (`attemptPractice`: `… for step "${input.nodeId}".`), and the route
binds `nodeId` from the wire verbatim. But the template slot was never bound
to the question being assessed, so after a learner attempted the
`send_report` question, that question's feedback — which correctly names
`send_report` — rendered **under the `collect_posts` question too** (and
under every other question). The wrong step reference in the feedback under
the `collect_posts` question is the audited F-009.

## 2. The repair (a 3-line presentation-state scoping — nothing else)

Per the Work Order ("Correct the practice-feedback step reference so
feedback names the actual checkpoint/step being assessed. No teaching
authority or protocol changes"):

1. **`frontend/src/components/teach/TeachExperience.tsx`** — the practice
   feedback state becomes a map **keyed by the authority's own question id**
   (`useState<Record<string, string>>`), set per attempt with a functional
   update (`{ ...prev, [question.id]: result.result.feedback }` — a
   re-attempt supersedes that question's own slot exactly as the authority's
   latest attempt supersedes), and rendered **only in that question's own
   section** (`practiceFeedback[question.id]`). The rendered text remains
   the backend's verbatim feedback string; the question prompt, options,
   wire body (`{ nodeId, answer }`), and every lesson/assessment surface are
   untouched.

After the repair, the feedback under a question always names the step THAT
question assesses (the authority derives the string from the attempted
nodeId, and the wire pins that nodeId — LEG7's network capture proves it).
An unattempted question renders no feedback at all.

**Non-goals honored:** no teaching-authority change (the V2-006 service and
its transport route are byte-identical to base), no protocol change, no
`client.ts` change, no backend change, no drive-by fixes to other teach copy
(recorded in §6 instead), no special-casing of `collect_posts` (the fix is
the general scoping rule, pinned by the derivation-rule test).

## 3. Deterministic regression (RED at base → GREEN at head)

The RED commit (`5f3fed5`) lands the failing tests first, in the existing
`frontend/src/pages/TeachExperience.test.tsx` suite — a dedicated
REALITY-REPAIR-008 block (3 tests) whose fixtures mirror the authority's own
derivations VERBATIM (the questions exactly as the V2-006 `listPracticeQuestions`
derives them — id `pq-${nodeId}`, the step's own prompt, the distinct
declared-semantics options — and the attempt feedback exactly as its fixed
templates interpolate the attempted step), on the audit's TEACH-2 topology
(`collect_posts` → `send_report`):

1. **the Work Order's required regression (the known case)** — after the
   `send_report` question is attempted, the `collect_posts` question's
   section must NOT carry the `send_report` feedback; after the
   `collect_posts` question itself is answered, its feedback names
   `collect_posts` (with the wire pin: the attempt POSTs
   `{ nodeId: 'collect_posts', answer: 'github.repository.read' }`);
2. **the derivation rule** — each practice question's section keeps its OWN
   attempt's feedback after other questions are attempted;
3. **the boundary** — a never-attempted question renders NO feedback while
   an attempted one renders its own.

**At base `9cbfd12` (run before any implementation):
TeachExperience.test.tsx — 3 failed / 13 passed (16).** Every failure
renders the F-009 defect's own visible state — the shared feedback
`Not the workflow declaration for step "send_report". …` rendered inside
the `collect_posts` question's section (the exact audited DOM).

**At head — GREEN: 16/16** (the 13 pre-existing tests green at every step,
including the existing single-question practice test — the attempt travels
the real route with verbatim feedback — and the whole
assessment/completion/evidence battery: **all lesson/assessment evidence
remains unchanged**).

## 4. Verification matrix at the exact head

| Check | Result |
| --- | --- |
| Touched suite (`frontend/src/pages/TeachExperience.test.tsx`) | **16/16 PASS** (13 pre-existing + 3 new) |
| Full frontend battery (`cd frontend && bun run test`) | **383/383 PASS (38 files)** — the 380 at the RR-003 merge + 3 new |
| `bun run typecheck` (frontend) | **clean** (exit 0, zero diagnostics) |
| `bun run lint` (frontend) | **0 errors / 1 inherited warning** (ArchitecturePage `react-hooks/exhaustive-deps`, untouched — the documented family) |
| Boundary diff at the GREEN head (`dfcc41b`, before the smoke runner commit): `git diff 9cbfd12..HEAD -- backend/ spec/development-state/ frontend/src/api/` | **empty (0 bytes)** |
| Boundary diff at the final head: `git diff 9cbfd12..HEAD -- backend/src spec/development-state/ frontend/src/api/` | **empty (0 bytes)** — the only backend-path delta on the branch is the dispatch-mandated smoke runner itself (`backend/tests/integration/deployment/run-reality-repair-008-browser-smoke.ts`, a test file — no backend product code) |
| `bunx tsc --noEmit` (backend) | **the 2 documented inherited `workflow-deployments.route.ts` TS2739 errors only — zero in the smoke runner** (backend/src byte-identical to base) |
| `bunx eslint tests/integration/deployment/run-reality-repair-008-browser-smoke.ts` | **0 errors / 9 warnings** (the `no-console`/`no-explicit-any` runner family — the RR-003/RR-004 runners record the same) |
| Backend full battery | **NOT RUN by this worker** — zero backend/src changes on this branch (git-diff-verified); the worktree's backend `node_modules` is a read-only symlink borrow (see below), and no backend surface changed |
| Browser E2E sweep (`tests/e2e-browser/`) | **NOT RUN by this worker** — no e2e-visible surface changed (the repair is intra-component presentation state); the t9 teach-me spec is unchanged and its deterministic sibling (TeachExperience.test.tsx) is 16/16 |

**node_modules borrow disclosure (per the dispatch):** this worktree's
`frontend/node_modules` and `backend/node_modules` are **read-only symlinks
into the main clone** (`/home/z/workflowos/frontend/node_modules`,
`/home/z/workflowos/backend/node_modules`) — lockfile-identical to the base
commit's lockfiles (no install was performed, no packages added, no writes
to the shared cache by this worker; the borrow existed at dispatch and is
disclosed here). If a battery run shows concurrent-run anomalies (other
specialists share the symlinked cache), re-run and report only stable
numbers — none were observed in this session; all numbers above are from
single clean runs at the recorded heads.

## 5. Real-topology browser proof (the smoke — COMMITTED, NOT RUN)

Runner: `backend/tests/integration/deployment/run-reality-repair-008-browser-smoke.ts`
— modeled EXACTLY on the merged RR-003 runner: the REAL deployment entry
spawned as a process (`bun src/index.ts`, the docker-compose CMD, on the
WORK-071 pglite dev runtime — real PostgreSQL-WASM DatabaseClient + the
SAME migrations as production — `WORKFLOWOS_ROLE=all`, fresh temp data dir,
`:3001`), the ACTUAL product SPA via the Vite dev server (`:5188`, its
`/api` proxy targeting `:3001` exactly as deployed), and a REAL headless
Chromium (Playwright, 1280×800); `step()`/`shot()`/`journey.json` with
sha-256 digests under `assets/reality-repair-008/`.

The PUBLISHER is seeded through the REAL HTTP routes only (register →
login → org → public workflow → free listing → publish) with the audit's
TEACH-2 topology (`collect_posts` → `send_report`). The LEARNER gets
NOTHING pre-seeded and does everything through the real browser UI:

| Leg | Proof |
| --- | --- |
| LEG1 | the learner **signs up through the real register surface** (Create one → Create account) and lands on Home |
| LEG2 | the learner creates their organization through the real Home onboarding (the RR-002 composed precondition) |
| LEG3 | Explore → the listing → the entitled free decision → **the EXISTING V2-002 Install pins Version 1 into the LEARNER org** (screenshot `01`) |
| LEG4 | the library Installed tab → Open: the cross-org public workflow detail loads (the RR-003 composed precondition) → **Teach Me opens beside Run**; the session create-or-converges bound to the pinned version (`Version 1 — the lesson is bound to it`) |
| LEG5 | the real §12 lesson: Start lesson → `Step 1 of 2 — Collect the open posts` (the V2-003 presentation label) → "I've done it" → `Step 2 of 2 — Email the weekly report` → "I've done it" → **All steps confirmed** (the checkpoint flow unchanged) |
| LEG6 | **THE PRACTICE MOMENT (F-009's exact scenario):** the authority's own practice questions render (the `collect_posts` question + the `send_report` question); the learner attempts the `send_report` question FIRST with a wrong answer — the REAL authority answers with its verbatim feedback for the ATTEMPTED step under its own question, and **the `collect_posts` question's section carries NO feedback naming `send_report` in the real rendered DOM** (at base the one question-unscoped feedback state rendered inside EVERY practice section — the audited defect); the network capture shows the attempt POST carried `nodeId: 'send_report'` (screenshot `02`) |
| LEG7 | **THE KNOWN CASE (the Work Order's required regression):** the learner answers the `collect_posts` question itself — the feedback under the `collect_posts` question names **`collect_posts`** (the authority's own string for THAT attempt, verbatim: `Correct: the workflow declares exactly this semantics for step "collect_posts".`) and **NOT `send_report`**; the `send_report` question **keeps its OWN feedback**; the network capture proves the practice POST carried `nodeId: 'collect_posts'` — the step actually being assessed (screenshot `03`) |
| LEG8 | **all lesson/assessment evidence unchanged:** the assessment surface ("Show you know it") renders as before → the learner submits the real assessment (order + declared-semantics recall) → **Lesson complete** (terminal; no lifecycle commands) → the teaching-evidence surface renders with its §12 separation vocabulary (`Kept separate from run evidence — learning never counts as execution`) → **zero runs** in the learner org (learning never executed the workflow) (screenshot `04`) |

**Run at the code head: PENDING ORCHESTRATOR RUN** (the exit code, duration,
and per-leg timings will be recorded in
`assets/reality-repair-008/journey.json` when the orchestrator executes it —
port discipline: `:3001`/`:5188` belong to the orchestrator; this worker
never started a dev server and never ran the smoke).

## 6. Out-of-boundary observations (recorded for serialized successors)

- **The practice prompt surfaces internal node ids** while the lesson body
  uses the V2-003 presentation labels (F-T4-001): the V2-006 authority's own
  question prompt is `Which declared semantics does the workflow assign to
  step "collect_posts"?` — an internal id in user-facing copy. The frontend
  renders the authority's prompt verbatim (transport honesty — correct), so
  this is a presentation question for the authority/AEP, NOT a frontend fix
  this slice may make. Recorded, untouched (the Work Order forbids drive-by
  copy changes).
- **The assessment exact-token grading observation** (the audit's recorded
  observation #1, TEACH-3): the recall assessment is graded by exact string
  equality with the declared semantics token. Unchanged and out of this
  slice's boundary (Architect-disposition territory).
- **The backend battery is honestly not run** by this worker (zero
  backend/src changes; the read-only node_modules borrow is disclosed in
  §4). The orchestrator may run it at delivery if it chooses; nothing in
  this branch can affect it (git-diff-verified).

## 7. CI honesty

This worker made **zero GitHub API calls of any kind** (no `git push`, no
`gh` CLI, no REST checks — the orchestrator owns ALL delivery), so the CI
status of this branch head is **not checked by this worker** and is the
orchestrator's to verify at delivery. The repository's GitHub Actions has
had zero executions at every prior recorded checkpoint (the RR-003/RR-004
evidence) — missing CI runs remain an external condition, never claimed as
a pass. Every number in §3/§4 is from a command actually run at the
recorded heads in this worktree; the smoke exit code is honestly PENDING
(§5).

## 8. Completion criteria mapping (the Work Order's own list)

| Work Order requirement | Evidence |
| --- | --- |
| "Correct the practice-feedback step reference so feedback names the actual checkpoint/step being assessed" | §2 (the per-question scoping — the feedback under a question is the authority's string for THAT question's own attempt) + §3 test 1 + LEG7 |
| "No teaching authority or protocol changes" | §4 (backend/src byte-identical to base; zero route/service/wire changes; the V2-006 templates untouched) |
| Required regression: "the known `collect_posts` feedback case names `collect_posts`, not `send_report`" | §3 test 1 (deterministic, GREEN) + LEG6/LEG7 (the real-DOM proof, pending the orchestrator's run) |
| "…while all lesson/assessment evidence remains unchanged" | §3 (13/13 pre-existing tests green — the assessment, completion, evidence-separation, and practice tests) + LEG8 + the full battery 383/383 |
| Deterministic tests (the RED-first discipline) | §3 (RED 3 failed / 13 passed at base `9cbfd12` → GREEN 16/16 at head) |
| Real-browser proof through the real teaching flow | §5 (the committed runner: learner signup → org → install → Teach Me → lesson → the practice moment → the known case → unchanged assessment/evidence) — **PENDING ORCHESTRATOR RUN** |
| "Architect merge after exact-head verification. Required before R6." | the gate rests with the orchestrator (the smoke run + delivery) and then the Architect |

**Worker conclusion:** REALITY-REPAIR-008 is implemented within its declared
boundary (a 3-line frontend presentation-state scoping; no teaching
authority, protocol, backend, wire, or governance change), deterministically
verified (RED 3 failed / 13 passed at base → GREEN 16/16 touched suite;
full battery 383/383; typecheck clean; lint 0 errors), with the
real-topology browser smoke committed and armed for the orchestrator (its
exit code honestly pending). The F-009 copy defect is repaired at its root:
the feedback template is bound to the question being assessed, so the
`collect_posts` question's feedback names `collect_posts` — never
`send_report`. The gate now rests with the orchestrator (the smoke run +
the exact-head review-trigger delivery) and then the Architect: exact-head
review and merge before R6; deployment remains locked until the serialized
repairs + the R6 repeat audit + the R7 release decision succeed.
