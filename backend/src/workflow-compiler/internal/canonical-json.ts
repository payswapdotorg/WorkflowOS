/**
 * V2-007 — canonical JSON serialization (module-internal).
 *
 * Follows the registry's "Canonical identity and digest rules": UTF-8 JSON
 * text with deterministic object-key ordering (lexicographic), no
 * insignificant whitespace, `−0 → 0` primitive normalization, non-JSON
 * values rejected. Mirrors the merged V2-003 canonical-JSON discipline; the
 * helper is deliberately module-internal (the V2-002 finding about
 * consolidating canonical-JSON helpers is left to IG-001).
 */
import { WorkflowCompilerError } from '../types.js';

/**
 * Serialize a JSON-shaped value to canonical JSON text. Throws
 * `WorkflowCompilerError('WORKFLOW_COMPILER_ARTIFACT_INVALID')` for values
 * that are not JSON data (defensive — validated artifacts never hit this).
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
      throw new WorkflowCompilerError(
        'WORKFLOW_COMPILER_ARTIFACT_INVALID',
        `value of type ${typeof value} is not JSON data and cannot be canonically serialized`,
      );
  }
}

function writeCanonicalNumber(value: number, out: string[]): void {
  if (!Number.isFinite(value)) {
    throw new WorkflowCompilerError(
      'WORKFLOW_COMPILER_ARTIFACT_INVALID',
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

/** Whether a value is a plain JSON object (not an array, not null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is JSON data (numbers must be finite). */
export function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      if (Array.isArray(value)) return value.every(isJsonValue);
      if (!isPlainObject(value)) return false;
      return Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}
