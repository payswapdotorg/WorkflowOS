# WorkflowOS Implementation Backlog — Requirements

## 1. REQUIREMENTS

| ID | Requirement | Module / component | Dependencies |
|---|---|---|---|
| PLAT-001 | Establish the TypeScript modular-monolith structure, explicit module interfaces, and background-worker execution model. | Platform | — |
| AUTH-001 | Authenticate users and establish WorkflowOS user identity. | `/auth`, `/users` | PLAT-001 |
| AUTH-002 | Persist organization membership and organization/project roles and permissions. | `/organizations`, `/auth` | AUTH-001 |
| AUTH-003 | Enforce tenant/project access server-side. | `/auth`, `/organizations`, `/projects` | AUTH-002, PROJ-001 |
| DATA-001 | Provide authoritative relational application persistence. | PostgreSQL | PLAT-001 |
| DATA-002 | Provide Redis-backed queues, transient locks, caching, and coordination; Redis is not authoritative. | Redis/workers | PLAT-001 |
| DATA-003 | Provide object storage for large/immutable artifacts with PostgreSQL references. | Object Storage | PLAT-001 |
| SEC-001 | Provide a secret-management abstraction for provider credentials. | Security boundary | PLAT-001 |
| OBS-001 | Provide structured logging, metrics, error tracking, and traceable execution IDs. | Platform/workflows | PLAT-001, DATA-002 |
| PROJ-001 | Persist organizations, projects, project configuration, and repository associations. | `/organizations`, `/projects` | DATA-001 |
| SPEC-001 | Persist specification documents and specification lifecycle. | `/specifications` | PROJ-001, DATA-001, DATA-003 |
| ARCH-001 | Persist Architecture and ArchitectureVersion with DRAFT/FROZEN/SUPERSEDED lifecycle. | `/architecture` | PROJ-001, DATA-001, SPEC-001 |
| ARCH-002 | Enforce immutable frozen architecture versions. | `/architecture` | ARCH-001 |
| ARCH-003 | Persist Architecture Decisions linked to versions. | `/architecture` | ARCH-001 |
| ARCH-004 | Persist Architecture Change Requests and create a new immutable version after approved change. | `/architecture` | ARCH-002, ARCH-003 |
| REQ-001 | Persist Requirements, architecture references, dependencies, verification requirements, and status. | `/requirements` | ARCH-001, DATA-001 |
| REQ-002 | Persist Acceptance Criteria with unique IDs, expectations, status, and evidence references. | `/requirements` | REQ-001 |
| WORK-001 | Persist coherent Work Items with requirements, criteria, constraints, dependencies, assignment, execution, PRs, verification, and review history. | `/work-items` | REQ-001, REQ-002, ARCH-001, PROJ-001 |
| WORK-002 | Persist and evaluate work-item dependencies. | `/work-items` | WORK-001 |
| WORK-003 | Persist Work Order state and associations; ownership remains in `/work-items`. | `/work-items` | WORK-001, REQ-002, ARCH-001 |
| GITHUB-001 | Connect projects to GitHub through the GitHub App and configured permissions. | `/github` | AUTH-002, PROJ-001, SEC-001 |
| GITHUB-002 | Retrieve repository/branch/commit/PR/review/check/workflow state through provider-independent interfaces. | `/github` | GITHUB-001, PROJ-001 |
| GITHUB-003 | Validate, persist, queue, and asynchronously process GitHub webhooks. | `/github` | GITHUB-001, SEC-001, DATA-001, DATA-002 |
| GITHUB-004 | Make duplicate webhook delivery idempotent. | `/github`, `/workflows` | GITHUB-003, WORKFLOW-001 |
| GITHUB-005 | Preserve historical PR associations; enforce one active implementation PR per work item; allow one PR to implement multiple explicitly associated work items. | `/github`, `/work-items` | GITHUB-002, WORK-001 |
| GITHUB-006 | Ingest GitHub Actions workflow/check results and artifacts as provider-independent CI evidence. | `/github` | GITHUB-002, GITHUB-003 |
| WORKFLOW-001 | Implement the frozen legal workflow state transitions and reject all others. | `/workflows` | WORK-001, WORK-002, GITHUB-005 |
| WORKFLOW-002 | Determine eligibility, assign work, initiate implementation, and create workflow executions. | `/workflows` | WORKFLOW-001, WORK-003, AGENT-001 |
| WORKFLOW-003 | Orchestrate verification and architect review according to the frozen state machine. | `/workflows` | WORKFLOW-001, VERIFY-001, REVIEW-001 |
| WORKFLOW-004 | Permit merge only after required approval and advance to next eligible work. | `/workflows` | WORKFLOW-003, GITHUB-005 |
| WORKFLOW-005 | Record material workflow transitions with traceable execution IDs. | `/workflows`, `/audit` | WORKFLOW-001, OBS-001, AUDIT-001 |
| LLM-001 | Provide provider-neutral LLM access, normalization, retries, usage/error recording, and credential isolation. | `/llm` | PLAT-001, SEC-001 |
| LLM-002 | Execute the architect reasoning role from repository/verification evidence without owning review/workflow state. | `/llm` | LLM-001, REVIEW-001, VERIFY-001, ARCH-001 |
| LLM-003 | Generate Work Orders from persistent project state and frozen architecture context. | `/llm` | LLM-001, WORK-003, REQ-002, ARCH-001 |
| AGENT-001 | Execute implementation agents through a provider-independent Agent Gateway. | `/agents` | WORK-003, SEC-001 |
| AGENT-002 | Persist Agent Runs, execution metadata, outputs, commits/PRs, tests, and blockers. | `/agents` | AGENT-001, WORK-001, DATA-003 |
| VERIFY-001 | Persist verification runs, results, evidence, and artifact references. | `/verification` | GITHUB-006, REQ-002, DATA-001, DATA-003 |
| VERIFY-002 | Explicitly map evidence to the acceptance criteria it proves. | `/verification` | VERIFY-001, REQ-002 |
| VERIFY-003 | Derive criterion/requirement status from evidence, not agent claims. | `/verification` | VERIFY-002 |
| REVIEW-001 | Persist Architect Reviews with work item, PR, architecture, verification, reviewer/model, input, verdict, timestamp. | `/reviews` | VERIFY-003, WORK-001, GITHUB-005 |
| REVIEW-002 | Persist Review Findings and correction requirements for traceable correction cycles. | `/reviews` | REVIEW-001, VERIFY-002 |
| AUDIT-001 | Persist append-oriented audit events for privileged/domain actions and workflow transitions. | `/audit` | DATA-001, PROJ-001 |
| NOTIFY-001 | Provide the optional provider-independent notification boundary. | `/notifications` | PROJ-001, WORKFLOW-005 |
| UI-001 | Display authoritative project, architecture, requirement, and work-item state. | Web Application | AUTH-003, PROJ-001, ARCH-001, REQ-001, WORK-001 |
| UI-002 | Display Agent Runs, PR state, CI/verification evidence, reviews, and audit history. | Web Application | AGENT-002, GITHUB-005, VERIFY-003, REVIEW-001 |
| UI-003 | Allow authorized workflow actions while keeping authorization/state authority in the backend. | Web Application/API | AUTH-003, WORKFLOW-001, UI-001 |
| DEPLOY-001 | Deploy Web Application, Backend API, Background Worker, PostgreSQL, Redis, Object Storage. | Infrastructure | PLAT-001, DATA-001, DATA-002, DATA-003, OBS-001, SEC-001 |

