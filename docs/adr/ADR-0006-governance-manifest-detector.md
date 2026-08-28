# ADR-0006 — The detector registry advances 6→7 with `governance-manifest`

Status: accepted (WORK-052)

## Context

WORK-051 ships a deliberately CLOSED detector registry — exactly six detector kinds —
pinned by a static architecture invariant ("closed set of exactly 6 kinds; no other file
may call `registry.set`"). The pin exists to prevent *unauthorized* drift, not to forbid
*authorized* evolution. WORK-052 needs governed evaluation of the development-governance
state itself (the self-hosting boundary contract `SELF-HOSTING-BOUNDARY` and repository
source-of-truth integrity) at exact revisions.

## Decision

The registry advances to exactly seven kinds, adding **`governance-manifest`**: a
deterministic detector that reads `spec/development-state/governance-model.json` and
`program-state.json` through the existing revision-bound `RepositorySnapshot` (never the
working tree) and applies the same fail-closed validation as the control-plane loader:
missing/unreadable/parses-failing manifests ⇒ `inconclusive` (a blocking assertion then
blocks); a weakened boundary, cyclic DAG, evidence-inconsistent status, unknown
vocabulary, or missing enforcement references ⇒ `fail`. The closed-set static invariant
is deliberately advanced 6→7 in the same change, with this ADR as the record that the
extension is WORK-052-authorized.

## Consequences

- The registry remains closed — the pin still counts, still bans `registry.set` outside
  the factory, and still rejects unknown kinds at evaluation (`inconclusive`, fail
  closed). Evolution of the closed set stays a reviewable, ADR-recorded event.
- WorkflowOS can checkpoint its own control-plane integrity at any revision through the
  standard substrate: assertions of kind `governance-manifest` attach to an immutable
  ArchitectureVersion and evaluate with durable `/verification` evidence — no new
  evidence store, no new authority.
- The detector is generic: any governed repository carrying the two artifacts can use
  it; it reads only the snapshot and its assertion's `detectorConfig` (paths
  configurable, defaults to the canonical locations).
