/**
 * V2-015 — Execution Proof Graph: the public contracts.
 *
 * WORK ORDER: spec/architecture/v2/work-orders/V2-015.md
 * ARCHITECTURE CHANGE: V2-ACR-001 — Verifiable Execution and Execution
 *   Attestation
 * REGISTRY: spec/architecture/v2/V2-CTRL-003-protocol-registry.md (+ .json)
 *   — this module owns EXACTLY the registry object type
 *   `workflowos/execution-proof-graph/v1` (the third attestationObjectType).
 *
 * The domain lives at `src/execution-proof-graph/` (application-layer pure
 * domain module — the V2-014 execution-attestation structural precedent).
 *
 * V2-015 owns EXACTLY:
 *   - the ExecutionProofGraph model + deterministic serialization;
 *   - causal and dependency edge semantics between attestations;
 *   - admission predicates based on VerifiedExecutionFacts;
 *   - cross-device continuation composition that preserves
 *     Run/WorkflowVersion identity;
 *   - multi-parent dependency satisfaction;
 *   - replay/duplicate convergence at graph level;
 *   - trust-policy evaluation INPUTS specific to proof composition;
 *   - dedicated graph and coordination tests.
 *
 * BOUNDARY CONTRACT (load-bearing, pinned by
 * tests/architecture/execution-proof-graph-boundary.test.ts):
 *
 *   - V2-003 (WorkflowIR) remains the ONLY workflow-semantics authority: this
 *     module NEVER imports workflow-ir; the WorkflowVersion semantic digest
 *     is carried as OPAQUE reference binding data (strings), exactly as
 *     V2-014 carries it. The proof graph is EVIDENCE about executions, never
 *     a second workflow graph (invariant 1).
 *   - V2-014 remains the ONLY cryptographic verification authority: this
 *     module consumes `ExecutionAttestation` envelopes and
 *     `VerifiedExecutionFact`/`AttestationVerification` RESULTS as data; it
 *     NEVER calls the verifier and NEVER re-implements signing/verification
 *     (invariant 12).
 *   - V2-005 remains the Run/evidence persistence authority: no durable
 *     storage, no run lifecycle. Graph facts are composed over supplied
 *     records; durable persistence of graph state is not required by the
 *     frozen work order (the graph is a deterministic composition over
 *     existing evidence).
 *   - V2-004 remains the node identity/capability authority: capability and
 *     placement facts arrive as explicit policy inputs; this module never
 *     evaluates capability possession or placement itself (invariant 9).
 *   - V2-008 remains the computer-use execution authority: this module never
 *     executes anything; cross-device continuation is a composition layer
 *     that PRODUCES typed admission/precondition inputs for the caller.
 *   - V2-009 remains the events/scheduling/placement authority.
 *   - V2-012 (collaboration/marketplace/economics) is an independent
 *     sibling: nothing is imported from it.
 *   - NO routes, NO migrations, NO new dependencies: hashing through the
 *     Node builtin `node:crypto` (SHA-256 identity derivations only) and the
 *     merged V2-014 public canonical-JSON utility.
 *   - DETERMINISM: no wall clock, no randomness, no network in the module
 *     source — every timestamp/epoch is injected; every ordering is
 *     canonical (sorted) and derivation is pure.
 */

import type {
  AssuranceLevel,
  AttestationBindingDimension,
  AttestationFailureCode,
  AttestationVerification,
  Sha256Hex,
  UtcTimestamp,
} from '../execution-attestation/index.js';

// ============================================================================
// §0 Domain identity (registry attestationObjectTypes — V2-015's one)
// ============================================================================

/**
 * The canonical object type of an ExecutionProofGraph (registry, frozen).
 * The THIRD registered attestation object type; deliberately absent from
 * V2-014's vocabulary (its boundary battery pins that absence).
 */
export const EXECUTION_PROOF_GRAPH_OBJECT_TYPE = 'workflowos/execution-proof-graph/v1';

/** The current proof-graph schema version. */
export const EXECUTION_PROOF_GRAPH_SCHEMA_VERSION = 1;

/** The registry protocol event emitted when a proof graph is updated. */
export const EXECUTION_PROOF_UPDATED_EVENT_NAME = 'execution.proof.updated' as const;

// ============================================================================
// §1 Vocabularies (V2-015-owned; frozen here, pinned to the registry)
// ============================================================================

