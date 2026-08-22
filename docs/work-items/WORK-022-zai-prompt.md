# Step 2 — Generate Coding-Agent Prompt for WORK-022

You are the Architecture Authority for WorkflowOS.

The frozen architecture, requirements, and implementation backlog are authoritative.

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
- WORK-016 — Architect Reviews and Review Findings
- WORK-017 — Workflow orchestration through implementation
- WORK-018 — Verification and architect-review orchestration
- WORK-019 — Merge gating and workflow advancement
- WORK-020 — Audit and privileged-event trail
- WORK-021 — Notification boundary

The next eligible work item is:

**WORK-022 — WorkflowOS web application**

Read these authoritative files from `main`:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

The frozen backlog defines WORK-022 as:

```text
Objective:
Implement authoritative read views and authorized actions without
embedding workflow or authorization authority in frontend code.

Requirements:
UI-001
UI-002
UI-003

Dependencies:
WORK-002
WORK-004
WORK-005
WORK-006
WORK-007
WORK-019
WORK-020

Acceptance criteria:
UI-AC-01..02
UI2-AC-01..02
UI3-AC-01..02

Required verification:
end-to-end, API contract, static architecture tests

Architecture modules affected:
Web Application / backend API

Expected repository areas:
frontend, API endpoints, authorization boundary

Out of scope:
frontend-owned workflow logic or authorization

Definition of done:
Authorized users can observe and act on state while the backend retains authority.
```

The architecture explicitly defines the frontend as a web application responsible for displaying:

```text
project state
architecture
requirements
work items
agent execution state
GitHub pull requests
verification results
architect reviews
audit history
```

and allowing authorized users to perform workflow actions, while explicitly prohibiting frontend ownership of authoritative workflow logic or authorization.

The frozen UI acceptance criteria are:

```text
UI-AC-01:
Authorized users can view project/architecture/requirements/work-item state.

UI-AC-02:
Frontend consumes backend state and does not own authoritative workflow state.

UI2-AC-01:
Authorized users can view Agent Runs/PRs/verification evidence/reviews/audit history.

UI2-AC-02:
Displayed workflow state matches backend after refresh.

UI3-AC-01:
Unauthorized users cannot perform privileged workflow actions through direct backend calls.

UI3-AC-02:
Frontend has no authoritative transition/authorization rules.
```

Also inspect current `main`, especially:

```text
backend/src/api/
backend/src/modules/auth/
backend/src/modules/users/
backend/src/modules/organizations/
backend/src/modules/projects/
backend/src/modules/architecture/
backend/src/modules/specifications/
backend/src/modules/requirements/
backend/src/modules/work-items/
backend/src/modules/workflows/
backend/src/modules/verification/
backend/src/modules/reviews/
backend/src/modules/llm/
backend/src/modules/agents/
backend/src/modules/github/
backend/src/modules/audit/
backend/src/modules/notifications/
backend/src/platform/
backend/tests/
```

Also inspect the repository root to determine whether a frontend/web application already exists. Reuse any existing frontend foundation that does not conflict with the frozen architecture.

If no frontend exists yet, establish the smallest coherent web application foundation needed by WORK-022. Do not introduce unnecessary framework or infrastructure changes beyond what the repository requires.

# CRITICAL ARCHITECTURE RULE

The frontend is a **consumer and action initiator**, never an authority.

The authoritative model is:

```text
Frontend
   ↓
Backend API
   ↓
Authoritative domain/workflow services
   ↓
PostgreSQL / GitHub / existing providers
```

Never:

```text
Frontend
   ↓
workflow state mutation
```

Never:

```text
Frontend
   ↓
authorization decision
```

Never:

```text
Frontend
   ↓
direct PostgreSQL / Redis / provider SDK
```

The frontend must not contain:

* canonical workflow state;
* legal workflow transition graph;
* authorization rules;
* tenant-isolation rules;
* merge gating;
* verification semantics;
* review verdict authority;
* Work Item eligibility logic;
* dependency evaluation.

# WORK-022 OBJECTIVE

Build a usable web application that allows an authorized WorkflowOS user to:

1. authenticate;
2. select/access a tenant project;
3. observe authoritative project state;
4. inspect architecture, requirements, work items, Work Orders, Agent Runs, PRs, verification, reviews, and audit history;
5. initiate authorized workflow actions by calling backend APIs;
6. observe the resulting authoritative state after refresh.

The UI must never calculate the authoritative result itself.

# FRONTEND STATE MODEL

