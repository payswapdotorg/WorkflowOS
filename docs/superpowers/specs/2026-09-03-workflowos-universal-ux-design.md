# WorkflowOS 2.0 — Universal Product UX Design

**Status:** Proposed product UX architecture; design approved for specification
**Date:** 2026-09-03
**Scope:** Human-facing product experience over the frozen/authorized WorkflowOS V2 architecture
**Authority boundary:** This document defines presentation, interaction, information architecture, progressive disclosure, content language, and cross-platform UX. It does not redefine Workflow, WorkflowVersion, WorkflowIR, Deployment, Run, Node, Capability, authorization, evidence, attestation, proof, or governance authorities.

## 1. Design thesis

WorkflowOS should feel like a calm personal operating layer for computer work, not an automation builder, AI chat application, developer console, or marketplace dashboard.

The user-facing product is organized around five verbs:

```text
MAKE
DO
LEARN
SHARE
IMPROVE
```

These verbs are the human expression of the underlying architecture:

- MAKE turns text, voice, demonstration, or hybrid input into a Workflow.
- DO executes an immutable WorkflowVersion through an authorized Deployment/Run path.
- LEARN derives a teaching experience from the same WorkflowVersion.
- SHARE exposes collaboration, publication, fork, installation, and commercial access.
- IMPROVE exposes optimization proposals that become explicit new WorkflowVersions.

The architecture remains universal and protocol-neutral; the UX hides architectural machinery until the user has a reason to inspect it.

## 2. Core UX principles

### 2.1 Purpose over machinery
Every primary surface should answer one of these questions:

- What can I do now?
- What is this workflow for?
- Can I run it?
- Can it teach me?
- What does it need from me?
- What happened?
- Why did it fail?
- What changed?
- Can I trust it?

Do not lead with internal object terminology such as WorkflowIR, Deployment, Node, Capability, ExecutionDigest, ExecutionAttestation, or ExecutionProofGraph.

### 2.2 Conversation is input, not information architecture
Natural-language and voice interaction are preferred when a user is creating or asking about work. Durable information is presented structurally: workflow summaries, steps, schedules, permissions, versions, outcomes, and evidence.

### 2.3 Progressive disclosure
The product exposes four levels of detail:

```text
Level 1 — DO
Run · Teach Me · Create · Schedule

Level 2 — UNDERSTAND
What it does · Where it runs · What it needs · What happened

Level 3 — CONTROL
Versions · Permissions · Triggers · Sharing · Optimization

Level 4 — INSPECT
Workflow map · IR · execution details · attestations · proof graph · API
```

A novice can remain at Levels 1–2. Advanced users, developers, administrators, and security reviewers can intentionally enter Levels 3–4.

### 2.4 Agency and forgiveness
The user remains in control of consequential actions. Before irreversible or externally visible effects, summarize what will happen and provide an explicit choice. Make recovery, undo, retry, pause, and takeover easy.

### 2.5 Honest uncertainty
The product must distinguish successful absence from unavailable information and verified completion from assertion. Never replace “we do not know” with “nothing happened” or “everything is fine.”

### 2.6 Familiar language
User-facing copy uses plain language:

- “Where it runs” rather than “Deployment placement”
- “Needs access to” rather than “Capability requirements”
- “When” rather than “Trigger definition”
- “How do we know?” rather than “Evidence model”
- “Make my own” rather than “Fork repository”
- “Update available” rather than “New WorkflowVersion”

### 2.7 Cross-platform consistency, not identical layouts
Web, desktop, iOS, Android, and cloud retain the same semantic product model while adapting navigation, input, available capabilities, and local behavior to their platforms.

## 3. Primary information architecture

The product's default navigation is intentionally small.

### Desktop

```text
WorkflowOS

Home
Workflows
Explore
Activity

Create +

Settings
Profile
```

### Mobile

```text
Home   Workflows   Search   Activity   You
```

The developer/enterprise control surface is available as an expert workspace and is not the default navigation model for ordinary users.

## 4. Home

Home answers: “What can I do right now?”

Primary content:

1. Universal creation/search entry point.
2. Recent and frequently used workflows.
3. Runs or workflows needing attention.
4. Pending approvals and version updates.
5. Device/connectivity issues that block work.
6. Small, relevant suggestions based on existing user context.

The home screen should not become a metrics dashboard. Operational depth belongs in Activity, workflow detail, and the expert workspace.

