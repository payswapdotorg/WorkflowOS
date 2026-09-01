# WorkflowOS 2.0 — Research and External Architecture Rationale

This document records why the V2 architecture uses a semantic workflow artifact above a computer-use agent, capability-based nodes, explicit evidence, teaching from workflows, and process-trace compilation.

## OpenClaw

OpenClaw's computer-use design exposes computer interaction through capability-oriented node/runtime surfaces rather than making raw platform implementation the workflow abstraction. It also treats provider selection and capability availability explicitly instead of silently falling back between execution mechanisms.

WorkflowOS adopts the general architectural lesson: nodes advertise capabilities; WorkflowIR remains platform-neutral; execution eligibility combines capability, authorization and policy; unavailable capabilities are explicit failures.

Reference: https://docs.openclaw.ai/nodes/computer-use

## Hermes Agent

Hermes Agent demonstrates a useful separation between reusable procedural knowledge (skills), agent reasoning, computer use and scheduled execution, and supports multiple execution environments. WorkflowOS extends the separation by making the reusable procedure an immutable versioned Workflow artifact with a formal IR, deployment identity, evidence and marketplace semantics.

Reference: https://github.com/NousResearch/hermes-agent

## Computer-agent benchmarks

OSWorld, WorkArena, WorkArena++ and related benchmarks show that realistic computer tasks remain difficult for general agents, particularly around grounding, long-horizon planning, state understanding and reliable interaction. This motivates a design in which computer use is one bounded execution class rather than the workflow's semantic source of truth.

References:
- https://arxiv.org/abs/2404.07972
- https://arxiv.org/abs/2403.07718
- https://arxiv.org/abs/2407.05291

## Web and mobile agents

Research such as WebLINX, AndroidWorld and subsequent mobile-agent work shows that web/mobile execution requires richer grounding and state capture than screenshots alone. Accessibility trees, structured UI observations and explicit post-action state improve the execution model.

WorkflowOS therefore stores semantic WorkflowIR separately from raw demonstration/observation traces and lets Node capabilities expose platform-specific grounding mechanisms.

References:
- https://arxiv.org/abs/2402.05937
- https://arxiv.org/abs/2405.14573

## Learning from demonstration

Learning-from-demonstration research supports reducing programming burden by observing expert procedures, but demonstrations are observations of behavior rather than guaranteed executable specifications. WorkflowOS consequently uses demonstrations as authoring evidence that must be segmented, interpreted, validated and compiled into WorkflowIR.

## Process mining / RPA

Process-mining and RPA research motivates extracting higher-level procedures from event traces and using those traces to identify automation and optimization opportunities. WorkflowOS deliberately avoids simply replaying every low-level UI event as a workflow. It abstracts observations into semantic actions, preserves the raw trace as provenance, and can later propose API substitutions or workflow reuse.

## Mobile platform asymmetry

Android and iOS expose different automation and permission primitives. WorkflowOS therefore guarantees one protocol, not identical capabilities. A phone node advertises only what the operating system and user permissions support; unsupported capabilities produce explicit ineligibility rather than hidden simulation.

## Architectural consequence

The combined evidence leads to this design:

```text
human procedure
   ↓ text / voice / demonstration / hybrid
workflow compiler
   ↓
immutable semantic WorkflowVersion + WorkflowIR
   ↓
capability-aware execution
   ├── deterministic/API
   ├── computer agent
   ├── human
   └── subworkflow
   ↓
verified WorkflowRun + evidence
   ↓
optimization proposals / new versions
```

The product moat is therefore not merely computer control. It is the durable workflow knowledge layer: capture → semantic compilation → execution → evidence → improvement → distribution → teaching.

## Research use rule

Research informs architecture but does not override repository-frozen contracts. A future implementation agent must use the V2 Architecture Constitution and Work Orders as normative authority. New research can motivate a governed architecture change; it cannot silently alter implementation semantics.
