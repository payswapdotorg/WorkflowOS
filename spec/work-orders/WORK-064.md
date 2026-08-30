# WORK-064 — Continuous Product Validation

Status: in flight (activated 2026-08-30 by the architect — the implementation
instruction after the approved implementation plan merged to main as
`4018f42`; the activation is recorded in
`spec/development-state/program-state.json`, branch
`feat/work-064-continuous-validation`, implementation PR #86). The implementation delivers the
domain/model authority at `backend/src/continuous-validation/` (the
application-layer pattern, NOT an 18th frozen module): the closed
vocabularies (EffectPolicy × ValidationMode × ValidationTrigger × typed
outcomes), fail-closed Environment × EffectPolicy admission (FORBIDDEN never
admits in production; PRE_MERGE only behind the architect-approved safe
mechanism), TestIdentity binding as an ADAPTER over the existing `/auth`
`AuthenticatedPrincipal` (machine-credential providers only — the closed
`apikey` set today, extended by WORK-063's future runtime; human principals
rejected; NO issuance path), ValidationRun admission composing
identity + environment + policy + mode/trigger constraints (POST_RELEASE
requires an explicit caller-supplied releaseRef — no release authority
exists in the repository yet; CONTINUOUS requires explicit configuration —
no autonomous scheduling), typed observations/outcomes with the full
run → journey → step → environment provenance chain (a missing
CRITERION-REQUIRED observation is an EXPLICIT validation_failure, never
healthy — mutation-killing discriminations pinned), evidence mapping into the EXISTING `/verification`
authority through its public `attachEvidence` boundary (claim authority,
server-side classification — NO parallel evidence store), the
ValidationRunRepository PORT with the documented IN-MEMORY adapter (NO
schema migration is authorized — durable validation state is an explicit
future ACR-gated decision; migrations stay at 58), and the
DefaultContinuousValidationService composed in `buildApp` + exposed on
AppDeps for FUTURE consumers (WORK-065 browser agent, WORK-066 scheduler —
NOT implemented here). Verification on the branch: WORK-064 suite 119/119;
static architecture 804/804 (13 WORK-064 boundary invariants);
development-governance 66/66; architecture-governance 40/40; full backend
regression 2617 passed / 0 failed; typecheck/lint clean (backend + frontend).
Architectural rulings documented in
`docs/superpowers/notes/2026-08-30-work-064-repository-mapping.md`.

PR #86 review correction (2026-08-30, the architect's audit — two
domain-correctness fixes in finalization, NOTHING else changed: no new
authority, no migration, no WORK-065+ scope):

1. **Canonical expectation integrity** — `finalizeValidationRun` now
   resolves each result's expectation against the CANONICAL journey
   declaration and verifies deep structural equality
   (id/stepId/kind/description/matcher). A result retaining the id but
   altering the matcher and claiming `matched: true` is a typed
   `FINALIZE_EXPECTATION_CANONICAL_MISMATCH` rejection: health can never be
   derived from an executor-supplied expectation variant. A structurally
   equal clone is accepted (the contract is canonical SHAPE, not object
   identity).
2. **Success-criteria semantics** — health is determined by
   `SuccessCriterion.requiresObservationIds` (the declared set that
   determines health), NOT the raw expectation count: an observational
   expectation not required by any criterion no longer fails the run (its
   captured actual stays provenance-preserved in the run's observations;
   when a run DOES fail, every unmet expectation — required AND
   observational — is still recorded with full provenance); an unmet
   required observation fails the run exactly as before. The finalize
   boundary additionally rejects hand-crafted journeys with empty or
   unknown-referencing criteria (defense in depth — health is never
   vacuous).

Discriminating regressions added in
`backend/tests/continuous-validation/outcome-provenance.test.ts` (§6+§7:
seven of them FAIL on the pre-correction implementation — the
pre-correction pin asserting the wrong every-expectation semantics was
inverted); the full WORK-064/governance/static/regression verification was
re-run on the correction head.

PR #86 re-review correction (2026-08-30, the architect's REQUEST CHANGES on
the corrected implementation — ONE remaining integrity gap in the same
finalization boundary, NOTHING else changed: no new authority, no
migration, no WORK-065+ scope):