### Home primary entry

```text
What do you want to get done?

[ Describe it ]
[ Show me ]
[ Describe + show ]
```

The same surface supports search and action interpretation. Example intents:

- “invoice” → search workflows, runs, activity, and people.
- “make it run every Friday” → scheduling action.
- “why didn't the report send?” → locate the relevant run and explain its result.

## 5. Workflows library

Workflows are the user's primary durable mental model.

Suggested sections:

```text
My Workflows
Installed
Shared with me
Drafts
Archived
```

Useful contextual filters:

- Runs automatically
- Needs attention
- On this device
- Cloud
- Shared

Workflow cards should emphasize:

- human-readable name;
- purpose/description;
- current state;
- last run;
- next scheduled run where applicable;
- device/environment at a human level;
- update/attention state.

Internal identifiers and version digests are secondary details.

## 6. Workflow detail

Workflow detail is the core product screen.

Canonical hierarchy:

```text
Workflow name
Purpose
Primary actions
Status
What it does
When it runs
Where it runs
Recent activity
Version
Access & safety
More
```

Primary actions should normally be:

```text
[ Run ]   [ Teach Me ]   [ Edit ]
```

A contextual [Schedule] action appears when scheduling is available.

### Example structure

```text
Weekly Finance Report

Prepare and send the weekly finance report.

[ Run ]  [ Teach Me ]  [ Edit ]

READY
Runs automatically · Friday 4:00 PM
Runs on · Mac · preferred

WHAT IT DOES
1. Collect latest finance spreadsheet
2. Generate report
3. Review result
4. Send to Finance

RECENT ACTIVITY
✓ Completed Friday
⚠ New version available

VERSION
v3 current · v2 previous · v1 original

ACCESS & SAFETY
Spreadsheet · Email · Files
```

## 7. Creation experience

Creation starts from the goal, not from workflow primitives.

### Entry modes

```text
Tell WorkflowOS
Show WorkflowOS
Tell + Show
```

### Tell flow

The user describes the desired work. WorkflowOS asks only questions that are required to make the intended workflow materially less ambiguous.

Example:

```text
User: “Every morning, check my calendar, summarize today's meetings and send the summary to me.”

WorkflowOS:
“What time should I send it?”
“What should happen if there are no meetings?”
“Should I send automatically or ask you first?”
```

After enough information is known, present a semantic preview:

```text
Here's what I understood

Every weekday at 8:00 AM:
1. Read today's calendar
2. Summarize meetings
3. Send the summary to you

[ Create workflow ]
[ Change something ]
```

### Show flow

The user demonstrates the task while WorkflowOS records provenance.

Recording UI should be lightweight:

```text
● Recording
WorkflowOS is watching what you do.

[ Pause ]     [ Finish ]
```

After capture, WorkflowOS derives a human-readable interpretation and asks for correction before commitment.

```text
I think you showed me this:
1. Open the sales dashboard
2. Export the report
3. Rename the file
4. Upload it to Finance
5. Send a message

Anything I got wrong?

[ Review ]  [ Try workflow ]
```

Raw captures remain provenance and are never represented as the durable workflow itself.

## 8. Workflow editing

Default editing is semantic and step-oriented.

```text
STEP 1
Open the sales dashboard

STEP 2
Export the report

STEP 3
Rename the file

STEP 4
Upload it to Finance
```

Each step supports contextual editing, insertion, deletion, conditions, approvals, or placement where the WorkflowIR permits them.

A graph/map editor exists as an Advanced view. It is not the default editing surface.

### Advanced workflow map

Advanced users can inspect:

- control flow;
- data flow;
- dependencies;
- parallel branches;
- execution class;
- capability requirements;
- placement;
- human approval points.

The visual map is an inspection/control surface over WorkflowIR, never a second workflow format.

## 9. Run experience

The primary execution verb is “Run.”

Before consequential execution, show a concise execution preview when needed:

```text
Run Weekly Finance Report?

This will:
• read the Finance spreadsheet
• create the report
• send it to Finance

Runs on: Mac
Version: 3
Approval: required before sending

[ Cancel ]  [ Run ]
```

Do not expose internal authorization vocabulary unless the user explicitly opens details.

## 10. Where it runs

Replace deployment/node terminology with a simple chooser:

