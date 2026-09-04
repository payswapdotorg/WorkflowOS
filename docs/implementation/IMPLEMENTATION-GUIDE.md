# WorkflowOS Implementation Guide

## Fresh-agent procedure

A fresh architect or implementation agent must be able to work from the repository alone.

1. Read `AGENTS.md`.
2. Read `spec/implementation-roadmap.md` — the frozen human-readable sequencing/progress authority.
3. Read `spec/development-state/README.md` — authority declarations.
4. Read the applicable machine state: `spec/development-state/program-state.json`, `v2-work-order-state.json`, and for V2-017 `implementation-state.json`.
5. Read the governing architecture lock and applicable V2 control artifacts.
6. Read the selected Work Order and dependency map.
7. Inspect actual current `main`, relevant PRs, merge commits, CI and persisted evidence.
8. Recompute the dependency-eligible frontier; do not trust a stale `nextAction` blindly.
9. Implement one bounded task/Work Order per branch unless a declared integration gate says otherwise.
10. For behavior changes, write the failing test first and verify RED before implementation.
11. Implement the smallest conforming change.
12. Run deterministic verification and required real-system/browser dogfooding.
13. Record exact base/head/merge identities and evidence.
14. Submit the PR to the Architect gate.
15. Treat actual Git merge as completion.
16. Reconcile roadmap + relevant machine state immediately after merge.
17. Recompute the next eligible frontier.

## Authority hierarchy

Architecture and semantic invariants outrank all planning artifacts.

Requirements and selected Work Orders define scope.

The dependency graph plus machine Work Order state defines eligibility.

`spec/implementation-roadmap.md` is the human-readable implementation sequencing/progress authority and must be synchronized with the applicable machine state.

PR prose, task checkboxes, branch names, agent reports, test counts, and conversation history are evidence/navigation only.

## Repository-only rule

Do not rely on hidden context. If an implementation fact is important enough to affect scope, sequencing, dependencies, verification, or recovery and it is not discoverable from repository artifacts, persist it before proceeding or raise the required governed change.

## Definition of done

A governed item is complete only when its Work Order acceptance criteria are satisfied, required verification/dogfooding is evidenced, Architect review is satisfied, the actual Git merge exists, and the roadmap/machine state are reconciled to that merge.

## Recovery

Use this sequence after interruption:

```text
main
 ↓
implementation-roadmap.md
 ↓
implementation-state / Work Order state
 ↓
selected Work Order
 ↓
dependency evidence
 ↓
actual code + tests
 ↓
exact-head verification
 ↓
PR / Architect gate
 ↓
merge
 ↓
reconcile
```

Never ask a subsequent agent to reconstruct progress from chat.
