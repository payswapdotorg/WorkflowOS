# V2-014 Execution Attestation — Dogfooding Evidence (Attestation Export + Independent Verification + Replay/Stale/Tamper Rejection)

**Work Order:** V2-014 — Execution Attestation Protocol
**Classification of capability:** execution-facing protocol capability (cryptographic attestation primitive; not a human UI surface)
**Validation type:** real-protocol attestation production → canonical export → independent out-of-band verification → negative experiments (replay/stale/tamper), per the work-order dogfooding requirement: "Export the attestation and independently verify it outside the issuing code path. Then perform a negative experiment using a replayed/stale or modified attestation and record the rejection."
**Status:** EVIDENCE PERSISTED — experiment run through the real protocol path; Work Order remains implemented/pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

V2-014 — Execution Attestation Protocol, wave W2A, branch `feat/v2-014-execution-attestation`, base `9d2504592badded04cb531c73791bf3e7313ce92`.

## Workflow / version under test

A REAL workflow authored with the merged V2-003 builder (`createWorkflowIrBuilder`): the support-ticket-triage workflow (6 nodes — `fetch_issue`, `draft_summary`, `review_gate`, `notify_channel`, `sync_backlog`, `log_rejection` — 5 control edges, secret-referenced credentials, subworkflow dependency, placement constraints). Its real WorkflowVersion semantic digest is **`571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37`** (domain `workflowos/workflow-ir/v1`) — byte-identical to the merged V2-003 dogfooding evidence digest of the same workflow, asserted at run time (reference-data continuity, not re-derivation).

The immutable WorkflowVersion identity is derived through the merged V2-002 deterministic derivations over the serialized document's real content digest:

| Binding | Value |
|---|---|
| Workflow (V2-002 `deriveWorkflowId`) | `wfw_2169a0a9c7a67a411b099c204397168f` |
| WorkflowVersion (V2-002 `deriveWorkflowVersionId`) | `wfwv_96a446f9b5629b3e950e0bd7810efccd` |
| WorkflowVersion semantic digest (V2-003, reference data) | `571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37` |
| Deployment | `wfd-triage-deployment-1` |
| Run / attempt / step | `wfr-triage-20260901-0001` / `1` / `notify_channel` |
| Node (V2-004 `deriveNodeKeyFingerprint` over the V2-004 dogfooding browser-host key seed) | `node_795e8b12eaef3e45` (the merged V2-004 dogfooding device host, reproduced) |
| Workload identity | `wl_triage-runner-2026-09` |
| Causal parent (real ExecutionDigest of the `review_gate` approval statement) | `2cb51212d69e1ab3213aaf14bcab9eb59a310b36e975be6c04804ae31046ec69` |

## Surface / host