Frontend state is always derived from backend/API responses.

For example:

```text
GET /projects/:id
GET /projects/:id/architecture
GET /projects/:id/requirements
GET /projects/:id/work-items
GET /work-items/:id/agent-runs
GET /work-items/:id/...PR...
GET /work-items/:id/verification
GET /work-items/:id/reviews
GET /projects/:id/audit
GET /projects/:id/notifications
```

Use the actual API contracts present in the repository rather than inventing endpoint shapes.

The frontend may cache/read data for UX purposes, but cached UI state is never authoritative.

A browser refresh must reconstruct state from backend data.

# AUTHENTICATION

Use the existing backend authentication boundary.

Do not implement a second identity provider or duplicate auth logic in the browser.

The frontend should:

* present the authenticated session/principal;
* include the necessary authentication credentials/tokens using the existing backend contract;
* respond to `401`/`403` appropriately.

The browser must never determine whether a user is authorized.

For privileged actions:

```text
Frontend
  ↓ request
Backend authentication
  ↓
Backend AuthorizationService
  ↓
allowed/denied
```

# TENANT ISOLATION

The frontend must treat tenant/project IDs as identifiers, not proof of access.

Never render protected data merely because a URL contains:

```text
/project/<id>
```

Backend authorization must determine access.

The UI should handle:

```text
401 unauthenticated
403 unauthorized
404 not found
```

without revealing protected cross-tenant resource existence where the backend intentionally hides it.

Never build client-side checks such as:

```text
if (project.organizationId === currentUser.organizationId) ...
```

as an authority mechanism.

Such UI checks may improve UX only when they do not replace backend enforcement.

# REQUIRED READ VIEWS

Implement views for the authoritative state required by UI-AC-01/UI2-AC-02.

At minimum provide coherent screens/pages for:

```text
Project
  ├── project overview
  ├── architecture/version
  ├── requirements/criteria
  ├── work items
  ├── Work Order
  ├── Agent Runs
  ├── Pull Requests / implementation state
  ├── Verification
  ├── Architect Reviews / Findings
  ├── Audit history
  └── Notifications where useful
```

Do not build a giant administration interface.

Implement the minimum coherent navigation necessary to satisfy the acceptance criteria.

# PROJECT VIEW

The project page must display authoritative backend state such as:

* project identity;
* organization;
* repository association;
* current/frozen architecture version;
* requirements;
* Work Items;
* overall workflow-related status where available.

Do not derive a "project status" in the frontend unless the backend already exposes that authoritative status.

# ARCHITECTURE VIEW

Display:

* Architecture;
* current/relevant ArchitectureVersion;
* lifecycle state;
* immutable/frozen status;
* ADRs where the backend exposes them;
* Architecture Change Requests/status where relevant.

Do not allow the browser to edit frozen architecture directly.

Privileged architecture actions must call backend endpoints that use existing authorization and `/architecture` domain logic.

# REQUIREMENTS VIEW

Display:

* Requirement ID;
* title/description;
* architecture version;
* status;
* Acceptance Criteria;
* criterion status;
* evidence references where available.

Do not compute PASS/FAIL criteria in the browser.

Criterion state must come from `/verification` / backend API.

# WORK ITEM VIEW

Display:

* Work Item identity;
* state;
* requirements;
* criteria;
* dependencies;
* Work Order;
* PR associations;
* Agent Runs;
* Verification;
* Architect Reviews;
* audit history relevant to the Work Item.

The workflow state shown in the browser must be the exact backend state.

Do not reconstruct workflow state from event history in the frontend.

# AGENT RUN VIEW

Display existing Agent Run records.

Show relevant provider-neutral information such as:

* status;
* timing;
* output summary;
* commit;
* pull request;
* reported tests;
* blockers;
* retry/error information.

Do not expose raw provider credentials.

Do not fabricate completion based on UI state.

# PULL REQUEST VIEW

Display authoritative GitHub state already exposed through the backend.

Show:

* repository;
* PR identifier;
* URL/reference;
* state;
* active/historical status;
* merge status where provided.

Do not determine mergeability from frontend heuristics.

Do not infer MERGED merely because an Architect Review is approved.

# VERIFICATION VIEW

Display:

* VerificationRun state;
* criterion evaluation;
* requirement derivations where exposed;
* evidence references;
* CI evidence;
* authoritative vs claim evidence distinction where the backend exposes it.

Do not evaluate evidence in the frontend.

