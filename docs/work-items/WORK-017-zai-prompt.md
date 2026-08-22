# Step 2 — Generate Coding-Agent Prompt for WORK-017

You are the implementation agent for WorkflowOS work item **WORK-017 — Workflow convergence / automated execution loop**.

Work only on WORK-017. Do not redesign the architecture or implement later work items.

## 1. AUTHORITATIVE INPUTS

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
backend/src/modules/agents/
backend/src/modules/llm/
backend/src/modules/github/
backend/src/modules/verification/
backend/src/modules/reviews/
backend/src/modules/requirements/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to the merged WORK-007 through WORK-016 boundaries and contracts.

The frozen architecture documents are authoritative and must not be modified.

---

# 2. WORK ITEM

**WORK ITEM ID:** `WORK-017`

**Title:** Workflow convergence / automated execution loop

### Objective

Implement the Workflow Engine orchestration/convergence layer that connects the existing Work Item, Work Order, Agent Run, GitHub, Verification, and Architect Review contracts into the canonical implementation loop.

The platform must advance Work Items through the frozen workflow using existing domain boundaries rather than bespoke controller logic.

Conceptually:

```text
eligible Work Item
      ↓
Workflow Engine
      ↓
Work Order
      ↓
Agent Run
      ↓
GitHub PR
      ↓
Verification
      ↓
Architect Review
      ↓
Workflow Engine
      ↓
correction / merge / verified / next item
```

WORK-017 is an orchestration/convergence task. It does not move domain ownership from existing modules.

---

# 3. CRITICAL OWNERSHIP RULE

`/workflows` is the exclusive owner of:

- canonical workflow state;
- legal workflow transitions;
- orchestration decisions;
- workflow convergence;
- retry/correction routing;
- progression from one lifecycle phase to the next.

The following modules remain authoritative for their own domains:

```text
/work-items
    Work Item + Work Order

/agents
    Agent Gateway + Agent Runs

/llm
    LLM Gateway + Architect execution + Work Order generation

/github
    GitHub integration + repository/PR/CI ingestion

/verification
    verification runs + evidence + criterion/requirement evaluation

/reviews
    Architect Reviews + Review Findings

/requirements
    Requirements + Acceptance Criteria

/architecture
    Architecture + ArchitectureVersion + change control
```

Consume these modules through their public contracts only. Never import another module's `internal/` implementation.

---

# 4. CANONICAL CONVERGENCE LOOP

Use the exact legal transitions implemented in WORK-009 and the frozen documents.

At minimum the orchestration supports the existing frozen progression:

```text
DRAFT
  ↓
READY
  ↓
ASSIGNED
  ↓
IMPLEMENTING
  ↓
PR_OPEN
  ↓
VERIFYING
  ↓
ARCHITECT_REVIEW
  ↓
APPROVED
  ↓
MERGED
  ↓
VERIFIED
```

and correction/error states already defined by the frozen architecture, including:

```text
IMPLEMENTATION_BLOCKED
VERIFICATION_FAILED
CHANGES_REQUESTED
ARCHITECTURE_CHANGE_REQUIRED
```

Do not alter the canonical state graph.

---

# 5. ORCHESTRATION RESPONSIBILITY

Coordinate existing domain actions.

Examples:

```text
READY
  ↓
resolve Work Order / eligibility
  ↓
request/launch Agent Run
  ↓
transition IMPLEMENTING
```

```text
Agent Run completed
  ↓
observe commit/PR result
  ↓
transition PR_OPEN
```

```text
PR + implementation complete
  ↓
Verification Run
  ↓
transition VERIFYING
```

```text
Verification completed
  ↓
if failed → VERIFICATION_FAILED
if ready for architecture review → ARCHITECT_REVIEW
```

```text
Review finalized
  ↓
APPROVE → appropriate next workflow transition
REQUEST_CHANGES → IMPLEMENTING
ARCHITECTURE_CHANGE_REQUIRED → ARCHITECTURE_CHANGE_REQUIRED
IMPLEMENTATION_BLOCKED → IMPLEMENTATION_BLOCKED
```

These are examples only; use the exact frozen legal transitions and preconditions.

Do not assume all signals are synchronous. Use existing persistent records and provider-independent contracts.

---

# 6. EVENT / SIGNAL MODEL

