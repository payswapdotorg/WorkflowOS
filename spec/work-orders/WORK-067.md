# WORK-067 — Engineering Signal & Regression Correlation

Status: IN FLIGHT — activated by the architect on 2026-09-01
(the implementation instruction; the branch
`feat/WORK-067-signal-regression-correlation` was created from the actual
`origin/main` at `5f0b058` — the WORK-065 post-merge finalization — the
same base main as the parallel WORK-066 branch/PR #102, with
the ADR-0003 coordination declared in the program-state activation
record; WORK-066 has since been MERGED as `0a506b1` via PR #102 and
FINALIZED §34.8/ADR-0007 by PR #104 — the coordination is durable
history). The activation record is appended below (the architect's review
+ merge remain the completion gate; the §34.8/ADR-0007 post-merge
finalization follows the merge).

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

## Activation record (2026-09-01 — appended by the implementation)

Activated by the architect (the WORK-067 implementation instruction), after
verifying against the actual repository that every prerequisite held:
WORK-064 complete (`c351451`/PR #86, finalized §34.8/ADR-0007),
WORK-015/WORK-040/WORK-041 complete (the consumed authorities), WORK-056
soft (not started — the normalization seam is the documented TEMPORARY
compatibility boundary), 58/58 recorded work orders complete on main, and
no existing WORK-067 branch or PR. Branch:
`feat/WORK-067-signal-regression-correlation` (created from the actual
`origin/main` at `5f0b058`). WORK-067 does NOT hard-depend on WORK-066
(its correlation consumes WORK-064 outputs, not scheduler decisions): the
two run PARALLEL per this Work Order's own PARALLEL-SAFE-with-WORK-066
declaration, with the ADR-0003 coordination over the shared
`backend/src/app.ts` / `backend/tests/architecture/static-architecture.test.ts`
/ `backend/vitest.config.ts` integration surfaces declared in the
program-state activation record.

**Implementation (the ADVISORY correlation layer — not an authority):**
the domain lives at `backend/src/engineering-signals/` (the
WORK-064/065/066 application-layer precedent — NOT an 18th frozen module),
composed in `buildApp` and exposed on AppDeps as `engineeringSignalService`
for the future governed consumers (WORK-068 feedback conversion, WORK-070
architecture fitness — NOT implemented here).

- **The signal model** — `EngineeringSignal`: the deterministic logical
  identity (`sha256` over tenant + project + environment +
  `logicalFailureKey` — the same logical failure across runs and sources
  converges on ONE identity; a different tenant/project/environment/failure
  NEVER collapses), the append-only `SignalOccurrence[]` history (every
  occurrence preserves its raw observation reference AND raw payload
  VERBATIM plus the convergence reasoning — never reduced to a hash), and
  the per-release correlation + advisory regression state.
- **The TEMPORARY intake seam** — `RawObservationInput`: the documented
  WORK-056 compatibility boundary (delegated when WORK-056 lands).
  Fail-closed on the closed `SIGNAL_SOURCES` /
  `SIGNAL_SEVERITIES` vocabularies (the severity vocabulary is the
  repository's existing critical/high/medium/low — the WORK-041
  maintenance precedent), missing scope dimensions, invalid RECORDED
  observation times, missing references, and missing raw payloads.
- **Deduplication** — the `EngineeringSignalRepository` PORT with the
  in-memory adapter as the composition default (this Work Order authorizes
  NO schema migration; the WORK-064/066 port precedent). The PostgreSQL
  keyed-uniqueness contract — the DATABASE constraint (PRIMARY KEY +
  UNIQUE identity fingerprint), not an application race, decides the
  winner under true two-actor concurrency — is proven by the real-PG
  integration suite against a test-schema table implementing the same
  port (two independent connections; the mutation leg proves the
  same-key test FAILS without the constraint).
- **Release correlation** — RECORDED release identities only: the
  caller-supplied `ReleaseCorrelationContext` carries the recorded
  reference + boundary time + declared provenance
  (`validation-run-release-ref` | `caller-declared`). Repository truth: NO
  release authority exists (verified: no `wfos_releases`, no release
  service; the ONLY recorded release references are the WORK-064
  POST_RELEASE runs' `releaseRef` — consumed as the occurrence-level
  causal binding). WORK-067 NEVER infers a release identity from a
  timestamp, a commit, a deployment URL, or a branch name. The causal
  discipline: a signal causally bound to release A is REJECTED for
  release B (`causal-binding-mismatch` — the wrong-release
  discrimination); unbound signals correlate only via the explicitly
  recorded caller-declared basis WITH post-release-window time overlap;
  project-scope mismatches fail closed.
- **Regression identification (ADVISORY)** — per correlated release: the
  deterministic boundary split (before = `observedAt < releasedAt`,
  after = `>=`); absent-before + present-after → `likely_regression`;
  present-before-and-after → NOT a regression merely because the release
  happened; severity escalation on the boundary-adjacent occurrences (the
  LAST pre-release and FIRST post-release, deterministic ordering) via the
  repository's severity ordering — an increase is regression-relevant, a
  DECREASE is never promoted; NO correlation → the assessment is
  explicitly `unavailable` with `likelyRegression: null` (a failure signal
  NEVER becomes silently healthy).
- **The WORK-064 consumption adapter** — `validationRunToObservationInputs`:
  a COMPLETED run's typed outcome becomes observations through the
  authority's public record type (never re-implemented admission,
  finalization, or health evaluation); every `validation_failure` becomes
  one observation per failed expectation (nothing dropped — a missing
  observation is an explicit WORK-064 failure); `effect_policy_violation`
  and `environment_error` each become one typed observation; a `healthy`
  run records NO failure signal (the honest no-signal case — NOT a silent
  conversion). The severity mapping is the documented deterministic
  assessment (the WORK-041 detector precedent): validation_failure →
  `high`, effect_policy_violation → `critical`, environment_error →
  `medium`. The service-level `ingestValidationRun` consumes the run
  through the authority's public `findRun` boundary (fail-closed on
  unknown runs, un-completed runs, and tenant-scope mismatches).
