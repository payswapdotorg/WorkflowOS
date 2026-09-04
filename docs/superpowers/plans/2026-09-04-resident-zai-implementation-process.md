# Resident Z.ai Implementation Process Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt the proven `pectoraux/controller` implementation-process mechanics to WorkflowOS so a resident Z.ai worker is dispatched, monitored, reviewed, resumed, and recovered through durable repository/GitHub checkpoints without copying Controller code.

**Architecture:** Preserve WorkflowOS as the sole authority for architecture, Work Orders, dependencies, and completion. Add a thin operating protocol around the existing repository governance: durable dispatch packets, resident Z.ai worker mode, exact-head review packets, same-PR change loops, watchdog/recovery, and explicit post-merge reconciliation. Z.ai remains an implementation worker only; the Architect remains the semantic gate; GitHub and repository artifacts remain durable evidence; the Z.ai session remains disposable runtime state.

**Tech Stack:** Markdown governance artifacts, existing WorkflowOS JSON development-state artifacts, GitHub PR/comments as durable execution surfaces, existing V2-017 frontend implementation workflow.

**Spec:** `spec/architecture/v2/work-orders/V2-017.md`, `spec/architecture/v2/post-w6-product-roadmap.md`, `spec/development-state/implementation-state.json`, and the existing repository-only execution contract.

## Global Constraints

Repository is the sole durable source of truth.

Do not copy Controller source code or introduce a Controller runtime into WorkflowOS.

A resident Z.ai session is disposable execution state and never an authority source.

One bounded V2-017 task per branch/PR; same PR across implementation/review iterations.

No unmerged sibling branch may become a dependency.

Actual Git merge remains the completion authority.

Architect review is semantic; approval is separate from merge.

All carried SHAs, PR identity, findings, and handoffs must be exact and re-verified from live GitHub.

Failure, contradiction, stale base, or missing evidence fails closed.

The V2 architecture is already implemented; this process change must not introduce product/runtime/domain semantics.

---

### Task 1: Add resident-worker operating protocol

**Files:**
- Create: `docs/implementation/RESIDENT-ZAI-WORKER-PROTOCOL.md`
- Modify: `AGENTS.md`
- Modify: `docs/implementation/IMPLEMENTATION-GUIDE.md`

**Interfaces:**
- Consumes the existing repository-only authority hierarchy and V2-017 task model.
- Produces the normative worker lifecycle and recovery rules used by all future V2-017 task dispatches.

- [ ] **Step 1: Write the protocol artifact**

Define the lifecycle as:

```text
DISPATCH_AUTHORIZED
→ WORKER_ACTIVE
→ CHECKPOINTED
→ WAITING_FOR_ARCHITECT
→ CHANGES_REQUESTED
→ WORKER_ACTIVE
→ ...
→ APPROVED
→ MERGING
→ MERGED
→ RECONCILING
→ COMPLETE
```

State explicitly that the Z.ai session is disposable, the GitHub PR and repository artifacts are the durable checkpoint, and a fresh session must resume from those artifacts.

- [ ] **Step 2: Add durable dispatch contract**

Specify that every dispatch carries: repository identity, Work Item/task ID, exact base SHA, Work Order path, accepted scope, forbidden scope, required checks/dogfooding, expected PR rule, and worker safety rules. Require the worker to verify all of these against `main` before changing code.

- [ ] **Step 3: Add resident monitoring rules**

Specify that after returning the PR to Architect review, the worker remains in resident waiting mode: re-read repository state, PR head, and new Architect findings; resume only on new durable evidence; checkpoint before context/quota exhaustion; never create a replacement PR.

- [ ] **Step 4: Add recovery/watchdog rules**

Define `SUSPECTED_HANG`, `WAITING_FOR_CAPACITY`, and `ESCALATE` as operational classifications only. A fresh session may replace a dead/exhausted worker, but only against the latest GitHub PR head and the same Work Item/branch/PR. Repeated identical restart/failure conditions must escalate instead of looping.

- [ ] **Step 5: Commit protocol artifact**

```bash
git add docs/implementation/RESIDENT-ZAI-WORKER-PROTOCOL.md
 git commit -m "docs: define resident Z.ai worker protocol"
```

