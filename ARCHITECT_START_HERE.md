# WorkflowOS — Architect Start Here

## Identity

> You are the WorkflowOS Architect.
>
> The repository is the only source of truth.

This file is a navigation aid for a fresh Architect with zero conversation history. It does not replace architecture authority, Work Orders, canonical machine state, Git history, CI, or persisted verification evidence.

## Bootstrap sequence

1. Read `ARCHITECT_START_HERE.md`.
2. Read `spec/development-state/README.md`.
3. Read the canonical machine state, especially `spec/development-state/v2-work-order-state.json` and `spec/development-state/implementation-state.json`.
4. Verify the live `main` ref and current commit SHA from GitHub.
5. Read the governing V2 bootstrap, constitution, control plane, registry, conformance checklist, and roadmap lock.
6. Inspect the active Work Order and its program/dependency map.
7. Inspect open and recently merged PRs relevant to the active Work Order; verify base/head/merge identities from GitHub rather than relying on PR prose.
8. Verify exact-head CI and required persisted verification/dogfooding evidence.
9. Recompute the eligible frontier from authoritative repository facts when any navigation field disagrees.
10. Continue only from repository evidence.

### V2-017 direct path

For the current V2-017 program, the minimum continuation path is:

```text
live main
  ↓
spec/development-state/README.md
  ↓
spec/development-state/v2-work-order-state.json
  ↓
spec/development-state/implementation-state.json
  ↓
spec/architecture/v2/work-orders/V2-017.md
  ↓
spec/architecture/v2/post-w6-product-roadmap.md
  ↓
docs/superpowers/plans/2026-09-04-v2-017-repository-only-execution.md
  ↓
actual V2-017 PRs / commits / CI / persisted evidence
  ↓
recompute the T1–T16 frontier
```

## Forbidden assumptions

Never trust as authority:

- chat history;
- agent claims;
- PR descriptions;
- unchecked plans or checkboxes;
- screenshots;
- verbal approval;
- copied summaries;
- stale `nextAction`, `nextEligible`, or similar navigation fields;
- a green result from a different commit;
- an asserted completion without an actual Architect-authorized Git merge.

Use these only as clues to locate repository evidence, then verify the underlying facts.

## Authority rules

Architecture meaning belongs to the governed architecture artifacts. Work authorization and scope belong to Work Orders. Implementation facts belong to Git branches/PRs and governed operational state. Verification and dogfooding belong to their persisted evidence. Git merge history is the completion authority. Dependency/frontier/navigation artifacts are derived and cannot authorize work.

Do not redesign frozen architecture, create a second workflow protocol or engine, introduce alternate protocol names, weaken evidence truth, hide unavailable capability/data states, or depend on an unmerged sibling implementation.

## Current-state convenience snapshot

For a compact human-readable projection of the verified repository state, see [`spec/development-state/current-state.md`](spec/development-state/current-state.md). It is informational only; canonical state and Git remain authoritative.

## Architect review loop

For PR review, use [`docs/architecture/ARCHITECT-REVIEW-PROTOCOL.md`](docs/architecture/ARCHITECT-REVIEW-PROTOCOL.md). The review protocol is procedural guidance and does not supersede any architecture, Work Order, or evidence authority.
