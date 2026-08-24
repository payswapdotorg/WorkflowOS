# WORK-034 Persistent Agent Sessions — Implementation Design

## Status

Design artifact for WORK-034 only. The authoritative product requirements remain `spec/work-items.md`, `spec/architecture-lock.md`, and `spec/dependency-graph.md`.

## Goal

Evolve the existing `/agents` request/result execution boundary into durable, resumable Agent Sessions while preserving one logical `ExecutionRecord` identity across native and external execution.

## Frozen Requirements Implemented by This Design

WORK-034 requires:

- resumable Agent Sessions;
- turns;
- tool calls;
- observations;
- checkpoints;
- interruptions;
- terminal outcomes;
- native and external execution as first-class modes;
- the same logical execution identity for both modes.

The already-landed persistent session core provides the durable session/state/event foundation. This design covers the missing integration with the existing execution lifecycle.

## Authority Boundary

`/agents` remains the sole execution authority.

The existing `ExecutionService` remains the only entry point that dispatches an `ExecutionTask` to an `ExecutionProvider`.

`ExecutionSession` is continuation state for exactly one existing `ExecutionRecord`:

```text
WorkItem
  -> WorkOrder
    -> ExecutionRecord
      -> ExecutionSession
        -> session events / turns / observations
```

The session layer MUST NOT own:

- Work Item workflow state;
- Work Order state;
- verification state;
- review state;
- GitHub truth;
- provider registries;
- provider-specific execution implementations;
- a second scheduler or execution engine.

## Execution Relationship

An execution begins with one `ExecutionRecord`. A session may be created for that execution and resumed later. The session's `executionId` never changes.

Native and external providers remain behind the existing `ExecutionProvider` interface. Session state is provider-independent and is persisted identically for both modes.

The session integration must NOT create a second `ExecutionRecord` when resuming. The same execution identity is reused.

## Lifecycle

The session integration must support this governed relationship:

```text
ExecutionRecord
    |
    +--> ExecutionSession(created)
             |
             +--> running
             |     +--> turns/events/observations/checkpoints
             |
             +--> interrupted
             |     |
             |     +--> running
             |
             +--> completed / failed / cancelled
```

Session terminal state must never imply WorkflowOS `VERIFIED`, `APPROVED`, or `MERGED`. Those remain owned by existing authorities.

## Resume Semantics

Resume is idempotent and CAS-protected. Only one concurrent caller may successfully transition an `interrupted` session back to `running` for a given version.

A resume must continue the same `ExecutionRecord`. It must never create a second logical execution or mutate workflow state directly.

## Provider Semantics

Native execution continues through the existing `NativeExecutionProvider`.

External execution continues through the existing `ExternalExecutionProvider` and companion/handoff boundary.

This design does not implement cross-mode handoff; that belongs to WORK-042. The session identity model must nevertheless remain compatible with future handoff by keeping one stable `executionId` and session identity.

## Event Semantics

The existing session event store is append-only. Integration code records session lifecycle/turn information around execution activity but does not rewrite history.

Provider-specific raw implementation remains behind provider boundaries. Session events contain provider-independent structured observations and safe metadata only.

## Crash / Concurrency Requirements

- Session transitions use repository CAS.
- Resume cannot create duplicate execution records.
- A duplicate start/resume attempt loses the CAS and produces no second logical transition.
- Terminal sessions cannot be resumed or mutated.
- Execution provider outcomes remain authoritative for execution completion/failure.
- Session persistence failure must not be converted into a false execution success.

## Scope

This design intentionally excludes WORK-035 workspace/worktree management, WORK-036 tool runtime, WORK-037 permissions, and WORK-042 cross-mode handoff.

## Verification

Implementation must include:

- unit/integration coverage for native session start/resume;
- external session start/resume through the existing provider boundary;
- concurrent start/resume CAS tests;
- same-ExecutionRecord identity assertions;
- interruption/resume tests;
- provider outcome to terminal session tests;
- regression coverage proving workflow/verification/review authorities remain untouched;
- static architecture checks preventing a second execution engine/provider path.
