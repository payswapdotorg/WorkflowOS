# Architecture Governance and Checkpoints — Design

**Status:** Proposed evolution for the next WorkflowOS architecture increment

## 1. Goal

Turn the frozen architecture from a document that is mainly reviewed at the end of implementation into an executable governance system that detects architectural drift continuously, records conformance evidence, and blocks unsafe lifecycle progression without creating a second workflow engine or replacing existing domain authorities.

## 2. Problem

WorkflowOS already has strong architectural primitives: immutable architecture versions, Work Items bound to an architecture version, server-side tenant authority, evidence-based verification, deterministic workflow transitions, and explicit architecture-change requests. The development experience, however, can still discover architectural violations late, after an implementation has accumulated substantial changes.

The intended improvement is to move architectural enforcement earlier and make it repeatable throughout implementation. A checkpoint should answer a narrower question than ordinary tests: **does the current implementation remain structurally and semantically compatible with the authoritative architecture version governing this Work Item?**

## 3. Non-goals

- No second workflow/state-machine authority.
- No replacement of `/architecture`, `/work-items`, `/workflows`, `/verification`, or `/reviews`.
- No automatic mutation of a frozen architecture version.
- No autonomous approval of an architecture change merely because a checkpoint passes.
- No generic enterprise static-analysis platform.
- No requirement that every architecture rule be machine-checkable.

## 4. Core model

### 4.1 Architecture Assertion

An Architecture Assertion is a versioned architectural rule owned by `/architecture` and attached to an immutable ArchitectureVersion. It describes a condition that must remain true for implementations governed by that version.

Each assertion has:

- `assertionId`
- `architectureVersionId`
- `severity`: `blocking | advisory`
- `scope`: `repository | module | interface | data | workflow | security | execution | other`
- `statement`
- `detectorKind`
- `detectorConfig`
- `createdAt`

The `/architecture` module remains the sole authority for architecture definitions. Assertion evaluation does not create a second architecture authority.

### 4.2 Architecture Checkpoint

An Architecture Checkpoint is a conformance evaluation executed by an application capability against a concrete implementation snapshot and an immutable ArchitectureVersion.

The checkpoint orchestrator is not a workflow authority and owns no lifecycle transitions.

Checkpoint results and their evaluation evidence are persisted through the existing `/verification` authority so there is no parallel evidence store. A checkpoint references the governed Work Item, ArchitectureVersion, implementation revision, assertion set, detector results, and final conformance outcome.

The result vocabulary is:

- `passed`
- `passed_with_advisories`
- `blocked`
- `inconclusive`

### 4.3 Architecture Drift finding

A failed blocking assertion produces an Architecture Drift finding/evidence result. Findings never silently rewrite architecture. They either block the governed transition or require an explicit Architecture Change Request when the implementation is intentionally incompatible with the current version.

## 5. Lifecycle placement

Checkpoints are gates/obligations associated with existing lifecycle states rather than new workflow states.

### Architecture readiness

Before implementation assignment, verify that the Work Item has a valid immutable ArchitectureVersion and that all required assertions for that version are resolvable.

### Work Order checkpoint

Before an implementation agent starts, evaluate the Work Order's declared implementation scope against assertions that can be evaluated without source changes.

### Implementation checkpoints

During `IMPLEMENTING`, checkpoints may run at explicit progress boundaries, approved agent commits, or policy-selected intervals. Blocking failures prevent further implementation progress until corrected or an Architecture Change Request is opened.

### PR checkpoint

Before `PR_OPEN`, the candidate implementation revision must pass all applicable blocking architectural assertions.

### Verification-entry checkpoint

Before or at entry to `VERIFYING`, architecture conformance is re-evaluated against the exact revision that will be verified. This prevents verification from validating an implementation that drifted after the last architecture checkpoint.

### Architect review

`ARCHITECT_REVIEW` remains the final semantic authority. Mechanical checkpoints reduce the architect's review burden; they do not replace architectural judgment.

