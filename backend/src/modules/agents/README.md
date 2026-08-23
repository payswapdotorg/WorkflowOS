# /agents

**Responsibility (frozen):** Agent Gateway and Agent Runs.

This directory is a frozen backend module boundary (spec/architecture.md §6).
Cross-module communication must go through `index.ts`; `internal/` is private.

## WORK-027: Execution provider abstraction

`/agents` owns the provider-independent execution boundary (one Work Order, two
execution modes — the mode is an implementation detail):

- `internal/execution.types.ts` — public contract types (exported as types
  through the barrel): `ExecutionMode`, `ExecutionState` (9 execution-record
  states — a SEPARATE state machine from the /workflows workflow states),
  `ExecutionTask`, `ExecutionSubmission`, `ExecutionProvider`,
  `ExternalExecutionPackage`, record/event/handoff repository + service types.
- `internal/native-execution-provider.ts` — `NativeExecutionProvider`: adapts
  the EXISTING AgentGateway behind the provider boundary. The single native
  execution path (no second gateway, no duplicated execution).
- `internal/external-execution-provider.ts` — `ExternalExecutionProvider`:
  generates a deterministic, secret-free `ExternalExecutionPackage` and returns
  `handoff_ready`. It executes NOTHING and contains no Z.ai/ChatGPT/Claude
  adapters, URLs, or DOM automation (WORK-028/029).
- `internal/execution-service.ts` — `DefaultExecutionService`: creates the
  execution record, dispatches to the mode-matching provider, persists the
  outcome, and emits `EXECUTION_*` audit events via `/audit`.
- `internal/execution-handoff-service.ts` — `DefaultExecutionHandoffService`:
  issues + redeems ONE-TIME, short-lived, project-scoped handoff tokens
  (SHA-256 hashed at rest; lazy execution expiry with `EXECUTION_EXPIRED`).
- `internal/execution-callback-service.ts` (PR #30 review fix #2) —
  `DefaultExecutionCallbackService`: issues + validates SCOPED event-ingestion
  callback credentials (`wfct_` prefix, SHA-256 hashed at rest, short-lived,
  capped at the execution handoff window). Scoped to EXACTLY ONE execution and
  to event ingestion ONLY — only `POST /execution/:id/events` reads
  `x-callback-token`, so the token grants no other capability (no project
  reads, no package reads, no workflow/verification/review mutation). Multi-use
  by design (started → progress → completed); per-event idempotency is enforced
  via `idempotencyKey`. The Companion extension never needs the user's
  WorkflowOS API key.
- `internal/execution-event-ingestion-service.ts` — external result ingestion
  (`started|progress|completed|failed`): updates ONLY the execution record.
  It NEVER mutates workflow/verification/review state, and native executions
  reject events (AgentGateway owns native run state).
- `internal/pg-execution-repository.ts` — PostgreSQL persistence for
  `wfos_executions` / `wfos_execution_events` / `wfos_execution_handoffs`.
- `internal/agent-provider-registry.types.ts` — extended with
  `ExecutionProviderInfo` + the `EXTERNAL_UI_CATALOG` (Z.ai / ChatGPT /
  Claude; display + validation metadata only — no credentials, no URLs).

Authority rules enforced statically (tests/architecture): execution files never
import `/workflows`, `/verification`, `/reviews`, or reference workflow
tables; the external package declares no secret-shaped fields; the external
provider never reads the SecretStore; handoff tokens are hashed + one-time.
