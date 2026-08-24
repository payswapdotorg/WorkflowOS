# WorkflowOS Implementation Backlog — Work Items

## WORK ITEMS

### WORK-001 — Platform and modular-monolith foundation
Objective: Establish module boundaries, interface conventions, background workers, logging, and shared runtime foundation.
Requirements: PLAT-001, OBS-001
Dependencies: none
Acceptance criteria: PLAT-AC-01..03; OBS-AC-01..02
Required verification: unit tests, integration tests, static architecture checks
Architecture modules affected: platform and all frozen backend boundaries
Expected repository areas: backend root, module structure, workers, shared interfaces, observability
Out of scope: domain logic, provider integrations, frontend
Definition of done: Module/worker conventions are executable and verified.

### WORK-002 — Identity, organizations, permissions, tenant isolation
Objective: Implement identities, organization membership, project roles, authorization, and secret access boundary.
Requirements: AUTH-001, AUTH-002, AUTH-003, SEC-001
Dependencies: PLAT-001, DATA-001, PROJ-001
Acceptance criteria: AUTH-AC-01..02; AUTH2-AC-01..02; AUTHZ-AC-01..03; SEC-AC-01..02
Required verification: API, integration, security tests
Architecture modules affected: `/auth`, `/users`, `/organizations`, `/projects`
Expected repository areas: authentication, authorization, tenant scoping, org/project persistence
Out of scope: GitHub permission UX, frontend UX, provider implementations
Definition of done: Backend tenant isolation is enforced for authenticated project access.

### WORK-003 — PostgreSQL, Redis, object storage
Objective: Establish authoritative persistence and supporting queue/artifact boundaries.
Requirements: DATA-001, DATA-002, DATA-003
Dependencies: PLAT-001
Acceptance criteria: DATA-AC-01..03; DATA2-AC-01..02; DATA3-AC-01..02
Required verification: database integration and recovery tests
Architecture modules affected: persistence/platform boundary
Expected repository areas: schemas/migrations, Redis workers, object-storage abstraction
Out of scope: domain models and provider integrations
Definition of done: All three storage boundaries are available through stable application interfaces.

### WORK-004 — Project and specification domains
Objective: Implement projects, repository associations, and specification lifecycle.
Requirements: PROJ-001, SPEC-001
Dependencies: WORK-002, WORK-003
Acceptance criteria: PROJ-AC-01..03; SPEC-AC-01..03
Required verification: integration tests, API contract tests
Architecture modules affected: `/organizations`, `/projects`, `/specifications`
Expected repository areas: project/specification domains and persistence
Out of scope: architecture versions and GitHub sync
Definition of done: Tenant-owned projects and specifications persist with lifecycle state.

### WORK-005 — Architecture management and change control
Objective: Implement Architecture, versions, ADRs, immutability, and Change Requests.
Requirements: ARCH-001..004
Dependencies: WORK-004
Acceptance criteria: ARCH-AC-01..03; ARCH2-AC-01..02; ARCH3-AC-01..02; ARCH4-AC-01..03
Required verification: database constraint and integration tests
Architecture modules affected: `/architecture`
Expected repository areas: architecture domain, versioning, ADRs, change-request lifecycle
Out of scope: requirements generation and workflow engine
Definition of done: Frozen versions are immutable and approved changes create new immutable versions.

### WORK-006 — Requirements and acceptance criteria
Objective: Implement requirement/criterion persistence and architecture traceability.
Requirements: REQ-001, REQ-002
Dependencies: WORK-005, WORK-003
Acceptance criteria: REQ-AC-01..03; AC-AC-01..04
Required verification: database constraint, API, integration tests
Architecture modules affected: `/requirements`
Expected repository areas: requirements, criteria, persistence
Out of scope: verification semantics
Definition of done: Requirements and criteria have stable IDs and version traceability.

### WORK-007 — Work items, dependencies, Work Order state
Objective: Implement work items, dependency graph, PR association model, active-PR constraint, and Work Order state.
Requirements: WORK-001..003
Dependencies: WORK-005, WORK-006
Acceptance criteria: WORK-AC-01..04; DEP-AC-01..03; WO-AC-01..02
Required verification: database constraint, unit, integration tests
Architecture modules affected: `/work-items`
Expected repository areas: work-item domain, dependency graph, Work Order state
Out of scope: workflow transitions and LLM generation
Definition of done: Work units/dependencies can be persisted and validated.

