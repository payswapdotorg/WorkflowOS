# WorkflowOS

WorkflowOS is a platform for managing an AI-assisted software development
workflow. This repository holds both the frozen architecture specification
and the implementation.

## Repository layout

```
WorkflowOS/
├── spec/        # Frozen architecture (authoritative — do not modify)
│   ├── architecture.md
│   ├── architecture-lock.md
│   ├── requirements.md
│   ├── work-items.md
│   └── dependency-graph.md
├── backend/     # TypeScript modular-monolith backend (WORK-001+)
└── docs/        # Work-item evidence and design notes
```

## Architecture

The architecture is **frozen**. The authoritative documents are:

- [`spec/architecture.md`](spec/architecture.md) — full architecture.
- [`spec/architecture-lock.md`](spec/architecture-lock.md) — locked invariants.

Any change to the architecture requires an Architecture Change Request and a
new immutable architecture version. Implementation agents must not modify the
frozen architecture (architecture §2.4, §40).

## Current state

**WORK-001** — Platform and modular-monolith foundation — is implemented in
[`backend/`](backend/). See [`docs/work-items/WORK-001.md`](docs/work-items/WORK-001.md)
for the acceptance-criteria evidence.

All subsequent work items build on this foundation.

## Quick start

### Local development — no Docker, no hosted PostgreSQL (WORK-071)

Run the real WorkflowOS backend locally against a PGlite database (real
PostgreSQL compiled to WASM, persisted to the local filesystem — the same
migrations and the same domain code as production):

```bash
cd backend
bun install

# The explicit dev-runtime signal: WORKFLOWOS_DEV_RUNTIME=pglite with
# DATABASE_URL unset. Fails closed if both are set, or under
# NODE_ENV=production.
WORKFLOWOS_DEV_RUNTIME=pglite bun run start

# In another shell — the frontend dev server proxies /api to :3001.
cd frontend && bun install && bun run dev
```

The backend serves the full product surface (auth, organizations, projects,
work items, workflow/execution/verification) on `http://localhost:3001`,
with the dev database persisted under
`backend/.workflowos-dev-data/pglite` (override with
`WORKFLOWOS_DEV_DATABASE_DIR`). No Redis server is required either: the
dev runtime substitutes the non-authoritative Redis layer (locks/cache) and
the queue with in-memory dev implementations.

This path is dev-only. Production always uses a networked PostgreSQL via
`DATABASE_URL` (see `.env.example` and
[`docs/deployment/production.md`](docs/deployment/production.md)).

### Full stack with Docker (docker-compose)

```bash
cp .env.example .env   # fill in real values — never commit credentials
docker compose up
```

### Tests

```bash
cd backend
bun install
bun run test          # unit + integration + static architecture checks
```

See [`backend/README.md`](backend/README.md) for details.
