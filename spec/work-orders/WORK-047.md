# WORK-047 — Agent Intelligence

Status: IMPLEMENTED — delivered on branch `feat/work-047-agent-intelligence` (off main@1f2bef9 — the merged WORK-046); awaiting architect review. The same change carries the owed WORK-046 post-merge finalization (§34.8/ADR-0007) + this derived work order + the governed activation of WORK-047.
Architecture: frozen v1.0 authority model + the §33.9 Agent Intelligence direction
Dependencies: WORK-032 (benchmark evidence), WORK-044 (adaptive execution router),
WORK-046 (multi-agent delegation)

## Objective

Introduce an ADVISORY intelligence layer that uses historical WorkflowOS evidence
— from EXISTING authoritative stores, never a second historical-data store — to
recommend:

* agent roles (from the WORK-045 closed catalog)
* providers, models, and execution modes (from the WORK-044 routing result over
  the WORK-043 eligible set)
* fallback strategies (the ordered eligible alternatives with reasons)
* task/delegation decomposition (a WORK-046 `DelegationPlanInput`-shaped
  recommendation the caller may submit through the EXISTING delegation plan
  authority)

The layer is **advisory/ranking only**. The non-negotiable authority ordering:

```text
hard eligibility / constraints        (WORK-043 — the ONE eligibility engine)
        ↓
eligible candidates
        ↓
routing / execution policy            (WORK-044 + §22 policy snapshot)
        ↓
historical intelligence               (THIS layer — ranking only)
        ↓
recommendation                        (advisory; the caller decides)
```

Intelligence recommends. Authoritative subsystems decide. Nothing in this slice
may override or replace: authorization, execution eligibility, execution policy,
routing authority, workflow state, verification, review, GitHub authority,
WORK-045 role definitions, or WORK-046 delegation authority.

## Governing contracts (derived — §33.9, dependency-graph, W045/W046)

- §33.9: the intelligence layer "must select among eligible candidates and must
  never override hard authorization, security, or capability constraints."
  The ranking input is the WORK-044 routing result's ALREADY-ELIGIBLE ranked
  set; an ineligible candidate can never be scored (fail-closed seam, mirroring
  W044-AC01/W044-AC11).
- WORK-043 remains the ONE eligibility engine. Intelligence never re-evaluates,
  reinterprets, weakens, or bypasses hard constraints; the excluded picture is
  carried through from the authority's verdicts verbatim.
- WORK-044 remains the routing authority. Intelligence CONSUMES
  `AdaptiveExecutionRouterService.recommendExecution()` — it never re-implements
  ranking signals the router owns (benchmark quality, reliability, cost, latency,
  human intervention, preferences), never mutates routing state (there is none —
  the router is stateless), and never dispatches.
- WORK-045 remains the role authority. Role recommendations resolve through
  `AgentRoleCatalogService.resolveRole` (deterministic, revision-pinned);
  intelligence authors no role definitions and redefines no role semantics
  (W045-AC05/AC14 — the `extensions.intelligence` seam stays untouched).
- WORK-046 remains the delegation authority. A decomposition recommendation is
  DATA the caller may submit through the EXISTING
  `POST …/delegation-plans` boundary (which validates roles, providers, and
  dependencies fail-closed); intelligence never creates a plan, never drives
  one, and never executes anything.
- Historical evidence comes from EXISTING authoritative stores only:
  `wfos_executions` (terminal execution outcomes per provider/model/mode,
  project-scoped), `wfos_delegation_plans/units/attempts` (per-role coordination
  outcomes, the W046-AC10 structured state, project-scoped through the
  authoritative work-item→architecture chain), and the benchmark evidence
  carried through the consumed routing result (§14 `HistoricalPerformance`).
  NO new tables, NO migration, NO second ledger (the last migration stays
  `0057`).
- `/workflows`, `/verification`, `/reviews`, `/architecture`, `/work-items`,
  and the GitHub authority are untouched: intelligence writes NOTHING except
  through the consumed §22 policy decision (already persisted by the
  WORK-043 recommendation path the router consumes) and reads only the
  evidence stores above.
- The layer is STATELESS and DETERMINISTIC: the same inputs (routing result +
  evidence) produce the identical recommendation; every ordering is decided by
  a documented total order.

