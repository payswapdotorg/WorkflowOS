# WORK-066 — Validation Scheduling & Change Triggers

Status: COMPLETE — merged by the architect as
`0a506b10e5526151929366bb11197230334b620c` via PR #102 on 2026-08-31
(squash-merged at the approved head
`493ae593da59edf0375e3c7e8e57147e36d065b5` on 2026-08-31T16:37:09Z; single
parent `5f0b058` — the WORK-065 post-merge finalization mainline; the merge
tree is IDENTICAL — `git diff 493ae59 0a506b1` is empty) and finalized per
§34.8/ADR-0007 (see the post-merge finalization record appended below; the
activation and implementation history below is preserved, not rewritten).
The completion is recorded in `spec/development-state/program-state.json`
(status `complete`, `pr` 102, `head` `493ae59`, `mergedAs`
{pr: 102, mergeCommit: 0a506b10…}; branch
`feat/WORK-066-validation-scheduling` preserved as the historical record of
how it merged). The implementation delivered the validation scheduler at
`backend/src/validation-scheduling/` (the application-layer pattern — NOT
an 18th frozen module): the scheduling/trigger DECISION layer consuming the
WORK-064 admission authority.

Issued by: the research-driven v1.1 evolution (the continuous product
validation roadmap). This Work Order establishes the validation scheduling
and change-trigger model — it does NOT implement runtime code. Activation
requires the architect's authorization and is recorded in
`spec/development-state/program-state.json` (this change records none).

