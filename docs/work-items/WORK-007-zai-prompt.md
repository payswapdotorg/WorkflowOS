# Z.ai Implementation Prompt — WORK-007

You are the implementation agent for WorkflowOS work item WORK-007 — Work items, dependencies, Work Order state.

Work only on WORK-007. Do not redesign the architecture or implement later work items.

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
backend/src/modules/work-items/
backend/src/modules/requirements/
backend/src/modules/architecture/
backend/src/modules/projects/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to the merged WORK-001 through WORK-006 implementation:

- module public-interface conventions;
- PostgreSQL `DatabaseClient` and migration runner;
- repository and persistence conventions;
- centralized infrastructure/dependency injection;
- authorization and tenant-isolation mechanisms;
- ArchitectureVersion, Requirement, and AcceptanceCriterion contracts;
- existing static architecture checks;
- API/runtime and CI conventions.

The frozen architecture documents are authoritative and must not be modified.

---

# 2. WORK ITEM

**WORK ITEM ID:** `WORK-007`

**Title:** Work items, dependencies, Work Order state

### Objective

Implement the authoritative `/work-items` domain for:

- Work Items;
- Work Item → Requirement associations;
- Work Item → Acceptance Criterion associations;
- Work Item dependencies;
- assignment/execution metadata required by the frozen architecture;
- historical/current Pull Request associations required by the frozen cardinality model;
- Work Order persistence and state ownership.

### Requirements

- **WORK-001** — Persist coherent Work Items with requirements, criteria, constraints, dependencies, assignment, execution, PRs, verification, and review history.
- **WORK-002** — Persist and evaluate Work Item dependencies.
- **WORK-003** — Persist Work Order state and associations; ownership remains in `/work-items`.

### Dependencies

- `WORK-005` — complete and merged.
- `WORK-006` — complete and merged.

Do not implement GitHub integration itself.
Do not implement workflow orchestration.
Do not implement LLM/agent execution.
Do not implement verification/review semantics.

---

# 3. FROZEN PR CARDINALITY RULE

The architecture explicitly requires:

- a Work Item may have multiple PR associations over its lifetime;
- only one implementation PR may be active for a Work Item at a time;
- a PR may implement multiple Work Items when each association is explicit.

WORK-007 must persist this domain contract.

Do not implement GitHub provider behavior yet.
Do not implement CI ingestion or merge orchestration.

---

# 4. ACCEPTANCE CRITERIA

## WORK-AC-01 — Work Item requires ArchitectureVersion

Every Work Item references exactly one ArchitectureVersion.

**Evidence:** database constraint/integration test.

The traceability chain must be:

```text
Work Item
→ ArchitectureVersion
→ Architecture
→ Project
→ Organization
```

A Work Item may not exist without an ArchitectureVersion reference.

---

## WORK-AC-02 — Historical PR associations are preserved

A Work Item can have multiple historical Pull Request associations over time.

**Evidence:** integration test.

Closing/superseding a previous PR must not erase its historical association.

WORK-007 must persist the association/domain state but must not implement GitHub API calls.

---

## WORK-AC-03 — Second simultaneous active implementation PR is rejected

A Work Item may have only one active implementation PR at a time.

**Evidence:** database constraint/integration test.

The active-PR rule must be enforced so that two concurrent active implementation PR associations cannot exist for the same Work Item.

Do not rely solely on frontend/application convention.
Use PostgreSQL constraints/indexes/transactional enforcement where appropriate.

---

## WORK-AC-04 — One PR can explicitly associate multiple Work Items

A single Pull Request association record can explicitly reference multiple Work Items.

**Evidence:** integration test.

Do not impose a one-PR-per-work-item model.

---

## DEP-AC-01 — Dependency references existing Work Items

A Work Item dependency must reference an existing Work Item.

**Evidence:** database constraint.

---

## DEP-AC-02 — Incomplete dependency blocks IMPLEMENTING eligibility

Represent enough dependency state for later `/workflows` logic to determine whether a Work Item is eligible for implementation.

**Evidence:** integration/domain test.

Do **not** implement the workflow state machine yet.

Expose a reusable domain-level dependency eligibility contract.

---

## DEP-AC-03 — Circular Work Item dependencies are rejected

Circular dependency graphs are rejected.

**Evidence:** unit/integration test.

The implementation must prevent direct and indirect cycles.

Do not confuse this with Requirement dependencies already implemented in WORK-006.

---

# 5. WORK ORDER

## WO-AC-01 — Work Order contract

A Work Order contains references for:

- project;
- Work Item;
- ArchitectureVersion;
- Requirements;
- Acceptance Criteria;
- architecture constraints;
- verification requirements;
- implementation context;
- scope/out-of-scope information;
- required evidence/verification context.

**Evidence:** API contract/integration test.

The Work Order must be persisted or represented through a stable `/work-items` domain contract that later `/llm` and `/agents` modules can consume.

Do not implement Work Order generation yet.

---

## WO-AC-02 — Work Order state ownership

