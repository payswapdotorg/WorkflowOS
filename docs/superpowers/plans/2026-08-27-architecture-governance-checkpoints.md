# Architecture Governance and Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add executable architecture assertions and revision-bound conformance checkpoints around the existing WorkflowOS lifecycle without creating a second workflow engine, architecture authority, or verification authority.

**Architecture:** `/architecture` owns immutable architecture versions and assertion definitions; the checkpoint capability evaluates those assertions but owns no lifecycle state or evidence authority. `/verification` persists finalized checkpoint evidence, while `/workflows` remains the only lifecycle transition authority.

**Tech Stack:** TypeScript, existing WorkflowOS modular monolith, PostgreSQL, existing module barrels, existing workflow/verification persistence and worker infrastructure.

**Spec:** `docs/superpowers/specs/2026-08-27-architecture-governance-checkpoints-design.md`

## Global Constraints

- Frozen v1.0 architecture remains immutable; intentional incompatibility requires the existing Architecture Change Request path and a new immutable ArchitectureVersion.
- `/architecture` remains the sole architecture authority.
- `/verification` remains the sole durable verification/conformance evidence authority.
- `/workflows` remains the sole workflow lifecycle/state-transition authority.
- No new workflow states.
- No second workflow engine, verification engine, review engine, or generic enterprise static-analysis platform.
- Initial increment supports readiness, pre-implementation, PR, and verification-entry checkpoints; no scheduler, cron, or `setInterval` is required.
- Blocking assertions fail closed on inconclusive evaluation unless explicitly advisory.
- Tenant/project ownership is server-side and must be validated before checkpoint execution.

---

### Task 1: Architecture assertion contract

**Files:**
- Modify: existing `/architecture` public types and repository contracts.
- Test: existing architecture integration test location plus new governance regression tests.

**Interfaces:**
- Consumes: immutable `ArchitectureVersion` authority.
- Produces: immutable assertion metadata with `assertionId`, `architectureVersionId`, `severity`, `scope`, `statement`, `detectorKind`, `detectorConfig`, `createdAt`.

- [ ] **Step 1: Write the failing tests**

Add regression coverage proving an assertion belongs to exactly one architecture version, cannot be mutated after version freeze, and cannot be deleted or reassigned after use by a finalized checkpoint.

- [ ] **Step 2: Run the focused test file and confirm failure**

Run the existing architecture integration suite plus the new focused governance tests. Expected result: failures for the missing assertion contract.

- [ ] **Step 3: Add the assertion contract through `/architecture`**

Reuse the existing architecture repository and immutable-version conventions. Do not create a parallel architecture store. Assertions must be version-scoped and readable through the `/architecture` public barrel.

- [ ] **Step 4: Run focused tests**

Expected: all assertion lifecycle tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/architecture backend/tests
git commit -m "feat: add versioned architecture assertion contract"
```

### Task 2: Checkpoint evaluation contract and detector seam

**Files:**
- Create: `backend/src/architecture-governance/architecture-governance.types.ts`
- Create: `backend/src/architecture-governance/internal/architecture-checkpoint-service.ts`
- Create: `backend/src/architecture-governance/internal/detectors/` focused deterministic detectors.
- Create: `backend/src/architecture-governance/index.ts`
- Test: `backend/tests/integration/architecture-governance/architecture-checkpoint.regression.test.ts`

**Interfaces:**
- Consumes: `/architecture` assertions, authoritative Work Item/ArchitectureVersion context, exact implementation revision.
- Produces: checkpoint result with `passed | passed_with_advisories | blocked | inconclusive`; detector result with `pass | fail | inconclusive | not_applicable`.

- [ ] **Step 1: Write failing tests for the checkpoint contract**

Test at minimum:

```ts
expect(result.status).toBe('blocked')
expect(result.results[0].status).toBe('fail')
expect(result.architectureVersionId).toBe(version.id)
expect(result.implementationRevision).toBe(commitSha)
```

Also test advisory and inconclusive behavior.

- [ ] **Step 2: Run the focused tests and confirm failure**

Expected: missing checkpoint service/detector failures.

- [ ] **Step 3: Implement the narrow detector contract**

Define a single detector interface with deterministic output. Detectors must read through existing public module contracts; they may not write architecture, workflow, or verification persistence.

- [ ] **Step 4: Implement the checkpoint orchestrator**

The service evaluates the assertion set against an exact revision, computes the four checkpoint statuses, and never mutates workflow state. Keep the service application-layer only.

- [ ] **Step 5: Run focused tests**

Expected: checkpoint contract tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/architecture-governance backend/tests/integration/architecture-governance
git commit -m "feat: add architecture checkpoint evaluation boundary"
```

### Task 3: Persist checkpoint evidence through `/verification`

