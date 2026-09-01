# WorkflowOS V1 → V2 Transition Policy

**Status:** APPROVED TRANSITION POLICY  
**V1:** frozen architecture remains authoritative for all existing V1 behavior.  
**V2:** proposed architecture generation; V2 development is now the forward product roadmap.

## Transition decision

Remaining V1 roadmap items are **deferred by default**. They are not deleted, invalidated, or rewritten. They are activated only when the V2 roadmap identifies a concrete dependency that cannot be satisfied by an existing frozen V1 capability or an explicitly scoped V2 compatibility item.

V2 work must not silently mutate, replace, or reinterpret frozen V1 authorities.

## Execution priority

The canonical forward execution queue is the V2 machine-readable roadmap:

`spec/development-state/v2-work-order-state.json`

The current next wave is:

- V2-002 — Workflow Repository + Immutable Versioning
- V2-003 — Workflow IR
- V2-004 — Node + Capability Protocol

These are independent W1 items and must start from the same stable `main` base. A sibling V2 branch must never be used as another sibling's base.

## When V1 may resume

A deferred V1 Work Order may be activated only if a V2 Work Order records one of these reasons:

1. an existing V1 capability is missing and cannot be consumed through a stable public boundary;
2. a V2 compatibility bridge is required to preserve V1 behavior;
3. a production/security defect in V1 blocks safe V2 operation;
4. the sole architect explicitly reactivates the V1 item.

When this occurs, the V1 item remains a V1 item; it is not silently absorbed into a V2 scope.

## Fresh-agent rule

A fresh implementation agent should read this policy, the V2 README, the V2 control plane, and `v2-work-order-state.json`. The agent must treat V2 as the forward queue and the remaining V1 roadmap as deferred unless the canonical state explicitly says otherwise.

## Quality rule

The transition is a scheduling decision, not a quality shortcut. Every V2 feature retains deterministic verification, real integration verification where appropriate, feature-boundary dogfooding, and integration dogfooding. Defects found during dogfooding are persisted and governed; they are not hidden to preserve roadmap speed.

## Historical integrity

V1 Work Order records, merge evidence, historical dogfooding reports, and architecture decisions remain intact. The transition does not rewrite history to make V2 appear to have existed earlier.
