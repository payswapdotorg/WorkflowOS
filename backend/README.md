# WorkflowOS Backend

TypeScript modular-monolith backend for WorkflowOS. This package implements the
**WORK-001** platform foundation:

- the frozen module-boundary structure
- explicit module interfaces (the only surface cross-module code may import)
- Redis-backed background-worker infrastructure
- structured, execution-aware observability

Domain logic for individual modules is **out of scope** for WORK-001 and is
added by later work items on top of this foundation.

> The authoritative architecture lives in [`../spec/architecture.md`](../spec/architecture.md)
> and [`../spec/architecture-lock.md`](../spec/architecture-lock.md). Both are
> **frozen**; this package must not contradict them.

## Layout

```
backend/
├── src/
│   ├── index.ts              # process entrypoint (role = api | worker | all)
│   ├── app.ts                # composition root
│   ├── config.ts             # env-driven configuration
│   ├── api/                  # Fastify HTTP server
│   │   ├── server.ts
│   │   ├── plugins/          # execution-context plugin (per-request exec id)
│   │   └── routes/           # /health, /jobs/echo
│   ├── platform/             # shared runtime foundation
│   │   ├── module-contract.ts
│   │   ├── execution-context.ts   # AsyncLocalStorage exec-id propagation
│   │   ├── logger.ts             # pino, execution-aware (OBS-AC-02)
│   │   ├── metrics.ts            # metrics integration point (OBS-001)
│   │   ├── error-tracker.ts      # error-tracking integration point (OBS-001)
│   │   ├── ids.ts
│   │   ├── queue/               # Queue interface + InMemoryQueue
│   │   ├── redis/               # RedisQueue + redis client + TransientLock + TransientCache
│   │   ├── postgres/            # DatabaseClient + pg/pglite + migration runner (DATA-001)
│   │   ├── storage/             # ObjectStore interface + InMemory/Fs stores (DATA-003)
│   │   ├── persistence/         # ArtifactMetadataRepository + Infrastructure container
│   │   └── worker/             # WorkerHost, JobHandler, echo fixture
│   └── modules/               # 16 frozen module boundaries
│       ├── auth/
│       ├── users/
│       ├── organizations/
│       ├── projects/
│       ├── architecture/
│       ├── specifications/
│       ├── requirements/
│       ├── work-items/
│       ├── workflows/
│       ├── verification/
│       ├── reviews/
│       ├── llm/
│       ├── agents/
│       ├── github/
│       ├── notifications/
│       └── audit/
└── tests/
    ├── unit/                 # execution-context, logger, queues, worker-host
    ├── integration/          # PLAT-AC-03, OBS-AC-01/02, DATA-AC-01..03, DATA2-AC-01..02, DATA3-AC-01..02
    │   ├── postgres/         # PostgreSQL persistence, FK, recovery
    │   ├── redis/            # worker processing, non-authoritative, transient lock
    │   └── storage/          # object storage + artifact boundary
    └── architecture/         # PLAT-AC-01/02 + WORK-003 provider-coupling invariants
```

Each module directory contains:

- `index.ts` — the module's **public interface**. Exports a `ModuleContract`
  with the canonical frozen name (e.g. `/workflows`). This is the ONLY file
  other modules may import.
- `internal/` — private implementation area. Cross-module imports of
  `internal/**` are forbidden and enforced statically.

## Module-boundary convention

```ts
// src/modules/workflows/index.ts
import type { ModuleContract } from '@platform/module-contract.js';

export interface WorkflowsModuleApi {
  // future capabilities consumed by other modules
}

export const workflowsModule: ModuleContract & WorkflowsModuleApi = {
  name: '/workflows',
};
```

Cross-module communication rules (enforced by
`tests/architecture/static-architecture.test.ts`):

1. A file in `src/modules/<A>/**` may NOT import `src/modules/<B>/internal/**`
   for any `B != A`.
2. A file in `src/modules/<A>/**` may NOT import any non-`index.ts` file of
   another module `<B>` (the public interface is the only entry point).
3. The `platform/` runtime MUST NOT import from any domain module.
4. The `api/` layer MUST NOT reach into any module's `internal/`.

## Background workers

The architecture mandates Redis-backed background workers (architecture §27)
for long-running work. The API enqueues and returns immediately (PLAT-AC-03);
a worker host polls the queue and runs handlers asynchronously.