3. **Derived match integrity** — after corrections 1–2, the finalizer
   verified the canonical expectation but still determined success from
   the caller-supplied `result.matched`. The finalizer now derives the
   match itself — `evaluateObservation(canonicalExpected, actual)`, the
   authoritative deterministic evaluator — and the success-criteria
   evaluation reads the DERIVED value, never the assertion. The supplied
   `result.matched` is treated as an ASSERTED value that must equal the
   derived value and otherwise is rejected (typed
   `FINALIZE_MATCH_ASSERTION_MISMATCH`): an executor submitting
   `expected = canonical, actual = incorrect, matched: true` can no longer
   fabricate a healthy result (and `actual = correct, matched: false` can
   no longer fabricate a failure). Honest executors are unaffected — every
   legitimate result constructor already derives `matched` through
   `evaluateObservation`.

Discriminating regressions added in
`backend/tests/continuous-validation/outcome-provenance.test.ts` (§8, the
four required directions + two supporting: 4 of the 6 FAIL on the
pre-correction head `71f9e18` — proven both ways); the full
WORK-064/governance/static/regression verification was re-run on the
correction head (WORK-064 suite 135/135; static architecture 804/804;
governance suites 125/125; full backend regression 2633 passed / 0 failed).

Issued by: the research-driven v1.1 evolution (the continuous product
validation roadmap — the closed-loop software engineering control system
extension to v1.1). This Work Order establishes the continuous product
validation domain model. Activation requires the architect's authorization
and is recorded in `spec/development-state/program-state.json` (the
activation was recorded 2026-08-30 — see the status header above).

Dependencies: WORK-048 (Developer Workbench — the user-facing surface whose
journeys are validated), WORK-050 (Unified Execution UX — the unified
execution surface whose journeys are validated), and WORK-063 (Identity and
Access Layer — proposed in PR #81 at issuance and now COMPLETE: merged as
`8dac9c4` on 2026-08-30, spec-only, finalized §34.8/ADR-0007; the validation
journey model needs authentication to model sign-up/sign-in/password-reset
journeys honestly). Where a journey does not require authentication (e.g.
public read paths), the WORK-063 dependency is not exercised, but the model
must still account for it.

Downstream: WORK-065 (Synthetic Browser Validation Agent) executes
ValidationJourneys under this Work Order's authority; WORK-066 (Validation
Scheduling & Change Triggers) decides when they run; WORK-067 (Engineering
Signal & Regression Correlation) consumes their failure evidence.

## Objective

Establish the domain/model contract for continuous product validation: what a
meaningful user workflow is, how a synthetic run exercises it, how side
effects are classified and bounded, what the system expects to observe, and
how observations become evidence — WITHOUT becoming a second verification, a
second workflow, or a second execution authority.

Functional testing, synthetic product validation, and runtime observation
are three complementary proof classes. This Work Order owns the SECOND:
synthetic product validation. It does not own functional testing (which
remains in `/verification` per existing authority) and it does not own
runtime observation (which remains in the existing runtime/audit authorities
of v1.0).

## The domain model (the contract)

```text
ValidationJourney
    a meaningful user workflow (sign up, sign in, create project,
    create task, invite member, checkout, password reset, …).
    Declares: required identities, environment binding, effect policy,
    expected observations, success criteria.

ValidationRun
    one synthetic execution of a ValidationJourney under a specific
    Environment, producing Evidence. Re-runnable, comparable across
    releases.

TestIdentity
    the synthetic principal the run acts as (a test user, a test
    service account, a test tenant). Never a real production user.

Environment
    the deployment the run executes against (preview/isolated for
    PRE_MERGE; the real production deployment for POST_RELEASE /
    CONTINUOUS, under the EffectPolicy).

EffectPolicy
    the side-effect classification binding the run:
        READ_ONLY
        SAFE_MUTATION
        ISOLATED_MUTATION
        FORBIDDEN
    Production synthetic validation must NEVER perform uncontrolled
    destructive side effects. Dangerous functionality requires a sandbox,
    a synthetic identity, a test tenant, a test payment instrument,
    controlled external integrations, or another explicitly approved safe
    mechanism.

ExpectedObservation
    what the run expects to observe at each step (DOM state, network
    response, persisted record, downstream event). An observation that
    does not match its expectation is a validation failure.

Evidence
    the durable record the run produces. Maps into the EXISTING
    /verification evidence authority — never a parallel evidence store.
```

