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

### 9.1 The authority split (the validation-substrate decision)

```text
WORK-064 (Continuous Product Validation)
    the domain/model authority — ValidationJourney, EffectPolicy,
    TestIdentity, Environment, ExpectedObservation, Evidence
        ↓ declares
WORK-065 (this section — the browser agent contract)
    the synthetic browser execution mechanism
        ↓ executes under
the existing Execution Authority (the ONE execution boundary; the browser
agent is a tool-runtime consumer, not a second execution authority)
        ↓ observes into
the EXISTING /verification authority (evidence is mapped, not duplicated)
        ↓
the EXISTING /reviews authority (architect review remains the merge gate)
```

The browser agent does NOT decide:

- whether a test is authoritative (that is `/verification`);
- whether architecture is correct (that is `/architecture`);
- whether a release should ship (that is the release authority);
- whether code should change (that is `/work-items`, via WORK-068);
- whether a Work Item should be created (that is WORK-068).

It executes and observes.

### 9.2 The contract (what WORK-065 owns)

The browser agent owns the EXECUTION CONTRACT, not a particular browser
vendor. The contract is:

- **navigate** — open an http(s) URL against the declared Environment;
- **observe** — capture DOM/network/persisted/downstream observations at
  declared checkpoints, each carrying the full
  run→journey→step→environment provenance chain;
- **evidence-capture** — record observations as `ValidationObservation`
  records that the WORK-064 finalization boundary evaluates, and map the
  completed run's outcome into the EXISTING `/verification` evidence
  authority through its public `attachEvidence` boundary;
- **effect-policy enforcement** — enforce the declared EffectPolicy at
  execution time (before every action), fail closed on every forbidden or
  out-of-policy action with a typed `effect_policy_violation` execution
  error, and never relax the policy.

The agent-browser style capability (headless browser automation with
structured navigation/click/type/snapshot commands) is ONE possible
implementation of this contract. The implementation lives behind the
existing `BrowserDriver` port (the neutral navigation/inspection port
established by the tool runtime) — WORK-065 does not introduce a second
browser automation framework.

### 9.3 The execution path

```text
create validation run      (WORK-064 admission — the agent never admits itself;
                            it calls the WORK-064 service boundary)
  → launch synthetic browser  (the BrowserDriver port — fail closed when no
                               driver is configured: environment_error)
  → perform declared journey   (navigate/click/type/extract/screenshot,
                                each action effect-policy-gated before
                                execution)
  → capture expected observations  (DOM/network/persisted/downstream, each
                                     with full provenance)
  → capture failures           (a missing observation is an explicit
                                validation_failure, never a silent pass;
                                a selector/action failure is an explicit
                                validation_failure with actual: null)
  → produce raw observation provenance  (run→journey→step→environment→time)
  → return validation outcome   (WORK-064 finalization derives the typed
                                 outcome; the agent never determines health)
  → map into /verification      (the existing authority — no parallel store)
```

### 9.4 Effect-policy enforcement at execution time (the load-bearing invariant)

The browser agent MUST enforce the EffectPolicy at execution time, not
merely trust the ValidationJourney declaration. Before performing any
action, the agent classifies the action's effect and checks it against the
run's declared EffectPolicy:

- a **read** action (extract, screenshot) is admitted under every
  policy (READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION); it observes state
  and performs no mutation;
- a **mutation** action (click, type — actions that change DOM/process
  state) is admitted under SAFE_MUTATION and ISOLATED_MUTATION only; a
  mutation under READ_ONLY is rejected before execution with a typed
  `effect_policy_violation` execution error;
- a **FORBIDDEN** action is rejected before execution under every policy;
  FORBIDDEN is the admission classification for dangerous functionality —
  the agent never performs it, even when the journey declared FORBIDDEN
  and the environment admitted it behind the architect-approved safe
  mechanism (the safe mechanism is the WORK-064 admission contract; the
  agent still treats FORBIDDEN as a non-executable class);
- an **ISOLATED_MUTATION** action requires the synthetic identity's tenant
  binding to match the environment's isolated tenant; a cross-tenant
  mutation is rejected before execution.

#### 9.4.1 Navigation-target safety (the AUTHORITATIVE journey-owned provenance model)

A browser navigation is NOT unconditionally a read action. A navigation can
have externally observable side effects even without a DOM mutation:

- a GET endpoint that performs state changes (e.g. `?action=delete`, a
  one-time token consumption, an unsubscription link, a plain-path RESTful
  GET-mutation like `/delete/123`);
- a download/navigation chain that hits internal services;
- effects outside the target application's DOM.

