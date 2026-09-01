/**
 * V2-002 — the deterministic identity + digest derivations (PURE).
 *
 * No randomness, no clock, no process-local state: the same authoritative
 * inputs always produce byte-identical identities (registry §"Canonical
 * identity and digest rules": "Deterministic IDs must be derived only from
 * authoritative identity inputs defined by the owning object contract. UI
 * session IDs, timestamps chosen by models, random prompt text, or local
 * process identity must never be the sole identity basis for a durable
 * workflow object or execution fact.").
 *
 * The canonical-JSON helper is deliberately INTERNAL to this module (no
 * shared platform util was invented; IG-001 may consolidate canonical
 * serialization across V2 modules after the W1 merge — recorded as a
 * finding in the V2-002 evidence).
 *
 * DIGEST BOUNDARY (V2-002 ↔ V2-003): `computeContentDigest` digests the
 * OPAQUE version content document for immutability + deterministic
 * convergence proofs. It is the CONTENT digest. The SEMANTIC digest of a
 * WorkflowVersion (SHA-256 over the canonical WorkflowIR + the
 * version-affecting compatibility metadata the IR schema declares) is
 * owned by V2-003. This module never computes, claims, or validates it.
 */
import { createHash } from 'node:crypto';
import type { WorkflowVersionProtocolDescriptor } from '../types.js';

/** SHA-256 hex (64 lowercase chars) over the UTF-8 bytes of `input`. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Canonical JSON: UTF-8 JSON with deterministic object-key ordering
 * (recursive), NO insignificant whitespace, and primitive representations
 * as produced by the ECMAScript JSON serializer (shortest round-trip
 * numbers, standard string escapes). Array order is PRESERVED (ordered
 * sequences are not silently turned into sets — the owning schema declares
 * set semantics; here the content is opaque).
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => serializeCanonical(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(obj[key])}`);
    return `{${members.join(',')}}`;
  }
  // Functions/symbols/bigints are not representable canonical JSON values.
  throw new Error(
    `workflow-repository: value of type ${typeof value} is not a canonical-JSON value`,
  );
}

/**
 * The CONTENT digest: SHA-256 over canonical JSON of the opaque version
 * content. Key-order-insensitive, envelope-free (only the content document
 * is hashed — never request envelopes, repository metadata, or
 * presentation). NOT the semantic digest (V2-003 owns that).
 */
export function computeContentDigest(content: unknown): string {
  return sha256Hex(canonicalJson(content));
}

/** Identity-kind labels for hash domain separation (internal preimage fields). */
type IdentityKind = 'workflow' | 'workflow-version' | 'workflow-installation';

const IDENTITY_PREFIX: Record<IdentityKind, string> = {
  workflow: 'wfw_',
  'workflow-version': 'wfwv_',
  'workflow-installation': 'wfin_',
};

/**
 * Derive a durable identity: prefixed 32-hex from SHA-256 over the
 * canonical identity object (kind-domain-separated, only the declared
 * authoritative fields — every other property of the input is ignored).
 */
function deriveIdentity(kind: IdentityKind, fields: Record<string, string>): string {
  const preimage: Record<string, string> = { kind, ...fields };
  const digest = sha256Hex(canonicalJson(preimage));
  return `${IDENTITY_PREFIX[kind]}${digest.slice(0, 32)}`;
}

/**
 * The workflow identity: derived ONLY from the authoritative creation
 * inputs (tenant organization, owner, slug). Non-authoritative repository
 * metadata (name, description, visibility, timestamps) never affects it;
 * the same creation request converges on the same identity.
 */
export function deriveWorkflowId(input: {
  organizationId: string;
  ownerUserId: string;
  slug: string;
}): string {
  return deriveIdentity('workflow', {
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    slug: input.slug,
  });
}

/**
 * The immutable version identity: derived ONLY from (workflow, content
 * digest, protocol descriptor) — content-addressed per workflow. The SAME
 * content + protocol in one workflow converges on ONE identity (no
 * divergent duplicate); the same content in a DIFFERENT workflow (a fork)
 * is a different identity. Non-authoritative fields (version number,
 * parent, creator, timestamps) never affect it.
 */
export function deriveWorkflowVersionId(input: {
  workflowId: string;
  contentDigest: string;
  protocol: WorkflowVersionProtocolDescriptor;
}): string {
  return deriveIdentity('workflow-version', {
    workflowId: input.workflowId,
    contentDigest: input.contentDigest,
    irSchemaVersion: input.protocol.irSchemaVersion,
  });
}

/**
 * The installation identity: derived ONLY from (tenant organization, the
 * pinned version) — the (tenant, exact version) pair converges on ONE
 * installation; re-installs are idempotent.
 */
export function deriveWorkflowInstallationId(input: {
  organizationId: string;
  versionId: string;
}): string {
  return deriveIdentity('workflow-installation', {
    organizationId: input.organizationId,
    versionId: input.versionId,
  });
}
