# WORK-001 — Platform and modular-monolith foundation

**Status:** COMPLETE
**Acceptance criteria:** PLAT-AC-01, PLAT-AC-02, PLAT-AC-03, OBS-AC-01, OBS-AC-02
**Implementation:** `backend/`

## What was built

The TypeScript modular-monolith foundation described by `spec/architecture.md`
and `spec/architecture-lock.md`:

1. **Frozen module boundaries** — all 16 modules exist under
   `backend/src/modules/`. Each module has a public `index.ts` exporting a
   `ModuleContract` with its canonical name, plus a private `internal/`
   directory.
2. **Explicit module-interface convention** — cross-module communication goes
   through a module's `index.ts`. Reaching into another module's `internal/`
   (or any non-index file) is forbidden.
3. **Background-worker execution model** — `Queue` interface with two
   implementations:
   - `RedisQueue` (production; Redis `RPUSH`/`LPOP` + ack set)
   - `InMemoryQueue` (local dev and tests)
   - `WorkerHost` polls the queue, runs handlers inside a per-job execution
     context, and never blocks the API request path (PLAT-AC-03).
4. **Observability foundation**:
   - `pino` structured newline-delimited JSON logger.
   - `AsyncLocalStorage`-based execution context; an execution id is
     generated at the API boundary (or supplied via `X-Execution-Id`),
     carried into enqueued jobs, and re-established inside the worker so
     worker logs include it (OBS-AC-01 / OBS-AC-02).
   - `MetricsSink` and `ErrorTracker` integration points with default no-op
     implementations; vendor-specific sinks can be plugged in at startup
     without coupling domain code.

Domain logic (auth flows, project entities, architecture management,
requirements, work items, GitHub/LLM/agent integration, verification,
reviews, frontend) is **out of scope** and intentionally absent.

## Acceptance-criteria → evidence map

| Criterion | Evidence |
| --- | --- |
| **PLAT-AC-01** — Frozen modules exist as explicit boundaries | `tests/architecture/static-architecture.test.ts` — `PLAT-AC-01 — frozen modules exist as explicit boundaries` (asserts all 16 module dirs exist, each exposes `index.ts` + `internal/`, and the exported `ModuleContract.name` matches the canonical frozen name; also asserts no unexpected module dirs exist). |
| **PLAT-AC-02** — Cross-module calls use declared interfaces | `tests/architecture/static-architecture.test.ts` — `PLAT-AC-02 — cross-module calls use declared interfaces` (scans every `import`/`export from` in `src/modules/**`, resolves each to a file path, and rejects any import that reaches another module's `internal/` or any non-`index.ts` file of another module). Additional invariants: `platform/` MUST NOT import domain modules; `api/` MUST NOT reach into any module's `internal/`. |
| **PLAT-AC-03** — Long-running work executes asynchronously and does not block API request handling | `tests/integration/async-worker.integration.test.ts` — `PLAT-AC-03 — async background execution` (POST `/jobs/echo` with `delayMs: 600ms` returns 202 in well under 600ms; the worker then completes the job after the API returned; also verifies 5 concurrent jobs don't serialize API responses). |
| **OBS-AC-01** — Every workflow/background execution has a traceable execution identifier | `tests/integration/async-worker.integration.test.ts` — `OBS-AC-01 / OBS-AC-02 — execution id tracing through the worker` (the API-returned `executionId` equals the `executionId` on the queued `JobRecord` and on the execution context observed inside the handler; a caller-supplied `X-Execution-Id` header is honored through the full path). |
| **OBS-AC-02** — Logs emitted during an execution include that correlation/execution identifier | Same integration test asserts that every job-scoped log line (`api.job.enqueued`, `worker.job.started`, `echo.handled`, `worker.job.completed`) includes the job's `executionId`. |

## Required verification

| Type | Where |
| --- | --- |
| Unit tests | `backend/tests/unit/` — execution-context, logger, in-memory-queue, redis-queue (via `ioredis-mock`), worker-host. |
| Integration tests | `backend/tests/integration/async-worker.integration.test.ts` — PLAT-AC-03, OBS-AC-01, OBS-AC-02. |
| Static architecture checks | `backend/tests/architecture/static-architecture.test.ts` — PLAT-AC-01, PLAT-AC-02, plus forbidden-dependency-direction invariants. |

Run with:

```bash
cd backend && bun run test
```

Last run: **102 / 102 tests pass**, `bun run typecheck` clean, `bun run lint` clean.

## What is NOT in this change

Per WORK-001 out-of-scope, this implementation does **not** add:

- authentication flows (WORK-002)
- PostgreSQL/Redis/object-storage persistence layers (WORK-003)
- project / specification domain entities (WORK-004)
- architecture management / change control (WORK-005)
- requirements and acceptance criteria (WORK-006)
- work items and work-order state (WORK-007)
- GitHub integration (WORK-008..010)
- workflow state machine (WORK-011)
- agent gateway (WORK-012)
- LLM gateway (WORK-013..014)
- verification engine (WORK-015)
- architect reviews (WORK-016)
- workflow orchestration (WORK-017..019)
- audit trail (WORK-020)
- notifications (WORK-021)
- frontend (WORK-022)
- deployable runtime topology (WORK-023)
- end-to-end lifecycle (WORK-024)

The domain job types listed in architecture §27
(`github.webhook`, `github.sync`, `llm.request`, `agent.execute`,
`verification.collect`, `architect.review`, `notification.send`) are NOT
implemented. The reusable execution mechanism that future work items will use
to add them IS in place, demonstrated end-to-end by the `echo` fixture job.

## Architecture conformance

The implementation does not contradict `spec/architecture.md` or
`spec/architecture-lock.md`:

- Modular monolith (not microservices) — §2.6, §6.
- Redis-backed background workers; Redis is NOT authoritative — §27, §29.
- Modules communicate through explicit interfaces — §6.
- Observability capabilities (not a vendor) — §35.
- No provider-specific coupling in domain modules — §2.5, §16, §17.
- No frontend authority — §5.

No frozen architecture document was modified.