Do not provide UI controls that directly mark criteria PASS/FAIL unless the backend explicitly exposes an authorized action for that exact operation.

# REVIEW VIEW

Display:

* Architect Reviews;
* verdict;
* summary/rationale;
* findings;
* correction-cycle history;
* associated Work Item / Work Order / ArchitectureVersion context.

Do not let the browser change a Review verdict locally.

A final review result comes from `/reviews`.

# AUDIT VIEW

Display read-only audit history using `/audit` APIs.

At minimum support:

* chronological events;
* timestamp;
* actor/source;
* resource;
* workflow transition information;
* execution/correlation ID where useful.

Do not expose any client-side ability to edit/delete audit history.

# AUTHORIZED ACTIONS

UI-003 requires authorized users to perform workflow actions while backend authority is preserved.

Inspect the existing API endpoints and expose UI controls only for actions already supported by the backend.

Examples may include:

* initiate/converge workflow;
* request merge;
* retry/resume where explicitly supported;
* create/finalize architecture/review actions where backend contracts permit them.

Do not invent frontend actions for unsupported backend operations.

Each action must follow:

```text
button click
   ↓
API request
   ↓
backend auth
   ↓
backend workflow/domain service
   ↓
authoritative state mutation
   ↓
API response
   ↓
frontend refresh/re-fetch
```

The frontend must not optimistically replace canonical workflow state with its own state machine.

# WORKFLOW ACTION CONTROLS

Do not encode the entire frozen workflow graph in frontend code.

It is acceptable to render controls based on server-provided capability/action information if such an endpoint already exists.

Otherwise, the simplest safe approach is:

* show actions appropriate to the current backend response;
* call the backend;
* handle `409`/`403`/other failures from the server;
* re-fetch authoritative state after the operation.

The backend remains the final authority.

# UI ERROR HANDLING

The UI must visibly and accurately represent authoritative server failures.

Examples:

```text
401 → sign-in/session required
403 → action/resource not authorized
404 → resource unavailable/not found
409 → state/transition conflict
422/400 → invalid request
5xx → server failure
```

Never translate a failed backend mutation into a successful UI state.

# REFRESH / CONSISTENCY

UI2-AC-02 requires displayed workflow state to match backend state after refresh.

At minimum test:

```text
initial state
→ browser/API action
→ backend mutation
→ refresh page
→ displayed state equals backend state
```

Do not rely solely on in-memory client state.

If the frontend uses a query/cache library or custom cache, invalidation/re-fetch must occur after mutations.

# API BOUNDARY

The frontend must consume backend APIs.

Do not access:

* PostgreSQL directly;
* Redis directly;
* object storage directly where the backend already provides the authoritative interface;
* GitHub SDK directly;
* LLM provider SDKs;
* agent provider SDKs.

Provider integrations remain backend-owned.

# BACKEND API GAPS

WORK-022 may add minimal backend API endpoints needed to render authoritative UI state or expose existing authorized actions.

Any new API endpoint must:

* use existing AuthorizationService;
* use existing domain interfaces;
* preserve tenant isolation;
* preserve module ownership;
* avoid moving workflow logic into controllers;
* avoid introducing frontend-specific duplicate state.

Do not use the frontend as an excuse to redesign backend modules.

If a required UI view cannot be implemented because the backend has no stable contract and adding one would require architectural redesign, report:

```text
IMPLEMENTATION_BLOCKED
```

rather than inventing frontend authority.

# FRONTEND TECHNOLOGY

Inspect the repository for an existing frontend framework.

If one already exists, reuse it.

If no frontend foundation exists, select the smallest reasonable TypeScript web application approach consistent with the frozen architecture and current repository tooling.

Do not introduce unnecessary microservices or deployment architecture.

Do not add a second backend.

Do not add a separate database.

# DESIGN / UX SCOPE

The implementation is functional rather than marketing-focused.

Provide:

* coherent navigation;
* readable tables/cards/details;
* clear status presentation;
* loading/error/empty states;
* authorized action controls;
* responsive enough layout for normal desktop usage.

Do not spend scope on advanced design systems, animations, or nonessential visual polish.

# SECURITY

Never render or expose:

* API keys;
* SecretStore values;
* provider credentials;
* raw access tokens;
* internal secret environment values.

Be careful with server-rendered page data and browser logs.

Do not serialize sensitive backend configuration into client-side JavaScript.

# STATIC ARCHITECTURE CHECKS

Extend architecture checks to verify:

