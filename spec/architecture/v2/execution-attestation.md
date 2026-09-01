# WorkflowOS 2.0 — Execution Attestation and Proof Model

**Status:** PROPOSED / implementation-authorized normative evolution under V2-ACR-001.

## Purpose

Provide a portable protocol object for making execution facts cryptographically commit-able, attest-able, freshness-bound, verifiable, and composable across WorkflowOS nodes.

The primitive is deliberately layered. A digest commits to canonical data. An attestation authenticates an attester's statement. Verification/appraisal decides whether the evidence and trust context establish the required execution fact. No single layer is treated as physical truth.

## Object model

```text
WorkflowVersion
    ↓ immutable semantic meaning
WorkflowRun
    ↓ execution identity
ExecutionStatement
    ↓ canonical commitment
ExecutionDigest
    ↓ authenticated envelope
ExecutionAttestation
    ↓ verifier/appraisal policy
VerifiedExecutionFact
    ↓ optional composition
ExecutionProofGraph
```

## ExecutionStatement

An ExecutionStatement describes one bounded execution fact. It is a semantic object and MUST contain only fields whose presence is defined by this contract.

Minimum semantic bindings:

- protocol version and statement type;
- Workflow identity and immutable WorkflowVersion identity;
- WorkflowIR semantic digest;
- Deployment identity;
- Run identity and execution-attempt identity;
- Step identity when the fact concerns a step;
- Node identity and workload/runtime identity when available;
- execution class and invoked canonical capability where applicable;
- canonical input commitments and output/effect commitments;
- observation commitments and evidence references;
- causal parent execution digests;
- authorization-context digest and placement/policy digests when relevant;
- freshness material (challenge/nonce/epoch or equivalent);
- execution outcome and bounded timestamps.

Secrets, raw credentials, bearer tokens, and unnecessary sensitive parameter values MUST NOT be serialized into the statement. Use commitments or opaque secure references when the fact can be verified without disclosure.

## ExecutionDigest

`ExecutionDigest` is a domain-separated SHA-256 digest over canonical JSON of the canonical ExecutionStatement.

The digest MUST be domain separated from WorkflowVersion semantic digests and from unrelated protocol objects. Recommended domain identifier:

`workflowos/execution-statement/v1`

The digest therefore commits to execution semantics without becoming the WorkflowVersion identity.

## ExecutionAttestation

An ExecutionAttestation is an authenticated envelope containing:

- attestation format/version;
- canonical ExecutionStatement or a resolvable content-addressed reference;
- ExecutionDigest;
- attester identity;
- workload/runtime identity or measurement when available;
- assurance method/level;
- signature and key-reference metadata;
- optional verifier-relevant platform evidence;
- issuance/freshness metadata.

The signature authenticates the attester's statement. It does NOT by itself prove honest execution or physical reality.

## Assurance

The initial assurance vocabulary is:

- `software_signed` — software-controlled signing key attests to the statement;
- `hardware_backed` — key/use is protected by platform hardware-backed facilities;
- `tee_attested` — attestation includes evidence that the relevant workload executed inside an attested trusted execution environment;
- `verifiable_computation` — an independently checkable proof establishes the specified computation under the committed inputs/program.

Assurance levels are evidence properties. They do not change WorkflowIR semantics or execution classes.

## Freshness and replay

Every attestation that can influence a current workflow decision MUST be bound to the relevant execution identity and freshness context.

A verifier MUST reject an otherwise valid attestation when:

- it belongs to a different Run or execution attempt;
- its challenge/nonce/epoch is not the expected one;
- its validity interval is expired where an interval is required;
- it has already been consumed where single-use semantics apply;
- its causal parents do not match the required execution graph.

Timestamps alone are not a sufficient replay defense.

## Verification

Verification evaluates:

```text
cryptographic validity
AND identity validity
AND freshness
AND workflow/version binding
AND authorization relevance
AND capability/placement relevance
AND evidence sufficiency
AND required assurance
AND causal/dependency consistency
```

The output is a VerifiedExecutionFact or a typed rejection. A valid signature with insufficient evidence MUST NOT become a verified side-effect fact.

## Cross-device composition

When a Run moves between nodes, each node may produce an attestation linked to the same Run and to its causal predecessor attestations.

```text
A1(H1)
  ↓
A2(H2, parent=H1)
  ↓
A3(H3, parent=H2)
```

Parallel branches are permitted:

```text
      A1
     /  \
   A2    A3
     \  /
      A4
```

A dependent execution may require verified predicates from one or more parent attestations. This is the basis for trust-minimized multi-device coordination.

## ExecutionProofGraph

An ExecutionProofGraph is a derived/transportable graph whose nodes are ExecutionAttestations and whose edges are explicit causal/dependency links.

It is NOT a second workflow representation. WorkflowIR remains the semantic source of workflow intent. The proof graph represents evidence about executions of that intent.

A graph MUST be acyclic with respect to causal edges. Repeated delivery of the same attestation MUST converge by its stable attestation/execution identity.

## Trust model

The following are distinct and MUST never be collapsed:

```text
Node identity
Workload identity
Capability possession
Authorization
Placement
Policy
Cryptographic authenticity
Attestation assurance
Observed effect
Verification result
```

For example:

```text
valid signature
    ≠ authorized action
    ≠ correct action
    ≠ successful side effect
    ≠ trusted hardware
```

## Optional external anchoring

Transparency logs, blockchains, external ledgers, and decentralized timestamping MAY consume attestations later. None is required for baseline V2 execution or correctness.

## Privacy

An attestation SHOULD expose the minimum information needed for its intended verifier. Predicate commitments and opaque references should be preferred over raw sensitive values when disclosure is unnecessary. The existence of a cryptographic proof MUST NOT become a side channel for secrets.

## Compatibility

Execution attestation is additive. Existing Run, capability, placement, evidence, and cross-device handoff semantics remain intact. Hosts that cannot provide hardware or TEE assurance remain valid participants at `software_signed` assurance when policy permits.

## Failure semantics

Unknown, malformed, unverifiable, stale, unauthorized, or insufficient-assurance attestations fail closed for decisions that require them. Lack of stronger assurance is an explicit ineligible result, not silently substituted by a weaker class.