### WORK-008 — GitHub App and repository integration
Objective: Establish provider-isolated GitHub connectivity and repository-state interfaces.
Requirements: GITHUB-001, GITHUB-002
Dependencies: WORK-002, WORK-004, WORK-003
Acceptance criteria: GH-AC-01..03; GH2-AC-01..02
Required verification: GitHub integration tests and static architecture checks
Architecture modules affected: `/github`
Expected repository areas: GitHub App/adapter, repository sync
Out of scope: webhooks, verification semantics, workflow orchestration
Definition of done: `/github` exposes provider-independent repository/PR/CI interfaces.

### WORK-009 — GitHub webhook ingestion and idempotency
Objective: Implement validation, persistence, queueing, and duplicate tolerance for GitHub webhooks.
Requirements: GITHUB-003, GITHUB-004
Dependencies: WORK-008, WORK-003, SEC-001
Acceptance criteria: GH3-AC-01..03; GH4-AC-01..02
Required verification: GitHub integration and duplicate-delivery tests
Architecture modules affected: `/github`, `/workflows`
Expected repository areas: webhook endpoint, event persistence, queue handlers, idempotency
Out of scope: workflow business rules and CI semantics
Definition of done: Duplicate webhook delivery produces one logical effect asynchronously.

### WORK-010 — Pull-request association and active-PR lifecycle
Objective: Implement historical PR associations and the frozen active-PR cardinality rule.
Requirements: GITHUB-005
Dependencies: WORK-007, WORK-008
Acceptance criteria: GH5-AC-01..03
Required verification: integration and database constraint tests
Architecture modules affected: `/github`, `/work-items`
Expected repository areas: PR persistence and association model
Out of scope: merge orchestration and CI ingestion
Definition of done: Work-item/PR cardinality is enforced exactly as frozen.

### WORK-011 — Canonical workflow state machine
Objective: Implement deterministic legal transitions and reject all others.
Requirements: WORKFLOW-001
Dependencies: WORK-007, WORK-010
Acceptance criteria: WF-AC-01..06
Required verification: exhaustive unit and workflow integration tests
Architecture modules affected: `/workflows`
Expected repository areas: state machine and transition policies
Out of scope: agent execution, verification engine, UI
Definition of done: Frozen state machine is executable and invalid transitions are rejected.

### WORK-012 — Agent Gateway and Agent Runs
Objective: Implement provider-independent agent execution and persistent Agent Runs.
Requirements: AGENT-001, AGENT-002
Dependencies: WORK-007, WORK-003, SEC-001
Acceptance criteria: AGENT-AC-01..03; AGENT-RUN-AC-01..03
Required verification: adapter integration and persistence tests
Architecture modules affected: `/agents`
Expected repository areas: Agent Gateway, adapters, Agent Run persistence
Out of scope: LLM Gateway and workflow state changes
Definition of done: Agents execute through a normalized interface with traceable runs.

### WORK-013 — LLM Gateway
Objective: Implement provider-neutral LLM access and provider adaptation.
Requirements: LLM-001
Dependencies: WORK-003, SEC-001
Acceptance criteria: LLM-AC-01..03
Required verification: unit, provider integration, static architecture tests
Architecture modules affected: `/llm`
Expected repository areas: LLM Gateway, adapters, normalization
Out of scope: architect orchestration and Work Order generation
Definition of done: Domain code uses LLM capabilities without provider coupling.

### WORK-014 — Work-order generation and architect execution
Objective: Implement LLM-backed architect reasoning and Work Order generation without owning persisted review/workflow state.
Requirements: LLM-002, LLM-003
Dependencies: WORK-006, WORK-007, WORK-013, GITHUB-002
Acceptance criteria: LLM2-AC-01..03; LLM3-AC-01..02
Required verification: integration, API contract, static boundary tests
Architecture modules affected: `/llm`, `/work-items`, `/reviews`
Expected repository areas: architect service, Work Order generation, persistent-state assembly
Out of scope: review persistence and workflow transitions
Definition of done: Architect and Work Order capabilities use persistent state and normalized outputs.

