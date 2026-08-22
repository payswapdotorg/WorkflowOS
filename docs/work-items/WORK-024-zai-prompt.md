# Step 2 — Generate Coding-Agent Prompt for WORK-024

You are the Architecture Authority for WorkflowOS.

The frozen architecture, requirements, and implementation backlog are authoritative.

The following work items are complete and merged into `main`:

- WORK-001 — Platform and modular-monolith foundation
- WORK-002 — Identity, organizations, permissions, tenant isolation
- WORK-003 — PostgreSQL, Redis, object storage
- WORK-004 — Project and specification domains
- WORK-005 — Architecture management and change control
- WORK-006 — Requirements and acceptance criteria
- WORK-007 — Work items, dependencies, Work Order state
- WORK-008 — GitHub App and repository integration
- WORK-009 — GitHub webhook ingestion and idempotency
- WORK-010 — Pull-request association and active-PR lifecycle
- WORK-011 — Canonical workflow state machine
- WORK-012 — Agent Gateway and Agent Runs
- WORK-013 — LLM Gateway
- WORK-014 — Work-order generation and architect execution
- WORK-015 — CI ingestion and verification engine
- WORK-016 — Architect Reviews and Findings
- WORK-017 — Workflow convergence through implementation
- WORK-018 — Verification and architect-review orchestration
- WORK-019 — Merge gating and workflow advancement
- WORK-020 — Audit and privileged-event trail
- WORK-021 — Notification boundary
- WORK-022 — WorkflowOS web application
- WORK-023 — Deployable runtime

The next and final backlog item is:

**WORK-024 — End-to-end WorkflowOS development lifecycle**

Read these authoritative files from `main` before generating the implementation prompt:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

WORK-024 is explicitly the final lifecycle proof item. The frozen backlog defines it as:

```text
Objective:
Prove the frozen architecture from project creation through merged/verified work.

Requirements:
WORKFLOW-001..005
GITHUB-001..006
LLM-001..003
AGENT-001..002
VERIFY-001..003
REVIEW-001..002

Dependencies:
WORK-019
WORK-020
WORK-022
WORK-023

Acceptance criteria:
project creation;
GitHub connection;
frozen architecture;
requirement/work-item creation;
agent execution;
PR association;
CI ingestion;
evidence-based verification;
persisted architect review;
correction cycle;
approved merge;
VERIFIED;
complete audit trace.

Required verification:
end-to-end test suite

Architecture modules affected:
all frozen workflow modules and external integration boundaries

Expected repository areas:
end-to-end tests, workflow fixtures, integration infrastructure

Out of scope:
architectural changes and new deployment architecture

Definition of done:
Complete frozen lifecycle executes without bypassing an architectural boundary.
```

# CRITICAL DISTINCTION

WORK-024 is primarily an **integration verification** work item.

Do not use it as an excuse to redesign or broaden any completed domain.

The implementation should prove that the already-merged architecture composes correctly from:

```text
project creation
        ↓
GitHub connection
        ↓
architecture creation/freezing
        ↓
requirements + criteria
        ↓
Work Item + Work Order
        ↓
workflow initiation
        ↓
Agent Run
        ↓
PR association
        ↓
CI ingestion
        ↓
verification evidence
        ↓
criterion/requirement evaluation
        ↓
Architect execution/review
        ↓
correction cycle where needed
        ↓
APPROVED
        ↓
merge gating
        ↓
GitHub merged
        ↓
MERGED
        ↓
VERIFIED
        ↓
next eligible work
        ↓
audit trace
```

The end-to-end test must consume the existing public contracts and authoritative services.

Do not replace real boundaries with mocks merely to make the scenario pass.

Mocks/fakes are appropriate only where an external provider cannot safely be invoked in CI. In those cases, the fake must sit behind the existing provider-independent adapter and exercise the same boundary.

# PRIMARY OBJECTIVE

Create a deterministic, repeatable E2E scenario that proves the complete frozen WorkflowOS lifecycle can execute without bypassing:

* authentication/authorization;
* tenant isolation;
* project ownership;
* architecture version ownership and immutability;
* requirement/criterion persistence;
* Work Item and dependency authority;
* Work Order authority;
* GitHub provider boundary;
* Agent Gateway;
* LLM Gateway;
* Verification authority;
* Review authority;
* Workflow Engine;
* Merge gate;
* Audit authority;
* deployment/runtime topology.

The test must prove actual persisted state, not just successful API responses.

