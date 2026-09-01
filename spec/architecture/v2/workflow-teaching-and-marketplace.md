# WorkflowOS 2.0 — Workflow Teaching, Reverse Teaching, Collaboration and Marketplace

**Status:** PROPOSED / normative V2 design

## Core idea

A Workflow is both an automation artifact and a reusable unit of procedural knowledge.

It has two symmetric modes:

```text
AUTOMATE ME
  user installs workflow → workflow executes the task

TEACH ME
  user installs workflow → WorkflowOS derives a lesson → human performs/practices task
```

The teaching representation is derived from the immutable WorkflowVersion and its verified semantics. It is not a second workflow format or execution authority.

## Authoring modes

A workflow may originate from:

- text instructions;
- voice instructions;
- direct demonstration on a computer/device;
- a hybrid of all three.

All authoring modes compile toward the same WorkflowIR. Raw teaching traces remain provenance and are never treated as executable semantics by themselves.

## Resumable teaching sessions

`TeachingSession` is a first-class resumable artifact bound to a WorkflowVersion. It retains current step, learner state, unresolved questions, confirmations, and teaching evidence. A session may pause and resume without mutating the WorkflowVersion.

## Reverse teaching

When a user does not know how to perform a task:

```text
find workflow
  ↓
install workflow version
  ↓
Teach Me
  ↓
derive lesson from workflow semantics
  ↓
show prerequisites / steps / decision points / expected outcomes
  ↓
human practices the task
```

The system must clearly distinguish:

- what the workflow guarantees;
- what the workflow expects the human to decide;
- what the workflow cannot teach because information is unavailable.

The system must not invent procedural facts that are not present in the workflow or evidence.

## Teaching and execution evidence

Teaching evidence and execution evidence are different evidence classes. A learner completing a lesson does not create an execution record, and an execution result does not prove that the learner can perform the task independently.

## Workflow repositories

A WorkflowRepository is Git-like:

- public/private visibility;
- owner and organization permissions;
- collaboration;
- immutable version history;
- branches and forks where supported;
- provenance from source workflow/version;
- review and publication metadata.

Forking creates a new Workflow identity and preserves provenance to the source. It does not give the fork access to source secrets, deployments, or private data.

## Publishing and installation

Publishing makes a chosen immutable WorkflowVersion available for installation. Installation pins a specific version. Updating an installation is an explicit version transition; an upstream publisher cannot silently mutate an installed version.

## Marketplace economics

Supported commercial models:

- free;
- one-time purchase;
- maintenance subscription.

Future licensing models may be added through a governed V2 architecture change.

### Entitlement boundary

```text
purchase/subscription
        ↓
     entitlement
        ↓
      install
        ↓
 workflow execution
```

An entitlement grants access to workflow content/version updates according to its commercial terms. It never grants execution authority beyond the installation's own policy and node capabilities.

### Maintenance subscriptions

A maintenance subscription may entitle the customer to publisher-provided compatible updates, support or maintenance releases. The installed customer deployment remains pinned until the customer or an explicitly configured update policy accepts a new WorkflowVersion.

A publisher cannot use maintenance access to retrieve customer secrets, customer private workflow state, or customer execution data except through explicitly authorized product contracts.

### One-time purchases

A one-time purchase entitles the customer to the purchased version and whatever update rights were explicitly part of that product. The original version remains immutable and executable subject to its compatibility and security policy.

### Payment provider isolation

The workflow domain contains no provider-specific payment objects. Payment processors are adapter concerns behind a commercial entitlement boundary. The workflow itself never receives raw payment credentials.

## Marketplace trust

Published workflows expose machine-readable metadata:

- publisher identity;
- version and digest;
- required capabilities;
- data scopes;
- placement requirements;
- security/effect profile;
- dependencies;
- tests/evidence available;
- commercial terms;
- maintenance/update policy.

The marketplace must never imply that publication equals trust, verification, or authorization. Customers retain authority to inspect and approve installation requirements.

## Optimization relationship

A marketplace workflow can receive an optimization proposal just like a private workflow. Optimization creates a proposed new version; it never mutates a purchased/installed version in place.

## Forbidden drift

No implementation may:

- create a second workflow format for teaching;
- equate a recorded screen video with the executable workflow;
- let publishers mutate installed versions silently;
- let purchasing bypass capability or authorization checks;
- leak secrets to publishers;
- put payment-provider semantics into WorkflowIR;
- make marketplace ranking an execution authority;
- make teaching sessions mutate workflow definitions implicitly.
