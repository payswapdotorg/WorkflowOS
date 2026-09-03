/**
 * V2-013 — internal/safe first-party execution packaging.
 *
 * The typed, fail-closed decision that a pinned first-party workflow may
 * be dispatched for execution in a development environment — for ONE real
 * run (the V2-016 precondition pattern: the package is the run's
 * precondition set, minted BEFORE dispatch through the real execution
 * authorities, which stay external).
 *
 * The fixed evaluation order (deterministic, first failure returned):
 *   1. the self-hosting permission boundary (fail-closed against a
 *      weakened governance model — the code-pinned floor);
 *   2. the manifest↔artifact correspondence (kind, slug, semantic digest);
 *   3. the installation pin proof (the manifest pin vs the pin facts read
 *      back from the REAL V2-002 authority — drift is fail-closed);
 *   4. the proof predicates for every policy-declared proof-required
 *      step, consumed through V2-015's `evaluateProofAdmission` (the
 *      verified-fact admission — V2-015/V2-014 stay the authorities; the
 *      admission failure is carried VERBATIM, never reinterpreted), and
 *      THEN the predecessor binding to the artifact's authoritative
 *      WorkflowIR predecessor edges (the PR #160 Blocker-1 correction:
 *      every VERIFIED evidence fact must attest an IR-declared predecessor
 *      step of the proof-required step within the manifest's pinned
 *      workflow scope, and every IR-declared predecessor must be covered
 *      by an admitted parent — a valid attestation for an unrelated
 *      execution NEVER satisfies the predicate);
 *   5. only then is the package minted.
 *
 * Pure and deterministic: no clock, no randomness, no network.
 */

import { computeWorkflowVersionSemanticDigest } from '../../workflow-ir/index.js';
import type { WorkflowIrDocument } from '../../workflow-ir/index.js';
import { evaluateProofAdmission } from '../../execution-proof-graph/index.js';
import type { PredecessorEvidence, ProofAdmissionInput } from '../../execution-proof-graph/index.js';
import type {
  FirstPartyWorkflowManifest,
  PackageFirstPartyExecutionInput,
  ProofStepEvidenceInput,
  SelfHostingPackagingResult,
} from '../types.js';
import { evaluateSelfHostingBoundary } from './boundary.js';

/**
 * Package one first-party workflow execution for one run. Fail-closed:
 * ANY failed dimension returns the typed failure and mints NOTHING.
 */