**Files:**
- Modify: existing `/verification` types/repository contracts.
- Modify: architecture-governance orchestrator.
- Test: `backend/tests/integration/architecture-governance/checkpoint-evidence.regression.test.ts`

**Interfaces:**
- Consumes: checkpoint evaluation output.
- Produces: immutable revision-bound verification evidence linked to Work Item, ArchitectureVersion, assertion set, implementation revision, and detector results.

- [ ] **Step 1: Write failing evidence tests**

Prove:

```ts
expect(first.architectureVersionId).toBe(version.id)
expect(first.workItemId).toBe(workItem.id)
expect(first.implementationRevision).toBe(sha1)
expect(second.implementationRevision).toBe(sha2)
expect(first.id).not.toBe(second.id)
```

Also prove the first finalized checkpoint cannot be overwritten by the second.

- [ ] **Step 2: Run focused tests and confirm failure**

Expected: evidence persistence is missing.

- [ ] **Step 3: Extend `/verification` additively**

Use the existing evidence repository and verification semantics. Do not add a parallel `architecture_evidence` table or repository. Add only the minimal evidence shape needed to identify checkpoint kind and assertion results.

- [ ] **Step 4: Run focused evidence tests**

Expected: immutable revision-bound checkpoint evidence passes.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/verification backend/src/architecture-governance backend/tests/integration/architecture-governance
git commit -m "feat: persist architecture checkpoints through verification"
```

### Task 4: Lifecycle gate integration through `/workflows`

**Files:**
- Modify: existing `/workflows` transition orchestration contracts.
- Modify: architecture-governance application service/wiring.
- Test: `backend/tests/integration/architecture-governance/workflow-gates.regression.test.ts`

**Interfaces:**
- Consumes: finalized checkpoint result.
- Produces: an authorization/conformance result consumed by the existing workflow transition logic.

- [ ] **Step 1: Write failing gate tests**

Prove that:

- blocking checkpoint prevents the relevant transition;
- advisory checkpoint permits the transition;
- inconclusive blocking checkpoint prevents the transition;
- checkpoint code itself does not issue workflow SQL writes.

- [ ] **Step 2: Run focused tests and confirm failure**

Expected: lifecycle gates are not connected.

- [ ] **Step 3: Add a workflow-facing conformance gate**

The checkpoint capability returns a gate result. `/workflows` consumes that result and performs the legal transition. Do not let the checkpoint service call workflow transition methods as an authority bypass.

- [ ] **Step 4: Verify no new workflow states exist**

Static architecture test must reject new lifecycle states introduced by this work.

- [ ] **Step 5: Run focused workflow-gate tests**

Expected: legal transitions are blocked/permitted correctly.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/workflows backend/src/architecture-governance backend/tests/integration/architecture-governance
git commit -m "feat: gate lifecycle transitions on architecture conformance"
```

### Task 5: Architecture readiness and pre-implementation checkpoints

**Files:**
- Modify: existing work-item/assignment orchestration entry points.
- Modify: architecture-governance service.
- Test: `backend/tests/integration/architecture-governance/readiness.regression.test.ts`

**Interfaces:**
- Consumes: Work Item → immutable ArchitectureVersion mapping and Work Order.
- Produces: readiness/pre-implementation checkpoint result consumed by existing workflow orchestration.

- [ ] **Step 1: Write failing readiness tests**

Test missing architecture version, unresolved required assertions, and an invalid Work Order scope.

- [ ] **Step 2: Run focused tests and confirm failure**

Expected: implementation assignment is currently allowed without conformance evaluation.

- [ ] **Step 3: Implement readiness + pre-implementation evaluation**

Keep the first implementation deterministic and narrow. No source code mutation, no workflow writes from the checkpoint capability.

- [ ] **Step 4: Run focused tests**

Expected: readiness and pre-implementation gates pass the frozen contract.

- [ ] **Step 5: Commit**

```bash
git add backend/src/architecture-governance backend/src/modules/work-items backend/tests/integration/architecture-governance
git commit -m "feat: add readiness and pre-implementation architecture gates"
```

### Task 6: PR and verification-entry checkpoints

**Files:**
- Modify: existing PR/verification orchestration entry points.
- Modify: architecture-governance service.
- Test: `backend/tests/integration/architecture-governance/pr-and-verification-gates.regression.test.ts`

**Interfaces:**
- Consumes: exact candidate revision and immutable architecture version.
- Produces: blocking/advisory/inconclusive gate result consumed by existing `/workflows` orchestration.

- [ ] **Step 1: Write failing PR/verification-entry tests**

Prove a known structural violation blocks before PR creation, and that verification re-checks the exact revision it will verify.

- [ ] **Step 2: Run focused tests and confirm failure**

Expected: PR/verification paths currently do not consume the checkpoint boundary.