# TEST ENVIRONMENT

Inspect the existing `main` runtime and test infrastructure first.

Prefer the existing test/deployment infrastructure created by WORK-023.

If necessary, create a dedicated E2E harness that:

* starts the same modular-monolith API/worker topology already established;
* uses the existing PostgreSQL/Redis/object storage boundaries;
* uses deterministic provider fakes/adapters where external GitHub/LLM/Agent access is not available;
* exercises the real Fastify API and real worker path;
* persists and verifies data through PostgreSQL;
* does not create a second application runtime.

Do not create a parallel E2E-specific backend architecture.

# ENVIRONMENT / FIXTURES

Build explicit deterministic fixtures:

```text
Organization A
  User A
  Project A
  GitHub installation A
  Repository A
  Architecture A
  Frozen ArchitectureVersion A1
  Requirements A
  Criteria A
  Work Item A
  Work Order A

Organization B
  User B
  Project B
  Architecture B
  Work Item B
```

Use Organization B to prove tenant isolation during the lifecycle.

The test must ensure every resource created for the main scenario belongs to Project A and Organization A.

# AUTHENTICATION / AUTHORIZATION

Start the E2E scenario with the existing authentication mechanism.

Prove:

```text
User A
→ authenticated
→ resolves to WorkflowOS identity
→ can access Project A
```

Also prove:

```text
User A
→ cannot access Project B
→ cannot manipulate Work Item B
→ cannot read Work Item B's audit history
```

Do not bypass the backend AuthorizationService in the E2E path.

# PROJECT CREATION

The lifecycle must begin with project creation, using the supported API/public contract.

Verify persistence:

```text
Organization A
    owns Project A
```

Verify a user from Organization B cannot access the created project.

Do not seed the project directly in PostgreSQL if the acceptance criterion requires project creation through the API/domain boundary.

# GITHUB CONNECTION

Use the existing `/github` provider-independent interface.

For CI, use the existing deterministic fake/provider adapter if a real GitHub App cannot be used.

Prove:

```text
Project A
  → GitHub installation
  → repository association
  → provider-independent repository identity
```

Do not import provider-specific GitHub types into other modules.

Verify the repository/PR identity can later be used by Work Item/merge gating.

# ARCHITECTURE

Create and freeze the project ArchitectureVersion using the existing `/architecture` contracts.

Verify:

```text
Architecture A
  → Version A1
  → FROZEN
```

Prove frozen content is immutable.

Do not directly update architecture persistence in the E2E flow.

The E2E scenario must use the actual ArchitectureService/API.

# REQUIREMENTS / ACCEPTANCE CRITERIA

Create requirements and acceptance criteria through the existing `/requirements` boundary.

At least one requirement should have multiple criteria so the verification engine's scope rules are exercised.

Example:

```text
REQ-001
  AC-001 — implementation behavior
  AC-002 — CI evidence
```

Do not allow the E2E fixture to fabricate authoritative PASS evidence from client input.

# WORK ITEM / WORK ORDER

Create a Work Item referencing the frozen ArchitectureVersion.

Create or generate the Work Order through the existing Work Item/LLM contract.

Verify:

```text
Work Item A
  → ArchitectureVersion A1
  → Project A
  → Organization A
```

and:

```text
Work Order A
  → Work Item A
  → ArchitectureVersion A1
  → Project A
```

The E2E test must prove the persisted traceability chain.

# WORKFLOW INITIATION

Begin the lifecycle through the existing `/workflows` API/orchestration boundary.

Do not directly set a workflow state.

The canonical state must move through the actual WorkflowEngine.

Verify persisted transition history.

At minimum exercise:

```text
DRAFT
→ READY
→ ASSIGNED
→ IMPLEMENTING
```

using the real existing orchestration.

# AGENT EXECUTION

Use the existing Agent Gateway through its provider-independent contract.

The fake adapter may return deterministic implementation output, such as:

```text
commit_ref
pull_request_ref
reported_tests
reported_blockers
```

The Agent Run must be persisted.

Verify:

* Work Item ID;
* Work Order ID;
* provider/configuration;
* status;
* output;
* commit/PR;
* reported tests;
* blockers;
* timing/execution ID.

Do not let Agent output directly change requirements/criteria or workflow state.

The Agent Run must trigger the existing workflow convergence path.

# PR ASSOCIATION

Associate the implementation PR through `/work-items` / GitHub public contracts.

Verify:

