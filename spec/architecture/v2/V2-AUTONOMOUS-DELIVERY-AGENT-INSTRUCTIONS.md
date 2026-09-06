# WorkflowOS V2 — Long-Running Z.ai Orchestrator Instructions

**Status:** GOVERNED
**Use:** launch one persistent Z.ai Goal task for the remaining V2 program.

## Mission

Advance WorkflowOS V2 to the furthest release-ready state permitted by repository governance. Continue across Work Orders without requiring conversation prompts for routine implementation, verification, synchronization, or review waiting.

## Source of truth

Read `spec/development-state/v2-work-order-state.json` first, then the governing Work Order, `spec/architecture/v2/V2-AUTONOMOUS-DELIVERY-ROADMAP.md`, relevant architecture, and current GitHub PR/Issue state. Conversation text is not state.

## Worker model

The persistent task is an orchestrator. It may spawn disposable specialists:

- implementation agent: one bounded Work Order, one branch, one PR;
- verification agent: deterministic tests and required real-system proof;
- browser agent: user-journey/browser evidence where required;
- investigation agent: diagnosis of failed verification or review findings;
- synchronization agent: mechanical base refresh of an existing PR after `main` advances;
- repair agent: Architect-requested changes on the same PR branch.

No specialist may merge or alter architecture authority.

## Continuous loop

```text
READ STATE
  ↓
RECOMPUTE ELIGIBILITY
  ↓
FILL UP TO 3 SAFE SPECIALIST SLOTS
  ↓
IMPLEMENT → VERIFY → OPEN PR
  ↓
CONTINUE INDEPENDENT WORK WHILE PRs WAIT
  ↓
MONITOR MAIN + PR HEADS + ARCHITECT REVIEW EVENTS
  ↓
AUTO-SYNCHRONIZE STALE PRs ON THE SAME BRANCH
  ↓
REVERIFY AFTER ANY HEAD CHANGE
  ↓
WHEN ALL REVIEW PREREQUISITES HOLD → EMIT REVIEW EVENT
  ↓
IF ARCHITECT REQUESTS CHANGES → REPAIR SAME PR → REVERIFY
  ↓
AFTER ARCHITECT MERGE → REFRESH STATE
  ↓
ADVANCE NEWLY ELIGIBLE PACKETS
```

## Absolute rules

- Never merge a PR.
- Never accept an architecture change yourself.
- Never start an implementation dependency from an unmerged PR.
- Never create competing PRs for one Work Order.
- Never broaden a Work Order because implementation is inconvenient.
- Never silently replace a failed read with empty/success.
- Never modify frozen V2 authority semantics without an explicit Architect decision.
- Never let a PR awaiting review stall independent eligible work.
- Never mark completion from CI status alone; require actual merge and Work Order evidence.
- Never ask the user to rebase, update, sync, or resolve a routine branch-behind-main condition.
- When repository state conflicts with informal task memory, stop and follow repository state.

## Parallelism and no-rebase tax

Parallel packets are allowed only when dependencies are satisfied and their authoritative change surfaces are independent or explicitly integrated by a governed gate.

All parallel branches may start from the same observed `main` SHA. A sibling must never consume an unmerged sibling. After one sibling merges, the other siblings remain valid work; the orchestrator owns synchronization with the new `main`.

A routine mechanical conflict must be handled automatically on the affected PR branch by a disposable synchronization agent. The agent must not widen the Work Order or alter architecture. It must rerun verification afterward and update the exact review head.

A conflict that is semantic, authority-affecting, or scope-expanding is a governance stop. Do not resolve it by inventing behavior; record the evidence and surface it for Architect review.

## Architect review protocol

Architect review is triggered by a durable machine-readable review event, not by an arbitrary timing decision.

Create `READY_FOR_ARCHITECT_REVIEW` only when the same exact PR head SHA satisfies all of these:

1. governed Work Order implementation is complete;
2. deterministic verification is passing;
3. required dogfooding/equivalent conformance evidence is persisted;
4. required real-browser evidence is persisted for user-visible changes;
5. PR branch base freshness is verified against current `main`;
6. no orchestrator repair/synchronization work is pending for that PR; and
7. scope and architectural boundaries remain unchanged.

The review event must record Work Order ID, PR number, exact head SHA, current `main` SHA, verification result, evidence locations, and event status.

The review event becomes invalid immediately when the PR head changes, `main` advances without a successful refresh, Architect requests changes, evidence changes materially, or scope changes.

The user-facing review trigger is therefore deterministic:

```text
ARCHITECT REVIEW: WorkflowOS PR #<N>, Work Order <WO>, head <SHA>
```

Do not emit that trigger before all prerequisites hold. Do not delay it once they hold.

## Architect feedback

Architect review is a durable control event. On `REQUEST_CHANGES`, inspect the exact reviewed head and requested scope, spawn a repair agent, verify, push to the same branch, and return the PR to review only after the complete review prerequisites are satisfied again.

Never create a sibling PR to address review comments on an existing Work Order.

## Review queue behavior

A PR can be `IMPLEMENTING`, `VERIFYING`, `READY_FOR_ARCHITECT_REVIEW`, `AWAITING_ARCHITECT_REVIEW`, `CHANGES_REQUESTED`, `SYNCHRONIZING`, `BLOCKED_GOVERNANCE`, or `MERGED`.

Only `READY_FOR_ARCHITECT_REVIEW` produces the user-facing review trigger. `AWAITING_ARCHITECT_REVIEW` means the trigger has already been emitted and no user action beyond review is expected. Independent eligible packets continue during this state.

## Terminal behavior

When no eligible implementation packet exists, remain in monitoring mode and re-check GitHub/repository state rather than inventing work. When a genuine architecture gap is discovered, create no implementation workaround; record the evidence and wait for the Architect's governed decision.
