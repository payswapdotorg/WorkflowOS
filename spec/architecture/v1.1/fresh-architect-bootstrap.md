# WorkflowOS — Fresh Architect Bootstrap

> **The repository, not the previous conversation, is authoritative.**

This document is the bootstrap for a completely new Architect LLM that
has lost all conversational context. A new ChatGPT conversation can
begin with: "You are the architect of WorkflowOS. Inspect the repository
and take over." — and the new architect can reconstruct the entire
program from the repository alone.

## 1. Where the frozen architecture is

The frozen v1.0 architecture is the GOVERNING architecture. It is
immutable; changes require the architecture-change/versioning authority
(ACR + new ArchitectureVersion).

- `spec/architecture.md` — the v1.0 architecture document.
- `spec/architecture-lock.md` — the v1.0 architecture lock (the frozen
  invariants).
- `spec/requirements.md` — the v1.0 requirements.
- `spec/work-items.md` — the v1.0 work items.
- `spec/dependency-graph.md` — the v1.0 dependency graph (human-readable
  design-time view).
- `spec/governance/governance-model.json` — the v1.0 governance model
  (code-pinned vocabularies: control loop, assurance profiles, change
  surfaces, proof classes, checkpoint kinds, work-order statuses,
  feedback origins, core self-hosting prohibitions, completion rule,
  post-merge finalization protocol).
- `spec/governance/assurance-profiles.json` — the v1.0 assurance
  profiles.
- `spec/governance/architect.json` — the architect's decision rights and
  non-delegable authorities.
- `spec/governance/checkpoint-contract.json` — the v1.0 checkpoint
  contracts.
- `spec/governance/worker-protocol.json` — the v1.0 worker protocol.
- `docs/adr/` — the ADRs (ADR-0001..0007 as of this writing).

The frozen v1.0 control loop is the 10-stage loop:
`SENSE → UNDERSTAND → PLAN → CHECK → EXECUTE → VERIFY → REVIEW → RELEASE → OBSERVE → LEARN → SENSE`.
It is code-pinned in
`backend/src/architecture-checkpoints/internal/governance-validation.ts`
as `CONTROL_LOOP_STAGES`. Adding a stage (e.g., `VALIDATE` — see the
v1.1 evolution) requires touching the code AND the artifact AND the
tests (the no-silent-rewrite property).

## 2. Where the proposed evolution is

The v1.1 evolution is PROPOSED. It is additive; it does not rewrite v1.0.
v1.1 becomes governing ONLY through ACR-001 (and the new ACR-002 for the
validation sub-evolution) approval by the architecture authority.

- `spec/architecture/v1.1/README.md` — the v1.1 package overview.
- `spec/architecture/v1.1/architecture.md` — the v1.1 architecture
  document (the Engineering Control Loop, complexity-adaptive
  engineering, system model, quality attributes, engineering signals,
  change programs, transformation completeness, operational/release
  governance, architecture evolution, self-hosting).
- `spec/architecture/v1.1/architecture-lock.md` — the v1.1 lock
  (forward-evolution invariants, additive to v1.0).
- `spec/architecture/v1.1/dependency-graph.md` — the v1.1 dependency
  graph (the design-time view; the canonical mapping is
  `spec/development-state/dependency-state.json`).
- `spec/architecture/v1.1/work-items.md` — the v1.1 work items table.
- `spec/architecture/v1.1/artifact-taxonomy.json` — the artifact
  taxonomy (normative, authoritative, derived, evidence).
- `spec/architecture/v1.1/reconciliation-record.md` — the reconciliation
  record (the 2026-08-29 architect verdict and identity resolution).
- `spec/architecture/v1.1/control-system-evolution.md` — the closed-loop
  control system evolution (the `VALIDATE` stage, the agents-as-bounded-
  workers distinction, the authority chain).
- `spec/architecture/v1.1/research-rationale.md` — the research-derived
  rationale (the mature software engineering loop, the three
  complementary proof classes, source references).
