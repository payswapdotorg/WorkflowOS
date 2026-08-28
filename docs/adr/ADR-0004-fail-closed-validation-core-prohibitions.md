# ADR-0004 — Governance state validates fail-closed against code-pinned core prohibitions

Status: accepted (WORK-052)

## Context

The canonical governance state is repository-resident JSON. A purely self-describing
file cannot defend its own integrity: an edit that weakens the self-hosting boundary or
drops a proof class from the `CRITICAL` profile would be "valid" against a schema that
lives in the same mutable file. The checkpoint principle from WORK-051 applies: a
governance control must never claim stronger guarantees than the underlying authority
can prove.

## Decision

The control-plane loader validates the artifacts **fail-closed** and cross-checks the
mutable parts against **code-pinned minimums** compiled into the backend:

- the self-hosting boundary's `mayNot` list must contain the core prohibitions pinned in
  code (no silent governing-architecture rewrite; no second workflow/Work
  Item/verification/architecture authority; no weakened
  security/tenant/concurrency/idempotency; no self-merge of the governing PR);
- each assurance profile's requirements must dominate its code-pinned minimum (proof
  classes and checkpoint kinds);
- the dependency DAG must be acyclic over known Work Orders; statuses must come from the
  closed vocabulary; `complete` requires merge evidence; checkpoint contracts' declared
  enforcement references must exist in the repository;
- any violation is a typed validation error — the control plane refuses to serve state
  it cannot prove consistent (fail closed, never a vacuous green).

The code-pinned minimums are themselves pinned by static architecture tests, and the
frozen lock sections are pinned verbatim so a silent rewrite of the governing rules
fails CI.

## Consequences

- Weakening the governance model requires touching BOTH the artifact and the code-pinned
  minimums (or the static pins) — a visible, reviewable diff, exactly the "no silent
  rewrite" property the boundary demands.
- The `governance-manifest` detector reuses the same validation at any revision through
  the checkpoint substrate, so a drifted or boundary-weakened repository fails its own
  architecture checkpoint (fail closed, durable evidence).
- Unknown fields are rejected (schema drift fails closed), so forward evolution requires
  a deliberate schema-version bump.
