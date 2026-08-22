# Z.ai Implementation Prompt — WORK-010

You are the implementation agent for **WorkflowOS work item WORK-010 — LLM Gateway**.

Work only on WORK-010. Do not redesign the architecture or implement later work items.

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
backend/src/modules/workflows/
backend/src/modules/architecture/
backend/src/modules/github/
backend/src/platform/
backend/tests/
.github/workflows/
```

Pay particular attention to:

- the merged WORK-001 through WORK-009 module boundaries;
- existing `SecretStore`;
- PostgreSQL `DatabaseClient` and migration runner;
- Redis/worker infrastructure;
- execution/correlation ID and logging conventions;
- authorization and tenant-isolation services;
- existing static architecture checks;
- API/runtime/configuration conventions;
- existing CI/test conventions.

The frozen architecture documents are authoritative and must not be modified.

---

# 2. WORK ITEM

**WORK ITEM ID:** `WORK-010`

**Title:** LLM Gateway

### Objective

Implement the provider-independent `/llm` Gateway required by the frozen architecture.

The LLM Gateway provides a single application-facing abstraction over multiple LLM providers while keeping provider-specific APIs, credentials, models, request/response formats, retries, errors, and usage details behind provider adapters.

### Requirements

- **LLM-001** — Provide provider-independent LLM Gateway abstraction.
- **LLM-002** — Support provider selection/model selection and normalized request/response handling.
- **LLM-003** — Persist usage/execution metadata required by the architecture.
- **LLM-004** — Keep LLM credentials provider-specific and secret-managed.
- **LLM-005** — Support deterministic retry/error handling without duplicating provider logic.

### Dependency

- `WORK-009` — complete and merged.

Do not implement Agent Gateway execution, Architect Review, Work Order generation, or workflow orchestration beyond consuming the existing Workflow Engine contract where strictly required.

---

# 3. CRITICAL ARCHITECTURAL BOUNDARY

The frozen architecture defines:

```text
Architect Service
       ↓
   LLM Gateway
       ↓
Provider adapters
       ↓
OpenAI / Anthropic / Google / Other
```

The architecture requires:

- LLM providers accessed through a provider-independent interface;
- provider-specific APIs isolated from domain/application modules;
- provider credentials unavailable to domain modules;
- provider selection and model selection owned by the LLM Gateway;
- request construction, response normalization, retries, usage recording, and error handling owned by the gateway/provider boundary.

Only `/llm` may depend on provider-specific LLM SDKs.

No other module may import provider SDKs.

---

# 4. PROVIDER SUPPORT

Inspect the frozen architecture and current dependency setup before selecting exact providers.

Establish the provider-independent boundary even if WORK-010 implements only a minimal provider set.

If provider SDK dependencies already exist, reuse them.

If the frozen architecture explicitly names providers, implement the required adapters.

If providers are intentionally unspecified, implement only the minimal adapter coverage required to prove the architecture and keep the adapter interface extensible.

Normalize provider-specific:

```text
request
response
usage
model
finish/status
provider error
```

into provider-independent types.

Do not expose raw SDK request/response types through the `/llm` public barrel.

---

# 5. LLM GATEWAY CONTRACT

The public `/llm` contract must support at minimum:

- provider selection;
- model selection;
- normalized prompt/message input;
- optional system instructions;
- deterministic request metadata;
- normalized response;
- usage metadata;
- provider/model information;
- retryable/non-retryable error classification;
- correlation/execution identifier.

Use stable provider-independent interfaces/types.

Later consumers must not need to know which SDK or provider implementation is active.

---

# 6. CREDENTIALS / SECRET MANAGEMENT

Reuse the existing WORK-002 `SecretStore`.

Raw provider credentials must:

- never be stored in ordinary domain records;
- never be logged;
- never be returned in API responses;
- never be persisted in request/response transcripts unless explicitly redacted;
- never be exposed to `/workflows`, `/work-items`, `/agents`, `/verification`, or `/reviews`.

Provider adapters may retrieve credentials through `SecretStore`.

Do not create a new secret store.

Static checks must ensure provider-specific credential access stays inside `/llm`.

---

# 7. PROVIDER ADAPTER BOUNDARY

Create an internal adapter interface and provider implementations.

Conceptually:

```text
LLM Gateway
   │
   ├── OpenAI Adapter
   ├── Anthropic Adapter
   ├── Google Adapter
   └── Other Adapter
