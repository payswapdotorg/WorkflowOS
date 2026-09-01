# WorkflowOS 2.0 — Executable Development Control Plane

**Status:** PROPOSED / repository-resident control contract  
**Authority:** V2 architecture proposal; v1.0 remains authoritative until V2 is explicitly approved.

## Purpose

This control plane makes V2 implementation mechanical while maximizing safe parallelism. Every V2 feature is represented by a Work Order, machine-readable state, explicit dependencies, declared change surfaces, acceptance evidence, and dogfooding.

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

- `contract` — the dependency consumes a frozen interface/schema/protocol, not its implementation.
- `implementation` — the dependency genuinely requires merged implementation behavior.
- `integration` — the dependency is an integration gate combining independently merged capabilities.

**Parallelization rule:** `contract` dependencies MAY be developed in parallel from the same merged base. `implementation` dependencies require the dependency to be merged first. `integration` Work Orders combine already-merged capabilities.

## No-rebase parallelism rule

A parallel Work Order MUST NOT use another parallel Work Order's unmerged branch, commit, or PR as its base.

Parallel Work Orders start from the same stable `main` SHA and own disjoint declared change surfaces. They may depend on each other's **contracts** only if those contracts are already merged or independently frozen in the architecture package.

If two Work Orders touch the same file, schema object, public interface, migration, or authoritative state record, they are not a no-rebase parallel pair unless their scopes are explicitly split so that each branch can merge without editing the other's unmerged lines.

When parallel branches converge, an integration Work Order starts from current `main`; sibling implementation branches are never rebased onto one another.

## Activation record

Each `IN_FLIGHT` Work Order records:

- exact base SHA;
- Work Order ID;
- branch;
- dependency type for every dependency;
- declared file/schema/API change surfaces;
- acceptance tests;
- real integration evidence required;
- feature dogfooding experiment;
- expected integration gates;
- known exclusions.

## Mechanical execution loop

1. Read current `main` and the Work Order from GitHub.
2. Verify dependencies and whether they are `contract`, `implementation`, or `integration` dependencies.
3. If eligible for a parallel wave, create the branch from the **same exact base SHA** as its siblings.
4. Add deterministic failing tests for the Work Order's contract.
5. Implement the smallest change preserving frozen authority boundaries.
6. Run local/unit/integration verification.
7. Run required real-system proofs.
8. Run the required feature-boundary dogfooding experiment as soon as the feature is executable.
9. Persist empirical findings separately from normative architecture.
10. Fix only findings owned by this Work Order; create a corrective Work Order for unrelated findings.
11. Mark the Work Order ready and open its PR.
12. Sole architect reviews and merges it.
13. After merge, finalize state against the real merge SHA.
14. Activate the next eligible wave; never create a rebase dependency merely to combine sibling work.
15. After a wave lands, run any declared integration Work Order and its cross-feature dogfooding experiment.

## Dogfooding rule

Tests prove software correctness; dogfooding proves integrated product usefulness. Every user-facing or execution-facing feature requires a smallest-real-use experiment before completion. Non-user-facing infrastructure must define an equivalent operational/conformance experiment.

A dogfooding failure is preserved as evidence. Contract-relevant failures block dependents; non-contract failures create targeted follow-up work without forcing unrelated branches to rebase.

## State-machine invariants

1. Every Work Order has exactly one stable ID and canonical specification.
2. Every dependency names a known Work Order.
3. The dependency graph is acyclic.
4. Hard `implementation` dependencies must be COMPLETE before activation.
5. `contract` dependencies require only a frozen/merged contract.
6. `integration` dependencies are satisfied only by prior merged capabilities.
7. No parallel Work Order depends on an unmerged sibling implementation.
8. No parallel Work Order shares an unresolved authoritative change surface with a sibling.
9. `IN_FLIGHT` requires branch + exact base SHA.
10. `READY_FOR_MERGE` requires deterministic verification + required dogfooding evidence.
11. `COMPLETE` requires PR + approved head + actual merge commit.
12. Dogfooding evidence is mandatory at feature boundaries.
13. Empirical failures cannot be erased by rewriting observations.
14. A V2 Work Order cannot silently redefine a frozen V2 contract.
15. V2 state never supersedes frozen v1.0 authority.

## Evidence classes

- `IMPLEMENTATION`
- `VERIFICATION`
- `DOGFOODING`
- `ARCHITECTURE`
- `OBSERVATION`

Evidence classes are distinct and cannot impersonate one another.

## Lean review model

There is one architect/reviewer. Review intensity follows risk:

- low risk: focused diff + targeted tests + feature dogfood;
- contract boundary: contract review + discrimination tests + dogfood;
- security/data-loss/cross-process: real-system concurrency/failure proof + integration dogfood;
- integration Work Order: merged-artifact compatibility proof + end-to-end dogfood.

No external architect/reviewer is required.

## Recovery / resume

Interrupted work resumes from GitHub state, not conversation memory. A Work Order record must contain last verified SHA, branch, activation evidence, current status, outstanding failures/findings, dogfooding status, and next mechanical action.

## Canonical parallel wave protocol

A wave is a set of Work Orders that:

1. start from one common merged `main` SHA;
2. have no unmerged implementation dependencies on each other;
3. have disjoint change surfaces;
4. have individually complete verification and dogfooding;
5. can merge independently in any order;
6. are followed by an optional integration Work Order if interaction itself needs verification.

The default is **parallel when safe**, not sequential when merely convenient.

## Current V2 namespace

V2 product work uses `V2-*`. Development-control artifacts use `V2-CTRL-*`.
