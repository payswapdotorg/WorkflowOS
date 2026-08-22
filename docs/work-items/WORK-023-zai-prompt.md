# Step 2 — Generate Coding-Agent Prompt for WORK-023

You are the Architecture Authority for WorkflowOS.

The frozen architecture, requirements, and implementation backlog are authoritative.

WORK-001 through WORK-022 are complete and merged into `main`. The next eligible work item is:

**WORK-023 — Deployable runtime**

Read from `main` before changing code:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

Also inspect the current repository, especially:

```text
backend/
frontend/
backend/src/platform/
backend/src/api/
.github/workflows/
```

Pay particular attention to the existing WORK-001 runtime/worker foundation, WORK-003 PostgreSQL/Redis/ObjectStore infrastructure, WORK-020 audit integration, WORK-022 frontend build/start conventions, existing configuration/loading, health/readiness, CI, and test conventions.

Do NOT redesign the architecture.

# WORK ITEM

**WORK-023 — Deployable runtime**

Objective: Establish the frozen initial runtime topology.

Requirement: `DEPLOY-001`

Dependencies:

* WORK-001
* WORK-003
* WORK-020

Acceptance criteria:

* **DEPLOY-AC-01** — Runtime topology contains Web Application, Backend API, Background Worker, PostgreSQL, Redis, and Object Storage.
* **DEPLOY-AC-02** — WorkflowOS deploys independently of customer repositories.
* **DEPLOY-AC-03** — Initial deployment does not require microservices.

Required verification: deployment/integration test.

Architecture area: infrastructure.

Expected repository areas: container/deployment configuration, API/worker startup.

Out of scope: customer application deployment and Kubernetes-specific architecture.

Definition of done: WorkflowOS runs in the specified modular-monolith-plus-workers topology.

# FROZEN DEPLOYMENT BOUNDARY

The architecture requires an initial containerized topology of:

```text
Web Application
Backend API
Background Worker
PostgreSQL
Redis
Object Storage
```

The backend remains one TypeScript modular monolith. Background workers use the existing Redis-backed worker mechanism. PostgreSQL is authoritative. Redis is not authoritative. Object storage uses the existing abstraction.

The exact cloud provider is intentionally unspecified. Do not introduce cloud-specific architecture, Kubernetes, service mesh, or microservice extraction.

# IMPLEMENTATION REQUIREMENTS

1. Inspect and reuse the existing runtime foundations before adding files.
2. Provide reproducible container/runtime definitions for the web app, API, worker, PostgreSQL, Redis, and object storage.
3. Reuse the existing API and WorkerHost entrypoints; do not create another backend, queue, worker framework, database client, or migration system.
4. Allow API and worker to use the same backend image/build where appropriate, with distinct process commands when needed.
5. Use the existing PostgreSQL migration runner for fresh database initialization.
6. Configure frontend → backend API through existing repository conventions.
7. Reuse the existing ObjectStore boundary and provide a local/test-compatible implementation only where the repository requires one.
8. Reuse existing configuration/validation and secret-management mechanisms. Never bake secrets into source, images, or deployment manifests.
9. Provide deterministic health/readiness behavior sufficient to validate API, worker, PostgreSQL, Redis, and object-storage initialization where supported by the current architecture.
10. Ensure WorkflowOS starts without any customer repository present, checked out, mounted, or required for build/startup.
11. Extend CI so deployment/runtime validation is reproducible in GitHub Actions without real production-cloud credentials unless already available securely.

# DEPLOY-AC-01

Prove the runtime contains:

```text
Web Application
Backend API
Background Worker
PostgreSQL
Redis
Object Storage
```

Verify connectivity:

```text
Web Application → Backend API
Backend API → PostgreSQL
Backend API → Redis/ObjectStore
Background Worker → Redis → existing backend persistence/artifact boundaries
```

Use real configured interfaces, not in-memory stand-ins for authoritative production boundaries.

# DEPLOY-AC-02

Prove the deployment works with no customer repository checkout.

Customer repositories remain external systems accessed through `/github`. Do not couple the WorkflowOS runtime image to customer source code or customer CI.

# DEPLOY-AC-03

Prove the initial deployment remains modular-monolith-plus-workers.

Do not introduce:

* separate backend microservices;
* Kubernetes as a requirement;
* service mesh;
* separate workflow/auth/verification/GitHub/LLM/agent services;
* new distributed architecture.

# WORKER / REDIS

Reuse the existing Queue/WorkerHost. Demonstrate at least one existing representative background job can enqueue/process in the deployed topology. Redis remains transport/coordination only and must not become authoritative state.

# SECURITY / CONFIGURATION

Preserve existing tenant authorization and secret boundaries. Validate required configuration deterministically. Deployment files must not contain credentials, tokens, or SecretStore values. Do not expose secrets to the frontend.

# CI / TESTING

At minimum add deterministic deployment/runtime checks for:

* all six topology components present;
* API startup/readiness;
* worker startup;
* PostgreSQL readiness + fresh migrations;
* Redis readiness;
* ObjectStore initialization;
* frontend reaching configured API;
* one representative background job;
* startup without a customer repository;
* no-microservices architecture invariant.

Run and keep passing:

```text
bun run test
bun run typecheck
bun run lint
```

plus the repository-appropriate frontend/container/deployment validation commands. CI must pass.

# STATIC ARCHITECTURE CHECKS

Extend existing checks to ensure:

* backend remains one modular-monolith codebase;
* worker uses the existing WorkerHost/queue;
* PostgreSQL remains authoritative;
* Redis is non-authoritative;
* ObjectStore remains behind its existing abstraction;
* frontend has no direct database/Redis/provider access;
* no deployment file hard-codes secrets;
* no Kubernetes/microservice requirement is introduced;
* existing WORK-001 through WORK-022 checks remain intact.

# OUT OF SCOPE

Do NOT implement customer application deployment, Kubernetes architecture, microservice extraction, service mesh, new auth, new persistence, new worker infrastructure, or WORK-024 end-to-end lifecycle functionality.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

# DEFINITION OF DONE

WORK-023 is complete only when:

* the frozen six-component containerized topology is reproducible;
* API and worker reuse the existing modular-monolith/runtime foundation;
* PostgreSQL is authoritative and Redis remains non-authoritative;
* ObjectStore uses the existing boundary;
* deployment is independent of customer repositories;
* no microservices/Kubernetes requirement is introduced;
* configuration and secrets are handled safely;
* fresh database migrations work;
* deterministic readiness checks exist where required;
* one representative background job works;
* deployment validation runs in CI;
* static architecture checks pass;
* all WORK-023 tests pass;
* all WORK-001 through WORK-022 regression tests pass;
* typecheck/lint/container validation pass;
* frozen specification documents remain unchanged;
* no WORK-024 functionality is introduced.

# FAILURE / ESCALATION RULES

If DEPLOY-AC-01..03 or the frozen deployment topology is ambiguous/contradictory:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires changing frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If the existing runtime foundation cannot support the frozen topology without conflicting architecture:

```text
IMPLEMENTATION_BLOCKED
```

Do not silently introduce microservices, Kubernetes, or cloud-specific architecture.

# FINAL OUTPUT

Return only the final coding-agent prompt suitable for Z.ai.

When done send the final prompt to Z.ai on:

```text
feat/WORK-023-deployable-runtime
```

targeting `main`.

Do NOT merge the PR.
