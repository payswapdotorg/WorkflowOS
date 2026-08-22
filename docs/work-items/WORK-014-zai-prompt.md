# Z.ai Implementation Prompt — WORK-014

You are the implementation agent for WorkflowOS work item WORK-014 — Work-order generation and architect execution.

Work only on WORK-014. Do not redesign the architecture or implement later work items.

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
backend/src/modules/llm/
backend/src/modules/work-items/
backend/src/modules/requirements/
backend/src/modules/architecture/
backend/src/modules/github/
backend/src/modules/workflows/
backend/src/modules/agents/
backend/src/modules/reviews/
backend/src/modules/verification/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to the merged WORK-001 through WORK-013 implementation:

- existing LLM Gateway from WORK-013;
- existing Agent Gateway from WORK-012;
- Work Order persistence from WORK-007;
- ArchitectureVersion/content from WORK-005;
- Requirements and Acceptance Criteria from WORK-006;
- GitHub repository/PR data from WORK-008;
- Workflow Engine authority from WORK-009;
- authorization/tenant isolation;
- SecretStore;
- ObjectStore;
- existing static architecture checks;
- API/runtime/configuration/test conventions.

The frozen architecture documents are authoritative and must not be modified.

---

# 2. WORK ITEM

**WORK ITEM ID:** `WORK-014`

**Title:** Work-order generation and architect execution

### Objective

Implement the architect role execution boundary and Work Order generation using the existing provider-independent LLM Gateway and persistent project state.

### Requirements

- **LLM-002** — Execute the architect reasoning role from actual repository/verification evidence without owning review/workflow state.
- **LLM-003** — Generate Work Orders from persistent project state and frozen architecture context.

### Dependencies

- `WORK-006` — complete
- `WORK-007` — complete
- `WORK-013` — complete
- `GITHUB-002` — satisfied by existing WORK-008 provider-independent GitHub integration

Do not implement:

- Architect Review persistence;
- Review Findings;
- Verification Engine;
- canonical workflow transitions;
- Agent execution;
- a second LLM provider abstraction;
- a second Work Order model.

---

# 3. CRITICAL MODULE OWNERSHIP

The frozen architecture explicitly separates:

```text
/llm
    LLM Gateway
    architect reasoning execution
    Work Order generation

/work-items
    Work Item + Work Order persistence/authority

/reviews
    persisted Architect Reviews and findings

/verification
    evidence interpretation + criterion evaluation

/workflows
    canonical workflow state

/agents
    Agent Gateway + Agent Runs

/github
    GitHub provider integration
```

WORK-014 extends `/llm`.

It must NOT move Work Order ownership out of `/work-items`.

It must NOT create a second Work Order persistence model.

It must NOT persist Architect Review records in `/llm`.

It must NOT mutate canonical workflow state.

It must NOT determine criterion PASS/FAIL from agent claims.

---

# 4. ARCHITECT SERVICE

The frozen architecture defines:

```text
Architect Service
       ↓
LLM Gateway
       ↓
provider adapters
```

WORK-014 must implement the Architect Service/application boundary.

The Architect Service should:

1. assemble authoritative project context;
2. assemble the frozen ArchitectureVersion context;
3. assemble Requirements and Acceptance Criteria;
4. assemble relevant repository/GitHub evidence available through provider-independent contracts;
5. assemble persisted verification evidence when available;
6. request reasoning through the existing `LlmGateway`;
7. normalize the architect result into a canonical structured output;
8. generate a Work Order through the existing `/work-items` Work Order contract;
9. preserve traceability to the exact ArchitectureVersion and source evidence/context.

Do not implement a general autonomous architect.

---

# 5. INPUT AUTHORITY

Architect reasoning must use persistent authoritative state, not transient conversation history.

The context assembled for an architect execution must come from:

- PostgreSQL-backed project state;
- ArchitectureVersion;
- Requirements;
- Acceptance Criteria;
- Work Item where applicable;
- Work Order context where applicable;
- provider-independent GitHub repository/PR data;
- persisted verification evidence when available;
- existing specification/project state.

Do not use client-supplied arbitrary context as authoritative replacement data.

A caller may provide an execution instruction or request context, but the authoritative project/architecture/requirement data must be loaded from the backend.

---

# 6. ARCHITECT EXECUTION CONTRACT

Define a provider-independent architect execution contract within `/llm`.

At minimum support:

