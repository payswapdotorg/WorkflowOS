# WorkflowOS Agent Operating Contract

This repository is the sole source of truth for implementation. Assume no access to prior conversations.

## Mandatory reading order

1. `README.md`
2. `spec/implementation-roadmap.md` — frozen human-readable sequencing/progress authority
3. `spec/development-state/README.md` — governance authority declarations
4. `spec/development-state/implementation-state.json` — V2-017 task-level operational state when working on the active product program
5. applicable machine Work Order state: `spec/development-state/v2-work-order-state.json` or `spec/development-state/program-state.json`
6. `spec/architecture-lock.md`
7. `spec/architecture.md` and applicable V2 architecture-control artifacts
8. applicable requirements, Work Order, dependency graph, and design/specification
9. current GitHub `main`, relevant open PRs, commits, CI and persisted evidence

## Repository-only rule

Conversation history, chat summaries, verbal instructions, pasted reports, agent memory, and unstored assumptions are non-authoritative.

If an important implementation fact exists only in conversation, persist it in the appropriate repository artifact before relying on it. If the fact cannot be made consistent with the governing architecture or Work Order, stop and raise the governed change instead.

## Frozen architecture

Do not change frozen architecture, protocol, semantic, execution, verification, evidence, authorization, marketplace, or governance invariants inside an ordinary implementation task. Use the applicable architecture-change process.

## Roadmap authority

`spec/implementation-roadmap.md` is the human-readable sequencing and progress authority. It must remain synchronized with the relevant machine state. It does not override architecture locks, Work Orders, dependency authorities, or actual Git history.

## Work discipline

Implement one bounded Work Order/task slice per branch/PR unless a declared integration gate says otherwise.

Before coding:

1. inspect current `main`;
2. read roadmap and machine state;
3. recompute dependency eligibility from repository state;
4. verify dependencies by actual merge evidence;
5. read the selected Work Order/contracts;
6. inspect actual implementation;
7. write a failing behavioral test first when behavior changes.

Then implement the smallest conforming change, run exact-head verification, perform required real-system/browser dogfooding, record evidence, submit for the Architect gate, and reconcile state after the actual merge.

## Completion

A task is not complete because code exists, tests pass locally, CI is green, a PR is open, or an agent says it is complete. Completion requires the applicable governance gate and authoritative Git merge evidence.

## Recovery

Resume from:

```text
current main
→ implementation roadmap
→ machine state
→ selected Work Order
→ dependency merge evidence
→ actual implementation
→ exact-head verification
→ persisted evidence
→ recompute frontier
```

Never ask a future agent to reconstruct implementation state from conversation.

## Boundary rules

- No unmerged sibling branch is a dependency.
- Frontend code does not become a semantic/workflow/execution/verification authority.
- Recommendations remain advisory until an owning authority records a decision.
- Failed reads remain distinguishable from genuine empty results.
- Exact revisions and evidence must be preserved at handoff boundaries.
