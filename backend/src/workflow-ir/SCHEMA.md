# WorkflowIR — Module Schema Specification (V2-003)

**Owner:** Work Order [V2-003 — Workflow IR](../../../../spec/architecture/v2/work-orders/V2-003.md)
**Module:** `backend/src/workflow-ir/` (pure domain module — no persistence, no routes, no DB, no migration)
**IR schema version:** `1` (this document specifies schema version 1)
**Canonical object type:** `workflowos/workflow-ir/v1`
**Normative inputs:** architecture-constitution §2/§3/§4/§6/§7/§12/§16/§21; V2-CTRL-003 protocol registry (frozen at `dff907d16728c7124fab5176b21622d927178b3d`); execution-control-plane; V2-003 work order.

This is the module-resident specification of the WorkflowIR schema and its
deterministic serialization, validation, digest and negotiation contracts. It
is the engineering source of truth for the module; promotion into the shared
`spec/` tree is an architect decision (persisted as a V2-003 finding — see
§12).

---

## 1. Position in the object hierarchy

```text
WorkflowRepository          (V2-002)
  └── Workflow              (V2-002)
       ├── WorkflowVersion  (V2-002 — immutable; pins ONE WorkflowIR document)
       │    └── WorkflowIR  (THIS SPEC — the semantic source of truth, constitution §3)
       └── WorkflowDeployment (V2-002/V2-009)
              └── WorkflowRun  (V2-005)
```

The WorkflowIR is the platform-neutral semantic representation of exactly one
WorkflowVersion. A prompt, a screen recording, a browser trace, a teaching
session, a compiled artifact or a marketplace listing is **never** equivalent
to WorkflowIR (constitution §3). This module owns the IR **schema and
semantics only** — repository persistence/version lifecycle (V2-002),
node/capability matching (V2-004), run/evidence (V2-005), teaching, compiler,
computer-agent runtime, scheduling and marketplace are out of scope.

### 1.1 Execution-attestation boundary (hard)

This module contains **no execution-attestation concepts**. There is no
ExecutionStatement, ExecutionDigest, ExecutionAttestation or proof-graph
concept anywhere in its types or code. The digest defined here is the
**WorkflowVersion semantic digest** (§7), which commits to workflow *meaning*
only. It is domain-separated (`workflowos/workflow-ir/v1`) from the
execution-statement digest domain owned by V2-014
(`workflowos/execution-statement/v1`) and never hashes execution facts. A
test (`tests/unit/workflow-ir/execution-attestation-boundary.test.ts`) scans
the module source and fails on any attestation concept appearing in code.

---

## 2. Document envelope

A serialized WorkflowIR artifact is a JSON object with EXACTLY these keys
(unknown keys are validation errors — there is no smuggling surface):

```jsonc
{
  "objectType": "workflowos/workflow-ir/v1",   // exact literal; anything else is rejected
  "irSchemaVersion": 1,                         // integer; this build supports {1}
  "compatibility": {                            // version-affecting metadata (§6) — DIGEST INPUT
    "compatibilityLevel": "equivalent" | "compatible" | "incompatible",
    "inputSurfaceChange":  "none" | "additive" | "breaking",
    "outputSurfaceChange": "none" | "additive" | "breaking"
  },
  "ir": { /* the WorkflowIR semantic object, §3 */ },
  "presentation": { /* optional, §5 — SERIALIZED, NEVER DIGESTED */ }
}
```

A newer `irSchemaVersion` than any supported version is rejected
(`IR_SCHEMA_VERSION_UNSUPPORTED`) — the consumer never guesses forward. A
wrong `objectType` is rejected (`IR_OBJECT_TYPE_MISMATCH`).

## 3. The WorkflowIR semantic object

```ts
interface WorkflowIR {
  start: string;                        // single entry node id
  inputs: PortDeclaration[];            // workflow-level input ports (a set, keyed by name)
  outputs: WorkflowOutputBinding[];     // workflow-level outputs (a set, keyed by name)
  nodes: WorkflowNode[];                // the steps (a set, keyed by id)
  edges: ControlEdge[];                 // explicit control edges (a set, keyed by from/to/trigger)
  defaultPlacement: PlacementId;        // canonical registry placement id
  provenance: WorkflowProvenance;       // how this IR came to exist (semantic — digest input)
}
```

Identifiers (`node ids`, port names, decision option ids) match
`/^[A-Za-z][A-Za-z0-9_-]*$/`. All five collections above are **sets** for
digest/equality purposes (§7.2): authoring order is presentation, not meaning.

### 3.1 Ports and the type system