### WORK-015 — CI ingestion and verification engine
Objective: Implement CI ingestion, verification runs, evidence mapping, and criterion evaluation.
Requirements: GITHUB-006, VERIFY-001..003
Dependencies: WORK-006, WORK-008, WORK-003
Acceptance criteria: GH6-AC-01..02; VERIFY-RUN-AC-01..03; VERIFY-MAP-AC-01..02; VERIFY-EVAL-AC-01..03
Required verification: GitHub integration, verification unit, integration tests
Architecture modules affected: `/github`, `/verification`
Expected repository areas: CI adapter, verification domain, evidence store, criterion evaluator
Out of scope: architect review and workflow transitions
Definition of done: CI evidence is ingested by `/github`, evaluated by `/verification`, and produces deterministic criterion state.

### WORK-016 — Architect reviews and findings
Objective: Persist reviews, verdicts, findings, and correction-cycle traceability.
Requirements: REVIEW-001, REVIEW-002
Dependencies: WORK-014, WORK-015, WORK-010
Acceptance criteria: REVIEW-AC-01..03; FINDING-AC-01..03
Required verification: integration and API contract tests
Architecture modules affected: `/reviews`
Expected repository areas: reviews, findings, verdict validation
Out of scope: LLM invocation and state transitions
Definition of done: Review records and findings are durable and evidence-linked.

### WORK-017 — Workflow orchestration through implementation
Objective: Connect eligibility, assignment, Work Order generation, and agent execution to the state machine.
Requirements: WORKFLOW-002
Dependencies: WORK-011, WORK-012, WORK-014
Acceptance criteria: WF-ORCH-AC-01..03
Required verification: workflow integration tests
Architecture modules affected: `/workflows`, `/work-items`, `/llm`, `/agents`
Expected repository areas: orchestration services, worker jobs, transition handlers
Out of scope: verification/review orchestration
Definition of done: An eligible work item can flow through assignment and implementation asynchronously.

### WORK-018 — Verification and architect-review orchestration
Objective: Connect verification, review invocation, and review verdicts to the frozen state machine.
Requirements: WORKFLOW-003
Dependencies: WORK-015, WORK-016, WORK-017
Acceptance criteria: WF-VER-AC-01..02
Required verification: end-to-end workflow integration tests
Architecture modules affected: `/workflows`, `/verification`, `/reviews`, `/llm`
Expected repository areas: verification handlers, review handlers, correction-cycle orchestration
Out of scope: merge implementation
Definition of done: VERIFYING, failure, correction, and ARCHITECT_REVIEW paths execute according to the frozen machine.

### WORK-019 — Merge gating and workflow advancement
Objective: Implement approval-gated merge, VERIFIED completion, and next-work selection.
Requirements: WORKFLOW-004
Dependencies: WORK-018, WORK-010, WORK-002
Acceptance criteria: WF-MERGE-AC-01..03
Required verification: end-to-end workflow and GitHub integration tests
Architecture modules affected: `/workflows`, `/github`, `/work-items`
Expected repository areas: merge orchestration, eligibility, advancement
Out of scope: UI
Definition of done: Approved work merges, reaches VERIFIED through `/workflows`, and advances deterministically.

### WORK-020 — Audit and privileged-event trail
Objective: Persist audit events across domain, integration, review, and workflow operations.
Requirements: AUDIT-001, WORKFLOW-005
Dependencies: WORK-004, WORK-005, WORK-007, WORK-011, WORK-016, WORK-019
Acceptance criteria: AUDIT-AC-01..02; WF-AUDIT-AC-01..02
Required verification: integration and security tests
Architecture modules affected: `/audit`, `/workflows`
Expected repository areas: audit persistence, emitters/listeners, privileged-event policies
Out of scope: notifications
Definition of done: Material actions are traceable and audit history is append-oriented.

### WORK-021 — Notification boundary
Objective: Add the optional notification abstraction without coupling delivery to authoritative workflow state.
Requirements: NOTIFY-001
Dependencies: WORK-020, PROJ-001
Acceptance criteria: NOTIFY-AC-01..02
Required verification: integration and static architecture tests
Architecture modules affected: `/notifications`
Expected repository areas: notification abstraction, provider adapters, delivery jobs
Out of scope: mandatory provider selection
Definition of done: Notification events can be emitted safely through the optional boundary.