export function packageFirstPartyExecution(input: PackageFirstPartyExecutionInput): SelfHostingPackagingResult {
  // ------------------------------------------------------------------
  // 1. the self-hosting permission boundary (fail-closed)
  // ------------------------------------------------------------------
  const verdict = evaluateSelfHostingBoundary(input.artifact.document, input.boundary);
  if (!verdict.allowed) {
    return {
      packaged: false,
      failure: {
        code:
          verdict.failure.code === 'SELF_HOSTING_BOUNDARY_MODEL_INVALID'
            ? 'SELF_HOSTING_BOUNDARY_MODEL_INVALID'
            : 'SELF_HOSTING_BOUNDARY_DENIED',
        detail: `the self-hosting permission boundary denied the ${input.artifact.kind} workflow: ${verdict.failure.code} — ${verdict.failure.detail}`,
        boundaryFailure: verdict.failure,
      },
    };
  }

  // ------------------------------------------------------------------
  // 2. manifest ↔ artifact correspondence
  // ------------------------------------------------------------------
  const semanticDigest = computeWorkflowVersionSemanticDigest(input.artifact.document);
  if (
    input.manifest.kind !== input.artifact.kind ||
    input.manifest.slug !== input.artifact.slug ||
    input.manifest.semanticDigest.digest !== semanticDigest.digest
  ) {
    return {
      packaged: false,
      failure: {
        code: 'SELF_HOSTING_MANIFEST_MISMATCH',
        detail:
          `the manifest does not correspond to the supplied artifact (kind/slug/semantic digest mismatch: manifest ${input.manifest.kind}/${input.manifest.slug}/${input.manifest.semanticDigest.digest.slice(0, 12)}… vs artifact ${input.artifact.kind}/${input.artifact.slug}/${semanticDigest.digest.slice(0, 12)}…)`,
      },
    };
  }

  // ------------------------------------------------------------------
  // 3. the installation pin proof (drift = fail-closed)
  // ------------------------------------------------------------------
  const pin = input.pinFacts;
  if (
    pin.installationId !== input.manifest.installationId ||
    pin.workflowId !== input.manifest.workflowId ||
    pin.versionId !== input.manifest.versionId ||
    pin.versionNumber !== input.manifest.versionNumber ||
    pin.contentDigest !== input.manifest.contentDigest
  ) {
    return {
      packaged: false,
      failure: {
        code: 'SELF_HOSTING_PIN_DRIFT',
        detail:
          `the installed pin no longer matches the manifest (a silent pin move is fail-closed: expected version ${input.manifest.versionId} (digest ${input.manifest.contentDigest.slice(0, 12)}…), the authority reports version ${pin.versionId} (digest ${pin.contentDigest.slice(0, 12)}…))`,
        expected: `${input.manifest.workflowId}@${input.manifest.versionId}`,
        actual: `${pin.workflowId}@${pin.versionId}`,
      },
    };
  }

  // ------------------------------------------------------------------
  // 4. the proof predicates (V2-015 admission, consumed verbatim)
  // ------------------------------------------------------------------
  const admitted: {
    stepId: string;
    satisfiedParents: readonly string[];
    trustedAttesterKeyIds: readonly string[];
  }[] = [];
  const supplies = new Map<string, ProofStepEvidenceInput>();
  for (const supply of input.proofSteps) {
    supplies.set(supply.stepId, supply);
  }
  for (const stepId of input.artifact.executionPolicy.proofRequiredSteps) {
    const supply = supplies.get(stepId);
    if (!supply) {
      return {
        packaged: false,
        failure: {
          code: 'SELF_HOSTING_PROOF_STEP_UNSUPPLIED',
          detail: `the proof-required step "${stepId}" has NO predecessor-evidence supply (fail-closed: a proof predicate is never satisfied by absence)`,
          stepId,
        },
      };
    }
    const admissionInput: ProofAdmissionInput = {
      dependent: {
        stepId,
        workflowId: input.manifest.workflowId,
        workflowVersionId: input.manifest.versionId,
        workflowVersionSemanticDigest: input.manifest.semanticDigest.digest,
        runId: input.executionScope.runId,
      },
      declaredParents: supply.declaredParents,
      predecessorEvidence: supply.predecessorEvidence,
      trustPolicy: input.trustPolicy,
      ...(supply.capabilityRequirement !== undefined ? { capabilityRequirement: supply.capabilityRequirement } : {}),
      ...(supply.capabilityFacts !== undefined ? { capabilityFacts: supply.capabilityFacts } : {}),
      ...(supply.authorizationRequired !== undefined ? { authorizationRequired: supply.authorizationRequired } : {}),
      ...(supply.authorizationGrants !== undefined ? { authorizationGrants: supply.authorizationGrants } : {}),
      ...(supply.dependentCapability !== undefined ? { dependentCapability: supply.dependentCapability } : {}),
    };
    const admission = evaluateProofAdmission(admissionInput);
    if (!admission.admitted) {
      return {
        packaged: false,
        failure: {
          code: 'SELF_HOSTING_PROOF_PREDICATE_REJECTED',
          detail: `the proof predicate for step "${stepId}" was REJECTED by the V2-015 admission: ${admission.failure.code} — ${admission.failure.detail}`,
          admissionFailure: admission.failure,
          stepId,
        },
      };
    }
    // 4b. the predecessor binding to the authoritative WorkflowIR edges
    //     (runs only AFTER a successful admission, so replayed/untrusted/
    //     substituted evidence keeps its verbatim V2-015/V2-014 failure
    //     chain — the binding closes what the admission cannot see: the
    //     STEP structure of the pinned artifact)
    const bindingViolation = bindPredecessorsToIrEdges({
      document: input.artifact.document,
      manifest: input.manifest,
      stepId,
      evidence: supply.predecessorEvidence,
      satisfiedParents: admission.satisfiedParents,
    });
    if (bindingViolation) {
      return {
        packaged: false,
        failure: {
          code: 'SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED',
          detail: `the predecessor evidence for proof-required step "${stepId}" is not bound to the authoritative WorkflowIR predecessor edges: ${bindingViolation.detail}`,
          stepId,
          ...(bindingViolation.offending !== undefined ? { offending: bindingViolation.offending } : {}),
        },
      };
    }
    admitted.push({
      stepId,
      satisfiedParents: [...admission.satisfiedParents],
      trustedAttesterKeyIds: [...admission.trustedAttesterKeyIds],
    });
  }

  // ------------------------------------------------------------------
  // 5. mint the package (the run's precondition set)
  // ------------------------------------------------------------------
  return {
    packaged: true,
    package: {
      kind: input.manifest.kind,
      workflowId: input.manifest.workflowId,
      versionId: input.manifest.versionId,
      versionNumber: input.manifest.versionNumber,
      contentDigest: input.manifest.contentDigest,
      semanticDigest: input.manifest.semanticDigest,
      installationId: input.manifest.installationId,
      runId: input.executionScope.runId,
      boundaryCoreProhibitions: [...input.boundary.coreProhibitions],
      admittedProofSteps: admitted,
    },
  };
}

// ============================================================================
// The predecessor binding (the PR #160 Blocker-1 correction)
// ============================================================================

