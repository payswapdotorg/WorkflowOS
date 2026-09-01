# WorkflowOS 2.0 — Fresh Architect / Implementation Bootstrap

This file is the shortest safe recovery path for a new LLM architect or implementation agent with zero conversation history.

## Read in this order

1. `spec/architecture/v2/V2-CTRL-000-implementation-authorization.md`
2. `spec/architecture/v2/architecture-constitution.md`
3. `spec/architecture/v2/V2-CTRL-003-protocol-registry.md` and `V2-CTRL-003-protocol-registry.json`
4. `spec/architecture/v2/execution-control-plane.md`
5. `spec/architecture/v2/V2-CTRL-001-conformance-checklist.md`
6. `spec/architecture/v2/dogfooding-protocol.md`
7. `spec/architecture/v2/v1-transition.md`
8. `spec/architecture/v2/optimized-roadmap.md` and `V2-CTRL-002-roadmap-lock.md`
9. `spec/development-state/v2-work-order-state.json`
10. the assigned Work Order in `spec/architecture/v2/work-orders/` (and its machine-state entry)
11. `docs/superpowers/specs/2026-09-01-workflowos-2-0-universal-workflow-protocol-design.md`
12. `spec/architecture/v2/workflow-teaching-and-marketplace.md`
13. `spec/architecture/v2/workflow-marketplace-economics.md` when commercial access is relevant
14. `spec/architecture/v2/mobile-device-runtime.md` when device/mobile/cross-device behavior is relevant
15. relevant existing V1 public contracts before reusing any V1 capability

## Status interpretation

V2 is **APPROVED FOR IMPLEMENTATION** but remains a **PROPOSED architecture generation** until a formal V2 architecture version is frozen through the repository governance process. This means implementation is authorized while V2 design changes remain subject to the constitution and governed architecture-change process.

## Product definition

WorkflowOS 2.0 turns how people work with computers into reusable executable software.

Users can teach a workflow by text, voice, demonstration, or hybrid input; pause/resume teaching; install workflows; execute them manually/scheduled/event-triggered; run them locally on desktop/mobile, in a browser, or in the cloud; optimize them into new versions; collaborate/fork/share them; purchase them once or subscribe to maintenance; and reverse-teach from an installed workflow to a human.

## Canonical artifact hierarchy

```text
WorkflowRepository
  ↓
Workflow
  ↓
immutable WorkflowVersion
  ↓
WorkflowIR
  ↓
WorkflowDeployment
  ↓
WorkflowRun
```

The WorkflowIR is the semantic source of truth. Raw demonstrations, screenshots/video, prompts, model memory, compiled artifacts, teaching sessions and marketplace listings are not replacement workflow formats.

## Universal protocol

Web, desktop, iOS, Android and cloud implement one protocol. Platform-specific UX and capabilities may differ. Workflow semantics, identity, versioning, run/evidence rules and authorization semantics must not differ.

Protocol-visible names are governed by `V2-CTRL-003`. Agents must not invent aliases for existing semantic operations.

Nodes advertise capabilities. Capability possession is never authorization.

## Execution classes

Each step is deterministic/API, agentic/computer-use, human, or subworkflow. Prefer deterministic/API execution when semantic equivalence is established. Computer-use is bounded by WorkflowIR, capability, authorization, policy, placement and evidence requirements.

## Event and placement model

Triggers are typed event patterns. Workflows and steps can specify locality/placement. Device-local events may execute locally without cloud round trips when required. Cross-device handoff preserves run identity, causation and evidence and must be idempotent.

## Teaching model

Automation and teaching are two views over one immutable workflow version. Teaching sessions are derived, resumable and evidence-separated. Reverse teaching lets a person install a workflow and request instruction without creating a second workflow format.

## Marketplace model

Workflow repositories are Git-like collaborative artifacts. Visibility, forks, provenance, reviews, installation pinning and immutable versions are first-class. Supported commercial models are free, one-time purchase and maintenance subscription.

Entitlement grants content/version access only. It never grants execution authority, secrets, or capability permissions.

## Optimization model

Optimization is advisory and creates proposed new versions. It may replace GUI sequences with APIs, reuse workflows, parallelize safe steps, change placement or improve cost/reliability. It never silently mutates an installed version.

## V1 boundary

V1 remains frozen and authoritative for V1 behavior. Remaining V1 roadmap items are deferred unless a concrete V2 dependency, compatibility/security requirement, or explicit architect reactivation is recorded. Reuse V1 through explicit public boundaries/adapters only.

## Implementation control

The machine-readable state file is authoritative for V2 progress. A fresh agent must use it to identify the next eligible Work Order/wave, dependency type, change surface, dogfooding requirement, integration-gate status, and next action.

Parallel means independently mergeable:

- same stable merged base;
- disjoint authoritative surfaces;
- no sibling branch dependency;
- no rebase onto sibling branches;
- complete tests and dogfooding per item;
- integration Work Order when composition itself needs proof.

## Mechanical loop

```text
read authorization + constitution + registry + state + Work Order
→ verify dependencies and stable base
→ activate
→ create branch from stable main
→ write deterministic failing tests
→ implement
→ real integration proofs
→ feature dogfood
→ record findings
→ PR
→ sole architect review/merge
→ post-merge state finalization
→ run any newly eligible integration gate
→ cross-feature dogfood
→ next eligible wave
```

## Non-negotiable stop conditions

Stop and raise a governed architecture change when implementation would:

- redefine a frozen V2 concept;
- create a second workflow protocol/engine;
- create a protocol-name alias that conflicts with the canonical registry;
- make a platform-specific semantic fork;
- turn an assertion into evidence;
- make a non-durable adapter claim durable behavior;
- bypass authorization through capability possession or marketplace entitlement;
- mutate an immutable workflow version silently;
- hide a missing platform capability;
- revive deferred V1 without an allowed reason;
- remove or weaken a required dogfooding or discrimination test to make progress;
- require an unmerged sibling implementation as a dependency;
- activate an integration gate before every listed input is actually COMPLETE.

## Current execution pointer

The canonical current pointer is always `spec/development-state/v2-work-order-state.json`. Never trust the pointer in this document if the machine-readable state disagrees.
