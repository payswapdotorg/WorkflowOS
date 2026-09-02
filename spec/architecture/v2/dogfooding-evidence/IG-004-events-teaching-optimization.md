# IG-004 — Events + Reverse Teaching + Optimization Integration Gate — Dogfooding Evidence

**Work Order:** IG-004 — Events + Reverse Teaching + Optimization Integration
**Classification of capability:** integration-gate verification of three merged W4 execution-facing contracts (V2-009 scheduling + events + placement × V2-010 reverse teaching × V2-011 workflow optimization) over ONE immutable workflow/version model (V2-002 repository + V2-003 WorkflowIR underneath); not a human UI surface
**Validation type:** real-stack integration experiment (work-order dogfooding requirement, literal frozen clause: "Execute one event-triggered workflow, teach the same workflow to a human, and compare a baseline and an optimization proposal against the same acceptance task")
**Status:** EVIDENCE PERSISTED — experiment run through the real integrated paths; gate remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

IG-004 — Events + Reverse Teaching + Optimization Integration, wave W4 integration gate, branch `feat/ig-004-events-teaching-optimization`, base `663d0fcb5810e919d0bcbbc6298eb9719db6c22d` (current main after V2-011 PR #146). Inputs: V2-009, V2-010, V2-011 (all merged on this base). Frozen scope: integration tests/spec/evidence ONLY — this gate composes already-merged capabilities; no implementation redesign, no sibling rebases, no drive-by fixes to V2-009/V2-010/V2-011.

## Workflow / version under test

ONE real WorkflowIR workflow authored through the merged V2-003 builder — the **repository ticket digest report** (5 nodes / 5 control edges: `fetch_tickets` deterministic_api `github.repository.read`, `scan_board` agentic_computer_use with EXACTLY ONE API-stable ordinary requirement `github.repository.read` (the post-correction V2-011 invariant), `approve_digest` human approval, `record_rejection` human information carrying the sensitive `spreadsheet.edit` capability, `send_digest` deterministic_api `messaging.send`), validated by the real `validateWorkflowIrDocument`, compiling under the real V2-007 `compileWorkflow`, V2-003 semantic digest `6979473f6abfa8331255bb2dbda3d687ce1d1e03b2bed0580508cda523d15914`.

Version lifecycle exercised on the real V2-002 repository:

- **v1 (baseline)** — created through the real route (version 1), INSTALLED (pinned) through the real installations route (installation status `enabled`), deployed (V2-009 pins the SAME exact (workflow, version) tuple + installation pin).
- **v2 (optimized candidate)** — materialized through the V2-011 materializer port backed by the real repository `createVersion` after the owner-approved api_substitution proposal (version 2, distinct content digest, parent v1). NEVER installed, NEVER deployed, NEVER activated.

## Surface / host

The REAL stack, one process, inject-driven HTTP over the REAL Fastify app:

- **Persistence:** real PGlite (PostgreSQL compiled to WASM — the same single persistence boundary as production `pg`) with ALL 62 migrations (incl. `0062_workflow_deployments_v2.sql`).
- **Identity:** the real identity stack — API-key operator (provisioned through the real credential provisioner; the secret lives in the env secret store — the production path).
- **Routes:** the real V2-002 workflow-repository routes (create workflow / install / read version / list versions / read installation), the real V2-005 workflow-runs routes (request run / start / steps / invocations / complete / history / list) and the real V2-009 workflow-deployments routes (event ingest / tick), every call over `app.inject()`.
- **Node directory:** one device node registered through the REAL V2-004 protocol (SHA-256 key seed → nonce challenge → HMAC-SHA256 challenge-response → registration → trust), the event's declared source.
- **Composed services:** the V2-010 `DefaultReverseTeachingSessionService` (session store in-memory — the module's reference composition; the pin is resolved from the REAL installed version read over HTTP) and the V2-011 `DefaultWorkflowOptimizationService` with the `CandidateVersionMaterializer` port satisfied by the REAL V2-002 repository service (the only version authority).
- **Clocks:** the shared injected trigger clock (V2-005/V2-009/V2-004 boundaries observe one epoch); the teaching/optimization services use their own injected stepping clocks.

## Exact task

1. Author the digest-report workflow; create + INSTALL (pin) v1 through the real V2-002 routes; read it back (byte snapshot + parsed document + V2-003 semantic digest).
2. Deploy it (V2-009) with a cloud_allowed placement policy and one `file.changed` event subscription — the deployment pins the SAME exact version.
3. **Execute the event-triggered workflow:** write the REAL repository-board snapshot file to a real sandbox directory; deliver its `file.changed` event (source = the registered device node, payload = the real path) through the real ingest route; verify the triggered run pins v1's exact identity; EXECUTE the run to completion through the real V2-005 routes (all five declared steps; the scan step records the AGENTIC computer-use loop — a real observation of the real board file (its real sha-256 as the observation commitment) then the action).
4. Re-deliver the SAME (source, eventId) — verify idempotent convergence (zero new deliveries; still one run).
5. **Teach the same workflow to a human:** create the reverse-teaching session over the SAME installation pin; begin the lesson from the installed content; perform the whole manual lesson (the `spreadsheet.edit` step safety-gated — the unacknowledged attempt refused typed); finalize; verify every evidence record is teaching evidence pinned to the installation and that teaching created ZERO runs.
6. **Compare a baseline and an optimization proposal against the same acceptance task:** analyze v1 (exactly one api_substitution opportunity) → propose (provenance pins the REAL v1 identity) → approve (the owner's human gate) → materialize v2; EXECUTE the optimized run against the SAME real task (the scan step as the direct deterministic API call); compare through the module's empirical engine (correctness FIRST — same five steps, same statuses, the SAME real digest-line artifact — then resource cost and maintainability signals) and the deterministic document comparison (the frozen rubric).
7. Verify NO MUTATION (v1 byte-identical after the whole experiment), NO ACTIVATION (installation + deployment keep pinning v1) and independent addressability (both versions fetchable by id, distinct digests; two runs each pinning its exact version).
8. Execute as a standalone real process, TWICE on fresh stacks, and persist the transcript verbatim below.

## Starting state

Fresh PGlite + fresh identity stack per run. Deterministic environment: shared trigger clock base `1788264000000` (2026-09-01T12:00:00.000Z), run-boundary epoch 7, teaching clock base `1733568000000`, optimization clock base `1789000000000`, sequential id factories, fixed node key seed (`sha256('ig-004-dogfooding-device')`), fixed board-snapshot content. No network, no wall-clock dependence in protocol logic, no randomness (the only wall-clock fact is the run-instance timestamp/duration below).

## Expected outcome

- The event-triggered run and (in the gate test) the scheduled run instantiate the PINNED WorkflowVersion: the exact (workflow, version) pin, V2-002's content digest, V2-003's semantic digest, the installation pin, and the event/run correlation (the trigger identity embeds the inbox event identity; the run's input commitment IS the event's payload commitment).
- The duplicate event converges idempotently: one inbox event, one delivery, one run.
- The reverse-teaching lesson derives from the INSTALLED version (digest-verified; a mismatched document is refused typed — proven in the gate test's dedicated negative).
- The optimization proposal materializes as a NEW WorkflowVersion (distinct immutable identity); the baseline is never mutated and never activated.
- Baseline and optimized versions remain independently addressable and independently executable; the comparison over the same acceptance task is correctness-first-equivalent with the honest resource/maintenance deltas.
- Overall: **event/scheduled execution, human teaching and optimization operate over the SAME immutable workflow/version model.**

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/IG-004/backend && bunx tsx tests/integration/integration-gates/run-ig-004-dogfooding.ts` — exit code 0, 2026-09-02T18:06:09Z (wall duration 7.8 s for BOTH fresh-stack runs; the only wall-clock facts are run-instance bookkeeping — every boundary clock is injected). Transcript sha-256: `a434c8b2e4050e3a9c72798e650480ce0a9d8cd29e3db0a15712dc7684dd3ba0`.

```text
--- RUN 2 — 0. ONE immutable version: authored, installed (pinned), deployed ---
[PASS] 0.baseline-created :: the gate workflow created through the real V2-002 route (version 1, wfwv_dcc1…e422)
[PASS] 0.baseline-installed :: version 1 INSTALLED (pinned) through the real installations route
[PASS] 0.baseline-readable :: the installed version read back over HTTP; V2-003 semantic digest 6979473f6…5914
[PASS] 0.deployed :: the deployment pins the installed version exactly (V2-009 over the same immutable pin); one file.changed event subscription

--- RUN 2 — 1. EXECUTE the event-triggered workflow (the baseline run) ---
[PASS] 1.real-task-file :: the repository-board snapshot is a REAL file (cceadde00…6343); the acceptance task outcome is the digest line computed from it
[PASS] 1.event-delivered :: the real file.changed event ingested (HTTP 201): one delivery, state delivered, run wfr_d96de…be27
[PASS] 1.run-pins-v1 :: the event-triggered run instantiates the pinned WorkflowVersion: exact (workflow, version) pin, V2-002 content digest + V2-003 semantic digest of the INSTALLED v1, the installation pin, and the event/run correlation (trigger embeds the inbox event identity; the run's input commitment IS the event's payload commitment)
[PASS] 1.duplicate-converged :: duplicate event CONVERGED idempotently (HTTP 200, created=false, zero new deliveries); still exactly ONE run
[PASS] 1.baseline-completed :: the event-triggered BASELINE run EXECUTED to completion through the real V2-005 routes (all five declared steps)

--- RUN 2 — 2. TEACH the same workflow to a human (reverse teaching) ---
[PASS] 2.lesson-from-installed :: the reverse-teaching session pins the SAME installation; the lesson derives from the INSTALLED version (the digest-verified manual view: 5 steps in canonical order)
[PASS] 2.safety-gate :: the spreadsheet.edit step is SAFETY-GATED (V2-008's sensitive vocabulary consumed by V2-010)
[PASS] 2.safety-refused :: the safety-gated step REFUSES performance without the explicit acknowledgment (typed SAFETY_ACKNOWLEDGMENT_REQUIRED)
[PASS] 2.lesson-completed :: the human completed the manual lesson (3 performed + 2 disclosure-acknowledged); every evidence record is TEACHING evidence pinned to the SAME installation
[PASS] 2.zero-runs :: teaching created ZERO runs (the execution/teaching distinction): still exactly ONE run after the whole lesson

--- RUN 2 — 3. The OPTIMIZATION PROPOSAL (a new version, never a mutation) ---
[PASS] 3.analyzed :: the deterministic analysis of the installed v1 finds EXACTLY ONE opportunity: api_substitution of the agentic scan step (its single API-stable ordinary requirement github.repository.read beats UI automation)
[PASS] 3.proposal-pinned :: the PROPOSAL (status proposed) pins the REAL v1 identity (workflow + version + V2-003 semantic digest) with provenance; task-surface equivalence proven + the merged V2-003 negotiation accepts
[PASS] 3.materialized-v2 :: the approved proposal MATERIALIZED as a REAL new WorkflowVersion 2 through the port backed by the real V2-002 repository (a distinct immutable identity — the proposed change, never a mutation of the source)

--- RUN 2 — 4. BASELINE vs OPTIMIZED on the SAME acceptance task ---
[PASS] 4.optimized-pins-v2 :: the optimized run is INDEPENDENTLY addressable: it pins v2's exact identity through the real V2-005 boundary (installationId null — the candidate is NOT activated)
[PASS] 4.optimized-completed :: the OPTIMIZED run EXECUTED to completion through the real V2-005 routes (all five declared steps)
[PASS] 4.correctness-first :: CORRECTNESS FIRST: both real runs completed with the SAME five steps and statuses; the scan step's output commitment is the SAME REAL artifact (a396e4596…0d6b — the digest line computed from the real board file)
[PASS] 4.resource-cost :: resource cost: the baseline's event-triggered agentic loop (observe→act) costs 6 invocations; the optimized direct API call 5 (Δ-1)
[PASS] 4.maintainability-signals :: maintainability signals: the optimized run's capability surface drops the browser observation (4 → 3 distinct capabilities)
[PASS] 4.rubric-deltas :: the deterministic comparison over the two REAL versions: task-surface equivalent; latency 7→5 (Δ-2), cost 6→3 (Δ-3), reliability Δ-0.13, maintenance 6→5 (Δ-1)

--- RUN 2 — 5. NO MUTATION + NO ACTIVATION + independent addressability ---
[PASS] 5.not-activated :: NOT ACTIVATED: the installation AND the deployment keep pinning v1 (enabled) — the candidate v2 merely EXISTS
[PASS] 5.no-mutation :: NO MUTATION: the baseline version re-read over HTTP is byte-identical after the whole experiment (event trigger, execution, teaching, optimization, BOTH runs)
[PASS] 5.addressable :: baseline and optimized versions remain INDEPENDENTLY ADDRESSABLE (2 versions, distinct digests) and 2 runs, each pinning its exact version identity

# RUN 2 summary: all checks PASS

(RUN 1 transcript: byte-identical to RUN 2 above after normalizing run-scoped
 bookkeeping — uuid-shaped ids, the derived dep_/sub_/evt_/dlv_/run_ ids, the
 mkdtemp sandbox suffixes, the run labels. Both runs share the same deterministic
 content/semantic digests and the same real-task artifact commitments.)

determinism: transcripts IDENTICAL after normalization

DOGFOODING RESULT: PASS (deterministic across two fresh runs)
```

Summary of observed outcomes:

- **One immutable version model, three consumers:** the deployment (V2-009), the reverse-teaching session (V2-010) and the optimization proposal (V2-011) all pinned the SAME installed v1 through the merged V2-002/V2-003 surfaces, and none of them mutated it — v1 was byte-identical after the event trigger, the full execution, the teaching lesson, the optimization lifecycle and both runs.
- **Event-triggered execution pins the version:** the run created by the real event delivery carried the exact (workflow, version) pin, V2-002's content digest, V2-003's semantic digest, the installation pin and the event/run correlation (trigger id `evt:<inbox-event>:<subscription>`; input commitment = the event's payload commitment). The duplicate re-delivery converged (HTTP 200, created=false, zero deliveries, one run). The gate test additionally proves the SCHEDULED run (one-shot tick) pins the same version with trigger id `sch:<subscription>:<occurrence>`.
- **Teaching derives from the installed version:** the lesson (5 steps, canonical order) was the digest-verified manual view of the installed content; the `spreadsheet.edit` step was safety-gated (the unacknowledged attempt refused typed); the finalized lesson recorded only teaching evidence pinned to the installation and created ZERO runs. The gate test's dedicated negative proves the fail-closed boundary: a document with a different semantic digest is refused `VERSION_PIN_MISMATCH` and the session is not transitioned.
- **Optimization proposes, never mutates:** the analysis found exactly the one api_substitution opportunity; the proposal's provenance pinned the REAL v1 identity; the owner-approved candidate materialized as a REAL new WorkflowVersion 2 through the materializer port backed by the repository; the installation AND the deployment kept pinning v1.
- **Baseline vs optimized on the same acceptance task, correctness first:** both runs completed the SAME five steps with the same statuses; the scan step's output commitment was the SAME REAL artifact (`a396e459685965a06a759a33eee82d1078d8dc71b710c9686a90e4c8833f0d6b` — the digest line `open tickets: 3 — snapshot@cceadde007f2` computed from the real board file, sha-256 `cceadde007f28336f0e95c018a8c41d71232946152f2cf452cc3a06308d66343`); then the honest resource cost (6→5 invocations — the agentic observation round-trip) and maintainability signals (4→3 distinct capabilities — the browser observation dropped); the frozen rubric over the two REAL versions (latency 7→5, cost 6→3, reliability Δ-0.13, maintenance 6→5).
- **Independently addressable:** both versions fetched by id with distinct content digests, two versions listed, and two runs each pinning its exact version identity (the optimized run pins v2 with installationId null — the candidate is never activated by optimization).

## Duration / cost

Wall duration 7.8 s for the whole double-run experiment (two fresh PGlite stacks + two full identity stacks + both five-step run executions + the teaching lesson + the optimization lifecycle + the comparison). Protocol time is driven by the injected deterministic clocks, so the protocol timeline is reproducible exactly.

## Evidence references

- Runner: `backend/tests/integration/integration-gates/run-ig-004-dogfooding.ts` (standalone real-process run; transcript above captured 2026-09-02T18:06:09Z, exit code 0, sha-256 `a434c8b2e4050e3a9c72798e650480ce0a9d8cd29e3db0a15712dc7684dd3ba0`).
- Gate test: `backend/tests/integration/integration-gates/ig-004-events-teaching-optimization.integration.test.ts` (2 tests on the real stack: the full P1–P5 gate path — event-triggered run pinning the installed version, duplicate-event convergence, one-shot scheduled run pinning the same version, reverse teaching from the installation with the safety-gate negative, optimization proposal → approval → materialization with byte-identity and pin re-verification, independent addressability + the optimized run pinning v2 — plus the dedicated VERSION_PIN_MISMATCH negative).
- Frozen work order: `spec/architecture/v2/work-orders/IG-004.md` + Issue #147 (branch base `663d0fcb5810e919d0bcbbc6298eb9719db6c22d`).
- Deterministic identities shared by both runs: V2-003 semantic digest `6979473f6abfa8331255bb2dbda3d687ce1d1e03b2bed0580508cda523d15914`; board-snapshot sha-256 `cceadde007f28336f0e95c018a8c41d71232946152f2cf452cc3a06308d66343`; scan-step outcome commitment `a396e459685965a06a759a33eee82d1078d8dc71b710c9686a90e4c8833f0d6b`.
- Scoped verification at evidence time: gate test 2/2 green (twice — deterministic); the other gates IG-001/IG-002 11/11 green; architecture suite 895/895 (static pins intact: migration count 62, route count 37 — the gate adds ZERO src files); `bun run typecheck` — zero new errors (the 2 `workflow-deployments.route.ts` errors VERIFIED IDENTICAL at the pristine base `663d0fc` in a detached worktree — V2-009's merged code, inherited and disclosed); scoped eslint on both new files — 0 errors, 0 warnings; full local vitest suite in disjoint chunks: 4146 passed / 3 failed / 65 skipped — the 3 failures are the WORK-069 governance trio (governance-state W052-AC01 + parallel-eligibility W052-AC03 ×2), VERIFIED INHERITED at the pristine base `663d0fc` (same 3 failures; zero governance files in this diff; out of scope per the architect constraint).
- Full-suite details (re-runnable from `backend/`): unit + architecture + continuous-validation 128 files / 2351; integration a–e 989 (950 passed / 3 failed / 36 skipped); integration f–o 179 (169 passed / 10 skipped, includes the integration-gates 13/13); integration p–w 357 (338 passed / 19 skipped); workflow-compiler/ir/workflows + benchmark 230; workflow family (deployments/reverse-teaching/optimization/repository/runs) 108.

## Classification

**PASS** — event/scheduled execution, human teaching and optimization verified over the SAME immutable workflow/version model: scheduled and event-triggered runs instantiate the pinned WorkflowVersion (exact version pin + content digest + semantic digest + installation pin + event/run correlation); duplicate events converge idempotently; reverse teaching derives from the installed version (digest-verified, fail-closed on mismatch); optimization produces a proposed new version rather than mutating the source (byte-identical baseline, still-pinned installation and deployment); baseline and optimized versions remain independently addressable and independently executable. No second authority introduced by the gate (it consumes the three merged barrels exactly; the gate adds ZERO src files, ZERO migrations, ZERO routes).

## Limitations recorded honestly (observations, not failures)

1. **Executor-driven run bodies.** The run step/invocation bodies are driven by the runner exactly as an executor would drive the real V2-005 boundary (the same discipline as the V2-005/V2-009/V2-011 dogfooding precedents); the agentic loop's observation commitment is the REAL board file's sha-256, but no computer-agent runtime (V2-008) executes the steps autonomously in this experiment — that surface is V2-008's own dogfooding evidence.
2. **The scheduled trigger is proven by the gate test, not the runner transcript.** The frozen dogfooding clause requires ONE event-triggered workflow; the one-shot schedule (the same pinned-version instantiation proof, trigger type `schedule`) is proven in the gate test (`ig-004-events-teaching-optimization.integration.test.ts`, section P1b) rather than duplicated in the transcript above.
3. **In-process HTTP.** All route calls are `app.inject()` over the REAL Fastify app in one process (the family precedent); a real network transport is not exercised by this gate.
4. **PGlite/CI divergence.** The local real stack is PGlite; CI runs the same suite against PGlite (the production boundary is `pg`) — the same single persistence boundary, different driver build (recorded by every V2 family evidence).
5. **The teaching/optimization stores are the modules' in-memory reference compositions.** Durable proposal/session persistence is a separately-owned later concern (V2-011/V2-010 work orders); the PIN resolution — the fact this gate proves — flows through the REAL V2-002 repository in both cases (the installed version is read over the real routes; the candidate is created through the real repository service).
6. **Reuse opportunities not exercised.** The gate fixture deliberately contains exactly one api_substitution opportunity and no duplicate non-human nodes; the workflow_reuse path (with its capability-aware duplicate signature) remains covered by the merged V2-011 battery — out of the gate's frozen composition scope.

## Resulting action

- IG-004 remains **implemented / pending-architect-merge** (never marked COMPLETE by an agent). This evidence satisfies the Work Order's literal dogfooding clause and all five required proofs on the real stack.
- No contract failure found across V2-009/V2-010/V2-011 composition; no corrective Work Order needed from this experiment. The gate is the prerequisite for advancing the roadmap beyond W4 — the architect's merge is the completion event.