```ts
type PortType =
  | { kind: 'string' } | { kind: 'number' } | { kind: 'boolean' }
  | { kind: 'json' }                       // arbitrary JSON payload target
  | { kind: 'secret' }                     // opaque secret HANDLE type
  | { kind: 'object'; fields: PortField[] } // structural; fields are a set keyed by name
  | { kind: 'array'; element: PortType };

interface PortField   { name: string; type: PortType; optional?: boolean }
interface PortDeclaration { name: string; type: PortType; optional?: boolean }
```

Assignability (`isPortTypeAssignable`) is sound, never coercing:

- `secret` is a **one-way opaque handle type**: secret→secret only. A secret
  can never widen to `json`/`string`/… and no other type can masquerade as a
  secret handle. This is the structural half of secret non-leakage (§4).
- Every non-secret type is assignable to `json`; `json` is assignable only to
  `json` (no unprovable downcasts).
- Objects: the source must provide every required target field with an
  assignable type; a source field marked `optional` can never satisfy a
  required target field; array elements are checked recursively.

### 3.2 Data bindings

Every node input port carries exactly one binding, discriminated by `kind`
with exact key sets:

```ts
type BindingSource =
  | { kind: 'workflow_input'; input: string }            // a workflow-level input port
  | { kind: 'node_output';   node: string; output: string } // another node's output port
  | { kind: 'literal';       value: JsonValue }          // constant data (NEVER for secret ports)
  | { kind: 'secret_ref';    ref: string };              // opaque secret reference — secret ports ONLY
```

A binding must typecheck: the source type must be assignable to the port
type (`IR_BINDING_TYPE_MISMATCH`), the referenced node/output/workflow-input
must exist, and optionality must flow soundly (an optional workflow input
cannot satisfy a required port — `IR_BINDING_OPTIONALITY_MISMATCH`).

Workflow outputs bind `from` a workflow input or a node output and must
typecheck the same way.

### 3.3 Secrets (constitution §16)

Secret material can **never** be embedded in IR. The `secret` port type is
satisfiable only by a `secret_ref` binding, which carries exactly one opaque
`ref` string (non-empty, no whitespace, ≤256 chars, no other keys —
`IR_SECRET_REF_MALFORMED`). A literal binding on a secret port is rejected
(`IR_SECRET_LITERAL_FORBIDDEN`); a `secret_ref` on a non-secret port is
rejected (`IR_SECRET_REF_FOR_NON_SECRET_PORT`). Resolution and delivery of
secret material happens only through authorized runtime paths owned outside
this module. Serialized IR therefore provably contains only the opaque
reference (grep-level tests pin this).

### 3.4 Control semantics

```ts
type EdgeTrigger = 'success' | 'failure' | { outcome: string };
interface ControlEdge { from: string; to: string; on: EdgeTrigger }
```

- `success` — the source completed successfully.
- `failure` — the source failed; valid **only** when the source node's
  failure policy is `failover`, and exactly one such edge may exist.
- `{ outcome }` — a human node produced the named declared outcome. This is
  the only data-dependent branch in the IR.

Well-formed control (all enforced, all ambiguous forms rejected):

- every edge endpoint must reference an existing node; no self-edges; no
  edges into the start node; no duplicate (from, to, trigger) triples;
- every node must be reachable from `start`;
- failure policies: `fail_workflow`, `retry_then_fail_workflow{maxAttempts}` (integer ≥ 1),
  `failover` (requires exactly one outgoing `failure` edge), `ignore_and_continue`
  (forbids `failure` edges). Policy/edge contradictions are
  `IR_FAILURE_POLICY_EDGE_CONFLICT` / `IR_FAILURE_POLICY_EDGE_REQUIRED`.
- a node with no outgoing `success`/`outcome` edges is a terminal node
  (allowed); dangling semantic references are not.

### 3.5 Human constructs (execution class `human`) — pause-safe

```ts
type HumanStepSpec =
  | { kind: 'approval';   instruction: string }                    // outcomes: approved | rejected
  | { kind: 'decision';   instruction: string; options: string[] } // person picks an option id
  | { kind: 'information'; instruction: string; provides: PortDeclaration }; // person provides a typed value
```

Human nodes are **pause points**: the workflow suspends until the person
acts. Output contracts (validated, `IR_HUMAN_OUTPUT_CONTRACT`):

- approval → boolean port named `approved`; declared outcomes `approved`,
  `rejected`; control continues via `on: {outcome}` edges covering BOTH.
- decision → string port named `selected`; every declared option id must be
  covered by an outcome edge (options are a set — no duplicates).
- information → the `provides` declaration is the node's output port;
  completes via `success` edges.