## Effect policy (the safety contract)

The EffectPolicy is the load-bearing safety invariant of this Work Order. A
synthetic run is admitted only when its declared effect policy is one the
target Environment is authorized to accept.

```text
READ_ONLY          — observes state, performs no mutation.
SAFE_MUTATION      — mutates only state the synthetic identity owns.
ISOLATED_MUTATION  — mutates state inside an isolated test tenant/sandbox.
FORBIDDEN          — the action is forbidden in synthetic runs in this
                     environment (production destructive operations, real
                     payments, real external integrations without a
                     controlled test double).
```

For dangerous functionality (real checkout, real external integration, real
destructive mutation) the journey MUST declare FORBIDDEN in production and
require either:

- a sandboxed preview environment (PRE_MERGE mode);
- a synthetic identity inside an isolated test tenant (ISOLATED_MUTATION);
- a test payment instrument / test external integration approved for
  synthetic use;
- or another explicitly architect-approved safe mechanism.

The browser agent (WORK-065) is an EXECUTION MECHANISM for the
EffectPolicy. It is NOT an authority: it cannot relax a FORBIDDEN, cannot
elevate READ_ONLY to SAFE_MUTATION, and cannot bypass the policy. The policy
is declared in the ValidationJourney and enforced before the run is admitted.

## Authentication is part of the journey

A meaningful customer journey typically begins with a human signing in. The
validation model must therefore exercise the real authentication path
(OAuth/OIDC, email) — NOT a shared demo key. WORK-063 (Identity and Access
Layer) is the dependency that makes this honest: synthetic identities are
scoped service accounts with capability-scoped credentials, never a single
shared bootstrap key.

Until the runtime identity layer that WORK-063 specifies is implemented
(the Work Order is merged and complete as the architecture decision; the
runtime implementation remains future architect-gated work), journeys that
require authentication must either:

- declare FORBIDDEN for the authenticated steps (and exercise only the
  pre-authentication surface); or
- run only in PRE_MERGE preview environments that provision a synthetic
  identity through an explicitly architect-approved bootstrap.

The demo-key login is NOT a permanent customer login mechanism and must not
be encoded into the ValidationJourney contract as if it were.

## Dogfooding (WorkflowOS-as-a-product)

WorkflowOS must be able to use its own product-development workflow to build
and maintain a customer product, and it must be able to test that product
using realistic synthetic-user journeys. The canonical dogfood flow:

```text
Customer intent
    ↓
WorkflowOS planning
    ↓
Work Items / Work Orders
    ↓
architecture checkpoint
    ↓
agent execution
    ↓
verification
    ↓
architect review
    ↓
GitHub / release
    ↓
synthetic product validation   ← this Work Order
    ↓
engineering signals            ← WORK-067
    ↓
new governed Work Item          ← WORK-068
```

The same loop applies when WorkflowOS itself is the customer product: the
WorkflowOS repository, its architecture, its Work Items, its agents, its
validation, its feedback, and its evolution all run inside the same control
system.

## Operating modes

Three validation modes are persisted in
`spec/architecture/v1.1/continuous-validation-lifecycle.md` and summarized
here:

- **PRE_MERGE** — preview/isolated environment; purpose: catch integration
  regressions before merge.
- **POST_RELEASE** — immediately after production release; purpose: confirm
  the new release works in the real deployment.
- **CONTINUOUS** — scheduled/event-driven; purpose: detect regressions after
  deployment.

Each mode binds the EffectPolicy and the assurance level. PRE_MERGE may
permit ISOLATED_MUTATION; POST_RELEASE and CONTINUOUS must default to
READ_ONLY or SAFE_MUTATION only, with FORBIDDEN for destructive operations.

## Failure → Work Item semantics (the invariant)

