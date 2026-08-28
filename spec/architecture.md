# WorkflowOS Architecture

**Version:** 1.0
**Status:** FROZEN
**Purpose:** Define the architectural structure of WorkflowOS, a platform for managing LLM-assisted software development workflows.

---

# 1. Purpose

WorkflowOS enables software teams to manage an AI-assisted development workflow in which:

1. A project has a frozen architecture.
2. The architecture is converted into requirements and implementation work items.
3. Coding agents implement individual work items.
4. Implementations are submitted through GitHub pull requests.
5. Automated verification evaluates the implementation.
6. An architect agent independently reviews the implementation.
7. Failed implementations receive targeted correction instructions.
8. Approved work is merged.
9. The workflow advances to the next eligible work item.

WorkflowOS is responsible for maintaining the state, evidence, workflow transitions, and audit history of this process.

LLMs and coding agents are replaceable external participants in the workflow.

---

# 2. Architectural Principles

## 2.1 System of Record

WorkflowOS application state is stored in PostgreSQL.

Repository state is stored in GitHub.

Neither conversational history nor an LLM's memory is a system of record.

## 2.2 Evidence Over Claims

An implementation agent's statement that something is implemented is not sufficient evidence of completion.

Requirements and acceptance criteria must be evaluated using objective evidence whenever practical.

## 2.3 Workflow Authority

The Workflow Engine is responsible for workflow state transitions.

LLMs may provide decisions, recommendations, prompts, reviews, and other content, but they do not directly control workflow state.

## 2.4 Frozen Architecture

Once an architecture version is frozen, implementation agents must not modify it.

Architectural changes require an explicit Architecture Change Request and creation of a new architecture version.

## 2.5 Provider Independence

WorkflowOS must not be architecturally dependent on a single LLM provider or coding-agent provider.

External providers are accessed through provider adapters.

## 2.6 Modular Monolith First

WorkflowOS will initially be implemented as a modular monolith with background workers.

The architecture must preserve clear domain boundaries so that components can later be extracted into services if scale requires it.

Microservices are not required for the initial implementation.

---

# 3. System Context

WorkflowOS interacts with the following external systems:

* End users
* GitHub
* GitHub Actions
* LLM providers
* Coding-agent providers
* Optional notification providers
* Optional secret-management infrastructure
* Infrastructure hosting the WorkflowOS application

The high-level relationship is:

```text
                    ┌─────────────────┐
                    │      USER       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   WorkflowOS    │
                    └───────┬─────────┘
                            │
             ┌──────────────┼───────────────┐
             │              │               │
             ▼              ▼               ▼
          GitHub        LLM Providers    Agent Providers
             │
             ▼
       GitHub Actions
```

---

# 4. High-Level Architecture

WorkflowOS consists of the following major layers:

```text
┌─────────────────────────────────────────────┐
│                 Web Application             │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│              Application API                │
│             Modular Backend                 │
├─────────────────────────────────────────────┤
│ Auth / Organizations / Projects             │
│ Specifications / Requirements              │
│ Work Items / Workflow                       │
│ Agent Runs / Reviews                        │
│ GitHub / LLM / Agent integrations           │
│ Notifications / Audit                       │
└──────────────────────┬──────────────────────┘
                       │
            ┌──────────┼──────────┐
            │          │          │
            ▼          ▼          ▼
       PostgreSQL     Redis     Object Storage
            │
            ▼
     Background Workers
            │
     ┌──────┼─────────┐
     ▼      ▼         ▼
  GitHub    LLM      Agent
 Gateway   Gateway   Gateway
```

---

# 5. Frontend

The frontend is a web application.

The frontend is responsible for:

* displaying project state
* displaying architecture and requirements
* displaying work items
* displaying agent execution state
* displaying GitHub pull requests
* displaying verification results
* displaying architect reviews
* displaying audit history
* allowing authorized users to perform workflow actions

The frontend must not contain authoritative workflow logic.

Workflow transitions and authorization decisions are enforced by the backend.

---

# 6. Backend

The backend is a TypeScript modular monolith.

The backend owns application and domain logic.