## Provenance contract (the four questions, verbatim from the assignment)

Every recommendation must retain enough provenance to answer:

```text
Why was this role/provider/model/mode recommended?
Which historical evidence contributed?
What constraints were already applied?
What alternatives were rejected?
```

Concretely, every result carries: structured reasons (dimension + detail), the
contributing evidence cells with their observation windows
(`firstObservedAt`/`lastObservedAt` — stale evidence is surfaced as historical,
never presented as current), the constraints-already-applied record carried from
the WORK-043 satisfied constraints + the consumed §22 `decisionId` (the durable
audit anchor), and the rejected alternatives with the AUTHORITY's blocking
reasons (the intelligence layer never invents exclusion reasons).

Historical evidence is never turned into authority: evidence annotates and
ranks; it cannot admit an ineligible candidate, cannot drop a
task-profile-required role from a decomposition, and cannot mutate any
authoritative state.

## Work decomposition

WORK-047 may recommend a decomposition strategy for a Work Item, but it must
not create a second workflow engine or independently execute that
decomposition. The downstream path remains:

```text
Work Item
    ↓
WORK-047 recommendation
    ↓
WORK-046 delegation
    ↓
existing execution authority
    ↓
verification / review
```

A decomposition recommendation is `DelegationPlanInput`-shaped DATA the
caller submits through the EXISTING WORK-046 delegation plan boundary (which
validates roles, providers, and dependencies fail-closed); intelligence never
creates, drives, or executes a plan.

## Scope

1. A new application-layer domain `src/agent-intelligence/` (mirroring the
   §34 benchmark / execution-policy / execution-routing / agent-roles /
   delegation pattern — NOT the 18th frozen module; the frozen set stays 17).
2. `recommendExecution`: the advisory execution recommendation — the
   intelligence re-ranking of the router's eligible set using the observed
   execution-history signal (a signal WORK-044 does not consume), the ordered
   fallback chain, full provenance, and the excluded picture with the
   authority's reasons.
3. `recommendDelegation`: the advisory decomposition recommendation — a
   deterministic, task-profile-driven unit structure over WORK-045 catalog
   roles with dependency edges, execution assignments taken from the
   intelligence ranking (explicitly unavailable when no eligible candidates
   exist), role-history annotations, rejected role alternatives with reasons,
   and the submission path through the EXISTING delegation boundary.
4. A read-only evidence repository over the existing stores (SELECT-only
   aggregation; project-scoped; tenant isolation by construction).
5. A bounded read-only HTTP surface behind the existing project authorization
   (project.read; server-side work-item→project resolution mirroring the
   delegation/routing routes; fail-closed typed errors).
6. Integration tests on real PostgreSQL covering the behavioral contract, the
   adversarial matrix, tenant isolation, provenance, and determinism; plus the
   static architecture invariants appended to the shared suite.

## Out of scope

- WORK-048/049/050 (frontend/workbench surfaces), Change Programs, runtime
  feedback, architecture fitness, adaptive assurance, self-hosting automation
- Any new eligibility/policy/routing evaluation (WORK-043/044 stay)
- Any role authoring or role-semantic change (WORK-045 stays)
- Any plan creation/dispatch/coordination behavior (WORK-046 stays)
- Any LLM-driven recommendation (the intelligence is deterministic evidence
  aggregation — no `@modules/llm` usage in this slice)
- Autonomous scheduling (no timers/cron/background loops; every recommendation
  is an explicit call)
- Persistence of recommendations (stateless, mirroring WORK-044; the §22
  decision of the consumed recommendation is the durable audit anchor)
- New provider adapters or provider SDK usage outside the existing boundary

## Architecture preservation

Do not introduce:

* a second eligibility evaluator
* a second routing engine
* a second role catalog
* a second execution engine
* a second workflow authority
* a second verification authority
* hidden scheduler behavior
* provider SDK usage outside the existing provider boundary
* architectural mutations without an ACR

## Acceptance Criteria

### W047-AC01 — Intelligence sits AFTER the authorities (the pipeline order)

The execution recommendation is computed OVER the WORK-044 routing result's
already-eligible ranked set (consumed via `recommendExecution`); the routing
score is carried through as a component; no candidate outside the eligible set
is ever scored, ranked, recommended, or assigned.

