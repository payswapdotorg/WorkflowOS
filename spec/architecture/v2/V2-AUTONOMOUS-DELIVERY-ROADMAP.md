# WorkflowOS V2 — Autonomous Delivery Roadmap

**Status:** GOVERNED EXECUTION GRAPH
**Purpose:** provide a machine-readable planning companion for the long-running Z.ai delivery orchestrator. This manifest does not replace canonical architecture or development-state authority.

## Authority order

1. Architecture constitution and frozen V2 contracts.
2. `spec/development-state/v2-work-order-state.json` for canonical historical completion and dependency facts.
3. `spec/development-state/v2-autonomous-execution-state.json` for current orchestration resume state, three-slot scheduling, branch synchronization, and review queue state.
4. Individual Work Orders in `spec/architecture/v2/work-orders/` for bounded scope and acceptance.
5. This manifest for execution topology, packet dependencies, safe parallelism, automatic branch synchronization, and review readiness.
6. GitHub PR/Issue state and evidence for actual execution state.

The execution overlay may not contradict an architectural or merged-history fact in the canonical base state. When they disagree, recompute the overlay from Git history and Work Orders; never reinterpret architecture to fit the overlay.

## Three-agent execution limit

Z.ai may reliably run **at most three specialist agents concurrently**. The orchestrator must therefore maintain a maximum of three active implementation/verification/fix/browser specialist slots at any time.

A specialist slot is disposable. Architect review does not consume an implementation slot when the PR is merely awaiting review. When Architect requests changes, the orchestrator may allocate one of the three slots to a repair agent for the affected PR.

The orchestrator must prefer useful parallelism over artificial concurrency: do not split one bounded Work Order across multiple implementation branches, and do not start dependent packets merely to keep slots busy.

## Orchestrator contract

The persistent orchestrator must recalculate eligibility from canonical state after every merge. It may run independent packets concurrently up to the three-agent limit but must never start a packet whose declared prerequisite is not merged/COMPLETE.

Architect review never becomes a prerequisite for unrelated eligible packets. A PR awaiting review may coexist with independent implementation. Architect changes are applied to the same PR branch by a disposable repair agent.

The orchestrator must never merge, approve its own architecture, reinterpret frozen semantics, or bypass a dependency. Git merge is the completion barrier.

## Zero manual rebase tax

Parallelism is not considered successful if the human must issue follow-up prompts such as “rebase the other task”, “sync your branch”, or “resolve the branch being behind main”. Those operations belong to the persistent orchestrator.

### Sibling independence

Independent Work Orders must be selected so that their **authoritative change surfaces are disjoint** or their shared surface is explicitly governed as an integration gate. One sibling may never depend on another sibling's unmerged branch, files, commits, generated artifacts, or implementation details.

### Automatic base synchronization

When `main` advances while an eligible PR is in progress or awaiting review, the orchestrator must automatically:

1. detect that the PR branch is behind the current `main`;
2. reserve one disposable specialist slot for synchronization if needed;
3. refresh the PR branch onto the current `main` using the repository's approved rebase/merge strategy;
4. resolve only mechanical conflicts that stay inside the Work Order's already-authorized surface;
5. rerun the Work Order's deterministic verification and required real-system/browser evidence;
6. record the new exact head SHA; and
7. return the PR to `READY_FOR_ARCHITECT_REVIEW` only when the review prerequisites are again satisfied.

The orchestrator must never ask the user to perform this synchronization. A semantic conflict, authority conflict, or scope-expanding conflict is a **governance stop**, not a conflict-resolution invitation.

### Merge ordering

Architect may merge any PR whose review prerequisites are satisfied. The orchestrator must assume any merge can advance `main` and immediately recalculate eligibility/synchronization for the remaining PRs. Independent PRs do not require serial rebasing onto one another.

### Branch freshness invariant

A PR is reviewable only at an exact head whose base relationship has been verified against the current `main`. The required state is:

```text
WORK ORDER COMPLETE LOCALLY
        +
REQUIRED EVIDENCE COMPLETE
        +
CURRENT BRANCH BASE VERIFIED
        +
NO OUTSTANDING REVIEW REPAIR
        =
READY_FOR_ARCHITECT_REVIEW
```

## Complete V2 program graph

```text
V2-017 COMPLETE
      │
      ▼
V2-REALITY-AUDIT-001
  R0–R4 COMPLETE
      │
      ▼
REALITY-REPAIR-001  F-001 deployment composition
      │
      ▼
REALITY-REPAIR-002  F-002 organization onboarding
      │
      ▼
REALITY-REPAIR-003  F-003 caller-org detail reads
      │
      ├────────────────┬────────────────┬────────────────┬────────────────┐
      ▼                ▼                ▼                ▼
REALITY-REPAIR-004  REALITY-REPAIR-005  REALITY-REPAIR-006  REALITY-REPAIR-007
F-004a + F-004b     F-005               F-007               F-008
copy + expert IR    Home attention      installed naming   lifecycle UX
      │                │                 │                 │
      ├────────────────┼─────────────────┼─────────────────┤
      ▼                ▼                 ▼                 ▼
REALITY-REPAIR-008  REALITY-REPAIR-009
F-009 teaching copy F-010 human diff
      └─────────────────────┬─────────────────────────────┘
                            ▼
                     R6 FULL RE-AUDIT
                            │
                            ▼
                    R7 RELEASE READINESS
                            │
                            ▼
                       DEPLOYMENT
```

## Product-repair topology

