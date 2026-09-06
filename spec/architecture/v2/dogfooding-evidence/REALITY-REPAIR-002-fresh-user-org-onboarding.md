# REALITY-REPAIR-002 — First-Run Organization Onboarding (F-002)

**Work Order:** `spec/architecture/v2/work-orders/REALITY-REPAIR-002.md`
**Parent gate:** V2-REALITY-AUDIT-001 (Architect disposition F-002 ACCEPT)
**Dispatch:** GitHub Issue #19 (authorized by the REALITY-REPAIR-001 merge at `915ed1d`)
**Base:** `main` at worker start — `e763531` (the live head; `basePolicy:
current-main-at-worker-start`). The dispatch's named `915ed1d` had been
advanced by docs/governance-only commits (`a59fdb0..e763531`, zero file
overlap with this slice — verified by diff before branching).
**Branch:** `feat/REALITY-REPAIR-002-fresh-user-org-onboarding`
**Code head:** `825cdb9` (commit sequence: `7b20581` RED tests → `e8bfd70`
the onboarding → `825cdb9` the library Installed tab + the browser smoke)
**Files:** 11 source/test files + 6 evidence artifacts, +1,576/−5 lines;
**zero backend/src changes, zero route changes, zero spec-authority changes**

## 1. The defect (F-002, the audit's release blocker)

A fresh signup reaches the product shell with **zero organizations**, while
every org-scoped product capability silently becomes ineffective:

- **Home** renders the generic `No workflows yet — the ones you create or
  install will appear here` empty copy — presented as though the user had
  simply not created anything, with no path to create or select the
  organization every product action is scoped to;
