/**
 * V2-014 — the ExecutionAttestation envelope: structural validation (typed,
 * fail-closed), canonical serialization, domain separation at the envelope
 * and statement levels, and the stable identity derivations.
 *
 * Identity derivations (invariant 4 — distinct namespaces, distinct bases):
 *
 *   attesterKeyId  = 'wfeak_' + sha-256('workflowos/attester-key/v1' || DER)
 *                    — derived ONLY from the attester's public key bytes;
 *   attestationId  = 'wfea_' + sha-256(canonical-json(
 *                      {kind, executionDigest, attesterKeyId}))[:32]
 *                    — derived ONLY from the (execution digest, attester key)
 *                    pair: duplicate delivery converges on it, and it is
 *                    neither Node identity nor workload identity.
 */
import { createHash } from 'node:crypto';
import {
  ATTESTATION_ID_PREFIX,
  ATTESTER_KEY_ID_DOMAIN,
  ATTESTER_KEY_ID_PREFIX,
  EXECUTION_ATTESTATION_ENVELOPE_SCHEMA_VERSION,
  EXECUTION_ATTESTATION_OBJECT_TYPE,
  EXECUTION_STATEMENT_OBJECT_TYPE,
  ExecutionAttestationError,
} from '../types.js';
import type {
  AttestationFailure,
  AttestationParseResult,
  ExecutionAttestation,
  Sha256Hex,
} from '../types.js';
import { canonicalJsonStringify } from './canonical-json.js';
import { canonicalStatementProjection, isSha256Hex, isUtcTimestamp, validateExecutionStatement } from './statement.js';
import { isCanonicalAssurance } from './registry-vocabulary.js';

const ATTESTATION_ID_PATTERN = /^wfea_[0-9a-f]{32}$/;
const ATTESTER_KEY_ID_PATTERN = /^wfeak_[0-9a-f]{32}$/;
const ED25519_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;
const HEX_PATTERN = /^[0-9a-f]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const REQUIRED_ENVELOPE_KEYS = [
  'objectType',
  'envelopeSchemaVersion',
  'attestationId',
  'executionDigest',
  'statement',
  'attesterKeyId',
  'attesterPublicKey',
  'assurance',
  'issuedAt',
  'signature',
] as const;

const OPTIONAL_ENVELOPE_KEYS = ['assuranceEvidence', 'keyReference'] as const;
const ALLOWED_ENVELOPE_KEYS = new Set<string>([...REQUIRED_ENVELOPE_KEYS, ...OPTIONAL_ENVELOPE_KEYS]);

// ============================================================================
// Identity derivations
// ============================================================================

/** The stable attester key identity: 'wfeak_' + sha-256(domain || DER). */
export function deriveAttesterKeyId(publicKeyDerHex: string): string {
  const digest = createHash('sha256')
    .update(ATTESTER_KEY_ID_DOMAIN, 'utf8')
    .update(Buffer.from(publicKeyDerHex, 'hex'))
    .digest('hex');
  return `${ATTESTER_KEY_ID_PREFIX}${digest.slice(0, 32)}`;
}

/** The stable attestation identity: 'wfea_' + sha-256 over the (digest, key) pair. */
export function deriveAttestationIdentity(executionDigest: Sha256Hex, attesterKeyId: string): string {
  const preimage = {
    kind: 'execution-attestation',
    executionDigest,
    attesterKeyId,
  };
  const digest = createHash('sha256').update(canonicalJsonStringify(preimage), 'utf8').digest('hex');
  return `${ATTESTATION_ID_PREFIX}${digest.slice(0, 32)}`;
}

// ============================================================================
// Envelope validation (structure + domains — typed failures)
// ============================================================================

function malformed(detail: string, attestationId?: string): AttestationFailure {
  return { code: 'ATTESTATION_MALFORMED_ENVELOPE', detail, ...(attestationId !== undefined ? { attestationId } : {}) };
}

function domainMismatch(detail: string): AttestationFailure {
  return { code: 'ATTESTATION_DOMAIN_MISMATCH', detail };
}

/**
 * Structural + domain validation of an attestation envelope (no signature
 * verification — that is the verification pipeline's job). Returns a typed
 * failure for malformed structure and for cross-protocol/cross-object domain
 * substitution.
 */
