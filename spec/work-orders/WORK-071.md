# WORK-071 — Local Development Runtime Substrate

Status: in flight (activated 2026-08-30 by the architect — the implementation
instruction on the post-#87/#95 mainline `4eb48b7`; the activation is recorded
in `spec/development-state/program-state.json`, branch
`feat/work-071-local-dev-runtime`). The implementation delivers the dev-only
runtime path as an explicit environment branch in the composition root:
`backend/src/config.ts` reads the explicit, never-ambient
`WORKFLOWOS_DEV_RUNTIME=pglite` signal (failing closed on ambiguity with
`DATABASE_URL`, on `NODE_ENV=production`, and on unsupported values);
`backend/src/app.ts` `buildApp` constructs the EXISTING
`PgliteDatabaseClient` (real PostgreSQL compiled to WASM — DATA-AC-03
satisfied, not a fake in-memory database) persisted to
`WORKFLOWOS_DEV_DATABASE_DIR` (default `backend/.workflowos-dev-data/pglite`,
gitignored), running the SAME `runMigrations` and the SAME domain code
through the SAME `DatabaseClient` boundary (no second persistence authority;
the production `DATABASE_URL` branch is unchanged and first; the production
factory still returns `pg.Pool`). The Redis requirement is resolved with a
dev-only in-memory Redis substitute
(`backend/src/platform/redis/in-memory-redis.ts` — the §29 NON-authoritative
locks/cache/readiness layer only; unknown Lua fails closed), so the FULL
`Infrastructure` container and the workflow orchestrator (convergence loop)
run without a Redis server; the queue stays the existing `InMemoryQueue`
(non-durable, explicitly warned); the object store keeps the existing
`FsObjectStore`/`InMemoryObjectStore` fallbacks. Local development requires
NO externally hosted PostgreSQL, NO Redis, NO Docker. Verification on the
branch: the WORK-071 suite 22/22 (env-boundary selection + fail-closed
discriminations, dev-path startup through the real `buildApp` with the full
product deps, the SAME 58 migrations on the dev database, the Infrastructure
container + orchestrator without Redis, restart persistence through the
local filesystem, product routes through the real HTTP server —
`/health/ready` ready, 401-without-credentials, the API-key login/bootstrap
path, tenant isolation through the local runtime, concurrent requests, the
DEFAULT nested dev data directory booting on a clean checkout (the
browser-proof regression: PGlite does not create parent directories) —
production-path discrimination: `DATABASE_URL` still selects `pg.Pool` with
no silent PGlite fallback, and no-signal-no-URL stays database-less (the dev
wiring is not ambient)); static architecture 817/817 (13 new WORK-071
invariants); development-governance 67/67; backend typecheck 0 / lint 0
errors (2 pre-existing warnings, untouched); FULL backend regression 2669
passed / 44 skipped / 0 failed; frontend typecheck 0 / lint 0 errors (1
pre-existing warning) / 122 tests passed. Browser proof on the dev runtime
(the REAL entrypoint — NO DATABASE_URL, NO REDIS_URL, NO Docker):
`/health/ready` ready (postgres + redis + objectStore all ok); fresh browser
→ LoginPage → API-key login → Projects → Project Overview → the Developer
Workbench (all tabs; Work Graph interactive), zero page/console errors, all
API calls 200; the seeded org/project/user persisted across a backend
restart; all three fail-closed startup refusals verified through the real
entrypoint with clear errors. The dev path does NOT by itself satisfy the
dogfooding gate — the gate still requires WORK-074 complete AND this Work
Order complete.

Issued by: the 2026-08-30 customer dogfooding experiment's governed follow-up
(the dogfooding evidence artifact
`spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`,
finding F-2). This Work Order establishes the local-development runtime
substrate — a supported dev-only runtime path so WorkflowOS can be exercised
without requiring an externally hosted PostgreSQL server. It does NOT alter
production semantics. Activation requires the architect's authorization and
is recorded in `spec/development-state/program-state.json` (the issuing
change recorded none; the activation is carried by the implementation change
that updated this status line).