Human nodes never take plain `success`/`failure` control edges
(`IR_HUMAN_SUCCESS_EDGE_FORBIDDEN` / `IR_HUMAN_FAILURE_EDGE_FORBIDDEN`);
outcome edges referencing undeclared outcomes and uncovered declared
outcomes are both rejected. Run pause/resume lifecycle itself is V2-005.

### 3.6 Node specs and execution classes

```ts
type NodeSpec =
  | { class: 'deterministic_api';      capability: CapabilityName }
  | { class: 'agentic_computer_use';   task: string }
  | { class: 'human';                  human: HumanStepSpec }
  | { class: 'subworkflow';            subworkflow: SubworkflowDependency };
```

`spec.class` MUST equal the node's `executionClass`
(`IR_SPEC_CLASS_MISMATCH`). The four execution classes are exactly the
registry's frozen identifiers — `deterministic_api`, `agentic_computer_use`,
`human`, `subworkflow` (constitution §6). Per-node placement uses exactly the
registry's placement ids.

`capabilityRequirements` are canonical registry capability **names** (plain
strings validated by exact membership — never structural guesses, never
platform SDK names, never aliases). A subworkflow node MUST require
`workflow.execute`.

### 3.7 Subworkflow dependencies

```ts
interface SubworkflowDependency { workflowId: string; versionRef: string }
```

An explicit, immutable reference to another WorkflowVersion (constitution
§6.4). Both fields are opaque non-empty identifiers — repository semantics
(V2-002) own what they resolve to; the IR never dereferences them.

### 3.8 Completion evidence

A node MAY declare `completionEvidence` — which evidence class establishes
its side-effect completion. Only `observation`, `verification` and
`human_confirmation` are accepted: `intent` and `claim` are honest statements
but never establish that a side effect happened (constitution §7;
`IR_COMPLETION_EVIDENCE_INVALID`).

## 4. Provenance, compatibility, presentation

```ts
interface WorkflowProvenance { origin: 'authored' | 'compiled' | 'imported'; sourceRefs?: string[] }
```

Provenance is semantic (digest-affecting) per the V2-003 work order. Source
references are opaque strings (a set).

`compatibility` (the version-affecting semantic compatibility metadata) is
part of the **digest input** — the registry digest rule says the
WorkflowVersion semantic digest is computed from the canonical WorkflowIR
**and** the compatibility metadata the schema declares as version-affecting.
The declaration describes the change against the previous version of the same
workflow; negotiation (§8) cross-checks it against the computed public
surface diff and rejects dishonest declarations.

`presentation` (display title, node labels, layout coordinates, free-text
notes) is serialized for lossless round-trips but is **excluded from the
digest and from semantic equality** (registry: `presentationExcluded`).
Repository/marketplace/UX/deployment metadata are not part of this schema at
all — there is no field for them, and unknown fields are rejected.

## 5. Canonical serialization

`serializeWorkflowIrDocument(document) → string` emits **canonical JSON**:

- UTF-8 JSON text, object keys sorted lexicographically (by UTF-16 code
  unit), no insignificant whitespace;
- arrays keep authoring order EXCEPT where the schema declares sets — the
  serializer emits the **set-normalized** form (§7.2), so independently
  authored equivalent documents serialize to identical bytes;
- primitive normalization: `−0` → `0`; non-finite numbers, `undefined` and
  functions are not JSON data and are rejected
  (`WORKFLOW_IR_CANONICAL_VALUE_NOT_JSON` / `IR_LITERAL_NOT_JSON`);
- `undefined` object members are treated as absent.

`parseWorkflowIrDocument(text)` parses, shape-coerces and validates; any
ambiguous, unsupported or non-canonical-shaped input is a typed rejection
(`ParseResult`), never a silent default.

## 6. Validation

`validateWorkflowIrDocument(unknown) → ValidationResult` runs two stages:

1. **Strict shape coercion** — exact key sets everywhere (unknown fields are
   errors), discriminated unions with exact members, identifier patterns,
   literal-JSON checks, secret_ref shape checks, presentation shape checks.
2. **Semantics** — duplicate identifiers, dangling references, control
   well-formedness (§3.4/§3.5), typed binding checks (§3.1/§3.2), secret
   rules (§3.3), registry vocabulary conformance (§11), subworkflow
   dependency rules, compatibility metadata shape.

Every issue carries `{ code, path, message }`. Validation is deterministic:
the same input yields the same issues in the same order. Issue codes
(all fail-closed):

