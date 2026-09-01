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

W2: V2-005 + V2-006 + V2-007
    - parallel-no-rebase
    - V2-005: repository implementation + IR/capability contracts
    - V2-006: IR/capability contracts only
    - V2-007: V2-003 implementation only
    - no sibling branch may be used as a base
    - composition is proved later by integration gates

W3: V2-008

W4: V2-009 + V2-010 + V2-011
    - parallel-no-rebase
    - V2-009 owns events/schedules/placement
    - V2-010 owns reverse teaching
    - V2-011 owns optimization proposals

W5: V2-012

W6: V2-013
```

## Integration gates

The following are actual executable gate contracts, not narrative concepts:

- `IG-001` → `spec/architecture/v2/work-orders/IG-001.md`
- `IG-002` → `spec/architecture/v2/work-orders/IG-002.md`
- `IG-003` → `spec/architecture/v2/work-orders/IG-003.md`
- `IG-004` → `spec/architecture/v2/work-orders/IG-004.md`
- `IG-005` → `spec/architecture/v2/work-orders/IG-005.md`

## No-rebase invariant

A sibling implementation is never a dependency of another sibling implementation while unmerged. Any required composition is an integration gate from current `main` after the inputs have merged.

## Dogfooding invariant

Each feature has a feature-boundary dogfood before completion. Each integration gate has a cross-feature dogfood before the affected downstream wave can advance.

## Quality invariant

Parallelism may reduce waiting time, never verification. No required test, real-system proof, security check, evidence requirement or dogfooding experiment may be removed to preserve parallelism.
