# WorkflowOS 2.0 — V2-001 Universal Workflow Protocol Design

**Status:** Proposed architecture for V2-001
**Date:** 2026-09-01
**Governing architecture:** v1.0 remains frozen and authoritative. This proposes the next architecture generation and does not modify v1.0.

## 1. Purpose

WorkflowOS 2.0 changes the primary product abstraction into a system for teaching computers how people work, preserving that work as versioned workflows, executing workflows on capable devices or cloud hosts, and teaching workflows back to people.

V2-001 establishes the protocol boundary required by every later V2 subsystem. Web, desktop, iOS, Android, and cloud runners are protocol participants, not separate workflow semantics.

## 2. Non-goals

V2-001 does not implement computer-use execution, teaching/recording UX, workflow compilation, marketplace/payments, scheduling/event implementations, optimization, reverse teaching, client UIs, cloud provisioning, or replacement of the v1.0 workflow engine.

## 3. Core model

```text
Workflow
   |
   +-- immutable WorkflowVersion
           |
           +-- WorkflowIR
           +-- dependencies
           +-- required capabilities
           +-- policies
           +-- provenance

WorkflowVersion
   |
   +-- Deployment
           |
           +-- Node / cloud host

Deployment
   |
   +-- Run
           |
           +-- Steps / capability invocations / observations / evidence
```

Workflow is the durable collaboration identity. WorkflowVersion is immutable executable meaning. Editing creates a new version. Deployment binds a version to an execution environment and policy context. Run records one execution of one pinned version.

## 4. Protocol principles

### Semantic independence

The wire protocol must not assume browser, desktop, phone, or cloud. Surfaces may differ in UX and device capabilities but must preserve workflow meaning.

### Capability-based execution

Workflows declare required capabilities and constraints. Nodes advertise capabilities. Eligibility is determined by capability matching plus authorization and policy. Workflow semantics must not depend directly on platform SDKs.

### Explicit placement

Placement is policy. The protocol represents required/preferred/allowed placement, locality, privacy/data-residency constraints, and human approval requirements.

### Deterministic identity

Durable protocol objects have explicit stable identifiers and version relationships. Run identity cannot depend solely on UI session state or model-generated text.

### Evidence first

Intent, observed result, deterministic verification, and human confirmation are distinct. A model assertion is not proof of side-effect success.

### Version pinning

A run executes one immutable WorkflowVersion. Updating a workflow never silently mutates an installed deployment.

## 5. Protocol entities

### Workflow

Minimum fields: workflowId, tenant/owner, name, description, visibility, lifecycle status, current-version reference, collaboration/repository metadata.

### WorkflowVersion

Minimum fields: workflowVersionId, workflowId, immutable content digest, parent-version reference, WorkflowIR, capability requirements, dependencies, policy requirements, provenance, creation metadata.

### Node

An execution host participating in the protocol. It advertises node identity, platform/device class, protocol version, capabilities, availability/health, locality, and security/trust attributes.

### Capability

A stable, namespaced, versionable operation a node can perform. Examples: browser.navigate, browser.click, filesystem.read, filesystem.write, spreadsheet.edit, phone.answer_call, phone.contacts.search, messaging.send, microphone.capture, screen.observe.

Capability advertisement does not itself grant authorization.

### Trigger

Why a run was requested: manual, schedule, external event, workflow completion, or device/application event. V2-001 defines the envelope; implementations come later.

### Deployment

Binds WorkflowVersion + target placement + execution policy. It is the unit that can be enabled, disabled, inspected, and rolled back.

### Run

Records workflow/version/deployment/trigger identity, timestamps, status, input/output references, step records, evidence references, and policy decisions.

## 6. Transport envelope

The initial transport uses a versioned message envelope that can be carried over HTTP, WebSocket, or another transport without changing semantics:

```json
{
  "protocolVersion": "2.x",
  "messageId": "...",
  "correlationId": "...",
  "causationId": "...",
  "sender": "...",
  "recipient": "...",
  "timestamp": "...",
  "messageType": "...",
  "payload": {},
  "securityContext": {}
}
```

V2-001 freezes the semantic requirements: messages are versioned, correlated, causally traceable, and attributable to an authenticated participant. Exact serialization/authentication mechanisms are later work.

## 7. Command/event separation

Commands express requests, for example workflow.execute, workflow.pause, workflow.resume, workflow.cancel, workflow.deploy, capability.invoke. Events record facts, for example workflow.run.started, workflow.step.started, capability.invocation.completed, observation.recorded, verification.completed, workflow.run.completed, workflow.run.failed.

A command acknowledgement is not evidence that the requested side effect occurred.

## 8. Input/output model

Workflow inputs/outputs are typed protocol values supporting scalars, structured values, files/object references, binary/media references, opaque secret references, user/device references, and collections. Large payloads should be referenced rather than embedded. Raw credentials must never be serialized into workflow definitions or ordinary run messages.

## 9. Pause/resume

Pause/resume is protocol-level. A paused run retains its pinned version, safe execution position, state needed for resumption, outstanding approvals, and accumulated evidence. Resume is explicit and idempotent. Client disappearance does not imply cancellation.

## 10. Security boundary

Identity, capability, authorization, execution policy, and secret reference are distinct concepts. A node must authenticate to the protocol. Capability possession never bypasses authorization. Secrets are delivered only through controlled opaque references.

## 11. V1 compatibility boundary

V1 remains authoritative for the existing WorkflowOS development/governance system. V2 may reuse mature V1 infrastructure only behind explicit adapters and without changing V1 semantics.

V2 must not rewrite the frozen v1.0 architecture, the v1.0 workflow state machine, PostgreSQL authority rules, or existing execution/verification authority boundaries. Existing software-engineering workflows become V2 workflow content rather than a second execution engine.

## 12. Cross-surface requirement

Web, desktop, iOS, Android, and cloud runners implement the same protocol semantics. Allowed differences are UI, local sensors/device capabilities, local execution availability, platform authentication primitives, and lifecycle behavior. Workflow meaning, version identity, run model, capability vocabulary, evidence semantics, and authorization remain equivalent.

## 13. Testing requirements

V2-001 implementation must provide conformance tests for envelope serialization/deserialization, version negotiation, correlation/causation, workflow/version/run identity, command/event distinction, capability declaration/matching, placement constraints, I/O schema validation, pause/resume idempotency, authorization-vs-capability separation, secret-reference non-leakage, and cross-client interoperability.

A shared conformance fixture should run against every client/runtime implementation.

## 14. Acceptance criteria

V2-001 is complete only when the protocol vocabulary is repository-resident and frozen; Workflow, WorkflowVersion, Deployment, Node, Capability, Trigger, and Run are defined; commands/events are separated; messages are versioned/correlated; execution is pinned to an immutable version; capability requirements are platform-independent; placement constraints are representable; evidence distinguishes intent/observation/verification/confirmation; pause/resume is explicit; all supported surfaces are protocol-equivalent; V1 compatibility boundaries are explicit; and conformance tests are defined before client-specific implementations begin.

## 15. Subsequent work

V2-002 Workflow Repository + Immutable Versioning
V2-003 Workflow IR
V2-004 Node + Capability Protocol
V2-005 Workflow Runs + Evidence
V2-006 Teaching Sessions
V2-007 Workflow Compiler
V2-008 Computer-Agent Runtime
V2-009 Scheduling + Events + Placement
V2-010 Reverse Teaching
V2-011 Optimization
V2-012 Collaboration + Marketplace + Economics
V2-013 WorkflowOS Self-Hosted Workflow Library

No later work item may redefine these concepts without a governed V2 architecture change.
