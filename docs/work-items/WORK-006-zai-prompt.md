# Z.ai Implementation Prompt — WORK-006

You are the implementation agent for **WorkflowOS work item WORK-006 — Requirements and acceptance criteria**.

Work only on WORK-006. Do not redesign the architecture or implement later work items.

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
backend/src/modules/requirements/
backend/src/modules/architecture/
backend/src/modules/projects/
backend/src/modules/specifications/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to:

- the merged WORK-001 through WORK-005 module boundaries;
- PostgreSQL `DatabaseClient` and migration runner;
- repository and persistence conventions;
- centralized infrastructure/dependency injection;
- existing authorization and tenant-isolation mechanisms;
- existing object-storage abstraction;
- API/runtime conventions;
- existing static architecture checks;
- existing CI/test conventions.

The frozen architecture documents are authoritative and must not be modified.

---

# 2. WORK ITEM

**WORK ITEM ID:** `WORK-006`

**Title:** Requirements and acceptance criteria

### Objective

Implement the authoritative `/requirements` domain for:

- Requirements;
- requirement dependencies;
- architecture-version traceability;
- verification-requirement metadata;
- Acceptance Criteria;
- criterion status;
- references to evidence for later verification.

### Requirements

- **REQ-001** — Persist Requirements, architecture references, dependencies, verification requirements, and status.
- **REQ-002** — Persist Acceptance Criteria with unique IDs, expectations, status, and evidence references.

### Dependency

- `WORK-005` — complete and merged.

Do not implement `/work-items`, verification semantics, or workflow orchestration.

---

# 3. ACCEPTANCE CRITERIA

## REQ-AC-01 — Requirement IDs are unique

Requirement identifiers are unique within the authoritative requirement domain.

**Evidence:** database constraint/integration test.

A duplicate requirement ID must be rejected by PostgreSQL rather than merely detected by application logic.

---

## REQ-AC-02 — Requirement references exactly one ArchitectureVersion

Every Requirement references exactly one ArchitectureVersion.

**Evidence:** database constraint/integration test.

The reference must point to an existing ArchitectureVersion.

A Requirement must not exist without an ArchitectureVersion reference.

---

## REQ-AC-03 — Requirement dependencies are valid

Requirement dependencies reference existing Requirements.

**Evidence:** database constraint/integration test.

Invalid references must fail.

Requirements must not silently depend on nonexistent Requirements.

---

## AC-AC-01 — Criterion IDs are unique

Acceptance Criterion identifiers are unique according to the frozen requirements model.

**Evidence:** database constraint/integration test.

---

## AC-AC-02 — Each Criterion belongs to exactly one Requirement

Every Acceptance Criterion belongs to exactly one Requirement.

**Evidence:** database constraint/integration test.

---

## AC-AC-03 — Criterion status is constrained

Criterion status is limited to:

```text
PENDING
PASS
FAIL
BLOCKED
```

**Evidence:** database constraint/unit test.

Invalid statuses must be rejected.

Do not invent additional criterion states.

---

## AC-AC-04 — Criteria can reference evidence records

Acceptance Criteria can persist references to evidence records without making `/requirements` the owner of verification semantics.

**Evidence:** integration test.

The requirement domain stores the stable reference/association needed by the later `/verification` module.

Do not implement the verification engine yet.

---

# 4. MODULE OWNERSHIP

The `/requirements` module owns:

- Requirement;
- requirement dependency relationships;
- verification-requirement metadata associated with a Requirement;
- AcceptanceCriterion;
- criterion status;
- requirement-to-criterion relationships;
- requirement/criterion architecture traceability;
- references to evidence.

Do **not** move these responsibilities into:

```text
/architecture
/work-items
/verification
/workflows
```

The `/verification` module will later own evidence interpretation and derived verification semantics.

The `/work-items` module will later consume Requirements and Acceptance Criteria.

---

# 5. ARCHITECTURE TRACEABILITY

Preserve this relationship:

```text
Requirement
    ↓
ArchitectureVersion
    ↓
Architecture
    ↓
Project
    ↓
Organization
```

Every Requirement belongs to exactly one architecture version.