```text
ArchitectExecutionRequest
ArchitectContext
ArchitectExecutionResult
```

The request should contain:

- project;
- architecture/version;
- work item if applicable;
- requirements;
- acceptance criteria;
- repository evidence;
- verification evidence where available;
- execution/correlation ID;
- task/instruction;
- relevant architecture constraints.

Do not expose provider-specific LLM SDK types.

---

# 7. CONTEXT ASSEMBLY

Create a dedicated context-building service inside `/llm`.

It should resolve authoritative context through existing module contracts.

The context must include at minimum:

```text
Project
ArchitectureVersion
Requirements
Acceptance Criteria
Work Item
Repository/GitHub evidence where available
Verification evidence where available
Architecture constraints
Out-of-scope constraints
```

Do not copy authoritative records into duplicate domain tables merely to build context.

The generated architect context must be traceable to the exact source records.

---

# 8. GITHUB EVIDENCE

Use the existing provider-independent `/github` contract.

The Architect Service may consume:

- repository metadata;
- relevant branches/commits;
- pull requests;
- PR status;
- repository state;
- available checks/review data already exposed by WORK-008.

Do not import GitHub SDK/provider code into `/llm`.

Do not treat raw GitHub payloads as architecturally authoritative unless they have passed through the existing `/github` boundary.

Do not implement new GitHub synchronization behavior.

---

# 9. VERIFICATION EVIDENCE

WORK-014 may consume persisted verification evidence if it already exists.

Do not implement the Verification Engine.

Do not independently evaluate evidence.

Do not derive criterion PASS/FAIL inside `/llm`.

The architect may receive verification status/evidence as input to reasoning, but `/verification` remains authoritative for verification semantics.

If verification evidence does not exist yet, represent that fact rather than inventing evidence.

---

# 10. ARCHITECT OUTPUT

Normalize the architect result into a provider-independent structured contract.

At minimum include:

```text
verdict / outcome
summary
reasoning or rationale
identified risks
identified constraints
required corrections
architecture-change-required signal if applicable
work-order candidate data
source execution ID
provider/model metadata
```

Inspect the frozen requirements for exact architect-result semantics.

Do not invent a persisted Architect Review model in this work item.

The normalized result is an input to later `/reviews`.

---

# 11. WORK ORDER GENERATION

The primary output of WORK-014 is a generated Work Order.

Use the existing `/work-items` Work Order persistence and contract.

A generated Work Order must preserve:

- project;
- Work Item;
- ArchitectureVersion;
- Requirements;
- Acceptance Criteria;
- architecture constraints;
- implementation context;
- scope;
- out-of-scope;
- verification requirements;
- relevant source/context references;
- generation metadata;
- originating architect execution ID.

Do not create another Work Order table.

Do not allow generated Work Order context to silently drift from the authoritative ArchitectureVersion.

---

# 12. FROZEN ARCHITECTURE TRACEABILITY

Every generated Work Order must remain tied to the exact ArchitectureVersion used to generate it.

The generation flow must preserve:

```text
Architect Execution
    ↓
ArchitectureVersion
    ↓
Work Item
    ↓
Work Order
```

An architect must not generate a Work Order for a different architecture version merely because a client supplied another ID.

Validate all relevant project/tenant/version relationships.

---

# 13. IMMUTABILITY / VERSION SAFETY

The Architect Service must treat a frozen ArchitectureVersion as immutable.

It may read it.

It must not modify it.

It must not silently generate a Work Order against a version that does not match the Work Item's authoritative architecture association.

If the source architecture version is superseded or otherwise not eligible for the requested operation, follow the frozen specification.

Do not change ArchitectureVersion state in WORK-014.

---

# 14. WORK ORDER GENERATION RULES

Inspect `/spec/architecture.md`, `/spec/architecture-lock.md`, and `/spec/requirements.md` for exact generation semantics.

At minimum:

- Work Order generation must use persisted state;
- generation must preserve frozen architecture context;
- generated scope and out-of-scope must be explicit;
- requirements and acceptance criteria included in context must be persisted/referenced;
- verification requirements must be preserved;
- generation must be traceable to the architect execution.

Do not let the LLM invent authoritative requirements or acceptance criteria.

The architect may propose content, but authoritative Requirement and Acceptance Criterion identities must come from `/requirements`.

---

# 15. LLM GATEWAY USAGE

Reuse the existing `LlmGateway`.