Evidence: integration test + static architecture test.

### W047-AC02 — Hard constraints always dominate intelligence

A candidate excluded by policy (e.g. `policy_blocked`), capability
(`capability_blocked`), or any other WORK-043 constraint — even with SUPERIOR
historical evidence — never appears in the intelligence ranking; it appears in
`rejectedAlternatives` with the authority's blocking reasons. The ranking seam
additionally REJECTS any ineligible candidate with a typed error
(defense in depth, mirroring the W044 seam).

Evidence: integration tests (three distinct exclusion authorities) + unit test
of the seam + static test.

### W047-AC03 — Fail-closed / fail-safe recommendation semantics

No eligible candidates → `recommended: null` with the structured excluded
picture (never a fallback to an ineligible candidate). Historical evidence
unavailable → the documented neutral prior with `insufficient` status and
explicit uncertainty (never fabricated). Unknown role at the decomposition seam
→ typed fail-closed error. Unresolvable scope → typed fail-closed error.

Evidence: integration tests + unit tests.

### W047-AC04 — Deterministic, repeatable recommendations

Identical inputs → identical results (deep-equal on repeated calls). Equal
evidence → the documented tie-break chain: intelligence score desc → routing
score desc → lexicographic (provider, model, mode) (the W044-AC14 total order);
for decompositions, the declared role-catalog order. No object-iteration or
database-ordering dependence.

Evidence: integration tests (repeated call + equal-evidence fixtures).

### W047-AC05 — Tenant isolation + no cross-project evidence leakage

Evidence queries are project-scoped (`wfos_executions.project_id`; the
delegation chain scoped through the authoritative work-item→architecture→project
relation). Another project's execution history, delegation history, policy, or
registry cannot affect a project's recommendation, and vice versa.

Evidence: integration tests on real PostgreSQL (multi-project fixtures).

### W047-AC06 — Provenance/explainability (the four questions)

Every recommendation carries: structured reasons; the contributing evidence
cells with sample sizes, rates, and observation windows (staleness surfaced);
the constraints-already-applied record (the satisfied WORK-043 constraints +
the §22 decisionId); and the rejected alternatives with the authority's
reasons. The decomposition additionally carries per-unit role rationale and
rejected role alternatives with reasons.

Evidence: integration tests asserting the provenance shape + content.

### W047-AC07 — No mutation of authoritative state

A recommendation (either operation) writes no workflow/execution/verification/
review/delegation rows: the row counts of the authoritative tables are
unchanged after a recommendation call; the only durable artifact is the §22
policy decision persisted by the CONSUMED recommendation path (recorded
truthfully on the result as `decisionId`).

Evidence: integration test (before/after row counts) + static test (SELECT-only
evidence SQL; no INSERT/UPDATE/DELETE in the domain).

### W047-AC08 — No second authority of any kind

No second eligibility evaluator, no second routing engine, no second role
catalog, no second execution engine, no second workflow authority, no second
verification/review authority, no scheduler, no provider SDK/gateway usage, no
credential access, no new authority tables (no migration).

Evidence: static architecture tests (the forbidden-duplication matrix).

### W047-AC09 — The decomposition is data, not execution

The decomposition recommendation is a `DelegationPlanInput`-shaped structure
(the exact WORK-046 request vocabulary: unitKey/role/mode/provider/model/
dependsOn) with the submission path documented; it is accepted only through the
EXISTING delegation plan boundary (the integration test submits a recommended
decomposition through `DelegationPlanService.createPlan` and observes the
plan created under the EXISTING validation).

Evidence: integration test + static test.

### W047-AC10 — Historical evidence never becomes authority

Role-history evidence ANNOTATES the decomposition (observed success, sample
size, warnings for poor observed success) but never drops a
task-profile-required role, never adds a role absent from the catalog, and
never changes the fail-closed semantics. Execution-history evidence re-ranks
ELIGIBLE candidates only.

Evidence: integration test (annotated-not-dropped) + unit tests.

## Required adversarial coverage (all pinned by title in the integration suite)

1. no eligible candidates → fail closed (`recommended: null`, never a fallback)
2. historical evidence unavailable → safe/explicitly uncertain (neutral prior)
3. stale historical evidence → the observation window is surfaced (never
   presented as current; scoring is recency-independent and deterministic)
