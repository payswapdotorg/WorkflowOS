# WorkflowOS 2.0 — Dogfooding Protocol

**Status:** PROPOSED and mandatory for V2 implementation.

## Principle

Every complete user-facing or execution-facing V2 capability must be exercised through the real product path immediately after implementation. The goal is to discover architectural defects at feature boundaries, not after a large roadmap tranche.

## Experiment lifecycle

```text
feature tests green
  ↓
feature executable on a real supported surface
  ↓
DOGFOODING RUN
  ↓
record observation + evidence
  ↓
classify: PASS | CONTRACT FAILURE | UX FAILURE | OPERATIONAL FAILURE
  ↓
PASS → feature eligible for merge/completion
failure → targeted corrective Work Order or explicit non-blocking observation
```

## Experiment requirements

Each experiment records: Work Order ID, workflow/version under test, surface/host, exact task, starting state, expected outcome, observed outcome, evidence references, duration/cost where relevant, failure classification, and resulting action.

The experiment must use real WorkflowOS protocol paths. A mock is acceptable only for a dependency explicitly outside the feature's control boundary.

## Required feature-boundary experiments

| Work Order | Real experiment |
|---|---|
| V2-002 | Create a workflow, edit it, create an immutable version, fork it, install it, and execute it. Verify old installations remain pinned. |
| V2-003 | Author a real workflow, serialize to IR, deserialize, and execute/inspect it for semantic equivalence. |
| V2-004 | Discover a real node's capabilities and execute a workflow through capability matching without platform-specific semantics leaking into the workflow. |
| V2-005 | Execute a real workflow, inspect its run/evidence, pause/resume it, and reconstruct what happened from the record. |
| V2-006 | Install a workflow and use it to teach a real person the task; then compare teaching and execution paths. |
| V2-007 | Compile a real authored workflow and execute the compiled result against the same acceptance task. |
| V2-008 | Automate a useful computer task end-to-end on a real host. Include at least one failure/recovery case. |
| V2-009 | Run one scheduled workflow and one supported event-triggered workflow. Verify duplicate-event behavior and placement. |
| V2-010 | Install a workflow, invoke reverse teaching, have a person follow the generated lesson, then execute the workflow. |
| V2-011 | Run baseline and optimized versions against the same real task and compare correctness plus resource cost. |
| V2-012 | Fork, modify, publish, install and perform a safe transaction using the marketplace/collaboration path. |
| V2-013 | Install and execute a WorkflowOS development workflow using WorkflowOS itself. |

## Safety

Dogfooding never uses production destructive actions merely to prove automation. Dangerous capabilities require an isolated tenant, test account, sandbox resource, explicit human confirmation, or equivalent containment. Phone/device experiments must use test contacts/accounts unless a human explicitly chooses otherwise.

## Evidence discipline

Screenshots, traces, run IDs, logs, and recordings are evidence. They do not become architecture merely because they exist. A defect discovered during dogfooding is not silently folded into an unrelated Work Order; it is either fixed within the owning scope or persisted as a separate corrective item.

## Anti-repeat rule

No V2 roadmap tranche may advance solely because its tests are green. At every execution-capability boundary, the next Work Order consumes the previous Work Order's dogfooding result. This is the primary protection against repeating the v1 failure mode of implementing many work items before testing the integrated product.
