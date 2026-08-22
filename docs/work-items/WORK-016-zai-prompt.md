# Z.ai Implementation Prompt — WORK-016

You are the implementation agent for WorkflowOS work item **WORK-016 — Architect Reviews and Review Findings**.

Work only on WORK-016. Do not redesign the architecture or implement later work items.

## Authoritative inputs

Before modifying code, read from `main`:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

Also inspect:

```text
backend/src/modules/reviews/
backend/src/modules/llm/
backend/src/modules/workflows/
backend/src/modules/work-items/
backend/src/modules/verification/
backend/src/modules/agents/
backend/src/modules/architecture/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to WORK-014 Architect Service, WORK-009 Workflow Engine, WORK-015 verification evidence/results, WORK-007 Work Item/Work Order, WORK-005 ArchitectureVersion, authorization/tenant isolation, PostgreSQL, ObjectStore, execution IDs/logging, and static architecture checks.

The frozen architecture documents are authoritative and must not be modified.

## Objective

Implement the `/reviews` domain for persisted Architect Reviews and Review Findings.

Requirements:

- Persist an Architect Review against the exact Work Item / ArchitectureVersion / Work Order context being reviewed.
- Persist Review Findings.
- Preserve architect execution/reviewer traceability.
- Represent review outcome using the frozen review semantics.
- Distinguish review outcome from canonical workflow state.
- Provide a reusable provider-independent review-result contract for `/workflows`.
- Preserve tenant isolation and authorization.
- Preserve review history without overwriting prior reviews/findings.

Do not implement a new LLM provider layer, verification engine, workflow state machine, or duplicate Work Item/Work Order model.

## Module ownership

Frozen boundaries:

```text
/llm
    owns Architect execution

/reviews
    owns Architect Review + Review Findings persistence and semantics

/verification
    owns evidence and criterion evaluation

/workflows
    owns canonical workflow state

/work-items
    owns Work Item + Work Order

/architecture
    owns ArchitectureVersion/change control

/agents
    owns Agent Runs
```

Architect execution remains `/llm`.
Workflow state remains `/workflows`.
Verification remains `/verification`.
Work Item/Work Order remains `/work-items`.

## Architect Review

Persist a durable Review record with the fields required by the frozen architecture, including where applicable:

- stable review ID;
- Work Item;
- Work Order;
- ArchitectureVersion;
- architect execution/reference;
- reviewer/actor/source;
- review status/outcome;
- summary/rationale;
- created/completed timestamps;
- execution/correlation ID;
- required metadata.

Use references to existing domain records. Do not duplicate Work Item, Work Order, ArchitectureVersion, or Architect Execution records.

## Review Findings

Findings are first-class persisted records. Support at minimum:

- stable finding ID;
- Review ID;
- severity/category;
- title/summary;
- detailed description;
- affected scope;
- related Requirement/Criterion IDs where applicable;
- related evidence references where applicable;
- disposition/status;
- created/updated timestamps.

Inspect frozen specification for exact statuses/categories. Do not invent an unrelated issue tracker.

## Review outcomes

Inspect frozen documents for exact semantics. At minimum support required outcomes such as:

```text
CHANGES_REQUESTED
ARCHITECTURE_CHANGE_REQUIRED
APPROVED
```

A review outcome is a review-domain result, not a canonical workflow state. Do not define a competing `WorkflowState` enum.

## Workflow boundary

Use this boundary:

```text
Architect
   ↓
/reviews
   ↓
persisted Review + Findings
   ↓
public review result contract
   ↓
/workflows
   ↓
canonical transition
```

`/reviews` MUST NOT:

- mutate `wfos_workflow_executions`;
- define workflow states;
- bypass the Workflow Engine;
- directly transition `DRAFT`, `IMPLEMENTING`, `ARCHITECT_REVIEW`, or other canonical states.

Expose only a provider-independent public result contract for `/workflows`; never import `/reviews/internal` from other modules.

## Verification boundary

Reviews may consume existing VerificationRun, criterion evaluation, requirement derivation, and evidence references, but `/verification` remains authoritative for verification semantics.

Do not evaluate evidence or modify criterion status in `/reviews`.

Findings may reference criteria/evidence without becoming an evidence store.

## ArchitectureVersion / traceability

Every Review must remain tied to the exact ArchitectureVersion under review:

```text
Review
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

Validate Work Item/Work Order/ArchitectureVersion consistency. Frozen ArchitectureVersions remain immutable.

## Architect execution traceability

Where a Review originates from Architect Service execution, retain the exact execution identifier/reference. Reuse the `/llm` public Architect execution contract. Do not create another Architect execution store or access provider SDKs directly.

## Review history and correction cycles

Never mutate a completed historical Review into a later review cycle.

Support:

```text
Review #1 → CHANGES_REQUESTED
implementation correction
Review #2 → APPROVED
```

Both Reviews remain independently persisted and historically retrievable.

A review may record `ARCHITECTURE_CHANGE_REQUIRED`, but `/reviews` must not create/mutate Architecture Change Requests unless explicitly assigned by the frozen architecture. Do not mutate ArchitectureVersion state.

## Authorization / tenant isolation

Reuse the existing `/auth` `AuthorizationService`.

Reviews are project/tenant scoped. Demonstrate that User A cannot read/create/mutate Review B or add cross-tenant findings; cross-tenant criterion/evidence references must fail.

Do not create another authorization model.

## Review actors

Inspect frozen specification for actor/source semantics. Preserve enough metadata to distinguish architect/LLM execution source, human actor where supported, and execution/correlation ID. Do not invent an unrestricted reviewer identity system.

## Public Review Result

Expose a provider-independent public result suitable for `/workflows`, conceptually:

```text
ArchitectReviewResult
    reviewId
    workItemId
    architectureVersionId
    outcome
    findingIds
    summary
    createdAt
```

