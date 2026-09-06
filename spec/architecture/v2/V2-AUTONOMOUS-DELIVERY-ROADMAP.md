# WorkflowOS V2 — Autonomous Delivery Roadmap

**Status:** GOVERNED EXECUTION GRAPH
**Purpose:** provide a machine-readable planning companion for the long-running Z.ai delivery orchestrator. This manifest does not replace canonical architecture or development-state authority.

## Authority order

1. Architecture constitution and frozen V2 contracts.
2. `spec/development-state/v2-work-order-state.json` for canonical eligibility/completion.
3. Individual Work Orders in `spec/architecture/v2/work-orders/` for bounded scope and acceptance.
4. This manifest for execution topology, packet dependencies, and safe parallelism.
5. GitHub PR/Issue state and evidence for actual execution state.

## Three-agent execution limit

Z.ai may reliably run **at most three specialist agents concurrently**. The orchestrator must therefore maintain a maximum of three active implementation/verification/fix/browser specialist slots at any time.

A specialist slot is disposable. Architect review does not consume an implementation slot when the PR is merely awaiting review. When Architect requests changes, the orchestrator may allocate one of the three slots to a repair agent for the affected PR.

The orchestrator must prefer useful parallelism over artificial concurrency: do not split one bounded Work Order across multiple implementation branches, and do not start dependent packets merely to keep slots busy.

## Orchestrator contract

The orchestrator must recalculate eligibility from canonical state after every merge. It may run independent packets concurrently up to the three-agent limit but must never start a packet whose declared prerequisite is not merged/COMPLETE.

Architect review never becomes a prerequisite for unrelated eligible packets. A PR awaiting review may coexist with independent implementation. Architect changes are applied to the same PR branch by a disposable repair agent.

The orchestrator must never merge, approve its own architecture, reinterpret frozen semantics, or bypass a dependency. Git merge is the completion barrier.

## Complete V2 program graph

```text
V2-017 COMPLETE
      │
      ▼
V2-REALITY-AUDIT-001
  R0–R4 COMPLETE
      │
      ▼
REALITY-REPAIR-001  F-001 deployment composition
      │
      ▼
REALITY-REPAIR-002  F-002 organization onboarding
      │
      ▼
REALITY-REPAIR-003  F-003 caller-org detail reads
      │
      ├───────────────┬───────────────────────┐
      ▼               ▼                       ▼
REALITY-REPAIR-004  REALITY-REPAIR-005   REALITY-REPAIR-006
F-004a + F-004b     F-005                  F-007
copy + expert IR    Home attention         installed naming
      │               │                       │
      │               └───────────┬───────────┘
      │                           │
      ▼                           ▼
REALITY-REPAIR-007             REALITY-REPAIR-008
F-008 lifecycle UX             F-009 teaching copy
      │                           │
      └──────────────┬────────────┘
                     ▼
               REALITY-REPAIR-009
               F-010 human diff
                     │
                     ▼
              R6 FULL RE-AUDIT
                     │
                     ▼
            R7 RELEASE READINESS
                     │
              PASS / no critical
                     │
                     ▼
               DEPLOYMENT UNLOCK
                     │
                     ▼
              ┌───────────────┐
              │ DEP-001       │
              │ architecture  │
              └───────┬───────┘
                      ▼
              ┌───────────────┐
              │ DEP-002       │
              │ config/secrets│
              └───────┬───────┘
                      │
          ┌───────────┼───────────┬───────────┐
          ▼           ▼           ▼           ▼
       DEP-003      DEP-004     DEP-005      DEP-007
        Neon         Redis        R2         Vercel
          │           │           │           │
          └───────────┴──────┬────┴───────────┘
                             ▼
                         DEP-006
                      API + Worker
                             │
                    ┌────────┼────────┐
                    ▼        ▼        ▼
                 DEP-008    DEP-009  DEP-010
                   Edge      CI/CD  Observability
                    │          │       │
                    └──────────┴───────┘
                             ▼
                         DEP-011
                   Production dogfooding
                             │
                             ▼
                         DEP-012
                  Architect final acceptance
                             │
                             ▼
                         V2 PRODUCTION
```

## Product-repair topology