"HTTP GET" ≠ "no side effect." The URL structure alone CANNOT prove safety —
a plain-path GET may still mutate server state, and a query string is one
possible signal of mutation, not a proof of it. The agent cannot know whether
a target GET mutates server state merely from the URL.

THE INVARIANT (the authoritative provenance):

> A READ_ONLY navigation is safe only when the target is declared
> read-only-safe by the authoritative journey — and the safety proof must
> originate from the journey's canonical state, never from a second
> caller-provided object.
>
> The browser executor must not turn an executor-supplied assertion into
> authoritative safety.

THE JOURNEY-OWNED MODEL (the authoritative provenance — PR #97 fourth
architect review correction):

The authoritative `readonlySafeNavigationTargets` allowlist is a field ON the
canonical `ValidationJourney` itself. It is declared, validated, and frozen
under WORK-064's authority at `defineValidationJourney` (the journey
declaration boundary — the SAME provenance channel as `effectPolicy` and the
steps): every entry must be a non-empty string parsing as an http(s) URL with
no embedded userinfo (`validateSafeNavigationTargetEntry`), and the frozen
declaration defaults to `[]` when absent (the safe default).

There is NO separate declaration object and NO executor input field:

- the executor-constructed `BrowserJourneyPlan` carries no allowlist (the
  plan input type does not accept `readonlySafeNavigationTargets` — a
  type-level proof);
- `ExecuteValidationRunInput` carries no `journeyNavigationSafety` field (a
  type-level proof + a runtime rejection — see below);
- the browser-validation domain exports NO declaration constructor and NO
  declaration type (there is nothing a caller can import to mint one).

The executor constructs the PLAN (choosing which navigate actions to
perform) but CANNOT create, replace, or expand the trusted safe-target set.
The enforcement gate checks each navigate URL against the JOURNEY's canonical
declaration (`journey.readonlySafeNavigationTargets` — the agent's only
source; a runtime-crafted journey object carrying a non-array value fails
closed to the empty declaration).

```text
WORK-064 ValidationJourney
    └── readonlySafeNavigationTargets (declared + validated + frozen at
        defineValidationJourney — the journey authority's own field)
              ↓ carried INSIDE the journey object (the only channel)
WORK-065 execution plan (BrowserJourneyPlan — carries NO allowlist)
              ↓
browser enforcement (classifyNavigationTarget(url, journey.readonlySafeNavigationTargets))
```

THE CLOSED INPUT CHANNEL (the runtime discrimination): if a runtime caller
shape-smuggles a `journeyNavigationSafety` property onto the execution input
anyway, the agent REJECTS the input BEFORE the admission boundary and any
browser execution (`admitted: false`, no run created, the driver never
called). A caller-supplied navigation-safety object is a provenance
violation REGARDLESS of its content — even one that "matches" the journey's
canonical declaration — because the only legitimate provenance is the journey
itself. (This eliminates the third-round defect: a
`JourneyNavigationSafetyDeclaration` constructed by a caller and bound by
`journeyId` proved identity correlation, not the provenance of the
declaration.)

Classification (`classifyNavigationTarget(url, allowlist)`):

- `forbidden` — the URL has a non-http(s) scheme or embedded userinfo
  (categorically rejected under EVERY policy, regardless of the allowlist —
  syntactic safety, defense in depth);
- `read_only_safe` — the URL is http(s), no userinfo, AND is in the journey's
  allowlist (the journey authority declared it read-only-safe) → admitted
  under READ_ONLY + every non-FORBIDDEN policy;
- `unverified` — the URL is http(s), no userinfo, but NOT in the journey's
  allowlist (no authoritative proof of safety) → rejected under READ_ONLY
  (the executor cannot assert safety and cannot supply a declaration; the
  journey must declare the target read-only-safe); admitted under
  SAFE_MUTATION / ISOLATED_MUTATION (the run has a mutation policy, so a
  potentially-mutating navigation is within policy).

An empty declaration means NO navigation is proven read-only-safe (the safe
default — every navigate under READ_ONLY is rejected).

Defense in depth: the `PlaywrightBrowserDriver` ALSO validates the URL
scheme + userinfo before `page.goto()` (the documented "http(s) URLs only"
guarantee made real). The gate is the primary enforcement; the driver is the
backstop. The browser driver is NEVER called for a navigation that the
policy boundary rejected (discrimination-proven).

