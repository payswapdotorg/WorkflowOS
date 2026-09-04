# WorkflowOS Implementation Roadmap

**Status:** FROZEN GOVERNANCE ARTIFACT

**Purpose:** Human-readable implementation sequencing, progress, recovery, and handoff surface.

**Machine counterparts:**
- Work Order eligibility and completion: `spec/development-state/v2-work-order-state.json` and `spec/development-state/program-state.json`
- V2-017 task-level progress: `spec/development-state/implementation-state.json`
- Derived dependency/frontier/checkpoint projections: `spec/development-state/dependency-state.json`, `frontier-state.json`, `checkpoint-state.json`

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

A chat message, agent memory, copied report, PR prose, stale checkbox, or external planning document is never a hidden prerequisite.

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
| T2 | 🟦 IN_PROGRESS | T1 | Workflow-first Home and attention surfaces |
| T3 | ⬜ ELIGIBLE | T1 | Workflow library |
| T4 | ⬜ BLOCKED | T3 | Workflow detail |
| T5 | ⬜ ELIGIBLE | T1 | Tell / Show / Tell + Show creation |
| T6 | ⬜ BLOCKED | T4 | Run / approval / where-it-runs |
| T7 | ⬜ BLOCKED | T6 | Failure / recovery / takeover |
| T8 | ⬜ BLOCKED | T4 | Scheduling and events |
| T9 | ⬜ BLOCKED | T4 | Teach Me / reverse teaching |
| T10 | ⬜ BLOCKED | T6 / T7 / T9 | Activity and “How do you know?” |
| T11 | ⬜ BLOCKED | T4 | Versions / updates / optimization |
| T12 | ⬜ BLOCKED | T3 / T4 / T11 | Sharing / marketplace / install |
| T13 | ⬜ ELIGIBLE | T1 | Expert/developer workspace |
| T14 | ⬜ BLOCKED | T1 + shared product shell | Responsive/mobile adaptation |
| T15 | ⬜ BLOCKED | T2–T14 | Full verification + real product dogfooding |
| T16 | ⬜ BLOCKED | T15 | Sole Architect review and merge gate |

### Current frontier

```text
ELIGIBLE FRONTIER

T3  Workflow library
T5  Tell / Show / Tell + Show
T13 Expert/developer workspace

CURRENT ACTIVE

T2  Workflow-first Home
```

No task may become eligible merely because a branch exists. Dependencies are complete only through authoritative merged Git evidence.

## Current implementation snapshot

At the time this roadmap is introduced:

- `main` is the authoritative base branch.
- V2-017 Task 1 is complete through **PR #173**, merged as `3a507199ec8b70f4c4feb2829bb1b6a2070bfc38`.
- V2-017 Task 2 is the active implementation slice.
- The active Task 2 work was initially opened as **PR #175** from `main` at `520b93b0c757bd0827d09de66d628f0fc4dbcba8`, with RED-first Home contract coverage at head `7fa73064468861271d8843c1b2ba34fc4a97f8be`.
- That Task 2 branch is subject to the governance-artifact introduction described by the repository history. Any subsequent implementation must use the newest eligible `main` and must not depend on stale sibling branches.

The exact live branch/PR state must always be re-read from GitHub before continuing.

## Task execution loop

```text
ROADMAP + MACHINE STATE
        ↓
ELIGIBLE TASK
        ↓
READ WORK ORDER / CONTRACTS
        ↓
INSPECT ACTUAL REPOSITORY
        ↓
WRITE FAILING TEST (when behavior changes)
        ↓
RED → GREEN → REFACTOR
        ↓
DETERMINISTIC VERIFICATION
        ↓
REAL-SYSTEM / BROWSER DOGFOOD
        ↓
EVIDENCE
        ↓
PR + ARCHITECT REVIEW
        ↓
ACTUAL GIT MERGE
        ↓
POST-MERGE RECONCILIATION
        ↓
ROADMAP + MACHINE STATE SYNCHRONIZED
        ↓
RECOMPUTE FRONTIER
```

## Merge discipline

One implementation slice per branch/PR unless a governing Work Order explicitly defines a combined integration gate.

A parallel sibling may depend only on already merged contracts. No unmerged branch is a dependency.

A task is not complete because tests pass, a PR is green, or an agent reports completion. Completion requires the governing review/merge process and actual Git merge evidence.

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
- a proposed dependency is an unmerged sibling branch;
- the required authority contract does not exist;
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
5. the applicable machine Work Order state
6. the selected Work Order and dependency map
7. current GitHub `main` and open/merged PRs

Nothing else is required to reconstruct the current implementation position.