Dependencies: WORK-003 (PostgreSQL, Redis, object storage — the frozen
persistence boundary whose dev path this Work Order provides) and WORK-023
(Deployable runtime — the composition root `buildApp` this Work Order extends
with a dev branch). Both are complete. The dev path is dependency-eligible
immediately. This Work Order does NOT depend on WORK-074 — they are
independent parallel enablers of the dogfooding gate (the identity/auth
runtime vs the platform/runtime substrate; different protected surfaces).

Downstream: the dogfooding gate
(`spec/architecture/v1.1/dogfooding-model.md` §8, updated in this change) —
the canonical first full dogfooding journey now requires WORK-074
complete AND this Work Order complete (or an equivalent supported runtime
environment). WORK-061 (Self-Hosting Conformance and Continuous Governance)
benefits from a supported local path for development and conformance
exercises.

## Objective

Provide a supported local-development runtime path so WorkflowOS can be
exercised without requiring an externally hosted PostgreSQL — so a real
customer (and the dogfooding experiment) can run the application locally against
real authorities (real PostgreSQL semantics, real migrations, real domain
code) without standing up Docker-hosted or remote PostgreSQL.

The production PostgreSQL path remains authoritative (DATA-AC-03: proof comes
from a real relational database, not a fake). The development path must NOT
alter production semantics: no second persistence authority, no divergent
schema, no divergent domain behavior. The development path is an explicit
environment boundary (dev-only wiring), not a silent production fallback.

## Why this is a Work Order (the verified gap)

The dogfooding experiment (finding F-2) and the independent code verification
on this branch confirm the gap precisely:

- The composition root (`backend/src/app.ts` `buildApp`) leaves `database`
  `undefined` when `DATABASE_URL` is absent. Unlike the queue (which falls
  back to `InMemoryQueue`) and the object store (which falls back to
  `InMemoryObjectStore` or `FsObjectStore`), the database has NO local
  fallback. Without a database, the `Infrastructure` container is never built
  (it requires both `redisClient` and `database`), and the application cannot
  serve its authoritative surfaces.
- The production factory (`backend/src/platform/postgres/database-factory.ts`
  `createDatabaseClient`) always returns a `PgDatabaseClient` (real `pg.Pool`
  from `DATABASE_URL`). There is no dev branch.
- A PGlite `DatabaseClient` adapter ALREADY EXISTS
  (`backend/src/platform/postgres/pglite-database-client.ts` —
  `@electric-sql/pglite`, real PostgreSQL compiled to WASM, satisfying
  DATA-AC-03) and is used by the test suite, but the production composition
  does NOT wire it for a dev path.
- `.env.example` points `DATABASE_URL` at the docker-compose `postgres` service
  (`postgres://wfos:changeme@postgres:5432/wfos`) — i.e., local dev today
  requires standing up Docker-hosted PostgreSQL, which is an externally hosted
  PostgreSQL (even if local), not a local-runtime substrate.

To run WorkflowOS locally today, a customer must stand up Docker-hosted
PostgreSQL (and Redis, for the full Infrastructure container). That is the
gap this Work Order closes.

## Do NOT assume PGlite is automatically the correct architecture

The likely direction is a dev-only PGlite-backed runtime path, but the
implementer must NOT assume PGlite is automatically the correct architecture.
The implementer must inspect the existing runtime abstractions first and
justify the choice against them.

What the repository already provides (verified on this branch):

- The `DatabaseClient` interface (`backend/src/platform/postgres/database-
  client.ts`) — the boundary domain code depends on; callers must not depend
  on `pg` directly.
- The `PgliteDatabaseClient` adapter (`pglite-database-client.ts`) — real
  PostgreSQL compiled to WASM; mirrors `pg`'s `query` signature; used by
  tests; the docstring explicitly states it "may be used in local dev."
- The `runMigrations` migration runner (`migration-runner.ts`) — already runs
  migrations on PGlite in tests.
