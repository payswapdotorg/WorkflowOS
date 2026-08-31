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
INTAKE. WORK-067 (Engineering Signal & Regression Correlation — COMPLETE:
merged `bde33cc` via PR #103, finalized §34.8/ADR-0007) is the
CORRELATION/REGRESSION-DETECTION LAYER that consumes
WORK-056's intake (until WORK-056 lands, the TEMPORARY intake seam in
§9 types raw observations directly with the same provenance discipline).

The validation-originated signals (from WORK-064's failure evidence)
enter the same signal intake. They are NOT a parallel signal store.
When WORK-056 lands, validation-originated signals are typed using
WORK-056's taxonomy. Until then, they are typed directly by WORK-067
with the same provenance discipline.

## 8. The runtime evidence mapping (NOT implemented in this task)

The runtime evidence mapping (raw observation → validation result →
formal verification evidence) was implemented under WORK-064 (COMPLETE —
the authority's evidence mapping on main) while WORK-067 (COMPLETE — the
ADVISORY signal correlation layer) deliberately does NOT map into formal
verification evidence: its signals are advisory only. The remaining gap
is governed future work (the WORK-068 feedback converter and beyond). Until then:

- the existing `/verification` authority governs (no validation-originated
  evidence is mapped);
- the v1.1 evidence provenance model in this document is design-time
  proposed state;
- no runtime code implements the mapping.

This task does NOT implement the runtime evidence mapping. It persists
the model.

## 9. The implemented Engineering Signal correlation model (WORK-067 — COMPLETE + FINALIZED)

WORK-067 (Engineering Signal & Regression Correlation) was activated by
the architect on 2026-09-01, implemented at
`backend/src/engineering-signals/` (the application-layer pattern — NOT an
18th frozen module; branch `feat/WORK-067-signal-regression-correlation`),
MERGED by the architect as `bde33cc` via PR #103 on 2026-08-31T18:30:23Z
(squash-merged at the approved head `0fe9c48` — the tree identical), and
FINALIZED §34.8/ADR-0007 by the WORK-067 post-merge finalization. This
section persists the implemented
model — the runtime form of §5–§7's design-time contract.

### The signal record (the provenance-preserving derived artifact)

An `EngineeringSignal` is the DERIVED artifact class §4 anticipated. Its
identity is a deterministic `sha256` over **tenant + project +
environment + the logical failure classification** — the same logical
failure observed multiple times (across runs, across sources) converges
on ONE identity; a different tenant, project, environment, or failure
NEVER collapses onto it. The signal carries an append-only occurrence
history: every occurrence preserves its **raw observation reference (the
opaque authority locator) AND the raw payload verbatim** plus the
convergence reasoning. A signal without provenance is impossible (the
normalization rejects missing references/payloads — no free-floating
signals).

The chain §3 anticipated is realized:

```text
formal verification evidence (in /verification)
    ↑ mapped from (WORK-064's evidence mapping — unchanged)
validation result (a ValidationRun's typed outcome)
    ↑ consumed by (WORK-067's validation-source adapter: findRun + the
      public record type — every failure becomes an occurrence)
Engineering Signal occurrence (preserving run → journey → step →
    environment → observedAt + the raw failure record)
    ↑ converged by (the deterministic signal identity)
Engineering Signal (deduplicated, release-correlated, regression-assessed)
    ↑ ADVISORY — consumed by the FUTURE governed converters
governed Work Item (WORK-068, through the EXISTING /work-items authority)
```

### The intake seam (TEMPORARY — the WORK-056 boundary)

Until WORK-056 (Engineering Signals and Feedback Intake) lands, the
normalization boundary is `RawObservationInput` — the documented
TEMPORARY compatibility seam: the caller supplies the scope
(tenant/project/environment), the logical failure classification, the
severity (the repository's existing critical/high/medium/low vocabulary —
the WORK-041 maintenance precedent), the RECORDED observation time, the
raw observation reference, and the raw payload. When WORK-056 lands, the
taxonomy/intake is DELEGATED to it and this seam retires into a consumed
boundary. The closed source vocabulary covers the Work Order's
heterogeneous kinds (validation, ci, runtime, telemetry, security,
user-feedback, deployment); references are PRESERVED, never
dereferenced.

### Release correlation (RECORDED identities only — the architectural gap)

Repository truth (re-verified at implementation): **NO release authority
exists** (no `wfos_releases`, no release service; the v1.1 roadmap binds
the release authority to WORK-069's future territory). The ONLY recorded
release references today are the WORK-064 POST_RELEASE runs' `releaseRef`
— consumed as the occurrence-level causal binding. WORK-067 therefore
correlates signals ONLY to caller-supplied `ReleaseCorrelationContext`s
(RECORDED reference + boundary time + declared provenance
`validation-run-release-ref | caller-declared`) — a release identity is
NEVER invented from a timestamp, a commit, a deployment URL, or a branch
name. The causal discipline: a signal causally bound to release A is
REJECTED for release B (`causal-binding-mismatch` — the wrong-release
discrimination); unbound signals correlate only via the explicitly
recorded caller-declared basis WITH post-release-window time overlap.
When NO release context exists, release correlation is explicitly
`unavailable` (fail-closed) — the documented architectural gap until the
release authority lands.

### The regression assessment (ADVISORY)

Per correlated release, the assessment splits the occurrence timeline at
the boundary (before = `observedAt < releasedAt`; after = `>=` — the
release is live from its boundary): absent-before + present-after →
`likely_regression`; present-before-and-after → NOT a regression merely
because a release happened; severity escalation (the LAST pre-release and
FIRST post-release occurrences, deterministic ordering, the repository's
severity ordering) → regression-relevant — a DECREASE is never promoted.
`likelyRegression` is `true`/`false` when assessed and **`null` when
unavailable** — a failure signal NEVER becomes silently healthy (the §5
invariant carried forward). The assessment is ADVISORY data: it is not a
verification verdict, not a Work Item, not a workflow transition — the
governed conversion is WORK-068's (through the EXISTING `/work-items`
authority).

### Persistence (the port boundary)

The `EngineeringSignalRepository` PORT binds the in-memory adapter (this
Work Order authorizes NO schema migration — the WORK-064/066 port
precedent). The durable binding point is the documented future ACR at the
same port; the PostgreSQL keyed-uniqueness contract (the DATABASE
constraint decides the winner under true two-actor concurrency) is proven
by the real-PG two-actor integration suite against a test-schema table.