4. conflicting evidence (benchmark favors A, execution history favors B) →
   deterministic composite with BOTH signals in the provenance
5. a new provider/model absent from historical data → `insufficient` signal,
   still rankable through the routing component (explicitly not fabricated)
6. unknown role → fail closed with a typed error
7. policy excludes the historically best candidate → never recommended;
   rejected with the authority's reason
8. capability excludes the historically best candidate → same
9. routing-carried exclusion of the historically best candidate → same
10. an ineligible candidate at the ranking seam → typed rejection (defense in
    depth; structurally unreachable on the public path)
11. tenant isolation → another project's evidence/policy/registry cannot
    affect the recommendation
12. cross-project historical evidence leakage → none (multi-project fixtures
    with divergent histories)
13. deterministic ordering under equal evidence → the documented total order
14. repeated recommendation for identical inputs → deep-equal results
15. no mutation of authoritative workflow/execution state → row counts
    unchanged
16. no second routing/eligibility/role authority → the static matrix

The most important proof: **intelligence cannot bypass hard constraints** —
covered by 7/8/9/10 together with the static pipeline-order invariant.

## Required implementation evidence

- Integration tests on real PostgreSQL (the routing-test stack pattern: the
  real policy service + router with stubbed registry/evidence, plus REAL
  execution-record and delegation-attempt history rows) covering the
  behavioral contract and the adversarial matrix by title.
- Unit tests for the pure ranking/decomposition functions (including the
  ineligible-candidate seam rejection and the corrupted-rule fail-closed).
- Static architecture invariants appended to the shared suite (the
  forbidden-duplication matrix + the pipeline-order/determinism/provenance
  pins + the adversarial-title pins).
- Typecheck and lint clean; the full repository regression suite clean on real
  PostgreSQL (modulo the documented pre-existing failure, if still present).
- `governance:status` green and truthful after the WORK-046 finalization +
  WORK-047 activation.

## Migration numbering note

WORK-047 adds NO migration (the advisory layer owns no tables; the evidence is
read-only aggregation over existing stores). The last migration remains
`0057_delegation_plans.sql` (WORK-046); the WORK-040 last-migration pin and the
ARCH-SELF-006 migration-head pin (57) are unchanged.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- evaluating eligibility or re-ranking ineligible candidates;
- a second routing/ranking engine over signals WORK-044 owns;
- authoring or redefining role semantics;
- creating, driving, or executing delegation plans directly;
- persisting recommendations or any new historical-data store;
- mutating workflow/verification/review/execution state;
- an autonomous scheduler or background loop;
- provider SDK usage outside the existing provider boundary;
- changing the frozen architecture version.

## Definition of Done

- W047 acceptance criteria have objective evidence.
- All required tests pass on CI (real PostgreSQL).
- Architecture invariants pass (static suite + the new WORK-047 block).
- PR contains only WORK-047 scope (plus the owed WORK-046 post-merge
  finalization data change + the WORK-047 work order + the governed activation
  of WORK-047 — all data/governance changes, no code beyond the slice).
- Independent Architect Review approves the implementation PR.
- Implementation PR is merged (the architect is the merge authority).
- WORK-047 is then finalized per §34.8/ADR-0007.

## Implementation record (2026-08-29 — the delivered slice)

- **The domain** (`src/agent-intelligence/`, application layer — NOT the 18th
  frozen module; the frozen set stays 17): `types.ts` (the public advisory
  contracts), `internal/intelligence-ranking.ts` (the PURE ranking: the
  fail-closed eligibility seam, the composite 0.6×routing + 0.4×observed
  execution history, the neutral prior, the §14 sufficiency threshold, the
  total-order tie-break chain score → routing → lexicographic),
  `internal/decomposition.ts` (the PURE deterministic task-profile-driven
  role rules + the fail-closed unknown-role seam + the annotate-never-drop
  role-history aggregation), `internal/pg-agent-intelligence-repository.ts`
  (the READ-ONLY evidence aggregation over the EXISTING stores:
  `wfos_executions` terminal outcomes per (provider, model, mode) scoped by
  `project_id` + the W046-AC10 delegation ledger per (role, provider, mode)
  scoped through the AUTHORITATIVE work-item → architecture-version →
  architecture → project chain; SELECT-only, no new tables, no migration —
  the last migration stays `0057`), and
  `internal/agent-intelligence.service.ts` (the orchestrator: consumes the
  WORK-044 router's recommendation — never the policy service directly —
  collects the evidence, ranks, and builds the full provenance).
