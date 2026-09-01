/**
 * V2-014 — the ExecutionStatement: schema validation, the canonical semantic
 * projection, the domain-separated ExecutionDigest, and the one-way value
 * commitment helper.
 *
 * DIGEST BOUNDARY (invariant 1 + 2, registry digest rule): the ExecutionDigest
 * is SHA-256 over canonical JSON of
 *
 *   { domain: 'workflowos/execution-statement/v1',
 *     statementSchemaVersion,
 *     statement }        ← the canonical (set-normalized) statement
 *
 * The domain label is INSIDE the preimage (domain separation is load-bearing:
 * the same statement bytes hashed without the domain, or under any other
 * module's domain, yield a different digest). This digest commits to
 * execution semantics and is NEVER the WorkflowVersion semantic digest
 * (V2-003's domain) or a content digest (V2-002's discipline) — those enter
 * the statement only as opaque reference binding data.
 */
import { createHash } from 'node:crypto';
import {
  EXECUTION_STATEMENT_OBJECT_TYPE,
  EXECUTION_STATEMENT_SCHEMA_VERSION,
  ExecutionAttestationError,
} from '../types.js';
import type { ExecutionDigestValue, ExecutionStatement, Sha256Hex, UtcTimestamp } from '../types.js';
import { canonicalJsonStringify } from './canonical-json.js';
import { isCanonicalCapability, isCanonicalExecutionClass } from './registry-vocabulary.js';

