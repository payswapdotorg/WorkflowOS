# V2-CTRL-003 — Canonical Protocol Registry

**Status:** REQUIRED CONTROL ARTIFACT  
**Authority:** Canonical names and cross-cutting serialization/identity rules for WorkflowOS 2.0.

This registry removes naming drift between the universal protocol, mobile runtime, teaching/marketplace specifications, execution attestation, and later Work Orders. A later Work Order may extend the registry only through an explicit V2 architecture change; it must not silently rename an existing concept.

## Canonical capability namespace

Capabilities are namespaced, lowercase, dot-separated, versionable operations. These names are semantic protocol identifiers, not platform SDK names.

### Browser / web
- `browser.navigate`
- `browser.click`
- `browser.type`
- `browser.select`
- `browser.observe`
- `browser.download`
- `browser.upload`

### Desktop / filesystem / applications
- `filesystem.read`
- `filesystem.write`
- `application.open`
- `application.observe`
- `application.interact`
- `screen.observe`
- `ui.inspect`
- `ui.click`
- `ui.type`

### Phone / calling
- `phone.call.observe`
- `phone.call.identify`
- `phone.call.answer`
- `phone.call.reject`
- `phone.call.end`

### Messaging / contacts
- `messaging.observe`
- `messaging.read`
- `messaging.send`
- `contacts.read`
- `contacts.search`
- `contacts.create`

### Device sensors / media
- `notifications.observe`
- `microphone.capture`
- `speech.synthesis`
- `camera.capture`
- `location.read`

### Spreadsheets / business applications
- `spreadsheet.read`
- `spreadsheet.edit`

### Social systems
- `social.post.observe`
- `social.post.publish`
- `social.engagement.observe`

### WorkflowOS-native
- `workflow.execute`
- `workflow.pause`
- `workflow.resume`
- `workflow.cancel`
- `workflow.deploy`
- `workflow.observe`

### Integration / development examples
- `github.repository.read`
- `github.pull_request.create`
- `github.pull_request.merge`

The examples are extensible, but an implementation must reuse an existing canonical name when the semantic operation already exists. `phone.answer_call`, `calls.answer`, and `messages.send`, for example, are non-canonical aliases and must not be introduced as alternate protocol meanings.

## Canonical event namespace

Events use lowercase dot-separated names and represent observed facts, not requests.

Examples:
- `workflow.run.requested`
- `workflow.run.started`
- `workflow.step.started`
- `workflow.step.completed`
- `workflow.run.paused`
- `workflow.run.resumed`
- `workflow.run.completed`
- `workflow.run.failed`
- `capability.invocation.requested`
- `capability.invocation.completed`
- `observation.recorded`
- `verification.completed`
- `execution.attestation.issued`
- `execution.attestation.verified`
- `execution.proof.updated`
- `device.connected`
- `device.disconnected`
- `phone.call.received`
- `phone.call.ended`
- `messaging.message.received`
- `notification.received`
- `file.created`
- `file.changed`
- `application.opened`
- `social.post.engagement.threshold_crossed`
- `workflow.deployment.enabled`
- `workflow.deployment.disabled`

Trigger implementations may introduce source-specific event types only through a registered namespace; they must still preserve the common envelope and event identity semantics.

## Canonical execution-class identifiers
- `deterministic_api`
- `agentic_computer_use`
- `human`
- `subworkflow`

## Canonical placement/locality identifiers
- `device_local`
- `device_preferred`
- `cloud_allowed`
- `cloud_preferred`
- `cloud_required`
- `any_supported_node`

## Canonical visibility identifiers
- `private`
- `organization`
- `public`

## Canonical execution-attestation object types

- `workflowos/execution-statement/v1`
- `workflowos/execution-attestation/v1`
- `workflowos/execution-proof-graph/v1`

These identify protocol object types and are not WorkflowIR execution classes.

## Canonical execution assurance identifiers

- `software_signed`
- `hardware_backed`
- `tee_attested`
- `verifiable_computation`

Assurance is an evidence/trust property. It does not change workflow semantics or capability authorization.

## Canonical workflow/run state principles

Exact lifecycle vocabularies are owned by the corresponding Work Orders, but these invariants are global:

- a WorkflowVersion is immutable;
- a Deployment pins one WorkflowVersion;
- a Run pins one Deployment/WorkflowVersion;
- pause/resume preserves Run identity;
- a command is never itself evidence of side-effect completion;
- duplicate event delivery must converge according to trigger/run idempotency rules;
- an execution attestation binds to the execution identity it claims and cannot be replayed across Runs or attempts where freshness is required.

## Canonical identity and digest rules

Where a deterministic content digest is required, the semantic value is:

```text
SHA-256(canonical-json(semantic-object))
```

Canonical JSON means UTF-8 JSON with deterministic object-key ordering, deterministic array ordering where the schema declares sets, no insignificant whitespace, and normalized primitive representations defined by the owning schema. Implementations must never hash presentation formatting, model prose outside the semantic object, or transport envelopes unless the owning contract explicitly includes them.

A WorkflowVersion semantic digest is computed from its canonical WorkflowIR and the semantic compatibility metadata that the IR schema declares as version-affecting. Repository metadata, marketplace pricing, UX state, and deployment placement are not part of the WorkflowVersion semantic digest unless a later architecture change explicitly makes them semantic.

An ExecutionDigest is distinct from a WorkflowVersion digest. Its canonical semantic domain is `workflowos/execution-statement/v1` and it commits to an ExecutionStatement, including the exact WorkflowVersion binding, Run/attempt identity, relevant action/effect/observation commitments, causal parents, policy/placement context where relevant, and freshness material defined by the owning contract.

Deterministic IDs must be derived only from authoritative identity inputs defined by the owning object contract. UI session IDs, timestamps chosen by models, random prompt text, or local process identity must never be the sole identity basis for a durable workflow object or execution fact.

## Canonical evidence vocabulary

Evidence classes are distinct:

- `intent`
- `observation`
- `claim`
- `verification`
- `human_confirmation`

An ExecutionAttestation is an authenticated protocol object. It is not a sixth evidence class and never replaces verification.

A claim can describe what an agent believes happened. It is not equivalent to observation or verification. A valid signature proves authentic statement origin/integrity according to the signing system; it does not automatically prove the asserted side effect.

## Canonical security rule

Capability advertisement, authorization, consent, placement, policy, trust, cryptographic authenticity, attestation assurance, and verification are separate dimensions. A protocol consumer must evaluate the relevant conjunction; possession of a capability or signing key never grants permission or automatic proof.

## Registry conformance

Every V2 Work Order that introduces protocol-visible names must:

1. search this registry first;
2. reuse an existing identifier where semantics match;
3. add a new identifier only if the semantic operation is genuinely new;
4. add discrimination tests preventing accidental aliasing;
5. update the registry through governed architecture change before depending on the new name.