`IR_FIELD_MISSING`, `IR_FIELD_UNEXPECTED`, `IR_FIELD_INVALID`,
`IR_OBJECT_TYPE_MISMATCH`, `IR_SCHEMA_VERSION_UNSUPPORTED`,
`IR_COMPATIBILITY_INVALID`, `IR_PROVENANCE_INVALID`,
`IR_NODES_REQUIRED`, `IR_NODE_ID_INVALID`, `IR_NODE_ID_DUPLICATE`,
`IR_NODE_UNREACHABLE`, `IR_PORT_NAME_INVALID`, `IR_PORT_NAME_DUPLICATE`,
`IR_EDGE_NODE_UNKNOWN`, `IR_EDGE_SELF_LOOP`, `IR_EDGE_INTO_START`,
`IR_EDGE_DUPLICATE`, `IR_EDGE_TRIGGER_INVALID`,
`IR_FAILURE_POLICY_INVALID`, `IR_FAILURE_POLICY_EDGE_REQUIRED`,
`IR_FAILURE_POLICY_EDGE_CONFLICT`, `IR_BINDING_KIND_UNKNOWN`,
`IR_BINDING_NODE_UNKNOWN`, `IR_BINDING_OUTPUT_UNKNOWN`,
`IR_BINDING_WORKFLOW_INPUT_UNKNOWN`, `IR_BINDING_OPTIONALITY_MISMATCH`,
`IR_BINDING_TYPE_MISMATCH`, `IR_LITERAL_NOT_JSON`,
`IR_SECRET_REF_MALFORMED`, `IR_SECRET_LITERAL_FORBIDDEN`,
`IR_SECRET_REF_FOR_NON_SECRET_PORT`, `IR_OUTPUT_BINDING_INVALID`,
`IR_EXECUTION_CLASS_UNKNOWN`, `IR_PLACEMENT_UNKNOWN`,
`IR_COMPLETION_EVIDENCE_INVALID`, `IR_SPEC_CLASS_MISMATCH`,
`IR_CAPABILITY_NON_CANONICAL`, `IR_CAPABILITY_REQUIREMENT_NON_CANONICAL`,
`IR_SUBWORKFLOW_DEPENDENCY_INVALID`, `IR_SUBWORKFLOW_CAPABILITY_REQUIRED`,
`IR_HUMAN_OUTPUT_CONTRACT`, `IR_HUMAN_OPTION_DUPLICATE`,
`IR_HUMAN_OUTCOME_UNDECLARED`, `IR_HUMAN_OUTCOME_UNCOVERED`,
`IR_HUMAN_SUCCESS_EDGE_FORBIDDEN`, `IR_HUMAN_FAILURE_EDGE_FORBIDDEN`.

## 7. The WorkflowVersion semantic digest

```text
digest = SHA-256( canonical-json( semantic-object ) )

semantic-object = {
  domain:            'workflowos/workflow-ir/v1',
  irSchemaVersion:  <number>,
  compatibility:     { compatibilityLevel, inputSurfaceChange, outputSurfaceChange },
  ir:                <set-normalized WorkflowIR>
}
```

Returned as `{ algorithm: 'sha-256', domain: 'workflowos/workflow-ir/v1',
digest: <64 lowercase hex> }`.

- Same semantics → same digest. Presentation-only changes → SAME digest.
- Any semantic change — an edge, a binding source, a binding/port type, a
  capability requirement, the invoked capability, an execution class, a
  failure policy, a human instruction, a placement, a secret reference, node
  outputs, provenance, the declared compatibility metadata — → DIFFERENT
  digest.
- The digest input contains EXACTLY the version-affecting metadata the
  schema declares (`compatibility`) and excludes presentation, repository,
  marketplace, UX and deployment metadata.
- **Domain separation:** this digest commits to workflow meaning only. It
  shares no domain with the execution-statement digest (V2-014) and never
  hashes execution facts.

### 7.2 Set normalization

Digest/equality treat these collections as sets (sorted canonically):
nodes by id; edges by (from, to, trigger); workflow inputs/outputs, node
inputs/outputs and object-type fields by port name; capability
requirements; decision options; provenance source refs. Everything else
(e.g. `start`, placements, instructions, literals) is order-free by
construction.

`semanticallyEqual(a, b)` is byte equality of the two canonical semantic
preimages. Independently constructed equivalent documents therefore have
identical canonical bytes, identical preimages and identical digests — the
cross-client equivalence invariant.

## 8. Compatibility / version negotiation

### 8.1 IR schema negotiation

`negotiateIrSchemaVersion(consumer, offered, migrations)` — deterministic:

- `accept` — the offered schema version is directly supported;
- `upgrade` — the offered version is older and a declared **safe** migration
  chain reaches a supported version (migrations are declared metadata; the
  decision layer never executes a migration);