The frozen module ownership boundaries are documented below. The module paths are:

```text
/auth
/users
/organizations
/projects
/architecture
/specifications
/requirements
/work-items
/workflows
/verification
/reviews
/llm
/agents
/github
/notifications
/audit
```

Each module owns its domain entities and business rules.

Modules communicate through explicit application/domain interfaces rather than directly reaching into another module's internal implementation.

## Frozen module ownership

The frozen module boundaries are:

| Module | Responsibility |
|---|---|
| `/architecture` | Architecture Management; ADRs; Architecture Change Requests; Architecture Versions |
| `/specifications` | specification documents and specification lifecycle |
| `/requirements` | Requirements; Acceptance Criteria |
| `/work-items` | Work Items; Work Item Dependencies; Work Order state |
| `/workflows` | workflow state machine; legal state transitions; orchestration |
| `/verification` | verification; evidence; criterion evaluation |
| `/reviews` | Architect Reviews; Review Findings |
| `/llm` | LLM Gateway; Architect role execution; Work-order generation |
| `/agents` | Agent Gateway; Agent Runs |
| `/github` | GitHub App; GitHub webhooks; Pull Requests; CI integration |

The `/llm` module provides architect/LLM capabilities. The `/reviews` module owns persisted review records and findings.


---

# 7. Auth and Organizations

WorkflowOS is multi-tenant.

The top-level ownership hierarchy is:

```text
Organization
    │
    └── Project
          │
          └── Repository
```

Users belong to organizations.

Projects belong to organizations.

Access to project resources must be enforced server-side.

The frontend must not be trusted to enforce authorization.

The initial authorization model should support organization/project roles and permissions.

---

# 8. Projects

A Project is the primary WorkflowOS container for a software development effort.

A project contains:

* project configuration
* connected repositories
* architecture versions
* architecture decisions
* requirements
* work items
* agent runs
* pull requests
* verification results
* reviews
* workflow executions
* audit events

A project is associated with one or more repositories as supported by the product model.

---

# 9. Architecture Management

The `/architecture` module owns Architecture, Architecture Versions, Architecture Decisions, and Architecture Change Requests.

Architecture is a versioned project artifact.

The model is:

```text
Architecture
    ├── Architecture Version 1
    ├── Architecture Version 2
    └── Architecture Version N
```

An architecture version may be:

```text
DRAFT
FROZEN
SUPERSEDED
```

A frozen architecture version is immutable.

A new immutable architecture version is created only from an approved Architecture Change Request.

Architecture versions may reference Architecture Decision Records.

Each work item must reference exactly one architecture version.

This provides historical traceability between implementation work and the architectural rules that governed it.

---

# 10. Requirements

Requirements are first-class domain objects.

A requirement contains:

* unique identifier
* title
* description
* architecture version
* dependencies
* acceptance criteria
* verification requirements
* status
* associated work items
* evidence

Example:

```text
AUTH-001
OAuth Authentication

Architecture Version:
3

Acceptance Criteria:
AC-1
AC-2
AC-3
AC-4
```

Requirement status must not be based solely on an implementation agent's statement.

---

# 11. Acceptance Criteria

Acceptance criteria are first-class objects associated with requirements.

Each criterion must have:

* unique identifier
* description
* verification expectation
* status
* evidence references

Possible status values:

```text
PENDING
PASS
FAIL
BLOCKED
```

Where practical, evidence should originate from automated verification.

Examples include:

* unit tests
* integration tests
* end-to-end tests
* contract tests
* static analysis
* architecture checks
* CI results
* manually recorded evidence where automation is not practical

---

# 12. Work Items

A Work Item is the primary implementation unit.

A work item contains:

* objective
* requirements covered
* acceptance criteria
* dependencies
* architecture version
* architecture constraints
* out-of-scope definition
* implementation agent assignment
* associated pull requests
* active implementation pull request (at most one)
* execution history
* verification results
* architect review results

A work item should represent a coherent implementation change that can reasonably be implemented and reviewed as one unit.

---

# 13. Work Item State Machine

The canonical workflow states and legal transitions are:

```text
DRAFT
  ↓
READY
  ↓
ASSIGNED
  ↓
IMPLEMENTING
  ↓
PR_OPEN
  ↓
VERIFYING
  ├── VERIFICATION_FAILED → IMPLEMENTING
  └── ARCHITECT_REVIEW
          ├── CHANGES_REQUESTED → IMPLEMENTING
          ├── ARCHITECTURE_CHANGE_REQUIRED → ARCHITECTURE_CHANGE_REQUEST
          └── APPROVED → MERGED → VERIFIED
```

`IMPLEMENTATION_BLOCKED` may occur during `ASSIGNED`, `IMPLEMENTING`, or `VERIFYING` and returns to `IMPLEMENTING` when resolved.

`ARCHITECTURE_CHANGE_REQUIRED` is terminal for the current implementation attempt until the architecture change is resolved.

The Workflow Engine owns the workflow state machine and all legal state transitions. External agents must not directly mutate workflow state outside authorized APIs.

State transitions are deterministic and idempotent.

---

# 14. Workflow Engine

The Workflow Engine coordinates the development lifecycle.

Its responsibilities include:

* determining whether work item dependencies are satisfied
* creating workflow executions
* assigning work items
* requesting implementation
* reacting to GitHub events
* initiating verification
* requesting architect review
* processing architect decisions
* initiating correction cycles
* determining when a work item may be merged
* marking work as verified
* advancing the project to the next eligible work item

The Workflow Engine is deterministic.

LLMs provide inputs to the workflow but do not own the workflow state machine.

---

# 15. Agent Runs

Every interaction with an implementation agent is represented as an Agent Run.

An Agent Run contains:

* agent provider
* agent configuration
* work item
* work order
* execution status
* start time
* completion time
* output
* referenced commit
* pull request
* reported tests
* reported blockers
* execution metadata

Agent output must be treated as claims/evidence inputs rather than authoritative verification.

---

# 16. LLM Gateway

The `/llm` module owns the LLM Gateway, architect role execution, and Work-order generation.

All LLM providers are accessed through a provider-independent interface.

The domain/application layer must not directly depend on a specific provider.

Conceptually:

```text
Architect Service
       │
       ▼
   LLM Gateway
       │
 ┌─────┼─────┬─────┐
 ▼     ▼     ▼     ▼
OpenAI Anthropic Google Other
```

The LLM Gateway is responsible for:

* provider selection
* model selection
* request construction
* response normalization
* retries
* usage recording
* error handling
* provider-specific adaptation

LLM provider credentials must not be exposed to domain modules.

---

# 17. Agent Gateway

The Agent Gateway is separate from the LLM Gateway.

An LLM generates reasoning or content.

An Agent performs repository/development actions.

The Agent Gateway provides a provider-independent interface for implementation agents.

Examples of supported agent types may include:

* Z.ai
* Gemini
* Codex
* Claude-based agents
* other API-accessible coding agents
* local agents
* human/manual execution

An agent receives a Work Order.

An agent returns an Execution Result.

The architecture must not assume that every agent provider exposes identical capabilities.

---

# 18. Work Order

A Work Order is the implementation instruction generated for an implementation agent.

A work order references:

* project
* work item
* architecture version
* requirements
* acceptance criteria
* architecture constraints
* relevant repository context
* required verification
* out-of-scope areas

The Work Order is generated from persistent project state rather than from transient conversational memory.

---

# 19. Architect Reviews

Architect review is a first-class workflow object.

A review is associated with:

* work item
* pull request
* architecture version
* requirements
* verification state
* reviewer agent/model
* review input
* structured verdict
* findings
* timestamp

Canonical architect verdicts are:

```text
APPROVE
REQUEST_CHANGES
ARCHITECTURE_CHANGE_REQUIRED
IMPLEMENTATION_BLOCKED
```

An architect review must evaluate actual repository evidence rather than relying only on the implementation agent's narrative.

---

# 20. Review Findings

A review may contain multiple findings.

Each finding contains:

* affected requirement or criterion
* severity
* description
* evidence
* required correction
* verification requirement