- [ ] **Step 3: Integrate the checkpoint gate**

Use existing GitHub/verification inputs. Do not duplicate PR authority or verification authority. Exact commit/revision is mandatory.

- [ ] **Step 4: Run focused tests**

Expected: PR and verification-entry gates pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/architecture-governance backend/src/modules backend/tests/integration/architecture-governance
git commit -m "feat: add PR and verification-entry architecture gates"
```

### Task 7: Tenant isolation and self-hosting protections

**Files:**
- Modify: checkpoint route/context resolver.
- Modify: architecture-governance service.
- Test: `backend/tests/integration/architecture-governance/tenant-and-self-hosting.regression.test.ts`

**Interfaces:**
- Consumes: server-resolved project/organization scope.
- Produces: authorization-safe checkpoint execution.

- [ ] **Step 1: Write failing two-project tests**

Project A user attempting to checkpoint Project B must be rejected before detector execution. WorkflowOS must be able to checkpoint its own repository without granting checkpoint code authority to modify the architecture that governs it.

- [ ] **Step 2: Run focused tests and confirm failure**

Expected: unauthorized checkpoint execution is currently insufficiently constrained.

- [ ] **Step 3: Implement server-side ownership resolution**

Never trust caller-supplied organization/project ownership when resolving a checkpoint target. Validate through the authoritative project membership chain.

- [ ] **Step 4: Implement self-hosting guard**

Checkpoint execution may evaluate the current repository, but architecture mutation still requires the existing Architecture Change Request path and explicit architect decision.

- [ ] **Step 5: Run focused tests**

Expected: cross-tenant access blocked and self-hosting remains constrained.

- [ ] **Step 6: Commit**

```bash
git add backend/src/architecture-governance backend/tests/integration/architecture-governance
 git commit -m "feat: enforce architecture checkpoint tenant and self-hosting boundaries"
```

### Task 8: Static architecture invariants

**Files:**
- Modify: `backend/tests/architecture/static-architecture.test.ts`
- Test: architecture suite.

- [ ] **Step 1: Write failing static invariants**

Add checks preventing:

- direct workflow SQL from checkpoint code;
- direct verification persistence from checkpoint code;
- direct architecture-version mutation from checkpoint code;
- detector imports bypassing public barrels;
- new lifecycle states;
- scheduler-driven checkpoint execution;
- caller-controlled tenant scope;
- second architecture/verification/workflow authorities.

- [ ] **Step 2: Run architecture tests and confirm failures**

Expected: new invariants fail until implementation boundaries are correct.

- [ ] **Step 3: Implement invariants**

Use source-structure assertions plus mutation-proof checks where feasible. Avoid weak single-occurrence assertions that can be bypassed by adding a second unguarded call site.

- [ ] **Step 4: Run architecture tests**

Expected: all invariants pass and the architecture test count increases only by the intended governance invariants.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/architecture/static-architecture.test.ts
git commit -m "test: freeze architecture governance boundaries"
```

### Task 9: Full verification and PR

**Files:**
- Modify: worklog as local-only operational artifact.
- Test: all relevant unit/integration suites and full backend suite.

- [ ] **Step 1: Run typecheck and lint**

Expected: zero type errors and no new lint errors beyond documented baseline.

- [ ] **Step 2: Run architecture checks**

Expected: all architecture invariants pass.

- [ ] **Step 3: Run targeted governance suites**

Expected: all mandatory checkpoint, evidence, gate, tenant, and self-hosting regressions pass.

- [ ] **Step 4: Run the full backend suite**

Expected: zero regressions.

- [ ] **Step 5: Run real PostgreSQL concurrency/immutability tests where applicable**

Expected: database-level constraints and finalization semantics behave identically under real PostgreSQL.

- [ ] **Step 6: Review the complete diff for authority drift**

Confirm no new workflow engine, verification engine, architecture authority, scheduler, or implicit architecture mutation path exists.

- [ ] **Step 7: Open the PR**

The PR description must contain a requirement→implementation→test mapping and explicitly state which frozen boundaries were preserved.

- [ ] **Step 8: Do not merge**

The architect/reviewer will inspect the actual diff and either request changes or approve.

---

## Self-review checklist

- [ ] Every design requirement in `docs/superpowers/specs/2026-08-27-architecture-governance-checkpoints-design.md` has a corresponding task.
- [ ] No task introduces a second workflow, verification, review, or architecture authority.
- [ ] Checkpoint evidence always flows through `/verification`.
- [ ] Workflow state changes always flow through `/workflows`.
- [ ] Frozen architecture versions remain immutable.
- [ ] Tenant scope is authoritative and server-resolved.
- [ ] No scheduler is introduced in the initial increment.
- [ ] Self-hosting does not grant autonomous architecture mutation authority.
