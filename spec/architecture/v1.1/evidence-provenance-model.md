# WorkflowOS v1.1 — Evidence & Provenance Model

Status: proposed. This document persists the evidence provenance model
for the continuous product validation sub-evolution. It does NOT create
a second evidence authority. The existing `/verification` authority
(established in v1.0, owned by WORK-015) remains the ONE verification/
evidence authority.

## 1. The invariant

> Validation observations do NOT create a second evidence authority. They
> map into the existing verification/evidence system, with provenance
> preserved between them.

This is the load-bearing provenance invariant of the v1.1 validation
sub-evolution. It is the architectural answer to the earlier Workbench
provenance defect (the historical case where observations were not
bound to durable provenance).

## 2. The three-tier evidence model

The v1.1 validation sub-evolution distinguishes three tiers:

```text
raw observation
    a single observation captured by a validation run (DOM snapshot,
    network response, persisted record, downstream event). Provenance:
    the run, the journey, the step, the environment, the timestamp.

    ↓ provenance-preserving derivation

validation result
    a typed outcome of a validation run (healthy, validation_failure,
    effect_policy_violation, environment_error). Provenance: the raw
    observations it was derived from, the run's identity, the run's
    environment, the run's trigger.

    ↓ provenance-preserving mapping

formal verification evidence
    a record in the EXISTING /verification evidence authority. The
    validation result is a DERIVED artifact that REFERENCES the formal
    evidence; it does not replace it. Provenance: the validation result
    it was mapped from, the verification run that recorded it, the
    criterion it satisfies (where applicable).
```

## 3. The provenance chain

Every formal verification evidence record that originated as a
validation observation carries the full provenance chain:

```text
formal verification evidence (in /verification)
    ↑ mapped from
validation result (a ValidationRun's outcome)
    ↑ derived from
raw observation (a single observation in the run)
    ↑ captured by
a ValidationRun (a synthetic execution of a ValidationJourney)
    ↑ declared by
a ValidationJourney (a meaningful user workflow)
    ↑ authorized by
WORK-064 (Continuous Product Validation — the domain/model authority)
    ↑ executed by
WORK-065 (Synthetic Browser Validation Agent — the execution mechanism)
```

Each arrow is a provenance-preserving derivation: the downstream record
records the upstream record's identity, and the upstream record is never
overwritten by the downstream record.

## 4. The artifact taxonomy (preserved)

The artifact taxonomy in `spec/architecture/v1.1/artifact-taxonomy.json`
already classifies:

- **normative**: ArchitectureVersion, architecture-lock, ADR, ACR;
- **authoritative**: /architecture, /work-items, /workflows, /verification,
  /reviews, /github;
- **derived**: SystemModel, EngineeringSignal, frontier-state,
  dependency-state, architecture-fitness-observation, checkpoint-summary;
- **evidence**: verification evidence, review findings, repository
  observations, CI observations, runtime observations, user-feedback
  observations.

The v1.1 validation sub-evolution adds TWO new derived artifact classes
to the taxonomy (when WORK-064/067 are implemented):

- **ValidationRun** — a derived artifact (the outcome of a synthetic
  execution);
- **ValidationObservation** — a derived artifact (a single raw
  observation captured by a run).

Both are DERIVED, never authoritative. They REFERENCE formal
verification evidence (in `/verification`); they do not REPLACE it.

The updated taxonomy will be persisted in
`spec/architecture/v1.1/artifact-taxonomy.json` when WORK-064 is
implemented. Until then, this document records the intended classification.

## 5. The no-silent-healthy rule

A validation failure CANNOT be:

- silently discarded (the observation is missing — the failure is not
  recorded);
- converted into a false healthy state (the run is recorded as healthy
  despite a failed observation);
- directly converted into an ungoverned code change (the failure
  triggers a code mutation without going through the existing
  `/work-items` authority).

This is enforced by:

- explicit error states (a validation failure is a typed
  `validation_failure`, never a missing observation);
- evidence (every failure is recorded with provenance);
- provenance (the failure's source — run, journey, step, environment —
  is preserved through to the Work Item);
- signal creation (the failure becomes an Engineering Signal via
  WORK-067);
- governed Work Item creation (the signal becomes a proposed Work Item
  via WORK-068, through the existing `/work-items` authority).

## 6. The failure → Work Item flow (the canonical path)

```text
Validation failure (a typed validation_failure outcome)
    ↓
Evidence (provenance preserved — run, journey, step, environment)
    ↓
Engineering Signal (WORK-067 — correlated, deduplicated, regression-
                    likelihood-assessed)
    ↓
governed assessment (severity, scope, blast radius)
    ↓
Work Item (WORK-068 — through the EXISTING /work-items authority;
          never a parallel intake)
    ↓
the existing governance lifecycle (architecture checkpoint, agent
execution, verification, architect review, merge)
```

The browser agent (WORK-065) observes. The signal system (WORK-067)
assesses. The Work Item system (WORK-068, the existing `/work-items`
authority) governs change. The architect governs implementation review.

No browser agent may directly modify code because it found a failure.
This is the no-direct-code-change invariant, enforced at the architecture
boundary.

## 7. The relationship to WORK-056 (Engineering Signals and Feedback Intake)

WORK-056 (Engineering Signals and Feedback Intake — planned) is the
v1.1 evolution Work Order that establishes the signal TAXONOMY and
INTAKE. WORK-067 (Engineering Signal & Regression Correlation —
planned) is the CORRELATION/REGRESSION-DETECTION LAYER that consumes
WORK-056's intake.

The validation-originated signals (from WORK-064's failure evidence)
enter the same signal intake. They are NOT a parallel signal store.
When WORK-056 lands, validation-originated signals are typed using
WORK-056's taxonomy. Until then, they are typed directly by WORK-067
with the same provenance discipline.

## 8. The runtime evidence mapping (NOT implemented in this task)

The runtime evidence mapping (raw observation → validation result →
formal verification evidence) will be implemented under WORK-064 and
WORK-067 when they are activated. Until then:

- the existing `/verification` authority governs (no validation-originated
  evidence is mapped);
- the v1.1 evidence provenance model in this document is design-time
  proposed state;
- no runtime code implements the mapping.

This task does NOT implement the runtime evidence mapping. It persists
the model.
