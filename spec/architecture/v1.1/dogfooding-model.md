# WorkflowOS v1.1 — Dogfooding & Self-Hosting Model

Status: proposed. This document persists the dogfooding model for
WorkflowOS-as-a-product and WorkflowOS-as-its-own-customer-product. It
is additive to the existing v1.0 self-hosting boundary
(`spec/governance/governance-model.json` → `selfHostingBoundary`) and
the v1.0 self-hosting Work Order (WORK-052). It does not rewrite either.

## 1. The principle

> WorkflowOS must be able to use its own product-development workflow to
> build and maintain a customer product, and it must be able to test that
> product using realistic synthetic-user journeys.

Dogfooding is a permanent WorkflowOS capability, not a demo. The same
control system that governs customer-product development governs
WorkflowOS-as-its-own-customer-product.

## 2. The canonical dogfood flow (customer product)

```text
Customer intent
    ↓
WorkflowOS planning
    ↓
Work Items / Work Orders
    ↓
architecture checkpoint
    ↓
agent execution
    ↓
verification
    ↓
architect review
    ↓
GitHub / release
    ↓
synthetic product validation (WORK-064..070)
    ↓
engineering signals (WORK-067)
    ↓
new governed Work Item (WORK-068)
```

Each stage uses the existing authoritative boundaries. The loop is
connective governance, not a new workflow engine.

## 3. The self-hosting flow (WorkflowOS as the customer product)

The same loop applies when WorkflowOS itself is the customer product:

```text
WorkflowOS repository
    ↓
WorkflowOS architecture
    ↓
WorkflowOS Work Items
    ↓
WorkflowOS agents
    ↓
WorkflowOS verification
    ↓
WorkflowOS architect review
    ↓
WorkflowOS GitHub / release
    ↓
WorkflowOS validation (WORK-064..070, once implemented)
    ↓
WorkflowOS feedback (WORK-067)
    ↓
WorkflowOS evolution (WORK-068 → new Work Items)
```

This is the dogfooding/self-hosting model. The WorkflowOS repository
governs itself through the same authorities it provides to customer
products.

## 4. The dogfood execution policy (operational)

The first official dogfood run begins only after the normal
authentication path is functional (WORK-063, Identity and Access Layer —
proposed in PR #81). The demo API key is NOT the permanent customer
login mechanism and must not be encoded into the ValidationJourney
contract as if it were.

The dogfood run exercises:

```text
authentication (WORK-063 — human login + scoped machine identity)
organization (existing v1.0 authority)
project (existing v1.0 authority)
GitHub connection (existing v1.0 authority)
Vercel connection (existing v1.0 runtime authority)
LLM configuration (existing v1.0 LLM gateway)
agent configuration (existing v1.0 agent authorities)
planning (existing v1.0 continuous development planner)
work orders (existing v1.0 /work-items authority)
execution (existing v1.0 execution authorities)
parallelism (existing v1.0 parallel protocol)
verification (existing v1.0 /verification authority)
review (existing v1.0 /reviews authority)
deployment (existing v1.0 /github + runtime authorities)
browser validation (WORK-064..070, once implemented)
```

This is the canonical acceptance journey for WorkflowOS-as-a-product.
A release of WorkflowOS is not honestly complete until the dogfood run
exercises this journey end-to-end against a real deployment.

## 5. The self-hosting boundary (preserved)

The v1.0 self-hosting boundary (the `selfHostingBoundary` in
`spec/governance/governance-model.json`, code-pinned in
`backend/src/architecture-checkpoints/internal/governance-validation.ts`)
remains in force. The core prohibitions are preserved verbatim:

- silently rewrite its frozen governing architecture — changes require
  the architecture-change/versioning authority;
- introduce a second workflow engine or lifecycle authority;
- introduce a second Work Item authority;
- introduce a second verification or evidence authority;
- introduce a second architecture authority;
- weaken tenant isolation or server-side security invariants;
- weaken concurrency or idempotency guarantees;
- let a self-hosted worker merge its own governing PR — PR review by the
  architect is the only merge gate.

The v1.1 validation sub-evolution adds NO new core prohibitions to this
list (it preserves them all) and adds NO relaxation. The new
invariants (EffectPolicy enforcement, no-silent-healthy, failure→signal
→Work Item) are WORK-064..070 Work Order invariants, not v1.0 frozen
invariants — they become governing only when ACR-002 is approved and
the corresponding Work Orders are implemented and merged.

## 6. The architect's role in dogfooding

The architect (Architect LLM) is the architecture authority, the Work
Order authority, the checkpoint authority, the PR review authority, the
drift detector, and the merge recommendation/authorization authority.
The architect:

- activates Work Orders (the non-delegable activation decision);
- reviews implementation PRs (routine implementation-code review is the
  architect's responsibility, not the human's);
- detects architectural drift (the v1.1 continuous architecture fitness
  loop, WORK-070, feeds the architect's drift detection);
- recommends/authorizes merges (the human approves the consequential
  merges for governing changes).

The human:

- approves ACRs (the non-delegable architecture change decision);
- approves work-order activations (the consequential business decision);
- approves merges for governing changes (the consequential merge
  decision);
- sets product/business direction (the consequential product decisions).

Implementation agents:

- propose changes and evidence;
- cannot exercise architectural or merge authority;
- one Work Item branch/PR at a time;
- bounded workers inside the control system.

Browser/synthetic agents:

- observe and produce evidence;
- never mutate code, merge PRs, approve reviews, or transition workflow
  state;
- validation workers inside the control system.

## 7. The dogfood run as acceptance evidence

A release of WorkflowOS that passes the dogfood run produces acceptance
evidence:

- the authentication path works (a human can sign in; a scoped service
  account can act);
- the planning/execution/verification/review loop works end-to-end;
- the GitHub/Vercel integration works;
- the deployment works;
- the browser validation works (once WORK-064..070 are implemented);
- the feedback→Work Item loop works (once WORK-067/068 are implemented).

A release that does NOT pass the dogfood run is not honestly complete.
The dogfood run is the canonical acceptance journey.

## 8. The first dogfood run (operational policy)

The first official dogfood run is gated on:

1. WORK-063 (Identity and Access Layer) is implemented and merged (the
   normal authentication path is functional; the demo key is retired
   from the customer login path);
2. WORK-064 (Continuous Product Validation) is implemented and merged
   (the ValidationJourney/EffectPolicy model is in force) — SATISFIED:
   COMPLETE (merged as `c351451` via PR #86 and finalized §34.8/ADR-0007
   on 2026-08-30; the domain/model authority is on main);
3. WORK-065 (Synthetic Browser Validation Agent) is implemented and
   merged (the execution mechanism exists);
4. the existing v1.0 authorities are operational (the dogfood run
   exercises the real authorities, not mocks).

Until these are in place, the dogfood run is staged: the customer
journeys that do not require authentication (public read paths) can run
in PRE_MERGE; the authenticated journeys are FORBIDDEN until WORK-063
lands.

The repository records that this is the canonical acceptance journey
for WorkflowOS-as-a-product. A fresh Architect LLM resuming the program
must treat the dogfood run as the integration acceptance gate.