/** One binding violation (deterministic, first violation wins). */
interface ParentBindingViolation {
  readonly detail: string;
  readonly offending?: string;
}

/**
 * The WorkflowIR's authoritative predecessor steps for one step: the
 * unique `from` nodes of every control edge INTO the step (all trigger
 * kinds — success, failure, and outcome edges are all causal
 * predecessors), in deterministic sorted order. V2-003 stays the workflow
 * -semantics authority; this derives the step structure READ-ONLY from the
 * pinned artifact's own document.
 */
function authoritativePredecessorSteps(document: WorkflowIrDocument, stepId: string): string[] {
  const steps = new Set<string>();
  for (const edge of document.ir.edges) {
    if (edge.to === stepId) {
      steps.add(edge.from);
    }
  }
  return [...steps].sort();
}

/**
 * Bind the predecessor evidence to the authoritative WorkflowIR edges for
 * one proof-required step (fail-closed, run AFTER the V2-015 admission so
 * unverified/replayed/substituted evidence keeps its verbatim failure chain):
 *
 *   1. every VERIFIED evidence fact must attest an IR-declared predecessor
 *      step of this step (a foreign step or an absent step identity is a
 *      typed violation — a valid attestation for an unrelated execution
 *      never satisfies the predicate), within the manifest's pinned
 *      workflow scope (the workflowId dimension the V2-015 binding check
 *      does not cover);
 *   2. every IR-declared predecessor step must be covered by an ADMITTED
 *      parent's fact (a declared set narrower than the IR structure is a
 *      typed violation — the structural predecessor set is proven in
 *      full, never partially).
 */
function bindPredecessorsToIrEdges(input: {
  readonly document: WorkflowIrDocument;
  readonly manifest: FirstPartyWorkflowManifest;
  readonly stepId: string;
  readonly evidence: readonly PredecessorEvidence[];
  readonly satisfiedParents: readonly string[];
}): ParentBindingViolation | null {
  const authoritative = authoritativePredecessorSteps(input.document, input.stepId);
  const authoritativeSet = new Set<string>(authoritative);
  const authoritativeListed =
    authoritative.length > 0 ? authoritative.map((step) => `"${step}"`).join(', ') : 'NO predecessors';

  const factsByDigest = new Map<string, { readonly statement: { readonly workflowId: string; readonly workflowVersionId: string; readonly workflowVersionSemanticDigest: string; readonly stepId?: string } }>();
  for (const wrapper of input.evidence) {
    if (!wrapper.verification.ok) {
      continue; // unverified evidence flows to the admission's verbatim rejection path
    }
    const fact = wrapper.verification.fact;
    factsByDigest.set(wrapper.executionDigest, fact);

    // 1a. the step binding: the fact must attest an IR-declared predecessor
    const factStep = fact.statement.stepId;
    if (factStep === undefined || !authoritativeSet.has(factStep)) {
      return {
        detail:
          `the verified fact under execution digest ${wrapper.executionDigest.slice(0, 12)}… attests step "${factStep ?? '(step identity absent)'}", which is NOT a WorkflowIR-declared predecessor of "${input.stepId}" (the pinned artifact declares ${authoritativeListed}) — a valid attestation for an unrelated execution never satisfies a proof-required step (fail-closed)`,
        offending: factStep ?? '(step identity absent)',
      };
    }

    // 1b. the workflow-scope binding: the fact must attest the manifest's
    //     exact workflow identity (the workflowId dimension the V2-015
    //     admission binding check does not cover)
    if (fact.statement.workflowId !== input.manifest.workflowId) {
      return {
        detail:
          `the verified fact under execution digest ${wrapper.executionDigest.slice(0, 12)}… attests workflow ${fact.statement.workflowId}, not the manifest's pinned workflow ${input.manifest.workflowId} — predecessor evidence must bind the manifest's exact workflow identity (fail-closed)`,
        offending: `${fact.statement.workflowId}@${fact.statement.workflowVersionId}`,
      };
    }
  }

  // 2. the coverage binding: every IR-declared predecessor is covered by an
  //    ADMITTED parent's fact (the declared set may not be narrower than
  //    the authoritative structure)
  const coveredSteps = new Set<string>();
  for (const digest of input.satisfiedParents) {
    const fact = factsByDigest.get(digest);
    if (fact && fact.statement.stepId !== undefined) {
      coveredSteps.add(fact.statement.stepId);
    }
  }
  for (const predecessor of authoritative) {
    if (!coveredSteps.has(predecessor)) {
      return {
        detail:
          `the WorkflowIR-declared predecessor "${predecessor}" of "${input.stepId}" is NOT covered by an admitted parent (the supplied predicate is narrower than the authoritative predecessor edges) — the structural predecessor set must be proven in full (fail-closed)`,
        offending: predecessor,
      };
    }
  }
  return null;
}
