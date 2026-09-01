# V2-ACR-001 — Verifiable Execution and Execution Attestation

**Status:** PROPOSED ARCHITECTURE EVOLUTION — implementation planning authorized, formal V2 freeze remains governed separately.
**Architecture generation:** WorkflowOS 2.0

## Decision requested

Extend the V2 architecture with a first-class, protocol-native **Execution Attestation** model. The model adds deterministic execution commitments, authenticated node attestations, explicit assurance levels, and composable execution-proof graphs without creating a second workflow protocol, execution engine, authorization authority, or verification authority.

## Problem

V2 already defines immutable WorkflowVersions, canonical WorkflowIR, authenticated Nodes, capabilities, placement, WorkflowRuns, evidence, causation, and cross-device handoff. A Run can therefore describe what the system recorded, but V2 does not yet define a portable cryptographic object that a node can use to commit to a precise execution fact and that another node or verifier can independently appraise.

The goal is not to treat a hash or signature as physical truth. The goal is to make execution facts **commit-able, attest-able, verifiable, freshness-bound, and composable**.

## Terminology

- **ExecutionStatement** — canonical structured representation of one execution fact.
- **ExecutionDigest** — domain-separated SHA-256 digest of the canonical ExecutionStatement.
- **ExecutionAttestation** — an authenticated envelope carrying an ExecutionStatement/ExecutionDigest, attester identity, assurance context, and signature.
- **VerifiedExecutionFact** — the result of applying an explicit verification/appraisal policy to an attestation and its evidence. It is not created merely by possessing a valid signature.
- **ExecutionProofGraph** — a DAG of attestations linked by causal/dependency relationships.

## Core semantics

1. A WorkflowVersion remains the immutable semantic source of workflow meaning.
2. A Run remains the execution identity and state authority defined by V2-005.
3. An ExecutionStatement commits only to explicitly defined semantic execution inputs, actions, observations, effects, and causal context.
4. ExecutionDigest uses the V2 canonical JSON discipline plus domain separation for the execution-statement object; it must not reuse a WorkflowVersion digest as an execution identity.
5. An ExecutionAttestation authenticates who attests and what they attest; a valid signature does not by itself establish that the asserted side effect occurred.
6. Freshness is explicit. An attestation is bound to the Run/execution attempt and a challenge, nonce, epoch, or equivalent anti-replay context defined by the owning contract.
7. Node identity, workload/runtime identity, authorization, capability possession, placement, trust, and attestation assurance are separate dimensions.
8. Evidence classes remain distinct: intent, observation, claim, verification, and human confirmation. Attestation is an authenticated protocol object, not a replacement evidence class.
9. Verification/appraisal remains the authority for deciding whether an attestation and its evidence establish the required execution fact.
10. Cross-device handoff preserves Run identity, causation, attestation ancestry, and idempotency without silently creating a second workflow protocol.
11. Composable proof graphs are optional protocol artifacts and never become a second workflow engine.
12. Software-signed attestations are the universal baseline. Hardware-backed, TEE-backed, and verifiable-computation evidence may strengthen assurance when a host supports them without changing WorkflowIR semantics.
13. Sensitive values are represented by explicit commitments or opaque references when disclosure is unnecessary; secrets are never placed in workflow definitions or ordinary protocol payloads.
14. Marketplace entitlement never grants attestation authority or execution authority.

## Threat model

The design must explicitly cover network replay/reordering, malicious coordinators, malicious or compromised nodes, stale attestations, forged/cross-protocol envelopes, unauthorized actions, and disclosure of sensitive execution parameters.

A valid software signature proves key possession and statement integrity. It does not prove honest behavior, physical reality, or uncompromised execution. Stronger assurance requires stronger evidence and policy.

## Assurance model

The architecture permits an extensible assurance vocabulary, with the initial semantic floor:

- `software_signed`
- `hardware_backed`
- `tee_attested`
- `verifiable_computation`

These are assurance properties, not execution classes. A verifier may require a minimum assurance level as policy.

## Authority preservation

No new workflow, scheduler, authorization, or verification engine is introduced.

```text
WorkflowIR
  ↓
WorkflowRun
  ↓
execution on Node
  ↓
ExecutionAttestation
  ↓
verification/appraisal
  ↓
VerifiedExecutionFact
```

V2-004 remains the Node/capability/trust authority. V2-005 remains the Run/evidence authority. The future proof-graph feature consumes these authorities and never supersedes them.

## Roadmap impact

The change introduces two product Work Orders:

- **V2-014 — Execution Attestation Protocol**: foundational contract and implementation for canonical execution statements, digests, signatures, freshness, assurance, and verification primitives. It is positioned after W1 so it can consume the merged V2-003 and V2-004 contracts while preserving parallelism with teaching/compiler work.
- **V2-015 — Execution Proof Graph and Trust-Minimized Coordination**: composes merged execution attestations across nodes into verifiable causal/dependency graphs and conditional cross-device coordination.

An additional integration gate is added:

- **IG-006 — Cross-Device Attestation Composition**: proves V2-005/V2-008/V2-009/V2-014 composition before V2-015 becomes complete.

## Required proof classes

The future implementations must include deterministic regression tests, mutation/discrimination tests, real cryptographic verification, replay/freshness negatives, authorization/capability separation, cross-device idempotency, crash/reconnect recovery where claimed, and real-product dogfooding. Trust claims must never be inferred from a signature alone.

## No-rebase / parallelism decision

V2-014 owns only its attestation contracts, cryptographic envelope implementation, and dedicated tests/specs. It does not modify V2-002 repository internals, V2-003 IR semantics, or V2-004 Node internals. Its protocol identifiers are registered by this governed change before implementation depends on them.

V2-006 and V2-007 may proceed in parallel with V2-014 after W1. V2-005 waits for the V2-014 contract because its run/evidence model must persist attestation references and execution commitments. No sibling branch is ever used as another sibling's base.

V2-015 owns proof-graph/coordination semantics and does not modify the internal implementations of V2-008 or V2-009; the composition boundary is verified through IG-006.

## Stop conditions

Stop and raise a further governed architecture change if implementation requires:

- a second workflow protocol or engine;
- a second execution, authorization, or verification authority;
- treating a signature/hash as proof of physical reality without the corresponding assurance/evidence policy;
- silently weakening replay protection or freshness;
- device-specific workflow semantics;
- secrets embedded in attestations;
- a transparency ledger or blockchain becoming a mandatory execution dependency;
- zero-knowledge or hardware attestation being required from all hosts;
- silently changing the immutable WorkflowVersion or its semantic digest rules.

## Relationship to V1

No V1 authority is rewritten. V2 consumes V1 only through the existing explicit adapter boundary.
