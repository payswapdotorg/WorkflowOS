/**
 * V2-003 — WorkflowIR: the public domain contracts.
 *
 * The domain lives at `src/workflow-ir/` (application-layer pure domain
 * module OUTSIDE src/modules/, mirroring the orchestration /
 * engineering-signals precedent — NOT a frozen module; no persistence, no
 * routes, no migration). It owns EXACTLY the Work Order V2-003 scope:
 *
 *   - the versioned, typed, platform-neutral WorkflowIR schema;
 *   - graph/control/data semantics (nodes, edges, typed bindings);
 *   - deterministic canonical serialization + the WorkflowVersion SEMANTIC
 *     digest (domain `workflowos/workflow-ir/v1`);
 *   - validation that rejects ambiguous/unsupported IR;
 *   - lossless semantic round-trip and compatibility/version negotiation;
 *   - dedicated IR tests + the module-resident SCHEMA.md specification.
 *
 * BOUNDARY CONTRACT (spec/architecture/v2/work-orders/V2-003.md):
 *
 *   - NOT repository persistence/version lifecycle (V2-002): no storage, no
 *     version records — this module is a pure domain library.
 *   - NOT Node/Capability semantics (V2-004): capability references are
 *     canonical registry NAMES only; signature matching is not defined here.
 *   - NOT Run/evidence persistence (V2-005), NOT teaching, compiler,
 *     computer-agent runtime, scheduling, marketplace.
 *   - NO execution-attestation concepts: ExecutionStatement/ExecutionDigest/
 *     ExecutionAttestation are owned by V2-014 under the domain
 *     `workflowos/execution-statement/v1`. The digest here is the
 *     WorkflowVersion SEMANTIC digest — a DIFFERENT, domain-separated thing
 *     that never hashes execution facts.
 *   - NO browser/desktop/mobile/cloud SDK concepts: capability references
 *     are canonical V2-CTRL-003 registry names, never platform SDK names and
 *     never aliases of canonical operations.
 *   - Secret material is NEVER embedded in IR: only opaque `secret_ref`
 *     handles bound to `secret`-typed ports (constitution §16).
 */

// ============================================================================
// §0  The IR domain identifier (schema-internal, IR-scoped)
// ============================================================================

/**
 * The canonical object type of a serialized WorkflowIR document.
 *
 * REGISTRY-CONFORMANCE NOTE (V2-CTRL-003 registry-conformance rule 5):
 * `workflowos/workflow-ir/v1` is a genuinely new protocol object-type
 * identifier — no existing registry entry covers the WorkflowIR canonical
 * object (the registry's object types are the execution-attestation ones).
 * It is kept SCHEMA-INTERNAL and IR-scoped here; discrimination tests pin
 * that it is distinct from every registry attestation object type, and a
 * governed registry extension is REQUIRED before it becomes
 * protocol-visible (persisted as a V2-003 finding, not silently widened).
 */
export const WORKFLOW_IR_OBJECT_TYPE = 'workflowos/workflow-ir/v1';

/** The current IR schema version. */
export const IR_SCHEMA_VERSION = 1;

/** The IR schema versions this build can parse/validate. */
export const SUPPORTED_IR_SCHEMA_VERSIONS: readonly number[] = [1];

// ============================================================================
// §1  The closed vocabularies (frozen V2-CTRL-003 registry identifiers)
// ============================================================================

/** Canonical execution classes (registry: executionClasses). */
export const EXECUTION_CLASSES = [
  'deterministic_api',
  'agentic_computer_use',
  'human',
  'subworkflow',
] as const;
export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

/** Canonical placement/locality identifiers (registry: placement). */
export const PLACEMENT_IDS = [
  'device_local',
  'device_preferred',
  'cloud_allowed',
  'cloud_preferred',
  'cloud_required',
  'any_supported_node',
] as const;
export type PlacementId = (typeof PLACEMENT_IDS)[number];

