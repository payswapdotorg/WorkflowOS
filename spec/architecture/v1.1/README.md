# WorkflowOS Architecture v1.1

Status: proposed pending ACR-001 approval and merge.

v1.1 is an additive evolution of frozen v1.0. Historical v1.0 documents are never rewritten to make v1.1 true.

> **Reconciliation (2026-08-29, pass 1 + pass 2):** this package was reconciled against main `8f27cc7`
> (the merged WORK-046..050 wave), then — after the architect's REQUEST CHANGES verdict —
> the WORK-053..059 identity collision and the v1.1-vs-2.0 version-label conflict were
> **resolved at the identity/authority layer**: the architect-issued issue track (ACR-001,
> WORK-053..061, v1.1) is canonical; the upload wave is retired under `UW-053..059`
> identities in `spec/archive/upload-wave-2026-08-28/`. See
> [`reconciliation-record.md`](reconciliation-record.md) (§3 + §8) for the verified repository
> truth, the resolution, and the GitHub enforcement gaps recorded as v1.1 governance requirements.

## Scope

v1.1 adds the durable architectural model for:

- Engineering Control Loop: sense → understand → plan → check → execute → verify → review → release → observe → learn.
- Complexity-adaptive assurance.
- Derived System Model and provenance-aware engineering context.
- Quality attributes and architecture fitness.
- Engineering signals from repository, CI, runtime, security, incidents, performance, user and product feedback.
- Change Programs and Change Sets for large-system evolution while retaining Work Item as the atomic governed unit.
- Continuous architecture evaluation and Architecture Change Requests.
- Operational/release governance where applicable.
- Self-hosting of WorkflowOS without permitting silent changes to governing architecture.

## Authority rule

No v1.1 artifact becomes a replacement for an existing v1.0 authority. New artifacts are classified as normative architecture, authoritative state in an existing authority, derived engineering state, or evidence.
