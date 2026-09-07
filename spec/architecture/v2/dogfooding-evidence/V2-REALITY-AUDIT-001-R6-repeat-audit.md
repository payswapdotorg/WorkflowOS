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
authored it and did NOT run it; the orchestrator runs it at the exact
head)
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
| DEP-1 | real deployment entry serves the V2 product | FAIL (F-001) | every product route group answers auth-gated 200 behind the real entry (RR-001) | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| AUTH-1 | register through real UI | PASS | unchanged PASS | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| AUTH-2 | sign out | PASS | unchanged PASS | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| AUTH-3 | sign in with password | PASS | unchanged PASS | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| AUTH-4 | wrong password | PASS | honest error, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| AUTH-5 | duplicate registration | PASS | honest error, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| AUTH-6 | session persistence (reload) | PASS | retained, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| HOME-1 | goal/search entry + mode buttons | PASS | renders, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| HOME-2 | attention: Recent/Needs attention empty states | PASS | honest empty states, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| HOME-3 | attention: Pending approvals | FAIL (F-005) | the RR-005 composition surfaces real pending-approval content from existing runs/approval reads | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| HOME-4 | attention: Updates | FAIL (F-005) | the RR-005 composition surfaces a real available update from existing version/installation reads | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| HOME-5 | attention: Device issues | EXPECTED UNAVAILABLE | REMAINS honestly unavailable (F-006 disposition: ACCEPT AS-IS — an explicit deferral, not a defect) | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| CREATE-1 | Tell creation → preview → commit | PASS (honest boundary) | fail-closed boundary preserved; the RR-004 copy correction removes the false authoring promise | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| CREATE-2 | Show creation | PASS | honest no-recording note, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| CREATE-3 | Tell + Show | PASS | combined capture, same honest boundary | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| MKT-1 | Explore browse | PASS | listing cards render, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| MKT-2 | listing detail §22 disclosure | PASS | full disclosure, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| MKT-3 | purchase with NO organization | BLOCKED (F-002) | the RR-002 first-run onboarding flow creates the organization through the real UI — no silent no-op | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| MKT-4 | purchase with org | PASS | entitled state, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| MKT-5 | install pinned version | PASS | installed + pinned, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| MKT-6 | Make my own (fork) | PASS | provenance-carrying copy, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| LIB-1 | My Workflows tab | PASS | cards with facts, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| LIB-2 | Installed tab | PASS (defect noted, F-007) | installed cards now show the workflow's REAL name (RR-006), not the generic fallback | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| LIB-3 | Drafts / Archived | PASS (honest unavailable) | honest unavailable, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| DET-1 | own workflow detail | PASS | full detail surface, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| DET-2 | INSTALLED (marketplace) workflow detail | FAIL (F-003) | the cross-org detail LOADS (RR-003): caller-org reads, zero publisher-org-scoped requests, no honest-error state | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| RUN-1 | run preview → request → start | PASS | consequential preview then Running, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| RUN-2 | Running + trust disclosure | PASS | honest evidence state, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| RUN-3 | run state survives reload | PASS | retained, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| RUN-4 | user drives run lifecycle (approve/resume/pause/stop) | FAIL (F-008) | the RR-007 controls close the human-approval loop: "Waiting for you" is actionable — Approve/Resume resolves the gate, Pause/Stop reachable | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| RUN-5 | failure presentation + recovery | PASS | honest failure + working Try again, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| WHEN-1 | schedule editor → save | PASS | real deployment + subscription, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| TEACH-1 | lesson + checkpoints + pause/resume | PASS | governed lesson flow, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| TEACH-2 | practice | PASS (defect noted, F-009) | practice feedback references the CORRECT step (RR-008) | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| TEACH-3 | assessment → Lesson complete | PASS | terminal on pass, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| TEACH-4 | teaching evidence separation | PASS | visibly distinct, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| VER-1 | update banner (v2 available) | PASS | banner + pin language, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| VER-2 | Review update / What changed | PASS (defect noted, F-010) | the RR-009 human-readable diff renders field-level readable changes (equivalent v1→v2) and the honest non-equivalence statement (v3) — no raw internal JSON | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| VER-3 | Approve update | PASS | new pin via EXISTING commands, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| ACT-1 | Activity timeline | PASS | entries + links, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| ACT-2 | activity → run deep link | PASS | navigates to the run, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| ACT-3 | teaching/device on Activity | EXPECTED UNAVAILABLE | honest unavailable, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| EXPERT-1 | Expert bridge page | PASS | renders with disclosure, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| EXPERT-2 | project creation through UI | PASS | project created, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| EXPERT-3 | engineering surfaces | BLOCKED (composition artifact) | the REAL entry (RR-001) serves the V1 engineering routes alongside the product routes — the surface loads without "Error: Not found" | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| RESP-1 | mobile 390×844 | PASS | no overflow, usable nav, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| NET-1 | in-app navigation while offline | PASS | honest degraded states + recovery, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |
| COMP-1 | companion handoff deep link | PASS | honest bridge, unchanged | PENDING ORCHESTRATOR RUN | PENDING ORCHESTRATOR RUN |

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
   the real entry must answer auth-gated 200s for every product route
   group. **R6 result: PENDING ORCHESTRATOR RUN**
2. **F-002 — no organization onboarding** → evidenced by MKT-3 at R6:
   the no-org session must onboard through the real UI. **R6 result:
   PENDING ORCHESTRATOR RUN**
3. **F-003 — marketplace installed-workflow detail uses publisher org
   reads** → evidenced by DET-2 at R6: the cross-org detail must load
   with caller-org reads only. **R6 result: PENDING ORCHESTRATOR RUN**
4. **F-008 — user-facing run lifecycle/approval controls absent** →
   evidenced by RUN-4 at R6: the approval gate must be closable through
   the product. **R6 result: PENDING ORCHESTRATOR RUN**

## 5. The run record (honest status)

**Status: PENDING ORCHESTRATOR RUN** — the runner was authored by the
R6-A specialist and NOT run by it (port discipline, the repair-wave
pattern). The orchestrator owns the run at the exact head `5ec0a49`,
the result finalization of this document, and the regenerated artifacts
(`journey.json` + the screenshots). No exit-code, duration, or matrix
result is claimed before that run actually happens.

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