/**
 * The evidence classes that can ESTABLISH step completion (constitution §7:
 * intent and claim are honest statements, but they never establish that a
 * side effect happened — a model statement is not evidence of completion).
 */
export const COMPLETION_EVIDENCE_CLASSES = ['observation', 'verification', 'human_confirmation'] as const;
export type CompletionEvidenceClass = (typeof COMPLETION_EVIDENCE_CLASSES)[number];

/**
 * A canonical capability name (registry: capabilities). Plain string type:
 * membership is enforced by validation against the frozen registry snapshot,
 * never by a structural guess.
 */
export type CapabilityName = string;

// ============================================================================
// §2  The port type system (typed data flow)
// ============================================================================

/** JSON data (subset used in IR literals — never secret material). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The closed port type vocabulary. */
export type PortType =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  /** arbitrary JSON payload (assignable target for every non-secret type) */
  | { kind: 'json' }
  /**
   * an opaque secret HANDLE. Values of this type are `secret_ref` bindings
   * only; a secret can never widen to `json`/`string`/… (leak prevention)
   * and secret material can never be a literal.
   */
  | { kind: 'secret' }
  | { kind: 'object'; fields: readonly PortField[] }
  | { kind: 'array'; element: PortType };

export interface PortField {
  readonly name: string;
  readonly type: PortType;
  readonly optional?: boolean;
}

/** A declared workflow-level input port. */
export interface PortDeclaration {
  readonly name: string;
  readonly type: PortType;
  readonly optional?: boolean;
}

// ============================================================================
// §3  Data bindings (typed data flow between ports)
// ============================================================================

/**
 * Where a node input port's value comes from. Discriminated by `kind` with
 * EXACT key sets (validation rejects unknown keys — no smuggling surface).
 */
export type BindingSource =
  | { readonly kind: 'workflow_input'; readonly input: string }
  | { readonly kind: 'node_output'; readonly node: string; readonly output: string }
  /** a constant; FORBIDDEN for secret-typed ports (inline material) */
  | { readonly kind: 'literal'; readonly value: JsonValue }
  /**
   * an OPAQUE secret reference: carries exactly a `ref` handle, never
   * material; only valid for secret-typed ports.
   */
  | { readonly kind: 'secret_ref'; readonly ref: string };

/** A declared node input port plus its typed binding. */
export interface PortBinding extends PortDeclaration {
  readonly binding: BindingSource;
}

// ============================================================================
// §4  Control semantics (explicit edges, human outcomes, failure policy)
// ============================================================================

/**
 * When a control edge is taken:
 *   - `success` — the source node completed successfully;
 *   - `failure` — the source node failed (only with a `failover` policy);
 *   - `{ outcome }` — a human approval/decision node produced the named
 *     declared outcome (the ONLY data-dependent branch in the IR).
 */
export type EdgeTrigger = 'success' | 'failure' | { readonly outcome: string };

export interface ControlEdge {
  readonly from: string;
  readonly to: string;
  readonly on: EdgeTrigger;
}

/**
 * Per-node failure policy. Unambiguous by construction:
 *   - `fail_workflow` — any failure fails the workflow (no failure edges);
 *   - `retry_then_fail_workflow` — deterministic retry budget, then fail;
 *   - `failover` — failure routes along EXACTLY ONE on_failure edge;
 *   - `ignore_and_continue` — failure is ignored; on_success edges proceed.
 */
export type StepFailurePolicy =
  | { readonly strategy: 'fail_workflow' }
  | { readonly strategy: 'retry_then_fail_workflow'; readonly maxAttempts: number }
  | { readonly strategy: 'failover' }
  | { readonly strategy: 'ignore_and_continue' };

// ============================================================================
// §5  Node specs per execution class (registry execution classes)
// ============================================================================

