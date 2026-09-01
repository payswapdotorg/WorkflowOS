# WorkflowOS 2.0 Architecture

**Status: PROPOSED.** The frozen v1.0 architecture remains authoritative until a governed V2 architecture version is approved.

WorkflowOS 2.0 is a computer-workflow operating system. Its primary durable artifact is a versioned Workflow that can be authored from text, voice, demonstrations, or hybrids; deployed to capable web/desktop/mobile/cloud nodes; executed under explicit policy; scheduled or event-triggered; optimized through new versions; collaboratively forked/merged; sold or subscribed to; and used in reverse to teach people.

## V2 product work sequence

- **V2-001 — Universal Workflow Protocol** — COMPLETE.
- **W1 / parallel:** **V2-002 — Workflow Repository + Immutable Versioning**, **V2-003 — Workflow IR**, **V2-004 — Node + Capability Protocol**.
- **W2 / parallel where surfaces allow:** **V2-005 — Workflow Runs + Evidence**, **V2-006 — Teaching Sessions**, **V2-007 — Workflow Compiler**; followed by integration of their merged capabilities.
- **W3:** **V2-008 — Computer-Agent Runtime**.
- **W4 / parallel:** **V2-009 — Scheduling + Events + Placement**, **V2-010 — Reverse Teaching**, **V2-011 — Optimization**.
- **W5:** **V2-012 — Collaboration + Marketplace + Economics**.
- **W6:** **V2-013 — WorkflowOS Self-Hosted Workflow Library**.

The optimized wave/dependency contract is canonical in `spec/architecture/v2/optimized-roadmap.md`; machine-readable execution state is canonical in `spec/development-state/v2-work-order-state.json`.

## Mechanical execution

The V2 roadmap is paired with repository-resident executable work-order/state machinery:

- `spec/development-state/v2-work-order-state.json` — canonical V2 state, wave membership, dependency types, change surfaces, integration gates and next action.
- `spec/architecture/v2/execution-control-plane.md` — lifecycle, activation, no-rebase parallelism, evidence, recovery/resume and lean review protocol.
- `spec/architecture/v2/dogfooding-protocol.md` — mandatory feature-boundary and integration dogfooding.
- `spec/architecture/v2/optimized-roadmap.md` — the implementation-speed optimization and wave rationale.
- `spec/architecture/v2/work-orders/` — executable contract for every V2 product item.

A fresh implementation agent must determine the next eligible Work Order or parallel wave, its dependency type, change surface, acceptance contract and dogfooding requirement without conversation history.

## Core rule

The protocol and semantic contracts are the foundation. Platform applications are clients/hosts of the same protocol, not separate workflow engines. Existing WorkflowOS software-engineering capabilities become installable V2 workflows rather than being rebuilt as a second product architecture.

## Quality rule

Parallelism never reduces tests, real-system proofs, security checks or dogfooding. A sibling branch never depends on another sibling's unmerged implementation. When interaction between independently merged features needs validation, an integration Work Order is used rather than a rebase.

## Dogfooding rule

Tests validate correctness; dogfooding validates the integrated product. Every user-facing or execution-facing feature gets a smallest-real-use experiment before completion, and declared integration gates get cross-feature experiments. Empirical failures remain evidence and create targeted corrective work without forcing unrelated branches to rebase.

See `docs/superpowers/specs/2026-09-01-workflowos-2-0-universal-workflow-protocol-design.md`, `spec/architecture/v2/execution-control-plane.md`, `spec/architecture/v2/dogfooding-protocol.md`, and `spec/architecture/v2/optimized-roadmap.md`.