The findings are persisted so correction cycles remain traceable.

---

# 21. GitHub Integration

The `/github` module owns the GitHub App, GitHub webhooks, Pull Requests, and CI integration. GitHub Actions is an external CI provider.

GitHub is the authoritative source for repository state.

WorkflowOS integrates with GitHub through a GitHub App.

The integration supports, according to configured permissions:

* repository discovery
* pull requests
* commits
* branches
* pull request diffs
* reviews
* review comments
* check runs
* workflow runs
* webhook events

GitHub webhook events enter WorkflowOS through a dedicated webhook ingestion boundary.

GitHub-specific implementation details must remain inside the GitHub integration module.

The rest of the application communicates through provider-independent interfaces.

---

# 22. GitHub Event Processing

The event flow is:

```text
GitHub
   ↓
Webhook Endpoint
   ↓
Signature/Event Validation
   ↓
Event Persistence
   ↓
Event Queue
   ↓
Workflow Engine
```

Events must be processed asynchronously.

The system must tolerate duplicate webhook delivery.

Workflow transitions must therefore be idempotent.

---

# 23. Pull Requests

A work item may have multiple PRs over its lifetime and must preserve historical PR associations. A work item may have only one active implementation PR at a time. A PR may implement one or more work items, provided each work item is explicitly associated with that PR.

WorkflowOS tracks:

* repository
* PR number
* branch
* base branch
* head commit
* status
* checks
* review state
* associated work items

A pull request is the primary integration boundary between an implementation agent and the target repository.

---

# 24. Verification

The `/verification` module owns verification runs, verification results, evidence, acceptance-criterion evaluation, and evidence-to-criterion mapping. The `/github` module owns GitHub integration and CI result ingestion.

Verification is separate from architecture review.

Verification determines whether required technical checks pass.

Examples:

* build
* unit tests
* integration tests
* end-to-end tests
* lint
* type checking
* contract tests
* architecture tests
* security checks

WorkflowOS consumes verification results from the configured CI system.

The initial implementation assumes GitHub Actions is the primary CI provider.

---

# 25. Verification Engine

The Verification Engine is implemented within `/verification`, which owns verification semantics and evidence-to-criterion mapping. `/github` only ingests CI provider results.

Conceptual flow:

```text
Acceptance Criterion
        ↓
Required Evidence
        ↓
CI/Test/Artifact Result
        ↓
Verification Result
        ↓
Criterion Status
```

A passing CI run does not automatically imply that every acceptance criterion has passed.

The verification layer must associate evidence with the criteria it actually proves.

---

# 26. Customer CI

WorkflowOS does not initially execute arbitrary customer code itself.

Customer repositories remain responsible for running their own CI/build/test environment.

WorkflowOS consumes the resulting status and artifacts.

This minimizes infrastructure complexity and keeps repository execution inside the customer's existing GitHub environment.

---

# 27. Background Jobs

Long-running tasks must execute asynchronously.

The initial architecture uses Redis-backed background workers.

Representative job types include:

```text
github.webhook
github.sync
llm.request
agent.execute
verification.collect
architect.review
notification.send
```

The API must not block waiting for long-running LLM, agent, GitHub, or verification operations.

---

# 28. PostgreSQL

PostgreSQL is the authoritative WorkflowOS application database.

Core persistent domains include:

```text
Users
Organizations
Projects
Repositories
GitHub Installations
Architectures
Architecture Versions
Architecture Decisions
Requirements
Acceptance Criteria
Work Items
Work Item Dependencies
Agent Runs
Work Orders
Pull Requests
Verification Runs
Verification Results
Reviews
Review Findings
Workflow Executions
Audit Events
```

Relational integrity must be enforced through appropriate keys, constraints, and indexes.

JSON fields may be used for provider-specific or unstructured metadata where appropriate, but JSON must not replace core relational domain modeling.

---

# 29. Redis

Redis is used for:

* background job queues
* transient locks
* caching where appropriate
* short-lived coordination data

Redis is not the authoritative source of workflow state.

---

# 30. Object Storage

