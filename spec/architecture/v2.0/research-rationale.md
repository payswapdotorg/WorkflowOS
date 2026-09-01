# WorkflowOS 2.0 — Research Rationale

This document records the research and external-system observations that informed the v2.0 architecture. It is intentionally separated from the normative architecture so that new implementation agents can recover both the **design decisions** and the **evidence behind them** without relying on conversation history.

## 1. Computer-use agents are promising but not sufficient as a workflow representation

**OSWorld** evaluates multimodal agents against real desktop applications and cross-application workflows. Its original benchmark contains 369 real computer tasks and reported a large gap between human and agent performance, with failures concentrated in GUI grounding and operational knowledge. This supports treating computer use as an execution capability surrounded by stronger workflow structure, verification and policy—not as the workflow definition itself.

Source: Xie et al., *OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments* (2024).
https://arxiv.org/abs/2404.07972

## 2. Enterprise/browser work needs explicit workflow structure

**WorkArena** evaluates agents on common enterprise knowledge-work tasks in ServiceNow and reports a substantial gap to full automation. **WorkArena++** expands the setting to 682 compositional tasks and highlights difficulties in planning, contextual understanding, retrieval, reasoning and execution.

Design implication: the Workflow IR needs explicit preconditions, postconditions, inputs, outputs, dependencies, evidence requirements and human intervention points. A single open-ended prompt is too underspecified to serve as the authoritative executable artifact.

Sources:

- Drouin et al., *WorkArena: How Capable Are Web Agents at Solving Common Knowledge Work Tasks?* (2024).
  https://arxiv.org/abs/2403.07718
- Boisvert et al., *WorkArena++: Towards Compositional Planning and Reasoning-based Common Knowledge Work Tasks* (2024).
  https://arxiv.org/abs/2407.05291

## 3. Web agents still need grounding and history management

**WebLINX** evaluates conversational web navigation over 100K interactions and 2,300 expert demonstrations across more than 150 websites. The work uses retrieval-inspired page pruning plus screenshots and action history and finds that generalization to unseen websites remains difficult.

Design implication: demonstration capture should retain screen/semantic-UI evidence and action history while the compiler turns them into semantic workflow steps. Raw interaction traces are valuable provenance and training/evaluation material, but should not become the semantic workflow itself.

Source: Lù, Kasner and Reddy, *WebLINX: Real-World Website Navigation with Multi-Turn Dialogue* (2024).
https://arxiv.org/abs/2402.05930

## 4. Mobile automation is not merely desktop automation on a smaller screen

**AndroidWorld** provides a realistic Android environment with 116 tasks across 20 apps and found large differences between agents adapted from desktop and those designed for mobile interaction. It also emphasizes deterministic initialization, success checking and teardown.

**MobileWorld** extends mobile benchmarking to 201 tasks across 20 applications and specifically targets vague natural-language instructions, enterprise communication/e-commerce scenarios and hybrid tool usage.

Design implication: mobile devices are first-class execution nodes with platform-specific capabilities, state observations and permissions. The protocol must remain common across platforms while allowing Android/iOS to advertise different capability sets.

Sources:

- Rawles et al., *AndroidWorld: A Dynamic Benchmarking Environment for Autonomous Agents* (2024).
  https://arxiv.org/abs/2405.14573
- Kong et al., *MobileWorld: Benchmarking Autonomous Mobile Agents in Agent-User Interactive, and MCP-Augmented Environments* (2025).
  https://arxiv.org/abs/2512.19432

## 5. Tool invocation matters in computer-use systems

**OSWorld-MCP** evaluates computer-use agents with explicit tool invocation in addition to GUI interaction and decision making. The study reports meaningful success gains when high-quality tools are available, while also finding that even strong agents do not reliably invoke tools.

Design implication: WorkflowOS should make API/connectors first-class execution capabilities and let the optimizer replace brittle GUI sequences with deterministic tool calls when a semantically equivalent capability exists.

Source: Jia et al., *OSWorld-MCP: Benchmarking MCP Tool Invocation In Computer-Use Agents* (2025).
https://arxiv.org/abs/2510.24563

## 6. Learning from demonstration supports teaching rather than programming

