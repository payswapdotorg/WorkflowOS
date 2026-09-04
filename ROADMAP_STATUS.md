# WorkflowOS Implementation Status — Operator Dashboard

> **NON-AUTHORITATIVE.** This file is an operational observability surface only. It never overrides the architecture, Work Orders, canonical machine state, dependency graph, Git history, PR state, CI, or other authoritative repository artifacts.

## Current snapshot

- **program:** V2-017 — Universal Product UX
- **current task:** T2 — Workflow-first Home
- **worker mode:** resident Z.ai worker process
- **durable identity:** task + branch + PR + exact base/head SHA
- **Z.ai session:** disposable runtime reference; not persisted here as authority
- **operator state:** dispatch checkpoint recorded; live `main` must be re-read before worker execution
- **dispatch policy:** exact implementation base is the live `main` SHA observed immediately before creating the implementation PR
- **historical implementation:** PR #178, preserved as historical evidence and retired from the active implementation path
- **next action:** create exactly one fresh T2 implementation PR from the live verified base and keep the resident worker on that PR through review iterations
- **completion authority:** actual Architect-authorized Git merge followed by canonical reconciliation

## Resident worker rules

The implementation worker remains available after a review-ready checkpoint. A textual response does not terminate the worker responsibility.

A fresh session may replace a disconnected or exhausted session only by resuming the same governed task and PR from the latest durable checkpoint.

Review changes are applied to the same implementation PR; a review iteration never creates a replacement PR.

## Maintenance protocol

Update this dashboard at worker dispatch, implementation checkpoint, `CHANGES_REQUESTED`, `WAITING_FOR_ARCHITECT`, recovery/restart, merge handoff, and post-merge reconciliation.

Every update must describe only events that actually occurred. Exact branch, PR, base, head, and merge identities must be obtained from live GitHub rather than copied from stale dashboard text.
