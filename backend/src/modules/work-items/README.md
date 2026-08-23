# /work-items

**Responsibility (frozen):** Work Items, Work Item Dependencies, Work Order state.

This directory is a frozen backend module boundary (spec/architecture.md §6).
Cross-module communication must go through `index.ts`; `internal/` is private.

## WORK-027: ExecutionTask construction + deterministic prompt

`/work-items` remains the context authority and now also owns task assembly:

- `internal/execution-prompt-builder.ts` — `DefaultExecutionPromptBuilder`:
  generates the DETERMINISTIC implementation prompt (markdown + SHA-256
  digest) from the persisted `ImplementationContextContent`. Pure function:
  no timestamps, no UUIDs, no randomness — identical authoritative inputs
  produce an identical prompt (regression-tested via promptDigest equality
  across revision 1 'initial' and revision 2 'correction' executions).
- `internal/execution-task-service.ts` — `DefaultExecutionTaskService`:
  loads the Work Item + latest Work Order, builds (or reuses) the
  ImplementationContext via the EXISTING `DefaultImplementationContextBuilder`,
  resolves the project, and assembles the provider-independent `ExecutionTask`
  consumed by the `/agents` ExecutionService.
- `internal/start-implementation-service.ts` — REFACTORED (WORK-027): the
  service no longer calls the AgentGateway directly; it delegates to
  ExecutionTaskService + ExecutionService so native gateway execution lives in
  exactly ONE place (`/agents` NativeExecutionProvider). Behavior is
  unchanged: 201 + agentRunId, 502 on gateway failure, no fake AgentRun.
