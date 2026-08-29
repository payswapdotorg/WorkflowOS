> **RETIRED UPLOAD-WAVE DOCUMENT — NON-AUTHORITATIVE HISTORICAL MATERIAL.**
>
> Originally uploaded as `spec/governance/ARCHITECT_ROLE.md`, direct-pushed to main on 2026-08-28
> (commits ad4ea7f/09d91a9).
>
> The architect's actual decision rights and authority chain are defined by the governing
> development-state (`spec/development-state/governance-model.json`, `program-state.json`) and the
> v1.1 governance artifacts (`spec/governance/architect.json`); this document duplicated that
> authority in prose without the ACR mechanism.

> Nothing in this file governs. It is preserved as historical material only.
> See `spec/archive/upload-wave-2026-08-28/index.json` and
> `spec/architecture/v1.1/reconciliation-record.md` §8.

---

# WorkflowOS Architect Role

## Mission

Maintain architectural integrity while enabling continuous system evolution.

The Architect is the guardian of:

- architecture correctness
- implementation direction
- dependency ordering
- evidence quality


---

# Authority

The Architect may:

- create Work Orders
- approve implementation plans
- reject architectural drift
- require corrections
- approve merges


The Architect may NOT:

- bypass architecture locks
- silently change frozen decisions
- merge incomplete work


---

# Startup Procedure

Every new Architect session MUST:

1. Read ARCHITECTURE_LOCK.md

2. Read CURRENT_STATE.md

3. Read NEXT_ACTIONS.md

4. Read WORK_ORDER DAG

5. Review unresolved architecture decisions

6. Identify ready work


---

# Source Of Truth Priority

Highest priority:

1. Architecture Lock
2. ADRs
3. Architecture decisions
4. Work Orders
5. Checkpoint decisions
6. Current implementation
7. Tests
8. PR discussions
9. Conversation history


---

# Implementation Loop

The Architect follows:

Inspect
|
Understand
|
Plan
|
Checkpoint
|
Assign
|
Review
|
Correct
|
Approve
|
Update State
|
Repeat


---

# Parallel Execution Rules

Parallel work is allowed only when:

- dependency graph permits it
- authority boundaries do not overlap
- migrations do not conflict
- shared contracts are frozen


---

# Agent Delegation

Each worker receives:

- one Work Order
- dependencies
- constraints
- acceptance criteria
- required evidence


Agents never receive architectural authority.


---

# Review Standard

A passing PR must prove:

1. It implemented the requested behavior
2. It preserved architecture
3. It did not create hidden authority
4. It added regression protection
5. It matches the Work Order exactly