Object storage is used for large or immutable artifacts where storing the complete content in PostgreSQL is undesirable.

Potential artifacts include:

* large agent transcripts
* PR snapshots
* generated reports
* CI artifacts
* large specification files
* exported project data

PostgreSQL stores metadata and references to these objects.

---

# 31. Audit Log

WorkflowOS maintains an append-oriented audit trail.

Representative events include:

```text
PROJECT_CREATED
ARCHITECTURE_CREATED
ARCHITECTURE_FROZEN
REQUIREMENT_CREATED
WORK_ITEM_CREATED
WORK_ITEM_ASSIGNED
WORK_ORDER_GENERATED
AGENT_RUN_STARTED
AGENT_RUN_COMPLETED
PULL_REQUEST_CREATED
VERIFICATION_STARTED
VERIFICATION_COMPLETED
ARCHITECT_REVIEW_STARTED
ARCHITECT_REVIEW_COMPLETED
CHANGES_REQUESTED
WORK_ITEM_APPROVED
PULL_REQUEST_MERGED
WORK_ITEM_VERIFIED
ARCHITECTURE_CHANGE_REQUESTED
```

Audit records should capture:

* actor
* timestamp
* organization
* project
* entity
* action
* relevant before/after state
* source

Audit history must not be casually editable through normal application operations.

---

# 32. Security

Security boundaries apply at every layer.

Requirements include:

* server-side authorization
* organization/project isolation
* encrypted credential storage
* least-privilege GitHub permissions
* provider credential isolation
* authenticated webhook processing
* auditability of privileged actions
* no exposure of provider secrets to implementation agents unless explicitly required
* no direct unrestricted database access by LLMs or coding agents

External providers should receive only the minimum information needed for their assigned operation.

---

# 33. Forward Architecture Evolution — Project Lifecycle and Execution Fabric

> **Status:** Forward-looking architectural addendum. This section records the accepted direction for subsequent architecture versions and does not retroactively mutate the frozen v1.0 workflow or authority rules above. Any implementation that changes the frozen state machine or module ownership must still be introduced through an approved Architecture Change Request and a new immutable architecture version.

WorkflowOS evolves from a project-build workflow into a continuous software-development operating system with three product lifecycle modes:

```text
BUILD        → greenfield project development
CONTINUE     → ongoing development of an existing project
MAINTAIN     → continuous maintenance and health management of an existing project
```

All three modes use the same authoritative Work Item → Work Order → Execution → Verification → Review → Merge/Release machinery. They must not create separate implementation engines.

## 33.1 Unified Execution Fabric

Every implementation task supports both:

```text
NATIVE
  WorkflowOS → ExecutionService → AgentGateway → provider API/local agent

EXTERNAL
  WorkflowOS → ExecutionService → Companion → user's native provider product
```

Native/API and external execution are first-class, not fallback tiers. A task may begin in one mode and continue in the other without losing the logical Work Item, Work Order, implementation context, evidence, or audit trail.

## 33.2 Full-Capability Principle

WorkflowOS must not deliberately weaken a capable model or remove its native capabilities merely to reduce observed differences between providers. Providers should run at their normal eligible capability ceiling.

WorkflowOS standardizes:

* task definition
* architecture
* requirements
* context
* verification
* review
* policy
* evidence

It does not artificially cap model quality. Benchmarking must preserve measured capability differences.

## 33.3 Execution Eligibility and Selection

Execution selection is a constrained optimization problem:

```text
Hard constraints
  ↓
Eligible candidates
  ↓
Historical benchmark performance
  ↓
Cost / latency / reliability
  ↓
User and project preferences
  ↓
Recommendation or automatic selection
```

Hard constraints may include:

* required execution capability
* user/provider subscription limits
* model availability
* API quota/rate limits
* project policy
* organization policy
* privacy requirements
* native-only or external-only requirements
* security constraints

Subscription and availability constraints are eligibility inputs, not quality scores.

## 33.4 Fair Benchmarking

Benchmark comparisons must use the same:

* architecture version
* requirements
* acceptance criteria
* Work Item
* Work Order
* implementation context
* prompt digest
* repository baseline commit
* verification requirements

