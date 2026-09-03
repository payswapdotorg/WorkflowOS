# V2-016 — Cross-Device Attestation Runtime Preconditions — Dogfooding Evidence

**Work Order:** V2-016 — Cross-Device Attestation Runtime Preconditions
**Classification of capability:** feature implementation (V2-008 runtime composition hooks — the typed dependent-step admission precondition + causal-parent production); not a human UI surface
**Validation type:** real-stack runtime-boundary dogfooding experiment (work-order dogfooding requirement, literal frozen clause: "Node A produces an attestation; the canonical V2-014 verifier independently verifies it; the resulting V2-014-derived verified fact is passed into Node B's dependent execution boundary; Node B consumes that precondition before its first side effect; the dependent Node-B attestation records Node A's execution digest in causalParents; negative precondition cases produce typed rejection with zero side effects; replay/duplicate delivery still converges" — narrowly scoped to the newly added runtime contract, exactly as the work order requires)
**Status:** EVIDENCE PERSISTED — experiment run through the real integrated paths; work order remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

V2-016 — Cross-Device Attestation Runtime Preconditions, W5 corrective prerequisite for IG-006, branch `feat/v2-016-cross-device-runtime-preconditions`, base `35fadf9d0b8f3379921fed843f89479c816af887` (main after the architect's freeze commit). Scope: V2-008-owned runtime hooks ONLY — the typed composition precondition on the public execution/resume surface, fail-closed admission consumption before the first dependent side-effecting host invocation, and declared causal-parent execution digests flowing unchanged into the runtime-produced V2-014 `ExecutionStatement.causalParents`. Every sibling module is consumed through its merged public barrel with ZERO modifications (V2-005 run persistence, V2-014 verification authority, V2-004 placement/capability, V2-003 IR semantics, the authorization boundary — all unchanged). Full cross-device completion is re-proven by IG-006 after this work merges (IG-006 remains BLOCKED / FAIL CLOSED on PR #152 until its re-run).

## Workflow / version under test

ONE safe cross-device test workflow per composed run (authored through the REAL V2-002 repository + the merged V2-003 builder): `collect` (agentic browser submit, `cloud_allowed`, `browser.observe`/`browser.click` — steered to **Node A**, the real web host) → `approve` (human approval pause point) → `acknowledge` (agentic filesystem write, `device_local`, `filesystem.read`/`filesystem.write` — steered to **Node B**, the real desktop host; **the DEPENDENT step** the runtime's `dependentStepIds` policy declares). Four composed runs per experiment instance (A: the happy path; B: the missing-precondition negative; C: the wrong-run-binding negative; D: the duplicate-entries convergence), each on its own fresh sandbox + fresh node directory, all over the SAME real repository authority.

## Surface / host

The REAL stack, one standalone process per experiment instance:

- **Persistence:** real PGlite with ALL 62 migrations (the shared `buildComputerAgentTestStack` composition).
- **Run/evidence authority:** the REAL V2-005 `DefaultWorkflowRunService` as the runtime's recorder (structurally satisfied — no adapter code); the dependent step's typed failure and the still-paused negative state are read back through the REAL `getRunHistory`.
- **Version identity:** the REAL V2-002 repository (authoring + version pinning); the plan compiled from the pinned version through the real V2-003 parser + V2-007 compiler (digest-verified).
- **Node/placement authority:** the REAL V2-004 registration protocol — Node A is a genuinely registered web node, Node B a genuinely registered desktop node; capability sets + placement steer the two steps to the two hosts through the merged matcher.
- **Hosts:** Node A = `WebBrowserHostAdapter` over the scripted browser environment with a REAL Ed25519 attester key; Node B = `DesktopHostAdapter` over `RealFilesystemDesktopEnvironment` — REAL `node:fs` I/O rooted at a real sandbox directory, with a REAL Ed25519 attester key (both hosts wrapped in the attestation-capturing host so the driver-side verifier receives the exact signed envelopes).
- **Verification authority:** the canonical V2-014 verifier (the merged barrel's `verifyAttestation`) under an explicit driver-side policy — trusted attester = Node A's key, a FRESH single-use replay registry, freshness (injected verifier clock, epoch, max-age), and exact run/version/step bindings — producing the `VerifiedExecutionFact` the precondition carries.
- **Runtime:** the merged V2-008 `ComputerAgentRuntime` carrying the V2-016 contract (`dependentStepIds: ['acknowledge']`; `preconditions` supplied on `resumeAfterHuman`).

## Exact task

1. Compose run A (fresh sandbox + two real attesting hosts); `executeRun` drives `collect` on Node A (attested, captured) and pauses at the human step; assert Node B's ack file is ABSENT.
2. Transfer Node A's attestation as the canonical V2-014 envelope bytes (`serializeAttestation` → `parseAttestation`, same identity).
3. Verify it through the CANONICAL V2-014 verifier (driver-side policy) → the `VerifiedExecutionFact` (attests statement authenticity only, never authorization).
4. Exercise the canonical verifier's TYPED negatives — stale (aged verifier clock → `ATTESTATION_EXPIRED`), replayed (single-use nonce registry → `ATTESTATION_REPLAYED`), insufficient assurance (`hardware_backed` floor → `ATTESTATION_ASSURANCE_INSUFFICIENT`) — each producing NO fact.
5. `resumeAfterHuman` the dependent drive supplying the typed composition precondition (the fact + the declared causal parent = the fact's execution digest); assert the run COMPLETES, Node B's ack file is REALLY written (real bytes), the dependent Node-B attestation carries EXACTLY Node A's execution digest in `causalParents`, and the durable record (read back through the real run history) shows the same.
6. Duplicate re-drive of the completed run → typed `COMPUTER_AGENT_RUN_NOT_PAUSED`, Node B's file byte-identical (exactly one write).
7. Run B: resume WITHOUT the precondition → the run FAILS `AGENT_PRECONDITION_REJECTED`, the dependent step reports actions 0, Node B's file NOT written.
8. Run C: a fact minted for run A supplied to run C's drive → typed `COMPUTER_AGENT_PRECONDITION_REJECTED` at drive entry, run C STILL PAUSED (read back through the real run service), file NOT written.
9. Run D: the SAME precondition delivered twice in one drive → converges (one admission, one write, one causal parent).
10. Execute the whole experiment TWICE on fresh stacks; the normalized transcripts must be byte-identical; persist the transcript verbatim below.

## Starting state

Fresh PGlite + fresh node directories + fresh sandboxes per run. Deterministic environment: injected stepping clocks (fixed base, fixed step), fixed key seeds (node ids derive deterministically), fixed fixture content and paths, fresh replay registries per verification leg. No network, no wall-clock dependence in domain logic. Real Ed25519 key material is per-run (key-normalized assertions; key ids/public keys/signatures excluded from the normalized transcript by construction). Run-scoped repository ids (workflow/version/run) differ per run by design of the authority's id factory and are excluded from the normalized transcript by construction; the node ids, execution digests, typed outcomes, and file bytes are identical across runs.

## Expected outcome

- The V2-008 runtime admits the dependent step ONLY through the consumed precondition: the canonical V2-014-verified fact is passed into Node B's dependent execution boundary and consumed BEFORE the first side effect (the missing/invalid/stale/replayed/insufficient cases all prevent the write with zero host invocations).
- The dependent Node-B attestation records EXACTLY Node A's execution digest in `causalParents` (the runtime-produced statement, the durable binding, and the canonical verifier's binding all agree).
- Admission is never authorization: the existing capability/safe-action/placement/attestation gates still apply unchanged after admission.
- Duplicate/re-drive delivery converges (exactly one write; typed terminal rejections).
- Overall: **the two IG-006 blocking composition gaps are closed on the real runtime path — P3's admission coupling (the dependent side effect now genuinely requires the consumed V2-014-derived verified predecessor) and P5's causal coupling (the runtime-produced dependent attestation is now genuinely parented).**

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/V2-016/backend && bunx tsx tests/integration/computer-agent/run-v2-016-dogfooding.ts` — exit code 0, final capture 2026-09-03T02:30:20Z (wall duration 7.4 s for BOTH fresh-stack runs; fourth consecutive all-PASS execution with identical results). Normalized-transcript sha-256 (both instances byte-identical): `69748ebf35c89eeb76f2a0d5fa01f2074d8ab5762c3d9a2f714f4ef52b206fa4`.

```text
run A composed (fresh sandbox, fresh node directory, two real attesting hosts; ids normalized)
  [PASS] 1.drive-1: Node A executed the attested predecessor and the run paused at the human step (Node B untouched) — state=paused pausedAt=approve
  [PASS] 1.side-effects: Node B's ack file is ABSENT before the dependent drive — ack=absent
  [PASS] 3.envelope: the attestation transferred as the V2-014 canonical envelope bytes (serialize → parse, same identity) — 2070 chars
  [PASS] 4.independent-verification: the CANONICAL V2-014 verifier verified Node A's attestation (trusted key, fresh replay registry, freshness, exact bindings) — attests=statement_authenticity
  [PASS] 4.fact-shape: the V2-014-derived fact attests statement authenticity ONLY (never authorization)
  [PASS] 4.negative-stale: an aged envelope is rejected TYPED by the canonical verifier (ATTESTATION_EXPIRED) — ATTESTATION_EXPIRED
  [PASS] 4.negative-replay: the re-presented envelope is a REPLAY (single-use nonce, ATTESTATION_REPLAYED) — ATTESTATION_REPLAYED
  [PASS] 4.negative-assurance: an assurance floor above the envelope's level is a TYPED rejection (no fact) — ATTESTATION_ASSURANCE_INSUFFICIENT
  [PASS] 5.admission: Node B's dependent step was ADMITTED (the V2-014-derived fact consumed before the first side effect) and the run completed — state=completed
  [PASS] 5.side-effect: Node B's ack file is REALLY written (real node:fs bytes, exact content) — 77 chars
  [PASS] 5.dependent-attestation: the dependent step produced its attestation on Node B
  [PASS] 5.causal-parents: the dependent Node-B attestation records EXACTLY Node A's execution digest in causalParents — parents=1 (digest normalized out of the transcript)
  [PASS] 5.gates: the dependent step passed every existing gate (attestation attached = independently verified + boundary-attached) — outcome=completed attached=1
  [PASS] 5.durable-record: the real run history carries the dependent attestation binding with the declared causal parent
  [PASS] 5.run-identity: both attestations bind the SAME run + WorkflowVersion (run/version identity across the two nodes)
  [PASS] 6.duplicate-re-drive: the completed run rejects re-delivery TYPED (RUN_NOT_PAUSED)
  [PASS] 6.exactly-once: the Node-B file is byte-identical after the duplicate re-drive (no second write)
  [PASS] 7.missing-precondition: the dependent step fails closed TYPED with ZERO side effects (run failed, actions 0) — state=failed failure=AGENT_PRECONDITION_REJECTED actions=0
  [PASS] 7.zero-side-effects: run B's Node-B file is NOT written (the admission gate fired before any host invocation)
  [PASS] 8.wrong-run-binding: a fact minted for run A supplied to run C is rejected TYPED at drive entry (cross-run substitution)
  [PASS] 8.zero-durable-mutations: run C is STILL PAUSED (the resume never happened — read back through the real run service) — state=paused
  [PASS] 8.zero-side-effects: run C's Node-B file is NOT written
  [PASS] 9.run-d-verification: run D's predecessor canonically verified
  [PASS] 9.duplicate-entries: delivering the SAME precondition twice converges (one admission, one write, one causal parent) — state=completed parents=1
--- experiment instance complete ---
--- determinism proof ---
  [PASS] 10.determinism: the two fresh-stack experiment transcripts are byte-identical — lengths 3211/3211
```

(The `2.node-a` guard is a fail-only fixture check — it emits a FAIL line and aborts the instance when the predecessor attestation is absent or mis-scoped; on the passing path its evidence is the `3.envelope`/`4.*` chain over the captured envelope. The second instance's transcript is byte-identical by the `10.determinism` check.)

**Result: 49/49 machine-checkable checks PASS (24 per instance × 2 instances + the determinism comparison); exit code 0.**

## Work-order completion-gate mapping

- **"consume a canonical V2-014-derived verified predecessor before the first dependent side effect"** — checks `1.side-effects`, `5.admission`, `5.side-effect`, `7.*`, `8.*` (the happy path consumes; every negative prevents the write with zero host invocations; the unit battery additionally proves the entry validation precedes `startRun`/`resumeRun` and the admission gate precedes host routing).
- **"propagate declared predecessor execution digests into the runtime-produced causalParents"** — checks `5.causal-parents`, `5.durable-record`, `5.run-identity` + the unit causal battery (sorted-set determinism, exactly-the-declared-set verification binding, zero-parent compatibility, no-silent-fallback machine check).
- **"preserve V2-005 persistence, existing authorization/capability boundaries, and V2-014 verification authority"** — checks `5.gates`, `5.durable-record`, `8.zero-durable-mutations` + the boundary battery (recorder port pinned to the exact 12-command Pick; safe-action shapes pinned; the admission module proven pure-structure with type-only sibling imports; no proof-graph import; no crypto).
- **"negative precondition cases produce typed rejection with zero side effects"** — checks `7.*`, `8.*`, `4.negative-*`.
- **"replay/duplicate delivery still converges"** — checks `6.*`, `9.*`.

## Honest limitations

1. **Node A's browser environment is the scripted page** (the merged V2-008 battery's canonical scripted browser environment); Node B is REAL `node:fs` I/O. The cross-device *placement* is real (two genuinely registered V2-004 nodes, merged-matcher steering), but Node A's host environment is deterministic-scripted — the same honest disclosure the V2-008 integration battery carries. Full cross-device completion (with both hosts over real surfaces and the independent verifier process) is IG-006's re-run, not this work order's scope.
2. **The driver-side canonical verification runs in the same process as the runtime** (the independent verifier PROCESS pattern — raw envelope bytes + an out-of-band verifier context — is IG-006's re-run shape). The seam is honest: the verifier consumes only the transferred canonical envelope bytes and its own out-of-band policy; the runtime's replay-registry consumption never leaks into the driver's registry.
3. **The precondition's structural binding is compile-time-typed, not cryptographic**: a `VerifiedExecutionFact` is only constructible through the canonical verifier in the composed discipline, but TypeScript structural fabrication remains possible for a hostile in-process caller (out of this work order's threat scope — the proof-graph authority V2-015 owns deeper chain semantics; the type is deliberately impossible to confuse with raw/unverified attestation bytes, exactly as the work order requires).
4. **Admission is drive-scoped**: the precondition binds run/version identity (cross-drive validity) but is consumed on the drive that reaches the dependent step — the IG-006 re-run's driver supplies it on the resume drive, exactly as the dogfooding does. A precondition validated on an earlier drive does not silently carry into a later one (fail-closed, re-supplied per drive).
5. **In-process stack composition** (PGlite + the real services, one process per experiment instance; no external Postgres/Redis) — the established V2-005/V2-008 integration-battery discipline; production deployment divergence is disclosed by that precedent.
6. **Determinism normalization**: repository ids, key material, signatures, sandbox paths, and wall time are excluded from the normalized transcript by construction (the raw transcripts differ exactly in those run-scoped values); everything else — node ids (fixed key seeds), typed outcomes, check labels, byte lengths, file contents — is identical across the two fresh-stack instances.
