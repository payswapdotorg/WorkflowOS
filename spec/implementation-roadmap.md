# WorkflowOS Implementation Roadmap

**Status:** FROZEN GOVERNANCE ARTIFACT

**Purpose:** Human-readable implementation sequencing, progress, recovery, and handoff surface.

**Machine counterparts:**
- Work Order eligibility and completion: `spec/development-state/v2-work-order-state.json` and `spec/development-state/program-state.json`
- V2-017 task-level progress: `spec/development-state/implementation-state.json`
- Derived dependency/frontier/checkpoint projections: `spec/development-state/dependency-state.json`, `frontier-state.json`, `checkpoint-state.json`
- Resident worker operating protocol: `docs/implementation/RESIDENT-ZAI-WORKER-PROTOCOL.md`
- Resident worker operations: `spec/development-state/resident-worker-operations.md`

**Detailed supporting map:** `spec/implementation-map.md`

**Important:** The roadmap is authoritative for human-readable sequencing/progress presentation. It must agree with the machine state artifacts. It never overrides the architecture lock, Work Orders, dependency graph, Git merge facts, or authority boundaries.

## Zero-history operating rule

A fresh architect or implementation agent must be able to determine what to implement next without conversation history.

The required recovery chain is:

```text
actual Git main
    ↓
implementation roadmap
    ↓
machine development state
    ↓
selected Work Order
    ↓
detailed implementation plan / contracts
    ↓
open + merged PR evidence
    ↓
exact verification + dogfooding evidence
    ↓
recompute eligible frontier
```

A chat message, agent memory, copied report, PR prose, stale checkbox, provider session, or external planning document is never a hidden prerequisite.

## Authority model

| Concern | Authority |
|---|---|
| Frozen architecture | `spec/architecture-lock.md` + governing architecture package |
| Requirements | `spec/requirements.md` |
| Work Order scope | selected Work Order under `spec/work-orders/` or `spec/architecture/v2/work-orders/` |
| Dependency eligibility | authoritative dependency graph + machine Work Order state |
| Human-readable sequencing/progress | **this roadmap** |
| V2 task-level operational progress | `spec/development-state/implementation-state.json` |
| V1/V1.1 Work Order operational state | `spec/development-state/program-state.json` |
| V2 Work Order operational state | `spec/development-state/v2-work-order-state.json` |
| Actual completion | authoritative Git merge |
| Runtime tenant state | PostgreSQL / owning runtime authority |
| Resident Z.ai worker process | disposable runtime; durable state is repository + GitHub |

### Synchronization invariant

A status change is governed only when the human-readable roadmap and its relevant machine counterpart change together in the same governed change, or when a post-merge reconciliation deliberately records an authoritative Git fact. A mismatch is a governance defect, not an invitation to guess.

## Program overview

### Baseline — original V1 and post-W6 platform evolution

```text
WORK-001 … WORK-024   COMPLETE
        │
        ├── WORK-025 … WORK-032   COMPLETE
        ├── WORK-033 … WORK-045   COMPLETE
        ├── WORK-046 … WORK-050   COMPLETE
        └── WORK-051 … WORK-052   COMPLETE
```

The baseline establishes the frozen WorkflowOS authorities, execution fabric, verification/evidence system, governance control plane, and development/self-hosting substrate. These Work Orders are historical implementation foundation, not prerequisites inferred from conversation.

### Current governed program — V2-017 Universal Product UX

```text
                         V2-017 UNIVERSAL PRODUCT UX
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                         ▼                         ▼
                 FOUNDATION / SHELL          WORKFLOW EXPERIENCE
                         │                         │
                  ┌──────┼──────┐          ┌──────┼──────┐
                  ▼      ▼      ▼          ▼      ▼      ▼
                 T1     T2     T13        T3     T4     T5
               shell   Home   Expert    library detail  create
                  │      │      │          │      │      │
                  └──────┴──────┴──────┬───┴──────┴──────┘
                                       ▼
                             T6 → T7   Run / Recovery
                             T8       Scheduling / Events
                             T9       Teach Me
                                       │
                         ┌─────────────┴──────────────┐
                         ▼                            ▼
                 T11 Versions / Improve       T12 Share / Market
                         │                            │
                         └─────────────┬──────────────┘
                                       ▼
                              T10 Activity / Trust
                                       │
                                       ▼
                              T14 Responsive / Mobile
                                       │
                                       ▼
                              T15 Full Product Dogfood
                                       │
                                       ▼
                                T16 Architect Gate
                                       │
                                       ▼
                              V2-017 COMPLETE
```