A validation failure MUST NOT be silently discarded, converted into a false
healthy state, or directly converted into an ungoverned code change. The
canonical failure flow:

```text
Validation failure
    ↓
evidence (provenance preserved)
    ↓
Engineering Signal (WORK-067)
    ↓
correlation / deduplication
    ↓
governed assessment
    ↓
Work Item (WORK-068, through the existing /work-items authority)
```

The browser agent (WORK-065) observes. The signal system (WORK-067)
assesses. The Work Item system (WORK-068, the existing `/work-items`
authority) governs change. The architect governs implementation review. No
browser agent may directly modify code because it found a failure.

This invariant is especially important given the earlier Workbench provenance
defect (the historical case where observations were not bound to durable
provenance). This Work Order makes the binding explicit.

## Evidence provenance (the model)

Validation observations do NOT create a second evidence authority. The model
distinguishes:

```text
raw observation
    ↓
validation result
    ↓
formal verification evidence (the EXISTING /verification authority)
```

and preserves provenance between them. A ValidationRun's Evidence record is a
derived artifact (per `spec/architecture/v1.1/artifact-taxonomy.json`) that
references, but does not replace, formal verification evidence. See
`spec/architecture/v1.1/evidence-provenance-model.md`.

## Explicit prohibitions

WORK-064 must NEVER become:

- a **second verification authority** — formal evidence evaluation stays in
  `/verification`; validation evidence is derived and provenance-bound;
- a **second workflow authority** — validation runs are not workflow state;
  they do not transition Work Items;
- a **second execution authority** — the browser agent is a mechanism, not
  an authority; the existing execution boundary (WORK-027/034/042) remains
  the ONE execution authority;
- a **second identity authority** — synthetic identities are scoped service
  accounts issued under WORK-063's identity layer; this Work Order does not
  mint its own principals;
- a **production destructive surface** — uncontrolled destructive side
  effects are FORBIDDEN by the EffectPolicy contract.

## Required invariants

1. Each ValidationJourney declares exactly one EffectPolicy.
2. READ_ONLY journeys perform no mutation; SAFE_MUTATION journeys mutate only
   synthetic-owned state; ISOLATED_MUTATION journeys are bound to an
   isolated test tenant/sandbox; FORBIDDEN actions are never admitted.
3. Each ValidationRun carries a TestIdentity (a synthetic principal, never a
   real production user).
4. Each ValidationRun binds an Environment (preview, isolated, or production
   — with the EffectPolicy the environment is authorized to accept).
5. Production synthetic validation never performs uncontrolled destructive
   side effects (real payments, real external integrations, real destructive
   mutations) — these are FORBIDDEN unless an explicitly approved safe
   mechanism exists.
6. A validation failure is never silently discarded, never converted into a
   false healthy state, and never directly converted into an ungoverned code
   change.
7. Validation evidence maps into the existing `/verification` evidence
   authority — provenance preserved, never a parallel evidence store.
8. The browser agent is an execution mechanism, not an authority.
9. Synthetic identities are scoped service accounts under WORK-063's identity
   layer; the demo-key login is not encoded as a permanent customer login.
10. Authentication-required journeys exercise the real authentication path
    (OAuth/OIDC, email), not a shared bootstrap key.

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **effect policy enforcement** — a FORBIDDEN action declared in production
   is rejected before the run is admitted (fail closed, typed error);
2. **environment binding** — a SAFE_MUTATION journey cannot run against an
   environment authorized only for READ_ONLY;
3. **synthetic identity isolation** — a TestIdentity cannot act as a real
   production user (discrimination-proven);
4. **failure-to-signal binding** — a validation failure produces an
   Engineering Signal (WORK-067) with provenance preserved (the failure
   cannot be silently dropped);
5. **no false-healthy** — a failed run cannot be recorded as healthy
   (mutation/discrimination: removing the failure-recording path makes the
   corresponding test FAIL);
6. **evidence provenance** — a ValidationRun's Evidence references, but does
   not replace, formal verification evidence in `/verification`;
7. **no second authority** — static architecture invariants for the
   no-second-verification/no-second-workflow/no-second-execution/no-second-
   identity matrix pass.

