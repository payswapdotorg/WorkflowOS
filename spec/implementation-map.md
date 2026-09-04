# WorkflowOS Detailed Implementation Map

**Status:** FROZEN SUPPORTING GOVERNANCE ARTIFACT

**Human-readable roadmap:** `spec/implementation-roadmap.md`

**Machine Work Order state:** `spec/development-state/v2-work-order-state.json` and `spec/development-state/program-state.json`

**Task-level operational state:** `spec/development-state/implementation-state.json`

This map explains how the implementation program is composed. It is not a second dependency authority and must not be edited to manufacture eligibility.

## Authority boundaries

| Concern | Authority |
|---|---|
| Architecture meaning and invariants | architecture lock / governing architecture package |
| Requirements | `spec/requirements.md` and V2 requirement/UX specs |
| Work Order scope | selected Work Order |
| Dependencies / eligibility | authoritative Work Order graph + machine state |
| Human-readable progress / sequence | `spec/implementation-roadmap.md` |
| Task-level progress | `spec/development-state/implementation-state.json` |
| Existing V2 Work Order status | `spec/development-state/v2-work-order-state.json` |
| Existing V1/V1.1 Work Order status | `spec/development-state/program-state.json` |
| Completion fact | actual Git merge |
| Runtime workflow/execution/verification semantics | owning V2 authorities |

## Program layers

### Baseline platform

`WORK-001..WORK-024` established the original platform, domain, workflow, verification, audit, UI, deployment, and end-to-end foundations.

### Autonomous development substrate

`WORK-025..WORK-052` established the architect workspace, runtime and provider integration, execution abstraction, Companion surfaces, benchmarking, execution policy, adaptive routing, agent roles, delegation, agent intelligence, developer workbench, maintenance health, unified execution UX, architecture governance, and development/self-hosting control plane.

The V2 machine state records actual completion identities. Do not infer completion from the range itself.

### V2 product layer

`V2-017` is the governed post-W6 human-facing product UX program. It composes over existing authorities and does not create new workflow, execution, evidence, verification, authorization, marketplace, or governance authorities.

## V2-017 task graph

```text
T1
 ├── T2
 ├── T3 → T4 → T6 → T7
 ├── T5
 ├── T13 → T14
 └── T1 → T8/T9/T11

T3 + T4 + T11 → T12
T6 + T7 + T9 → T10
T2–T14 → T15 → T16
```

The authoritative detailed graph remains in `spec/architecture/v2/post-w6-product-roadmap.md` and `spec/architecture/v2/work-orders/V2-017.md`.

## Task contracts

| Task | Scope | Main evidence boundary |
|---|---|---|
| T1 | Consumer shell, navigation, expert entry | route/navigation tests + auth journey |
| T2 | Workflow-first Home | read-state tests + browser Home journey |
| T3 | Workflow library | library/filter/read-state tests |
| T4 | Workflow detail | action/version/access presentation tests |
| T5 | Creation entry | Tell/Show/hybrid and semantic-preview tests |
| T6 | Run/approval/placement | consequential-action and availability tests |
| T7 | Failure/recovery/takeover | failure-state and Run-identity tests |
| T8 | Scheduling/events | trigger semantics and presentation tests |
| T9 | Teaching/reverse teaching | lesson/version/evidence separation tests |
| T10 | Activity/trust | evidence disclosure and authenticity-vs-effect tests |
| T11 | Versions/updates/improve | immutable pin/adoption/proposal tests |
| T12 | Share/market/install | entitlement/install/execution separation tests |
| T13 | Expert/developer workspace | reachability and authority-preservation tests |
| T14 | Responsive/mobile | semantic-equivalence and mobile interaction tests |
| T15 | Integrated dogfood | exact-head CI + real browser + acceptance reconciliation |
| T16 | Architect gate | repository-first review + actual merge |

## Implementation surfaces

V2-017 may change presentation/composition surfaces only. Reuse existing backend reads and mutation boundaries wherever possible.

A missing backend authority is a stop condition. It must not be replaced by client-side derivation or an invented local state machine.

## Completion loop

```text
read roadmap
  ↓
read task-level state
  ↓
read Work Order
  ↓
verify dependency merges
  ↓
inspect code
  ↓
write failing test
  ↓
implement
  ↓
verify exact head
  ↓
dogfood
  ↓
evidence
  ↓
Architect review
  ↓
merge
  ↓
reconcile state + roadmap
  ↓
recompute frontier
```

## Anti-drift rules

1. The roadmap does not redefine frozen architecture.
2. The task state does not redefine the dependency graph.
3. PR prose does not define completion.
4. Unmerged branches do not satisfy dependencies.
5. Test counts do not replace behavioral evidence.
6. Failed reads are not successful empties.
7. Advisory recommendations are not authoritative decisions.
8. No frontend surface may create a duplicate semantic or execution authority.
9. No architecture change hides inside a product-layer task.
10. Every handoff must be reconstructable from repository state.