- `REALITY-REPAIR-001 → 002 → 003` is intentionally serialized because each establishes the runtime/user substrate required by the next critical journey.
- `REALITY-REPAIR-004`, `REALITY-REPAIR-005`, and `REALITY-REPAIR-006` may run concurrently after `REALITY-REPAIR-003` is merged, subject to the three-agent ceiling.
- `REALITY-REPAIR-007` depends on `REALITY-REPAIR-003` and may run concurrently with 004/005/006 when a slot is available.
- `REALITY-REPAIR-008` and `REALITY-REPAIR-009` are independent bounded cleanup packets and may run concurrently once their stated predecessors permit them.
- `REALITY-REPAIR-004` is the single canonical F-004 Work Order. It includes the copy correction and the composition-only expert WorkflowIR authoring surface. Natural-language capture→WorkflowIR generation remains deferred and would require a governed architecture change.
- Device-status F-006 has no implementation packet because the Architect accepted the existing honest-unavailable behavior.
- R6 is a full repeat audit; R7 is an explicit release-readiness decision gate. Neither may be treated as ordinary implementation work.

## Productionization topology

| Packet | Purpose | Dependencies | Parallelism | Unlocks |
|---|---|---|---|---|
| DEP-001 | production architecture/provider seams | R7 | SERIAL FOUNDATION | 002, 007, 008, 009 |
| DEP-002 | environment/secrets/config contract | 001 | SERIAL FOUNDATION | 003, 004, 005, 006, 007, 008, 009, 010 |
| DEP-003 | Neon DB + migration control | 002 | PARALLEL | 006, 009, 011 |
| DEP-004 | Redis coordination | 002 | PARALLEL | 006, 009, 011 |
| DEP-005 | R2 storage adapter | 002 | PARALLEL | 006, 009, 010, 011 |
| DEP-006 | API + Worker deployment | 003, 004, 005 | SERIALIZED RUNTIME FOUNDATION | 008, 009, 010, 011 |
| DEP-007 | Vercel frontend delivery | 002 | PARALLEL | 008, 011 |
| DEP-008 | DNS/TLS/edge/Turnstile | 002, 006, 007 | PARALLEL | 011 |
| DEP-009 | CI/CD/migrations/rollback/smoke | 002, 003, 006 | PARALLEL | 011, 012 |
| DEP-010 | observability/cost controls | 002, 006, 008 | PARALLEL | 011, 012 |
| DEP-011 | production dogfooding/release evidence | 003, 004, 005, 006, 007, 008, 009, 010 | FINAL GATE | 012 |
| DEP-012 | Architect production acceptance | 011 | FINAL AUTHORITY GATE | V2 LIVE |

## Packet authoring rules

Every future Work Order must contain, at minimum:

- a unique bounded scope and explicit non-goals;
- canonical dependencies expressed only as merged/COMPLETE prerequisites;
- an explicit parallelism class (`SERIAL`, `PARALLEL`, `FINAL-GATE`, or equivalent);
- the authoritative files/services/contracts it may touch;
- deterministic verification requirements;
- real-browser proof where the packet changes user-visible behavior;
- evidence artifacts and the exact-head acceptance requirement;
- explicit downstream unlocks;
- stop conditions for architecture/authority drift;
- a rule that Architect-requested repairs update the same PR rather than creating a sibling implementation.

## One PR per Work Order

A worker agent may split internal tasks, but one governed Work Order produces one implementation branch and one PR. Cross-Work-Order batching is prohibited unless an Architect-created integration gate explicitly authorizes it.

## Three-slot scheduling policy

The orchestrator maintains three active specialist slots:

```text
Slot A — primary implementation
Slot B — independent implementation / verification
Slot C — independent implementation / Architect-review repair
```

When no Architect repair is pending, all three slots may be filled from the currently eligible graph. When a review change arrives, a slot may be reassigned to repair the existing PR. A dependent Work Order cannot be substituted merely because a slot is idle.

## Review does not stall the graph

A PR waiting on Architect review does not block independent eligible packets. A repair agent updates the same PR branch and reruns the Work Order's verification.

## Merge is the barrier

Downstream activation is based on actual Git merge and canonical state, never PR creation, CI success alone, or worker assertion.

## Failure isolation

A provider-specific implementation failure blocks that packet and its dependents but does not stop independent packets. A newly discovered shared semantic/authority issue becomes a governed corrective Work Order.

## Final gate

No deployment packet may activate before V2-REALITY-AUDIT-001 is accepted, all release-blocking repairs are merged, R6 confirms no critical UX-to-operational mismatch, and R7 records Architect release-readiness acceptance.
