# WorkflowOS 2.0 — Fresh Architect / Implementation Bootstrap

This file is the shortest safe recovery path for a new LLM architect or implementation agent with zero conversation history.

## Read in this order

1. `spec/architecture/v2/V2-CTRL-000-implementation-authorization.md`
2. `spec/architecture/v2/architecture-constitution.md`
3. `spec/architecture/v2/V2-CTRL-003-protocol-registry.md` and `V2-CTRL-003-protocol-registry.json`
4. `spec/architecture/v2/execution-control-plane.md`
5. `spec/architecture/v2/V2-ACR-002-governance-control-plane-refinement.md`
6. `spec/architecture/v2/V2-CTRL-001-conformance-checklist.md`
7. `spec/architecture/v2/dogfooding-protocol.md`
8. `spec/architecture/v2/v1-transition.md`
9. `spec/architecture/v2/optimized-roadmap.md` and `V2-CTRL-002-roadmap-lock.md`
10. `spec/development-state/README.md`
11. `spec/development-state/governance-model.json`
12. `spec/development-state/program-state.json`
13. the derived `dependency-state.json`, `frontier-state.json`, and `checkpoint-state.json` only as projections; regenerate/validate them when they disagree with underlying facts
14. the assigned Work Order in `spec/architecture/v2/work-orders/` (and its machine-state entry)
15. `spec/architecture/v2/architecture-change-requests/V2-ACR-001-execution-attestation.md` when execution proof, trust, cryptographic evidence or cross-device behavior is relevant
16. supporting V2 product specifications relevant to the Work Order
17. relevant existing V1 public contracts before reusing any V1 capability

## Status interpretation

V2 is **APPROVED FOR IMPLEMENTATION** but remains a **PROPOSED architecture generation** until a formal V2 architecture version is frozen through repository governance.

`V2-ACR-002` is the governing refinement for development-state ownership. It makes the distinction explicit between authoritative facts, operational resume state, and derived navigation/checkpoint projections.

## Product definition

WorkflowOS 2.0 turns how people work with computers into reusable executable software.

Users can teach a workflow by text, voice, demonstration, or hybrid input; pause/resume teaching; install workflows; execute them manually/scheduled/event-triggered; run them locally on desktop/mobile, in a browser, or in the cloud; optimize them into new versions; collaborate/fork/share them; purchase them once or subscribe to maintenance; and reverse-teach from an installed workflow to a human.

## Canonical artifact hierarchy

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

The WorkflowIR is the semantic source of truth. Raw demonstrations, screenshots/video, prompts, model memory, compiled artifacts, teaching sessions and marketplace listings are not replacement workflow formats.

## Development governance model

The development control plane is layered:

```text
Architect decisions / ACRs
        ↓
Work Orders and declared scope
        ↓
implementation operational state
        ↓
verification + dogfooding evidence
        ↓
Architect merge = completion fact
        ↓
post-merge reconciliation records that fact
        ↓
derived dependency/frontier/checkpoint projections
```

There is one completion authority: the Architect's merge.

There is one dependency authority: the Work Order dependency graph.

Derived eligibility/frontier/checkpoint/navigation state never becomes a second authority.

## Post-merge rule

A merge is the completion event. Recording the merge in canonical state is bookkeeping and may be automated or run deterministically from authoritative Git history.

The recorder must not approve the merge, broaden the Work Order, lower assurance, or create new authority. Ambiguous or unverifiable merge identity fails closed.

## Universal protocol

Web, desktop, iOS, Android and cloud implement one protocol. Platform-specific UX and capabilities may differ. Workflow semantics, identity, versioning, run/evidence rules and authorization semantics must not differ.

Protocol-visible names are governed by `V2-CTRL-003`. Agents must not invent aliases for existing semantic operations.

Nodes advertise capabilities. Capability possession is never authorization.

## Execution classes

Each step is deterministic/API, agentic/computer-use, human, or subworkflow. Prefer deterministic/API execution when semantic equivalence is established. Computer-use is bounded by WorkflowIR, capability, authorization, policy, placement and evidence requirements.

## Execution attestation

Execution proof is layered:

```text
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
ExecutionProofGraph
```

A digest is a canonical commitment, not execution truth. A signature authenticates an attester's statement, not a physical side effect. Decision-relevant attestations bind to WorkflowVersion/Run/attempt/step and freshness. Node identity, workload identity, authorization, capability, trust, assurance and verification remain separate.

## Parallel implementation

Parallel means independently mergeable:

- same stable merged main base;
- disjoint authoritative surfaces;
- no sibling branch dependency;
- no rebase onto sibling branches;
- complete tests and dogfooding per item;
- integration Work Order when composition itself needs proof.

Integration gates consume merged capabilities and begin from current `main`.

## Recovery

Resume from GitHub state, Work Order operational state, and verification/dogfooding evidence. Do not trust conversational memory or stale navigation fields such as `nextEligible`, `nextAction`, or copied wave summaries when they disagree with the underlying graph and Git history.

## Non-negotiable stop conditions

Stop and raise a governed architecture change when implementation would:

- redefine a frozen V2 concept;
- create a second workflow protocol/engine;
- create a protocol-name alias that conflicts with the canonical registry;
- make a platform-specific semantic fork;
- turn an assertion into evidence;
- turn a signature/hash into automatic proof of a physical side effect;
- make a non-durable adapter claim durable behavior;
- bypass authorization through capability possession, marketplace entitlement, or signing-key possession;
- accept stale/replayed execution attestations;
- silently downgrade required attestation assurance;
- mutate an immutable workflow version silently;
- hide a missing platform capability;
- revive deferred V1 without an allowed reason;
- remove or weaken a required dogfooding, discrimination, freshness, replay, or cryptographic test to make progress;
- require an unmerged sibling implementation as a dependency;
- activate an integration gate before every listed input is actually COMPLETE;
- treat a derived governance projection as an authority source;
- record completion without authoritative Git merge evidence.
