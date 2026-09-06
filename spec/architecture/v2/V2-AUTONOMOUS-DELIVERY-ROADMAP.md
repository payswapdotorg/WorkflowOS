# WorkflowOS V2 — Autonomous Delivery Roadmap

**Status:** GOVERNED EXECUTION GRAPH
**Purpose:** provide a machine-readable planning companion for the long-running Z.ai delivery orchestrator. This manifest does not replace canonical architecture or development-state authority.

## Authority order

1. Architecture constitution and frozen V2 contracts.
2. `spec/development-state/v2-work-order-state.json` for canonical eligibility/completion.
3. Individual Work Orders in `spec/architecture/v2/work-orders/` for bounded scope and acceptance.
4. This manifest for execution topology, packet dependencies, and safe parallelism.
5. GitHub PR/Issue state and evidence for actual execution state.

## Orchestrator contract

The orchestrator must recalculate eligibility from canonical state after every merge. It may run independent packets concurrently but must never start a packet whose declared prerequisite is not merged/COMPLETE.

Architect review never becomes a prerequisite for unrelated eligible packets. A PR awaiting review may coexist with independent implementation. Architect changes are applied to the same PR branch by a disposable repair agent.

## Current product-repair graph

```text
REALITY-REPAIR-001
        │
        ▼
REALITY-REPAIR-002
        │
        ▼
REALITY-REPAIR-003
        │
        ▼
REALITY-REPAIR-007
        │
        ├───────────────┐
        ▼               ▼
REALITY-REPAIR-004A   REALITY-REPAIR-004
        │               │
        └──────┬────────┘
               ▼
REALITY-REPAIR-005 ──┐
REALITY-REPAIR-006 ──┤
REALITY-REPAIR-008 ──┤──► R6 FULL REALITY RE-AUDIT
REALITY-REPAIR-009 ──┘          │
                                ▼
                         DEPLOYMENT UNLOCK
```

Notes:

- `REALITY-REPAIR-007` depends on caller-org correctness because the run-control UX must operate on customer-owned execution facts.
- `REALITY-REPAIR-004A` is the composition-only expert authoring decision; natural-language capture→WorkflowIR remains deferred.
- Repairs 005, 006, 008 and 009 are presentation/composition work and may run in parallel once their required blocker dependencies are satisfied.
- R6 is a gate, not an implementation packet.

## Productionization graph

```text
                         DEP-001
                  architecture foundation
                         │
                         ▼
                         DEP-002
                config/secrets foundation
                   ┌─────┼─────┬─────┐
                   │     │     │     │
                   ▼     ▼     ▼     ▼
                DEP-003 DEP-004 DEP-005 DEP-007
                 Neon   Redis    R2    Vercel
                   │     │     │      │
                   └─────┴─────┴──────┘
                           │
                           ▼
                         DEP-006
                    API + Worker runtime
                           │
                    ┌──────┼─────────┐
                    ▼      ▼         ▼
                 DEP-008 DEP-009  DEP-010
                  Edge    CI/CD   Observability
                    │      │         │
                    └──────┴─────────┘
                           │
                           ▼
                         DEP-011
                  Production dogfooding
                           │
                           ▼
                         DEP-012
                  Architect acceptance
                           │
                           ▼
                       V2 LIVE
```

## Packet registry

| Packet | Purpose | Dependencies | Parallelism | Unlocks |
|---|---|---|---|---|
| DEP-001 | production architecture/provider seams | R6 | SERIAL FOUNDATION | 002,007,008,009 |
| DEP-002 | env/secrets/config contract | 001 | PARALLEL_AFTER_DEPENDENCIES | 003,004,005,006,007,008,009,010 |
| DEP-003 | Neon DB + migration control | 002 | PARALLEL_AFTER_DEPENDENCIES | 006,009,011 |
| DEP-004 | Redis coordination | 002 | PARALLEL_AFTER_DEPENDENCIES | 006,009,011 |
| DEP-005 | R2 storage adapter | 002 | PARALLEL_AFTER_DEPENDENCIES | 006,009,010,011 |
| DEP-006 | API + Worker deployment | 003,004,005 | SERIALIZED RUNTIME FOUNDATION | 008,009,010,011 |
| DEP-007 | Vercel frontend delivery | 002 | PARALLEL_AFTER_DEPENDENCIES | 008,011 |
| DEP-008 | DNS/TLS/edge/Turnstile | 002,006,007 | PARALLEL_AFTER_DEPENDENCIES | 011 |
| DEP-009 | CI/CD/migrations/rollback/smoke | 002,003,006 | PARALLEL_AFTER_DEPENDENCIES | 011,012 |
| DEP-010 | observability/cost controls | 002,006,008 | PARALLEL_AFTER_DEPENDENCIES | 011,012 |
| DEP-011 | production dogfooding/release evidence | 003,004,005,006,007,008,009,010 | FINAL GATE | 012 |
| DEP-012 | Architect production acceptance | 011 | FINAL AUTHORITY GATE | V2 LIVE |

## Execution principles

### One PR per Work Order

A worker agent may split internal tasks, but one governed Work Order produces one implementation branch and one PR. Cross-Work-Order batching is prohibited unless an Architect-created integration gate explicitly authorizes it.

### Parallelism is earned

Packets marked `PARALLEL_AFTER_DEPENDENCIES` may execute concurrently once all dependencies are merged. Parallel workers must begin from the required base and have disjoint authoritative change surfaces.

### Review does not stall the graph

A PR waiting on Architect review does not block independent packets. A review-fix agent updates the same PR branch and reruns the Work Order's verification.

### Merge is the barrier

Downstream activation is based on actual Git merge and canonical state, never PR creation, CI success alone, or worker assertion.

### Failure isolation

A provider-specific implementation failure blocks that packet and its dependents but should not stop independent packets. A newly discovered shared semantic/authority issue becomes a governed corrective Work Order.

### Final gate

No deployment packet may activate before V2-REALITY-AUDIT-001 is accepted, all release-blocking repairs are merged, and R6 confirms no critical UX-to-operational mismatch.