export function validateEnvelopeStructure(value: unknown): AttestationFailure | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return malformed('an ExecutionAttestation must be a JSON object');
  }
  const envelope = value as Record<string, unknown>;

  const objectType = envelope['objectType'];
  if (typeof objectType !== 'string') {
    return malformed('envelope objectType must be a string');
  }
  if (objectType !== EXECUTION_ATTESTATION_OBJECT_TYPE) {
    return domainMismatch(
      `envelope objectType "${objectType}" is not ${EXECUTION_ATTESTATION_OBJECT_TYPE} (cross-protocol/cross-object substitution rejected)`,
    );
  }

  const attestationId = envelope['attestationId'];
  const attestationIdText = typeof attestationId === 'string' ? attestationId : undefined;

  if (envelope['envelopeSchemaVersion'] !== EXECUTION_ATTESTATION_ENVELOPE_SCHEMA_VERSION) {
    return malformed(
      `unsupported envelope schema version ${String(envelope['envelopeSchemaVersion'])} (supported: ${String(EXECUTION_ATTESTATION_ENVELOPE_SCHEMA_VERSION)})`,
      attestationIdText,
    );
  }

  if (typeof attestationId !== 'string' || !ATTESTATION_ID_PATTERN.test(attestationId)) {
    return malformed('attestationId must be a wfea_-prefixed 32-hex identity', attestationIdText);
  }

  const executionDigest = envelope['executionDigest'];
  if (typeof executionDigest !== 'object' || executionDigest === null || Array.isArray(executionDigest)) {
    return malformed('executionDigest must be an object {algorithm, domain, digest}', attestationId);
  }
  const digestRecord = executionDigest as Record<string, unknown>;
  if (digestRecord['algorithm'] !== 'sha-256' || !isSha256Hex(digestRecord['digest'])) {
    return malformed('executionDigest must carry algorithm "sha-256" and a 64-hex digest', attestationId);
  }
  if (digestRecord['domain'] !== EXECUTION_STATEMENT_OBJECT_TYPE) {
    return domainMismatch(
      `executionDigest domain "${String(digestRecord['domain'])}" is not the execution-statement domain ${EXECUTION_STATEMENT_OBJECT_TYPE}`,
    );
  }

  const statement = envelope['statement'];
  if (typeof statement !== 'object' || statement === null || Array.isArray(statement)) {
    return malformed('statement must be a JSON object', attestationId);
  }
  const statementRecord = statement as Record<string, unknown>;
  if (typeof statementRecord['objectType'] !== 'string') {
    return malformed('statement objectType must be a string', attestationId);
  }
  if (statementRecord['objectType'] !== EXECUTION_STATEMENT_OBJECT_TYPE) {
    return domainMismatch(
      `statement objectType "${statementRecord['objectType']}" is not ${EXECUTION_STATEMENT_OBJECT_TYPE} (cross-protocol/cross-object substitution rejected)`,
    );
  }
  const statementValidation = validateExecutionStatement(statement);
  if (!statementValidation.ok) {
    const summary = statementValidation.issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('; ');
    return malformed(`the embedded statement is invalid: ${summary}`, attestationId);
  }

  if (typeof envelope['attesterKeyId'] !== 'string' || !ATTESTER_KEY_ID_PATTERN.test(envelope['attesterKeyId'])) {
    return malformed('attesterKeyId must be a wfeak_-prefixed 32-hex identity', attestationId);
  }
  if (typeof envelope['attesterPublicKey'] !== 'string' || !HEX_PATTERN.test(envelope['attesterPublicKey'])) {
    return malformed('attesterPublicKey must be a hex-encoded SPKI DER Ed25519 public key', attestationId);
  }

  if (typeof envelope['assurance'] !== 'string' || !isCanonicalAssurance(envelope['assurance'])) {
    return malformed(`assurance "${String(envelope['assurance'])}" is not a canonical registry assurance level`, attestationId);
  }

  const assuranceEvidence = envelope['assuranceEvidence'];
  if (assuranceEvidence !== undefined) {
    if (!Array.isArray(assuranceEvidence)) {
      return malformed('assuranceEvidence must be an array of evidence descriptors', attestationId);
    }
    for (const evidence of assuranceEvidence) {
      const failure = validateAssuranceEvidenceDescriptor(evidence);
      if (failure !== null) {
        return { ...failure, attestationId };
      }
    }
  }

  const keyReference = envelope['keyReference'];
  if (keyReference !== undefined && (typeof keyReference !== 'string' || keyReference.length === 0 || keyReference.length > 256 || CONTROL_CHARACTER_PATTERN.test(keyReference))) {
    return malformed('keyReference must be a non-empty opaque reference string', attestationId);
  }

  if (!isUtcTimestamp(envelope['issuedAt'])) {
    return malformed('issuedAt must be a fixed-format UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ)', attestationId);
  }

  if (typeof envelope['signature'] !== 'string' || !ED25519_SIGNATURE_PATTERN.test(envelope['signature'])) {
    return malformed('signature must be a 128-hex Ed25519 signature', attestationId);
  }

  for (const key of Object.keys(envelope)) {
    if (!ALLOWED_ENVELOPE_KEYS.has(key)) {
      return malformed(`unknown envelope field "${key}" (exact key set — no smuggling surface)`, attestationId);
    }
  }

  return null;
}

