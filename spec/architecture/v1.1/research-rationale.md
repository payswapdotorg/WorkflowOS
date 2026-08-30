# WorkflowOS v1.1 — Research Rationale (Mature Software Engineering Loop)

Status: proposed. This document records the research-derived conclusions
that motivate the v1.1 evolution. It does not rewrite frozen v1.0
architecture. It summarizes conclusions and preserves source references
already established; it does not copy large amounts of source text.

## 1. The core conclusion

Mature software engineering is not a sequence of isolated change
events. It is a **continuous loop** that involves:

- requirements;
- architecture;
- implementation;
- verification;
- operation;
- maintenance;
- telemetry;
- user feedback;
- technical debt;
- quality attributes;
- security;
- architecture fitness;
- continuous replanning.

A change-system (the v1.0 model) handles the first five well: it
decides what to change, executes under authority, and verifies. A
control-system (the v1.1 model) additionally closes the loop by:

- deliberately validating the released system against real customer
  journeys (the `VALIDATE` stage);
- observing runtime behavior (the `OBSERVE` stage);
- learning from validation and observation to sense new work (the
  `LEARN → SENSE` stages);
- continuously replanning against the learned state (the `PLAN` stage).

The v1.1 evolution's central design principle:

> WorkflowOS should optimize for how quickly a system can safely learn,
> change, verify, and evolve — not merely how quickly an agent can
> generate code.

## 2. Why the loop must be closed

An open loop (release → passively observe what fails → react) learns only
from failures. A closed loop (release → deliberately validate → observe →
learn → sense) learns from both successes and failures, and from the
fitness of the architecture over time.

The practical consequence: without `VALIDATE`, the system has no
deliberate signal about whether the released system actually works for
the customer until a customer reports a failure (or a runtime alert
fires). With `VALIDATE`, the system continuously exercises meaningful
customer journeys and learns before customers are affected.

## 3. The three complementary proof classes

The v1.1 evolution explicitly distinguishes three proof classes that
complement one another:

```text
functional testing
    unit/integration tests of the implementation, evaluated by the
    existing /verification authority. Proves the code does what it
    claims.

synthetic product validation
    exercising meaningful user workflows against a real deployment
    (preview or production, under a declared EffectPolicy). Proves the
    released system works for the customer. Owned by WORK-064..070.

runtime observation
    observing the real production system's behavior (errors, latency,
    resource use, downstream events). Proves the system works in
    production reality. Owned by the existing v1.0 runtime/audit
    authorities.
```

These are complementary, not redundant:

- functional testing cannot catch integration regressions in the real
  deployment (synthetic validation can);
- synthetic validation cannot catch runtime anomalies that only manifest
  under real load (runtime observation can);
- runtime observation cannot catch customer-journey regressions until a
  customer is affected (synthetic validation can, before customers are
  affected).

## 4. The continuous engineering control loop (research summary)

The research program established that mature software engineering
organizations operate a continuous loop with the following properties:

- **requirements** are not frozen at project start; they evolve with the
  system and its environment;
- **architecture** is not a one-time design; it is continuously
  evaluated for fitness against quality attributes, runtime behavior, and
  changing requirements;
- **implementation** is governed: each change goes through checkpoint,
  execution, verification, and review;
- **verification** is multi-class: static, dynamic, discrimination,
  plus the new validation class;
- **operation** observes the real system and feeds signals back;
- **maintenance** addresses technical debt continuously, not as a
  separate project;
- **telemetry** is the nervous system of the loop;
- **user feedback** is a first-class signal, not an afterthought;
- **technical debt** is tracked and addressed before it becomes
  architectural drift;
- **quality attributes** are measured against baselines/targets/
  thresholds;
- **security** is continuous, not a gate;
- **architecture fitness** is continuously evaluated and produces ACRs
  when the architecture drifts;
- **continuous replanning** is the property that makes the loop closed:
  each cycle's learning informs the next cycle's planning.

The v1.1 evolution persists these properties as architectural concepts
(the Engineering Control Loop, the System Model, Quality Attributes,
Engineering Signals, Change Programs, Adaptive Assurance, Operational/
Release Governance, Architecture Fitness, Self-Hosting) and the new
continuous product validation sub-evolution (the `VALIDATE` stage,
ValidationJourney, EffectPolicy, the failure→Work Item semantics).

