# Step 2 — Generate Coding-Agent Prompt for WORK-015

You are the implementation agent for **WORK-015 — CI ingestion and verification engine** in WorkflowOS.

The frozen architecture and implementation backlog are authoritative. Work only on WORK-015. Do not redesign the architecture or implement later work items.

## Authoritative documents

Read from `main` before changing code:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

Also inspect the current implementation, especially:

```text
backend/src/modules/verification/
backend/src/modules/github/
backend/src/modules/requirements/
backend/src/modules/work-items/
backend/src/modules/workflows/
backend/src/modules/agents/
backend/src/modules/llm/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to WORK-006 Requirement/Acceptance Criterion persistence, WORK-008 GitHub provider/webhook integration, WORK-012 Agent Run records, WORK-014 architect context/evidence usage, ObjectStore, PostgreSQL, worker infrastructure, authorization/tenant isolation, and existing static architecture checks.

## Objective

Implement the `/verification` domain and GitHub CI evidence ingestion required by the frozen architecture.

Requirements:

- **GITHUB-006** — Ingest GitHub Actions workflow/check results and artifacts as provider-independent CI evidence.
- **VERIFY-001** — Persist verification runs, results, evidence, and artifact references.
- **VERIFY-002** — Explicitly map evidence to the acceptance criteria it proves.
- **VERIFY-003** — Derive criterion/requirement status from evidence, not agent claims.

Dependencies:

- WORK-006 complete
- WORK-008 complete
- WORK-003 complete

Do not implement Architect Reviews, Review Findings, workflow-state transitions beyond a read-only/integration contract strictly necessary for verification, agent execution, LLM changes, or later work items.

## Critical ownership boundaries

Preserve these boundaries exactly:

```text
/github
    GitHub provider-specific behavior
    retrieval/translation of CI workflow/check/artifact data

/verification
    VerificationRun
    Evidence
    evidence→criterion mappings
    criterion/requirement evaluation
    derived verification status

/requirements
    Requirement + AcceptanceCriterion persistence

/work-items
    Work Item + Work Order

/workflows
    canonical workflow state

/agents
    Agent Runs

/reviews
    later Architect Reviews
```

GitHub supplies evidence. Verification interprets evidence. Requirements remains the owner of Criterion persistence.

Do not collapse these boundaries.

## GitHub CI evidence ingestion

Extend `/github` with provider-independent CI data contracts representing, as applicable:

- workflow/check identity
- repository
- commit/SHA
- branch/ref
- workflow/check name
- status
- conclusion/result
- timestamps
- run URL/reference
- artifact references
- provider metadata

GitHub SDK types stay inside `/github/internal`. `/verification` must not import GitHub SDK/provider implementations.

Do not let `/github` evaluate Acceptance Criteria.

## CI evidence flow

Implement the architectural flow:

```text
GitHub Actions
    ↓
GitHub adapter/webhook
    ↓
provider-independent CI evidence
    ↓
/verification
    ↓
VerificationRun
    ↓
Evidence
    ↓
CriterionEvidenceMapping
    ↓
criterion evaluation
    ↓
derived criterion/requirement status
```

Do not let GitHub directly set criterion status. Do not let an Agent Run claim automatically become PASS.

## VerificationRun

`/verification` owns a durable `VerificationRun`.

Capture the fields required by the frozen architecture, at minimum:

- stable verification run ID
- Work Item
- Work Order where applicable
- ArchitectureVersion
- source/reference context
- verification status
- started/finished timestamps
- execution/correlation ID
- summary/result metadata
- failure/error metadata where appropriate

Inspect the frozen specification for exact status values. Do not invent an expansive workflow.

## Evidence

Implement provider-independent Evidence supporting, at minimum:

- stable identity
- type/source
- provider
- external reference
- commit/reference where applicable
- result/status
- content/summary where appropriate
- artifact reference
- created timestamp
- metadata

Possible sources include GitHub checks/runs/workflows, stored artifacts, agent-reported test results, and manual evidence where allowed.

Do not assume every evidence source is equally authoritative. Implement the authority distinctions required by the frozen architecture.

## ObjectStore

Large CI/verification artifacts must use the existing WORK-003 ObjectStore abstraction.

PostgreSQL should hold metadata/reference such as:

- stable evidence identity
- storage reference
- digest/size/type where appropriate

Do not create another artifact store.

Required conceptual relationship:

```text
CI artifact
    ↓
