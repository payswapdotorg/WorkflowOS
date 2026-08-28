# ADR-0002 — Assurance profiles change depth, not authority

Status: accepted (WORK-052)

## Context

Issue #61 requires adaptive assurance profiles (`LIGHT`, `STANDARD`, `HIGH_ASSURANCE`,
`CRITICAL`) that "deterministically alter checkpoint/evidence requirements" while the
same authorities remain authoritative — "Profiles must affect assurance depth, not
authority semantics." WORK-051 already ships an impact profile (`low|medium|high`) and a
pinned `IMPACT_CHECKPOINT_MATRIX` controlling which checkpoint kinds apply at lifecycle
gates. Two designs were possible: let the profile participate in the runtime lifecycle
gate decision, or keep the gate machinery untouched and make the profile a work-order-
level assurance contract.

## Decision

Assurance profiles are selected **deterministically from declared change surfaces**
(critical ⇒ `CRITICAL`; complex ⇒ `HIGH_ASSURANCE`; ordinary ⇒ `STANDARD`; simple ⇒
`LIGHT`; unknown/unset fails closed to the `HIGH_ASSURANCE` floor). The profile fixes the
work order's required checkpoint contracts, proof classes, and evidence requirements in
the protocol (what must be demonstrated and recorded in `program-state.json`). The
WORK-051 runtime gate machinery — impact derivation and `IMPACT_CHECKPOINT_MATRIX` — is
**untouched**. A dominance rule is enforced by validation: each profile's required
checkpoint kinds must be a superset of the kinds the WORK-051 matrix applies at the
corresponding impact level, so a profile can only add assurance depth, never subtract.

## Consequences

- No second policy engine: the profile is data (a rule table + a requirement matrix in
  `governance-model.json`) evaluated by one deterministic selector in the control plane.
- The lifecycle gates keep exactly one semantics (WORK-051's); no profile can weaken a
  gate, and no gate change can bypass a profile — the two layers compose by dominance.
- `LIGHT` keeps trivial changes cheap (no mandatory heavy process), while `CRITICAL`
  demands static + dynamic + discrimination proofs and recorded architect-review
  evidence — deterministic, auditable depth.
- Coherence between the work order's assurance profile and the runtime Work Item's
  impact declaration is validated: a `CRITICAL`/`HIGH_ASSURANCE` work order must map to
  runtime impact `high` (the fail-closed default stays `high`).