Where orchestration needs asynchronous coordination, define only the minimal provider-independent application signals/commands required by the repository.

Examples may include:

```text
AgentRunCompleted
AgentRunFailed
PullRequestOpened
PullRequestClosed
VerificationCompleted
VerificationFailed
ArchitectReviewFinalized
ArchitectureChangeResolved
```

Use the exact events/signals required by the frozen specification.

Do not create a generic event platform solely for WORK-017.

Do not create a second persistent event store unless explicitly required.

---

# 7. WORKFLOW ENGINE AUTHORITY

Every convergence decision must eventually invoke the existing Workflow Engine transition boundary.

Do not mutate `wfos_workflow_executions.current_state` directly.

The following modules must not write canonical workflow state:

- Agent Gateway;
- GitHub;
- Verification;
- Reviews;
- LLM/Architect.

The orchestration layer decides which transition to request; the Workflow Engine remains the final authority.

---

# 8. WORK ITEM ELIGIBILITY

Before beginning implementation:

- use the existing Work Item Dependency Service;
- verify Work Order availability/eligibility;
- verify ArchitectureVersion association;
- verify tenant authorization where a user action initiates the loop.

Do not duplicate dependency-cycle or completion logic.

Reuse WORK-007's public contract.

---

# 9. WORK ORDER RELATIONSHIP

`/work-items` owns Work Order persistence and state.

The Workflow Engine may:

- read Work Orders;
- validate Work Order state;
- request generation through the existing `/llm` Architect Service;
- consume an existing Work Order.

It must not create a second Work Order model or directly mutate internal Work Order persistence.

Use the existing `/work-items` public contract.

---

# 10. AGENT LOOP

Reuse the existing Agent Gateway and Agent Run model.

Preserve:

```text
Work Item
→ Work Order
→ Agent Run
→ Agent result
```

The Agent Gateway remains the implementation-provider boundary.

`/workflows` must not import provider-specific agent SDKs.

Agent output remains evidence/claims. Agent completion alone must not:

- mark criteria PASS;
- mark Work Item VERIFIED;
- bypass Verification;
- bypass Review.

---

# 11. GITHUB LOOP

Reuse the provider-independent `/github` contract.

Consume repository/PR state such as:

- PR opened;
- PR updated;
- PR merged;
- PR closed;
- commit/reference available.

GitHub remains authoritative for repository state.

Do not duplicate GitHub state inside `/workflows`.

Do not import GitHub SDK/provider code into `/workflows`.

---

# 12. VERIFICATION LOOP

Consume results through `/verification` public contracts.

For example:

```text
VerificationRun completed
  ↓
evaluate persisted criteria
  ↓
Workflow Engine determines legal next transition
```

Do not evaluate evidence inside `/workflows`.

Do not create another criterion-status authority.

If verification is insufficient, follow the existing frozen behavior rather than inventing one.

---

# 13. REVIEW LOOP

Consume Architect Review results through `/reviews` public interfaces.

Map review outcomes to canonical workflow transitions according to the frozen architecture.

Possible review-domain outcomes include:

```text
APPROVE
REQUEST_CHANGES
ARCHITECTURE_CHANGE_REQUIRED
IMPLEMENTATION_BLOCKED
```

Do not duplicate review storage inside `/workflows`.

Do not allow `/reviews` to mutate workflow state directly.

---

# 14. MERGE / VERIFIED CONVERGENCE

Advance through:

```text
APPROVED
  ↓
MERGED
  ↓
VERIFIED
```

using the exact frozen semantics and authoritative GitHub/Verification signals.

Do not infer merge from agent claims, LLM output, review text, or frontend state.

Do not infer `VERIFIED` merely from merge unless the frozen workflow explicitly says so.

---

# 15. CORRECTION CYCLES

Support repeated correction loops, preserving all historical records.

Example:

```text
IMPLEMENTING
  ↓
PR_OPEN
  ↓
VERIFYING
  ↓
ARCHITECT_REVIEW
  ↓
REQUEST_CHANGES
  ↓
IMPLEMENTING
```

Later:

```text
IMPLEMENTING
  ↓
PR_OPEN
  ↓
VERIFYING
  ↓
ARCHITECT_REVIEW
  ↓
APPROVE
```

Do not overwrite prior Agent Runs, Verification Runs, Reviews, Findings, PR associations, Work Orders, or Workflow transitions.

