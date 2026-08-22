# Step 2 — Generate Coding-Agent Prompt for WORK-018

You are the Architecture Authority for WorkflowOS.

The frozen architecture and implementation backlog are authoritative.

The following work items are complete and merged into `main`:

- WORK-001 — Platform and modular-monolith foundation
- WORK-002 — Identity, organizations, permissions, tenant isolation
- WORK-003 — PostgreSQL, Redis, object storage
- WORK-004 — Project and specification domains
- WORK-005 — Architecture management and change control
- WORK-006 — Requirements and acceptance criteria
- WORK-007 — Work items, dependencies, Work Order state
- WORK-008 — GitHub integration and webhook ingestion
- WORK-009 — Canonical workflow state machine
- WORK-012 — Agent Gateway and Agent Runs
- WORK-013 — LLM Gateway
- WORK-014 — Architect execution and Work Order generation
- WORK-015 — CI ingestion and verification engine
- WORK-016 — Architect Reviews and Review Findings
- WORK-017 — Workflow convergence through implementation

The next eligible work item is:

**WORK-018 — Verification and architect-review orchestration**

The frozen backlog defines WORK-018 as:

> Connect verification, review invocation, and review verdicts to the frozen state machine.

Requirements:

- **WORKFLOW-003**

Acceptance criteria:

- **WF-VER-AC-01..02**

Dependencies:

- WORK-015
- WORK-016
- WORK-017

Architecture modules affected:

- `/workflows`
- `/verification`
- `/reviews`
- `/llm`

Out of scope:

- merge implementation

Read these authoritative files from `main`:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

The frozen dependency graph explicitly defines:

```text
WORKFLOW-001 + VERIFY-001 + REVIEW-001 → WORKFLOW-003
```

and:

```text
GITHUB-006 + VERIFY-001..003 + REVIEW-001..002 + WORKFLOW-002 → WORKFLOW-003
```

The backlog defines WORK-017 as implementation orchestration and WORK-018 as the next convergence layer for verification/review. Do not duplicate WORK-017 responsibilities.

Also inspect the merged implementation, especially:

```text
backend/src/modules/workflows/
backend/src/modules/verification/
backend/src/modules/reviews/
backend/src/modules/llm/
backend/src/modules/work-items/
backend/src/modules/github/
backend/src/modules/agents/
backend/tests/
.github/workflows/
```

Pay particular attention to the current WORK-017 trusted signal boundary.

Do NOT redesign the architecture.

# WORK ITEM OBJECTIVE

Implement the verification/review orchestration layer that connects already-existing:

```text
Verification Engine
Architect Review domain
Architect Service
Workflow Engine
```

into the frozen workflow.

The intended flow is:

```text
PR_OPEN
   ↓
VERIFYING
   ↓
Verification Run
   ↓
Verification result
   ├── failure → VERIFICATION_FAILED
   │                 ↓
   │              IMPLEMENTING
   │
   └── sufficient success
          ↓
     ARCHITECT_REVIEW
          ↓
     Architect Review
          ├── REQUEST_CHANGES
          │       ↓
          │   CHANGES_REQUESTED
          │       ↓
          │   IMPLEMENTING
          │
          ├── ARCHITECTURE_CHANGE_REQUIRED
          │       ↓
          │   ARCHITECTURE_CHANGE_REQUIRED
          │
          ├── IMPLEMENTATION_BLOCKED
          │       ↓
          │   IMPLEMENTATION_BLOCKED
          │
          └── APPROVE
                  ↓
              APPROVED
```

Use the exact frozen state transitions already established in WORK-009 and consumed by WORK-017.

# CRITICAL BOUNDARIES

`/workflows` remains the **exclusive owner of canonical workflow state and transitions**.

`/verification` remains the authority for:

* VerificationRun;
* Evidence;
* Evidence→Criterion mappings;
* criterion evaluation;
* requirement derivation.

`/reviews` remains the authority for:

* Architect Reviews;
* Review Findings;
* review verdicts;
* review history.

`/llm` remains the authority for:

* Architect execution;
* normalized architect results;
* Work Order generation.

`/github` remains authoritative for repository/PR/CI state.

WORK-018 must orchestrate these domains.

It must NOT move ownership between them.

# MOST IMPORTANT TRUST BOUNDARY

Never trust arbitrary client-supplied verification or review outcomes.

The lesson from WORK-015 and WORK-017 must remain enforced.