* PR belongs to Work Item A;
* active-PR cardinality holds;
* historical association is persisted;
* PR identity is available to merge gating.

Do not insert directly into `wfos_pull_request_associations` in the E2E scenario.

# CI INGESTION

Produce a deterministic GitHub check/workflow event through the existing `/github` CI ingestion boundary.

Use the same provider-independent path as production.

Verify:

```text
GitHub CI event
→ durable CI evidence
→ associated Project A / PR / Work Item context
```

Do not invoke `/verification` evaluation directly yet.

The E2E scenario must prove `/github` ingests the evidence first.

# VERIFICATION

Start/complete a VerificationRun through `/verification`.

Attach authoritative CI evidence through the trusted CI path.

Map that evidence explicitly to the criteria.

Run the deterministic evaluation.

Verify:

```text
criterion
→ PASS only because authoritative evidence proves it
```

Also verify claim-only evidence cannot manufacture PASS.

The E2E test must use persisted VerificationRun/Evidence state, not client-invented outcome fields.

The verification run must remain tied to Work Item A and its ArchitectureVersion.

# ARCHITECT EXECUTION

Use the real `/llm` Architect Service boundary.

The architect context must include:

* frozen ArchitectureVersion;
* Requirements;
* Acceptance Criteria;
* VerificationRun/evidence;
* repository evidence;
* Work Item/Work Order context where required.

Use the deterministic fake LLM provider already available through `/llm`.

Verify the architect execution is persisted/retrievable as required by the existing contracts.

It must not mutate workflow state directly.

# ARCHITECT REVIEW

Create/finalize an Architect Review through `/reviews`.

The review must reference:

* Work Item A;
* ArchitectureVersion A1;
* PR;
* Verification;
* reviewer/model/execution information.

For the main happy path, produce:

```text
APPROVE
```

Verify the verdict is persisted.

# CORRECTION CYCLE

The frozen WORK-024 acceptance criteria explicitly require a correction cycle.

The E2E scenario must exercise at least one nontrivial correction loop.

Recommended sequence:

```text
ARCHITECT_REVIEW
→ CHANGES_REQUESTED
→ IMPLEMENTING
→ PR/CI update
→ VERIFYING
→ ARCHITECT_REVIEW
→ APPROVE
```

The second review must be a distinct persisted review.

The finding from the first review must remain linked through the existing correction-cycle contract.

Do not simulate the correction cycle by directly setting workflow states.

Drive it through the existing `/workflows` convergence/orchestration path.

# MERGE GATING

After APPROVE, the Work Item must remain:

```text
APPROVED
```

until authoritative GitHub state confirms the PR is actually merged.

Use the existing WORK-019 merge gate.

The E2E test must prove approval alone does not create MERGED.

Then use the existing GitHub fake/provider boundary to report the PR as merged.

Only then may the WorkflowEngine advance to:

```text
MERGED
```

Do not directly mutate `wfos_workflow_executions`.

# VERIFIED

Use the existing WORK-019 `advanceToVerified` semantics.

Verify:

```text
MERGED
→ VERIFIED
```

only when the frozen verification/completion requirements are satisfied.

The completion signal must flow through the existing `/work-items` completion boundary.

Do not use client-side state or a synthetic completion flag.

Verify the Work Item is persisted as completed through its established internal completion authority.

# NEXT ELIGIBLE WORK

Create at least one additional Work Item in Project A with a dependency on the completed item.

Also create a cross-tenant Work Item in Project B.

After Work Item A reaches VERIFIED, invoke existing next-work selection.

Prove:

```text
Work Item A completed
+
Work Item A2 dependency satisfied
→ A2 selected
```

and:

```text
Project B Work Item
→ never selected
```

The result must come from `/work-items` eligibility/dependency contracts.

Do not reimplement dependency traversal in the E2E test or frontend.

# AUDIT TRACE

The final E2E assertion is the complete audit trace.

Query Project A / Work Item A audit history.

Verify material events exist for the complete lifecycle, including applicable:

```text
project/domain creation
architecture freeze
work item / work order creation
workflow transitions
agent execution
PR/CI integration
verification
review finalization
merge
VERIFIED
```

At minimum, every canonical workflow transition in the test must have its corresponding `WORKFLOW_TRANSITION` audit event with:

* work item;
* from state;
* to state;
* execution/correlation ID;
* actor/source;
* timestamp.

Verify the audit trail is supplementary to, and consistent with, workflow history.