### WORK-022 — WorkflowOS web application
Objective: Implement authoritative read views and authorized actions without embedding workflow/authorization authority in frontend code.
Requirements: UI-001, UI-002, UI-003
Dependencies: WORK-002, WORK-004, WORK-005, WORK-006, WORK-007, WORK-019, WORK-020
Acceptance criteria: UI-AC-01..02; UI2-AC-01..02; UI3-AC-01..02
Required verification: end-to-end, API contract, static architecture tests
Architecture modules affected: Web Application / backend API
Expected repository areas: frontend, API endpoints, authorization boundary
Out of scope: frontend-owned workflow logic or authorization
Definition of done: Authorized users can observe and act on state while the backend retains authority.

### WORK-023 — Deployable runtime
Objective: Establish the frozen initial runtime topology.
Requirements: DEPLOY-001
Dependencies: WORK-001, WORK-003, WORK-020
Acceptance criteria: DEPLOY-AC-01..03
Required verification: deployment/integration test
Architecture modules affected: infrastructure
Expected repository areas: container/deployment configuration, API/worker startup
Out of scope: customer application deployment and Kubernetes-specific architecture
Definition of done: WorkflowOS runs in the specified modular-monolith-plus-workers topology.

### WORK-024 — End-to-end WorkflowOS development lifecycle
Objective: Prove the frozen architecture from project creation through merged/verified work.
Requirements: WORKFLOW-001..005, GITHUB-001..006, LLM-001..003, AGENT-001..002, VERIFY-001..003, REVIEW-001..002
Dependencies: WORK-019, WORK-020, WORK-022, WORK-023
Acceptance criteria: project creation; GitHub connection; frozen architecture; requirement/work-item creation; agent execution; PR association; CI ingestion; evidence-based verification; persisted architect review; correction cycle; approved merge; VERIFIED; complete audit trace.
Required verification: end-to-end test suite
Architecture modules affected: all frozen workflow modules and external integration boundaries
Expected repository areas: end-to-end tests, workflow fixtures, integration infrastructure
Out of scope: architectural changes and new deployment architecture
Definition of done: Complete frozen lifecycle executes without bypassing an architectural boundary.

## 2. IMPLEMENTATION ORDER

### Phase 1 — Foundation
1. WORK-001
2. WORK-003
3. WORK-002

### Phase 2 — Core project and planning
4. WORK-004
5. WORK-005
6. WORK-006
7. WORK-007

WORK-005 and WORK-006 can partially proceed in parallel once persistence/project foundations are stable.

### Phase 3 — GitHub integration
8. WORK-008
9. WORK-009
10. WORK-010

### Phase 4 — Agent and LLM integration
11. WORK-012
12. WORK-013
13. WORK-014

WORK-012 and WORK-013 can proceed in parallel after their shared dependencies.

### Phase 5 — Workflow engine
14. WORK-011
15. WORK-017

### Phase 6 — Verification and review
16. WORK-015
17. WORK-016
18. WORK-018

WORK-015 and WORK-016 can proceed in parallel after their input contracts exist.

### Phase 7 — Merge, audit, UI
19. WORK-019
20. WORK-020
21. WORK-021
22. WORK-022

### Phase 8 — Deployment and end-to-end verification
23. WORK-023
24. WORK-024

## 3. AUTONOMOUS EXECUTION EXTENSIONS — IMPLEMENTED

### WORK-025 — Autonomous Architecture Workspace
Objective: Let users interact with an architect LLM, iteratively refine architecture, and persist architecture/requirements/criteria/work-item plans without copy/paste.
Dependencies: WORK-014, WORK-022, WORK-024
Status: implemented

### WORK-026 — Autonomous Runtime, GitHub/Vercel Integration, Implementation Context
Objective: Provision project repositories, connect runtime/deployment providers, generate authoritative implementation context, configure agent providers, and drive real implementation execution.
Dependencies: WORK-025, WORK-008, WORK-012, WORK-023
Status: implemented

### WORK-027 — Execution Provider Abstraction
Objective: Unify native/API and external execution behind provider-independent ExecutionTask/ExecutionService contracts with secure external handoff.
Dependencies: WORK-026
Status: implemented

### WORK-028 — WorkflowOS Companion Extension
Objective: Eliminate manual copy/paste between WorkflowOS and external AI products through a secure browser extension and scoped callback flow.
Dependencies: WORK-027
Status: implemented

### WORK-029 — Z.ai Companion Adapter
Objective: Execute implementation tasks through the user's real Z.ai coding experience while preserving WorkflowOS authority and evidence boundaries.
Dependencies: WORK-028
Status: implemented