- `spec/architecture/v1.1/validation-model.md` — the continuous product
  validation domain model (ValidationJourney, ValidationRun,
  TestIdentity, Environment, EffectPolicy, ExpectedObservation,
  Evidence).
- `spec/architecture/v1.1/adaptive-assurance-evolution.md` — the
  validation-aware assurance dimension (additive to v1.0's
  `spec/governance/assurance-profiles.json`).
- `spec/architecture/v1.1/dogfooding-model.md` — the dogfooding/self-
  hosting model (the canonical customer-product and self-hosting flows).
- `spec/architecture/v1.1/dogfooding-evidence/` — the durable dogfooding
  EVIDENCE artifacts (runtime/user-feedback/validation observations; mapped
  into the existing governance evidence taxonomy — see `artifact-taxonomy.json`).
  The first artifact, `2026-08-30-onboarding-attempt.md`, records the
  2026-08-30 customer dogfooding experiment that was ATTEMPTED and STOPPED at
  onboarding (the runtime does not yet provide the required production
  authentication or a local runtime database path). It is EVIDENCE, not
  normative or authoritative; it does not directly mutate state.
- `spec/architecture/v1.1/continuous-validation-lifecycle.md` — the
  three operating modes (PRE_MERGE, POST_RELEASE, CONTINUOUS) and their
  EffectPolicy/assurance bindings.
- `spec/architecture/v1.1/evidence-provenance-model.md` — the three-tier
  evidence model (raw observation → validation result → formal
  verification evidence, provenance preserved).
- `spec/architecture/v1.1/parallel-execution-metadata.md` — the
  parallel-execution metadata model (parallelEligibility,
  parallelConflicts, protectedSurfaces).
- `spec/architecture-change-requests/ACR-001-v1-1-adaptive-engineering-
  control-system.md` — ACR-001 (the original v1.1 ACR).
- `spec/architecture-change-requests/ACR-002-continuous-product-
  validation.md` — ACR-002 (the continuous product validation sub-
  evolution ACR).

## 3. Where Work Orders live

- `spec/work-orders/` — the canonical Work Order spec files
  (`WORK-NNN.md`). The authoritative identity surface: exactly one
  `WORK-NNN.md` per Work Order identity, plus `TEMPLATE.md`. Retired/
  superseded identity material lives in `spec/archive/` under distinct
  identities (e.g., `UW-053..059` for the retired upload wave).
- `spec/development-state/program-state.json` — the canonical program
  state. `workOrders[]` records the activated Work Orders (complete,
  in_flight). PLANNED Work Orders (WORK-053..061, WORK-065..070,
  WORK-071..074) are spec files only — they are NOT in `program-state.json`
  until the architect activates them.
- `spec/development-state/dependency-state.json` — the canonical
  dependency mapping. `futureGeneration` maps each planned Work Order
  to its dependencies; `futureGenerationEligibility` records the
  eligibility of each.
- `spec/development-state/frontier-state.json` — the derived frontier
  state (`plannedNext`, `plannedFuture`, known conflicts, resolved
  conflicts).
- `spec/governance/future-roadmap.json` — the canonical future roadmap
  (sequence + parallelWaves). The sequence MUST exactly equal
  `Object.keys(dependency-state.json futureGeneration)` (the
  work-order-identity test enforces this).

## 4. Where program state lives

- `spec/development-state/program-state.json` — the canonical program
  state (the governing architecture version, the activated Work Orders,
  the resumption protocol, the decisions).
- `spec/development-state/governance-model.json` — the canonical
  governance model (the code-pinned vocabularies and contracts).
- `spec/development-state/dependency-state.json` — the canonical
  dependency mapping.
- `spec/development-state/frontier-state.json` — the derived frontier
  state.
- `spec/development-state/checkpoint-state.json` — the checkpoint
  state.
