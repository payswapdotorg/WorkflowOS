# REALITY-REPAIR-003 — Consumer-Organization Workflow Detail (F-003)

**Work Order:** `spec/architecture/v2/work-orders/REALITY-REPAIR-003.md`
**Parent gate:** V2-REALITY-AUDIT-001 (Architect disposition F-003 ACCEPT)
**Dispatch:** GitHub Issue #23 (authorized by the REALITY-REPAIR-002 merge at `773ca7d`,
reconciled by `e37b36b` + `dda35b4`)
**Base:** `main` at worker start — `dda35b4` (the live head; `basePolicy:
current-main-at-worker-start`; the dispatch's merge head `773ca7d` had been
advanced by the governance reconciliation + zero-content housekeeping commits
`773ca7d..dda35b4` — every one verified as empty-file/no-op diffs with zero
overlap with this slice's surface).
**Branch:** `feat/REALITY-REPAIR-003-consumer-org-workflow-detail`
**Code head:** see the PR body (commit sequence: RED tests → the repair → the
browser smoke)
**Files:** frontend composition only — 4 product files + 5 test files + the
smoke runner + 6 evidence artifacts; **zero backend/src changes, zero route
changes, zero spec-authority changes, zero authorization-semantics changes**

## 1. The defect (F-003, the audit's release blocker)

The workflow detail page scoped every org-scoped follow-up read to **the
workflow's OWN organization** — `workflow.organizationId`, the publisher's:

- `WorkflowDetailPage` read runs, installations, deployments, and the When
  picker's org workflows from the publisher org;
- `RunExperience` / `RecoveryExperience` issued the run request + the
  mandated re-read against the publisher org;
- `WhenEditor` created new deployments in the publisher org.

A marketplace consumer — who purchased and installed the public workflow
**into their own organization** (the RR-002-repaired journey) — opened the
detail from Installed/My Workflows and hit the publisher org's member-only
reads: the backend **correctly 403s the non-member**, and the page's
all-or-error contract turned that honest rejection into **the whole detail
dying** (`Couldn't load this workflow right now.`). Even where reads were
hypothetically permitted, the composition would have surfaced the
**publisher's** facts, not the consumer's. The run/schedule commands were
additionally *objectively wrong wiring*: the backend run command validates
`installation.organizationId === request organization` (`RUN_INSTALLATION_MISMATCH`)
— the installation the consumer runs lives in THEIR org, so the
publisher-org request could never satisfy the pin.

The backend authority was never at fault: the org-scoped reads are member-only
by design, the public workflow/version reads are public by design, and the
run/deployment commands accept the caller's org. The product UI simply
composed the wrong organization into every org-scoped surface of the detail.

## 2. The repair (composition/wiring only — no authorization change)

Per the Work Order ("Reuse the existing `organizations.listForUser`
selection/organization context already consumed by the product shell. Keep
public workflow/version reads unchanged. Replace owner-org scoping only
where customer-local facts are required") and the Issue #23 authority
boundary ("fix composition/wiring, not authorization policy"):

1. **`frontend/src/pages/WorkflowDetailPage.tsx`** — the org-scoped reads
   (runs, installations, deployments, org workflows) now resolve against
   **every organization of the session user** through a new
   `fetchCallerOrganizationFacts()` — the exact F-T2-001 aggregation the
   product shell (Home, the library) already consumes
   (`organizations.listForUser()` → per-org reads, all-or-error: any failed
   per-org read errors the surface; a zero-org caller gets honest empty
   facts, never an error). The **public** workflow + version reads are
   untouched. The page also gained an explicit fail-closed guard: an
   authoritative workflow read that yields no usable record renders the
   honest error surface — never an undefined record flowing into the render.
2. **`frontend/src/components/run/RunExperience.tsx`** and
   **`frontend/src/components/recovery/RecoveryExperience.tsx`** — the run
   commands (request + the mandated exact-run re-read) now operate in **the
   INSTALLATION's organization** — the authoritative org of the pinned
   target, exactly what the backend validates the request org against —
   with the no-installation fallback remaining the workflow's own org (the
   owner/member path, unchanged).
3. **`frontend/src/components/when/WhenSection.tsx` / `WhenEditor.tsx`** —
   the Schedule action's deployment create receives the same resolved
   `commandOrganizationId` (the installation's org; the workflow's own org
   on the owner path), so the consumer's subscription delivers runs as
   THEIR org's local facts.
4. **`frontend/src/api/client.ts`** — untouched: no new command, no new
   read, no wire change. `VersionsExperience`/`TeachExperience` already
   resolved org-scoped commands against the installation's org (correct
   before and after).

