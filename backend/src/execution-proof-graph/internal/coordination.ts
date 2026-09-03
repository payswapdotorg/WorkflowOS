/**
 * V2-015 — internal/cross-device continuation and coordination composition.
 *
 * The coordination seam ONLY (invariants 5/6/10/12): consumes the merged
 * public outputs (V2-008's V2-016 `DependentStepPrecondition` shape —
 * TYPE-ONLY; V2-014 verification results — data) and returns typed
 * graph/admission decisions to the caller. It NEVER executes anything,
 * NEVER mutates V2-008/V2-009/V2-014 internals, and NEVER becomes a second
 * execution engine.
 *
 *   - `planCrossDeviceContinuation`: Node B's independent V2-014
 *     verification result is turned into a typed continuation decision —
 *     admitted materializes the V2-016 dependent-step precondition (the
 *     EXACT currency `ResumeAfterHumanInput.preconditions` consumes, bound
 *     to the graph's Run/WorkflowVersion identity — cross-device handoff
 *     preserves identity and the precondition is admission, never a
 *     grant); denied carries the typed dimension failure and materializes
 *     NOTHING (the dependent action cannot be admitted);
 *   - `recordContinuationOutcome`: folds the RUNTIME-PRODUCED dependent
 *     attestation back into the graph (append-only; the causal edges
 *     derive from the produced statement's own declared causalParents);
 *   - `verifyGraphAgainstAttestations`: independent reconstruction — a
 *     delivered graph is checked against the SOURCE attestations (node
 *     identity, every binding field, the declared causal parents): a
 *     coordinator that mutates parent relationships (even re-committing
 *     the parent commitment) is detected because the graph no longer
 *     equals the projection of the authenticated source evidence.
 */

import type { DependentStepPrecondition } from '../../computer-agent/index.js';
import type { AttestationVerification, ExecutionAttestation, Sha256Hex, VerifiedExecutionFact } from '../../execution-attestation/index.js';
import type {
  ExecutionProofGraph,
  PredecessorEvidence,
  ProofAdmissionFailure,
  ProofAdmissionInput,
  ProofGraphFailure,
  ProofGraphMutationResult,
} from '../types.js';
import { evaluateGraphAdmission } from './convergence.js';
import type { ProofGraphBuilder } from './graph.js';
import { nodesEqual, projectAttestationToNode } from './validation.js';

// ============================================================================
// Cross-device continuation planning (the admission → precondition seam)
// ============================================================================

/** The continuation-planning input (graph state + evidence + policy). */
export interface CrossDeviceContinuationInput {
  readonly graph: ExecutionProofGraph;
  readonly dependent: ProofAdmissionInput['dependent'];
  readonly declaredParents: readonly Sha256Hex[];
  readonly predecessorEvidence: readonly PredecessorEvidence[];
  readonly trustPolicy: ProofAdmissionInput['trustPolicy'];
  readonly capabilityFacts?: ProofAdmissionInput['capabilityFacts'];
  readonly capabilityRequirement?: ProofAdmissionInput['capabilityRequirement'];
  readonly authorizationGrants?: ProofAdmissionInput['authorizationGrants'];
  readonly authorizationRequired?: ProofAdmissionInput['authorizationRequired'];
  readonly dependentCapability?: ProofAdmissionInput['dependentCapability'];
  readonly placementEligibility?: ProofAdmissionInput['placementEligibility'];
  readonly placementConstraint?: ProofAdmissionInput['placementConstraint'];
}

/** The typed continuation decision (admitted materializes the V2-016 precondition; denied materializes NOTHING). */
export type CrossDeviceContinuationDecision =
  | {
      readonly continuation: 'admitted';
      /** The V2-016 dependent-step precondition for the runtime resume drive. */
      readonly precondition: DependentStepPrecondition;
      /** The satisfied parent digests (the admitted reliance set). */
      readonly satisfiedParents: readonly Sha256Hex[];
    }
  | {
      readonly continuation: 'denied';
      readonly failure: ProofAdmissionFailure;
    };

/**
 * Plan the cross-device continuation of a dependent action: evaluate the
 * graph-grounded admission over Node B's independently obtained verification
 * results and — ONLY on admission — materialize the V2-016 dependent-step
 * precondition bound to the graph's Run/WorkflowVersion identity.
 *
 * Fail-closed: an unverified/stale/untrusted/insufficiently-assured
 * predecessor, a scope mismatch, or a parent outside the graph denies the
 * continuation with the typed dimension failure — the runtime currency is
 * NEVER minted from a denial.
 */
