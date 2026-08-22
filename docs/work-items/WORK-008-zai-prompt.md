# Z.ai Implementation Prompt — WORK-008

You are the implementation agent for WorkflowOS work item WORK-008 — GitHub integration and webhook ingestion.

Work only on WORK-008. Do not redesign the architecture or implement later work items.

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
backend/src/modules/github/
backend/src/modules/work-items/
backend/src/modules/projects/
backend/src/modules/requirements/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to the merged WORK-001 through WORK-007 implementation, including the Redis worker/queue, secret-management abstraction, repository association model, Pull Request association model, authorization boundary, persistence/migrations, and static architecture checks.

The frozen architecture documents are authoritative and must not be modified.

# WORK ITEM

**WORK ITEM ID:** `WORK-008`

**Title:** GitHub integration and webhook ingestion

### Objective

Implement the GitHub integration boundary required by the frozen architecture, including:

- provider-independent GitHub integration interfaces;
- secure credential access;
- project/repository synchronization boundary;
- webhook ingestion;
- webhook signature validation;
- durable event receipt;
- idempotent asynchronous webhook processing;
- GitHub-backed Pull Request synchronization needed to maintain Work Item PR associations.

### Requirements

- **GITHUB-001** — Provide GitHub integration through a provider/adaptor boundary.
- **GITHUB-002** — Ingest and process GitHub webhooks securely and idempotently.
- **GITHUB-003** — Synchronize repository/PR data required by WorkflowOS.

### Dependencies

- WORK-007 — complete
- WORK-002 — complete
- WORK-003 — complete
- WORK-004 — complete

Do not implement workflow orchestration, verification, agent execution, LLM Gateway, or CI ingestion beyond what is strictly necessary to establish GitHub event handling.

# GITHUB PROVIDER BOUNDARY

The `/github` module owns GitHub-specific behavior.

Provider-specific code must remain behind the module's adapter boundary.

Do not allow `/projects`, `/work-items`, `/requirements`, `/workflows`, `/verification`, `/agents`, or `/llm` to import GitHub SDK/provider implementations directly.

Use the existing project repository-association model from WORK-004. Do not create another repository-association representation.

# GITHUB CREDENTIALS / SECRETS

Reuse the WORK-002 secret-management abstraction.

Raw GitHub credentials must:

- never be stored in ordinary domain records;
- never be logged;
- never be returned by APIs;
- never be persisted in webhook/event records.

The GitHub adapter may retrieve credentials through the existing secret boundary.

Do not create another secret store.

# PROJECT / REPOSITORY INTEGRATION

Use the existing `/projects` repository-association contract.

The GitHub module may resolve or synchronize external repository metadata, but `/projects` remains the owner of project-domain state.

Do not move project ownership into `/github` or create duplicate project tables.

At minimum the integration must represent:

- provider = GitHub;
- external repository identity;
- canonical repository reference;
- repository metadata required by the frozen architecture.

The GitHub adapter is responsible for translating GitHub-specific responses into this provider-independent representation.

# PULL REQUEST SYNCHRONIZATION

Use the existing `/work-items` Pull Request association model. Do not create a second PR association model.

The GitHub integration must synchronize the GitHub PR information required to maintain:

- external PR identity;
- repository reference;
- branch/head metadata where required;
- lifecycle status;
- historical PR associations;
- the one-active-PR-per-Work-Item invariant already enforced by WORK-007.

If a GitHub event changes a PR status, update the existing Work Item PR association through the appropriate boundary.

Do not introduce direct GitHub imports into `/work-items`.

# WEBHOOK ARCHITECTURE

The frozen architecture requires:

```text
GitHub
  ↓
Webhook boundary
  ↓
validation
  ↓
durable event receipt
  ↓
idempotent asynchronous processing
  ↓
domain updates
```

The HTTP webhook endpoint must not perform long-running GitHub/domain synchronization synchronously.

It must:

1. validate the webhook signature;
2. validate required headers/event identifiers;
3. persist the webhook receipt;
4. return an appropriate success response;
5. enqueue asynchronous processing through the existing WORK-001/WORK-003 Redis-backed worker mechanism.