Benchmarking must expose capability differences rather than suppressing them.

WorkflowOS may maintain separate benchmark modes for:

* maximum-capability comparison
* controlled comparison
* cost-constrained execution
* latency-constrained execution
* subscription-constrained execution

## 33.5 Existing-Project Onboarding

WorkflowOS must support projects not originally created by WorkflowOS.

Onboarding should establish a Project Baseline containing:

* repository and baseline commit
* observed technology stack
* inferred architecture
* dependency graph
* test/CI health
* deployment/runtime state
* security findings
* technical debt
* current risks

Inferred information must carry explicit provenance such as `observed`, `inferred`, `confirmed`, or `proposed`. WorkflowOS must not falsely represent inferred architecture as the historical source of truth.

## 33.6 Continuous Development and Maintenance

WorkflowOS should proactively identify and pursue:

* product features
* refactors
* technical debt
* dependency upgrades
* security vulnerabilities
* runtime compatibility changes
* CI regressions
* browser compatibility issues
* performance regressions
* architecture drift
* operational issues

Actionable signals become governed Work Items and follow the same execution/verification/review path as planned product work.

## 33.7 Cross-Mode Handoff

A logical execution may move between native and external environments:

```text
Native Qwen
   ↓
blocked / capability gap
   ↓
External Claude Code
   ↓
continue same logical execution
```

or:

```text
External Z.ai
   ↓
needs unavailable capability
   ↓
Native agent
   ↓
continue same Work Order
```

The handoff preserves the logical execution identity and accumulated authoritative context. A handoff is not a new Work Item and must not create a second workflow state machine.

## 33.8 Agent Runtime Direction

Future native execution should provide a controlled execution environment with:

* isolated Git worktrees
* filesystem access
* terminal/process execution
* git tooling
* package/test runners
* browser tooling where required
* network policy
* secret policy
* checkpoints and resumability
* observation capture

These capabilities are execution infrastructure, not workflow authority.

## 33.9 Agent Intelligence Direction

A future Agent Intelligence layer may recommend or select roles, providers, models, modes, and fallback strategies using:

* task characteristics
* project constraints
* benchmark evidence
* provider availability
* historical success
* cost
* latency
* human-intervention requirements

This layer must select among eligible candidates and must never override hard authorization, security, or capability constraints.

# 34. Forward Architecture Evolution — Development Governance and Self-Hosting Control Plane

This section records the WORK-052 design package (Issue #61; design document
`docs/superpowers/specs/2026-08-28-development-governance-design.md`). It is an
append-only forward-evolution section: no frozen v1.0 rule is modified. Full design:
`docs/superpowers/specs/2026-08-28-development-governance-design.md`; machine-readable
model: `spec/development-state/governance-model.json`.

## 34.1 Repository-Resident Development State

The repository — not any chat conversation — is the durable source of truth for the
WorkflowOS architecture program. The canonical machine-readable development state lives
in `spec/development-state/`:

* `governance-model.json` — the governance model (Engineering Control Loop, assurance
  profiles, governed checkpoint contracts, self-hosting boundary, authority map);
  architect-owned, changed only through Work Orders.
* `program-state.json` — the program state (governing architecture version, one record
  per Work Order with status/dependencies/declared change surfaces/branch-PR bindings/
  merge evidence/handoff records/checkpoint outcomes, decisions index); maintained by
  implementers per the parallel protocol, made canonical by architect merge.

A fresh checkout must be able to reconstruct the architecture program — governing
version, Work Orders and their statuses, dependency frontier, parallelization
eligibility, applicable checkpoints and assurance depth, constraining decisions, and
resumption state — from these artifacts alone. The control-plane capability
(`backend/src/development-governance/`, application layer — not a frozen module) loads
and validates them fail-closed and answers the control-plane queries; the
`governance:status` CLI prints the summary.

## 34.2 The Engineering Control Loop

