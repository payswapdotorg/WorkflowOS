# WorkflowOS

WorkflowOS is a platform for managing an AI-assisted software development
workflow. This repository holds both the frozen architecture specification
and the implementation.

## Repository authority

This GitHub repository is the sole source of truth for implementation. A fresh
agent must not require conversation history, copied reports, or external
planning notes to determine what to implement next.

### Read first — all agents

1. [`AGENTS.md`](AGENTS.md) — mandatory repository-only operating contract
2. [`spec/implementation-roadmap.md`](spec/implementation-roadmap.md) — **frozen human-readable implementation sequencing and progress authority**
3. [`spec/development-state/README.md`](spec/development-state/README.md) — development-governance authority declarations
4. [`spec/development-state/implementation-state.json`](spec/development-state/implementation-state.json) — V2-017 task-level progress and recovery state
5. [`spec/development-state/v2-work-order-state.json`](spec/development-state/v2-work-order-state.json) — V2 Work Order eligibility/completion state
6. [`spec/development-state/program-state.json`](spec/development-state/program-state.json) — V1/V1.1 Work Order operational state
7. [`spec/architecture-lock.md`](spec/architecture-lock.md) — frozen architecture invariants
8. [`spec/architecture.md`](spec/architecture.md) — architecture description
9. [`spec/requirements.md`](spec/requirements.md) — requirements
10. applicable Work Order and dependency artifacts under [`spec/`](spec/)
11. [`docs/implementation/IMPLEMENTATION-GUIDE.md`](docs/implementation/IMPLEMENTATION-GUIDE.md) — implementation protocol

### Active program

V2-017 Universal Product UX is **complete**. The current V2 implementation
frontier is **V2-DEPLOY-001 — WorkflowOS V2 Productionization**.

Read:
- [`spec/architecture/v2/deployment-roadmap.md`](spec/architecture/v2/deployment-roadmap.md) — V2 productionization sequence and provider strategy
- [`spec/architecture/v2/work-orders/V2-DEPLOY-001.md`](spec/architecture/v2/work-orders/V2-DEPLOY-001.md) — governing productionization Work Order
- [`docs/deployment/V2-PRODUCTIONIZATION.md`](docs/deployment/V2-PRODUCTIONIZATION.md) — deployment baseline

The completed V2-017 roadmap remains authoritative for its historical task
sequence; it must not be reopened merely because productionization is now in
progress.

## Implementation rule

Select work only when its governing machine state and dependency graph make it
eligible. Verify dependencies through actual Git merge evidence. Inspect the
actual repository before coding. One bounded implementation slice per branch/PR.
Write failing behavioral tests first where behavior changes. Run objective
verification and required real-system/browser dogfooding. Record exact revision
and evidence. Submit to the Architect gate. Actual Git merge establishes
completion. Reconcile the roadmap and machine state immediately after merge.

## Architecture

The architecture is **frozen**. The authoritative documents are:

- [`spec/architecture.md`](spec/architecture.md) — full architecture.
- [`spec/architecture-lock.md`](spec/architecture-lock.md) — locked invariants.

Any change to the architecture requires an Architecture Change Request and a
new immutable architecture version. Implementation agents must not modify the
frozen architecture inside ordinary Work Orders.

## Current V2 product-layer state

V2-017 Universal Product UX is complete through T16. Exact V2-017 task status
must be re-read from GitHub and
`spec/development-state/implementation-state.json` when historical UX evidence
is required. The current forward implementation frontier is V2-DEPLOY-001.

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