- The `Infrastructure` container (`platform/persistence/infrastructure.ts`) —
  accepts a `DatabaseClient`, a `Redis`, a `Queue`, an `ObjectStore`; the
  composition root constructs these.
- Local-fallback building blocks already exported from `platform/index.ts`:
  `InMemoryQueue`, `InMemoryObjectStore`, `FsObjectStore`,
  `createTempFsObjectStore`, `createPgliteDatabaseClient`, `EnvSecretStore`.

PGlite is the NATURAL fit because: (a) it already implements `DatabaseClient`;
(b) it is real PostgreSQL (WASM), so DATA-AC-03 (proof from a real relational
database) is satisfied — the dev path is NOT a fake in-memory database; (c)
migrations already run on it; (d) the factory just needs a dev branch. BUT the
implementer must verify the FULL composition, not just the database:

- the `Redis` requirement of the `Infrastructure` container (for locks/cache)
  — there is currently NO in-memory Redis substitute exported; the dev path
  must either provide one, accept a partial Infrastructure (database + object
  store, no locks/cache — the current behavior when `redisClient` is absent),
  or require a real Redis (which would re-introduce the "externally hosted"
  problem for the lock/cache layer).
- the queue — `InMemoryQueue` is non-durable (acceptable for dev, but the
  implementer must record that explicitly).
- the object store — `InMemoryObjectStore` (non-durable) or `FsObjectStore`
  (durable, local) are both acceptable for dev.
- the config (`backend/src/config.ts`) — a dev-path env switch (e.g.,
  `WORKFLOWOS_DEV_RUNTIME=pglite` or absence of `DATABASE_URL` triggering the
  dev path) must be explicit, not ambient.

The implementer MUST NOT blindly copy the test-suite's PGlite wiring into the
production composition. Test wiring is constructed per-test with controlled
lifecycle and no concurrency; the dev runtime must handle the application's
real lifecycle (graceful startup/shutdown, migration application, concurrent
requests) and the real domain code. The dev path is a new, explicit
environment boundary in the composition root, not a copy of test helpers.

## Architecture invariants

Must preserve:

- **Production PostgreSQL remains authoritative.** The dev path is dev-only;
  production always uses `PgDatabaseClient` against a networked PostgreSQL
  (DATA-AC-03). No dev-path code may execute in production.
- **No second persistence authority.** The dev path uses the SAME
  `DatabaseClient` interface, the SAME migrations, the SAME domain code. It is
  a different *implementation* of the same boundary, not a different
  *authority*. The `/verification`, `/work-items`, `/workflows`, `/reviews`,
  `/architecture` authorities remain the ONE authorities for their concerns;
  the dev path does not introduce a parallel store.
- **Explicit environment boundary.** The dev path is gated by an explicit
  env signal (never ambient). It MUST fail closed if the dev signal is absent
  in production. It MUST log an explicit warning that the dev runtime is in
  use (non-durable, not for production).
- **Migrations/schema compatibility.** The dev path runs the SAME migrations
  as production (the existing `runMigrations`). The schema MUST be compatible
  — the dev path is not a divergent schema. If a migration is PGlite-
  incompatible (e.g., a PG feature PGlite lacks), the implementer STOPS and
  raises the issue (it is a migration-design problem, not a dev-path
  workaround).
- **No silent rewrite of frozen architecture.** The dev path does NOT change
  the v1.0 frozen architecture, the v1.0 dependency graph, or the
  governance-model's persistence authority. It is an additive dev-runtime
  capability.
- **The self-hosting boundary holds.** A self-hosted worker running the dev
  path may NOT merge its own governing PR; the dev path is a runtime
  convenience, not a governance bypass.

## Implementation requirements

