# Step 2 — Generate Coding-Agent Prompt for WORK-019

You are the implementation agent for **WorkflowOS work item WORK-019 — Merge gating and workflow advancement**.

Work only on WORK-019. Do not redesign the architecture or implement later work items.

## Authoritative inputs

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
backend/src/modules/github/
backend/src/modules/work-items/
backend/src/modules/reviews/
backend/src/modules/verification/
backend/src/modules/agents/
backend/tests/
.github/workflows/
```

Pay particular attention to WORK-009, WORK-010, WORK-017, and WORK-018.

The frozen architecture documents are authoritative and must not be modified.

# WORK ITEM

**WORK-019 — Merge gating and workflow advancement**

Objective: implement the merge-gating and workflow-advancement layer required by WORKFLOW-004.

The intended flow is:

```text
ARCHITECT_REVIEW
      ↓
APPROVED
      ↓
merge eligibility checks
      ↓
authorized merge request
      ↓
GitHub merge / authoritative PR state
      ↓
MERGED
      ↓
post-merge verification / required completion conditions
      ↓
VERIFIED
      ↓
select next eligible Work Item
```

Requirements:

- **WORKFLOW-004** — approval-gated merge, VERIFIED completion, and next-work selection.

Dependencies:

- WORK-018
- WORK-010
- WORK-002

Acceptance criteria:

- **WF-MERGE-AC-01..03**

Architecture modules affected:

```text
/workflows
/github
/work-items
```

Out of scope: UI.

Do not implement later work items.

# CRITICAL OWNERSHIP BOUNDARIES

`/workflows` remains the exclusive authority for:

- canonical workflow state;
- merge gating decisions;
- merge orchestration;
- MERGED → VERIFIED progression;
- next-work-item selection.

`/github` remains authoritative for repository/PR state and provider-specific merge operations.

`/work-items` remains authoritative for Work Items, dependencies, Work Order, implementation eligibility, and active PR associations.

`/reviews` remains authoritative for Architect Review verdicts.

`/verification` remains authoritative for VerificationRun, Evidence, and criterion evaluation.

Do not move ownership between these modules.

Never import another module's `internal/` implementation.

# AUTHORITATIVE MERGE RULE

A review verdict of `APPROVE` must NOT itself create `MERGED`.

Before entering `MERGED`, verify authoritative GitHub PR state and/or use the existing provider-independent GitHub merge contract.

Never infer merge from:

- Architect Review text;
- Agent claims;
- LLM output;
- frontend state;
- a client-provided boolean;
- a fake callback.

GitHub remains authoritative for actual repository/PR state.

# MERGE GATING

Inspect and enforce the exact frozen prerequisites from WORK-007, WORK-010, WORK-017, WORK-018, and the authoritative specifications. At minimum, as applicable:

- Work Item is in the correct workflow state;
- an approved Architect Review exists;
- Review belongs to the same Work Item;
- Review/Work Order/ArchitectureVersion relationships are valid;
- active PR association belongs to the same Work Item;
- verification prerequisites are satisfied according to the frozen rules;
- PR is still open and mergeable according to GitHub;
- there is no unresolved blocking state;
- required dependencies are satisfied.

Do not duplicate rules owned by `/verification`, `/reviews`, `/work-items`, or `/github`.

# GITHUB MERGE OPERATION

Use the existing provider-independent `/github` boundary.

The workflow layer may request a merge through that abstraction, but must not import GitHub SDK/provider implementations.

After requesting a merge, canonical workflow state may advance to `MERGED` only when authoritative GitHub state confirms the PR is actually merged.

Do not set `MERGED` optimistically.

# MERGE IDEMPOTENCY

Repeated merge requests must be safe.

Reuse the existing source-event/per-transition idempotency mechanisms. Do not introduce a global idempotency key.

Scope merge actions to the Work Item / PR / workflow execution.

# PR CARDINALITY

Preserve the frozen active-PR rule:

- historical PR associations remain;
- only one active PR may exist for a Work Item;
- a PR may be associated with multiple Work Items.

Resolve the correct active PR association for the Work Item.

# MERGED → VERIFIED

Implement the exact frozen semantics for `MERGED → VERIFIED`.

Do not assume GitHub merge alone is sufficient unless the frozen specification explicitly says so.

Where post-merge verification is required, consume `/verification` through its public interface and do not evaluate evidence in `/workflows`.

A Work Item may enter `VERIFIED` only when the frozen conditions are satisfied.

# NEXT WORK-ITEM SELECTION

Implement deterministic next-work selection using the existing `/work-items` dependency/eligibility contract.

Do not duplicate:

- cycle detection;
- dependency completion semantics;
- Work Item ownership;
- tenant authorization.

At minimum consider:

```text
eligible
not completed
dependencies satisfied
correct project/tenant
correct architecture version where required
```

Use deterministic ordering if the frozen specification defines an ordering. Do not invent an arbitrary priority model.

Do not automatically begin implementation unless explicitly required by the frozen architecture.

The selection result is a Work Item identity/reference, not another Work Item record.

# MULTI-WORK-ITEM / TENANT SAFETY

Next-work selection must remain project/tenant scoped.

Completing a Work Item in Organization A must never select a Work Item from Organization B.

Explicitly test cross-tenant fixtures.

# DEPENDENCY RULES

Reuse the existing `WorkItemDependencyService`.

Do not reimplement dependency graph traversal in `/workflows`.

# CONCURRENCY / RACE SAFETY

The merge and advancement loop must be safe when multiple workers/processes operate simultaneously.

Reuse:

- Workflow Engine optimistic concurrency;
- PostgreSQL transaction boundaries;
- existing idempotency;
- existing row locking where already provided.

Do not introduce Redis-based authoritative locking.

# RECOVERY

The orchestration must recover after worker/process failure, including:

- merge requested but worker crashes;
- merge completed but worker crashes;
- GitHub merge event arrives before local retry;
- `MERGED` recorded but `VERIFIED` processing is delayed.

Reconstruct correct state from PostgreSQL plus authoritative GitHub state.

Do not rely on in-memory workflow state.

# ASYNC EXECUTION

Reuse the existing WORK-017 Queue/WorkerHost.

Do not create another worker system.

Conceptually:

```text
APPROVED
   ↓
