# WorkflowOS 2.0 Architecture

**Status: PROPOSED.** The frozen v1.0 architecture remains authoritative until a governed V2 architecture version is approved.

WorkflowOS 2.0 is a computer-workflow operating system. Its primary durable artifact is a versioned Workflow that can be authored from text, voice, demonstrations, or hybrids; deployed to capable web/desktop/mobile/cloud nodes; executed under explicit policy; scheduled or event-triggered; optimized through new versions; collaboratively forked/merged; sold or subscribed to; and used in reverse to teach people.

## V2 architecture sequence

The product sequence remains:

`V2-001 → V2-002 → V2-003 → V2-004 → V2-005 → V2-006 → V2-007 → V2-008 → V2-009 → V2-010 → V2-011 → V2-012 → V2-013`

Execution order is **not** strictly linear. The canonical implementation graph is the optimized wave roadmap at `spec/architecture/v2/optimized-roadmap.md` and the machine-readable state at `spec/development-state/v2-work-order-state.json`.

Current wave model:

```text
W0  V2-001
     ↓
W1  V2-002   V2-003   V2-004        ← same base, parallel, no rebase
     ↓
W2  V2-005   V2-006   V2-007        ← parallel where surfaces allow
     ↓
W3  V2-008
     ↓
W4  V2-009   V2-010   V2-011        ← same-base parallel wave
     ↓
W5  V2-012
     ↓
W6  V2-013
```

Integration gates are separate from sibling implementation branches. When independently developed capabilities first interact, the integration gate starts from the then-current `main`; it never rebases one sibling onto another.

## Mechanical execution

The V2 roadmap is paired with repository-resident machine-readable state and executable work-order contracts:

- `spec/development-state/v2-work-order-state.json` — canonical V2 work-order state, dependency types, parallel waves, integration gates, completion gates and dogfooding requirements.
- `spec/architecture/v2/execution-control-plane.md` — lifecycle, activation, dependency typing, no-rebase rules, evidence, recovery/resume and lean review protocol.
- `spec/architecture/v2/dogfooding-protocol.md` — mandatory feature-boundary and integration-boundary real-product experiments.
- `spec/architecture/v2/optimized-roadmap.md` — human-readable optimized roadmap and parallelization rationale.
- `spec/architecture/v2/work-orders/` — one executable contract per V2 product work item.

A fresh implementation agent must be able to determine the next eligible item or wave, its dependency type, exact change-surface boundary, required verification, and required dogfooding experiment without reading conversation history.

## Parallelization rule

**Parallel means independently mergeable.** Sibling Work Orders must share a stable merged base, have disjoint authoritative change surfaces, have no unmerged implementation dependencies on each other, and be individually complete on tests and dogfooding. A parallel sibling must never require a rebase onto another sibling.

If a conflict would otherwise occur, split the contract or add a small integration Work Order. Never weaken quality gates merely to preserve parallelism.

## Core rule

The protocol and semantic contracts are the foundation. Platform applications are clients/hosts of the same protocol, not separate workflow engines. Existing WorkflowOS software-engineering capabilities become installable V2 workflows rather than being rebuilt as a second product architecture.

## Dogfooding discipline

Tests validate correctness; dogfooding validates the integrated product. Every user-facing or execution-facing feature has a feature-boundary experiment before completion, and every declared integration gate has a cross-feature experiment. Contract-relevant dogfooding failures block the affected dependency subtree; unrelated findings become targeted corrective Work Orders.

## V1 boundary

V2 does not silently replace frozen v1.0 authorities. Reuse occurs through explicit adapters and preserved authority boundaries. A fresh agent must not infer permission to redesign V1 merely because a V2 feature would be easier that way.

See `docs/superpowers/specs/2026-09-01-workflowos-2-0-universal-workflow-protocol-design.md`, `spec/architecture/v2/execution-control-plane.md`, `spec/architecture/v2/optimized-roadmap.md`, and `spec/development-state/v2-work-order-state.json`.