- `spec/development-state/README.md` — the development-state README
  (the schema and authority).

The canonical state is loaded fail-closed by
`backend/src/development-governance/internal/governance-state-loader.ts`
and validated by
`backend/src/architecture-checkpoints/internal/governance-validation.ts`.
A state that does not validate is never served.

## 5. Where dependencies live

- `spec/dependency-graph.md` — the v1.0 human-readable design-time
  dependency graph.
- `spec/architecture/v1.1/dependency-graph.md` — the v1.1 design-time
  dependency graph (additive to v1.0).
- `spec/development-state/dependency-state.json` — the canonical
  machine-readable dependency mapping. `futureGeneration` is the ONE
  canonical dependency mapping for planned Work Orders.
- Each Work Order spec file's `Dependencies` section — the human-readable
  dependency declaration for that Work Order.

The DAG must be acyclic (Kahn's algorithm check in the validation engine).
No duplicate Work Order identities (the identity-surface check in the
validation engine).

## 6. How activation works

A Work Order moves from `planned` (spec file only) to `in_flight`
(activated) ONLY through the architect's authorization. The activation
is recorded in `program-state.json` → `workOrders[]` with:

- `id`, `title`, `status: 'in_flight'`;
- `dependencies` (the Work Order IDs this Work Order depends on);
- `branch` (the implementation branch);
- `pr` (the implementation PR number, when opened);
- `surfaceFlags` (the declared change-surface flags — must match the
  code-pinned closed set);
- `assuranceProfile` (must match the deterministic selection for the
  declared surfaces);
- `surfaces` (the declared change surfaces for parallel-protocol
  conflict detection);
- `coordination` (if the Work Order has incomplete dependencies —
  mutual coordination records).

The architect's authorization is non-delegable (per
`spec/governance/architect.json`). Implementation agents cannot activate
Work Orders.

## 7. What the current frontier is

Read `spec/development-state/frontier-state.json` → `plannedNext` and
`plannedFuture`, and `spec/development-state/program-state.json` →
`workOrders[]` (filter by status).

As of this writing (the 2026-08-30 governance state + the v1.1 continuous
product validation roadmap):

- 55 Work Orders are `complete` (WORK-001..045, WORK-046..052, WORK-062,
  WORK-063, and WORK-064) — all with merge evidence.
- WORK-062 (Durable Multi-Agent Orchestration Substrate) is `complete`
  (activated 2026-08-30; merged by the architect as `f0855d2` via PR #82
  on 2026-08-30, squash-merged at the approved review-remediated head
  `1caa259`; finalized complete per §34.8/ADR-0007 — the post-merge
  finalization merged as `46e7858` via PR #83; the canonical state records
  `status: complete` with the full `mergedAs` provenance identity:
  pr 82, mergeCommit f0855d2955dcf2d3edea683e497902ad30778fc8).
- WORK-063 (Identity and Access Layer) is `complete` (merged by the
  architect as `8dac9c47f7397e22765478520ac71659d37e1783` via PR #81 on
  2026-08-30, squash-merged at branch head `f86d1f2` — the tree is
  identical to the approved rebased head; finalized complete per
  §34.8/ADR-0007; the canonical state records `status: complete` with the
  full `mergedAs` provenance identity: pr 81, mergeCommit
  8dac9c47f7397e22765478520ac71659d37e1783). The merged delivery is
  SPEC-ONLY — the identity-and-access architecture decision, the Work
  Order, and the dependency-model correction; NO runtime implementation
  rode the merge, and the runtime identity layer remains UNIMPLEMENTED
  (architect-gated future work).