Work Order state is owned by `/work-items`.

**Evidence:** static architecture check.

Do not move Work Order state into `/workflows`, `/llm`, or `/agents`.

---

# 6. MODULE OWNERSHIP

`/work-items` owns:

- Work Item;
- Work Item dependencies;
- Work Item ↔ Requirement associations;
- Work Item ↔ Acceptance Criterion associations;
- assignment/execution metadata required by the frozen architecture;
- Pull Request association records as part of the Work Item domain contract;
- Work Order;
- Work Order state.

Do **not** move these responsibilities into:

- `/requirements`;
- `/architecture`;
- `/workflows`;
- `/github`;
- `/llm`;
- `/agents`;
- `/verification`;
- `/reviews`.

Later modules consume these contracts.

---

# 7. REQUIREMENT / CRITERION ASSOCIATIONS

A Work Item must be able to identify the Requirements and Acceptance Criteria it implements.

Those references must be validated.

A Work Item must not associate a Criterion from a Requirement that belongs to an unrelated architecture/project context.

Use existing Requirement/Criterion ownership and architecture traceability.

At minimum validate:

```text
Work Item
→ ArchitectureVersion
```

and each associated Requirement/Criterion is compatible with that same ArchitectureVersion/project context.

Do not duplicate Requirement or Criterion records.

---

# 8. WORK ITEM MODEL

Inspect the frozen architecture and requirements.

The Work Item should support at minimum:

- stable ID;
- project ownership/context;
- ArchitectureVersion reference;
- objective/title;
- scope;
- out-of-scope information;
- constraints;
- Requirement associations;
- Criterion associations;
- dependency relationships;
- assignment metadata;
- execution metadata;
- PR associations;
- verification/review references required by the domain contract;
- timestamps/metadata.

Do not implement the actual verification or review engines.

Persist references needed by later modules.

---

# 9. ASSIGNMENT / EXECUTION

Persist the assignment/execution metadata required by the frozen architecture.

Do **not** implement:

- Agent Gateway;
- Agent Run execution;
- LLM reasoning;
- workflow scheduling.

The Work Item domain should provide stable fields/records later modules can update.

Do not invent broad execution semantics beyond the frozen architecture.

---

# 10. WORK ITEM DEPENDENCIES

Represent a directed graph:

```text
WorkItem A
  depends_on
WorkItem B
```

Requirements:

- dependency target must exist;
- self-dependency must fail;
- indirect cycles must fail;
- dependency state must be queryable;
- eligibility must be deterministic.

Do not let Redis become authoritative dependency state.

PostgreSQL is authoritative.

Provide a reusable domain method/contract such as:

```text
canBeginImplementation(workItemId)
```

that determines eligibility from persisted dependencies and their authoritative status.

Do not connect this directly to the workflow state machine yet.

---

# 11. PULL REQUEST ASSOCIATION DOMAIN

Implement a provider-independent Pull Request reference.

At minimum support:

- stable internal association ID;
- Work Item reference;
- external PR identity/reference;
- provider;
- repository reference if needed;
- status needed to distinguish active vs historical;
- created/closed/superseded timestamps or equivalent lifecycle metadata;
- explicit active flag/state as required.

The domain must support:

```text
One Work Item
→ many PR associations over time
```

and:

```text
One PR
→ many Work Items
```

with explicit association records.

The actual GitHub representation belongs to WORK-008 and later GitHub integration work.

Do not import GitHub SDK/provider code into `/work-items`.

---

# 12. ACTIVE-PR INVARIANT

The frozen rule is:

> One active implementation PR per Work Item.

Implement this at the persistence layer where practical.

For example, a PostgreSQL partial unique index or equivalent transactional constraint may enforce:

```text
work_item_id + active association
```

at most one.

Do not make this a frontend-only rule.

Test concurrent/duplicate active associations where practical.

---

# 13. WORK ORDER STATE

Inspect `/spec/architecture.md` for the exact Work Order/state semantics.

Do **not** confuse Work Order state with the global WorkflowOS workflow state machine.

The distinction is:

```text
/work-items
    owns Work Order state

/workflows
    later owns the canonical workflow state transitions
```

Persist only the Work Order states required by the frozen architecture.

If the architecture does not define an exhaustive Work Order state list, do not invent an extensive state machine. Implement the minimum explicit state contract needed by current requirements and report any genuine specification gap.

---

# 14. TENANT ISOLATION

Work Items are project/architecture scoped and therefore tenant scoped.

Reuse the existing `/auth` `AuthorizationService`.

At minimum test:

```text
Organization A
  User A
  Project A
  Architecture A
  Requirement A
  Work Item A

Organization B
  User B
  Project B
  Architecture B
  Requirement B
  Work Item B
```

Verify:

- User A can access Work Item A;
- User A cannot read or mutate Work Item B;
- User A cannot associate Work Item A with Requirements/Criteria from Project B;
- User A cannot create a PR association for Work Item B;
- identifier substitution cannot bypass tenant isolation.