- `REALITY-REPAIR-001 → 002 → 003` is intentionally serialized because each establishes the runtime/user substrate required by the next critical journey.
- `REALITY-REPAIR-004`, `REALITY-REPAIR-005`, `REALITY-REPAIR-006`, and `REALITY-REPAIR-007` become eligible after `REALITY-REPAIR-003` merges. The orchestrator may run at most three of them at once.
- `REALITY-REPAIR-008` and `REALITY-REPAIR-009` are also independent bounded packets once their stated predecessor (`REALITY-REPAIR-003`) is merged. They compete for the same three slots rather than forming artificial serial chains.
- `REALITY-REPAIR-004` is the single canonical F-004 Work Order. It includes the copy correction and composition-only expert WorkflowIR authoring surface. Natural-language capture→WorkflowIR generation remains deferred and would require a governed architecture change.
- Device-status F-006 has no implementation packet because the Architect accepted the existing honest-unavailable behavior.
- R6 is a full repeat audit; R7 is an explicit release-readiness decision gate. Neither may be treated as ordinary implementation work.

## Productionization topology

| Packet | Purpose | Dependencies | Parallelism | Unlocks |
|---|---|---|---|---|
| DEP-001 | production architecture/provider seams | R7 | SERIAL FOUNDATION | 002, 007, 008, 009 |
| DEP-002 | environment/secrets/config contract | 001 | SERIAL FOUNDATION | 003, 004, 005, 006, 007, 008, 009, 010 |
| DEP-003 | Neon DB + migration control | 002 | PARALLEL | 006, 009, 011 |
| DEP-004 | Redis coordination | 002 | PARALLEL | 006, 009, 011 |
| DEP-005 | R2 storage adapter | 002 | PARALLEL | 006, 009, 010, 011 |
| DEP-006 | API + Worker deployment | 003, 004, 005 | SERIALIZED RUNTIME FOUNDATION | 008, 009, 010, 011 |
| DEP-007 | Vercel frontend delivery | 002 | PARALLEL | 008, 011 |
| DEP-008 | DNS/TLS/edge/Turnstile | 002, 006, 007 | PARALLEL | 011 |
| DEP-009 | CI/CD/migrations/rollback/smoke | 002, 003, 006 | PARALLEL | 011, 012 |
| DEP-010 | observability/cost controls | 002, 006, 008 | PARALLEL | 011, 012 |
| DEP-011 | production dogfooding/release evidence | 003, 004, 005, 006, 007, 008, 009, 010 | FINAL GATE | 012 |
| DEP-012 | Architect production acceptance | 011 | FINAL AUTHORITY GATE | V2 LIVE |

## Packet authoring rules

Every future Work Order must contain, at minimum:

- a unique bounded scope and explicit non-goals;
- canonical dependencies expressed only as merged/COMPLETE prerequisites;
- an explicit parallelism class (`SERIAL`, `PARALLEL`, `FINAL-GATE`, or equivalent);
- the authoritative files/services/contracts it may touch;
- deterministic verification requirements;
- real-browser proof where the packet changes user-visible behavior;
- evidence artifacts and the exact-head acceptance requirement;
- explicit downstream unlocks;
- stop conditions for architecture/authority drift;
- a rule that Architect-requested repairs update the same PR rather than creating a sibling implementation;
- a synchronization rule that main-branch freshness is orchestrator-owned, not user-owned.

## One PR per Work Order

A worker agent may split internal tasks, but one governed Work Order produces one implementation branch and one PR. Cross-Work-Order batching is prohibited unless an Architect-created integration gate explicitly authorizes it.

## Three-slot scheduling policy

The orchestrator maintains three active specialist slots:

```text
Slot A — primary implementation
Slot B — independent implementation / verification
Slot C — independent implementation / synchronization / Architect-review repair
```

When no synchronization or Architect repair is pending, all three slots may be filled from the currently eligible graph. When synchronization is required, one slot becomes a base-refresh slot. When a review change arrives, one slot may be reassigned to repair the existing PR. A dependent Work Order cannot be substituted merely because a slot is idle.

## Architect review trigger

The orchestrator must create a durable review-request event only when all conditions below hold for the **same exact PR head SHA**:

1. the governed Work Order's implementation is complete;
2. the Work Order's deterministic verification is complete and passing;
3. required dogfooding/equivalent conformance evidence is persisted;
4. required real-browser evidence is persisted for user-visible changes;
5. the PR branch is synchronized with current `main` according to the branch freshness invariant;
6. there are no unresolved orchestrator repair tasks; and
7. the Work Order's scope and architectural boundaries have not drifted.

The durable event must include at least: Work Order ID, PR number, exact head SHA, current main SHA, verification summary, evidence locations, synchronization result, and `READY_FOR_ARCHITECT_REVIEW` status.

The user does **not** need to ask for reviews during ordinary implementation. The only review prompt should be emitted when this event is reached. At that point the user can send the standardized review trigger:

```text
ARCHITECT REVIEW: WorkflowOS PR #<N>, Work Order <WO>, head <SHA>
```

A review request is invalidated automatically whenever the PR head changes, main advances without successful resynchronization, review changes are requested, evidence changes, or scope changes. A new exact-head review event must then be produced.

## Review does not stall the graph

A PR waiting on Architect review does not block independent eligible packets. A repair agent updates the same PR branch and reruns the Work Order's verification. Base synchronization also happens automatically if another merge advances `main`.

## Merge is the barrier

Downstream activation is based on actual Git merge and canonical state, never PR creation, CI success alone, or worker assertion.

## Failure isolation

A provider-specific implementation failure blocks that packet and its dependents but does not stop independent packets. A newly discovered shared semantic/authority issue becomes a governed corrective Work Order. Mechanical branch conflicts are absorbed by the orchestrator; semantic conflicts stop and return to Architect governance.

## Final gate

No deployment packet may activate before V2-REALITY-AUDIT-001 is accepted, all release-blocking repairs are merged, R6 confirms no critical UX-to-operational mismatch, and R7 records Architect release-readiness acceptance.
