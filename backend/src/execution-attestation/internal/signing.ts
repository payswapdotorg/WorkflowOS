/**
 * V2-014 — real Ed25519 signing (node:crypto; no third-party cryptography,
 * no mocks on any path):
 *
 *   generateAttesterKeyPair() — generateKeyPairSync('ed25519');
 *   signExecutionAttestation() — sign(null, preimage, privateKey) over the
 *     canonical unsigned-envelope preimage (domain-separated by the envelope
 *     object type inside the preimage);
 *   verifyEd25519Signature() — verify(null, preimage, publicKey).
 *
 * The signature authenticates the ATTESTER's statement. It never proves
 * honest execution, physical reality, authorization, or sufficient evidence
 * (registry authorityRules: signature-is-not-automatic-execution-truth).
 */
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import {
  ASSURANCE_LEVELS,
  EXECUTION_ATTESTATION_ENVELOPE_SCHEMA_VERSION,
  EXECUTION_ATTESTATION_OBJECT_TYPE,
  ExecutionAttestationError,
} from '../types.js';
import type {
  AssuranceLevel,
  AttesterKeyPair,
  AttestationSigningInput,
  ExecutionAttestation,
} from '../types.js';
import { canonicalAttestationJson, deriveAttesterKeyId, deriveAttestationIdentity, signingPreimageJson, validateEnvelopeStructure } from './envelope.js';
import { assertValidStatement, digestOfStatementObject, isUtcTimestamp } from './statement.js';
import { isCanonicalAssurance } from './registry-vocabulary.js';

/** A fixed probe message for real key-pair consistency checks. */
const KEY_PAIR_PROBE = Buffer.from('workflowos/execution-attestation/v1 key-pair consistency probe', 'utf8');

/**
 * Generate a REAL Ed25519 attester key pair. The private key stays in memory
 * (never serialized into any protocol object); the public key travels in the
 * envelope as hex SPKI DER.
 */
export function generateAttesterKeyPair(): AttesterKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  return {
    privateKey,
    publicKeyDer,
    keyId: deriveAttesterKeyId(publicKeyDer),
  };
}

/** The assurance rank (monotonic order of the registry vocabulary). */
export function assuranceRank(level: AssuranceLevel): number {
  return ASSURANCE_LEVELS.indexOf(level);
}

/**
 * Sign an ExecutionStatement into an ExecutionAttestation with a REAL Ed25519
 * signature. Fail-closed typed rejections: invalid statements, non-canonical
 * assurance, stronger-than-software assurance without representable
 * evidence, malformed issuance clock, and private/public key mismatch (real
 * cryptographic probe — never an assumption).
 */
export function signExecutionAttestation(input: AttestationSigningInput): ExecutionAttestation {
  assertValidStatement(input.statement);

  if (typeof input.assurance !== 'string' || !isCanonicalAssurance(input.assurance)) {
    throw new ExecutionAttestationError(
      'EXECUTION_ATTESTATION_INVALID',
      `assurance "${String(input.assurance)}" is not a canonical registry assurance level`,
    );
  }
  if (input.assuranceEvidence !== undefined && !Array.isArray(input.assuranceEvidence)) {
    throw new ExecutionAttestationError('EXECUTION_ATTESTATION_INVALID', 'assuranceEvidence must be an array of evidence descriptors');
  }
  if (assuranceRank(input.assurance) > assuranceRank('software_signed')) {
    const evidence = input.assuranceEvidence ?? [];
    if (evidence.length === 0) {
      throw new ExecutionAttestationError(
        'EXECUTION_ATTESTATION_INVALID',
        `assurance level "${input.assurance}" requires representable assurance evidence (an opaque secure reference or an inline sha-256 commitment) — unsupported stronger assurance is never claimed silently`,
      );
    }
  }

  if (!isUtcTimestamp(input.issuedAt)) {
    throw new ExecutionAttestationError(
      'EXECUTION_ATTESTATION_INVALID',
      'issuedAt must be a fixed-format UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ) — the attester clock is injected, never ambient',
    );
  }

  // REAL key-pair consistency probe: the private key must sign and the public
  // key must verify, otherwise the envelope would carry a key it cannot honor.
  const probeSignature = sign(null, KEY_PAIR_PROBE, input.attesterPrivateKey);
  const publicKeyObject = createPublicKey({ key: Buffer.from(input.attesterPublicKeyDer, 'hex'), format: 'der', type: 'spki' });
  if (!verify(null, KEY_PAIR_PROBE, publicKeyObject, probeSignature)) {
    throw new ExecutionAttestationError(
      'EXECUTION_ATTESTATION_INVALID',
      'the attester private key does not match the provided attester public key (verified with a real Ed25519 probe signature)',
    );
  }

  const executionDigest = {
    algorithm: 'sha-256' as const,
    domain: 'workflowos/execution-statement/v1' as const,
    digest: digestOfStatementObject(input.statement),
  };
  const attesterKeyId = deriveAttesterKeyId(input.attesterPublicKeyDer);
  const attestationId = deriveAttestationIdentity(executionDigest.digest, attesterKeyId);

  const unsigned: Record<string, unknown> = {
    objectType: EXECUTION_ATTESTATION_OBJECT_TYPE,
    envelopeSchemaVersion: EXECUTION_ATTESTATION_ENVELOPE_SCHEMA_VERSION,
    attestationId,
    executionDigest,
    statement: input.statement,
    attesterKeyId,
    attesterPublicKey: input.attesterPublicKeyDer,
    assurance: input.assurance,
    issuedAt: input.issuedAt,
  };
  if (input.assuranceEvidence !== undefined) {
    unsigned['assuranceEvidence'] = input.assuranceEvidence;
  }
  if (input.keyReference !== undefined) {
    unsigned['keyReference'] = input.keyReference;
  }

  const preimage = signingPreimageJson(unsigned);
  const signature = sign(null, Buffer.from(preimage, 'utf8'), input.attesterPrivateKey).toString('hex');

  const attestation = { ...unsigned, signature } as unknown as ExecutionAttestation;
  const structuralFailure = validateEnvelopeStructure(attestation);
  if (structuralFailure !== null) {
    throw new ExecutionAttestationError('EXECUTION_ATTESTATION_INVALID', `signed envelope is structurally invalid: ${structuralFailure.detail}`);
  }
  return attestation;
}

/**
 * REAL Ed25519 signature verification over a preimage under a hex SPKI DER
 * public key. Returns false for any invalid input (never throws to callers —
 * typed failure mapping happens in the verification pipeline).
 */
export function verifyEd25519Signature(preimage: string, signatureHex: string, publicKeyDerHex: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyDerHex, 'hex'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(preimage, 'utf8'), publicKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** The canonical export bytes of a signed attestation (typed fail-closed). */
export function serializeAttestation(attestation: ExecutionAttestation): string {
  return canonicalAttestationJson(attestation);
}
