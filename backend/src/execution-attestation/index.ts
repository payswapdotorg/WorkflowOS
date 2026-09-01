/**
 * V2-014 — Execution Attestation Protocol (public barrel).
 *
 * Owns (spec/architecture/v2/work-orders/V2-014.md): the ExecutionStatement
 * schema + canonical deterministic serialization, the domain-separated
 * ExecutionDigest, the ExecutionAttestation envelope + real Ed25519 signature
 * model, attester/workload identity bindings, freshness + anti-replay
 * semantics, the assurance vocabulary + representable evidence, cryptographic
 * verification with typed failure results, duplicate convergence by stable
 * identity, and the protocol conformance fixtures/discrimination tests.
 *
 * Boundaries (V2-014):
 *   - NO repository persistence (V2-002), NO WorkflowIR semantics (V2-003),
 *     NO Node authority (V2-004), NO run/evidence persistence (V2-005), NO
 *     computer-use execution (V2-008), NO proof-graph coordination (V2-015);
 *     merged sibling outputs are consumed ONLY as opaque reference data.
 *   - NO routes, NO migrations, NO new dependencies: real cryptography via
 *     the Node builtin `node:crypto` (Ed25519 + SHA-256) only.
 *   - NO authorization authority: a valid signature never implies
 *     authorization, correct behavior, or sufficient evidence — the verified
 *     fact marks those dimensions as never asserted.
 */
export {
  // §0 domain identity
  EXECUTION_STATEMENT_OBJECT_TYPE,
  EXECUTION_ATTESTATION_OBJECT_TYPE,
  EXECUTION_STATEMENT_SCHEMA_VERSION,
  EXECUTION_ATTESTATION_ENVELOPE_SCHEMA_VERSION,
  ATTESTER_KEY_ID_DOMAIN,
  // §1 vocabularies (frozen registry identifiers)
  EXECUTION_CLASSES,
  ASSURANCE_LEVELS,
  EXECUTION_OUTCOMES,
  EXECUTION_ATTESTATION_EVENT_NAMES,
  // §2 identity prefixes
  ATTESTATION_ID_PREFIX,
  ATTESTER_KEY_ID_PREFIX,
  ATTESTATION_EVENT_ID_PREFIX,
  // §8 typed failure taxonomy
  ATTESTATION_FAILURE_CODES,
  ATTESTATION_BINDING_DIMENSIONS,
  // §15 typed error surface
  EXECUTION_ATTESTATION_ERROR_CODES,
  ExecutionAttestationError,
} from './types.js';
export type {
  ExecutionClass,
  AssuranceLevel,
  CapabilityName,
  ExecutionOutcome,
  ExecutionAttestationEventName,
  Sha256Hex,
  UtcTimestamp,
  Ed25519SignatureHex,
  ExecutionStatement,
  ExecutionDigestValue,
  AssuranceEvidence,
  ExecutionAttestation,
  AttesterKeyPair,
  AttestationSigningInput,
  AttestationFailure,
  AttestationFailureCode,
  AttestationBindingDimension,
  AttestationVerification,
  VerifiedExecutionFact,
  AttestationBindingExpectation,
  AttestationFreshnessPolicy,
  AttestationVerificationPolicy,
  ReplayRegistry,
  AttestationIngestionOutcome,
  AttestationParseResult,
  ExecutionAttestationProtocolEvent,
  AttestationValidationIssue,
  AttestationValidationResult,
  ExecutionAttestationErrorCode,
} from './types.js';

// §3/§4 statement + digest (canonical serialization, validation, commitments)
export {
  validateExecutionStatement,
  canonicalStatementJson,
  computeExecutionDigest,
  executionValueCommitment,
} from './internal/statement.js';

// §6 envelope (identity derivations, parse)
export { deriveAttesterKeyId, deriveAttestationIdentity, parseAttestation } from './internal/envelope.js';

// §7 real Ed25519 signing + canonical export bytes
export { generateAttesterKeyPair, signExecutionAttestation, assuranceRank, serializeAttestation } from './internal/signing.js';

// §9/§10 typed verification
export { verifyAttestation, validateVerificationPolicy } from './internal/verify.js';

// §11/§12 replay + convergence (reference in-memory implementations)
export { InMemoryReplayRegistry, InMemoryAttestationLedger } from './internal/attestation-ledger.js';

// §14 typed protocol events
export { attestationIssuedEvent, attestationVerifiedEvent } from './internal/protocol-events.js';

// §1 registry vocabulary snapshot (frozen; pinned no-drift by the battery)
export { EXECUTION_ATTESTATION_REGISTRY_VOCABULARY } from './internal/registry-vocabulary.js';

// canonical JSON discipline (public for cross-client byte-equality proofs)
export { canonicalJsonStringify } from './internal/canonical-json.js';
