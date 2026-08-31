# ACR-002 — WorkflowOS v1.1 Continuous Product Validation Sub-Evolution

Status: proposed.

## Motivation

WorkflowOS has a strong governed change-execution model (v1.0) and a
proposed v1.1 adaptive engineering control system (ACR-001). The v1.0
control loop is `SENSE → UNDERSTAND → PLAN → CHECK → EXECUTE → VERIFY →
REVIEW → RELEASE → OBSERVE → LEARN → SENSE` — but the loop is OPEN
between RELEASE and OBSERVE: the system releases, then passively waits
for runtime failures to observe. There is no deliberate stage that
exercises the released system against meaningful customer journeys
before customers are affected.

The research program established that mature software engineering is a
continuous loop that includes deliberate validation of the released
system, runtime observation, and learning from both. The v1.1 evolution
(ACR-001) established the connective governance; this ACR adds the
VALIDATE stage and the continuous product validation sub-evolution that
closes the loop.

## Current architecture

Frozen v1.0 separates architecture, requirements, work items, workflow,
execution, verification, review, GitHub, runtime, and audit authorities.
WORK-051/052 added executable checkpoints and repository-resident
development governance. ACR-001 (proposed, not yet approved) adds the
v1.1 adaptive engineering control system: the Engineering Control Loop,
System Model, Quality Attributes, Engineering Signals, Change Programs,
Adaptive Assurance, Operational/Release Governance, Architecture
Fitness, and Self-Hosting Conformance.

The v1.0 control loop does not include a `VALIDATE` stage. The
`OBSERVE → LEARN → SENSE` chain is present but passive: the system
observes only what fails organically.

## Proposed evolution

Create a continuous product validation sub-evolution that:

1. adds an explicit `VALIDATE` stage to the v1.1 control loop (between
   `RELEASE` and `OBSERVE`), making the loop closed;
2. establishes the continuous product validation domain model
   (`ValidationJourney`, `ValidationRun`, `TestIdentity`, `Environment`,
   `EffectPolicy`, `ExpectedObservation`, `Evidence`);
3. integrates a synthetic browser validation agent (the Z.ai agent-browser
   style capability) as the execution mechanism for ValidationJourneys;
4. adds validation scheduling and change triggers (PRE_MERGE,
   POST_RELEASE, CONTINUOUS) bound to assurance-aware selection;
5. adds engineering signal correlation and regression detection that
   consumes validation-originated signals;
6. adds feedback-to-governed-Work-Item conversion through the EXISTING
   `/work-items` authority;
7. adds progressive release and runtime validation bound to canary/
   partial rollout, with governed continue/halt/recover decisions;
8. adds continuous architecture fitness as the closed-loop synthesis of
   quality-attribute observations, engineering signals, and release/
   runtime evidence → architecture risk recommendation → ACR;
9. makes dogfooding a permanent WorkflowOS capability (WorkflowOS-as-a-
   product and WorkflowOS-as-its-own-customer-product);
10. persists a Fresh-Architect Bootstrap artifact so a new Architect LLM
    can reconstruct the program without conversational context.

The sub-evolution is implemented through seven new Work Orders
(WORK-064..070), each carrying parallel-execution metadata
(`parallelEligibility`, `parallelConflicts`, `protectedSurfaces`) so an
Architect LLM can mechanically determine READY/BLOCKED/PARALLEL-SAFE/
CONFLICTING.

## Alternatives rejected

1. **Rewrite v1.0 in place** — rejected because historical architecture
   and its invariants must remain immutable. The v1.0 control loop is
   code-pinned; adding `VALIDATE` requires touching the code, the
   artifact, and the tests in the same change (the no-silent-rewrite
   property), and only after ACR approval.
2. **Add a second verification authority for validation evidence** —
   rejected because it duplicates the existing `/verification` authority
   and breaks the provenance chain. Validation evidence maps INTO
   `/verification` as a derived artifact.
3. **Add a browser agent with code-mutation authority** — rejected
   because it concentrates authority in a runtime mechanism and breaks
   the no-direct-code-change invariant. The browser agent observes; the
   Work Item system governs change; the architect governs implementation
   review.
4. **Run validation only in production** — rejected because production
   destructive operations are FORBIDDEN without an approved safe
   mechanism. The PRE_MERGE/POST_RELEASE/CONTINUOUS modes bind the
   EffectPolicy per environment.
5. **Encode the demo-key login as the permanent customer login** —
   rejected because the demo key is a bootstrap implementation. The
   ValidationJourney contract requires the real authentication path
   (WORK-063).
6. **Add an autonomous unsupervised scheduler** — rejected because any
   background drive is a governed implementation decision (the same
   stop-condition discipline as WORK-046/062). CONTINUOUS runs are
   scheduled by explicit configuration.

## Preserved invariants

All v1.0 security, tenancy, authority, lifecycle, provenance,
idempotency, concurrency, provider-isolation, verification, and evidence
guarantees remain mandatory. All v1.1 (ACR-001) invariants remain
mandatory. The new invariants (EffectPolicy enforcement, no-silent-
healthy, failure→signal→Work Item binding, no-second-authority matrix)
are WORK-064..070 Work Order invariants — they become governing only
when this ACR is approved and the Work Orders are implemented and merged.

## Migration strategy

Implement the sub-evolution incrementally through WORK-064..070. Each
Work Order is a separate spec file with parallel-execution metadata.
Activation is the architect's non-delegable decision (recorded in
`program-state.json`). The dependency graph is:

```text
WORK-063 (Identity & Access — complete: merged as 8dac9c4 via PR #81, spec-only, finalized §34.8/ADR-0007)
    ↓
WORK-064 (Continuous Product Validation — COMPLETE: merged as c351451 via PR #86, finalized §34.8/ADR-0007)
    ↓
WORK-065 (Synthetic Browser Validation Agent — COMPLETE: merged as 5de5e83 via PR #97, finalized §34.8/ADR-0007)
    ↓
WORK-066 (Validation Scheduling & Change Triggers)
    ↓
WORK-067 (Engineering Signal & Regression Correlation)
    ↓
WORK-068 (Feedback → Governed Work Items)
    ↓
    ├──── WORK-069 (Progressive Release & Runtime Validation)
    │            ↓
    └──── WORK-070 (Continuous Architecture Fitness)
```

WORK-064..070 are NEW Work Orders; they do not duplicate or rewrite
WORK-053..061. WORK-067 is the CORRELATION/REGRESSION-DETECTION LAYER
that CONSUMES (but does not duplicate) WORK-056's signal taxonomy when
WORK-056 lands. WORK-069 is the CLOSED-LOOP RUNTIME VALIDATION LAYER
that CONSUMES (but does not duplicate) WORK-059's release governance
framework when WORK-059 lands. WORK-070 is the CLOSED-LOOP SYNTHESIS
of WORK-055 (the model) + WORK-060 (the loop) + WORK-067 (signals) +
WORK-069 (release/runtime evidence).

The frozen v1.0 control loop is NOT modified by this ACR. The v1.1
control loop with `VALIDATE` is PROPOSED in
`spec/architecture/v1.1/control-system-evolution.md`. Activation of the
`VALIDATE` stage requires:

1. this ACR's approval by the architect (the non-delegable architecture
   authority);
2. ACR-001's approval (the original v1.1 ACR — this ACR is a sub-
   evolution of ACR-001);
3. a new immutable ArchitectureVersion (v1.1) recorded in
   `/architecture`;
4. the code-pinned `CONTROL_LOOP_STAGES` constant in
   `backend/src/architecture-checkpoints/internal/governance-validation.ts`
   updated to include `validate` (the no-silent-rewrite property);
5. the corresponding test expectations
   (`governing.controlLoop.map((s) => s.name)` in
   `backend/tests/integration/development-governance/governance-state.integration.test.ts`)
   updated to match.

Until activation, the v1.1 control loop in
`spec/architecture/v1.1/control-system-evolution.md` is design-time
proposed state. The v1.0 frozen control loop governs.

## Rollback

Unmerged v1.1 Work Items can be abandoned without altering v1.0
authoritative state. A future v1.1-derived artifact may be removed only
through its owning authority; historical v1.0 records remain intact.
The seven new Work Orders (WORK-064..070) are spec files only until
activated; abandoning them is a `git revert` of this package. (WORK-064
has since been activated and is COMPLETE — merged as `c351451` via PR #86
and finalized §34.8/ADR-0007 on 2026-08-30; WORK-065 is likewise COMPLETE —
merged as `5de5e83` via PR #97 on 2026-08-31 and finalized §34.8/ADR-0007
by the WORK-065 post-merge finalization; WORK-066 is likewise COMPLETE —
merged as `0a506b1` via PR #102 on 2026-08-31T16:37:09Z (squash-merged at
the approved head `493ae59`, the tree identical) and finalized §34.8/ADR-0007
by the WORK-066 post-merge finalization; WORK-067 is likewise COMPLETE —
merged as `bde33cc` via PR #103 on 2026-08-31T18:30:23Z (squash-merged at
the approved head `0fe9c48`, the tree identical) and finalized §34.8/ADR-0007
by the WORK-067 post-merge finalization; abandoning any MERGED delivery
would be a governed revert of the merge, not of this package alone. The three
remaining Work Orders WORK-068..070 are still spec files only, NOT
activated.)

## Approval rule

Only the architecture authority can approve this ACR and designate the
resulting ArchitectureVersion as governing. Self-hosted agents may
propose ACRs but cannot approve or silently modify the governing
version. The approval is the architect's non-delegable decision (per
`spec/governance/architect.json`).

This ACR is a SUB-EVOLUTION of ACR-001. ACR-001 must be approved
before this ACR can be approved (the continuous product validation
sub-evolution depends on the v1.1 adaptive engineering control system
that ACR-001 establishes). Until ACR-001 is approved, this ACR is
design-time proposed state and the v1.0 frozen architecture governs.

## Relationship to ACR-001

ACR-001 established the v1.1 adaptive engineering control system (the
Engineering Control Loop, System Model, Quality Attributes, Engineering
Signals, Change Programs, Adaptive Assurance, Operational/Release
Governance, Architecture Fitness, Self-Hosting Conformance). This ACR
(ACR-002) adds the continuous product validation sub-evolution that
closes the loop:

- the `VALIDATE` stage (between RELEASE and OBSERVE);
- the ValidationJourney/EffectPolicy domain model;
- the synthetic browser validation agent;
- validation scheduling and change triggers;
- engineering signal correlation and regression detection;
- feedback-to-governed-Work-Item conversion;
- progressive release and runtime validation;
- continuous architecture fitness as the closed-loop synthesis.

The seven new Work Orders (WORK-064..070) are SEPARATE from the
WORK-053..061 track that implements ACR-001. They CONSUME (but do not
duplicate) the ACR-001 capabilities when those Work Orders land
(WORK-067 consumes WORK-056's taxonomy; WORK-069 consumes WORK-059's
framework; WORK-070 consumes WORK-055's model and WORK-060's loop).
