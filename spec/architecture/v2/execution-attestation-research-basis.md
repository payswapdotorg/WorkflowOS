# Execution Attestation — Research Basis

This document records the external research that informed V2-ACR-001. It is explanatory evidence for the architecture decision, not a replacement for the normative V2 contracts.

## Remote attestation / trust appraisal

**IETF RFC 9334 — Remote ATtestation procedureS (RATS) Architecture**

https://www.rfc-editor.org/rfc/rfc9334.html

Relevant design lesson: Evidence, verifier appraisal, attestation results, and relying-party policy are distinct. A cryptographically authenticated statement is not automatically a trusted execution fact. Freshness and environment binding matter.

**IETF RATS Architecture / Entity Attestation Token ecosystem**

The RATS family reinforces the separation between attester identity/evidence and the policy that consumes appraisal results.

## Provenance and process attestations

**in-toto**

https://in-toto.io/

https://github.com/in-toto/attestation

Relevant design lesson: a prescribed process can be evidenced by independently signed step attestations. Statement/predicate/envelope separation avoids making a process log a monolithic opaque proof object.

**W3C PROV**

https://www.w3.org/TR/prov-primer/

Relevant design lesson: provenance is naturally modeled as relationships among entities, activities, and agents. This supports WorkflowOS's causal execution graph model rather than a single flat execution log.

## Identity and workload assurance

**SPIFFE / SPIRE concepts**

https://spiffe.io/docs/latest/spire-about/spire-concepts/

Relevant design lesson: node/platform identity and workload identity are distinct. Possessing a node identity does not by itself establish what workload produced an execution.

## Delegated authority

**UCAN specification**

https://github.com/ucan-wg/spec

Relevant design lesson: delegated authorization can be cryptographically represented and attenuated independently from execution claims. WorkflowOS therefore keeps capability/authorization separate from execution attestation.

## Attestation envelopes and domain separation

**in-toto Attestation Framework**

https://github.com/in-toto/attestation/blob/main/spec/README.md

Relevant design lesson: typed statements/predicates plus authenticated envelopes are safer and more extensible than signing an unspecified JSON blob.

**DSSE — Dead Simple Signing Envelope**

https://github.com/secure-systems-lab/dsse

Relevant design lesson: signatures should authenticate both payload type and payload, providing domain separation between independently meaningful signed objects.

## Transparency

**Sigstore / Rekor**

https://docs.sigstore.dev/logging/overview/

Relevant design lesson: an append-only transparency log can add independent timestamp/inclusion evidence, but it is an optional layer and need not be a baseline execution dependency.

## Verifiable computation

**Proof-carrying code**

Necula, G. C., "Proof-Carrying Code," POPL 1997, https://doi.org/10.1145/263699.263712

Relevant design lesson: an untrusted producer can provide machine-checkable evidence satisfying an explicit policy. This motivates keeping verifiable-computation proofs as one optional assurance class rather than requiring them universally.

## Architecture conclusions derived from the research

1. A hash is a deterministic commitment, not proof of physical execution.
2. A valid signature proves statement authenticity under the signing system, not honest behavior or side-effect reality.
3. Execution truth requires appraisal of evidence, identity, freshness, policy and assurance.
4. Node identity and workload/runtime identity should remain distinct.
5. Independently signed step attestations can be composed into higher-level process/provenance graphs.
6. Freshness and anti-replay must be explicit; timestamps alone are insufficient.
7. Stronger hardware/TEE/verifiable-computation assurances should strengthen a common protocol rather than create platform-specific workflow semantics.
8. Transparency logs and blockchains are optional anchoring/coordination mechanisms, not baseline execution dependencies.

The normative interpretation of these findings is recorded in `V2-ACR-001-execution-attestation.md` and `execution-attestation.md`.