Redis must not be the authoritative webhook/event record. PostgreSQL must persist the authoritative webhook receipt/state.

# WEBHOOK SIGNATURE VALIDATION

Implement GitHub webhook signature verification at the dedicated webhook boundary.

Do not trust only the event delivery ID, accept unsigned requests, validate signatures inside unrelated domain modules, or log the raw webhook secret.

Tests must include:

- valid signature accepted;
- invalid signature rejected;
- missing signature rejected.

Use constant-time comparison where appropriate.

# EVENT RECEIPT / IDEMPOTENCY

Persist webhook deliveries in PostgreSQL.

The persisted receipt must support idempotency using the GitHub delivery identifier.

At minimum:

- duplicate delivery IDs must not create duplicate authoritative event records;
- duplicate processing must not produce duplicate domain side effects;
- processing state must be durable;
- processing can be retried safely.

Use PostgreSQL constraints/transactions for idempotency. Do not use Redis as the deduplication authority.

# WEBHOOK EVENT MODEL

Persist enough data to support:

- delivery ID;
- event type;
- repository identity/reference;
- received timestamp;
- signature-validation result where appropriate;
- processing status;
- retry/error metadata;
- event payload/reference appropriate to the architecture.

Do not store secrets or require the entire webhook payload in logs.

Large payloads may use the existing object-storage abstraction if necessary, with PostgreSQL references.

Do not invent a separate event-storage system.

# ASYNCHRONOUS PROCESSING

Reuse the existing Redis-backed worker system. Do not build another queue or worker framework.

Webhook request flow:

```text
validate
→ persist
→ enqueue
→ return
```

Worker flow:

```text
load durable receipt
→ process idempotently
→ update domain state
→ mark receipt processed/failed
```

Processing failure must not cause loss of the authoritative receipt. Provide retry-safe behavior.

# INITIAL GITHUB EVENTS

Inspect the frozen architecture/requirements to determine which GitHub events are required for WORK-008.

At minimum, support the event categories needed for:

- repository synchronization;
- pull-request synchronization;
- PR lifecycle updates relevant to existing Work Item PR associations.

Do not implement every GitHub webhook event.

Do not implement GitHub Actions/CI result ingestion yet unless required by the frozen WORK-008 contract.

# API / WEBHOOK ENDPOINTS

Implement the dedicated webhook ingress boundary using an endpoint structure consistent with the frozen architecture.

The endpoint must:

- be isolated from ordinary authenticated user APIs;
- validate GitHub signatures;
- capture the delivery ID;
- persist the delivery;
- enqueue the worker;
- return quickly.

Do not place webhook processing logic directly in the route handler.

# GITHUB ADAPTER

Create a provider-specific adapter inside `/github` for the actual GitHub API calls.

Keep external GitHub client usage isolated there.

Expose provider-independent application operations such as:

- get repository metadata;
- get repository/PR metadata;
- synchronize project repository metadata;
- retrieve PR details as required.

Do not let provider-specific SDK types leak into `/projects` or `/work-items`.

Use interfaces so tests can use deterministic fixtures/fakes.

# AUTHORIZATION

GitHub synchronization is privileged infrastructure behavior.

Do not expose arbitrary GitHub synchronization to untrusted callers.

User-facing synchronization operations, if required by WORK-008, must use the existing `/auth` authorization boundary.

Webhook processing is trusted external-provider ingress, but must still be scoped to the repository/project association represented in WorkflowOS.

Do not create a new authorization system.

# TENANT ISOLATION

GitHub events must not allow data to cross project/tenant boundaries.

At minimum verify:

- a webhook for Repository A cannot mutate Project B merely because a client-supplied identifier matches;
- repository association is resolved from the authoritative stored provider/repository reference;
- PR updates affect only Work Items associated with the corresponding repository/project;
- cross-tenant identifiers do not grant access.

Use the existing project/work-item relationships.

# PERSISTENCE

Reuse:

- PostgreSQL DatabaseClient;
- migration runner;
- Redis Queue/WorkerHost;
- object storage;
- secret-management abstraction;
- project repository association;
- Work Item PR association repository.

Do not create duplicate infrastructure.

Add only the GitHub/webhook persistence needed for WORK-008.

Use database constraints for:

- unique GitHub delivery IDs;
- valid processing state;
- repository/event identity where required;
- durable idempotency.

# STATIC ARCHITECTURE CHECKS

Extend existing architecture checks to ensure:

- only `/github` imports GitHub SDK/provider packages;
- `/projects` remains GitHub-provider independent;
- `/work-items` remains GitHub-provider independent;
- webhook route code is separate from ordinary domain modules;
- webhook processing uses existing worker infrastructure;
- `/github` does not create its own Redis/worker/database infrastructure;
- raw secrets are not persisted/logged;
- no duplicate PR association model is introduced;
- existing WORK-001 through WORK-007 architecture checks remain intact.

# REQUIRED TESTS

## GitHub provider boundary

Test:

- provider-specific implementation stays inside `/github`;
- provider-independent interfaces work with fakes;
- provider SDK types do not cross domain boundaries.

## Secrets

Test:

- GitHub credentials are retrieved through SecretStore;
- raw credentials never enter persistent domain records;
- raw credentials never appear in logs.

## Webhook validation

Test:

- valid signature accepted;
- invalid signature rejected;
- missing signature rejected;
- valid delivery ID required.

## Durable receipt

Test:

- webhook receipt persists in PostgreSQL;
- duplicate delivery ID is idempotent;
- receipt survives Redis loss.

## Asynchronous behavior

Test:

```text
HTTP webhook
→ DB receipt
→ Redis queue
→ worker
→ domain update
```

The HTTP request must return without waiting for long-running processing.

Reuse the existing worker mechanism.

## PR synchronization

Test:

- GitHub PR event updates the existing Work Item PR association;
- historical PR associations remain preserved;
- active-PR invariant remains enforced;
- one PR can remain associated with multiple Work Items;
- GitHub-specific data does not leak into `/work-items` provider-independent types.

Do not use GitHub API calls in `/work-items` tests.

## Repository synchronization

Test:

- GitHub repository metadata maps to the existing project repository association;
- project ownership remains with `/projects`;
- cross-tenant repository identifiers do not mutate unrelated projects.

## Idempotency

Deliver the same webhook twice and verify:

```text
same delivery ID
same event
        ↓
one durable receipt
one effective domain mutation
```

## Regression

All WORK-001 through WORK-007 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

# OUT OF SCOPE

Do NOT implement:

- GitHub Actions/CI verification engine;
- verification semantics;
- workflow state machine;
- LLM Gateway;
- Agent Gateway;
- agent execution;
- architect reviews;
- full repository synchronization engine;
- notifications;
- frontend;
- deployment.

Do not implement WORK-009 or later.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

# DEFINITION OF DONE

WORK-008 is complete only when:

- GitHub-specific code is isolated inside `/github`;
- GitHub credentials use the existing secret abstraction;
- repository associations use the existing project model;
- PR synchronization uses the existing Work Item PR association model;
- webhook signatures are validated;
- webhook deliveries are durably recorded in PostgreSQL;
- duplicate deliveries are idempotent;
- webhook processing is asynchronous through the existing Redis worker system;
- Redis is not the authoritative event/delivery store;
- domain updates are retry-safe;
- repository/PR updates cannot cross tenant/project boundaries;
- active PR cardinality remains enforced;
- static architecture checks pass;
- all WORK-008 tests pass;
- all prior regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-009 or later functionality is introduced.

# FAILURE / ESCALATION RULES

If the frozen GitHub/webhook requirements cannot be reconciled with the existing architecture:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If a required security/authorization contract is missing:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent new architecture.

# FINAL AGENT RESPONSE

When complete, report:

```text
WORK-008 COMPLETE

Implementation summary:
Tests/evidence:
Files changed:
Webhook validation/idempotency evidence:
Tenant-isolation evidence:
PR/repository synchronization evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
