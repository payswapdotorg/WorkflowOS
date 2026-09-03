# IG-006 — Cross-Device Execution Attestation Composition — Dogfooding Evidence

**Work Order:** IG-006 — Cross-Device Execution Attestation Composition
**Classification of capability:** integration-gate verification of five merged execution-facing contracts (V2-005 durable WorkflowRuns × V2-008 computer/device execution incl. the merged V2-016 dependent-admission + causal-parent hooks × V2-009 locality-aware placement + event delivery × V2-014 ExecutionAttestations) composed into ONE cross-device execution protocol; not a human UI surface
**Validation type:** real-stack integration experiment (work-order dogfooding requirement, literal frozen clause: "Run one safe cross-device workflow using two real supported hosts. Execute a first step on host A, transfer the run, verify its attestation on host B, execute a dependent step, disconnect/reconnect or replay one message, and verify the resulting Run/evidence/proof graph remains correct and side-effect-safe")
**Status:** EVIDENCE PERSISTED (V2-016 RE-PROVE ROUND). The architect's repository-level review blocked the first submission (PR #152, preserved open on its original `927f23d` base as the historical fail-closed record) on two composition-proof gaps: the P3 admission coupling and the P5 runtime causal chain. V2-016 — Cross-Device Attestation Runtime Preconditions (merged as main `11d6afbfefe55badb2765d68aecfad013ed5ce53`, squash of PR #155) supplied the runtime contract this re-prove consumes. Both couplings are now POSITIVELY PROVEN on the real runtime composition path — `V2-014 verification → VerifiedExecutionFact → Node-B admission → dependent side effect → causalParents in the runtime-produced attestation` — and the gate verdict is **PASS**. Agents never mark COMPLETE; the architect's merge is the completion event.

## Work Order ID