existing workflow queue
   ↓
merge-gating worker
   ↓
load authoritative state
   ↓
validate gates
   ↓
request/observe GitHub merge
   ↓
verify authoritative GitHub state
   ↓
WorkflowEngine.transition()
   ↓
MERGED
   ↓
post-merge verification if required
   ↓
VERIFIED
   ↓
next eligible Work Item
```

Redis remains transport/coordination only. PostgreSQL remains authoritative.

# PUBLIC API

Only expose APIs required to verify WORK-019.

Possible operations include:

- request merge;
- inspect merge readiness;
- inspect advancement result.

Do not expose operations that directly set workflow state, force `MERGED`, force `VERIFIED`, or force the next Work Item.

All user-facing actions require existing authorization.

# AUTHORIZATION

Use the existing `/auth` AuthorizationService.

Only authorized project users may initiate merge operations or inspect protected merge state.

Internal GitHub/webhook processing must resolve authoritative Work Item/project ownership from persisted associations.

Do not create another permission hierarchy.

If a required permission is genuinely missing, stop and report:

```text
IMPLEMENTATION_BLOCKED
```

with the exact missing contract.

# STATIC ARCHITECTURE CHECKS

Extend existing checks to ensure:

- `/workflows` is the only canonical state mutator;
- `/workflows` uses `/github`, `/work-items`, and `/verification` only through public contracts;
- `/workflows` never imports GitHub SDK/provider implementations;
- `/github` remains repository/PR authority;
- `/work-items` remains Work Item/PR association/dependency authority;
- `/verification` remains verification authority;
- `/reviews` remains review verdict authority;
- no module other than `/workflows` directly mutates workflow persistence;
- no new workflow state machine is introduced;
- no duplicate PR/merge store is introduced;
- no client API can directly set `MERGED` or `VERIFIED`;
- existing WORK-001 through WORK-018 architecture checks remain intact.

# REQUIRED TESTS

## Merge gating

Test every frozen prerequisite for merge, including approved review, correct Work Item/Work Order, active PR association, verification prerequisites, tenant authorization, GitHub PR mergeability/state, and rejection of blocked states.

## Approval is not merge

Explicitly prove:

```text
APPROVED
+
PR not merged
→
workflow remains APPROVED
```

## GitHub merge

Use a deterministic fake GitHub adapter.

Test:

- merge request succeeds;
- merge request rejected;
- GitHub reports merged;
- GitHub remains unmerged;
- repeated merge request is idempotent;
- duplicate GitHub merge events are harmless.

## MERGED transition

Test:

```text
APPROVED
→ GitHub merged
→ MERGED
```

and prove the transition goes through `WorkflowEngine.transition()`.

## MERGED → VERIFIED

Test the exact frozen conditions for `VERIFIED`.

If post-merge verification is required, use the existing `/verification` contract. If verification is already satisfied before merge, follow the frozen semantics exactly.

## Next-work selection

Test:

- next eligible Work Item selected;
- incomplete dependency blocks selection;
- completed dependencies permit selection;
- cross-tenant Work Item never selected;
- deterministic selection order;
- already completed Work Items are skipped.

## No forced advancement

Test that client/API callers cannot force `MERGED`, `VERIFIED`, or the next Work Item, and forged GitHub/Review/Verification payloads cannot advance state.

## Idempotency

Test duplicate merge requests, GitHub merge signals, merged processing, post-merge verification processing, and next-work selection.

## Concurrency

Test two workers simultaneously attempting merge gating, `MERGED`, and next-work selection.

## Worker recovery

Simulate failure after merge request, after GitHub reports merged, after `MERGED`, and during `VERIFIED` processing. Reprocess and prove convergence.

## Tenant isolation

Test cross-tenant merge request denial, cross-tenant PR association rejection, and cross-tenant next Work Item rejection.

## Regression

All existing WORK-001 through WORK-018 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

# OUT OF SCOPE

Do NOT implement:

- Audit;
- Notifications;
- frontend/UI;
- deployment;
- merge UI;
- new GitHub provider infrastructure;
- new Verification Engine;
- new Review system;
- new Workflow Engine;
- WORK-020 or later functionality.

Do not move merge authority into `/github` beyond provider-specific repository operations. `/workflows` owns policy/gating and canonical transition.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

# DEFINITION OF DONE

WORK-019 is complete only when:

- merge gating uses the frozen approval/prerequisite rules;
- approval does not itself imply merge;
- actual merge state comes from authoritative GitHub state;
- merge requests are idempotent and concurrency-safe;
- `MERGED` is entered only through `/workflows`;
- `VERIFIED` is entered only when frozen conditions are satisfied;
- post-merge verification uses existing `/verification` contracts where required;
- next Work Item selection uses existing `/work-items` dependency/eligibility contracts;
- next-work selection is deterministic and tenant-scoped;
- duplicate/out-of-order signals are safe;
- worker recovery is supported;
- no client can force `MERGED`, `VERIFIED`, or next-work selection;
- no duplicate domain store or state authority is introduced;
- static architecture checks pass;
- all WORK-019 tests pass;
- all WORK-001 through WORK-018 regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-020 or later functionality is introduced.

# FAILURE / ESCALATION RULES

If the frozen `WF-MERGE-AC-01..03` semantics are ambiguous or contradictory:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing the frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If an existing authorization contract cannot support required merge/advancement behavior:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent merge/verification/advancement semantics.

# FINAL AGENT RESPONSE

When complete, return:

```text
WORK-019 COMPLETE
```

followed by:

```text
Implementation summary:
Tests/evidence:
Files changed:
Merge-gating evidence:
Verified-transition evidence:
Next-work selection evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.