# WORK-034 Slice 2 — Session-Aware Execution Design

**Status:** Approved in chat; formalized for implementation planning
**Date:** 2026-08-24

## Goal

Extend the existing `/agents` execution authority so an `ExecutionSession` can start, resume, interrupt, and terminally complete an existing `ExecutionRecord` without introducing a second execution engine or changing workflow/verification/review authority.

## Architecture

`ExecutionSession` is durable continuation context for exactly one existing `ExecutionRecord`. The session layer is composed into the existing `/agents` `ExecutionService` boundary; provider implementations remain unchanged in this slice.

```text
WorkItem
  ↓
WorkOrder
  ↓
ExecutionRecord
  ↓
ExecutionSession
  ↓
existing ExecutionService
  ↓
existing ExecutionProvider
```

Creating or resuming a session MUST NOT create another execution record. Session identity remains the same `executionId`.

## Scope

This slice implements only the session-to-execution orchestration seam:

- session start/resume/interrupt/terminal operations through the existing `/agents` execution boundary;
- idempotent reuse of the existing `ExecutionRecord`;
- concurrency-safe session/execution coordination;
- durable session lifecycle evidence through the existing session event store.

This slice does NOT implement multi-turn model execution, tool runtime, workspaces, permissions, cross-mode handoff, adaptive routing, provider-specific session APIs, or frontend session UX.

## Authority Boundaries

- `/agents` remains the sole execution authority.
- `ExecutionSession` does not become a second workflow engine.
- Session state MUST NOT mutate Work Item workflow state directly.
- Session state MUST NOT declare verification, review, approval, merge, or VERIFIED outcomes.
- Existing `ExecutionProvider` implementations remain the provider boundary.
- Existing `ExecutionRecord` remains the execution identity and provider submission record.

## Session/Execution Semantics

A session is associated with exactly one existing execution:

```text
session.executionId === execution.id
```

Start/resume operations operate on that execution identity. They must be safe under concurrent callers and must never create a second logical execution for the same session.

The session state machine established by Slice 1 remains authoritative:

```text
created → running
running → interrupted → running
running → completed | failed | cancelled
created | interrupted → cancelled
```

All transitions remain repository-level CAS transitions.

## Failure and Concurrency Requirements

- Concurrent session starts/resumes have exactly one winning state transition.
- A stale caller receives a typed conflict/null result and performs no provider side effect.
- A crash between session state advancement and provider submission MUST NOT cause creation of a second execution identity.
- Provider submission remains idempotent on the existing execution identity.
- Terminal session state cannot trigger further provider execution.
- Provider outcomes remain execution outcomes; session orchestration cannot reinterpret them as workflow/verification truth.

## Testing Requirements

The implementation must cover:

1. session start uses the existing ExecutionRecord;
2. session resume uses the same ExecutionRecord;
3. concurrent start/resume has one winner;
4. repeated provider submission uses the same execution identity;
5. interrupt/resume preserves execution linkage;
6. terminal session prevents further provider/execution mutation;
7. provider outcome remains execution authority;
8. no second execution record is created under retries/concurrency.

Static architecture tests must prevent a second execution engine/ExecutionService and direct workflow/verification/review mutation from the session layer.
