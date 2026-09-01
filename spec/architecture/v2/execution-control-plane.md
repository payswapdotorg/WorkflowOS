# WorkflowOS 2.0 — Executable Development Control Plane

**Status:** PROPOSED / implementation-authorized repository control contract  
**Authority:** V2 architecture proposal; implementation is authorized by `V2-CTRL-000`; v1.0 remains authoritative for V1 behavior until a governed V2 transition.  
**Governance refinement:** `V2-ACR-002-governance-control-plane-refinement.md` is the current normative refinement of state ownership, projection semantics, and post-merge reconciliation.

**Mandatory companion artifacts:**
- `spec/architecture/v2/V2-CTRL-000-implementation-authorization.md`
- `spec/architecture/v2/architecture-constitution.md`
- `spec/architecture/v2/V2-CTRL-003-protocol-registry.md` + `.json`
- `spec/architecture/v2/V2-CTRL-001-conformance-checklist.md`
- `spec/architecture/v2/V2-CTRL-002-roadmap-lock.md`
- `spec/architecture/v2/dogfooding-protocol.md`
- `spec/architecture/v2/fresh-architect-bootstrap.md`
- `spec/architecture/v2/architecture-change-requests/V2-ACR-002-governance-control-plane-refinement.md`
- `spec/development-state/README.md`
- `spec/development-state/governance-model.json`
- `spec/development-state/program-state.json`

## Purpose

This control plane makes V2 implementation mechanical while maximizing safe parallelism. It governs execution from repository-resident facts and deterministic projections without creating a second authority.

The control plane distinguishes **facts**, **operational state**, and **derived projections**. Facts establish what happened or what was authorized; operational state records what an interrupted implementation needs to resume; projections answer what is eligible or ready now.

## Authority model

The control plane MUST preserve these authority boundaries:

```text
Architectural meaning     → /architecture + governed V2 architecture records
Work authorization/scope  → Work Order
Implementation facts      → repository branch/PR + Work Order operational state
Verification evidence    → /verification
Product review            → /reviews
Git merge truth           → /github / repository Git history
Eligibility/frontier      → derived from Work Orders + Git facts + roadmap constraints
Checkpoint summaries      → derived from checkpoint contracts + verification evidence
```

No derived artifact can authorize work, approve architecture, merge a PR, or override an owning authority.

## State classes

### Authoritative facts

Authoritative development facts include:

- immutable Work Order identity, scope and dependency declarations;
- architect-issued architecture decisions and architecture-change records;
- verification/dogfooding evidence;
- repository Git history and the actual Architect merge event;
- durable PR/merge identity bindings where repository governance requires them.

### Operational state

Operational state may contain only information required to continue or audit in-flight work, including:

- status declaration while work is in progress;
- exact base SHA;
- branch and PR bindings;
- last verified SHA;
- unresolved findings;
- next mechanical action;
- recorded coordination needed for in-flight work.

Operational state cannot override authoritative Git evidence.

### Derived projections

The following are projections, not independent authority:

- `dependency-state.json`;
- `frontier-state.json`;
- `checkpoint-state.json`;
- eligible-wave/current-frontier summaries;
- `nextEligible` or equivalent navigation fields;
- readiness summaries derived from evidence.

A stale or inconsistent projection MUST be regenerated or treated as invalid; it MUST NOT be used as an alternate source of truth.

## Work-order lifecycle

```text
PLANNED
  ↓ activate
IN_FLIGHT
  ↓ implementation + verification + dogfooding
READY_FOR_MERGE
  ↓ Architect merge
COMPLETE
```

Failure/rework:

```text
IN_FLIGHT → BLOCKED → IN_FLIGHT
READY_FOR_MERGE → IN_FLIGHT
```

The Architect's merge remains the sole completion event. Tests, CI, approval, or a PR do not substitute for merge evidence.

## Completion and post-merge reconciliation

A merge establishes the completion fact. Post-merge reconciliation only records that fact in canonical program state.

A reconciliation mechanism MAY be automated or run deterministically from repository Git evidence. It is **recording**, not approval.

It MUST:

1. identify an actual Architect merge unambiguously;
2. bind `mergedAs` to the actual PR identity and merge commit;
3. mark the Work Order complete;
4. remove obsolete active-handoff/resumption state;
5. update any required data-only Work Order status projection;
6. preserve unrelated findings and evidence;
7. fail closed when merge identity is ambiguous or unverifiable.

The recorder MUST NOT:

- approve the merge;
- broaden or amend the Work Order;
- change architectural meaning;
- lower assurance requirements;
- create an authority or workflow state;
- mark work complete without authoritative merge evidence.

The Architect remains the only actor who can merge work, amend governance scope, reopen completed work for new scope, or approve architecture changes.

A short red reconciliation window is intentional enforcement: when Git proves a Work Order merged but canonical state has not reconciled, governance status MUST report the inconsistency rather than silently passing it.

## Dependency types

Every dependency is explicitly one of:

- `contract` — consume a frozen/merged interface, schema or protocol; no implementation dependency.
- `implementation` — genuinely requires another Work Order's merged implementation.
- `integration` — dedicated gate combining independently merged capabilities.

There is exactly **one authoritative dependency graph**: the Work Order graph. Roadmap locks may constrain concurrency or composition but cannot create a competing dependency graph. Eligibility is derived from the graph, Git facts, roadmap constraints, and required evidence.

## No-rebase parallelism

A parallel Work Order MUST NOT use another parallel Work Order's unmerged branch, commit or PR as its base.

