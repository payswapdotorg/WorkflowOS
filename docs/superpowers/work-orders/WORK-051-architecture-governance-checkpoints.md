# WORK-051 — Architecture Governance and Checkpoints

> **Implementation authority:** z.ai implementation agent. Architect/reviewer retains approval authority and will review the resulting PR before merge.

## Objective

Evolve WorkflowOS so architectural conformance is executable and continuously enforceable during the existing development lifecycle, reducing late discovery of architectural drift without introducing a second workflow engine or replacing existing domain authorities.

## Preconditions

- Base the implementation on the current `main` branch and the approved Architecture Governance and Checkpoints design at `docs/superpowers/specs/2026-08-27-architecture-governance-checkpoints-design.md`.
- Treat the existing frozen v1.0 architecture as immutable. Do not modify its authority rules in place.
- Establish the approved design as a new immutable ArchitectureVersion through the existing `/architecture` authority before relying on any new architecture-governance rules.
- WORK-043 is merged and is part of the current execution-policy surface. Do not reopen or redesign WORK-043 as part of this work.

## Architectural contract

### Ownership

- `/architecture` remains the sole authority for architecture definitions, architecture versions, assertions, and architecture change control.
- `/verification` remains the sole authority for durable verification/conformance evidence storage and finalization semantics.
- `/workflows` remains the sole authority for lifecycle state and legal state transitions.
- `/reviews` remains the authority for architect review records and verdicts.
- The new checkpoint capability is an application-layer orchestrator. It owns no workflow state machine and no parallel evidence authority.

### Core entities

Implement the following concepts without duplicating existing authorities:

1. **Architecture Assertion** — immutable-version-scoped rule metadata owned by `/architecture`.
2. **Architecture Checkpoint** — evaluation of an assertion set against an exact implementation revision.
3. **Architecture Drift finding/result** — conformance failure evidence; never an implicit architecture mutation.

Required assertion fields:

- `assertionId`
- `architectureVersionId`
- `severity: blocking | advisory`
- `scope`
- `statement`
- `detectorKind`
- `detectorConfig`
- `createdAt`

Checkpoint result vocabulary is exactly:

- `passed`
- `passed_with_advisories`
- `blocked`
- `inconclusive`

Detector result vocabulary is:

- `pass`
- `fail`
- `inconclusive`
- `not_applicable`

An inconclusive blocking assertion fails closed at a lifecycle gate unless that assertion is explicitly advisory.

### Evidence and authority boundaries

Checkpoint evidence must be persisted through the existing `/verification` authority. Do not introduce a parallel `architecture_evidence` store or second verification repository.

Every finalized checkpoint must preserve this traceability chain:

`ArchitectureVersion → WorkItem → implementation revision → assertion set → detector results → verification evidence → checkpoint result`

Checkpoint records/results are immutable once finalized. A later checkpoint creates a new revision-bound result; it never overwrites an earlier checkpoint.

### Lifecycle integration

Do NOT add new workflow states.

The first implementation must support these gates around the existing lifecycle:

1. architecture readiness before implementation assignment;
2. pre-implementation Work Order checkpoint;
3. PR architecture conformance checkpoint before `PR_OPEN`;
4. verification-entry checkpoint before/at `VERIFYING`.

Checkpoint failures must block progression through the existing `/workflows` transition authority rather than directly mutating workflow state.

Implementation checkpoints may be prepared as a narrow reusable capability, but continuous mid-implementation scheduling is **not required in this first increment**. Do not add cron, `setInterval`, or another scheduler.

### Architecture impact

Derive a Work Item impact level:

- `LOW` — documentation/local behavior; PR checkpoint sufficient.
- `MEDIUM` — module/internal behavior or data changes; pre-implementation + PR checkpoints.
- `HIGH` — authority boundaries, public interfaces, workflow/execution/security boundaries, or schema changes; readiness + pre-implementation + implementation + PR + verification checkpoints.

Impact controls checkpoint frequency/assertion applicability; it must not weaken the underlying architecture rules.

### Detector boundary

Initial detectors must be narrow and deterministic. At minimum establish interfaces for:

- static repository structure/import checks;
- schema/migration invariants;
- authority-ownership rules;
- interface/contract rules;
- workflow-transition rules;
- runtime-configuration rules.

Detectors read authoritative state through existing public contracts and must not become alternate domain authorities.

### Architecture evolution / self-hosting

If implementation intentionally violates a frozen rule, the checkpoint must stop normal progression and surface an Architecture Change Request path. The correct escape is:

`checkpoint blocked → Architecture Change Request → architect decision → new immutable ArchitectureVersion → new assertion set`

WorkflowOS may govern implementation of WorkflowOS, but changes to the foundational architecture governing the self-hosted loop remain externally/root-authorized. The running system must not silently redefine the rules by which it evaluates itself.

## Mandatory regression proofs

The implementation is not acceptable without executable proofs for all of the following:

1. A known architecture violation is detected before PR creation.
2. The same assertion evaluated twice against the same revision yields the same conformance result.
3. Checkpoint evidence is tied to the exact ArchitectureVersion, WorkItem, and implementation revision.
4. A later implementation revision creates a distinct checkpoint result rather than mutating the previous result.
5. A blocking failure produces `blocked` and prevents the corresponding lifecycle transition through `/workflows`.
6. An advisory failure produces `passed_with_advisories` and does not block the lifecycle.
7. An inconclusive blocking assertion fails closed.
8. An intentional architecture-change path does not mutate the frozen version and requires explicit architecture-change authority.
9. Tenant/project ownership is enforced for every checkpoint lookup and execution path; cross-project access is denied before detector execution.
10. Checkpoint execution itself cannot mutate architecture definitions, workflow state, or verification evidence except through the existing `/verification` authority.
11. Self-hosting can run the same checkpoint machinery against WorkflowOS without granting it unchecked authority to alter its governing architecture.

## Static architecture invariants

Add executable architecture checks that prevent reintroduction of:

- a second workflow/state-machine authority;
- a second verification/evidence authority;
- a second architecture authority;
- direct workflow SQL writes from checkpoint code;
- direct verification-table writes from checkpoint code;
- detector imports that bypass public module barrels;
- detector/provider-specific credential coupling;
- architecture-version mutation by checkpoint code;
- checkpoint routes that trust caller-supplied project/organization ownership;
- scheduler-driven checkpoint execution in the initial increment.

## Scope exclusions

Do NOT implement:

- Adaptive Execution Router / WORK-044;
- Multi-Agent Roles / WORK-045;
- Multi-Agent Delegation / WORK-046;
- Agent Intelligence / WORK-047;
- Developer Workbench / WORK-048;
- Project Health UX / WORK-049;
- Unified Execution UX / WORK-050;
- a generic enterprise static-analysis product;
- vector search/embeddings as part of checkpointing;
- a continuous crawler;
- automatic architecture-version mutation;
- a second workflow engine;
- a second verification engine;
- a second review engine.

## Required implementation workflow

1. Audit the current `/architecture`, `/verification`, and `/workflows` public contracts before editing.
2. Write failing tests for each mandatory regression proof above.
3. Implement the smallest conforming architecture-layer extension.
4. Add static architecture invariants before declaring the feature complete.
5. Run typecheck, lint, architecture checks, targeted integration tests, and the full backend regression suite.
6. Open a PR against `main` with a complete finding→fix→test mapping.
7. Do not merge. The architect will inspect the actual diff and issue REQUEST CHANGES or approval.
