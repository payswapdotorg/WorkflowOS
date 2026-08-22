# Z.ai Implementation Prompt — WORK-012

You are the implementation agent for WorkflowOS work item WORK-012 — Agent Gateway and Agent Runs.

Work only on WORK-012. Do not redesign the architecture or implement later work items.

## Authoritative documents

Read from `main` before modifying code:

- `/spec/architecture.md`
- `/spec/architecture-lock.md`
- `/spec/requirements.md`
- `/spec/work-items.md`
- `/spec/dependency-graph.md`

Inspect the current implementation, especially:

- `backend/src/modules/agents/`
- `backend/src/modules/work-items/`
- `backend/src/modules/workflows/`
- `backend/src/modules/llm/`
- `backend/src/modules/github/`
- `backend/src/platform/`
- `backend/tests/`
- `.github/workflows/`

Pay particular attention to WORK-007 Work Item/Work Order contracts, WORK-009 Workflow Engine, WORK-010/merged LLM Gateway, SecretStore, PostgreSQL, ObjectStore, Redis Queue/WorkerHost, execution/correlation IDs, static architecture checks, authorization, tenant isolation, and CI conventions.

Do not modify frozen specification documents.

## Objective

Implement the provider-independent `/agents` boundary and persistent Agent Run model required by the frozen architecture.

Requirements:

- AGENT-001 — Execute implementation agents through a provider-independent Agent Gateway.
- AGENT-002 — Persist Agent Runs, execution metadata, outputs, commits/PRs, tests, and blockers.

Dependencies:

- WORK-007 — complete
- WORK-010/LLM Gateway — complete
- DATA-003 — complete
- SEC-001 — complete

Do not implement full workflow orchestration, verification, architect review, Work Order generation, or later work items.

## Architectural boundaries

Frozen ownership:

- `/work-items` owns Work Item + Work Order.
- `/workflows` owns canonical workflow state.
- `/llm` owns LLM Gateway.
- `/agents` owns Agent Gateway + Agent Runs.
- `/github` owns GitHub provider behavior.
- `/verification` will later own verification semantics.

Agent execution is distinct from LLM execution. A provider-specific agent implementation must remain inside `/agents/internal`. No other domain module may import agent-provider SDKs or concrete agent implementations.

Do not merge Agent Gateway and LLM Gateway into one abstraction.

## Agent Gateway contract

Expose a provider-independent `/agents` application contract including, at minimum:

- `AgentGateway`
- `AgentRequest`
- `AgentExecutionResult`
- `AgentError`
- `AgentStatus`

The gateway must support provider/agent selection, agent configuration, Work Item reference, Work Order reference, ArchitectureVersion where required, execution/correlation ID, repository context/reference where required, normalized input, normalized result, and normalized errors.

Consumers must not need to know whether the implementation agent is Z.ai, Gemini, Codex, Claude-based, another API agent, or local/manual.

Do not expose provider-specific SDK request/response types through the public `/agents` barrel.

## Adapter boundary

Implement:

```text
AgentGateway
     ↓
AgentAdapter
     ↓
provider-specific adapters
```

Provider-specific implementations belong under `/agents/internal`.

Concrete providers may be constructed by the composition root, but the public barrel should expose only provider-independent types/interfaces and the module contract.

## Agent request and result

An AgentRequest should support at least:

- provider
- agent configuration
- Work Item ID
- Work Order ID
- ArchitectureVersion ID where required
- execution/correlation ID
- repository context/reference where required
- Work Order constraints/scope
- normalized provider-independent input

Provider-specific configuration must not leak into domain modules.

Normalize results into a provider-independent structure containing, at minimum:

- status
- output
- startedAt
- completedAt
- executionId
- provider
- configuration metadata
- commit/reference
- pull request/reference
- reported tests
- reported blockers
- normalized error classification
- provider-neutral metadata

Agent output is claim/evidence input only. It must not:

- mark requirements PASS;
- mark criteria PASS;
- mark Work Item VERIFIED;
- directly mutate canonical workflow state;
- bypass `/workflows`;
- bypass verification/review.

