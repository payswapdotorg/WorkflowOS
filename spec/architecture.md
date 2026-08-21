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

The initial modules are:

```text
/auth
/users
/organizations
/projects
/specifications
/requirements
/work-items
/workflows
/agent-runs
/reviews
/github
/llm
/agents
/notifications
/audit
```

Each module owns its domain entities and business rules.

Modules communicate through explicit application/domain interfaces rather than directly reaching into another module's internal implementation.

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

A new version is required for architectural changes.

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
* associated pull request
* execution history
* verification results
* architect review results

A work item should represent a coherent implementation change that can reasonably be implemented and reviewed as one unit.

---

# 13. Work Item State Machine

The canonical workflow states are:

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
  ↓
ARCHITECT_REVIEW
  ↓
APPROVED
  ↓
MERGED
  ↓
VERIFIED
```

Alternative states include:

```text
CHANGES_REQUESTED
IMPLEMENTATION_BLOCKED
VERIFICATION_FAILED
ARCHITECTURE_CHANGE_REQUIRED
```

The Workflow Engine owns these state transitions.

External agents must not directly mutate workflow state outside authorized APIs.

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

Each implementation PR is associated with one or more WorkflowOS work items.

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

The Verification Engine maps objective evidence to acceptance criteria.

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

# 33. Secrets

Provider credentials and sensitive tokens must not be stored as ordinary application data.

The architecture uses a secret-management abstraction.

Application code accesses secrets through that abstraction.

Provider-specific credentials must not be embedded in domain objects or workflow records.

---

# 34. Multi-Tenancy

All tenant-owned data belongs to an Organization.

Project-level resources inherit organizational ownership.

Authorization is enforced server-side.

No request may access a resource solely because the client supplied its identifier.

Resource ownership must be resolved through authorized organization/project relationships.

---

# 35. Observability

The system must provide:

* structured logging
* application metrics
* workflow/job metrics
* error tracking
* distributed tracing where practical

Long-running workflow executions must have traceable identifiers so a user can follow:

```text
Work Item
→ Agent Run
→ Commit
→ PR
→ CI
→ Verification
→ Architect Review
→ Merge
```

---

# 36. Deployment

The initial system is containerized.

The initial deployment consists conceptually of:

```text
Web Application
Backend API
Background Worker
PostgreSQL
Redis
Object Storage
```

Infrastructure should be deployable independently of the customer's application repositories.

The exact cloud provider is intentionally not part of this architectural version.

---

# 37. Domain Boundary Summary

The primary domain relationships are:

```text
Organization
    ↓
Project
    ↓
Architecture Version
    ↓
Requirement
    ↓
Acceptance Criteria
    ↓
Work Item
    ↓
Agent Run
    ↓
Pull Request
    ↓
Verification
    ↓
Architect Review
    ↓
Merge
```

These relationships are central to WorkflowOS and must remain explicit.

---

# 38. Core Architectural Invariants

The following invariants are mandatory:

1. PostgreSQL is the authoritative WorkflowOS state.
2. GitHub is the authoritative repository state.
3. LLM output is never automatically treated as proof of implementation.
4. Acceptance criteria require evidence.
5. Workflow state transitions are controlled by the Workflow Engine.
6. Frozen architecture versions are immutable.
7. Every work item references an architecture version.
8. Every implementation PR references at least one work item.
9. Verification occurs before architectural approval.
10. Architecture review occurs before merge unless explicitly overridden by project policy.
11. Implementation agents cannot silently modify architecture.
12. External providers are isolated behind adapters.
13. Tenant boundaries are enforced server-side.
14. Secrets are never treated as ordinary business data.
15. Long-running work executes asynchronously.
16. Workflow/event processing is idempotent.
17. Conversation history is not a system of record.
18. All important workflow transitions are auditable.

---

# 39. Explicit Non-Goals for Version 1

The following are not part of the frozen architecture:

* running arbitrary customer code inside WorkflowOS infrastructure
* replacing GitHub as the source-control system
* requiring a specific LLM vendor
* requiring a specific coding-agent vendor
* autonomous architectural modification
* fully autonomous production deployment
* microservices as a requirement
* customer Kubernetes management
* building an independent CI platform
* treating chat history as persistent project state

---

# 40. Architectural Change Process

Any change to this architecture requires:

```text
Architecture Change Request
        ↓
Impact Analysis
        ↓
Architect Review
        ↓
Human Approval
        ↓
New Architecture Version
        ↓
Updated Requirements / Work Items
```

No implementation agent may bypass this process.

---

# 41. End-to-End Workflow

The canonical WorkflowOS development lifecycle is:

```text
1. Create Project
2. Connect GitHub Repository
3. Create Architecture
4. Freeze Architecture
5. Generate Requirements
6. Generate Work Items
7. Determine Eligible Work Item
8. Generate Work Order
9. Execute Implementation Agent
10. Create / Update Pull Request
11. Run CI / Verification
12. Evaluate Acceptance Criteria
13. Request Architect Review
14. Architect Reviews Actual Evidence
15. APPROVE
      OR
    REQUEST_CHANGES
      OR
    ARCHITECTURE_CHANGE_REQUIRED
16. Repeat correction cycle when required
17. Merge Approved Pull Request
18. Mark Work Item VERIFIED
19. Determine Next Eligible Work Item
20. Repeat
```

This workflow is the primary behavior that the WorkflowOS architecture exists to support.

---

# 42. Architecture Boundary Rule

Future implementation decisions must preserve the distinction between:

```text
Persistent project state
Workflow orchestration
External provider integrations
Implementation execution
Deterministic verification
LLM-based architectural reasoning
User authorization
```

These responsibilities must not be collapsed into a single generic "AI service."

The platform's reliability depends on these boundaries remaining explicit.