## 2. ACCEPTANCE CRITERIA

Every requirement above has objective criteria. Preferred evidence is shown after each criterion.

### Foundation
- PLAT-AC-01: Frozen modules exist as explicit boundaries — static architecture check.
- PLAT-AC-02: Cross-module calls use declared interfaces — static architecture check.
- PLAT-AC-03: Long-running work executes asynchronously — integration test.
- AUTH-AC-01: Valid authentication resolves one WorkflowOS identity — integration test.
- AUTH-AC-02: Invalid authentication is rejected — end-to-end test.
- AUTH2-AC-01: Organization membership persists — integration test.
- AUTH2-AC-02: Roles resolve to explicit permissions — unit/integration test.
- AUTHZ-AC-01: Unauthorized project access fails — API contract test.
- AUTHZ-AC-02: Cross-tenant identifiers do not grant access — integration test.
- AUTHZ-AC-03: Backend authorization remains effective when frontend checks are bypassed — end-to-end/API test.
- DATA-AC-01: Core entities persist relationally in PostgreSQL — database integration test.
- DATA-AC-02: Invalid foreign-key references fail — database constraint test.
- DATA-AC-03: Workflow state is recoverable from PostgreSQL without Redis — recovery integration test.
- DATA2-AC-01: Background jobs enqueue/process through Redis-backed workers — integration test.
- DATA2-AC-02: Redis is not authoritative state — recovery integration test.
- DATA3-AC-01: Large/immutable artifacts store with durable PostgreSQL references — integration test.
- DATA3-AC-02: Large bodies are not required in core relational records — schema/static check.
- SEC-AC-01: Provider credentials are accessed through the secret abstraction — integration test.
- SEC-AC-02: Provider secrets are absent from domain/workflow records — static/security test.
- OBS-AC-01: Every workflow execution has a traceable identifier — integration test.
- OBS-AC-02: Logs include that correlation identifier — integration test.