Do not duplicate ownership fields unnecessarily when the existing architecture relationships already provide them.

A Requirement must not be associated with an unrelated project or architecture in a way that bypasses its ArchitectureVersion.

Inspect the existing `/architecture` implementation and use its stable public contract.

### Architecture-version compatibility

Follow the frozen specification regarding whether Requirements may reference `DRAFT` and `FROZEN` architecture versions.

Do not introduce a new lifecycle rule.

Do not implement architecture-version lifecycle changes in WORK-006.

---

# 6. REQUIREMENT MODEL

The Requirement model should support at least:

- stable identifier;
- human-readable title/name;
- description;
- exactly one ArchitectureVersion reference;
- requirement status required by the frozen specification;
- dependency relationships;
- verification-requirement metadata;
- timestamps/metadata required by the architecture.

Inspect the frozen documents and existing repository conventions for exact field/status semantics.

Do not invent large future schemas for Work Items or Verification.

---

# 7. REQUIREMENT DEPENDENCIES

Requirements can depend on other Requirements.

Represent this relationship explicitly.

The dependency model must:

- reference existing Requirements;
- prevent self-dependency;
- preserve dependency direction;
- be queryable;
- be available to later requirements/work-item consumers.

Do not implement the complete work-item dependency graph. That belongs to later work.

Do not add circular-dependency rules unless the frozen requirements specification assigns that responsibility to `/requirements`.

If the frozen specification explicitly requires requirement-cycle rejection, implement and test it.

Otherwise, keep this capability limited to valid persisted references and self-dependency prevention.

---

# 8. ACCEPTANCE CRITERIA MODEL

Each Acceptance Criterion belongs to exactly one Requirement.

Each Criterion must support at least:

- stable criterion ID;
- Requirement reference;
- expectation/description;
- status;
- evidence references;
- timestamps/metadata required by the architecture.

Criterion IDs must be unique.

A Criterion must not belong to multiple Requirements.

Do not put actual verification logic in this module.

---

# 9. EVIDENCE REFERENCES

The requirement domain must persist references to evidence that may later be produced by `/verification`.

The evidence reference must be provider-independent.

The reference may identify evidence originating from:

- CI;
- GitHub;
- an automated test;
- an artifact;
- manual verification;
- another future verification provider.

Do not implement `/verification`.

Do not make `/requirements` interpret evidence.

Do not let an LLM or implementation agent directly become the authoritative source of criterion verification.

WORK-006 establishes persistence and contracts for later verification integration.

---

# 10. STATUS AUTHORITY

`/requirements` owns the persisted Criterion status field.

WORK-006 does **not** implement the future evidence-evaluation engine.

Do not create logic that treats an implementation agent's statement as authoritative evidence.

Do not automatically mark Criteria `PASS` because an agent reports success.

The eventual `/verification` module will evaluate evidence and verification semantics.

For this work item, focus on:

- persistence;
- constraints;
- stable contracts;
- safe status representation.

---

# 11. TENANT ISOLATION

Requirements are project/architecture scoped and therefore tenant scoped.

Reuse the existing WORK-002 authorization boundary.

Demonstrate at least:

```text
Organization A
  User A
  Project A
  Architecture A
  Requirement A

Organization B
  User B
  Project B
  Architecture B
  Requirement B
```

Verify:

- User A can access authorized requirements for Project A;
- User A cannot read Requirement B;
- User A cannot mutate Requirement B;
- identifier substitution cannot bypass tenant isolation.

Do not create a new authorization system.

---

# 12. AUTHORIZATION

Use the existing `AuthorizationService`.

Use the existing project permission model:

- `project.read` for reads;
- `project.write` for requirement/criterion creation or mutation;
- `project.admin` only when genuinely required.

Do not create a new permission hierarchy.

If an operation genuinely requires a permission that does not exist and cannot safely use the existing model, stop and report:

```text
IMPLEMENTATION_BLOCKED
```

with the exact authorization gap.

---

# 13. PERSISTENCE

Reuse WORK-003:

- `DatabaseClient`;
- migration runner;
- transaction abstraction;
- existing repository conventions;
- centralized infrastructure;
- existing object-storage references where necessary.