/**
 * The two edge relations of the proof graph.
 *
 *   - `causal`: the child attestation's own statement DECLARES the parent's
 *     execution digest in `causalParents` (the executor-side causal claim).
 *   - `dependency`: the COMPOSITION authority (the caller) declares that a
 *     dependent action relies on the parent — the admission-side dependency
 *     claim. NEVER derived from WorkflowIR here (V2-003 owns workflow
 *     semantics); the caller declares the dependency set explicitly.
 */
export const PROOF_EDGE_RELATIONS = ['causal', 'dependency'] as const;
export type ProofEdgeRelation = (typeof PROOF_EDGE_RELATIONS)[number];

/**
 * The admission dimensions — one per SEPARATE decision dimension
 * (invariant 9: node capability, authorization, placement, attestation
 * assurance and verification result remain separate dimensions).
 */
export const PROOF_ADMISSION_DIMENSIONS = [
  'verification',
  'binding',
  'freshness',
  'assurance',
  'trust',
  'capability',
  'authorization',
  'placement',
  'parents',
] as const;
export type ProofAdmissionDimension = (typeof PROOF_ADMISSION_DIMENSIONS)[number];

// ============================================================================
// §2 Identity prefixes (stable identity namespaces)
// ============================================================================

export const PROOF_GRAPH_ID_PREFIX = 'wfpg_';
export const PROOF_NODE_ID_PREFIX = 'wfpgn_';
export const PROOF_EDGE_ID_PREFIX = 'wfpge_';

/**
 * The internal hash domain labels for V2-015 identity derivations
 * (module-internal MAC discipline — mirrors V2-014's ATTESTER_KEY_ID_DOMAIN
 * pattern; domain-separated from every other digest domain).
 */
export const PROOF_GRAPH_ID_DOMAIN = 'workflowos/execution-proof-graph/v1';
export const PROOF_NODE_ID_DOMAIN = 'workflowos/proof-node/v1';
export const PROOF_EDGE_ID_DOMAIN = 'workflowos/proof-edge/v1';
export const PROOF_PARENT_COMMITMENT_DOMAIN = 'workflowos/proof-parents/v1';

// ============================================================================
// §3 The graph node (one attestation, one stable execution identity)
// ============================================================================

/**
 * One node of the proof graph: bound to EXACTLY one valid ExecutionAttestation
 * (invariant 2) and carrying the stable execution identity plus the
 * Run/WorkflowVersion binding (invariant 5).
 *
 * The node is a DETERMINISTIC PROJECTION of the bound attestation: every
 * field is derived from (or copied verbatim out of) the attestation envelope
 * and its embedded statement. Two deliveries of the same attestation
 * therefore produce the IDENTICAL node (byte-deterministic convergence —
 * invariant 7) and a conflicting redefinition of the same identity is a
 * typed rejection, never a last-write-wins (invariant 11).
 *
 * The node does NOT carry the signature or the public key: the graph is
 * evidence ABOUT executions; cryptographic authenticity is V2-014's verdict
 * (carried per-admission as the VerifiedExecutionFact, never stored here).
 */
export interface ExecutionProofNode {
  /** The stable graph-node identity (derived ONLY from attestationId). */
  readonly nodeIdentity: string;
  /** The bound attestation identity (V2-014 `attestationId`, `wfea_…`). */
  readonly attestationId: string;
  /** The bound execution digest value (V2-014 `executionDigest.digest`). */
  readonly executionDigest: Sha256Hex;
  /** The attester key identity that signed the bound attestation. */
  readonly attesterKeyId: string;
  /** The assurance level claimed by the bound attestation. */
  readonly assurance: AssuranceLevel;
  /** The claimed execution outcome (a claim — never side-effect evidence). */
  readonly outcome: 'succeeded' | 'failed';
  /** Workflow identity (opaque external identity — V2-002 scope). */
  readonly workflowId: string;
  /** The immutable WorkflowVersion identity (opaque external identity). */
  readonly workflowVersionId: string;
  /** The WorkflowIR semantic digest (opaque binding data — V2-003's). */
  readonly workflowVersionSemanticDigest: Sha256Hex;
  /** Run identity (opaque external identity — V2-005's). */
  readonly runId: string;
  /** Execution-attempt identity within the run (integer >= 1). */
  readonly attemptId: number;
  /** Step identity when the bound fact concerns a step (null otherwise). */
  readonly stepId: string | null;
  /** The executor's node identity (opaque external identity — V2-004's). */
  readonly executorNodeId: string;
  /**
   * The sorted causal-parent execution digests DECLARED by the bound
   * attestation's own statement (the executor-side causal claim, canonical
   * sorted set — deterministic ordering, invariant 3).
   */
  readonly declaredCausalParents: readonly Sha256Hex[];
  /**
   * The parent commitment: sha-256 over the domain-separated canonical
   * projection of `declaredCausalParents`. A coordinator that alters parent
   * relationships cannot forge this commitment (mutation detection,
   * invariant 10).
   */
  readonly parentCommitment: Sha256Hex;
}

