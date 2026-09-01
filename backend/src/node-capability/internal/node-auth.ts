import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NodeRegistrationPayload } from '../types.js';

/**
 * V2-004 — registration-channel authentication (node scope, deliberately
 * minimal).
 *
 * Boundary rationale (recorded in the V2-004 evidence file):
 *
 *   - This authenticates a node's REGISTRATION CHANNEL and its session —
 *     nothing more. It proves possession of node-scoped key material at
 *     registration time and binds the exact registration payload (platform
 *     class, protocol version, capability advertisement, attributes) so the
 *     advertisement cannot be altered in transit.
 *   - It is HMAC-SHA256 message authentication over domain-separated
 *     canonical-JSON payloads — symmetric MAC verification by the directory,
 *     which is the only party that needs to verify it. It is NOT an
 *     execution fact, NOT a claim about any side effect, and carries no
 *     verification authority. The execution-truth protocol object types
 *     (statement, digest and proof-composition objects — a separate Work
 *     Order's concepts) are structurally absent from this module (pinned by
 *     tests/unit/node-capability/module-boundary.test.ts).
 *   - MAC input domains are `workflowos/node-key/v1`,
 *     `workflowos/node-registration/v1`, `workflowos/node-session/v1` —
 *     node-scoped only, so a registration MAC can never be replayed as any
 *     other protocol fact.
 */

/** MAC input domain for node key fingerprint derivation. */
const NODE_KEY_DOMAIN = 'workflowos/node-key/v1';

/** MAC input domain for registration challenge responses. */
const NODE_REGISTRATION_DOMAIN = 'workflowos/node-registration/v1';

/** MAC input domain for session tokens. */
const NODE_SESSION_DOMAIN = 'workflowos/node-session/v1';

const FINGERPRINT_HEX_LENGTH = 16;

/**
 * Deterministic node id derivation: SHA-256 over the domain label and the
 * node key material (the authoritative identity input of the node object
 * contract). Same key material → same id; different key material →
 * different id. No clock, no randomness.
 */
export function deriveNodeKeyFingerprint(nodeKeySecret: Uint8Array): string {
  const digest = createHash('sha256').update(NODE_KEY_DOMAIN).update(nodeKeySecret).digest('hex');
  return `node_${digest.slice(0, FINGERPRINT_HEX_LENGTH)}`;
}

/**
 * Canonical JSON serialization for MAC inputs (V2-CTRL-003 canonical-JSON
 * discipline): UTF-8 JSON, deterministically sorted object keys, preserved
 * array order, no insignificant whitespace. Presentation formatting is never
 * included. Only plain protocol data can be canonicalized: secrets (raw key
 * bytes) are structurally rejected.
 */
export function canonicalJsonString(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('node-capability: canonical JSON cannot represent a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalizeElement(element)).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (value instanceof Uint8Array) {
      throw new Error('node-capability: canonical JSON must not embed raw key material');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }
  throw new Error(`node-capability: canonical JSON cannot represent ${typeof value}`);
}

function canonicalizeElement(element: unknown): string {
  if (element === undefined) {
    throw new Error('node-capability: canonical JSON cannot represent undefined inside an array');
  }
  return canonicalize(element);
}

/** The MAC message for a registration challenge response. */
function registrationMessage(nonce: string, payload: NodeRegistrationPayload): string {
  return `${NODE_REGISTRATION_DOMAIN}\n${nonce}\n${canonicalJsonString(payload)}`;
}

/**
 * Node-side computation of the registration challenge response: hex
 * HMAC-SHA256 over the domain-separated nonce + canonical-JSON payload.
 * Exported so hosts implement the same protocol; the directory recomputes
 * it to verify (timing-safe).
 */
export function computeRegistrationResponse(input: {
  readonly nodeKeySecret: Uint8Array;
  readonly payload: NodeRegistrationPayload;
  readonly nonce: string;
}): string {
  return createHmac('sha256', input.nodeKeySecret)
    .update(registrationMessage(input.nonce, input.payload))
    .digest('hex');
}

/** Directory-side timing-safe verification of a challenge response. */
export function verifyRegistrationResponse(input: {
  readonly nodeKeySecret: Uint8Array;
  readonly payload: NodeRegistrationPayload;
  readonly nonce: string;
  readonly response: string;
}): boolean {
  const expected = computeRegistrationResponse({
    nodeKeySecret: input.nodeKeySecret,
    payload: input.payload,
    nonce: input.nonce,
  });
  return hexEqual(expected, input.response);
}

/** Session-token computation (directory-side issue/verify). */
export function computeSessionToken(input: {
  readonly nodeKeySecret: Uint8Array;
  readonly nodeKeyFingerprint: string;
  readonly serial: number;
}): string {
  const message = `${NODE_SESSION_DOMAIN}\n${input.nodeKeyFingerprint}\n${String(input.serial)}`;
  return createHmac('sha256', input.nodeKeySecret).update(message).digest('hex');
}

/** Timing-safe comparison of two hex MAC strings. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
