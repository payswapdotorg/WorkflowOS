# WorkflowOS 2.0 — Architecture Constitution

**Status:** PROPOSED / implementation-authorized V2 constitution  
**Precedence:** This document governs interpretation of all V2 Work Orders while V2 remains proposed. Implementation is authorized by `V2-CTRL-000`; formal V2 freezing remains a separate governed architecture-version decision.
**Canonical protocol registry:** `V2-CTRL-003-protocol-registry.md` + `V2-CTRL-003-protocol-registry.json`

## 1. Product thesis

WorkflowOS turns how people work with computers into reusable, executable, versioned software.

A person can:

- describe a procedure with text;
- describe it with voice;
- demonstrate it on a computer or device;
- combine description and demonstration;
- pause and resume teaching at any point;
- install an existing workflow and execute it;
- install an existing workflow and ask WorkflowOS to teach the person how to do it manually;
- edit, fork, collaborate on, publish and share workflows;
- schedule workflows or trigger them from supported events;
- execute on web, desktop, iOS, Android or cloud hosts according to capability and placement;
- receive optimization proposals that become explicit new versions;
- buy workflows once or subscribe to publisher maintenance.

## 2. Primary artifact hierarchy

The canonical object hierarchy is:

```text
WorkflowRepository
  └── Workflow
       ├── immutable WorkflowVersion
       │    └── WorkflowIR
       └── WorkflowDeployment
              └── WorkflowRun
```

Definitions:

- `Workflow` = durable identity, repository/collaboration scope and public/private identity.
- `WorkflowVersion` = immutable executable meaning.
- `WorkflowIR` = platform-neutral semantic representation of one version.
- `WorkflowDeployment` = explicit binding of a version to execution placement and policy.
- `WorkflowRun` = one execution instance of one pinned deployment/version.

Nothing below this hierarchy may redefine these concepts.

## 3. Semantic source of truth

The semantic source of a workflow is the immutable WorkflowIR contained by its WorkflowVersion.

The following are NOT equivalent to WorkflowIR:

- a prompt;
- a screen recording;
- raw mouse/touch coordinates;
- a browser trace;
- model memory;
- a TeachingSession;
- a compiled artifact;
- a marketplace listing.

Those artifacts can provide provenance, compilation inputs, evidence, or derived teaching material, but none may silently become the canonical workflow meaning.

## 4. Universal protocol

Web, desktop, iOS, Android and cloud use exactly one WorkflowOS protocol for semantic operations. Canonical protocol identifiers are governed by `V2-CTRL-003`; this constitution does not permit parallel aliases.

Allowed platform differences:

- available capabilities;
- operating-system permission mechanisms;
- UX;
- local sensors and device APIs;
- connectivity and lifecycle;
- local execution availability.

Forbidden platform differences:

- separate workflow semantics;
- separate WorkflowIR formats;
- separate workflow engines;
- different version identity rules;
- different evidence truth semantics.

## 5. Node and capability authority

A Node advertises capabilities; it does not grant authorization.

Eligibility is:

```text
capability availability
AND workflow policy
AND user/organization authorization
AND placement constraints
AND node trust/health
```

A missing capability is an explicit ineligible result. Implementations may not silently emulate, substitute, or fall back to an unauthorized capability.

## 6. Execution classes

Every workflow step is executed as one of:

1. **Deterministic/API** — use a known structured operation when available.
2. **Agentic/computer-use** — an agent interprets/acts within declared capabilities and policy.
3. **Human** — the workflow explicitly asks a person to act, approve, decide, or provide information.
4. **Subworkflow** — invokes another immutable WorkflowVersion through an explicit dependency.

An implementation should prefer deterministic execution when semantic equivalence is established. Computer-use is not the default substitute for a known reliable API.

## 7. Evidence truth

The system must distinguish:

```text
intent
observation
claim/assertion
verification
human confirmation
```

A model statement such as “the file was uploaded” is not evidence that the file was uploaded.

Side effects are considered completed only when the configured evidence policy establishes completion.

## 8. Workflow teaching

Teaching and automation are symmetric views over the same WorkflowVersion.

`TeachingSession` is derived from workflow meaning and may contain learner state, checkpoints and teaching evidence. It may never mutate the source WorkflowVersion implicitly.

Reverse teaching is explicitly supported:

```text
install workflow
  ↓
Teach Me
  ↓
derive lesson
  ↓
human practice
```

The system must disclose uncertainty rather than inventing missing procedure details.

## 9. Demonstration capture

Demonstration capture may collect:

- screen frames;
- accessibility/UI tree observations;
- mouse/touch/keyboard events;
- application/window identity;
- voice narration/transcript;
- clipboard/file/application observations;
- timestamps;
- user annotations.

Raw capture is immutable provenance. A compiler/authoring subsystem transforms it into WorkflowIR; raw interaction replay is not the workflow.

## 10. Optimization

Optimization is advisory and version-producing.

Examples:

- replace fragile GUI steps with an API connector;
- replace a repeated sequence with an existing workflow dependency;
- parallelize independent steps;
- move execution to a better node;
- reduce cost/latency;
- add explicit human approval where risk was detected.

An optimization proposal must explain the affected semantic region and expected trade-offs. It cannot mutate an installed version silently.

## 11. Events and triggers

Triggers are event patterns that instantiate WorkflowRuns.

