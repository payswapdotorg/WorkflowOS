# WORK-065 — Repository Mapping + Real-Browser Evidence

Status: evidence (a durable architecture/engineering evidence artifact under
the repository's existing governance/validation/evidence taxonomy). This
artifact is **evidence**, not normative and not authoritative: it records
what was empirically observed + the repository-mapping rulings that shaped
the implementation. It does not directly mutate normative or authoritative
state.

Provenance: produced by the WORK-065 implementation agent (the architect's
2026-08-30 implementation instruction after the WORK-064 finalization
`f9ba02f`). The implementation is on branch `feat/work-065-browser-validation-agent`;
NOT merged; NOT verified — the architect's review and the merge gate remain
the only completion event (§34.8/ADR-0007).

---

## 1. The authority split (the validation-substrate decision)

WORK-065 is the EXECUTION MECHANISM for ValidationJourneys declared under
WORK-064's authority. The split is:

```text
WORK-064 (Continuous Product Validation)
    the domain/model authority — ValidationJourney, EffectPolicy,
    TestIdentity, Environment, ExpectedObservation, Evidence
        ↓ declares (admitValidationRun / finalizeValidationRun /
          mapValidationOutcomeToVerification)
WORK-065 (this Work Order)
    the synthetic browser execution mechanism
        ↓ executes under (the declared EffectPolicy, enforced at
          execution time — fail closed)
the existing Execution Authority (the ONE execution boundary; the browser
agent is a tool-runtime consumer, not a second execution authority)
        ↓ observes into
the EXISTING /verification authority (evidence is mapped through its public
attachEvidence boundary — claim authority, server-side classification)
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

## 2. Repository mapping (the implementation rulings)

### 2.1 Location

`backend/src/browser-validation/` — application-layer capability OUTSIDE
`src/modules/` (the §34 benchmark / execution-policy / orchestration /
agent-roles / continuous-validation precedent; NOT the 18th frozen module).
The frozen module set stays at 17.

### 2.2 The browser abstraction (WORK-036 reuse — NO second framework)

Repository inspection proved the canonical browser infrastructure is
`backend/src/platform/tools/browser-tool-executor.ts` (WORK-036): the
`BrowserToolExecutor` + the neutral `BrowserDriver` PORT
(`open`/`click`/`type`/`extract`/`screenshot`). The browser validation agent
CONSUMES the `BrowserDriver` port directly — it is the same port
`BrowserToolExecutor` wraps. NO second browser automation framework is
introduced.

The Playwright-backed driver adapter (`internal/playwright-browser-driver.ts`)
is the ONE place browser-automation libraries appear in the repository. It
implements the existing `BrowserDriver` port. The static-architecture
invariant (c) pins this: playwright appears ONLY in the driver adapter; no
puppeteer/CDP anywhere in the domain.

### 2.3 The WORK-064 consumption (never reimplementation)

The agent CONSUMES the `ContinuousValidationService` (WORK-064) for:
- admission (`admitRun`) — the agent never admits itself;
- finalization (`completeRun` → `finalizeValidationRun`) — the agent never
  determines health; the finalization boundary independently derives the
  match (PR #86 correction 3 — the agent's asserted `matched` is verified,
  never trusted) and the typed outcome;
- evidence mapping (`mapOutcomeToVerification` → `/verification.attachEvidence`)
  — the agent never constructs a parallel evidence store.

The static-architecture invariant (d) pins this: the domain imports
`admitRun`/`completeRun`/`mapOutcomeToVerification` and does NOT reimplement
the admission/finalization vocabulary.

### 2.4 The effect-policy enforcement (the load-bearing invariant)

The agent enforces the declared EffectPolicy at EXECUTION TIME (before every
action), not merely at admission. The classification is deterministic + closed:
- navigate / extract / screenshot → `read` (admitted under every non-FORBIDDEN
  policy);
- click / type → `mutation` (admitted under SAFE_MUTATION + ISOLATED_MUTATION
  only; rejected under READ_ONLY with a typed `effect_policy_violation`).

FORBIDDEN rejects EVERY action before execution — the browser agent performs
no forbidden actions (the architect-approved safe mechanism is the WORK-064
admission contract, NOT a browser-execution path). ISOLATED_MUTATION requires
the synthetic identity's tenant to match the environment's isolated tenant
(cross-tenant rejection is defense in depth — the WORK-064 admission boundary
already verifies it; the agent re-verifies before the mutation executes).

The static-architecture invariant (m) pins the enforcement in source.

### 2.5 The TestIdentity (presented, never minted)

The agent presents a `TestIdentitySource` to the WORK-064 admission boundary
(an unauthenticated visitor, or an already-authenticated synthetic machine
principal). It NEVER mints credentials, creates users, or impersonates a
human. The closed machine-credential provider set is `['apikey']` (WORK-002;
WORK-063's future runtime extends it). A human interactive principal is
REJECTED as a TestIdentity (the load-bearing discrimination — proven in
agent-execution.test.ts §10).

### 2.6 The no-second-authority matrix (static-architecture invariants)

14 static-architecture invariants pin the no-second-authority matrix:
(a) the domain exists + is NOT a frozen module;
(b) imports only allowed surfaces (relative continuous-validation barrel,
    @platform/*, @modules/auth + @modules/verification barrels, playwright
    [driver adapter ONLY], node:*);
(c) NO second browser automation framework;
(d) consumes the WORK-064 authority (never reimplements it);
(e) consumes the existing BrowserDriver port (WORK-036);
(f) NO second identity authority (binds, never mints);
(g) NO second verification authority (no criterion evaluation, no parallel
    evidence store);
(h) NO code mutation / PR merge / review approval / workflow transition;
(i) NO autonomous scheduling (WORK-066 owns triggers);
(j) NO signal/WorkItem creation, NO progressive release (WORK-067..070);
(k) NO durable persistence / migration (migrations stay at 58);
(l) NO secrets;
(m) the effect-policy enforcement is pinned in source;
(n) the app.ts wiring is pinned (DefaultBrowserValidationAgent constructed
    from the WORK-064 service; exposed on AppDeps; production does NOT launch
    a browser unguarded).

### 2.7 Production wiring (fail closed)

`app.ts` constructs `DefaultBrowserValidationAgent` with
`continuousValidationService` and NO driver (`driver: undefined`). Production
fails closed: every call records `environment_error` (never a silent no-op).
The `PlaywrightBrowserDriver` adapter is the explicit binding point for the
future architect-authorized production browser driver — it is NOT wired today
(no production browser is authorized). The static-architecture invariant (n)
pins that `app.ts` does NOT construct `PlaywrightBrowserDriver` (no unguarded
browser launch).

## 3. Real-browser evidence (the verification obligation)

The real-browser integration test
(`tests/browser-validation/real-browser-execution.test.ts`) launches a REAL
Chromium browser (Playwright) against a tiny local HTTP server serving a
known HTML page, and drives the `DefaultBrowserValidationAgent` through the
`PlaywrightBrowserDriver` adapter. It proves:

1. **the happy path** — navigate + extract the heading against a real browser
   → `healthy`; every observation carries the full run→journey→step→env→time
   provenance chain; the evidence mapping into `/verification` ran once with
   `claim` authority + `pass` result (healthy → pass); the evidence reference
   binds back to the existing authority's row.
2. **the selector miss** — an extract whose selector does not match against a
   real browser → the observation is explicitly MISSING (`actual: null`) →
   `validation_failure` (never healthy).

The fake-driver unit tests (`agent-execution.test.ts`, 14 tests) prove the
adversarial failure semantics deterministically:
- browser unavailable → `environment_error`;
- FORBIDDEN policy → `effect_policy_violation` (NO action executed);
- mutation under READ_ONLY → `effect_policy_violation` (partial execution);
- selector miss → `validation_failure` (actual: null);
- timeout → `environment_error`;
- missing observation → `validation_failure`;
- rejected admission → no run + no evidence;
- identity binding (unauthenticated null principal; human principal rejected);
- evidence mapping failure → run preserved + evidence null;
- no second verification authority (agent calls only `attachEvidence`);
- deterministic outcomes.

The effect-policy enforcement + plan construction tests
(`effect-policy-enforcement.test.ts`, 15 tests) prove the enforcement gate +
the closed action classification + the plan-validation rules.

## 4. Scope confirmation (what was NOT pulled in)

WORK-066 (Validation Scheduling & Change Triggers), WORK-067 (Engineering
Signal & Regression Correlation), WORK-068 (feedback-to-Work-Item
automation), WORK-069 (progressive release), WORK-070 (architecture-fitness
automation), and the customer-product dogfooding experiment are NOT pulled
into scope. The browser agent exposes NO scheduling, NO signal emission, NO
Work Item creation, NO progressive-release decisions. The static-architecture
invariants (i) + (j) pin this.

WORK-071, WORK-072, WORK-073, WORK-074 are NOT touched (their activation
state is unchanged).

## 4b. Production wiring — NOT operational (the architect's secondary observation)

Production wiring currently constructs the `DefaultBrowserValidationAgent`
with **no driver** (`driver: undefined`). Production execution is
deliberately fail-closed until another authorized component supplies a
driver: every call records `environment_error` (never a silent no-op). The
`PlaywrightBrowserDriver` adapter is the explicit binding point for the
future architect-authorized production browser driver — it is NOT wired
today (no production browser is authorized). The static-architecture
invariant (n) pins that `app.ts` does NOT construct `PlaywrightBrowserDriver`
(no unguarded browser launch).

This means WORK-065 is currently an **execution mechanism available to
future consumers** (WORK-066 scheduler — NOT implemented here), NOT an
operational production browser-validation capability. The browser-validation
contract, the enforcement gate, the evidence mapping, and the discriminating
tests are all real and proven; the production driver binding is the future
architect-authorized step. This sequencing is intentional: the safety
boundary (effect-policy enforcement, navigation-target classification,
no-second-authority matrix) must exist and be proven BEFORE a production
driver is wired.

## 4c. Navigation-target safety boundary (PR #97 architect review — the AUTHORITATIVE journey-bound provenance)

The original implementation classified EVERY `navigate` action as a `read`
action. The first correction introduced a per-action `targetPolicy` field
(still executor-supplied). The second correction moved the allowlist to the
`BrowserJourneyPlan` (still executor-constructed — the executor could
manufacture safe targets via the plan). The architect's **third REQUEST
CHANGES** correctly identified the remaining authority-boundary gap: the
allowlist's PROVENANCE was still executor-supplied.

THE INVARIANT (the architect's ruling):

> A READ_ONLY navigation is safe only when the target is declared
> read-only-safe by the authoritative journey, and the execution plan is
> proven consistent with that declaration.
>
> The browser executor must not turn an executor-supplied assertion into
> authoritative safety.

THE JOURNEY-BOUND MODEL (the final correction):

- REMOVED `readonlySafeNavigationTargets` from `BrowserJourneyPlan` and
  `BrowserJourneyPlanInput` entirely — the plan carries ONLY `journeyId` +
  `steps`. The executor constructs the plan (choosing navigate actions) but
  CANNOT carry or expand an allowlist through it (a type-level proof: the
  plan input type does not declare the field).
- ADDED `JourneyNavigationSafetyDeclaration` — a JOURNEY-BOUND authoritative
  declaration: `{ journeyId, readonlySafeNavigationTargets }`. Constructed by
  `defineJourneyNavigationSafety(journey, targets)`, which validates the
  binding (`journeyId === journey.id`) + the entry syntax (http(s), no userinfo).
- ADDED `journeyNavigationSafety` to `ExecuteValidationRunInput` — the
  authoritative declaration is carried ALONGSIDE the journey, NOT on the plan.
- The agent validates `journeyNavigationSafety.journeyId === journey.id`
  before using the allowlist (a declaration bound to a different journey is
  rejected — proven in agent-execution.test.ts §15).
- `enforceEffectPolicy` takes the journey's allowlist (from
  `journeyNavigationSafety.readonlySafeNavigationTargets`), NOT the plan's.

THE ARCHITECT'S REQUIRED REGRESSION (the authority-confusion proof):

```
authoritative journey (via defineJourneyNavigationSafety):
  readonlySafeNavigationTargets = ["https://example.com/sign-in"]

executor-created plan:
  readonlySafeNavigationTargets = ["https://example.com/sign-in", "https://example.com/delete/123"]

→ plan construction: the plan input type does NOT accept readonlySafeNavigationTargets
  (a TYPE ERROR — @ts-expect-error proves it; the executor cannot expand the set via the plan)
```

And the positive case:

```
journey: ["/sign-in"]
plan navigates to: "/sign-in"
journeyNavigationSafety.readonlySafeNavigationTargets: ["/sign-in"]

→ admitted under READ_ONLY (URL in the journey's allowlist)
```

The attack shape (`GET /delete/123` under READ_ONLY, not in the journey's
allowlist) → `unverified` → REJECTED before `page.goto()`. The browser driver
is NEVER called for a rejected navigation (7 discriminating tests in
agent-execution.test.ts §14 + 2 binding-validation tests in §15 + 4
authority-confusion tests in navigation-target.test.ts §6).

The critical distinction: the executor may choose WHICH declared-safe target
to navigate to, but it must NOT get to expand the trusted set. The trusted set
originates from the journey authority (the journey-bound declaration), not
from the executor-constructed plan.

## 4d. Navigation-safety provenance (PR #97 fourth architect review — the declaration is JOURNEY-OWNED; the input channel is CLOSED)

The architect's **fourth REQUEST CHANGES** correctly identified that the third
correction still had a forgeable channel: `defineJourneyNavigationSafety(
journey, readonlySafeNavigationTargets)` accepted an ARBITRARY target list and
merely bound it to `journey.id`. The agent's `journeyNavigationSafety.
journeyId === journey.id` check proved **identity correlation**, NOT the
**provenance of the declaration** — a caller could hand the agent a REAL
journey plus a FORGED declaration and the agent would treat the forged targets
as authoritative READ_ONLY-safe:

```
real journey J
        ↓
caller constructs JourneyNavigationSafetyDeclaration(J, ["/delete/123"])
        ↓
agent sees journeyId === J
        ↓
"/delete/123" is treated as authoritative READ_ONLY-safe        ← THE HOLE
```

THE INVARIANT (the architect's ruling, fourth round):

> A READ_ONLY navigation is safe only when the target is declared
> read-only-safe by the authoritative journey — and the proof must originate
> from the journey's canonical state, not from a second caller-provided object.
>
> The executor should be allowed to CHOOSE a target from the
> already-authorized declaration, but it should not be able to CREATE or
> REPLACE that declaration.

THE JOURNEY-OWNED MODEL (the final architecture):

- **WORK-064 owns the declaration.** `ValidationJourney` itself carries
  `readonlySafeNavigationTargets: readonly string[]` — declared, validated,
  and frozen at `defineValidationJourney` (the journey declaration boundary,
  the SAME provenance channel as `effectPolicy` and the steps). Each entry is
  validated at declaration time by `validateSafeNavigationTargetEntry`
  (non-empty string, parseable http(s) URL, no embedded userinfo — exported
  from the continuous-validation barrel). Absent → `[]` (the safe default).
- **The browser-validation domain has NO declaration surface at all.**
  `JourneyNavigationSafetyDeclaration` (type), `defineJourneyNavigationSafety`
  (constructor), and `validateAllowlistEntry` (entry validator) are REMOVED —
  there is nothing a caller can import to mint a declaration.
- **`ExecuteValidationRunInput` has NO `journeyNavigationSafety` field.** The
  declaration travels ONLY inside the journey object. The plan carries no
  allowlist (unchanged from the third correction).
- **The agent reads the allowlist from the journey's canonical state** —
  `journey.readonlySafeNavigationTargets` (fail-closed to `[]` if a
  runtime-crafted journey object carries a non-array).
- **The closed input channel is enforced at runtime.** A caller who
  shape-smuggles a `journeyNavigationSafety` property onto the input (past
  the type system) is REJECTED in the agent's §0 gate BEFORE the admission
  boundary and any browser execution: `admitted: false`, NO run created
  (proven via the run repository — the admission service is never reached),
  the driver never called, no evidence attached. The rejection applies
  REGARDLESS of content — a forged mismatched declaration AND a "matching"
  one are both rejected, because the only legitimate provenance is the
  journey itself.

THE ARCHITECT'S REQUIRED REGRESSIONS (both proven in agent-execution.test.ts §15):

```
journey J authoritative safe targets = ["/sign-in"]
caller supplies: JourneyNavigationSafetyDeclaration(J, ["/delete/123"])
        ↓
REJECTED BEFORE browser execution (and before admission — no run is persisted)
```

And the positive case:

```
journey J authoritative safe targets = ["/sign-in"]
caller requests /sign-in (via the plan — no declaration object anywhere)
        ↓
ADMITTED under READ_ONLY (the journey's canonical declaration authorized it)
```

The discriminating matrix in §15 (5 runtime tests + the barrel-absence proof):

1. the architect's literal attack (forged mismatched declaration) → rejected
   before admission, run never persisted, driver never called;
2. a forged declaration that EXACTLY MATCHES the canonical one → ALSO
   rejected (the channel itself is illegitimate — accepting a matching object
   would leave the forgeable channel open);
3. a non-object smuggled value (null) → also rejected (the gate checks the
   CHANNEL, not the content);
4. the positive control (canonical `/sign-in`, no declaration object) →
   admitted, driver called, healthy;
5. the canonical-state enforcement (no smuggle; `/delete/123` against a
   `/sign-in`-only journey) → the run is admitted but the navigation is
   rejected at the gate, driver never called — the proof originates from the
   journey's canonical state;
6. the barrel exports NO `defineJourneyNavigationSafety` /
   `JourneyNavigationSafetyDeclaration` / `validateAllowlistEntry` — nothing
   to import, nothing to mint.

Plus the type-level proofs: `@ts-expect-error` on the smuggled
`journeyNavigationSafety` input property (fails the typecheck if the field
ever returns) and the plan-input proof from the third correction (unchanged).
The static-architecture invariant (o) re-pins the whole model: the
ValidationJourney interface field, the declaration-boundary validation in
WORK-064's types, the absence of the declaration surface in browser-validation,
the closed input interface, the agent's §0 runtime gate, and the canonical
allowlist read.

The critical distinction (the architect's words): the executor may choose a
target FROM the already-authorized declaration, but it cannot create or
replace the declaration. The declaration now has exactly the same provenance
as the journey's effect policy and steps — the journey authority's own
canonical state.

## 5. Verification summary (on the implementation branch, post-fourth-correction)

- WORK-065 browser-validation suite: 91 tests (39 navigation-target [the §1
  entry-validation tests now target the WORK-064 boundary guard + the §5/§6
  journey-declaration rewrites] + 27 agent execution [14 original + 7 §14
  navigation-safety + 6 §15 provenance proofs, including the architect's
  required forged-declaration negative, the matching-declaration rejection,
  the null-smuggle rejection, the positive control, the canonical-state
  enforcement, and the barrel-absence proof] + 15 effect-policy-enforcement
  + 8 PlaywrightDriver URL-validation + 2 real-browser) — all green,
  including the real-Chromium path driving the journey-owned declaration.
- WORK-064 continuous-validation suite: 144 tests (validation-domain 38, +9
  journey-owned declaration guards: default [], frozen,
  non-array/non-string/unparseable/non-http(s)/userinfo/empty rejected at
  defineValidationJourney, the exported boundary guard) — all green.
- static-architecture: 839/839 (invariant (o) re-pinned to the
  journey-owned model: the ValidationJourney interface field + the
  declaration-boundary validation in WORK-064's types + NO declaration
  surface in browser-validation + the closed ExecuteValidationRunInput
  interface + the agent's runtime provenance gate + the canonical
  allowlist read).
- FULL suite, real PostgreSQL (the CI-equivalent, on the reconciled head):
  134 files / 2891 tests / 0 failed. FULL suite, PGlite: 2847 passed /
  0 failed / 44 real-PG-only skipped. typecheck: 0 errors. lint: 0 errors
  (2 pre-existing warnings in work-032-benchmark.spec.ts, untouched).
- governance:status: exit 0 — complete: 57; in flight: WORK-065 (this
  branch, correctly recognized); post-merge finalization 12/12 finalized,
  NO gaps. The pre-existing WORK-074 red window is GONE: the WORK-074
  post-merge finalization landed (PR #100, merged as 1e279a2) and this
  reconciliation recomputed the branch's governance state onto it
  (WORK-074 complete + finalized; the branch's snapshot tests assert
  exactly that).
- The relay-drain budget recalibration (45s→120s,
  `backend/tests/integration/agents/cross-mode-handoff.regression.test.ts`)
  that briefly rode this branch was REMOVED: out of WORK-065 scope, the
  file restored byte-identical to main truth. CI runs fresh on the
  reconciled head; any cross-mode-handoff failure on it is discriminated
  against main first (the known CI-starvation flake signature), never
  masked by budget changes in this PR.

NOT merged; NOT verified — the architect's review and the merge gate remain
the only completion event (§34.8/ADR-0007).

---

## 6. The post-#100 reconciliation (2026-08-31 — the rebase onto 1e279a2)

The WORK-074 post-merge finalization landed as PR #100 (merged as
`1e279a2`) while this branch carried the fourth-correction head `595aaba`
(rebased onto the pre-finalization mainline `cdedd0ca`). The branch was
REBASED onto `1e279a2`:

- The rebase dropped the out-of-scope relay-drain recalibration commit
  entirely (§5 above): `backend/tests/integration/agents/cross-mode-handoff.regression.test.ts`
  is byte-identical to current main — the WORK-042/WORK-065 scope boundary
  restored. No separate PR was created for it (not authorized).
- The governance state was recomputed onto the finalization truth:
  WORK-071 complete (8604c8a/PR #96), WORK-074 complete + finalized
  (cdedd0ca/PR #99 + PR #100/1e279a2), WORK-065 the ONE in-flight item
  (this branch, PR #97); the stale WORK-074 in-flight/red-window claims
  the pre-rebase branch carried (its snapshot tests asserted
  `inFlight: ['WORK-065', 'WORK-074']`) were corrected to
  `['WORK-065']` — 57/57 mainline work orders complete. The
  `merged-finalization` suite is main's version (the branch's
  WORK-071-gap accommodations were stale and reverted).
- The navigation-safety architecture is UNCHANGED by the reconciliation:
  the JOURNEY-OWNED declaration model (§4d) — `readonlySafeNavigationTargets`
  on the WORK-064 ValidationJourney, no executor-side declaration surface,
  the runtime provenance gate, the driver-never-called proofs.
- Scope audit: `git diff origin/main...HEAD --name-only` = 31 files, all
  WORK-065 implementation/tests/spec/governance — the relay test file is
  NOT among them.
- The full verification battery was re-run on the reconciled head:
  development-governance 68/68; browser-validation 91/91 (including the
  real-Chromium pair); continuous-validation 144/144; static architecture
  839/839 (the WORK-065 migration-set pin re-pinned 58 → 59 for WORK-074's
  0059_identity_runtime — the pin the rebase had to recover from the
  flattened merge resolution); backend typecheck 0 errors; backend lint
  0 errors (2 pre-existing warnings untouched); frontend typecheck
  0 errors / lint 0 errors (1 pre-existing warning) / 127 tests; full
  backend regression on real PostgreSQL 134 files / 2891 tests / 0 failed;
  PGlite 2847 passed / 0 failed / 44 real-PG-only skipped;
  governance:status exit 0 (complete: 57; in flight: WORK-065; 12/12
  merged finalized, no gaps).

NOT merged; NOT verified — the architect's review and the merge gate remain
the only completion event (§34.8/ADR-0007).
