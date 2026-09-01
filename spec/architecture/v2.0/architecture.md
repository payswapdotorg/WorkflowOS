# WorkflowOS 2.0 — Detailed Architecture

## 1. Purpose and architectural generation

WorkflowOS 2.0 changes the top-level product abstraction from a governed software-change system into a **universal workflow operating system**.

The product allows a person to teach a repeatable computer operation by describing it, demonstrating it, or combining both. WorkflowOS converts that teaching session into a structured, versioned, executable workflow. The workflow can subsequently be installed, triggered, scheduled, executed, verified, optimized, collaborated on, forked, and shared.

v2.0 is a **new architecture generation**. It must not silently mutate frozen v1.0 semantics. Proven v1.x primitives may be reused through explicit compatibility boundaries, but v2.0 contracts own the new workflow layer.

The central rule is:

> **The workflow artifact is above the agent. The agent is an execution mechanism inside a workflow, not the workflow itself.**

## 2. Architecture at a glance

```text
                                  WORKFLOWOS 2.0

 ┌────────────────────────────────────────────────────────────────────┐
 │                         Workflow Repository                        │
 │  identity · versions · collaboration · dependencies · policies    │
 └────────────────────────────────┬───────────────────────────────────┘
                                  │
                           Workflow Version
                                  │
                       ┌──────────┴──────────┐
                       │                     │
                 Authoring Layer       Workflow Compiler
                       │                     │
          ┌────────────┼────────────┐       │
          │            │            │       ↓
        Text         Voice     Demonstration Workflow IR
          │            │            │       │
          └────────────┼────────────┘       │
                       └──────────┬─────────┘
                                  │
                           Compiled Workflow
                                  │
               ┌──────────────────┼──────────────────┐
               │                  │                  │
         Deterministic        Agentic            Human
         / API actions     computer-use steps     steps
               │                  │                  │
               └──────────────────┼──────────────────┘
                                  │
                           Execution Runtime
                                  │
                ┌─────────────────┼─────────────────┐
                │                 │                 │
             Web node        Desktop node      Mobile node
                │                 │                 │
                └─────────────────┼─────────────────┘
                                  │
                            Cloud runners
                                  │
                                  ↓
                         Evidence / Verification
                                  │
                                  ↓
                         Optimization Engine
                                  │
                                  ↓
                         Proposed Workflow Version
```

## 3. The four primary artifacts

### 3.1 Workflow

A stable identity and collaboration container.

Minimum semantics:

```text
WorkflowId
owner/organization
name
visibility
repository metadata
createdAt
updatedAt
defaultVersion
```

A Workflow has no mutable executable content. Executable content lives in versions.

### 3.2 WorkflowVersion

An immutable snapshot of the executable workflow.

It contains:

```text
WorkflowVersionId
WorkflowId
parentVersionId
sourceProvenance
workflowIR
inputSchema
outputSchema
requiredCapabilities
executionPolicy
dependencies
tests
optimization lineage
createdAt
```

An execution always references an exact version.

### 3.3 WorkflowDeployment

An installation of a specific workflow version onto an execution target under a particular capability/policy context.

Examples:

```text
Workflow: Weekly Finance Report
Version: 7
Deployment: Alice's Mac
Trigger: Monday 08:00
```

or:

```text
Workflow: Handle Mom Calls
Version: 3
Deployment: Alice's iPhone
Trigger: phone.call.received
```

Deployment binds the version to concrete resources without changing the version.

### 3.4 WorkflowRun

One execution instance.

Minimum identity:

```text
WorkflowRunId
WorkflowId
WorkflowVersionId
WorkflowDeploymentId
TriggerEventId
ExecutionContextId
StartedAt
CompletedAt
Status
```

Every step execution must be traceable to this run and its version.

## 4. Workflow Repository model

A Workflow Repository is intentionally modeled after a software repository while remaining workflow-native.

Conceptual contents:

```text
workflow.yaml
README.md
versions/
tests/
demonstrations/
assets/
connectors/
policies/
optimization/
evidence/
```

Collaboration operations:

```text
fork
branch
commit
version
review
merge
publish
install
update
rollback
pin dependency
```

Public/private visibility is a repository property. Organization-owned workflows may use organizational permissions and review rules.

## 5. Workflow IR

The Workflow IR is the canonical executable representation. It is a **semantic intermediate representation**, not a recording of low-level GUI events.

A step has a stable identity and a semantic contract.

```text
WorkflowStep
  id
  kind
  intent
  inputs
  outputs
  preconditions
  postconditions
  requiredCapabilities
  placement
  effectPolicy
  executionStrategy
  retryPolicy
  evidencePolicy
  humanApprovalPolicy
  dependencies
```

Step kinds include:

```text
action.deterministic
action.api
action.computer
action.human
decision
condition
subworkflow
parallel
wait
emit-event
```

GUI details are implementation evidence and grounding inputs, not the semantic workflow itself.

## 6. Deterministic vs. agentic vs. human execution

A workflow may mix three fundamentally different mechanisms.

### Deterministic/API

Use for actions whose semantics are known and mechanically executable.

Examples:

```text
HTTP API
SQL operation through an approved connector
spreadsheet formula
file transform
GitHub API
CRM mutation
```

### Agentic/computer-use

Use when contextual reasoning or interaction with an unstructured interface is required.

Examples:

```text
Find the relevant support ticket.
Navigate an unfamiliar portal.
Determine which attachment is the newest invoice.
Complete a UI flow where the stable API is unavailable.
```

The computer agent is constrained by the workflow's declared capabilities and effect policy.

### Human

Use for missing information, deliberate approvals, high-risk actions, or explicit pauses.

Examples:

```text
Approve payment.
Choose the customer account.
Provide MFA.
Resolve an ambiguity.
```

## 7. Universal node and capability protocol

All WorkflowOS apps and runtimes use the same protocol.

Products:

```text
Web
Desktop
iOS
Android
Cloud Runner
```

are protocol clients/hosts, not separate workflow semantics.

A node advertises a versioned capability descriptor.

Example:

```yaml
node:
  id: iphone-123
  platform: ios
  protocolVersion: 2
  capabilities:
    - screen.capture
    - ui.inspect
    - ui.tap
    - ui.type
    - notifications.receive
    - calls.observe
    - calls.answer
    - messages.read
    - messages.send
    - contacts.search
```

Capabilities are the runtime's contract. A workflow requests capabilities; the runtime selects a compatible node.

The protocol must permit a platform to expose fewer capabilities than another platform while keeping workflow semantics identical.

## 8. Capability contract

Each capability should define:

```text
CapabilityId
version
inputSchema
outputSchema
sideEffectClass
requiredPermissions
supportedPlatforms
requiredLocality
securityClass
```

Capability resolution must be explicit and fail closed.

No provider may silently substitute an incompatible implementation.

A computer-control provider failure produces an unavailable/error result rather than secretly switching providers.