### Project / architecture
- PROJ-AC-01: Organization can own multiple projects — integration test.
- PROJ-AC-02: Project records organizational owner — database constraint.
- PROJ-AC-03: Project can associate one or more repositories — integration test.
- SPEC-AC-01: Specification document persists with project ownership/lifecycle — integration test.
- SPEC-AC-02: Invalid specification lifecycle transitions fail — unit/integration test.
- SPEC-AC-03: Large specification content can use object storage — integration test.
- ARCH-AC-01: ArchitectureVersion persists with project/architecture association — database integration test.
- ARCH-AC-02: Only DRAFT/FROZEN/SUPERSEDED states are accepted — database/unit test.
- ARCH-AC-03: Work item creation requires exactly one architecture version — database constraint/integration test.
- ARCH2-AC-01: Updates to FROZEN versions are rejected — integration test.
- ARCH2-AC-02: Frozen content remains unchanged after attempted modification — integration test.
- ARCH3-AC-01: ADR persists and links to a version — integration test.
- ARCH3-AC-02: Invalid ADR/version references are rejected — database constraint.
- ARCH4-AC-01: Change Request records affected version and requested change — integration test.
- ARCH4-AC-02: Unapproved Change Request cannot create replacement version — integration test.
- ARCH4-AC-03: Approved Change Request creates new immutable version — integration test.

### Requirements / work items
- REQ-AC-01: Requirement IDs are unique — database constraint.
- REQ-AC-02: Each requirement references exactly one architecture version — database constraint.
- REQ-AC-03: Requirement dependencies reference existing requirements — database constraint/integration test.
- AC-AC-01: Criterion IDs are unique — database constraint.
- AC-AC-02: Each criterion belongs to exactly one requirement — database constraint.
- AC-AC-03: Criterion status is PENDING/PASS/FAIL/BLOCKED only — database constraint.
- AC-AC-04: Criteria can reference evidence records — integration test.
- WORK-AC-01: Work item requires an architecture version — database constraint.
- WORK-AC-02: Historical PR associations are preserved — integration test.
- WORK-AC-03: Second simultaneous active implementation PR is rejected — database/integration test.
- WORK-AC-04: One PR can explicitly associate multiple work items — integration test.
- DEP-AC-01: Dependency references existing work item — database constraint.
- DEP-AC-02: Incomplete dependency blocks IMPLEMENTING eligibility — workflow integration test.
- DEP-AC-03: Circular dependency graphs are rejected — unit/integration test.
- WO-AC-01: Work Order contains project/work-item/architecture/requirement/criterion/constraint/verification/context/scope references — API contract/integration test.
- WO-AC-02: Work Order state is owned by `/work-items` — static architecture check.

### GitHub / workflow
- GH-AC-01: Repository connects through a GitHub App installation — GitHub integration test.
- GH-AC-02: Only configured GitHub permissions are used — integration/security test.
- GH-AC-03: GitHub-specific provider code remains in `/github` — static architecture check.
- GH2-AC-01: Repository/branch/commit/PR/review/check/workflow data are retrievable via provider-neutral interfaces — GitHub integration test.
- GH2-AC-02: Domain code does not depend directly on GitHub provider types — static architecture check.
- GH3-AC-01: Invalid webhook signatures/events are rejected — GitHub integration test.
- GH3-AC-02: Valid webhooks persist before async processing — integration test.
- GH3-AC-03: Webhook endpoint does not synchronously block on workflow processing — integration test.
- GH4-AC-01: Duplicate webhook delivery has one logical effect — integration test.
- GH4-AC-02: Duplicate delivery cannot create duplicate transitions — end-to-end integration test.
- GH5-AC-01: Historical PR associations remain after closure/supersession — integration test.
- GH5-AC-02: Two active implementation PRs for one work item are rejected — database/integration test.
- GH5-AC-03: Multi-work-item PRs record each explicit association — integration test.
- GH6-AC-01: GitHub Actions results are ingested as CI evidence — GitHub integration test.
- GH6-AC-02: `/github` does not evaluate acceptance criteria — static architecture check.
- WF-AC-01: Valid workflow transitions exactly match the frozen state machine — unit test.
- WF-AC-02: VERIFICATION_FAILED returns to IMPLEMENTING — unit test.
- WF-AC-03: CHANGES_REQUESTED returns to IMPLEMENTING — unit test.
- WF-AC-04: ARCHITECTURE_CHANGE_REQUIRED is terminal for the current implementation attempt — unit test.
- WF-AC-05: IMPLEMENTATION_BLOCKED is legal only from ASSIGNED/IMPLEMENTING/VERIFYING and resolves to IMPLEMENTING — unit test.
- WF-AC-06: Invalid transitions are rejected — unit/API test.
- WF-ORCH-AC-01: Incomplete dependencies prevent assignment — integration test.
- WF-ORCH-AC-02: Eligible work can be assigned and an execution record created — integration test.
- WF-ORCH-AC-03: Agent execution is asynchronous — integration test.
- WF-VER-AC-01: VERIFYING cannot advance before required verification completes — integration test.
- WF-VER-AC-02: Architect review receives persisted verification state/evidence context — integration test.
- WF-MERGE-AC-01: MERGED requires required approval — integration test.
- WF-MERGE-AC-02: VERIFIED is reached only through `/workflows` — integration test.
- WF-MERGE-AC-03: Next-work selection enforces dependencies — integration test.
- WF-AUDIT-AC-01: Material transitions emit audit events — integration test.
- WF-AUDIT-AC-02: Replayed idempotent events do not create conflicting audit state — integration test.

