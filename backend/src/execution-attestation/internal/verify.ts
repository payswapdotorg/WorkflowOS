/**
 * V2-014 — the verification pipeline: an ordered list of REAL critical
 * checks, each returning a TYPED failure or null, plus the fail-closed
 * policy validation and the single-use nonce consumption on full success.
 *
 * The public `verifyAttestation` ALWAYS runs the complete ordered pipeline
 * (`VERIFICATION_CHECKS`); there is no check-skipping option on the public
 * API. `runVerificationPipeline` exists so the mutation/discrimination
 * battery can prove each check is load-bearing by removing exactly one REAL
 * check (test-local mutation — no source file is ever modified).
 *
 * VERIFICATION BOUNDARIES (invariants 5 + 11): verification decides ONLY
 * about the attestation object — cryptographic validity, identity validity,
 * freshness, workflow/version/run/attempt/step binding, and assurance
 * sufficiency. It NEVER evaluates authorization, capability possession,
 * placement, or WorkflowIR semantics, and it never recomputes sibling-module
 * digests (binding data is compared, not re-derived). A valid signature with
 * insufficient evidence never becomes a verified execution fact.
 */
import {
  ATTESTATION_BINDING_DIMENSIONS,
  ASSURANCE_LEVELS,
  ExecutionAttestationError,
} from '../types.js';
import type {
  AssuranceLevel,
  AttestationFailure,
  AttestationVerification,
  AttestationVerificationPolicy,
  ExecutionAttestation,
  VerifiedExecutionFact,
} from '../types.js';
import { deriveAttesterKeyId, signingPreimageJson, validateEnvelopeStructure } from './envelope.js';
import { digestOfStatementObject, isUtcTimestamp, parseUtcTimestamp } from './statement.js';
import { verifyEd25519Signature } from './signing.js';
import { isCanonicalAssurance } from './registry-vocabulary.js';

/** One critical verification check (id + typed evaluation). */
export interface VerificationCheck {
  readonly id: string;
  readonly evaluate: (
    attestation: ExecutionAttestation,
    policy: AttestationVerificationPolicy,
  ) => AttestationFailure | null;
}

// ============================================================================
// Policy validation (fail-closed BEFORE any check runs)
// ============================================================================

/**
 * Validate the verification policy. Structurally enforces invariant 6: a
 * policy with NEITHER a nonce expectation NOR a replay registry would leave
 * timestamps as the only freshness defense — that is rejected (typed throw).
 */
export function validateVerificationPolicy(policy: AttestationVerificationPolicy): void {
  if (typeof policy !== 'object' || policy === null) {
    throw new ExecutionAttestationError('EXECUTION_ATTESTATION_INVALID', 'the verification policy must be an object');
  }
  const freshness = policy.freshness;
  if (typeof freshness !== 'object' || freshness === null) {
    throw new ExecutionAttestationError(
      'EXECUTION_ATTESTATION_INVALID',
      'a freshness policy is REQUIRED: freshness is mandatory wherever an attestation can influence current execution',
    );
  }
  if (!isUtcTimestamp(freshness.now)) {
    throw new ExecutionAttestationError(
      'EXECUTION_ATTESTATION_INVALID',
      'freshness.now must be a fixed-format UTC timestamp — the verifier clock is injected, never ambient',
    );
  }
  if (typeof freshness.currentEpoch !== 'number' || !Number.isInteger(freshness.currentEpoch) || freshness.currentEpoch < 0) {
    throw new ExecutionAttestationError('EXECUTION_ATTESTATION_INVALID', 'freshness.currentEpoch must be a non-negative integer');
  }
  if (freshness.expectedNonce === undefined && freshness.replayRegistry === undefined) {
    throw new ExecutionAttestationError(
      'EXECUTION_ATTESTATION_INVALID',
      'the freshness policy must bind a nonce expectation (expectedNonce) and/or a replay registry — timestamps alone are insufficient replay protection',
    );
  }
  if (freshness.maxAgeMs !== undefined && (typeof freshness.maxAgeMs !== 'number' || !Number.isFinite(freshness.maxAgeMs) || freshness.maxAgeMs < 0)) {
    throw new ExecutionAttestationError('EXECUTION_ATTESTATION_INVALID', 'freshness.maxAgeMs must be a non-negative finite number');
  }
  if (policy.requiredAssurance !== undefined && !isCanonicalAssurance(policy.requiredAssurance)) {
    throw new ExecutionAttestationError(
      'EXECUTION_ATTESTATION_INVALID',
      `requiredAssurance "${String(policy.requiredAssurance)}" is not a canonical registry assurance level`,
    );
  }
  if (policy.attesterKeyIds !== undefined && (!Array.isArray(policy.attesterKeyIds) || policy.attesterKeyIds.some((id) => typeof id !== 'string'))) {
    throw new ExecutionAttestationError('EXECUTION_ATTESTATION_INVALID', 'attesterKeyIds must be an array of attester key identities');
  }
}

