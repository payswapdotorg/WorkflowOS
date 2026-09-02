# V2-011 — Workflow Optimization — Dogfooding Evidence

**Work Order:** V2-011 — Workflow Optimization (wave W4)
**Classification of capability:** owner-facing optimization capability (analyze an installed workflow, propose a safer/cheaper/faster/more-maintainable implementation, materialize it as an explicit CANDIDATE WorkflowVersion after the owner's approval) — an analysis/proposal surface, never an execution, version-authority or activation surface
**Validation type:** real-product experiment (work-order dogfooding requirement, literal frozen clause: "Run baseline and optimized versions against the same real task and compare correctness first, then resource cost and maintainability signals")
**Status:** EVIDENCE PERSISTED — experiment run through the real integrated paths; the Work Order remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

V2-011 — Workflow Optimization, wave W4, branch `feat/v2-011-workflow-optimization`, base `4c5568abb98ccbfefcc86bdfaf288c48db21c423` (merged main: V2-002 through V2-010 + V2-014 + IG-001 + IG-002 + governance reconciliation all frozen on this base).

## Workflow / version under test

**The "daily-ticket-digest" workflow** — authored through the real V2-003 builder (`createWorkflowIrBuilder`), created and INSTALLED (pinned immutable version 1) through the real V2-002 HTTP routes:

- 5 declared steps: `fetch_tickets` (deterministic_api `github.repository.read`), `scan_board` (**agentic_computer_use** whose declared requirement `github.repository.read` is an API-stable ORDINARY capability — the substitution target), `approve_digest` (human approval, approved/rejected outcomes), `record_rejection` (human information), `send_digest` (deterministic_api `messaging.send` with a `secret_ref` binding).
- One workflow input `ticketQuery`, one workflow output `digestReport`; both human outcomes covered (all five steps on the executed path).
- The **candidate version 2** derived by the V2-011 module from the owner-approved proposal: `scan_board` becomes `deterministic_api github.repository.read` — ports, bindings, failure policy, placement and completion evidence verbatim; every other node byte-identical; honest compatibility declaration `equivalent` + `none`/`none` (cross-checked by the merged V2-003 negotiation: accept / public-surface-unchanged).

## Surface / host

**The full real stack**: real PGlite (PostgreSQL compiled to WASM — the platform's test-database boundary, the same single persistence surface as production `pg`) with ALL 62 migrations applied by the real migration-runner; the real identity stack (users/organizations/memberships + API-key credential provisioner + auth provider); a REAL Fastify app built by `buildServer` with the REAL V2-002 workflow-repository routes AND the REAL V2-005 workflow-runs routes — every repository, installation, version-creation and run step driven over HTTP via `app.inject()`.

**The optimization path**: the V2-011 public API (`src/workflow-optimization/index.ts` barrel) — `DefaultWorkflowOptimizationService` over `InMemoryOptimizationProposalStore` (the reference composition for the store port, the exact V2-006/V2-010 family precedent; durable proposal persistence is a separately-owned later concern) with the **candidate-version materializer port satisfied by the REAL V2-002 repository service** (`DefaultWorkflowRepositoryService.createVersion` — the exact authority behind the routes; the module itself never imports the repository). The analysis/comparison consume the merged V2-003 barrel (validator, semantic digest, serializer, negotiation); the unsafe rule consumes the merged V2-008 sensitive-capability vocabulary; the empirical comparison consumes real V2-005 run histories read-only. No mock anywhere in this Work Order's control boundary.

**The real task data**: a real repository-board snapshot FILE (`board-snapshot.txt`, written to a real mkdtemp sandbox directory — 5 ticket lines, 3 open); the task outcome artifact is the digest line computed from that real file; the agentic observation's input commitment is the real file's sha-256.

**Host:** local dev sandbox, Node via `bunx tsx`, PGlite in-memory. (CI equivalent: real PostgreSQL behind `WORKFLOWOS_DATABASE_URL`; unset in this environment, recorded honestly.)

**Reproducible experiment path:** `backend/tests/integration/workflow-optimization/run-optimization-dogfooding.ts` (`bunx tsx tests/integration/workflow-optimization/run-optimization-dogfooding.ts` from `backend/`).

## Exact task (the Work Order's required experiment)

1. **BASELINE** — author the daily-ticket-digest workflow (merged V2-003 builder), create it through the real V2-002 route (born with immutable version 1), INSTALL/pin version 1 through the real installations route, read it back over HTTP; write the real board-snapshot file.
2. **ANALYZE → PROPOSE → APPROVE → MATERIALIZE** — through the V2-011 public API: the analysis detects the api_substitution opportunity (the declared requirement is an API-stable ordinary capability); the proposal is created with full provenance (the exact baseline pin + analysis identity) and the pre-materialization comparison (task-surface equivalence + merged-negotiation acceptance + the frozen rubric deltas); materialization BEFORE the owner's approval is rejected typed (APPROVAL_REQUIRED); the owner explicitly approves; the candidate materializes as a REAL new WorkflowVersion 2 through the materializer port (the real repository service).
3. **BASELINE RUN** — the same real task against the INSTALLED v1 through the real V2-005 routes: all five declared steps driven exactly as an executor would; the scan step records the REAL agentic computer-use loop (an observation of the real board file — the file's real sha-256 as the observation commitment — then the action): 2 invocations.
4. **OPTIMIZED RUN** — the SAME real task against the candidate v2 (NOT activated — `installationId: null`): the same five steps; the scan step records 1 direct deterministic API invocation; the SAME output commitments (the same real task → the same real outcome artifact).
5. **COMPARE (correctness FIRST)** — the module's empirical engine over the two REAL run histories: correctness (both completed; same step set; same statuses; the scan step's output commitment EQUAL in both runs — the same real artifact digest), THEN the resource cost signals (invocation counts) and the maintainability signals (distinct capabilities); plus the deterministic document comparison over the two REAL versions (the frozen rubric: latency/cost/reliability/maintenance deltas).
6. **NO ACTIVATION + NO MUTATION** — the installation still pins v1 (enabled); v1 re-read over HTTP is byte-identical after the whole experiment.

## Starting state

Fresh real stack (fresh PGlite + fresh identity stack) per run; the deterministic injected sources (sequential ids, stepping clocks) on both the optimization service and the run service; fixed task content (the board snapshot lines). No network, no wall-clock dependence in product logic, no randomness.

## Expected outcome

1. The baseline workflow is installed and pinned exactly as authored (version 1; the HTTP-read content re-parses and its semantic digest is computable through the merged V2-003 barrel).
2. The analysis detects exactly one api_substitution opportunity (scan_board), zero unsafe rejections; the proposal's provenance pins the exact baseline (workflow, version, semantic digest) and the deterministic analysis identity.
3. The approval gate holds: materialization before the owner's approval is rejected typed; after approval, the candidate materializes as a REAL new version 2 (versionNumber 2, different content identity) — never a mutation of v1.
4. The candidate substitutes ONLY the mechanism: scan_board is deterministic_api (github.repository.read) with ports/bindings/failure policy verbatim; the merged V2-003 negotiation accepts the candidate (public-surface-unchanged).
5. Both real runs (baseline agentic; optimized direct) complete all five declared steps; the scan step's output commitment is the SAME real artifact digest in both runs.
6. CORRECTNESS FIRST: the empirical comparison proves equivalence (both completed, same steps, same statuses, same real outcome); THEN resource cost: the agentic loop costs one extra invocation (6 → 5); maintainability: the optimized capability surface drops the browser observation (4 → 3 distinct capabilities).
7. NOT ACTIVATED: the installation still pins v1 (enabled); the candidate v2 merely exists. NO MUTATION: v1 is byte-identical after everything.
8. The whole experiment is deterministic: two fresh-stack runs produce identical transcripts after normalizing run-scoped bookkeeping.

## Observed outcome (verbatim run transcript)

```text
=== V2-011 dogfooding RUN 2 (fresh PGlite + fresh identity stack) ===

--- RUN 2 — 1. BASELINE: the real workflow + the real task data ---
[PASS] 1.real-task-file :: the repository-board snapshot is a REAL file (4a9cf4ee2…74f3); the task outcome is the digest line computed from it
[PASS] 1.create-baseline :: the baseline workflow created through the real V2-002 route (version 1, wfwv_551f…9136)
[PASS] 1.install-baseline :: version 1 INSTALLED (pinned) through the real installations route
[PASS] 1.baseline-readable :: the installed version read back over HTTP; V2-003 semantic digest 6d1d51ee6…f8d6

--- RUN 2 — 2. ANALYZE → PROPOSE → APPROVE → MATERIALIZE (the optimization lifecycle) ---
[PASS] 2.analysis-detects :: the analysis detects the api_substitution opportunity (scan_board: the declared requirement github.repository.read is an API-stable ordinary capability)
[PASS] 2.proposal-provenance :: the proposal's provenance pins the EXACT baseline (workflow, version, V2-003 digest) + the analysis identity opt_b4ce4…b3de
[PASS] 2.proposal-comparison :: the pre-materialization comparison proves task-surface equivalence; the merged V2-003 negotiation accepts the candidate (public-surface-unchanged)
[PASS] 2.approval-gate :: materialization BEFORE the owner's approval is rejected typed (APPROVAL_REQUIRED) — no candidate version exists yet
[PASS] 2.owner-approves :: the owner explicitly APPROVES the proposal
[PASS] 2.candidate-materialized :: the candidate materialized as a REAL NEW WorkflowVersion 2 (wfwv_d98d…0d8e) — never a mutation of v1
[PASS] 2.candidate-substitution :: the candidate substitutes ONLY the mechanism: scan_board becomes deterministic_api (github.repository.read); ports/bindings/failure policy verbatim
[PASS] 2.rubric-deltas :: the frozen rubric over the two REAL versions: latency 7→5 (Δ-2), cost 6→3 (Δ-3), reliability Δ-0.13, maintenance 6→5 (Δ-1)

--- RUN 2 — 3. BASELINE RUN: the real task against v1 (the agentic loop) ---
[PASS] 3.request-baseline :: run REQUESTED for the INSTALLED v1 through the real V2-005 route
[PASS] 3.complete-baseline :: the baseline run COMPLETED (all five declared steps executed)

--- RUN 2 — 4. OPTIMIZED RUN: the SAME real task against v2 (the direct API call) ---
[PASS] 3.request-optimized :: run REQUESTED for the candidate v2 (NOT activated — installationId null) through the real V2-005 route
[PASS] 3.complete-optimized :: the optimized run COMPLETED (all five declared steps executed)

--- RUN 2 — 5. COMPARE (correctness FIRST, then cost + maintainability) ---
[PASS] 5.correctness-first :: CORRECTNESS FIRST: both real runs completed with the SAME five steps and statuses — the optimized version performs the SAME task
[PASS] 5.same-real-outcome :: the scan step's output commitment is the SAME REAL artifact digest in both runs (630ed379e…0693) — the digest line computed from the real board file
[PASS] 5.resource-cost :: resource cost: the baseline's agentic loop (observe→act) costs 6 invocations; the optimized direct API call 5 (Δ-1)
[PASS] 5.maintainability-signals :: maintainability signals: the optimized run's capability surface drops the browser observation (4 → 3 distinct capabilities)

--- RUN 2 — 6. NO ACTIVATION + NO MUTATION ---
[PASS] 6.not-activated :: NOT ACTIVATED: the installation still pins version 1 (enabled) — the candidate v2 merely EXISTS; activation is the owner's separate decision on the V2-002/V2-009 surface
[PASS] 6.baseline-unchanged :: NO MUTATION: the baseline version re-read over HTTP is byte-identical after the whole experiment (analysis, proposal, approval, materialization, BOTH runs)

# RUN 2 summary: all checks PASS

(RUN 1 transcript: byte-identical to RUN 2 above after normalizing run-scoped
 bookkeeping — uuid-derived org/user/version/installation/run ids, the mkdtemp
 sandbox suffixes, the run labels — the full RUN 1 transcript is reproduced by
 simply running this runner; both runs share the same deterministic content digests.)

determinism: transcripts IDENTICAL after normalization

DOGFOODING RESULT: PASS (deterministic across two fresh runs)
```

## Evidence references

- Runner (committed, reproducible): `backend/tests/integration/workflow-optimization/run-optimization-dogfooding.ts` — commit `4c5cf9f` on `feat/v2-011-workflow-optimization`; invocation `bunx tsx tests/integration/workflow-optimization/run-optimization-dogfooding.ts` from `backend/` → exit 0, `DOGFOODING RESULT: PASS (deterministic across two fresh runs)`.
- RED battery (tests-first, module resolution failures only): commit `19d52b5` — 11 unit files / 63 tests.
- Implementation (GREEN): commit `9fb8445` — 63/63 unit tests green; scoped eslint 0 findings.
- Integration battery (real stack): commit `58d8570` — 3 tests green on real PGlite + all 62 migrations + real routes (the same materializer-port-over-real-repository composition this experiment uses).
- Deterministic digests reproduced across both runs: baseline V2-003 semantic digest `6d1d51ee6…f8d6`; analysis identity `opt_b4ce4…b3de`; real board-file digest `4a9cf4ee2…74f3`; real outcome-artifact digest `630ed379e…0693`; rubric deltas latency Δ-2 / cost Δ-3 / reliability Δ-0.13 / maintenance Δ-1.

## Duration

Two full fresh-stack runs in one process: ~14 s wall (each run: stack build + migrations + the 6-section experiment). The deterministic-fixture discipline keeps re-runs byte-stable after normalization.

## Classification

**PASS** — every check passed in both fresh-stack runs; transcripts identical after normalization; exit 0.

## Resulting action

- V2-011's analysis → proposal → owner-approval gate → candidate materialization → baseline-vs-optimized comparison loop is verified end-to-end on the real stack with a real task file and real runs; the candidate exists as a real WorkflowVersion 2 while the installation keeps pinning v1 (never activated, never mutated).
- The frozen clause is discharged literally: baseline and optimized versions ran against the same real task; correctness was compared FIRST (equivalent — same steps, same statuses, the same real outcome-artifact digest), then the resource cost (one fewer invocation: the agentic observation round-trip removed) and the maintainability signals (the browser-observation capability dropped from the run's surface).
- NOT merged: the architect's merge is the completion event; this evidence supports the PR review.

## Honest limitations (explicitly recorded, never silent)

1. **The runs are executor-driven, not agent-executed**: the baseline run's agentic step records the computer-use loop's invocation SHAPE (a real observation commitment — the real board file's sha-256 — then the action) rather than being driven by the V2-008 runtime itself; the dogfooding compares the two versions' runs through the real V2-005 recording boundary (V2-011 does not own execution). The invocation-count comparison is therefore a REAL recorded-fact comparison (both runs' invocations are real V2-005 records), not a wall-clock benchmark.
2. **Latency/cost/reliability are modeled, not measured**: the rubric deltas (Δ-2 latency units, Δ-3 cost units, Δ-0.13 failure weight) are the frozen documented model over declared facts; the empirical layer grounds the resource-cost signal with the recorded invocation counts (6 → 5) and the maintainability signal with the recorded distinct-capability counts (4 → 3). No wall-clock latency or monetary cost was measured.
3. **The reuse opportunity kind is not exercised in the dogfooding transcript**: the frozen clause requires the baseline-vs-optimized run pair (an api_substitution candidate); the workflow_reuse path (including a REAL existing-workflow target and the targetless-suggestion negative) is fully covered by the integration battery on the same real stack.
4. **The unsafe rejection is covered by the integration battery** (a sensitive-capability workflow → typed SENSITIVE_CAPABILITY_SUBSTITUTION → no candidate created) rather than duplicated in this transcript; the dogfooding clause is the run-pair comparison.
5. **The candidate version is deliberately NOT activated** (the installation still pins v1): activation is the owner's separate decision on the V2-002/V2-009 surfaces, outside V2-011's owned scope ("does not own … automatic activation of optimized versions").
6. **CI environment difference**: local PGlite (WASM) vs CI's real PostgreSQL behind `WORKFLOWOS_DATABASE_URL` (unset here) — the same divergence honestly recorded by every prior V2 dogfooding evidence.

## Re-verification after the PR #146 corrections (architect REQUEST_CHANGES round)

After the architect's repository-level review of PR #146 found two blocking
correctness defects (API substitution could drop required capabilities for
multi-requirement nodes; the reuse duplicate signature ignored
`capabilityRequirements`), the module was corrected on this same branch
(commits `04c6398` RED regressions → `f6ab415` GREEN fixes) and this
experiment was RE-RUN at the corrected head:

- Invocation: `bunx tsx tests/integration/workflow-optimization/run-optimization-dogfooding.ts` from `backend/` → exit 0, `DOGFOODING RESULT: PASS (deterministic across two fresh runs)`.
- Result: identical to the recorded transcript — same two fresh-stack runs, all six sections PASS, transcripts byte-identical after normalization, the same deterministic content digests (baseline V2-003 semantic digest `6d1d51ee6…f8d6`; analysis identity `opt_b4ce4…b3de` — UNCHANGED by the corrections, as expected: the dogfooding workflow's agentic node declares exactly one API-stable requirement, so its analysis output is untouched by the single-requirement restriction and by the capability-aware duplicate signature).
- Scope of the corrections relative to this experiment: none of the six recorded sections changed; the corrections only close the two holes the architect identified (multi-requirement substitution and differently-capable reuse grouping), neither of which is exercised by this fixture — both are covered by dedicated RED→GREEN regressions in the unit battery (`analysis-detection.test.ts`, `unsafe-optimization.test.ts`) and the integration battery (`workflow-optimization.core.integration.test.ts`, two new negatives on the real stack: no candidate version created for a multi-requirement agentic node; differently-capable scans never grouped for reuse).
