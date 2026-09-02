# IG-001 Repository ↔ WorkflowIR Round-Trip — Dogfooding Evidence

**Work Order:** IG-001 — Repository ↔ WorkflowIR Integration (integration gate; inputs V2-002 + V2-003)
**Classification of capability:** integration-gate proof over repository persistence/versioning + WorkflowIR semantics (not a human UI surface)
**Validation type:** real-service repository↔WorkflowIR dogfooding experiment (work-order dogfooding requirement, literal: "Create one real workflow, persist/version it, install it, edit it into a new version, and verify both installed versions retain their intended semantics.")
**Status:** EVIDENCE PERSISTED — pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

IG-001 — Repository ↔ WorkflowIR Integration, gate branch `feat/ig-001-repository-workflowir-roundtrip`, base `def45e79db60d9b509263d2c166733ede9dc1b3d` (merged main after V2-005/W2B). Gate surface: integration test + dogfooding runner + evidence only — no production code changed by this gate (the work order's scope rule).

## Workflow / version under test

One real workflow authored with the merged V2-003 fixtures, persisted/versioned/installed through the real V2-002 repository service:

- **v1 (authored):** `buildMinimalDocument()` — the minimal valid WorkflowIR (single `deterministic_api` observe node, capability `browser.observe`, one workflow input, no presentation). Content digest `6cecc19205a14f3d4d6871d33e586e65b1c3f7d6bd49b2a6abc8438b62736e69`; semantic digest `61974fe04bc40f4d0ffb71978449809d3d262c4e45c52eda51ed54cc80039697`.
- **v2 (the edit):** the same document with the observe node's capability edited `browser.observe` → `workflow.observe` (spec + capabilityRequirements) via `withNode` — the same edit shape as the gate test. Content digest `15a5dfa5ff6ddbdb02fd423790582ad96ca7de42b5fe3c37b23e905bbf4c5481`; semantic digest `4a1ea87fd34088c6d535eba8a015cb826e8bba207c44227c351fd22a7c5d34eb`.
- The two semantic digests differ — the edit is a real semantic change, not a byte-identical re-creation.

## Surface / host

Real product path, single standalone process (`bunx tsx`), no vitest, no mocks:

- **Repository:** the REAL `DefaultWorkflowRepositoryService` (V2-002) over the REAL PGlite test harness via `buildAuthStack({})` — real PostgreSQL compiled to WASM with ALL migrations applied (incl. `0060_workflow_repository_v2.sql` with its DB-level immutability triggers), real users/organizations/memberships, and the `OrganizationMembershipResolver` port wired exactly like the gate test file wires it.
- **WorkflowIR:** the REAL V2-003 barrel — `validateWorkflowIrDocument`, `serializeWorkflowIrDocument`, `computeWorkflowVersionSemanticDigest` — over the merged fixtures (`buildMinimalDocument`, `withNode`).
- Both versions are installed into the SAME organization: the installation identity is derived from `(organizationId, versionId)`, so v1 and v2 installs are TWO coexisting pinned installations (and a re-install of the same version converges — pinned by the gate test's idempotency step).

## Exact task

1. CREATE one real workflow: author the v1 WorkflowIR, validate it through the real V2-003 validator, create the workflow through the real repository service (born with immutable version 1).
2. INSTALL v1 into the organization (installation A, pinned to exactly v1).
3. EDIT the workflow into a new version (the observe-node capability edit) and create immutable version 2 through the real repository service.
4. INSTALL v2 into the same organization (installation B, pinned to exactly v2 — a SECOND coexisting installation).
5. VERIFY BOTH installed versions retain their intended semantics: the organization lists exactly 2 installations; installation A still pins v1 and a fresh `getVersion` re-fetch of v1 is byte-identical to the authored v1 with the authored semantic digest; installation B pins v2 and the v2 re-fetch is byte-identical to the authored v2 with the edited semantic digest.
6. FORK (required-proof extension): the source workflow is set public and forked into a second organization — provenance preserved, independent identity, semantic digest carried, and installations NOT transferred.

## Starting state

Fresh in-process PGlite database (per-run instance) with all migrations applied by `buildAuthStack`. Deterministic fixtures only: the WorkflowIR documents are pure data (`buildMinimalDocument` + `withNode`); content/semantic digests and the wfw_/wfwv_/wfin_ identities are deterministic derivations of (organization, user, fixture) inputs. No network, no vitest, no randomness in the domain path; wall-clock appears only in run-scoped transcript bookkeeping (start/duration lines).

## Expected outcome

- v1 is persisted immutably (versionNumber 1) with the authored content digest and semantic digest.
- Installation A pins exactly v1; installation B (after the edit) pins exactly v2; both installations coexist in the organization (exactly 2 rows).
- v2's semantic digest differs from v1's (the edit is real).
- Re-fetching each version returns serialized bytes byte-identical to the authored document and the authored semantic digest — both installed versions retain their intended semantics.
- The fork gets an independent identity with preserved provenance, carries the source semantic digest, and transfers no installations (fork org lists 0).

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/IG-001/backend && timeout 300 bunx tsx tests/integration/integration-gates/run-ig-001-dogfooding.ts` — exit code 0, 2026-09-02T05:49:38Z (wall clock start 1788328178490 ms; wall duration 3421 ms; the wall-clock lines are run-instance bookkeeping, not domain state — every digest below is fixture-deterministic and was byte-identical across preliminary runs).

```text
IG-001 repository ↔ WorkflowIR round-trip — dogfooding run
  work order                         IG-001 — Repository ↔ WorkflowIR Integration (integration gate)
  gate test                          tests/integration/integration-gates/ig-001-repository-workflowir.integration.test.ts
  base SHA                           def45e79db60d9b509263d2c166733ede9dc1b3d
  wall clock start (ms)              1788328178490
protocol determinism: fixtures only — the WorkflowIR is pure data; digests and
repository identities are deterministic derivations (no network, PGlite in-process).

✓ authored WorkflowIR validates through the real V2-003 validator
✓ workflow created through the real repository service (created=true)
✓ workflow is born with immutable version 1 (versionNumber=1)

CREATE — one real workflow, persisted/versioned
  workflow id                        wfw_4c848fb499834b348d0e294428a53d93
  version id                         wfwv_980025b5b2aeb9afc60ace35f773e34e
  version number                     1
  content digest (V2-002)            6cecc19205a14f3d4d6871d33e586e65b1c3f7d6bd49b2a6abc8438b62736e69
  semantic digest (V2-003)           61974fe04bc40f4d0ffb71978449809d3d262c4e45c52eda51ed54cc80039697
✓ version 1 installed (created=true)
✓ installation A pins exactly version 1

INSTALL v1
  installation id                    wfin_19b5a0fac274390feed5cb368bb0b638
  pinned version                     wfwv_980025b5b2aeb9afc60ace35f773e34e (#1)
✓ edited WorkflowIR validates through the real V2-003 validator
✓ version 2 created through the real repository service (created=true)
✓ version 2 has a new immutable identity (id ≠ v1)
✓ v2 semantic digest ≠ v1 semantic digest (the edit is real)

EDIT into v2 — observe node capability browser.observe → workflow.observe
  version id                         wfwv_b31f68f675b542ce70e4fa9ff9f6349d
  version number                     2
  content digest (V2-002)            15a5dfa5ff6ddbdb02fd423790582ad96ca7de42b5fe3c37b23e905bbf4c5481
  semantic digest (V2-003)           4a1ea87fd34088c6d535eba8a015cb826e8bba207c44227c351fd22a7c5d34eb
✓ version 2 installed (created=true)
✓ installation B is a SECOND coexisting installation (id ≠ installation A)

INSTALL v2
  installation id                    wfin_06f28681782a79eaf15fb8491b2581ec
  pinned version                     wfwv_b31f68f675b542ce70e4fa9ff9f6349d (#2)

VERIFY BOTH — both installed versions retain their intended semantics
✓ the organization lists exactly 2 installations
✓ installation A pins version 1
✓ installation A pinned version number is 1
✓ re-fetched v1 serialized bytes equal the authored v1 bytes
✓ re-fetched v1 semantic digest equals the authored v1 semantic digest
  installation A
  pinned version id                  wfwv_980025b5b2aeb9afc60ace35f773e34e
  pinned version number              1
  pinned content digest              6cecc19205a14f3d4d6871d33e586e65b1c3f7d6bd49b2a6abc8438b62736e69
    installation A RETAINS SEMANTICS: YES
✓ installation B pins version 2
✓ installation B pinned version number is 2
✓ re-fetched v2 serialized bytes equal the authored v2 bytes
✓ re-fetched v2 semantic digest equals the authored v2 semantic digest
  installation B
  pinned version id                  wfwv_b31f68f675b542ce70e4fa9ff9f6349d
  pinned version number              2
  pinned content digest              15a5dfa5ff6ddbdb02fd423790582ad96ca7de42b5fe3c37b23e905bbf4c5481
    installation B RETAINS SEMANTICS: YES

FORK — provenance preserved, independent identity, installations never transfer
✓ fork created (created=true) with an independent workflow identity
✓ fork initial version has a new identity (id ≠ source v1)
✓ fork preserves provenance (forkedFromWorkflowId = source)
✓ fork preserves provenance (forkedFromVersionId = source v1)
✓ fork initial version carries the source semantic digest
✓ installations NOT transferred: the fork org lists 0 installations
✓ the source org still lists exactly 2 installations
  fork workflow id                   wfw_6a5e8d296b65f7a6d1baff9a5fc2e09b
  fork version id                    wfwv_1d2d8fce2692e611aef43394441b1a62
  forkedFromWorkflowId               wfw_4c848fb499834b348d0e294428a53d93
  forkedFromVersionId                wfwv_980025b5b2aeb9afc60ace35f773e34e
  fork semantic digest               61974fe04bc40f4d0ffb71978449809d3d262c4e45c52eda51ed54cc80039697
  fork org installations             0

RESULT: both installed versions retain their intended semantics — PASS
RESULT: fork preserved provenance with an independent identity and transferred no installations — PASS
  wall duration (ms)                 3421
```

Summary of observed outcomes:

- **Both installed versions retain their intended semantics (the literal frozen dogfooding clause):** installation A (`wfin_19b5a0fac274390feed5cb368bb0b638`) still pins exactly v1 (#1) and a fresh re-fetch of v1 produced serialized bytes byte-identical to the authored v1 with the authored semantic digest `61974fe0…39697`; installation B (`wfin_06f28681782a79eaf15fb8491b2581ec`) pins exactly v2 (#2) and the v2 re-fetch was byte-identical to the authored v2 with the edited semantic digest `4a1ea87f…d34eb`. The organization holds exactly 2 coexisting installations — the v2 edit did not move, overwrite, or re-point installation A.
- **The edit is real:** v2's semantic digest differs from v1's; v2 has a new immutable version identity.
- **Fork:** independent workflow identity (`wfw_6a5e…`) with preserved provenance (`forkedFromWorkflowId`/`forkedFromVersionId` = source), the fork initial version carries the source semantic digest, the fork org lists 0 installations (installations are tenant-private and never transfer), and the source org still lists exactly 2.
- All 27 in-transcript checks printed ✓; exit code 0.

## Duration / cost

Domain-path wall duration: 3421 ms single process (includes PGlite boot + all migrations + every repository/IR operation above). Total experiment loop including tsx process startup: ~5 s. Digest determinism verified empirically: two preliminary runs produced byte-identical content/semantic digests and outcomes; only run-scoped bookkeeping (wall clock + uuid-derived org/user ids and the identity derivations that include them) varies between runs.

## Evidence references

- Runner: `backend/tests/integration/integration-gates/run-ig-001-dogfooding.ts` (standalone real-process run; transcript above captured 2026-09-02T05:49:38Z at commit `1932a16`).
- Gate test: `backend/tests/integration/integration-gates/ig-001-repository-workflowir.integration.test.ts` — 4/4 green at the same tree (`timeout 300 bunx vitest run tests/integration/integration-gates/ig-001-repository-workflowir.integration.test.ts` → 1 file, 4 tests passed, 0 failed), including the strengthened test `proves BOTH installed versions retain their intended semantics after the edit (frozen dogfooding clause)` which additionally pins the re-install convergence (idempotent `insertInstallationOrConverge`, still 2 installations, no drift).
- Commits on `feat/ig-001-repository-workflowir-roundtrip`: `bc0c719524a0dc9d1aba7282cf3d511255e82cfe` test(IG-001): prove both installed versions retain their intended semantics; `1932a16194a74aae4790cd95343f46517d60e456` test(IG-001): add the real-path dogfooding runner; `docs(IG-001): persist gate dogfooding evidence` (this file).
- Fixtures: `backend/tests/unit/workflow-ir/helpers.ts` (`buildMinimalDocument`, `withNode`) — the merged V2-003 deterministic fixture battery.
- Harness: `backend/tests/helpers/test-auth-stack.ts` (real PGlite + migrations + identity stack) and `backend/tests/helpers/test-database.ts`.

## Classification

**PASS** — the literal frozen dogfooding clause was executed through the real product path and both installed versions retained their intended semantics (byte-identical content + authored semantic digests after the edit), with the fork provenance/identity/no-transfer proof also green; exit code 0; no contract failure found.

## Limitations recorded honestly (observations, not failures)

1. **PGlite in-process vs CI real-PG.** The local execution path is PGlite (real PostgreSQL compiled to WASM) in one process; the same harness automatically selects a real PostgreSQL server when `WORKFLOWOS_DATABASE_URL` is set (the CI workflow). Repository SQL semantics (immutability triggers, composite FKs, create-or-converge) are the same PostgreSQL dialect in both; real-PG-specific concurrency is out of IG-001's proof list.
2. **Service-level path, not HTTP.** The runner drives the real `DefaultWorkflowRepositoryService` directly (the exact wiring the gate test uses, including the `OrganizationMembershipResolver` port). The HTTP route surface was already proven by V2-002's own dogfooding evidence (`app.inject()` against the real Fastify routes); cross-module/transport composition is IG-002's scope.
3. **Run-scoped repository identities.** Organization/user ids are uuid-derived per PGlite instance, so the derived `wfw_`/`wfwv_`/`wfin_` identities differ between runs. Every semantic assertion (serialized bytes, content digests, semantic digests, counts, provenance) is fixture-deterministic and was byte-identical across runs.
4. **Minimal document shape.** The dogfooding workflow is the minimal valid WorkflowIR with a one-node capability edit (the gate-test edit shape) — deliberately the exact surface the frozen clause exercises; the full triage-document round-trip is pinned by the merged V2-003 dogfooding evidence and the gate test's first case.

## Resulting action

- IG-001's gate is strengthened: the literal two-installed-versions dogfooding clause is now BOTH pinned in the suite (the 4th gate test, incl. re-install convergence and no-drift re-assertions) and executed for real with persisted evidence (this file). The branch `feat/ig-001-repository-workflowir-roundtrip` remains pending-architect-merge (PR #137) — agents never push or mark COMPLETE.
- No frozen-concept contradictions were encountered: the `(organizationId, versionId)`-derived installation identity makes "both installed versions" two coexisting installations exactly as the work order's clause reads; nothing needed reinterpretation.
- No corrective Work Order needed from this experiment.
