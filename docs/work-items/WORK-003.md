# WORK-003 — PostgreSQL, Redis, object storage

**Status:** COMPLETE
**Acceptance criteria:** DATA-AC-01, DATA-AC-02, DATA-AC-03, DATA2-AC-01, DATA2-AC-02, DATA3-AC-01, DATA3-AC-02
**Requirements:** DATA-001, DATA-002, DATA-003
**Implementation:** `backend/src/platform/{postgres,redis,storage,persistence}/`

## What was built

The authoritative persistence boundary and supporting Redis / object-storage
boundaries required by the frozen architecture (§28 PostgreSQL, §29 Redis,
§30 Object Storage). Reuses the WORK-001 platform conventions (module
interfaces, execution context, logger, queue/worker) without duplicating them.

### 1. PostgreSQL (DATA-001 / DATA-AC-01..03)

- `platform/postgres/database-client.ts` — `DatabaseClient` interface with
  `query`, `exec` (multi-statement), `transaction`, `close`. Production
  `PgDatabaseClient` wraps a `pg.Pool`.
- `platform/postgres/database-factory.ts` — central `createDatabaseClient()`
  so domain modules never construct their own pool.
- `platform/postgres/pglite-database-client.ts` — real PostgreSQL compiled to
  WASM (`@electric-sql/pglite`), used for local tests / dev when no
  `DATABASE_URL` is set. NOT a fake in-memory DB — real FK, real transactions.
- `platform/postgres/migration-runner.ts` — applies SQL files under
  `migrations/` idempotently, tracked in a `schema_migrations` table.
- `platform/postgres/migrations/0001_init.sql` — infrastructure fixtures:
  - `wfos_fixture_parent` / `wfos_fixture_child` with a real `FOREIGN KEY`
    (used by DATA-AC-02).
  - `wfos_artifact_metadata` with `storage_key`, `content_length`,
    `digest_sha256`, `metadata JSONB` — NO body column (DATA3-AC-02).
  - No domain entities.

### 2. Redis extensions (DATA-002 / DATA2-AC-01..02)

Reuses the WORK-001 `RedisQueue` + `RedisQueue` + shared `createRedisClient`
unchanged. Adds two explicitly non-authoritative coordination abstractions:

- `platform/redis/transient-lock.ts` — `TransientLock` using
  `SET NX PX` + Lua-guarded release (token comparison). TTL-bounded, never
  authoritative.
- `platform/redis/transient-cache.ts` — `TransientCache` with optional TTL
  and `getOrLoad`. Recoverable from PostgreSQL; flushing Redis never
  corrupts persisted state.

### 3. Object storage (DATA-003 / DATA3-AC-01..02)

- `platform/storage/object-store.ts` — provider-independent `ObjectStore`
  interface (`put`, `get`, `delete`, `provider`). Domain code depends on this,
  never on a concrete implementation.
- `platform/storage/in-memory-object-store.ts` — dev/test implementation.
- `platform/storage/fs-object-store.ts` — filesystem-backed implementation
  (local / single-node production); `createTempFsObjectStore()` for tests.

### 4. Persistence + DI (DATA-001..003)

- `platform/persistence/artifact-metadata-repository.ts` — `ArtifactMetadataRepository`
  over `wfos_artifact_metadata`. Hides SQL behind a stable interface so future
  schema changes don't ripple into domain modules.
- `platform/persistence/infrastructure.ts` — `buildInfrastructure()`
  assembles the `Infrastructure` container (database, redis, queue,
  objectStore, transientLock, transientCache, artifactMetadata). Domain
  modules obtain these from the container; never construct their own clients.
- `src/app.ts` wires `Infrastructure` when `DATABASE_URL` + `REDIS_URL` are
  configured, and applies migrations on startup.

## Acceptance-criteria → evidence map

| Criterion | Evidence |
| --- | --- |
| **DATA-AC-01** — PostgreSQL relational persistence | `tests/integration/postgres/relational-persistence.integration.test.ts` — inserts/reads via `DatabaseClient`, SERIAL auto-increment, UUID defaults, JSONB metadata. |
| **DATA-AC-02** — Foreign-key integrity | `tests/integration/postgres/foreign-key.integration.test.ts` — PostgreSQL rejects a child row with a non-existent parent (FK constraint), rejects NULL parent (NOT NULL). |
| **DATA-AC-03** — PostgreSQL authoritative / recoverable without Redis | `tests/integration/postgres/recovery.integration.test.ts` — writes authoritative state to PostgreSQL, flushes Redis, recovers from PostgreSQL; transaction rollback proven; fresh Redis does not restore PG state. |
| **DATA2-AC-01** — Redis-backed worker processing | `tests/integration/redis/worker-processing.integration.test.ts` — reuses WORK-001 `RedisQueue` + `WorkerHost`; job enqueues + processes asynchronously; FIFO; execution id in worker logs. |
| **DATA2-AC-02** — Redis not authoritative | `tests/integration/redis/non-authoritative.integration.test.ts` — flushing Redis does not destroy PostgreSQL state; a fresh Redis recovers nothing; committed transactions survive Redis loss. |
| **DATA3-AC-01** — Object storage with durable PG references | `tests/integration/storage/object-storage.integration.test.ts` — artifact → ObjectStore → storage_key → `wfos_artifact_metadata` row → retrieve body by key. Both `InMemoryObjectStore` and `FsObjectStore`. |
| **DATA3-AC-02** — Large bodies use the artifact boundary | `tests/integration/storage/artifact-boundary.integration.test.ts` — schema/static check: `wfos_artifact_metadata` has `storage_key` but no body column; migration SQL static check; 64 KiB artifact represented in PG only by reference. |

## Static architecture invariants (WORK-003 additions)

`tests/architecture/static-architecture.test.ts` adds a
`WORK-003 invariants — no provider coupling in domain modules` block:

1. `src/modules/**` MUST NOT import `pg`, `ioredis`, `@electric-sql/pglite`.
2. `src/modules/**` MUST NOT import concrete provider implementations
   (`fs-object-store`, `in-memory-object-store`, `pglite-database-client`, etc.)
   — only the interfaces from `@platform/index.ts`.
3. Only `src/platform/**` may import provider packages.
4. No second `WorkerHost` / `Queue` implementation was introduced in domain
   modules (the WORK-001 runtime is the only accepted one).
5. The frozen `spec/*.md` documents still exist and are unchanged.

## Verification

```
cd backend
bun install
bun run test        # 145 tests pass
bun run typecheck   # tsc --noEmit — clean
bun run lint        # eslint — clean
```

### CI (`.github/workflows/backend.yml`)

Adds `postgres:16` and `redis:7` service containers so the infrastructure
tests run against real PostgreSQL and real Redis in CI (not just pglite /
ioredis-mock). The test harness picks them up via `WORKFLOWOS_DATABASE_URL`
and `REDIS_URL` env vars.

## Architecture conformance

- PostgreSQL is authoritative (§28, §2.1, `DATA-AC-03`).
- Redis is non-authoritative (§29, `DATA2-AC-02`); only queues, locks,
  cache, coordination.
- Object storage for large/immutable artifacts (§30); PostgreSQL holds
  metadata + references.
- Provider independence (§2.5): domain modules depend on `DatabaseClient`,
  `Queue`, `ObjectStore`, `TransientLock`, `TransientCache` interfaces —
  never on `pg` / `ioredis` / a concrete store. Enforced statically.
- No duplicate worker/queue runtime (WORK-001 `WorkerHost` + `Queue`
  reused unchanged).
- No domain entities introduced (auth, projects, work items, etc. are out
  of scope — later work items).
- No frozen architecture document modified.
