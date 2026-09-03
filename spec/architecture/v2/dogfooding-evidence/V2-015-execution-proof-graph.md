# V2-015 — Execution Proof Graph and Trust-Minimized Coordination — Dogfooding Evidence

**Work Order:** V2-015 — Execution Proof Graph and Trust-Minimized Coordination (spec/architecture/v2/work-orders/V2-015.md)
**Activation issue:** #157
**Classification of capability:** the proof-graph composition layer over five merged execution-facing contracts (V2-014 attestations × V2-005 durable Run/evidence × V2-008 computer/device execution incl. the merged V2-016 dependent-admission + causal-parent hooks × V2-009 locality-aware placement + event delivery, composed through the IG-006-verified cross-device protocol); not a human UI surface
**Validation type:** real-stack integration experiment (the work order's literal frozen dogfooding clause: "Use one real safe/isolated workflow across at least two supported hosts. Produce attestations on host A, transfer the run, require a verified predecessor predicate before the next side effect, record the complete proof graph, then replay an attestation or duplicate a graph fragment and prove deterministic rejection/convergence. Persist the evidence and negative findings append-only.")
**Status:** EVIDENCE PERSISTED — dogfooding verdict **PASS** (exit 0; every machine-checkable check green; FOUR consecutive fresh-stack runs deterministic; TWO consecutive whole-runner invocations with the identical normalized-transcript sha-256). Agents never mark COMPLETE; the architect's review and merge are the completion event.

## Work Order ID

V2-015 — Execution Proof Graph and Trust-Minimized Coordination, wave W5 (parallel with V2-012 — no sibling consumption, no rebase), branch `feat/v2-015-execution-proof-graph` (the architect's pre-rooted governed branch at `1696ae1b` = plan-doc commit on base `493da4c8`), base exactly `493da4c82ba70d4a104e97559dc54192297792d2` (main after the architect merge of IG-006 PR #156). Inputs: V2-014, V2-005, V2-008, V2-009, IG-006 (all merged; IG-006 is the architect-merged integration gate at this very base).

## Workflow / version under test

ONE safe cross-device WorkflowIR workflow authored through the merged V2-003 builder — **the intake-form acknowledgment workflow** (3 nodes: the browser step on Node A `web` device kind, a human handoff approval, the device-local dependent acknowledgment write on Node B `desktop` device kind), validated by the real V2-002/V2-003 paths. Version 1 created through the real V2-002 route, INSTALLED (pinned) through the real installations route, deployed through the real V2-009 service with one `file.changed` subscription (the deployment pins the SAME exact version tuple).

## Surface / host

The REAL stack, one process, inject-driven HTTP over the REAL Fastify app:

- **Persistence:** real PGlite with ALL migrations (the platform migration runner applies the full set on every fresh-stack run).
- **Identity:** the real identity stack — API-key operator provisioned through the real credential provisioner.
- **Routes:** the real V2-002 workflow-repository routes (create/install/read), the real V2-005 workflow-runs routes + the attestation attach boundary, the real V2-009 workflow-deployments event-ingest route, every call over `app.inject()`.
- **Two real supported hosts (the V2-008 runtime's supported host kinds), both registered through the REAL V2-004 node protocol:**
  - **HOST A (Node A, the web device kind):** `WebBrowserHostAdapter` over the merged `ScriptedBrowserEnvironment` carrying a REAL Ed25519 attester key — the browser step's grounded click is a REAL host action through the universal protocol.
  - **HOST B (Node B, the desktop device kind):** `DesktopHostAdapter` over the merged `RealFilesystemDesktopEnvironment` (REAL `node:fs/promises` I/O rooted at a real sandbox directory) carrying a REAL Ed25519 attester key — the dependent step's write is a REAL filesystem side effect, asserted by reading the real bytes back.
- **The merged V2-008 `ComputerAgentRuntime` drives both hosts over the real V2-005 run service as its recorder**, with the merged V2-016 dependent-admission policy configured on Node B's runtime (`dependentStepIds: ['record_ack']`) and the typed `DependentStepPrecondition` **materialized by the V2-015 continuation plan** supplied on the resume drive — the runtime contract consumed exactly as merged.
- **Independent verification:** an INDEPENDENT VERIFIER PROCESS (a runtime-generated script importing ONLY the merged V2-014 public barrel — zero production context) verifies the raw canonical envelope bytes with an out-of-band `verifier-context.json`; the resulting `VerifiedExecutionFact` crosses the process boundary as DATA (`verified-fact.json`) and is the ONLY admission currency.
- **The V2-015 layer under test:** `reconstructProofGraphFromRunHistory`, `planCrossDeviceContinuation`, `recordContinuationOutcome`, `deliverGraphFragment`, `serializeProofGraph`/`computeGraphDigest`/`validateGraphState`, `verifyGraphAgainstAttestations` — all consumed through the merged `execution-proof-graph` public barrel.
- **Clocks:** the shared injected trigger clock (epoch 7); the verifier clocks are injected and advanceable.

## Exact task (the frozen clause, executed literally)

1. Author the cross-device workflow; create + INSTALL (pin) v1 through the real V2-002 routes; deploy (V2-009) with one `file.changed` subscription.
2. THE TRIGGER: the real `file.changed` event over the real ingest route; the run pins the EXACT version identity; locality-aware placement routes the browser step ONLY to Node A and the device-local dependent step ONLY to Node B; the duplicate event converges (still ONE run).
3. EXECUTE the first step on HOST A (the runtime's produce→verify→attach gates): ONE `software_signed` ExecutionAttestation durably attached through the real V2-005 boundary; the run PAUSES at the human handoff approval (the transfer moment).
4. TRANSFER: the attestation travels as the V2-014 canonical envelope bytes on the transfer medium; the INDEPENDENT VERIFIER PROCESS verifies it with real Ed25519; the fact attests `statement_authenticity` ONLY (neverAsserts: authorization / capability_possession / correct_behavior / observed_effect / sufficient_evidence).
5. **REQUIRE A VERIFIED PREDECESSOR PREDICATE BEFORE THE NEXT SIDE EFFECT (the V2-015 composition):** the proof graph is RECONSTRUCTED from the real run history (Node A's binding is the graph's first node); `planCrossDeviceContinuation` evaluates the graph-grounded admission over the independent process's fact with the REAL dimension inputs (V2-004 matcher capability facts, the run's safe-action grants, the real placement eligibility) — admitted MATERIALIZES the V2-016 `DependentStepPrecondition` (the runtime currency); the dependent step then executes through `resumeAfterHuman(approved, preconditions=[the materialized precondition])` and the acknowledgment file is REALLY written EXACTLY ONCE (real node:fs bytes asserted); Node B's RUNTIME-PRODUCED dependent attestation carries EXACTLY Node A's execution digest in `causalParents`.
6. **RECORD THE COMPLETE PROOF GRAPH:** the full graph reconstructed from the durable history (two nodes + one causal edge) validates clean; the graph identity preserves the Run/WorkflowVersion identity; the runtime-path fold (`recordContinuationOutcome` over the captured envelope) is BYTE-IDENTICAL with the history reconstruction; the source comparison (`verifyGraphAgainstAttestations`) is clean; the canonical graph digest is recorded.
7. **REPLAY/DUPLICATE CONVERGENCE:** the duplicated graph fragment delivered TWICE converges (zero accepts on re-delivery, byte-identical state); the REPLAYED attestation (the consumed single-use nonce re-presented) is refused typed (`ATTESTATION_REPLAYED`) and mints NO admission currency (the continuation over it is DENIED); the run boundary refuses the duplicate attach (`RUN_ATTESTATION_REJECTED` — no duplicate side effects at the integration boundary); the MUTATED fragment (the dependent node's declared parent swapped AND the parent commitment recomputed — the sneaky coordinator) is DETECTED by the source comparison.
8. **THE NEGATIVE CRYPTOGRAPHIC EXPERIMENTS (each fails through V2-014 verification and yields NO admissible predecessor and NO continuation):** tampered canonical bytes (typed parse failure), an untrusted key context (`ATTESTATION_ATTESTER_UNEXPECTED` — the empty list trusts nobody), a replayed nonce (`ATTESTATION_REPLAYED`), an epoch advance (`ATTESTATION_EPOCH_STALE`), an aged envelope (`ATTESTATION_EXPIRED`), insufficient assurance (`ADMISSION_ASSURANCE_INSUFFICIENT` — a `hardware_backed` requirement over the `software_signed` fact), and a mutated Run binding (`ADMISSION_PREDECESSOR_BINDING_MISMATCH` — cross-run substitution fails closed).
9. Execute as a standalone real process, FOUR times on fresh stacks per invocation (and the whole runner invoked TWICE consecutively), and persist the transcript verbatim below. Exit code 0 = PASS; exit 1 = a check failed or determinism broke (the runner is self-checking by design).

## Starting state

Fresh PGlite + fresh identity stack + fresh sandbox per run. Deterministic environment: shared injected trigger clock, fixed node key seeds (the node identities are seed-derived and stable across runs), fixed fixture content. REAL Ed25519 attester keys are generated per run (key material cannot be seeded) — the key-derived facts (attester key ids, attestation ids, execution digests, graph digests) are the normalized-out bookkeeping; every deterministic structured fact (version digests, node identities, every typed outcome, the graph/admission/convergence results as booleans/counts) is compared byte-for-byte across all four runs by the runner itself.

## Expected outcome

- One Run and one WorkflowVersion identity preserved across two nodes and the PROOF GRAPH (the graph identity is derived ONLY from the (workflow, version, run) triple — invariant 5).
- Attestations produced on host A; the run transferred; **the verified-predecessor predicate REQUIRED before the next side effect** (the V2-015 admission materializes the runtime currency from the independent verifier's fact — the verification result and the dependent execution are ONE composition path; a valid signature alone never becomes trust/authorization/capability/assurance).
- The complete proof graph recorded (append-only, validates clean, source-verified, byte-deterministic serialization, mutation-detection digest).
- Replay/duplicate convergence deterministic (one logical graph fact; typed rejections; no duplicate side effects at any boundary).
- Every negative experiment typed and side-effect-free.

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/V2-015/backend && bunx tsx tests/integration/execution-proof-graph/run-v2-015-dogfooding.ts` — **exit code 0 (the PASS verdict)**, final capture 2026-09-03T06:29Z. The whole runner was executed TWICE consecutively (each invocation = FOUR fresh-stack runs): both invocations exit 0 with the IDENTICAL normalized-transcript sha-256 `6a7282b1363aab32466cfcb80177ccfa661b52df1acc44876aabc9d473d253e7`. Per invocation: 31/31 checks PASS, 0 FAIL; structured facts IDENTICAL across the four fresh-stack runs; normalized transcripts IDENTICAL.

```text

--- RUN 4 — 0. ONE immutable version: authored, installed (pinned), deployed ---
[PASS] 0.version-created: the cross-device workflow created through the real V2-002 route (version 1, content digest 4d2483…1fd2)
[PASS] 0.version-installed: version 1 INSTALLED (pinned) through the real installations route
[PASS] 0.version-readable: the installed version read back over HTTP; V2-003 semantic digest 4e9ba9…47a1
[PASS] 0.deployed: the deployment pins the SAME installed version tuple (V2-009 over the same immutable pin); one file.changed subscription

--- RUN 4 — 1. THE TRIGGER + locality-aware placement (the run pins the version) ---
[PASS] 1.event-delivered: the real file.changed event ingested over HTTP: one delivery, state delivered
[PASS] 1.run-pins-version: the triggered run pins the EXACT version identity (workflow + version + digests + installation) — the graph scope's Run/WorkflowVersion identity
[PASS] 1.placement-routes-two-devices: locality-aware placement: the browser step routes ONLY to Node A (node_8…fa11), the device-local dependent step ONLY to Node B (node_e…deb5)
[PASS] 1.duplicate-event-converged: duplicate event CONVERGED idempotently (HTTP 200, created=false); still exactly ONE run

--- RUN 4 — 2. EXECUTE the first step on HOST A (Node A, the web device) ---
[PASS] 2.step-a-executed: the browser step COMPLETED on Node A through the merged runtime and the run PAUSED at the human handoff approval (the transfer moment)
[PASS] 2.attestation-a-produced: Node A produced ONE software_signed ExecutionAttestation, durably attached through the real V2-005 boundary

--- RUN 4 — 3. TRANSFER the run + the attestation (canonical bytes; INDEPENDENT VERIFIER PROCESS) ---
[PASS] 3.independent-verifier-process: the INDEPENDENT VERIFIER PROCESS (imports ONLY the merged V2-014 public barrel; raw envelope bytes + out-of-band verifier-context.json) verified the transferred attestation with real Ed25519: ok, attests statement_authenticity, neverAsserts ["authorization","capability_possession","correct_behavior","observed_effect","sufficient_evidence"] — the fact crossed the process boundary as DATA (verified-fact.json)

--- RUN 4 — 4. THE V2-015 GRAPH ADMISSION (the verification-derived predicate over the real graph) ---
[PASS] 4.graph-reconstructed: the proof graph RECONSTRUCTED from the real run history: one node (Node A's binding), validates clean, zero rejected bindings
[PASS] 4.continuation-admitted: the graph-grounded admission over the independent verifier's fact with the REAL dimension inputs (V2-004 capability facts, the run's safe-action grants, the real placement eligibility) ADMITTED the dependent continuation
[PASS] 4.precondition-materialized: the V2-016 DependentStepPrecondition MATERIALIZED by the V2-015 continuation plan (the exact runtime currency: the fact from the independent verifier process, the causal parent digest set, the Run/WorkflowVersion identity)

--- RUN 4 — 5. EXECUTE the dependent step on HOST B (the runtime consuming the V2-015-materialized precondition) ---
[PASS] 5.dependent-step-admitted-and-executed: Node B's dependent step is ADMITTED through the V2-015-materialized precondition (consumed before its first side effect) and executed: the acknowledgment file is REALLY written (real node:fs bytes asserted)
[PASS] 5.runtime-causal-parents: the RUNTIME-PRODUCED dependent attestation carries EXACTLY Node A's execution digest in causalParents (the durable binding AND the captured envelope) and verifies under the causalParents expectation — the graph's causal edge is the REAL production path, never a hand-built statement

--- RUN 4 — 6. THE COMPLETE PROOF GRAPH (recorded, validated, source-verified) ---
[PASS] 6.graph-complete: the COMPLETE proof graph reconstructed from the durable history: two nodes, one causal edge (parent = Node A's execution digest), validates clean, zero rejections, zero unresolved parents
[PASS] 6.graph-identity-preserves-run: the graph identity preserves the Run/WorkflowVersion identity (cross-device continuation composes over the SAME logical scope)
[PASS] 6.fold-path-byte-identical: the runtime-path fold (recordContinuationOutcome over Node B's captured envelope) is BYTE-IDENTICAL with the durable-history reconstruction — one logical graph fact
[PASS] 6.source-comparison-clean: verifyGraphAgainstAttestations: the delivered graph EQUALS the projection of the two source envelopes (node identity, every binding field, the declared causal parents)
[PASS] 6.graph-digest: the canonical graph digest over the complete proof graph: 99d718…db53 (mutation detection commitment)

--- RUN 4 — 7. REPLAY/DUPLICATE CONVERGENCE (the frozen clause's replay leg) ---
[PASS] 7.duplicate-fragment-converged: the duplicated graph fragment delivered TWICE converges: zero accepts on re-delivery, all duplicates, byte-identical state (one logical graph fact)
[PASS] 7.replayed-attestation-refused: the REPLAYED attestation (the same single-use nonce re-presented after consumption) is refused TYPED (ATTESTATION_REPLAYED) and the continuation over the refused verification is DENIED — no admission currency is minted
[PASS] 7.run-boundary-duplicate-refused: the run boundary refuses the DUPLICATE attach of the dependent attestation (durable single-use nonce — RUN_ATTESTATION_REJECTED); no duplicate side effects at the integration boundary
[PASS] 7.mutated-fragment-detected: the MUTATED graph fragment (the dependent node's declared parent swapped AND the parent commitment RECOMPUTED) is DETECTED by the source comparison (the delivered graph no longer equals the projection of the authenticated envelopes)

--- RUN 4 — 8. THE NEGATIVE CRYPTOGRAPHIC EXPERIMENTS (no admissible predecessor, no continuation) ---
[PASS] 8.tampered-bytes: tampered canonical envelope bytes: typed parse failure (ATTESTATION_MALFORMED_ENVELOPE) — NO fact, NO admission
[PASS] 8.untrusted-key-context: an untrusted key context: the verifier refuses TYPED (ATTESTATION_ATTESTER_UNEXPECTED) and the continuation is DENIED — the empty list trusts nobody
[PASS] 8.epoch-advance-stale: a verifier epoch advanced past the statement's is stale TYPED (ATTESTATION_EPOCH_STALE) — no fact
[PASS] 8.aged-envelope-expired: an aged envelope (verifier clock far past validity) is expired TYPED (ATTESTATION_EXPIRED) — no fact
[PASS] 8.insufficient-assurance: a hardware_backed assurance requirement over the software_signed fact denies the continuation TYPED (ADMISSION_ASSURANCE_INSUFFICIENT) — signature validity never silently becomes assurance
[PASS] 8.mutated-run-binding: a mutated Run binding (the plan composed against a DIFFERENT run scope) is denied TYPED (ADMISSION_PREDECESSOR_BINDING_MISMATCH) — cross-run substitution fails closed

(RUN 1..3 transcripts: identical to RUN 4 above after normalizing run-scoped bookkeeping
 — uuid-shaped ids, the derived dep_/sub_/evt_/dlv_/wfw_/wfwv_/wfin_/wfr_… ids, the
 Ed25519 key-derived material (attester key ids, attestation ids, execution digests —
 real Ed25519 cannot be seeded), the mkdtemp sandbox suffixes and the run labels. The
 deterministic structured facts — version digests, node identities, the timeline, every
 typed outcome, the graph/admission/convergence results — are compared byte-for-byte
 across all four fresh-stack runs.)

determinism (structured facts): IDENTICAL across the four fresh-stack runs
determinism (normalized transcripts): IDENTICAL

DOGFOODING RESULT: PASS (every machine-checkable check green; the four fresh-stack runs deterministic — the frozen V2-015 dogfooding clause executed on the REAL stack: attestations produced on host A, the run transferred, the verified-predecessor predicate required before the next side effect, the complete proof graph recorded, and the replay/duplicate convergence proven deterministic)
```

## Honest limitations

1. **The two hosts are in-process instances of the V2-008 runtime's supported host kinds** (the web side over the merged `ScriptedBrowserEnvironment`; the desktop side over the merged `RealFilesystemDesktopEnvironment` with REAL `node:fs/promises` I/O) — the same honest limitation the IG-006 evidence records; the universal host protocol, the V2-004 registration, and the runtime composition are the real merged paths.
2. **The independent verifier is a spawned process, not a separate machine:** the transferred envelope bytes cross a real process boundary (raw file + out-of-band verifier-context.json, importing ONLY the merged V2-014 public barrel, zero production context) — but the network is not exercised (the family precedent; no real cross-machine transport exists in this repository).
3. **The workflow is the canonical 3-step cross-device shape** (browser step → human approval → device-local write): it exercises the dependent-admission and causal-parent composition the frozen clause targets; multi-parent joins are covered by the unit/integration batteries (multi-parent.test.ts, admission-mutations.test.ts, the cross-device multi-parent test), not by this single-clause runner.
4. **The V2-015 graph state is a deterministic composition over existing evidence** (per the work order's ownership boundary — V2-005 remains the persistence authority): the graph is reconstructed from the durable run history and the signed envelopes; no graph-specific durable tables were added (the frozen work order does not require them).
5. **The admission's capability/authorization/placement dimension inputs are caller-supplied facts** derived from the REAL V2-004 matcher results, the run's safe-action grants, and the real placement evaluation — the V2-015 layer never evaluates possession/grants/placement itself (the authority separation the boundary battery pins).
6. **PGlite is real PostgreSQL compiled to WASM** (the same single persistence boundary; no real multi-connection contention — the family limitation).
7. **Determinism proof scope:** the normalized-transcript equality + structured-facts equality across the four fresh-stack runs (per invocation) and the identical normalized-transcript sha-256 across the two whole-runner invocations. The raw transcripts differ exactly in the normalized-out bookkeeping (uuids, derived ids, per-run Ed25519 key material, sandbox suffixes, run labels) — real Ed25519 key material cannot be seeded.

## Battery receipts (the verification evidence)

- Unit: graph 18 + serialization 12 + admission 20 + admission-mutations 20 + multi-parent 6 + replay-convergence 8 = 84/84 green, run TWICE (deterministic).
- Integration: evidence 7 + cross-device 8 (incl. the separate-PROCESS verifier) + coordinator-mutation 9 = 24/24 green, run TWICE (deterministic).
- Architecture: the V2-015 boundary battery 11 tests green; the full architecture suite green (see the Task 8 completion receipts).
- Dogfooding: the runner above — exit 0, 31/31 checks, FOUR fresh-stack runs × TWO invocations, normalized-transcript sha-256 `6a7282b1363aab32466cfcb80177ccfa661b52df1acc44876aabc9d473d253e7`.

## Negative findings (append-only)

- No negative findings in the composition itself. The recorded honest observations are the limitations above (host kinds in-process, verifier process not machine, PGlite single-connection, graph state as composition rather than durable tables — each a scope boundary of the frozen work order, not a failure).

## Task 8 completion matrix (the full verification battery — final receipts)

All commands executed from `backend/` at the final head; every scoped battery run TWICE (deterministic, identical counts):

| Battery | Command | Result |
|---|---|---|
| V2-015 scoped (unit + integration) ×2 | `bunx vitest run tests/unit/execution-proof-graph tests/integration/execution-proof-graph` | **108/108 green** both runs (84 unit + 24 integration) |
| Architecture suite | `bunx vitest run tests/architecture` | **905/905 green** (incl. the 11 V2-015 boundary tests; zero regressions) |
| Full non-integration scope | `bunx vitest run tests/unit tests/architecture tests/continuous-validation tests/browser-validation tests/validation-scheduling tests/engineering-signals tests/progressive-release` | **2926 passed / 0 failed** |
| Integration chunk 1 (agent-intelligence → auth) | `bunx vitest run tests/integration/{agent-intelligence,agent-roles,agents,architect,architecture,architecture-governance,audit,auth}` | 612 passed / 29 skipped |
| Integration chunk 2 (benchmark → development-planner) | `bunx vitest run tests/integration/{benchmark,computer-agent,delegation,development-governance,development-planner}` | 190 passed / **3 failed — the INHERITED WORK-069 governance trio** (W052-AC01 + W052-AC03 ×2; verified identical on canonical main in the same window during the PR #156 final-head verification round; zero governance files in this diff) / 1 skipped |
| Integration chunk 3 (dev-runtime → execution-routing, incl. execution-proof-graph) | `bunx vitest run tests/integration/{dev-runtime,e2e,engineering-signals,execution-attestation,execution-proof-graph,execution-policy,execution-routing}` | 228 passed / 6 skipped |
| Integration chunk 4 (frontend → notifications) | `bunx vitest run tests/integration/{frontend,github,llm,maintenance,marketplace,node-capability,notifications}` | 102 passed |
| Integration chunk 5 (onboarding → repository-intelligence) | `bunx vitest run tests/integration/{onboarding,orchestration,postgres,progressive-release,projects,redis,repository-intelligence}` | 145 passed / 23 skipped |
| Integration chunk 6 (requirements → webpack) | `bunx vitest run tests/integration/{requirements,reverse-teaching,reviews,runtime,storage,teaching-sessions,trigger-scheduling,validation-scheduling,webpack}` | 100 passed / 6 skipped |
| Integration chunk 7 (verification → workflow-ir) | `bunx vitest run tests/integration/{verification,work-items,workbench,workflow-compiler,workflow-deployments,workflow-ir}` | 174 passed |
| Integration chunk 8 (workflow-optimization → workflows + top-level) | `bunx vitest run tests/integration/{workflow-optimization,workflow-repository,workflow-runs,workflows} tests/integration/async-worker.integration.test.ts` | 216 passed |
| **TOTAL (full canonical scope, disjoint chunks)** | | **4693 passed / 3 failed (the inherited trio) / 65+ skipped — ZERO V2-015-attributable failures** |
| Typecheck | `bun run typecheck` | exactly the 2 inherited `workflow-deployments.route.ts` TS2739 baseline errors; **zero new** |
| Scoped lint | `bunx eslint src/execution-proof-graph tests/unit/execution-proof-graph tests/integration/execution-proof-graph tests/architecture/execution-proof-graph-boundary.test.ts` | 0 errors / 0 warnings |
| Dogfooding | `bunx tsx tests/integration/execution-proof-graph/run-v2-015-dogfooding.ts` (×2 invocations) | exit 0 both; 31/31 checks; 4 fresh-stack runs per invocation; normalized-transcript sha-256 `6a7282b1…d253e7` identical |

Baseline comparison: the pre-V2-015 base (`493da4c8`) CI totals were 4698 passed / 3 failed / 2 skipped (PR #156 final head, the +6 IG-006 gate tests included); the +108 V2-015 tests are ALL green and the ONLY failures remain the 3 inherited WORK-069 governance failures — zero new failures attributable to this work.