- **Issuer (attester):** the runner process `backend/tests/integration/execution-attestation/run-attestation-dogfooding.ts`, executing the REAL V2-014 public API (`signExecutionAttestation` with a REAL Ed25519 key pair from `generateAttesterKeyPair()` — `generateKeyPairSync('ed25519')` / `sign` / `verify` via `node:crypto`, never mocked) on the single dogfooding host. The attested workload is a REAL deterministic local action: the runner writes real artifact files (`draft-summary.txt`, `approval-record.json`, `notify-payload.txt`) and executes the action for real — reads the artifact bytes back from disk and computes their real SHA-256 through `executionValueCommitment` (the commitments in the statement are one-way hashes of real file bytes; the observation commitment hashes a real `fs.stat` observation).
- **Independent verifier (out of the issuing code path):** a SEPARATE process, `backend/tests/integration/execution-attestation/verify-attestation-dogfooding.ts`, spawned by the runner. It imports ONLY the public verify API of `src/execution-attestation` (plus node builtins) and the RAW exported canonical attestation bytes — no issuer state, no private key, no statement fixture, no sibling-module imports. Its out-of-band context (the execution it expects, and the attester key id trusted out-of-band — key distribution is outside V2-014's authority) is read from `verifier-context.json`, modeling real out-of-band key distribution.
- **Clocks:** fully injected fixed UTC constants (statement `executedAt` 2026-09-01T12:00:00.000Z, `validUntil` 12:05:00.000Z, `issuedAt` 12:00:01.000Z, verifier `now` 12:00:30.000Z, epoch 7); wall clock appears ONLY in the harness's run-instance bookkeeping lines (start/duration), never in protocol state.

## Exact task

1. Author the real support-ticket-triage workflow with the merged V2-003 builder; compute its real semantic digest (pinned to the merged V2-003 dogfooding evidence digest).
2. Derive the real V2-002 workflow/version identities and the real V2-004 node identity (the V2-004 dogfooding device host).
3. Execute the real deterministic local workload (artifact write + real read-back + real SHA-256) and build the `review_gate` causal-parent statement and the `notify_channel` ExecutionStatement with the exact WorkflowVersion/Run/attempt/step/node/parent bindings, injected freshness material (nonce + epoch), and one-way commitments for all values.
4. Sign with a REAL Ed25519 key pair; emit the `execution.attestation.issued` protocol event; EXPORT the canonical bytes (`serializeAttestation`) to disk.
5. Verify INDEPENDENTLY in a separate process (public verify API + raw bytes only): fresh verification must produce a `VerifiedExecutionFact`.
6. Negative experiments, all with a cryptographically VALID signature: (A) re-presentation after the verifier clock/epoch advanced → typed stale/expired rejection; (A') re-presentation of the same bytes after single-use nonce consumption (same clock, same epoch) → typed replay rejection; (B) one tampered canonical action byte → typed signature rejection; (B') a mutated Run binding in the re-serialized envelope → typed signature rejection.
7. Determinism: re-run the whole experiment with a SECOND real Ed25519 key pair — canonical statement, ExecutionDigest, and all verification outcomes must be identical (key-material normalized); re-run the runner as a fresh invocation and compare transcripts.

## Starting state

Fresh process, fresh in-memory replay registry/ledger per verification policy; fresh Ed25519 key material per run (Ed25519 cannot be seeded — disclosed below); real artifacts written to a fresh run temp directory per run. No ambient clock, no network, no shared state between issuer and verifier processes other than the exported canonical bytes and the out-of-band context file.

## Expected outcome

- The exported canonical attestation bytes verify independently (exit 0) into a fact that attests ONLY statement authenticity (`attests=statement_authenticity`; `neverAsserts` includes authorization, capability possession, correct behavior, observed effect, sufficient evidence).
- Every negative experiment produces its TYPED failure code: `ATTESTATION_EPOCH_STALE`, `ATTESTATION_EXPIRED`, `ATTESTATION_REPLAYED`, `ATTESTATION_SIGNATURE_INVALID` (×2).
- The statement/digest/canonical forms and every verification outcome are deterministic across key material and across invocations.

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/V2-014/backend && bunx tsx tests/integration/execution-attestation/run-attestation-dogfooding.ts` — **exit code 0** (2026-09-01T23:30Z, wall duration 1124 ms in the evidence run; wall-clock lines are run-instance bookkeeping, not protocol state — all protocol clocks are injected constants). The experiment runs TWICE per invocation (run-1 primary, run-2 with a second real Ed25519 key pair) and was executed as two independent invocations plus the evidence run (three total; all exit 0, transcripts identical modulo the normalized lines listed under Determinism).

```text
V2-014 execution attestation dogfooding run
work order: V2-014 (execution attestation protocol)
attested module: backend/src/execution-attestation (public barrel + node:crypto Ed25519)
wall clock start (ms): 1788305827958
  [ok]   run-1: the composed statement validates against the schema — 26 fields, exact key set
  [ok]   run-1: canonical statement serialization is deterministic — 1381 chars
  [ok]   run-1: the issued protocol event uses the canonical registry event name — execution.attestation.issued (event id wfeaev_0207d53cfa289bae5f7c510297f6e525)
  [ok]   run-1: the exported bytes carry the payload COMMITMENT, never the payload text — commitment 1e3f1a7c9e556111… present; raw payload/secret-ref absent
  [ok]   run-1: independent verifier process exited 0 — exit=0; transcript follows

independent verifier transcript — run-1 (imports only the public verify API + the exported raw bytes):
    independent verifier — run-1
      raw bytes source: /tmp/v2-014-dogfood-jTzhuO/attestation.json (2070 chars)
      trusted attester key (out-of-band): wfeak_c61d4e4db0508e64007559d63140242b
      expected execution: workflow wfw_2169a0a9c7a67a411b099c204397168f, version wfwv_96a446f9b5629b3e950e0bd7810efccd
                        run wfr-triage-20260901-0001, attempt 1, step notify_channel, node node_795e8b12eaef3e45
    checks:
      [ok]   V1a parse exported canonical bytes — parsed envelope wfea_526fdda4a25968585b6fb418900fd20b
      [ok]   V1b fresh verification through the public verify API — VerifiedExecutionFact wfea_526fdda4a25968585b6fb418900fd20b (digest 4b88c526c39eec7a…)
      [ok]   V1c the verified fact attests ONLY statement authenticity — attests=statement_authenticity; neverAsserts=authorization,capability_possession,correct_behavior,observed_effect,sufficient_evidence
      [ok]   V1d the fact carries the domain-separated ExecutionDigest — domain=workflowos/execution-statement/v1, algorithm=sha-256
      [ok]   V1e the fact binds the exact expected WorkflowVersion/Run/attempt/step/node — version=wfwv_96a446f9b5629b3e950e0bd7810efccd, run=wfr-triage-20260901-0001, attempt=1, step=notify_channel, node=node_795e8b12eaef3e45
      [ok]   V2 re-presentation after the verifier epoch advanced — typed rejection code=ATTESTATION_EPOCH_STALE (expected ATTESTATION_EPOCH_STALE); detail: the statement epoch 7 is older than the verifier epoch 8
      [ok]   V3 re-presentation after the verifier clock advanced past validity — typed rejection code=ATTESTATION_EXPIRED (expected ATTESTATION_EXPIRED); detail: the attestation validity interval expired at 2026-09-01T12:05:00.000Z (verified at 2026-09-01T12:06:00.000Z)
      [ok]   V4 re-presentation of the same bytes after nonce consumption (same clock, same epoch) — typed rejection code=ATTESTATION_REPLAYED (expected ATTESTATION_REPLAYED); detail: the single-use nonce for (run wfr-triage-20260901-0001, attempt 1) was already consumed — a re-presented attestation is a replay even with fresh timestamps and a valid signature
      [ok]   V5 tampered action byte still parses, but verification — typed rejection code=ATTESTATION_SIGNATURE_INVALID (expected ATTESTATION_SIGNATURE_INVALID); detail: the Ed25519 signature does not verify over the canonical unsigned-envelope preimage under the embedded attester public key
      [ok]   V6 mutated Run binding (re-signed envelope required — attacker has no key) — typed rejection code=ATTESTATION_SIGNATURE_INVALID (expected ATTESTATION_SIGNATURE_INVALID); detail: the Ed25519 signature does not verify over the canonical unsigned-envelope preimage under the embedded attester public key
      RESULT: independent verification + all negative experiments behaved as specified

run-1 — real binding reference data + attestation:
  workflow (V2-002 derivation)           wfw_2169a0a9c7a67a411b099c204397168f
  WorkflowVersion (V2-002 derivation)    wfwv_96a446f9b5629b3e950e0bd7810efccd
  WorkflowVersion semantic digest (V2-003, real) 571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37
  node (V2-004 fingerprint derivation)   node_795e8b12eaef3e45
  run / attempt / step                   wfr-triage-20260901-0001 / 1 / notify_channel
  workload identity                      wl_triage-runner-2026-09
  causal parent ExecutionDigest          2cb51212d69e1ab3213aaf14bcab9eb59a310b36e975be6c04804ae31046ec69
  input commitment (serialized WorkflowIR) 08886bd9c09cc13d1aa2f968f2974212b7af01a0e6f87778621e11089da16c94
  output commitment (real artifact sha-256) 1e3f1a7c9e556111c848183233b2aca96815b83182cc8e667970a7e2b8f4c624
  observation commitment (real fs observation) 8366da571c4a03c178008b4ad7820062cfdb207d0330a074022be754e74c50fc
  attestation identity                   wfea_526fdda4a25968585b6fb418900fd20b
  attester key identity (real Ed25519)   wfeak_c61d4e4db0508e64007559d63140242b
  ExecutionDigest (domain-separated)     4b88c526c39eec7a03352336a69a831f7bff049add13e1c4b4a32a641e376231
  issued event                           execution.attestation.issued wfeaev_0207d53cfa289bae5f7c510297f6e525 (deterministic over the attestation identity)
  exported canonical bytes               2070 chars (run temp dir attestation.json)
  [ok]   run-2: the composed statement validates against the schema — 26 fields, exact key set
  [ok]   run-2: canonical statement serialization is deterministic — 1381 chars
  [ok]   run-2: the issued protocol event uses the canonical registry event name — execution.attestation.issued (event id wfeaev_7a6d68528cef47bb257488aca0975b07)
  [ok]   run-2: the exported bytes carry the payload COMMITMENT, never the payload text — commitment 1e3f1a7c9e556111… present; raw payload/secret-ref absent
  [ok]   run-2: independent verifier process exited 0 — exit=0; transcript follows

independent verifier transcript — run-2 (imports only the public verify API + the exported raw bytes):
    independent verifier — run-2
      raw bytes source: /tmp/v2-014-dogfood-tMXtzP/attestation.json (2070 chars)
      trusted attester key (out-of-band): wfeak_f5b7a6453f52d9c270ef6ccb4ec1c568
      expected execution: workflow wfw_2169a0a9c7a67a411b099c204397168f, version wfwv_96a446f9b5629b3e950e0bd7810efccd
                        run wfr-triage-20260901-0001, attempt 1, step notify_channel, node node_795e8b12eaef3e45
    checks:
      [ok]   V1a parse exported canonical bytes — parsed envelope wfea_1da72ab8b6dc13983d2babba74a93c15
      [ok]   V1b fresh verification through the public verify API — VerifiedExecutionFact wfea_1da72ab8b6dc13983d2babba74a93c15 (digest 4b88c526c39eec7a…)
      [ok]   V1c the verified fact attests ONLY statement authenticity — attests=statement_authenticity; neverAsserts=authorization,capability_possession,correct_behavior,observed_effect,sufficient_evidence
      [ok]   V1d the fact carries the domain-separated ExecutionDigest — domain=workflowos/execution-statement/v1, algorithm=sha-256
      [ok]   V1e the fact binds the exact expected WorkflowVersion/Run/attempt/step/node — version=wfwv_96a446f9b5629b3e950e0bd7810efccd, run=wfr-triage-20260901-0001, attempt=1, step=notify_channel, node=node_795e8b12eaef3e45
      [ok]   V2 re-presentation after the verifier epoch advanced — typed rejection code=ATTESTATION_EPOCH_STALE (expected ATTESTATION_EPOCH_STALE); detail: the statement epoch 7 is older than the verifier epoch 8
      [ok]   V3 re-presentation after the verifier clock advanced past validity — typed rejection code=ATTESTATION_EXPIRED (expected ATTESTATION_EXPIRED); detail: the attestation validity interval expired at 2026-09-01T12:05:00.000Z (verified at 2026-09-01T12:06:00.000Z)
      [ok]   V4 re-presentation of the same bytes after nonce consumption (same clock, same epoch) — typed rejection code=ATTESTATION_REPLAYED (expected ATTESTATION_REPLAYED); detail: the single-use nonce for (run wfr-triage-20260901-0001, attempt 1) was already consumed — a re-presented attestation is a replay even with fresh timestamps and a valid signature
      [ok]   V5 tampered action byte still parses, but verification — typed rejection code=ATTESTATION_SIGNATURE_INVALID (expected ATTESTATION_SIGNATURE_INVALID); detail: the Ed25519 signature does not verify over the canonical unsigned-envelope preimage under the embedded attester public key
      [ok]   V6 mutated Run binding (re-signed envelope required — attacker has no key) — typed rejection code=ATTESTATION_SIGNATURE_INVALID (expected ATTESTATION_SIGNATURE_INVALID); detail: the Ed25519 signature does not verify over the canonical unsigned-envelope preimage under the embedded attester public key
      RESULT: independent verification + all negative experiments behaved as specified

run-2 — determinism with a SECOND real Ed25519 key pair (key-normalized):
  [ok]   run-2: same WorkflowVersion semantic digest — 571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37
  [ok]   run-2: same V2-002 workflow + version identities — wfw_2169a0a9c7a67a411b099c204397168f / wfwv_96a446f9b5629b3e950e0bd7810efccd
  [ok]   run-2: same node identity — node_795e8b12eaef3e45
  [ok]   run-2: same causal parent ExecutionDigest — 2cb51212d69e1ab3213aaf14bcab9eb59a310b36e975be6c04804ae31046ec69
  [ok]   run-2: same real artifact commitments — input/output/observation commitments identical
  [ok]   run-2: canonical statement JSON byte-identical — 1381 chars
  [ok]   run-2: SAME ExecutionDigest (digest is key-independent) — 4b88c526c39eec7a03352336a69a831f7bff049add13e1c4b4a32a641e376231
  [ok]   run-2: DIFFERENT attester key identity (fresh key material, disclosed) — wfeak_c61d4e4db0508e64007559d63140242b → wfeak_f5b7a6453f52d9c270ef6ccb4ec1c568
  [ok]   run-2: DIFFERENT attestation identity (identity binds the key dimension) — wfea_526fdda4a25968585b6fb418900fd20b → wfea_1da72ab8b6dc13983d2babba74a93c15
  [ok]   run-2: independent verifier also exited 0 for the second key — exit=0

reference-data continuity with merged W1 dogfooding evidence:
  [ok]   the authored workflow is the merged V2-003 dogfooding workflow (semantic digest pinned) — 571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37 (V2-003 evidence: 571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37)
  [ok]   the attesting node is the merged V2-004 dogfooding device host — node_795e8b12eaef3e45

expected statement (canonical JSON, run-1):
{"action":"Post the approved triage summary to the team notifications channel","attemptId":1,"authorizationContextDigest":"b71caa49334c16368671601755afa2aab81907e5e574d3eb7fc365da0abd5b16","capability":"messaging.send","causalParents":["2cb51212d69e1ab3213aaf14bcab9eb59a310b36e975be6c04804ae31046ec69"],"deploymentId":"wfd-triage-deployment-1","epoch":7,"evidenceReferences":["wfev-message-delivery-0001"],"executedAt":"2026-09-01T12:00:00.000Z","executionClass":"deterministic_api","inputCommitments":["08886bd9c09cc13d1aa2f968f2974212b7af01a0e6f87778621e11089da16c94"],"nodeId":"node_795e8b12eaef3e45","nonce":"challenge-triage-run-0001-attempt-1","objectType":"workflowos/execution-statement/v1","observationCommitments":["8366da571c4a03c178008b4ad7820062cfdb207d0330a074022be754e74c50fc"],"outcome":"succeeded","outputCommitments":["1e3f1a7c9e556111c848183233b2aca96815b83182cc8e667970a7e2b8f4c624"],"placementPolicyDigest":"d4f6917b6574199033aa1bdf6df8e7753c2882c996cf0eb49da517d2bc8fc2d0","runId":"wfr-triage-20260901-0001","statementSchemaVersion":1,"stepId":"notify_channel","validUntil":"2026-09-01T12:05:00.000Z","workflowId":"wfw_2169a0a9c7a67a411b099c204397168f","workflowVersionId":"wfwv_96a446f9b5629b3e950e0bd7810efccd","workflowVersionSemanticDigest":"571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37","workloadIdentity":"wl_triage-runner-2026-09"}

wall duration (ms): 1124
RESULT: attestation produced through the real protocol path, independently verified, all negative experiments rejected with typed failures, determinism key-normalized
```

(The transcript above is verbatim from the evidence run: run-2 executes the same experiment with a second real Ed25519 key pair in its own temp directory with its own out-of-band context file (`verifier-context-2.json`, trusted attester `wfeak_f5b7a6453f52d9c270ef6ccb4ec1c568`), and its independent verifier process exited 0 with the identical typed outcomes.)

### The observed attestation (exported canonical bytes, run-1)

The exact 2070-char canonical envelope exported by `serializeAttestation` (key-derived material — public key, key id, attestation id, signature — is per-run and disclosed as such):

```json
{"assurance":"software_signed","attestationId":"wfea_526fdda4a25968585b6fb418900fd20b","attesterKeyId":"wfeak_c61d4e4db0508e64007559d63140242b","attesterPublicKey":"302a300506032b6570032100bf09a6a1e17dd874b5889b31ddbefdc5bc363181a0b71ec340c16b2b07263829","envelopeSchemaVersion":1,"executionDigest":{"algorithm":"sha-256","digest":"4b88c526c39eec7a03352336a69a831f7bff049add13e1c4b4a32a641e376231","domain":"workflowos/execution-statement/v1"},"issuedAt":"2026-09-01T12:00:01.000Z","objectType":"workflowos/execution-attestation/v1","signature":"6d47f609eb4879e7db734c1f32c3182da7b7b20ef07c04545e0030253ad5f3b80581b386365487e6226ee210f1cb5e43ac56b56ee972b34e1a51a93461fe4d0d","statement":{"action":"Post the approved triage summary to the team notifications channel","attemptId":1,"authorizationContextDigest":"b71caa49334c16368671601755afa2aab81907e5e574d3eb7fc365da0abd5b16","capability":"messaging.send","causalParents":["2cb51212d69e1ab3213aaf14bcab9eb59a310b36e975be6c04804ae31046ec69"],"deploymentId":"wfd-triage-deployment-1","epoch":7,"evidenceReferences":["wfev-message-delivery-0001"],"executedAt":"2026-09-01T12:00:00.000Z","executionClass":"deterministic_api","inputCommitments":["08886bd9c09cc13d1aa2f968f2974212b7af01a0e6f87778621e11089da16c94"],"nodeId":"node_795e8b12eaef3e45","nonce":"challenge-triage-run-0001-attempt-1","objectType":"workflowos/execution-statement/v1","observationCommitments":["8366da571c4a03c178008b4ad7820062cfdb207d0330a074022be754e74c50fc"],"outcome":"succeeded","outputCommitments":["1e3f1a7c9e556111c848183233b2aca96815b83182cc8e667970a7e2b8f4c624"],"placementPolicyDigest":"d4f6917b6574199033aa1bdf6df8e7753c2882c996cf0eb49da517d2bc8fc2d0","runId":"wfr-triage-20260901-0001","statementSchemaVersion":1,"stepId":"notify_channel","validUntil":"2026-09-01T12:05:00.000Z","workflowId":"wfw_2169a0a9c7a67a411b099c204397168f","workflowVersionId":"wfwv_96a446f9b5629b3e950e0bd7810efccd","workflowVersionSemanticDigest":"571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37","workloadIdentity":"wl_triage-runner-2026-09"}}
```

Verification result summary (all from the independent verifier process):
- Fresh verification → `ok: true`; the fact attests `statement_authenticity` only and explicitly never asserts authorization / capability possession / correct behavior / observed effect / sufficient evidence (registry authorityRules discipline held on the real path).
- `ATTESTATION_EPOCH_STALE` — re-presentation after the verifier epoch advanced 7→8 (valid signature, correct bindings).
- `ATTESTATION_EXPIRED` — re-presentation at verifier clock 12:06:00.000Z (past `validUntil` 12:05:00.000Z).
- `ATTESTATION_REPLAYED` — re-presentation of the SAME bytes with the SAME clock and epoch after the first successful verification consumed the single-use nonce (timestamps alone demonstrably insufficient).
- `ATTESTATION_SIGNATURE_INVALID` — one flipped canonical byte of the action field (parse still succeeds; the real Ed25519 verification fails).
- `ATTESTATION_SIGNATURE_INVALID` — the Run binding mutated to `wfr-attacker-rebound-9999` in the re-serialized envelope (the signature covers the exact binding; the attacker holds no key).

## Determinism

- **Across key material (in-invocation run-1 vs run-2):** WorkflowVersion semantic digest, V2-002 identities, node identity, causal-parent ExecutionDigest, all artifact commitments, the canonical statement JSON (1381 chars), and the ExecutionDigest `4b88c526c39eec7a03352336a69a831f7bff049add13e1c4b4a32a641e376231` are byte-identical; only key-derived material differs (attester key id, attestation id, event id, signature/public key — Ed25519 key material cannot be seeded, disclosed honestly).
- **Across invocations:** two independent runner invocations plus the evidence run produced byte-identical transcripts after normalizing exactly: the two wall-clock bookkeeping lines (start/duration), the run temp-directory paths, and the key-derived identity material (`wfeak_*` attester key ids, `wfea_*` attestation ids, `wfeaev_*` event ids). The canonical statement, ExecutionDigest, all typed verification outcomes, and the causal-parent digest were identical with no normalization needed.
- The dogfooding module source itself contains no wall-clock/randomness/network dependence (pinned by the module-boundary test over `src/execution-attestation/**`).

## Evidence references

- Red battery (inherited, committed failing): `47c031da122587fdc61a54ca3eeec0696bd386a4` — test(execution-attestation): deterministic red battery for V2-014.
- Aligned red battery (still red without the module — proven by temporarily removing `src/execution-attestation/` and re-running the battery: 16/16 files fail on import): `5a430aa` — test(execution-attestation): align red battery with the module surface.
- Implementation (green: scoped battery 186/186 across 16 files): `6c94db0` — feat(execution-attestation): implement V2-014 execution attestation protocol.
- Runner (issuer + orchestrator): `backend/tests/integration/execution-attestation/run-attestation-dogfooding.ts`.
- Independent verifier: `backend/tests/integration/execution-attestation/verify-attestation-dogfooding.ts`.
- Scoped deterministic battery: `backend/tests/unit/execution-attestation/**` + `backend/tests/integration/execution-attestation/attestation-composition.integration.test.ts` (186 tests, incl. 14 mutation/discrimination evidence pairs).
- Registry: `spec/architecture/v2/V2-CTRL-003-protocol-registry.md` / `.json` (frozen; vocabulary snapshot no-drift pinned by the battery).

## Duration / cost

Evidence run wall duration 1124 ms (single process + two spawned verifier processes; real Ed25519 key generation, real signing, real verification). Two additional invocations for cross-invocation determinism (~0.5–1.1 s each).

## Failure classification

**PASS** — the attestation was produced through the real protocol path (real builder-authored workflow, real merged-sibling reference identities, real local deterministic workload, real Ed25519 signing), exported canonically, and independently verified OUTSIDE the issuing code path by a separate process importing only the public verify API + the raw bytes; every negative experiment (stale epoch, expired validity, replayed nonce, tampered byte, mutated binding) produced its expected TYPED rejection; determinism held key-normalized and invocation-normalized.

## Resulting action

None required — no protocol defects found at the feature boundary. V2-014 remains implemented/pending-architect-merge; the module is ready for the architect's review. No evidence artifact became architecture.

## Honest limitations (recorded, not silently dropped)

1. **Durable WorkflowRun persistence is unmerged (V2-005):** the run/attempt identity (`wfr-triage-20260901-0001` / `1`) is a real protocol binding with exact semantics, but no durable WorkflowRun record backs it yet — V2-005 deliberately waits for this contract to merge. The attested workload is a REAL deterministic local action (real artifact files, real SHA-256 over real bytes), not yet a WorkflowOS-scheduled execution.
2. **Single-host self-attestation:** issuer and verifier run on the same host as separate processes. True cross-device/cross-attester composition (proof graphs, handoff) is V2-015's scope (IG-006); this experiment proves the single-device contract boundary.
3. **The operator is the implementing agent:** the "human approval" causal parent and the workload execution are performed by the dogfooding harness operator through the real public API (no independently recruited human; no production destructive action — isolated temp resources only, per the dogfooding safety rule).
4. **Ed25519 key material cannot be seeded:** per-run key ids, attestation ids, event ids, signatures, and public keys necessarily differ between runs. Determinism is proven for everything else (canonical forms, digests, verification outcomes) with key material explicitly normalized; the disclosure is recorded rather than hidden.
5. **Out-of-band key distribution is modeled, not built:** the verifier trusts the attester key id from a context file written alongside the run (`verifier-context.json`) — real key-distribution/trust-anchor infrastructure is a later Work Order's concern; V2-014 owns only the verification contract given a trusted key.
6. **The replay registry in the experiment is the in-memory reference implementation:** durable, run-scoped replay state belongs to the run/evidence authority (V2-005), which will persist attestation references against this contract.