Do not create:

- another PostgreSQL client;
- another migration system;
- another repository framework;
- another DI container;
- another Redis runtime;
- another verification/evidence engine.

Use PostgreSQL constraints for:

- unique Requirement IDs;
- ArchitectureVersion references;
- requirement dependency references;
- unique Criterion IDs;
- Criterion → Requirement relationship;
- Criterion status values;
- evidence-reference relationships.

Use transactions where multiple related records must be created or changed atomically.

---

# 14. API

Implement only API endpoints needed to verify WORK-006.

At minimum expose contracts for:

- create/read/update Requirements;
- create/read/update Acceptance Criteria;
- add/remove Requirement dependencies;
- associate evidence references with Criteria where appropriate.

All endpoints must be backend-authorized.

Do not implement:

- Work Item APIs;
- verification APIs;
- workflow APIs;
- GitHub APIs;
- frontend.

Keep business logic in the module/application layer rather than route handlers.

---

# 15. STATIC ARCHITECTURE CHECKS

Extend the existing architecture checks as necessary.

Verify:

- `/requirements` owns Requirement and AcceptanceCriterion authority;
- other modules do not import `/requirements/internal`;
- `/requirements` does not own verification semantics;
- `/requirements` does not own workflow state;
- `/requirements` does not directly depend on GitHub providers;
- `/requirements` does not construct infrastructure clients;
- cross-module dependencies use existing public interfaces;
- existing WORK-001 through WORK-005 checks remain intact.

Do not weaken existing architecture enforcement.

---

# 16. REQUIRED TESTS

## Requirements

Test:

- Requirement creation/persistence;
- unique Requirement ID enforcement;
- ArchitectureVersion foreign-key enforcement;
- tenant isolation;
- Requirement update/read authorization;
- invalid dependency reference rejection;
- self-dependency rejection;
- Requirement dependency persistence/querying.

## Acceptance Criteria

Test:

- Criterion creation/persistence;
- unique Criterion ID enforcement;
- exactly-one-Requirement relationship;
- allowed statuses;
- invalid status rejection;
- evidence-reference persistence;
- cross-tenant access rejection.

## Traceability

Test the complete chain:

```text
Requirement
→ ArchitectureVersion
→ Architecture
→ Project
→ Organization
```

and verify invalid references fail.

## Regression

All existing WORK-001 through WORK-005 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

---

# 17. OUT OF SCOPE

Do NOT implement:

- Work Items;
- Work Order state;
- work-item dependency graph;
- GitHub integration;
- LLM Gateway;
- Agent Gateway;
- verification engine;
- evidence evaluation;
- architect reviews;
- workflow state machine;
- frontend;
- notifications;
- deployment.

Do not implement WORK-007 or later functionality.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

---

# 18. DEFINITION OF DONE

WORK-006 is complete only when:

- Requirements persist with stable unique IDs;
- every Requirement references exactly one ArchitectureVersion;
- Requirement dependencies persist against existing Requirements;
- invalid/self dependency references are rejected as required;
- Acceptance Criteria persist with unique IDs;
- every Criterion belongs to exactly one Requirement;
- Criterion statuses are constrained to `PENDING`, `PASS`, `FAIL`, `BLOCKED`;
- Criteria can persist provider-independent evidence references;
- requirement/criterion traceability to Architecture is preserved;
- tenant isolation is enforced;
- backend authorization uses the existing authorization boundary;
- `/requirements` does not own verification semantics;
- no duplicate infrastructure is introduced;
- static architecture checks pass;
- all WORK-006 tests pass;
- all prior regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-007 or later functionality is introduced.

---

# 19. FAILURE / ESCALATION RULES

If the frozen specification requires behavior that conflicts with the current architecture:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing the frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If a required authorization contract is missing:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent new architecture, security models, verification semantics, or future work-item functionality.

---

# 20. FINAL AGENT RESPONSE

When complete, return:

```text
WORK-006 COMPLETE
```

followed by:

```text
Implementation summary:
Tests/evidence:
Files changed:
Requirement/architecture traceability evidence:
Tenant-isolation evidence:
Acceptance-criteria/evidence-reference evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
