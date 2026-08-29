# WORK-046 — Multi-Agent Delegation

Status: IMPLEMENTED — reconciled onto current main@0541d13 (PR #60: integration merge retaining the round-1 remediation verbatim); awaiting architect re-review
Architecture: frozen v1.0 authority model + forward multi-agent intelligence direction (§33.9)
Dependencies: WORK-034, WORK-036, WORK-044, WORK-045

## Objective

Introduce a provider-neutral DELEGATION capability: a bounded multi-agent plan for **one existing Work Item** that assigns WORK-045 roles to execution units, coordinates their dependencies and sequencing, and executes every unit through the EXISTING execution boundary with heterogeneous native/external execution.

WORK-046 is a COORDINATION slice. The delegation layer is **coordination, not authority**:

```text
Work Item
   │
   └── Delegation Plan
         ├── Role A   (WORK-045 role catalog)
         ├── Role B
         ├── Role C
         └── ...
               │
               ↓
        existing ExecutionService
               │
        existing Sessions
               │
        existing Workspaces
               │
        existing Verification
               │
        existing Review
```

It does not implement agent intelligence (WORK-047), a second workflow engine, a second execution engine, a provider router, an eligibility evaluator, or any new authority.

## Governing contracts

- `/workflows` remains the workflow-state authority. A Work Item has ONE authoritative workflow; delegation NEVER mutates workflow state.
- `/agents` remains the execution/provider gateway authority. Every delegated execution is submitted through the EXISTING `ExecutionService.submit()` (built by the EXISTING `ExecutionTaskService`); there is NO second execution engine, no second AgentGateway, no provider implementation in the delegation layer.
- `/execution-policy` (WORK-043) remains the hard eligibility/selection policy authority. Delegation does not evaluate eligibility.
- WORK-044 remains the routing authority. Delegation does not rank or select among candidates.
- WORK-045 remains the role authority. Delegation CONSUMES the closed role catalog (`AgentRoleCatalogService`); it never redefines role semantics, never authors role definitions, and pins the historical `(roleId, roleRevision)` reference at plan creation (W045-AC10).
- `/verification` and `/reviews` remain the verification/review authorities. Delegation never evaluates evidence or reviews.
- One Work Item, one plan identity per logical plan: `(workItemId, planKey)` is the durable idempotent plan identity.
- ONE execution identity per delegated execution: every dispatch attempt references exactly one existing `wfos_executions.execution_id`; retries allocate a NEW attempt with a NEW execution identity while the logical unit identity and its role assignment stay stable.
- Native and external execution remain first-class: a plan may mix native and external units for the same logical Work Item.
- Delegation state is COORDINATION DATA, never a second Work Item lifecycle. Delegation may have internal coordination state (plan/unit/attempt records), but it must not quietly become a second Work Item state machine.

## Pre-implementation architectural checkpoint (REQUIRED before implementation starts)

This is the first work item developed under the WORK-051 governance model.
At implementation time the architecture-checkpoint process was itself under
review on PR #52, so the pre-implementation checkpoint was delivered as this
documented conformance matrix — evaluated against the proposed design BEFORE
implementation — plus the executable static invariants in the implementation
PR (the PR conformance checkpoint). The governance machinery has since
MERGED (WORK-051 as f2c996c, WORK-052 as 47615c2) and is now LIVE: the
integration round (below) re-verified the delegation implementation through
the now-live detectors, the shared validation engine, and the governance
state machinery, with zero design changes required.

The proposed delegation design must preserve, and the implementation must
prove structurally:

| # | Preservation requirement | Structural mechanism in the design | Executable proof |
|---|---|---|---|
| P1 | ONE Work Item | A plan is bound to exactly one `work_item_id` (FK); every unit's execution is built by the EXISTING `ExecutionTaskService` for THAT Work Item | migration FK + static invariant (no second work-item authority; no work-item writes) |
| P2 | ONE workflow authority | Delegation code contains NO workflow-state vocabulary, no transition map, no `wfos_workflow_executions`/`wfos_workflow_transitions` SQL, no WorkflowEngine access | static invariant: no hidden lifecycle state |
| P3 | ONE execution identity per delegated execution | `wfos_delegation_attempts.execution_id` is UNIQUE and references the existing execution record; the dispatch protocol submits each attempt exactly once through `ExecutionService.submit` with a deterministic `dispatchIdempotencyKey` (`delegation-unit-<unitId>-attempt-<n>`) | migration constraints + two-actor convergence tests |
| P4 | EXISTING role catalog | Units pin `(roleId, roleRevision)` resolved through `AgentRoleCatalogService.resolveRole` at plan creation; unknown roles fail closed; the delegation layer contains no role definitions | static invariant (consumes the catalog, never redefines it) + fail-closed tests |
| P5 | EXISTING execution policy | Delegation imports nothing from execution-policy; it performs no eligibility evaluation; capability declarations are consumed by the EXISTING boundaries at execution time | static invariant (no execution-policy imports/evaluation) |
| P6 | EXISTING routing | Delegation imports nothing from execution-routing; it performs no ranking/selection; provider validation mirrors the existing route pattern (registry-backed), not a router | static invariant (no execution-routing imports) |
| P7 | EXISTING verification | Delegation never imports /verification and never evaluates evidence | static invariant |
| P8 | EXISTING review | Delegation never imports /reviews and never produces review outcomes | static invariant |

The PR conformance checkpoint (static invariants in the implementation PR)
additionally looks for FORBIDDEN DUPLICATION:
- no second execution engine (no AgentGateway/provider implementation/registry in the delegation layer; exactly ONE `ExecutionService.submit` call site);
- no second role catalog or role-authoring surface;
- no second eligibility/routing engine;
- no second workflow/lifecycle engine ("no hidden lifecycle state");
- no new authority tables for execution history (delegation tables are coordination data referencing EXISTING identities);
- no scheduler (drive is explicit; no timers/cron/background loops).

## Scope

1. A durable, provider-neutral `DelegationPlan` for one existing Work Item: bounded unit list, each unit assigned a WORK-045 role (identity + revision pinned), a mode (`native`/`external`), a provider/model, and dependencies on other units in the same plan.
2. Idempotent plan creation: the same delegation request (same `(workItemId, planKey)`) converges on ONE authoritative plan; concurrent creation never duplicates units.
3. A coordination service that: validates the plan against the role catalog (fail closed), validates the dependency graph (acyclic; dependencies refer to units in the same plan), dispatches ready units (all dependencies succeeded) through the EXISTING `ExecutionTaskService` + `ExecutionService`, observes attempt outcomes through the EXISTING execution record (the outcome authority), and exposes structured plan/unit/attempt state.
4. Failure, retry, interruption, and partial completion: failed units are retryable (a NEW attempt with a NEW execution identity; the unit + role identity stable); interruption cancels pending units without touching in-flight executions; partial completion leaves the plan recoverable.
5. Heterogeneous execution: native and external units in one plan for the same Work Item.
6. Crash-safe dispatch: the attempt intent is durable BEFORE submission; a re-drive after a crash converges (observe-or-resubmit) without a duplicate logical execution.
7. A bounded HTTP surface (create/get/drive/retry/interrupt) behind the existing project authorization, with provider validation mirroring the existing execution route.
8. Real PostgreSQL two-actor regressions for the concurrency claims (below) and static architecture invariants for the boundary claims.

## Out of scope

- Agent Intelligence / learned role selection (WORK-047)
- Adaptive routing or new ranking logic (WORK-044)
- Eligibility evaluation (WORK-043)
- A second workflow engine or ANY Work Item lifecycle authority
- A second execution engine, session engine, or workspace engine
- New provider adapters
- Verification/review semantics
- Authorization/permission engine
- GitHub merge/CI authority
- Credential/secret storage
- Autonomous scheduling (timers/cron/background loops) — drive is explicit
- Multi-Work-Item orchestration (a plan is bounded to ONE Work Item)
- Frontend delegation UX

## Acceptance Criteria

### W046-AC01 — One plan identity per delegation request

Creating the same delegation request twice (same `(workItemId, planKey)`) returns the SAME authoritative plan — same plan id, same unit set. Two concurrent creators converge on one plan with no duplicate units.

Evidence: real-PG two-actor integration test.

### W046-AC02 — WORK-045 roles consumed, never redefined

Every unit carries `(roleId, roleRevision)` resolved through the existing `AgentRoleCatalogService`; unknown roles fail closed with a typed error; the delegation layer contains no role definitions and redefines no role semantics.

Evidence: integration tests + static architecture test.

### W046-AC03 — Existing execution boundary preserved

Every delegated execution is submitted through the existing `ExecutionService.submit()` on a task built by the existing `ExecutionTaskService` for the SAME Work Item. There is exactly one submit call site in the delegation layer; no provider/gateway is imported or implemented.

Evidence: static architecture test + integration tests (execution records carry the Work Item id).

### W046-AC04 — One execution identity per delegated execution

Each attempt references exactly one existing execution identity (`execution_id` UNIQUE per attempt); the dispatch idempotency key is deterministic per logical attempt; a crashed dispatch re-drive converges on ONE execution (no duplicate logical execution).

Evidence: migration constraints + crash/convergence integration tests.

### W046-AC05 — Retry preserves identities

Retrying a failed/unresolved unit allocates a new attempt (new execution identity) while the unit identity, its role identity, and its role revision stay stable.

Evidence: integration test.

### W046-AC06 — Dependencies and sequencing coordinate without lifecycle authority

A unit dispatches only when all its dependencies have succeeded; dependency cycles and cross-plan dependencies fail closed at plan creation; sequencing never mutates (or even reads as an authority) workflow state.

Evidence: integration tests + static architecture test.

### W046-AC07 — Heterogeneous native/external execution

One plan may contain native and external units for the same logical Work Item; native units complete synchronously through the existing native path; external units reach the existing handoff flow and stay in flight until their existing ingestion path terminalizes them.

Evidence: integration test.

### W046-AC08 — Failure, partial completion, interruption, recovery

A failed unit does not fail the plan (the plan stays recoverable); units depending on a failed unit stay pending; an interrupted plan cancels pending units without touching in-flight executions; retry after failure resumes the plan.

Evidence: integration tests.

### W046-AC09 — No hidden lifecycle state

The delegation layer declares NO workflow-state vocabulary, NO transition map, NO engine, and writes no workflow tables. Its coordination statuses (`active/completed/abandoned` for plans; `pending/dispatched/succeeded/failed/unresolved/cancelled` for units) are structurally disjoint from the frozen WorkflowState set.

Evidence: static architecture test (negative invariants).

### W046-AC10 — Structured state for WORK-047

The durable plan/unit/attempt records expose structured state (role pinning, dependency sets, per-attempt outcomes and details) sufficient for later intelligence to analyze without becoming an authority.

Evidence: integration tests asserting the structured records.

### W046-AC11 — Authorization + provider validation mirror the existing surfaces

The HTTP surface is project-authorized (`project.read`/`project.write`); native providers/models and external providers are validated against the existing registry exactly like the existing execution route; delegation adds no authorization or provider-selection semantics.

Evidence: route wiring + static architecture test.

### W046-AC12 — No scheduler

No timer, cron, queue consumer, or background loop drives delegation; every drive is an explicit call.

Evidence: static architecture test.

## Required two-actor PostgreSQL regressions (real PostgreSQL, two independent connections)

1. Same delegation request → ONE authoritative plan (concurrent creators converge).
2. Concurrent execution-unit creation/dispatch → no duplicate logical units or attempts.
3. Retry after crash → convergence (both crash windows: before record creation → re-submit; after record creation → observe).
4. Partial failure → recoverable plan.
5. Role identity → stable across retries.
6. Native/external mix → same logical Work Item.

## Required implementation evidence

- Unit/integration tests for plan validation (unknown role, cycle, cross-plan dependency, missing provider/model) — all fail closed with typed errors.
- The six two-actor regressions above.
- Static architecture invariants: the P1–P8 preservation matrix + the forbidden-duplication checks (including "no hidden lifecycle state").
- Typecheck and lint clean.
- Full repository regression suite clean on real PostgreSQL.

## Migration numbering note

This branch numbers its migration `0057_*`. At implementation time main's
last migration was `0051_*`, and `0052`–`0056` were reserved for the
then-pending WORK-051 branch (PR #52). That branch has since MERGED as
`f2c996c`, so `0052`–`0056` are now the merged WORK-051 migrations and
`0057` applies after them in filename order — the reservation resolved
exactly as coordinated (both merge orders stayed clean).

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a new workflow state, transition, or engine;
- mutating workflow/verification/review state from the delegation layer;
- a second execution engine, provider, or gateway;
- redefining or authoring role semantics;
- evaluating eligibility or ranking candidates;
- an autonomous scheduler;
- a new authoritative persistence model for execution history;
- multi-Work-Item orchestration;
- changing the frozen architecture version.

## Definition of Done

- W046 acceptance criteria have objective evidence.
- All required tests pass on CI.
- Architecture invariants pass (including "no hidden lifecycle state").
- PR contains only WORK-046 scope.
- Independent Architect Review approves the implementation PR.
- Implementation PR is merged.
- WORK-046 is then marked VERIFIED before WORK-047 becomes eligible.

## Integration record (2026-08-28 — reconciliation onto the current governance baseline)

The original implementation (head `f88cac4`, off `main` @ `5c7d5bb`) was
delivered before WORK-051/WORK-052 merged. The architect's review of PR #60
ordered two things before approval: reconciliation with the current `main`,
and the interruption-to-dispatch race regression. Both are delivered:

- **Round-1 remediation (retained VERBATIM on the branch)**: `0e15abf` closes
  the interruption-to-dispatch race at the durable-intent boundary — the
  migration's `wfos_delegation_attempt_requires_active_plan()` trigger takes
  `FOR SHARE` on the plan row inside the BEFORE INSERT on
  `wfos_delegation_attempts`, serializing the dispatch re-check against
  `interruptPlan`'s `active → abandoned` UPDATE; `75ca9b6` proves the race on
  TWO independent PostgreSQL connections (a stale pending snapshot can no
  longer allocate an attempt after the interruption commits, and the failed
  allocation rolls back completely — unit still `pending`, zero attempt rows).
- **Integration shape**: a MERGE of `main` @ `0541d13` (merge commit
  `a52b2e4`), deliberately NOT a rebase, so the two remediation commits
  remain on the branch exactly as reviewed. `main` @ `0541d13` carries the
  merged WORK-051 (`f2c996c`, migrations `0052`–`0056`), the merged WORK-052
  (`47615c2`) with its post-merge finalization (`1ccc45f`), and the
  owner-uploaded spec documents (the WORK-053–059 work orders + the
  governance protocol documents) — all now beneath the delegation slice.
- **Shared-surface resolution (no semantic change)**: (1) the static-suite
  append collision — main's WORK-052 describe block and this branch's
  WORK-046 describe block both append at the file end; both are preserved,
  WORK-052's first; (2) the WORK-040 "last migration" pin, advanced to
  `0057_` (after the merged WORK-051 migrations `0052`–`0056`);
  (3) the WORK-051 self-host checkpoint assertion ARCH-SELF-006 (the
  schema-migration head pin `expectedLastMigrationNumber`), advanced
  `56 → 57` — the same reserved-numbering coordination PR #52 round 4
  itself executed when it advanced the pin to 56; without this the frozen
  self-host checkpoint evaluates the real tree (which now contains `0057`)
  as `blocked`.
  `app.ts` / `api/server.ts` / `api/index.ts` / `index.ts` merged cleanly
  (the delegation wiring is purely additive beside the WORK-051/052
  composition).
- **Migration reservation resolved**: `0052`–`0056` are now the MERGED
  WORK-051 migrations; `0057_delegation_plans.sql` carries the resolved
  numbering note and the race-guard trigger from `0e15abf`, unchanged
  otherwise.
- **Governance machinery evaluation**: the delegation implementation was
  re-verified through the now-live WORK-051/052 machinery — the shared
  architecture-governance validation engine, the detector registry
  (incl. the governance-manifest detector under its ADR-0006 semantics),
  `arch:check`, `governance:status`, and the development-governance state
  invariants — with the delegation design PRESERVED as frozen (no
  modernization; no conflict was demonstrated).
- **Canonical state reconciliation**: `spec/development-state/program-state.json`
  WORK-046 entry + handoff updated to the integrated head (the merge
  `a52b2e4`); coordination records are durable history on both sides
  (WORK-051 merged `f2c996c`, WORK-052 merged `47615c2`).
- **Verification (this round)**: typecheck; lint; static architecture suite
  (the WORK-046 invariants beside the WORK-051/052 invariants); the
  delegation integration suite on real PostgreSQL 18 INCLUDING the
  two-connection interruption race regression; the development-governance
  suites against the reconciled canonical state; the full real-PG regression
  sweep; `arch:check`; `governance:status`. (Exact counts are recorded in the
  PR #60 integration report.)
- **Preserved by decision**: the delegation design itself is UNCHANGED by
  this round — the architect's rule was to reconcile with the new governance
  layer while preserving the frozen WORK-046 architecture; no conflict was
  demonstrated, so no design change was made.

## Round-3 correction record (2026-08-28 — the attempt-generation race)

The architect's round-3 review of PR #60 (CHANGES REQUIRED, on head
`20e72f6`) found one remaining blocking concurrency defect in
`PgDelegationRepository.recordAttemptOutcome()`: the attempt outcome row was
fenced by `attemptId`, but the unit-state mutation was fenced only by
`unit_id AND status IN ('dispatched', 'failed', 'unresolved')` — no fence
tying the unit mutation to the CURRENT attempt. That permitted:

```text
attempt 1 → unresolved → retry → attempt 2 allocated (unit = dispatched)
→ LATE attempt-1 result arrives → recordAttemptOutcome(attempt 1)
→ unit = succeeded   ← WRONG: attempt 2 is still executing
```

which could propagate into the plan-completion check and incorrectly complete
the delegation plan (a genuine violation of the retry contract, not a
cosmetic concern).

- **The fix (the attempt-generation fence)**: the unit-state mutation is now
  ATTEMPT-FENCED — it additionally requires the recorded attempt to BE the
  unit's current attempt, via
  `EXISTS (SELECT 1 FROM wfos_delegation_attempts a WHERE a.id = $3 AND
  a.unit_id = u.id AND a.attempt_no = u.attempt_count)`. The allocation
  transaction bumps `attempt_count` and inserts that very `attempt_no`
  atomically under the unit row lock, so the equality identifies exactly one
  live attempt — the current one. A result for attempt N-1 after a retry
  allocated attempt N is structurally incapable of changing the unit's
  current state: the fence rejects it, `recordAttemptOutcome` returns null,
  and the caller converges on the current row. The late outcome is still
  recorded on the attempt row itself (per-attempt history stays truthful);
  only the unit's CURRENT state (and through it the plan-completion check)
  is owned by the CURRENT attempt. Under READ COMMITTED the fence is also
  correct in the blocked-then-reevaluated interleaving: PostgreSQL
  re-evaluates the WHERE (including the EXISTS fence) against the NEW
  committed row version, so a unit whose current attempt just became N+1
  rejects a result for attempt N even when the stale recorder's UPDATE was
  already in flight on a second connection. No schema change was needed —
  the fence is established inside the durable operation itself, from the
  existing allocation invariant.
- **The regression** (`delegation-attempt-generation-race.integration.test.ts`,
  real PostgreSQL 18, TWO independent connections — mirroring the `75ca9b6`
  precedent): T1 is the late attempt-1 outcome recorder (the exact production
  `recordAttemptOutcome` transaction shape, paused between its two
  statements), T2 is the retry allocation on an independent connection (the
  production dispatch transaction). T1's unit UPDATE genuinely BLOCKS on
  T2's row lock (proven by a contention probe — it cannot resolve while T2
  holds the lock); when T2 commits the retry, the blocked UPDATE
  re-evaluates against the NEW row version and the fence rejects the stale
  mutation. All three architect-required directions are covered: stale
  attempt-1 SUCCESS → unit REMAINS dispatched on attempt 2; stale attempt-1
  FAILURE → unit REMAINS dispatched on attempt 2; attempt 2 resolves → the
  unit takes the attempt-2 outcome → the plan may complete (success →
  plan `completed`; failure → unit `failed` + plan stays `active` and
  recoverable). A sequential form (through the production repository
  methods) covers the same contract on BOTH the pglite and real-PG paths.
- **Discrimination proof**: against the UNFENCED repository (the pre-fix
  head), all three regression tests FAIL (the unit flips to the stale
  attempt's outcome exactly as the architect described); with the fence,
  all three pass.
- **Static pin**: invariant (k) in the WORK-046 describe block pins the
  fence in the repository SQL, the same fence inside the regression's
  mirrored SQL, the contention proof, and the three required scenario
  titles — the fix is now structurally enforced.
- **Design scope**: the coordinator's convergence semantics are unchanged
  (a fenced-away stale record returns null → converge on the current row,
  exactly as a lost CAS already did); no new state, no new authority, no
  scheduler, no workflow vocabulary — the delegation design itself is
  otherwise UNCHANGED.
- **Verification (this round, real PostgreSQL 18)**: typecheck 0 errors;
  lint 0 errors (2 pre-existing warnings); static architecture 736/736
  (+1: the attempt-generation fence invariant); the delegation suites
  15/15 (11 plans + 3 new race regressions + the round-1 interruption
  race); development-governance + architecture-governance 90/91 (the 1 =
  the documented pre-existing merged-finalization pin failure, WORK-052
  scope, identical on `main`); full real-PG sweep 107 files — 2356 passed /
  1 failed (the same pre-existing failure); pglite full sweep 2312 passed /
  44 skipped / 1 failed (the same one); `governance:status` exit 0 and
  truthful.
