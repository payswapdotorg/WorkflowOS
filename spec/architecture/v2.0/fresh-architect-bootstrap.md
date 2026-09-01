# WorkflowOS 2.0 — Fresh Architect Bootstrap

This document is the recovery point for any future architect or implementation agent. It exists so that no v2.0 implementation depends on chat history.

## Start here

Read these files in order:

1. `spec/architecture/v2.0/README.md`
2. `spec/architecture/v2.0/architecture.md`
3. `spec/architecture/v2.0/research-rationale.md`
4. `spec/architecture/v1.1/fresh-architect-bootstrap.md`
5. the current `spec/development-state/program-state.json`
6. the current `spec/development-state/dependency-state.json`
7. the current `spec/development-state/frontier-state.json`
8. the relevant v1.x Work Orders and implementation code before proposing any compatibility reuse

## Architectural position

WorkflowOS 2.0 is a new architecture generation. Do not reinterpret v1.0 as v2.0 and do not perform an uncontrolled rewrite.

The top-level artifact is a versioned **Workflow**, not a Work Item, Agent Run, prompt, skill file, or GUI recording.

The canonical object chain is:

```text
Workflow
  ↓
WorkflowVersion
  ↓
WorkflowDeployment
  ↓
WorkflowRun
```

The canonical executable representation is **Workflow IR**.

## Universal protocol

Web, desktop, iOS, Android and cloud runtimes implement the same WorkflowOS protocol.

They differ by capability advertisements, OS permissions, locality, and UX—not by workflow semantics.

A device or runner is a **Node**. Nodes advertise versioned **Capabilities**. Workflows declare required capabilities. The runtime resolves requirements against eligible nodes and policies.

## Authoring model

A Workflow can be authored through:

```text
text
voice
demonstration
hybrid
```

Authoring is itself resumable. Teaching traces are durable provenance. The compiler converts traces into semantic Workflow IR while preserving uncertainty and asking human questions where needed.

## Execution model

Workflow steps can execute as:

```text
deterministic/API
agentic/computer-use
human
subworkflow
```

Prefer deterministic/API execution when it is semantically equivalent and authorized.

A computer agent is never the workflow authority.

## Device model

Mobile and desktop devices are first-class execution nodes.

Example mobile-only capabilities:

```text
phone.call.observe
phone.call.answer
messages.read
messages.send
notifications.receive
camera.capture
location.read
mobile.ui.inspect
mobile.ui.tap
```

A workflow may require local execution for capabilities that cannot safely or technically move to the cloud.

## Event and scheduling model

Triggers are first-class Events + Conditions.

Examples:

```text
schedule
webhook
email
message
phone call
notification
file change
application event
threshold crossing
workflow completion/failure
```

Threshold triggers must use crossing semantics to avoid repeated execution while a metric remains above a threshold.

Scheduling belongs to deployments/triggers, not the semantic core of a Workflow Version.

## Security model

Every workflow/deployment has an explicit policy ceiling covering capabilities, data scopes, devices, locality, side-effect level, credentials and approval requirements.

Secrets are referenced through secure bindings, never embedded in Workflow source or teaching traces.

No provider silently falls back to an incompatible provider.

## Versioning

Workflow Versions are immutable.

Optimization, edits and demonstrations produce candidate new versions. Existing versions remain reproducible forever subject to their declared dependencies.

Execution provenance always identifies the exact Workflow Version and Deployment.

## Collaboration

A Workflow Repository behaves like a software repository:

```text
fork
branch
commit
review
merge
publish
install
update
rollback
```

Workflow dependencies use explicit version constraints and input/output contracts.

## Optimization

Optimization is advisory until accepted.

It may propose:

```text
API replacement
existing workflow substitution
parallelization
reliability improvement
security improvement
cost/latency reduction
locality improvement
human-intervention reduction
```

Optimization never silently mutates an installed workflow.

## Verification

Never treat an agent's confidence as evidence of success.

Distinguish:

```text
agent belief
observed fact
deterministic verification
human confirmation
```

Every consequential workflow run must have reconstructable provenance from Workflow Version → Deployment → Run → Step → Capability → evidence/result.

## Software-engineering workflows

The existing WorkflowOS software-engineering capabilities are expected to become installable workflows in v2.0.

They are a **workflow family**, not the defining architecture.

Example:

```text
software/build-product
  input: product description
  subworkflows:
    repository-analysis
    architecture-design
    implementation
    verification
    browser-validation
    review
    deployment
```

## Implementation order

The first implementation Work Orders should establish the contracts before rich UI:

```text
V2-001 Universal Workflow Protocol
V2-002 Workflow Repository + immutable Version
V2-003 Workflow IR
V2-004 Node + Capability protocol
V2-005 Workflow Run + Evidence
```

Only after those are stable should the project build the multimodal authoring and execution surfaces.

## Non-negotiable rule

When implementing v2.0, inspect this package and the current repository state first. Do not infer requirements from chat history, prior agent reports, or remembered design discussions when a repository artifact exists.