IG-006 — Cross-Device Execution Attestation Composition, wave W5 integration gate / prerequisite for V2-015, branch `feat/ig-006-cross-device-attestation-v2` (the architect's pre-rooted governed branch at `2ab2381`, content-identical to main `11d6afbf`), base `11d6afbfefe55badb2765d68aecfad013ed5ce53` (main after the V2-016 squash merge — the exact current lineage; the old `feat/ig-006-cross-device-attestation` branch is NOT rebased and PR #152 is preserved open as the historical blocked attempt). Inputs: V2-005, V2-008, V2-009, V2-014, V2-016 (all merged). Frozen scope: integration tests, protocol conformance, evidence and dogfooding ONLY. **The re-prove modifies ONLY the gate's own three files (the gate test, the dogfooding runner, this evidence file) — ZERO modifications to V2-005/V2-008/V2-009/V2-014/V2-016 or any other source file**; every V2-016 surface is consumed through the merged public `computer-agent` barrel only (`DependentStepPrecondition`, `policy.dependentStepIds`, the `preconditions` input on the execute/resume/takeover drives).

## Workflow / version under test

ONE safe cross-device WorkflowIR workflow authored through the merged V2-003 builder — **the intake-form acknowledgment workflow** (3 nodes: the browser step on Node A `web` device kind, a human handoff approval, the device-local dependent acknowledgment write on Node B `desktop` device kind), validated by the real `validateWorkflowIrDocument`, V2-003 semantic digest `1c271b56b…3c45`, content digest `16b409f2c…4e4b`. Version 1 created through the real V2-002 route, INSTALLED (pinned) through the real installations route, deployed through the real V2-009 service with one `file.changed` subscription (the deployment pins the SAME exact version tuple). The section-9 probes additionally author ONE probe workflow of the identical shape with DISTINCT output-path literals (its side effect can never be conflated with the main run's).

## Surface / host

The REAL stack, one process, inject-driven HTTP over the REAL Fastify app:

- **Persistence:** real PGlite with ALL 62 migrations (incl. `0062_workflow_deployments_v2.sql`).
- **Identity:** the real identity stack — API-key operator provisioned through the real credential provisioner.
- **Routes:** the real V2-002 workflow-repository routes (create/install/read), the real V2-005 workflow-runs routes (request/start/steps/invocations/complete/history + the attestation attach boundary), the real V2-009 workflow-deployments routes (event ingest), every call over `app.inject()`.
- **Two real supported hosts (the V2-008 runtime's supported host kinds), both registered through the REAL V2-004 node protocol:**
  - **HOST A (Node A, the web device kind):** `WebBrowserHostAdapter` over the merged `ScriptedBrowserEnvironment` carrying a REAL Ed25519 attester key — the browser step's grounded click is a REAL host action through the universal protocol.
  - **HOST B (Node B, the desktop device kind):** `DesktopHostAdapter` over the merged `RealFilesystemDesktopEnvironment` (REAL `node:fs/promises` I/O rooted at a real sandbox directory) carrying a REAL Ed25519 attester key — the dependent step's write is a REAL filesystem side effect, asserted by reading the real bytes back.
- **The merged V2-008 `ComputerAgentRuntime` drives both hosts over the real V2-005 run service as its recorder** (the runtime's own public composition surface), with the **merged V2-016 dependent-admission policy configured on Node B's runtimes (`dependentStepIds: ['record_ack']`) and the typed `DependentStepPrecondition` supplied on the resume drive** — the runtime contract under re-prove, consumed exactly as merged.
- **Independent verification:** Node B's verifier context (its own fresh single-use replay registry, its own trusted-attester list, the run-derived binding expectations) — real Ed25519 verification. An additional INDEPENDENT VERIFIER PROCESS (importing ONLY the merged public barrel) verifies the raw canonical envelope bytes with an out-of-band `verifier-context.json` — zero production context.
- **Transfer medium:** Node A's attestation serialized to the V2-014 canonical envelope bytes on the transfer medium (2102 chars) and parsed back with the SAME identity + statement.
- **Clocks:** the shared injected trigger clock; the verifier clocks are injected and advanceable (freshness/epoch tests).

## Exact task

1. Author the cross-device workflow; create + INSTALL (pin) v1 through the real V2-002 routes; deploy it (V2-009) with one `file.changed` subscription — the deployment pins the SAME exact version tuple.
2. THE TRIGGER: deliver the real `file.changed` event (source = Node A, payload = the real intake-form file) over the real ingest route; verify the triggered run pins the EXACT version identity with the event/run correlation; verify locality-aware placement (browser step → Node A ONLY; device-local dependent step → Node B ONLY; a cloud relay advertising the SAME filesystem capabilities is capability-eligible yet placement-INELIGIBLE — capability alone never routes); verify duplicate-event convergence.
3. EXECUTE the first step on HOST A: the browser step (observe → grounded click → verify) completes on Node A through the merged runtime and the run PAUSES at the human handoff approval (the transfer moment); Node A produces ONE `software_signed` ExecutionAttestation durably attached through the real V2-005 boundary.
4. TRANSFER: serialize Node A's attestation to the V2-014 canonical envelope bytes on the transfer medium; the INDEPENDENT VERIFIER PROCESS verifies the raw bytes with real Ed25519.
5. VERIFY on HOST B (**P3a — the V2-014 verifier domain, now COUPLED**): Node B's own verifier context verifies the transferred attestation; the verified fact attests `statement_authenticity` ONLY; negatives ALL typed and side-effect-free: untrusted-attester refusal (`ATTESTATION_ATTESTER_UNEXPECTED` — producing NO fact, so NO admission precondition can be constructed), replayed handoff (`ATTESTATION_REPLAYED` — single-use nonce consumed), epoch-stale (`ATTESTATION_EPOCH_STALE`), expired (`ATTESTATION_EXPIRED`). **The VerifiedExecutionFact minted here is the admission currency consumed in step 6 — the verification result and the dependent execution are ONE composition path.**
6. EXECUTE the dependent step on HOST B (**the V2-016 runtime path**): `resumeAfterHuman(approved, preconditions=[the precondition derived from the step-5 verified fact])` — the runtime validates the precondition structurally at drive entry, ADMITS the dependent step, and the acknowledgment file is REALLY written exactly once (real bytes asserted); Node B produces its own attestation, verified + durably attached through the same boundary. **P5b (runtime production, PROVEN):** the RUNTIME-PRODUCED dependent attestation (the durable binding AND the signed envelope) carries EXACTLY Node A's execution digest in `causalParents` — never a hand-built statement — and that produced attestation verifies under the causalParents expectation; **P5a (verifier domain):** hand-built un-parented and wrong-parented dependent statements are refused typed on dimension `causalParents`.
7. DISCONNECT/RECONNECT + REPLAY: the re-presented handoff is refused `ATTESTATION_REPLAYED`; duplicate handoff delivery converges in the V2-014 ingestion ledger (accepted → duplicate, 2 deliveries, one identity); duplicate trigger converges (zero new runs); duplicate attach command converges exactly-once (executed=false); a re-attach under a NEW command id is rejected typed through the real route (HTTP 422 `RUN_ATTESTATION_REJECTED` carrying `ATTESTATION_REPLAYED`, the DURABLE rejection row records it); duplicate host action converges in the host ledger (NO second write — the real file bytes unchanged).
8. Verify the RESULTING Run/evidence/proof graph: the run history reconstructs (ONE attempt, all three steps in order); both attestation bindings carry the SAME run/version/semantic/attempt identity across TWO DIFFERENT node identities; the protocol timeline is EXACTLY the pinned 31-event sequence (zero new events from duplicates/replays); the invocation sequence is exactly the cross-device loop with EXACTLY ONE write; every attestation evidenceReference resolves to a real evidence record of THIS run; final accounting: exactly ONE run, ONE durable rejection row, ONE write effect per host, the immutable version byte-identical.
9. **THE FAIL-CLOSED ADMISSION PROBES (the P3b coupling re-proved, machine-checked):** (a) the MISSING case — a second safe cross-device workflow: Node A executes its step, then Node B attempts the dependent drive with NO verification leg in between, a runtime policy that does NOT even trust Node A's attester key, and NO precondition supplied: the dependent action is REFUSED (typed `AGENT_PRECONDITION_REJECTED`, ZERO host side effects — the probe acknowledgment file is NOT written, zero filesystem invocations, no Node-B attestation); (b) the CROSS-RUN FACT-THEFT case — a GENUINE fact verified for ANOTHER run of the same pinned version, supplied as this run's precondition: typed `COMPUTER_AGENT_PRECONDITION_REJECTED` thrown at DRIVE ENTRY (zero durable mutations, zero host side effects), the run left PAUSED; (c) the GENUINE RE-DRIVE — the corrected, genuinely-verified precondition completes the run, the dependent side effect executes EXACTLY ONCE, and the dependent attestation carries the causal parent.
10. Execute as a standalone real process, TWICE on fresh stacks per execution, and persist the transcript verbatim below. The runner's verdict is **PASS** with exit code 0 (all checks green + deterministic + both couplings positively proven); exit 1 fires if any check fails, determinism breaks, or either coupling is no longer proven.

## Starting state

Fresh PGlite + fresh identity stack per run. Deterministic environment: shared injected trigger clock, sequential id factories, fixed fixture content, fixed node key seeds (the node identities `node_693d…09b7` / `node_198a…77d6` are seed-derived and stable across runs). REAL Ed25519 attester keys are generated per run (key material cannot be seeded) — the key-derived facts (attester key ids, attestation ids, execution digests) are the normalized-out bookkeeping; every deterministic structured fact (version content/semantic digests, node identities, the 31-event timeline, the invocation/evidence sequences, every typed outcome, the admission/causal coupling probes as booleans/counts) is compared byte-for-byte across the two runs by the runner itself. No network, no wall-clock dependence in protocol logic (the only wall-clock facts are the run-instance timestamp/duration below).

## Expected outcome

- **Genuinely proven on the merged composition (the full runtime path):** one Run and one WorkflowVersion identity preserved across two nodes (P1); step execution on Node A produces a valid ExecutionAttestation (P2); **Node B independently verifies the attestation BEFORE admitting a dependent action — P3a the verifier domain, P3b the admission coupling: the verification RESULT (the canonical VerifiedExecutionFact) is consumed as the runtime admission precondition, and the dependent action CANNOT execute without it (typed refusals, zero side effects, cross-run theft rejected at drive entry, re-drivable)**; freshness/replay protection works across reconnect/retry at the verifier and durable run boundary (P4); **causal parent binding is enforced — P5a the verifier dimension (un-parented and wrong-parented refused typed), P5b the runtime production (the runtime-produced dependent attestation carries EXACTLY Node A's execution digest in causalParents and verifies under the causal expectation)**; duplicate handoff/event delivery converges without duplicate side effects (P6); capability and authorization remain separate dimensions (P7); insufficient node trust/assurance produces explicit typed ineligible/rejected results (P8 — and the untrusted verifier can mint NO admission currency at all); evidence and attestation references reconstruct the execution history (P9). A valid signature authenticates the attester statement and NEVER establishes trust, authorization, capability possession, observed effect, or correctness.

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/IG-006-v2/backend && bunx tsx tests/integration/integration-gates/run-ig-006-dogfooding.ts` — **exit code 0 (the PASS gate verdict)**, final capture 2026-09-03T04:19Z (wall duration ≈ 8 s for BOTH fresh-stack runs; FOUR consecutive executions with identical normalized transcript). Normalized-transcript sha-256 (computed by the runner, stable across ALL executions): `d6227d685cd55c932a279946c0d4c94448facc337f88804a58a5fa615810fdf6`.

```text
--- RUN 2 — 0. ONE immutable version: authored, installed (pinned), deployed ---
[PASS] 0.version-created :: the cross-device gate workflow created through the real V2-002 route (version 1, content digest 16b409f2c…4e4b)
[PASS] 0.version-installed :: version 1 INSTALLED (pinned) through the real installations route
[PASS] 0.version-readable :: the installed version read back over HTTP; V2-003 semantic digest 1c271b56b…3c45
[PASS] 0.deployed :: the deployment pins the SAME installed version tuple (V2-009 over the same immutable pin); one file.changed subscription

--- RUN 2 — 1. THE TRIGGER + locality-aware placement (the run pins the version) ---
[PASS] 1.event-delivered :: the real file.changed event (source = Node A, payload = the real intake-form file) ingested over HTTP: one delivery, state delivered
[PASS] 1.run-pins-version :: the triggered run pins the EXACT version identity (workflow + version + content/semantic digests + installation) with the event/run correlation (trigger id embeds the inbox event identity; the run's input commitment IS the event's payload commitment)
[PASS] 1.placement-routes-two-devices :: locality-aware placement: the browser step routes ONLY to Node A (web, node_693d…09b7), the device-local dependent step ONLY to Node B (desktop, node_198a…77d6); the cloud relay advertising the SAME filesystem capabilities is capability-eligible yet placement-INELIGIBLE (capability alone never routes)
[PASS] 1.duplicate-event-converged :: duplicate event CONVERGED idempotently (HTTP 200, created=false, zero new deliveries); still exactly ONE run

--- RUN 2 — 2. EXECUTE the first step on HOST A (Node A, the web device) ---
[PASS] 2.step-a-executed :: the browser step COMPLETED on Node A through the merged runtime (observe → grounded click → verify) and the run PAUSED at the human handoff approval (the transfer moment); the submit button is REALLY clicked on the web host
[PASS] 2.attestation-a-produced :: Node A produced ONE software_signed ExecutionAttestation, durably attached through the real V2-005 boundary (statement bound to the run/version/semantic-digest/attempt/step/node)

--- RUN 2 — 3. TRANSFER the run + the attestation (canonical bytes on the transfer medium) ---
[PASS] 3.envelope-transferred :: Node A's attestation serialized to the V2-014 canonical envelope bytes (2102 chars) on the transfer medium and parsed back with the SAME identity + statement
[PASS] 3.independent-verifier-process :: the INDEPENDENT VERIFIER PROCESS (imports ONLY the merged public barrel; raw envelope bytes + out-of-band verifier-context.json) verified the transferred attestation with real Ed25519: ok, attests "statement_authenticity", neverAsserts ["authorization","capability_possession","correct_behavior","observed_effect","sufficient_evidence"]

--- RUN 2 — 4. VERIFY on HOST B (the independent V2-014 verifier domain — P3a; the fact is CONSUMED by the dependent admission) ---
[PASS] 4.independent-verification-p3a :: Node B's verifier context (fresh single-use replay registry, Node B's trusted-attester list, run-derived binding expectations) verifies the transferred attestation (P3a, the V2-014 verifier domain): the verified fact attests statement_authenticity only — and this verification RESULT is the admission currency consumed by the dependent drive in section 5 (the V2-016 coupling)
[PASS] 4.signature-never-authorizes :: the verified fact EXPLICITLY never asserts authorization / capability possession / correct behavior / observed effect / sufficient evidence (a valid signature is never a trust grant)
[PASS] 4.untrusted-attester-refused :: a verifier that does not trust Node A's key refuses the verification TYPED (ATTESTATION_ATTESTER_UNEXPECTED) and produces NO fact — the admission currency is IMPOSSIBLE to mint without trusting the attester, so no dependent admission can be constructed (the fail-closed admission probe is section 9)
[PASS] 4.replayed-handoff-refused :: the REPLAYED handoff (the same verification message re-presented to Node B) is refused TYPED (ATTESTATION_REPLAYED — the single-use nonce was consumed at verification; P4 verifier-domain freshness)
[PASS] 4.epoch-stale-refused :: a verifier epoch advanced past the statement's is stale TYPED (ATTESTATION_EPOCH_STALE)
[PASS] 4.expired-refused :: an aged envelope (verifier clock past issuedAt + validity) is expired TYPED (ATTESTATION_EXPIRED)

--- RUN 2 — 5. EXECUTE the dependent step on HOST B (Node B, the desktop device — the V2-016 admission path consuming the section-4 verified fact) ---
[PASS] 5.precondition-derived-from-verification :: the dependent admission precondition is DERIVED from the section-4 verification result (the V2-014 VerifiedExecutionFact minted by Node B's own verifier — the admission currency; the declared causal parent is the fact's own execution digest)
[PASS] 5.dependent-step-admitted-and-executed :: Node B's dependent step is ADMITTED through the verification-derived precondition (consumed before its first side effect) and executed (resumeAfterHuman over the DURABLE run: the human approved the handoff): the acknowledgment file is REALLY written (real node:fs bytes asserted) with the exact expected content
[PASS] 5.causal-runtime-production-p5b :: P5b (the RUNTIME production path — PROVEN): the runtime-produced dependent attestation (the real durable record_ack binding AND the envelope Node B actually signed) carries EXACTLY Node A's execution digest in causalParents — the same digest the verified fact attests — and that produced attestation verifies under the causalParents expectation (the causal chain is real end-to-end: never a hand-built statement for the positive proof)
[PASS] 5.causal-verifier-p5a :: P5a (the V2-014 verifier domain): the causalParents dimension is ENFORCED — hand-built un-parented and wrong-parented dependent statements are refused TYPED on dimension causalParents (the pre-V2-016 un-parented runtime shape would not verify under a causal expectation)

--- RUN 2 — 6. DISCONNECT/RECONNECT + REPLAY: every duplicate converges side-effect-safely ---
[PASS] 6.handoff-ledger-converged :: duplicate handoff delivery converges by stable attestation identity (ledger: accepted → duplicate, 2 deliveries, ONE identity)
[PASS] 6.duplicate-trigger-converged :: the re-delivered trigger event converges idempotently (created=false, zero new deliveries)
[PASS] 6.duplicate-attach-converged :: the duplicate attach command (the runtime's exact command id) converges exactly-once (executed=false — the V2-005 command log)
[PASS] 6.route-replay-rejected :: the re-attach under a NEW command id is rejected TYPED through the real route (HTTP 422 RUN_ATTESTATION_REJECTED carrying ATTESTATION_REPLAYED) and the DURABLE rejection row records the replay
[PASS] 6.duplicate-host-action-converged :: the duplicate host action (the same invocation id re-presented to Node B) converges in the host ledger (converged=true) — NO second write, the real file bytes unchanged

--- RUN 2 — 7. the RESULTING RUN/EVIDENCE/PROOF GRAPH (correct + side-effect-safe) ---
[PASS] 7.run-graph-reconstructs :: the run history reconstructs: the completed run pins the SAME version identity, ONE attempt, all three steps in order (web node → human approval → desktop node)
[PASS] 7.attestations-cross-device :: BOTH attestation bindings carry the SAME run/version/semantic/attempt identity across TWO DIFFERENT node identities (Node A produced the first, Node B the second — distinct execution digests): one protocol across two devices
[PASS] 7.timeline-exact :: the protocol timeline is EXACTLY the pinned 31-event sequence (requested → started → the browser loop → verified attestation → paused → resumed → the human approval → the filesystem loop → verified attestation → completed) — every duplicate/replay added ZERO new protocol events
[PASS] 7.invocations-and-evidence :: the invocation sequence is exactly the cross-device loop (browser.observe/click/observe on Node A, filesystem.read/write/read on Node B, all succeeded, EXACTLY ONE write); the evidence class multiset matches (intent/claim/observation/verification per capability step + ONE human_confirmation produced by the acting human); every attestation evidenceReference resolves to a real evidence record of THIS run
[PASS] 7.side-effect-safety :: FINAL ACCOUNTING (the main run): exactly ONE run, ONE durable rejection row (the typed replay), ONE write effect per host (the acknowledgment bytes EXACT), and the immutable version byte-identical after the whole experiment

--- RUN 2 — 9. THE FAIL-CLOSED ADMISSION PROBES (the P3b coupling re-proved — machine-checked) ---
[PASS] 9.missing-admission-refused :: P3b (the admission coupling, PROVEN — the missing case): the dependent action is REFUSED on Node B (the typed AGENT_PRECONDITION_REJECTED, ZERO host side effects — the probe acknowledgment file is NOT written, ZERO filesystem invocations, no Node-B attestation) although Node B never verified Node A's handoff attestation and its runtime policy does not even trust Node A's attester key — the OLD gap probe (the PR #152 blocked attempt) proved this drive EXECUTED; the V2-016 runtime contract now makes the dependent side effect IMPOSSIBLE without an admitted verification-derived precondition
[PASS] 9.cross-run-theft-rejected :: P3b (the admission coupling, PROVEN — the substitution case): a GENUINE V2-014-derived verified fact minted for ANOTHER run of the same pinned version, supplied as this run's admission precondition, is REJECTED typed at DRIVE ENTRY (COMPUTER_AGENT_PRECONDITION_REJECTED, thrown before any recorder command of the drive — zero durable mutations, zero host side effects) and the run is left PAUSED, re-drivable with a corrected precondition
[PASS] 9.genuine-re-drive-completed :: P3b (the admission coupling, PROVEN — the re-drive): the corrected, genuinely-verified precondition (Node B's own verification of THIS run's Node-A attestation) is admitted, the dependent action executes EXACTLY ONCE (the probe acknowledgment file REALLY written, one filesystem.write invocation), and the runtime-produced dependent attestation carries the verified predecessor's execution digest in causalParents (the P5 runtime causal chain, proven on the probe run as well)

# RUN 2 summary: all checks PASS

(RUN 1 transcript: identical to RUN 2 above after normalizing run-scoped bookkeeping
 — uuid-shaped ids, the derived dep_/sub_/evt_/dlv_/wfr_/wfre_/… ids, the Ed25519
 key-derived material (attester key ids, attestation ids, execution digests — real
 Ed25519 cannot be seeded), the mkdtemp sandbox suffixes and the run labels. The
 deterministic structured facts — version content/semantic digests, node identities,
 the timeline, the invocation/evidence sequences, every typed outcome — are compared
 byte-for-byte across the two runs.)

determinism (structured facts): IDENTICAL across the two fresh-stack runs
determinism (normalized transcripts): IDENTICAL

GATE VERDICT: PASS — every frozen proof green on the RUNTIME COMPOSITION PATH
  - P3 admission coupling (PROVEN): V2-014 verification → VerifiedExecutionFact → Node-B admission
    → dependent side effect. The section-5 main path consumes the verification-derived
    precondition; the section-9 fail-closed probes prove the dependent action is IMPOSSIBLE
    without it (typed AGENT_PRECONDITION_REJECTED, zero side effects) and that cross-run fact
    theft is rejected typed at drive entry with the run left paused, re-drivable (machine-
    confirmed on both fresh-stack runs; the consumed surface key set is pinned in the gate test).
  - P5 runtime causal chain (PROVEN): the RUNTIME-PRODUCED dependent attestation carries EXACTLY
    Node A's execution digest in causalParents (the durable binding AND the signed envelope),
    and that produced attestation verifies under the causalParents expectation — never a
    hand-built statement for the positive proof (machine-confirmed on both fresh-stack runs).
  (the blocked PR #152 attempt preserved the two gaps as fail-closed unsatisfied dependencies;
   V2-016 — merged as main 11d6afbf — supplied the runtime contract this re-prove consumes.
   V2-015 remains blocked until this gate is merged, exactly as the frozen roadmap requires.)

DOGFOODING RESULT: PASS (every frozen proof on the runtime composition path — the two PR #152 blocking couplings positively re-proven)
normalized-transcript-sha256: d6227d685cd55c932a279946c0d4c94448facc337f88804a58a5fa615810fdf6
```

**35/35 machine checks PASS** (the PR #152 correction round carried 32/32 with a fail-closed verdict; the re-prove adds the precondition-derivation check, splits the causal gap check into the runtime-production positive, and replaces the single gap probe with the three fail-closed admission probes), executed **4 consecutive times** — every execution exit 0, every pair of fresh-stack runs deterministic (structured facts byte-identical, normalized transcripts identical, stable sha above).

## Duration / cost

≈ 8 s wall per full runner execution (BOTH fresh-stack runs: fresh PGlite + all 62 migrations + fresh identity stack + fresh sandbox each). The complete verification battery for this round (gate test ×2, dogfooding ×4, sibling gates, architecture suite, computer-agent suites, full canonical vitest suite in disjoint chunks, typecheck, scoped eslint, static pin measurement) ran in single-session wall time on the development sandbox.

## Findings (the two PR #152 blocking findings, re-proved RESOLVED on the runtime path)

1. **P3b — admission coupling (RESOLVED by V2-016, positively re-proven).** The blocked attempt machine-checked that "Node B's independent V2-014 verification result is not consumed by the dependent action's admission" (the old probe: the dependent side effect executed with zero admission decision). The merged V2-016 surface (`DependentStepPrecondition` carrying the canonical `VerifiedExecutionFact` + `policy.dependentStepIds` + the `preconditions` drive input) closes the gap, and this re-prove demonstrates BOTH directions on the real stack: the main path consumes the verification RESULT as the admission precondition before the dependent step's first side-effecting host invocation, and the fail-closed probes prove the dependent action is IMPOSSIBLE without it (missing → typed `AGENT_PRECONDITION_REJECTED` at the step gate with zero host side effects; cross-run fact theft → typed `COMPUTER_AGENT_PRECONDITION_REJECTED` thrown at drive entry with the run left PAUSED, then re-drivable to completion with the corrected precondition). The untrusted-attester leg proves the admission currency itself cannot be minted without trusting the attester (a failed verification produces NO fact).
2. **P5b — runtime causal chain (RESOLVED by V2-016, positively re-proven).** The blocked attempt machine-checked that "the runtime-produced dependent attestation carries `causalParents: []`" while only a hand-built statement could carry the parent. The merged V2-016 production surface (`StepAttestationMaterial.causalParents`, populated exclusively from the step's admitted preconditions behind the `Omit` type) closes the gap, and this re-prove asserts the positive proof ONLY on the runtime-produced attestation (per the V2-016 work order: "A hand-built ExecutionStatement is insufficient proof of runtime causal production"): the real `resumeAfterHuman` walk's own output — captured from Node B's signing host AND read back from the durable V2-005 binding — carries EXACTLY Node A's execution digest (the same digest the verified fact attests), and that produced attestation verifies under the causalParents expectation through the merged V2-014 verifier. Hand-built statements remain ONLY as the P5a verifier-domain negatives (un-parented / wrong-parented refused typed).

## Evidence references

- Gate test (the full frozen-proof suite incl. the reworked P3b fail-closed battery and the P5 runtime-path assertions + the consumed-surface type pins): `backend/tests/integration/integration-gates/ig-006-cross-device-attestation.integration.test.ts` — **6/6 green, run twice**.
- Dogfooding runner (this transcript's producer; two fresh stacks per execution, deterministic comparison, PASS verdict exit 0): `backend/tests/integration/integration-gates/run-ig-006-dogfooding.ts` — **35/35 checks, 4 consecutive executions**.
- The consumed merged V2-016 surfaces (barrel-only, unmodified): `backend/src/computer-agent/types.ts` (`DependentStepPrecondition`, `policy.dependentStepIds`, the `preconditions` drive input, the `AGENT_PRECONDITION_REJECTED` / `COMPUTER_AGENT_PRECONDITION_REJECTED` codes), `backend/src/computer-agent/internal/preconditions.ts`, `backend/src/computer-agent/internal/runtime.ts` (drive-entry admission + the step admission gate), `backend/src/computer-agent/internal/attesting.ts` (`causalParents` production + the independent-verification binding).
- The blocked historical attempt (preserved, NOT rebased): branch `feat/ig-006-cross-device-attestation` at `109f42b`, PR #152 (BLOCKED / FAIL CLOSED per the architect's disposition).
- Work orders: `spec/architecture/v2/work-orders/IG-006.md`, `spec/architecture/v2/work-orders/V2-016.md` (completion-gate clause 6: "a fresh re-run of IG-006 proves P3 on the runtime admission path and P5 on the runtime attestation-production path" — satisfied by this evidence).

## Classification

**GATE VERDICT: PASS — every frozen proof green on the RUNTIME COMPOSITION PATH.** Deterministic verification (4 consecutive runner executions + the gate test run twice + structured-facts byte-comparison), real-system proofs (real PGlite + all 62 migrations + real routes + two real host kinds with real Ed25519 keys + real `node:fs` side effects + an independent verifier process), persisted dogfooding evidence (this file). The completion gate per the frozen work order additionally requires the architect's review/merge and actual merge evidence — the architect's merge is the completion event; agents never self-merge.

## Limitations recorded honestly (observations, not failures)

- The runtime-produced causal-parent proof is scoped to the merged V2-016 contract shape: ONE declared verified predecessor per dependent step in this experiment (the sorted-set semantics, multi-predecessor declaration, and the exactly-the-declared-set binding rules are covered by V2-016's own regression batteries, not re-proven here).
- The P5a verifier-domain negatives (un-parented, wrong-parented) necessarily use hand-built probe statements — they prove the VERIFIER dimension only; every positive causal proof is runtime-produced (per the V2-016 work order).
- The surfaced node_output dataflow observation from the blocked attempt (the per-drive values map does not survive the pause→resume handoff; a `node_output` binding resolves to null across the handoff) remains TRUE and is still pinned by the dedicated observation test in the gate file — it is a pinned observation for the architect, not a frozen-proof failure, and the frozen proofs never depend on value-level cross-drive dataflow.
- REAL Ed25519 key material cannot be seeded: the key-derived identities (attester key ids, attestation ids, execution digests) are normalized-out run bookkeeping; determinism is proven over the structured facts (booleans/counts/sequences) and the normalized transcripts, exactly as in every prior family round.
- The driver-side verification (Node B's verifier context producing the admission fact) executes in-process in the runner (the same discipline as the gate test); a SEPARATE spawned independent verifier process additionally verifies the raw envelope bytes (section 3) — but the precondition-minting verification itself is not spawned as a separate OS process.
- The 3 failing `WORK-052`/`WORK-069` development-governance tests are the inherited lineage baseline (identical failures on pristine main `11d6afbf`; zero governance files in this diff) — disclosed, never fixed (out of scope).

## Resulting action

The governed IG-006 re-prove is submitted for the architect's review: branch `feat/ig-006-cross-device-attestation-v2` (base exactly `11d6afbf`, PR #152 preserved untouched as the historical blocked attempt). V2-015 remains blocked until this gate is reviewed, merged, and the merge evidence recorded — exactly as the frozen roadmap requires. No self-merge; the architect's merge is the completion event.