Do NOT:

- call provider SDKs directly;
- create a new retry system;
- create a new provider abstraction;
- duplicate SecretStore usage;
- duplicate usage persistence.

The Architect Service should issue a normalized `LlmRequest` through the existing gateway.

Provider/model selection must remain inside the existing LLM boundary.

---

# 16. PROMPT / CONTEXT SAFETY

The architect prompt must distinguish:

```text
authoritative project facts
authoritative architecture constraints
authoritative requirements/criteria
external/repository evidence
untrusted claims
requested task/instruction
```

Do not allow untrusted repository content or agent output to override the frozen architecture.

Treat implementation-agent claims as claims/evidence inputs rather than authority.

Do not expose provider credentials to the prompt/context.

---

# 17. PERSISTENCE

Reuse existing:

- PostgreSQL;
- Work Order repository;
- Requirement/criterion repositories;
- Architecture repositories;
- GitHub provider-independent interfaces;
- existing LLM Gateway;
- ObjectStore where large context/artifacts require references;
- existing execution IDs/logging.

Persist only WORK-014-specific execution/context metadata that is genuinely required.

Do not create:

- another LLM execution store;
- another Work Order table;
- another requirement/criterion store;
- another architecture store;
- another GitHub repository model;
- another authorization system.

---

# 18. IDEMPOTENCY / REPEAT GENERATION

Architect executions must remain traceable by execution ID.

Repeated generation requests must not silently overwrite an existing Work Order or create contradictory Work Orders.

Inspect the existing Work Order contract and frozen architecture for the correct behavior.

Where duplicate generation is allowed, preserve historical generation metadata.

Where only one generated Work Order is appropriate, enforce that rule explicitly.

Do not rely on Redis for generation idempotency.

---

# 19. TENANT ISOLATION

Architect execution and Work Order generation are tenant/project scoped.

Reuse `/auth`.

At minimum prove:

```text
Organization A
  Project A
  Architecture A
  Requirements A
  Work Item A

Organization B
  Project B
  Architecture B
  Requirements B
  Work Item B
```

Verify:

- User A cannot execute the architect against Project B;
- User A cannot read Project B's architect execution/context;
- User A cannot generate a Work Order for Project B;
- client-supplied identifiers cannot substitute a different tenant's ArchitectureVersion or Requirements;
- generated Work Orders remain tenant-scoped.

Do not create a new authorization hierarchy.

---

# 20. AUTHORIZATION

Use existing project permissions for:

- viewing authoritative project context;
- initiating architect execution;
- generating Work Orders.

Do not create a new architect-specific authorization system unless the frozen specification explicitly requires it.

If the required permission is genuinely unavailable:

```text
IMPLEMENTATION_BLOCKED
```

with the exact gap.

---

# 21. API

Implement only API/application endpoints needed to verify WORK-014.

At minimum provide enough surface to:

- request an architect execution for a Work Item/project;
- retrieve the normalized architect execution/result;
- generate/retrieve the resulting Work Order;
- demonstrate tenant isolation.

All requests must be backend-authorized.

Do not expose a provider-specific LLM endpoint.

Do not expose raw prompt/provider credentials.

Do not expose internal context-assembly implementation details that could leak secrets.

---

# 22. ASYNC EXECUTION

Architect reasoning may be long-running.

Reuse the existing WorkerHost/Redis queue if asynchronous execution is required.

Do not create another worker system.

If asynchronous execution is used, the conceptual flow is:

```text
API
 ↓
architect execution record/request
 ↓
existing queue
 ↓
Architect Service
 ↓
LlmGateway
 ↓
normalized ArchitectExecutionResult
 ↓
Work Order generation
```

Do not make Redis authoritative for Architect Execution state.

PostgreSQL remains authoritative.

---

# 23. STATIC ARCHITECTURE CHECKS

Extend existing architecture checks to ensure:

- `/llm` owns Architect Service;
- `/llm` may consume provider-independent `/github`, `/requirements`, `/architecture`, `/work-items`, and `/verification` contracts;
- `/llm` does not import GitHub SDK/provider code;
- `/llm` does not import other modules' internals;
- `/llm` does not define Work Order persistence authority;
- `/llm` does not define canonical workflow state;
- `/llm` does not define verification semantics;
- `/reviews` remains the owner of persisted Architect Review records;
- `/work-items` remains the owner of Work Order persistence;
- `/workflows` remains the sole workflow-state owner;
- LLM provider implementations remain behind the existing LLM adapter boundary;
- existing WORK-001 through WORK-013 checks remain intact.

