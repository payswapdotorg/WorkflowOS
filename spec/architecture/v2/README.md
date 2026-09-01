# WorkflowOS 2.0 Architecture

**Status: PROPOSED / implementation-authorized.** The frozen v1.0 architecture remains authoritative until a governed V2 architecture version is formally frozen. Implementation authorization is recorded in `V2-CTRL-000-implementation-authorization.md`.

WorkflowOS 2.0 is a computer-workflow operating system. Its primary durable artifact is a versioned Workflow that can be authored from text, voice, demonstrations, or hybrids; deployed to capable web/desktop/mobile/cloud nodes; executed under explicit policy; scheduled or event-triggered; optimized through new versions; collaboratively forked/merged; sold or subscribed to; and used in reverse to teach people.

## V1 → V2 transition

The forward product roadmap is now V2. Remaining V1 roadmap items are **deferred by default** and may resume only for a concrete V2 dependency, compatibility/security requirement, or explicit architect reactivation. This transition is normative and persisted at `spec/architecture/v2/v1-transition.md`.

Fresh agents must not infer that deferred V1 items remain prerequisites for V2. Existing V1 authorities remain intact and are consumed only through explicit boundaries.

## Canonical V2 control plane

Read these as the repository-resident source of truth:

- `V2-CTRL-000-implementation-authorization.md` — implementation authorization and sole-architect model.
- `architecture-constitution.md` — normative architecture and anti-drift rules.
- `V2-CTRL-003-protocol-registry.md` + `.json` — canonical protocol names, capabilities, events, placement, execution classes, evidence and digest rules.
- `execution-control-plane.md` — Work Order lifecycle, dependency typing, no-rebase model, integration-gate state, recovery and completion.
- `V2-CTRL-001-conformance-checklist.md` — mandatory implementation/verification/dogfooding checks.
- `V2-CTRL-002-roadmap-lock.md` — canonical wave graph and no-rebase lock.
- `dogfooding-protocol.md` — mandatory feature- and integration-boundary experiments.
- `v2-work-order-state.json` — canonical machine-readable progress/eligibility/state.
- `architecture-change-requests/V2-ACR-001-execution-attestation.md` — governed execution-attestation evolution.
- `execution-attestation.md` — normative execution statement/digest/attestation/proof model.

The `fresh-architect-bootstrap.md` file is the shortest safe reading path for a zero-history agent.

## V2 architecture sequence

The product sequence is an index, not the execution order:

`V2-001 → V2-002 → V2-003 → V2-004 → V2-006/V2-007/V2-014 → V2-005 → V2-008 → V2-009/V2-010/V2-011 → IG-006 → V2-012/V2-015 → V2-013`

The **canonical execution order is the wave graph in `V2-CTRL-002-roadmap-lock.md` and `v2-work-order-state.json`**, not this linear/index sequence.

## Current wave model

```text
W0   V2-001 COMPLETE
        ↓
W1   V2-002   V2-003   V2-004             ← same base, parallel, no rebase
        ↓
W2A  V2-006   V2-007   V2-014             ← same base, parallel, no rebase
        ↓
W2B  V2-005                              ← Run/evidence consumes V2-014 contract
        ↓
W3   IG-001 + IG-002 → V2-008
        ↓
W4   V2-009   V2-010   V2-011              ← parallel, no rebase
        ↓
     IG-006                                ← cross-device attestation composition
        ↓
W5   V2-012   V2-015                      ← parallel, no rebase
        ↓
W6   V2-013
```

Integration gates are first-class repository work: they start from current `main` after their inputs are complete and never require sibling branch rebasing.

## Core product architecture

The protocol and semantic contracts are the foundation. Platform applications are clients/hosts of the same protocol, not separate workflow engines. Existing WorkflowOS software-engineering capabilities become installable V2 workflows rather than being rebuilt as a second product architecture.

Canonical artifact hierarchy:

```text
WorkflowRepository
  ↓
Workflow
  ↓
immutable WorkflowVersion
  ↓
WorkflowIR
  ↓
WorkflowDeployment
  ↓
WorkflowRun
```

WorkflowIR is the semantic source of truth. Text, voice, demonstration traces, prompts, model memory, compiled artifacts, teaching sessions and marketplace listings are inputs/provenance/derived views, not replacement workflow formats.

Web, desktop, iOS, Android and cloud use one protocol. Nodes advertise capabilities; authorization, policy, consent, placement and trust remain separate. Locality is a correctness constraint.

Teaching and automation are symmetric views over one immutable WorkflowVersion. Workflows can also be reverse-teaching artifacts, showing humans how to perform the task represented by the workflow.

Marketplace entitlement never becomes execution authority. One-time purchases and maintenance subscriptions are supported without mutating installed versions silently.

Optimization is advisory and version-producing; it can propose API substitution, workflow reuse, safer placement, parallelization and reliability/cost improvements.

## Execution proof architecture

V2 now defines an additive verifiable-execution layer:

```text
WorkflowIR
  ↓
WorkflowRun
  ↓
ExecutionStatement
  ↓
ExecutionDigest
  ↓
ExecutionAttestation
  ↓
verification/appraisal
  ↓
VerifiedExecutionFact
  ↓
ExecutionProofGraph (later)
```

The cryptographic layer does not replace WorkflowIR, Run, Node, authorization, or verification. A signature authenticates a statement; it does not automatically prove a physical side effect. Freshness, evidence sufficiency, trust and assurance are explicit.

## Mechanical execution

Every V2 Work Order follows:

```text
read authorization + constitution + registry + state + Work Order
→ verify dependencies / stable base
→ activate
→ implement
→ deterministic verification
→ required real-system verification
→ feature-boundary dogfooding
→ persist findings
→ PR
→ sole architect review/merge
→ post-merge finalization
→ integration gate when required
→ cross-feature dogfooding
→ next eligible wave
```

Parallel Work Orders are independently mergeable and never depend on another sibling's unmerged branch. When interaction requires integration, use an `IG-*` Work Order instead of rebasing siblings.

## Quality and dogfooding

Tests validate implementation correctness. Dogfooding validates the real integrated product at the smallest useful boundary. Every user-facing/execution-facing feature and every integration gate has an explicit experiment. Contract-relevant failures block the affected dependency subtree; unrelated findings become targeted corrective Work Orders.

No speed optimization may remove a required regression, real-system proof, security boundary, evidence requirement or dogfooding experiment.

For execution attestation specifically, feature-boundary dogfooding must include real cryptographic verification plus at least one negative replay/tamper/freshness experiment. Cross-device proof composition requires a real two-host experiment where supported.

## V1 boundary

V2 does not silently replace frozen v1.0 authorities. Reuse occurs through explicit adapters and preserved authority boundaries. A fresh agent must not infer permission to redesign V1 merely because a V2 feature would be easier that way.

See `docs/superpowers/specs/2026-09-01-workflowos-2-0-universal-workflow-protocol-design.md`, `spec/architecture/v2/workflow-teaching-and-marketplace.md`, `spec/architecture/v2/workflow-marketplace-economics.md`, and `spec/architecture/v2/mobile-device-runtime.md` for supporting normative detail.
