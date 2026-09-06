# REALITY-REPAIR-001 — Real Deployment Composition Evidence

**Work Order:** `spec/architecture/v2/work-orders/REALITY-REPAIR-001.md`
**Parent gate:** V2-REALITY-AUDIT-001 / GitHub Issue #15 (worker report PR #16, merged `0cb335a`)
**Architect disposition:** F-001 ACCEPT (release blocker)
**Dispatch handle:** GitHub Issue #17 (serialized slice; no parallel repairs)
**Implementation branch:** `feat/REALITY-REPAIR-001-deployment-composition`
**Base:** `33a2e24` (the dispatch-time `main` head) — rebased mid-execution onto the then-current live `main` `67409e5` (the Architect's docs-only advance; ZERO file overlap with this slice, tree-identical for every path this PR touches, full re-verification at the rebased head)
**Code head at verification:** `b084f50` (evidence head `62522d3`)

---

## 1. The defect (F-001, as the audit recorded it)

`backend/src/api/server.ts` registers each V2 product route group only when
its optional deps object is passed to `buildServer`. The REAL deployment
entry (`backend/src/index.ts` — also the docker-compose CMD
`CMD ["bun", "src/index.ts"]`) passed **none of the seven product groups**,
so a deployed WorkflowOS served login and then dead-ended: every V2 product
surface (workflows, runs, deployments, teaching, versions, marketplace)
returned the unrouted 404 behind the universal shell — while migrations
0060–0062 DID run. Audit reproduction (DEP-1): `/health` 200,
`POST /auth/password/register` 201, `/workflows` `/marketplace/listings`
`/teaching-sessions` `/runs` `/workflow-versions` all 404.

## 2. The repair (composition only — the Work Order's boundary)

| Surface | Change |
|---|---|
| `backend/src/app.ts` | `AppDeps.database?: DatabaseClient` — expose the EXISTING shared database client on the composition-root container (the same one-DatabaseClient authority every repository already uses). Deliberately NOT `infrastructure.database`: the infrastructure container is undefined in a `DATABASE_URL`-without-`REDIS_URL` deployment, which would silently re-lose the product routes (a partial recurrence of F-001). |
| `backend/src/index.ts` | `composeV2ProductRouteDeps(app.deps)` — constructs the frozen V2 authorities over the shared database + the identity authority's membership facts (the exact union the V2-017 dogfooding runner and the V2 E2E compositions prove) and passes the **seven** route-deps groups into `buildServer`: V2-002 repository, V2-005 runs, V2-009 deployments (over the V2-004 node directory), V2-006 teaching, V2-010 reverse teaching, V2-011 optimization, V2-012 marketplace. The V2-011/V2-012 transport routes compose their own services from the repository + memberships (the integration-test recipe; the module's OWN deterministic reference payment adapter — no real provider, ever). |
| docker-compose | **No change needed** — the CMD `bun src/index.ts` inherits the wiring. |

**Non-goals honored:** no new routes (the routes-directory file set stays at
40 — unchanged), no authority redesign, no V2-002..V2-012 semantic change,
no new migration. Every V2 module, every route file, and `api/server.ts` are
byte-identical to base.

**Honest boundaries carried by the reference implementations** (surfaced,
not concealed — same as the proven test compositions): the V2-004 node
directory, the V2-006/V2-010 session stores, and the V2-011/V2-012 proposal/
listing reference stores are the modules' in-memory reference stores —
durable persistence for those surfaces is a separately-owned later concern.
The V2-002/V2-005/V2-009 facts are PostgreSQL-authoritative through the
shared client. `currentEpoch: 1` is the deployment's attestation-freshness
protocol epoch (the dogfooding composition precedent; a production epoch
bump is a governed protocol change, never a silent composition decision).

**Fail-closed composition:** without a database the groups stay
unregistered exactly as before, and the degraded state is logged
(`app.api.v2_product_routes.unregistered`) — never a silent substitute.

## 3. Commit sequence (RED → GREEN → pin → browser proof)

