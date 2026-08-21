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

```bash
cd backend
bun install
bun run test          # unit + integration + static architecture checks
```

See [`backend/README.md`](backend/README.md) for details.
