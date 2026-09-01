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
Owns Node identity, capability advertisement, capability requirement matching, placement/locality/privacy constraints and cross-host conformance.

**Why parallel:** each item consumes the already-merged V2-001 protocol contract. None requires another item's implementation. Each scope excludes the other sibling's internals.

## Wave 2 — Execution foundation

After Wave 1 implementation siblings are merged:

### V2-005 — Workflow Runs + Evidence
Owns Run lifecycle, evidence, pause/resume, idempotency, correlation and execution history. It consumes the V2-002 repository implementation plus frozen V2-003/V2-004 contracts.

### V2-006 — Teaching Sessions
Owns TeachingSession, learner state, explanations, practice and teaching evidence. It consumes frozen W1 contracts only and can run in parallel with V2-005/V2-007.

### V2-007 — Workflow Compiler
Owns deterministic compilation from the merged V2-003 IR implementation and does not depend on V2-005's unmerged implementation. Full compiler↔run composition is deferred to IG-003.

**Preferred arrangement:**

```text
V2-005 Run/evidence
V2-006 Teaching sessions      ← parallel, same stable base
V2-007 Compiler core
             ↓
     feature-boundary dogfood
             ↓
   IG-001 / IG-002 as required
```

## Integration gates before computer execution

Before V2-008 may activate, the W1 semantics must be integrated through:

- **IG-001:** repository ↔ WorkflowIR round-trip, immutability, pinning and fork semantics.
- **IG-002:** WorkflowIR ↔ Node/Capability/placement compatibility and authorization separation.

These gates start from the then-current `main` after their inputs merge. They are not rebases of sibling branches. Each has cross-feature dogfooding.

## Wave 3 — Computer execution

### V2-008 — Computer-Agent Runtime

Activates only after V2-004, V2-005 and V2-007 implementations are merged **and IG-001 + IG-002 are COMPLETE**. Owns browser/desktop/mobile computer execution and host adapters while preserving universal workflow semantics.

## Wave 4 — Events, scheduling and optimization foundations

After V2-008:

### V2-009 — Scheduling + Events + Placement
Owns trigger subscriptions, schedules, event deduplication, locality-aware placement and enable/disable semantics.

### V2-010 — Reverse Teaching
Owns converting installed workflows into human lessons and may run in parallel with V2-009/V2-011 where surfaces remain disjoint.

### V2-011 — Optimization
Owns optimization analysis and explicit proposed versions. It may replace GUI sequences with APIs, reuse workflows, parallelize safe steps, improve placement or reduce cost/reliability risk, but never silently mutates an installed version.

## Integration gates

Whenever independently developed capabilities first interact, use a dedicated integration Work Order from current `main` rather than rebasing a sibling branch. Declared gates:

- `IG-001` repository ↔ IR;
- `IG-002` IR ↔ capability/placement;
- `IG-003` compiler ↔ runs/evidence ↔ computer execution;
- `IG-004` events ↔ reverse teaching ↔ optimization;
- `IG-005` marketplace ↔ self-hosting.

## Wave 5 — Ecosystem

### V2-012 — Collaboration + Marketplace + Economics
Combines repository/versioning, execution/evidence, teaching and optimization after their implementations have merged. Entitlement never grants execution authority.

## Wave 6 — Self-hosting

### V2-013 — WorkflowOS Self-Hosted Workflow Library
Turns WorkflowOS's software-engineering, maintenance, deployment, verification and dogfooding procedures into ordinary installable workflows using the same protocol and governance boundaries.

## Dogfooding placement

Every user-facing/execution-facing Work Order has a feature-boundary experiment before completion. Every integration gate has an additional cross-feature experiment before downstream progression.

The evidence is empirical and append-only. Contract-relevant failure blocks the affected dependency subtree. Unrelated findings become targeted corrective Work Orders.

## No-rebase quality invariant

Speed is never purchased by rebasing, weakening tests, reducing dogfooding, collapsing scopes, or allowing sibling branches to depend on unmerged implementations. When a conflict surface appears, the architect either rescopes ownership into independent contracts or introduces an integration gate.

## Expected throughput

```text
W0: 1
W1: 3 parallel
W2: 2–3 parallel
IG-001 + IG-002: integration gates
W3: 1
W4: 3 parallel
W5: 1
W6: 1
IG-003..005: integration gates at composition boundaries
```