// ============================================================================
// Value-shape predicates
// ============================================================================

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** Is this a lowercase 64-hex sha-256 value? */
export function isSha256Hex(value: unknown): value is Sha256Hex {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

/**
 * Parse a fixed-format UTC timestamp to epoch milliseconds. Returns null for
 * any non-conforming value (fixed-width UTC strings keep this module free of
 * ambient clock APIs; every timestamp is injected or validated data).
 */
export function parseUtcTimestamp(value: string): number | null {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (year < 1) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
}

/** Is this a valid fixed-format UTC timestamp? */
export function isUtcTimestamp(value: unknown): value is UtcTimestamp {
  return typeof value === 'string' && parseUtcTimestamp(value) !== null;
}

// ============================================================================
// One-way value commitment (the supported path for sensitive values)
// ============================================================================

/**
 * Commit a semantic value to an opaque sha-256 hex commitment. One-way: the
 * raw value (including secret material) NEVER enters the statement — only
 * the commitment does. Deterministic for equal inputs.
 */
export function executionValueCommitment(value: string | Uint8Array): Sha256Hex {
  const hash = createHash('sha256');
  if (typeof value === 'string') {
    hash.update(value, 'utf8');
  } else {
    hash.update(value);
  }
  return hash.digest('hex');
}

// ============================================================================
// Schema validation (exact key sets — no smuggling surface)
// ============================================================================

const REQUIRED_STATEMENT_KEYS = [
  'objectType',
  'statementSchemaVersion',
  'workflowId',
  'workflowVersionId',
  'workflowVersionSemanticDigest',
  'deploymentId',
  'runId',
  'attemptId',
  'nodeId',
  'executionClass',
  'action',
  'inputCommitments',
  'outputCommitments',
  'observationCommitments',
  'evidenceReferences',
  'causalParents',
  'nonce',
  'epoch',
  'outcome',
  'executedAt',
] as const;

const OPTIONAL_STATEMENT_KEYS = [
  'stepId',
  'workloadIdentity',
  'capability',
  'authorizationContextDigest',
  'placementPolicyDigest',
  'validUntil',
] as const;

const ALLOWED_STATEMENT_KEYS = new Set<string>([...REQUIRED_STATEMENT_KEYS, ...OPTIONAL_STATEMENT_KEYS]);

const ID_FIELDS = ['workflowId', 'workflowVersionId', 'deploymentId', 'runId', 'nodeId'] as const;
const COMMITMENT_ARRAYS = ['inputCommitments', 'outputCommitments', 'observationCommitments'] as const;

/**
 * Validate an ExecutionStatement against the schema. Fail-closed: exact key
 * sets, canonical registry vocabularies, commitment shapes, fixed-format
 * bounded timestamps, freshness material, and the outcome vocabulary.
 */
export function validateExecutionStatement(value: unknown): {
  ok: boolean;
  issues: { code: string; path: string; message: string }[];
} {
  const issues: { code: string; path: string; message: string }[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ code: 'STATEMENT_NOT_AN_OBJECT', path: '$', message: 'an ExecutionStatement must be a JSON object' }] };
  }
  const statement = value as Record<string, unknown>;

  if (statement['objectType'] !== EXECUTION_STATEMENT_OBJECT_TYPE) {
    issues.push({
      code: 'STATEMENT_OBJECT_TYPE_INVALID',
      path: '$.objectType',
      message: `objectType must be exactly ${EXECUTION_STATEMENT_OBJECT_TYPE} (cross-protocol/cross-object substitution is rejected)`,
    });
  }

  if (statement['statementSchemaVersion'] !== EXECUTION_STATEMENT_SCHEMA_VERSION) {
    issues.push({
      code: 'STATEMENT_SCHEMA_VERSION_UNSUPPORTED',
      path: '$.statementSchemaVersion',
      message: `unsupported statement schema version ${String(statement['statementSchemaVersion'])} (supported: ${String(EXECUTION_STATEMENT_SCHEMA_VERSION)})`,
    });
  }

  for (const key of Object.keys(statement)) {
    if (!ALLOWED_STATEMENT_KEYS.has(key)) {
      issues.push({
        code: 'STATEMENT_FIELD_UNKNOWN',
        path: `$.${key}`,
        message: `unknown statement field "${key}" (exact key set — no smuggling surface)`,
      });
    }
  }

  for (const key of REQUIRED_STATEMENT_KEYS) {
    if (statement[key] === undefined) {
      issues.push({ code: 'STATEMENT_FIELD_REQUIRED', path: `$.${key}`, message: `required field "${key}" is missing` });
    }
  }

  for (const field of ID_FIELDS) {
    const fieldValue = statement[field];
    if (typeof fieldValue === 'string' && fieldValue.trim() === '') {
      issues.push({ code: 'STATEMENT_ID_EMPTY', path: `$.${field}`, message: `identifier field "${field}" must not be empty/blank` });
    }
  }
  for (const field of ['stepId', 'workloadIdentity'] as const) {
    const fieldValue = statement[field];
    if (fieldValue !== undefined && typeof fieldValue === 'string' && fieldValue.trim() === '') {
      issues.push({ code: 'STATEMENT_ID_EMPTY', path: `$.${field}`, message: `optional identifier field "${field}" must not be empty/blank when present` });
    }
  }
  for (const field of ['action', 'nonce'] as const) {
    const fieldValue = statement[field];
    if (typeof fieldValue === 'string' && fieldValue.trim() === '') {
      issues.push({ code: 'STATEMENT_FIELD_EMPTY', path: `$.${field}`, message: `field "${field}" must not be empty/blank` });
    }
  }

  const attemptId = statement['attemptId'];
  if (attemptId !== undefined && (typeof attemptId !== 'number' || !Number.isInteger(attemptId) || attemptId < 1)) {
    issues.push({ code: 'STATEMENT_ATTEMPT_INVALID', path: '$.attemptId', message: 'attemptId must be an integer >= 1' });
  }

  const epoch = statement['epoch'];
  if (epoch !== undefined && (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0)) {
    issues.push({ code: 'STATEMENT_EPOCH_INVALID', path: '$.epoch', message: 'epoch must be a non-negative integer' });
  }

  const executionClass = statement['executionClass'];
  if (executionClass !== undefined && (typeof executionClass !== 'string' || !isCanonicalExecutionClass(executionClass))) {
    issues.push({ code: 'STATEMENT_EXECUTION_CLASS_NON_CANONICAL', path: '$.executionClass', message: `executionClass "${String(executionClass)}" is not a canonical registry execution class` });
  }

  const capability = statement['capability'];
  if (capability !== undefined && (typeof capability !== 'string' || !isCanonicalCapability(capability))) {
    issues.push({ code: 'STATEMENT_CAPABILITY_NON_CANONICAL', path: '$.capability', message: `capability "${String(capability)}" is not a canonical registry capability name (aliases are rejected, never mapped)` });
  }

  const outcome = statement['outcome'];
  if (outcome !== undefined && outcome !== 'succeeded' && outcome !== 'failed') {
    issues.push({ code: 'STATEMENT_OUTCOME_UNKNOWN', path: '$.outcome', message: `outcome "${String(outcome)}" is not in the execution-outcome vocabulary (succeeded | failed)` });
  }

  for (const field of COMMITMENT_ARRAYS) {
    validateCommitmentArray(statement[field], field, issues);
  }
  const causalParents = statement['causalParents'];
  if (causalParents !== undefined) {
    validateCommitmentArray(causalParents, 'causalParents', issues, 'causal parent ExecutionDigest');
  }
  for (const field of ['workflowVersionSemanticDigest', 'authorizationContextDigest', 'placementPolicyDigest'] as const) {
    const fieldValue = statement[field];
    if (fieldValue !== undefined && !isSha256Hex(fieldValue)) {
      issues.push({ code: 'STATEMENT_DIGEST_NOT_SHA256', path: `$.${field}`, message: `field "${field}" must be a lowercase 64-hex sha-256 digest (raw values cannot be bound here — use executionValueCommitment)` });
    }
  }

  const executedAt = statement['executedAt'];
  const validUntil = statement['validUntil'];
  if (executedAt !== undefined && !isUtcTimestamp(executedAt)) {
    issues.push({ code: 'STATEMENT_TIMESTAMP_INVALID', path: '$.executedAt', message: 'executedAt must be a fixed-format UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ)' });
  }
  if (validUntil !== undefined && !isUtcTimestamp(validUntil)) {
    issues.push({ code: 'STATEMENT_TIMESTAMP_INVALID', path: '$.validUntil', message: 'validUntil must be a fixed-format UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ)' });
  }
  if (isUtcTimestamp(executedAt) && isUtcTimestamp(validUntil)) {
    const executedAtMs = parseUtcTimestamp(executedAt);
    const validUntilMs = parseUtcTimestamp(validUntil);
    if (executedAtMs !== null && validUntilMs !== null && validUntilMs <= executedAtMs) {
      issues.push({ code: 'STATEMENT_TIMESTAMP_ORDER_INVALID', path: '$.validUntil', message: 'validUntil must be strictly after executedAt (bounded validity interval)' });
    }
  }

  const evidenceReferences = statement['evidenceReferences'];
  if (evidenceReferences !== undefined) {
    if (!Array.isArray(evidenceReferences)) {
      issues.push({ code: 'STATEMENT_FIELD_INVALID', path: '$.evidenceReferences', message: 'evidenceReferences must be an array of opaque reference strings' });
    } else {
      evidenceReferences.forEach((reference, index) => {
        if (typeof reference !== 'string' || reference.length === 0 || reference.length > 256 || CONTROL_CHARACTER_PATTERN.test(reference)) {
          issues.push({ code: 'STATEMENT_EVIDENCE_REF_INVALID', path: `$.evidenceReferences[${index}]`, message: 'evidence references must be non-empty opaque strings without control characters' });
        }
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

function validateCommitmentArray(value: unknown, field: string, issues: { code: string; path: string; message: string }[], label = 'commitment'): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ code: 'STATEMENT_FIELD_INVALID', path: `$.${field}`, message: `${field} must be an array of ${label} digests` });
    return;
  }
  value.forEach((entry, index) => {
    if (!isSha256Hex(entry)) {
      issues.push({
        code: 'STATEMENT_COMMITMENT_NOT_SHA256',
        path: `$.${field}[${index}]`,
        message: `${label} entries must be lowercase 64-hex sha-256 digests (one-way commitments — raw values are never bound)`,
      });
    }
  });
}

