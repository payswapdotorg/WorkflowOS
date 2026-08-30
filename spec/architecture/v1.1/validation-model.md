# WorkflowOS v1.1 — Continuous Product Validation Model

Status: proposed. This document persists the domain/model contract for
continuous product validation (WORK-064). It does not implement runtime
behavior. It is the design-time authority for the validation domain model;
the runtime implementation (when authorized) lives in the backend under
WORK-064.

## 1. The domain model

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
    Issued under WORK-063's identity layer.

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
    destructive side effects.

ExpectedObservation
    what the run expects to observe at each step (DOM state, network
    response, persisted record, downstream event). An observation that
    does not match its expectation is a validation failure.

Evidence
    the durable record the run produces. Maps into the EXISTING
    /verification evidence authority — never a parallel evidence store.
```

## 2. ValidationJourney

A `ValidationJourney` is the design-time declaration of a meaningful user
workflow. It is owned by WORK-064's authority and consumed by WORK-065's
browser agent (the execution mechanism).

A `ValidationJourney` declares:

- **identity**: the TestIdentity class the journey requires (an
  unauthenticated visitor, an authenticated user, a service account, an
  organization owner, …);
- **environment binding**: the operating modes the journey is admitted
  in (PRE_MERGE only, PRE_MERGE + POST_RELEASE, or all three);
- **effect policy**: the side-effect class the journey performs
  (READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION, FORBIDDEN);
- **steps**: the ordered sequence of actions (navigate, click, type,
  observe, assert) with their expected observations;
- **success criteria**: the conditions the run must satisfy to be
  recorded as healthy;
- **failure semantics**: what a failure at each step produces (an
  Engineering Signal through WORK-067, never a silent drop).

Example journeys (illustrative):

```text
sign up            — visitor → email/OAuth → organization → first project
sign in            — returning user → email/OAuth → dashboard
create project     — authenticated user → project form → project surface
create task        — project member → task form → task surface
invite member      — organization owner → invite form → member acceptance
checkout           — customer → payment → confirmation (test instrument)
password reset     — user → reset request → email → new password → sign in
```

## 3. ValidationRun

A `ValidationRun` is one synthetic execution of a `ValidationJourney`
under a specific `Environment`, producing `Evidence`. It is re-runnable
and comparable across releases (the same journey run against release N and
release N+1 should produce comparable evidence; a divergence is a
regression candidate).

A `ValidationRun` records:

- the `ValidationJourney` it executes;
- the `TestIdentity` it acts as;
- the `Environment` it executes against;
- the `EffectPolicy` it is bound to;
- the `ExpectedObservation` set it evaluated;
- the `Evidence` it produced (with provenance);
- the operating mode (PRE_MERGE / POST_RELEASE / CONTINUOUS);
- the trigger (PR / deployment / release / scheduled / runtime signal /
  architecture change / security finding / dependency change);
- the outcome (healthy / validation_failure / effect_policy_violation /
  environment_error).

## 4. TestIdentity

A `TestIdentity` is the synthetic principal a `ValidationRun` acts as.
It is NEVER a real production user. It is issued under WORK-063's identity
layer (a scoped service account with capability-scoped credentials) or,
for unauthenticated journeys, the null identity.

A `TestIdentity` carries:

- the principal class (visitor, user, service account, organization
  owner, project member, …);
- the capabilities the run is scoped to (read Work Orders, create
  branch, create PR, …);
- the tenant binding (which test tenant or sandbox the identity belongs
  to — for ISOLATED_MUTATION journeys);
- the provenance (the issuing identity layer, the issuance reason).

A `TestIdentity` CANNOT:

- mint itself (the browser agent presents it; it never creates it);
- act as a real production user (discrimination-proven);
- exceed its declared capabilities (the EffectPolicy enforcement rejects
  out-of-capability actions).

## 5. Environment

An `Environment` is the deployment a `ValidationRun` executes against.
The operating mode binds the environment:

- **PRE_MERGE** — a preview/isolated environment (a preview deployment of
  the PR's branch, an isolated test tenant, a sandbox);
- **POST_RELEASE** — the real production deployment, immediately after a
  release;
- **CONTINUOUS** — the real production deployment, on a schedule or event
  trigger.

An `Environment` is authorized to accept a specific set of
`EffectPolicy` values:

- a preview environment may accept READ_ONLY, SAFE_MUTATION,
  ISOLATED_MUTATION;
- the production deployment accepts READ_ONLY and SAFE_MUTATION only;
  ISOLATED_MUTATION requires an isolated test tenant; FORBIDDEN is
  rejected in production without an approved safe mechanism.

## 6. EffectPolicy

The `EffectPolicy` is the load-bearing safety invariant of the
validation model. It is the side-effect classification binding the run.

```text
READ_ONLY          — observes state, performs no mutation.
SAFE_MUTATION      — mutates only state the synthetic identity owns.
ISOLATED_MUTATION  — mutates state inside an isolated test tenant/sandbox.
FORBIDDEN          — the action is forbidden in synthetic runs in this
                     environment (production destructive operations, real
                     payments, real external integrations without a
                     controlled test double).
```

For dangerous functionality (real checkout, real external integration,
real destructive mutation) the journey MUST declare FORBIDDEN in
production and require either:

- a sandboxed preview environment (PRE_MERGE mode);
- a synthetic identity inside an isolated test tenant
  (ISOLATED_MUTATION);
- a test payment instrument / test external integration approved for
  synthetic use;
- or another explicitly architect-approved safe mechanism.

The browser agent (WORK-065) enforces the EffectPolicy at execution
time. It is an execution mechanism, NOT an authority: it cannot relax a
FORBIDDEN, cannot elevate READ_ONLY to SAFE_MUTATION, cannot bypass the
policy.

## 7. ExpectedObservation

An `ExpectedObservation` is what the run expects to observe at a step.
An observation that does not match its expectation is a validation
failure. Examples:

- DOM state (the expected element is present, has the expected text,
  is in the expected visibility state);
- network response (the expected status code, the expected response
  shape — headers/body where safe);
- persisted record (the expected record exists in the database, with
  the expected fields — observable only for the synthetic identity's
  own state);
- downstream event (the expected audit event, the expected notification
  — observable only where the run is authorized to observe them).

## 8. Evidence

`Evidence` is the durable record a `ValidationRun` produces. It is a
DERIVED artifact (per `spec/architecture/v1.1/artifact-taxonomy.json`)
that maps into the EXISTING `/verification` evidence authority — never a
parallel evidence store.

See [`evidence-provenance-model.md`](evidence-provenance-model.md) for
the provenance binding: raw observation → validation result → formal
verification evidence.

## 9. The browser agent (execution mechanism, not authority)

The browser agent (WORK-065) is the execution mechanism for
ValidationJourneys. It:

- reads the ValidationJourney declared by WORK-064;
- executes it under the declared EffectPolicy (which it cannot relax);
- produces observations that become Evidence in the existing
  `/verification` authority;
- never mutates code, never merges PRs, never approves reviews, never
  transitions workflow state.

The browser agent is BENEATH the validation authority established by
WORK-064. It is not another verification authority. It uses the existing
`/verification` authority for formal evidence where appropriate.

## 10. The invariant

> No customer-product validation failure may be silently discarded,
> converted into a false healthy state, or directly converted into an
> ungoverned code change.

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

This invariant is especially important given the earlier Workbench
provenance defect (the historical case where observations were not bound
to durable provenance). The v1.1 evolution makes the binding explicit
and machine-checked.
