# WORK-068 — Feedback → Governed Work Items

Status: planned.

Issued by: the research-driven v1.1 evolution (the continuous product
validation roadmap). This Work Order establishes the feedback-to-governed-
work-item conversion model — it does NOT implement runtime code. Activation
requires the architect's authorization and is recorded in
`spec/development-state/program-state.json` (this change records none).

Dependencies: WORK-067 (Engineering Signal & Regression Correlation — the
advisory signal source this Work Order converts into governed work). Existing
authority consumed: `/work-items` (the ONE Work Item authority, established
in v1.0; this Work Order feeds it, never duplicates it).

Downstream: WORK-069 (Progressive Release & Runtime Validation) and
WORK-070 (Continuous Architecture Fitness) consume the governed Work Items
this Work Order produces.

## Objective

Convert validated engineering signals into governed engineering work —
WITHOUT creating a second Work Item model, a second planning authority, or a
parallel work-intake that competes with the existing `/work-items`
authority.

The existing Work Item authority remains authoritative. This Work Order is
the CONVERSION LAYER that turns advisory signals into proposed Work Items
which then enter the existing `/work-items` authority through its existing
intake.

## The canonical flow

```text
Engineering Signal (WORK-067 — advisory, provenance-bound)
    ↓
assessment (severity, scope, blast radius)
    ↓
deduplication (against existing open Work Items)
    ↓
priority (relative to the existing backlog)
    ↓
Work Item (through the EXISTING /work-items authority —
          never a parallel intake)
    ↓
the existing governance lifecycle (architecture checkpoint,
agent execution, verification, architect review, merge)
```

## Explicit prohibitions

WORK-068 must NEVER become:

- a **second Work Item authority** — the existing `/work-items` authority
  remains the ONE Work Item authority; this Work Order produces PROPOSED
  Work Items that enter through the existing intake;
- a **second planning authority** — the existing continuous development
  planner (WORK-040) remains the ONE planning authority; this Work Order
  feeds it, never replaces it;
- a **second workflow authority** — Work Item lifecycle transitions stay
  in `/workflows`;
- a **silent autonomous Work Item creator** — any conversion is a governed
  decision (the same stop-condition discipline as WORK-046/062/066); a
  signal does not automatically become a Work Item without assessment;
- a **code-mutation authority** — Work Items this Work Order proposes still
  go through the full governance lifecycle before any code change.

## Required invariants

1. The existing `/work-items` authority remains the ONE Work Item authority.
2. A signal becomes a proposed Work Item through assessment, deduplication,
   and priority — never through silent autonomous creation.
3. Each proposed Work Item preserves provenance to its originating signal.
4. A proposed Work Item enters the existing `/work-items` intake; it does
   not bypass the intake.
5. The existing continuous development planner (WORK-040) remains the ONE
   planning authority; this Work Order feeds it, never replaces it.
6. A proposed Work Item still goes through the full governance lifecycle
   (architecture checkpoint, agent execution, verification, architect
   review, merge) before any code change.

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **no second work-item authority** — a proposed Work Item enters the
   existing `/work-items` intake (static architecture invariant + runtime
   discrimination);
2. **no silent autonomous creation** — a signal does not automatically
   become a Work Item without assessment (discrimination-proven);
3. **provenance preservation** — each proposed Work Item records its
   originating signal(s) (no free-floating proposals);
4. **deduplication** — a signal that duplicates an existing open Work Item
   is deduplicated, not converted into a second Work Item;
5. **no workflow bypass** — a proposed Work Item goes through the full
   governance lifecycle before any code change (no shortcut);
6. **mutation/discrimination** — removing the no-second-authority boundary,
  the provenance binding, or the no-silent-autonomous-creation rule makes
  the corresponding test FAIL.

## Scope

Allowed: the feedback-to-governed-Work-Item conversion model (assessment,
deduplication, priority, provenance); the contract that the existing
`/work-items` authority remains authoritative; the required proofs above.

Forbidden: the signal correlation model (WORK-067), the progressive release
(WORK-069), the architecture fitness model (WORK-070), the existing
`/work-items` authority, the existing planning authority (WORK-040), the
existing workflow authority. Forbidden for THIS change: any runtime code at
all (this task delivers the Work Order only).

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - spec/architecture/v1.1/
      - spec/development-state/dependency-state.json
    reason: the v1.1 evolution package — concurrent authors must coordinate.
  - migrations: []   # no schema migration in this Work Order
  - authorities:
      - /work-items   # the ONE Work Item authority — consumed, never duplicated
      - /workflows    # the ONE workflow authority — consumed, never duplicated
    reason: the Work Order CONSUMES these authorities; it must not duplicate
      them.
  - dependencies:
      - WORK-067   # the advisory signal source this Work Order converts
    reason: WORK-067 must be complete before its signals can be honestly
      converted into governed Work Items.
protectedSurfaces:
  - spec/architecture/v1.1/dogfooding-model.md
  - spec/work-orders/WORK-068.md
```

An Architect LLM may mechanically determine the state of WORK-068 as:
`READY` when WORK-067 is complete; `BLOCKED` while WORK-067 is
unimplemented; `PARALLEL-SAFE` with WORK-053..061, WORK-064..066, WORK-069..070
(different surfaces); `CONFLICTING` with any future Work Order that authors
a second Work Item, planning, or workflow authority.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second Work Item, planning, or workflow authority;
- silent autonomous Work Item creation without assessment;
- a Work Item that bypasses the existing `/work-items` intake;
- changing the frozen v1.0 architecture version.

## Definition of done

- The feedback-to-governed-Work-Item conversion model is persisted in
  `spec/architecture/v1.1/dogfooding-model.md`.
- All required invariants hold with objective evidence (the required proofs
  above, including mutation/discrimination tests).
- Static architecture invariants for the no-second-authority matrix pass.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-068 scope; independent Architect Review approves;
  WORK-068 is marked VERIFIED before WORK-069/070 become eligible on it.
