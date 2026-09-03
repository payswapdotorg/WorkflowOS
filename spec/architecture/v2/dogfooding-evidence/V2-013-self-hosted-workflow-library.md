# V2-013 — Self-Hosted Workflow Library: dogfooding evidence

**Runner:** `backend/tests/integration/self-hosted-library/run-v2-013-dogfooding.ts` (executed from `backend/` with `bunx tsx`)
**Date:** 2026-09-03 (the frozen V2-013 dogfooding clause execution)
**Base:** `d97a92f8ba243a47e2ac173d0b189dd79814aeca` (canonical main after the V2-015 merge)

## The executed clause

> Use WorkflowOS itself to install and execute at least one development workflow end-to-end, with the repository recording the resulting evidence and any corrective observations. Where an execution predicate is required, the dogfood must verify that the predicate is satisfied by a valid, fresh, authorized execution attestation rather than by an assertion or replay.

The dogfooding procedure was chosen as the executed workflow (the most self-referential first-party artifact: the procedure that installs and executes first-party workflows, installed and executed through itself).

## Machine-checkable results (both fresh-stack runs)

[PASS] governance-model-valid: the canonical governance-model.json loads and validates clean (the fail-closed governance state)

## run-1 — 1. INSTALL (the self-hosting installation)

[PASS] install-six-kinds: all six first-party workflows installed through the REAL authority (the dogfooding manifest pins wfw_d4cbe9e2a67c6ee18ec9b7668e024eed@wfwv_e996d8322fe7eb2e8ac9c5d135df3d27)

## run-1 — 2. EXECUTE (the real run through the real V2-005 command surface)

[PASS] run-pinned-to-manifest: the REAL run pins the manifest exact (workflow, version, installation) — and the run carries the SAME semantic digest as the manifest
[PASS] predecessor-attached-through-boundary: the predecessor attestation (a REAL Ed25519 envelope bound to the real run) is durably ATTACHED through the REAL V2-005 boundary (the run-derived binding policy verified it — execution digest 042bd58580ba…)

## run-1 — 3. THE PROOF PREDICATE (independent verification → V2-013 packaging)

[PASS] independent-verifier-ok: the INDEPENDENT verifier process (imports ONLY the V2-014 public barrel) verifies the REAL envelope: the fact attests statement_authenticity ONLY and never asserts authorization/capability/correctness/observed-effect/sufficiency
[PASS] proof-predicate-satisfied-packaged: the proof predicate for execute_workflow is SATISFIED by the valid, fresh, authorized attestation — the V2-013 packaging mints the execution package (admitted parents: 1, trusted attesters: 1)
[PASS] run-completed: the development workflow executed END-TO-END through the REAL run authority (install → execute → record evidence → complete)

## run-1 — 4. REPLAY REJECTION (never an assertion or replay)

[PASS] replay-refused-no-package: the REPLAYED predecessor (the same single-use nonce re-presented after consumption) is refused TYPED (ATTESTATION_REPLAYED) and the V2-013 packaging over the refused verification mints NOTHING (SELF_HOSTING_PROOF_PREDICATE_REJECTED)
[PASS] run-boundary-duplicate-refused: the run boundary refuses the DUPLICATE attach (durable single-use nonce — RUN_ATTESTATION_REJECTED): no duplicate side effects at the integration boundary
[PASS] unrelated-step-attestation-refused: a VALID, fresh, authorized attestation for a NON-predecessor step (record_evidence) is REFUSED TYPED by the predecessor binding to the authoritative WorkflowIR edges (SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED) — the exact PR #160 Blocker-1 attack shape, closed fail-closed

## run-1 — 5. EVIDENCE (the reconstruction converges with the manifest)

[PASS] evidence-reconstruction-converges: the evidence reconstruction over the REAL run history converges with the manifest (pin matches; the completed run attributed to the exact pinned version; 1 attestation binding; the evidence + attach records counted)

## Corrective observations (recorded per the frozen clause)