// ============================================================================
// §4 The graph edge (one causal or dependency relation between two nodes)
// ============================================================================

/**
 * One edge of the proof graph: a typed relation between two graph nodes.
 *
 * Edges are DETERMINISTIC DATA: the edge identity is derived ONLY from
 * (relation, parent execution digest, child execution digest); delivering
 * the same relation twice converges on the same identity (invariant 7).
 *
 * Edge semantics are validated structurally against the bound nodes:
 *   - a `causal` edge's parent digest MUST appear in the child node's
 *     `declaredCausalParents` (the child's own statement declared it);
 *   - a `dependency` edge declares a composition-side reliance — the parent
 *     must exist in the graph, and the relation must be acyclic;
 *   - every edge binds BOTH endpoint digests (the coordinator cannot
 *     re-wire an edge without breaking the digest binding — invariant 10).
 */
export interface ExecutionProofEdge {
  /** The stable graph-edge identity (derived ONLY from relation+digests). */
  readonly edgeIdentity: string;
  /** The edge's relation (causal = executor-declared; dependency = composition-declared). */
  readonly relation: ProofEdgeRelation;
  /** The parent node's identity (`wfpgn_…`). */
  readonly parentNode: string;
  /** The child node's identity (`wfpgn_…`). */
  readonly childNode: string;
  /** The parent's execution digest (the immutable endpoint binding). */
  readonly parentExecutionDigest: Sha256Hex;
  /** The child's execution digest (the immutable endpoint binding). */
  readonly childExecutionDigest: Sha256Hex;
}

// ============================================================================
// §5 The graph (deterministic, append-only evidence state)
// ============================================================================

/**
 * The proof graph: EVIDENCE about executions (invariant 1) — never a
 * workflow model. One logical graph per (workflow, workflowVersion, run)
 * scope: the graph identity is derived ONLY from that triple, so duplicate
 * graph delivery converges on the same logical object (invariant 7) and
 * cross-device continuation preserves Run/WorkflowVersion identity
 * (invariant 5) by construction.
 *
 * The state is APPEND-ONLY (invariant 11): nodes and edges are only ever
 * added; prior verified facts cannot be erased or rewritten. Collections are
 * canonically sorted (nodes by nodeIdentity, edges by edgeIdentity) so the
 * state is byte-deterministic regardless of insertion order (invariant 3).
 */
export interface ExecutionProofGraph {
  /** MUST be exactly `workflowos/execution-proof-graph/v1`. */
  readonly objectType: typeof EXECUTION_PROOF_GRAPH_OBJECT_TYPE;
  readonly schemaVersion: number;
  /** The stable graph identity (`wfpg_…`). */
  readonly graphIdentity: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowVersionSemanticDigest: Sha256Hex;
  readonly runId: string;
  /** All nodes, sorted by nodeIdentity (deterministic). */
  readonly nodes: readonly ExecutionProofNode[];
  /** All edges, sorted by edgeIdentity (deterministic). */
  readonly edges: readonly ExecutionProofEdge[];
}

// ============================================================================
// §6 Graph mutation results + the typed failure taxonomy
// ============================================================================

