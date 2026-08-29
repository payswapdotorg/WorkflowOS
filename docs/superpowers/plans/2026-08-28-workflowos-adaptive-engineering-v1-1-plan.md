# WorkflowOS Adaptive Engineering Architecture v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the repository-resident architecture and governance artifacts required to evolve WorkflowOS into a complexity-adaptive, closed-loop engineering control system while preserving the frozen v1.0 authority model.

**Architecture:** Keep v1.0 immutable. Introduce v1.1 as an additive architecture evolution package covering the engineering control loop, derived system model, quality attributes/fitness, engineering signals, large-change orchestration, adaptive assurance, operational governance, architecture evolution, and self-hosting. GitHub and `spec/` remain the persistent control plane; new artifacts are normative, authoritative, derived, or evidentiary and may not create shadow authorities.

**Tech Stack:** Markdown architecture/ADR/spec artifacts, JSON governance state, GitHub Issues/PRs, CODEOWNERS, GitHub Actions, existing WorkflowOS TypeScript/PostgreSQL architecture.

**Spec:** `docs/superpowers/specs/2026-08-28-workflowos-adaptive-engineering-architecture-v1-1-design.md`

## Global Constraints

- Frozen v1.0 architecture is never rewritten in place.
- `/architecture` remains the sole architecture authority.
- `/work-items` remains the sole Work Item and Work Order authority.
- `/workflows` remains the sole workflow lifecycle authority.
- `/verification` remains the sole verification/evidence authority.
- `/reviews` remains the semantic review authority.
- `/github` remains the external repository/PR/CI authority.
- New artifacts are normative architecture, authoritative state, derived state, or evidence; no fifth authority class is introduced.
- Assurance depth changes evidence/checkpoints, never authority semantics.
- Parallel agents use isolated branches/PRs; merge remains architect-controlled.
- Unknown, malformed, or unavailable governance information fails closed.

---

### Task 1: Define the v1.1 architecture package

**Files:**
- Create: `spec/architecture/v1.1/README.md`
- Create: `spec/architecture/v1.1/architecture.md`
- Create: `spec/architecture/v1.1/architecture-lock.md`
- Create: `spec/architecture/v1.1/artifact-taxonomy.json`

**Interfaces:**
- Consumes: existing `spec/architecture.md`, `spec/architecture-lock.md`, WORK-052 governance model.
- Produces: immutable-ready v1.1 architecture package defining the control loop, authority map, complexity model, system model, quality attributes, feedback, self-hosting, and evolution rules.

- [ ] **Step 1: Write v1.1 package files from the approved design**
- [ ] **Step 2: Add explicit preservation matrix for v1.0 authorities**
- [ ] **Step 3: Add artifact taxonomy distinguishing normative, authoritative, derived, and evidentiary artifacts**
- [ ] **Step 4: Validate all referenced authorities against the current repository model**
- [ ] **Step 5: Commit the architecture package**

---

### Task 2: Establish the architecture-change record

**Files:**
- Create: `spec/architecture-change-requests/ACR-001-v1-1-adaptive-engineering-control-system.md`
- Create: `spec/architecture-change-requests/README.md`

**Interfaces:**
- Consumes: v1.0 architecture and v1.1 design package.
- Produces: durable proposal/approval record linking the new ArchitectureVersion to the evidence and preserving v1.0 history.

- [ ] **Step 1: Record motivation, scope, alternatives, invariants preserved, migration strategy, rollback strategy, and approval requirement**
- [ ] **Step 2: Explicitly prohibit silent self-hosted modification of the governing architecture**
- [ ] **Step 3: Link ACR to the v1.1 package and future Work Orders**
- [ ] **Step 4: Commit the ACR**

---

### Task 3: Extend Work Items and dependency graph for the v1.1 generation

**Files:**
- Modify: `spec/work-items.md`
- Modify: `spec/dependency-graph.md`
- Create: `spec/work-orders/WORK-053.md` through `spec/work-orders/WORK-061.md`

**Interfaces:**
- Consumes: current WORK-046..052 state and approved v1.1 design.
- Produces: explicit Work Orders for architecture foundation, system model, fitness, signals, change programs, assurance, operational governance, architecture evolution, and self-hosting conformance.

- [ ] **Step 1: Add WORK-053..061 with explicit objectives, dependencies, surfaces, prohibitions, proof requirements, and definitions of done**
- [ ] **Step 2: Encode the dependency DAG so no Work Order claims eligibility before prerequisites complete**
- [ ] **Step 3: Mark future Work Orders planned rather than complete/in-flight**
- [ ] **Step 4: Add parallelization notes only where declared surfaces permit concurrency**
- [ ] **Step 5: Validate DAG acyclicity and consistency with existing WORK-046..052 records**
- [ ] **Step 6: Commit the roadmap changes**

