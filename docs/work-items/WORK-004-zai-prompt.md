# Step 2 — Generate Coding-Agent Prompt for WORK-004

You are the implementation agent for WorkflowOS.

The frozen architecture and implementation backlog are authoritative.

The following work items are complete and merged into `main`:

- WORK-001 — Platform and modular-monolith foundation
- WORK-003 — PostgreSQL, Redis, object storage
- WORK-002 — Identity, organizations, permissions, tenant isolation

The next eligible work item is:

**WORK-004 — Project and specification domains**

Before changing code, read from the repository:

- `/spec/architecture.md`
- `/spec/architecture-lock.md`
- `/spec/requirements.md`
- `/spec/work-items.md`
- `/spec/dependency-graph.md`

Also inspect current `main`, especially:

- `backend/src/platform/`
- `backend/src/modules/`
- existing PostgreSQL migrations and persistence abstractions
- existing authorization/tenant-isolation implementation
- existing API/runtime conventions
- existing architecture checks
- existing tests and CI

Do NOT redesign the architecture.

## WORK ITEM

### WORK-004 — Project and specification domains

**Objective:** Implement the authoritative project domain and specification lifecycle required by the frozen architecture.

**Requirements:**

- PROJ-001 — Persist tenant-owned WorkflowOS projects and their repository associations.
- SPEC-001 — Persist specifications and their lifecycle state.

**Dependencies:**

- WORK-002 — complete
- WORK-003 — complete

WORK-002 introduced a minimal `wfos_projects` representation only to support authorization and tenant isolation.

WORK-004 must evolve that existing representation into the authoritative project domain. Do not create duplicate project tables or a competing project model/migration strategy.

## ACCEPTANCE CRITERIA

### PROJ-AC-01 — Tenant-owned projects persist

Projects persist with an owning organization/tenant and remain accessible only through the existing backend authorization boundary.

Evidence: integration test.

### PROJ-AC-02 — Repository association persists

A project can be associated with its external repository representation through a provider-independent repository/reference contract.

Evidence: integration test.

Do NOT implement GitHub integration itself. Do NOT call GitHub directly.

The project domain must persist the association required by later WORK-008 GitHub integration.

### PROJ-AC-03 — Project lifecycle is explicit

Project lifecycle/state is persisted and transitions are represented explicitly rather than inferred from unrelated fields.

Evidence: unit/integration test.

Use only lifecycle behavior required by the frozen specification. Inspect `/spec/architecture.md` and `/spec/requirements.md` before selecting exact state names.

### SPEC-AC-01 — Specification persists

A specification belongs to a tenant-owned project and persists through PostgreSQL.

Evidence: integration test.

### SPEC-AC-02 — Specification lifecycle is explicit

Specification lifecycle state is persisted and validated.

Evidence: unit/integration test.

### SPEC-AC-03 — Specification content/version traceability

A specification supports versioned/traceable content according to the frozen architecture and requirements.

Evidence: integration test.

Do not implement architecture-version management here; that belongs to WORK-005.

## ARCHITECTURAL BOUNDARIES

### `/projects`

Owns:

- project identity
- project ownership
- project lifecycle
- repository associations
- project access relationships already established by WORK-002

### `/specifications`

Owns:

- specifications
- specification lifecycle
- specification content/version references required by the frozen architecture

Do not move specification authority into `/projects`.
Do not move project authority into `/specifications`.
Do not move workflow state into either module.
Do not create a second authorization system.

## TENANT ISOLATION

Every project and specification must remain tenant-scoped.

Reuse the WORK-002 authorization model.

At minimum demonstrate:

```text
Organization A
  User A
  Project A
  Specification A

Organization B
  User B
  Project B
  Specification B
```

User A must not be able to access Project B or Specification B through identifier substitution.

Do not duplicate authorization logic inside project/specification repositories. Use the existing authorization boundary.

## PROJECT MODEL

Inspect the existing WORK-002 project table and types before changing anything.

Extend them only where necessary for PROJ-001.

The completed project model should support at least:

- stable project identity
- owning organization
- project name/metadata required by the frozen architecture
- lifecycle state
- repository association/reference

Do not implement:

- repository synchronization
- GitHub API calls
- GitHub webhook handling
- GitHub permissions
- CI ingestion

Those belong to later work items.

## REPOSITORY ASSOCIATION

Create a provider-independent project repository association/reference contract.

The project domain should be able to represent conceptually:

```text
Project
  ↓
Repository Reference
  ├── provider
  ├── external repository identifier
  ├── canonical location/reference
  └── metadata required by the frozen architecture
```

Do not couple `/projects` directly to GitHub SDKs or GitHub-specific runtime objects.

The actual GitHub adapter is WORK-008.