/** V2-015 graph-level failure codes (typed, fail-closed, never boolean). */
export const PROOF_GRAPH_FAILURE_CODES = [
  /** A candidate node is structurally invalid. */
  'GRAPH_NODE_INVALID',
  /** Same node identity, different content — append-only violation. */
  'GRAPH_NODE_CONFLICT',
  /** A candidate edge is structurally invalid (relation/identity/digests). */
  'GRAPH_EDGE_INVALID',
  /** Same edge identity, different content — append-only violation. */
  'GRAPH_EDGE_CONFLICT',
  /** The edge references an unknown node. */
  'GRAPH_EDGE_UNKNOWN_NODE',
  /** A self-edge (a node relating to itself). */
  'GRAPH_EDGE_SELF_LOOP',
  /** The edge would introduce a cycle. */
  'GRAPH_EDGE_CYCLE',
  /** The edge's parent digest is not declared by the child (causal edges). */
  'GRAPH_EDGE_PARENT_UNDECLARED',
  /** A candidate does not belong to this graph's scope. */
  'GRAPH_SCOPE_MISMATCH',
  /** Serialization/parse-level structural failure. */
  'GRAPH_SERIALIZATION_INVALID',
] as const;
export type ProofGraphFailureCode = (typeof PROOF_GRAPH_FAILURE_CODES)[number];

/** A typed graph-level failure (discriminated by `code`, fail-closed). */
export interface ProofGraphFailure {
  readonly code: ProofGraphFailureCode;
  readonly detail: string;
  /** The offending identity when structurally recoverable. */
  readonly identity?: string;
}

/** The result of ONE append-only graph mutation. */
export type ProofGraphMutationResult =
  | {
      readonly kind: 'accepted';
      readonly node?: ExecutionProofNode;
      readonly edge?: ExecutionProofEdge;
      /** The graph state AFTER the mutation (new immutable snapshot). */
      readonly graph: ExecutionProofGraph;
    }
  | {
      /** Duplicate delivery — converged to the existing logical fact. */
      readonly kind: 'duplicate';
      readonly node?: ExecutionProofNode;
      readonly edge?: ExecutionProofEdge;
      readonly graph: ExecutionProofGraph;
    }
  | {
      readonly kind: 'rejected';
      readonly failure: ProofGraphFailure;
      /** The graph state UNCHANGED (append-only: rejections never mutate). */
      readonly graph: ExecutionProofGraph;
    };

// ============================================================================
// §7 Admission: predicate inputs (explicit policy dimensions)
// ============================================================================

/**
 * ONE predecessor evidence supply for an admission decision: the typed
 * V2-014 verification RESULT (never raw bytes — a signature-valid envelope
 * that was never verified cannot occupy this slot, structurally).
 *
 * IDENTITY BINDING (fail-closed, enforced structurally by admission): the
 * wrapper's `executionDigest` is the graph binding key under which the
 * evidence is supplied, and it MUST equal the verified fact's OWN
 * `executionDigest.digest` (V2-014's `VerifiedExecutionFact` carries its own
 * execution digest, independent of this wrapper field). A wrapper keyed
 * under digest A paired with a verified fact for digest B is a typed
 * `ADMISSION_EVIDENCE_IDENTITY_MISMATCH` — never a lookup-key substitution
 * vector (admission is bound to the EXACT declared predecessor execution
 * fact).
 */
export interface PredecessorEvidence {
  /** The predecessor's execution digest (the graph binding key). */
  readonly executionDigest: Sha256Hex;
  /** The V2-014 verification result for the predecessor attestation. */
  readonly verification: AttestationVerification;
}

/**
 * The capability dimension INPUT (V2-004's authority, consumed as explicit
 * data): what the caller's node-directory/policy evaluation reported about
 * the predecessor's executor node. The admission layer CHECKS that an
 * explicit capability fact was supplied and satisfies the requirement; it
 * never evaluates capability possession itself (invariant 9).
 */
export interface CapabilityFactInput {
  /** The executor node the fact is about (V2-014 statement nodeId). */
  readonly nodeId: string;
  /** Capabilities the node directory reports as POSSESSED (canonical names). */
  readonly possessedCapabilities: readonly string[];
}

/**
 * The authorization dimension INPUT (the existing authorization authority's
 * decision, consumed as explicit data): an explicit GRANT the caller
 * supplies. Absence of a matching grant denies admission — the admission
 * layer never grants anything itself.
 */
export interface AuthorizationGrantInput {
  readonly nodeId: string;
  /** The canonical capability the grant authorizes. */
  readonly capability: string;
}

/**
 * The placement dimension INPUT (V2-009's authority, consumed as explicit
 * data): the eligibility the placement evaluation reported for a node under
 * the declared placement constraint. The admission layer checks the
 * explicit eligibility fact; it never evaluates placement.
 */