```text
Where should this run?

✓ This Mac
  Available · preferred

○ iPhone
  Missing required access

○ Cloud
  Available

[ Use recommended ]
```

Unavailable capability, failed health, locality constraints, authorization conflicts, and trust restrictions are presented as explicit human-readable reasons.

The product must never imply an unsupported platform can perform an action.

## 11. Scheduling and event triggers

The primary trigger vocabulary is:

```text
When
```

Choices:

```text
Run now
At a time
On a schedule
When something happens
After another workflow
```

Examples:

- “Every weekday at 8 AM.”
- “When Mom calls.”
- “When the monthly report changes.”
- “When my post reaches 100,000 likes.”

Advanced trigger controls can expose deduplication, missed windows, timezone behavior, event identity, and placement when required by the user's intent or troubleshooting context.

## 12. Teach Me

Teach Me is a first-class workflow action, adjacent to Run.

Teaching is always visibly tied to the installed immutable WorkflowVersion.

Entry:

```text
Weekly Finance Report

[ Run ]       [ Teach Me ]
```

Lesson opening:

```text
You'll learn:
How to prepare the weekly finance report.

Estimated time: 8 minutes

You will practice:
✓ finding the report
✓ checking totals
✓ sending the final version

[ Start lesson ]
```

A lesson step should distinguish explanation, demonstration, learner action, checkpoint, and outcome.

```text
Step 2 of 5

Check that “Net Revenue” matches the monthly ledger.

Why this matters
This catches reporting errors before the report is sent.

Your turn.

[ I've done it ]
[ Show me again ]
[ I don't understand ]
```

Teaching evidence and execution evidence remain separate in the UI and data model.

## 13. Reverse teaching

For a workflow the user installed but does not understand:

```text
Install → Teach Me → Practice → Completion
```

The UI must make three things explicit:

1. what the workflow guarantees;
2. what the human still needs to decide;
3. what the workflow does not contain enough information to teach.

The product must disclose missing information instead of inventing procedural facts.

## 14. Permissions and safety

Use “Needs access to” as the default user-facing concept.

```text
This workflow needs access to:

Files
Read reports

Calendar
Read today's events

Messages
Send messages to Finance Team
```

For each sensitive capability, explain why it is needed in the current context. Avoid requesting unrelated permissions just because the platform makes them available.

A capability being available on a device must never be presented as permission to use it.

High-consequence actions should receive a concise pre-action explanation or confirmation:

```text
This workflow is about to publish publicly.

[ Cancel ]  [ Continue ]
```

## 15. Execution status language

Primary states should use a small human vocabulary:

```text
Ready
Running
Waiting for you
Paused
Needs attention
Completed
Couldn't complete
Unavailable
```

Internal run-state terminology is shown only in Advanced details.

## 16. Execution history and Activity

Activity is the universal timeline for executions, approvals, updates, device events, and relevant workflow changes.

```text
Today

✓ Weekly report
Completed · 9:02 AM · Mac

⚠ Website automation
Needs you · 8:51 AM

✓ Backup
Completed · 3:05 AM · Cloud
```

Filters:

```text
All · Needs me · Completed · Failed · Shared
```

Search and direct links must allow a user to reach the related Workflow and Run.

## 17. Trust and “How do you know?”

A completed run should expose a simple explanation before advanced evidence.

```text
✓ Completed

How do you know?

✓ Report created
✓ File uploaded
✓ Message accepted by mail service

Verified by
Mail service response
File observation
Execution record
```

An Advanced verification view can expose:

- execution statement;
- digest;
- attestation;
- assurance level;
- causal parents;
- freshness;
- verifier result;
- proof graph.

The UI must never imply that a cryptographic signature alone proves a physical side effect.

## 18. Failure and recovery UX

Failures should answer:

1. What was attempted?
2. What is known to have happened?
3. What is unknown?
4. What can the user do next?

Example:

```text
I couldn't finish this.

I opened the report, but the website had changed.

What I know:
✓ The report opened
✓ The download started
✕ The file could not be located

[ Take over ]
[ Try again ]
[ Edit workflow ]
[ Stop ]
```

Never show a failed authority read as an empty successful result.

Human takeover should preserve the existing Run and return control cleanly to the user.

## 19. Versioning and updates

Versioning is primarily a trust feature, not a repository feature.

When a newer version exists:

