# WorkflowOS Implementation Guide

## Fresh-agent procedure

A fresh architect or implementation agent must be able to work from the repository alone.

1. Read `AGENTS.md`.
2. Read `spec/implementation-roadmap.md` — the frozen human-readable sequencing/progress authority.
3. Read `spec/development-state/README.md` — authority declarations.
4. Read the applicable machine state: `spec/development-state/program-state.json`, `v2-work-order-state.json`, and for V2-017 `implementation-state.json`.
5. Read the governing architecture lock and applicable V2 control artifacts.
6. Read the selected Work Order and dependency map.
7. Read `docs/implementation/RESIDENT-ZAI-WORKER-PROTOCOL.md` when the selected task is being dispatched/resumed through a resident Z.ai worker.
8. Inspect actual current `main`, relevant PRs, merge commits, CI and persisted evidence.
9. Recompute the dependency-eligible frontier; do not trust a stale `nextAction` blindly.
10. Implement one bounded task/Work Order per branch unless a declared integration gate says otherwise.
11. For behavior changes, write the failing test first and verify RED before implementation.
12. Implement the smallest conforming change.
13. Run deterministic verification and required real-system/browser dogfooding.
14. Record exact base/head/merge identities and evidence.
15. Publish a durable implementation checkpoint on the same task PR.
16. Submit the PR to the Architect gate and enter resident `WAITING_FOR_ARCHITECT` rather than treating the textual response as termination.
17. On new findings, resume the same PR from the durable review packet and publish a new checkpoint.
18. Treat actual Git merge as completion.
19. Reconcile roadmap + relevant machine state immediately after merge.
20. Recompute the next eligible frontier.

## Authority hierarchy

Architecture and semantic invariants outrank all planning artifacts.

Requirements and selected Work Orders define scope.

The dependency graph plus machine Work Order state defines eligibility.

`spec/implementation-roadmap.md` is the human-readable implementation sequencing/progress authority and must be synchronized with the applicable machine state.

PR prose, task checkboxes, branch names, agent reports, test counts, dashboard text, provider session IDs, and conversation history are evidence/navigation only.

## Repository-only rule

Do not rely on hidden context. If an implementation fact is important enough to affect scope, sequencing, dependencies, verification, or recovery and it is not discoverable from repository artifacts or live GitHub evidence, persist it before proceeding or raise the required governed change.

## Durable dispatch

Before a resident worker changes code, the Architect/operator must post a durable dispatch request naming the exact task, Work Order, base SHA, accepted scope, forbidden scope, required verification, same-PR requirement, and worker safety boundaries. The worker must independently verify those facts against current repository authority and live GitHub.

A dispatch request does not authorize work against a stale base, inactive task, missing dependency, or contradictory authority.

## Resident worker loop

```text
DISPATCH
  ↓
VERIFY LIVE AUTHORITY
  ↓
IMPLEMENT
  ↓
VALIDATE + DOGFOOD
  ↓
DURABLE CHECKPOINT
  ↓
WAITING_FOR_ARCHITECT
  ↓
REQUEST_CHANGES? ── yes → SAME PR → IMPLEMENT → CHECKPOINT
  │
  no
  ↓
APPROVE / MERGE GATE
  ↓
ACTUAL GIT MERGE
  ↓
RECONCILIATION
  ↓
NEXT FRONTIER
```

The resident worker may be replaced after a confirmed disconnect, context exhaustion, or bounded watchdog decision. Replacement must resume from the latest GitHub checkpoint on the same governed task/PR; it must never create a replacement PR merely because a session changed.

## Definition of done

A governed item is complete only when its Work Order acceptance criteria are satisfied, required verification/dogfooding is evidenced, Architect review is satisfied, the actual Git merge exists, and the roadmap/machine state are reconciled to that merge.

A worker returning `WAITING_FOR_ARCHITECT` means the implementation checkpoint is review-ready, not that the Work Item is complete.

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
same governed PR
 ↓
latest committed head
 ↓
latest Architect review packet
 ↓
exact-head verification
 ↓
merge
 ↓
reconcile
```

Never ask a subsequent agent to reconstruct progress from chat or an expired provider session.

## Watchdog / escalation

No new commit does not by itself prove a hang. Confirm whether the worker is actively executing, waiting for Architect review, waiting for capacity, or blocked by an authority contradiction before restarting a session.

Bounded restarts are permitted only from durable checkpoints. Repeated identical restart/failure conditions must escalate rather than loop.