// ============================================================================
// The ordered critical checks
// ============================================================================

const envelopeShape: VerificationCheck = {
  id: 'envelope-shape',
  evaluate: (attestation) => {
    const failure = validateEnvelopeStructure(attestation);
    if (failure !== null && failure.code === 'ATTESTATION_MALFORMED_ENVELOPE') {
      return failure;
    }
    return null;
  },
};

const envelopeDomain: VerificationCheck = {
  id: 'envelope-domain',
  evaluate: (attestation) => {
    if (attestation.objectType !== 'workflowos/execution-attestation/v1') {
      return {
        code: 'ATTESTATION_DOMAIN_MISMATCH',
        detail: `envelope objectType "${String(attestation.objectType)}" is not workflowos/execution-attestation/v1 (cross-protocol/cross-object substitution rejected)`,
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

const statementDomain: VerificationCheck = {
  id: 'statement-domain',
  evaluate: (attestation) => {
    const statementObjectType = (attestation.statement as unknown as Record<string, unknown>)['objectType'];
    if (statementObjectType !== 'workflowos/execution-statement/v1') {
      return {
        code: 'ATTESTATION_DOMAIN_MISMATCH',
        detail: `statement objectType "${String(statementObjectType)}" is not workflowos/execution-statement/v1 (cross-protocol/cross-object substitution rejected)`,
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

const attesterKeyIdConsistency: VerificationCheck = {
  id: 'attester-key-id',
  evaluate: (attestation) => {
    const derived = deriveAttesterKeyId(attestation.attesterPublicKey);
    if (derived !== attestation.attesterKeyId) {
      return {
        code: 'ATTESTATION_ATTESTER_KEY_ID_MISMATCH',
        detail: `the attester key id is not derived from the embedded public key (claimed ${attestation.attesterKeyId}, derived ${derived})`,
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

const signatureAuthenticity: VerificationCheck = {
  id: 'signature',
  evaluate: (attestation) => {
    const preimage = signingPreimageJson(attestation);
    if (!verifyEd25519Signature(preimage, attestation.signature, attestation.attesterPublicKey)) {
      return {
        code: 'ATTESTATION_SIGNATURE_INVALID',
        detail: 'the Ed25519 signature does not verify over the canonical unsigned-envelope preimage under the embedded attester public key',
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

const expectedAttester: VerificationCheck = {
  id: 'expected-attester',
  evaluate: (attestation, policy) => {
    if (policy.attesterKeyIds === undefined) {
      return null;
    }
    if (!policy.attesterKeyIds.includes(attestation.attesterKeyId)) {
      return {
        code: 'ATTESTATION_ATTESTER_UNEXPECTED',
        detail: `the attestation is signed by attester ${attestation.attesterKeyId}, but the policy trusts only [${policy.attesterKeyIds.join(', ')}] (cryptographic authenticity is not attester trust — substitution rejected)`,
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

const digestMatch: VerificationCheck = {
  id: 'digest-match',
  evaluate: (attestation) => {
    const recomputed = digestOfStatementObject(attestation.statement);
    if (recomputed !== attestation.executionDigest.digest) {
      return {
        code: 'ATTESTATION_DIGEST_MISMATCH',
        detail: `the envelope execution digest ${attestation.executionDigest.digest} does not match the digest recomputed over the embedded statement ${recomputed}`,
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

const bindingExpectations: VerificationCheck = {
  id: 'bindings',
  evaluate: (attestation, policy) => {
    const statement = attestation.statement as unknown as Record<string, unknown>;
    const expectations = policy.bindings as Record<string, unknown>;
    for (const dimension of ATTESTATION_BINDING_DIMENSIONS) {
      const field = BINDING_DIMENSION_FIELDS[dimension];
      const expected = expectations[field];
      if (expected === undefined) {
        continue;
      }
      if (dimension === 'causalParents') {
        const expectedSet = sortedSetKey(expected);
        const actualSet = sortedSetKey(statement['causalParents']);
        if (expectedSet !== actualSet) {
          return bindingMismatch(dimension, expectedSet, actualSet, attestation.attestationId, 'the causal parent ExecutionDigest set does not match the expectation');
        }
        continue;
      }
      const actual = statement[field];
      if (actual !== expected) {
        const presenceDetail =
          dimension === 'step' && actual === undefined
            ? 'the statement is run-scoped but a step binding is required for this decision'
            : 'the execution binding does not match the verifier expectation';
        return bindingMismatch(dimension, renderValue(expected), renderValue(actual), attestation.attestationId, presenceDetail);
      }
    }
    return null;
  },
};

const freshnessNonce: VerificationCheck = {
  id: 'freshness-nonce',
  evaluate: (attestation, policy) => {
    const expectedNonce = policy.freshness.expectedNonce;
    if (expectedNonce !== undefined && attestation.statement.nonce !== expectedNonce) {
      return {
        code: 'ATTESTATION_NONCE_UNEXPECTED',
        detail: `the statement nonce does not match the expected challenge for this execution attempt (expected "${expectedNonce}", got "${attestation.statement.nonce}")`,
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

const freshnessEpoch: VerificationCheck = {
  id: 'freshness-epoch',
  evaluate: (attestation, policy) => {
    if (attestation.statement.epoch < policy.freshness.currentEpoch) {
      return {
        code: 'ATTESTATION_EPOCH_STALE',
        detail: `the statement epoch ${String(attestation.statement.epoch)} is older than the verifier epoch ${String(policy.freshness.currentEpoch)}`,
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

const freshnessExpiry: VerificationCheck = {
  id: 'freshness-expiry',
  evaluate: (attestation, policy) => {
    const now = parseUtcTimestamp(policy.freshness.now);
    const validUntil = attestation.statement.validUntil;
    if (validUntil !== undefined) {
      const validUntilMs = parseUtcTimestamp(validUntil);
      if (now !== null && validUntilMs !== null && now > validUntilMs) {
        return {
          code: 'ATTESTATION_EXPIRED',
          detail: `the attestation validity interval expired at ${validUntil} (verified at ${policy.freshness.now})`,
          attestationId: attestation.attestationId,
        };
      }
    }
    const maxAgeMs = policy.freshness.maxAgeMs;
    if (maxAgeMs !== undefined) {
      const issuedAtMs = parseUtcTimestamp(attestation.issuedAt);
      if (now !== null && issuedAtMs !== null && now - issuedAtMs > maxAgeMs) {
        return {
          code: 'ATTESTATION_EXPIRED',
          detail: `the attestation is older than the policy max-age (${String(maxAgeMs)} ms; issued at ${attestation.issuedAt}, verified at ${policy.freshness.now})`,
          attestationId: attestation.attestationId,
        };
      }
    }
    return null;
  },
};

const freshnessReplay: VerificationCheck = {
  id: 'freshness-replay',
  evaluate: (attestation, policy) => {
    const registry = policy.freshness.replayRegistry;
    if (registry === undefined) {
      return null;
    }
    const binding = {
      runId: attestation.statement.runId,
      attemptId: attestation.statement.attemptId,
      nonce: attestation.statement.nonce,
    };
    if (registry.isConsumed(binding)) {
      return {
        code: 'ATTESTATION_REPLAYED',
        detail: `the single-use nonce for (run ${binding.runId}, attempt ${String(binding.attemptId)}) was already consumed — a re-presented attestation is a replay even with fresh timestamps and a valid signature`,
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

const assuranceEvidenceRequired: VerificationCheck = {
  id: 'assurance-evidence',
  evaluate: (attestation) => {
    const rank = assuranceRankOf(attestation.assurance);
    if (rank > 0) {
      const evidence = attestation.assuranceEvidence;
      if (evidence === undefined || evidence.length === 0) {
        return {
          code: 'ATTESTATION_ASSURANCE_EVIDENCE_MISSING',
          detail: `the attestation claims assurance "${attestation.assurance}" but carries NO representable assurance evidence (an opaque secure reference or an inline sha-256 commitment is required)`,
          attestationId: attestation.attestationId,
        };
      }
    }
    return null;
  },
};

const assuranceSufficiency: VerificationCheck = {
  id: 'assurance-sufficiency',
  evaluate: (attestation, policy) => {
    const required = policy.requiredAssurance;
    if (required === undefined) {
      return null;
    }
    if (assuranceRankOf(attestation.assurance) < assuranceRankOf(required)) {
      return {
        code: 'ATTESTATION_ASSURANCE_INSUFFICIENT',
        detail: `the attestation offers assurance "${attestation.assurance}" but the decision requires at least "${required}" — unsupported stronger assurance is reported honestly and never silently downgraded`,
        attestationId: attestation.attestationId,
      };
    }
    return null;
  },
};

/** Typed binding dimension → the field name on statement and policy. */
const BINDING_DIMENSION_FIELDS: Record<(typeof ATTESTATION_BINDING_DIMENSIONS)[number], string> = {
  workflow: 'workflowId',
  workflowVersion: 'workflowVersionId',
  workflowVersionSemanticDigest: 'workflowVersionSemanticDigest',
  deployment: 'deploymentId',
  run: 'runId',
  attempt: 'attemptId',
  step: 'stepId',
  node: 'nodeId',
  causalParents: 'causalParents',
};

function assuranceRankOf(level: string): number {
  const index = (ASSURANCE_LEVELS as readonly string[]).indexOf(level);
  return index < 0 ? -1 : index;
}

function bindingMismatch(
  dimension: string,
  expected: string,
  actual: string,
  attestationId: string,
  detail: string,
): AttestationFailure {
  return {
    code: 'ATTESTATION_BINDING_MISMATCH',
    dimension: dimension as AttestationFailure['dimension'],
    expected,
    actual,
    detail: `binding mismatch on dimension "${dimension}": ${detail}`,
    attestationId,
  };
}

function sortedSetKey(value: unknown): string {
  if (!Array.isArray(value)) {
    return renderValue(value);
  }
  return [...value].sort().join(',');
}

function renderValue(value: unknown): string {
  if (value === undefined) {
    return '<absent>';
  }
  return String(value);
}

/**
 * The ordered critical-check pipeline (the production verification order):
 * structure → domains → key identity → signature → attester trust →
 * digest consistency → bindings → freshness (nonce/epoch/expiry/replay) →
 * assurance (evidence/sufficiency).
 */
export const VERIFICATION_CHECKS: readonly VerificationCheck[] = [
  envelopeShape,
  envelopeDomain,
  statementDomain,
  attesterKeyIdConsistency,
  signatureAuthenticity,
  expectedAttester,
  digestMatch,
  bindingExpectations,
  freshnessNonce,
  freshnessEpoch,
  freshnessExpiry,
  freshnessReplay,
  assuranceEvidenceRequired,
  assuranceSufficiency,
];

// ============================================================================
// The pipeline runner + the public verifier
// ============================================================================

/**
 * Run the given checks in order (first typed failure wins). On FULL success
 * (all provided checks pass) the single-use nonce is consumed and a
 * VerifiedExecutionFact is returned.
 */
export function runVerificationPipeline(
  attestation: ExecutionAttestation,
  policy: AttestationVerificationPolicy,
  checks: readonly VerificationCheck[] = VERIFICATION_CHECKS,
): AttestationVerification {
  validateVerificationPolicy(policy);
  for (const check of checks) {
    const failure = check.evaluate(attestation, policy);
    if (failure !== null) {
      return { ok: false, failure };
    }
  }
  const registry = policy.freshness.replayRegistry;
  if (registry !== undefined) {
    registry.consume({
      runId: attestation.statement.runId,
      attemptId: attestation.statement.attemptId,
      nonce: attestation.statement.nonce,
    });
  }
  return { ok: true, fact: verifiedFact(attestation, policy) };
}

/** The public verifier: ALWAYS the complete ordered pipeline. */
export function verifyAttestation(
  attestation: ExecutionAttestation,
  policy: AttestationVerificationPolicy,
): AttestationVerification {
  return runVerificationPipeline(attestation, policy, VERIFICATION_CHECKS);
}

const NON_AUTHORITY_NOTE =
  'A valid signature proves authentic statement origin/integrity only — never authorization, capability possession, correct behavior, an observed effect, or sufficient evidence (registry authorityRules: signature-is-not-automatic-execution-truth, attestation-is-not-verification-authority).';

function verifiedFact(attestation: ExecutionAttestation, policy: AttestationVerificationPolicy): VerifiedExecutionFact {
  return {
    attestationId: attestation.attestationId,
    executionDigest: attestation.executionDigest,
    statement: attestation.statement,
    attesterKeyId: attestation.attesterKeyId,
    assurance: attestation.assurance as AssuranceLevel,
    verifiedAt: policy.freshness.now,
    attests: 'statement_authenticity',
    neverAsserts: ['authorization', 'capability_possession', 'correct_behavior', 'observed_effect', 'sufficient_evidence'],
    nonAuthorityNote: NON_AUTHORITY_NOTE,
  };
}