- **the marketplace listing detail** (the §23 entitlement → install surface)
  sits in a **perpetual `Checking your access…`** state: the access decision
  is per-organization and there is no organization for it to resolve
  against; the offer-accept / install / fork callbacks early-return with no
  feedback; the fork panel's only signal is the dead-end sentence `Your
  organization is needed to create the copy.`;
- **the Workflows library** hides a real installation behind the generic
  `No workflows yet` copy whenever the org holds zero *authored* workflows —
  the copy that literally promises "the ones you … install will appear
  here" (the page-level `noWorkflowsAnywhere` gate swallowed the Installed
  section's own authoritative read).

The backend authority was never at fault: `POST /organizations`
(authenticated humans; the creator becomes its `owner` — WORK-074) and
`GET /organizations` existed and worked. The product UI simply never
composed them into a first-run journey.

## 2. The repair (the smallest valid composition — no new authority)

Following the Work Order's explicit preference for **user-facing creation
over server-side auto-provisioning** (auto-provisioning would have
introduced new ownership/naming semantics; explicit creation introduces
none):

1. **`frontend/src/api/client.ts`** — `organizations.create(name)`: the ONE
   existing command (`POST /organizations`). The 201 response is the
   authoritative created record; the client never fabricates an
   organization.
2. **`frontend/src/components/onboarding/OrganizationOnboarding.tsx`** (new)
   — the explicit first-run card: a named region
   (`aria-label="Organization onboarding"`), the reason org-scoped actions
   need an organization, the name form (disabled on blank — no spurious
   400s), an honest failure with retry. It reads nothing itself: the
   mounting surface owns the zero-org condition (no second read, no
   client-side authority over which organizations exist).
3. **`frontend/src/pages/HomePage.tsx`** — the first-run landing. An
   organizations read (the same loading/error/empty/data honesty contract)
   renders the onboarding card **only on the successful empty condition**;
   on creation every Home read refetches so the org-scoped aggregations
   (F-T2-001: across every organization) target the created organization. A
   failed read stays an honest error — never a fake onboarding-empty.
4. **`frontend/src/components/marketplace/MarketplaceListingDetail.tsx`** —
   the zero-org `Your access` state is now the actionable onboarding instead
   of the silent dead end: the perpetual `Checking your access…` line is
   suppressed when there is no organization for the decision to resolve
   against, and the created organization immediately becomes the selection —
   the access decision runs for it, and the offer-accept / install / fork
   flows become reachable. The marketplace path no longer silently no-ops.
5. **`frontend/src/pages/WorkflowsPage.tsx`** — the Installed section
   renders from the **installation read** (its own org-scoped authority),
   independent of the authored-workflows read; the generic
   `noWorkflowsAnywhere` copy no longer swallows real installations.

**Non-goals honored:** no changes to organization authority semantics,
membership authorization, workflow authority, marketplace economics, or V2
product route contracts. The identity and organization routes are untouched
(the browser smoke's signup/login legs exercise them end-to-end on the real
entry).

## 3. Deterministic regression (RED at base → GREEN at head)

`7b20581` lands the failing tests first. **At base `e763531`** (run before
any implementation):

- `frontend/src/components/onboarding/OrganizationOnboarding.test.tsx` —
  fails at import (the component does not exist);
- `frontend/src/pages/HomePage.test.tsx` — `Unable to find role="region" and
  name "Organization onboarding"` (the zero-org Home shows only the generic
  empty copy);
- `frontend/src/components/marketplace/MarketplaceListingDetail.test.tsx` —
  the zero-org listing detail renders the perpetual
  `Checking your access…` section with no onboarding (the failure output
  itself reproduces the defect's visible state);
- `frontend/src/pages/WorkflowsPage.test.tsx` — the fresh-user library hides
  the installation behind the generic copy.

**RED: 4 failed / 25 passed in the three first files (+3 in the library
file).** The 25/15 pre-existing tests in the same files stayed green at
base (existing journeys intact before the repair).

**At head `825cdb9` — GREEN:** 33/33 in the three touched suites, 18/18 in
the library suite — including the boundary assertions: the onboarding never
renders for a tenanted user; a failed organizations read never becomes a
fake onboarding-empty; the exact `POST /organizations` wire shape
(`/api/organizations`, `{ name }`) is asserted; the parent receives the
authoritative 201 record verbatim; the per-org access decision runs for the
CREATED organization; empty-name submits never reach the authority.

## 4. Verification matrix at the exact head `825cdb9`

| Check | Result |
| --- | --- |
| Frontend suite (`frontend/`) | **375/375 PASS (38 files)** — 362 at base + 13 new (the RR-002 regression + the library block) |
| `tsc --noEmit` (frontend) | **clean** |
| `eslint .` (frontend) | **0 errors / 1 inherited warning** (ArchitecturePage, untouched) |
| `tsc --noEmit` (backend) | **the 2 documented inherited `workflow-deployments.route.ts` TS2739 errors only** — the file is byte-identical to base; zero new errors |
| `eslint .` (backend) | **0 errors / 29 warnings** (the `no-console` runner family; 20 at the RR-001 head + the new smoke runner's statements, same pattern) |
| Backend full battery (chunked: architecture+unit; integration a–d, e–n, o–t, v–z+validation; browser-validation+continuous-validation+validation-scheduling; progressive-release) | **4,871 tests: 4,796 passed / 4 failed / 71 skipped (env-gated)** — the 4 failures are **exactly the inherited governance-pin family documented at the RR-001 merge** (1 static WORK-052 finalization-protocol pin + 3 development-governance WORK-052/WORK-069-era pins), with **zero spec/development-state bytes changed on this branch** (git diff vs base: only new evidence artifacts under `dogfooding-evidence/assets/reality-repair-002/`) — failing identically at the base head, governance-pin territory, out of this slice's boundary |
| Browser E2E sweep (`tests/e2e-browser/`, Playwright) | **43/43** — 41 in the full pass; 2 failed under parallel load (t7-failure-recovery, work-048-workbench — the documented transient-under-parallel-workers SIGKILL family) and **each re-verified green standalone** (t7: 1/1; work-048: 5/5) |

## 5. Real-topology browser proof (the Work Order's required evidence)

Runner: `backend/tests/integration/deployment/run-reality-repair-002-browser-smoke.ts`
— the REAL deployment entry spawned as a process (`bun src/index.ts`, the
docker-compose CMD, on the WORK-071 pglite dev runtime — real
PostgreSQL-WASM DatabaseClient + the SAME migrations as production —
`WORKFLOWOS_ROLE=all`, fresh temp data dir, `:3001`), the ACTUAL product
SPA via the Vite dev server (its `/api` proxy targets `:3001` exactly as
deployed), and a REAL headless Chromium (Playwright, 1280×800).

**Run at the code head `825cdb9`: exit 0, 11/11 legs, 11,083 ms.**
Transcript + sha-256 digests: `assets/reality-repair-002/journey.json`.

The **publisher** is seeded through the REAL HTTP routes only (register →
login → org → public workflow → free listing → publish) so the marketplace
has one published listing to act on. **The fresh user gets NOTHING
pre-seeded** — zero organizations — and does everything through the real
browser UI:

| Leg | Proof |
| --- | --- |
| LEG1 | fresh **signup through the real register surface** (Create one → Create account) lands on Home with zero orgs |
| LEG2 | Home renders the explicit first-run organization onboarding — the named region, the reason, the form (screenshot `01`) |
| LEG3 | the organization is created **through the real browser UI only**; the onboarding resolves off the landing surface (screenshot `02`) |
| LEG4 | **`GET /organizations` resolves the created organization** for the browser session (the REAL entry, same cookie): exactly 1 org, the created name, `roleId: owner` |
| LEG4b | the **product selection uses it**: the listing's per-org access decision resolves (entitled, `Access through the free listing.`) — never the base's perpetual `Checking your access…` (screenshot `03`) |
| LEG5 | the **org-scoped product action**: the EXISTING V2-002 install command pins version 1 into the created organization — `Installed — pinned to version 1` (screenshot `04`) |
| LEG6 | the **Workflows library lists the installation** (the Installed tab: `Version 1 — pinned`, `Enabled`, the honest cross-org fallback name `Installed workflow`, the Open route) (screenshot `05`) |

**Marketplace access/purchase path no longer silently no-ops:** the access
decision resolves against the created organization and the install lands.
The paid offer-acceptance branch of the same §23 flow (the command + its
honest payment-failure state) is proven deterministically in the component
contract tests; this topology has no payment provider configured — honestly
so — so the honest browser purchase-path journey is free-listing access +
install.

## 6. Out-of-boundary observations (recorded for serialized successors)

- Opening a **cross-org public workflow detail** composes org-scoped reads
  (runs / installations / deployments / the repository list) with the
  workflow's OWN organization — the publisher's — and the backend correctly
  **403s the non-member fresh user**. That is the existing authorization
  semantics (unchanged by this repair); the cross-org public detail-page UX
  belongs to a serialized successor, not this slice.
- The 4 inherited governance-pin test failures + 2 inherited typecheck
  errors are recorded above with base-provenance and left for Architect
  disposition (governance-pin territory).

## 7. CI honesty

The repository's GitHub Actions has **zero executions** repository-wide at
base and at this branch head (checked via the REST API after push — see the
PR body). Missing CI runs are recorded as the external condition; they are
never claimed as a pass. All verification above was executed locally in the
development sandbox at the exact heads recorded.

## 8. Completion criteria mapping (the Work Order's own list)

| Work Order requirement | Evidence |
| --- | --- |
| Fresh branch from the merged REALITY-REPAIR-001 head | branched from live main `e763531` (the dispatch base `915ed1d` advanced by governance-only commits; `basePolicy: current-main-at-worker-start` per the machine state; base freshness verified against live main at PR time) |
| Fresh signup with zero pre-seeded organizations | LEG1–LEG2 (the fresh user is never seeded; `GET /organizations` proves zero-org before onboarding in the RED/base evidence and 1-org after) |
| Organization creation through the real browser UI only | LEG3 (typed name → `Create organization` → the real POST) |
| Post-onboarding `GET /organizations` resolves the created org; product selection uses it | LEG4 (1 org, owner) + LEG4b (the per-org decision resolves for it) |
| Marketplace access/purchase path no longer silently no-ops | LEG4b + LEG5 (+ the deterministic accept-offer component tests) |
| Existing authenticated journeys remain green | e2e-browser 43/43 (2 transients re-verified standalone); frontend 375/375; backend battery 4,796/4,796 outside the 4 base-proven inherited pins |
| Deterministic tests + real browser proof | §3 (RED→GREEN) + §5 (11/11 real-topology legs) |
| Exact-head review packet + durable checkpoint | the PR body + the GitHub review trigger comment + the Issue #19 checkpoint |

**Worker conclusion:** REALITY-REPAIR-002 is implemented within its
declared boundary (frontend-only composition over the existing
`POST /organizations` authority; no new authority, persistence model,
authorization semantics, or route changes), deterministically verified
(RED at base → GREEN at head), and proven on the real deployment topology
with a real browser (fresh signup → onboarding → org-scoped install). The
F-002 release blocker is repaired. The gate now rests with the Architect:
exact-head review and merge before REALITY-REPAIR-003 activates; deployment
remains locked until the serialized repairs + the R6 repeat audit succeed.