function validateAssuranceEvidenceDescriptor(evidence: unknown): AttestationFailure | null {
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return malformed('assurance evidence entries must be objects');
  }
  const record = evidence as Record<string, unknown>;
  if (record['kind'] === 'opaque_reference') {
    if (Object.keys(record).length !== 2 || typeof record['reference'] !== 'string' || record['reference'].length === 0 || record['reference'].length > 256 || CONTROL_CHARACTER_PATTERN.test(record['reference'])) {
      return malformed('opaque_reference evidence requires a non-empty opaque reference string');
    }
    return null;
  }
  if (record['kind'] === 'inline_commitment') {
    if (Object.keys(record).length !== 3 || record['algorithm'] !== 'sha-256' || !isSha256Hex(record['digest'])) {
      return malformed('inline_commitment evidence requires algorithm "sha-256" and a 64-hex digest');
    }
    return null;
  }
  return malformed('assurance evidence kind must be "opaque_reference" or "inline_commitment"');
}

// ============================================================================
// Canonical projection + serialization
// ============================================================================

/**
 * The canonical envelope projection (set-normalized assurance evidence,
 * canonical statement projection, deterministic optional omission). PURE —
 * operates on arbitrary objects (used for preimages and re-computation).
 */
export function canonicalEnvelopeProjection(value: unknown): Record<string, unknown> {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {
    objectType: record['objectType'],
    envelopeSchemaVersion: record['envelopeSchemaVersion'],
    attestationId: record['attestationId'],
    executionDigest: canonicalDigestValue(record['executionDigest']),
    statement: canonicalStatementProjection(record['statement']),
    attesterKeyId: record['attesterKeyId'],
    attesterPublicKey: record['attesterPublicKey'],
    assurance: record['assurance'],
    issuedAt: record['issuedAt'],
    signature: record['signature'],
  };
  if (record['assuranceEvidence'] !== undefined) {
    const evidence = Array.isArray(record['assuranceEvidence'])
      ? [...record['assuranceEvidence']].sort((a, b) => {
          const aKey = canonicalJsonStringify(a);
          const bKey = canonicalJsonStringify(b);
          return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
        })
      : record['assuranceEvidence'];
    result['assuranceEvidence'] = evidence;
  }
  if (record['keyReference'] !== undefined) {
    result['keyReference'] = record['keyReference'];
  }
  return result;
}

function canonicalDigestValue(value: unknown): Record<string, unknown> {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    algorithm: record['algorithm'],
    domain: record['domain'],
    digest: record['digest'],
  };
}

/**
 * The UNSIGNED envelope projection (the signing preimage object): the
 * canonical envelope WITHOUT the signature member. PURE.
 */
export function unsignedEnvelope(value: unknown): Record<string, unknown> {
  const projection = canonicalEnvelopeProjection(value);
  delete projection['signature'];
  return projection;
}

/** The canonical JSON signing preimage of an envelope (PURE). */
export function signingPreimageJson(value: unknown): string {
  return canonicalJsonStringify(unsignedEnvelope(value));
}

/**
 * The canonical JSON export form of a VALIDATED attestation (typed,
 * fail-closed). This is the exported byte form: serialize → transport →
 * parse → verify is the supported round trip.
 */
export function canonicalAttestationJson(attestation: ExecutionAttestation): string {
  const failure = validateEnvelopeStructure(attestation);
  if (failure !== null) {
    throw new ExecutionAttestationError(
      'EXECUTION_ATTESTATION_INVALID',
      `invalid ExecutionAttestation: ${failure.detail}`,
    );
  }
  return canonicalJsonStringify(canonicalEnvelopeProjection(attestation));
}

// ============================================================================
// Parse (typed failures: malformed + domain mismatch)
// ============================================================================

/**
 * Parse canonical (or any) JSON bytes into an attestation. Typed fail-closed:
 * non-JSON bytes or structurally invalid envelopes yield
 * ATTESTATION_MALFORMED_ENVELOPE; foreign protocol objects (e.g. a serialized
 * WorkflowIR document or a bare statement) yield ATTESTATION_DOMAIN_MISMATCH.
 */
export function parseAttestation(bytes: string): AttestationParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    return { ok: false, failure: malformed(`the bytes are not JSON: ${(error as Error).message}`) };
  }
  // distinguish domain mismatches (a foreign protocol object) before deep
  // structural validation so substitution is always typed as DOMAIN_MISMATCH:
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const objectType = (parsed as Record<string, unknown>)['objectType'];
    if (typeof objectType === 'string' && objectType !== EXECUTION_ATTESTATION_OBJECT_TYPE) {
      return {
        ok: false,
        failure: domainMismatch(
          `object type "${objectType}" is not ${EXECUTION_ATTESTATION_OBJECT_TYPE} (cross-protocol/cross-object substitution rejected)`,
        ),
      };
    }
  }
  const failure = validateEnvelopeStructure(parsed);
  if (failure !== null) {
    return { ok: false, failure };
  }
  return { ok: true, attestation: parsed as ExecutionAttestation };
}