Learning-from-demonstration research has long argued that non-experts can teach capable systems by showing behavior instead of writing programs. Surveys and empirical work also highlight that teaching quality, ambiguity and interaction matter, which motivates an authoring loop that can ask questions, preserve uncertainty and allow the teacher to pause/resume rather than treating one demonstration as infallible code.

Sources:

- Lee, *A survey of robot learning from demonstrations for Human-Robot Collaboration* (2017).
  https://arxiv.org/abs/1710.08789
- Sena and Howard, *Quantifying Teaching Behaviour in Robot Learning from Demonstration* (2019).
  https://arxiv.org/abs/1905.04218

## 7. Process mining and RPA support recording, discovery and improvement

A systematic literature review of process mining for RPA identifies process discovery, event-log preprocessing, automation selection and improvement as major challenges. The literature supports combining user-interaction/event traces with process models instead of directly replaying raw automation recordings.

Design implication: WorkflowOS should capture execution traces and demonstrations as rich event data, then compile and analyze them into semantic process models. The optimizer should reason about conformance, redundancy, automation candidates, and replacement opportunities.

Sources:

- El-Gharib and Amyot, *Robotic process automation using process mining — A systematic literature review* (2023).
  https://www.sciencedirect.com/science/article/pii/S0169023X23000897
- van der Aalst, *Process Mining: Discovery, Conformance and Enhancement of Business Processes* (background reference cited by the review).

## 8. Current open-source systems validate several lower-level choices

### OpenClaw

Current OpenClaw documentation uses capability-advertised nodes and a uniform `computer.act` command. Nodes must advertise the capabilities required by computer control, and provider failures do not silently fall back to another provider. This validates the v2.0 node/capability model and the principle of explicit provider selection.

Sources:

- OpenClaw computer-use documentation:
  https://docs.openclaw.ai/nodes/computer-use
- OpenClaw node capability documentation:
  https://github.com/openclaw/openclaw/blob/main/docs/nodes/index.md

### Hermes Agent

Hermes currently combines reusable skills, autonomous skill creation, scheduled automations, cross-platform gateways, and multiple execution backends. Its cron subsystem supports one-shot and recurring schedules, pause/resume/edit/run/remove operations, skill-backed jobs, and a model/provider drift guard for unattended jobs.

This validates the usefulness of reusable procedural artifacts, explicit scheduling objects, execution environments and drift protection. WorkflowOS 2.0 extends those ideas by making an immutable Workflow Version and Workflow Deployment the authoritative artifacts rather than using a prompt/skill as the complete automation representation.

Sources:

- Hermes repository:
  https://github.com/nousresearch/hermes-agent
- Hermes scheduled tasks:
  https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/
- Hermes feature overview:
  https://hermes-agent.nousresearch.com/docs/user-guide/features/overview

## 9. Architectural conclusions from the evidence

The combined evidence leads to the following conclusions:

1. **Computer use is an execution capability, not an adequate workflow representation.** General agents still struggle with grounding, long-horizon reasoning and robust execution.
2. **Structured workflow state is necessary.** Preconditions, postconditions, dependencies, evidence and policy reduce ambiguity and enable testing and deterministic replay.
3. **Demonstrations are valuable source material.** Store them as provenance and compile them into semantic workflows rather than replaying raw GUI events forever.
4. **APIs/tools are superior to GUI interaction when semantically equivalent and authorized.** Therefore connectors belong in the same capability system as computer use.
5. **Mobile is a first-class execution environment.** The same protocol should span devices while capability availability and OS restrictions remain explicit.
6. **Workflow reuse is a core opportunity.** Existing workflows can act as versioned dependencies and subworkflows.
7. **Execution placement is part of correctness.** Some actions are inherently device-local; moving them to the cloud can change security, latency or feasibility.
8. **Verification must be separated from agent belief.** The workflow needs explicit success criteria and observable evidence.
9. **Optimization should produce proposed versions.** Silent optimization would undermine auditability and user intent.
10. **The workflow artifact is the product moat.** Generic computer-use runtimes are becoming infrastructure; the reusable, governed workflow layer is the differentiated system.

## 10. What this research does NOT imply

This literature does not prove that a universal computer agent is solved. It supports the opposite architectural decision: WorkflowOS should make unreliable agentic capabilities **bounded, replaceable execution mechanisms inside a stronger, versioned workflow system**.
