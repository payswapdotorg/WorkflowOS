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

## Forward-Evolution Invariants for the Next Architecture Version

The following rules are accepted development direction for future architecture versions. They do not retroactively change the canonical v1.0 workflow above.

### Unified lifecycle

- WorkflowOS supports three project lifecycle modes: `BUILD`, `CONTINUE`, and `MAINTAIN`.
- These modes use the same Work Item → Work Order → Execution → Verification → Review machinery.
- A project created outside WorkflowOS may be onboarded and subsequently governed by the same lifecycle.

### Native and external execution parity

- `native` and `external` execution are first-class execution modes for all lifecycle types.
- No lifecycle mode may be restricted to one execution mode by architecture design.
- A logical execution may hand off between native and external execution without creating a second Work Item or workflow state machine.
- Handoffs preserve authoritative context, execution identity, evidence, and auditability.

### Model capability preservation

- WorkflowOS must never deliberately reduce an eligible provider/model's native capabilities merely to equalize benchmark results.
- Benchmarking must preserve observed performance differences.
- Hard constraints such as authorization, subscription availability, quotas, privacy, security, provider capability, and project policy are eligibility filters, not quality penalties.

### Execution selection

- Execution selection must distinguish capability, eligibility, and performance.
- Benchmark evidence may rank eligible candidates but cannot override hard constraints.
- User and project preferences may influence selection after hard constraints are satisfied.

### Existing-project truth model

- Onboarding an existing repository must distinguish `observed`, `inferred`, `confirmed`, and `proposed` project knowledge.
- WorkflowOS must not represent reconstructed/inferred architecture as historical authoritative fact without confirmation.

### Continuous development and maintenance

- Maintenance work, security work, dependency updates, compatibility fixes, architecture drift, technical debt, and operational regressions are governed Work Items.
- No separate maintenance workflow engine may be introduced.
- Proactive maintenance signals must enter the existing Work Item → Work Order → Execution pipeline.

### Benchmark integrity

- Comparative trials must use the same architecture, requirements, acceptance criteria, Work Order, implementation context, prompt digest, repository baseline, and verification requirements.
- Benchmark systems must not suppress a better-performing provider to make another provider appear equivalent.
- Results must expose the underlying measurements as well as any derived score.

### Development governance and self-hosting (WORK-052, §34)

- The repository, not any chat conversation, is the durable source of truth for the
  architecture program: the canonical machine-readable development state lives in
  `spec/development-state/` (`governance-model.json` + `program-state.json`).
- WorkflowOS may govern planning, execution, verification, review, and maintenance of
  its own implementation.
- WorkflowOS may not silently rewrite its governing architecture, its architecture
  authority, or its foundational rules; governing-architecture changes continue through
  the architecture-change/versioning authority (Work Order + new immutable version).
- No self-hosted worker merges its own governing PR; PR review by the architect remains
  the only merge gate.
- The development-governance control plane is an application-layer capability: it holds
  no mutation ports over architecture, work-items, workflows, verification, or reviews;
  it issues no SQL; it creates no database tables; the frozen module set stays closed.
- Assurance profiles (`LIGHT`, `STANDARD`, `HIGH_ASSURANCE`, `CRITICAL`) change required
  assurance depth only — never authority semantics — and their requirements always
  dominate the impact/checkpoint matrix (assurance only adds depth).
- The parallel implementation protocol is repository-native: one Work Item per
  branch/PR, dependency-eligible starts, declared change surfaces with conflict
  detection, scope integrity, centralized architecture decisions, architect PR review
  as the merge gate.
- Governance state validation is fail-closed, including against code-pinned core
  prohibitions; a repository whose development state violates an invariant is not a
  valid governed state.
