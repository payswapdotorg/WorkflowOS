/**
 * V2-007 — Workflow Compiler: the public domain contracts.
 *
 * The domain lives at `src/workflow-compiler/` (application-layer pure
 * domain module — workflow-ir / node-capability precedent). It owns EXACTLY
 * the Work Order V2-007 scope:
 *
 *   - deterministic compilation of a canonical WorkflowIR document (the
 *     merged V2-003 implementation — this module's declared `implementation`
 *     dependency) into an executable compiled plan;
 *   - explicit, typed compile diagnostics with a fail-closed taxonomy
 *     (IR-valid-but-compiler-unrepresentable documents are REJECTED, never
 *     guessed forward);
 *   - compile-time capability and placement checks before execution
 *     (canonical registry vocabulary only, aliases forbidden);
 *   - compiled-artifact provenance bound to the source WorkflowVersion
 *     SEMANTIC digest + compiler identity + schema identity, preserved
 *     through export/import;
 *   - safe handling of model-generated plans: generated intent is intent,
 *     never proof of execution — the compiled artifact is inspectable data;
 *   - deterministic compiled-artifact identity (canonical JSON + sha-256);
 *   - semantic-equivalence projection (compiled plan → IR-comparable form).
 *
 * BOUNDARY CONTRACT (spec/architecture/v2/work-orders/V2-007.md):
 *
 *   - The compiler is a DERIVED TRANSFORMATION of the WorkflowIR. It is
 *     NEVER a replacement workflow representation and never a second
 *     authority: the WorkflowIR inside its immutable WorkflowVersion remains
 *     the semantic source of truth (constitution §3), and the compiled
 *     artifact carries the source semantic digest as a verifiable binding.
 *   - NOT repository persistence/versioning (V2-002), NOT WorkflowIR
 *     semantics (V2-003), NOT Run/evidence persistence (V2-005), NOT
 *     teaching (V2-006), NOT node/capability matching semantics (V2-004 —
 *     requirement sets are carried as DATA), NOT computer-agent execution
 *     (V2-008), NOT scheduling/events/optimization/marketplace.
 *   - NO execution-attestation concepts: ExecutionStatement/ExecutionDigest/
 *     ExecutionAttestation are owned by V2-014 under the domain
 *     workflowos/execution-statement/v1. The digest here is the COMPILED
 *     ARTIFACT digest (domain workflowos/compiled-workflow/v1) — a DIFFERENT,
 *     domain-separated commitment that never hashes execution facts.
 *   - NO execution semantics: the artifact contains no run, attempt, status,
 *     result or evidence-of-execution fields. Compiling a plan (however it
 *     was authored, including model-generated) executes NOTHING.
 *   - Secret material NEVER enters the compiled artifact: secret ports pass
 *     through as opaque `secret_ref` handles only (constitution §16).
 */

import type {
  BindingSource,
  CompletionEvidenceClass,
  ExecutionClass,
  NodeSpec,
  PlacementId,
  PortDeclaration,
  PortBinding,
  PortType,
  StepFailurePolicy,
  WorkflowIrDocument,
  WorkflowOutputBinding,
} from '../workflow-ir/index.js';
import { WORKFLOW_IR_OBJECT_TYPE } from '../workflow-ir/index.js';

// ============================================================================
// §0  Compiler identity and the compiled-artifact object type
// ============================================================================

/**
 * The canonical object type of a serialized compiled-workflow artifact.
 *
 * REGISTRY-CONFORMANCE NOTE (V2-CTRL-003 registry-conformance rule 5):
 * `workflowos/compiled-workflow/v1` is a genuinely new protocol object-type
 * identifier — the registry's object types are the three execution-
 * attestation ones owned by V2-014, none of which covers a compiled plan.
 * It is kept SCHEMA-INTERNAL and compiler-scoped here; discrimination tests
 * pin that it is distinct from every registry attestation object type AND
 * from the WorkflowIR object type, and a governed registry extension is
 * REQUIRED before it becomes protocol-visible (persisted as a V2-007
 * finding, never silently widened).
 */
export const COMPILED_WORKFLOW_OBJECT_TYPE = 'workflowos/compiled-workflow/v1';

