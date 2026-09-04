# WorkflowOS Implementation Status — Operator Dashboard

> **NON-AUTHORITATIVE.** This file is an operational observability surface only. It never overrides the architecture, Work Orders, canonical machine state, dependency graph, Git history, PR state, CI, or other authoritative repository artifacts.

## Current snapshot

- **program:** V2-017 — Universal Product UX
- **current task:** T2 — Workflow-first Home
- **worker mode:** resident Z.ai worker process
- **durable identity:** task + branch + PR + exact base/head SHA
- **Z.ai session:** disposable runtime reference; not persisted here as authority
- **operator state:** durable dispatch being issued
- **current required base:** `b5e370896b1425dbf04b10bf726482b15e330bfd`
- **historical implementation:** PR #178, preserved but retired because its base predates the resident-worker process synchronization
- **next action:** create the fresh T2 worker branch/PR from the exact required base and leave the durable dispatch packet on the worker handoff issue
- **completion authority:** actual Architect-authorized Git merge followed by canonical reconciliation

## Resident worker rules

The implementation worker remains available after a review-ready checkpoint. A textual response does not terminate the worker responsibility.

A fresh session may replace a disconnected or exhausted session only by resuming the same governed task and PR from the latest durable checkpoint.

Review changes are applied to the same implementation PR; a review iteration never creates a replacement PR.

## Maintenance protocol

Update this dashboard at worker dispatch, implementation checkpoint, `CHANGES_REQUESTED`, `WAITING_FOR_ARCHITECT`, recovery/restart, merge handoff, and post-merge reconciliation.

Every update must describe only events that actually occurred. Exact branch, PR, base, head, and merge identities must be obtained from live GitHub rather than copied from stale dashboard text.