The diagram is intentionally human-readable. The exact dependency graph remains in `spec/architecture/v2/post-w6-product-roadmap.md` and the V2 Work Order.

## V2-017 status ledger

| Task | Status | Dependencies | Primary outcome |
|---|---|---|---|
| T1 | ✅ COMPLETE | V2-017 activation | Universal product shell, navigation, expert entry |
| T2 | ✅ COMPLETE | T1 | Workflow-first Home and attention surfaces |
| T3 | ✅ COMPLETE | T1 | Workflow library |
| T4 | ✅ COMPLETE | T3 | Workflow detail |
| T5 | ✅ COMPLETE | T1 | Tell / Show / Tell + Show creation |
| T6 | ⬜ ELIGIBLE | T4 | Run / approval / where-it-runs |
| T7 | ⬜ BLOCKED | T6 | Failure / recovery / takeover |
| T8 | ⬜ ELIGIBLE | T4 | Scheduling and events |
| T9 | ⬜ ELIGIBLE | T4 | Teach Me / reverse teaching |
| T10 | ⬜ BLOCKED | T6 / T7 / T9 | Activity and “How do you know?” |
| T11 | ⬜ ELIGIBLE | T4 | Versions / updates / optimization |
| T12 | ⬜ BLOCKED | T3 / T4 / T11 | Sharing / marketplace / install |
| T13 | ✅ COMPLETE | T1 | Expert/developer workspace |
| T14 | ⬜ ELIGIBLE | T1 + shared product shell | Responsive/mobile adaptation |
| T15 | ⬜ BLOCKED | T2–T14 | Full verification + real product dogfooding |
| T16 | ⬜ BLOCKED | T15 | Sole Architect review and merge gate |

### Current frontier

```text
ELIGIBLE FRONTIER

T6  Run / approval / where-it-runs
T8  Scheduling and events
T9  Teach Me / reverse teaching
T11 Versions / updates / optimization
T14 Responsive / mobile adaptation

CURRENT TASK

T6  Run / approval / where-it-runs
    T4 dependency complete; T4 is merged and reconciled
```

No task may become eligible merely because a branch exists. Dependencies are complete only through authoritative merged Git evidence. A stale implementation branch is historical evidence, not a current implementation dependency.

## Current implementation snapshot

- T1 is complete through **PR #173**, merged as `3a507199ec8b70f4c4feb2829bb1b6a2070bfc38`.
- T2 is complete through **PR #180**, merged as `a862498980036ef49b844cb1fa15bcd2e93c76c7`.
- T3 is complete through **PR #182**, merged as `27e6162c03f50c26041d7a71ae5c1ff99151f9a8`.
- T4 is complete through **PR #191**, squash-merged as `a9d70e9944d8d6af3cac7a3f7ddfe35c7c233636` from corrected head `35054853ba100deead33439aa2160507e421211c` on base `2904859fd6775063132e9c576e2319ee3cffdeda`.
- T4 included correction of F-T4-001: step labels are sourced only from V2-003 `presentation.nodeLabels`; internal `WorkflowNode.id` values are never rendered as consumer-facing labels, and missing/invalid presentation labels fail closed to the honest steps-unavailable state.
- T4 exact corrected-head verification: frontend 192/192, tsc clean, ESLint 0 errors with one pre-existing warning, Vite build clean; e2e, work-026/027/048/049/050 browser E2E, companion extension, lifecycle, and Architecture Governance passed. Backend and deploy failures matched the same failures at canonical base, producing zero PR-attributable CI regressions.
- T5 is complete through **PR #185**, squash-merged as `c958f17f93f2d03ff82ff1c06619ce0968e3e6b8` from corrected head `e759c6b4a992c526aa716b636868ae399c23414e`.
- T5 completion included correction of F-T5-001: the false `workflowos-captured-input-v1` use of the frozen WorkflowIR compatibility field was removed; the creation flow fails closed because no valid public captured-input authoring contract exists.
- T5 exact-head verification: Architecture Governance, frontend, lifecycle, governance-artifacts, work-026/027/048/049/050 browser E2E, and companion extension checks passed at the corrected head. Backend and deploy failures remained identical pre-existing failures from the canonical base. Frontend 22 files / 179 tests passed, tsc clean, ESLint 0 errors with one pre-existing warning, Vite build clean, work-074 browser 5/5, lifecycle 1/1, and architecture 914/915 with the single WORK-052 failure pre-existing at base.
- T13 is complete through **PR #188**, squash-merged as `e1383a97508e711a0a758c52bca3cb188a340030` from head `c71d30f0494fa30b4a03267f5106c552fbbd4ad0`.
- T13 exact-head verification: Architecture Governance, frontend, lifecycle, and work-026/027/048/049/050 browser E2E plus companion extension passed; backend and deploy failures were identical pre-existing failures at the canonical base. Frontend 22 files / 181 tests passed, tsc clean, ESLint 0 errors with one pre-existing warning, Vite build clean, work-074 6/6, lifecycle 1/1, and architecture 914/915 with the single WORK-052 failure pre-existing at base. The implementation keeps the existing expert/developer authority intact and adds only explicit mode-crossing language and a labeled return path.
- T2's historical PR #175 and #178 remain historical evidence only; neither is a current implementation dependency.
- The exact implementation base for each new task is **always the live `main` SHA re-read immediately before worker dispatch**. No stored governance artifact is treated as durable current-main truth.
- The resident-worker operating protocol, operations artifact, and dispatch template are repository-resident and govern all resident Z.ai implementation sessions.

