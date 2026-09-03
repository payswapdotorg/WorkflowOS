/**
 * V2-015 — Execution Proof Graph (public barrel).
 *
 * Owns (spec/architecture/v2/work-orders/V2-015.md): the ExecutionProofGraph
 * model + deterministic serialization, causal/dependency edge semantics,
 * admission predicates based on VerifiedExecutionFacts, cross-device
 * continuation composition preserving Run/WorkflowVersion identity,
 * multi-parent dependency satisfaction, replay/duplicate convergence at
 * graph level, and trust-policy evaluation inputs specific to proof
 * composition.
 *
 * Boundaries (V2-015):
 *   - V2-003 remains the ONLY workflow-semantics authority (never imported
 *     here; semantic digests are opaque binding data);
 *   - V2-005 remains the Run/evidence persistence authority;
 *   - V2-004 remains the node identity/capability authority;
 *   - V2-008 remains the computer-use execution authority;
 *   - V2-009 remains the events/scheduling/placement authority;
 *   - V2-014 remains the cryptographic verification authority (its types +
 *     canonical-JSON/identity utilities are consumed through the merged
 *     public barrel ONLY — never `internal/`);
 *   - V2-012 is an independent sibling (nothing imported);
 *   - NO routes, NO migrations, NO new dependencies; the pure core has no
 *     clock/randomness/network (all injected).
 *
 * The graph is EVIDENCE about executions — never a second workflow,
 * execution, verification, or authorization engine (invariant 12).
 */
export {
  // §0 domain identity (registry attestationObjectTypes — V2-015's one)
  EXECUTION_PROOF_GRAPH_OBJECT_TYPE,
  EXECUTION_PROOF_GRAPH_SCHEMA_VERSION,
  EXECUTION_PROOF_UPDATED_EVENT_NAME,
  // §1 vocabularies
  PROOF_EDGE_RELATIONS,
  PROOF_ADMISSION_DIMENSIONS,
  // §2 identity prefixes + hash domains
  PROOF_GRAPH_ID_PREFIX,
  PROOF_NODE_ID_PREFIX,
  PROOF_EDGE_ID_PREFIX,
  PROOF_GRAPH_ID_DOMAIN,
  PROOF_NODE_ID_DOMAIN,
  PROOF_EDGE_ID_DOMAIN,
  PROOF_PARENT_COMMITMENT_DOMAIN,
  // §6 typed failure taxonomy
  PROOF_GRAPH_FAILURE_CODES,
  // §8 typed admission failure taxonomy
  PROOF_ADMISSION_FAILURE_CODES,
  // §9 typed error surface
  EXECUTION_PROOF_GRAPH_ERROR_CODES,
  ExecutionProofGraphError,
} from './types.js';
export type {
  ProofEdgeRelation,
  ProofAdmissionDimension,
  ProofGraphFailureCode,
  ProofGraphFailure,
  ProofGraphMutationResult,
  ExecutionProofNode,
  ExecutionProofEdge,
  ExecutionProofGraph,
  PredecessorEvidence,
  CapabilityFactInput,
  AuthorizationGrantInput,
  PlacementEligibilityInput,
  ProofCompositionTrustPolicy,
  ProofAdmissionInput,
  ProofAdmissionFailureCode,
  ProofAdmissionFailure,
  ProofAdmissionResult,
  ExecutionProofGraphErrorCode,
} from './types.js';

// §10 consumed V2-014 public contracts (type-only re-exports)
export type {
  AssuranceLevel,
  AttestationBindingDimension,
  AttestationFailureCode,
  AttestationVerification,
  ExecutionAttestation,
  Sha256Hex,
  UtcTimestamp,
  VerifiedExecutionFact,
} from './types.js';

// internal/pure validation: deterministic identity derivations + structural
// validation (append-only/duplicate/cycle/scope semantics)
export {
  deriveGraphIdentity,
  deriveProofNodeIdentity,
  deriveProofEdgeIdentity,
  deriveParentCommitment,
  projectAttestationToNode,
  validateNodeCandidate,
  validateEdgeCandidate,
  validateGraphState,
  validateGraphConsistency,
  edgeWouldCreateCycle,
  compareNodeForAppend,
  nodesEqual,
  edgesEqual,
  isSha256Hex,
  isUtcTimestamp,
  compareUtcTimestamps,
  utcTimestampToEpochMs,
} from './internal/validation.js';

// internal/pure graph construction: the deterministic, append-only builder
export {
  createProofGraphBuilder,
  type ProofGraphBuilder,
  type ProofGraphScope,
  type EdgeInput,
} from './internal/graph.js';

// internal/pure verification-derived admission predicates
export {
  evaluateProofAdmission,
} from './internal/admission.js';

// internal/multi-parent satisfaction + replay/duplicate convergence
export {
  evaluateGraphAdmission,
  deliverGraphFragment,
  type GraphAdmissionInput,
  type GraphConvergenceResult,
} from './internal/convergence.js';

// internal/evidence composition: the narrow V2-005 adapter (type-only
// consumption of the merged run-history data shapes; no persistence)
export {
  reconstructProofGraphFromRunHistory,
  type RunHistoryReconstruction,
} from './internal/evidence.js';

// internal/cross-device continuation + coordination composition (the seam)
export {
  planCrossDeviceContinuation,
  recordContinuationOutcome,
  verifyGraphAgainstAttestations,
  type CrossDeviceContinuationInput,
  type CrossDeviceContinuationDecision,
  type ContinuationRecordingResult,
  type GraphAttestationVerification,
} from './internal/coordination.js';

// internal/canonical serialization: byte-deterministic serialization,
// fail-closed typed parse, and the graph-level mutation-detection digest
export {
  serializeProofGraph,
  parseProofGraph,
  computeGraphDigest,
  type ProofGraphParseResult,
} from './internal/serialization.js';
