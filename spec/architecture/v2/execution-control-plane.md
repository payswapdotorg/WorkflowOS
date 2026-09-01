# WorkflowOS 2.0 — Executable Development Control Plane

**Status:** PROPOSED / repository-resident control contract  
**Authority:** V2 architecture proposal; v1.0 remains authoritative until V2 is explicitly approved.

## Purpose

This document makes V2 implementation mechanical. Every V2 feature is represented by a Work Order, a machine-readable state record, explicit dependency edges, a bounded acceptance contract, and a dogfooding gate. Implementation agents must be able to resume from GitHub without conversational history.

## Work-order lifecycle

```text
PLANNED
  ↓ activate
IN_FLIGHT
  ↓ implementation + verification
READY_FOR_MERGE
  ↓ sole architect review/merge
COMPLETE
```

Failure/rework paths:

```text
IN_FLIGHT → BLOCKED → IN_FLIGHT
READY_FOR_MERGE → IN_FLIGHT
```

`COMPLETE` requires the actual Git merge evidence. Tests, CI, or a PR approval never substitute for merge evidence.

## Activation rule

Only one V2 Work Order may be `IN_FLIGHT` unless the state explicitly declares a conflict-free parallel wave. The activation record must identify:

- exact base SHA;
- Work Order ID;
- branch;
- dependencies and their observed state;
- declared change surfaces;
- acceptance tests;
- dogfooding experiment/gate;
- known exclusions.

## Mechanical execution loop

Every Work Order follows this exact loop:

1. Read current `main` and the Work Order from GitHub.
2. Verify dependency and state invariants.
3. Create a fresh branch from the recorded current `main`.
4. Write the smallest failing deterministic tests for the acceptance contract.
5. Implement the minimum change preserving V2 protocol boundaries.
6. Run local verification.
7. Run the required real integration verification where the Work Order calls for it.
8. Run the feature's dogfooding experiment immediately after the feature becomes executable.
9. Record empirical findings separately from normative architecture state.
10. Fix only findings owned by the Work Order; create/follow a new Work Order for unrelated findings.
11. Update the Work Order evidence record and state.
12. Open a PR.
13. The sole architect reviews the PR and may request changes or merge it.
14. After merge, finalize state against the real merge SHA and activate the next eligible Work Order.

## Dogfooding rule

A feature is not considered validated merely because its unit/integration tests pass. Each feature gets a smallest-real-use experiment immediately after its implementation boundary becomes usable.

Dogfooding must test the actual product path, not a synthetic substitute. Results are empirical evidence and never silently become architecture decisions. A failed experiment creates a targeted corrective Work Order or blocks activation of dependent work when the failure affects the feature's contract.

Examples:

- Workflow Repository → create, edit, version, fork, install and execute a real workflow through the repository UI/API.
- Workflow IR → author one real workflow and round-trip it through the IR.
- Node/Capability → execute the same workflow against at least two host classes where supported.
- Runs/Evidence → inspect a real run and reconstruct what happened from evidence.
- Teaching → teach a real operator from a workflow and measure task completion.
- Compiler → compile a real authored workflow and execute the compiled artifact.
- Computer Agent → automate one useful computer task end to end.
- Scheduling/Events → run one scheduled/event-triggered workflow in a controlled environment.
- Reverse Teaching → install a real workflow and use it to teach a human.
- Optimization → compare baseline and optimized workflow versions on the same task.
- Collaboration/Marketplace → fork, modify, publish/install and transact a real workflow in a safe test context.
- Self-hosting → install and run a WorkflowOS development workflow using WorkflowOS itself.

## State machine invariants

1. Every Work Order has exactly one stable ID and one canonical specification file.
2. Every dependency is another known Work Order.
3. The dependency graph is acyclic.
4. A Work Order cannot activate until all hard dependencies are `COMPLETE`.
5. Soft dependencies may be incomplete only when the Work Order explicitly declares the compatibility seam.
6. `IN_FLIGHT` requires a branch and exact base SHA.
7. `READY_FOR_MERGE` requires a PR and complete local/CI evidence.
8. `COMPLETE` requires PR + approved head + actual merge commit.
9. Dogfooding evidence is required before declaring a feature `COMPLETE`, unless the Work Order explicitly classifies the feature as non-user-facing infrastructure and defines an equivalent operational experiment.
10. A dogfooding failure cannot be erased by editing the result; corrective history is append-only.
11. A later Work Order cannot redefine a frozen V2 concept without an explicit architecture-change record.
12. V2 state cannot supersede the frozen v1.0 state.

## Evidence classes

- **IMPLEMENTATION:** repository code/config/spec change.
- **VERIFICATION:** deterministic tests, integration tests, CI, browser/device/cloud evidence.
- **DOGFOODING:** real-user or real-product-path experiment.
- **ARCHITECTURE:** normative decisions approved by the sole architect.
- **OBSERVATION:** empirical finding not yet converted into a normative decision.

No evidence class may impersonate another.

## Recovery / resume

An interrupted implementation is resumed from the repository state, not from memory. The state record must identify the last verified commit, current branch, completed tasks, failed tests, dogfooding status, and next mechanical step. Agents must not infer completion from stale prose.

## Lean review model

There is one architect/reviewer. No external review role is required. Review ceremony scales with risk:

- small Work Order: focused diff + targeted tests + dogfooding;
- architectural boundary: full contract review + discriminating regression;
- cross-process/security/data-loss risk: real integration proof.

The implementation agent must never merge its own PR merely because CI is green; the sole architect performs the merge gate.

## V2 work-order namespace

V2 product work is numbered `V2-001` onward. Development-control artifacts use the `V2-CTRL-*` namespace and are not product capabilities.

The canonical sequence is:

`V2-001 → V2-002 → V2-003 → V2-004 → V2-005 → V2-006 → V2-007 → V2-008 → V2-009 → V2-010 → V2-011 → V2-012 → V2-013`.

Where two work items can be safely developed in parallel, the state file must explicitly record the wave and conflict surface. Default behavior is sequential.