---

# 16. FAILURE / BLOCKING CONVERGENCE

Support the frozen blocking paths.

Examples:

```text
IMPLEMENTING
  ↓
IMPLEMENTATION_BLOCKED
```

```text
VERIFYING
  ↓
VERIFICATION_FAILED
```

```text
ARCHITECT_REVIEW
  ↓
ARCHITECTURE_CHANGE_REQUIRED
```

Use the exact recovery/terminal semantics from WORK-009.

Do not create new recovery states.

---

# 17. CONCURRENCY / DUPLICATE SIGNALS

The convergence layer must be resilient to duplicate/out-of-order signals.

Examples:

```text
same AgentRunCompleted twice
same VerificationCompleted twice
same ReviewFinalized twice
same GitHub event twice
```

These must not cause:

- duplicate workflow transitions;
- illegal state transitions;
- duplicate downstream executions;
- history corruption.

Reuse the Workflow Engine's durable transition idempotency mechanisms.

Do not use Redis as the convergence authority.

---

# 18. IDEMPOTENCY

Each orchestration-triggered transition should have a deterministic idempotency identity derived from appropriate workflow/work-item and source-event identifiers.

The same logical signal processed twice must produce one authoritative workflow transition.

Do not use a global idempotency key shared across Work Items.

Scope identities appropriately.

---

# 19. ASYNCHRONOUS EXECUTION

Reuse the existing Queue + WorkerHost.

Do not build another workflow worker.

Conceptually:

```text
domain event / request
    ↓
persisted authoritative state
    ↓
existing Redis queue
    ↓
workflow orchestration worker
    ↓
load persistent state
    ↓
evaluate next legal action
    ↓
request existing domain operation
    ↓
canonical Workflow Engine transition
```

Redis is transport/coordination only. PostgreSQL remains authoritative.

---

# 20. RECOVERY / RESTART

The orchestration process must be recoverable after worker restart.

Do not rely on in-memory state.

A pending convergence step must be reconstructable from persisted:

- workflow state;
- Work Item;
- Work Order;
- Agent Run;
- PR association;
- Verification Run;
- Review.

Add deterministic restart/reprocessing tests where appropriate.

---

# 21. TENANT ISOLATION

All user-triggered convergence operations must use the existing authorization boundary.

Internal asynchronous processing must resolve the authoritative project/tenant relationship from persisted records rather than trusting event payload identifiers.

A signal referencing another tenant's Work Item must not cause an unauthorized mutation.

Do not trust client-supplied project/architecture identifiers to override persisted traceability.

---

# 22. AUTHORIZATION

Use the existing `/auth` AuthorizationService.

User-facing actions that initiate convergence use existing project permissions.

Internal worker processing operates against authoritative persisted identities.

Do not create another workflow permission hierarchy.

---

# 23. PERSISTENCE

Reuse:

- Workflow repository;
- Workflow Engine;
- Work Item repository;
- Work Order repository/contracts;
- Agent Run repository/contracts;
- GitHub provider-independent contracts;
- Verification contracts;
- Review contracts;
- PostgreSQL `DatabaseClient`;
- existing Queue/WorkerHost.

Do not create:

- another workflow store;
- another Work Item store;
- another Work Order store;
- another Agent Run store;
- another Review store;
- another Verification store;
- another worker framework.

Only add persistence explicitly required for convergence orchestration.

---

# 24. API

Implement only the API needed to verify convergence.

Potential operations include:

- initiate a workflow/convergence run;
- resume/retry a blocked workflow where allowed;
- inspect current orchestration status/history.

Do not expose arbitrary workflow-state setting.

API requests submit operations to the Workflow Engine rather than writing a state value.

---

# 25. STATIC ARCHITECTURE CHECKS

Extend existing checks to enforce:

- `/workflows` remains the only owner of canonical workflow transitions;
- `/workflows` may consume public interfaces from `/work-items`, `/agents`, `/github`, `/verification`, `/reviews`, `/llm`;
- `/workflows` never imports another module's `internal/`;
- `/workflows` never imports provider-specific GitHub/LLM/agent SDKs;
- `/agents`, `/github`, `/verification`, `/reviews`, `/llm` cannot mutate canonical workflow persistence directly;
- `/workflows` does not create duplicate domain stores;
- workflow orchestration uses the existing Queue/WorkerHost;
- no second workflow state machine is introduced;
- existing WORK-001 through WORK-016 checks remain intact.