- **The advisory boundary** — the service surface is
  ingest/correlate/read ONLY: no verification verdicts or evidence
  (/verification), no Work Item or workflow transitions (/work-items +
  /workflows + the future WORK-068), no architecture/review mutation, no
  code mutation, no scheduling/execution (WORK-066/065 — zero imports
  from either domain), no permanent signal intake authority (WORK-056
  owns the future taxonomy). 20 static-architecture invariants pin the
  no-second-authority matrix.

**Verification on the branch:** the engineering-signals suite (84 tests:
identity 11 + dedup 14 + release correlation 9 + regression 11 +
provenance 6 + advisory boundary 3 + cross-source 6 + concurrency 5 +
mutation 6 + validation adapter 10 + composition 3) + the real-PG
two-actor suite (6 tests, `WORKFLOWOS_DATABASE_URL`) + 23 new
static-architecture checks (881/881 total on the post-#104 reconciled
head — the 858 main baseline with WORK-066's invariants + the 23 WORK-067
additions) + the WORK-064/065/066 regressions
+ the full backend regression on real PostgreSQL. See the PR body for the
exact counts on the final head.

**Known limitations (documented honestly):** the signal repository is
in-memory (the non-durable boundary — signals are re-derivable
deterministically from re-delivered observations; the durable ACR binding
point is the port); release correlation requires caller-supplied RECORDED
release contexts (no release authority exists — the architectural gap is
WORK-069's future territory, recorded in
`spec/architecture/v1.1/evidence-provenance-model.md` §9); the intake
normalization is the TEMPORARY seam until WORK-056 lands; no runtime drive
surface is wired (no API route/job handler — the future governed
consumers decide); the correlation state after a concurrent ingest is
re-derived through the explicit `correlateToReleases` call (no hidden
side effects).

### Reconciliation record (2026-09-01 — appended by the post-#102 rebase)

MID-DELIVERY, the architect MERGED the parallel WORK-066 (PR #102 → squash
`0a506b1`; main advanced `5f0b058` → `0a506b1` — the branch's in-flight
activation record is now ON main, awaiting the §34.8/ADR-0007 finalization).
Per the declared ADR-0003 coordination and the WORK-065 PR #97
post-#100 reconciliation precedent, the WORK-067 branch was REBASED onto
the post-#102 mainline:

- the shared `backend/src/app.ts` / `backend/tests/architecture/
  static-architecture.test.ts` / `backend/vitest.config.ts` integration
  surfaces now carry BOTH work orders' additions (the scheduler + the
  signal service composed side by side; the WORK-066 invariant block +
  the WORK-067 invariant block; both test-suite includes);
- the derived governance state was recomputed for the combined live
  truth (58 complete + TWO in-flight records: WORK-066 merged-unfinalized
  + WORK-067 the reconciled implementation);
- the governance snapshot re-pins hold for the PAIR (inFlight
  `['WORK-066', 'WORK-067']`; the merged-pair conflict surface partners);
- the full verification battery re-runs on the reconciled head (see the
  PR body for the final counts).

No WORK-066 semantics were modified: the scheduler's surface is
byte-identical to the merged main version; the WORK-067 additions are
purely additive beside it. The architect's review + merge remain the
completion gate.

### Post-#104 reconciliation record (2026-09-01 — appended by the second rebase; the post-#102 record above is preserved as dated history)

The WORK-066 post-merge finalization (§34.8/ADR-0007) landed as PR #104
(merged as `69f2edf`): WORK-066 is now COMPLETE + FINALIZED on main (59/59
recorded work orders complete) and the pre-finalization red window is
CLOSED. Per the same reconciliation precedent, the WORK-067 branch was
REBASED AGAIN onto the post-#104 mainline:

- the shared integration surfaces keep BOTH work orders' additions
  (the scheduler + the signal service composed side by side; both
  invariant blocks; both test-suite includes — unchanged from the
  post-#102 reconciliation);
- the derived governance state was recomputed for the CURRENT truth
  (59 complete + the ONE in-flight record: WORK-067; the ADR-0003
  coordination with WORK-066 is preserved as DURABLE HISTORY — the
  partner is complete, the coordination contract's HISTORY exemption
  applies, no mutuality is required);
- the governance snapshot re-pins hold for the SINGLE live item
  (inFlight `['WORK-067']`; the conflict surface partner expectations
  against the complete WORK-066);
- the full verification battery re-runs on the reconciled head — the
  pre-existing red-window failures that carried the first delivery are
  expected GREEN now (the finalization closed them; see the PR body for
  the final counts).

No WORK-066 finalization semantics were absorbed into this branch: the
finalization's own governance changes were taken from MAIN (the canonical
base truth), and WORK-067 remains the ONLY additional active
implementation. The architect's review + merge remain the completion
gate.
