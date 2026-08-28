# WORK-056 — Change Program / Change Set Model

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