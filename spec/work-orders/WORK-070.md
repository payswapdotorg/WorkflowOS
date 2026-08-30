# WORK-070 — Continuous Architecture Fitness

Status: planned.

Issued by: the research-driven v1.1 evolution (the continuous product
validation roadmap). This Work Order establishes the continuous
architecture fitness closed loop — it does NOT implement runtime code.
Activation requires the architect's authorization and is recorded in
`spec/development-state/program-state.json` (this change records none).

Dependencies: WORK-067 (Engineering Signal & Regression Correlation — the
advisory signal source), WORK-069 (Progressive Release & Runtime Validation —
the release/runtime evidence source). Existing authority consumed: the
architecture checkpoint framework (WORK-051 — complete; the existing
checkpoint substrate this Work Order feeds). Soft relationships: WORK-055
(Quality Attributes and Architecture Fitness — planned; the quality-attribute
MODEL this Work Order continuously evaluates), WORK-060 (Continuous
Architecture Evolution and ACR Feedback Loop — planned; the ACR FEEDBACK
LOOP this Work Order's output feeds). WORK-070 is the CLOSED-LOOP SYNTHESIS
that continuously combines WORK-055's fitness observations + WORK-067's
engineering signals + WORK-069's release/runtime evidence → architecture
risk recommendation → ACR (through WORK-060's loop when it lands, through
the existing `/architecture` ACR authority until then).

Downstream: the ACR feedback loop (WORK-060 when it lands; the existing
`/architecture` ACR authority until then) consumes WORK-070's risk
recommendations.

## Objective

Continuously evaluate whether the architecture remains fit — combining
architecture conformance, quality attributes, performance, reliability,
security, dependency trends, technical debt, runtime behavior, and
operational impact into a continuous architecture-risk assessment that
produces an ACR recommendation when the architecture drifts — WITHOUT
mutating frozen architecture directly, WITHOUT becoming a second
architecture authority, and WITHOUT becoming a second verification
authority.

WORK-070 is the closed-loop synthesis of WORK-055 (the model) + WORK-060
(the loop) + WORK-067 (engineering signals) + WORK-069 (release/runtime
evidence). It does NOT replace any of them.

## The fitness inputs

WORK-070 continuously evaluates the architecture against:

```text
architecture conformance    (the existing /architecture authority's
                            assertions + the static architecture suite)
quality attributes          (WORK-055's model, when it lands; until then,
                            the existing assertions)
performance                 (the existing runtime/audit authorities)
reliability                 (the existing runtime/audit authorities)
security                    (the existing security signal intake)
dependency trends           (the existing dependency intelligence)
technical debt              (the existing maintenance/planning authorities)
runtime behavior            (the existing runtime/audit authorities)
operational impact          (WORK-069's release/runtime evidence)
```

Each input is provenance-bound to its source. WORK-070 does not invent
inputs; it consumes them from the existing authorities and the v1.1
evolution Work Orders.

## The fitness output

```text
architecture risk
    ↓
recommendation
    ↓
Architecture Change Request (through WORK-060's ACR feedback loop when
                              it lands; through the existing /architecture
                              ACR authority until then)
```

WORK-070's output is ADVISORY: it produces an architecture-risk recommendation
that feeds the ACR authority. It does not mutate frozen architecture. It
does not approve ACRs. It does not bypass the architect's ACR approval.

## Relationship to WORK-055 and WORK-060

WORK-055 is the planned v1.1 evolution Work Order that establishes the
quality-attribute MODEL and the FITNESS EVALUATION (baselines/targets/
thresholds, fitness observations). WORK-060 is the planned v1.1 evolution
Work Order that establishes the ACR FEEDBACK LOOP (architecture evolution
and ACR feedback). WORK-070 is the CLOSED-LOOP SYNTHESIS that:

- CONSUMES WORK-055's fitness observations when WORK-055 lands;
- until then, performs continuous evaluation directly against the existing
  architecture assertions;
- CONSUMES WORK-067's engineering signals and WORK-069's release/runtime
  evidence;
- PRODUCES architecture-risk recommendations that feed WORK-060's ACR
  feedback loop when WORK-060 lands;
- until then, feeds the existing `/architecture` ACR authority directly.

WORK-070 does NOT duplicate WORK-055's model, WORK-060's loop, WORK-067's
signal intake, or WORK-069's release mechanics. It is the synthesis layer
that combines them.

## Explicit prohibitions

WORK-070 must NEVER become:

- a **second architecture authority** — `/architecture` remains the ONE
  architecture authority; WORK-070 produces risk recommendations, not
  architecture decisions;
- a **frozen-architecture mutator** — WORK-070 cannot mutate frozen v1.0
  architecture; an ACR (through the existing authority) is required for any
  governing change;
- a **second verification authority** — the evidence it consumes is
  provenance-bound to the existing authorities; it does not re-evaluate;
- a **second workflow authority** — architecture-risk recommendations do
  not transition Work Items;
- an **autonomous ACR approver** — ACR approval remains the architect's
  non-delegable decision (per `spec/governance/architect.json`);
- a **silent healthy-state converter** — an architecture drift cannot be
  silently discarded or converted into a false fit state.

## Required invariants

1. `/architecture` remains the ONE architecture authority.
2. WORK-070 cannot mutate frozen v1.0 architecture; an ACR is required for
   any governing change.
3. ACR approval remains the architect's non-delegable decision.
4. Architecture-risk recommendations are advisory; they do not transition
   Work Items or approve ACRs.
5. Every input is provenance-bound to its source (no free-floating inputs).
6. When WORK-055 lands, fitness evaluation is delegated to it (no parallel
   fitness model).
7. When WORK-060 lands, the ACR feedback loop is delegated to it (no
   parallel loop).
8. An architecture drift cannot be silently discarded or converted into a
   false fit state.

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **no second architecture authority** — a risk recommendation does not
   mutate frozen architecture or approve an ACR (static architecture
   invariant + runtime discrimination);
2. **no frozen-architecture mutation** — WORK-070 cannot mutate v1.0
   frozen architecture (discrimination-proven);
3. **advisory status** — a risk recommendation does not transition Work
   Items or approve ACRs;
4. **provenance preservation** — every input records its source (no
   free-floating inputs);
5. **no silent healthy** — an architecture drift cannot be silently
   discarded or converted into a false fit state (mutation/discrimination);
6. **delegation when WORK-055/060 land** — fitness evaluation delegates to
   WORK-055; the ACR loop delegates to WORK-060 (no parallel model/loop);
7. **mutation/discrimination** — removing the no-second-authority boundary,
  the no-frozen-mutation boundary, the provenance binding, or the
  no-silent-healthy rule makes the corresponding test FAIL.

## Scope

Allowed: the continuous architecture fitness closed loop (inputs →
architecture risk → recommendation → ACR authority); the advisory contract;
the required proofs above.

Forbidden: the signal correlation model (WORK-067), the progressive
release (WORK-069), the quality-attribute model (WORK-055, planned), the
ACR feedback loop (WORK-060, planned), the existing `/architecture`
authority, the existing verification/workflow authorities. Forbidden for
THIS change: any runtime code at all (this task delivers the Work Order
only).

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
      - /architecture  # the ONE architecture authority — consumed, never duplicated
      - /verification  # evidence maps into the existing verification authority
      - /work-items    # risk recommendations do not transition Work Items
    reason: the Work Order CONSUMES these authorities; it must not duplicate
      them.
  - dependencies:
      - WORK-067   # the advisory signal source
      - WORK-069   # the release/runtime evidence source
      - WORK-051   # complete — architecture checkpoint framework
      - WORK-055   # soft — quality-attribute model (planned); delegated to when it lands
      - WORK-060   # soft — ACR feedback loop (planned); delegated to when it lands
    reason: WORK-067 and WORK-069 must be complete before the closed loop
      can be honestly exercised; WORK-051 is complete; WORK-055 and
      WORK-060 are soft dependencies (delegated to when they land).
protectedSurfaces:
  - spec/architecture/v1.1/control-system-evolution.md
  - spec/work-orders/WORK-070.md
```

An Architect LLM may mechanically determine the state of WORK-070 as:
`READY` when WORK-067 and WORK-069 are complete (WORK-051 is already
complete; WORK-055 and WORK-060 are soft); `BLOCKED` while WORK-067 or
WORK-069 is unimplemented; `PARALLEL-SAFE` with WORK-053..061, WORK-064..068
(different surfaces); `CONFLICTING` with any future Work Order that authors
a second architecture, verification, or workflow authority.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second architecture, verification, or workflow authority;
- frozen-architecture mutation without an ACR;
- autonomous ACR approval;
- a silent healthy-state converter for architecture drift;
- changing the frozen v1.0 architecture version.

## Definition of done

- The continuous architecture fitness closed loop is persisted in
  `spec/architecture/v1.1/control-system-evolution.md`.
- All required invariants hold with objective evidence (the required proofs
  above, including mutation/discrimination tests).
- Static architecture invariants for the no-second-authority matrix pass.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-070 scope; independent Architect Review approves;
  WORK-070 is marked VERIFIED.