| Commit | Kind |
|---|---|
| `aaa85cd` | RED — the deterministic real-entry composition contract (fails at base exactly as the audit recorded: all seven groups 404) |
| `05210c4` | GREEN — the composition fix (app.ts exposure + the seven groups in index.ts); the RED test passes 9/9 |
| `b10bbb1` | Static-architecture regression pins (4 invariants over the PR #19 index.ts-wiring precedent) |
| `b084f50` | The real-topology browser smoke runner (this evidence document is committed after the final run at exactly this head) |

## 4. Deterministic verification (exact rebased head; code head `b084f50`)

| Check | Result |
|---|---|
| `tsc --noEmit` (backend) | **the 2 documented inherited `workflow-deployments.route.ts` TS2739 errors only** — byte-identical at base; zero new errors |
| `eslint .` (backend) | **0 errors**, 20 warnings (11 inherited at base + 9 from the two new test files — the `no-console`/`no-explicit-any` family every `run-*` dogfooding runner in the repo carries) |
| RED/GREEN integration test (`tests/integration/deployment/reality-repair-001.integration.test.ts`) | **9/9 PASS** — boots the REAL entry as a process (`bun src/index.ts`, docker-compose CMD, pglite dev runtime, role=all, fresh temp DB dir); identity/organizations/engineering routes functional (register 201, login 200 + session, org 201, `/projects` 200, `/health/ready` 200); a representative auth-gated read (or create-then-read) from EVERY V2 product group answers with the group's real typed payload — V2-002 `GET …/workflow-repository/workflows` 200 (lists the created workflow), V2-005 `GET …/workflow-runs/runs` 200, V2-009 `GET …/workflow-deployments/deployments` 200, V2-006 session create 201 + read 200, V2-010 session create 201 + read 200, V2-011 analyze 200 + proposals 200, V2-012 `GET /marketplace/listings` 200; the unrouted-404 shape is the negative control (a genuinely missing route still answers the Fastify generic 404) |
| Static-architecture suite | **895/899 incl. the 4 new REALITY-REPAIR-001 invariants**; the 1 failure is the inherited WORK-052 finalization-protocol pin, **proven failing identically at the clean base `33a2e24`** (worktree check) — governance-pin territory, out of this slice's boundary |
| Backend full battery (chunked: unit + architecture + domain suites; integration a–o + browser-validation; integration p–z + top-level) | **4953 tests: 4949 passed / 4 failed / 65 skipped (env-gated real-PG suites)** — the 4 failures are exactly the inherited governance-pin family (1 static WORK-052 pin + 3 development-governance WORK-052/WORK-069-era pins), **all proven failing identically at the clean base `33a2e24`** (worktree check) |
| Frontend suite (`frontend/`) (pre-rebase head; zero frontend files touched) | **362/362 PASS (37 files)** — unaffected, as expected for a backend-only change |
| Browser E2E sweep (`tests/e2e-browser/`, Playwright, chunked `--workers=1` in 3 passes) | **43/43** — 41 passed in-pass; 2 failed under parallel load (t9-teach-me, work-050-unified-execution — the documented transient-under-parallel-workers flakiness family) and **each re-verified green standalone** (t9: 1/1; work-050: 4/4) |

## 5. Real-topology browser proof (the Work Order's required evidence)

Runner: `backend/tests/integration/deployment/run-reality-repair-001-browser-smoke.ts`
— the REAL deployment entry spawned as a process (`bun src/index.ts`, the
docker-compose CMD, on the WORK-071 pglite dev runtime — real
PostgreSQL-WASM DatabaseClient + the SAME migrations as production —
`WORKFLOWOS_ROLE=all`, fresh temp data dir, `:3001`), the ACTUAL product
SPA via the Vite dev server (its `/api` proxy targets `:3001` exactly as
deployed), and a REAL headless Chromium (Playwright, 1280×800).

**Four consecutive fresh-stack runs: 10/10 legs PASS, exit code 0, each
time** (three at the pre-rebase head, one after the clean rebase onto the
live main `67409e5` — the run whose artifacts are persisted). Final run at
the exact rebased code head `b084f50` (`journey.json` transcript +
sha-256-evidenced screenshots):

```text
PASS ( 5078ms) the REAL deployment entry boots (bun src/index.ts, pglite, role=all, :3001)
PASS (   27ms) a V2 product route answers on the real entry (GET /marketplace/listings is 401-not-404)
PASS (   32ms) the ACTUAL product SPA is served (Vite dev server)
PASS (  451ms) seed: register → login → org → public workflow → install → listing → publish (REAL routes)
PASS ( 2300ms) LEG1 the product login surface (email/password → session)
PASS (   14ms) LEG2 Home renders behind the universal shell (attention surfaces)
PASS (  548ms) LEG3 the Workflows library lists the installed workflow
PASS (  516ms) LEG4 the workflow detail page (steps, immutable version, actions)
PASS (  391ms) LEG5 Explore lists the published marketplace listing
PASS (  374ms) LEG6 the listing detail page (back-nav + the version-and-trust region)
```

The seed flows through the REAL routes only (no direct DB writes): password
register → login (session cookie) → `POST /organizations` → public V2-002
workflow (authored through the V2-003 builder — the approval gate with the
exhaustive approved/rejected outcome edges) → V2-002 installation → V2-012
listing create + publish. The browser then signs in through the product
login UI and walks the required surfaces: Home (§4 attention surfaces),
Workflows (the Installed tabpanel), **the workflow detail page** (own-org
full surface: presentation steps, `Version 1 — immutable`, access/safety,
Run + Teach Me actions), Explore (the published listing), and the listing
detail page (back-nav + the Version-and-trust region) — **two detail
surfaces** where the Work Order required at least one.

### Artifacts (final head run; sha-256)

| File | Bytes | SHA-256 |
|---|---|---|
| `assets/reality-repair-001/01-home.png` | 95039 | `f926044e5487ee97592e0053325330a3e84a987c076f58d8795d833d9939b7ae` |
| `assets/reality-repair-001/02-workflows.png` | 60707 | `aa2ae6e525e47a70126f26690922410af68391ab635a05a088751bd5984a3d90` |
| `assets/reality-repair-001/03-workflow-detail.png` | 99361 | `d32a8205bda6814c3ee3de1ec701cb734d664a7d8e864b0e26f323493f7c2db6` |
| `assets/reality-repair-001/04-explore.png` | 47831 | `f1f03e946b91bf1c04d9b7528e61213effc823eb68eda5953a5ff8734b9d281f` |
| `assets/reality-repair-001/05-listing-detail.png` | 110584 | `7255b04c5f0efeedee488ad535315d7303e59c67f87f68e5c3de0d09bf01fd62` |
| `assets/reality-repair-001/journey.json` | — | the structured transcript (this run) |

Determinism note: screenshots 02/03/04 are byte-identical across runs;
01/05 differ across runs because they render server-generated identifiers
(workflow ids, listing revision ids, dates). The transcript structure is
identical modulo the generated identities and timestamps.

## 6. Out-of-boundary findings recorded honestly (NOT repaired here)

- **F-002 (no organization onboarding):** the browser smoke seeds the org
  through the REAL API route (the audit's own persona-seeding approach).
  The UI onboarding gap is REALITY-REPAIR-002 — serialized behind this
  slice's merge, not touched here.
- **F-003 (installed cross-org workflow detail reads):** the smoke's detail
  leg uses the own-org full surface (the Work Order requires "at least one
  detail page"); the cross-org INSTALLED detail defect remains for
  REALITY-REPAIR-003.
- **F-008 (run lifecycle controls):** not exercised in the smoke (the Run
  button is merely verified present); the user-facing lifecycle controls
  remain for REALITY-REPAIR-007.
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

| Required evidence | Delivered |
|---|---|
| Fresh branch from current `main` | `feat/REALITY-REPAIR-001-deployment-composition` from `33a2e24` (the then-current head) |
| Real deployment entry boots successfully | 3 consecutive boots of `bun src/index.ts` (pglite dev runtime, role=all) — §5 |
| Representative auth-gated read from every V2 product route group returns a route response, not 404 | 9/9 integration test + the smoke's 401-not-404 probe + every leg — §4, §5 |
| Existing identity/engineering routes remain functional | register/login/org/`/projects`/`/health/ready` verified in the same composition — §4 |
| Browser smoke reaches Home, Workflows, Explore, and at least one detail page | 6 legs, TWO detail surfaces, 3/3 runs — §5 |
| Exact-head test and review evidence | §4 at the rebased code head `b084f50` (re-verified: typecheck = the 2 inherited errors, the 9/9 real-entry test, the 4/4 new invariants, the 10/10 smoke); this document + the PR body |

**Worker conclusion:** REALITY-REPAIR-001 is implemented within its
declared boundary, deterministically verified, and proven on the real
deployment topology with a real browser. The F-001 release blocker is
repaired at the composition level; the release gate remains with the
Architect's exact-head review, the serialized repair sequence
(REALITY-REPAIR-002 next only after this merge), and the R6 repeat audit
before any deployment unlock.