ObjectStore
    ↓
PostgreSQL evidence/reference
```

## Evidence → Criterion mapping

Persist explicit evidence-to-criterion mappings. A mapping must support, as required by the frozen model:

- evidence ID
- criterion ID
- relevance/relationship
- source metadata
- mapping status where required
- created timestamp

Do not infer that every CI result applies to every criterion.

## Criterion evaluation

`/verification` owns evaluation semantics.

Implement deterministic evaluation over persisted Evidence and Evidence→Criterion mappings.

Evaluation must:

- operate on persisted evidence
- identify criteria being evaluated
- produce criterion result/status
- preserve the evidence supporting the result
- never use raw agent claims as automatic PASS authority

Use exactly the criterion statuses already defined by WORK-006:

```text
PENDING
PASS
FAIL
BLOCKED
```

Do not invent additional criterion states.

## Requirement status

Inspect the frozen specification for the exact relationship between criterion status and Requirement status.

Implement only the derivation required by the frozen architecture. Do not duplicate Requirement persistence.

If Requirement status is derived from criteria, make derivation deterministic and traceable. If another boundary owns it, preserve that ownership.

## Verification authority

These are not authoritative criterion-completion mechanisms:

- Agent output
- LLM output
- Architect reasoning
- frontend state
- GitHub labels/comments
- arbitrary client claims

Only supported persisted evidence interpreted by `/verification` may produce authoritative criterion status.

## Traceability

Verification must remain tied to:

```text
VerificationRun
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

Reuse existing domain relationships. Do not create duplicate Work Item, Requirement, or Architecture records.

## Tenant isolation and authorization

Reuse the existing `/auth` AuthorizationService.

Prove cross-tenant isolation for VerificationRun, Evidence, mappings, and evaluation. A caller from Organization A must not be able to read, create, map, or evaluate data belonging to Organization B by changing identifiers.

Do not create a new authorization hierarchy.

Use existing project permissions. If a required permission is genuinely unavailable and cannot be satisfied safely within the existing model, report:

```text
IMPLEMENTATION_BLOCKED
```

with the exact gap.

## Idempotency

CI ingestion and verification processing must be retry-safe.

Duplicate GitHub deliveries or duplicate CI records must not create contradictory evidence.

Use durable PostgreSQL identifiers/constraints. Redis is not the authority for evidence or idempotency.

Where multiple attempts are semantically meaningful, model them explicitly instead of overwriting history.

## CI artifacts

Support provider-independent artifact references for items such as test reports, logs, coverage, builds, and generated verification evidence.

Do not parse every artifact type in this work item; implement only the contract required by the frozen architecture.

Large bodies belong in ObjectStore, not core relational evidence rows.

## Verification pipeline

Implement a reusable pipeline:

```text
create VerificationRun
        ↓
ingest/attach Evidence
        ↓
map Evidence → Criteria
        ↓
evaluate Criteria
        ↓
derive relevant Requirement status
        ↓
persist results
```

Each stage must be testable without HTTP.

Do not make workflow transitions part of this pipeline. Later `/workflows` consumes verification outcomes and decides whether canonical workflow transitions are legal.

## Async processing

Reuse the existing WORK-001/003 WorkerHost if asynchronous evidence processing is needed. Do not create another worker system.

Webhook-driven processing should remain:

```text
GitHub
  ↓
/github
  ↓
durable event/evidence
  ↓
existing queue
  ↓
/verification
```

Redis remains transport/coordination only. PostgreSQL remains authoritative.

## Static architecture checks

Extend existing checks to ensure:

- `/verification` owns VerificationRun, Evidence, mapping, and evaluation authority;
- `/verification` does not import GitHub SDK/provider implementations;
- `/github` does not evaluate Acceptance Criteria;
- `/agents` cannot directly mutate criterion status;
- `/llm` cannot directly mutate criterion status;
- `/workflows` does not directly evaluate Evidence;
- `/requirements` remains the owner of AcceptanceCriterion persistence;
- `/verification` uses existing PostgreSQL/ObjectStore/authorization infrastructure;
- no duplicate evidence/artifact store is introduced;
- no module defines a competing criterion-status authority;
- workflow state remains exclusively owned by `/workflows`;
- existing WORK-001 through WORK-014 checks remain intact.