### WORK-030 — ChatGPT/Codex Companion Adapter
Objective: Execute implementation tasks through ChatGPT's coding-agent/Codex surface with no silent fallback to conversational chat.
Dependencies: WORK-029
Status: implemented

### WORK-031 — Claude Code Companion Adapter
Objective: Execute implementation tasks through Claude Code on the web using the user's existing authenticated session.
Dependencies: WORK-030
Status: implemented

## 4. EXECUTION AND INTELLIGENCE ROADMAP

### WORK-032 — Native vs External Execution Benchmark
Objective: Build a fair, evidence-driven benchmark that compares native/API and external execution for the exact same engineering task while preserving true provider capability differences.
Requirements: benchmark task snapshots, isolated trials, authoritative CI/verification/review metrics, comparison/export, benchmark integrity.
Dependencies: WORK-031
Execution modes: native and external are both mandatory benchmark dimensions.
Definition of done: Comparable trials prove identical task inputs, prompt digest, and repository baseline, and collect authoritative outcome metrics.

### WORK-033 — Execution Policy and Fair Benchmarking
Objective: Define capability ceilings, benchmark modes, execution policies, and constraint-aware selection without artificially reducing a provider's capabilities.
Dependencies: WORK-032
Core rules: hard constraints first; benchmark quality only ranks eligible candidates; subscription/plan limitations are eligibility constraints; no provider is deliberately handicapped.
Execution modes: native and external remain first-class.

### WORK-034 — Persistent Agent Sessions
Objective: Evolve execution from request/result jobs into resumable Agent Sessions with turns, tool calls, observations, checkpoints, interruptions, and terminal outcomes.
Dependencies: WORK-033, WORK-027
Execution modes: both native and external session state must remain observable through the same logical execution identity.

### WORK-035 — Agent Workspace and Git Worktrees
Objective: Give native agents isolated reproducible workspaces with repository, worktree, branch, baseline commit, filesystem, and execution metadata.
Dependencies: WORK-034, WORK-008
Execution modes: native uses WorkflowOS-managed workspaces; external continues to use provider-native workspaces while preserving the same Work Item/Execution identity.

### WORK-036 — Tool Runtime
Objective: Provide governed tool interfaces for filesystem, terminal, git, package/test execution, browser, HTTP, and related development capabilities.
Dependencies: WORK-035
Execution modes: tool outcomes remain observable for both native and external execution; external adapters report provider-side observations without bypassing WorkflowOS authority.

### WORK-037 — Agent Policy and Permissions
Objective: Add execution-specific policy controls distinct from project authorization: allow, deny, ask, and constrained capabilities for tools, network, secrets, and deployment actions.
Dependencies: WORK-036, WORK-002
Execution modes: policies apply to native execution and to external handoff eligibility/observability.

## 5. EXISTING PROJECTS, CONTINUOUS DEVELOPMENT, AND MAINTENANCE

### WORK-038 — Existing Project Onboarding
Objective: Allow users to connect software that WorkflowOS did not build and establish an explicit Project Baseline from repository evidence.
Dependencies: WORK-035, WORK-036, WORK-037, WORK-008
Required baseline provenance: observed, inferred, confirmed, proposed.
Execution modes: onboarding-triggered implementation work must support native and external execution.

### WORK-039 — Repository and Context Intelligence
Objective: Build persistent repository, dependency, architecture, symbol, API, test, runtime, and historical context used to assemble better implementation and maintenance contexts.
Dependencies: WORK-038, WORK-034
Execution modes: context is shared across native and external execution; providers receive the same authoritative task context subject to provider-specific limits.

### WORK-040 — Continuous Development Planner
Objective: Continuously turn product goals, technical debt, refactors, performance opportunities, developer requests, and dependency-aware priorities into governed Work Items.
Dependencies: WORK-039, WORK-032
Execution modes: recommended/selected execution may be native or external per eligibility and policy.

### WORK-041 — Maintenance and Project Health Engine
Objective: Detect dependency vulnerabilities, CI regressions, runtime changes, security advisories, compatibility issues, performance regressions, architecture drift, technical debt, and operational risks; create and prioritize maintenance Work Items.
Dependencies: WORK-039, WORK-040
Execution modes: maintenance Work Items must support native and external execution and the same verification/review lifecycle as feature work.