/** Throw the typed error when the statement is invalid (fail-closed helper). */
export function assertValidStatement(value: unknown): ExecutionStatement {
  const result = validateExecutionStatement(value);
  if (!result.ok) {
    const summary = result.issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('; ');
    throw new ExecutionAttestationError('EXECUTION_ATTESTATION_INVALID', `invalid ExecutionStatement: ${summary}`, result.issues);
  }
  return value as ExecutionStatement;
}

// ============================================================================
// The canonical semantic projection + the ExecutionDigest
// ============================================================================

/**
 * The canonical (set-normalized) projection of a statement. Every collection
 * the SCHEMA declares as a set is sorted here so array order can never affect
 * the digest: input/output/observation commitments, evidence references and
 * causal parents. Optional fields are omitted deterministically when absent.
 * Defensive (pure): operates on arbitrary objects without validating them.
 */
export function canonicalStatementProjection(statement: unknown): Record<string, unknown> {
  const record = (typeof statement === 'object' && statement !== null ? statement : {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {
    objectType: record['objectType'],
    statementSchemaVersion: record['statementSchemaVersion'],
    workflowId: record['workflowId'],
    workflowVersionId: record['workflowVersionId'],
    workflowVersionSemanticDigest: record['workflowVersionSemanticDigest'],
    deploymentId: record['deploymentId'],
    runId: record['runId'],
    attemptId: record['attemptId'],
    nodeId: record['nodeId'],
    executionClass: record['executionClass'],
    action: record['action'],
    inputCommitments: sortedCopy(record['inputCommitments']),
    outputCommitments: sortedCopy(record['outputCommitments']),
    observationCommitments: sortedCopy(record['observationCommitments']),
    evidenceReferences: sortedCopy(record['evidenceReferences']),
    causalParents: sortedCopy(record['causalParents']),
    nonce: record['nonce'],
    epoch: record['epoch'],
    outcome: record['outcome'],
    executedAt: record['executedAt'],
  };
  for (const optional of OPTIONAL_STATEMENT_KEYS) {
    if (record[optional] !== undefined) {
      result[optional] = record[optional];
    }
  }
  return result;
}

function sortedCopy(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return [...value].sort(compareCanonical);
}

function compareCanonical(a: unknown, b: unknown): number {
  const aKey = canonicalJsonStringify(a);
  const bKey = canonicalJsonStringify(b);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

/**
 * The canonical JSON text of a VALIDATED statement (deterministic; unknown
 * fields are structurally impossible after validation).
 */
export function canonicalStatementJson(statement: ExecutionStatement): string {
  assertValidStatement(statement);
  return canonicalJsonStringify(canonicalStatementProjection(statement));
}

/**
 * The pure digest of a statement object WITHOUT validation (the internal
 * consistency primitive — used by the verification pipeline's digest check,
 * which must recompute even over envelopes a buggy signer produced).
 *
 * Preimage: `{domain, statement}` — the domain label provides domain
 * separation; the canonical statement projection carries its own objectType
 * and schema version.
 */
export function digestOfStatementObject(statement: unknown): Sha256Hex {
  const preimage = {
    domain: EXECUTION_STATEMENT_OBJECT_TYPE,
    statement: canonicalStatementProjection(statement),
  };
  return createHash('sha256').update(canonicalJsonStringify(preimage), 'utf8').digest('hex');
}

/**
 * The domain-separated ExecutionDigest (registry digest rule,
 * executionDomain `workflowos/execution-statement/v1`). Deterministic: the
 * same semantic statement → the same digest, independent of key order and
 * set-member order. NOT the WorkflowVersion semantic digest.
 */
export function computeExecutionDigest(statement: ExecutionStatement): ExecutionDigestValue {
  assertValidStatement(statement);
  return {
    algorithm: 'sha-256',
    domain: EXECUTION_STATEMENT_OBJECT_TYPE,
    digest: digestOfStatementObject(statement),
  };
}