External/user/API callers must NOT be able to submit:

```text
verification_completed
review_finalized
```

or equivalent trusted signals with forged payloads.

Use the existing WORK-017 **source-authenticated internal submission methods**.

For verification:

```text
submitVerificationCompleted(...)
```

must validate the persisted VerificationRun and derive the result from the authoritative verification record.

For review:

```text
submitReviewFinalized(...)
```

must validate the persisted Review and derive the verdict from the persisted ReviewResult.

Do not trust:

```text
payload.allCriteriaPass
payload.outcome
```

when supplied by an untrusted caller.

The authoritative source record must be loaded from PostgreSQL.

# WORKFLOW-003 REQUIREMENT

Implement exactly the frozen WORKFLOW-003 behavior.

Before coding, identify the precise meaning of:

```text
WF-VER-AC-01
WF-VER-AC-02
```

from the authoritative frozen documents.

If those acceptance criteria are genuinely ambiguous or contradictory, report:

```text
ARCHITECTURE_BLOCKER
```

Do not invent semantics.

# VERIFICATION ORCHESTRATION

When a Work Item reaches:

```text
VERIFYING
```

the orchestration layer must ensure a verification run is initiated/associated using the existing `/verification` contract.

Do not create a second VerificationRun model.

Use the existing:

```text
VerificationService
VerificationRun
Evidence
Criterion evaluation
```

contracts.

The orchestration layer must not perform evidence evaluation itself.

A verification result must come from the persisted `/verification` record.

# VERIFICATION RESULT DERIVATION

When verification completes:

1. Load the persisted VerificationRun.
2. Confirm it belongs to the same Work Item/project.
3. Confirm the run is actually completed.
4. Obtain its persisted evaluation result.
5. Determine the next workflow transition according to the frozen rules.
6. Submit the transition through `WorkflowEngine.transition()`.

Do NOT infer verification success from:

* agent claims;
* raw CI payloads;
* client payloads;
* arbitrary signal metadata.

Use the authoritative `/verification` result.

# VERIFICATION FAILURE

The frozen workflow includes:

```text
VERIFYING
   ↓
VERIFICATION_FAILED
   ↓
IMPLEMENTING
```

Implement the correction path exactly as frozen.

Do not create a new verification retry state.

Do not directly set workflow state from `/verification`.

The orchestration layer submits the appropriate transition to `/workflows`.

# ARCHITECT REVIEW INVOCATION

When verification satisfies the frozen conditions for architect review:

```text
VERIFYING
   ↓
ARCHITECT_REVIEW
```

the orchestration layer must invoke/create the Architect Review using the existing `/reviews` and `/llm` contracts.

Do not create a duplicate review record.

Do not create another Architect Service.

The review should preserve traceability to:

```text
Work Item
Work Order
ArchitectureVersion
VerificationRun
Architect execution
```

Use existing public interfaces.

# REVIEW EXECUTION

The Architect Review must be generated from authoritative project state.

Reuse WORK-014 Architect Service and WORK-013 LLM Gateway.

Do not call provider SDKs directly.

Do not create a second LLM abstraction.

The review orchestration should supply enough context to the existing Architect Service to review the implementation against:

* Work Order;
* Requirements;
* Acceptance Criteria;
* verification results/evidence;
* relevant PR/repository state;
* architecture constraints.

The existing `/llm` and `/reviews` contracts remain authoritative for execution and persistence.

# REVIEW VERDICT

Once a Review is finalized, the orchestration layer must obtain the persisted ReviewResult through the existing trusted `/reviews` boundary.

Map the exact frozen review verdicts:

```text
APPROVE
REQUEST_CHANGES
ARCHITECTURE_CHANGE_REQUIRED
IMPLEMENTATION_BLOCKED
```

to the corresponding canonical workflow transition.

Do not accept a caller-provided outcome.

Do not allow `/reviews` to mutate workflow state directly.

Every state change goes through:

```text
WorkflowEngine.transition()
```

# CORRECTION LOOP

Explicitly support the frozen correction loop:

```text
VERIFYING
   ↓
ARCHITECT_REVIEW
   ↓
REQUEST_CHANGES
   ↓
CHANGES_REQUESTED
   ↓
IMPLEMENTING
```

Then the Work Item may return through:

```text
PR_OPEN
→ VERIFYING
→ ARCHITECT_REVIEW
```

