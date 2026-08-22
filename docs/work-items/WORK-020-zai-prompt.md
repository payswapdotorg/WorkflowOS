# Step 2 — Generate Coding-Agent Prompt for WORK-020

You are the implementation agent for **WorkflowOS work item WORK-020 — Audit and privileged-event trail**.

Work only on WORK-020. Do not redesign the architecture or implement later work items.

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
backend/src/modules/audit/
backend/src/modules/workflows/
backend/src/modules/architecture/
backend/src/modules/projects/
backend/src/modules/work-items/
backend/src/modules/github/
backend/src/modules/verification/
backend/src/modules/reviews/
backend/src/modules/agents/
backend/src/modules/llm/
backend/src/platform/
backend/tests/
.github/workflows/
```

The frozen architecture documents are authoritative and must not be modified.

## Work item

**WORK-020 — Audit and privileged-event trail**

Implement the authoritative `/audit` domain and workflow audit-emission boundary required by `AUDIT-001` and `WORKFLOW-005`.

The system must preserve an append-oriented, durable trail of material actions while keeping domain state authoritative in its owning modules.

## Module ownership

`/audit` owns:

- AuditEvent persistence;
- audit event schema;
- event normalization;
- append-only audit history;
- audit query/read contracts;
- audit-specific integrity rules.

`/workflows` remains the sole owner of canonical workflow state and transitions.

Existing modules remain authoritative for their domains:

```text
/architecture     Architecture + ArchitectureVersion + change control
/projects         Project + repository association
/work-items       Work Item + Work Order + PR association
/github           GitHub/repository/PR/CI provider boundary
/verification     VerificationRun + Evidence + criterion evaluation
/reviews          Architect Review + Review Findings
/agents           Agent Runs
/llm              LLM/Architect execution
```

Do not move domain authority into `/audit`.

## AuditEvent contract

Inspect the frozen specification for exact fields. At minimum support:

```text
event ID
event type
actor/source
organization/tenant
project
resource type
resource ID
correlation/execution ID
timestamp
event metadata
```

Where relevant, support safe references to:

```text
work item
work order
architecture version
review
verification run
agent run
pull request
```

Prefer stable identifiers plus structured metadata. Do not denormalize complete domain records into audit events.

## Append-only history

Audit history must be append-oriented.

Normal application operations must not silently update or delete an existing audit event.

Use PostgreSQL protections where appropriate and demonstrate the protection at the persistence layer.

The audit system is forensic/governance infrastructure, not the source of truth for underlying domain state.

## Authority direction

The required relationship is:

```text
domain state
    ↓
domain operation
    ↓
audit event
```

Not:

```text
audit event
    ↓
domain state
```

Audit ingestion must never mutate:

- workflow state;
- requirements or criteria;
- reviews;
- work items;
- architecture versions;
- GitHub state.

## Material actions

Inspect the frozen architecture and backlog to determine the required material event set.

At minimum identify applicable actions among:

```text
identity/security actions
project/domain actions
architecture changes
Requirement/Work Item material actions
Work Order creation/state changes
GitHub integration/PR lifecycle actions
workflow transitions
verification outcomes
architect review/finalization
merge/verified progression
```

Do not invent an unnecessarily large event taxonomy. Preserve concrete event names from the frozen specification when defined. Otherwise keep the taxonomy minimal and deterministic.

## Workflow audit

Workflow actions must be auditable.

The Workflow Engine should emit audit events for canonical transitions, for example:

```text
workflow transition
    DRAFT → READY
        ↓
AuditEvent
```

and:

```text
workflow transition
    APPROVED → MERGED
        ↓
