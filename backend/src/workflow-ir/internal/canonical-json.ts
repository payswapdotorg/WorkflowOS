/**
 * V2-003 — canonical JSON serialization (the registry's "Canonical identity
 * and digest rules").
 *
 * Canonical JSON = UTF-8 JSON text with:
 *   - deterministic object-key ordering (lexicographic by UTF-16 code unit);
 *   - deterministic array ordering WHERE THE OWNING SCHEMA DECLARES SETS —
 *     set-sorting is applied by the semantic normalizer (semantic.ts /
 *     serialize.ts), not here;
 *   - NO insignificant whitespace;
 *   - normalized primitive representations defined by this schema: −0 → 0;
 *     non-finite numbers / undefined / functions are rejected (they are not
 *     JSON values and never enter canonical bytes);
 *   - `undefined` object members are treated as absent.
 */
import { WorkflowIrError } from '../types.js';

/**
 * Serialize a JSON-shaped value to canonical JSON text. Throws
 * `WorkflowIrError('WORKFLOW_IR_CANONICAL_VALUE_NOT_JSON')` for values that
 * are not JSON data (defensive — validated documents never hit this).
 */
export function canonicalJsonStringify(value: unknown): string {
  const parts: string[] = [];
  writeCanonical(value, parts);
  return parts.join('');
}

function writeCanonical(value: unknown, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      writeCanonicalNumber(value, out);
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'object':
      if (Array.isArray(value)) {
        out.push('[');
        for (let i = 0; i < value.length; i += 1) {
          if (i > 0) out.push(',');
          writeCanonical(value[i], out);
        }
        out.push(']');
        return;
      }
      writeCanonicalObject(value as Record<string, unknown>, out);
      return;
    default:
      throw new WorkflowIrError(
        'WORKFLOW_IR_CANONICAL_VALUE_NOT_JSON',
        `value of type ${typeof value} is not JSON data and cannot be canonically serialized`,
      );
  }
}

function writeCanonicalNumber(value: number, out: string[]): void {
  if (!Number.isFinite(value)) {
    throw new WorkflowIrError(
      'WORKFLOW_IR_CANONICAL_VALUE_NOT_JSON',
      `non-finite number ${String(value)} is not JSON data`,
    );
  }
  // primitive normalization: -0 → 0
  const normalized = value === 0 ? 0 : value;
  out.push(String(normalized));
}

function writeCanonicalObject(value: Record<string, unknown>, out: string[]): void {
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  out.push('{');
  let first = true;
  for (const key of keys) {
    if (!first) out.push(',');
    first = false;
    out.push(JSON.stringify(key), ':');
    writeCanonical(value[key], out);
  }
  out.push('}');
}