/**
 * The human constructs (execution class `human`). Human nodes are PAUSE
 * POINTS: the workflow suspends until the person acts (registry events
 * workflow.run.paused/resumed; run lifecycle itself is V2-005).
 *
 *   - approval — the canonical pause-safe approval gate. Declared outcomes:
 *     `approved` / `rejected`; the node MUST expose a boolean output port
 *     named `approved`; control continues via `on: {outcome}` edges covering
 *     BOTH outcomes.
 *   - decision — the person selects one of the declared option ids. The node
 *     MUST expose a string output port named `selected`; every option id
 *     must be covered by an outcome edge.
 *   - information — the person provides the typed value (`provides`), which
 *     MUST also be the node's output port; completes via `success` edges.
 */
export type HumanStepSpec =
  | { readonly kind: 'approval'; readonly instruction: string }
  | { readonly kind: 'decision'; readonly instruction: string; readonly options: readonly string[] }
  | { readonly kind: 'information'; readonly instruction: string; readonly provides: PortDeclaration };

/**
 * A subworkflow dependency: an explicit, immutable reference to another
 * WorkflowVersion (constitution §6.4). Opaque identifiers — repository
 * semantics (V2-002) own what they resolve to; the IR never dereferences.
 */
export interface SubworkflowDependency {
  readonly workflowId: string;
  readonly versionRef: string;
}

/** The class-specific node specification (discriminated by `class`). */
export type NodeSpec =
  | { readonly class: 'deterministic_api'; readonly capability: CapabilityName }
  | { readonly class: 'agentic_computer_use'; readonly task: string }
  | { readonly class: 'human'; readonly human: HumanStepSpec }
  | { readonly class: 'subworkflow'; readonly subworkflow: SubworkflowDependency };

/** One workflow step. `spec.class` MUST equal `executionClass`. */
export interface WorkflowNode {
  readonly id: string;
  readonly executionClass: ExecutionClass;
  readonly spec: NodeSpec;
  /** canonical registry capability names (validated against the registry) */
  readonly capabilityRequirements: readonly CapabilityName[];
  readonly placement: PlacementId;
  readonly inputs: readonly PortBinding[];
  readonly outputs: readonly PortDeclaration[];
  readonly failurePolicy: StepFailurePolicy;
  /** which evidence class establishes this step's completion (§7) */
  readonly completionEvidence?: CompletionEvidenceClass;
}

// ============================================================================
// §6  The workflow IR (the semantic object)
// ============================================================================

/** How this IR came to exist (semantic, digest-affecting — per V2-003). */
export interface WorkflowProvenance {
  readonly origin: 'authored' | 'compiled' | 'imported';
  /** opaque references to provenance artifacts (sessions, captures, …) */
  readonly sourceRefs?: readonly string[];
}

/** A workflow-level output bound to a workflow input or a node output. */
export interface WorkflowOutputBinding {
  readonly name: string;
  readonly type: PortType;
  readonly from: BindingSource;
}

/**
 * The platform-neutral semantic representation of one WorkflowVersion
 * (constitution §3: THE semantic source of truth).
 */
export interface WorkflowIR {
  /** the single entry node */
  readonly start: string;
  readonly inputs: readonly PortDeclaration[];
  readonly outputs: readonly WorkflowOutputBinding[];
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly ControlEdge[];
  readonly defaultPlacement: PlacementId;
  readonly provenance: WorkflowProvenance;
}

// ============================================================================
// §7  Version-affecting compatibility metadata + presentation
// ============================================================================

/**
 * The version-affecting semantic compatibility metadata DECLARED by the IR
 * schema (registry digest rule: the WorkflowVersion semantic digest is
 * computed from the canonical WorkflowIR AND this metadata; presentation,
 * repository, marketplace, UX and deployment metadata are NOT part of it).
 *
 * `compatibilityLevel`/`*SurfaceChange` describe the change against the
 * previous version of the same workflow. Negotiation cross-checks the
 * declaration against the computed public-surface diff and rejects
 * inconsistent declarations (fail closed — honest metadata only).
 */
export interface VersionAffectingCompatibility {
  readonly compatibilityLevel: 'equivalent' | 'compatible' | 'incompatible';
  readonly inputSurfaceChange: 'none' | 'additive' | 'breaking';
  readonly outputSurfaceChange: 'none' | 'additive' | 'breaking';
}