1. **The governance boundary is real input, not configuration.** The boundary evaluation consumed the canonical `spec/development-state/governance-model.json` through the real loader; the packaging fingerprints the model's core prohibitions into every minted package. A weakened model is fail-closed at the V2-013 packaging level (SELF_HOSTING_BOUNDARY_MODEL_INVALID) — the dogfood confirms the ADR-0004 discipline holds on the self-hosting path, not only in the governance battery.
2. **Epoch alignment is a composition responsibility.** The run service's injected `currentEpoch` (RUN_TEST_EPOCH 7) must be ≤ the attestation statement's epoch for BOTH the run-boundary attach and the V2-015 admission; the dogfood pinned the statement epoch to the service epoch. A production self-hosted worker must derive its statement epoch from the run's epoch context (the V2-008 runtime path does this internally; a hand-driven worker must not invent one).
3. **The proof predicate's trust policy is the caller's duty.** The independent verifier verifies cryptographic authenticity; WHO to trust (attesterKeyIds) is supplied out-of-band in the verifier context, and the V2-013 packaging's trust policy independently restates it. The dogfood kept the two consistent; a corrective note for production: the trust set should derive from the node/capability authority (V2-004) rather than runner constants.
4. **Version convergence is load-bearing.** Re-publishing an identical first-party document converges on the existing version (V2-002 semantics); the manifest is only advanced by a genuinely mutated document through an explicit `publishFirstPartyVersion` transition. The dogfood's manifest stayed pinned to v1 throughout — the frozen pinning regression held end-to-end.
5. **The architect-review correction (PR #160, 2026-09-03): the predecessor binding is structural, not caller-declared.** The original packaging trusted the caller-supplied `declaredParents` without binding them to the WorkflowIR predecessor edges — a valid attestation for an unrelated execution could satisfy a proof-required step, and the recovery accepted synthetic advance targets. The correction round added: the typed `SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED` binding (every VERIFIED evidence fact must attest a WorkflowIR-declared predecessor step of the proof-required step within the manifest's workflow scope, and every IR-declared predecessor must be covered by an admitted parent — proven RED pre-fix with the exact attack shapes) and the typed `SELF_HOSTING_RECOVERY_TARGET_UNPROVEN` advance-target validation (the plan mints only on authoritative version facts read back from the real V2-002 authority). The dogfood's unrelated-step leg records the corrected negative experiment on the REAL stack.
6. **The recovery advance target is authority-proven INSTALLED data.** `advance_version` requires BOTH the target version's facts read back through the repository authority (V2-002's `getVersion`) AND the target's installation read-back in the SAME development environment (V2-002's `getInstallation` — the exact pinned (workflowId, versionId, versionNumber, contentDigest)): a published-but-NOT-installed target is fail-closed typed (`SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED`, the PR #160 residual Blocker-2 correction of review 5102958519 — publication alone is not transition-readiness). The plan is data and its executor still publishes and installs the new pin through the real authorities. A rollback-shaped advance (a lower versionNumber) is NOT blocked by the number alone — the governed transition discipline (explicit publish + install) is the actual gate, and the facts must prove the exact requested target within the SAME workflow.

## Determinism

The experiment ran twice on fresh stacks (fresh PGlite with ALL migrations, fresh identity, fresh Ed25519 worker keys). The structured facts were identical across both runs; the normalized transcripts (eliding only generated identities — the V2-002/V2-005 uuid-shaped ids, the Ed25519-derived digests/attestation ids, the mkdtemp sandbox suffixes and run labels) were byte-identical.

## Honest scope statement

The dogfood executed the run through the REAL V2-005 command surface (the run authority's own recording path — request/start/step/invocation/evidence/attach/complete). It did NOT drive the V2-008 ComputerAgentRuntime host-execution path (the V2-015 dogfooding runner already proves that composition for capability steps); the development procedure's steps here are recorded by the self-hosted worker through the run-authority commands, which is the worker's real driving surface.