export interface PlacementEligibilityInput {
  readonly nodeId: string;
  /** The placement constraint id the evaluation ran under (registry). */
  readonly placementConstraint: string;
  /** The eligibility verdict the V2-009 evaluation produced. */
  readonly eligible: boolean;
}

/**
 * The trust-policy evaluation INPUT specific to proof composition
 * (invariant 8: trust policy remains EXPLICIT; signature validity never
 * silently becomes trust).
 *
 *   - `trustedAttesterKeyIds`: the attester keys this composition chooses
 *     to trust. The EMPTY list trusts NOBODY (fail-closed) — a verified
 *     fact from an unlisted attester is a typed trust rejection, never a
 *     silent admission.
 *   - `requiredAssurance`: the minimum assurance level this composition
 *     requires of predecessor evidence.
 *   - freshness bounds: the injected admission-time clock, the current
 *     protocol epoch, and the maximum accepted age of the VERIFICATION
 *     (not merely of the execution — a fact verified long ago is stale
 *     evidence at admission time).
 */
export interface ProofCompositionTrustPolicy {
  readonly trustedAttesterKeyIds: readonly string[];
  readonly requiredAssurance?: AssuranceLevel;
  /** REQUIRED: the injected admission clock (fail-closed when absent). */
  readonly now: UtcTimestamp;
  /** REQUIRED: the verifier's current protocol epoch. */
  readonly currentEpoch: number;
  /** Maximum age of the predecessor VERIFICATION (verifiedAt → now). */
  readonly maxVerificationAgeMs?: number;
}

/**
 * ONE admission predicate evaluation input: the dependent action, the
 * parent set it declares, the evidence supplied for those parents, and the
 * explicit per-dimension policy inputs.
 */
export interface ProofAdmissionInput {
  /** The dependent action's own scope binding (the admission target). */
  readonly dependent: {
    readonly stepId: string;
    readonly workflowId: string;
    readonly workflowVersionId: string;
    readonly workflowVersionSemanticDigest: Sha256Hex;
    readonly runId: string;
  };
  /**
   * The EXACT declared parent set (sorted execution digests). The dependent
   * action is admitted only when EVERY declared parent is satisfied by a
   * verified fact — an extra supplied parent NEVER silently satisfies a
   * missing one (multi-parent semantics).
   */
  readonly declaredParents: readonly Sha256Hex[];
  /** The evidence supplied for the declared parents (binding by digest). */
  readonly predecessorEvidence: readonly PredecessorEvidence[];
  /** The explicit trust/assurance/freshness policy (REQUIRED). */
  readonly trustPolicy: ProofCompositionTrustPolicy;
  /** The capability facts (REQUIRED when a capabilityRequirement is set). */
  readonly capabilityFacts?: readonly CapabilityFactInput[];
  /** The capability names the dependent action requires of predecessors' executors. */
  readonly capabilityRequirement?: readonly string[];
  /** The explicit authorization grants (REQUIRED when authorizationRequired). */
  readonly authorizationGrants?: readonly AuthorizationGrantInput[];
  /** When true, an explicit grant must cover the dependent capability. */
  readonly authorizationRequired?: boolean;
  /** The dependent action's canonical capability (for grant matching). */
  readonly dependentCapability?: string;
  /** The placement eligibility facts (REQUIRED when a placementConstraint is set). */
  readonly placementEligibility?: readonly PlacementEligibilityInput[];
  /** The declared placement constraint (registry id) when placement matters. */
  readonly placementConstraint?: string;
}

// ============================================================================
// §8 Admission results (typed per-dimension rejections)
// ============================================================================