- `reject` — `schema-too-new` (never guess forward), `no-upgrade-path`,
  or `no-supported-versions`.

### 8.2 Workflow version update negotiation

`negiateWorkflowVersionUpdate({ installed, candidate })` cross-checks the
candidate's DECLARED compatibility metadata against the public-surface diff
COMPUTED from the two snapshots (inputs/outputs/compatibility):

- computed surface unchanged + declared `equivalent` → `accept`
  (`public-surface-unchanged`);
- additive-only computed change + declared `compatible` → `upgrade`
  (`additive-compatible-surface`);
- breaking computed change + declared `incompatible` → `reject`
  (`breaking-change`);
- ANY disagreement between declaration and computation → `reject`
  (`compatibility-declaration-inconsistent`) — honest metadata only.

Surface diff semantics: added optional input = additive; added required
input, removed input, input type no longer accepting old values,
optional→required = breaking; input type widening = additive; added output =
additive; removed/narrowed output = breaking. Adoption policy itself stays
with the customer's installation/deployment policy (constitution §15) — this
layer only classifies compatibility.

## 9. Determinism and test discipline

All module behavior is deterministic: no wall-clock, no randomness, no
network; any id/clock need is injected by the caller. The battery lives at
`tests/unit/workflow-ir/**` and `tests/integration/workflow-ir/**`:

| File | Proves |
|---|---|
| `canonical-json.test.ts` | primitive normalization, key sorting, undefined-as-absent |
| `round-trip.test.ts` | lossless author→serialize→deserialize→identical (incl. human/approval constructs, placement, secret refs, failure policy, presentation) |
| `digest.test.ts` | same semantics → same digest; presentation-only → same; every semantic mutation → different; metadata inclusion/exclusion |
| `validation.test.ts` | duplicate/dangling/ambiguous/unsupported rejection; deterministic issue order |
| `typed-bindings.test.ts` | full assignability matrix incl. secret non-widening, object/array structural rules |
| `secret-non-leakage.test.ts` | inline material rejected; grep-level proof that serialized IR carries only the opaque ref |
| `negotiation.test.ts` | accept/upgrade/reject decisions; declaration cross-check; semantic equality |
| `platform-semantics.test.ts` | canonical capability names only; aliases and platform SDK concepts rejected; embedded vocabulary equals the frozen registry file on disk |
| `execution-attestation-boundary.test.ts` | no attestation concepts in module code; domain discrimination |
| `cross-client-equivalence.integration.test.ts` | builder vs literal vs alt-order → identical canonical bytes (multi-module composition) |
| `dogfooding-round-trip.integration.test.ts` | the recorded dogfooding experiment (see the V2-003 evidence file) |

## 10. Authoring

`createWorkflowIrBuilder()` assembles a typed document fluently with only
the documented schema defaults (compatibility `equivalent/none/none`,
provenance `authored`, placement `any_supported_node`). The builder never
validates and never "fixes" an invalid graph — validation is an explicit,
fail-closed step (`assertValidWorkflowIrDocument` throws `WorkflowIrError`).

## 11. Registry conformance (V2-CTRL-003)

- Execution classes, placement ids, capability names and evidence classes
  are the **frozen registry identifiers**, reused exactly (never aliased).
  The embedded snapshot (`internal/registry-vocabulary.ts`) records its
  source file and frozen SHA; tests pin it byte-for-byte against the
  registry JSON on disk, so drift is impossible without a failing test.
- `workflowos/workflow-ir/v1` is a genuinely new **schema-internal**
  object-type identifier for domain separation (no registry entry covers a
  WorkflowIR canonical object). It is IR-scoped, never aliased against any
  registry identifier, and discrimination tests pin its distinctness from
  the registry's attestation object types. **Governed registry extension is
  required before it becomes protocol-visible** (registry-conformance rule
  5) — recorded as a V2-003 finding, not silently widened.
- Capability references in IR are canonical names only: non-canonical
  aliases (`phone.answer_call`, `messages.send`, …) and platform SDK
  concepts (`chrome.tabs.create`, `ios.appintent.openurl`,
  `aws.s3.putObject`, …) are rejected by validation.

## 12. Governance notes and findings

- Promotion of this specification into the shared `spec/` tree is an
  architect decision — deliberately not performed by this Work Order
  (finding persisted in the dogfooding evidence and the wave worklog).
- The module never edits the registry, `spec/development-state/**`,
  `backend/vitest.config.ts` or any sibling-owned surface.
- Version bumps of `irSchemaVersion` MUST come with a declared migration
  path and a new schema-version conformance battery; a consumer facing a
  newer schema fails closed by design.
