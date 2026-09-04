# WorkflowOS Implementation Status — Operator Dashboard

> **NON-AUTHORITATIVE.** This file is an operational observability surface only. It never overrides the architecture, Work Orders, canonical machine state, dependency graph, Git history, PR state, CI, or other authoritative repository artifacts.

## Current snapshot

- **program:** V2-017 — Universal Product UX
- **current task:** T2 — Workflow-first Home
- **worker mode:** resident Z.ai worker process
- **durable identity:** task + branch + PR + exact base/head SHA
- **Z.ai session:** disposable runtime reference; not persisted here as authority
- **operator state:** ready for live dispatch verification
- **base policy:** re-read live `main` immediately before dispatch; no stored dashboard SHA is authoritative
- **historical implementation:** PR #178, preserved but retired because it predates the resident-worker process alignment
- **next action:** retire/close the historical PR #178, then issue the durable T2 dispatch packet against the exact live `main` SHA and create one fresh implementation PR from that base
- **completion authority:** actual Architect-authorized Git merge followed by canonical reconciliation

## Resident worker rules

The implementation worker remains available after a review-ready checkpoint. A textual response does not terminate the worker responsibility.

A fresh session may replace a disconnected or exhausted session only by resuming the same governed task and PR from the latest durable checkpoint.

Review changes are applied to the same implementation PR; a review iteration never creates a replacement PR.

## Maintenance protocol

Update this dashboard at worker dispatch, implementation checkpoint, `CHANGES_REQUESTED`, `WAITING_FOR_ARCHITECT`, recovery/restart, merge handoff, and post-merge reconciliation.

Every update must describe only events that actually occurred. Exact branch, PR, base, head, and merge identities must be obtained from live GitHub rather than copied from stale dashboard text.
