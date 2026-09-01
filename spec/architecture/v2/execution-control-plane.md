# WorkflowOS 2.0 — Executable Development Control Plane

**Status:** PROPOSED / implementation-authorized repository control contract  
**Authority:** V2 architecture proposal; implementation is authorized by `V2-CTRL-000`; v1.0 remains authoritative for V1 behavior until a governed V2 transition.

**Mandatory companion artifacts:**
- `spec/architecture/v2/V2-CTRL-000-implementation-authorization.md`
- `spec/architecture/v2/architecture-constitution.md`
- `spec/architecture/v2/V2-CTRL-003-protocol-registry.md` + `.json`
- `spec/architecture/v2/V2-CTRL-001-conformance-checklist.md`
- `spec/architecture/v2/V2-CTRL-002-roadmap-lock.md`
- `spec/architecture/v2/dogfooding-protocol.md`
- `spec/architecture/v2/fresh-architect-bootstrap.md`
- `spec/development-state/v2-work-order-state.json`

## Purpose

This control plane makes V2 implementation mechanical while maximizing safe parallelism. Every V2 feature is represented by a Work Order, machine-readable state, explicit dependencies, declared change surfaces, acceptance evidence, and dogfooding.

## Status interpretation

`architectureStatus: PROPOSED` means the V2 generation is not yet formally frozen as a final architecture version. `implementationAuthorization: APPROVED` means the product owner has authorized implementation against the current constitution and governed change process. Agents must not treat the word PROPOSED as permission to ignore the controls, nor treat implementation authorization as permission to reinterpret frozen concepts.

## Work-order lifecycle

```text
PLANNED
  ↓ activate
IN_FLIGHT
  ↓ implementation + verification + dogfooding
READY_FOR_MERGE
  ↓ sole architect merge
COMPLETE
```

Failure/rework:

```text
IN_FLIGHT → BLOCKED → IN_FLIGHT
READY_FOR_MERGE → IN_FLIGHT
```

`COMPLETE` requires the actual Git merge evidence. Tests, CI, approval, or a PR do not substitute for merge evidence.

## Dependency types

Every dependency is explicitly one of:

- `contract` — consume a frozen/merged interface, schema or protocol; no implementation dependency.
- `implementation` — genuinely requires another Work Order's merged implementation.
- `integration` — dedicated gate combining independently merged capabilities.

## No-rebase parallelism

A parallel Work Order MUST NOT use another parallel Work Order's unmerged branch, commit or PR as its base.

Parallel siblings start from the same stable `main` SHA, own disjoint authoritative change surfaces, and can merge independently. If two siblings require the same unmerged file/schema/public-interface lines, they are not a parallel pair; split the ownership or introduce an integration Work Order.

Integration gates start from current `main` after required siblings merge. Never rebase sibling implementation branches onto one another.

## Protocol naming

Every protocol-visible capability, event, execution class, placement identifier, evidence class, or deterministic digest rule comes from `V2-CTRL-003`. A Work Order must search the registry before introducing any name. Existing semantics are reused rather than aliased.

## Integration-gate state

`IG-*` entries are first-class development state. A gate is not merely prose: its machine-state entry records whether it is locked, waiting for inputs, eligible, in flight, or complete. A gate cannot activate until every listed `after` dependency is COMPLETE. Its completion is required wherever the machine-state entry or roadmap lock says it gates downstream work.

## Activation record

Each `IN_FLIGHT` Work Order records exact base SHA, branch, dependency types, declared change surfaces, acceptance tests, real-system proofs, feature dogfooding, expected integration gates, known exclusions, last verified SHA, unresolved findings and next mechanical action.

## Mechanical execution loop

1. Read V2-CTRL-000, the Constitution, Protocol Registry, Control Plane, Conformance Checklist, Roadmap Lock, machine state and assigned Work Order.
2. Verify current `main` and all dependencies from GitHub.
3. Activate only the assigned eligible wave item(s).
4. Create the branch from the exact stable base SHA.
5. Write deterministic failing tests for the Work Order contract.
6. Implement the smallest conforming change.
7. Run local/unit/integration verification and required real-system proofs.
8. Run the required feature-boundary dogfooding experiment as soon as the feature is executable.
9. Persist findings as evidence; do not rewrite negative observations.
10. Fix only findings owned by this Work Order. Unrelated findings become separate corrective Work Orders.
11. Mark ready and open the PR.
12. The sole architect reviews and merges it.
13. After merge, finalize state against the real merge SHA.
14. Run declared integration gates and cross-feature dogfooding when their inputs have merged.
15. Activate the next eligible wave.

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
11. `COMPLETE` requires PR + approved head + actual merge commit.
12. Dogfooding evidence is mandatory at feature boundaries.
13. Empirical failures are append-only evidence.
14. Frozen V2 concepts change only through governed V2 architecture change.
15. V2 never silently supersedes frozen v1.0 authority.
16. V2-CTRL-002 is the canonical no-rebase wave lock; informal parallelization advice cannot override it.
17. Protocol-visible names must conform to V2-CTRL-003.
18. Integration-gate state cannot claim COMPLETE before every `after` dependency is actually COMPLETE.
19. A Work Order cannot claim COMPLETE without persisted dogfooding/equivalent-conformance evidence referenced by machine state.

## Evidence classes

- `IMPLEMENTATION`
- `VERIFICATION`
- `DOGFOODING`
- `ARCHITECTURE`
- `OBSERVATION`

Evidence classes are distinct and cannot impersonate one another.

## Lean review model

There is exactly one architect/reviewer. Review intensity follows risk: focused review for low-risk changes; contract/discrimination review for boundary changes; real-system failure/concurrency proof for security/data-loss/cross-process changes; merged-artifact end-to-end proof for integration gates.

No external architect/reviewer is required.

## Recovery / resume

Interrupted work resumes from GitHub state, never conversation memory. The machine state is authoritative for current status; Work Order state carries last verified SHA, unresolved findings, dogfooding status and next action. A stale prose description must never override machine state.

## Canonical current execution

Read `spec/development-state/v2-work-order-state.json` for the active/next eligible wave and integration-gate state. Read `spec/architecture/v2/V2-CTRL-002-roadmap-lock.md` for the exact parallel/no-rebase graph.

## Namespace

Product work uses `V2-*`; integration gates use `IG-*`; development-control artifacts use `V2-CTRL-*`.