- **The HTTP surface** (`agent-intelligence.route.ts`): two READ-ONLY GET
  endpoints (`/projects/:projectId/work-items/:workItemId/agent-intelligence/
  execution` + `…/delegation`) behind `project.read` authorization with
  server-side work-item → project resolution (the delegation/routing route
  pattern), VALIDATED benchmark-mode override pass-through, and fail-closed
  typed error mapping. Wired through `app.ts` (composed AFTER the router —
  the pipeline order is structural), `index.ts`, and `api/server.ts`.
- **The two operations**: `recommendExecution` — the intelligence re-ranking
  of the router's already-eligible set with the ordered fallback chain and
  the full provenance (no eligible candidates → `recommended: null`, never a
  fallback; an ineligible candidate at the seam → typed rejection);
  `recommendDelegation` — the deterministic decomposition over the WORK-045
  catalog (roles resolved + revision-pinned; assignments from the
  intelligence ranking, explicitly unavailable when no eligible candidates
  exist; role history annotates with poor-success warnings and NEVER drops a
  task-profile-required unit), a `DelegationPlanInput`-shaped recommendation
  the caller submits through the EXISTING WORK-046 boundary.
- **The provenance model** on every result answers the four questions
  structurally: structured reasons; contributing evidence cells with sample
  sizes, rates, and observation windows (stale evidence surfaced as
  historical — the scoring is recency-independent); the constraints-already-
  applied record (the §22 `decisionId` anchor + the WORK-043 satisfied
  constraints carried verbatim); and the rejected alternatives with the
  AUTHORITY's blocking reasons (policy / capability / routing-carried
  classification, never invented).
- **Tests** (all pinned by title): the integration suite (21 tests on real
  PostgreSQL — the behavioral contract + the full 16-case adversarial matrix
  + tenant isolation + provenance + determinism + the no-mutation proof +
  the submission through the EXISTING delegation boundary), the unit suite
  (19 tests — the pure functions: the seam rejections, the tie-break chain,
  the neutral prior, the confidence model, the decomposition rules across
  profiles), and the API suite (6 tests — the route contract: authorization,
  server-side project resolution, mode validation, typed error mapping).
  Static architecture: the WORK-047 describe block (11 invariants — the
  pipeline-order pin, the forbidden-duplication matrix, the SELECT-only
  evidence pin, the no-migration pin, the determinism pins, the provenance
  contract pin, the adversarial-title pins, the work-order pins) appended to
  the shared suite (736 → 747).
- **Governance**: the same change executes the owed WORK-046 post-merge
  finalization (status complete + `mergedAs {pr: 60, mergeCommit:
  1f2bef93598433c65b874e58701bdec198289404}` + the active handoff removed +
  the work-order document updated, per §34.8/ADR-0007 and the 1ccc45f
  precedent) and activates WORK-047 (`in_flight`, branch + handoff + the
  truthfully-updated surfaces: the slice adds the `agent-intelligence`
  application layer and consumes the `execution-routing` public contract;
  `repository-intelligence` from the original reservation is NOT touched).
  The governance-state/parallel-eligibility pins are updated to the
  finalized truth (48 complete, WORK-047 the only in-flight item, frontier
  WORK-048; the discriminations retargeted from WORK-046 to WORK-047 with
  the in-flight-pair reconstruction).
- **Verification (this delivery)**: typecheck 0 errors; lint 0 errors (the
  2 pre-existing warnings); static architecture 747/747 (main baseline
  736/736 + 11 new); the agent-intelligence suites 46/46 (21 integration +
  19 unit + 6 API) on real PostgreSQL 18 AND pglite; development-governance
  50/51 (the 1 = the merged-finalization REAL-repository audit —
  characterized at delivery time as a pre-existing stale expected-value pin,
  a characterization the PR #75 architectural review CORRECTLY REJECTED and
  this branch has since remediated: see the review remediation record below;
  the WORK-046 finalization in this change FIXES the underlying WORK-046
  audit gap, the audit itself now passes 3/3); architecture-governance 40/40;
  FULL real-PG 18 sweep 110 files — 2413 passed / 1 failed (that audit);
  pglite full sweep 2369 passed / 44 skipped (real-PG-only) / 1 failed (the
  same); `governance:status` exit 0 and truthful (48 complete, WORK-047 in
  flight, merged finalized 3/3, frontier WORK-048).