export function planCrossDeviceContinuation(input: CrossDeviceContinuationInput): CrossDeviceContinuationDecision {
  // structural: the predecessor's step must differ from the dependent's
  // (a step cannot be its own predecessor — mirrors the V2-016 runtime rule)
  for (const evidence of input.predecessorEvidence) {
    if (evidence.verification.ok && evidence.verification.fact.statement.stepId === input.dependent.stepId) {
      return {
        continuation: 'denied',
        failure: {
          code: 'ADMISSION_INPUT_INVALID',
          dimension: 'binding',
          detail: `the predecessor's step (${input.dependent.stepId}) must differ from the dependent step (a step cannot be its own predecessor)`,
        },
      };
    }
  }

  const admission = evaluateGraphAdmission({
    graph: input.graph,
    dependent: input.dependent,
    declaredParents: input.declaredParents,
    predecessorEvidence: input.predecessorEvidence,
    trustPolicy: input.trustPolicy,
    ...(input.capabilityFacts !== undefined ? { capabilityFacts: input.capabilityFacts } : {}),
    ...(input.capabilityRequirement !== undefined ? { capabilityRequirement: input.capabilityRequirement } : {}),
    ...(input.authorizationGrants !== undefined ? { authorizationGrants: input.authorizationGrants } : {}),
    ...(input.authorizationRequired !== undefined ? { authorizationRequired: input.authorizationRequired } : {}),
    ...(input.dependentCapability !== undefined ? { dependentCapability: input.dependentCapability } : {}),
    ...(input.placementEligibility !== undefined ? { placementEligibility: input.placementEligibility } : {}),
    ...(input.placementConstraint !== undefined ? { placementConstraint: input.placementConstraint } : {}),
  });

  if (!admission.admitted) {
    return { continuation: 'denied', failure: admission.failure };
  }

  // admitted: materialize the V2-016 runtime currency from the VERIFIED
  // facts (never raw envelopes). Exactly one precondition per distinct
  // predecessor attestation; the causal parent digests are the admitted
  // reliance set (canonical sorted order).
  const factsByDigest = new Map<string, VerifiedExecutionFact>();
  for (const evidence of input.predecessorEvidence) {
    if (evidence.verification.ok) {
      factsByDigest.set(evidence.executionDigest, evidence.verification.fact);
    }
  }
  const sortedParents = [...input.declaredParents].sort();
  const facts = sortedParents
    .map((digest) => factsByDigest.get(digest))
    .filter((fact): fact is VerifiedExecutionFact => fact !== undefined);
  const primary = facts[0];
  if (!primary) {
    // unreachable: admission requires evidence for every declared parent
    return {
      continuation: 'denied',
      failure: {
        code: 'ADMISSION_PARENT_MISSING',
        dimension: 'parents',
        detail: 'no verified predecessor fact for the admitted parent set',
      },
    };
  }

  const precondition: DependentStepPrecondition = {
    dependentStepId: input.dependent.stepId,
    predecessorAttestationId: primary.attestationId,
    verifiedPredecessor: primary,
    causalParentDigests: sortedParents,
    runId: input.dependent.runId,
    workflowVersionId: input.dependent.workflowVersionId,
    workflowVersionSemanticDigest: input.dependent.workflowVersionSemanticDigest,
  };

  return {
    continuation: 'admitted',
    precondition,
    satisfiedParents: admission.satisfiedParents,
  };
}

// ============================================================================
// Continuation outcome recording (fold the runtime-produced attestation)
// ============================================================================

/** The result of folding a runtime-produced dependent attestation into the graph. */
export interface ContinuationRecordingResult {
  /** The graph state after the recording (append-only). */
  readonly graph: ExecutionProofGraph;
  /** The node mutation result (accepted / duplicate / rejected). */
  readonly nodeResult: ProofGraphMutationResult;
  /** The causal-edge mutation results (one per resolvable declared parent). */
  readonly edgeResults: readonly ProofGraphMutationResult[];
}

/**
 * Fold the RUNTIME-PRODUCED dependent attestation into the graph: the node
 * is appended (append-only; duplicate delivery converges) and the causal
 * edges derive from the PRODUCED statement's own declared causalParents
 * (the executor-side causal claim — never a hand-built statement for the
 * positive proof).
 */
