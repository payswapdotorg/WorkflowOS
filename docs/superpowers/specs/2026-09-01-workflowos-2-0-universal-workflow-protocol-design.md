# WorkflowOS 2.0 — V2-001 Universal Workflow Protocol Design

**Status:** Proposed architecture for V2-001; implementation-authorized through `spec/architecture/v2/V2-CTRL-000-implementation-authorization.md`  
**Date:** 2026-09-01  
**Governing architecture:** v1.0 remains frozen and authoritative. This document proposes the next architecture generation; it does not modify v1.0.  
**Canonical protocol registry:** `spec/architecture/v2/V2-CTRL-003-protocol-registry.md` + `V2-CTRL-003-protocol-registry.json`

## Purpose

WorkflowOS 2.0 is a computer-workflow operating system: people can describe or demonstrate work, WorkflowOS converts that knowledge into a reusable versioned workflow, and the workflow can execute on a capable web, desktop, mobile, or cloud node. A workflow can also be used in reverse to teach a person how to perform the task.

V2-001 establishes the universal protocol boundary used by all later V2 subsystems. It is intentionally narrower than the full V2 architecture.

## Non-goals

This work does not implement computer-use execution, teaching UX, workflow compilation, marketplace/payments, scheduling implementations, optimization, reverse teaching UX, desktop/mobile applications, cloud provisioning, or replacement of the frozen v1.0 workflow engine.

## Canonical object model

```text
Workflow
  └── immutable WorkflowVersion
        ├── WorkflowIR
        ├── dependencies
        ├── capability requirements
        ├── policies
        └── provenance
              │
              └── Deployment
                    └── Node / cloud host
                          └── Run
                                ├── steps
                                ├── capability invocations
                                ├── observations
                                └── evidence
```

**Workflow** is durable identity and collaboration scope. **WorkflowVersion** is immutable executable meaning. Editing creates a new version. **Deployment** binds a version to a target execution environment and policy context. **Run** records one execution of one pinned version.

## Protocol principles

### 1. Client-neutral semantics

The protocol must not assume browser, desktop, phone, or cloud. Surfaces may differ in UX and local capabilities, but workflow meaning, authorization, versioning, runs, and evidence are protocol-equivalent.

### 2. Capability-based execution

Workflows declare required capabilities and execution constraints. Nodes advertise capabilities. Eligibility combines capability matching with authorization and execution policy. Workflow semantics never directly depend on platform SDKs.

Canonical capability identifiers are governed by `V2-CTRL-003`; implementations must reuse those identifiers rather than invent aliases.

### 3. Explicit placement

Placement is represented as policy: required, preferred, allowed fallback, locality/privacy constraints, and human-approval requirements. A workflow can therefore be local, device-bound, cloud-bound, or portable without changing its identity.

### 4. Deterministic identity

Durable objects have stable identifiers and explicit version relationships. Run identity cannot depend solely on a UI session or model-generated text.

### 5. Evidence first

Intent, observation, deterministic verification, and human confirmation are separate concepts. A model assertion is not proof that a side effect occurred.

### 6. Version pinning

Every run executes one immutable WorkflowVersion. Updating a workflow never silently changes an installed deployment.

### 7. No implicit side effects

Protocol messages express requests or recorded facts. Omitted fields do not acquire hidden semantics.

## Protocol entities

### Workflow

Minimum fields: workflowId, tenant/owner, name, description, visibility, lifecycle status, current-version reference, collaboration/repository metadata.

### WorkflowVersion

Minimum fields: workflowVersionId, workflowId, immutable content digest, parent-version reference, WorkflowIR, capability requirements, dependencies, policy requirements, provenance, creation metadata.

### Node

An execution host participating in the protocol. It advertises identity, platform/device class, protocol version, capabilities, availability/health, locality, and security/trust attributes.

### Capability

A stable, namespaced, versionable operation a node can perform. Canonical examples are defined in `V2-CTRL-003`, including `browser.navigate`, `filesystem.read`, `phone.call.answer`, `phone.call.end`, `messaging.send`, `contacts.search`, `speech.synthesis`, `social.post.observe`, and `social.post.publish`.

Capability advertisement does not grant authorization.

### Trigger

The reason a run was requested: manual, schedule, external event, workflow completion, or device/application event. V2-001 defines the protocol shape; trigger implementations are later work.

Canonical event identifiers are governed by `V2-CTRL-003`.

### Deployment

