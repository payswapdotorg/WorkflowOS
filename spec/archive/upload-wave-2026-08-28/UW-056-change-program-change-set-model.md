> **RETIRED UPLOAD-WAVE PROPOSAL — NON-AUTHORITATIVE HISTORICAL MATERIAL.**
>
> Originally uploaded claiming the WORK-056 identity as `spec/work-orders/WORK-056 — Change Program - Change Set Model.md`, direct-pushed to main
> on 2026-08-28 (commits 7db2ad3..0541d13) under an unapproved “architecture 2.0” label.
> Retired and re-identified by the architect's 2026-08-29 PR #74 review verdict: the architect-issued
> GitHub issue track (ACR-001, WORK-053..061, v1.1) is the one canonical track, and the re-used
> identifiers are retired here under the distinct identity **UW-056**.
>
> The canonical meaning of `WORK-056` is “Engineering Signals and Feedback Intake” (GitHub issue #68,
> `spec/work-orders/WORK-056.md`, `spec/development-state/dependency-state.json` futureGeneration).
> Nothing in this file governs: it is preserved as historical/proposed material only.
> See `spec/archive/upload-wave-2026-08-28/index.json` and
> `spec/architecture/v1.1/reconciliation-record.md` §8.

# UW-056 — Change Program - Change Set Model (retired upload-wave proposal)


Status:
BLOCKED

Dependencies:

- WORK-053 Architecture Checkpoint Framework
- WORK-055 Evidence / Proof Registry


Architecture Version:

2.0


# Objective

Introduce a higher-level orchestration model for complex software changes while preserving Work Items as the atomic implementation unit.


# Motivation

Simple systems can operate:

```
Requirement
    ↓
Work Item
    ↓
Implementation
```

Complex systems require:

```
Business Objective
        ↓
Change Program
        ↓
Multiple Work Items
        ↓
Coordinated Execution
        ↓
Unified Verification
```


# Core Principle

Change Programs coordinate.

They do not replace Work Items.

Work Items remain the smallest execution/review unit.


# New Domain Model


ChangeProgram:

```
id

name

objective

architecture_version

assurance_profile

status

created_at
```


ChangeSet:

```
id

program_id

work_items

dependency_graph

completion_state
```


# Lifecycle


```
PROPOSED

ANALYZING

APPROVED

EXECUTING

VERIFYING

COMPLETED

FAILED

CANCELLED
```


# Required Capabilities

The system must support:

- grouping related Work Items
- dependency ordering
- parallel eligibility calculation
- aggregate verification
- aggregate progress


# Forbidden

Must NOT:

- create another workflow engine
- replace Work Items
- bypass checkpoints
- bypass verification


# Required Invariants


1.

Every Change Program contains at least one Work Item.


2.

Every Work Item belongs to at most one active Change Program.


3.

Execution authority remains owned by execution subsystem.


4.

Verification authority remains independent.


# Verification


Behavioral:

A multi-work-item program can execute in dependency order.


Structural:

No duplicated lifecycle authority exists.


Mutation:

Removing dependency constraints causes tests to fail.


Concurrency:

Parallel Work Items cannot violate declared dependencies.


# Definition Of Done

- models implemented
- dependency graph integrated
- tests added
- architecture evidence attached
- PR approved