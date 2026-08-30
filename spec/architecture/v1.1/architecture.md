# WorkflowOS v1.1 Architecture

## 1. Engineering Control Loop

The system is modeled as a closed loop:

SENSE → UNDERSTAND → PLAN → CHECK → EXECUTE → VERIFY → REVIEW → RELEASE → OBSERVE → LEARN → SENSE.

Each stage uses existing authoritative boundaries. The loop is connective governance, not a new workflow engine.

> **v1.1 continuous product validation sub-evolution (ACR-002):** the v1.1
> control loop EXTENDS the frozen v1.0 10-stage loop with an explicit
> `VALIDATE` stage between `RELEASE` and `OBSERVE`, making the loop closed:
>
> SENSE → UNDERSTAND → PLAN → CHECK → EXECUTE → VERIFY → REVIEW → RELEASE → **VALIDATE** → OBSERVE → LEARN → SENSE.
>
> The frozen v1.0 control loop (10 stages, no `VALIDATE`) remains governing
> until ACR-001 and ACR-002 are approved; the v1.1 control loop (11 stages,
> with `VALIDATE`) is PROPOSED in
> [`control-system-evolution.md`](control-system-evolution.md). The
> `VALIDATE` stage is the deliberate act of exercising meaningful user
> workflows against a real deployment (preview or production, under a
> declared EffectPolicy) to confirm the released system works for the
> customer. See [`validation-model.md`](validation-model.md) and
> [`continuous-validation-lifecycle.md`](continuous-validation-lifecycle.md).

## 2. Complexity-adaptive engineering

Work Item remains the atomic governed change. Change Programs and Change Sets may contain many Work Items. Assurance depth is selected deterministically from declared impact/surface characteristics:

LIGHT → STANDARD → HIGH_ASSURANCE → CRITICAL.

The assurance profile can increase checkpoint/evidence depth but cannot reduce security, tenancy, authority, verification, provenance, identity, idempotency, or concurrency guarantees.

## 3. System Model

A derived System Model captures components, interfaces, dependencies, data flows, deployments, ownership/context, runtime boundaries, and quality-attribute relationships. Facts have provenance and never overwrite authoritative domain state.

## 4. Quality attributes and fitness

Important systems may define measured attributes including reliability, availability, latency, throughput, scalability, security, modifiability, operability, cost, usability, resilience, and delivery risk. Fitness observations compare measured evidence with baselines/targets/thresholds and may create governed Work Items or Architecture Change Requests.

## 5. Engineering signals

Raw observations from repository, CI, runtime, incidents, security, dependencies, performance, user feedback and business/product signals become provenance-preserving Engineering Signals. Signals inform planning; they do not directly mutate authoritative workflow, architecture, verification, or review state.

## 6. Large change orchestration

A Change Program represents a desired system-state transition. A Change Set groups a coherent subset of Work Items. Dependency-aware scheduling may execute independent Work Items concurrently. Each Work Item retains its existing Work Order, verification, review, and PR semantics.

## 7. Transformation completeness

For migrations/refactors, behavioral correctness and requested-transformation completeness are separate proofs. A completed change may require structural audits showing obsolete paths are removed and intended migration coverage is complete.

## 8. Operational/release governance

Where applicable, release governance may use SLOs, error budgets, progressive rollout, rollback strategy and post-release validation. These remain subordinate to `/workflows`, `/github`, `/verification`, and runtime authorities.

## 9. Architecture evolution

Architecture fitness and conformance may produce an Architecture Change Request. Approval creates a new immutable ArchitectureVersion. A self-hosted agent cannot change the governing architecture in place.

## 10. Self-hosting

WorkflowOS may use its own Work Items, Work Orders, execution, verification, review, GitHub and maintenance lifecycle to modify WorkflowOS. The same authorities and safeguards apply to internal and customer systems.

## 11. Continuous product validation (v1.1 sub-evolution, ACR-002)

The v1.1 sub-evolution adds the `VALIDATE` stage and the continuous product validation model: `ValidationJourney`, `ValidationRun`, `TestIdentity`, `Environment`, `EffectPolicy`, `ExpectedObservation`, `Evidence`. Production synthetic validation must never perform uncontrolled destructive side effects; dangerous functionality requires a sandbox, a synthetic identity, a test tenant, a test payment instrument, controlled external integrations, or another explicitly approved safe mechanism. The browser agent is an execution mechanism, not an authority. See [`validation-model.md`](validation-model.md), [`continuous-validation-lifecycle.md`](continuous-validation-lifecycle.md), [`evidence-provenance-model.md`](evidence-provenance-model.md).

## 12. Dogfooding (v1.1 sub-evolution, ACR-002)

WorkflowOS must be able to use its own product-development workflow to build and maintain a customer product, and it must be able to test that product using realistic synthetic-user journeys. The same loop applies when WorkflowOS itself is the customer product. See [`dogfooding-model.md`](dogfooding-model.md).

## 13. Feedback → governed Work Items (v1.1 sub-evolution, ACR-002)

A validation failure must never be silently discarded, converted into a false healthy state, or directly converted into an ungoverned code change. The canonical flow: validation failure → evidence → engineering signal (correlated, deduplicated, regression-likelihood-assessed) → governed assessment → Work Item through the EXISTING `/work-items` authority. The browser agent observes; the signal system assesses; the Work Item system governs change; the architect governs implementation review. See [`evidence-provenance-model.md`](evidence-provenance-model.md).

## 14. Continuous architecture fitness (v1.1 sub-evolution, ACR-002)

The v1.1 sub-evolution continuously evaluates whether the architecture remains fit, combining architecture conformance, quality attributes, performance, reliability, security, dependency trends, technical debt, runtime behavior, and operational impact into an architecture-risk recommendation that produces an ACR (through the existing `/architecture` authority). It does not mutate frozen architecture directly. See [`control-system-evolution.md`](control-system-evolution.md).