### LLM / agents / verification / review
- LLM-AC-01: `/llm` exposes a provider-independent request interface — API contract test.
- LLM-AC-02: Provider-specific responses are normalized — unit/integration test.
- LLM-AC-03: Provider credentials are unavailable to domain modules — static/security test.
- LLM2-AC-01: Architect execution consumes actual repository/verification evidence — integration test.
- LLM2-AC-02: Architect execution returns a canonical structured verdict — integration test.
- LLM2-AC-03: Architect execution cannot mutate workflow state — integration/static architecture test.
- LLM3-AC-01: Work-order generation reads persistent state, not transient conversation — integration test.
- LLM3-AC-02: Generated Work Orders include frozen architecture and verification context — API contract test.
- AGENT-AC-01: Agents execute through a provider-independent interface — integration test.
- AGENT-AC-02: Provider-specific agent behavior is adapter-isolated — static architecture check.
- AGENT-AC-03: Agent execution returns a normalized Execution Result — API contract test.
- AGENT-RUN-AC-01: Every implementation-agent interaction creates an Agent Run — integration test.
- AGENT-RUN-AC-02: Agent Run records provider/configuration/work-item/work-order/status/timing/output/commit/PR/tests/blockers — database/integration test.
- AGENT-RUN-AC-03: Agent output alone cannot mark a requirement complete — integration test.
- VERIFY-RUN-AC-01: Verification run can be created for an implementation attempt — integration test.
- VERIFY-RUN-AC-02: Verification results reference concrete evidence — database/integration test.
- VERIFY-RUN-AC-03: Large verification artifacts can reference object storage — integration test.
- VERIFY-MAP-AC-01: Evidence can be explicitly mapped to applicable criteria — integration test.
- VERIFY-MAP-AC-02: Evidence mappings identify the criteria actually supported — database/API contract test.
- VERIFY-EVAL-AC-01: Criterion status is derived from evidence according to verification expectation — unit/integration test.
- VERIFY-EVAL-AC-02: Passing CI alone cannot mark unrelated criteria PASS — integration test.
- VERIFY-EVAL-AC-03: Requirement completion cannot rely solely on agent claims — integration test.
- REVIEW-AC-01: Review record contains work item/PR/architecture/requirements/verification/reviewer/input/verdict/timestamp — database/integration test.
- REVIEW-AC-02: Only canonical review verdicts are accepted — database/API contract test.
- REVIEW-AC-03: Review persistence is independent of LLM invocation — integration test.
- FINDING-AC-01: A review can contain multiple findings — integration test.
- FINDING-AC-02: Findings identify affected requirement/criterion, severity, evidence, correction, verification requirement — API contract test.
- FINDING-AC-03: Correction cycles link back to their causing findings — integration test.

### Audit / UI / deployment
- AUDIT-AC-01: Audit records include actor/timestamp/org/project/entity/action/source/state — integration test.
- AUDIT-AC-02: Normal operations cannot silently rewrite audit history — integration/security test.
- NOTIFY-AC-01: Notification requests use an abstraction without provider coupling — integration/static architecture test.
- NOTIFY-AC-02: Notification failure does not incorrectly mutate authoritative workflow state — integration test.
- UI-AC-01: Authorized users can view project/architecture/requirements/work-item state — end-to-end test.
- UI-AC-02: Frontend consumes backend state and does not own authoritative workflow state — static architecture check.
- UI2-AC-01: Authorized users can view Agent Runs/PRs/verification evidence/reviews/audit history — end-to-end test.
- UI2-AC-02: Displayed workflow state matches backend after refresh — end-to-end test.
- UI3-AC-01: Unauthorized users cannot perform privileged workflow actions through direct backend calls — API/end-to-end test.
- UI3-AC-02: Frontend has no authoritative transition/authorization rules — static architecture check.
- DEPLOY-AC-01: Runtime topology contains Web App/API/Worker/PostgreSQL/Redis/Object Storage — deployment/integration test.
- DEPLOY-AC-02: WorkflowOS deploys independently of customer repositories — deployment test.
- DEPLOY-AC-03: Initial deployment does not require microservices — architecture/deployment check.