## 6. Architecture impact profile

Every Work Item receives a derived architecture-impact profile from its scope and declared change surface.

Suggested levels:

- `LOW`: documentation/local behavior; PR checkpoint sufficient.
- `MEDIUM`: module/internal behavior or data changes; pre-implementation + PR checkpoints.
- `HIGH`: authority boundaries, public interfaces, workflow/execution/security boundaries, or schema changes; readiness + pre-implementation + implementation + PR + verification checkpoints.

Impact controls checkpoint frequency and required assertion classes. It does not alter the architecture rules themselves.

## 7. Detector model

Detectors are specialized evaluators behind a common conformance interface. Initial detector classes should be narrow and deterministic:

- static repository structure/import detector
- schema/migration invariant detector
- authority-ownership detector
- interface/contract detector
- workflow-transition detector
- runtime configuration detector

A detector may report `pass`, `fail`, `inconclusive`, or `not_applicable`. An `inconclusive` blocking assertion fails closed at a lifecycle gate unless the assertion explicitly declares that inconclusive evaluation is advisory.

Detectors read authoritative state through existing public contracts and must not create parallel domain truth.

## 8. Decision policy

A checkpoint is `blocked` when any applicable blocking assertion fails or is inconclusive under a fail-closed rule.

A checkpoint is `passed_with_advisories` when all blocking assertions pass and one or more advisory assertions fail.

A checkpoint never creates or mutates workflow state directly. The existing `/workflows` authority consumes the checkpoint result and performs the legal lifecycle transition.

For intentional architectural evolution:

```text
checkpoint blocked
      ↓
ARCHITECTURE_CHANGE_REQUEST
      ↓
architect decision
      ↓
new immutable ArchitectureVersion
      ↓
new assertion set
```

## 9. Evidence and traceability

Every checkpoint must be traceable to:

`ArchitectureVersion → WorkItem → implementation revision → assertion set → detector results → verification evidence → checkpoint result`

Checkpoint evidence is stored through the existing `/verification` authority and is immutable once finalized. A later checkpoint never overwrites an earlier result; it creates another revision-bound result.

## 10. Self-hosting rule

WorkflowOS may use its own lifecycle to implement WorkflowOS, but the system must retain an external/root architecture authority for changes to the foundational architecture that governs the self-hosted loop.

Normal implementation changes may be autonomously planned, implemented, verified, and reviewed. Changes to the governing architecture itself require an explicit architecture-change decision and a new immutable version; the running system must not silently redefine the rules by which it evaluates itself.

## 11. Initial checkpoint policy

The first implementation should be deliberately small:

1. architecture readiness checkpoint
2. pre-implementation Work Order checkpoint
3. PR architecture conformance checkpoint
4. verification-entry checkpoint

Continuous mid-implementation checkpoints should be enabled for `HIGH` impact work after the initial governance path proves stable.

## 12. Success criteria

The design is successful when:

- a known architectural violation can be detected before PR creation;
- the same assertion produces a durable, immutable, revision-bound result through `/verification`;
- the workflow engine remains the only lifecycle authority;
- architecture changes create a new immutable ArchitectureVersion;
- checkpoint failures can block progression without directly mutating workflow state;
- intentional architecture changes have a clean, auditable escape path;
- WorkflowOS can use this machinery to govern its own implementation without becoming the unchecked authority for changing its foundational architecture.

## 13. Compatibility with the frozen architecture

This is a proposed next-version evolution, not a retroactive rewrite of the frozen v1.0 rules. It preserves the existing authority model and extends it with machine-readable architecture assertions plus checkpoint evaluation. The existing lifecycle remains the same Work Item → Work Order → Execution → Verification → Review → Merge/Release machinery, while architecture conformance becomes an explicit gate around that lifecycle.

Any change to frozen module ownership, workflow semantics, or other protected v1.0 rules still requires the existing Architecture Change Request path and a new immutable architecture version.
