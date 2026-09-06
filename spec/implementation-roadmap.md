# WorkflowOS Implementation Roadmap

**Status:** FROZEN GOVERNANCE ARTIFACT

**Purpose:** Human-readable implementation sequencing, progress, recovery, and handoff surface.

**Machine counterparts:**
- `spec/development-state/v2-work-order-state.json` — V2 historical/base Work Order state through V2-017
- `spec/development-state/v2-autonomous-execution-state.json` — governed post-W6 execution frontier, scheduling, synchronization, and review queue
- `spec/development-state/program-state.json` — V1/V1.1 Work Order operational state
- `spec/development-state/implementation-state.json` — V2-017 task-level operational state
- `docs/implementation/RESIDENT-ZAI-WORKER-PROTOCOL.md` — resident worker safety protocol
- `spec/development-state/resident-worker-operations.md` — autonomous worker/orchestrator operations

**Important:** This roadmap is the human-readable progress surface. It never overrides architecture locks, Work Orders, dependency declarations, or actual Git history. For post-W6 V2 work, the autonomous execution overlay is the active eligibility/scheduling projection over the governed Work Orders; merge truth remains GitHub.

## Zero-history operating rule

A fresh Architect or implementation agent must be able to determine the current implementation position without conversation history:

```text
actual Git main
    ↓
this roadmap
    ↓
V2 base Work Order state + autonomous execution overlay
    ↓
selected Work Order / dependency map
    ↓
open + merged PR evidence
    ↓
exact verification + persisted dogfooding evidence
    ↓
recompute eligible frontier
```

Conversation history, agent memory, pasted reports, provider sessions, stale checkboxes, and unstored assumptions are non-authoritative.

## V2-017 completion

V2-017 Universal Product UX is complete. T1–T16 are closed as a product program. This completion does **not** mean the overall V2 program is finished.

## Active post-W6 V2 program

The current forward frontier is the pre-deployment reality gate and its bounded accepted repairs:

```text
V2-017 COMPLETE
      ↓
REALITY AUDIT R0–R4 COMPLETE
      ↓
REALITY-REPAIR-001
      ↓
REALITY-REPAIR-002
      ↓
REALITY-REPAIR-003
      ├───────────────┬───────────────┬───────────────┐
      ▼               ▼               ▼               ▼
REPAIR-004        REPAIR-005       REPAIR-006       REPAIR-007
      │               │               │               │
      └───────────────┴───────────────┴───────────────┘
              + REPAIR-008 + REPAIR-009
                            ↓
                    R6 FULL RE-AUDIT
                            ↓
                    R7 ARCHITECT GATE
                            ↓
                    DEP-001 … DEP-012
```

Execution topology, exact dependencies, three-slot parallelism, automatic branch synchronization, and Architect review readiness are governed by `spec/architecture/v2/V2-AUTONOMOUS-DELIVERY-ROADMAP.md` and `spec/development-state/v2-autonomous-execution-state.json`.

## Parallel execution invariant

Independent packets may run concurrently up to the three-specialist ceiling. Sibling branches never consume one another's unmerged commits. When `main` advances, the autonomous orchestrator synchronizes affected branches itself, reruns required verification, and invalidates/reissues review readiness as necessary. Manual rebase prompts are not part of the operating model.

## Architect review invariant

A review is requested only when the exact PR head is review-ready: implementation complete, verification complete, required evidence persisted, required browser proof complete when applicable, branch synchronized to current `main`, no pending repair/synchronization work, and no scope/architecture drift. The durable review event records the Work Order, PR, exact head SHA, current main SHA, and evidence. A head change invalidates the review event.

## V1/V1.1 boundary

Remaining V1/V1.1 work is deferred by default and is not an implicit dependency of the current V2 frontier. Legacy PRs remain separately governed and must not be treated as V2 execution signals.