/** V2-015 admission-level failure codes (typed, fail-closed, never boolean). */
export const PROOF_ADMISSION_FAILURE_CODES = [
  /** The input itself is structurally invalid (fail-closed). */
  'ADMISSION_INPUT_INVALID',
  /** A declared parent has NO supplied evidence at all. */
  'ADMISSION_PARENT_MISSING',
  /** The supplied V2-014 verification FAILED (code carried verbatim). */
  'ADMISSION_PREDECESSOR_UNVERIFIED',
  /**
   * The evidence wrapper's `executionDigest` does not bind the verified
   * fact's OWN execution digest — pairing a verified fact for digest B
   * under the wrapper key A is an identity substitution, rejected before
   * the fact is used (fail-closed).
   */
  'ADMISSION_EVIDENCE_IDENTITY_MISMATCH',
  /** The fact's bindings do not match the dependent's scope. */
  'ADMISSION_PREDECESSOR_BINDING_MISMATCH',
  /** The fact is stale at admission time (validity/epoch/verification age). */
  'ADMISSION_PREDECESSOR_STALE',
  /** The fact's assurance is below the explicit required level. */
  'ADMISSION_ASSURANCE_INSUFFICIENT',
  /** The fact's attester is not in the trusted set (empty trusts nobody). */
  'ADMISSION_TRUST_POLICY_REJECTED',
  /** The capability fact is missing or the executor lacks the capability. */
  'ADMISSION_CAPABILITY_ABSENT',
  /** No explicit authorization grant covers the dependent action. */
  'ADMISSION_AUTHORIZATION_DENIED',
  /** The placement fact is missing or the node is ineligible. */
  'ADMISSION_PLACEMENT_INELIGIBLE',
] as const;
export type ProofAdmissionFailureCode = (typeof PROOF_ADMISSION_FAILURE_CODES)[number];

/** A typed admission failure (one dimension, machine-readable detail). */
export interface ProofAdmissionFailure {
  readonly code: ProofAdmissionFailureCode;
  /** The SEPARATE dimension that failed (invariant 9). */
  readonly dimension: ProofAdmissionDimension;
  readonly detail: string;
  /** The declared parent digest the failure concerns (when applicable). */
  readonly parentDigest?: Sha256Hex;
  /** Only present for ADMISSION_PREDECESSOR_UNVERIFIED: V2-014's own code. */
  readonly verifierFailureCode?: AttestationFailureCode;
  /** Only present for ADMISSION_PREDECESSOR_BINDING_MISMATCH. */
  readonly bindingDimension?: AttestationBindingDimension;
  /** Only present for ADMISSION_PREDECESSOR_BINDING_MISMATCH. */
  readonly expected?: string;
  /** Only present for ADMISSION_PREDECESSOR_BINDING_MISMATCH. */
  readonly actual?: string;
}

/**
 * The admission predicate result: admitted with the satisfied parent set,
 * or ONE typed dimension failure (the first failed dimension in the
 * canonical evaluation order — deterministic, never a boolean).
 */
export type ProofAdmissionResult =
  | {
      readonly admitted: true;
      readonly dependentStepId: string;
      /** The satisfied parent digests (canonical sorted order). */
      readonly satisfiedParents: readonly Sha256Hex[];
      /** The attester key ids trusted for this decision (explicit record). */
      readonly trustedAttesterKeyIds: readonly string[];
    }
  | {
      readonly admitted: false;
      readonly failure: ProofAdmissionFailure;
    };

// ============================================================================
// §9 Typed error surface (parse/serialization-level)
// ============================================================================

export const EXECUTION_PROOF_GRAPH_ERROR_CODES = [
  'EXECUTION_PROOF_GRAPH_INVALID',
] as const;
export type ExecutionProofGraphErrorCode = (typeof EXECUTION_PROOF_GRAPH_ERROR_CODES)[number];

/** Typed, fail-closed error for proof-graph operations (never a silent default). */
export class ExecutionProofGraphError extends Error {
  readonly code: ExecutionProofGraphErrorCode;
  readonly issues: readonly ProofGraphFailure[];

  constructor(code: ExecutionProofGraphErrorCode, message: string, issues: readonly ProofGraphFailure[] = []) {
    super(message);
    this.name = 'ExecutionProofGraphError';
    this.code = code;
    this.issues = issues;
  }
}

// ============================================================================
// §10 Re-exports of CONSUMED V2-014 public data types (composition surface)
// ============================================================================

/**
 * Re-exported CONSUMED contracts (type-only): the V2-014 public types this
 * module composes. Re-exporting keeps V2-015's consumers importing from ONE
 * public barrel while V2-014 remains the authority. Value re-exports are
 * limited to identity/canonicalization utilities consumed from V2-014's
 * public barrel (see index.ts — never `internal/`).
 */
export type {
  AssuranceLevel,
  AttestationBindingDimension,
  AttestationFailureCode,
  AttestationVerification,
  ExecutionAttestation,
  Sha256Hex,
  UtcTimestamp,
  VerifiedExecutionFact,
} from '../execution-attestation/index.js';