/** The stable identity of this compiler implementation. */
export const WORKFLOW_COMPILER_ID = 'workflowos/workflow-compiler';

/** The compiler version this module implements. */
export const WORKFLOW_COMPILER_VERSION = 1;

/** The compiler versions this build accepts (compile requests + artifacts). */
export const SUPPORTED_WORKFLOW_COMPILER_VERSIONS: readonly number[] = [WORKFLOW_COMPILER_VERSION];

// ============================================================================
// §1  The typed diagnostic taxonomy (fail-closed, closed vocabulary)
// ============================================================================

/**
 * The closed compiler error/diagnostic vocabulary. Every rejection is one of
 * these typed codes — never a silent default, never a guessed-forward
 * interpretation.
 */
export const WORKFLOW_COMPILER_ERROR_CODES = [
  /** the source (or the options) is not a valid compile input */
  'WORKFLOW_COMPILER_INPUT_INVALID',
  /** a capability name/invocation is non-canonical, unknown or undeclared */
  'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED',
  /** contradictory placement requirements (locality is a correctness constraint) */
  'WORKFLOW_COMPILER_PLACEMENT_CONFLICT',
  /** the control graph is invalid or compiler-unrepresentable (e.g. cyclic) */
  'WORKFLOW_COMPILER_GRAPH_INVALID',
  /** a failure-policy/step contract the compiler cannot honor */
  'WORKFLOW_COMPILER_POLICY_VIOLATION',
  /** an unsupported compiler version was requested or declared */
  'WORKFLOW_COMPILER_VERSION_UNSUPPORTED',
  /** ambiguous input the compiler refuses to silently normalize */
  'WORKFLOW_COMPILER_AMBIGUOUS_INPUT',
  /** a malformed/tampered compiled artifact (shape, digest, provenance) */
  'WORKFLOW_COMPILER_ARTIFACT_INVALID',
] as const;
export type WorkflowCompilerErrorCode = (typeof WORKFLOW_COMPILER_ERROR_CODES)[number];