```

The application layer sees only normalized gateway types such as:

```text
LlmGateway
LlmRequest
LlmResponse
LlmUsage
LlmError
```

Provider implementations may use SDK-specific types internally.

Do not export concrete provider classes through the `/llm` public barrel unless explicitly required by the architecture.

The composition root may construct concrete adapters.

---

# 8. PROVIDER SELECTION

Provider/model selection must be explicit and deterministic.

Do not allow arbitrary callers to supply provider SDK-specific configuration objects.

Use a normalized selection contract such as:

```text
provider
model
```

and let `/llm` resolve the corresponding adapter/configuration.

Unknown provider/model combinations must fail deterministically with a normalized error.

Do not silently fall back to another provider/model.

---

# 9. REQUEST NORMALIZATION

Define a provider-independent request representation supporting at minimum:

- system instruction;
- ordered messages/turns;
- role;
- content;
- model/provider;
- optional generation settings required by the frozen architecture;
- execution/correlation ID;
- metadata.

Do not overbuild a universal multimodal/streaming protocol unless the frozen architecture requires it.

---

# 10. RESPONSE NORMALIZATION

Normalize provider responses into a stable result containing at minimum:

- generated content;
- provider;
- model;
- finish/status;
- usage metadata;
- request/execution ID;
- provider-neutral metadata where useful.

Provider-specific response details may remain inside adapter metadata, but core consumers must not depend on provider-specific types.

---

# 11. USAGE RECORDING

Persist enough durable metadata to support:

- provider;
- model;
- request/execution ID;
- input/output token usage where available;
- total usage where available;
- timestamp;
- success/failure status;
- normalized error classification where applicable.

Do not persist raw credentials.

Do not make Redis authoritative for usage.

Use PostgreSQL through existing WORK-003 persistence.

Do not create another analytics or usage database.

---

# 12. LLM REQUEST / EXECUTION RECORD

If the frozen architecture requires a durable LLM request/execution record, persist it in `/llm`.

At minimum it should support:

- stable execution/request identifier;
- Work Item/Work Order reference if the architecture requires it;
- provider/model;
- status;
- usage;
- timestamps;
- retry count;
- error classification.

Do not implement Agent Run records here unless the architecture clearly assigns them to `/llm`.

Agent Runs belong to `/agents`.

---

# 13. RETRIES

Retries must be deterministic and provider-aware.

Retry only errors classified as retryable.

Do not retry:

- invalid credentials;
- invalid requests;
- unsupported models;
- authorization failures;
- other deterministic non-retryable errors.

Retryable failures may include provider throttling or transient transport/provider failures where the adapter classifies them as retryable.

The retry policy must be centralized in the gateway.

Do not duplicate retry loops in provider adapters.

Adapters classify provider-specific errors; the gateway owns retry policy.

Retry attempts must not create inconsistent usage records.

Persist retry metadata where required by the architecture.

---

# 14. ERROR NORMALIZATION

Define a provider-independent error representation distinguishing at least:

```text
retryable
non-retryable
authentication
rate-limit
invalid-request
provider-unavailable
unknown
```

Use the exact categories required by the frozen architecture where defined.

Provider-specific errors must be translated inside `/llm`.

Do not leak SDK exceptions outside the module.

---

# 15. IDEMPOTENCY / DUPLICATES

LLM requests must be traceable using the existing execution/correlation ID.

Where retry-safe request handling is required, persist an appropriate request/execution identifier.

A repeated internal request must not accidentally create multiple authoritative usage records for one logical attempt unless the architecture explicitly models attempts separately.

If retries are modeled as attempts, record them explicitly.

---

# 16. ASYNC EXECUTION

WORK-010 does not require a new worker framework.

If long-running LLM calls need asynchronous execution, reuse the existing WORK-001/WORK-003 Queue + WorkerHost.

Do not make Redis authoritative LLM execution state.

The gateway may remain synchronously usable where appropriate; later `/agents` or `/workflows` orchestration may wrap it.

Do not implement the complete agent execution lifecycle.

---

# 17. AUTHORIZATION / TENANT SCOPE

Reuse the existing `/auth` authorization boundary where user-facing API access is involved.

At minimum:

- callers cannot access another tenant's LLM execution records;
- provider credentials are never tenant-readable;
- request/usage records are tenant-scoped when associated with a project/work item;
- cross-tenant identifiers cannot expose LLM execution metadata.

Do not create another authorization system.

---

# 18. WORK ITEM / WORK ORDER REFERENCES

If LLM execution records reference Work Items or Work Orders, reuse their existing identifiers.

Do not create duplicate Work Item or Work Order models.

Do not move Work Order authority into `/llm`.

Do not move workflow state into `/llm`.

Do not let LLM execution directly mutate workflow state.

Later `/workflows` logic consumes LLM results and requests canonical transitions.

---

# 19. ARCHITECT SERVICE BOUNDARY

The frozen architecture references an Architect Service above the LLM Gateway.

Do not implement the full Architect Service in WORK-010.

Expose the gateway capability required for a future Architect Service to call something equivalent to:

```text
LlmGateway.generate(request)
```

The architect role must remain separate from provider implementation.

Do not embed architecture-review logic in provider adapters.

---

# 20. PERSISTENCE

Reuse:

- PostgreSQL `DatabaseClient`;
- migration runner;
- existing `Infrastructure` container;
- `SecretStore`;
- existing logger/execution context;
- existing queue/worker infrastructure where needed.

Do not create:

- another database client;
- another secret store;
- another worker system;
- another cache authority;
- another provider registry outside `/llm`.

---

# 21. API

Only expose API endpoints if required to verify WORK-010.

A protected test endpoint or application-level gateway invocation may prove:

- provider selection;
- normalized request/response;
- errors;
- usage persistence;
- tenant isolation.

Do not expose raw provider SDK details.

Do not create a general-purpose public chat-completions API unless the frozen architecture explicitly requires one.

---

# 22. STATIC ARCHITECTURE CHECKS

Extend existing checks to ensure:

- only `/llm` imports provider SDK packages;
- no other module imports OpenAI/Anthropic/Google/etc. SDKs;
- provider-specific types do not appear in the `/llm` public barrel;
- provider implementations remain under `/llm/internal`;
- no other module imports `/llm/internal`;
- `/llm` uses the existing `SecretStore` rather than creating another secret mechanism;
- `/llm` does not own workflow state;
- `/llm` does not own Work Order state;
- `/llm` does not own Agent Run authority;
- `/llm` does not create competing persistence/worker infrastructure;
- existing WORK-001 through WORK-009 architecture checks remain intact.

---

# 23. REQUIRED TESTS

## Gateway contract

Test:

- normalized request acceptance;
- provider selection;
- model selection;
- normalized response;
- provider-independent public types hiding SDK-specific structures.

## Provider adapters

For every implemented adapter test:

- successful response normalization;
- usage normalization;
- provider error normalization;
- retryable error classification;
- non-retryable error classification;
- credentials retrieved through `SecretStore`.

Use deterministic fake/provider fixtures where live calls are inappropriate.

Do not require live production-provider credentials in CI unless the repository explicitly supports secure integration credentials.

## Retry behavior

Test:

- retryable failure retries according to policy;
- non-retryable failure does not retry;
- retry count is recorded correctly;
- eventual success returns one logical successful result;
- terminal failure produces a normalized error.

## Usage/execution persistence

Test:

- request/execution record persists;
- provider/model recorded;
- usage recorded;
- success/failure status recorded;
- retry metadata recorded;
- no raw secret recorded.

## Tenant isolation

Test:

- User A cannot read User B's LLM execution record;
- cross-tenant identifiers do not expose usage/request metadata;
- provider credentials are never tenant-visible.

## Secret safety

Test:

- raw provider credentials do not appear in logs;
- raw credentials do not appear in persisted request/response records;
- raw credentials do not appear in API responses;
- provider adapters obtain secrets only through `SecretStore`.

## Static architecture

Test:

- provider SDK imports restricted to `/llm`;
- provider-specific concrete implementations not exported through public barrel;
- provider SDK types do not leak into public interfaces;
- no duplicate secret/persistence/worker infrastructure;
- workflow state remains owned by `/workflows`.

## Regression

All WORK-001 through WORK-009 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

CI must pass.

---

# 24. OUT OF SCOPE

Do NOT implement:

- Agent Gateway;
- Agent Runs;
- Work Order generation;
- Architect Service;
- architect reviews;
- verification engine;
- workflow orchestration;
- GitHub integration changes;
- frontend;
- notifications;
- deployment;
- WORK-011 or later.

Do not let LLM provider code mutate Work Item or workflow state directly.

Do not create a second state machine.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

---

# 25. DEFINITION OF DONE

WORK-010 is complete only when:

- `/llm` exposes a provider-independent LLM Gateway;
- provider/model selection is normalized;
- provider-specific SDK/API types remain inside `/llm`;
- credentials are obtained through the existing `SecretStore`;
- raw credentials never enter logs or persistence;
- provider responses/errors/usage are normalized;
- retry policy is centralized and deterministic;
- retryable and non-retryable errors behave correctly;
- LLM execution/usage metadata is durably persisted where required;
- tenant isolation is enforced for persisted LLM execution data;
- existing infrastructure is reused;
- no duplicate worker/database/secret infrastructure is introduced;
- static architecture checks pass;
- all WORK-010 tests pass;
- all prior regression tests pass;
- typecheck passes;
- lint passes;
- CI passes;
- frozen specification documents remain unchanged;
- no WORK-011 or later functionality is introduced.

---

# 26. FAILURE / ESCALATION RULES

If the frozen architecture does not define sufficient provider/LLM behavior to implement the gateway without inventing architecture:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If a required authorization/secret contract cannot be satisfied within the existing architecture:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently invent a new provider architecture.

---

# 27. FINAL AGENT RESPONSE

When complete, return:

```text
WORK-010 COMPLETE
```

followed by:

```text
Implementation summary:
Tests/evidence:
Files changed:
Provider-boundary evidence:
Secret-safety evidence:
Usage/retry evidence:
Tenant-isolation evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.