Use repository naming/types. `/workflows` must consume the public `/reviews` contract only.

## API

Implement only API needed to verify WORK-016:

- create Review;
- retrieve Review;
- list Review history for a Work Item;
- create/add Findings;
- retrieve Findings;
- finalize a Review / record its outcome;
- retrieve public Review Result.

All user-facing operations must be backend-authorized. No API may directly set workflow state or expose LLM provider details.

## Persistence

Reuse existing:

- PostgreSQL `DatabaseClient` and migration runner;
- Work Item/Work Order repositories;
- ArchitectureVersion contract;
- LLM Architect execution contract;
- Verification public contracts;
- execution/correlation IDs;
- ObjectStore only if unusually large immutable review artifacts are genuinely required.

Do not create another database client, review engine, workflow store, evidence store, Work Order model, or Architect execution store.

Use database constraints for Review→Work Item/Work Order/ArchitectureVersion, Finding→Review, optional Requirement/Criterion references, valid outcome/status values, and tenant/project integrity.

## Review finalization

Finalization must be deterministic. Once finalized, persist the outcome and findings. Historical Review identity must remain intact. Do not silently change a finalized review into another outcome.

If the frozen architecture allows finding mutation after finalization, model that explicitly; otherwise protect finalized core outcome.

Repeated finalization must be idempotent or rejected according to frozen semantics.

## Idempotency

Use durable PostgreSQL identity/idempotency where appropriate. Do not use Redis as the source of truth. A repeated submission with a stable review/execution ID must not accidentally duplicate a review or create contradictory outcomes.

## Async

No new worker system is permitted. If asynchronous review work is required, reuse the existing WorkerHost/Queue.

## Static architecture checks

Extend existing checks to ensure:

- `/reviews` owns Architect Review persistence;
- `/reviews` owns Review Finding persistence;
- `/reviews` does not define canonical workflow state;
- `/reviews` does not mutate workflow persistence directly;
- `/reviews` does not import `/workflows/internal`;
- `/reviews` does not import GitHub SDK/provider implementations;
- `/reviews` does not define criterion/verification semantics;
- `/reviews` uses `/verification` public contracts only;
- `/reviews` uses `/llm` Architect execution contract only;
- `/reviews` does not create duplicate Work Order or Architect Execution persistence;
- `/workflows` consumes `/reviews` via public interfaces;
- existing WORK-001 through WORK-015 architecture checks remain intact.

## Required tests

### Review persistence

Test Review creation, Work Item/Work Order/ArchitectureVersion links, architect execution reference, tenant ownership, and stable identity.

### Findings

Test finding persistence, Review relationship, optional criterion/evidence references, valid severity/category/status, cross-tenant rejection, and history.

### Outcomes

Test every valid review outcome required by frozen architecture, including `CHANGES_REQUESTED`, `ARCHITECTURE_CHANGE_REQUIRED`, `APPROVED`, plus any other explicitly defined outcome. Test invalid outcomes.

### Finalization

Test finalization persistence, protection from silent historical mutation, second-review creation, and repeat-finalization behavior.

### Workflow boundary

Test finalizing a Review does NOT directly mutate canonical workflow state; no Review API accepts `WorkflowState`; public Review Result is consumable by `/workflows` without `/reviews/internal` imports.

### Verification boundary

Test Review can consume persisted verification results/evidence references, does not modify criterion status, and findings can reference criteria/evidence.

### Architect traceability

Test exact Architect execution reference, exact ArchitectureVersion, rejection of mismatched versions, and immutability of frozen ArchitectureVersion.

### Correction cycle

Test independent historical Reviews:

```text
Review #1 → CHANGES_REQUESTED
Review #2 → APPROVED
```

### Tenant isolation

Test cross-tenant Review reads, creation, finding creation, criterion/evidence reference, and identifier substitution all fail.

### Regression

All existing WORK-001 through WORK-015 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

## Out of scope

Do NOT implement:

- Workflow Engine changes;
- verification engine changes;
- GitHub integration changes;
- LLM provider changes;
- Agent Gateway changes;
- Work Order generation;
- Architecture Change Request implementation;
- frontend;
- notifications;
- deployment;
- WORK-017 or later.

Do not let Review finalization directly transition workflow state.
Do not let Review findings become criterion PASS/FAIL.
Do not move Work Item, Work Order, ArchitectureVersion, Verification, or Architect Execution ownership into `/reviews`.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

## Definition of done

WORK-016 is complete only when:

- `/reviews` owns persisted Architect Reviews and Review Findings;
- Reviews remain tied to exact Work Item/Work Order/ArchitectureVersion context;
- Architect execution traceability is preserved;
- review outcomes are frozen-spec compliant;
- review history survives correction cycles;
- finalized Reviews cannot silently change historical outcome;
- findings have durable identity and relationships;
- tenant isolation is enforced;
- Review Results are exposed through a provider-independent public contract;
- `/workflows` remains canonical workflow-state authority;
- review finalization does not directly mutate workflow state;
- `/verification` remains verification authority;
- `/llm` remains Architect execution authority;
- no duplicate persistence/infrastructure is introduced;
- static architecture checks pass;
- all WORK-016 tests pass;
- all prior regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-017 or later functionality is introduced.

## Failure / escalation

If frozen specification does not define enough information to distinguish review-domain outcomes from workflow states:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If a required authorization contract cannot be implemented using existing contracts:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent a competing review/workflow architecture.

## Final agent response

When complete, return:

```text
WORK-016 COMPLETE
```

followed by:

```text
Implementation summary:
Tests/evidence:
Files changed:
Review-history/correction-cycle evidence:
Workflow-boundary evidence:
Verification-boundary evidence:
Tenant-isolation evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