AuditEvent
```

Capture, where applicable:

- work item;
- previous state;
- new state;
- transition type;
- actor/source;
- execution/correlation ID;
- timestamp;
- safe reason/metadata.

Do not create a second workflow-transition history in `/audit`. Existing WorkflowEngine history remains authoritative for reconstruction.

## Audit emission boundary

Provide a reusable public audit contract following the repository's module conventions, such as:

```text
AuditEventWriter
AuditEventRepository
AuditEventQuery
```

or the equivalent stable interface.

Other modules must not instantiate database clients to write audit rows and must not import `/audit/internal`.

Use centralized infrastructure and the existing PostgreSQL abstractions.

## Transactionality

Inspect the frozen architecture for exact transaction requirements.

Where a domain mutation and its audit event must be atomic, use the existing PostgreSQL transaction boundary so they cannot permanently diverge.

Do not rely on Redis or logs for audit durability.

If a domain operation cannot conveniently participate in one transaction, use the smallest architecture-compatible mechanism rather than redesigning persistence.

## Workflow transition audit

Reuse the WorkflowEngine's authoritative transition record and idempotency mechanisms.

Do not duplicate transition logic.

Retries must not create contradictory audit history. If a transition is an idempotent no-op, do not pretend it was a new successful transition unless the frozen audit semantics explicitly require attempted-action logging.

## Privileged events

Identify privileged operations requiring heightened audit traceability, including as applicable:

```text
authentication/credential changes
authorization-sensitive actions
architecture freezing/change approval
Work Item state transitions
review finalization
workflow merges
verified completion
```

Reuse the existing authorization model. Do not create a second permission hierarchy.

Actor/source metadata should distinguish, as applicable:

```text
human user
system/workflow
GitHub integration
LLM/architect
agent
worker
```

without storing secrets.

## Secret safety

Never put raw credentials, tokens, API keys, SecretStore values, or other secrets into audit records or audit-related logs.

Store only safe identifiers/references and non-secret metadata.

Add explicit tests.

## Tenant isolation

Audit history is tenant-sensitive.

Use the existing `/auth` AuthorizationService.

At minimum prove:

```text
Organization A
  Project A
  Audit A

Organization B
  Project B
  Audit B
```

User A must not read B's audit events or create a forged audit event targeting B.

Internal audit emission must derive tenant/project/resource ownership from authoritative persisted records rather than trusting arbitrary caller metadata.

## Resource integrity

Where practical, enforce relationships such as:

```text
audit.organization
audit.project
audit.work_item
audit.architecture_version
audit.review
audit.verification_run
```

against the actual ownership chain.

Reject inconsistent references such as a Project A audit event pointing to a Work Item owned by Project B.

Use PostgreSQL constraints/triggers where appropriate and consistent with prior integrity protections.

## Metadata safety

Use structured metadata.

Do not allow metadata to become an unbounded secret/request/prompt dump.

Do not copy full request bodies, credentials, full CI payloads, or raw LLM/agent transcripts into audit records unless explicitly required by the frozen specification.

Prefer:

```text
resource IDs
event type
actor/source
safe summary
correlation ID
provider reference
```

## Audit query contract

Expose a provider-independent read contract for authorized callers.

At minimum support, according to the frozen spec:

- project/resource audit history;
- chronological ordering;
- event-type filtering where required;
- stable event IDs;
- actor/source;
- correlation/execution ID.

Do not expose raw database access or any mutation mechanism.

## API

Implement only API endpoints required to verify WORK-020.

If the frozen architecture requires user-facing inspection, support read-only endpoints such as:

```text
GET project audit history
GET resource audit history
```

All reads must be backend-authorized.

Do not expose arbitrary client audit-write endpoints:

```text
POST arbitrary audit event
PUT audit event
PATCH audit event
DELETE audit event
```

System/internal emission must use the `/audit` application boundary.

## Async/worker boundary

Audit persistence itself must be durable.

If asynchronous delivery is permitted by the frozen architecture, reuse the existing Queue/WorkerHost and preserve the required reliability/ordering semantics.

Do not use Redis as the authoritative audit store and do not create a new worker framework.

If asynchronous emission is unnecessary, prefer synchronous/transactional persistence for material actions.

## Static architecture checks

Extend existing checks to ensure:

- `/audit` owns AuditEvent persistence;
- `/audit` does not own workflow/domain state;
- `/audit` does not import provider SDKs;
- `/audit` does not create its own database infrastructure;
- `/audit` does not mutate workflow persistence;
- `/audit` does not mutate Requirements/Criterion state;
- `/audit` does not mutate Reviews;
- `/audit` does not mutate Work Orders;
- other modules do not import `/audit/internal`;
- clients cannot write arbitrary audit events;
- raw SecretStore values cannot be persisted/logged through the audit API;
- WorkflowEngine audit emission remains tied to authoritative transitions;
- no duplicate audit/event store is introduced;
- existing WORK-001 through WORK-019 architecture checks remain intact.

## Required tests

### Audit persistence

Test:

- event creation through the application boundary;
- stable event ID;
- event type;
- actor/source;
- project/tenant association;
- execution/correlation ID;
- timestamp;
- metadata.

### Append-only protection

Test:

- normal application update is rejected;
- normal application deletion is rejected;
- historical event content remains unchanged;
- insert remains possible.

Prefer a PostgreSQL-level enforcement test rather than only service validation.

### Workflow audit

Test:

```text
workflow transition
→ persistent audit event
```

Verify the audit event contains:

- Work Item;
- from state;
- to state;
- transition type;
- actor/source;
- execution/correlation ID.

Cover at least one normal transition, one correction transition, and one merge/verified transition.

### Material domain/integration events

Test the material actions required by the frozen specification, including applicable:

- architecture changes;
- Work Item/Work Order changes;
- GitHub integration actions;
- verification outcomes;
- review finalization;
- merge/verified progression.

Do not add events only to inflate test coverage.

### Transactional consistency

Where the architecture requires atomicity, test failure scenarios such as:

```text
domain mutation fails
→ no audit event