Do not weaken existing architecture checks.

## Required tests

### GitHub CI ingestion

Test:

- provider-independent CI result representation;
- workflow/check ingestion;
- commit/reference association;
- artifact reference ingestion;
- invalid/unknown repository mapping behavior according to architecture;
- duplicate CI event idempotency.

Use deterministic GitHub fakes. Do not require live GitHub credentials in CI.

### VerificationRun

Test creation, Work Item/Work Order/ArchitectureVersion traceability, status, timestamps, and execution ID.

### Evidence

Test persistence, provider/reference metadata, artifact reference, ObjectStore integration for large artifacts, and duplicate evidence handling.

### Evidence mapping

Test valid mapping, invalid criterion rejection, cross-tenant rejection, and mapping persistence across repeated processing.

### Criterion evaluation

Test deterministic cases for:

- sufficient passing evidence → PASS;
- contradictory/failing evidence → FAIL;
- insufficient evidence → PENDING or the exact frozen result;
- blocked verification condition → BLOCKED where required;
- agent claim without authoritative evidence does not produce PASS.

Use the exact frozen evaluation semantics. If they are genuinely undefined, report `ARCHITECTURE_BLOCKER` rather than inventing semantics.

### Requirement derivation

Where required by the frozen specification, test all required criteria passing, a failing criterion, a pending criterion, and a blocked criterion against the expected Requirement status.

Do not invent status semantics if the frozen documents are ambiguous.

### Tenant security

Test cross-tenant reads/writes/mappings/evaluation and identifier-substitution attacks.

### Authority tests

Prove that Agent Run output, LLM/Architect output, and GitHub CI ingestion do not directly set authoritative criterion PASS.

### Workflow boundary

Verify that verification evaluation does not mutate canonical workflow state. Verification results remain verification results until `/workflows` explicitly consumes them.

### Object storage

Verify:

```text
large CI artifact
→ ObjectStore
→ evidence.storageKey
→ PostgreSQL
```

The full artifact body must not be required in the core evidence row.

### Regression

All existing WORK-001 through WORK-014 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

## Out of scope

Do NOT implement:

- Architect Reviews;
- Review Findings;
- workflow-state transitions;
- agent execution;
- LLM provider changes;
- GitHub provider redesign;
- frontend;
- notifications;
- deployment;
- WORK-016 or later.

Do not create a second evidence/artifact/verification persistence system.
Do not move AcceptanceCriterion ownership out of `/requirements`.
Do not let `/github` evaluate criteria.
Do not let `/agents` or `/llm` mark criteria PASS.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

## Definition of done

WORK-015 is complete only when:

- GitHub CI results are available through provider-independent interfaces;
- CI evidence is durably persisted;
- duplicate ingestion is idempotent;
- VerificationRuns are durably persisted;
- Evidence is durably persisted;
- large evidence/artifacts can use ObjectStore;
- Evidence→AcceptanceCriterion mappings are explicit;
- criterion evaluation is deterministic and evidence-based;
- agent/LLM/GitHub claims cannot directly become authoritative PASS;
- Requirement status is derived exactly as the frozen specification requires;
- tenant isolation is enforced;
- `/verification` owns verification semantics;
- `/requirements` remains AcceptanceCriterion authority;
- `/github` remains provider-specific CI authority;
- `/workflows` remains canonical workflow-state authority;
- no duplicate infrastructure is introduced;
- static architecture checks pass;
- all WORK-015 tests pass;
- all prior regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-016 or later functionality is introduced.

## Failure / escalation rules

If the frozen specification does not define enough evaluation semantics to implement criterion/requirement status safely:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If a required authorization/security contract cannot be satisfied using existing contracts:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent verification authority or status semantics.

## Final agent response

Return:

```text
WORK-015 COMPLETE

Implementation summary:
Tests/evidence:
Files changed:
Verification/evidence authority evidence:
Tenant-isolation evidence:
CI-ingestion evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.