This follows the capability/provider discipline observed in OpenClaw. OpenClaw requires connected nodes to advertise the computer-control capabilities required by the tool and deliberately avoids per-action provider fallback. See its current computer-use and node capability documentation. (https://docs.openclaw.ai/nodes/computer-use, https://github.com/openclaw/openclaw/blob/main/docs/nodes/index.md)

## 9. Event protocol

Events are first-class protocol objects.

```text
Event
  id
  type
  source
  occurredAt
  actor
  scope
  payload
  provenance
```

Trigger = event pattern + conditions + deduplication semantics.

Event categories include:

```text
manual
schedule
webhook
application
file
email
message
phone
calendar
notification
social-metric
workflow
system
```

Threshold triggers represent **crossing a threshold**, not repeatedly observing a state above a threshold.

For example:

```yaml
trigger:
  event: social.post.metrics.changed
  condition:
    likes:
      crosses: 100000
```

## 10. Mobile execution

Mobile workflows use exactly the same protocol but may request mobile-only capabilities.

Examples:

```text
phone.call.received
phone.call.answer
messages.read
messages.send
contacts.search
camera.capture
microphone.capture
location.read
notifications.receive
mobile.ui.inspect
mobile.ui.tap
```

A mobile workflow can therefore be:

```text
trigger: incoming call
condition: caller == Mom
action: answer call
action: speak message
```

A workflow may also use hybrid locality:

```text
phone event
    ↓
local deterministic condition
    ↓
cloud reasoning
    ↓
phone-local action
```

The protocol itself is platform-neutral; capability availability and OS permissions are platform-specific.

Android-specific automation must respect OS controls such as AccessibilityService and telephony/default-dialer requirements. iOS execution must respect Apple's approved automation/application mechanisms. The architecture therefore models capabilities and required permissions rather than promising identical low-level control across operating systems.

## 11. Execution locality

Placement is a first-class contract.

Allowed values:

```text
device-required
device-preferred
cloud-required
cloud-preferred
any
```

A workflow can declare defaults while individual steps override placement.

Example:

```yaml
workflow:
  placement: any

steps:
  - id: answer-call
    placement: device-required
  - id: summarize
    placement: cloud-preferred
  - id: write-local-file
    placement: device-preferred
```

The runtime must never move work across a locality boundary when the workflow policy forbids it.

## 12. Authoring system

WorkflowOS has one authoring model with multiple input modalities.

### Text

The user describes the procedure in natural language.

### Voice

Speech is transcribed into the same authoring context as text.

### Demonstration

The system records a synchronized teaching trace:

```text
screen frames
accessibility tree / semantic UI tree
mouse/touch/keyboard events
application/window identity
clipboard events where permitted
navigation/application transitions
voice narration
user annotations
timestamps
```

### Hybrid

The user can switch between narration, voice, and demonstration at any point.

## 13. Pausable workflow teaching

Authoring is itself a durable Draft Session.

A Draft Session stores:

```text
workflow draft
current authoring cursor
transcript
recording references
inferred steps
uncertainties
open questions
assets
compiler state
```

The user may stop at any point and resume later without losing semantic context.

The system must distinguish:

```text
raw teaching trace
semantic workflow draft
compiled workflow version
```

These are separate artifacts with lineage between them.

## 14. Compilation from demonstration

Compilation should proceed through explicit stages.

```text
TeachingTrace
   ↓
segmentation
   ↓
semantic action extraction
   ↓
intent inference
   ↓
state/precondition/postcondition inference
   ↓
capability resolution
   ↓
workflow IR
   ↓
validation
   ↓
workflow version candidate
```

The compiler must preserve uncertainty rather than fabricate certainty.

When it cannot determine a safe semantic step, it should surface an authoring question or produce a human step.

## 15. Workflow optimization engine

The optimizer analyzes an existing workflow without silently mutating it.

Optimization classes:

```text
existing-workflow substitution
API substitution
connector substitution
parallelism
reliability
security
latency
cost
locality
human-intervention reduction
```

Example:

```text
Current implementation:
  8 Excel UI actions

Proposal:
  replace with Excel/Graph API connector

Expected effect:
  lower latency
  fewer grounding failures
  lower agent cost
```

Another example:

```text
Current:
  custom invoice parsing

Proposal:
  reuse finance/invoice-extraction@3.2
```

Optimization produces a **proposed WorkflowVersion diff**. The user/workflow reviewers decide whether it becomes the next version.

## 16. Subworkflow and dependency model

A workflow can invoke another workflow version explicitly.

```text
Client Onboarding
  ├─ crm/customer-create@2.1
  ├─ wordpress/site-create@3.2
  ├─ analytics/setup@2.4
  └─ finance/welcome-email@1.8
```

Dependencies must include:

```text
workflow identity
version constraint
required capabilities
input/output compatibility
policy compatibility
```

The optimizer may suggest an existing workflow dependency but must never substitute it silently.

## 17. Scheduling

Scheduling belongs to WorkflowDeployment/Trigger, not the workflow's semantic core.

Supported scheduling:

```text
one-shot
time-of-day
interval
calendar recurrence
cron expression
external event
```

A scheduled deployment binds:

```text
workflow version
execution placement
model/provider policy where relevant
trigger
next execution state
```

Unattended jobs must pin or deliberately inherit model/provider configuration. Silent drift to a different paid provider/model is prohibited.

Hermes already demonstrates the practical utility of natural-language scheduling, recurring jobs, pause/resume/edit/trigger operations and provider/model drift guards. WorkflowOS adopts these ideas while making the schedule a deployment/trigger concern over an immutable workflow artifact. See the Hermes cron documentation. (https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/)

## 18. Version control and video-like editing

Workflow versions are immutable.

Users see workflows as a timeline/storyboard by default, not as raw graph JSON.

Example:

```text
00:00  Open Shopify
00:12  Find last week's orders
00:31  Export orders
00:52  Update finance sheet
01:23  Calculate VAT
01:46  Send report
```

A user can select a timeline segment and request a change:

```text
Replace this section with the Shopify API.
```

The compiler produces a candidate next version and a semantic diff.

Graph view remains available to advanced users.

## 19. Collaboration and governance

Workflow repositories support:

```text
owners
collaborators
reviewers
public/private visibility
forks
branches
merge requests
version releases
installation permissions
```

Consequential capability usage remains governed by workflow policies, deployment policy, and user authorization.

A workflow cannot broaden its own permissions.

## 20. Security and policy

Every workflow/deployment has a policy ceiling.

Policy controls may cover:

```text
allowed capabilities
allowed data scopes
allowed devices
allowed execution locations
maximum side-effect class
approval requirements
credential bindings
time windows
recipient restrictions
```

High-impact capabilities such as sending messages, making financial changes, deleting data, answering calls, or changing production infrastructure must be explicitly declared and may require human approval.

Secrets are referenced by bindings, never embedded in workflow source or teaching traces.

## 21. Verification and evidence

Every workflow run produces structured execution evidence:

```text
WorkflowVersion
Deployment
Node
TriggerEvent
Step
Capability
Inputs/outputs where permitted
Observed state
Result
Error
Timestamp
```

Workflow verification asks whether the workflow achieved its declared postconditions.

Computer-agent confidence is not itself proof of success.

The system must distinguish:

```text
agent belief
observed fact
deterministic verification
human confirmation
```

This reuses the strongest provenance principles from WorkflowOS 1.x.

## 22. Failure semantics

Failure must be explicit and typed.

Representative outcomes:

```text
blocked_capability
permission_denied
placement_unavailable
agent_error
action_failed
postcondition_failed
human_required
timeout
policy_violation
workflow_dependency_unavailable
verification_failed
```

No failure may silently become success.

No optimizer may silently replace a failed step with a different side-effecting strategy unless the policy permits the alternative and the replacement is part of an explicitly accepted workflow version.

## 23. Universal protocol contract

The protocol should expose a small stable envelope for all surfaces.

Conceptually:

```text
WorkflowRepositoryService
WorkflowVersionService
WorkflowCompilationService
WorkflowDeploymentService
WorkflowRunService
NodeRegistryService
CapabilityRegistryService
EventService
VerificationService
OptimizationService
PolicyService
```

All clients speak the same wire contract.

Web, desktop, mobile and cloud runners may expose richer UX, but the underlying commands, events, IDs, version semantics, evidence model and capability declarations remain shared.

## 24. Product surfaces

### Web

Best for:

```text
workflow discovery
repository management
visual editing
collaboration
review
analytics
scheduling
cloud deployments
```

### Desktop

Best for:

```text
local automation
native applications
filesystem
browser
office software
local credentials
local demonstrations
```

### Mobile

Best for:

```text
phone-native workflows
calls
messages
notifications
camera
location
mobile demonstrations
mobile-local event triggers
```

### Cloud

Best for:

```text
unattended schedules
always-on workflows
heavy computation
server APIs
browser sandboxes
cross-user organization workflows
```

These are presentation/execution specializations of one protocol—not separate workflow products.

## 25. Software-engineering workflows

Existing WorkflowOS software-engineering automation becomes a normal workflow family in v2.0.

Example:

```text
software/build-product

inputs:
  productDescription

subworkflows:
  repository-analysis
  architecture-design
  implementation
  verification
  browser-validation
  review
  deployment
```

The existing v1.x development/governance machinery becomes one of the most sophisticated workflow packages rather than the definition of WorkflowOS itself.

## 26. Migration strategy from v1.x

Do **not** rewrite v1.x in place.

Instead:

```text
v1.x proven kernel
      ↓
compatibility adapters
      ↓
v2 workflow protocol
```

Candidate reused primitives include:

```text
identity/authentication
authorization
provenance
verification/evidence
execution policy
architecture governance
repository integrations
agent execution abstractions
```

The v2 workflow layer must not duplicate these authorities.

## 27. Phased implementation architecture

The 2.0 implementation should be decomposed into governed Work Orders in this order:

```text
V2-001  Universal Workflow Protocol
V2-002  Workflow Repository + immutable Version model
V2-003  Workflow IR
V2-004  Node + Capability protocol
V2-005  Workflow Run + Evidence model
V2-006  Text/Voice authoring
V2-007  Demonstration capture + semantic compilation
V2-008  Deterministic/API execution
V2-009  Computer-agent execution
V2-010  Human-step execution
V2-011  Deployment + locality
V2-012  Event triggers + scheduling
V2-013  Workflow dependencies/subworkflows
V2-014  Collaboration/forking/review
V2-015  Optimization engine
V2-016  Web application
V2-017  Desktop node
V2-018  Android node
V2-019  iOS node
V2-020  Cloud runner
V2-021  Workflow marketplace/public registry
V2-022  Migration adapters for selected v1.x capabilities
```

The dependency graph must be generated from these Work Orders rather than implied by implementation order.

## 28. Non-negotiable invariants

1. WorkflowVersion is immutable.
2. WorkflowRun references an exact WorkflowVersion.
3. A computer agent is an execution mechanism, never the workflow authority.
4. GUI recordings are provenance, not the semantic workflow definition.
5. Web/desktop/mobile/cloud use one protocol.
6. Nodes advertise capabilities; workflows request capabilities.
7. Capability resolution is fail closed.
8. Provider selection never silently falls back across incompatible providers.
9. Locality policy cannot be silently violated.
10. Secrets are referenced through secure bindings, never embedded in workflows.
11. Optimization proposes a new version; it never silently mutates the current version.
12. Existing workflows are reusable dependencies with explicit version constraints.
13. Event triggers have explicit deduplication semantics.
14. Threshold triggers fire on threshold crossings, not repeated observations.
15. Deterministic/API execution is preferred when semantically equivalent and policy-compatible.
16. Agent confidence is never treated as verification evidence.
17. Every consequential execution is attributable to WorkflowVersion + Deployment + Run.
18. Failure cannot silently become success.
19. Platform capability differences are represented explicitly rather than hidden.
20. v1.0 frozen authorities remain authoritative until an explicit v2 compatibility boundary replaces them.

## 29. Architecture decision: why a new generation

An in-place refactor would couple the new universal workflow protocol to the existing software-development-specific concepts and create unnecessary migration risk. A separate v2 generation provides a clean semantic boundary while allowing reuse of the v1.x kernel.

The goal is therefore **reuse without inheritance of the old top-level abstraction**.