- WORK-064 (Continuous Product Validation — the domain/model authority) is
  `complete` (ACTIVATED by the architect on 2026-08-30 after the approved
  implementation plan merged as `4018f42`; implemented on branch
  `feat/work-064-continuous-validation`, PR #86; merged by the architect as
  `c3514512cb5bcf7694f551d1f1bac9b1ee2d3c3b` on 2026-08-30, squash-merged at
  the approved head `524c3f4` — the tree is identical; finalized complete
  per §34.8/ADR-0007; the canonical state records `status: complete` with
  the full `mergedAs` provenance identity: pr 86, mergeCommit
  c3514512cb5bcf7694f551d1f1bac9b1ee2d3c3b; the domain/model authority is on
  main at `backend/src/continuous-validation/`).
- WORK-053..061 are `planned` (spec files only; NOT in program-state).
- WORK-065..070 are `planned` (spec files only; NOT in program-state;
  new in this package).
- WORK-071, WORK-072, WORK-073, WORK-074 are `planned` (spec files only;
  NOT in program-state; new in the 2026-08-30 customer dogfooding
  experiment's governed follow-up — see
  `spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`).
  WORK-074 (Identity & Access Runtime Activation — the "WORK-063-RUNTIME" of
  the experiment's design) is the runtime implementation of WORK-063's spec;
  WORK-071 is the local development runtime substrate; WORK-072 and
  WORK-073 are frontend product-defect fixes. The dogfooding gate (§12)
  requires WORK-074 complete AND WORK-071 complete (or equivalent supported
  runtime).

The frontier's `plannedNext` holds FOUR dependency-eligible heads across
three tracks, all PLANNED and NOT activated: WORK-053 (ACR-001;
dependency-eligible on WORK-046+WORK-051+WORK-052, all complete; remains
PLANNED — the architect's 2026-08-29 verdict says "Do not activate WORK-053
yet", additionally gated on the v1.1/ACR-001 disposition) and WORK-065
(ACR-002; dependency-eligible now that its only dependency WORK-064 is
complete; remains PLANNED, NOT activated, NOT started — the architect's
authorization is required; WORK-067 is equally eligible — different protected
surfaces — and equally NOT activated), PLUS the two dogfooding-gate enablers
issued by the 2026-08-30 customer dogfooding experiment's governed follow-up:
WORK-071 (Local Development Runtime Substrate; deps WORK-003+WORK-023, both
complete) and WORK-074 (Identity & Access Runtime Activation — the
"WORK-063-RUNTIME" of the dogfooding experiment's design; deps WORK-063
complete). WORK-072 (Authentication State Synchronization; no hard deps) and
WORK-073 (Create Project Organization Selection; no hard deps) are the two
frontend product-defect fixes (also PLANNED). All four are
dependency-eligible and remain PLANNED, NOT activated, NOT started — the
architect's authorization is required. Dogfooding was ATTEMPTED on 2026-08-30
and STOPPED at onboarding
(see `spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`);
the dogfooding gate (§12 below) now requires WORK-074 complete AND WORK-071
complete (or equivalent supported runtime) — the repository no longer implies
that merely merging WORK-063's architecture specification means real
authentication exists.

## 8. How to review implementation agents

The architect (Architect LLM) performs routine implementation-code
review. The human does NOT perform routine implementation-code review.
The architect's review responsibilities (per
`spec/governance/architect.json`):

- `approve-architecture-change` (ACR approval — non-delegable);
- `approve-work-order` (Work Order activation — non-delegable);
- `approve-checkpoint-verdict` (checkpoint review);
- `approve-merge` (merge authorization — non-delegable for governing
  changes);
- `reject-implementation` (reject an implementation PR);
- `authorize-remediation` (authorize a remediation Work Item).

The architect's non-delegable authorities:

- `change-governing-architecture` (ACR approval);
- `weaken-frozen-invariant`;
- `bypass-verification`;
- `bypass-review`;
- `bypass-merge-gate`.

Implementation agents:

- propose changes and evidence;
- cannot exercise architectural or merge authority;
- one Work Item branch/PR at a time;
- bounded workers.

When reviewing an implementation PR:

1. verify the PR's scope matches the Work Order's `Allowed` section;
2. verify the required invariants hold with objective evidence (the
   Work Order's `Required proof` section);
3. verify the no-second-authority matrix passes (static architecture
   invariants);
4. verify mutation/discrimination tests are present and pass (the
   invariants are discriminating);
5. verify typecheck and lint are clean;
6. verify the full repository regression suite is clean;
7. recommend merge or request changes.

## 9. How to determine parallel eligibility

Read each Work Order's `parallel-execution metadata` section (in the
spec file) and compute:

1. **dependency check** — for each declared dependency, is it
   `complete`? (read `program-state.json` → `workOrders[]`). If not,
   the Work Order is `BLOCKED`.
2. **conflict check** — for each declared `parallelConflicts.surfaces`
   and `protectedSurfaces`, is any other active Work Order touching the
   same surface? If yes, the Work Order is `CONFLICTING` (coordination
   required — mutual coordination records per ADR-0003).
3. **eligibility** — if all dependencies are `complete` and no
   uncoordinated conflicts exist, the Work Order is `READY`.
4. **parallelism** — if `READY` and no shared protected surfaces with
   any other active Work Order, the Work Order is `PARALLEL-SAFE`;
   otherwise `CONFLICTING`.

The existing v1.0 parallel-eligibility engine
(`backend/src/development-governance/internal/default-development-governance-service.ts`
→ `evaluateParallelEligibility`) computes this from `program-state.json`
surfaces and coordination records. The v1.1 parallel-execution metadata
EXTENDS the engine with explicit `parallelEligibility`,
`parallelConflicts`, and `protectedSurfaces` declarations on each Work
Order spec file.

See `spec/architecture/v1.1/parallel-execution-metadata.md` for the
full model.

## 10. How to handle architecture changes

An architecture change requires:

1. an Architecture Change Request (ACR) — persisted in
   `spec/architecture-change-requests/ACR-NNN-*.md`;
2. the architect's approval (non-delegable);
3. a new immutable ArchitectureVersion (recorded in `/architecture`);
4. if the change touches a code-pinned vocabulary (the control loop, the
   assurance profiles, the change surfaces, the proof classes, the
   checkpoint kinds, the work-order statuses, the feedback origins, the
   core self-hosting prohibitions, the completion rule, the post-merge
   finalization protocol), the code in
   `backend/src/architecture-checkpoints/internal/governance-validation.ts`
   must be updated in the same change (the no-silent-rewrite property);
5. if the change touches a test's hardcoded expectations (e.g., the
   control loop list in `governance-state.integration.test.ts`), the
   test must be updated in the same change.