Historical Review, VerificationRun, AgentRun, PR, Evidence, and WorkflowTransition records must remain intact.

Do not overwrite prior attempts.

# ARCHITECTURE CHANGE REQUIRED

If review produces:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

transition to the frozen workflow state.

Do NOT:

* modify ArchitectureVersion;
* create an Architecture Change Request directly;
* bypass `/architecture`;
* invent architecture-change workflow states.

The architecture/change-control domain remains authoritative.

# IMPLEMENTATION BLOCKED

If review produces:

```text
IMPLEMENTATION_BLOCKED
```

transition through the existing Workflow Engine.

Use the exact recovery semantics from WORK-009.

# PUBLIC / INTERNAL SIGNALS

WORK-017 removed the public generic signal endpoint because it was an authority bypass.

Do not reintroduce it.

WORK-018 must use trusted internal submission methods from the workflow orchestrator.

Any new application/API surface must not let users forge:

* verification result;
* review verdict;
* merge state;
* agent completion.

# IDEMPOTENCY

The orchestration loop must remain idempotent.

Duplicate:

* VerificationRun completion;
* Review finalization;
* CI result;
* orchestration job;

must not produce duplicate workflow transitions.

Reuse WORK-017's source-event identity and per-transition idempotency strategy.

Do not introduce a second global idempotency mechanism.

# CONCURRENCY

Verification completion and review finalization may race with retries/reprocessing.

Use the existing Workflow Engine concurrency protection.

Only one valid transition should win.

A stale signal must not overwrite newer workflow state.

# TENANT ISOLATION

Every orchestration operation must resolve tenant/project ownership from persisted records.

Verify:

```text
VerificationRun
   → Work Item
   → ArchitectureVersion
   → Project
   → Organization
```

and:

```text
Review
   → Work Item
   → Project
```

Cross-tenant verification/review records must be rejected.

Do not trust caller-supplied project IDs.

Reuse existing `/auth` only where user-facing authorization is required.

# WORK ORDER / ARCHITECTURE TRACEABILITY

Architect review context must remain tied to the exact:

```text
Work Item
Work Order
ArchitectureVersion
```

already associated with the implementation.

Do not silently substitute another Work Order or ArchitectureVersion.

Existing PostgreSQL integrity constraints must remain in force.

# API

WORK-018 does not require a new public generic signal API.

Prefer internal application methods and WorkerHost jobs.

If an API endpoint is genuinely necessary to initiate/retry orchestration, it must:

* authorize the user;
* create an internal orchestration request;
* never accept authoritative verification/review outcomes;
* never accept workflow state;
* never accept a forged ReviewResult.

# ASYNC EXECUTION

Use the existing WORK-017 Queue/WorkerHost.

The intended flow is:

```text
trusted domain result
        ↓
existing workflow orchestration queue
        ↓
WORK-018 handler
        ↓
load authoritative persisted result
        ↓
invoke next domain operation
        ↓
WorkflowEngine.transition()
```

Do not create another worker.

PostgreSQL remains authoritative.

Redis remains transport/coordination only.

# RECOVERY

All orchestration state must be recoverable from PostgreSQL.

A worker may crash:

* after creating a VerificationRun;
* after completing verification but before transition;
* after creating a Review;
* after finalizing a Review but before transition.

Reprocessing must safely continue without duplicate authoritative state changes.

Test at least one crash/retry scenario for each major boundary where practical.

# STATIC ARCHITECTURE CHECKS

Extend the existing checks to ensure:

* `/workflows` remains the only canonical workflow-state mutator;
* `/verification` remains the only criterion/evidence evaluator;
* `/reviews` remains review/verdict authority;
* `/llm` remains Architect execution authority;
* no public endpoint can forge verification/review outcomes;
* `/workflows` does not import another module's `internal/`;
* `/workflows` does not import provider SDKs;
* `/verification` does not mutate workflow persistence directly;
* `/reviews` does not mutate workflow persistence directly;
* `/llm` does not mutate workflow persistence directly;
* `/agents` does not mutate workflow persistence directly;
* `/github` does not mutate workflow persistence directly;
* WORK-017's source-authenticated signal boundary remains intact;
* no duplicate VerificationRun, Review, LLM, or workflow state store is created.

# REQUIRED TESTS

## Verification orchestration

Test:

* Work Item entering VERIFYING initiates/uses the correct VerificationRun;
* completed verification is loaded from `/verification`;
* failing verification produces `VERIFICATION_FAILED`;
* successful verification produces `ARCHITECT_REVIEW`;
* no client payload can forge the result.

