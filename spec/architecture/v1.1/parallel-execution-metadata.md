# WorkflowOS v1.1 — Parallel-Execution Metadata Model

Status: proposed. This document persists the parallel-execution metadata
model for Work Orders. It is the design-time authority for the
metadata; the runtime parallel-eligibility engine (already partially
implemented in WORK-052's
`backend/src/development-governance/internal/default-development-governance-service.ts`)
extends to consume this metadata when the v1.1 evolution Work Orders are
implemented.

## 1. The principle

> A Work Order may not claim "parallel-safe" without identifying why.

The v1.0 parallel protocol (ADR-0003) already establishes the
parallel-implementation rules: one Work Item per branch/PR; dependency
eligibility; conflict detection; scope integrity; centralized decisions;
merge gate. The v1.1 evolution EXTENDS this with explicit
parallel-execution metadata on each Work Order, so an Architect LLM can
mechanically determine:

```text
READY         — all dependencies complete; no uncoordinated conflicts;
                the Work Order may be activated.
BLOCKED       — one or more dependencies are not complete; or an
                uncoordinated conflict exists.
PARALLEL-SAFE — READY and no shared protected surfaces with any other
                active Work Order.
CONFLICTING   — READY but shares protected surfaces with another active
                Work Order; coordination required (mutual coordination
                records, per ADR-0003).
```

## 2. The metadata structure

Each future Work Order (WORK-053..070 and any future ones) carries a
`parallel-execution metadata` section:

```yaml
parallelEligibility: allowed | prohibited | conditional
parallelConflicts:
  - surfaces:
      - <a protected spec/source/migration/authority surface>
    reason: <why this surface is a conflict surface>
  - migrations: [<migration numbers this Work Order reserves>]
  - authorities:
      - <an existing authority this Work Order consumes or authors>
    reason: <why this authority is a conflict surface>
  - dependencies:
      - <a Work Order ID this Work Order depends on>
    reason: <why this dependency is a conflict surface>
protectedSurfaces:
  - <a spec/source/migration/authority surface this Work Order owns>
```

### parallelEligibility

- `allowed` — the Work Order may run in parallel with any other
  PARALLEL-SAFE Work Order (rare; reserved for genuinely independent
  surfaces);
- `prohibited` — the Work Order must run alone (e.g., it touches the
  governing architecture lock, the canonical state files, or a uniquely
  shared surface);
- `conditional` — the Work Order may run in parallel subject to
  conditions (the common case; the conditions are the
  `parallelConflicts`).

### parallelConflicts

A list of conflict surfaces, each with a reason:

- `surfaces` — spec/source/migration/authority surfaces this Work Order
  touches; concurrent Work Orders touching the same surface must
  coordinate;
- `migrations` — schema migration numbers this Work Order reserves
  (per ADR-0003's migration-numbering reservation);
- `authorities` — existing authorities this Work Order consumes or
  authors; concurrent Work Orders authoring the same authority conflict;
- `dependencies` — Work Order IDs this Work Order depends on; the
  dependency is a conflict surface (the dependency's protected surfaces
  are transitively conflict surfaces for this Work Order).

### protectedSurfaces

A list of spec/source/migration/authority surfaces this Work Order
OWNS. Concurrent Work Orders that touch a protected surface of this
Work Order conflict with this Work Order.

## 3. The mechanical determination

An Architect LLM may mechanically determine the state of a Work Order
by:

1. **dependency check** — for each declared dependency, is the dependency
   `complete`? If not, the Work Order is `BLOCKED` (the dependency is
   the blocker);
2. **conflict check** — for each declared `parallelConflicts.surfaces`
   and `protectedSurfaces`, is any other active Work Order touching the
   same surface? If yes, the Work Order is `CONFLICTING` (coordination
   required);
3. **eligibility** — if all dependencies are `complete` and no
   uncoordinated conflicts exist, the Work Order is `READY`;
4. **parallelism** — if `READY` and no shared protected surfaces with
   any other active Work Order, the Work Order is `PARALLEL-SAFE`;
   otherwise `CONFLICTING` (coordination required).

## 4. The existing v1.0 parallel-eligibility engine (preserved)

The v1.0 parallel-eligibility engine (in
`backend/src/development-governance/internal/default-development-governance-service.ts`
→ `evaluateParallelEligibility`) already computes:

- `dependencyEligible` (all dependencies complete);
- `unsatisfiedDependencies` (the incomplete dependencies);
- `conflictsWith` (other active Work Orders sharing declared surfaces);
- `coordinated` (mutual coordination records per ADR-0003).

The v1.1 parallel-execution metadata EXTENDS this engine by:

- making the conflict surfaces EXPLICIT in each Work Order (rather than
  inferred from the `surfaces` field in program-state.json);
- adding the `parallelEligibility` declaration (allowed/prohibited/
  conditional) so the engine can short-circuit;
- adding the `protectedSurfaces` declaration so concurrent Work Orders
  can detect conflicts against this Work Order's owned surfaces.

The engine's existing logic (dependency check, conflict detection,
mutual coordination) is preserved. The metadata is additive.

## 5. The relationship to ADR-0003 (Parallel Protocol Surface Declaration)

ADR-0003 established the parallel protocol: each Work Order declares
its surfaces; concurrent Work Orders with overlapping surfaces must
coordinate (mutual coordination records). The v1.1 parallel-execution
metadata is the STRUCTURED FORM of the same principle:

- `surfaces` (in program-state.json) → `parallelConflicts.surfaces`
  (in the Work Order spec file) — the same information, more explicit;
- `coordination` (in program-state.json) → the mutual coordination
  records (preserved, unchanged);
- NEW: `parallelEligibility` — the explicit allowed/prohibited/
  conditional declaration;
- NEW: `protectedSurfaces` — the surfaces this Work Order owns (so
  concurrent Work Orders can detect conflicts against this Work Order,
  not just against shared surfaces).

## 6. The discrimination rule

A Work Order that claims `parallelEligibility: allowed` without
identifying why (no `parallelConflicts`, no `protectedSurfaces`) is
INVALID metadata. The architect must reject it. The rule:

> A Work Order may not claim "parallel-safe" without identifying why.

Concretely:

- `allowed` requires an empty `parallelConflicts` list AND an empty
  `protectedSurfaces` list (the Work Order genuinely touches no shared
  surface — rare);
- `prohibited` requires a `parallelConflicts` entry whose `surfaces`
  include a uniquely shared surface (e.g., the governing architecture
  lock, the canonical state files);
- `conditional` requires a non-empty `parallelConflicts` list with
  explicit surfaces/migrations/authorities/dependencies and reasons.

This rule is enforced at architect review time (the architect reads the
Work Order spec file and verifies the metadata). A future runtime
implementation may add a static check.

## 7. The runtime engine (NOT implemented in this task)

The runtime engine that consumes the parallel-execution metadata will
be extended under WORK-052's evolution (or a future Work Order) when
the v1.1 evolution Work Orders are implemented. Until then:

- the v1.0 parallel-eligibility engine governs (it reads `surfaces` and
  `coordination` from program-state.json);
- the v1.1 parallel-execution metadata in this document and in the
  Work Order spec files is design-time proposed state;
- no runtime code consumes the new metadata.

This task does NOT implement the runtime engine. It persists the model
and the metadata in the Work Order spec files.
