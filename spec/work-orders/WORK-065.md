# WORK-065 — Synthetic Browser Validation Agent

Status: COMPLETE — merged by the architect as
`5de5e83ac9a3ce2c1613a7b8b83045d0ab1d8916` via PR #97 on 2026-08-31
(squash-merged at the approved head `c06a3e3` — the post-#100
reconciliation head; the merge tree is IDENTICAL — both trees `8b6469c8`)
and finalized per §34.8/ADR-0007 (see the post-merge finalization record
appended below; the activation, implementation, reconciliation, and
review-correction history below is preserved, not rewritten). The
completion is recorded in `spec/development-state/program-state.json`
(status `complete`, `pr` 97, `head` `c06a3e3`, `mergedAs`
{pr: 97, mergeCommit: 5de5e83…}; branch
`feat/work-065-browser-validation-agent` and the coordination record
preserved as the historical record of how it merged). The implementation
delivered the synthetic browser validation agent at
`backend/src/browser-validation/` (the application-layer pattern — NOT an
18th frozen module): the execution contract
(navigate/observe/evidence-capture/effect-policy enforcement) that
CONSUMES the WORK-064 domain authority and the existing BrowserDriver
port (WORK-036 — no second browser automation framework), the
JOURNEY-OWNED navigation-safety declaration
(`ValidationJourney.readonlySafeNavigationTargets` — the fourth architect
review correction: a READ_ONLY navigation is admitted only when the
authoritative journey itself declares the target safe; a forged
executor/caller declaration is rejected before run admission — no run
persisted, the BrowserDriver never called), and the Playwright adapter's
pre-goto URL defense (non-http(s) schemes and embedded userinfo rejected
before `page.goto()`). The browser agent contract is persisted in
`spec/architecture/v1.1/validation-model.md` §9.

Issued by: the research-driven v1.1 evolution (the continuous product
validation roadmap — the closed-loop software engineering control system
extension to v1.1). This Work Order establishes the synthetic browser
validation agent. Activation requires the architect's authorization and is
recorded in `spec/development-state/program-state.json` (this change
records the activation).

