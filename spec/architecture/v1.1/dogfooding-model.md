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
authentication path is functional (WORK-074, Identity & Access Runtime
Activation — the runtime implementation of WORK-063's spec; WORK-063
itself is the SPEC-ONLY architecture decision merged as `8dac9c4` via
PR #81 — see §8 and §8.1 for the gate and the spec/runtime separation).
The demo API key is NOT the permanent customer
login mechanism and must not be encoded into the ValidationJourney
contract as if it were.

The dogfood run exercises:

```text
authentication (WORK-074 — the runtime implementation of WORK-063's spec;
                human login + scoped machine identity; the demo key is retired)
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

> **2026-08-30 update (the customer dogfooding experiment's governed
> follow-up):** the dogfooding experiment was ATTEMPTED on 2026-08-30 and
> STOPPED at onboarding. The empirical findings are persisted in
> `spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`.
> The gate below is updated to distinguish WORK-063 (the SPEC, already merged
> complete) from WORK-074 (the RUNTIME ACTIVATION — the "WORK-063-RUNTIME" of
> the experiment's design; the runtime implementation of WORK-063's spec), and
> to add WORK-071 (the local development runtime substrate). The repository no
> longer implies that merely merging WORK-063's architecture specification
> means real authentication exists.

The first official dogfood run is gated on:

1. **WORK-074 (Identity & Access Runtime Activation — the runtime
   implementation of WORK-063's spec) is complete and merged** — SATISFIED
   (2026-08-31, the WORK-074 post-merge finalization): WORK-074 was merged by
   the architect as `cdedd0ca3c72821d289d8d9d683f9902ddca480f` via PR #99
   (squash-merged at the approved head `25512f4`; finalized per
   §34.8/ADR-0007) — the normal authentication path is functional:
   Google/GitHub/email login, server-side sessions, scoped machine identity;
   the demo key is retired from the customer login path. WORK-063 (the SPEC)
   is already merged complete as `8dac9c4` via PR #81 (spec-only, finalized
   §34.8/ADR-0007) — the spec merge is NOT the runtime; the gate references
   the RUNTIME Work Order (WORK-074), not the spec (WORK-063). The dogfooding
   experiment had confirmed the gap empirically (finding F-1: the LoginPage
   exposed ONLY an API-key input; there was NO Google/GitHub/email login
   surface). WORK-063 remains complete = the architecture/specification
   identity; WORK-074 is complete = the runtime implementation — the two
   identities are NOT collapsed.
2. **WORK-071 (Local Development Runtime Substrate) is complete, OR an
   equivalent supported runtime environment is available** — SATISFIED
   (2026-08-31): WORK-071 was merged as
   `8604c8a5286b7533caf907c25fcd4dfdeeb662eb` via PR #96 (the explicit
   `WORKFLOWOS_DEV_RUNTIME=pglite` dev path — a real customer can run the
   application locally against real authorities without an externally hosted
   PostgreSQL). The dogfooding experiment had confirmed the gap empirically
   (finding F-2: the composition root left `database` undefined when
   `DATABASE_URL` was absent; there was no local fallback; a PGlite
   `DatabaseClient` adapter already existed but the production composition
   did not wire it for a dev path).
3. WORK-064 (Continuous Product Validation) is implemented and merged
   (the ValidationJourney/EffectPolicy model is in force) — SATISFIED:
   COMPLETE (merged as `c351451` via PR #86 and finalized §34.8/ADR-0007
   on 2026-08-30; the domain/model authority is on main; this item governs
   the browser-validation portion of the dogfood run);
4. WORK-065 (Synthetic Browser Validation Agent) is implemented and
   merged (the execution mechanism exists) — for the browser-validation
   portion;
5. the existing v1.0 authorities are operational (the dogfood run
   exercises the real authorities, not mocks).

Until these are in place, the dogfood run is staged: the customer
journeys that do not require authentication (public read paths) can run
in PRE_MERGE; the authenticated journeys were FORBIDDEN until WORK-074
landed (the runtime identity layer specified by WORK-063 was UNIMPLEMENTED
without it). **Live state (2026-08-31, the WORK-074 post-merge
finalization):** gate items 1 and 2 are SATISFIED (WORK-074 merged `cdedd0ca`
via PR #99 and finalized §34.8/ADR-0007; WORK-071 merged `8604c8a` via
PR #96) — the first full authenticated/local dogfooding experiment is
PERMITTED and NOT started (the architect's authorization governs the run;
the browser-validation portion remains gated on item 4 — WORK-065..070,
PLANNED, NOT activated).

The repository records that this is the canonical acceptance journey
for WorkflowOS-as-a-product. A fresh Architect LLM resuming the program
must treat the dogfood run as the integration acceptance gate, and must
NOT confuse WORK-063's merged spec with the runtime identity layer
(WORK-074) the gate actually requires.

### 8.1 The dogfooding gate is the spec/runtime separation (the invariant)

The gate's authentication precondition (item 1) references WORK-074, NOT
WORK-063. This is the load-bearing distinction: WORK-063 is the architecture
decision (the identity model — merged complete as the spec); WORK-074 is the
runtime implementation (the authentication code, the provider adapters, the
session lifecycle, the service-account issuance, the Workbench migration off
the demo key). A release of WorkflowOS is NOT honestly complete because
WORK-063's spec merged; it is honestly complete only when WORK-074's runtime
is implemented, proven, and merged — AND WORK-071's local-runtime path (or an
equivalent supported runtime) lets the dogfood run actually exercise the
application locally.

The dogfooding experiment's governed follow-up Work Orders (WORK-071,
WORK-072, WORK-073, WORK-074) were issued PLANNED, NOT activated — the
architect's authorization was required. **Live state (2026-08-31):** the two
dogfooding-gate enablers are COMPLETE (WORK-074 merged `cdedd0ca` via PR #99
and finalized §34.8/ADR-0007; WORK-071 merged `8604c8a` via PR #96) — the
gate's authentication + local-runtime edges are SATISFIED and the first full
authenticated/local dogfooding experiment is PERMITTED and NOT started;
WORK-072 (Authentication State Synchronization) and WORK-073 (Create Project
Organization Selection) remain PLANNED, NOT activated, NOT started — the
architect's authorization is required. They are independent frontend
product-defect fixes (findings F-3 and F-4) that do NOT gate the
dogfood run, but they remove P2 UX defects a real customer would encounter.
See `spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`
for the full experiment record and the finding→Work-Order mapping.