Dependencies: WORK-064 (Continuous Product Validation — the journey/EffectPolicy
authority the scheduler admits), WORK-065 (Synthetic Browser Validation Agent —
the execution mechanism the scheduler drives; BOTH dependency edges are now SATISFIED: WORK-064 is COMPLETE — merged by the architect as `c351451` via PR #86 on 2026-08-30 and finalized per §34.8/ADR-0007 — and WORK-065 is COMPLETE — merged by the architect as `5de5e83` via PR #97 on 2026-08-31 (squash-merged at the approved head `c06a3e3`, the tree identical) and finalized per §34.8/ADR-0007 by the WORK-065 post-merge finalization — so WORK-066 is now DEPENDENCY-ELIGIBLE and remains PLANNED, NOT activated, NOT started; the architect's authorization is required). Soft dependency: WORK-058
(Adaptive Assurance Engine — planned; "adaptive assurance architecture as
appropriate" per the issuing brief). The scheduler can be implemented
initially with a simpler assurance-aware model and upgraded to full adaptive
assurance when WORK-058 lands; until then, the assurance depth is fixed per
operating mode.

Downstream: WORK-067 (Engineering Signal & Regression Correlation) consumes
the runs the scheduler admits; WORK-069 (Progressive Release & Runtime
Validation) consumes the scheduling triggers for progressive rollout.

## Objective

Decide WHEN validation runs. A validation scheduler is risk/assurance-aware:
it does not simply run everything after everything. It binds triggers to
operating modes (PRE_MERGE / POST_RELEASE / CONTINUOUS — see
`spec/architecture/v1.1/continuous-validation-lifecycle.md`) and selects the
journeys/depth appropriate to the trigger — WITHOUT becoming a second
workflow engine, a second release authority, or an autonomous unsupervised
scheduler.

## The trigger model

Triggers determine when a ValidationRun is admitted. Each trigger carries
the operating mode and the assurance level the run must use:

```text
PR                    → PRE_MERGE       (the change's preview/isolated env)
deployment            → PRE_MERGE       (the deployment's preview env)
release               → POST_RELEASE   (the real production deployment)
scheduled interval    → CONTINUOUS      (the production deployment)
runtime signal        → CONTINUOUS      (anomaly-triggered)
architecture change   → PRE_MERGE       (ACR-gated preview)
security finding      → PRE_MERGE +     (immediate preview; escalates to
                          POST_RELEASE    POST_RELEASE if the finding is
                                          already in production)
major dependency      → PRE_MERGE +     (the dependency's preview; then
   change              → POST_RELEASE    POST_RELEASE for the released
                                          production deployment)
```

The scheduler does not invent triggers; it consumes triggers from the
existing authorities (the `/github` PR/deployment/release authority, the
existing runtime/audit observation authorities, the
`/architecture` ACR authority, the existing security signal intake).

## Risk/assurance-aware selection

The scheduler selects which ValidationJourneys to admit for a given trigger
based on the assurance level the trigger warrants:

- a LIGHT-triggered run (a documentation PR) may admit only READ_ONLY
  smoke journeys;
- a STANDARD-triggered run (a normal feature PR) admits the change's
  affected journeys at READ_ONLY or SAFE_MUTATION;
- a HIGH_ASSURANCE-triggered run (a public-contract or concurrency change)
  admits the affected journeys plus integration journeys, with
  discrimination evidence;
- a CRITICAL-triggered run (a schema, security, or authority change) admits
  the full journey suite, including ISOLATED_MUTATION journeys in a
  sandboxed preview, with architect-review-record evidence.

When WORK-058 (Adaptive Assurance Engine) is implemented, the scheduler
delegates the assurance selection to WORK-058's deterministic function over
declared change surfaces. Until then, the scheduler uses a fixed mapping
(trigger → assurance level → journey set) declared in this Work Order.

## Explicit prohibitions

WORK-066 must NEVER become:

- a **second workflow engine** — the scheduler admits validation runs; it
  does not transition Work Items, does not create PRs, does not merge;
- a **second release authority** — release remains in the existing
  `/workflows` + `/github` + runtime authorities; the scheduler triggers
  POST_RELEASE validation AFTER a release, never instead of it;
- an **autonomous unsupervised scheduler** — any background drive is a
  governed implementation decision (the same stop-condition discipline as
  WORK-046/062); CONTINUOUS runs are scheduled by explicit configuration,
  not unrequested timers/cron/loops;
- a **second verification authority** — the scheduler admits runs; evidence
  evaluation stays in `/verification`;
- a **second execution authority** — the scheduler drives WORK-065's
  browser agent; it does not execute directly.

## Required invariants

1. The scheduler admits only ValidationJourneys declared under WORK-064's
   authority.
2. The scheduler binds each admitted run to the operating mode and assurance
   level appropriate to its trigger.
3. The scheduler does not transition workflow state, create PRs, or merge.
4. CONTINUOUS runs are scheduled by explicit configuration; no autonomous
   unsupervised scheduler.
5. The scheduler consumes triggers from the existing authorities; it does
   not invent its own.
6. When WORK-058 lands, the scheduler delegates assurance selection to
   WORK-058's deterministic function (no parallel assurance engine).

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **trigger-to-mode binding** — a PR trigger admits only PRE_MERGE runs;
   a release trigger admits POST_RELEASE runs; a scheduled interval admits
   CONTINUOUS runs (discrimination-proven);
2. **assurance-aware selection** — a CRITICAL trigger admits the full
   journey suite; a LIGHT trigger admits only READ_ONLY smoke journeys;
3. **no workflow mutation** — the scheduler cannot transition Work Items,
   create PRs, or merge (static architecture invariant + runtime
   discrimination);
4. **no autonomous unsupervised scheduling** — a CONTINUOUS run cannot
   start without explicit configuration (discrimination-proven);
5. **no second authority** — static architecture invariants for the
   no-second-workflow/no-second-release/no-second-verification/no-second-
   execution matrix pass;
6. **mutation/discrimination** — removing the trigger-to-mode binding, the
   assurance-aware selection, or the no-workflow-mutation boundary makes
   the corresponding test FAIL.

## Scope

Allowed: the trigger model (PR/deployment/release/scheduled/runtime/
architecture/security/dependency); the risk/assurance-aware selection; the
operating-mode binding; the required proofs above.

Forbidden: the ValidationJourney domain model (WORK-064), the browser agent
(WORK-065), the signal runtime (WORK-067), the feedback converter
(WORK-068), progressive release (WORK-069), architecture fitness
(WORK-070), the adaptive assurance engine (WORK-058), the existing
release/workflow/verification/execution authorities. Forbidden for THIS
change: any runtime code at all (this task delivers the Work Order only).

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - spec/architecture/v1.1/continuous-validation-lifecycle.md
      - spec/development-state/dependency-state.json
    reason: the v1.1 evolution package — concurrent authors must coordinate
      on the shared spec surface.
  - migrations: []   # no schema migration in this Work Order
  - authorities:
      - /workflows    # the scheduler must not transition workflow state
      - /github      # triggers are CONSUMED from the github authority
      - /verification # evidence maps into the existing verification authority
    reason: the scheduler CONSUMES these authorities; it must not duplicate
      them.
  - dependencies:
      - WORK-064   # the journey authority
      - WORK-065   # the execution mechanism
      - WORK-058   # soft — adaptive assurance engine (planned)
    reason: WORK-064 and WORK-065 must be complete before the scheduler can
      be honestly exercised; WORK-058 is a soft dependency (a simpler
      fixed-mapping scheduler can ship first and delegate to WORK-058 when
      it lands).
protectedSurfaces:
  - spec/architecture/v1.1/continuous-validation-lifecycle.md
  - spec/work-orders/WORK-066.md
```

An Architect LLM may mechanically determine the state of WORK-066 as:
`READY` when WORK-064 and WORK-065 are complete (WORK-058 is soft); `BLOCKED`
while WORK-064 or WORK-065 is unimplemented; `PARALLEL-SAFE` with
WORK-053..061, WORK-067..070 (different surfaces); `CONFLICTING` with any
future Work Order that authors a second workflow, release, verification, or
execution authority.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second workflow, release, verification, or execution authority;
- an autonomous unsupervised scheduler not explicitly governed and
  authorized;
- changing the frozen v1.0 architecture version.

## Definition of done

- The trigger model is persisted in
  `spec/architecture/v1.1/continuous-validation-lifecycle.md`.
- All required invariants hold with objective evidence (the required proofs
  above, including mutation/discrimination tests).
- Static architecture invariants for the no-second-authority matrix pass.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-066 scope; independent Architect Review approves;
  WORK-066 is marked VERIFIED before WORK-067/069 become eligible on it.

## Activation record (2026-09-01 — appended by the implementation)

Activated by the architect (the WORK-066 implementation instruction), after
verifying against the actual repository that every prerequisite held:
WORK-064 complete (`c351451`/PR #86, finalized), WORK-065 complete +
finalized (`5de5e83`/PR #97; the finalization PR #101 merged as `5f0b058`),
58/58 recorded work orders complete, nothing else in flight, and no
existing WORK-066 branch or PR. Branch: `feat/WORK-066-validation-scheduling`
(created from the actual `origin/main` at `5f0b058`).

**Implementation (the scheduling/trigger decision layer — not an
authority):** the scheduler lives at `backend/src/validation-scheduling/`
(the WORK-064/WORK-065 application-layer precedent — NOT an 18th frozen
module), composed in `buildApp` and exposed on AppDeps as
`validationScheduler` for the future governed runtime drive surfaces (a
governed job handler / the dogfooding experiment — future decisions; this
Work Order wires the service, not a background scheduler).

- **Trigger classification** — the closed WORK-064 vocabulary
  (`VALIDATION_TRIGGERS` + `TRIGGER_MODE_BINDING`, consumed through the
  authority's barrel — the scheduler invents no trigger kinds; `MANUAL` is
  not a kind, a merge-shaped event is not a scheduler trigger). Every
  foreign kind fails closed with `SCHEDULING_TRIGGER_UNKNOWN`.
- **Required authority bindings per trigger** — the revision for PRE_MERGE
  legs, the recorded release reference for POST_RELEASE legs (repository
  truth: NO release authority exists yet — the reference is recorded, never
  invented; POST_RELEASE fails closed without it), the explicit continuous
  configuration for CONTINUOUS legs (no autonomous unsupervised scheduling —
  no timers, no loops, no queue consumers anywhere in the domain).
- **Assurance-aware selection** — the FIXED mapping declared in this Work
  Order (profile × mode → effect-policy allowance + the journey-set scope:
  LIGHT → affected READ_ONLY smoke; STANDARD → affected RO/SM;
  HIGH_ASSURANCE → affected ∪ integration RO/SM/IM; CRITICAL → the full
  declared suite) until WORK-058 lands. FORBIDDEN is never selected. The
  selection is a scope filter, never a grant — the WORK-064 admission gate
  remains the authority.
- **Determinism** — the scheduling identity is sha256 over the canonical
  logical-event fields (trigger, project, journey, environment, mode,
  reference); the run id is derived deterministically; the clock is
  INJECTED at the service boundary (no implicit global time in the decision
  path — pinned by static invariant 13).
- **Deduplication** — the `ScheduledTriggerClaimStore` PORT with the
  in-memory adapter as the composition default (this Work Order authorizes
  NO schema migration; the durable binding point is documented at the port —
  the WORK-064 run-repository precedent). The PostgreSQL contract — keyed
  uniqueness where the database constraint, not an application race, decides
  the winner under true two-actor concurrency — is proven by the real-PG
  integration suite against a test-schema table implementing the same port
  (two independent connections; the mutation leg proves the same-key test
  FAILS without the constraint).
- **Failure semantics** — the typed `SCHEDULING_*` outcome vocabulary
  (unknown trigger, missing journey/registry, invalid environment, missing
  release reference, missing continuous configuration, conflict, dependency
  unavailable, admission-rejected echoes, no-eligible-journeys): every
  failure is an explicit scheduling outcome, never a healthy validation,
  never a silent skip.
- **Governed linkage** — trigger → project → journey → environment →
  revision/release/window → scheduling decision → validation run, readable
  through `findSchedulingDecision` (the resumable reconciliation read).

**Verification on the branch:** the validation-scheduling suite (121 tests:
classification 17 + selection 15 + cadence 8 + identity 9 + decisions 24 +
idempotency 8 + concurrency 9 + authority 8 + mutation 5 + composition 3) +
the real-PG two-actor suite (6 tests, `WORKFLOWOS_DATABASE_URL`) + 19 new
static-architecture invariants (858/858) + the WORK-064 regression (144) +
the WORK-065 regression (91) + the full backend regression on real
PostgreSQL. See the PR body for the exact counts on the final head.

## Post-merge finalization record (§34.8/ADR-0007 — appended 2026-08-31)

The architect merged PR #102 as `0a506b10e5526151929366bb11197230334b620c`
(squash merge; single parent `5f0b058` — the WORK-065 post-merge
finalization mainline; merged 2026-08-31T16:37:09Z). The merged tree is
IDENTICAL to the approved head `493ae59`
(`git diff 493ae59 0a506b1` is empty) — the branch head the architect
reviewed, created from the post-#101 mainline `5f0b058` and never diverged
(no reconciliation was needed; all 11 CI workflows were green on that
head). The finalization — a data-only change on branch
`governance/WORK-066-post-merge-finalization` — records in the canonical
state: `status = complete`, `mergedAs = {pr: 102, mergeCommit:
0a506b10e5526151929366bb11197230334b620c}`, the implementation head
recorded as `493ae59` (the WORK-064/WORK-065 finalization head
convention), no active handoff (none was ever recorded —
`resumption.activeHandoffs` was empty before and after; merged work is not
resumable), and this work-order document's status updated truthfully with
this evidence APPENDED (history preserved, not rewritten).

The merged-finalization audit binds WORK-066 ↔ PR #102 ↔ merge commit
`0a506b1` on the real first-parent history: the merge subject follows the
`type(work-NNN): … (#PR)` conventional-commit scope squash convention
(`feat(work-066): Validation Scheduling & Change Triggers (the
scheduling/trigger DECISION layer, not an authority) (#102)`) — the FOURTH
merge-evidence shape, recognized since the WORK-064 finalization (NO
detector change needed). The pre-finalization red window was exactly the
WORK-066 gap the protocol exists to surface: the audit reported
`workOrders[WORK-066]: MERGED (0a506b10e) but the canonical status is
"in_flight"` (13/14 finalized); this finalization closes it
(governance:status reports 14/14 finalized, gaps []). The audit validates
the full provenance identity: `mergedAs.pr` must equal the declared PR
(102) and `mergedAs.mergeCommit` must match the ACTUAL merge evidence.
State-only finalization subjects (the `chore(governance): …` convention
this finalization itself follows) remain structurally excluded from merge
evidence — a finalization commit can never be mistaken for the architect's
implementation merge.

The dependency frontier was recomputed: WORK-066 is complete (59/59
recorded work orders, nothing in flight), and WORK-067 (Engineering Signal
& Regression Correlation) is the next ACR-002 sequence head —
DEPENDENCY-ELIGIBLE (its hard edges WORK-064 + WORK-015 + WORK-040 +
WORK-041 are ALL complete) and remains PLANNED, NOT activated, NOT
started; the architect's authorization is required. WORK-069 is likewise
DEPENDENCY-ELIGIBLE (its hard WORK-066 edge is now SATISFIED;
WORK-064/019/026/020 complete) and NOT activated; WORK-068/070/072/073
remain planned. Dogfooding: the gate's two enabler edges (WORK-074
complete + WORK-071 complete) were already SATISFIED and remain so — the
first full authenticated/local dogfooding experiment is PERMITTED and NOT
started (WORK-066's completion adds the scheduling CAPABILITY; it does NOT
claim the experiment was performed, and this finalization does NOT run it).
