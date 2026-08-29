# ACR-001 — WorkflowOS v1.1 Adaptive Engineering Control System

Status: proposed.

## Motivation
WorkflowOS has a strong governed change-execution model but needs a durable architecture for continuous sensing, system understanding, adaptive assurance, quality-attribute fitness, operational/user feedback, large change orchestration, and self-hosting.

## Current architecture
Frozen v1.0 separates architecture, requirements, work items, workflow, execution, verification, review, and GitHub authorities. WORK-051/052 add executable checkpoints and repository-resident development governance.

## Proposed evolution
Create ArchitectureVersion v1.1 with the Engineering Control Loop; derived System Model; Quality Attribute/Fitness model; Engineering Signals; Change Programs/Change Sets; Adaptive Assurance; operational/release governance; Architecture Fitness → ACR feedback; and Self-Hosting Conformance.

## Alternatives rejected
1. Rewrite v1.0 in place — rejected because historical architecture and its invariants must remain immutable.
2. Add one central autonomous agent — rejected because it creates excessive authority concentration and poor failure isolation.
3. Add independent planning/verification/workflow engines — rejected because they duplicate authorities.

## Preserved invariants
All v1.0 security, tenancy, authority, lifecycle, provenance, idempotency, concurrency, provider-isolation, verification, and evidence guarantees remain mandatory.

## Migration strategy
Implement v1.1 artifacts and capabilities incrementally through WORK-053..061 (the architect-issued issues #65..#73). Existing v1.0 Work Items continue to use their current contracts. No destructive migration is required for the architecture-definition layer.

> **Reconciliation note (2026-08-29, updated by pass 2):** this ACR was reconciled against main `8f27cc7`
> (the merged WORK-046..050 wave). The architect's upload wave of 2026-08-28T18:24–18:40Z
> re-used the WORK-053..059 identifiers for a different roadmap under a "2.0" version
> label. By the architect's 2026-08-29 PR #74 review verdict, the architect-issued issue
> track (this ACR, WORK-053..061, v1.1) is the one canonical track and the upload wave is
> retired under distinct UW-053..059 identities (`spec/archive/upload-wave-2026-08-28/`) —
> see `spec/architecture/v1.1/reconciliation-record.md` §8. The approval decision below
> remains the architect's alone.

## Rollback
Unmerged v1.1 Work Items can be abandoned without altering v1.0 authoritative state. A future v1.1-derived artifact may be removed only through its owning authority; historical v1.0 records remain intact.

## Approval rule
Only the architecture authority can approve this ACR and designate the resulting ArchitectureVersion as governing. Self-hosted agents may propose ACRs but cannot approve or silently modify the governing version.