## 5. The dogfooding/self-hosting model (research-derived)

A control system that cannot validate itself is not a closed loop. The
v1.1 evolution persists the dogfooding model:

> WorkflowOS must be able to use its own product-development workflow to
> build and maintain a customer product, and it must be able to test that
> product using realistic synthetic-user journeys.

The same loop applies when WorkflowOS itself is the customer product:
the WorkflowOS repository, its architecture, its Work Items, its agents,
its validation, its feedback, and its evolution all run inside the same
control system. See [`dogfooding-model.md`](dogfooding-model.md).

## 6. The adaptive-assurance model (research-derived)

The v1.1 evolution persists the adaptive-assurance model: the depth of
verification must match the risk of the change, not a one-size-fits-all
gate. The same authority model applies; only the assurance depth changes.

> Same authority model, different assurance depth.

The four profiles (LIGHT, STANDARD, HIGH_ASSURANCE, CRITICAL) are
already established in `spec/governance/assurance-profiles.json` and
the code-pinned `CODE_PINNED_PROFILE_MINIMUMS` in
`backend/src/architecture-checkpoints/internal/governance-validation.ts`.
The v1.1 evolution EXTENDS the model with the validation-aware dimension
(see [`adaptive-assurance-evolution.md`](adaptive-assurance-evolution.md)).

## 7. Source references (preserved, not copied)

The research program's source references are preserved where already
established in the repository:

- The Engineering Control Loop (10-stage frozen v1.0): `spec/governance/
  governance-model.json` → `engineeringControlLoop.stages` (code-pinned
  in `backend/src/architecture-checkpoints/internal/governance-
  validation.ts`).
- The original v1.1 design: `docs/superpowers/specs/2026-08-28-
  workflowos-adaptive-engineering-architecture-v1-1-design.md`.
- The original v1.1 plan: `docs/superpowers/plans/2026-08-28-workflowos-
  adaptive-engineering-v1-1-plan.md`.
- ADR-0001 (repository-resident governance state):
  `docs/adr/ADR-0001-repository-resident-governance-state.md`.
- ADR-0002 (assurance depth not authority):
  `docs/adr/ADR-0002-assurance-depth-not-authority.md`.
- ADR-0003 (parallel protocol surface declaration):
  `docs/adr/ADR-0003-parallel-protocol-surface-declaration.md`.
- ADR-0004 (fail-closed validation core prohibitions):
  `docs/adr/ADR-0004-fail-closed-validation-core-prohibitions.md`.
- ACR-001 (the v1.1 adaptive engineering control system ACR):
  `spec/architecture-change-requests/ACR-001-v1-1-adaptive-engineering-
  control-system.md`.
- ACR-002 (the continuous product validation sub-evolution ACR):
  `spec/architecture-change-requests/ACR-002-continuous-product-
  validation.md` (new in this package).

This document does not copy source text from research papers; it
summarizes the conclusions the architect has drawn from the research
program and points to the repository artifacts that persist them.

## 8. The no-silent-rewrite property (research-derived)

The research program established that a control system's authority
boundaries must be code-pinned: weakening them must require touching
both the artifact and the code, a visible, reviewable diff. The v1.1
evolution preserves this property:

- the v1.0 control loop is code-pinned (10 stages); adding `VALIDATE`
  requires touching the code;
- the v1.0 assurance profiles are code-pinned; weakening a profile
  requires touching the code;
- the v1.0 self-hosting core prohibitions are code-pinned; removing
  one requires touching the code;
- the v1.0 completion rule (architect-merge is the only completion
  event) is code-pinned;
- the v1.0 post-merge finalization protocol is code-pinned.

The v1.1 evolution adds new code-pinned invariants for the validation
sub-evolution (the EffectPolicy enforcement, the no-silent-healthy
rule, the failure→signal→Work Item binding) when the corresponding Work
Orders are implemented. Until then, they are persisted as Work Order
invariants in `spec/work-orders/WORK-064..070.md` and as v1.1 evolution
artifacts in this directory.