No self-hosted worker may rewrite a governing version in place. No
implementation agent may approve an ACR.

## 11. How to interpret historical records

Historical records (retired upload-wave material, superseded ADRs,
reconciliation records) are preserved as history. They are NOT
authoritative.

- `spec/archive/upload-wave-2026-08-28/` — the retired upload wave
  (UW-053..059 identities; explicitly non-authoritative; the
  machine-readable retirement record is `index.json`).
- `spec/architecture/v1.1/reconciliation-record.md` — the 2026-08-29
  reconciliation record (the identity collision resolution; the architect
  verdict that chose the issue track as canonical).
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — dated
  authoring records (design and plan documents); they record the
  authoring-time thinking, not the current state.

When a historical record contradicts the canonical state, the canonical
state wins. The canonical state is:
`spec/development-state/program-state.json` +
`spec/development-state/dependency-state.json` +
`spec/work-orders/WORK-NNN.md` (the architect-issued files).

## 12. How to initiate customer-product dogfooding

Read `spec/architecture/v1.1/dogfooding-model.md` (especially §8, updated by
the 2026-08-30 customer dogfooding experiment's governed follow-up). The
first official dogfood run begins only after:

1. **WORK-074 (Identity & Access Runtime Activation — the runtime
   implementation of WORK-063's spec) is complete and merged** (the normal
   authentication path is functional; the demo key is retired from the
   customer login path). WORK-063 (the SPEC) is already merged complete as
   `8dac9c4` via PR #81 (spec-only, finalized §34.8/ADR-0007) — but the spec
   merge is NOT the runtime. The gate references WORK-074 (the runtime), NOT
   WORK-063 (the spec), because the runtime identity layer remains
   UNIMPLEMENTED until WORK-074 lands. The 2026-08-30 dogfooding experiment
   confirmed this empirically (finding F-1: the LoginPage exposes ONLY an
   API-key input; there is NO Google/GitHub/email login surface).
2. **WORK-071 (Local Development Runtime Substrate) is complete, OR an
   equivalent supported runtime environment is available** (the application
   can be exercised locally against real authorities without an externally
   hosted PostgreSQL). The experiment confirmed the gap empirically (finding
   F-2: the composition root leaves `database` undefined when `DATABASE_URL`
   is absent; no local fallback exists; a PGlite adapter already exists but
   is not wired for a dev path).
3. WORK-064 (Continuous Product Validation) is implemented and merged —
   SATISFIED: COMPLETE (merged as `c351451` via PR #86 and finalized
   §34.8/ADR-0007 on 2026-08-30; the domain/model authority is on main);
4. WORK-065 (Synthetic Browser Validation Agent) is implemented and
   merged;
5. the existing v1.0 authorities are operational.

Until these are in place, the dogfood run is staged: the customer
journeys that do not require authentication can run in PRE_MERGE; the
authenticated journeys are FORBIDDEN until WORK-074 lands.

**The dogfooding experiment was ATTEMPTED on 2026-08-30 and STOPPED at
onboarding** (the runtime does not yet provide the required production
authentication or a local runtime database path). The empirical findings are
persisted in
`spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`:
seven findings (F-1 no production authentication runtime → WORK-074; F-2 no
local development runtime database path → WORK-071; F-3 LoginPage auth-state
synchronization defect → WORK-072; F-4 Create Project organization-selection
defect → WORK-073; F-5 POSITIVE — authority read failure → explicit error →
no fabricated empty state, no Work Item; F-6 GitHub/Vercel/LLM configuration
not exercisable — blocked-by-prerequisite; F-7 target product could not be
fully built/deployed — blocked-by-prerequisite consequence). A fresh Architect
LLM must NOT confuse WORK-063's merged spec with the runtime identity layer
(WORK-074) the gate actually requires, and must NOT imply the dogfooding gate
is satisfied merely because WORK-063's architecture specification merged.

The dogfood run exercises the canonical acceptance journey:
authentication, organization, project, GitHub connection, Vercel
connection, LLM configuration, agent configuration, planning, work
orders, execution, parallelism, verification, review, deployment,
browser validation. A release of WorkflowOS is not honestly complete
until the dogfood run exercises this journey end-to-end against a real
deployment.

## 13. How validation failures become Work Items

Read `spec/architecture/v1.1/evidence-provenance-model.md`. The
canonical flow:

```text
Validation failure (a typed validation_failure outcome)
    ↓
Evidence (provenance preserved — run, journey, step, environment)
    ↓
Engineering Signal (WORK-067 — correlated, deduplicated, regression-
                    likelihood-assessed)
    ↓
governed assessment (severity, scope, blast radius)
    ↓
Work Item (WORK-068 — through the EXISTING /work-items authority)
    ↓
the existing governance lifecycle
```

The browser agent (WORK-065) observes. The signal system (WORK-067)
assesses. The Work Item system (WORK-068, the existing `/work-items`
authority) governs change. The architect governs implementation review.
No browser agent may directly modify code because it found a failure.

The invariant: no customer-product validation failure may be silently
discarded, converted into a false healthy state, or directly converted
into an ungoverned code change.

### 13.1 The dogfooding experiment already produced findings → governed Work Orders

The 2026-08-30 customer dogfooding experiment (see
`spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`)
produced empirical findings that became governed Work Orders — through the
EXISTING authority, NOT through the not-yet-implemented WORK-067/068 signal
pipeline. The flow that actually operated:

```text
dogfooding evidence (the evidence artifact — provenance preserved)
    ↓
governed classification (each finding classified: PRODUCT BUG /
    ARCHITECTURE/GOVERNANCE / POSITIVE / BLOCKED-BY-PREREQUISITE;
    severity P0–P3)
    ↓
governed Work Order (through the EXISTING architect-issued Work Order
    authority: spec/work-orders/WORK-NNN.md — the same authority the
    WORK-067/068 pipeline will eventually feed)
    ↓
the existing governance lifecycle (planned → architect-activated →
    implemented → verified → reviewed → merged)
```

The product-defect findings (F-3 → WORK-072, F-4 → WORK-073) and the
runtime-enabler findings (F-1 → WORK-074, F-2 → WORK-071) are governed Work
Orders, PLANNED, NOT activated. The positive finding (F-5) recorded NO Work
Item (the Workbench provenance correction is working). The
blocked-by-prerequisite findings (F-6, F-7) recorded NO Work Order (they are
unblocked indirectly by the dogfooding gate). This is the invariant operating
in practice: no finding was silently discarded, converted into a false healthy
state, or directly converted into an ungoverned code change. When WORK-067/068
land, the same flow will be automated (the signal pipeline + the feedback
converter), but the authority is the same: the EXISTING /work-items authority
governs the change; the architect governs the review.

## 14. How to resume after losing all conversation context

1. Read this document (`spec/architecture/v1.1/fresh-architect-
   bootstrap.md`).
2. Read `spec/development-state/program-state.json` (the canonical
   program state — the governing architecture version, the activated
   Work Orders, the decisions).
3. Read `spec/development-state/dependency-state.json` (the canonical
   dependency mapping — `futureGeneration`, `futureGenerationEligibility`).
4. Read `spec/development-state/frontier-state.json` (the derived
   frontier — `plannedNext`, `plannedFuture`, known/resolved conflicts).
5. Read `spec/governance/future-roadmap.json` (the canonical roadmap —
   `sequence`, `parallelWaves`).
6. Read `spec/governance/architect.json` (the architect's decision
   rights and non-delegable authorities).
7. Read `spec/governance/governance-model.json` (the code-pinned
   vocabularies and contracts).
8. Read the Work Order spec files for the in-flight and planned Work
   Orders (`spec/work-orders/WORK-NNN.md`).
9. Run `cd backend && bun run governance:status` (the canonical
   governance-status CLI — answers from the repository alone).
10. Run `cd backend && bun run arch:check` (the static architecture
    suite).
11. Run `cd backend && bun run typecheck && bun run lint` (the
    typecheck and lint gates).

The repository, not the previous conversation, is authoritative. A
fresh Architect LLM that completes steps 1–11 has reconstructed the
entire program.

## 15. The authority model (the one-page summary)

```text
Human
= product/business/consequential approvals
= ACR approval, work-order activation, governing-merge authorization

Architect LLM
= architecture authority
= Work Order authority
= checkpoint authority
= PR review authority
= drift detector
= merge recommendation/authorization

Implementation agents
= bounded workers (one Work Item branch/PR at a time)

Browser/synthetic agents
= validation workers (observe; never mutate code, merge, approve)
```

Implementation agents do not replace architectural review. The human
should not be required to perform routine implementation-code review.
The architect performs that review; the human performs the
consequential approvals.

## 16. The closing rule

> The repository, not the previous conversation, is authoritative.

If this document, the canonical state files, the Work Order spec files,
the ADRs, and the ACRs disagree with any prior conversational context,
the repository wins. A fresh Architect LLM that reads the repository
has the same authority as the original architect.
