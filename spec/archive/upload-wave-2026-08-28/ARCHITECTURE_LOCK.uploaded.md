> **RETIRED UPLOAD-WAVE DOCUMENT — NON-AUTHORITATIVE HISTORICAL MATERIAL.**
>
> Originally uploaded as `spec/governance/ARCHITECTURE_LOCK.md`, direct-pushed to main on 2026-08-28
> (commit 3a66034). Its header claims “Version: 2.0, Status: FROZEN”.
>
> **That claim was never established through the Architecture Change Request mechanism.** No ACR has
> been approved for any architecture version change. The governing architecture remains **v1.0
> (frozen)** per `spec/development-state/program-state.json`; v1.1 exists only as a PROPOSED
> evolution package (PR #74, ACR-001, `spec/architecture/v1.1/`).
>
> Retired and moved to the archive by the architect's 2026-08-29 PR #74 review verdict so that no
> document in a governing-looking location (`spec/governance/`) asserts a competing version authority.

> Nothing in this file governs. It is preserved as historical material only.
> See `spec/archive/upload-wave-2026-08-28/index.json` and
> `spec/architecture/v1.1/reconciliation-record.md` §8.

---

# WorkflowOS Architecture Lock

Version:
2.0

Status:
FROZEN

Authority:
Architecture Authority

---

# Purpose

This document defines the immutable architectural constraints of WorkflowOS.

Any implementation, agent, Work Order, or architectural evolution MUST preserve these constraints.

Violations are architecture failures regardless of whether tests pass.

---

# Core Principle

WorkflowOS is a governed engineering control system.

Agents execute changes.

They do not define the system.

The repository is the persistent source of architectural truth.

---

# Authority Model

Exactly one authority exists for each concern.

## Architecture Authority

Owns:

- architecture versions
- ADRs
- architectural invariants
- architecture evolution

Location:

/architecture


---

## Workflow Authority

Owns:

- lifecycle transitions
- state machines
- allowed transitions

Location:

/workflows


---

## Work Authority

Owns:

- Work Items
- Work Orders
- dependencies
- implementation scope

Location:

/work-orders


---

## Execution Authority

Owns:

- agent execution
- provider interaction
- execution state

Location:

/execution


---

## Verification Authority

Owns:

- evidence
- verification results
- acceptance validation

Location:

/verification


---

## Review Authority

Owns:

- approval decisions
- merge authorization
- rejection decisions

Location:

/reviews


---

# Immutable Rules

## Rule 1 — No Hidden Authority

No module may create a competing source of truth.

Examples:

Forbidden:

- duplicate workflow state
- duplicate execution state
- local policy engines
- hidden configuration authority


---

## Rule 2 — Repository Truth

All durable architectural decisions MUST exist in Git.

Conversation context is never authoritative.

---

## Rule 3 — Architecture Evolution

Frozen architecture cannot be edited.

Changes require:

Architecture Change Request

containing:

- motivation
- impact analysis
- affected invariants
- migration strategy
- approval evidence

New architecture version MUST be created.

---

## Rule 4 — Agents Are Replaceable

Implementation agents are temporary workers.

They receive authority only through:

Work Order

They cannot:

- redefine architecture
- modify constraints
- bypass checkpoints

---

## Rule 5 — Evidence Before Acceptance

No implementation is complete without:

- behavioral evidence
- structural evidence
- regression evidence
- architecture evidence

---

# Lifecycle Model

The canonical lifecycle:
SENSE
↓
UNDERSTAND
↓
PLAN
↓
CHECK
↓
EXECUTE
↓
VERIFY
↓
REVIEW
↓
RELEASE
↓
OBSERVE
↓  
LEARN
└──────────→ SENSE


---

# Complexity Model

WorkflowOS must support:

LIGHT:

Simple changes

STANDARD:

Normal feature work

HIGH_ASSURANCE:

Architectural changes

CRITICAL:

Safety/security/business critical systems

Same authority model.

Different evidence depth.

---

# Final Constraint

WorkflowOS must be capable of building WorkflowOS.

The system must not depend on any single architect conversation.
