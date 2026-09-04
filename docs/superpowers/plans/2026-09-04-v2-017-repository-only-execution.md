# V2-017 Repository-Only Execution Contract

## Purpose

This document is a durable execution companion for `V2-017 — Universal Product UX`. It exists so a fresh implementation agent can execute, recover, and hand off V2-017 with **zero dependence on conversational history**.

Conversation, chat summaries, verbal instructions, agent-generated summaries, pasted reports, and unstored assumptions are not sources of truth for V2-017.

## Repository authority hierarchy

When information conflicts, resolve it in this order:

1. actual Git history and current `main`;
2. `spec/development-state/` canonical machine state and its authority declaration;
3. `spec/architecture/v2/work-orders/V2-017.md`;
4. `spec/architecture/v2/architecture-change-requests/V2-ACR-003-post-w6-universal-product-ux.md`;
5. `spec/architecture/v2/post-w6-product-roadmap.md`;
6. `docs/superpowers/specs/2026-09-03-workflowos-universal-ux-design.md`;
7. this execution contract and the detailed implementation plan at `docs/superpowers/plans/2026-09-03-v2-017-universal-product-ux.md`;
8. relevant existing implementation, tests, CI results, PR discussion, and persisted dogfooding evidence.

GitHub PR descriptions/comments are evidence and navigation aids, not substitutes for the frozen architecture, Work Order, canonical state, or actual Git history.

## Mandatory bootstrap for every fresh agent

Before changing code, the agent must:

1. read `spec/architecture/v2/fresh-architect-bootstrap.md`;
2. read `spec/development-state/README.md` and the V2 canonical state artifact referenced by `spec/architecture/v2/README.md`;
3. read `spec/architecture/v2/V2-CTRL-000-implementation-authorization.md`, `architecture-constitution.md`, `V2-CTRL-003-protocol-registry.md/.json`, `execution-control-plane.md`, `V2-CTRL-001-conformance-checklist.md`, `V2-CTRL-002-roadmap-lock.md`, and `dogfooding-protocol.md`;
4. read `V2-ACR-003`, `V2-017.md`, `post-w6-product-roadmap.md`, and the approved UX design;
5. inspect the current GitHub `main` commit and the relevant open/merged V2-017 PRs;
6. determine the next eligible task **from repository state**, not from a conversation, memory, stale checkbox, copied summary, or PR prose;
7. verify that every declared dependency is complete with authoritative Git merge evidence and that no unmerged sibling branch is being used as a dependency.

If any artifact is missing, contradictory, stale, or unverifiable, stop and resolve the repository governance state before implementation.

## Task-entry contract

Every V2-017 task begins from the current eligible `main` revision unless its Work Order explicitly declares another stable base.

Before implementation, record in the task branch/PR:

- task identifier from the program map;
- governing Work Order and ACR;
- exact base SHA;
- completed dependency merge identities;
- approved change surface;
- required verification and dogfooding;
- explicit scope exclusions.

A task must never treat another unmerged V2-017 branch as a dependency. If task composition requires functionality that exists only on an unmerged branch, stop and use the declared sequential boundary or a governed integration Work Order.

## Task execution contract

For every implementation task:

1. inspect the actual repository implementation before trusting any report;
2. derive tests from the frozen requirement before implementation;
3. use RED → GREEN for new behavioral regressions where applicable;
4. implement only the declared task surface;
5. run deterministic verification locally;
6. run required real-system/browser verification;
7. persist honest evidence in the repository/PR;
8. create a normal append-only commit history;
9. re-check the diff against the task scope;
10. submit the PR for Architect review;
11. do not merge until the Architect gate is satisfied;
12. use the actual Git merge as the completion fact;
13. reconcile canonical state from authoritative Git evidence after merge.

## Recovery / handoff contract

An interrupted agent must resume by re-reading repository state. It must not ask the next agent to reconstruct progress from the chat.

The durable recovery sequence is:

```text
current main
  ↓
canonical development state
  ↓
V2-017 Work Order
  ↓
V2-017 program map
  ↓
open/merged V2-017 PRs
  ↓
latest relevant commits + CI + persisted dogfooding evidence
  ↓
recompute eligible frontier
  ↓
continue only the eligible task
```

A handoff is complete only when the repository contains enough information for a zero-history agent to continue without this conversation.

## Evidence rules

Evidence must identify exact Git revisions, test commands/results, browser/system journeys, and known limitations. Agent claims such as “fixed”, “passed”, “complete”, or “ready” have no authority unless backed by repository evidence.

Fresh CI is required after the relevant corrected head. A previous head's green result does not prove the corrected head.

A platform-side CI queue stall may be recorded as an external blocker, but it must not be converted into a success claim or bypass the exact-head verification gate.

## Completion rules

The 16 task numbers are execution slices, not independent Work Order identities.

- T1–T14 are bounded implementation slices.
- T15 is final integrated verification and real product dogfooding.
- T16 is the final Architect review/merge gate.
- V2-017 completion is established by the actual Architect-authorized Git merge plus canonical post-merge reconciliation.

The plan checkboxes are a working checklist only. They are not authoritative progress state.

## Scope and authority stop conditions

Stop immediately and raise a governed architecture change if implementation would:

- change WorkflowIR semantics;
- mutate WorkflowVersion semantics or installed-version authority;
- create a second workflow protocol/engine;
- create a second execution, evidence, verification, or approval authority;
- turn marketplace entitlement into execution authority;
- make signatures/digests/attestations equivalent to physical-side-effect proof;
- fabricate state when authoritative reads fail;
- introduce a platform-specific semantic fork;
- hide an unavailable capability;
- depend on an unmerged sibling implementation;
- weaken required regression, freshness, replay, cryptographic, integration, or dogfooding verification;
- make conversational context necessary to determine what to implement next.

## Final handoff invariant

A fresh LLM must be able to answer all of the following using only repository-resident information:

- What architecture governs V2-017?
- What exact Work Order is active?
- What tasks exist and what are their dependencies?
- What is complete, and what Git merge proves it?
- What task is currently eligible?
- What exact base SHA must be used?
- What code and authority surfaces may change?
- What verification and dogfooding are required?
- What facts are uncertain or externally blocked?
- What is the next governed action?

If a question cannot be answered from the repository, the governance package is incomplete and must be repaired before implementation continues.