export function recordContinuationOutcome(
  builder: ProofGraphBuilder,
  produced: ExecutionAttestation,
): ContinuationRecordingResult {
  const nodeResult = builder.addAttestationNode(produced);
  const edgeResults: ProofGraphMutationResult[] = [];

  const child = builder.graph.nodes.find((n) => n.attestationId === produced.attestationId);
  if (child) {
    for (const parentDigest of child.declaredCausalParents) {
      const parent = builder.graph.nodes.find((n) => n.executionDigest === parentDigest);
      if (parent && parent.attestationId !== produced.attestationId) {
        edgeResults.push(
          builder.addCausalEdge({
            parentAttestationId: parent.attestationId,
            childAttestationId: produced.attestationId,
          }),
        );
      }
    }
  }

  return {
    graph: builder.graph,
    nodeResult,
    edgeResults,
  };
}

// ============================================================================
// Independent reconstruction (coordinator-mutation detection)
// ============================================================================

export type GraphAttestationVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly failures: readonly ProofGraphFailure[] };

/**
 * Independently verify a DELIVERED graph against the SOURCE attestations:
 * every source attestation must project to an EQUAL node (node identity,
 * every binding field, the declared causal parents — a coordinator that
 * mutates parent relationships, even re-committing the parent commitment,
 * no longer matches the projection of the authenticated evidence), and
 * every graph node must be accounted for by a source attestation. Causal
 * edges are re-derived from the sources: each delivered causal edge must
 * be derivable from the child's own statement.
 */
export function verifyGraphAgainstAttestations(
  graph: ExecutionProofGraph,
  attestations: readonly ExecutionAttestation[],
): GraphAttestationVerification {
  const failures: ProofGraphFailure[] = [];

  const projectionByAttestationId = new Map<string, ReturnType<typeof projectAttestationToNode>>();
  for (const attestation of attestations) {
    projectionByAttestationId.set(attestation.attestationId, projectAttestationToNode(attestation));
  }

  // 1. every source attestation → an EQUAL delivered node
  for (const attestation of attestations) {
    const projected = projectionByAttestationId.get(attestation.attestationId)!;
    const delivered = graph.nodes.find((n) => n.attestationId === attestation.attestationId);
    if (!delivered) {
      failures.push({
        code: 'GRAPH_NODE_INVALID',
        detail: `the source attestation ${attestation.attestationId} is missing from the delivered graph`,
        identity: attestation.attestationId,
      });
      continue;
    }
    if (!nodesEqual(delivered, projected)) {
      const differences: string[] = [];
      if (delivered.executionDigest !== projected.executionDigest) {
        differences.push('executionDigest');
      }
      if (delivered.runId !== projected.runId) {
        differences.push('runId');
      }
      if (delivered.workflowVersionId !== projected.workflowVersionId) {
        differences.push('workflowVersionId');
      }
      if (delivered.workflowVersionSemanticDigest !== projected.workflowVersionSemanticDigest) {
        differences.push('workflowVersionSemanticDigest');
      }
      if (delivered.nodeIdentity !== projected.nodeIdentity) {
        differences.push('nodeIdentity');
      }
      if (delivered.parentCommitment !== projected.parentCommitment || delivered.declaredCausalParents.join(',') !== projected.declaredCausalParents.join(',')) {
        differences.push('causalParents/parentCommitment');
      }
      failures.push({
        code: 'GRAPH_NODE_CONFLICT',
        detail: `the delivered node for ${attestation.attestationId} differs from the independent projection of the source attestation (mutated: ${differences.join(', ') || 'binding fields'})`,
        identity: attestation.attestationId,
      });
    }
  }

  // 2. every delivered node must be accounted for by a source attestation
  for (const node of graph.nodes) {
    if (!projectionByAttestationId.has(node.attestationId)) {
      failures.push({
        code: 'GRAPH_NODE_INVALID',
        detail: `the delivered node ${node.nodeIdentity} has no source attestation (coordinator-invented evidence)`,
        identity: node.nodeIdentity,
      });
    }
  }

  // 3. causal edges must be derivable from the sources' own statements
  for (const edge of graph.edges) {
    if (edge.relation !== 'causal') {
      continue; // dependency edges are composition-declared, not source-derived
    }
    const childProjection = graph.nodes.find((n) => n.nodeIdentity === edge.childNode);
    const source = attestations.find((a) => a.attestationId === childProjection?.attestationId);
    if (!source) {
      continue; // covered by the accounting failures above
    }
    if (!source.statement.causalParents.includes(edge.parentExecutionDigest)) {
      failures.push({
        code: 'GRAPH_EDGE_PARENT_UNDECLARED',
        detail: `the delivered causal edge ${edge.edgeIdentity} is not declared by the source attestation's own statement (re-wired relationship)`,
        identity: edge.edgeIdentity,
      });
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

// ============================================================================
// Verification-result reuse (typed passthrough for callers)
// ============================================================================

/** The verification union consumed by the composition (V2-014's result type). */
export type { AttestationVerification };
