# REALITY-REPAIR-009 — Human-Readable Version Diff (F-010)

**Work Order:** `spec/architecture/v2/work-orders/REALITY-REPAIR-009.md`
**Parent gate:** V2-REALITY-AUDIT-001 (Architect disposition F-010 ACCEPT —
"Minor presentation defect; preserve the authoritative comparison payload
and honest non-equivalence")
**Dispatch:** GitHub Issue #30 (RR-009-A, the resident specialist slice:
implementation + tests + smoke script + evidence only — NO delivery, NO
smoke run; the orchestrator owns both)
**Base:** `main` at worker start — `9cbfd12` (the live head, the RR-003
merge's reconciled frontier; no rebase, no merges)
**Branch:** `feat/REALITY-REPAIR-009-human-readable-version-diff`
**Commit sequence:** RED tests (`0268d63`) → the repair (`f8b29d3`) → the
browser smoke runner (`a24ed39`) → this evidence record
**Files:** frontend presentation only — 2 product files
(`versions-language.ts`, `VersionsExperience.tsx`) + 2 test files + the
smoke runner + 2 evidence artifacts; **zero backend/src changes, zero
client wire-surface changes (frontend/src/api byte-identical to base),
zero spec/development-state changes, zero comparison-semantics changes**

## 1. The defect (F-010, the audit's VER-2 journey)

The workflow detail's version comparison — the §19 "What changed" surface
the consumer opens with **Review update** — rendered the V2-011 comparison
payload's internal transport string **verbatim**:

> `Not equivalent: node collect_posts inputs: [{…}] != [{…}]`

The comparison authority (backend `workflow-optimization/internal/
comparison.ts`) reports its first task-surface divergence as a single
deterministic string — `<surface>: <baseline JSON> != <candidate JSON>` —
a transport envelope meant for machines. The product showed that raw
envelope to end users: node ids instead of step names, JSON blobs instead
of values, a ` != ` operator mid-sentence. The audit's VER-2 leg recorded
it honestly: "diff shown as raw internal JSON (F-010)" — the journey
PASSED with the defect noted.

The same leak existed on the §20 improvement proposal card (the identical
payload shape through the identical `correctnessLine` helper in the same
`VersionsExperience` component the finding names).

**The authority was never at fault:** the comparison, its verdict, and its
modeled estimates were correct and honest; only the presentation dumped
the transport shape.

## 2. The repair map (derivation over the payload — no semantics change)

Per the Work Order ("Render the existing V2-011 comparison payload as a
human-readable node/field summary rather than raw internal JSON. Preserve
the authoritative comparison result and explicit non-equivalence
statement. No optimization authority or comparison semantics change."):

1. **`frontend/src/components/versions/versions-language.ts`** — the pure
   presentation module gains `versionDiffSummary(comparison, labels)`: it
   PARSES the payload's own `firstDivergence` string against the grammar
   the comparison authority itself emits (the nine surface forms: `start`,
   `workflow inputs`, `workflow outputs`, `node ids`, `node <id> <field>`,
   `node <id>`, `edges`, `human node <id> spec`, `human nodes`), splits on
   the first top-level ` != ` with a JSON-string-aware scanner (a ` != `
   inside a string value stays inside the value), `JSON.parse`s the two
   value halves, and re-presents them:
   - node ids resolve through the **V2-003 presentation labels**
     (`stepLabel` — the internal node id never renders, F-T4-001);
   - per-node fields render as consumer words (`its inputs` / `its
     outputs` / `its failure policy` / `its placement` / `its completion
     evidence`);
   - values render through `readableValue` — names and values,
     recursively (e.g. `name: repository, type (kind: string), binding
     (kind: literal, value: payswapdotorg/WorkflowOS)`) — never a JSON
     blob;
   - a divergence the payload's own grammar does not describe degrades
     honestly (`undescribed`) — never raw internals, never a guessed
     equivalence;
   - **equivalence stays the payload's own boolean** — an equivalent
     comparison yields `none` (no divergence block at all).
   `correctnessLine` keeps the authoritative verdicts verbatim
   (`Task-for-task equivalent - verified` / `Not equivalent`) and no
   longer embeds the raw transport string.
2. **`frontend/src/components/versions/VersionsExperience.tsx`** — a
   shared `DivergenceBlock` renders the summary on BOTH payload consumers
   in the component family: the §19 "What changed" detail
   (`Installed version: …` / `New version: …`, right after the verdict
   line, before the compatibility line and the estimates) and the §20
   proposal card (`Current version: …` / `Proposed version: …`). Every
   other surface — the adoption gate, the approval gate, the estimates,
   the version history — is untouched.

**Non-goals honored:** no comparison-semantics change (the frontend never
re-derives, re-scores or re-classifies anything — the payload is the
input), no new optimization authority, no backend/src change, no
`client.ts` wire change (`workflowRepository`/`optimization.compareVersions`
are consumed exactly as before), no diff-algorithm invention (the
payload's own structure is parsed, not recomputed), no new npm packages.

## 3. Deterministic regression (RED at base → GREEN at head)

The RED commit (`0268d63`) landed the failing tests FIRST. **At base
`9cbfd12`:** `frontend/src/pages/VersionsExperience.test.tsx` —
**4 failed / 19 passed (23)**; every failure's DOM dump shows the
defect's own visible state (`Not equivalent: node fetch inputs: [{…}] !=
[{…}]` — the raw internal JSON envelope):

- the node-field summary test (no exact `Not equivalent` verdict element
  — the base line is the whole raw blob; no step label; no
  `Where the versions differ`; no value lines; the `!=` / `"kind"` /
  `"literal"` / `node fetch inputs:` envelope present);
- the workflow-level surface test (same);
- the proposal-card test (the same leak on the §20 surface);
- the unknown-grammar degradation test (the base renders the unknown
  payload string verbatim).

The fifth new test — the semantics-preserved REGRESSION pin (equivalence
stays equivalence) — passed at base and stays green at head.

**At head — GREEN:** the touched pair `versions-language.test.ts` (14 —
every grammar form, the label mapping, the scalar/policy/edge/human
renderings, the ` != `-inside-JSON-string split, the unresolvable-id
degradation, the unknown-grammar undescribed state, the equivalence pin)
+ `VersionsExperience.test.tsx` (23) = **37/37**; the full frontend
battery **398/398 (38 files)** — the 380 at base + 18 new.

## 4. Verification matrix at the exact head

All numbers below are from commands actually run in the worktree at the
recorded heads (the frontend node_modules and backend node_modules are
the main clone's lockfile-identical installs, borrowed READ-ONLY through
the pre-provisioned symlinks `frontend/node_modules` and
`backend/node_modules` — the worktree provisions no installs of its own;
the borrow is disclosed here per the dispatch).

| Check | Result |
| --- | --- |
| Frontend full battery (`bun run test`) | **398/398 PASS (38 files)** — 380 at base + 18 new (5 DOM + 13 pure-function); two consecutive runs, stable |
| `bun run typecheck` (frontend) | **clean** (exit 0) |
| `bun run lint` (frontend) | **0 errors / 1 inherited warning** (ArchitecturePage `react-hooks/exhaustive-deps`, untouched — the documented family) |
| `bunx tsc --noEmit` (backend, at the smoke-runner head) | **the 2 documented inherited `workflow-deployments.route.ts` TS2739 errors only — zero errors in the smoke runner**; `backend/src` is byte-identical to base (git-diff-verified) |
| `bunx eslint tests/integration/deployment/run-reality-repair-009-browser-smoke.ts` (backend) | **0 errors / 9 warnings** — the `no-console`/`no-explicit-any` runner family the RR-003/RR-004 runners record identically |
| Boundary: `git diff 9cbfd12..HEAD -- backend/ spec/development-state/ frontend/src/api/` | **empty (0 bytes)** — no backend change, no development-state change, no client wire change |
| Backend battery / e2e-browser sweep | **NOT RUN by this worker** — zero backend surface changed (backend/src byte-identical to base); recorded honestly, never claimed |
| Real-topology browser smoke (this slice's required evidence) | **commit a24ed39, NOT RUN — PENDING ORCHESTRATOR RUN** (port discipline: :3001/:5188 belong to the orchestrator) — §5 |

## 5. Real-topology browser proof (the smoke leg design)

Runner: `backend/tests/integration/deployment/run-reality-repair-009-
browser-smoke.ts` — modeled EXACTLY on the merged RR-003 runner: the REAL
deployment entry spawned as a process (`bun src/index.ts`, the
docker-compose CMD, on the WORK-071 pglite dev runtime — real
PostgreSQL-WASM DatabaseClient + the SAME migrations as production —
`WORKFLOWOS_ROLE=all`, fresh temp data dir, `:3001`), the ACTUAL product
SPA via the Vite dev server (`:5188`, its `/api` proxy targeting `:3001`
exactly as deployed), and a REAL headless Chromium (Playwright, 1280×800).
`step()/shot()/journey.json` with sha-256 digests; artifacts under
`assets/reality-repair-009/`.

**Exit code: PENDING ORCHESTRATOR RUN** (this worker never executed the
runner — port discipline). The runner compiles clean (§4).

The **publisher** is seeded through the REAL HTTP routes only (register →
login → org → public workflow v1 with presentation labels → free listing →
publish) and ships both updates through the REAL owner-only
`createVersion` route. **The consumer gets NOTHING pre-seeded** and does
everything through the real browser UI:

| Leg | Proof |
| --- | --- |
| LEG1 | the consumer **signs up through the real register surface** (Create one → Create account) and lands on Home |
| LEG2 | the consumer creates their organization through the real Home onboarding (the RR-002 composed precondition) |
| LEG3 | Explore → the listing → the entitled free decision → **the EXISTING V2-002 install pins version 1 into the CONSUMER org** (screenshot `02`) |
| LEG4 | the publisher creates version 2 through the **REAL owner-only createVersion route** (the task-text change — task-surface EQUIVALENT; the head confirmed moved by the real workflow read) |
| LEG5 | the consumer opens the detail: **"An update is available" (Version 2)** + the verbatim §19 pin language (`Your installed version: Version 1 — pinned`, `Nothing changes until you approve the update.`) |
| LEG6 | Review update → **"Task-for-task equivalent - verified"** — EQUIVALENCE STAYS EQUIVALENCE: the authority's equivalent result unchanged, no divergence block, no raw JSON, the estimates still rendering (screenshot `03`) |
| LEG7 | the publisher creates version 3 through the REAL owner-only createVersion route (the step-input literal change — task-surface NON-equivalent: exactly the audit VER-2 divergence shape) |
| LEG8 | **THE F-010 REPAIR, in the real browser:** Review update → What changed renders the human-readable diff — the honest `Not equivalent` verdict, the step NAME `Collect the open tickets` (the presentation label — never the raw node id), `its inputs`, the two readable values (`value: payswapdotorg/WorkflowOS` → `value: pectoraux/WorkflowOS`), **NO raw internal JSON envelope** (no `!=`, no `"kind"`, no `"literal"`, no `fetch_tickets` transport head), the estimates still rendering, the Approve-update gate unchanged (screenshot `04`) |
| LEG9 | **the wire-vs-DOM proof (the browser's own network capture):** every compare POST hit the REAL V2-011 authority route and its RESPONSE payload carries the raw internal envelope (`equivalent: false`, `node fetch_tickets inputs: … != …`, `"kind"` inside the JSON) **while the rendered DOM never shows any of it** — the derivation-over-payload contract proven end to end on the real topology |

## 6. Out-of-boundary observations (recorded for serialized successors)

- The §19 What-changed surface shows the compatibility line and the
  correctness verdict side by side: for a step-input literal change with
  unchanged workflow input/output surfaces, the V2-003 negotiation says
  `accept` ("No change to what the workflow does") while the task-surface
  proof says `Not equivalent`. That juxtaposition is the authorities' own
  honest output (the task-surface check is strictly deeper than the
  declared public surface) — this repair renders both verbatim and
  changes neither.
- The modeled rubric deltas can legitimately be 0→0 for a
  task-surface-only change (the execution classes didn't move); the
  estimates lines render honestly as always.
- `ProductVersionComparison.correctness.firstDivergence` remains a raw
  transport string on the wire — deliberately: this Work Order's boundary
  is the presentation, not the payload shape. A future governed
  comparison-payload reshape (typed per-field divergence objects) belongs
  to the V2-011 authority's own surface, not to a UX repair.
- The undescribed-degradation path (a divergence string the payload's own
  grammar does not carry — e.g. a future comparison rules version) is a
  presentation-compatibility safety valve; if the authority's grammar ever
  grows, `DIVERGENCE_HEADS`/`versionDiffSummary` is the single place to
  extend.

## 7. CI honesty

The repository's GitHub Actions has **zero executions** attributable to
this branch (this worker made NO GitHub API calls of any kind — no push,
no PR, no `gh`; delivery is the orchestrator's). Missing CI runs are
recorded as the external condition; they are never claimed as a pass. All
verification above was executed locally in the development sandbox at the
exact heads recorded, and the smoke run's exit code is honestly PENDING
the orchestrator's execution.

## 8. Completion criteria mapping (the Work Order's own list)

| Work Order requirement | Evidence |
| --- | --- |
| "Render the existing V2-011 comparison payload as a human-readable node/field summary rather than raw internal JSON" | §2 (the design) + §3 (RED 4-failed/19-passed at base → GREEN) + smoke LEG8 (the real-browser rendering) |
| "Preserve the authoritative comparison result" | `correctnessLine` keeps the verdicts verbatim; `versionDiffSummary` returns `none` for an equivalent payload; the REGRESSION pin + smoke LEG6 (equivalence stays equivalence, in the real browser) |
| "…and explicit non-equivalence statement" | the `Not equivalent` verdict line renders verbatim on every non-equivalent payload (deterministic tests + smoke LEG8) |
| "No optimization authority or comparison semantics change" | derivation only — the payload is parsed, never recomputed; zero backend/src changes (git-diff-verified); zero client wire changes; the estimates/adoption/approval gates untouched |
| Deterministic tests first | RED commit `0268d63` at base before any implementation (§3) |
| Real-topology browser proof | the committed runner (§5) — the run itself is the orchestrator's (PENDING) |

**Worker conclusion:** REALITY-REPAIR-009 is implemented within its
declared boundary — a frontend presentation repair that derives the
human-readable node/field summary OVER the existing V2-011 comparison
payload (names through the V2-003 presentation labels, values readable,
the honest non-equivalence statement preserved, equivalence untouched),
with no comparison-semantics, optimization-authority, backend, wire, or
governance changes — deterministically verified (RED at base → GREEN at
head, full battery 398/398, typecheck clean, lint clean) and armed with
the real-topology browser smoke for the orchestrator to run. The gate now
rests with the orchestrator (the smoke execution + the exact-head
review-trigger delivery) and then the Architect: exact-head review and
merge before R6; deployment remains locked until the serialized repairs +
the R6 repeat audit + the R7 release decision succeed.