Do not create a new permission hierarchy.

---

# 15. PERSISTENCE

Reuse WORK-003:

- `DatabaseClient`;
- migration runner;
- repository conventions;
- transaction abstraction;
- object storage references where necessary;
- centralized Infrastructure.

Do not create:

- another PostgreSQL client;
- another migration system;
- another DI container;
- another Redis runtime;
- another worker runtime;
- another authorization system.

Use PostgreSQL constraints for:

- ArchitectureVersion references;
- Requirement/Criterion references;
- Work Item dependencies;
- Work Item ↔ PR associations;
- active PR uniqueness;
- valid Work Order state values;
- tenant integrity.

---

# 16. API

Implement only API endpoints required to verify WORK-007.

At minimum expose contracts needed to:

- create/read/update Work Items;
- associate Requirements;
- associate Acceptance Criteria;
- create/read dependency relationships;
- determine dependency eligibility;
- create/read/update PR associations;
- create/read Work Orders;
- update Work Order state where required by the frozen contract.

All endpoints must be backend-authorized.

Do not implement:

- GitHub API calls;
- workflow transitions;
- LLM generation;
- agent execution;
- verification;
- architect reviews;
- merge orchestration.

---

# 17. STATIC ARCHITECTURE CHECKS

Extend the existing architecture checks to ensure:

- `/work-items` owns Work Item and Work Order authority;
- no other domain module imports `/work-items/internal`;
- `/work-items` does not import GitHub provider implementations;
- `/work-items` does not own workflow state;
- `/work-items` does not own verification semantics;
- `/work-items` does not own architect review semantics;
- `/work-items` does not create infrastructure clients;
- `/work-items` barrel exposes only domain contracts;
- existing WORK-001 through WORK-006 architecture checks remain intact.

Add an explicit static invariant that Work Order state is not declared in `/workflows`, `/llm`, or `/agents`.

---

# 18. REQUIRED TESTS

## Work Items

Test:

- Work Item persistence;
- ArchitectureVersion FK;
- project/tenant ownership;
- Requirement association;
- Acceptance Criterion association;
- invalid cross-project associations rejected;
- authorized access;
- cross-tenant access rejected.

## Dependencies

Test:

- valid dependency;
- invalid target dependency;
- self dependency;
- direct cycle;
- indirect multi-node cycle;
- dependency eligibility;
- incomplete dependency blocks eligibility;
- completed dependency allows eligibility.

## Pull Requests

Test:

- one Work Item can have multiple historical PR associations;
- one PR can associate with multiple Work Items;
- second active PR for same Work Item is rejected;
- historical PR association remains after becoming inactive;
- association is tenant-scoped.

Do not use GitHub API calls.

## Work Order

Test:

- Work Order persists/serializes required context;
- references project/Work Item/Architecture/Requirements/Criteria;
- scope and constraints are retained;
- required verification context is retained;
- Work Order state is constrained to the allowed values;
- Work Order belongs to the `/work-items` domain.

## Regression

All WORK-001 through WORK-006 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

---

# 19. OUT OF SCOPE

Do NOT implement:

- GitHub App or GitHub API integration;
- webhook ingestion;
- CI ingestion;
- workflow state machine;
- LLM Gateway;
- Agent Gateway;
- verification engine;
- architect reviews;
- merge orchestration;
- frontend;
- audit orchestration;
- notifications;
- deployment.

Do not implement WORK-008 or later.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

---

# 20. DEFINITION OF DONE

WORK-007 is complete only when:

- Work Items persist with exactly one ArchitectureVersion;
- Requirements and Criteria can be explicitly associated with a Work Item;
- incompatible/cross-project associations are rejected;
- Work Item dependencies persist and are cycle-safe;
- dependency eligibility is deterministically queryable;
- multiple historical PR associations are preserved;
- exactly one active PR association is allowed per Work Item;
- one PR can explicitly associate multiple Work Items;
- Work Order state is owned by `/work-items`;
- Work Order contains the required persistent/context references;
- tenant isolation is enforced;
- authorization uses the existing backend boundary;
- PostgreSQL remains authoritative;
- no GitHub provider coupling exists;
- static architecture checks pass;
- all WORK-007 tests pass;
- all prior regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-008 or later functionality is introduced.

---

# 21. FAILURE / ESCALATION RULES

If the frozen specification does not define the required Work Order state semantics well enough to implement safely:

```text
IMPLEMENTATION_BLOCKED
```

with the exact specification gap.

If implementation requires an architectural change:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If the frozen architecture itself is contradictory:

```text
ARCHITECTURE_BLOCKER
```

Do not silently invent new architecture or workflow semantics.

---

# 22. FINAL AGENT RESPONSE

When complete, return:

```text
WORK-007 COMPLETE
```

followed by:

```text
Implementation summary:
Tests/evidence:
Files changed:
Work-item/architecture traceability evidence:
Dependency-cycle/eligibility evidence:
PR-association/cardinality evidence:
Work-order evidence:
Tenant-isolation evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
