# Step 2 — Generate Coding-Agent Prompt for WORK-009

You are the implementation agent for **WorkflowOS work item WORK-009 — Workflow engine and canonical state machine**.

Work only on WORK-009. Do not redesign the architecture or implement later work items.

## AUTHORITATIVE INPUTS

Before modifying code, read from `main`:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

Also inspect the current implementation, especially:

```text
backend/src/modules/workflows/
backend/src/modules/work-items/
backend/src/modules/requirements/
backend/src/modules/architecture/
backend/src/modules/github/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to the merged WORK-001 through WORK-008 foundations, existing authorization/tenant isolation, PostgreSQL persistence, Redis Queue/WorkerHost, module public-interface conventions, and static architecture checks.

The frozen architecture documents are authoritative and must not be modified.

# WORK ITEM

**WORK-009 — Workflow engine and canonical state machine**

## Objective

Implement the authoritative `/workflows` domain and canonical WorkflowOS state machine.

The Workflow Engine becomes the exclusive owner of canonical workflow state. It enforces the frozen lifecycle, correction/failure/blocking paths, architecture-change escalation, dependency eligibility, concurrency safety, durable state history, and transition idempotency.

## Requirements

- **WORKFLOW-001** — Implement the canonical Workflow State Machine.
- **WORKFLOW-002** — Enforce legal state transitions centrally.
- **WORKFLOW-003** — Persist workflow execution/state history and prevent conflicting transitions.
- **WORKFLOW-004** — Support correction/retry/blocking/architecture-change escalation semantics.
- **WORKFLOW-005** — Ensure workflow transitions are backend-authoritative and cannot be owned by frontend, GitHub, LLM, agent, verification, or review modules.

## Dependencies

- WORK-007 — complete
- WORK-008 — complete

Do not implement the full LLM Gateway, Agent Gateway execution, Verification Engine semantics, Architect Review semantics, or move Work Order ownership out of `/work-items`.

# CRITICAL STATE-MACHINE AUTHORITY

`/workflows` is the **exclusive owner of canonical workflow state**.

No other module may:

- directly mutate canonical workflow state;
- define a competing canonical workflow-state enum/type;
- independently transition a Work Item between canonical workflow states;
- use frontend state as authoritative;
- use GitHub, LLM, agent, review, or verification modules as state authorities.

Other modules may emit results/signals or request transitions through the Workflow Engine boundary.

Canonical workflow state is persisted by `/workflows` in PostgreSQL.

# FROZEN WORKFLOW STATES

Read the exact state set and legal transitions from:

- `/spec/architecture.md`
- `/spec/architecture-lock.md`
- `/spec/requirements.md`

Do not invent alternative canonical states.

The frozen documents identify non-happy-path states including:

- `DRAFT`
- `IMPLEMENTING`
- `ARCHITECT_REVIEW`
- `VERIFYING`
- `CHANGES_REQUESTED`
- `IMPLEMENTATION_BLOCKED`
- `VERIFICATION_FAILED`
- `ARCHITECTURE_CHANGE_REQUIRED`

The frozen documents are authoritative for the complete graph, including any additional required states such as `READY`, `ASSIGNED`, `PR_OPEN`, `MERGED`, and `VERIFIED`.

If the documents are genuinely ambiguous or contradictory, stop and report:

```text
ARCHITECTURE_BLOCKER
```

Do not invent a different workflow.

# CANONICAL TRANSITION ENGINE

Implement one authoritative transition service/engine.

Every transition must:

1. Load authoritative current state from PostgreSQL.
2. Verify the requested transition is legal.
3. Verify required preconditions.
4. Persist the new state.
5. Persist transition history/audit metadata.
6. Be concurrency-safe.
7. Return the resulting state.

No other module may write canonical workflow state directly.

# TRANSITION SEMANTICS

Inspect the frozen documents for exact correction loops, blocked states, retry semantics, and terminal behavior.

The implementation must support every path explicitly defined there, including conceptual paths such as:

```text
ARCHITECT_REVIEW
  → CHANGES_REQUESTED
  → IMPLEMENTING
```

```text
VERIFYING
  → VERIFICATION_FAILED
  → IMPLEMENTING