/**
 * Presentation-only metadata: display labels, layout coordinates, notes.
 * Serialized (lossless round-trip) but EXCLUDED from the semantic digest and
 * from semantic equality (registry: presentationExcluded).
 */
export interface PresentationMetadata {
  readonly title?: string;
  readonly nodeLabels?: Readonly<Record<string, string>>;
  readonly nodePositions?: Readonly<Record<string, { x: number; y: number }>>;
  readonly notes?: string;
}

/** The serialized WorkflowIR artifact (the version's canonical document). */
export interface WorkflowIrDocument {
  readonly objectType: typeof WORKFLOW_IR_OBJECT_TYPE;
  readonly irSchemaVersion: number;
  readonly compatibility: VersionAffectingCompatibility;
  readonly ir: WorkflowIR;
  readonly presentation?: PresentationMetadata;
}

// ============================================================================
// §8  Validation / parsing results
// ============================================================================

export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export type ParseResult =
  | { readonly ok: true; readonly document: WorkflowIrDocument }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

// ============================================================================
// §9  The WorkflowVersion semantic digest (domain-separated)
// ============================================================================

/**
 * The WorkflowVersion semantic digest: SHA-256 over canonical JSON of the
 * semantic object {domain, irSchemaVersion, compatibility, ir} (registry
 * digest rule; presentation excluded). This is NOT the V2-014 execution
 * digest and shares no domain with it.
 */
export interface WorkflowVersionSemanticDigest {
  readonly algorithm: 'sha-256';
  readonly domain: typeof WORKFLOW_IR_OBJECT_TYPE;
  readonly digest: string;
}

// ============================================================================
// §10  Compatibility / version negotiation contracts
// ============================================================================

/**
 * A declared schema-upgrade path (migration metadata). The DECISION layer
 * consumes this metadata only; executing a migration is a compiler/repository
 * concern, never guessed here.
 */
export interface IrSchemaMigration {
  readonly from: number;
  readonly to: number;
  readonly upgradeSafe: boolean;
  readonly description?: string;
}

export type IrSchemaNegotiationResult =
  | { readonly decision: 'accept'; readonly irSchemaVersion: number }
  | { readonly decision: 'upgrade'; readonly from: number; readonly to: number }
  | {
      readonly decision: 'reject';
      readonly reason: 'schema-too-new' | 'no-upgrade-path' | 'no-supported-versions';
    };

/** The public surface snapshot of one WorkflowVersion (for negotiation). */
export interface WorkflowSurfaceSnapshot {
  readonly inputs: readonly PortDeclaration[];
  readonly outputs: readonly WorkflowOutputBinding[];
  readonly compatibility: VersionAffectingCompatibility;
}

export type WorkflowVersionUpdateDecision =
  | { readonly decision: 'accept'; readonly reason: 'public-surface-unchanged' }
  | { readonly decision: 'upgrade'; readonly reason: 'additive-compatible-surface' }
  | {
      readonly decision: 'reject';
      readonly reason: 'breaking-change' | 'compatibility-declaration-inconsistent';
    };

// ============================================================================
// §11  The typed error surface (fail-closed rejections)
// ============================================================================

export const WORKFLOW_IR_ERROR_CODES = [
  'WORKFLOW_IR_INVALID',
  'WORKFLOW_IR_CANONICAL_VALUE_NOT_JSON',
] as const;
export type WorkflowIrErrorCode = (typeof WORKFLOW_IR_ERROR_CODES)[number];

/** Typed, fail-closed error for IR operations (never a silent default). */
export class WorkflowIrError extends Error {
  readonly code: WorkflowIrErrorCode;
  readonly issues: readonly ValidationIssue[];

  constructor(code: WorkflowIrErrorCode, message: string, issues: readonly ValidationIssue[] = []) {
    super(message);
    this.name = 'WorkflowIrError';
    this.code = code;
    this.issues = issues;
  }
}