## Review remediation record (2026-08-29 — PR #75 REQUEST CHANGES)

The architectural review of PR #75 approved the WORK-047 intelligence
direction and ordered ONE narrow governance correction; remediated on the
same branch (`feat/work-047-agent-intelligence`):

- **The defect (as the review correctly characterized it)**: the
  merged-finalization audit's architect-merge evidence matcher
  (`ARCHITECT_MERGE_SUBJECT_RE = ^(WORK-\d{3})\b`) accepted ANY subject
  beginning with a work-order id, so the WORK-052 post-merge finalization
  commit `1ccc45f` ("WORK-052 post-merge corrective finalization — … (#63)",
  the state-only squash of PR #63) was classified as a SECOND merge-evidence
  commit for WORK-052 — conflating the actual architectural merge
  (`47615c2`) with the post-merge state-only finalization that followed it.
  This is a provenance/audit-model defect (the very commit that established
  the finalization protocol misclassified as merge evidence for its own work
  order), NOT a stale exact-equality pin — the delivery report's earlier
  "pre-existing WORK-052-scope stale pin" characterization is withdrawn.
- **The correction (extremely narrow)**: the matcher now recognizes the
  SPECIFIC colon-separated architect-merge convention — `WORK-NNN: title`
  (both actual architect squash merges follow it: `WORK-046: Multi-Agent
  Delegation` at `1f2bef9`, `WORK-052: Development Governance & Self-Hosting
  Control Plane` at `47615c2`), exactly as `governance-model.json`
  `postMergeFinalization.enforcement` and ADR-0007 already record. Both
  legitimate merge-evidence shapes are preserved: the classic
  `Merge pull request #N from …` merge commit and the colon convention. A
  subject that merely BEGINS with the id names the work order as a topic and
  is not evidence.
- **The discriminating regression** (merged-finalization suite, 10 → 11
  tests): the REAL `1ccc45f` subject verbatim + generic state-only shapes
  (`WORK-052 post-merge finalization — …`, `WORK-046 post-merge corrective
  finalization — …`, `WORK-052 finalization`) are proven never to enter the
  evidence (exact-equality on `byWorkOrder`), plus the audit-level proof
  that a history containing ONLY a finalization commit does not bind the
  work order as merged (under the loose matcher that exact history produced
  a FALSE provenance gap against the truthful `47615c2` record). The
  multi-evidence test premise was corrected (multiple evidence entries are
  legitimate only for multiple ACTUAL architect merges — a finalization
  squash is not among them). The static suite pins the tightened convention
  and the new regression marker.
- **What was NOT done**: the merged-finalization check was not weakened or
  disabled (the matcher strictly NARROWS accepted evidence); no expected SHA
  was hard-coded (the REAL-repository audit's exact-equality assertion was
  already the truth — the matcher now classifies it); no WORK-047
  intelligence code changed; no new feature scope.
- **Verification (after the correction)**: typecheck 0 errors; lint 0
  errors (the 2 pre-existing warnings); static architecture 747/747;
  merged-finalization 11/11 (the REAL repository audits clean — WORK-052
  evidence exactly `47615c2`); development-governance 52/52;
  architecture-governance 40/40; FULL real-PG 18 sweep 110 files —
  **2415 passed / 0 failed** (the first post-correction sweep run had one
  timing-sensitive flake in the UNRELATED cross-mode-handoff relay test
  R1-#2b — the same test that flaked once on the original PR #75 CI run and
  passed on re-run there; it passes in isolation 44/44 and did not recur in
  the clean sweep); pglite sweep 2371 passed / 44 skipped / 0 failed;
  `governance:status` exit 0 and truthful (48 complete, WORK-047 in flight,
  merged finalized 3/3, frontier WORK-048).
