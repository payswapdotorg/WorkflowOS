# WorkflowOS Architecture v1.1

Status: proposed pending ACR-001 (and the new ACR-002 for the continuous
product validation sub-evolution) approval and merge.

v1.1 is an additive evolution of frozen v1.0. Historical v1.0 documents
are never rewritten to make v1.1 true.

> **Reconciliation (2026-08-29, pass 1 + pass 2):** this package was reconciled against main `8f27cc7`
> (the merged WORK-046..050 wave), then — after the architect's REQUEST CHANGES verdict —
> the WORK-053..059 identity collision and the v1.1-vs-2.0 version-label conflict were
> **resolved at the identity/authority layer**: the architect-issued issue track (ACR-001,
> WORK-053..061, v1.1) is canonical; the upload wave is retired under `UW-053..059`
> identities in `spec/archive/upload-wave-2026-08-28/`. See
> [`reconciliation-record.md`](reconciliation-record.md) (§3 + §8) for the verified repository
> truth, the resolution, and the GitHub enforcement gaps recorded as v1.1 governance requirements.

> **Continuous product validation sub-evolution (2026-08-30):** this package was EXTENDED
> with the continuous product validation sub-evolution (ACR-002) — the `VALIDATE` stage,
> the ValidationJourney/EffectPolicy domain model, the synthetic browser validation agent,
> validation scheduling, engineering signal correlation, feedback→Work-Item conversion,
> progressive release, continuous architecture fitness, and the dogfooding/self-hosting
> model. Seven new Work Orders (WORK-064..070) carry the sub-evolution. See
> [`control-system-evolution.md`](control-system-evolution.md),
> [`research-rationale.md`](research-rationale.md),
> [`validation-model.md`](validation-model.md),
> [`adaptive-assurance-evolution.md`](adaptive-assurance-evolution.md),
> [`dogfooding-model.md`](dogfooding-model.md),
> [`continuous-validation-lifecycle.md`](continuous-validation-lifecycle.md),
> [`evidence-provenance-model.md`](evidence-provenance-model.md),
> [`parallel-execution-metadata.md`](parallel-execution-metadata.md), and
> [`fresh-architect-bootstrap.md`](fresh-architect-bootstrap.md) for the extended
> package. The frozen v1.0 control loop (10 stages, no `VALIDATE`) remains governing
> until ACR-001 + ACR-002 are approved; the v1.1 control loop (11 stages, with `VALIDATE`)
> is PROPOSED in [`control-system-evolution.md`](control-system-evolution.md).

## Scope

v1.1 adds the durable architectural model for:

- Engineering Control Loop: sense → understand → plan → check → execute → verify → review → release → (validate) → observe → learn. The `VALIDATE` stage is the v1.1 continuous-product-validation sub-evolution (ACR-002).
- Complexity-adaptive assurance.
- Derived System Model and provenance-aware engineering context.
- Quality attributes and architecture fitness.
- Engineering signals from repository, CI, runtime, security, incidents, performance, user and product feedback.
- Change Programs and Change Sets for large-system evolution while retaining Work Item as the atomic governed unit.
- Continuous architecture evaluation and Architecture Change Requests.
- Operational/release governance where applicable.
- Self-hosting of WorkflowOS without permitting silent changes to governing architecture.
- **Continuous product validation** (the v1.1 sub-evolution, ACR-002): the `VALIDATE` stage, ValidationJourney/EffectPolicy, the synthetic browser validation agent, validation scheduling, engineering signal correlation, feedback→Work-Item conversion, progressive release, continuous architecture fitness, and the dogfooding/self-hosting model.

## Authority rule

No v1.1 artifact becomes a replacement for an existing v1.0 authority. New artifacts are classified as normative architecture, authoritative state in an existing authority, derived engineering state, or evidence.

## Package contents

| Artifact | Purpose |
|---|---|
| [`architecture.md`](architecture.md) | The v1.1 architecture (the 10 numbered sections). |
| [`architecture-lock.md`](architecture-lock.md) | The v1.1 architecture lock (forward-evolution invariants). |
| [`dependency-graph.md`](dependency-graph.md) | The v1.1 design-time dependency graph. |
| [`work-items.md`](work-items.md) | The v1.1 work items table (WORK-053..062 + WORK-064..070). |
| [`artifact-taxonomy.json`](artifact-taxonomy.json) | The artifact taxonomy (normative, authoritative, derived, evidence). |
| [`reconciliation-record.md`](reconciliation-record.md) | The 2026-08-29 reconciliation record (the identity collision resolution). |
| [`control-system-evolution.md`](control-system-evolution.md) | The closed-loop control system evolution (the `VALIDATE` stage, agents-as-bounded-workers, the authority chain). |
| [`research-rationale.md`](research-rationale.md) | The research-derived rationale (the mature software engineering loop, the three complementary proof classes, source references). |
| [`validation-model.md`](validation-model.md) | The continuous product validation domain model. |
| [`adaptive-assurance-evolution.md`](adaptive-assurance-evolution.md) | The validation-aware assurance dimension (additive to v1.0's assurance-profiles.json). |
| [`dogfooding-model.md`](dogfooding-model.md) | The dogfooding/self-hosting model (canonical customer-product and self-hosting flows). |
| [`continuous-validation-lifecycle.md`](continuous-validation-lifecycle.md) | The three operating modes (PRE_MERGE, POST_RELEASE, CONTINUOUS) and their bindings. |
| [`evidence-provenance-model.md`](evidence-provenance-model.md) | The three-tier evidence model (raw observation → validation result → formal verification evidence). |
| [`parallel-execution-metadata.md`](parallel-execution-metadata.md) | The parallel-execution metadata model (parallelEligibility, parallelConflicts, protectedSurfaces). |
| [`fresh-architect-bootstrap.md`](fresh-architect-bootstrap.md) | The bootstrap for a fresh Architect LLM that has lost all conversational context. |