**Non-goals honored:** no new workflow-scoped aggregate route, no
membership-rule changes, no marketplace/entitlement changes, no new
authority, no second repository/installation/run/deployment model. A
correctly-denying backend 403 remains correct (LEG7 of the browser smoke
proves the member-only boundary still denies the consumer on the publisher
org — authorization semantics byte-identical).

## 3. Deterministic regression (RED at base → GREEN at head)

The RED commit lands the failing tests first. **At base `dda35b4`** (run
before any implementation): `WorkflowDetailPage.test.tsx` —
**4 failed / 12 passed**; each failure renders the F-003 defect's own
visible state (`Couldn't load this workflow right now.` — the publisher-org
403 killing the consumer's whole detail):

- the consumer detail-load test (no heading; the error state instead);
- the consumer Run-command test (the action posts to the publisher org);
- the consumer Schedule test (the deployment create posts to the publisher
  org);
- the zero-org caller test (the publisher-org read kills even the
  no-facts public view).

The fixtures reproduce the cross-org topology faithfully: the publisher org's
org-scoped routes answer the member-only 403; the consumer org's routes
answer the caller's facts (installation, run).

**At head — GREEN:** 16/16 in the suite — the consumer detail loads with
**zero publisher-org requests** (the network-asserted composition change),
the consumer's installation pin + run render from the caller-org reads, the
Run + Schedule commands land in the consumer org, and the own-org regression
pins the pre-repair behavior (the workflow org remains the target when it IS
a caller organization).

## 4. Verification matrix at the exact head

| Check | Result |
| --- | --- |
| Frontend suite (`frontend/`) | **380/380 PASS (38 files)** — 375 at the RR-002 merge + 5 new (the F-003 consumer block) |
| `tsc --noEmit` (frontend) | **clean** |
| `eslint .` (frontend) | **0 errors / 1 inherited warning** (ArchitecturePage, untouched) |
| `tsc --noEmit` (backend) | **the 2 documented inherited `workflow-deployments.route.ts` TS2739 errors only** — `backend/src` is byte-identical to base (git-diff-verified); zero new errors |
| `eslint .` (backend) | **0 errors / 38 warnings** (the `no-console` runner family — RR-002 recorded 29 in the same pattern; this branch's smoke runner adds statements in that family) |
| Backend full battery (chunked: architecture+unit; integration a–g; browser-validation + continuous-validation + validation-scheduling + engineering-signals + progressive-release) | **4,949 tests: 4,880 passed / 4 failed / 65 skipped (env-gated)** — the 4 failures are **exactly the inherited governance-pin family documented at the RR-001 merge and re-recorded at the RR-002 merge** (1 static WORK-052 finalization-protocol pin + 3 development-governance WORK-052/WORK-069-era pins); the pins read `spec/development-state/` machine-state bytes that are **byte-identical to base on this branch** (git-diff-verified: zero changes outside `frontend/`, the new smoke runner, and this evidence) — governance-pin territory, out of this slice's boundary |
| Browser E2E sweep (`tests/e2e-browser/`, Playwright, real topology) | **43/43** — 41 in the full pass; 2 failed under sequential-worker load (t7-failure-recovery, work-049-health — the documented transient-under-load SIGKILL family) and **each re-verified green standalone** (t7: 1/1; work-049: 5/5) |
| Real-topology browser smoke (this slice's required evidence) | **exit 0, 12/12 legs + 2 boot checks** — §5 |

## 5. Real-topology browser proof (the Work Order's required evidence)

Runner: `backend/tests/integration/deployment/run-reality-repair-003-browser-smoke.ts`
— the REAL deployment entry spawned as a process (`bun src/index.ts`, the
docker-compose CMD, on the WORK-071 pglite dev runtime — real
PostgreSQL-WASM DatabaseClient + the SAME migrations as production —
`WORKFLOWOS_ROLE=all`, fresh temp data dir, `:3001`), the ACTUAL product
SPA via the Vite dev server (its `/api` proxy targets `:3001` exactly as
deployed), and a REAL headless Chromium (Playwright, 1280×800).

**Run at the code head: exit 0, 12/12 legs, 12,095 ms.** Transcript +
sha-256 digests: `assets/reality-repair-003/journey.json`.

The **publisher** is seeded through the REAL HTTP routes only (register →
login → org → public workflow → free listing → publish). **The consumer
gets NOTHING pre-seeded** and does everything through the real browser UI:

| Leg | Proof |
| --- | --- |
| LEG1 | the consumer **signs up through the real register surface** (Create one → Create account) and lands on Home |
| LEG2 | the consumer creates their organization through the real Home onboarding (the RR-002 composed precondition) |
| LEG3 | Explore → the listing → the entitled free decision → **the EXISTING V2-002 install pins version 1 into the CONSUMER organization** (screenshot `02`) |
| LEG4 | the library Installed tab → Open: **the cross-org public workflow DETAIL LOADS** — the heading, the description, the Public line, the presentation-label steps, `Installed: Version 1 — pinned · Enabled`, `Not run yet`, `not deployed yet`, and **NO honest-error state** (screenshot `03`) |
| LEG5 | the browser's own network capture: **ZERO requests to the publisher org's org-scoped routes** during the detail load; the caller-org reads present; the unchanged public workflow read present |
| LEG6 | **the Run action requests the run in the CONSUMER organization** (the installation org): the run-status surface renders, the network capture shows the POST to the consumer org (and none to the publisher org), and the API runs read resolves THIS workflow's run in the consumer org (screenshot `04`) |
| LEG7 | the consumer's cookie against the publisher org's member-only runs read → **403** — the existing authorization semantics, UNCHANGED by this repair |
| LEG8 | the publisher (a second real browser session, real sign-in) opens the SAME workflow detail: **it loads with their facts** — heading, description, steps, the honest own-org `No installs` state, no error (screenshot `05`) |

**Customer-local installation/run/deployment facts remain isolated to the
caller's org:** the consumer's installation, run, and deployment facts come
only from the consumer-org reads (LEG4/LEG5/LEG6); the publisher org's
equivalent reads are never issued by the consumer's page and remain
member-only 403 for the consumer's session (LEG7). **Regression for
own-org workflow detail remains green:** LEG8 (the real browser own-org
journey) + the deterministic own-org test (§3) + the 375 pre-existing
frontend tests + e2e-browser 43/43.

## 6. Out-of-boundary observations (recorded for serialized successors)

- The consumer's When picker name-resolution ("After another workflow")
  degrades honestly for a cross-org install (the caller org holds no
  authored workflows to name); the picker's org-workflow read is the
  caller-org aggregation — honest, no fabricated names.
- The 4 inherited governance-pin test failures + 2 inherited typecheck
  errors are recorded above with base-provenance and left for Architect
  disposition (governance-pin territory).
- ShareExperience's publish/visibility command remains the OWNER's surface
  (the V2-002 owner command on the workflow's own org — correct for the
  owner; a non-owner consumer seeing the Share panel is a presentation
  question for a successor, not an authorization change).

## 7. CI honesty

The repository's GitHub Actions has **zero executions** repository-wide at
base and at this branch head (REST-checked after push — see the PR body).
Missing CI runs are recorded as the external condition; they are never
claimed as a pass. All verification above was executed locally in the
development sandbox at the exact heads recorded.

## 8. Completion criteria mapping (the Work Order's own list)

| Work Order requirement | Evidence |
| --- | --- |
| Fresh branch from the merged REALITY-REPAIR-002 head | branched from live main `dda35b4` (the RR-002 merge `773ca7d` advanced by governance reconciliation + zero-content housekeeping; `basePolicy: current-main-at-worker-start`; base freshness re-verified against live main at PR time) |
| Browser: customer purchases and installs a public marketplace workflow, then opens it from Installed/My Workflows | LEG3 → LEG4 (entitled install into the consumer org → the library Installed tab → Open) |
| Detail loads without publisher-org 403s | LEG4 (the detail renders; no honest-error state) + LEG5 (zero publisher-org requests — the network capture) |
| Customer-local installation/run/deployment facts remain isolated to the caller's org | LEG4/LEG5/LEG6 (caller-org reads only) + LEG7 (the publisher org stays member-only 403 for the consumer session) |
| Regression for own-org workflow detail remains green | LEG8 (real browser, the publisher's own-org detail) + the deterministic own-org test + frontend 380/380 + e2e-browser 43/43 |
| Deterministic tests plus real browser proof | §3 (RED 4-failed/12-passed at base → GREEN 16/16) + §5 (exit 0, 12/12 legs) |
| The org-scoped reads resolve from the caller's organization; public reads unchanged | the composition change (§2) + LEG5's zero-publisher-read capture + the public-read assertions in the deterministic suite |
| The run command operates in the installation's org (Issue #23 "reads/actions") | LEG6 (the POST network capture + the API runs read) + the deterministic consumer Run test |

**Worker conclusion:** REALITY-REPAIR-003 is implemented within its declared
boundary (frontend composition/wiring only, over the existing
`organizations.listForUser` selection, the existing public reads, and the
existing org-scoped commands; no new authority, persistence model,
authorization semantics, or route changes), deterministically verified (RED
at base → GREEN at head), and proven on the real deployment topology with a
real browser (consumer signup → marketplace install → the cross-org detail
loads with caller-org facts → the run lands in the consumer org → the
publisher boundary stays 403 → the own-org regression holds). The F-003
release blocker is repaired. The gate now rests with the Architect:
exact-head review and merge before REALITY-REPAIR-004..009 activate;
deployment remains locked until the serialized repairs + the R6 repeat audit
+ the R7 release decision succeed.
