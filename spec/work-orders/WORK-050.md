# WORK-050 — Unified Execution UX

Status: COMPLETE — merged by the architect as `8f27cc7` (PR #78, squash-merged
at branch head `6c9031c` on 2026-08-29T16:57:01Z; the merge tree is identical
to the approved head). The post-merge finalization §34.8/ADR-0007 is carried by
the v1.1 architecture-package reconciliation (PR #74). Derived from the
architect's authorization; this document is the governing work order.
Architecture: frozen v1.0 authority model (the execution UX is a CONSUMER of
existing authorities, never an authority itself)
Dependencies: WORK-042 (cross-mode execution handoff), WORK-043 (execution
policy / eligibility), WORK-048 (Developer Workbench). Consumes the public
contracts of WORK-044 (adaptive execution routing), WORK-045 (agent roles),
WORK-046 (multi-agent delegation), and WORK-047 (agent intelligence) through
their existing endpoints.

## Objective

The developer experiences native/API execution and external execution as ONE
coherent execution capability from the Work Item perspective. The Work Item's
unified execution section answers, without navigating unrelated subsystems:

```text
What execution is happening?            Why does that execution path exist?
What provider/model/agent is involved?  What constraints apply?
What does WORK-044 routing recommend?   What does WORK-047 intelligence recommend?
What was actually selected?             What is the authoritative execution state?
What is the external handoff state?     What is the verification state?
What happens next?
```

Native and external execution render from the SAME authoritative execution
model (the existing ExecutionRecord contract). The unified view is a read-model
presentation; every displayed fact comes from a backend authority's own
response.

## The non-negotiable authority model

The existing backend authorities remain authoritative, in this order:

```text
Eligibility → Routing → Agent Intelligence → Delegation → Execution → Verification → Review
```

The frontend CONSUMES those authorities. It must NOT recreate them:

```text
WORK-044 routing recommendation      ≠ execution decision
WORK-047 intelligence recommendation ≠ execution decision
```

A recommendation becomes reality only when an authoritative execution
operation/record says so. The unified view keeps `Recommended` and `Actually
selected` VISIBLY distinct (advisory framing for recommendations; the
execution record's own provider/model/mode for the selection); visual styling
must never imply that "recommended" means "selected".

The frontend must NOT create:

- a frontend execution state machine (state comes from the execution records);
- a provider-selection engine (selection happens only at the authoritative
  execution boundary);
- an eligibility/routing engine (scores and eligibility are the backend's);
- an intelligence/ranking engine (WORK-047's logic is never duplicated);
- a delegation authority or delegation graph/state machine (delegation state
  comes from the delegation records);
- a second handoff authority or handoff ledger (handoff state comes from the
  existing WORK-042 records);
- a second execution store, workflow store, or verification store.

## Native/external parity

Native and external execution are represented through the EXISTING execution
model. No separate external workflow, no external-only lifecycle state, no
second handoff authority, no new provider-selection mechanism. The WORK-042
cross-mode handoff contract is reused: ONE logical execution, ONE
ExecutionRecord, with the append-only handoff log row as the transition
evidence. The Work Item sees one execution model regardless of execution mode.

## Read/write boundaries

- Reuse existing backend operations wherever possible (§ below: the only new
  backend surface is TWO read-only GET endpoints that expose facts the
  frontend could not otherwise reach — the cross-mode handoff record and the
  delegation plan list).
- Any new UX read surface is read-only (GET only; `project.read`;
  server-side project authorization BEFORE any data is queried).
- Any execution mutation goes through the EXISTING authoritative execution
  boundary: `POST /work-items/:workItemId/execution` (start),
  `POST /execution/:executionId/handoff` (external package handoff),
  `POST /execution/:executionId/events` (external result ingestion). The
  unified view itself performs ZERO mutations and renders no new mutation
  triggers; the existing mutation components (Start Implementation /
  External Handoff dialogs) are reused unchanged.
- The frontend never selects a provider directly (the provider identity shown
  as selected comes ONLY from execution records), never creates execution
  state locally, never transitions workflow state directly, never fabricates
  handoff state, never decides verification state.

## Governing contracts (the architect's authorization, verbatim intent)

- **New backend reads (READ-ONLY, the only backend surface)**:
  `GET /execution/:executionId/cross-mode-handoff` (the WORK-042 handoff log
  row for an execution — `{handoff: null}` when none; 503 when the cross-mode
  service is unwired, mirroring the existing POST; project.read against the
  execution's own project, resolved server-side) and
  `GET /projects/:projectId/work-items/:workItemId/delegation-plans` (the
  WORK-046 plans with units for a Work Item; project.read + the work-item-in-
  project guard, mirroring the existing GET-by-planKey). No new tables, no
  migration (the last stays `0057`), no new route FILES (both endpoints extend
  their owning modules' existing route files).
- **Consumed authorities (existing endpoints, unchanged)**: the execution
  records (`GET /work-items/:workItemId/executions`, `GET /execution/:id`),
  the WORK-044 routing recommendation (`GET …/execution/routing/recommendation`
  — advisory), the WORK-047 intelligence recommendation (`GET …/agent-
  intelligence/execution` — advisory), the WORK-043 policy recommendation
  (`GET …/execution/recommendation` — the constraints/eligibility facts), the
  workflow authority (`GET …/workflow`, `GET …/workflow/merge-readiness`),
  and the verification authority (`GET …/verification-runs`).
- **Failure semantics (the WORK-048 lesson, all the way through)**: every
  contributing read keeps `loading` / `success(data)` / `error` distinct — for
  the execution, routing, intelligence, constraints, handoff, delegation, and
  verification surfaces. A failed authority read NEVER becomes "No execution /
  No provider / No handoff / No verification" unless the authority actually
  answered empty; an unavailable authority renders an explicit
  unavailable/error state (with the surface named).
- **Tenant/authorization safety**: all execution information is
  project-scoped and server-authorized. Unauthorized project execution data
  is inaccessible; one project's execution cannot appear in another project's
  Work Item; stale URL identifiers cannot bypass authorization (the routes
  resolve the project server-side through the authoritative chains);
  unavailable project data does not become a fabricated empty execution state.

## The UX model (the Work Item's unified execution section)

```text
Execution
──────────────────────────
Current state          Provider / model / mode
Agent role             Why this route
Constraints            Recommendation
Handoff                Verification
Next action
```

`Recommended`, `Selected`, `Running`, `Completed`, `Failed` are visually and
semantically distinct; statuses are the authorities' own values rendered
verbatim. Agent intelligence displays as ADVISORY evidence ("Agent
Intelligence recommends: … Why: … Historical evidence: …") beside — never
merged into — the authoritative "Actually selected: …" block. The routing
authority's recommendation explains eligible count, recommendation,
exclusions, and methodology (the backend's own explanation fields; never
recomputed). Where multiple delegated agents exist, the delegated execution
units render from the existing delegation records (roles, modes, providers,
statuses — the authority's own values); the frontend visualizes authoritative
facts, never a delegation graph of its own. The external/native handoff state
renders from the existing WORK-042 handoff records (fromMode → toMode, reason,
the resulting status) — only when authoritative.

## Adversarial verification matrix (all required)

1. Recommendation ≠ selection (a recommendation renders as advisory even when
   an execution exists; the selection shown is the record's own).
2. Routing recommendation ≠ execution decision (no execution → nothing is
   "selected"; the recommendation stays advisory).
3. Native and external execution render from the SAME authoritative model.
4. Failed execution reads render explicit errors, not empty state.
5. Failed routing/intelligence reads render explicit errors.
6. Failed handoff reads render explicit errors.
7. Failed verification reads render explicit errors.
8. Stale UI state cannot override fresh server state (fresh responses
   re-derive the view; no cached verdicts).
9. Tenant isolation (a user cannot read another project's execution state).
10. No frontend workflow authority (static).
11. No second execution authority (static).
12. No second handoff authority (static).
13. Provider/model identity comes from authoritative execution records.
14. Completed/failed execution states are not fabricated (statuses verbatim).
15. Repeated refreshes remain deterministic (the pure derivation).

Where persistence/concurrency semantics are involved, prove with real
PostgreSQL (the full regression suite + the browser E2E on real PG).

## Static architecture assertions (WORK-050 describe block)

The frontend has no execution state machine, no provider-selection engine, no
eligibility/routing engine, no intelligence/ranking engine, no delegation
authority, no handoff authority, no direct provider SDK, no direct DB access;
no second execution store; no second workflow store; recommendation fields
are not used as execution-selection authority (the derivation keeps advisory
and actual structurally distinct — the "actually selected" identity is read
ONLY from execution records); the derivation helper is PURE (facts in → view
out; no fetch/state/persistence); the two new backend endpoints are GET-only,
project-authorized reads; the route file set is unchanged (32 files); the
adversarial regression titles pinned; the work-order rules pinned.

## Out of scope (explicitly)

WORK-053+ v1.1 evolution capabilities, Change Programs, architecture fitness,
runtime feedback, adaptive assurance, self-hosting automation, a new execution
engine, a new delegation engine, a new verification engine. WORK-050 is UX
integration over existing authorities.