```text
An update is available

Weekly Finance Report · v3

What changed
• More reliable spreadsheet detection
• Faster report creation
• New approval before sending

Your installed version
v2

Nothing changes until you approve the update.

[ Review ]
```

Installed versions remain visibly stable until adoption. Historical versions remain addressable and inspectable.

## 20. Optimization UX

Optimization appears as recommendations, not as technical configuration.

```text
WorkflowOS found 3 improvements

Make it faster
42 sec → 11 sec

Make it more reliable
Browser automation → direct service API

Reduce cost
Estimated saving: 34%
```

Each proposal explains what changed, why it is expected to preserve semantics, and what trade-offs exist.

Optimizations always become explicit new WorkflowVersions. They never silently mutate an installed version.

## 21. Sharing and collaboration

Use human terms:

```text
Share
Make my own
Review
Publish
```

Sharing controls should express who can use or edit the workflow without exposing internal repository permissions.

Fork flow:

```text
Create your own version of:
Weekly Finance Report

Original by Acme Automation

Your copy will:
✓ have its own versions
✓ keep original attribution
✓ not receive the publisher's private data
✓ not receive the publisher's secrets

[ Create copy ]
```

## 22. Marketplace / Explore

Marketplace listings should resemble trustworthy software/product discovery rather than enterprise procurement forms.

A listing should summarize:

- what the workflow does;
- publisher identity;
- price/commercial model;
- compatible platforms/environments;
- required access;
- security/effect profile;
- available evidence/tests;
- current version;
- maintenance policy.

Example:

```text
Weekly Social Media Report

By Acme Automation
★★★★★

Automatically creates and sends your weekly social report.

$19

Works with
✓ Browser
✓ Spreadsheet
✓ Email

Needs access to
• Social accounts
• Spreadsheet
• Email

Version 3
Publisher verified
Tests available

Maintenance
$5/month

[ Get workflow ]
```

Publication, reviews, ranking, and sales must never be visually conflated with execution authorization or execution proof.

## 23. Commerce and installation

The UI must preserve the domain distinction:

```text
Purchase
  ↓
Access
  ↓
Install
  ↓
Choose where/how it runs
  ↓
Execute subject to policy
```

Never use “Purchased and activated” when installation and execution authorization remain separate.

After purchase:

```text
You're entitled to this workflow.

Next: Install version 3

[ Install ]
```

## 24. Device management

Devices are a secondary settings concept.

```text
Devices

MacBook Pro
✓ Connected
Can run 43 workflows

iPhone
✓ Connected
Can run 17 workflows

Cloud
✓ Connected
Can run 58 workflows
```

A device detail page should show what access WorkflowOS has:

```text
Allowed
✓ Files
✓ Browser
✓ Calendar

Ask before using
• Messages
• Microphone

Blocked
• Location
```

Device capability and user authorization remain distinct.

## 25. Advanced / Developer workspace

The current engineering control surface remains valuable but should be framed as an expert workspace.

Advanced navigation may include:

```text
Workbench
Architecture
Workflow map
Runs
Verification
Deployments
Health
Governance
Integrations
```

The current Workbench's rich read model, including work graph, executions, changes, verification, reviews, deployments, health, and activity, should remain accessible here rather than becoming the ordinary user's default product model.

The expert workspace must remain a consumer of backend authorities, not a second authority.

## 26. Global search

Search should span:

- workflows;
- workflow versions;
- runs;
- activity;
- people/teams where authorized;
- devices;
- marketplace listings;
- actions that can be inferred from the query.

Search examples:

```text
“invoice”
→ workflows, runs, people, activity

“show my failed runs”
→ activity/run query

“run the social report”
→ action intent

“make it run every Friday”
→ schedule intent
```

Search should support recent searches, suggestions, filters, and scoped results without making users understand the underlying data model.

## 27. Visual language

The visual system should be calm, spacious, legible, and state-oriented.

- Use hierarchy, spacing, typography, and contrast before decorative styling.
- Use color primarily to communicate state, severity, selection, and attention.
- Use motion for state transitions, progress, handoff, and feedback rather than decoration.
- Avoid neon “AI” treatments, dense dashboard chrome, or graph-first visuals in primary flows.
- Use familiar controls and predictable placement across platforms.
- Support dark mode, dynamic text sizing, keyboard navigation, touch, voice, and screen readers.

## 28. Copy principles

Primary copy should be:

- concise;
- human;
- concrete;
- non-technical unless the user is in Advanced mode;
- explicit about uncertainty and consequences.

Prefer:

“Couldn’t finish — the website changed.”

Over:

“Agentic computer-use execution encountered a capability grounding exception.”

Prefer:

“Your workflow is still using version 2.”

Over:

“Deployment remains pinned to WorkflowVersion 2.”

## 29. Architecture translation dictionary

| Internal concept | Primary UX language |
|---|---|
| Workflow | Workflow |
| WorkflowVersion | Version |
| WorkflowIR | Workflow map / Advanced |
| Deployment | Where it runs |
| Node | Device / Computer |
| Capability | What it can access/do |
| Authorization | Permission |
| Consent | Ask before… |
| Placement | Where it runs |
| Trigger | When |
| WorkflowRun | Run |
| Evidence | How we know |
| Verification | Verified |
| ExecutionAttestation | Advanced verification |
| ExecutionProofGraph | Evidence trail |
| TeachingSession | Lesson |
| Fork | Make my own |
| Entitlement | Access |
| Listing | Workflow page |
| Optimization proposal | Improvement |
| Maintenance update | Update available |
| Subworkflow | Uses another workflow |

## 30. Functional coverage guarantee

The UX must expose all V2 product capabilities without making all capabilities primary navigation items.

The covered capability domains are:

- authoring by text, voice, demonstration, or hybrid;
- semantic workflow editing;
- manual execution;
- scheduled execution;
- event-triggered execution;
- web automation;
- desktop automation;
- mobile actions;
- spreadsheet actions;
- messaging and contacts;
- calling;
- notifications and sensors where authorized;
- social observation/publication;
- multi-device execution;
- cloud execution;
- human approval and human takeover;
- execution history;
- evidence and verification;
- cryptographic execution attestation and proof inspection;
- teaching;
- reverse teaching;
- optimization proposals;
- versions and explicit updates;
- sharing and collaboration;
- forks and provenance;
- marketplace discovery;
- one-time purchase;
- maintenance subscriptions;
- installation and version pinning;
- device management;
- self-hosted/first-party workflows;
- expert developer/governance surfaces.

## 31. Non-negotiable architecture constraints for UX implementation

1. UX never becomes an execution authority.
2. UX state never outranks backend authoritative state.
3. A missing/error response must not render as a successful empty state.
4. A model claim must not be displayed as verified evidence.
5. A signature or digest must not be displayed as automatic proof of physical side effects.
6. Capability availability must never be presented as authorization.
7. Marketplace purchase/entitlement must never be presented as execution permission.
8. Installed WorkflowVersions must never appear to change silently.
9. Unsupported platform capabilities must never be hidden by simulated success.
10. Teaching must never mutate WorkflowVersion implicitly.
11. Advanced surfaces must consume the same underlying authorities and protocol.
12. UX terminology may simplify presentation but must not redefine semantics.

## 32. Acceptance criteria

A UX implementation conforming to this specification must demonstrate:

- a five-verb mental model (Make, Do, Learn, Share, Improve);
- four primary navigation areas (Home, Workflows, Explore, Activity) plus settings/profile;
- creation from text, voice, demonstration, and hybrid input;
- primary Run and Teach Me flows;
- structured scheduling/event creation in human language;
- readable placement/device selection;
- contextual permission and safety explanations;
- trustworthy success, failure, unavailable, paused, and takeover states;
- explicit version-update adoption;
- optimization proposals as new versions;
- marketplace discovery and purchase-to-install flow without execution-authority confusion;
- human-readable trust/evidence detail with Advanced verification;
- global search over product content and action intents;
- expert workspace access without exposing expert concepts as default navigation;
- cross-platform semantic consistency with platform-appropriate UX;
- accessibility across visual, touch, keyboard, speech, and assistive technology inputs;
- no architectural authority drift.

## 33. Source rationale

This UX direction is deliberately aligned with Apple's June 2026 Human Interface Guidelines and design-principle framing: purpose, agency, responsibility, familiarity, flexibility, simplicity, craft, and delight. Apple's current guidance emphasizes concise, clear interfaces, familiar and consistent interactions, user control, meaningful feedback, progressive access to complexity, and accessibility across ways of perceiving and interacting. The WorkflowOS design adopts those principles while remaining grounded in the repository's frozen V2 semantics.