Do not reconstruct workflow state from audit history.

# TENANT-ISOLATION E2E PROOF

Throughout the lifecycle, explicitly attempt identifier substitution:

```text
User A
→ Project B
→ denied

User A
→ Work Item B
→ denied

User A
→ Work Item A API with Project B identifier
→ denied/rejected

User A
→ Project B audit history
→ denied
```

Do this against the real backend API.

Do not rely only on unit tests already present in individual modules.

# DEPLOYMENT E2E

Because WORK-023 established the deployable runtime, the WORK-024 E2E suite should run against the actual supported topology wherever practical:

```text
web
api
worker
postgres
redis
object storage
```

Prefer a CI mode that:

1. builds/starts the deployment topology;
2. waits for readiness;
3. runs the complete lifecycle against the deployed API;
4. waits for asynchronous workers where needed;
5. verifies PostgreSQL state;
6. tears the topology down.

Do not introduce a new deployment architecture.

The E2E suite may use the browser/frontend if that provides real value, but the authoritative lifecycle proof must not depend on the browser.

# FRONTEND E2E

WORK-022 already established the web application.

Do not rebuild the UI.

A small smoke path may be included to prove:

```text
login
→ project visible
→ work item visible
→ workflow state visible after refresh
```

but the primary WORK-024 evidence must exercise the backend/domain lifecycle.

The frontend must remain a consumer.

# ASYNCHRONOUS EXECUTION

The lifecycle must exercise real asynchronous boundaries where they are authoritative, especially:

```text
Agent execution
GitHub webhook/CI ingestion
workflow worker convergence
notification delivery only if relevant
```

Do not replace asynchronous jobs with direct synchronous calls simply to simplify the E2E test.

Use polling with deterministic timeouts rather than arbitrary sleeps.

# FAILURE / RECOVERY

WORK-024 should prove at least one realistic retry/recovery path.

For example:

```text
worker stopped after enqueue
worker restarted
→ Agent/CI/workflow processing resumes
```

or:

```text
notification failure
→ lifecycle remains authoritative
```

Prefer a recovery path involving the core workflow rather than a peripheral notification.

Do not introduce new recovery infrastructure.

# TEST DATA CLEANUP / ISOLATION

The E2E harness must isolate test data between runs.

Use existing test-database/Redis isolation conventions from WORK-003.

Do not use global `FLUSHALL`/unscoped destructive cleanup in parallel CI.

Prefer:

* dedicated PostgreSQL database/schema where supported;
* worker-specific Redis DB;
* deterministic object-store namespace;
* cleanup after test completion.

# STATIC ARCHITECTURE CHECKS

Extend architecture checks only where needed to prevent WORK-024 from introducing bypasses.

Verify:

* E2E tests consume public APIs/contracts;
* E2E tests do not import domain `internal/` implementations to mutate state;
* E2E tests do not directly mutate workflow persistence;
* no test-only shortcut bypasses AuthorizationService;
* no test-only fake changes production domain authority;
* external provider fakes sit behind existing provider-independent interfaces;
* no second workflow engine is introduced;
* no second verification engine is introduced;
* no second review system is introduced;
* no new persistence authority is introduced;
* existing WORK-001 through WORK-023 static architecture checks remain intact.

It is acceptable for the E2E harness to construct deterministic fakes at the composition boundary.

It is NOT acceptable for tests to call concrete internals to simulate completed domain actions.

# REQUIRED TEST SUITE

Create a dedicated E2E suite for WORK-024.

At minimum, assertions must cover:

## Lifecycle

```text
project creation
→ GitHub connection
→ architecture freeze
→ requirement/criteria creation
→ Work Item creation
→ Work Order
→ workflow assignment
→ Agent Run
→ PR association
→ CI ingestion
→ verification
→ architect execution
→ review REQUEST_CHANGES
→ correction cycle
→ review APPROVE
→ GitHub merged
→ MERGED
→ VERIFIED
→ next-work selection
```

## Authority

Prove:

* Agent cannot mark criteria PASS;
* client cannot set workflow state;
* client cannot manufacture review approval;
* approval cannot imply merge;
* GitHub merged state is authoritative;
* VERIFIED is only reached through `/workflows`;
* next-work selection uses `/work-items`.

## Tenant isolation

Prove cross-tenant identifier substitution fails.

## Audit

Prove every material workflow transition has traceable audit history.

## Async

Prove real WorkerHost processing occurs.

## Recovery