```

```text
ARCHITECT_REVIEW
  → ARCHITECTURE_CHANGE_REQUIRED
```

```text
IMPLEMENTING
  → IMPLEMENTATION_BLOCKED
```

Use the frozen specification to determine:

- legal next states;
- terminal states;
- retry limits, if any;
- blocked-state recovery;
- architecture-change effects.

Do not guess transitions.

# WORK ITEM / WORK ORDER RELATIONSHIP

WORK-007 owns Work Item and Work Order state.

WORK-009 owns the **canonical workflow state** associated with Work Item execution.

Do not merge those domains.

The Workflow Engine may resolve a Work Item and Work Order, but `/work-items` remains authoritative for Work Order persistence/state.

# DEPENDENCY ELIGIBILITY

Reuse the WORK-007 `WorkItemDependencyService` contract.

Before entering any state that requires implementation eligibility, verify the Work Item is eligible.

Do not duplicate dependency logic inside `/workflows`.

If dependencies are incomplete, reject or route the transition exactly as required by the frozen workflow rules.

# ARCHITECTURE VERSION CONSTRAINT

Every workflow execution must remain traceable to the ArchitectureVersion associated with its Work Item.

The Workflow Engine must never silently change the Work Item's ArchitectureVersion.

Architecture changes belong to `/architecture` and WORK-005.

If the workflow reaches `ARCHITECTURE_CHANGE_REQUIRED`, record the outcome but do not mutate architecture content or bypass the `/architecture` boundary.

# AUTHORIZATION

Workflow transitions are backend-authoritative.

Reuse the existing `/auth` `AuthorizationService`.

At minimum:

- only authorized project actors/infrastructure may request applicable transitions;
- unprivileged users cannot arbitrarily set workflow state;
- frontend checks are never authoritative.

Do not create a new permission hierarchy unless explicitly required by the frozen specification.

If a genuinely required workflow-specific permission is unavailable and cannot use the existing authorization model, stop and report:

```text
IMPLEMENTATION_BLOCKED
```

# CONCURRENCY / RACE SAFETY

Workflow transitions must be concurrency-safe.

Two simultaneous requests must not both successfully apply conflicting transitions from the same prior state.

Use PostgreSQL transactions with appropriate row locking or optimistic concurrency/versioning.

Prove the behavior with a test such as:

```text
state = X
request A → legal X→Y
request B → legal X→Z
```

Only one authoritative transition may succeed. The losing request must fail deterministically, leaving correct current state and history.

Do not use Redis as the authoritative workflow-state lock.

# STATE HISTORY

Persist transition history in PostgreSQL.

At minimum capture:

- workflow/work-item reference;
- previous state;
- new state;
- transition type/reason;
- actor/source;
- timestamp;
- execution/correlation ID when available;
- relevant metadata.

History is append-oriented.

A later transition must not erase earlier history.

The transition sequence must be reconstructable for a Work Item.

# IDEMPOTENCY

Workflow transitions must be retry-safe.

Repeated delivery of the same transition request/event must not create unintended duplicate state changes.

Use a durable PostgreSQL idempotency key/event identifier where appropriate.

Do not make Redis the idempotency authority.

# EXTERNAL MODULE INTERACTIONS

The Workflow Engine may receive signals/results from:

- GitHub;
- LLM/agent modules;
- Verification;
- Reviews.

Those modules do not own canonical workflow state.

Use provider-independent interfaces/events as necessary.

Do not build later modules' full implementations.

Examples:

```text
Agent reports implementation completed
        ↓
Workflow Engine validates preconditions and performs legal transition
```

```text
Verification reports failure
        ↓
Workflow Engine performs the frozen failure transition
```

```text
Architect review reports changes requested
        ↓