### Task 2: Adapt fresh-agent and governance instructions

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/implementation/IMPLEMENTATION-GUIDE.md`
- Modify: `spec/development-state/README.md`
- Modify: `spec/implementation-roadmap.md`

**Interfaces:**
- Consumes Task 1 resident-worker protocol.
- Produces a single repository-resident procedure a fresh Architect/worker can follow without conversation history.

- [ ] **Step 1: Add mandatory dispatch checkpoint behavior**

Require the Architect to record a durable dispatch request before implementation begins, including the exact current `main` SHA and the single eligible task. Require the worker to acknowledge the dispatch on the same PR/issue surface with its verified base and intended branch.

- [ ] **Step 2: Add resident-mode recovery to fresh-agent instructions**

Update the bootstrap/recovery sequence so a worker first reads current `main`, canonical state, Work Order, program map, open PRs, and the latest dispatch/review packet before deciding whether to continue, resume, or escalate.

- [ ] **Step 3: Add same-PR review iteration semantics**

Require every `REQUEST_CHANGES` decision to use stable finding IDs and exact affected paths. Require the worker to resolve those findings on the same PR and return a new checkpoint with the new head SHA and validation evidence.

- [ ] **Step 4: Add explicit watchdog behavior**

Document that inactivity is not automatically failure. A watchdog must distinguish durable progress, active long-running work, suspected hang, capacity exhaustion, and contradiction.

- [ ] **Step 5: Keep architecture boundaries explicit**

State that this protocol does not create a second workflow engine, second source of truth, controller database, new product semantics, or autonomous Architect authority.

- [ ] **Step 6: Commit governance adaptation**

```bash
git add AGENTS.md docs/implementation/IMPLEMENTATION-GUIDE.md spec/development-state/README.md spec/implementation-roadmap.md
git commit -m "docs: adapt repository governance for resident workers"
```

### Task 3: Establish the non-authoritative operator dashboard

**Files:**
- Create: `ROADMAP_STATUS.md`
- Modify: `spec/development-state/implementation-state.json` only if required to add stable protocol metadata; do not add Z.ai session IDs as authoritative state.

**Interfaces:**
- Consumes live Git/PR evidence and canonical development state.
- Produces a human-visible operational snapshot that never overrides repository authority.

- [ ] **Step 1: Create dashboard contract**

Mark the dashboard explicitly `NON-AUTHORITATIVE` and require the fields: current operational state, active task, PR, exact base/head, last completed worker action, last Architect action, pending action, known blockers, and timestamp.

- [ ] **Step 2: Record resident session policy**

Record the current resident-worker mode without treating the Z.ai session identifier as durable authority. The durable identity is Work Item + branch + PR + latest head SHA.

- [ ] **Step 3: Add maintenance rules**

Require dashboard updates at worker entry, checkpoint, `CHANGES_REQUESTED`, `WAITING_FOR_ARCHITECT`, recovery/restart, merge handoff, and reconciliation. The dashboard must never claim an action that has not occurred.

- [ ] **Step 4: Commit dashboard**

```bash
git add ROADMAP_STATUS.md
git commit -m "docs: add non-authoritative implementation dashboard"
```

### Task 4: Activate T2 under the resident-worker process

**Files:**
- Modify: `spec/development-state/implementation-state.json`
- Modify: `spec/implementation-roadmap.md`
- PR surface: existing PR #178 only; no replacement PR

**Interfaces:**
- Consumes the resident dispatch protocol and current T2 state.
- Produces the durable dispatch checkpoint for the current T2 implementation run.

- [ ] **Step 1: Re-read live main and PR #178**

Verify the current `main` SHA, current PR #178 base/head, branch identity, and whether the branch is still valid against the current roadmap state. Do not trust previous conversation values.

- [ ] **Step 2: Reconcile T2 base if stale**

If PR #178 no longer targets the exact current eligible base, classify it `STALE_BASE` and create no implementation dependency from it. Preserve historical evidence and use a fresh task branch from current `main` only through the governed process.

- [ ] **Step 3: Post the durable Z.ai dispatch packet**

Post a GitHub PR/issue comment that names T2, the exact base SHA, the governing Work Order, owned and forbidden surfaces, required verification, and the instruction to remain in resident worker mode on the same PR.

- [ ] **Step 4: Record dashboard state**

Set the non-authoritative dashboard to `WORKER_ACTIVE` only after the dispatch has actually been posted and the worker handoff is recorded. Otherwise keep the truthful current state.

- [ ] **Step 5: Verify before implementation continues**

Re-read current repository state and the PR after posting the dispatch. The implementation worker must not act on a stale base or a superseded task state.

- [ ] **Step 6: Commit governance checkpoint**

```bash
git add spec/development-state/implementation-state.json spec/implementation-roadmap.md ROADMAP_STATUS.md
git commit -m "chore: activate T2 resident-worker checkpoint"
```

## Completion Evidence

The adaptation is complete when the repository contains the protocol, fresh-agent instructions, non-authoritative dashboard, and a durable T2 dispatch packet that can restart the implementation loop from GitHub without conversation history. The T2 code implementation itself remains governed by the existing V2-017 Work Order and is not complete merely because the dispatch process has been installed.
