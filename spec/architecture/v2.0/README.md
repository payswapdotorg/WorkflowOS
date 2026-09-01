# WorkflowOS 2.0 Architecture Package

WorkflowOS 2.0 is a new architecture generation built **on top of selected proven WorkflowOS 1.x kernel primitives**. It is not a rewrite of the frozen v1.0 architecture and it is not an in-place expansion of the existing Work Item model.

## Core thesis

> WorkflowOS turns the way people work with computers into reusable, executable, versioned workflows — and lets those workflows teach people as well as automate work.

A workflow can be taught through text, voice, demonstration, or any combination of the three. The resulting workflow is a first-class software artifact that can be versioned, edited, tested, forked, shared, installed, scheduled, deployed, executed, verified, optimized, taught, and monetized across web, desktop, mobile, and cloud surfaces.

## Primary artifacts

The v2.0 architecture centers on four immutable concepts:

1. **Workflow** — stable identity and collaboration container.
2. **Workflow Version** — immutable executable definition and its provenance.
3. **Workflow Deployment** — where and under which capabilities/policies a version is installed.
4. **Workflow Run** — one execution of one version on one deployment/context.

Teaching representations, lessons, marketplace listings, and commercial entitlements are derived/distribution artifacts; they do not replace the canonical workflow/version model.

The primary executable representation is the **Workflow IR**. LLMs and computer agents compile/execute against the IR; they do not replace it.

## Universal protocol

Web, desktop, iOS, Android, and cloud runners implement the same WorkflowOS protocol. They differ in available capabilities, permissions, placement, and UX—not workflow semantics.

Devices are first-class execution nodes. Nodes advertise capabilities. Workflows request capabilities. The runtime resolves requirements against eligible nodes and execution placements.

## Authoring modalities

Workflow creation supports four equivalent input modes:

- **Text** — describe the procedure like onboarding an intern.
- **Voice** — describe the procedure conversationally.
- **Demonstration** — perform the procedure while WorkflowOS records and interprets it.
- **Hybrid** — mix any of the above and pause/resume authoring at any point.

Raw demonstrations are retained as provenance; the semantic workflow is compiled into the IR.

## Bidirectional teaching

WorkflowOS is intentionally bidirectional:

```text
Person
  ↓
Teach WorkflowOS
  ↓
Workflow Version
  ↓
Teach Person / Automate Person's Task
```

An installed workflow can be used either to execute an operation or to teach a person how to perform it themselves. The same artifact can support explanation, guided walkthroughs, practice, or direct execution without creating a second executable representation.

See `workflow-teaching-and-marketplace.md` for the normative reverse-teaching model.

## Creator marketplace

Workflow repositories can be published and installed through a marketplace-like distribution layer.

Creators may offer:

- free workflows;
- one-time purchases;
- maintenance subscriptions;
- paid support or hosted execution as future commercial extensions.

Commercial entitlements are explicitly separated from execution authority. Payment, popularity, ratings, or publication status can never expand a workflow's runtime capabilities or permissions.

See `workflow-marketplace-economics.md` for the entitlement and creator-economics contract.

## Execution model

A workflow may contain:

- deterministic/API actions;
- agentic/computer-use actions;
- human actions/approvals;
- subworkflow invocations.

The runtime must prefer deterministic execution when equivalent capability exists. Computer use is a capability, not the definition of the workflow.

## Event model

Triggers are first-class events and conditions. Supported categories include manual, scheduled, webhook, application, file, communication, device, threshold-crossing, and workflow-completion/failure events.

Phone automations are the same protocol with mobile-specific capabilities such as calls, messages, notifications, contacts, camera, microphone, location, and UI interaction where the platform permits them.

## Locality

Execution placement is capability- and policy-driven:

- device-required;
- device-preferred;
- cloud-preferred;
- cloud-required;
- any/automatic.

This allows genuinely local phone actions to remain local while still permitting hybrid cloud reasoning when policy allows it.

## Governance

WorkflowOS 2.0 preserves the strongest v1.x kernel principles:

- explicit authority boundaries;
- typed capabilities and policies;
- deterministic identities;
- provenance;
- verification/evidence;
- fail-closed behavior;
- immutable versioning;
- human approval for consequential actions;
- no silent provider fallback;
- no silent workflow mutation by optimization;
- no privilege inheritance from marketplace status;
- commercial access separated from runtime authority.

## Research rationale

The architecture is informed by current computer-use, mobile-agent, process-mining, learning-from-demonstration, and workflow/agent runtime research. See `research-rationale.md` for the research record and design implications.

## Status

**Architectural design — proposed for WorkflowOS 2.0.**

Implementation must not begin from conversation memory. Agents should begin by reading this package and the linked v1.x bootstrap/governance artifacts.
