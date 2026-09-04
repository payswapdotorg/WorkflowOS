# Resident Worker Operations

**Status:** FROZEN OPERATING ARTIFACT

This artifact records the operational mechanics for resident Z.ai implementation workers. It does not create a product authority, execution engine, or second workflow protocol.

## Durable control loop

```text
ELIGIBLE TASK
    ↓
ARCHITECT DISPATCH
    ↓
RESIDENT Z.AI WORKER
    ↓
SAME-PR CHECKPOINT
    ↓
WAITING_FOR_ARCHITECT
    ↓
REQUEST_CHANGES → SAME PR → RESUME
    ↓
APPROVE
    ↓
ARCHITECT MERGE
    ↓
POST-MERGE RECONCILIATION
    ↓
NEXT ELIGIBLE TASK
```

## Dispatch packet

Every implementation dispatch posted to GitHub must identify the repository, task, Work Order, exact base SHA, completed dependency merges, owned scope, forbidden scope, required verification, browser/system dogfooding, and worker safety boundary.

The worker must independently verify all dispatch facts before implementation. A dispatch packet cannot authorize a stale branch, inactive task, missing dependency, or contradictory authority.

## Resident session

The Z.ai session is a disposable implementation process. It may remain active after a review-ready checkpoint and monitor for new durable Architect action. The session identifier is not persisted as authoritative state.

The same Work Item/task, branch, and PR survive review iterations and session replacement.

## Review packet

Architect `REQUEST_CHANGES` decisions are durable GitHub packets tied to the exact reviewed PR head. Each finding has a stable identifier, severity, acceptance criterion, exact path where applicable, and concrete required action.

The next worker iteration must consume that packet verbatim, implement on the same PR, run validation again, and publish a new checkpoint with the new head SHA.

## Recovery

A new worker session may replace a lost/exhausted session only after verifying the latest current `main`, canonical task state, same PR, latest head, and latest review packet. No replacement PR is created solely because the session changed.

Repeated identical restart/failure conditions are escalated rather than retried indefinitely.

## Operator dashboard

`ROADMAP_STATUS.md` is an observability surface only. It records the current operational handoff and known blockers but cannot override the canonical state or Git history.
