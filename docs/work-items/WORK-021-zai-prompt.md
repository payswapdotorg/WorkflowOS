# Step 2 — Generate Coding-Agent Prompt for WORK-021

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
- WORK-008 — GitHub App and repository integration
- WORK-009 — GitHub webhook ingestion and idempotency
- WORK-010 — Pull-request association and active-PR lifecycle
- WORK-011 — Canonical workflow state machine
- WORK-012 — Agent Gateway and Agent Runs
- WORK-013 — LLM Gateway
- WORK-014 — Work-order generation and architect execution
- WORK-015 — CI ingestion and verification engine
- WORK-016 — Architect reviews and findings
- WORK-017 — Workflow orchestration through implementation
- WORK-018 — Verification and architect-review orchestration
- WORK-019 — Merge gating and workflow advancement
- WORK-020 — Audit and privileged-event trail

The next eligible work item is:

**WORK-021 — Notification boundary**

Read these authoritative files from `main` before generating the implementation prompt:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

The frozen backlog defines:

```text
Objective:
Add the optional notification abstraction without coupling delivery
to authoritative workflow state.

Requirement:
NOTIFY-001

Dependencies:
WORK-020
PROJ-001

Acceptance criteria:
NOTIFY-AC-01..02

Architecture module:
/notifications

Out of scope:
mandatory provider selection
```

Also inspect current `main`, especially:

```text
backend/src/modules/notifications/
backend/src/modules/workflows/
backend/src/modules/audit/
backend/src/modules/projects/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to the already-merged WORK-017 through WORK-020 boundaries:

* `/workflows` owns canonical workflow state and orchestration;
* `/audit` owns the durable audit trail;
* `/notifications` must remain optional and non-authoritative;
* Redis/WorkerHost already provide the background execution mechanism;
* PostgreSQL remains authoritative;
* tenant authorization already exists;
* the frozen architecture deliberately does not select a mandatory notification provider.

Do NOT redesign the architecture.

# WORK ITEM OBJECTIVE

Implement the provider-independent `/notifications` boundary required by NOTIFY-001.

The intended architecture is:

```text
authoritative domain/workflow action
        ↓
notification event/request
        ↓
/notifications
        ↓
delivery abstraction
        ↓
optional provider adapter
        ↓
existing worker/queue
```

Notifications are a side effect.

They are NOT the source of truth for:

* workflow state;
* Work Item state;
* Verification state;
* Review state;
* Architecture state;
* Audit history.

# CRITICAL OWNERSHIP BOUNDARY

`/notifications` owns:

* notification message/request contract;
* recipient abstraction;
* delivery status if the frozen spec requires it;
* provider-neutral delivery interface;
* provider adapter boundary;
* retry/delivery job orchestration;
* notification preferences only if explicitly required by NOTIFY-001.

`/workflows` remains authoritative for:

* canonical workflow state;
* transitions;
* merge/verified state;
* orchestration decisions.

`/audit` remains authoritative for:

* audit history.

`/projects` remains authoritative for:

* project ownership/tenant scope.

Do not move domain authority into `/notifications`.

# NON-AUTHORITATIVE RULE

A notification must never be used as evidence that an authoritative action happened.

For example:

```text
workflow transition
    ↓
notification sent
```

is valid.

But:

```text
notification sent
    ↓