/** A reference to the underlying WorkflowIR validation issue, when one exists. */
export interface IrIssueReference {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** One typed compile/verification diagnostic. */
export interface CompileDiagnostic {
  readonly code: WorkflowCompilerErrorCode;
  readonly path: string;
  readonly message: string;
  readonly irIssue?: IrIssueReference;
}

// ============================================================================
// §2  The compiled plan (the inspectable executable representation)
// ============================================================================

/** One compiled workflow step (a compiled node with flattened control). */
export interface CompiledUnit {
  /** the source node id (stable, addressable) */
  readonly unit: string;
  readonly executionClass: ExecutionClass;
  readonly spec: NodeSpec;
  /** canonical registry capability names, set-normalized (sorted) */
  readonly capabilityRequirements: readonly string[];
  readonly placement: PlacementId;
  /** typed input bindings, sorted by port name */
  readonly inputs: readonly PortBinding[];
  /** declared output ports, sorted by port name */
  readonly outputs: readonly PortDeclaration[];
  readonly failurePolicy: StepFailurePolicy;
  /** the declared disclosure of what establishes this step's completion */
  readonly completionEvidence?: CompletionEvidenceClass;
  /** ordered on-success successor unit ids (canonical target order) */
  readonly onSuccess: readonly string[];
  /** the single on-failure successor (failover), or null */
  readonly onFailure: string | null;
  /** human outcome continuations, sorted by (outcome, target) */
  readonly onOutcomes: readonly { readonly outcome: string; readonly to: string }[];
}

/**
 * The executable plan: the source workflow's declared semantics in an
 * inspectable, deterministic, unit-indexed form. The units are emitted in
 * deterministic breadth-first order from the entry; the control semantics
 * are the flattened successor lists (the plan is a graph, not a trace).
 */
export interface CompiledWorkflowPlan {
  readonly entry: string;
  readonly units: readonly CompiledUnit[];
  readonly inputs: readonly PortDeclaration[];
  readonly outputs: readonly WorkflowOutputBinding[];
  readonly defaultPlacement: PlacementId;
}

// ============================================================================
// §3  Compiled-artifact provenance (compiler + source + options identity)
// ============================================================================

/** The source WorkflowVersion binding carried by every compiled artifact. */
export interface CompiledWorkflowSourceProvenance {
  readonly digestAlgorithm: 'sha-256';
  readonly digestDomain: typeof WORKFLOW_IR_OBJECT_TYPE;
  readonly irSchemaVersion: number;
  readonly objectType: typeof WORKFLOW_IR_OBJECT_TYPE;
  readonly origin: 'authored' | 'compiled' | 'imported';
  /** the source WorkflowVersion SEMANTIC digest (computed by V2-003, never here) */
  readonly semanticDigest: string;
  /** opaque source-provenance references, sorted (never secret material) */
  readonly sourceRefs?: readonly string[];
}

/** The provenance block: who compiled, from what, under which options. */
export interface CompiledWorkflowProvenance {
  readonly compiler: { readonly id: string; readonly version: number };
  /** sha-256 (hex) over the canonical normalized declared compile options */
  readonly optionsDigest: string;
  readonly source: CompiledWorkflowSourceProvenance;
}

// ============================================================================
// §4  The compiled artifact and its digest
// ============================================================================

/**
 * The compiled-workflow artifact: an inspectable, reproducible, deterministic
 * representation of ONE WorkflowVersion's executable plan, bound to the
 * source semantic digest. It contains NO execution status/result fields:
 * compiling a plan is not executing it, and a valid artifact is never
 * evidence that anything ran.
 */
export interface CompiledWorkflowArtifact {
  /** sha-256 over the canonical artifact preimage (self-verification) */
  readonly artifactDigest: string;
  readonly objectType: typeof COMPILED_WORKFLOW_OBJECT_TYPE;
  readonly plan: CompiledWorkflowPlan;
  readonly provenance: CompiledWorkflowProvenance;
}

/** The compiled-artifact digest (domain-separated, sha-256). */
export interface CompiledWorkflowDigest {
  readonly algorithm: 'sha-256';
  readonly domain: typeof COMPILED_WORKFLOW_OBJECT_TYPE;
  readonly digest: string;
}

// ============================================================================
// §5  Compile options and results
// ============================================================================

/**
 * Declared compile options. The closed option surface: unknown keys are
 * rejected, and an explicitly declared option is part of the artifact's
 * options-digest commitment (a caller who pins `compilerVersion: 1` gets a
 * different artifact identity from a caller relying on defaults).
 */
export interface CompileOptions {
  /** the compiler version requested for this compilation (must be supported) */
  readonly compilerVersion?: number;
}

export type CompileResult =
  | { readonly ok: true; readonly artifact: CompiledWorkflowArtifact }
  | { readonly ok: false; readonly diagnostics: readonly CompileDiagnostic[] };

export type CompiledArtifactParseResult =
  | { readonly ok: true; readonly artifact: CompiledWorkflowArtifact }
  | { readonly ok: false; readonly diagnostics: readonly CompileDiagnostic[] };

export type CompiledArtifactVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostics: readonly CompileDiagnostic[] };

// ============================================================================
// §6  The typed error surface (fail-closed rejections)
// ============================================================================

/** Typed, fail-closed error for compiler operations (never a silent default). */
export class WorkflowCompilerError extends Error {
  readonly code: WorkflowCompilerErrorCode;
  readonly diagnostics: readonly CompileDiagnostic[];

  constructor(
    code: WorkflowCompilerErrorCode,
    message: string,
    diagnostics: readonly CompileDiagnostic[] = [],
  ) {
    super(message);
    this.name = 'WorkflowCompilerError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

// Re-export the IR contracts this module's public surface is built on (the
// compiled plan reuses the merged V2-003 port/spec/policy contracts as-is —
// the compiler never redefines WorkflowIR semantics).
export type {
  BindingSource,
  CompletionEvidenceClass,
  ExecutionClass,
  NodeSpec,
  PlacementId,
  PortDeclaration,
  PortBinding,
  PortType,
  StepFailurePolicy,
  WorkflowIrDocument,
  WorkflowOutputBinding,
};