Workflow Engine performs the frozen correction transition
```

The Workflow Engine is the authority.

# PERSISTENCE

Reuse:

- PostgreSQL `DatabaseClient`;
- migration runner;
- transaction abstraction;
- existing authorization;
- Work Item repository;
- dependency eligibility service;
- shared runtime/observability.

Do not create:

- another PostgreSQL client;
- another workflow database;
- another Redis state store;
- another worker framework;
- another authorization system.

Add only workflow persistence required by WORK-009.

# ASYNC / WORKER INTERACTION

Do not create a new queue/worker system.

If workflow transitions require asynchronous handling, reuse the existing WORK-001/003 Queue + WorkerHost.

Do not create a second workflow executor.

# API

Implement only the API needed to verify the workflow contract.

At minimum provide protected endpoints sufficient to verify:

- current canonical workflow state;
- legal transition;
- illegal transition rejection;
- transition history.

Do not expose an endpoint that accepts arbitrary state values.

The API submits transition requests to the Workflow Engine.

Do not put the state machine in route handlers.

# STATIC ARCHITECTURE CHECKS

Extend the existing architecture checks to enforce:

- `/workflows` owns canonical workflow state;
- no other module defines a competing canonical workflow-state type;
- `/work-items` does not own canonical workflow state;
- `/llm` does not own canonical workflow state;
- `/agents` does not own canonical workflow state;
- `/verification` does not own canonical workflow state;
- `/reviews` does not own canonical workflow state;
- `/github` does not own canonical workflow state;
- frontend/API route code does not mutate workflow state directly;
- workflow state is persisted through the Workflow Engine boundary;
- existing WORK-001 through WORK-008 architecture checks remain intact.

# REQUIRED TESTS

## State machine

Test every legal transition defined by the frozen architecture and representative illegal transitions.

Cover every canonical state with valid inbound/outbound transitions where applicable.

Test the state-machine/domain layer directly, not only HTTP routes.

## Correction cycles

Explicitly test every correction/failure loop defined by the frozen specification, including:

```text
ARCHITECT_REVIEW → CHANGES_REQUESTED → IMPLEMENTING
VERIFYING → VERIFICATION_FAILED → IMPLEMENTING
```

and any other frozen recovery paths.

## Blocking

Test `IMPLEMENTATION_BLOCKED` entry and its exact frozen recovery behavior.

## Architecture change required

Test that `ARCHITECTURE_CHANGE_REQUIRED` is represented correctly and does not silently mutate architecture state.

## Dependency eligibility

Test:

- incomplete dependency blocks implementation eligibility;
- completed dependencies permit implementation eligibility;
- workflow uses the existing dependency service rather than duplicating the graph logic.

## Concurrency

Test simultaneous/conflicting transitions and prove only one succeeds while state/history remain consistent.

## Idempotency

Test duplicate transition requests/events. One logical transition must produce one state mutation and one corresponding history record.

## Tenant isolation

Test:

- User A cannot transition User B's Work Item;
- cross-tenant identifiers cannot bypass authorization;
- workflow reads are tenant-scoped.

## Regression

All WORK-001 through WORK-008 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

# OUT OF SCOPE

Do NOT implement:

- LLM Gateway;
- Agent Gateway;
- Agent Run execution;
- verification engine;
- architect review engine;
- new GitHub behavior;
- CI ingestion;
- notifications;
- frontend workflow UI;
- deployment;
- WORK-010 or later.

Do not create provider-specific workflow logic.

Do not create a second state machine.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

# DEFINITION OF DONE

WORK-009 is complete only when:

- canonical workflow state exists under `/workflows`;
- the state graph exactly follows the frozen architecture;
- legal/illegal transitions are centrally enforced;
- correction/retry/blocked/failure/architecture-change states are represented according to the frozen rules;
- Work Item dependency eligibility is enforced through the existing dependency service;
- workflow transitions are concurrency-safe;
- workflow history is durable in PostgreSQL;
- transition requests are idempotent/retry-safe;
- tenant isolation is enforced;
- authorization is backend-authoritative;
- no other module owns canonical workflow state;
- no duplicate workflow engine/queue/database is introduced;
- static architecture checks pass;
- all WORK-009 tests pass;
- all prior regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification files remain unchanged;
- no WORK-010 or later functionality is introduced.

# FAILURE / ESCALATION RULES

If the frozen workflow state graph is ambiguous or contradictory:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing the frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If a required authorization contract cannot be satisfied within the existing authorization model:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent a state machine.

# FINAL AGENT RESPONSE

When complete, return:

```text
WORK-009 COMPLETE

Implementation summary:
Tests/evidence:
Files changed:
Workflow-state authority evidence:
Concurrency/idempotency evidence:
Transition-history evidence:
Tenant-isolation evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