---

# 26. REQUIRED TESTS

## Happy-path convergence

Prove the complete authoritative path required by the frozen specification, using real persisted domain contracts and deterministic external-provider fakes where needed:

```text
eligible Work Item
→ Work Order
→ Agent Run
→ PR_OPEN
→ Verification
→ Architect Review
→ APPROVED
→ MERGED
→ VERIFIED
```

## Correction loop

Test the frozen correction path:

```text
ARCHITECT_REVIEW
→ REQUEST_CHANGES
→ IMPLEMENTING
→ PR_OPEN
→ VERIFYING
→ ARCHITECT_REVIEW
→ APPROVED
```

Verify prior histories remain intact.

## Verification failure loop

Test:

```text
VERIFYING
→ VERIFICATION_FAILED
→ IMPLEMENTING
```

using the exact frozen semantics.

## Implementation blocked

Test the exact frozen blocked/recovery behavior.

## Architecture change required

Test:

```text
ARCHITECT_REVIEW
→ ARCHITECTURE_CHANGE_REQUIRED
```

and ensure the Workflow Engine records the result without changing ArchitectureVersion content/state itself.

## Dependency blocking

Test incomplete dependencies prevent implementation and completed dependencies permit implementation.

Use the existing dependency service.

## Duplicate signal

Send the same downstream signal twice and prove:

- one workflow transition;
- no duplicate downstream execution;
- no corrupted history.

## Out-of-order signal

Provide a signal that is no longer valid for the current state and prove deterministic rejection/ignore behavior without state corruption.

## Concurrency

Two workers/processes attempting the same convergence step must not create contradictory workflow transitions.

## Worker recovery

Simulate worker restart/failure between persisted domain result and orchestration action. Prove the system can resume from PostgreSQL.

## Tenant isolation

Cross-tenant convergence attempts must fail safely.

## Authority boundaries

Prove:

- Agent completion cannot directly mutate workflow state;
- Verification completion cannot directly mutate workflow state;
- Review finalization cannot directly mutate workflow state;
- GitHub events cannot directly mutate canonical workflow state except through the Workflow Engine orchestration path;
- LLM/Architect results cannot directly mutate workflow state.

## Regression

All existing WORK-001 through WORK-016 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

---

# 27. OUT OF SCOPE

Do NOT implement:

- a new LLM/provider adapter;
- a new Agent Gateway;
- a new GitHub integration;
- a new Verification Engine;
- a new Review model;
- new Work Item/Work Order persistence;
- frontend;
- notifications;
- deployment;
- later work items;
- architecture redesign.

Do not move domain ownership into `/workflows`.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

---

# 28. DEFINITION OF DONE

WORK-017 is complete only when:

- the Workflow Engine orchestrates the existing domain boundaries;
- the canonical workflow state machine remains solely owned by `/workflows`;
- the happy-path convergence loop works using real persisted domain contracts;
- correction/failure/blocking/architecture-change paths work exactly as frozen;
- Agent Runs, GitHub PR state, Verification results, and Reviews are consumed through public interfaces;
- no module bypasses `/workflows` for canonical state mutation;
- duplicate/out-of-order signals are handled deterministically;
- convergence is concurrency-safe;
- worker restart/recovery is supported;
- PostgreSQL remains authoritative;
- Redis remains transport/coordination only;
- tenant isolation is enforced;
- no duplicate domain stores/workers/state machines are introduced;
- static architecture checks pass;
- all WORK-017 tests pass;
- all prior WORK-001 through WORK-016 tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no later work-item functionality is introduced.

---

# 29. FAILURE / ESCALATION RULES

If the frozen convergence semantics are ambiguous or contradictory:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing the frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If the existing authorization model cannot support required convergence operations:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent a new orchestration/state architecture.

---

# 30. FINAL AGENT RESPONSE

When complete, report exactly:

```text
WORK-017 COMPLETE
```

followed by:

```text
Implementation summary:
Tests/evidence:
Files changed:
Happy-path convergence evidence:
Correction/failure-path evidence:
Concurrency/idempotency evidence:
Worker-recovery evidence:
Tenant-isolation evidence:
Authority-boundary evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