---

# 24. REQUIRED TESTS

## Context assembly

Test:

- authoritative Project is loaded;
- exact ArchitectureVersion loaded;
- Requirements loaded from PostgreSQL;
- Acceptance Criteria loaded from PostgreSQL;
- Work Item loaded from PostgreSQL;
- repository/GitHub evidence comes through provider-independent interfaces;
- verification evidence is consumed only when available;
- client-supplied identifiers cannot substitute unrelated tenant/project data.

## Architect execution

Test:

- request reaches existing LlmGateway;
- provider/model remain provider-independent at the Architect Service boundary;
- normalized ArchitectExecutionResult returned;
- execution ID preserved;
- provider/model metadata preserved;
- errors remain normalized.

Use deterministic FakeLlmAdapter in CI.

Do not require live provider credentials.

## Work Order generation

Test:

- Work Order generated from persisted context;
- ArchitectureVersion reference is exact;
- Requirements and Acceptance Criteria references are preserved;
- constraints/scope/out-of-scope are retained;
- verification requirements are retained;
- architect execution ID is recorded;
- Work Order belongs to the same Work Item/project/tenant;
- no duplicate Work Order model exists.

## Evidence distinction

Test:

- repository/agent claims are passed as evidence/context;
- LLM output cannot directly mark criteria PASS;
- LLM output cannot directly mutate workflow state;
- verification semantics remain outside `/llm`.

## Tenant isolation

Test:

- cross-tenant architect execution denied;
- cross-tenant context retrieval denied;
- cross-tenant Work Order generation denied;
- identifier substitution cannot bypass authorization.

## Frozen architecture safety

Test:

- Architect Service can read frozen ArchitectureVersion;
- Architect Service cannot mutate frozen ArchitectureVersion;
- generated Work Order references the same ArchitectureVersion;
- a mismatched ArchitectureVersion request is rejected.

## Repeat/idempotency

Test the frozen behavior for repeated architect generation requests.

Ensure repeated requests cannot silently overwrite or contradict an existing Work Order.

## Regression

All existing WORK-001 through WORK-013 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

---

# 25. OUT OF SCOPE

Do NOT implement:

- Architect Review persistence;
- Review Findings;
- Verification Engine;
- CI evidence ingestion;
- workflow-state transitions;
- Agent Gateway changes;
- GitHub synchronization changes;
- frontend;
- notifications;
- deployment;
- WORK-015 or later functionality.

Do not create a second Work Order model.

Do not let the Architect Service directly update workflow state.

Do not let LLM output directly set acceptance-criterion status.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

---

# 26. DEFINITION OF DONE

WORK-014 is complete only when:

- Architect Service exists inside `/llm`;
- it uses the existing provider-independent LLM Gateway;
- it builds context from authoritative persistent state;
- ArchitectureVersion context is exact and traceable;
- Requirements and Acceptance Criteria come from persistent `/requirements`;
- repository/GitHub evidence is consumed through provider-independent interfaces;
- verification evidence is consumed without implementing verification semantics;
- architect output is normalized;
- Work Orders are generated using the existing `/work-items` Work Order contract;
- generated Work Orders preserve architecture/requirement/criterion/scope/verification context;
- architect execution identity is traceable to the generated Work Order;
- tenant isolation is enforced;
- LLM credentials remain behind SecretStore;
- frozen architecture remains immutable;
- `/workflows` remains the sole canonical workflow-state authority;
- `/reviews` remains the owner of Architect Review persistence;
- no duplicate Work Order or infrastructure system is introduced;
- static architecture checks pass;
- all WORK-014 tests pass;
- all prior regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-015 or later functionality is introduced.

---

# 27. FAILURE / ESCALATION RULES

If the frozen specification does not provide enough information to distinguish architect execution from persisted review semantics:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If a required authorization contract cannot be satisfied using existing authorization:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent an architect/review/workflow architecture.

---

# 28. FINAL AGENT RESPONSE

When complete, return:

```text
WORK-014 COMPLETE
```

followed by:

```text
Implementation summary:
Tests/evidence:
Files changed:
Architect-context traceability evidence:
Work Order generation evidence:
Tenant-isolation evidence:
Frozen-architecture safety evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
