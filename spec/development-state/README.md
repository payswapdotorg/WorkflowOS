# Repository Development State — Authority Declaration

`spec/development-state/` is the canonical repository-resident development-governance state of WorkflowOS. It exists so that a fresh architect or implementation agent with zero conversational history can determine what architecture governs, which Work Orders exist, what can run in parallel, which checkpoints apply, and how interrupted work resumes.

## Fresh takeover navigation

- [`ARCHITECT_START_HERE.md`](../../ARCHITECT_START_HERE.md) — root entrypoint for a zero-history Architect.
- [`current-state.md`](./current-state.md) — human-readable convenience projection; not authority.
- [`../../docs/architecture/ARCHITECT-REVIEW-PROTOCOL.md`](../../docs/architecture/ARCHITECT-REVIEW-PROTOCOL.md) — repeatable Architect PR review loop.
- [`../../docs/implementation/ZAI-RESIDENT-WORKER-PROMPT.md`](../../docs/implementation/ZAI-RESIDENT-WORKER-PROMPT.md) — resident implementation-worker operating prompt.

For V2 governance-state semantics, read `spec/architecture/v2/V2-ACR-002-governance-control-plane-refinement.md` together with `spec/architecture/v2/execution-control-plane.md`.

## Repository-only consumption

Repository state is the sole source of truth for implementation progress and recovery. Conversation history, agent memory, pasted reports, verbal instructions, and copied summaries are non-authoritative.

The human-readable implementation surface is `spec/implementation-roadmap.md` and must remain synchronized with the applicable machine state.

### V2 state model

V2 development state is intentionally split into a historical/base record and a post-W6 autonomous execution extension:

- `spec/development-state/v2-work-order-state.json` records the completed V2 W0–W6 program and the historical V2-017/reality-audit baseline.
- `spec/development-state/v2-autonomous-execution-state.json` is the governed post-W6 execution extension. It owns the active reality-repair/deployment Work Order frontier, three-slot scheduling state, branch synchronization state, and exact-head Architect review queue for that extension.
- The Work Order files remain scope/acceptance authority; GitHub merge history remains completion authority.

The autonomous extension is not a second semantic dependency authority. It is the continuation of the same Work Order graph after V2-017 and may only reference repository-resident governed Work Orders.

For legacy V1/V1.1 work, `program-state.json` remains the Work Order operational state.

## Authority classes

| Artifact | Authority | Role |
|---|---|---|
| `governance-model.json` | Governance MODEL | Architect-owned control-loop, assurance, checkpoint and boundary rules. |
| `program-state.json` | V1/V1.1 operational state | Work Order status and resume information for original Work Orders. |
| `v2-work-order-state.json` | V2 historical/base Work Order state | W0–W6 and V2-017 completion facts plus the pre-repair reality-audit baseline. |
| `v2-autonomous-execution-state.json` | V2 post-W6 execution state | Active successor frontier, scheduler state, synchronization records, review queue, and deployment gating for the post-W6 program. |
| `implementation-state.json` | V2-017 task state | Task-level progress inside V2-017; must agree with Git and its roadmap. |
| `implementation-roadmap.md` | Human-readable roadmap authority | Human-readable sequencing/progress presentation; does not override Work Orders or Git history. |
| `dependency-state.json` | Derived projection | Dependency eligibility/conflict projection; never independent authority. |
| `frontier-state.json` | Derived projection | Current eligible frontier/reconciliation projection; never independent authority. |
| `checkpoint-state.json` | Derived projection | Checkpoint requirement/result summary; verification evidence remains authoritative in owning modules. |

## Dependency authority

There is one logical Work Order dependency graph. The post-W6 autonomous state is an extension of that graph, not a competing graph. Every active extension Work Order must exist as a repository Work Order and must declare the same dependency semantics there.

## Completion authority

The Architect's actual Git merge is the sole completion event for an implementation task or Work Order.

`mergedAs` is a durable identity binding to the actual PR and merge commit. A complete record without matching Git evidence is invalid. An in-flight record with authoritative merge evidence is invalid until reconciled.

Post-merge reconciliation is bookkeeping: it records authoritative Git facts, updates the roadmap and machine state, and never approves a merge, expands scope, lowers assurance, or creates a new authority.

## Review authority

An Architect review trigger is valid only for the exact PR head named by a durable `READY_FOR_ARCHITECT_REVIEW` event in `v2-autonomous-execution-state.json`. A changed head, changed `main`, material evidence change, new Architect finding, or scope change invalidates the event.

The user-facing trigger is:

`ARCHITECT REVIEW: WorkflowOS PR #<N>, Work Order <WO>, head <SHA>`

The orchestrator may continue independent eligible work while a PR is awaiting review.

## Branch synchronization authority

The persistent Z.ai orchestrator is the synchronization mechanism for parallel work. Manual rebase prompts are not part of the governed operating model.

Parallel siblings must never depend on unmerged sibling branches. When `main` advances, the orchestrator refreshes affected PR branches on the same PR, resolves only mechanical in-scope conflicts, reruns required verification, and regenerates review readiness. Semantic/authority/scope conflicts stop for Architect governance.

## Required invariants

1. Schema versions and closed vocabularies are valid.
2. The logical Work Order dependency graph is acyclic and references known Work Orders only.
3. Completion evidence is bound to actual Architect-authorized Git merge identity.
4. In-flight work records an exact base SHA and cannot be treated as complete without authoritative merge evidence.
5. Roadmap, task-state and Work Order state cannot authorize work contrary to the dependency graph or frozen architecture.
6. Derived dependency/frontier/checkpoint/navigation projections cannot authorize or redefine work.
7. The governance boundary preserves code-pinned prohibitions and assurance dominance.
8. Checkpoint enforcement references remain present.
9. V2 derived artifacts cannot supersede frozen V1 authority or activate a proposed V2 architecture version.
10. Post-merge finalization records authoritative Git facts only and remains separate from approval.
11. V2 recovery can be completed from repository-resident artifacts without conversational history.
12. The human-readable roadmap and applicable machine state remain synchronized for every governed progress change.
13. The autonomous scheduler never exceeds three concurrent specialist agents.
14. No review-ready event is valid without exact-head verification against current `main`.
15. No routine branch-behind-main condition may require user/operator action.

A repository whose governance state violates any invariant is not a valid governed state: implementation must stop until the inconsistency is repaired.