A binding of WorkflowVersion + target placement + execution policy. It is the unit that can be enabled, disabled, inspected, and rolled back.

### Run

A record containing workflow/version/deployment/trigger identity, timestamps, status, input/output references, step records, evidence references, and policy decisions.

## Transport envelope

The initial transport uses a versioned envelope that can be carried over HTTP, WebSocket, or another transport without changing semantics:

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

The semantic requirements are: versioned, correlated, causally traceable, and attributable to an authenticated participant. Exact serialization and authentication mechanisms are later Work Order concerns, but all implementations must conform to the canonical registry and protocol fixtures.

## Command/event separation

Commands express requests, for example `workflow.execute`, `workflow.pause`, `workflow.resume`, `workflow.cancel`, `workflow.deploy`, and `capability.invoke`.

Events express facts, for example `workflow.run.started`, `workflow.step.started`, `capability.invocation.completed`, `observation.recorded`, `verification.completed`, `workflow.run.completed`, and `workflow.run.failed`.

A command acknowledgement is not evidence that the requested side effect occurred.

## Input/output model

Inputs and outputs are typed protocol values supporting scalars, structured values, file/object references, binary/media references, opaque secret references, user/device references, and collections. Large payloads should be referenced rather than embedded. Raw credentials must never appear in workflow definitions or ordinary run messages.

## Pause/resume

Pause/resume is protocol-level. A paused run retains its pinned WorkflowVersion, safe execution position, required state, outstanding approvals, and accumulated evidence. Resume is explicit and idempotent. Client disappearance does not imply cancellation.

## Security boundary

Identity, capability, authorization, execution policy, and secret reference are distinct. A node must authenticate to the protocol. Capability possession never bypasses authorization. Secrets are delivered only through controlled opaque references.

## Cross-surface requirement

Web, desktop, iOS, Android, and cloud runners implement the same protocol semantics. Allowed differences are UI, local sensors/device capabilities, local execution availability, platform authentication primitives, and lifecycle behavior. Workflow meaning, version identity, run model, capability vocabulary, evidence semantics, and authorization remain equivalent.

## V1 compatibility boundary

V1 remains authoritative for the existing WorkflowOS development/governance system. V2 may reuse mature V1 infrastructure only through explicit adapters and without changing V1 semantics.

V2 must not rewrite the frozen v1.0 architecture, v1.0 workflow state machine, PostgreSQL authority rules, or existing execution/verification authority boundaries. Existing software-engineering workflows become V2 workflow content rather than a second execution engine.

## Conformance requirements

The implementation must provide shared conformance fixtures for:

1. envelope serialization/deserialization;
2. version negotiation;
3. correlation and causation preservation;
4. workflow/version/run identity preservation;
5. command/event distinction;
6. capability declaration and matching;
7. placement constraints;
8. input/output schema validation;
9. pause/resume idempotency;
10. authorization vs capability separation;
11. secret-reference non-leakage;
12. cross-client interoperability;
13. canonical protocol registry conformance (no alternate aliases for existing identifiers).

## Acceptance criteria

V2-001 is complete only when the protocol vocabulary is repository-resident and frozen; Workflow, WorkflowVersion, Deployment, Node, Capability, Trigger, and Run are defined; commands and events are separated; messages are versioned and correlated; execution is pinned to an immutable version; capability requirements are platform-independent; placement constraints are representable; evidence distinguishes intent/observation/verification/confirmation; pause/resume is explicit; all supported surfaces are protocol-equivalent; V1 compatibility boundaries are explicit; the canonical registry is referenced; and conformance tests are defined before client-specific implementations begin.

## Subsequent work

The canonical execution order is the optimized wave graph, not the following historical list order. Fresh agents must use `spec/development-state/v2-work-order-state.json` and `V2-CTRL-002-roadmap-lock.md` for activation order.

- V2-002 Workflow Repository + Immutable Versioning
- V2-003 Workflow IR
- V2-004 Node + Capability Protocol
- V2-005 Workflow Runs + Evidence
- V2-006 Teaching Sessions
- V2-007 Workflow Compiler
- V2-008 Computer-Agent Runtime
- V2-009 Scheduling + Events + Placement
- V2-010 Reverse Teaching
- V2-011 Optimization
- V2-012 Collaboration + Marketplace + Economics
- V2-013 WorkflowOS Self-Hosted Workflow Library

No later work item may redefine concepts frozen here without a governed V2 architecture change.
