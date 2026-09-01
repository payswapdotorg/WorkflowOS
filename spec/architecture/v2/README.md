# WorkflowOS 2.0 Architecture

**Status: PROPOSED.** The frozen v1.0 architecture remains authoritative until a governed V2 architecture version is approved.

WorkflowOS 2.0 is a computer-workflow operating system. Its primary durable artifact is a versioned Workflow that can be authored from text, voice, demonstrations, or hybrids; deployed to capable web/desktop/mobile/cloud nodes; executed under explicit policy; scheduled or event-triggered; optimized through new versions; collaboratively forked/merged; sold or subscribed to; and used in reverse to teach people.

## V2 architecture sequence

1. **V2-001 — Universal Workflow Protocol**: common protocol across web, desktop, iOS, Android, and cloud.
2. **V2-002 — Workflow Repository + Immutable Versioning**
3. **V2-003 — Workflow IR**
4. **V2-004 — Node + Capability Protocol**
5. **V2-005 — Workflow Runs + Evidence**
6. **V2-006 — Teaching Sessions**
7. **V2-007 — Workflow Compiler**
8. **V2-008 — Computer-Agent Runtime**
9. **V2-009 — Scheduling + Events + Placement**
10. **V2-010 — Reverse Teaching**
11. **V2-011 — Optimization**
12. **V2-012 — Collaboration + Marketplace + Economics**
13. **V2-013 — WorkflowOS Self-Hosted Workflow Library**

## Mechanical execution

The V2 roadmap is now paired with repository-resident machine-readable state and executable work-order contracts:

- `spec/development-state/v2-work-order-state.json` — canonical V2 work-order state, dependency gates, completion gates and dogfooding requirements.
- `spec/architecture/v2/execution-control-plane.md` — lifecycle, activation, evidence, recovery/resume and lean review protocol.
- `spec/architecture/v2/dogfooding-protocol.md` — mandatory feature-boundary real-product experiments.
- `spec/architecture/v2/work-orders/` — one executable contract per V2 product work item.

A fresh implementation agent must be able to determine the next eligible item, its hard dependencies, its acceptance contract and its required dogfooding experiment without reading conversation history.

## Core rule

The protocol and semantic contracts are the foundation. Platform applications are clients/hosts of the same protocol, not separate workflow engines. Existing WorkflowOS software-engineering capabilities become installable V2 workflows rather than being rebuilt as a second product architecture.

## Development discipline

Tests validate correctness; dogfooding validates the integrated product. No large tranche may be implemented before real use at its feature boundary. Empirical dogfooding findings are persisted separately from normative architecture and create targeted corrective work when needed.

See `docs/superpowers/specs/2026-09-01-workflowos-2-0-universal-workflow-protocol-design.md`, `spec/architecture/v2/execution-control-plane.md`, and `spec/architecture/v2/work-orders/V2-001.md`.