mark workflow transition completed
```

is forbidden.

Notification success/failure must not mutate canonical workflow state.

A delivery failure must not roll back or block an already-authoritative workflow transition unless the frozen specification explicitly says otherwise.

# PROVIDER-INDEPENDENT BOUNDARY

The notification interface must be provider-independent.

Use a contract conceptually equivalent to:

```text
NotificationSender
NotificationRequest
NotificationResult
```

or the exact naming appropriate for the repository.

The public `/notifications` barrel must expose only stable types/interfaces.

Provider-specific implementation belongs under:

```text
/notifications/internal/
```

Do not expose provider SDK/types through the public module interface.

Do not select a mandatory production provider.

A local/test implementation may be used.

# ACCEPTANCE CRITERIA

Before coding, inspect the exact frozen NOTIFY-AC-01 and NOTIFY-AC-02 criteria.

Implement exactly those semantics.

Do not invent extra notification requirements.

At minimum, the architecture should demonstrate that:

1. Notification requests can be emitted through the provider-neutral boundary.
2. Delivery is asynchronous/non-blocking where the frozen specification requires it.
3. Provider-specific delivery remains isolated.
4. Notification failure does not become authoritative WorkflowOS state.
5. Delivery can be retried safely where required.
6. Tenant/resource scope is preserved.
7. Duplicate notification requests do not create unintended duplicate deliveries where idempotency is required.

If NOTIFY-AC-01..02 are ambiguous or contradictory in the frozen documents:

```text
ARCHITECTURE_BLOCKER
```

Do not invent semantics.

# EVENT / REQUEST MODEL

Use an explicit notification request/event.

At minimum preserve enough context to identify:

```text
notification ID
event type
organization/tenant
project
recipient
subject/channel/type as required by the spec
safe message payload
source domain event/resource
execution/correlation ID
created_at
```

Do not copy complete domain records or sensitive provider payloads.

The request should reference authoritative domain identifiers where appropriate.

# SOURCE TRACEABILITY

Notification requests should be traceable to their source action.

Examples:

```text
workflow transition
review finalized
verification completed
merge completed
Work Item assignment
```

Use safe source identifiers such as:

```text
workItemId
reviewId
verificationRunId
workflow transition ID
audit event ID
executionId
```

Do not create duplicate domain records.

# TENANT ISOLATION

Notifications are tenant-sensitive.

A notification intended for Organization A must never be delivered using a project/resource context belonging to Organization B.

Resolve resource ownership from authoritative persisted relationships.

Do not trust arbitrary client-supplied:

```text
organizationId
projectId
workItemId
recipient
```

without validating the relationship.

Use existing `/auth` authorization for user-facing initiation/inspection.

# RECIPIENT MODEL

Inspect the frozen architecture to determine whether recipients are:

* WorkflowOS users;
* organization/project members;
* email-like addresses;
* provider-specific destinations;
* a provider-neutral recipient reference.

Do not invent a broad contact-management system.

Keep the recipient abstraction minimal.

If recipient authorization or membership is needed, reuse `/users` and `/organizations`.

Do not place organization membership logic inside `/notifications`.

# ASYNC DELIVERY

Reuse the existing WORK-001 Queue/WorkerHost.

Do NOT create another worker framework.

The intended pattern is:

```text
authoritative action
    ↓
NotificationRequest persisted/queued
    ↓
existing queue
    ↓
notification worker
    ↓
provider-neutral sender
    ↓
provider adapter
```

Redis remains transport/coordination only.

PostgreSQL remains authoritative for any durable notification record required by the frozen spec.

Do not make Redis the notification source of truth.

# FAILURE / RETRY

Notification delivery should be resilient to transient failures where required by NOTIFY-001.

Use the existing worker retry model if sufficient.

Do not build a new retry framework unless necessary.

A failed notification must not:

* change workflow state;
* change Review verdict;
* change Verification result;
* change Work Item completion;
* change Audit state.

If a retry is supported, duplicate retries must be safe.

# IDEMPOTENCY

If the frozen notification semantics require duplicate suppression, establish a stable notification identity based on the source event/resource.

Examples:

```text
same workflow transition
same notification type
same recipient
```

must not accidentally send duplicate notifications.

Do not create a global idempotency key shared across tenants.

Scope it correctly.

# AUDIT RELATIONSHIP

Notifications may reference audit events, but `/notifications` must not become the audit authority.

Valid:

```text
workflow action
   ↓
audit event
   ↓
notification
```

Also valid:

```text
workflow action
   ├── audit event
   └── notification
```

Do not make:

```text
notification
   ↓
audit event
```

the authoritative path.

If notification delivery itself is audited by the frozen architecture, use `/audit` through its public interface.

Do not import `/audit/internal`.

# WORKFLOW RELATIONSHIP

Where WORKFLOW-005 or later workflow operations emit notifications:

```text
/workflows
    ↓
provider-independent notification request
    ↓