* frontend does not define canonical workflow states;
* frontend does not define authoritative transition maps;
* frontend does not implement authorization policy;
* frontend does not import backend `/internal` modules;
* frontend does not import PostgreSQL/Redis/GitHub/LLM/agent provider SDKs;
* frontend does not write workflow persistence;
* frontend does not evaluate verification evidence;
* frontend does not mutate review/architecture/work-item domain state directly;
* frontend consumes backend APIs/contracts;
* backend remains authoritative for all privileged actions;
* existing WORK-001 through WORK-021 checks remain intact.

Use static checks that are strong enough to prevent regression, but do not ban harmless UI strings that merely display workflow-state labels.

# REQUIRED TESTS

## UI-AC-01

End-to-end test proving an authorized user can view:

* project;
* architecture;
* requirements;
* Work Items.

The data shown must come from backend state.

## UI-AC-02

Static architecture test proving the frontend:

* does not own workflow state;
* does not own authorization logic.

## UI2-AC-01

End-to-end test proving an authorized user can view:

* Agent Runs;
* PRs;
* verification evidence;
* Architect Reviews;
* audit history.

## UI2-AC-02

End-to-end test:

```text
backend authoritative state
→ UI displays it
→ authorized workflow action
→ backend state changes
→ refresh
→ UI matches backend
```

## UI3-AC-01

API/end-to-end test proving unauthorized users cannot perform privileged actions through direct backend calls.

The frontend must not be the only protection.

Use the existing backend authorization tests/contracts.

## UI3-AC-02

Static architecture test proving there is no authoritative:

* transition graph;
* authorization rule implementation;
* direct workflow persistence;
* criterion evaluation;
* review verdict mutation

in frontend code.

## Tenant isolation

Test that:

```text
Tenant A user
→ Project A visible

Tenant A user
→ Project B
→ denied
```

and that changing route/query identifiers cannot bypass backend authorization.

## Refresh consistency

Test at least one workflow action where:

```text
backend state changes
→ browser refresh/re-fetch
→ exact backend state appears
```

## Error handling

Test:

* unauthorized action;
* invalid workflow transition;
* stale/conflicting action;
* API failure.

The frontend must reflect backend failure rather than creating a false success state.

## Regression

All existing WORK-001 through WORK-021 tests must continue to pass.

Run:

```text
bun run test
bun run typecheck
bun run lint
```

and the required frontend-specific test/build commands for whatever frontend foundation is used.

CI must pass.

# OUT OF SCOPE

Do NOT implement:

* frontend-owned workflow logic;
* frontend-owned authorization;
* direct database access from browser code;
* direct GitHub/LLM/agent provider integrations;
* notification provider work beyond consuming existing notification APIs if useful;
* deployment topology;
* WORK-023 deployment;
* WORK-024 end-to-end lifecycle;
* new domain persistence unrelated to missing UI API contracts;
* new workflow states;
* a second backend service.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

# DEFINITION OF DONE

WORK-022 is complete only when:

* the WorkflowOS web application exists;
* authorized users can view authoritative project/architecture/requirements/Work Item state;
* authorized users can view Agent Runs, PRs, verification evidence, reviews, and audit history;
* authorized users can initiate supported backend workflow actions;
* backend authorization remains authoritative;
* backend workflow state remains authoritative;
* browser refresh reconstructs displayed state from backend state;
* frontend has no authoritative transition/authorization logic;
* frontend does not access backend internals or provider SDKs directly;
* tenant isolation remains enforced server-side;
* privileged actions remain backend-authorized;
* no duplicate domain/store/workflow authority is introduced;
* static architecture checks pass;
* UI end-to-end/API/static tests pass;
* all WORK-001 through WORK-021 regression tests pass;
* typecheck passes;
* lint passes;
* frontend build/test checks pass;
* CI passes;
* frozen specification documents remain unchanged;
* no WORK-023 or WORK-024 functionality is introduced.

# FAILURE / ESCALATION RULES

If the frozen UI-AC-01..02, UI2-AC-01..02, or UI3-AC-01..02 semantics are ambiguous or contradictory:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If a required UI view/action cannot be implemented without inventing a missing backend authority that would broaden scope beyond WORK-022:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently move authorization or workflow authority into the frontend.

# FINAL OUTPUT

Return only the final coding-agent prompt suitable for Z.ai.

When done send the final prompt to Z.ai on:

```text
feat/WORK-022-workflowos-web-application
```

targeting `main`.

Do NOT merge the PR.
