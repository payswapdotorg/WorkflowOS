# Resident Worker Operations

**Status:** FROZEN OPERATING ARTIFACT

This artifact records the operational mechanics for the persistent Z.ai orchestrator and its disposable specialist agents. It does not create a product authority, execution engine, or second workflow protocol.

## Core model

```text
ARCHITECT
    ↓
PERSISTENT Z.AI ORCHESTRATOR
    ↓
┌────────────┬────────────┬────────────┐
│ SLOT A     │ SLOT B     │ SLOT C     │
│ implement  │ implement  │ verify /   │
│ or repair  │ or browser │ sync /repair│
└────────────┴────────────┴────────────┘
    ↓
GitHub PRs + durable evidence
    ↓
ARCHITECT REVIEW / MERGE
    ↓
POST-MERGE RECONCILIATION
    ↓
NEXT ELIGIBLE FRONTIER
```

The scheduler has a hard maximum of **3 concurrent specialist agents**. Architect review does not consume a specialist slot while a PR is merely awaiting review.

## Durable control loop

```text
ELIGIBLE WORK ORDER
    ↓
ORCHESTRATOR DISPATCH
    ↓
SPECIALIST IMPLEMENTATION
    ↓
VERIFY + DOGFOOD
    ↓
PR CHECKPOINT
    ↓
SYNCHRONIZE AUTOMATICALLY WHEN MAIN MOVES
    ↓
REVERIFY EXACT HEAD
    ↓
READY_FOR_ARCHITECT_REVIEW
    ↓
ARCHITECT DECISION
    ├── MERGE → RECONCILE → RECOMPUTE FRONTIER
    └── REQUEST_CHANGES → SAME PR → REPAIR → REVERIFY → RESUBMIT
```

## Dispatch packet

Every implementation dispatch posted to GitHub must identify the repository, Work Order, exact base SHA, completed dependencies, owned scope, forbidden scope, required verification, required browser/system dogfooding, one-PR rule, and worker safety boundary.

The orchestrator and specialist must independently verify these facts against repository authority and live GitHub before modifying code.

## Parallelism and synchronization

Parallel Work Orders are independently mergeable and may share the same stable `main` base. No sibling consumes an unmerged sibling.

When any merged PR advances `main`, the orchestrator MUST:

1. detect every in-flight PR whose base is stale;
2. allocate synchronization work within the three-slot limit;
3. refresh the affected branch against current `main` on the **same PR branch**;
4. resolve only mechanical conflicts within the Work Order's scope;
5. stop and surface semantic, authority, or scope conflicts to the Architect;
6. rerun the complete required verification/dogfooding after the branch head changes;
7. invalidate any prior review-ready event and emit a new one only when all review prerequisites hold.

The user/operator is never the routine synchronization mechanism. A worker may not ask the user to rebase a sibling branch.

## Review packet

Architect `REQUEST_CHANGES` decisions are durable GitHub packets tied to the exact reviewed PR head. Each finding has a stable identifier, severity, acceptance criterion, exact path where applicable, and concrete required action.

Review work remains on the same PR. A replacement PR for the same Work Order is prohibited.

## Review-ready event

Only an exact-head `READY_FOR_ARCHITECT_REVIEW` event may enter the Architect review queue. It must bind:

- Work Order ID;
- PR number;
- exact PR head SHA;
- exact current `main` SHA;
- verification result;
- required evidence locations;
- synchronization status;
- event timestamp/status.

Any head change, `main` advancement, material evidence change, Architect `REQUEST_CHANGES`, or scope change invalidates the event.

## Recovery

A new worker session resumes from durable repository evidence:

```text
current main
   ↓
autonomous execution state
   ↓
selected Work Order
   ↓
same PR / same branch
   ↓
latest committed head
   ↓
latest review packet
   ↓
latest verification + dogfooding evidence
```

A session ending never authorizes a replacement PR. Repeated identical failures are escalated rather than looped indefinitely.

## Completion boundary

Worker completion means review-ready. Work Order completion requires Architect acceptance and actual Git merge, followed by deterministic reconciliation.