## Agent Run domain

Every implementation-agent interaction must create an Agent Run in PostgreSQL.

Persist at least:

- stable ID
- provider
- configuration
- Work Item
- Work Order
- execution status
- start/completion time
- output
- referenced commit
- pull request
- reported tests
- reported blockers
- execution metadata

Use exact architecture-defined status semantics. Do not invent a large state machine.

Large immutable output may use the existing ObjectStore abstraction, with PostgreSQL retaining durable metadata/references.

## Traceability and tenant isolation

An Agent Run must be tied to an existing Work Item and Work Order:

```text
Agent Run
  ↓
Work Item
  ↓
ArchitectureVersion
  ↓
Architecture
  ↓
Project
  ↓
Organization
```

Reuse the existing authorization boundary. Test that authorized User A can access only their tenant's Agent Runs, cross-tenant identifiers fail, and an Agent Run cannot be created for another tenant's Work Item/Work Order.

Do not create a new permission hierarchy.

## Secret management

Reuse the existing `SecretStore`.

Provider credentials must never be stored as Agent Run fields, appear in Agent Run output, logs, API responses, or ordinary domain records.

Agent adapters may access credentials only through the existing secret abstraction.

Do not create another secret-management system.

## GitHub and Work Item PR references

Agents may report commits, branches, pull requests, and repository references, but `/agents` must not own GitHub state or import GitHub provider SDKs.

Use the existing `/work-items` PR association contract where persistence is required. Do not create another PR model.

Do not implement GitHub calls unless strictly required by the provider-independent agent contract.

## Workflow authority

The Agent Gateway must never mutate canonical workflow state.

The correct boundary is:

```text
Agent
  ↓
AgentExecutionResult
  ↓
/workflows
  ↓
authorized canonical transition
```

Agent execution status is not workflow state.

Static checks must ensure `/agents` does not define `WorkflowState`, update workflow execution persistence, invoke workflow internals, or export workflow authority.

## Work Order state

`/work-items` remains authoritative for Work Order state. Agents may consume/reference the Work Order but must not define or mutate Work Order state.

## LLM boundary

If an agent provider internally uses an LLM, keep that provider-specific behavior behind the Agent Gateway. Do not bypass or merge the `/llm` boundary.

## Asynchronous execution

Agent execution is long-running. Reuse the existing WORK-001/WORK-003 Redis Queue + WorkerHost.

Required conceptual flow:

```text
API/request
    ↓
create Agent Run
    ↓
enqueue agent job
    ↓
Redis
    ↓
WorkerHost
    ↓
Agent Gateway
    ↓
provider adapter
    ↓
AgentExecutionResult
    ↓
persist Agent Run
```

The initial request must return without waiting for the long-running agent to finish.

PostgreSQL is authoritative for Agent Run state; Redis is only transport/coordination.

## Retry, failure, idempotency

Normalize provider failures, including retryable, non-retryable, authentication, rate-limit, invalid-request, provider-unavailable, execution-failed, and cancellation/blocked cases where defined by the architecture.

Use architecture-defined categories; do not invent unnecessary states.

Centralize retry policy at the appropriate Agent Gateway boundary rather than duplicating loops across adapters.

Persist retry/error metadata where required.

Durably identify logical executions. Repeated submission of the same logical execution must not create contradictory authoritative records. If attempts are modeled, represent them explicitly rather than overwriting history.

## Persistence

Reuse:

- `DatabaseClient`
- migration runner
- existing `Infrastructure`
- SecretStore
- ObjectStore
- Redis Queue/WorkerHost
- execution/correlation ID infrastructure

Do not create another database client, worker system, secret store, artifact system, DI container, or workflow state store.

Use PostgreSQL constraints for Work Item/Work Order references, valid Agent Run status, tenant integrity, and execution identity/idempotency where applicable.

## API

Implement only enough API/application surface to verify WORK-012:

- create/request an Agent Run;
- retrieve an Agent Run;
- observe execution status/result;
- demonstrate asynchronous execution.

All API access must be backend-authorized.

Do not expose arbitrary workflow-state mutation or provider-specific SDK controls.

## Static architecture checks

Ensure:

- only `/agents` imports agent-provider SDKs;
- provider-specific implementations remain under `/agents/internal`;
- concrete providers are not exported through the public barrel unless strictly required;
- no other module imports `/agents/internal`;
- `/agents` does not import GitHub provider SDKs;
- `/agents` does not define workflow state;
- `/agents` does not own Work Order state;
- `/agents` does not own verification semantics;
- `/agents` does not create database/Redis/worker infrastructure;
- `/agents` uses existing SecretStore;
- Agent output cannot directly mutate workflow/verification state;
- existing WORK-001 through WORK-010 checks remain intact.

## Required tests

### Gateway contract

Test provider selection, normalized AgentRequest/AgentExecutionResult, unsupported-provider rejection, and provider-independent types hiding implementation details.

### Provider adapter

For every implemented adapter/fake, test success, failure classification, retryable/non-retryable failure, SecretStore credential access, and absence of provider-specific types from public interfaces. Use deterministic fakes for CI; do not require live provider credentials unless already supported.

### Agent Run persistence

Test creation, Work Item/Work Order references, provider/configuration, status, timestamps, output, commit, PR, reported tests, blockers, execution metadata, and durable errors.

### Async execution

Prove request → Agent Run created → queued → worker execution → result persisted. The initial request must return before long-running execution completes. Reuse the existing worker system.

### Retry/failure

Test retryable failures retry, non-retryable failures do not, retry metadata persists, and terminal failures remain durable.

### Tenant isolation

Test cross-tenant read/create attempts fail and credentials never become tenant-visible.

### Secret safety

Test raw credentials are absent from Agent Runs, logs, and API responses and that SecretStore is the only credential access mechanism.

### Workflow authority

Test completing an Agent Run does not mutate canonical workflow state by itself and no Agent API accepts workflow state.

### Object storage

Where applicable, test large Agent output through the existing ObjectStore with durable PostgreSQL references.

### Regression

All WORK-001 through WORK-010 tests must continue to pass. Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

## Out of scope

Do NOT implement:

- Work Order generation
- Architect Service
- Architect Reviews
- Verification Engine
- CI ingestion
- GitHub integration changes
- canonical workflow-state mutations
- frontend
- notifications
- deployment
- WORK-014 or later

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

## Definition of done

WORK-012 is complete only when `/agents` exposes a provider-independent Agent Gateway; providers are adapter-isolated; SDK/types do not leak; every implementation-agent interaction creates a durable Agent Run; required execution/output/commit/PR/test/blocker metadata is persisted; Agent Runs link to existing Work Items and Work Orders; long-running execution is asynchronous via existing workers; failures and retries are normalized and durable; large outputs can reuse ObjectStore; credentials use SecretStore and never appear in logs/persistence/API; tenant isolation holds; agent output cannot directly mutate workflow or verification state; `/workflows` remains canonical workflow-state owner; `/work-items` remains Work Order owner; no duplicate infrastructure is introduced; static checks, all WORK-012 tests, regression tests, typecheck, lint, and CI pass; frozen specs remain unchanged; no WORK-014+ functionality is introduced.

## Failure / escalation

If frozen Agent Gateway requirements are ambiguous or contradictory:

`ARCHITECTURE_BLOCKER`

If implementation requires changing frozen architecture:

`ARCHITECTURE_CHANGE_REQUIRED`

If required authorization or secret-management behavior cannot be satisfied using existing frozen contracts:

`IMPLEMENTATION_BLOCKED`

Do not silently invent new architecture.

## Final agent response

Return:

```text
WORK-012 COMPLETE

Implementation summary:
Tests/evidence:
Files changed:
Agent Gateway/provider evidence:
Agent Run evidence:
Tenant-isolation/security evidence:
Workflow-authority evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.