The exact live branch/PR state must always be re-read from GitHub before continuing.

## Task execution loop

```text
ROADMAP + MACHINE STATE
        ↓
ELIGIBLE TASK
        ↓
ARCHITECT DURABLE DISPATCH
        ↓
RESIDENT Z.AI WORKER
        ↓
VERIFY LIVE AUTHORITY
        ↓
WRITE FAILING TEST (when behavior changes)
        ↓
RED → GREEN → REFACTOR
        ↓
DETERMINISTIC VERIFICATION
        ↓
REAL-SYSTEM / BROWSER DOGFOOD
        ↓
DURABLE CHECKPOINT ON SAME PR
        ↓
WAITING_FOR_ARCHITECT
        ↓
REQUEST_CHANGES → SAME PR → RESUME
        ↓
ARCHITECT APPROVE / MERGE GATE
        ↓
ACTUAL GIT MERGE
        ↓
POST-MERGE RECONCILIATION
        ↓
ROADMAP + MACHINE STATE SYNCHRONIZED
        ↓
RECOMPUTE FRONTIER
```

## Resident-worker discipline

The worker's runtime session is disposable. The durable checkpoint is the same task branch and PR plus exact committed head SHA and persisted evidence.

A `REQUEST_CHANGES` review must be tied to the exact reviewed head and contain stable finding IDs, affected paths, acceptance criteria, and concrete required actions. The worker resolves those findings on the same PR and publishes a new checkpoint.

A disconnected or exhausted session may be replaced only by a fresh session that verifies the latest repository and GitHub state and resumes from the latest checkpoint. A session change never authorizes a replacement PR.

No new commit alone proves a hang. Watchdog decisions must distinguish active work, review waiting, capacity exhaustion, and contradiction. Repeated identical restart/failure conditions escalate rather than loop.

## Merge discipline

One implementation slice per branch/PR unless a governing Work Order explicitly defines a combined integration gate.

A parallel sibling may depend only on already merged contracts. No unmerged branch is a dependency.

A task is not complete because tests pass, a PR is green, or an agent reports completion. Completion requires the governing review/merge process, actual Git merge evidence, and canonical reconciliation.

## Evidence discipline

Every accepted implementation slice records:

- exact base SHA;
- exact head SHA;
- PR identity;
- merge commit identity after merge;
- verification commands and outcomes;
- real browser/system dogfooding where required;
- known limitations or external blockers;
- scope confirmation against the Work Order.

A previous commit’s green result does not prove a corrected head. Fresh verification is required for the exact relevant head.

## Governance stop conditions

Stop and reconcile the repository before coding when:

- roadmap and machine state disagree;
- a machine artifact says an item is complete without matching Git evidence;
- Git proves a merge that machine state has not reconciled;
- the required authority contract does not exist;
- a proposed dependency is an unmerged sibling branch;
- implementation would create a second workflow, execution, verification, evidence, authorization, or governance authority;
- an implementation claim cannot be verified from the repository;
- the next action cannot be determined from repository state alone.

## Freeze rule

This roadmap is a governed implementation artifact. Changes to sequencing, dependencies, task scope, or status semantics require a durable repository change that preserves the governing architecture and records the reason. Implementation agents may update progress only from objective evidence under the applicable Work Order; they may not rewrite the roadmap to make a blocked task appear eligible.

## Fresh-agent handoff

A fresh agent can begin with:

1. `AGENTS.md`
2. this roadmap
3. `spec/development-state/README.md`
4. `spec/development-state/implementation-state.json` for V2-017 task progress
5. `spec/development-state/resident-worker-operations.md` when a resident worker is active
6. the applicable machine Work Order state
7. the selected Work Order and dependency map
8. current GitHub `main` and open/merged PRs

Nothing else is required to reconstruct the current implementation position.