Prove at least one worker restart/retry converges correctly.

## Persistence

After restarting relevant processes, verify the canonical lifecycle state can be reconstructed from PostgreSQL and remains consistent.

## Regression

All existing WORK-001 through WORK-023 tests must continue to pass.

Run the complete repository validation:

```text
cd backend
bun run test
bun run typecheck
bun run lint

cd ../frontend
bun run test
bun run typecheck
bun run lint
bun run build
```

Also run the WORK-023 deployment validation and the new WORK-024 E2E suite in CI.

# CI

Extend CI with a dedicated WORK-024 end-to-end job.

The CI job should:

1. install dependencies;
2. build/start the existing WORK-023 topology;
3. wait for `/health/ready`;
4. run the E2E lifecycle;
5. collect relevant logs/artifacts on failure;
6. tear down the topology.

Do not make E2E CI depend on external customer repositories or real production credentials.

Use deterministic provider fakes where frozen provider boundaries permit them.

# OUT OF SCOPE

Do NOT implement:

* new domain features;
* architecture changes;
* new workflow states;
* new GitHub integrations;
* new LLM/Agent architecture;
* new Verification Engine;
* new Review system;
* new audit system;
* new notification system;
* new UI flows beyond minimal E2E smoke coverage;
* customer deployment/Kubernetes architecture;
* production cloud provisioning.

Do not modify:

```text
/spec/architecture.md
/spec/architecture-lock.md
/spec/requirements.md
/spec/work-items.md
/spec/dependency-graph.md
```

Do not change completed work items merely to make the E2E test easier.

If an existing contract is genuinely insufficient for the frozen lifecycle proof, determine whether the smallest additive API/test seam can satisfy it without changing authority. Otherwise report the appropriate escalation rather than silently bypassing the boundary.

# DEFINITION OF DONE

WORK-024 is complete only when:

* the complete frozen lifecycle executes in one deterministic E2E scenario;
* project creation is exercised through the authorized backend contract;
* GitHub connection/repository association is exercised through `/github`;
* ArchitectureVersion is frozen through `/architecture`;
* Requirements/Criteria persist through `/requirements`;
* Work Item/Work Order persist through `/work-items`;
* workflow state is driven only through `/workflows`;
* Agent execution occurs through `/agents`;
* PR association uses the existing GitHub/Work Item contracts;
* CI evidence is ingested through `/github`;
* verification/evidence evaluation occurs through `/verification`;
* Architect execution uses persisted verification context through `/llm`;
* Architect Reviews persist through `/reviews`;
* at least one correction cycle is demonstrated;
* approval does not imply merge;
* GitHub authoritative merge state produces MERGED;
* VERIFIED is reached only through the existing workflow authority;
* next-work selection respects dependency and tenant boundaries;
* material transitions have a complete audit trace;
* cross-tenant identifier substitution fails;
* at least one asynchronous worker recovery path is demonstrated;
* canonical state survives process restart/recovery;
* no test bypasses module/public-interface boundaries;
* no new domain authority is introduced;
* all existing WORK-001 through WORK-023 tests pass;
* typecheck passes;
* lint passes;
* frontend build/tests pass;
* deployment validation passes;
* dedicated WORK-024 E2E CI passes;
* frozen specification documents remain unchanged.

# FAILURE / ESCALATION RULES

If the complete frozen lifecycle cannot be exercised without contradicting an authoritative contract:

```text
ARCHITECTURE_BLOCKER
```

If implementation requires modifying the frozen architecture:

```text
ARCHITECTURE_CHANGE_REQUIRED
```

If a missing authorization/security contract prevents the lifecycle proof:

```text
IMPLEMENTATION_BLOCKED
```

Do not solve a missing contract by bypassing the existing authority boundary.

# FINAL CODING-AGENT RESPONSE

When complete, return exactly:

```text
WORK-024 COMPLETE
```
followed by:

```text
Implementation summary:
Tests/evidence:
Files changed:
End-to-end lifecycle evidence:
Authority/boundary evidence:
Tenant-isolation evidence:
Audit-trace evidence:
Async/recovery evidence:
Deployment/CI evidence:
Any blockers:
```

Do not claim completion without concrete automated evidence.

# FINAL HANDOFF

Return only this coding-agent prompt suitable for Z.ai.

Send it to Z.ai on:

```text
feat/WORK-024-end-to-end-lifecycle
```

targeting:

```text
main
```

Do NOT merge the resulting PR.
