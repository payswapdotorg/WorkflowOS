# WorkflowOS 2.0 — Optimized No-Rebase Roadmap

## Goal

Maximize implementation throughput without sacrificing architectural quality. Parallelism is used only when branches can start from the same stable `main` and merge independently. No feature branch ever depends on another unmerged feature branch.

## Wave 0 — Protocol foundation

**Complete:** V2-001 Universal Workflow Protocol.

This is the only prerequisite for the first parallel construction wave because the protocol freezes the shared wire boundary.

## Wave 1 — Independent foundations

Start all three from the same V2-001 merge SHA. They must have disjoint surfaces and merge independently.

### V2-002 — Workflow Repository + Immutable Versioning
Owns repository identity, Workflow, WorkflowVersion, version ancestry, fork identity, repository permissions, and installation pinning.

### V2-003 — Workflow IR
Owns the canonical semantic IR, graph/control/data semantics, deterministic serialization, validation, compatibility and semantic digest.

### V2-004 — Node + Capability Protocol
Owns Node identity, capability advertisement/versioning, capability requirement matching, placement/locality/privacy constraints and cross-host conformance.

## Wave 2A — Execution-proof foundation in parallel

After Wave 1 implementation siblings are merged, these items run independently from the same stable main.

### V2-006 — Teaching Sessions
Owns TeachingSession, learner state, explanations, practice and teaching evidence. It consumes frozen W1 contracts only.

### V2-007 — Workflow Compiler
Owns deterministic compilation from the merged V2-003 IR implementation. Full compiler↔run composition is deferred to IG-003.

### V2-014 — Execution Attestation Protocol
Owns canonical ExecutionStatement, domain-separated ExecutionDigest, authenticated ExecutionAttestation, freshness/anti-replay semantics, attester/workload identity binding, assurance levels, and cryptographic verification primitives. It consumes only merged W1 contracts and does not own Run persistence or Node internals.

**Why parallel:** V2-006, V2-007 and V2-014 have disjoint authoritative surfaces. V2-014 is a protocol/evidence primitive and does not require another sibling implementation.

## Wave 2B — Durable runs and evidence

### V2-005 — Workflow Runs + Evidence
Starts after V2-002 implementation and the V2-014 contract are merged, while consuming the V2-003/V2-004 contracts. It owns Run lifecycle, evidence persistence, correlation/causation, and bindings to attestation references.

## Integration gates before computer execution

Before V2-008 may activate, the W1 semantics must be integrated through:

- **IG-001:** repository ↔ WorkflowIR round-trip, immutability, pinning and fork semantics.
- **IG-002:** WorkflowIR ↔ Node/Capability/placement compatibility and authorization separation.

These gates start from the then-current `main` after their inputs merge. They are not rebases of sibling branches. Each has cross-feature dogfooding.

## Wave 3 — Computer execution

### V2-008 — Computer-Agent Runtime

Activates only after V2-004, V2-005 and V2-007 implementations are merged **and IG-001 + IG-002 are COMPLETE**. It owns browser/desktop/mobile computer execution and host adapters while preserving universal workflow semantics.

## Wave 4 — Events, scheduling and optimization foundations

After V2-008:

### V2-009 — Scheduling + Events + Placement
Owns trigger subscriptions, schedules, event deduplication, locality-aware placement and enable/disable semantics.

### V2-010 — Reverse Teaching
Owns converting installed workflows into human lessons and may run in parallel with V2-009/V2-011 where surfaces remain disjoint.

### V2-011 — Optimization
Owns optimization analysis and explicit proposed versions. It may replace GUI sequences with APIs, reuse workflows, parallelize safe steps, improve placement or reduce cost/reliability risk, but never silently mutates an installed version.

## Cross-device attestation gate

After V2-005, V2-008, V2-009 and V2-014 are merged, run **IG-006** from current `main` to prove cross-device execution-attestation composition, freshness, handoff idempotency, and attestation-gated dependent execution.

## Wave 5 — Ecosystem + verifiable coordination

The following remain parallel after their dependencies are satisfied:

### V2-012 — Collaboration + Marketplace + Economics
Combines repository/versioning, execution/evidence, teaching and optimization after their implementations have merged. Entitlement never grants execution authority.

### V2-015 — Execution Proof Graph and Trust-Minimized Coordination
Owns composable causal/dependency graphs of ExecutionAttestations, VerifiedExecutionFact predicates, and cross-device coordination. It does not replace WorkflowIR, Run, Node, capability, authorization, or verification authorities.

**Why parallel:** V2-012 owns ecosystem/commercial surfaces while V2-015 owns execution-proof composition. They do not depend on each other's unmerged implementation.

## Wave 6 — Self-hosting

### V2-013 — WorkflowOS Self-Hosted Workflow Library
Turns WorkflowOS's software-engineering, maintenance, deployment, verification, dogfooding and governed development procedures into ordinary installable workflows using the same protocol and governance boundaries. It consumes the merged proof/coordination capability but does not create a second engine.

## Integration gates

Whenever independently developed capabilities first interact, use a dedicated integration Work Order from current `main` rather than rebasing a sibling. Declared gates:

- `IG-001` repository ↔ IR;
- `IG-002` IR ↔ capability/placement;
- `IG-003` compiler ↔ runs/evidence ↔ computer execution;
- `IG-004` events ↔ reverse teaching ↔ optimization;
- `IG-005` marketplace ↔ self-hosting;
- `IG-006` execution attestations ↔ runs ↔ computer execution ↔ events/placement.

## Dogfooding placement

Every user-facing/execution-facing Work Order has a feature-boundary experiment before completion. Every integration gate has an additional cross-feature experiment before downstream progression.

Execution-attestation dogfooding must verify a real signature and independent verification, then demonstrate rejection of tampered or stale material. Proof-graph dogfooding must use two real supported hosts where capabilities and placement permit it.

## No-rebase quality invariant

Speed is never purchased by rebasing, weakening tests, reducing dogfooding, collapsing scopes, or allowing sibling branches to depend on unmerged implementations. When a conflict surface appears, the architect either rescopes ownership into independent contracts or introduces an integration gate.

## Expected throughput

```text
W0: 1
W1: 3 parallel
W2A: 3 parallel
W2B: 1
IG-001 + IG-002
W3: 1
W4: 3 parallel
IG-006
W5: 2 parallel
W6: 1
IG-003..005 at their existing composition boundaries
```