audit insertion fails
→ domain mutation rolls back
```

Implement only the transactional guarantees actually required by the frozen architecture.

### Idempotency

Test duplicate/retried operations including the applicable workflow transition, GitHub event, review finalization, and verification result.

Ensure no contradictory duplicate material audit history.

Follow frozen semantics for attempted-action logging if defined.

### Privileged events

Test privileged operations generate required audit entries, especially architecture freeze/change approval, workflow transitions, review finalization, and merge/verified completion.

### Secret safety

Test:

- raw provider secret cannot enter an audit record;
- raw API keys do not appear in audit metadata;
- SecretStore references remain safe;
- audit-emission logging does not expose secrets.

### Tenant isolation

Test:

- cross-tenant audit reads denied;
- forged cross-tenant resource IDs rejected;
- resource identifiers resolve to the correct project/organization;
- User A cannot inspect User B's audit history.

### Audit query

Test:

- chronological ordering;
- project/resource filtering;
- stable event identifiers;
- authorized reads only.

### Workflow boundary

Prove `/audit` never mutates workflow state and audit history remains supplementary forensic history rather than workflow source of truth.

### Regression

All existing WORK-001 through WORK-019 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

## Out of scope

Do NOT implement:

- notifications;
- frontend;
- deployment;
- a new authorization system;
- a new workflow state machine;
- new GitHub integration;
- a new verification engine;
- a new review system;
- new Work Item/Work Order persistence;
- WORK-021 or later functionality.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

## Definition of done

WORK-020 is complete only when:

- `/audit` owns durable AuditEvent persistence;
- audit history is append-oriented;
- material workflow/domain/integration actions required by the frozen architecture are auditable;
- workflow transitions carry auditable actor/source/context;
- privileged events are auditable;
- audit events are tenant-safe;
- cross-resource references cannot violate project/tenant ownership;
- raw secrets never enter audit records or logs;
- audit reads are backend-authorized;
- arbitrary clients cannot manufacture audit history;
- workflow state remains authoritative in `/workflows`;
- audit history is a complementary forensic record;
- no duplicate infrastructure/store is introduced;
- static architecture checks pass;
- all WORK-020 tests pass;
- all WORK-001 through WORK-019 regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-021 or later functionality is introduced.

## Failure / escalation rules

If the frozen AUDIT-AC-01..02 or WF-AUDIT-AC-01..02 semantics are ambiguous or contradictory:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing the frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If the existing authorization/security contracts cannot support the required audit boundary:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent a second audit/security/workflow architecture.

## Final agent response

When complete, return:

```text
WORK-020 COMPLETE
```

followed by:

```text
Implementation summary:
Tests/evidence:
Files changed:
Audit/append-only evidence:
Workflow audit evidence:
Tenant-isolation evidence:
Secret-safety evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
