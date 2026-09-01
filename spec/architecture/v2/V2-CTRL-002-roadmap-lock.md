# V2-CTRL-002 — Canonical Roadmap Lock

**Status:** REQUIRED CONTROL ARTIFACT

This file removes remaining roadmap ambiguity. It is read together with `v2-work-order-state.json` and takes precedence over informal wording in Work Order prose.

## Active roadmap

```text
W0: V2-001 COMPLETE

W1: V2-002 + V2-003 + V2-004
    - parallel-no-rebase
    - identical stable main base
    - disjoint authoritative surfaces
    - independently mergeable

W2A: V2-006 + V2-007 + V2-014
    - parallel-no-rebase
    - V2-006: teaching sessions
    - V2-007: compiler core
    - V2-014: execution attestation protocol
    - V2-014 consumes merged W1 contracts; it does not own sibling internals
    - V2-006/V2-007 do not consume V2-014's unmerged branch

W2B: V2-005
    - sequential after V2-014 contract and V2-002 implementation
    - owns Run lifecycle/evidence persistence
    - persists references to the canonical attestation contract

W3: IG-001 + IG-002, then V2-008
    - integration gates start from current main after all listed inputs merge
    - V2-008 is execution runtime and cross-host adapters

W4: V2-009 + V2-010 + V2-011
    - parallel-no-rebase
    - V2-009 owns events/schedules/placement
    - V2-010 owns reverse teaching
    - V2-011 owns optimization proposals

W5: V2-012 + V2-015
    - parallel-no-rebase
    - V2-012 owns collaboration/marketplace/economics
    - V2-015 owns execution proof graphs and trust-minimized coordination
    - no sibling branch dependency

W6: V2-013
    - self-hosted WorkflowOS workflow library
```

## Integration gates

The following are actual executable gate contracts, not narrative concepts:

- `IG-001` → `spec/architecture/v2/work-orders/IG-001.md`
- `IG-002` → `spec/architecture/v2/work-orders/IG-002.md`
- `IG-003` → `spec/architecture/v2/work-orders/IG-003.md`
- `IG-004` → `spec/architecture/v2/work-orders/IG-004.md`
- `IG-005` → `spec/architecture/v2/work-orders/IG-005.md`
- `IG-006` → `spec/architecture/v2/work-orders/IG-006.md`

`IG-006` is the cross-device attestation composition gate. It consumes only merged V2-005, V2-008, V2-009 and V2-014 capabilities and must complete before V2-015.

## No-rebase invariant

A sibling implementation is never a dependency of another sibling implementation while unmerged. Any required composition is an integration gate from current `main` after the inputs have merged.

V2-014 is a W2A sibling and therefore never branches from or rebases onto V2-006/V2-007. V2-015 is a W5 sibling of V2-012 and likewise remains independently mergeable.

## Dogfooding invariant

Each feature has a feature-boundary dogfood before completion. Each integration gate has a cross-feature dogfood before the affected downstream wave can advance.

Execution-attestation dogfooding MUST include one positive real-crypto verification and one negative replay/tamper/freshness experiment. Cross-device proof-graph dogfooding MUST exercise at least two real supported hosts when the required capabilities exist.

## Quality invariant

Parallelism may reduce waiting time, never verification. No required test, real-system proof, security check, evidence requirement or dogfooding experiment may be removed to preserve parallelism.

## Architectural quality ratchet

The execution-attestation extension adds no second workflow protocol, workflow engine, authorization authority, or verification authority. Cryptographic authenticity, node trust, capability possession, authorization, observed effects, and verification remain separate dimensions. Stronger attestation mechanisms strengthen assurance but never silently change workflow semantics.
