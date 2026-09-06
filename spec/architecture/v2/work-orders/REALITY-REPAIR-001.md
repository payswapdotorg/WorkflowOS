# REALITY-REPAIR-001 — Restore V2 Product Routes in Real Deployment Composition

**Status:** AUTHORIZED — next implementation slice
**Parent gate:** V2-REALITY-AUDIT-001
**Architect disposition:** F-001 ACCEPT

## Objective
Extend the real WorkflowOS deployment composition so the existing V2 product route groups are served by the actual `src/index.ts` / container topology.

## Scope
Construct and pass the existing V2 product service/dependency groups supported by `backend/src/api/server.ts`, using the existing shared database/configuration and frozen V2 authorities. Mirror the proven test composition only where it represents the real production topology.

Target groups include workflow repository, workflow runs, workflow deployments/scheduling, teaching, reverse teaching, optimization, and marketplace transport dependencies required by the V2 product.

## Non-goals
No new routes, domain authorities, workflow state machines, execution engines, verification systems, or provider abstractions. Do not alter V2-002 through V2-012 semantics.

## Required evidence
- Fresh branch from current `main`.
- Real deployment entry boots successfully.
- Representative auth-gated read from every V2 product route group returns an actual route response rather than 404.
- Existing identity/engineering routes remain functional.
- Browser smoke reaches Home, Workflows, Explore, and at least one detail page against the real deployment composition.
- Exact-head test and review evidence.

## Completion
Architect merge only after deterministic verification and real-topology browser proof. This repair unblocks REALITY-REPAIR-002 only after merge.