Parallel siblings start from the same stable `main` SHA, own disjoint authoritative change surfaces, and can merge independently. If two siblings require the same unmerged file/schema/public-interface lines, they are not a parallel pair; split ownership or introduce an integration Work Order.

Integration gates start from current `main` after required siblings merge. Never rebase sibling implementation branches onto one another.

## Protocol naming

Every protocol-visible capability, event, execution class, placement identifier, evidence class, or deterministic digest rule comes from `V2-CTRL-003`. A Work Order must search the registry before introducing any name. Existing semantics are reused rather than aliased.

## Integration-gate state

`IG-*` entries are first-class development controls. Their eligibility is derived from the canonical dependency graph and actual completion facts. A gate cannot activate until every listed `after` dependency is COMPLETE. A gate's state is itself subject to the same authoritative-fact/projection distinction.

## Activation record

Each `IN_FLIGHT` Work Order records exact base SHA, branch, dependency types, declared change surfaces, acceptance tests, real-system proofs, feature dogfooding, expected integration gates, known exclusions, last verified SHA, unresolved findings and next mechanical action.

## Mechanical execution loop

1. Read V2-CTRL-000, the Constitution, Protocol Registry, Control Plane, Conformance Checklist, Roadmap Lock, governance refinement, machine state and assigned Work Order.
2. Verify current `main` and all dependencies from GitHub.
3. Compute eligibility from authoritative state; do not trust a stale navigation projection.
4. Activate only an eligible Work Order/wave.
5. Create the branch from the exact stable base SHA.
6. Write deterministic failing tests for the Work Order contract.
7. Implement the smallest conforming change.
8. Run local/unit/integration verification and required real-system proofs.
9. Run the required feature-boundary dogfooding experiment as soon as the feature is executable.
10. Persist findings as evidence; do not rewrite negative observations.
11. Fix only findings owned by this Work Order. Unrelated findings become separate corrective Work Orders.
12. Mark ready and open the PR.
13. The Architect reviews and merges it.
14. Record/reconcile the authoritative merge fact; reconciliation is bookkeeping, not a second approval.
15. Run declared integration gates and cross-feature dogfooding when their inputs have merged.
16. Recompute the implementation frontier and activate the next eligible wave.

## Dogfooding rule

Tests prove software correctness; dogfooding proves integrated product usefulness. Every user-facing or execution-facing feature requires a real-product experiment before completion. Non-user-facing infrastructure requires an equivalent operational/conformance experiment. Integration gates require cross-feature dogfooding.

A contract-relevant dogfooding failure blocks dependents. An unrelated failure becomes targeted follow-up work. No finding may be hidden to preserve roadmap speed.

## State-machine invariants

1. One stable ID and one canonical Work Order file per item.
2. All dependencies name known Work Orders.
3. Dependency graph is acyclic.
4. Implementation dependencies must be COMPLETE before activation.
5. Contract dependencies require only a frozen/merged contract.
6. Integration gates consume merged capabilities.
7. No parallel item depends on an unmerged sibling implementation.
8. No parallel item shares an unresolved authoritative surface.
9. `IN_FLIGHT` requires branch + exact base SHA.
10. `READY_FOR_MERGE` requires verification + dogfooding evidence.
11. `COMPLETE` requires actual Architect merge evidence; `mergedAs` must match authoritative Git identity.
12. Dogfooding evidence is mandatory at feature boundaries.
13. Empirical failures are append-only evidence.
14. Frozen V2 concepts change only through governed V2 architecture change.
15. V2 never silently supersedes frozen v1.0 authority.
16. V2-CTRL-002 is the canonical no-rebase/concurrency lock.
17. Protocol-visible names must conform to V2-CTRL-003.
18. Integration-gate readiness is derived from actual completion facts, not from stale roadmap/navigation fields.
19. A Work Order cannot claim COMPLETE without persisted dogfooding/equivalent-conformance evidence referenced by machine state.
20. Derived projections cannot authorize, approve, merge, or redefine work.
21. Git merge evidence outranks stale completion/navigation state; inconsistency fails closed.
22. Post-merge reconciliation records an authoritative merge event and never becomes a second approval authority.

## Evidence classes

- `IMPLEMENTATION`
- `VERIFICATION`
- `DOGFOODING`
- `ARCHITECTURE`
- `OBSERVATION`

Evidence classes are distinct and cannot impersonate one another.

## Lean review model

There is exactly one Architect/reviewer. Review intensity follows risk: focused review for low-risk changes; contract/discrimination review for boundary changes; real-system failure/concurrency proof for security/data-loss/cross-process changes; merged-artifact end-to-end proof for integration gates.

No external architect/reviewer is required.

## Recovery / resume

Interrupted work resumes from GitHub state, Work Order operational state and verification evidence, never conversation memory.

Navigation fields such as `nextEligible`, `nextAction`, wave summaries, and derived frontier status are advisory projections. A stale projection never overrides dependency facts, merge history, Work Order scope, or architecture authority.

## Canonical current execution

Read the canonical Work Order/program facts and derive current eligibility/frontier from them. Read `V2-CTRL-002-roadmap-lock.md` for the no-rebase/composition constraints. Read `V2-ACR-002-governance-control-plane-refinement.md` whenever governance-state ownership or post-merge reconciliation is in scope.

## Namespace

Product work uses `V2-*`; integration gates use `IG-*`; development-control artifacts use `V2-CTRL-*`.
