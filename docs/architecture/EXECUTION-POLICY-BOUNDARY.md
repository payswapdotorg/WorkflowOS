# Execution Policy Architectural Boundary

## Status

ACCEPTED FORWARD-EVOLUTION CLARIFICATION

This document clarifies the placement of the execution-policy subsystem introduced by the forward execution-fabric roadmap. It does **not** modify the frozen v1.0 workflow authority model, module ownership rules, or architecture-version immutability requirements.

## Scope

The execution-policy subsystem provides application-layer evaluation used to determine whether an execution candidate is eligible and, after eligibility, to provide inputs to execution selection.

It is not a workflow engine, authorization engine, verification engine, repository integration, or provider gateway.

## Responsibilities

The execution-policy subsystem may own:

- candidate eligibility evaluation;
- hard-constraint evaluation before performance ranking;
- quota and rate-limit usage resolution from authoritative execution/provider records;
- privacy and security constraint evaluation;
- project/org policy inputs needed for execution eligibility;
- policy-derived eligibility explanations;
- provider-independent selection inputs consumed by future routing/selection logic.

## Explicit Non-Responsibilities

The execution-policy subsystem MUST NOT own:

- workflow state or workflow transitions;
- authorization or project membership decisions;
- verification semantics or acceptance-criterion evaluation;
- architect review or review findings;
- GitHub integration;
- provider-specific LLM or agent behavior;
- credential or secret ownership;
- authoritative execution lifecycle state;
- frontend-owned workflow decisions.

Those authorities remain with the frozen modules and existing provider gateways.

## Module Placement

WorkflowOS remains a modular monolith. `execution-policy` is an application-layer subsystem within that monolith, alongside the existing domain/application modules. It does not constitute a new distributed service or a replacement module for any frozen authority.

Conceptually:

```text
/workflows
    = lifecycle authority

/execution-policy
    = execution eligibility and selection policy

/agents
    = agent execution gateway and Agent Runs

/github
    = GitHub integration and CI ingestion

/verification
    = verification and evidence semantics

/reviews
    = architect reviews and findings
```

The execution-policy subsystem communicates with these boundaries through explicit interfaces/public ports. It must not reach into another module's internal implementation.

## Eligibility Authority

Eligibility is evaluated before benchmark ranking:

```text
Hard constraints
      ↓
Eligible candidates
      ↓
Benchmark/history
      ↓
Cost / latency / reliability
      ↓
User/project preferences
      ↓
Recommendation or selection
```

The subsystem may exclude a candidate because of a hard constraint. It must never convert an ineligible candidate into an eligible one by scoring, ranking, or preference adjustment.

## Usage Authority

Quota and rate-limit usage MUST be derived from authoritative execution/provider records. The subsystem must not introduce a parallel usage ledger solely to support eligibility decisions unless a future architecture version explicitly authorizes one.

## Provider Independence

Execution-policy contracts remain provider-independent. Provider adapters and provider-specific mechanics stay behind `/agents`, `/llm`, `/github`, or other explicitly defined provider boundaries.

## Relationship to Frozen v1.0

This clarification preserves the frozen v1.0 authority rules:

- `/workflows` remains the sole workflow-state authority;
- `/verification` remains the verification authority;
- `/github` remains the GitHub authority;
- frozen architecture versions remain immutable;
- external agents and LLMs remain replaceable participants;
- backend authorization remains authoritative;
- PostgreSQL remains the application state authority and GitHub remains the repository-state authority.

Any future change that transfers one of those frozen authorities, changes the canonical workflow state machine, or introduces a new architecture-level ownership boundary requires an approved Architecture Change Request and a new immutable architecture version.
