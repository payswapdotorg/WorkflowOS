/**
 * V2-015 — internal/verification-derived admission predicates.
 *
 * The pure policy-composition layer (invariants 4/8/9):
 *   - admission consumes V2-014 verification RESULTS (the
 *     `AttestationVerification` union) — it NEVER calls the verifier and
 *     NEVER re-implements verification (V2-014 stays the authority);
 *   - a failed verification is carried verbatim (the verifier's own failure
 *     code) and NEVER reinterpreted as admissible evidence;
 *   - freshness, assurance, trust, capability, authorization and placement
 *     are SEPARATE dimensions, each with its own typed failure code — a
 *     valid signature alone never satisfies trust, capability,
 *     authorization, or assurance policy;
 *   - capability/authorization/placement facts arrive as EXPLICIT inputs
 *     (V2-004's / the authorization authority's / V2-009's verdicts,
 *     consumed as data) — this layer never evaluates possession, grants
 *     authorization, or computes placement;
 *   - the evaluation order is fixed and deterministic: structural input
 *     (including the per-evidence identity binding — each verified wrapper's
 *     executionDigest MUST equal the verified fact's OWN execution digest)
 *     → per-parent (evidence → verification → binding → freshness →
 *     assurance → trust, in declared sorted order) → capability →
 *     authorization → placement. The FIRST failed dimension is returned.
 */

