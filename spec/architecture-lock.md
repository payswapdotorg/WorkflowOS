# Architecture Lock

## Status

FROZEN

This document establishes the rules governing implementation of the frozen WorkflowOS architecture.

The architecture may not be changed implicitly by implementation agents, coding agents, reviewers, or automated workflows.

## Immutable Architectural Decisions

Implementation agents MUST NOT change any of the following without an approved Architecture Change Request:

* system architecture
* application/module boundaries
* technology choices
* database architecture
* workflow/state-machine architecture
* API boundaries
* data ownership
* authentication and authorization architecture
* GitHub integration architecture
* LLM Gateway architecture
* Agent Gateway architecture
* verification architecture
* background-job architecture
* tenant isolation model
* credential/security architecture
* architecture versioning model

## Architecture Change Rule

If implementation of a requirement appears to require an architectural change, the implementation agent MUST stop and report:

ARCHITECTURE_CHANGE_REQUIRED

The implementation agent MUST NOT make the architectural change.

A proposed architectural change must instead go through:

1. Architecture Change Request
2. Impact analysis
3. Architect review
4. Explicit human approval
5. Creation of a new architecture version
6. Explicit replacement of the affected frozen version

## Source of Truth

The following are authoritative:

1. `/spec/architecture.md`
2. `/spec/architecture-lock.md`
3. Approved Architecture Decision Records
4. Approved requirement specifications

Conversation history is NOT authoritative.

LLM-generated text is NOT authoritative unless persisted into the repository or WorkflowOS state.

## Core Architectural Invariants

1. PostgreSQL is the authoritative WorkflowOS workflow state.

2. GitHub is the authoritative source for repository state.

3. LLMs are not authoritative evidence of implementation completion.

4. Acceptance criteria must be supported by evidence.

5. The workflow engine controls workflow state transitions.

6. LLMs may make recommendations and decisions within their assigned role but may not bypass workflow policy.

7. Implementation agents cannot modify the frozen architecture.

8. Frozen architecture versions are immutable.

9. Every work item must reference the architecture version under which it was created.

10. Every implementation must produce traceable evidence.

11. Every implementation PR must be associated with one or more work items.

12. Verification must occur before architectural approval.

13. Architectural approval must occur before merge unless an explicitly approved project policy states otherwise.

14. Credentials and secrets must never be stored as ordinary application data.

15. Tenant boundaries must be enforced server-side.

16. External LLM and agent providers must be accessed through provider adapters and must not be directly coupled to domain logic.

## Implementation Rule

Implementation agents must implement the architecture as specified.

They must not:

* redesign the system
* replace architectural components for convenience
* introduce new architectural patterns without approval
* bypass specified module boundaries
* weaken verification requirements
* remove requirements to make implementation easier
* mark incomplete work as complete
* simulate functionality in place of real implementation

## Evidence Rule

A requirement is not considered complete because an implementation agent says it is complete.

Completion requires appropriate evidence, such as:

* automated tests
* integration tests
* end-to-end tests
* contract validation
* static analysis
* architecture checks
* CI results
* manual verification where appropriate

## Scope Rule

Implementation work must remain within the assigned work item.

Unrelated refactoring, architectural cleanup, technology substitutions, and feature expansion require explicit approval.

## Human Authority

When an architectural ambiguity, contradiction, or required architectural change is discovered, human approval is required.

The system must favor stopping and escalating over silently inventing an architectural decision.