Supported categories may include:

- manual;
- schedule;
- webhook;
- application event;
- file event;
- communication event;
- device event;
- social threshold event;
- workflow lifecycle event.

Canonical event identifiers are governed by `V2-CTRL-003`.

Every event-triggered execution has stable event/trigger correlation and must be idempotent against duplicate delivery.

## 12. Locality and cross-device execution

Workflow and step placement can require:

- `device_local`;
- `device_preferred`;
- `cloud_allowed`;
- `cloud_preferred`;
- `cloud_required`;
- `any_supported_node`.

Canonical placement identifiers are governed by `V2-CTRL-003`.

Locality is a correctness constraint, not merely a performance hint.

## 13. Mobile semantics

Mobile workflows use the universal protocol plus platform-advertised capabilities.

Examples include:

- incoming call handling;
- caller identification;
- contact lookup/share;
- notification reactions;
- message processing;
- camera/microphone use;
- app interaction.

Android and iOS are allowed to expose different capabilities. The protocol must report those differences honestly.

## 14. Repository and Git-like collaboration

Workflow repositories support public/private visibility, ownership, collaboration, version history, fork identity, provenance and review.

Forking creates a new Workflow identity. Source private data and secrets never transfer merely because a workflow was forked.

Installation pins a version. Publisher edits create later versions and cannot mutate customer-installed versions silently.

## 15. Marketplace economics

Commercial access is represented by entitlements, not execution permissions.

Supported first-class commercial models:

- free;
- one-time purchase;
- maintenance subscription.

A maintenance subscription may provide access to compatible updates/support according to explicit terms. Update adoption remains controlled by the customer's installation/deployment policy.

Payment processors remain outside WorkflowIR and workflow authority contracts. Detailed economics are governed by `workflow-marketplace-economics.md`.

## 16. Security and privacy

Each sensitive capability has its own authorization/consent boundary. Device access is not blanket access to device data.

Examples:

- contacts ≠ messages;
- microphone ≠ call recording;
- location ≠ location sharing;
- call-answer ≠ arbitrary messaging;
- filesystem-write ≠ unrestricted filesystem access.

Secret material is referenced opaquely and delivered only through authorized runtime paths.

## 17. Self-hosting

WorkflowOS eventually packages its own development, maintenance, deployment, verification and dogfooding processes as ordinary Workflow artifacts.

Self-hosting must consume the same protocol and governance boundaries as customer workflows. It may not bypass them because the workflow is first-party.

## 18. V1 boundary

V1 is not rewritten by V2.

V2 may reuse stable V1 components only through explicit adapters. Existing V1 authorities keep their meaning until a governed transition replaces them.

No V2 Work Order may import a V1 internal module merely because it is convenient when an existing public contract or adapter is required.

## 19. Forbidden architectural drift

No implementation may:

- create a second workflow protocol;
- create a second workflow engine;
- make computer-agent prompts the durable workflow format;
- make raw recordings the workflow format;
- make a platform-specific workflow language;
- silently alter immutable WorkflowVersions;
- turn marketplace entitlement into execution authority;
- allow publisher access to customer secrets by default;
- make optimization silently mutate installations;
- make capability advertisement equal authorization;
- claim unsupported iOS/Android capabilities;
- use cloud execution when workflow locality forbids it;
- turn model assertions into side-effect evidence;
- bypass the V2 protocol for self-hosting;
- revive deferred V1 work without a recorded dependency/security/reactivation reason;
- invent protocol-visible aliases for canonical registry identifiers.

## 20. Required implementation discipline

Every V2 Work Order must identify:

- the architecture contract it consumes;
- the concepts it owns;
- the concepts it explicitly does not own;
- exact change surfaces;
- deterministic regressions;
- required real-system verification;
- required feature-boundary dogfooding;
- expected integration gates;
- known exclusions.

A Work Order that discovers a contradiction in a frozen V2 concept must stop and raise a governed architecture change rather than silently reinterpret the concept.

## 21. Execution attestation and verifiable execution

WorkflowOS may represent a bounded execution fact through the following additive protocol layers:

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
```

The following rules are constitutional:

- `ExecutionDigest` is distinct from the WorkflowVersion semantic digest.
- Execution statements use deterministic, domain-separated canonical serialization.
- An attestation authenticates an attester's statement; a valid signature does not automatically prove physical execution or side-effect completion.
- Decision-relevant attestations bind to WorkflowVersion, WorkflowRun, execution attempt, applicable step, causal parents, and freshness context.
- Freshness/replay resistance is mandatory where an attestation affects a current decision. Timestamps alone are insufficient.
- Node identity, workload identity, capability possession, authorization, placement, policy, cryptographic authenticity, assurance, observed effect, and verification remain separate dimensions.
- Initial assurance identifiers are `software_signed`, `hardware_backed`, `tee_attested`, and `verifiable_computation`. They are evidence/trust properties, not execution classes.
- Hosts may lack stronger assurance. The protocol reports that absence explicitly rather than silently downgrading or emulating it.
- ExecutionProofGraph is evidence about WorkflowRuns, not a second WorkflowIR, workflow engine, execution authority, or verification authority.
- Transparency logs, blockchains, external ledgers, TEEs and zero-knowledge mechanisms are optional assurance/anchoring mechanisms unless a later governed architecture change explicitly changes that rule.
