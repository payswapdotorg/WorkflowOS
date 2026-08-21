# Architecture Lock

## Status

FROZEN

This document is authoritative for the frozen architectural rules of WorkflowOS.

## Work item / Pull Request cardinality

- A work item may have multiple PRs over its lifetime, preserving historical PR associations.
- A work item may have only one active implementation PR at a time.
- A PR may implement one or more work items, provided each work item is explicitly associated with that PR.

## Workflow authority

- `/workflows` owns the workflow state machine, legal transitions, and orchestration.
- External agents and LLMs cannot directly mutate workflow state.
- Workflow transitions are deterministic and idempotent.

## Canonical workflow

```text
DRAFT
→ READY
→ ASSIGNED
→ IMPLEMENTING
→ PR_OPEN
→ VERIFYING
```

From `VERIFYING`:
- `VERIFICATION_FAILED` → `IMPLEMENTING`
- `ARCHITECT_REVIEW`

From `ARCHITECT_REVIEW`:
- `CHANGES_REQUESTED` → `IMPLEMENTING`
- `ARCHITECTURE_CHANGE_REQUIRED` → `ARCHITECTURE_CHANGE_REQUEST`
- `APPROVED` → `MERGED` → `VERIFIED`

`IMPLEMENTATION_BLOCKED` may occur during `ASSIGNED`, `IMPLEMENTING`, or `VERIFYING` and returns to `IMPLEMENTING` when resolved.

`ARCHITECTURE_CHANGE_REQUIRED` is terminal for the current implementation attempt until the architecture change is resolved.

## Architecture ownership

The `/architecture` module owns Architecture, ArchitectureVersion, ArchitectureDecision, and ArchitectureChangeRequest. Approved architecture changes create a new immutable architecture version. Frozen architecture versions are immutable.

## Verification ownership

The `/verification` module owns verification runs, verification results, evidence, acceptance-criterion evaluation, and evidence-to-criterion mapping. GitHub Actions is an external CI provider. `/github` owns GitHub integration and CI result ingestion; `/verification` owns verification semantics.

## Module boundaries

- `/architecture`: Architecture Management, ADRs, Architecture Change Requests, Architecture Versions
- `/specifications`: specification documents and specification lifecycle
- `/requirements`: Requirements, Acceptance Criteria
- `/work-items`: Work Items, Work Item Dependencies, Work Order state
- `/workflows`: workflow state machine, legal state transitions, orchestration
- `/verification`: verification, evidence, criterion evaluation
- `/reviews`: Architect Reviews, Review Findings
- `/llm`: LLM Gateway, Architect role execution, Work-order generation
- `/agents`: Agent Gateway, Agent Runs
- `/github`: GitHub App, GitHub webhooks, Pull Requests, CI integration

The `/llm` module provides architect/LLM capabilities. The `/reviews` module owns persisted review records and findings.

## Existing frozen invariants

- PostgreSQL is the authoritative WorkflowOS application/workflow state.
- GitHub is authoritative for repository state.
- Acceptance criteria require traceable evidence.
- Frozen architecture versions are immutable.
- Work items reference exactly one architecture version.
- Tenant boundaries are enforced server-side.
- Credentials and secrets are not ordinary application data.
- Provider-specific LLM and agent behavior remains behind their gateways.
- GitHub-specific behavior remains inside `/github`.
