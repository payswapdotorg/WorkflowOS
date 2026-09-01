# WORK-069 — Progressive Release & Runtime Validation

Status: COMPLETE + FINALIZED — activated by the architect on 2026-08-31 (the WORK-069
implementation instruction; every hard edge verified complete on main:
WORK-064 `c351451` via PR #86, WORK-066 `0a506b1` via PR #102 + the PR #104
finalization, and the existing WORK-019/026/020 authorities) and implemented
on branch `feat/WORK-069-progressive-release` (see the activation record
appended below; the original Work Order contract below is preserved, not
rewritten). The completion remains gated on the architect's review + merge
(§34.8/ADR-0007 finalization follows the merge).

Issued by: the research-driven v1.1 evolution (the continuous product
validation roadmap). This Work Order establishes the progressive release
and runtime validation model — it does NOT implement runtime code.
Activation requires the architect's authorization and is recorded in
`spec/development-state/program-state.json` (this change records none).

Dependencies: WORK-064 (Continuous Product Validation — the validation
authority whose runs this Work Order binds to progressive rollout That dependency edge is now SATISFIED — WORK-064 is COMPLETE (implemented on branch feat/work-064-continuous-validation, merged by the architect as `c351451` via PR #86 on 2026-08-30 and finalized per §34.8/ADR-0007; the domain/model authority is on main at backend/src/continuous-validation/). The WORK-066 edge is likewise SATISFIED — WORK-066 is COMPLETE (implemented on branch feat/WORK-066-validation-scheduling, merged by the architect as `0a506b1` via PR #102 on 2026-08-31T16:37:09Z, squash-merged at the approved head `493ae59` — the tree identical — and finalized per §34.8/ADR-0007 by the WORK-066 post-merge finalization; the scheduling/trigger decision layer is on main at backend/src/validation-scheduling/). WORK-069 is therefore DEPENDENCY-ELIGIBLE and remains PLANNED, NOT activated, NOT started),
WORK-066 (Validation Scheduling & Change Triggers — the scheduler whose
triggers this Work Order extends with release-stage triggers). Existing
authorities consumed: deployment governance (WORK-019 — complete; the
existing merge/release authority), runtime observation capability (WORK-026
Autonomous Runtime — complete; WORK-020 Audit — complete; the existing
runtime/audit observation authorities of v1.0). Soft relationship to
WORK-059 (Operational and Release Governance — planned): WORK-069 is the
CLOSED-LOOP RUNTIME VALIDATION LAYER that CONSUMES (but does not duplicate)
WORK-059's release governance framework when WORK-059 lands; until then,
WORK-069 operates directly on the existing v1.0 release/runtime authorities.

Downstream: WORK-070 (Continuous Architecture Fitness) consumes the
runtime-validation evidence for architecture risk assessment.

## Objective

Support increasingly safe production evolution through progressive rollout
(canary / partial rollout) bound to synthetic validation and runtime
observation, with continue / halt / recover decisions — WITHOUT creating a
second release engine, a second workflow authority, or a second runtime
observation authority.

The existing deployment authority boundaries are preserved. This Work Order
is the FEEDBACK LOOP that binds validation and runtime observation to the
release decision; it does not replace the release decision itself.

## The progressive release loop

```text
release (the existing /workflows + /github + runtime authorities)
    ↓
canary / partial rollout (the existing deployment surface)
    ↓
synthetic validation (WORK-064, scheduled by WORK-066 at POST_RELEASE)
    ↓
runtime observation (the existing runtime/audit authorities)
    ↓
continue / halt / recover
    ↓
    ├─ continue → full rollout
    ├─ halt → stop the rollout; the signal feeds WORK-067 → WORK-068
    └─ recover → rollback (the existing rollback authority)
```

The continue/halt/recover decision is GOVERNED: it is not an autonomous
browser-agent decision. A halt produces an Engineering Signal (WORK-067)
that becomes a governed Work Item (WORK-068) through the existing
`/work-items` authority. A recover uses the existing rollback authority.

## Relationship to WORK-059 (Operational and Release Governance)

WORK-059 is the planned v1.1 evolution Work Order that establishes the
operational/release governance framework (SLOs, error budgets, progressive
rollout, rollback, post-release validation). WORK-069 is the
CLOSED-LOOP RUNTIME VALIDATION LAYER that:

- CONSUMES WORK-059's release governance framework when WORK-059 is
  implemented;
- until then, operates directly on the existing v1.0 release/runtime
  authorities (WORK-019, WORK-026, WORK-020);
- ADDS the synthetic-validation-bound continue/halt/recover loop that
  WORK-059 does not own (WORK-059 owns the release framework; WORK-069
  owns the closed-loop runtime validation binding).

WORK-069 does NOT duplicate WORK-059's release engine. When WORK-059 lands,
WORK-069 delegates the release mechanics to WORK-059 and focuses on the
runtime-validation binding.

## Explicit prohibitions

WORK-069 must NEVER become:

- a **second release engine** — release remains in the existing
  `/workflows` + `/github` + runtime authorities; this Work Order binds
  validation/observation to the release decision, never replaces it;
- a **second workflow authority** — workflow state transitions stay in
  `/workflows`;
- a **second runtime observation authority** — runtime observation stays
  in the existing runtime/audit authorities;
- a **second verification authority** — the synthetic validation runs it
  binds are WORK-064's; their evidence maps into `/verification`;
- an **autonomous continue/halt/recover authority** — the decision is
  governed; a halt produces a signal that becomes a Work Item through the
  existing authority; a recover uses the existing rollback authority;
- a **browser-agent code-mutation authority** — the browser agent observes;
  it never modifies code because it found a failure.

## Required invariants

1. The existing deployment authority boundaries are preserved (no second
   release engine).
2. The continue/halt/recover decision is governed, not autonomous.
3. A halt produces an Engineering Signal (WORK-067) that becomes a governed
   Work Item (WORK-068) through the existing `/work-items` authority.
4. A recover uses the existing rollback authority.
5. Synthetic validation runs bound to progressive rollout are WORK-064's;
   their evidence maps into `/verification`.
6. Runtime observation stays in the existing runtime/audit authorities.
7. When WORK-059 lands, the release mechanics are delegated to it (no
   parallel release engine).

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **no second release engine** — a progressive rollout uses the existing
   deployment surface (static architecture invariant + runtime
   discrimination);
2. **governed continue/halt/recover** — a halt produces a signal that
   becomes a Work Item; a recover uses the existing rollback authority
   (discrimination-proven against autonomous decision);
3. **runtime-validation binding** — a canary rollout is bound to
   POST_RELEASE synthetic validation and runtime observation;
4. **no second authority** — static architecture invariants for the
   no-second-release/no-second-workflow/no-second-runtime-observation/no-
   second-verification matrix pass;
5. **mutation/discrimination** — removing the governed-decision boundary,
   the runtime-validation binding, or the no-second-authority boundary
   makes the corresponding test FAIL.

## Scope

Allowed: the progressive release loop (canary, partial rollout,
synthetic-validation binding, runtime-observation binding, continue/halt/
recover); the governed-decision contract; the required proofs above.

Forbidden: the ValidationJourney domain model (WORK-064), the browser agent
(WORK-065), the scheduling engine (WORK-066), the signal runtime
(WORK-067), the feedback converter (WORK-068), architecture fitness
(WORK-070), the operational/release governance framework (WORK-059,
planned), the existing release/workflow/runtime/audit authorities. Forbidden
for THIS change: any runtime code at all (this task delivers the Work Order
only).

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - spec/architecture/v1.1/continuous-validation-lifecycle.md
      - spec/development-state/dependency-state.json
    reason: the v1.1 evolution package — concurrent authors must coordinate.
  - migrations: []   # no schema migration in this Work Order
  - authorities:
      - /workflows    # the ONE workflow authority — consumed, never duplicated
      - /github      # the ONE release/PR/CI authority — consumed
      - /verification # evidence maps into the existing verification authority
    reason: the Work Order CONSUMES these authorities; it must not duplicate
      them.
  - dependencies:
      - WORK-064   # the validation authority whose runs are bound
      - WORK-066   # the scheduler whose triggers are extended
      - WORK-019   # complete — existing deployment governance
      - WORK-026   # complete — existing autonomous runtime
      - WORK-020   # complete — existing audit
      - WORK-059   # soft — operational/release governance (planned)
    reason: WORK-064 and WORK-066 must be complete before progressive release
      can be honestly bound to validation; WORK-019/026/020 are complete
      existing authorities consumed; WORK-059 is a soft dependency (delegated
      to when it lands).
protectedSurfaces:
  - spec/architecture/v1.1/continuous-validation-lifecycle.md
  - spec/work-orders/WORK-069.md
```

An Architect LLM may mechanically determine the state of WORK-069 as:
`READY` when WORK-064 and WORK-066 are complete (WORK-019/026/020 are
already complete; WORK-059 is soft); `BLOCKED` while WORK-064 or WORK-066 is
unimplemented; `PARALLEL-SAFE` with WORK-053..061, WORK-064..068, WORK-070
(different surfaces); `CONFLICTING` with any future Work Order that authors
a second release, workflow, runtime-observation, or verification authority.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second release, workflow, runtime-observation, or verification
  authority;
- an autonomous continue/halt/recover decision (not governed);
- a browser agent with code-mutation authority;
- changing the frozen v1.0 architecture version.

## Definition of done

- The progressive release loop is persisted in
  `spec/architecture/v1.1/continuous-validation-lifecycle.md`.
- All required invariants hold with objective evidence (the required proofs
  above, including mutation/discrimination tests).
- Static architecture invariants for the no-second-authority matrix pass.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-069 scope; independent Architect Review approves;
  WORK-069 is marked VERIFIED before WORK-070 becomes eligible on it.

## Activation record (2026-08-31 — appended by the implementation)

**Activated by the architect** (the WORK-069 implementation instruction).
Repository truth at activation: `origin/main` = `26e2ada` (the 2026-08-31
dogfooding-evidence merge, PR #106 — docs-only, one Markdown evidence file;
before it `8985dab` = the WORK-067 post-merge finalization PR #105 and
`bde33cc` = WORK-067 itself via PR #103); 60/60 recorded work orders
complete, 15/15 finalized, NOTHING in flight in the canonical main state.
Every hard dependency verified against the repository: WORK-064 complete +
finalized (`c351451` via PR #86 — the validation authority whose runs the
progressive rollout binds), WORK-066 complete + finalized (`0a506b1` via
PR #102, the finalization PR #104/`69f2edf` — the scheduler whose
POST_RELEASE RELEASE-trigger leg admits the runs this layer consumes),
WORK-019/WORK-026/WORK-020 complete (the existing v1.0 deployment/runtime/
audit authorities this layer consumes); soft WORK-059 not started (per the
Work Order's explicit ruling, WORK-069 operates directly on the existing
v1.0 release/runtime authorities until WORK-059 lands). Branch:
`feat/WORK-069-progressive-release` (grown from `26e2ada`). Recorded in
`spec/development-state/program-state.json` (status `in_flight`, the
entry-level surfaces/dependencies/assurance profile + the resumption
handoff).

**Parallel coordination (ADR-0003, the wave-10 pair):** WORK-068 (Feedback →
Governed Work Items) is in flight IN PARALLEL — PR #107 is OPEN against the
same `26e2ada` base. There is NO hard edge between them (WORK-069's halt
chain produces the Engineering Signals that WORK-068 converts downstream —
consumers, never a dependency edge). Both branches touch the shared
integration surfaces `backend/src/app.ts`, `backend/tests/architecture/
static-architecture.test.ts`, `backend/vitest.config.ts`,
`spec/development-state/dependency-state.json`, and the
`spec/architecture/v1.1/` documents; each branch is independently
reviewable, no local merge, and the architect reconciles the shared surfaces
at merge time. Neither branch rewrites the other's state.

### The implemented binding model

The domain lives at `backend/src/progressive-release/` (the
application-layer pattern — NOT an 18th frozen module; the WORK-064/065/
066/067 precedent), composed in `app.ts` as `progressiveReleaseService` on
`AppDeps` (NO route surface — the Work Order authorizes the decision layer,
not a drive surface; the future governed consumers wire those).

- **The canonical flow** (`DefaultProgressiveReleaseService.
  decideProgressiveRelease` — the explicit governed invocation, never
  autonomous): the typed request validation (tenant/project/environment/
  releaseRef/stage/run — every field caller-RECORDED, never invented here)
  → the validation evidence loaded through the WORK-064 **public** `findRun`
  boundary with the full binding matrix (completed + POST_RELEASE +
  RELEASE trigger + releaseRef + tenant + environment — a mismatch is a
  TYPED halt, never a continue) → the runtime observation read through the
  existing **/runtime** authority's public `DeploymentRepository.
  findLatestForProject` (the read-only port adapter; the provider-RECORDED
  deployment state and its OWN recorded time — never an inference) → the
  recorded rollout history (the decision history IS the rollout state —
  never a second release engine) → the PURE deterministic policy → the
  governed consequences → the persisted decision record.
- **The decision policy** (pure, total, explainable —
  `deriveProgressiveDecision`, version `work-069-progressive-release-
  policy-1`): rollout-state gating first (previously recovered → halt;
  previously halted → halt; stage regression → halt), then fail-closed
  evidence gating (every unusable-validation and missing/ambiguous-runtime
  state is a typed halt), then the RECOVER cases (an effect-policy
  violation at ANY stage; a validation failure or unhealthy runtime while
  still contained at the canary — the canary exists to catch exactly this),
  then the HALT cases at the exposed stages (a validation failure, an
  environment error, an unhealthy runtime at partial/full — stop, do not
  auto-rollback), and the ONE continue cell (a COMPLETED HEALTHY validation
  + a READY runtime observation + every binding matched).
- **The halt/recover signal consequence (WORK-067 consumed):** a
  non-continue decision's failure evidence flows through the authority's
  public intake — a completed-but-failed run's every failure through
  `ingestValidationRun` (source `validation`), an unhealthy runtime through
  `ingestObservation` (source `runtime`, the deployment record's OWN
  observed time), and an evidence-gap halt (missing/unusable validation or
  a missing runtime observation) through `ingestObservation` (source
  `validation` — the rollout was asked to proceed without provable safety;
  that IS the engineering finding). When the caller recorded the release
  boundary (`releaseObservedAt`), every produced signal is release-
  correlated through the authority's own correlation engine
  (`correlateToReleases`, recordedVia `caller-declared`; the occurrence's
  own recorded releaseRef remains the CAUSAL basis). WORK-069 NEVER creates
  a Work Item — WORK-068 converts the signals downstream through the
  existing `/work-items` authority.
- **The rollback consequence (the EXISTING authority consumed):** a
  RECOVER decision invokes the existing rollback authority through its
  port. Repository truth: NO rollback authority exists today (the release
  authority is distributed across `/workflows` + `/github` + `/runtime`
  and implements no rollback trigger). The port composes UNBOUND: the
  RECOVER decision is still derived and recorded with the rollback
  explicitly NOT invoked (`ROLLBACK_AUTHORITY_UNBOUND` — the typed
  fail-closed outcome) and the failure signal already emitted, so the
  governed chain sees the un-executed recovery — NEVER a silent continue.
  NO rollback mechanics are implemented here (no hidden GitHub/Vercel
  rollback).
- **The provenance record** (`ProgressiveReleaseDecisionRecord`): the full
  decision identity chain — which release (`releaseRef`), which environment,
  which stage, which validation run, which runtime observation (the
  deployment id + status), which policy (`policyVersion`), which decision,
  and why (the reason + the deterministic explanation) — plus the signal
  outcomes, the rollback outcome, and the consumed WORK-064 outcome kind.
  One `/audit` forensic event per decided record (the WORK-020 application
  boundary).
- **The persistence ruling** (`migrations: []` — the Work Order's own
  declaration): NO schema migration. The `ProgressiveReleaseDecision-
  Repository` PORT carries the in-memory adapter (the WORK-064 run-
  repository / WORK-066 claim-store / WORK-067 signal-repository
  precedent) and exposes the consequence-durability two-phase write
  (`reserve` + `completeDecision` — no ungated single-shot save); the
  keyed-uniqueness contract (`decision_id` PRIMARY KEY +
  the identity fingerprint UNIQUE — the DATABASE constraint, not an
  application race, decides the reservation winner) is proven under real
  PostgreSQL by the two-actor integration suite; the durable binding
  point is a future ACR at the same port. **The honest boundary (the
  2026-09-01 re-review claim correction):** the protocol's strength is
  the composed adapter's — the production in-memory adapter's
  reservation is PROCESS-LOCAL (duplicate delivery and completion
  failure are guarded within one process), and CROSS-PROCESS
  consequence idempotency (process-loss survival, two processes racing)
  is NOT claimed by that composition; it is the DURABLE-adapter contract
  of the same port (proven by the real-PG suite) and exactly what the
  future ACR productionizes. The durable binding point MUST precede any
  future drive-surface activation that delivers decisions from more
  than one process (the static-architecture suite pins this declaration
  at the composition root and at the port).
- **Idempotency and independence (§13):** the deterministic decision
  identity (tenant + project + release + stage + validation run + runtime
  observation event) — a duplicate delivery returns the recorded decision
  and re-executes NOTHING (no duplicate halt action, no duplicate signal,
  no duplicate rollback, no duplicate audit event) **within the
  persistence boundary the composed adapter provides** (the scope
  established by the persistence ruling above); the same identity
  re-derived after the rollout state moved underneath it is the TYPED
  `PR_DECISION_IDENTITY_CONFLICT` (never a silent rewrite); a different
  project/stage/release/observation is an INDEPENDENT decision.
- **The consequence durability protocol (the PR #108 architect-review
  correction + the 2026-09-01 re-review claim correction):** the decision
  record is the ONLY idempotency boundary for the governed consequences,
  so it is RESERVED (insert-only, through the port's `reserve`, persisted
  to the composed boundary) BEFORE any governed consequence executes — a
  `halt`/`recover`'s consequences run ONLY for the reservation owner (the
  loser of a concurrent insert race converges and executes nothing), then
  the `completeDecision` transition (pending → executed) records their
  REAL outcomes; a `continue` reserves directly as executed (it carries
  no governed consequences, so the reservation is atomically final).
  Within the composed boundary, a crash or a concurrent delivery can
  therefore NEVER re-execute a non-idempotent consequence (a rollback
  invocation, a signal emission) for a decision identity that is already
  reserved: the re-delivery that finds a reserved-but-unresolved
  (pending) reservation fails closed with the TYPED
  `PR_DECISION_CONSEQUENCES_PENDING` — never a re-execution, never a
  clean duplicate, never a silent continue. The port exposes NO ungated
  single-shot save (the pre-correction `save`-after-consequences ordering
  is structurally impossible). The STRENGTH of this guarantee is the
  composed adapter's (the re-review's exact ruling): under a DURABLE
  (PostgreSQL-class) adapter the reservation is cross-process and
  crash-surviving — the four re-review proof cases (two independent
  service instances racing a HALT; two racing a RECOVER with rollback
  bound; process-loss retry over a fresh repository/connection seeing
  the durable pending claim; distinct repository/service instances) are
  proven by the real-PG integration suite; under the production
  in-memory adapter the reservation is PROCESS-LOCAL and cross-process
  idempotency is NOT claimed (the domain suite pins the acknowledged
  limit as a discrimination proof).

### The verification battery

The domain suites (`backend/tests/progressive-release/`): the deterministic
policy matrix (every cell typed + the severity ordering + 100-repetition
determinism), the §14 fail-closed safety matrix (missing validation,
incomplete validation, wrong mode/trigger/release/tenant/environment,
missing and ambiguous runtime observation, already-halted,
already-recovered, invalid stage transition, foreign stage), the §13
idempotency/independence matrix, the consequence-durability regression
suite (the PR #108 architect-review cases: concurrent halt deliveries,
concurrent recover deliveries with the rollback authority bound — both
the insert-race and the in-flight windows, the crash between the
consequence execution and the completion persistence, and the preserved
duplicate-delivery guarantee — plus THE ACKNOWLEDGED COMPOSITION LIMIT
discrimination proof: two SEPARATE in-memory repository instances do NOT
share the reservation, the honestly-pinned process-local boundary), and
the halt/recover signal flow (the WORK-067 authority consumed — the
release-correlated signal chain, the rollback invocation through the
port, the honest no-signal continue case, the unbound-authority
fail-closed cases — extended with the persisted pending-tombstone
assertions). The mutation/discrimination proofs prove the protections
(removing the validation binding, the runtime binding, the
governed-decision boundary, the rollback boundary, the
no-second-authority boundary, or the signal channel makes the
corresponding test FAIL). The static-architecture suite pins the
no-second-authority matrix at the source level — including INVARIANT 11
(the reserve-first consequence durability protocol: the reservation
write precedes the consequence execution which precedes the completion
write, the pending tombstone fails closed, the in-memory adapter
implements NO ungated save, and the composition's PROCESS-LOCAL boundary
+ cross-process non-claim + future-ACR-before-drive-surface declaration
are pinned at the composition root and at the port — the claim can never
outrun the composed adapter). The real-PG two-actor integration suite
proves the keyed-uniqueness contract under true concurrency (two
independent connections, no sequential-call shortcuts) — including the
four 2026-09-01 re-review proof cases mapped 1:1 (CASE 1: two
independent service instances over two connections racing the same HALT
identity → exactly one consequence; CASE 2: the same for a RECOVER with
the rollback bound → exactly one rollback invocation; CASES 3+4: the
crash window + PROCESS LOSS — the re-delivery over a FRESH repository
instance on a FRESH connection, the prior process's state entirely gone,
sees the durable pending claim and fails closed typed, the non-idempotent
counters unchanged) and the pre-existing two-actor/mutation proofs.

### The architect-review correction record (PR #108 — 2026-09-01)

The architect review of PR #108 found ONE merge-blocking correctness
defect: the governed halt/recover consequences executed BEFORE the
decision record was persisted, so a crash or a concurrent delivery could
repeat the signal emission and, once the rollback authority is bound,
potentially repeat the rollback for the same decision identity (the
in-memory production composition made the decision record the only
durable boundary, and the pre-correction ordering left NO record in the
crash window). The correction is the consequence durability protocol
recorded above: reserve (persisted, insert-only) → execute (the
reservation owner only) → complete (the pending → executed transition),
with the typed `PR_DECISION_CONSEQUENCES_PENDING` fail-closed tombstone
for the crash window — implemented WITHOUT a schema migration (the Work
Order's `migrations: []` ruling is untouched: the protocol lives entirely
at the existing repository PORT; the real-PG proofs use the test-schema
fixture table as before). The secondary observation (a malformed
non-string `releaseObservedAt` could escape as a native `TypeError`
from `Date.parse` before the `typeof` check) is corrected in the same
change: the typed `PR_INPUT_RELEASE_OBSERVED_AT_INVALID` rejection now
covers every non-string/unparseable value, with the regression matrix in
the fail-closed safety suite. The regression coverage the architect
required (concurrent halt, concurrent recover with the rollback bound,
the crash window, and the preserved duplicate guarantee) is implemented
in `backend/tests/progressive-release/consequence-idempotency.test.ts`
and extended in the real-PG integration suite.

### The architect re-review correction record (PR #108 — 2026-09-01, comment 5486874072)

The architect re-review of the corrected head (`4e38cc1`) found the
`reserve → execute → complete` correction directionally correct but the
claimed crash/concurrency guarantee NOT provided by the production
composition: `buildApp()` wires the process-local
`InMemoryProgressiveReleaseDecisionRepository`, so a restart loses the
reservation and the same logical halt/recover consequence can execute
again; the real-PG suite proved a TEST-adapter contract, not the
production cross-process guarantee. The disposition offered two
resolutions: a genuinely durable production reservation boundary, or an
explicit architectural change removing the cross-process claim.

**The resolution taken (the claim correction — no migration smuggling):**
a durable production boundary requires a production table, which the
Work Order's own `migrations: []` ruling forbids and which the architect
explicitly declined to have smuggled into WORK-069 ("raise the
appropriate governed architecture change rather than smuggling a
migration into WORK-069"). The reservation-strength claim is therefore
corrected to match the composed reality, per the 064/066/067 precedent:
the protocol and its ordering are UNCHANGED (the architect's "keep the
`reserve → execute → complete` ordering"); what changed is the CLAIM —
(1) every source/spec/doc surface now states the two-level boundary (the
port contract under a durable adapter vs. the process-local in-memory
composition — types.ts §8 THE HONEST BOUNDARY STATEMENT, the service
header, the in-memory adapter header, the app.ts composition comment,
INVARIANT 11, this Work Order's persistence ruling and protocol bullet);
(2) the production composition's non-claim is PINNED structurally — the
static-architecture suite requires app.ts to declare the process-local
reservation, the cross-process non-claim, and the future-ACR-before-
drive-surface rule, and requires the port + adapter docs to carry the
same statement (the claim can never again outrun the composed adapter);
(3) the honest limit is discrimination-tested in the domain suite (two
separate in-memory repository instances — two processes — do NOT share
the reservation: both decide, both consequences execute; that test is
the rewrite trigger for the future durable ACR).

**The four required proof cases (comment 5486874072), proven for the
DURABLE-ADAPTER contract of the port in the real-PG integration suite,
mapped 1:1:** CASE 1 — two independent service instances over two
connections racing the same HALT identity → exactly one consequence
(one decision row, one audit event); CASE 2 — the same for a RECOVER
with the rollback authority bound → exactly one rollback invocation
(the shared non-idempotent counter); CASES 3+4 — the crash window +
PROCESS LOSS: the completion fails after the consequences executed, the
record is durable and pending, and the re-delivery — over a FRESH
repository instance on a FRESH connection with a complete fresh service
stack (the prior process's state entirely gone) — SEES the durable
pending claim, fails closed typed, and re-executes NOTHING (the
non-idempotent counters unchanged across both re-deliveries).

**The durable binding point (the future ACR):** productionizing the
durable adapter (the production table + the keyed-uniqueness constraint
+ the pending-tombstone semantics + the composition wiring) is a
governed architecture change beyond WORK-069's authorized scope; the
port contract it must satisfy is already proven by the real-PG suite,
and the binding point MUST precede any future drive-surface activation
that delivers decisions from more than one process (the production
composition today wires NO route surface and an UNBOUND rollback
authority — there is no production delivery path for the decisions
yet).


## Post-merge finalization (2026-09-01 — §34.8 / ADR-0007)

PR #108 was merged as `62475bea2366e9377fe2fc42b57f58c639296974` from approved head `8ab2d6410d582642487f389ffd0ba010d729b559`. Canonical state is now `complete` with `mergedAs {pr: 108, mergeCommit: 62475bea2366e9377fe2fc42b57f58c639296974}`. The active handoff is removed because merged work is not resumable. The canonical mainline at finalization is `2097827f03bc7581b321c9b20f3dff653a4fb12a`. This governance update introduces no runtime code, migration, or WORK-070 implementation.