/notifications
```

`/notifications` must not import `/workflows/internal`.

`/notifications` must not write `wfos_workflow_executions`.

Add static architecture checks to enforce this.

# API

Only implement APIs explicitly required by NOTIFY-001.

If the specification requires notification inspection, expose read-only authorized endpoints such as:

```text
GET project notifications
GET notification status
```

Do NOT expose arbitrary client-side notification write endpoints unless explicitly required.

Do not expose provider SDK details.

Do not let clients directly send notifications on behalf of the system unless NOTIFY-001 explicitly requires that behavior.

# PERSISTENCE

Reuse WORK-003 PostgreSQL infrastructure.

If the frozen specification requires durable notification records, persist them in PostgreSQL.

Do not create:

* another database client;
* another migration framework;
* another worker framework;
* another provider abstraction outside `/notifications`;
* another tenant store.

Keep notification persistence append-oriented or stateful only as required by the frozen specification.

# PRIVACY / SECRET SAFETY

Notification payloads must not contain:

* API keys;
* provider credentials;
* SecretStore values;
* auth tokens;
* internal secrets.

Use safe identifiers/references instead.

Provider adapters must receive only the minimum data necessary to deliver the notification.

Add explicit tests that raw secrets cannot enter notification records or logs.

# STATIC ARCHITECTURE CHECKS

Extend existing static checks to verify:

* `/notifications` owns notification domain authority;
* provider-specific code is isolated under `/notifications/internal`;
* public `/notifications` barrel exposes only provider-neutral contracts;
* `/notifications` cannot mutate workflow state;
* `/notifications` cannot mutate Verification/Review/Work Item state;
* `/notifications` does not import other modules' `internal/`;
* `/notifications` does not create its own queue/worker/database;
* `/notifications` does not select a mandatory provider;
* client code cannot create arbitrary notification history unless explicitly allowed;
* notification failures cannot become canonical workflow state;
* existing WORK-001 through WORK-020 architecture checks remain intact.

# REQUIRED TESTS

## Notification boundary

Test:

* notification request can be constructed through the public contract;
* provider-neutral interface accepts the request;
* provider implementation remains behind `/notifications/internal`;
* provider-specific types do not leak through the public barrel.

## Asynchronous delivery

If required by NOTIFY-AC-01/02, test:

```text
domain action
→ notification queued
→ API/domain operation returns without waiting
→ worker delivers notification
```

Use the existing Queue/WorkerHost.

Do not block the authoritative request on provider delivery.

## Failure isolation

Test:

```text
workflow transition succeeds
notification delivery fails
→ workflow state remains unchanged
→ audit state remains intact
```

and:

```text
notification delivery fails
→ retry when permitted
```

## Idempotency

Where required:

* same source event sent twice;
* worker retries same request;
* duplicate delivery attempt.

Prove no unintended duplicate side effects.

## Tenant isolation

Test:

* tenant A notification cannot use tenant B resource context;
* unauthorized user cannot inspect tenant B notification state;
* forged project/organization identifiers are rejected.

## Secret safety

Test:

* raw secret is not persisted;
* raw secret is not logged;
* provider adapter receives only allowed data.

## Provider isolation

Test:

* fake/local provider works through the public interface;
* provider-specific implementation is isolated;
* `/notifications` public barrel contains no provider-specific value exports.

## Workflow boundary

Prove:

* notification delivery does not mutate workflow state;
* notification failure does not alter workflow state;
* `/notifications` cannot set `MERGED` or `VERIFIED`;
* `/notifications` cannot mutate canonical workflow persistence.

## Optional audit integration

If the frozen architecture requires notification events to be auditable, prove the notification operation can emit audit information through `/audit` without creating a second audit store.

## Regression

All existing WORK-001 through WORK-020 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

# OUT OF SCOPE

Do NOT implement:

* mandatory notification provider selection;
* frontend notification UI;
* push/mobile infrastructure;
* email provider architecture unless already specified;
* user preference/notification settings system unless frozen by NOTIFY-001;
* new authorization system;
* new audit system;
* new workflow engine;
* new queue/worker system;
* WORK-022 or later functionality.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

# DEFINITION OF DONE

WORK-021 is complete only when:

* `/notifications` exposes a stable provider-independent boundary;
* provider-specific delivery is isolated behind an adapter;
* notification delivery uses the existing Queue/WorkerHost where async behavior is required;
* notification failure cannot become authoritative workflow/domain state;
* tenant/resource relationships are validated;
* duplicate requests are handled according to frozen semantics;
* secrets cannot enter notification persistence/logs/provider payloads improperly;
* notification history/state, if required, persists through PostgreSQL;
* no mandatory provider is selected beyond the frozen architecture;
* static architecture checks pass;
* all WORK-021 tests pass;
* all WORK-001 through WORK-020 regression tests pass;
* typecheck passes;
* lint passes;
* CI passes;
* frozen specification documents remain unchanged;
* no WORK-022 or later functionality is introduced.

# FAILURE / ESCALATION RULES

If NOTIFY-AC-01 or NOTIFY-AC-02 is ambiguous or contradictory:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If existing authorization/security contracts cannot safely support required notification behavior:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent a mandatory provider or notification architecture.

# FINAL OUTPUT

Return only the final coding-agent prompt suitable for Z.ai.

When done send the final prompt to Z.ai on:

```text
feat/WORK-021-notification-boundary
```

targeting `main`.

Do NOT merge the PR.