import { assuranceRank } from '../../execution-attestation/index.js';
import type { AttestationBindingDimension, Sha256Hex } from '../../execution-attestation/index.js';
import type {
  CapabilityFactInput,
  PlacementEligibilityInput,
  PredecessorEvidence,
  ProofAdmissionFailure,
  ProofAdmissionInput,
  ProofAdmissionResult,
} from '../types.js';
import { isSha256Hex, isUtcTimestamp, utcTimestampToEpochMs } from './validation.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Evaluate one admission predicate (pure, deterministic, fail-closed). */
export function evaluateProofAdmission(input: ProofAdmissionInput): ProofAdmissionResult {
  // ------------------------------------------------------------------
  // 0. structural input validation (fail-closed, dimension 'freshness'
  //    for clock/epoch problems, 'parents' for parent-set problems)
  // ------------------------------------------------------------------
  const structural = validateAdmissionInput(input);
  if (structural) {
    return { admitted: false, failure: structural };
  }

  const declaredParents = [...input.declaredParents].sort();
  const evidenceByDigest = new Map<string, PredecessorEvidence>();
  for (const evidence of input.predecessorEvidence) {
    evidenceByDigest.set(evidence.executionDigest, evidence);
  }

  // ------------------------------------------------------------------
  // 1. per declared parent: evidence → verification → binding → freshness
  //    → assurance → trust (deterministic sorted order)
  // ------------------------------------------------------------------
  for (const parentDigest of declaredParents) {
    const evidence = evidenceByDigest.get(parentDigest);
    if (!evidence) {
      return denied({
        code: 'ADMISSION_PARENT_MISSING',
        dimension: 'parents',
        detail: `no evidence supplied for the declared parent ${parentDigest}`,
        parentDigest,
      });
    }

    const { verification } = evidence;
    if (!verification.ok) {
      return denied({
        code: 'ADMISSION_PREDECESSOR_UNVERIFIED',
        dimension: 'verification',
        detail: `the V2-014 verification failed for parent ${parentDigest}: ${verification.failure.code} — ${verification.failure.detail}`,
        parentDigest,
        verifierFailureCode: verification.failure.code,
      });
    }

    const fact = verification.fact;

    // binding: the fact's Run/WorkflowVersion identity must match the
    // dependent's scope (cross-run/cross-version substitution fails closed)
    const bindingFailure = checkBinding(input, fact, parentDigest);
    if (bindingFailure) {
      return denied(bindingFailure);
    }

    // freshness (separate dimension, evaluated at ADMISSION time)
    const freshnessFailure = checkFreshness(input, fact, parentDigest);
    if (freshnessFailure) {
      return denied(freshnessFailure);
    }

    // assurance (separate dimension; never satisfied by signature validity)
    if (
      input.trustPolicy.requiredAssurance !== undefined &&
      assuranceRank(fact.assurance) < assuranceRank(input.trustPolicy.requiredAssurance)
    ) {
      return denied({
        code: 'ADMISSION_ASSURANCE_INSUFFICIENT',
        dimension: 'assurance',
        detail: `parent ${parentDigest} carries assurance ${fact.assurance}, below the required ${input.trustPolicy.requiredAssurance}`,
        parentDigest,
      });
    }

    // trust (separate dimension; the empty set trusts nobody — a valid
    // signature NEVER silently becomes trust)
    if (!input.trustPolicy.trustedAttesterKeyIds.includes(fact.attesterKeyId)) {
      return denied({
        code: 'ADMISSION_TRUST_POLICY_REJECTED',
        dimension: 'trust',
        detail: `the attester ${fact.attesterKeyId} of parent ${parentDigest} is outside the explicit trusted set`,
        parentDigest,
      });
    }
  }

  // ------------------------------------------------------------------
  // 2. capability dimension (explicit V2-004-derived facts, per parent)
  // ------------------------------------------------------------------
  if (input.capabilityRequirement !== undefined && input.capabilityRequirement.length > 0) {
    const factsByNode = new Map<string, CapabilityFactInput>();
    for (const fact of input.capabilityFacts ?? []) {
      factsByNode.set(fact.nodeId, fact);
    }
    for (const parentDigest of declaredParents) {
      const evidence = evidenceByDigest.get(parentDigest)!;
      if (!evidence.verification.ok) {
        continue; // unreachable: verified above
      }
      const executorNodeId = evidence.verification.fact.statement.nodeId;
      const capabilityFact = factsByNode.get(executorNodeId);
      if (!capabilityFact) {
        return denied({
          code: 'ADMISSION_CAPABILITY_ABSENT',
          dimension: 'capability',
          detail: `no capability fact supplied for the predecessor executor ${executorNodeId} (fail-closed)`,
          parentDigest,
        });
      }
      for (const required of input.capabilityRequirement) {
        if (!capabilityFact.possessedCapabilities.includes(required)) {
          return denied({
            code: 'ADMISSION_CAPABILITY_ABSENT',
            dimension: 'capability',
            detail: `the predecessor executor ${executorNodeId} does not possess the required capability ${required}`,
            parentDigest,
          });
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 3. authorization dimension (explicit grants; never granted here)
  // ------------------------------------------------------------------
  if (input.authorizationRequired) {
    const dependentCapability = input.dependentCapability;
    if (dependentCapability === undefined) {
      return denied({
        code: 'ADMISSION_INPUT_INVALID',
        dimension: 'authorization',
        detail: 'authorizationRequired demands a dependentCapability for grant matching',
      });
    }
    const grants = input.authorizationGrants ?? [];
    const covered = grants.some((grant) => grant.capability === dependentCapability);
    if (!covered) {
      return denied({
        code: 'ADMISSION_AUTHORIZATION_DENIED',
        dimension: 'authorization',
        detail: `no explicit authorization grant covers the dependent capability ${dependentCapability}`,
      });
    }
  }

  // ------------------------------------------------------------------
  // 4. placement dimension (explicit V2-009-derived eligibility facts)
  // ------------------------------------------------------------------
  if (input.placementConstraint !== undefined) {
    const eligibility = input.placementEligibility ?? [];
    const eligible = eligibility.some(
      (fact: PlacementEligibilityInput) =>
        fact.placementConstraint === input.placementConstraint && fact.eligible,
    );
    if (!eligible) {
      return denied({
        code: 'ADMISSION_PLACEMENT_INELIGIBLE',
        dimension: 'placement',
        detail: `no placement-eligible node was supplied under the declared constraint ${input.placementConstraint}`,
      });
    }
  }

  // ------------------------------------------------------------------
  // admitted: the exact declared parent set is satisfied
  // ------------------------------------------------------------------
  return {
    admitted: true,
    dependentStepId: input.dependent.stepId,
    satisfiedParents: declaredParents,
    trustedAttesterKeyIds: [...input.trustPolicy.trustedAttesterKeyIds],
  };
}

// ============================================================================
// Structural input validation
// ============================================================================

function validateAdmissionInput(input: ProofAdmissionInput): ProofAdmissionFailure | null {
  if (!isNonEmptyString(input.dependent?.stepId)) {
    return invalid('dependent.stepId must be a non-empty string', 'parents');
  }
  if (!isNonEmptyString(input.dependent?.runId) || !isNonEmptyString(input.dependent?.workflowId) || !isNonEmptyString(input.dependent?.workflowVersionId)) {
    return invalid('dependent scope binding must be non-empty', 'binding');
  }
  if (!isSha256Hex(input.dependent.workflowVersionSemanticDigest)) {
    return invalid('dependent workflowVersionSemanticDigest must be a sha-256 hex digest', 'binding');
  }
  if (!Array.isArray(input.declaredParents) || input.declaredParents.length === 0) {
    return invalid('declaredParents must be a non-empty array (an admitted dependent action declares its reliance)', 'parents');
  }
  const seen = new Set<string>();
  for (const digest of input.declaredParents) {
    if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) {
      return invalid(`declared parent is not a sha-256 hex digest: ${String(digest)}`, 'parents');
    }
    if (seen.has(digest)) {
      return invalid(`declared parent set contains a duplicate: ${digest}`, 'parents');
    }
    seen.add(digest);
  }
  if (!input.trustPolicy || !isUtcTimestamp(input.trustPolicy.now)) {
    return invalid('trustPolicy.now is required (the injected admission clock, fixed UTC format)', 'freshness');
  }
  if (typeof input.trustPolicy.currentEpoch !== 'number' || !Number.isInteger(input.trustPolicy.currentEpoch)) {
    return invalid('trustPolicy.currentEpoch is required (an integer)', 'freshness');
  }
  if (!Array.isArray(input.trustPolicy.trustedAttesterKeyIds)) {
    return invalid('trustPolicy.trustedAttesterKeyIds must be an array (the explicit trusted set)', 'trust');
  }
  if (!Array.isArray(input.predecessorEvidence)) {
    return invalid('predecessorEvidence must be an array', 'verification');
  }
  for (const evidence of input.predecessorEvidence) {
    if (typeof evidence?.executionDigest !== 'string' || !SHA256_PATTERN.test(evidence.executionDigest)) {
      return invalid('predecessor evidence digest is not a sha-256 hex digest', 'verification');
    }
    if (!evidence.verification || typeof evidence.verification.ok !== 'boolean') {
      return invalid('predecessor evidence must carry a typed V2-014 AttestationVerification result', 'verification');
    }
    // IDENTITY BINDING (fail-closed BEFORE the fact is used anywhere): the
    // wrapper's executionDigest is the graph binding/lookup key, but V2-014's
    // VerifiedExecutionFact carries its OWN executionDigest — the two MUST
    // coincide. Without this check a caller could pair a verified fact for
    // digest B with a wrapper keyed under digest A, declare parent A, and
    // have every dimension evaluated from fact B while the parent lookup is
    // satisfied by the wrapper key (a wrapper/fact identity substitution).
    // The comparison is inherently fail-closed on malformed fact shapes: a
    // missing/malformed fact.executionDigest.digest never equals the wrapper
    // key, so the mismatch is rejected typed.
    if (evidence.verification.ok) {
      const factOwnDigest = (evidence.verification.fact as { executionDigest?: { digest?: unknown } } | undefined)?.executionDigest?.digest;
      if (factOwnDigest !== evidence.executionDigest) {
        return {
          code: 'ADMISSION_EVIDENCE_IDENTITY_MISMATCH',
          dimension: 'verification',
          detail: `the evidence supplied under execution digest ${evidence.executionDigest} carries a verified fact whose OWN execution digest is ${
            typeof factOwnDigest === 'string' ? factOwnDigest : 'absent/malformed'
          } — the wrapper key must bind the exact verified fact (identity substitution fails closed)`,
          parentDigest: evidence.executionDigest,
        };
      }
    }
  }
  return null;
}

// ============================================================================
// Binding + freshness (per fact)
// ============================================================================

function checkBinding(
  input: ProofAdmissionInput,
  fact: { readonly statement: { readonly runId: string; readonly workflowVersionId: string; readonly workflowVersionSemanticDigest: string } },
  parentDigest: Sha256Hex,
): ProofAdmissionFailure | null {
  const bindings: readonly { readonly dimension: AttestationBindingDimension; readonly expected: string; readonly actual: string }[] = [
    { dimension: 'run', expected: input.dependent.runId, actual: fact.statement.runId },
    { dimension: 'workflowVersion', expected: input.dependent.workflowVersionId, actual: fact.statement.workflowVersionId },
    { dimension: 'workflowVersionSemanticDigest', expected: input.dependent.workflowVersionSemanticDigest, actual: fact.statement.workflowVersionSemanticDigest },
  ];
  for (const binding of bindings) {
    if (binding.expected !== binding.actual) {
      return {
        code: 'ADMISSION_PREDECESSOR_BINDING_MISMATCH',
        dimension: 'binding',
        detail: `the verified fact's ${binding.dimension} binding does not match the dependent's scope`,
        parentDigest,
        bindingDimension: binding.dimension,
        expected: binding.expected,
        actual: binding.actual,
      };
    }
  }
  return null;
}

function checkFreshness(
  input: ProofAdmissionInput,
  fact: { readonly verifiedAt: string; readonly statement: { readonly epoch: number; readonly validUntil?: string } },
  parentDigest: Sha256Hex,
): ProofAdmissionFailure | null {
  const now = input.trustPolicy.now;
  const nowMs = utcTimestampToEpochMs(now);

  // 1. the statement's own bounded validity (when declared)
  if (fact.statement.validUntil !== undefined && isUtcTimestamp(fact.statement.validUntil)) {
    if (utcTimestampToEpochMs(fact.statement.validUntil) < nowMs) {
      return {
        code: 'ADMISSION_PREDECESSOR_STALE',
        dimension: 'freshness',
        detail: `the parent fact's bounded validity elapsed at ${fact.statement.validUntil} (admission clock ${now})`,
        parentDigest,
      };
    }
  }

  // 2. the VERIFICATION's age (a fact verified long ago is stale evidence)
  const maxAgeMs = input.trustPolicy.maxVerificationAgeMs;
  if (maxAgeMs !== undefined) {
    if (!isUtcTimestamp(fact.verifiedAt)) {
      return {
        code: 'ADMISSION_INPUT_INVALID',
        dimension: 'freshness',
        detail: 'the fact verifiedAt is not a fixed-format UTC timestamp',
        parentDigest,
      };
    }
    const ageMs = nowMs - utcTimestampToEpochMs(fact.verifiedAt);
    if (ageMs > maxAgeMs || ageMs < 0) {
      return {
        code: 'ADMISSION_PREDECESSOR_STALE',
        dimension: 'freshness',
        detail: `the parent fact's verification is stale at admission time (age ${ageMs}ms > max ${maxAgeMs}ms)`,
        parentDigest,
      };
    }
  }

  // 3. the protocol epoch (earlier statement epochs are stale)
  if (fact.statement.epoch < input.trustPolicy.currentEpoch) {
    return {
      code: 'ADMISSION_PREDECESSOR_STALE',
      dimension: 'freshness',
      detail: `the parent fact's epoch ${fact.statement.epoch} is behind the current epoch ${input.trustPolicy.currentEpoch}`,
      parentDigest,
    };
  }
  return null;
}

// ============================================================================
// Helpers
// ============================================================================

function denied(failure: ProofAdmissionFailure): ProofAdmissionResult {
  return { admitted: false, failure };
}

function invalid(detail: string, dimension: 'parents' | 'binding' | 'freshness' | 'verification' | 'trust'): ProofAdmissionFailure {
  return { code: 'ADMISSION_INPUT_INVALID', dimension, detail };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
