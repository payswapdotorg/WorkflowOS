# WorkflowOS v1.1 — The Closed-Loop Software Engineering Control System Evolution

Status: proposed pending ACR-001 (and the new ACR-002 for the continuous
product validation sub-evolution) approval by the architecture authority.
v1.0 remains frozen and governing.

This document persists the core architectural conclusion of the
research-driven v1.1 evolution: **WorkflowOS is evolving from a governed
software-change system into a closed-loop software engineering control
system.** It is additive to the frozen v1.0 architecture and to the
existing v1.1 package (`spec/architecture/v1.1/architecture.md`); it does
not rewrite either.

## 1. The canonical lifecycle

The v1.0 engineering control loop (the code-pinned 10-stage loop in
`spec/governance/governance-model.json` → `engineeringControlLoop.stages`)
remains the FROZEN governing lifecycle:

```text
SENSE → UNDERSTAND → PLAN → CHECK → EXECUTE → VERIFY → REVIEW → RELEASE → OBSERVE → LEARN → SENSE
```

The v1.1 evolution EXTENDS this loop with an explicit `VALIDATE` stage,
producing the v1.1 proposed control-loop lifecycle:

```text
SENSE
  ↓
UNDERSTAND
  ↓
PLAN
  ↓
CHECK
  ↓
EXECUTE
  ↓
VERIFY
  ↓
REVIEW
  ↓
RELEASE
  ↓
VALIDATE          ← the v1.1 extension: synthetic product validation
  ↓
OBSERVE
  ↓
LEARN
  ↓
SENSE
  └────────────→ (closed loop)
```

`VALIDATE` is the explicit architectural concept for synthetic product
validation: the act of exercising meaningful user workflows against a
real deployment (preview or production, under a declared EffectPolicy)
to confirm the released system actually works for the customer.

`OBSERVE → LEARN → SENSE` is represented as a first-class future
evolution: the loop from validation/runtime observation back to sensing
new work is the closed-loop property that makes WorkflowOS a control
system, not merely a change system.

## 2. The control-system distinction

A governed software-change system (the v1.0 model) decides what changes to
make, executes them under authority, and verifies them. A closed-loop
software engineering control system (the v1.1 model) ADDITIONALLY:

- validates the released system against real customer journeys
  (the `VALIDATE` stage);
- observes the runtime behavior of the released system (the `OBSERVE`
  stage, already in v1.0);
- learns from validation and observation to sense new work (the `LEARN →
  SENSE` stages, already in v1.0);
- continuously replans against the learned state (the `PLAN` stage,
  already in v1.0).

The `VALIDATE` stage is the missing piece: it closes the loop between
release and observation by deliberately exercising the released system,
not merely waiting for runtime failures.

## 3. Agents are bounded workers, not the control system

Agents (implementation agents, browser agents, the conversational
architect agent) remain bounded workers inside the control system. They
are not the control system. The control system is the set of authorities
and their closed-loop interactions, persisted in the repository:

```text
Human
= product/business/consequential approvals
= the architect's non-delegable ACR approval, merge authorization, and
  work-order activation authority

Architect LLM
= architecture authority
= Work Order authority
= checkpoint authority
= PR review authority
= drift detector
= merge recommendation/authorization

Implementation agents
= bounded workers (one Work Item branch/PR at a time)

Browser/synthetic agents
= validation workers (observe; never mutate code, never merge, never
  approve)
```

Implementation agents do not replace architectural review. The human
should not be required to perform routine implementation-code review —
the architect (Architect LLM) performs that review; the human performs
the consequential approvals (ACR approval, merge authorization for
governing changes, work-order activation).

## 4. The architecture authority chain (runtime ordering)

```text
/architecture      → ArchitectureVersion, ACRs, assertions
    ↓
/requirements      → requirements, acceptance criteria
    ↓
/work-items        → Work Items, Work Orders, dependencies
    ↓
/workflows         → workflow state machine, legal transitions
    ↓
existing execution authority → ExecutionService.submit() boundary
    ↓
/verification      → evidence, criterion evaluation
    ↓
/reviews           → architect review records, findings
    ↓
/github            → PRs, CI, releases
    ↓
runtime/audit      → runtime observation (existing v1.0 authorities)
    ↓
VALIDATE (v1.1)    → synthetic product validation (WORK-064..070)
    ↓
OBSERVE → LEARN → SENSE (closed loop back to /architecture)
```

This is the RUNTIME authority/flow ordering — who owns what decision. It
is NOT a restatement of build dependencies: build dependencies live in
`spec/dependency-graph.md` + `spec/development-state/dependency-state.json`
+ the owning Work Order's `Dependencies` section.

## 5. The continuous engineering control loop

The v1.1 control loop is continuous: each cycle through SENSE → … → LEARN
informs the next cycle's SENSE. The inputs to the next cycle's SENSE
include:

- architecture conformance (the existing `/architecture` assertions);
- quality attributes (WORK-055 when it lands; the existing assertions
  until then);