## 6. ADAPTIVE EXECUTION

### WORK-042 — Cross-Mode Execution Handoff
Objective: Allow one logical engineering execution to move from native/API execution to external execution or from external to native without creating a second Work Item or workflow state machine.
Dependencies: WORK-034, WORK-027
Requirements: preserve logical execution identity, implementation context, evidence, audit, branch/workspace state, and correction history.

### WORK-043 — Execution Eligibility and Constraint Engine
Objective: Determine which execution candidates are actually eligible before performance ranking.
Dependencies: WORK-033, WORK-037, WORK-042
Hard constraints may include: model capability, user subscription plan, quota, rate limits, provider availability, privacy, organization/project policy, native/external restrictions, and security requirements.

### WORK-044 — Adaptive Execution Router
Objective: Recommend or automatically select among eligible native/API and external candidates using benchmark outcomes, quality, reliability, cost, latency, human intervention, and user/project preferences.
Dependencies: WORK-032, WORK-033, WORK-043
Principle: never lower a provider's capability merely to equalize benchmark outcomes.

## 7. MULTI-AGENT INTELLIGENCE

### WORK-045 — Agent Roles
Objective: Model reusable engineering roles such as Architect, Planner, Implementer, Tester, Security Reviewer, Performance Reviewer, UX Reviewer, and Release Engineer independently from any specific provider.
Dependencies: WORK-034, WORK-036, WORK-044
Execution modes: each role may use native or external execution when eligible.

### WORK-046 — Multi-Agent Delegation
Objective: Allow one logical Work Item to coordinate multiple specialized agents while preserving one authoritative workflow and evidence chain.
Dependencies: WORK-045, WORK-035, WORK-037
Execution modes: heterogeneous mixes of native and external agents are supported.

### WORK-047 — Agent Intelligence
Objective: Use historical WorkflowOS evidence to recommend roles, providers, models, execution modes, fallback strategies, and task decomposition.
Dependencies: WORK-032, WORK-044, WORK-046
Hard constraints remain authoritative; intelligence may rank eligible candidates but cannot bypass policy, authorization, verification, review, or GitHub authority.

## 8. DEVELOPER PRODUCT EXPERIENCE

### WORK-048 — Developer Workbench
Objective: Create the primary Stripe-quality developer workspace centered on Project, Work Graph, Work Item, Execution, Changes, Verification, Reviews, Deployments, Maintenance, and Activity.
Dependencies: WORK-040, WORK-041, WORK-042, WORK-044
UX requirements: developer-first information density, fast navigation, inspectable decisions, command-oriented actions, Apple-level polish where useful, backend-owned authority.

### WORK-049 — Project Health and Maintenance UX
Objective: Give developers an always-current project health view covering CI, security, dependencies, architecture stability, performance, runtime, maintenance debt, and recommended Work Items.
Dependencies: WORK-041, WORK-048
Execution modes: every recommended maintenance action can enter native or external execution.

### WORK-050 — Unified Execution UX
Objective: Make native/API and external execution feel interchangeable at the Work Item level, including recommendations, eligibility explanations, provider capability, subscription constraints, and one-click cross-mode handoff.
Dependencies: WORK-042, WORK-043, WORK-048
Required user experience: developers see the engineering task first and execution strategy second; advanced users can inspect and override the recommendation.

## 9. IMPLEMENTATION ORDER — FORWARD ROADMAP

### Phase 9 — Autonomous execution foundation
25. WORK-025
26. WORK-026
27. WORK-027
28. WORK-028
29. WORK-029
30. WORK-030
31. WORK-031

### Phase 10 — Evidence and execution policy
32. WORK-032
33. WORK-033

### Phase 11 — Execution substrate
34. WORK-034
35. WORK-035
36. WORK-036
37. WORK-037

### Phase 12 — Existing software and continuous operation
38. WORK-038
39. WORK-039
40. WORK-040
41. WORK-041

### Phase 13 — Adaptive execution
42. WORK-042
43. WORK-043
44. WORK-044

### Phase 14 — Multi-agent intelligence
45. WORK-045
46. WORK-046
47. WORK-047

### Phase 15 — Developer product experience
48. WORK-048
49. WORK-049
50. WORK-050

All forward work items must preserve the frozen v1.0 authority rules unless an approved architecture change creates a new immutable architecture version.