```
API request
   ↓
enqueue(jobType, payload, { executionId })   ← execution id from request context
   ↓
Redis  (production)   /   InMemoryQueue  (dev + tests)
   ↓
WorkerHost  →  runWithExecutionContext({ executionId })  →  JobHandler.handle(job)
   ↓
structured log lines include executionId   (OBS-AC-02)
```

- `Queue` — the shared interface (`enqueue`, `dequeue`, `ack`, `size`, `close`).
- `RedisQueue` — production; uses Redis `RPUSH`/`LPOP` (FIFO) + a Redis set for
  acknowledgements. Redis is NOT authoritative application state (§29).
- `InMemoryQueue` — local dev and tests; same interface.
- `WorkerHost` — polls the queue, dispatches to handlers, re-establishes the
  execution context per job so logs carry the job's `executionId`.

The echo fixture (`createEchoJobHandler`) demonstrates the pattern. Domain jobs
(`github.webhook`, `llm.request`, `agent.execute`, `verification.collect`,
`architect.review`, `notification.send`) are added by later work items using
the same `JobHandler` contract.

## Observability

- **Structured logging** — `pino` newline-delimited JSON. Every log line
  includes the active `executionId` (and `correlationId` when set) when a
  context is active.
- **Traceable execution IDs** — generated at the API boundary (or supplied
  via `X-Execution-Id`), carried through `AsyncLocalStorage` into enqueued
  jobs, and re-established inside the worker so worker logs include it
  (OBS-AC-01 / OBS-AC-02).
- **Metrics integration point** — `MetricsSink` interface; default no-op sink.
  A concrete sink is plugged in at startup without touching domain code.
- **Error-tracking integration point** — `ErrorTracker` interface; default
  no-op tracker. The worker host reports handler failures through it.

No vendor-specific observability library is coupled into domain modules
(architecture §2.5, §35).

## Commands

```bash
bun install            # install dependencies
bun run typecheck      # tsc --noEmit
bun run lint           # eslint
bun run test           # vitest run (unit + integration + architecture)
bun run arch:check     # static architecture checks only (PLAT-AC-01/02)
bun run start:api      # run the API process (WORKFLOWOS_ROLE=api)
bun run start:worker   # run the worker process (WORKFLOWOS_ROLE=worker)
bun run start          # run both in one process
```

### Configuration

| Env var                  | Default     | Description                                                          |
| ------------------------ | ----------- | -------------------------------------------------------------------- |
| `WORKFLOWOS_ROLE`        | `all`       | `api`, `worker`, or `all`.                                           |
| `PORT`                   | `3001`      | HTTP port when role includes `api`.                                   |
| `HOST`                   | `0.0.0.0`   | HTTP bind host.                                                       |
| `REDIS_URL`              | _(unset)_   | When set, the production `RedisQueue` + `TransientLock`/`Cache` are used. |
| `DATABASE_URL`           | _(unset)_   | PostgreSQL connection string (must start with `postgres`). When set, migrations run on startup and `Infrastructure` is wired. |
| `OBJECT_STORAGE_DIR`     | _(unset)_   | Filesystem root for `FsObjectStore`. When unset, an in-memory store is used. |
| `LOG_LEVEL`              | `info`      | pino log level.                                                       |

When `REDIS_URL` is unset, an in-memory queue is used with a warning. When
`DATABASE_URL` is unset, the app runs without the persistence container
(local dev). Production deployments MUST set `REDIS_URL`, `DATABASE_URL`, and
`OBJECT_STORAGE_DIR`.

### Test configuration

The test harness selects real vs. local-substitute infrastructure:

| Env var                    | When set                                                | When unset (default)                            |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| `WORKFLOWOS_DATABASE_URL`  | Real PostgreSQL via `pg.Pool` (CI service container)   | `@electric-sql/pglite` (real Postgres WASM)     |
| `WORKFLOWOS_REDIS_URL` / `REDIS_URL` | Real Redis via `ioredis` (CI service container) | `ioredis-mock`                                  |

Both paths exercise the real `DatabaseClient` / `RedisQueue` code — only the
transport differs. No fake in-memory database is used as proof of DATA-AC-03.

## WORK-001 evidence

See [`docs/work-items/WORK-001.md`](../docs/work-items/WORK-001.md) for the
WORK-001 acceptance-criteria-to-test mapping.

## WORK-003 evidence

See [`docs/work-items/WORK-003.md`](../docs/work-items/WORK-003.md) for the
WORK-003 (PostgreSQL, Redis, object storage) acceptance-criteria-to-test
mapping.