- runtime behavior (the existing runtime/audit authorities);
- validation results (WORK-064..070 — the v1.1 extension);
- engineering signals (WORK-067 — correlated, provenance-bound);
- user feedback (the existing intake);
- technical debt (the existing maintenance/planning authorities);
- security (the existing security signal intake);
- architecture fitness (WORK-070 — the v1.1 closed-loop synthesis).

The continuous loop is the property that makes WorkflowOS a control
system. Without `VALIDATE`, the loop would be open: the system would
release, observe (only what fails organically), and learn only from
failures. With `VALIDATE`, the system deliberately exercises the released
system and learns from both successes and failures.

## 6. The design principle (research-derived)

> WorkflowOS should optimize for how quickly a system can safely learn,
> change, verify, and evolve — not merely how quickly an agent can
> generate code.

This principle, derived from the research program (see
[`research-rationale.md`](research-rationale.md)), is the load-bearing
design constraint of the v1.1 evolution. It explains why:

- `VALIDATE` is a first-class stage (learning requires deliberate
  validation, not only passive observation);
- assurance is adaptive (the depth of verification must match the
  risk of the change, not a one-size-fits-all gate);
- the dogfooding loop is canonical (WorkflowOS must use its own control
  system to build and validate customer products — and itself);
- the failure→Work Item semantics is enforced (a validation failure
  cannot be silently discarded — that would break the loop's learning
  property);
- the parallel-execution metadata is mechanical (a control system must
  be able to determine what can run concurrently without human
  interpretation).

## 7. Relationship to the frozen v1.0 control loop

The frozen v1.0 control loop (10 stages, no `VALIDATE`) remains the
governing lifecycle until ACR-002 (this v1.1 extension) is approved by
the architecture authority. The v1.1 lifecycle (11 stages, with
`VALIDATE`) is PROPOSED. Activation requires:

1. ACR-002 approval by the architect (the non-delegable architecture
   authority);
2. a new immutable ArchitectureVersion (v1.1) recorded in
   `/architecture`;
3. the code-pinned `CONTROL_LOOP_STAGES` constant in
   `backend/src/architecture-checkpoints/internal/governance-validation.ts`
   updated to include `validate` (the no-silent-rewrite property — code
   and artifact move together);
4. the corresponding test expectations
   (`governing.controlLoop.map((s) => s.name)` in
   `backend/tests/integration/development-governance/governance-state.integration.test.ts`)
   updated to match.

Until activation, the v1.1 lifecycle in this document is design-time
proposed state. The v1.0 frozen lifecycle governs.

## 8. The invariant

> No customer-product validation failure may be silently discarded,
> converted into a false healthy state, or directly converted into an
> ungoverned code change.

This invariant is the load-bearing safety property of the closed loop. It
is enforced by:

- explicit error states (a validation failure is a typed
  `validation_failure`, never a missing observation);
- evidence (every failure is recorded with provenance);
- provenance (the failure's source — run, journey, step, environment —
  is preserved through to the Work Item);
- signal creation (the failure becomes an Engineering Signal via
  WORK-067);
- governed Work Item creation (the signal becomes a proposed Work Item
  via WORK-068, through the existing `/work-items` authority).

This is especially important given the earlier Workbench provenance
defect (the historical case where observations were not bound to durable
provenance). The v1.1 evolution makes the binding explicit and
machine-checked.

## 9. References

- Frozen v1.0 architecture: [`../architecture.md`](../architecture.md),
  [`../architecture-lock.md`](../architecture-lock.md).
- Existing v1.1 package: [`architecture.md`](architecture.md),
  [`architecture-lock.md`](architecture-lock.md),
  [`dependency-graph.md`](dependency-graph.md),
  [`work-items.md`](work-items.md),
  [`reconciliation-record.md`](reconciliation-record.md).
- Research rationale: [`research-rationale.md`](research-rationale.md).
- Validation model: [`validation-model.md`](validation-model.md).
- Adaptive assurance evolution: [`adaptive-assurance-evolution.md`](adaptive-assurance-evolution.md).
- Dogfooding model: [`dogfooding-model.md`](dogfooding-model.md).
- Continuous validation lifecycle: [`continuous-validation-lifecycle.md`](continuous-validation-lifecycle.md).
- Evidence provenance model: [`evidence-provenance-model.md`](evidence-provenance-model.md).
- Parallel-execution metadata: [`parallel-execution-metadata.md`](parallel-execution-metadata.md).
- Fresh-architect bootstrap: [`fresh-architect-bootstrap.md`](fresh-architect-bootstrap.md).
- ACR-001 (the original v1.1 adaptive engineering control system ACR):
  [`../architecture-change-requests/ACR-001-v1-1-adaptive-engineering-control-system.md`](../architecture-change-requests/ACR-001-v1-1-adaptive-engineering-control-system.md).
- ACR-002 (the continuous product validation sub-evolution ACR):
  [`../architecture-change-requests/ACR-002-continuous-product-validation.md`](../architecture-change-requests/ACR-002-continuous-product-validation.md).