Dependencies: WORK-064 (Continuous Product Validation — the authority this
agent executes underneath). The browser agent is the EXECUTION MECHANISM
for ValidationJourneys; WORK-064 is the AUTHORITY that defines them and the
EffectPolicy that binds them. That dependency edge is SATISFIED — WORK-064 is COMPLETE (implemented on branch feat/work-064-continuous-validation, merged by the architect as `c351451` via PR #86 on 2026-08-30 and finalized per §34.8/ADR-0007; the domain/model authority is on main at backend/src/continuous-validation/). WORK-065 was accordingly DEPENDENCY-ELIGIBLE and was ACTIVATED by the architect on 2026-08-30 (see the Status header above; the earlier "NOT activated, NOT started" wording of this file predates the activation and is superseded by it).

Reconciliation (2026-08-31): the implementation branch was first
reconciled onto the post-#99 mainline (cdedd0ca — the WORK-074 PR #99
merge) resolving the governance-only conflicts, declaring the ADR-0003
mutual coordination between the then-two live in-flight records
(WORK-065 ↔ WORK-074 on the shared static-architecture suite surface),
and advancing the WORK-065 migration-set pin 58 → 59 for WORK-074's
0059_identity_runtime (credit comment). The WORK-074 post-merge
finalization then LANDED as PR #100 (merged as 1e279a2 — the canonical
state records WORK-074 complete + finalized, 57/57 mainline work orders
complete), and the branch was REBASED onto that finalization head: the
governance state (program-state / frontier-state / dependency-state /
future-roadmap + the governance snapshot suites) is recomputed onto the
finalization truth — WORK-074 carries its complete + finalized record
exactly as main carries it, the earlier merged-finalization red-window
expectations (the pre-existing WORK-074 gap that PR #100 has now closed)
are re-pinned to the NO-gap truth, and WORK-065 is the ONE in-flight
record this branch carries. The historical ADR-0003 coordination
declaration remains on the WORK-065 record (durable history — both
parallel-era partners are now complete/merged). The rebase also REMOVED
an out-of-scope commit that briefly rode the branch (the WORK-042
cross-mode-handoff relay-drain budget recalibration):
backend/tests/integration/agents/cross-mode-handoff.regression.test.ts
is byte-identical to current main truth — this Work Order's scope
boundary is restored.

Downstream: WORK-066 (Validation Scheduling & Change Triggers) decides
when this agent runs; WORK-067 (Engineering Signal & Regression Correlation)
consumes the evidence it produces.

## Objective

Provide the synthetic browser validation agent that EXECUTES
ValidationJourneys against real browser behavior, observes the actual DOM/
network/persistence state, captures safe evidence, enforces the
EffectPolicy, and prevents uncontrolled production side effects — WITHOUT
becoming a verification authority, a workflow authority, an execution
authority, or a code-mutation authority.

The browser agent is an execution mechanism. It is not an authority.

## The authority model (the validation-substrate decision)

```text
WORK-064 (Continuous Product Validation)
    the domain/model authority — ValidationJourney, EffectPolicy,
    TestIdentity, Environment, ExpectedObservation, Evidence
        ↓ declares
WORK-065 (this Work Order)
    the synthetic browser execution mechanism
        ↓ executes under
the existing Execution Authority (WORK-027/034/042 — the ONE execution
boundary; the browser agent is a tool runtime consumer, not a second
execution authority)
        ↓ observes into
the EXISTING /verification authority (evidence is mapped, not duplicated)
        ↓
the EXISTING /reviews authority (architect review remains the merge gate)
```

The browser agent:

- reads the ValidationJourney declared by WORK-064;
- executes it under the declared EffectPolicy (which it cannot relax);
- produces observations that become Evidence in the existing
  `/verification` authority;
- never mutates code, never merges PRs, never approves reviews, never
  transitions workflow state.

## The Z.ai agent-browser style capability

This Work Order integrates the Z.ai agent-browser style capability
(headless browser automation with structured navigation/click/type/snapshot
commands) as the execution substrate for synthetic validation. The
capability is a TOOL — it is not an authority. Specifically:

- the agent-browser is one possible implementation of the browser
  validation agent; the contract (navigate, observe, evidence-capture,
  effect-policy enforcement) is what WORK-065 owns, not a particular vendor;
- the agent-browser runs under the existing tool runtime (WORK-036) and the
  existing agent policy (WORK-037);
- the agent-browser's observations are bound to the EffectPolicy declared
  in the ValidationJourney — the browser cannot perform actions the policy
  forbids.

## Effect policy enforcement (the load-bearing invariant)

The browser agent MUST enforce the EffectPolicy at execution time, not
merely trust the ValidationJourney declaration. Specifically:

- before performing any action, the agent checks the action's effect class
  against the run's declared EffectPolicy;
- a FORBIDDEN action is rejected before execution (fail closed, typed error,
  evidence recorded as `effect_policy_violation`);
- a READ_ONLY run cannot perform any mutation;
- a SAFE_MUTATION run can mutate only state owned by its TestIdentity;
- an ISOLATED_MUTATION run can mutate only state inside its isolated test
  tenant/sandbox.

This is discrimination-proven: an agent that does NOT enforce the policy
(mutating under a READ_ONLY declaration, or performing a FORBIDDEN action)
must be rejected by the surrounding control system, and the corresponding
test must FAIL when the enforcement is removed.

## Evidence capture (provenance preserved)

The browser agent captures:

- DOM snapshots at declared checkpoints;
- network responses (status, headers, body where safe);
- persisted records (the synthetic identity's own state);
- downstream events (audit, notifications) where the run is authorized to
  observe them.

All evidence is provenance-bound: each observation records its source
(browser, run, journey, step, timestamp, environment) and maps into the
existing `/verification` evidence authority as a derived artifact. The
browser agent never produces "free-floating" evidence.

## Explicit prohibitions

WORK-065 must NEVER become:

- a **second verification authority** — evidence evaluation stays in
  `/verification`; the browser agent produces observations, not verdicts;
- a **second execution authority** — the browser agent is a tool-runtime
  consumer underneath the existing execution boundary;
- a **second workflow authority** — the browser agent does not transition
  Work Items, does not create PRs, does not merge;
- a **code-mutation authority** — the browser agent observes; it never
  modifies code because it found a failure (see WORK-064's failure→Work
  Item semantics);
- a **production destructive surface** — uncontrolled destructive side
  effects are rejected by EffectPolicy enforcement;
- a **second identity authority** — the TestIdentity is issued by WORK-063's
  identity layer; the browser agent presents it, never mints it.

## Required invariants

1. The browser agent executes only ValidationJourneys declared under
   WORK-064's authority.
2. The EffectPolicy is enforced at execution time (not merely declared).
3. A FORBIDDEN action is rejected before execution, with evidence recorded.
4. The browser agent produces observations that map into the existing
   `/verification` evidence authority (provenance preserved).
5. The browser agent never mutates code, merges PRs, approves reviews, or
   transitions workflow state.
6. The TestIdentity is presented by the agent; it is never minted by the
   agent.
7. The browser agent runs under the existing tool runtime (WORK-036) and
   agent policy (WORK-037).
8. The browser agent is one possible implementation; the contract is what
   this Work Order owns.

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **effect policy enforcement** — a browser agent attempting a FORBIDDEN
   action under a READ_ONLY/SAFE_MUTATION declaration is rejected (fail
   closed, typed error, evidence recorded);
2. **no code mutation** — the browser agent cannot modify code, merge PRs,
   or approve reviews (static architecture invariant + runtime
   discrimination);
3. **evidence provenance** — every observation records its source and maps
   into `/verification` evidence (no free-floating observations);
4. **test identity isolation** — the browser agent cannot act as a real
   production user (the TestIdentity is scoped, provenance-bound);
5. **no second authority** — static architecture invariants for the
   no-second-verification/no-second-execution/no-second-workflow/no-second-
   identity matrix pass;
6. **mutation/discrimination** — removing the EffectPolicy enforcement,
   the provenance binding, or the no-code-mutation boundary makes the
   corresponding test FAIL.

## Scope

Allowed: the synthetic browser validation agent contract (navigate, observe,
evidence-capture, effect-policy enforcement); the Z.ai agent-browser style
capability integration as the execution substrate; the evidence mapping
into `/verification`; the required proofs above.

Forbidden: the ValidationJourney domain model (WORK-064), the scheduling
engine (WORK-066), the signal runtime (WORK-067), the feedback converter
(WORK-068), progressive release (WORK-069), architecture fitness
(WORK-070), authentication (WORK-063), the existing execution authorities,
the existing verification authority. Forbidden for THIS change: any runtime
code at all (this task delivers the Work Order only).

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - backend/src/modules/agents/   # the browser agent is a tool-runtime consumer
      - backend/src/platform/tools/   # the existing browser-tool-executor surface
    reason: the browser validation agent extends the existing agent/tool
      runtime; concurrent authors on that surface must coordinate.
  - migrations: []   # no schema migration in this Work Order
  - authorities:
      - /verification   # evidence maps into the existing verification authority
      - /workflows      # the browser agent must not transition workflow state
    reason: the agent CONSUMES these authorities; it must not duplicate them.
  - dependencies:
      - WORK-064   # the authority this agent executes underneath
    reason: WORK-064 must be implemented and verified before this agent can
      be honestly exercised.
protectedSurfaces:
  - spec/architecture/v1.1/validation-model.md
  - spec/work-orders/WORK-065.md
```

An Architect LLM may mechanically determine the state of WORK-065 as:
`READY` when WORK-064 is complete; `BLOCKED` while WORK-064 is unimplemented;
`PARALLEL-SAFE` with WORK-053..061, WORK-066..070 (different surfaces);
`CONFLICTING` with any future Work Order that authors a second execution,
verification, or workflow authority.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second verification, execution, workflow, or identity authority;
- a browser agent with code-mutation or merge authority;
- production destructive side effects without an approved safe mechanism;
- changing the frozen v1.0 architecture version.

## Definition of done

- The synthetic browser validation agent contract is persisted in
  `spec/architecture/v1.1/validation-model.md` (the agent section).
- All required invariants hold with objective evidence (the required proofs
  above, including mutation/discrimination tests).
- Static architecture invariants for the no-second-authority matrix pass.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-065 scope; independent Architect Review approves;
  WORK-065 is marked VERIFIED before WORK-066 becomes eligible on it.

## Post-merge finalization record (§34.8/ADR-0007 — appended 2026-08-31)

The architect merged PR #97 as `5de5e83ac9a3ce2c1613a7b8b83045d0ab1d8916`
(squash merge; single parent `1e279a2` — the WORK-074 post-merge
finalization mainline; merged 2026-08-31T12:01:14Z). The merged tree is
IDENTICAL to the approved head `c06a3e3`
(`git diff c06a3e3 5de5e83` is empty; both trees are `8b6469c8`) — the
post-#100 reconciliation head that carries the journey-owned
navigation-safety declaration (the fourth architect review correction:
`ValidationJourney.readonlySafeNavigationTargets`), the removal of the
out-of-scope WORK-042 relay-deflake change (the cross-mode-handoff
regression test restored to main truth), the recomputed governance state
onto the WORK-074 finalization, and the 11/11 green CI. The finalization —
a data-only change on branch
`governance/WORK-065-post-merge-finalization` — records in the canonical
state: `status = complete`, `mergedAs = {pr: 97, mergeCommit:
5de5e83ac9a3ce2c1613a7b8b83045d0ab1d8916}`, the implementation head
recorded as `c06a3e3`, no active handoff (none was ever recorded —
`resumption.activeHandoffs` was empty before and after; merged work is not
resumable), and this work-order document's status updated truthfully with
this evidence APPENDED (history preserved, not rewritten).

The merged-finalization audit binds WORK-065 ↔ PR #97 ↔ merge commit
`5de5e83` on the real first-parent history: the merge subject follows the
`type(work-NNN): … (#PR)` conventional-commit scope squash convention
(`feat(work-065): Synthetic Browser Validation Agent (the execution
mechanism, not authority) (#97)`) — the FOURTH merge-evidence shape,
recognized since the WORK-064 finalization (NO detector change needed).
The pre-finalization red window was exactly the WORK-065 gap the protocol
exists to surface: the audit reported `workOrders[WORK-065]: MERGED
(5de5e83ac) but the canonical status is "in_flight"` (12/13 finalized);
this finalization closes it (governance:status reports 13/13 finalized,
gaps []). The audit validates the full provenance identity: `mergedAs.pr`
must equal the declared PR (97) and `mergedAs.mergeCommit` must match the
ACTUAL merge evidence. State-only finalization subjects (the
`chore(governance): …` convention this finalization itself follows) remain
structurally excluded from merge evidence — a finalization commit can
never be mistaken for the architect's implementation merge.

The dependency frontier was recomputed: WORK-065 is complete (58/58
recorded work orders, nothing in flight), and WORK-066 (Validation
Scheduling & Change Triggers) is now DEPENDENCY-ELIGIBLE (its hard
dependencies WORK-064 + WORK-065 are BOTH complete; its WORK-058 edge is
soft) — it remains PLANNED, NOT activated, NOT started; the architect's
authorization is required. WORK-067 remains dependency-eligible on the
complete WORK-064 (different protected surfaces) and NOT activated;
WORK-068/069/070/072/073 remain planned. Dogfooding: the gate's two
enabler edges (WORK-074 complete + WORK-071 complete) were already
SATISFIED and remain so — the first full authenticated/local dogfooding
experiment is PERMITTED and NOT started (WORK-065's completion adds the
synthetic-browser validation CAPABILITY; it does NOT claim the experiment
was performed, and this finalization does NOT run it).