## Architect-review invocation

Test:

* successful verification creates/invokes the correct Architect Review path;
* review retains exact Work Item/Work Order/ArchitectureVersion traceability;
* existing Architect Service/LLM Gateway is used;
* no duplicate review/LLM provider architecture is created.

## Review verdict orchestration

Test every frozen verdict:

```text
APPROVE
REQUEST_CHANGES
ARCHITECTURE_CHANGE_REQUIRED
IMPLEMENTATION_BLOCKED
```

and verify the correct canonical workflow transition.

The verdict must be loaded from the persisted Review, not supplied by the caller.

## Correction cycle

Test:

```text
VERIFYING
→ ARCHITECT_REVIEW
→ REQUEST_CHANGES
→ CHANGES_REQUESTED
→ IMPLEMENTING
```

Then repeat the verification/review cycle and prove historical records remain intact.

## Verification failure

Test:

```text
VERIFYING
→ VERIFICATION_FAILED
→ IMPLEMENTING
```

using a persisted VerificationRun result.

## Architecture change

Test:

```text
ARCHITECT_REVIEW
→ ARCHITECTURE_CHANGE_REQUIRED
```

and prove ArchitectureVersion remains unchanged.

## Implementation blocked

Test the frozen blocked/recovery behavior.

## Forged-result security tests

Explicitly attempt:

* client submits fake `allCriteriaPass=true`;
* client submits fake `outcome=APPROVE`;
* client submits fake Review ID;
* client submits fake VerificationRun ID;
* client submits fake project/work-item relationship.

All must fail or be ignored.

## Duplicate processing

Process the same Verification completion twice.

Process the same Review finalization twice.

Prove:

* one logical workflow transition;
* no duplicate downstream review/verification execution.

## Out-of-order processing

Deliver:

* Review finalization before review exists;
* verification completion while not VERIFYING;
* duplicate stale results.

Verify deterministic safe behavior.

## Concurrency

Simultaneous verification completion/review signals must not create contradictory workflow transitions.

## Worker recovery

Simulate a worker restart between:

* persisted verification result and workflow transition;
* persisted review result and workflow transition.

Reprocessing must converge safely.

## Tenant isolation

Cross-tenant verification/review records must not cause workflow mutations.

## Regression

All existing WORK-001 through WORK-017 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

# OUT OF SCOPE

Do NOT implement:

* merge gating / merge implementation;
* next-work-item selection;
* Audit;
* notifications;
* frontend;
* deployment;
* new GitHub integration;
* new LLM provider;
* new Agent provider;
* new Verification persistence;
* new Review persistence;
* WORK-019 or later functionality.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

# DEFINITION OF DONE

WORK-018 is complete only when:

* verification completion is connected to the frozen workflow;
* successful verification can lead to ARCHITECT_REVIEW;
* failed verification leads to the frozen failure/recovery path;
* Architect Reviews are invoked through the existing Architect Service/review boundaries;
* persisted Review verdicts drive the correct canonical workflow transitions;
* all correction-cycle paths work;
* Architecture Change Required and Implementation Blocked outcomes are handled;
* no caller can forge verification/review results;
* duplicate/out-of-order processing is deterministic and safe;
* workflow state remains exclusively owned by `/workflows`;
* verification semantics remain exclusively owned by `/verification`;
* review semantics remain exclusively owned by `/reviews`;
* Architect execution remains owned by `/llm`;
* tenant isolation is enforced;
* recovery after worker restart is supported;
* no duplicate infrastructure/domain authority is introduced;
* static architecture checks pass;
* all WORK-018 tests pass;
* all WORK-001 through WORK-017 regression tests pass;
* typecheck passes;
* lint passes;
* CI passes;
* frozen specification documents remain unchanged;
* no WORK-019 or later functionality is introduced.

# FAILURE / ESCALATION RULES

If WF-VER-AC-01 or WF-VER-AC-02 is ambiguous/contradictory in the frozen documents:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If an existing authorization/security contract cannot safely support the required orchestration:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent verification/review orchestration semantics.

# FINAL OUTPUT

Return only the final coding-agent prompt suitable for Z.ai.

When done send the final prompt to Z.ai on:

```text
feat/WORK-018-verification-review-orchestration
```

targeting `main`.

Do NOT merge the PR.