## Scope

Allowed: the ValidationJourney, ValidationRun, TestIdentity, Environment,
EffectPolicy, ExpectedObservation, and Evidence domain model; the operating
modes (PRE_MERGE/POST_RELEASE/CONTINUOUS); the dogfooding canonical flow;
the failure→Work Item semantics; the evidence provenance binding to
`/verification`; the required proofs above.

Forbidden: runtime implementation of the browser agent (WORK-065), the
scheduling engine (WORK-066), the signal runtime (WORK-067), the feedback
converter (WORK-068), progressive release (WORK-069), or architecture
fitness (WORK-070) — those belong to their own Work Orders. Forbidden:
implementing authentication (WORK-063), execution (existing execution
authorities), or verification (existing `/verification`). Forbidden for THIS
change: any runtime code at all (this task delivers the Work Order and the
domain-model contract only).

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - spec/architecture/v1.1/
      - spec/development-state/dependency-state.json
      - spec/development-state/frontier-state.json
      - spec/governance/future-roadmap.json
      - spec/dependency-graph.md
    reason: the v1.1 evolution package — concurrent authors must coordinate
      on the shared spec surface (one canonical dependency graph, one
      roadmap sequence).
  - migrations: []   # no schema migration in this Work Order
  - authorities:
      - /verification   # evidence maps into the existing verification authority
      - /work-items     # failure→Work Item flows through the existing work-items authority
    reason: the Work Order CONSUMES these authorities; it must not duplicate
      them. Concurrent Work Orders that AUTHOR them (none planned) would
      conflict.
  - dependencies:
      - WORK-063   # complete — merged as 8dac9c4 via PR #81 (spec-only), finalized §34.8/ADR-0007
      - WORK-048   # complete
      - WORK-050   # complete
    reason: the dependency surface itself; WORK-063 is the load-bearing
      identity dependency for authenticated journeys.
protectedSurfaces:
  - spec/architecture/v1.1/validation-model.md
  - spec/architecture/v1.1/continuous-validation-lifecycle.md
  - spec/architecture/v1.1/evidence-provenance-model.md
  - spec/architecture/v1.1/dogfooding-model.md
  - spec/work-orders/WORK-064.md
```

An Architect LLM may mechanically determine the state of WORK-064 as:
`READY` when WORK-048, WORK-050, and WORK-063 are complete (ALL THREE are
complete as of 2026-08-30 — WORK-063 merged as `8dac9c4` via PR #81,
spec-only, and finalized §34.8/ADR-0007 — so WORK-064 is
DEPENDENCY-ELIGIBLE; activation remains the architect's authorization, and
WORK-064 is NOT activated and NOT started); `BLOCKED` while any declared
dependency is incomplete; `PARALLEL-SAFE` with
WORK-053..061 (independent v1.1 evolution track — different surfaces);
`CONFLICTING` with any future Work Order that authors a second verification,
identity, or execution authority.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second verification, workflow, execution, or identity authority;
- production destructive side effects without an approved safe mechanism;
- a browser agent with code-mutation authority;
- encoding the demo-key login as a permanent customer login;
- changing the frozen v1.0 architecture version.

## Definition of done

- The ValidationJourney/ValidationRun/TestIdentity/Environment/EffectPolicy/
  ExpectedObservation/Evidence domain model is persisted in
  `spec/architecture/v1.1/validation-model.md`.
- The operating modes (PRE_MERGE/POST_RELEASE/CONTINUOUS) are persisted in
  `spec/architecture/v1.1/continuous-validation-lifecycle.md`.
- The evidence provenance model is persisted in
  `spec/architecture/v1.1/evidence-provenance-model.md`.
- The dogfooding canonical flow is persisted in
  `spec/architecture/v1.1/dogfooding-model.md`.
- All required invariants hold with objective evidence (the required proofs
  above, including mutation/discrimination tests).
- Static architecture invariants for the no-second-authority matrix pass.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-064 scope; independent Architect Review approves;
  WORK-064 is marked VERIFIED before WORK-065/066/067 become eligible on it.
