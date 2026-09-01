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

**Why parallel:** each item consumes the already-merged V2-001 protocol contract. None requires another item's implementation. The implementation must be scoped so the repository/version model does not also define the IR internals, and the node model does not define platform-specific workflow semantics.

## Wave 2 — Execution foundation

After Wave 1 is merged, create:

### V2-005 — Workflow Runs + Evidence
An integration-heavy Work Order combining merged repository/versioning, IR and capability contracts. Owns Run lifecycle, evidence, pause/resume, idempotency, correlation and execution history.

### V2-006 — Teaching Sessions
Can run **in parallel with V2-005 only if its branch uses the already-merged contracts from Wave 1 and has no V2-005 implementation dependency**. It owns TeachingSession, learner state, explanations, practice and teaching evidence.

### V2-007 — Workflow Compiler
Can begin from the merged V2-003 IR and V2-005 **contract**, but must not depend on V2-005's unmerged implementation. If run-time execution semantics are required, its final integration gate waits for V2-005.

This means the preferred Wave 2 arrangement is:

```text
V2-005A Run contract + lifecycle      ─┐
V2-006  Teaching sessions              ├─ parallel where surfaces stay disjoint
V2-007  Compiler core                  ─┘
                    ↓
              integration gate
```

If V2-007 would need to modify V2-005 files, it becomes a sequential implementation dependency rather than forcing rebases.

## Wave 3 — Computer execution

### V2-008 — Computer-Agent Runtime
Consumes merged IR, Run/Evidence contracts, and Node/Capability protocol. It owns browser/desktop/mobile computer-agent execution and host adapters. No second workflow protocol is allowed.

V2-008 is deliberately delayed until the stable contracts exist because computer-agent behavior is the highest-risk execution surface.

## Wave 4 — Events, scheduling and optimization foundations

After V2-008:

### V2-009 — Scheduling + Events + Placement
Owns trigger subscriptions, schedules, event deduplication, locality-aware placement and enable/disable semantics.

### V2-011 — Optimization
Can be implemented in parallel with V2-009 because it consumes the stable IR and Run/Evidence contracts and does not need the scheduler implementation. It owns analysis and proposed new versions, never silent mutation.

### V2-010 — Reverse Teaching
Can be implemented in parallel with V2-009/V2-011 if it consumes merged Teaching + Computer-Agent contracts and has disjoint surfaces. It owns converting workflows into human lessons.

## Wave 5 — Ecosystem

### V2-012 — Collaboration + Marketplace + Economics
Integration Work Order. It combines repository/versioning, execution/evidence, teaching and optimization. It should not begin until the required upstream implementations are merged, so the integration is tested against real artifacts rather than speculative branches.

## Wave 6 — Self-hosting

### V2-013 — WorkflowOS Self-Hosted Workflow Library
Consumes the mature runtime, scheduling and marketplace capabilities. Turns WorkflowOS's software-engineering, maintenance, deployment and dogfooding procedures into installable workflows.

## Cross-wave integration rule

Whenever independently developed capabilities first interact, create a small integration gate rather than rebasing one implementation branch onto another.

Examples:

- repository + IR round-trip;
- IR + capability placement;
- run + evidence + computer agent;
- event trigger + run idempotency;
- teaching + installed workflow;
- optimizer + immutable versioning;
- marketplace + entitlement + execution;
- self-hosting + development governance.

## Dogfooding placement

Every user-facing/execution-facing Work Order has a feature-boundary dogfood before completion. Integration Work Orders get an additional cross-feature dogfood.

A feature dogfood validates the isolated capability. An integration dogfood validates composition. This creates fast feedback without postponing integrated testing until the end of the roadmap.

## No-rebase quality invariant

Speed is never purchased by rebasing, weakening tests, reducing dogfooding, collapsing scopes, or allowing sibling branches to depend on unmerged implementations. When a conflict surface appears, the architect either rescopes the work into independent contracts or introduces a deliberate integration Work Order.

## Expected throughput

The optimized roadmap targets roughly:

```text
Wave 0:        1
Wave 1:        3 parallel
Wave 2:        2–3 parallel + integration
Wave 3:        1
Wave 4:        3 parallel
Wave 5:        1
Wave 6:        1
```

This is intentionally more parallel than the original sequence, while preserving hard implementation dependencies and adding integration/dogfooding gates where interactions become real.