---

### Task 4: Establish persistent architect and worker governance artifacts

**Files:**
- Create: `spec/governance/README.md`
- Create: `spec/governance/architect.json`
- Create: `spec/governance/worker-protocol.json`
- Create: `spec/governance/assurance-profiles.json`
- Create: `spec/governance/checkpoint-contract.json`
- Create: `spec/development-state/dependency-state.json`
- Create: `spec/development-state/frontier-state.json`
- Create: `spec/development-state/checkpoint-state.json`

**Interfaces:**
- Consumes: current WORK-052 development-state model and v1.1 architecture.
- Produces: persistent descriptions of architect authority, stateless worker handoff, assurance profiles, checkpoint expectations, and derived frontier state.

- [ ] **Step 1: Define architect authority without coupling it to an AI vendor**
- [ ] **Step 2: Define worker handoff fields and prohibited actions**
- [ ] **Step 3: Define LIGHT/STANDARD/HIGH_ASSURANCE/CRITICAL deterministically**
- [ ] **Step 4: Define readiness, work-order, PR-conformance, verification-entry, fitness, and release checkpoint categories**
- [ ] **Step 5: Define derived-state freshness and fail-closed behavior**
- [ ] **Step 6: Commit governance artifacts**

---

### Task 5: Add GitHub-level persistent governance

**Files:**
- Create: `.github/CODEOWNERS`
- Create: `.github/pull_request_template.md`
- Create: `.github/ISSUE_TEMPLATE/work-order.yml`
- Create: `.github/ISSUE_TEMPLATE/architecture-change.yml`
- Create: `.github/ISSUE_TEMPLATE/governance-finding.yml`
- Create: `.github/workflows/governance.yml`

**Interfaces:**
- Consumes: persistent architect/governance artifacts and current repository conventions.
- Produces: repository-level enforcement surfaces that require Work Order identity, preserve architecture-owned files, and execute governance checks in CI.

- [ ] **Step 1: Protect architecture/governance paths for `@pectoraux`**
- [ ] **Step 2: Require PRs to identify Work Order, base revision, architecture version, surfaces, assurance profile, checkpoints, and evidence**
- [ ] **Step 3: Require architecture-change issues to include impact, alternatives, migration, rollback, and approval**
- [ ] **Step 4: Add governance workflow that validates machine-readable state, DAG structure, and mandatory governance markers**
- [ ] **Step 5: Add full-history checkout where governance requires merge-history reconstruction**
- [ ] **Step 6: Commit GitHub governance surfaces**

---

### Task 6: Update persistent governance documentation

**Files:**
- Modify: `spec/development-state/README.md`
- Modify: `docs/adr/README.md`
- Modify: top-level architecture/governance documentation only where links are needed

**Interfaces:**
- Consumes: all v1.1 artifacts.
- Produces: a fresh-agent entry path explaining which files are normative, which are authoritative, and how to resume safely.

- [ ] **Step 1: Document canonical artifact precedence**
- [ ] **Step 2: Document how a fresh architect reconstructs the current frontier**
- [ ] **Step 3: Document how a worker reconstructs its Work Order context**
- [ ] **Step 4: Document merge/finalization truth and architecture-change rules**
- [ ] **Step 5: Commit documentation updates**

---

### Task 7: Validate the artifact package before implementation begins

**Files:**
- Test: existing architecture/governance validation suites plus new governance artifact validation test if the repository has an established location.

- [ ] **Step 1: Run JSON/schema parsing checks on all new machine-readable artifacts**
- [ ] **Step 2: Run dependency-DAG validation and confirm no cycles**
- [ ] **Step 3: Run static architecture checks to confirm no authority duplication is introduced**
- [ ] **Step 4: Run existing governance-state reconstruction checks**
- [ ] **Step 5: Verify a fresh-agent handoff can identify architecture version, current Work Order, frontier, assurance, and checkpoints from repository files alone**
- [ ] **Step 6: Review the resulting branch diff for scope creep and stale state**
- [ ] **Step 7: Commit final corrections**

---

## Execution Handoff

This plan creates and validates the durable architecture/governance artifact layer. It does not implement WORK-053..061 product/runtime behavior. After the artifact PR is architect-approved and merged, implementation proceeds Work Order by Work Order, using the persistent dependency frontier to launch independent Z.ai workers concurrently.
