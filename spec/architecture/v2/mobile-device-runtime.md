# WorkflowOS 2.0 — Mobile and Cross-Device Runtime

**Status:** PROPOSED / implementation-authorized normative V2 design  
**Canonical registry:** `V2-CTRL-003-protocol-registry.md` + `V2-CTRL-003-protocol-registry.json`

## One protocol, many surfaces

Web, desktop, iOS, Android and cloud are implementations of one WorkflowOS protocol. They may expose different local capabilities, permissions and UX, but they do not define separate workflow semantics or separate workflow engines.

## Node model

Each participating device/runner is a `Node` with:

- stable node identity;
- authenticated protocol identity;
- platform/device class;
- protocol version;
- advertised capabilities and versions;
- locality and connectivity state;
- security/trust attributes;
- permission/consent state.

Capability advertisement is not authorization. A workflow may execute only when capability, authorization, workflow policy and placement all agree.

## Canonical capability vocabulary

Protocol-visible capability identifiers MUST come from `V2-CTRL-003`. This specification does not define aliases. Examples used below are canonical:

- `phone.call.observe`
- `phone.call.identify`
- `phone.call.answer`
- `phone.call.reject`
- `phone.call.end`
- `messaging.observe`
- `messaging.read`
- `messaging.send`
- `contacts.read`
- `contacts.search`
- `notifications.observe`
- `microphone.capture`
- `speech.synthesis`
- `camera.capture`
- `location.read`
- `application.open`
- `application.observe`
- `application.interact`
- `screen.observe`
- `ui.inspect`
- `ui.click`
- `ui.type`
- `social.post.observe`
- `social.post.publish`
- `social.engagement.observe`

Platform adapters advertise only capabilities they can actually perform under current OS and permission conditions.

## Platform asymmetry

iOS and Android are not required to expose identical capabilities. The common protocol remains identical while `supportedPlatforms`, permissions, placement and capability availability are platform-specific.

The product must state capability unavailability explicitly. It must not emulate an unsupported capability silently or claim cross-platform equivalence that does not exist.

## Locality

Workflow or step placement may require:

- `device_local` — the action must execute on the triggering device;
- `device_preferred` — device execution is preferred when eligible;
- `cloud_allowed` / `cloud_preferred`;
- `cloud_required`;
- `any_supported_node`.

Locality is especially important for low-latency or privileged phone interactions.

## Device-local event execution

Some events must be handled locally without requiring a round trip to the cloud. Examples include incoming calls, certain notifications and device state events. The local runtime may perform deterministic actions immediately and may consult a remote agent only when policy permits and latency/safety constraints allow it.

```text
phone event
  ↓
local trigger matcher
  ↓
policy/capability check
  ↓
local workflow step(s)
  ↓
optional cloud consultation
```

## Cross-device execution

A workflow may transition between nodes when its placement policy permits it. The protocol carries the same workflow/version/run identity across nodes, with causation and evidence preserved.

A node handoff must not duplicate a side effect merely because another node reconnects or replays an event.

## Example: call workflow

```yaml
trigger:
  event: phone.call.received
  conditions:
    caller: mom

placement:
  locality: device_local

steps:
  - capability: phone.call.answer
  - capability: speech.synthesis
    input: "I'll call you back soon."
  - capability: phone.call.end
```

The workflow is portable at the semantic level. A node is eligible only if it advertises the required phone capabilities and the user has granted the necessary authority.

## Example: social threshold workflow

```text
social.post.engagement.threshold_crossed
  where likes >= 100000
      ↓
workflow instance
      ↓
retrieve content via social.post.observe
      ↓
agent analysis/remix
      ↓
human approval if required
      ↓
social.post.publish via authorized capability
```

Threshold crossing is an event fact with a stable event identity; polling duplicates must converge to one workflow trigger.

## Privacy and consent

Sensitive device capabilities require explicit user consent and policy. A workflow cannot infer that access to a phone implies access to all phone data.

Examples:

- contacts access does not grant message access;
- microphone access does not grant call recording automatically;
- location access does not authorize sharing location with another party;
- answering calls does not authorize sending unrelated messages.

## Forbidden drift

No implementation may:

- invent alternate capability aliases when a canonical identifier exists;
- create separate workflow semantics for iOS/Android/desktop/web;
- hide unsupported capabilities behind simulated success;
- route device-sensitive actions through cloud by default when locality forbids it;
- treat capability possession as authorization;
- persist privileged device credentials inside workflow definitions;
- create a mobile-only workflow engine outside the universal protocol.