## PROJECT LIFECYCLE

Represent project lifecycle explicitly.

Before selecting exact state names, inspect `/spec/architecture.md` and `/spec/requirements.md`.

Use only states actually required by the frozen specification.

Transitions must be validated.

Do not implement the global WorkflowOS work-item state machine here.

## SPECIFICATION MODEL

A specification belongs to exactly one project.

A specification must remain tenant-scoped through its project.

The model must support:

- stable specification identity
- project ownership
- lifecycle state
- versioned/traceable content
- timestamps/metadata required by the frozen architecture

Do not implement architecture versions, ADRs, requirements, or acceptance criteria yet. Those are later work items.

## SPECIFICATION CONTENT

Use the existing object-storage abstraction from WORK-003 when the frozen architecture requires large/immutable specification bodies or artifacts to be stored outside core relational records.

Do not invent a second artifact-storage system.

PostgreSQL should store durable metadata/references.

## PERSISTENCE

Reuse WORK-003:

- `DatabaseClient`
- migration runner
- repository conventions
- transaction abstractions
- existing infrastructure container

Do not create another:

- PostgreSQL client
- migration system
- repository framework
- DI container
- Redis runtime

Use database constraints for:

- tenant ownership
- project/specification relationships
- uniqueness rules
- lifecycle integrity where appropriate

## AUTHORIZATION

Use the existing `/auth` `AuthorizationService`.

Project/specification routes and domain operations must be backend-authorized.

Do not place authorization decisions inside the frontend.

Do not create project-specific ad-hoc authorization logic.

At minimum test:

- authorized project owner/member access
- unauthorized project access
- cross-tenant project access
- cross-tenant specification access

## API

Add only the API endpoints necessary to exercise the WORK-004 contracts and acceptance criteria.

Do not build the full frontend.
Do not implement GitHub integration.

Prefer reusable domain/application functions behind the API rather than putting domain logic inside route handlers.

## STATIC ARCHITECTURE CHECKS

Extend the existing checks as necessary. Do not weaken existing checks.

Ensure:

- `/projects` owns project domain logic
- `/specifications` owns specification domain logic
- `/projects` does not contain specification domain authority
- `/specifications` does not contain project domain authority
- neither module imports another module's `internal/`
- neither module imports GitHub provider implementations
- neither module creates its own PostgreSQL/Redis infrastructure
- authorization continues to come from `/auth`
- object storage uses the existing provider-independent abstraction

Do not weaken existing WORK-001, WORK-002, or WORK-003 architecture checks.

## REQUIRED TESTS

### Project domain

Test:

- project creation/persistence
- tenant ownership
- lifecycle persistence
- lifecycle transition validation
- repository association persistence
- authorized access
- cross-tenant access rejection

### Specification domain

Test:

- specification creation/persistence
- specification belongs to project
- tenant isolation
- lifecycle persistence
- lifecycle transition validation
- version/content traceability
- large-content/object-storage boundary where applicable

### Regression

All existing WORK-001, WORK-002, and WORK-003 tests must continue to pass.

Tests must run in GitHub Actions. Typecheck, lint, and CI must remain clean.

## OUT OF SCOPE

Do NOT implement:

- architecture management
- architecture versions
- ADRs
- architecture change requests
- requirements
- acceptance criteria
- work items
- workflow state machine
- GitHub App
- GitHub repository sync
- GitHub webhooks
- CI ingestion
- LLM Gateway
- Agent Gateway
- verification engine
- architect reviews
- frontend
- deployment

Do not implement anything belonging to WORK-005 or later.

## DEFINITION OF DONE

WORK-004 is complete only when:

- the existing project representation has been evolved into the authoritative project domain;
- projects are tenant-owned and backend-authorized;
- project lifecycle is explicit and validated;
- repository associations persist through a provider-independent contract;
- no GitHub provider implementation is embedded in `/projects`;
- specifications persist and belong to projects;
- specification lifecycle is explicit and validated;
- specification content/version traceability is implemented according to the frozen architecture;
- object storage is reused where required;
- cross-tenant project/specification access is rejected;
- existing authorization remains authoritative;
- no duplicate infrastructure is introduced;
- all WORK-004 tests pass;
- all prior regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-005/006/007 functionality is introduced.

## FAILURE / ESCALATION RULES

If implementation requires an architectural change, report exactly:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If the existing WORK-002 project representation cannot be safely evolved into the WORK-004 project domain without violating the frozen architecture, report exactly:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently create a second project model.

## FINAL AGENT RESPONSE

Return:

```text
WORK-004 COMPLETE

Implementation summary:
Tests/evidence:
Files changed:
Project/tenant-isolation evidence:
Specification lifecycle evidence:
Repository-association evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