This is discrimination-proven on every axis: the attack shape `GET
/delete/123` under READ_ONLY is REJECTED (not in the journey's canonical
declaration → unverified → rejected, driver never called); the forged
declaration attack (a caller-supplied `journeyNavigationSafety` object
carrying `/delete/123` against a journey whose canonical declaration is
`['/sign-in']`) is REJECTED before admission; and a matching forged
declaration is ALSO rejected (the channel itself is illegitimate). The
corresponding tests FAIL when the journey-owned check, the closed-channel
rejection, or the canonical-state enforcement is removed.

#### 9.4.2 The attack shapes (the discrimination proofs)

The canonical-state attack (no smuggle):

```text
GET /delete/123
EffectPolicy = READ_ONLY
journey.readonlySafeNavigationTargets = ['https://example.com/sign-in']  # /delete/123 NOT in it
        ↓
classified: unverified (not in the journey's canonical declaration)
        ↓
rejected under READ_ONLY (effect_policy_violation)
        ↓
the browser driver is NEVER called (page.goto() is never reached)
```

The forged-declaration attack (the fourth-review required regression):

```text
journey J: readonlySafeNavigationTargets = ['https://example.com/sign-in']   # canonical
caller supplies: journeyNavigationSafety = { journeyId: J.id,
                                            readonlySafeNavigationTargets: ['/delete/123'] }
        ↓
the agent rejects the INPUT before the admission boundary
(admitted: false, no run created, the driver is NEVER called)
        ↓
the reason: navigation-safety provenance violation — the declaration is
OWNED by the WORK-064 journey authority; the executor input has no such field
```

A positively authorized safe navigation (the control):

```text
GET /sign-in
EffectPolicy = READ_ONLY
journey.readonlySafeNavigationTargets = ['https://example.com/sign-in']  # /sign-in IS in it
        ↓
classified: read_only_safe (in the journey's canonical declaration)
        ↓
admitted under READ_ONLY
        ↓
the browser driver IS called → healthy
```

### 9.5 Evidence capture (provenance preserved)

The browser agent captures:

- DOM observations (extracted text, element presence, visibility state) at
  declared checkpoints;
- network observations (the page's main resource status code, where the
  driver exposes it) on navigation;
- persisted records (the synthetic identity's own state — observable only
  for state the identity owns, never another tenant's);
- downstream events (audit, notifications) where the run is authorized to
  observe them.

Every observation records its source (run, journey, step, environment,
timestamp). Observations map into the existing `/verification` evidence
authority as a derived artifact — the browser agent never produces
free-floating evidence, never constructs a parallel evidence store, and
never evaluates criteria (that is `/verification`).

### 9.6 Test identity (presented, never minted)

Browser runs bind to explicit `TestIdentity` semantics from WORK-064/identity
architecture. The browser agent:

- presents a `TestIdentitySource` to the WORK-064 admission boundary (an
  unauthenticated visitor, or an already-authenticated synthetic machine
  principal);
- never mints a credential, never creates a user, never impersonates a
  real production user;
- runs synthetic validation under an explicit, traceable synthetic
  principal (the closed `apikey` machine-credential provider set today,
  extended by WORK-063's future runtime);
- rejects a human interactive principal as a TestIdentity (the load-bearing
  discrimination — a real production user can never act as a synthetic test
  principal).

### 9.7 Failure semantics

```text
browser unavailable        → environment_error (typed, provenance preserved)
selector/action failure    → validation_failure (actual: null — never healthy)
timeout                    → environment_error (typed, provenance preserved)
expected observation absent → validation_failure (actual: null)
partial execution          → completed with captured observations + failures
                              for every unmet expectation (never silent)

NEVER:
  failure → empty success
  failure → silent pass
  missing observation → healthy
```

The agent cannot convert an unavailable browser, a selector failure, a
timeout, or a missing observation into a healthy outcome. The WORK-064
finalization boundary independently derives the match and the outcome —
the agent's asserted `matched` is verified, never trusted.

### 9.8 Explicit prohibitions (the no-second-authority matrix)

The browser agent MUST NEVER become:

- a **second verification authority** — evidence evaluation stays in
  `/verification`; the browser agent produces observations, not verdicts;
- a **second execution authority** — the browser agent is a tool-runtime
  consumer underneath the existing execution boundary;
- a **second workflow authority** — the browser agent does not transition
  Work Items, does not create PRs, does not merge;
- a **code-mutation authority** — the browser agent observes; it never
  modifies code because it found a failure (see §10);
- a **production destructive surface** — uncontrolled destructive side
  effects are rejected by EffectPolicy enforcement;
- a **second identity authority** — the TestIdentity is issued by WORK-063's
  identity layer; the browser agent presents it, never mints it.

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