- A dev-only runtime path that wires `PgliteDatabaseClient` (or a
  justified alternative, per "Do NOT assume PGlite is automatically the
  correct architecture") when the dev-path env signal is present and
  `DATABASE_URL` is absent.
- The composition root (`buildApp`) extended with an explicit dev branch:
  when the dev signal is present, construct the dev database (and run
  migrations on it), construct an in-memory queue (or require Redis), and
  construct an in-memory or filesystem object store. The Infrastructure
  container is built with the dev clients.
- The `Redis` requirement resolved: either (a) provide an in-memory
  `TransientLock`/`TransientCache` substitute for dev (so the full
  Infrastructure container works without Redis), or (b) explicitly accept a
  partial Infrastructure (database + object store, no locks/cache) for dev
  and disable the features that require locks/cache with explicit logging —
  the implementer must choose and record the choice.
- An explicit env boundary: e.g., `WORKFLOWOS_DEV_RUNTIME=pglite` (or the
  implementer's chosen signal) — present triggers the dev path; absent in
  production always uses the production path. The dev path MUST refuse to
  start if the dev signal is present AND `DATABASE_URL` is also present (ambiguity
  fails closed).
- Migration compatibility verified: the existing migrations run cleanly on
  PGlite (the implementer proves this by running the full migration suite
  against a fresh PGlite instance and the application boots).
- The authentication/org/project/work-item/runtime surfaces boot locally:
  the application serves its authoritative surfaces against the dev database
  (a real customer — and the dogfooding experiment — can reach the LoginPage,
  create an organization, create a project, and exercise the runtime).
- Real browser dogfooding can use the local path: the dogfooding experiment
  (once WORK-074 is also complete) can run against the dev runtime
  without externally hosted PostgreSQL.
- No test-only PGlite wiring copied blindly into production composition: the
  dev path is a new, explicit environment boundary in `buildApp`/config, with
  its own lifecycle handling — not a reuse of test helpers.

## Verification requirements

## Behavioral

- The application boots on the dev path with NO `DATABASE_URL` and NO
  externally hosted PostgreSQL: `WORKFLOWOS_DEV_RUNTIME` set, `DATABASE_URL`
  unset → the dev database is constructed, migrations applied, the
  Infrastructure container built, the application serves its authoritative
  surfaces.
- The production path is unaffected: `DATABASE_URL` set, no dev signal → the
  production `PgDatabaseClient` is used (no dev code executes).
- Ambiguity fails closed: dev signal AND `DATABASE_URL` both set → the
  application refuses to start with an explicit error.
- A real customer journey (sign in — once WORK-074 is complete —
  create org, create project) works against the dev database with persistence
  across process restarts (PGlite persists to a local file/directory).

## Structural

- No domain module depends on PGlite directly (the `DatabaseClient` boundary
  holds; the dev path is wired only in `platform/` and the composition root).
- The dev path is gated by an explicit env signal (no ambient dev behavior
  in production).
- The static architecture invariants pass (the no-second-persistence-authority
  matrix; the frozen-boundary discipline).

## Mutation

- Removing the dev-path env check makes the dev wiring execute in production
  → the test FAILS (the dev path must not be ambient).
- Removing the ambiguity-fail-closed check makes the application start with
  both signals → the test FAILS.
- Making the dev path use a divergent schema (e.g., skipping a migration) →
  the test FAILS (schema compatibility must hold).

## Concurrency

- The dev path handles concurrent requests (PGlite's concurrency model is
  single-process; the implementer verifies the application's real concurrency
  works against it, or documents the dev-path's concurrency limit explicitly).

## Scope

Allowed: the dev-only runtime path (PGlite or justified alternative) wired in
the composition root; the explicit env boundary; the in-memory queue/lock/
cache substitutes for dev (or the explicit partial-Infrastructure choice);
migration compatibility verification; the dev-path lifecycle handling; the
required proofs above.

Forbidden: changing the production `PgDatabaseClient`/`createDatabaseClient`
factory's production behavior (the dev path is an ADDITIVE branch, not a
rewrite); introducing a second persistence/workflow/verification authority;
using a FAKE in-memory database that does not satisfy DATA-AC-03 (the dev
database MUST be real PostgreSQL semantics — PGlite satisfies this; a
hand-rolled mock does NOT); changing the frozen v1.0 architecture version;
changing the migrations (if a migration is PGlite-incompatible, the fix is a
migration design change under its own authorization, not a dev-path
workaround); implementing authentication (WORK-074), execution,
verification, or any domain logic — the dev path runs the EXISTING domain
code unchanged.

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - backend/src/app.ts           # the composition root (buildApp)
      - backend/src/config.ts        # the env reading
      - backend/src/platform/postgres/database-factory.ts
      - backend/src/platform/postgres/pglite-database-client.ts
      - backend/src/platform/persistence/infrastructure.ts
      - backend/src/platform/index.ts
      - .env.example
      - spec/architecture/v1.1/dogfooding-model.md
      - spec/architecture/v1.1/dogfooding-evidence/
    reason: the platform/runtime-substrate surface — concurrent authors must
      coordinate on the shared composition root and platform barrel. No other
      planned Work Order authors this surface (WORK-074 is the
      identity/auth surface; WORK-072/073 are frontend surfaces).
  - migrations: []
    # no schema migration in this Work Order — the dev path runs the EXISTING
    # migrations unchanged.
  - authorities: []
    # the dev path introduces NO new authority; it wires the existing
    # DatabaseClient/Queue/ObjectStore boundaries with dev implementations.
  - dependencies:
      - WORK-003   # complete — the frozen persistence boundary
      - WORK-023   # complete — the deployable runtime composition root
    reason: the dependency surface itself.
protectedSurfaces:
  - backend/src/app.ts
  - backend/src/config.ts
  - backend/src/platform/postgres/database-factory.ts
  - backend/src/platform/postgres/pglite-database-client.ts
  - backend/src/platform/persistence/infrastructure.ts
  - backend/src/platform/redis/
  - backend/src/platform/index.ts
  - spec/work-orders/WORK-071.md
  - spec/architecture/v1.1/dogfooding-model.md
  - spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md
```

An Architect LLM may mechanically determine the state of WORK-071 as: `READY`
(WORK-003 and WORK-023 are both complete — so the dev substrate is
dependency-eligible immediately); `BLOCKED` if either were incomplete (neither
is); `PARALLEL-SAFE` with WORK-074 (different protected surfaces: the
platform/runtime substrate vs the identity/auth runtime);
`PARALLEL-SAFE` with WORK-072 and WORK-073 (different protected surfaces: the
backend composition root vs the frontend LoginPage/ProjectListPage);
`CONFLICTING` with any future Work Order that authors the platform composition
root or the persistence boundary.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second persistence, workflow, or verification authority;
- a fake in-memory database that does not satisfy DATA-AC-03 (the dev
  database must be real PostgreSQL semantics);
- changing the production factory's production behavior (the dev path must be
  additive);
- changing the frozen v1.0 architecture version or the persistence authority;
- a divergent schema (if a migration is PGlite-incompatible, the fix is a
  migration design change under its own authorization — not a dev-path
  workaround that diverges the schema);
- weakening the self-hosting boundary (a self-hosted worker on the dev path
  may NOT merge its own governing PR).

## Definition of done

- The dev-only runtime path is wired in the composition root with an explicit
  env boundary; the application boots on the dev path with NO `DATABASE_URL`
  and NO externally hosted PostgreSQL.
- The production path is unaffected; ambiguity fails closed.
- The existing migrations run cleanly on the dev database; the schema is
  compatible (no divergent schema).
- The authentication/org/project/work-item/runtime surfaces boot locally
  against the dev database (a real customer can reach the application's
  authoritative surfaces locally).
- All required invariants hold with objective evidence (the mutation/
  discrimination tests above).
- Static architecture invariants for the no-second-persistence-authority
  matrix pass.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-071 scope; independent Architect Review approves; the
  implementation PR is merged; WORK-071 is marked VERIFIED before the
  dogfooding gate is satisfied on it.

  (The dev path does NOT by itself satisfy the dogfooding gate — the gate
  requires WORK-074 complete AND WORK-071 complete. WORK-071
  unblocks the local-runtime precondition; WORK-074 unblocks the
  production-authentication precondition. Both are required.)