The development control loop is `sense → understand → plan → check → execute → verify →
review → release → observe → learn`. Every stage is an existing authority or capability
(§34 of the design document maps each stage); the loop is connective tissue, not a new
engine. The `check` stage is the architecture checkpoint (WORK-051) with adaptive
assurance depth (§34.4); the `learn` stage is durable decisions (ADRs + the decisions
index) plus feedback provenance on work-order records feeding the next plan. Runtime,
user, and maintenance feedback enters governed planning only through existing producers
(the planner, the maintenance engine, verification failures, reviews) creating governed
Work Items.

## 34.3 Architecture Checkpoints as Fitness Functions

Architecture checkpoints are first-class governed control points. The governed
checkpoint contracts — the architecture fitness functions — are defined as data in
`governance-model.json`, one per quality attribute: authority preservation; dependency
direction; tenant isolation; identity/idempotency; concurrency and crash safety;
external side-effect boundaries; exact-revision/provenance integrity;
migration/immutability safety; duplicate-authority prevention; implementation
completeness against the Work Order; and the self-hosting boundary. Each contract
declares its proof classes — static structural, dynamic behavioral/concurrency, and
discrimination/mutation — with enforcement references that must exist in the repository
(validated fail-closed). The `governance-manifest` detector (in the WORK-051 closed
registry) evaluates the development-governance state itself at any exact revision
through the existing revision-bound snapshot substrate.

## 34.4 Adaptive Assurance Profiles

Assurance profiles are `LIGHT`, `STANDARD`, `HIGH_ASSURANCE`, `CRITICAL` — a
deterministic function of a work order's declared change surfaces (critical surfaces
such as authority boundaries, security/tenant changes, or schema changes select
`CRITICAL`; complex surfaces such as public contracts, concurrency, or external side
effects select `HIGH_ASSURANCE`; module-internal changes select `STANDARD`;
documentation/local changes select `LIGHT`; unclassified surfaces fail closed to the
`HIGH_ASSURANCE` floor). Profiles change ASSURANCE DEPTH ONLY — which checkpoint
contracts apply, which proof classes are required, and what evidence must be recorded —
never authority semantics. Every profile's required checkpoint kinds dominate the
WORK-051 impact/checkpoint matrix; assurance only adds depth. Trivial changes remain
`LIGHT`; heavy process is never mandatory for them.

## 34.5 Parallel Implementation Protocol

Multiple independent implementation agents may work concurrently under the
repository-native protocol: one Work Item per implementation branch/PR; dependency
eligibility computed from the dependency DAG (an item is eligible only when every
declared dependency is complete); declared change surfaces with deterministic conflict
detection (two in-flight items sharing a surface — a module, overlapping migration
numbering, the composition root, the static architecture suite, a shared spec document —
are a reported conflict requiring explicit architect coordination); scope integrity (a
worker edits only its own declared surfaces); centralized architecture decisions (Work
Orders + ADRs are the only entry points); and PR review by the architect as the only
merge gate. The protocol works without conversational state.

## 34.6 Evidence and Decision Durability

Material architectural decisions are recoverable from repository artifacts alone:
ADRs (`docs/adr/` — the repository-resident ADR authority for WorkflowOS's own
architecture, parallel to the runtime `/architecture` per-project ADR feature), design
packages, Work Orders, checkpoint outcomes recorded in `program-state.json`, and the
decisions index. PR comments and chat are ephemeral coordination, never the durable
record.

## 34.7 Self-Hosting Boundary

WorkflowOS MAY govern — through its own machinery — planning its own implementation,
executing changes, verification, review, and maintenance. WorkflowOS MAY NOT silently
rewrite its governing architecture, its own architecture authority, or its foundational
rules: changes to the governing architecture continue through the
architecture-change/versioning authority (architect-issued Work Order and, at runtime,
the Architecture Change Request → new immutable version path). No self-hosted worker
merges its own governing PR. The boundary is machine-readable in
`governance-model.json`, validated fail-closed against code-pinned core prohibitions,
pinned verbatim in the static architecture suite, and enforced at checkpoints by the
`governance-manifest` detector. Governance state is never stored outside the repository
(PostgreSQL remains the authority for tenant runtime state; the repository is the
authority for the self-hosting program).
