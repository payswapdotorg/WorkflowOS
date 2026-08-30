# WORK-067 — Engineering Signal & Regression Correlation

Status: planned.

Issued by: the research-driven v1.1 evolution (the continuous product
validation roadmap). This Work Order establishes the engineering signal
correlation and regression-detection model — it does NOT implement runtime
code. Activation requires the architect's authorization and is recorded in
`spec/development-state/program-state.json` (this change records none).

Dependencies: WORK-064 (Continuous Product Validation — the primary
validation-originated signal source That dependency edge is now SATISFIED — WORK-064 is COMPLETE (implemented on branch feat/work-064-continuous-validation, merged by the architect as `c351451` via PR #86 on 2026-08-30 and finalized per §34.8/ADR-0007; the domain/model authority is on main at backend/src/continuous-validation/). WORK-067 is now DEPENDENCY-ELIGIBLE (WORK-015/WORK-040/WORK-041 already complete; WORK-056 soft) and remains NOT activated, NOT started — the architect's authorization is required. Existing authorities consumed:
`/verification` (WORK-015 — complete; the existing verification authority
whose evidence this Work Order correlates), the continuous planning authority
(WORK-040 — complete), the maintenance authority (WORK-041 — complete). Soft
relationship to WORK-056 (Engineering Signals and Feedback Intake — planned):
WORK-067 is the CORRELATION/REGRESSION-DETECTION LAYER that CONSUMES (but
does not duplicate) WORK-056's signal taxonomy when WORK-056 lands; until
then, WORK-067 operates on raw observations directly with the same
provenance discipline.

Downstream: WORK-068 (Feedback → Governed Work Items) converts this Work
Order's signals into governed Work Items; WORK-070 (Continuous Architecture
Fitness) consumes the regression-correlated signals for architecture risk.

## Objective

Turn heterogeneous observations — synthetic validation failures, runtime
failures, CI failures, telemetry anomalies, security signals, user feedback
— into a normalized, provenance-preserving Engineering Signal that has been
correlated to releases, deduplicated, and assessed for likely-regression
status — WITHOUT becoming a second verification authority, a second workflow
authority, or a parallel signal intake that competes with WORK-056.

The signal is ADVISORY until governed. It does not directly mutate
authoritative workflow, architecture, verification, or review state. It
feeds planning through the existing `/work-items` authority (via WORK-068).

## The signal model (the contract)

```text
Raw observation
    from: synthetic validation (WORK-064), runtime (existing authorities),
    CI (/github), telemetry (existing runtime), security (existing
    authorities), user feedback (existing intake)
        ↓ normalize + provenance
Engineering Signal
    a typed, provenance-preserving record: source, observation, severity,
    correlated releases, deduplication key, regression likelihood
        ↓ assess (advisory)
Likely-regression assessment
    the signal's correlation to a specific release, its deduplication
    against prior signals, its regression likelihood
        ↓ remain advisory until governed
Governed Work Item (WORK-068, through the existing /work-items authority)
```

## Relationship to WORK-056 (Engineering Signals and Feedback Intake)

WORK-056 is the planned v1.1 evolution Work Order that establishes the
signal TAXONOMY and INTAKE (turning raw observations into typed signals with
provenance). WORK-067 is the CORRELATION and REGRESSION-DETECTION LAYER
that:

- CONSUMES WORK-056's signal taxonomy when WORK-056 is implemented;
- until then, performs the same normalization directly with the same
  provenance discipline;
- ADDS the correlation-to-releases, deduplication, and regression-likelihood
  functions that WORK-056 does not own.

WORK-067 does NOT duplicate WORK-056's intake. When WORK-056 lands, WORK-067
delegates intake to WORK-056 and focuses on correlation. This Work Order
records the contract boundary so a future implementer cannot accidentally
build a second intake.

## The correlation functions

WORK-067 is responsible for:

1. **deduplication** — the same logical failure observed multiple times
   (across runs, across sources) converges on one signal identity;
2. **release correlation** — each signal is correlated to the release(s)
   its observation overlaps in time and causation with;
3. **regression identification** — a signal present after a release but
   absent before it, or a signal whose severity increased after a release,
   is flagged as a likely regression;
4. **provenance preservation** — every signal records its source(s), the
   raw observations it was derived from, and the correlation reasoning;
5. **advisory status** — signals feed planning; they do not directly mutate
   workflow, architecture, verification, or review state.

## Explicit prohibitions

WORK-067 must NEVER become:

- a **second verification authority** — signal evaluation is advisory; the
  formal verdict stays in `/verification`;
- a **second workflow authority** — signals do not transition Work Items;
  they feed planning through `/work-items` (via WORK-068);
- a **second signal intake** — when WORK-056 lands, intake is delegated to
  it; WORK-067 is the correlation layer, not a parallel intake;
- a **code-mutation authority** — signals advise; they do not modify code;
- a **silent healthy-state converter** — a failure cannot be silently
  discarded or converted into a false healthy state (the WORK-064
  invariant, carried forward).

## Required invariants

1. Every Engineering Signal preserves provenance (source(s), raw
   observation(s), correlation reasoning).
2. The same logical failure converges on one signal identity
   (deduplication).
3. Each signal is correlated to the release(s) its observation overlaps.
4. A signal present after a release but absent before it is flagged as a
   likely regression.
5. Signals are advisory; they do not directly mutate workflow, architecture,
   verification, or review state.
6. A validation failure cannot be silently discarded or converted into a
   false healthy state.
7. When WORK-056 lands, intake is delegated to it (no parallel intake).

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **deduplication convergence** — the same logical failure observed
   multiple times converges on one signal identity;
2. **release correlation** — a signal is correlated to the correct
   release(s) (discrimination-proven against incorrect correlation);
3. **regression identification** — a signal present after a release but
   absent before it is flagged as a likely regression (and a signal present
   before AND after is NOT mis-flagged);
4. **provenance preservation** — every signal records its source(s) and
   raw observation(s) (no free-floating signals);
5. **advisory status** — a signal cannot directly mutate workflow,
   architecture, verification, or review state (static architecture
   invariant + runtime discrimination);
6. **no silent healthy** — a failure cannot be silently discarded or
   converted into a false healthy state (mutation/discrimination);
7. **no second authority** — static architecture invariants for the
   no-second-verification/no-second-workflow/no-second-intake matrix pass.

## Scope

Allowed: the Engineering Signal correlation model (deduplication, release
correlation, regression identification, provenance); the advisory-to-planning
contract; the required proofs above.

Forbidden: the ValidationJourney domain model (WORK-064), the browser agent
(WORK-065), the scheduling engine (WORK-066), the feedback converter
(WORK-068), progressive release (WORK-069), architecture fitness
(WORK-070), the signal intake taxonomy (WORK-056, planned), the existing
verification/workflow/runtime/audit authorities. Forbidden for THIS change:
any runtime code at all (this task delivers the Work Order only).

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
      - /verification   # signals are advisory; the formal verdict stays in /verification
      - /work-items     # signals feed planning through /work-items (via WORK-068)
    reason: the Work Order CONSUMES these authorities; it must not duplicate
      them.
  - dependencies:
      - WORK-064   # the primary validation-originated signal source
      - WORK-015   # complete — existing verification authority
      - WORK-040   # complete — continuous planning
      - WORK-041   # complete — maintenance
      - WORK-056   # soft — signal intake (planned); delegated to when it lands
    reason: WORK-064 must be complete before validation-originated signals can
      be honestly correlated; WORK-015/040/041 are complete existing
      authorities consumed; WORK-056 is a soft dependency (delegated to when
      it lands).
protectedSurfaces:
  - spec/architecture/v1.1/evidence-provenance-model.md
  - spec/work-orders/WORK-067.md
```

An Architect LLM may mechanically determine the state of WORK-067 as:
`READY` when WORK-064 is complete (WORK-015/040/041 are already complete;
WORK-056 is soft); `BLOCKED` while WORK-064 is unimplemented; `PARALLEL-SAFE`
with WORK-053..061, WORK-065..066, WORK-068..070 (different surfaces);
`CONFLICTING` with any future Work Order that authors a second verification,
workflow, or signal-intake authority.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second verification, workflow, or signal-intake authority;
- a signal that directly mutates workflow, architecture, verification, or
  review state;
- a silent healthy-state converter for validation failures;
- changing the frozen v1.0 architecture version.

## Definition of done

- The Engineering Signal correlation model is persisted in
  `spec/architecture/v1.1/evidence-provenance-model.md`.
- All required invariants hold with objective evidence (the required proofs
  above, including mutation/discrimination tests).
- Static architecture invariants for the no-second-authority matrix pass.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-067 scope; independent Architect Review approves;
  WORK-067 is marked VERIFIED before WORK-068/070 become eligible on it.
