/**
 * V2-003 — the port type system: assignability, literal type inference.
 *
 * Soundness rules (all enforced, none silently coerced):
 *   - `secret` is a ONE-WAY opaque handle type: a secret is assignable ONLY
 *     to `secret`, and ONLY a secret is assignable to `secret` (a secret can
 *     never widen to json/string/… and json/… can never masquerade as a
 *     secret handle);
 *   - every non-secret type is assignable to `json`; `json` is assignable
 *     only to `json` (no unprovable downcast);
 *   - objects are structurally checked: the SOURCE must provide every
 *     REQUIRED target field (with assignable types); optional target fields
 *     may be absent; a source field marked optional can never satisfy a
 *     required target field;
 *   - arrays are element-checked.
 */
import type { JsonValue, PortType } from '../types.js';

/** Is a value of `source` port type safely consumable as `target`? */
export function isPortTypeAssignable(source: PortType, target: PortType): boolean {
  if (source.kind === 'secret' || target.kind === 'secret') {
    return source.kind === 'secret' && target.kind === 'secret';
  }
  if (target.kind === 'json') return true;
  if (source.kind === 'json') return false;
  if (source.kind !== target.kind) return false;
  switch (target.kind) {
    case 'object': {
      if (source.kind !== 'object') return false;
      const sourceFields = new Map(source.fields.map((field) => [field.name, field]));
      for (const targetField of target.fields) {
        const sourceField = sourceFields.get(targetField.name);
        if (sourceField === undefined) {
          if (targetField.optional) continue;
          return false;
        }
        if (sourceField.optional && !targetField.optional) return false;
        if (!isPortTypeAssignable(sourceField.type, targetField.type)) return false;
      }
      return true;
    }
    case 'array':
      return source.kind === 'array' && isPortTypeAssignable(source.element, target.element);
    default:
      return true;
  }
}

/** Infer the port type of a JSON literal (never a secret — literals are data). */
export function inferLiteralType(value: JsonValue): PortType {
  if (value === null) return { kind: 'json' };
  if (typeof value === 'string') return { kind: 'string' };
  if (typeof value === 'number') return { kind: 'number' };
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'array', element: { kind: 'json' } };
    const elementTypes = value.map((element) => inferLiteralType(element));
    const first = elementTypes[0] as PortType;
    const homogeneous = elementTypes.every((element) => portTypesEqual(element, first));
    return { kind: 'array', element: homogeneous ? first : { kind: 'json' } };
  }
  return {
    kind: 'object',
    fields: Object.keys(value)
      .sort()
      .map((key) => ({ name: key, type: inferLiteralType(value[key] as JsonValue) })),
  };
}

/** Deep structural equality of port types (order-insensitive on fields). */
export function portTypesEqual(a: PortType, b: PortType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'object':
      if (b.kind !== 'object') return false;
      return fieldsEqual(a.fields, b.fields);
    case 'array':
      return b.kind === 'array' && portTypesEqual(a.element, b.element);
    default:
      return true;
  }
}

function fieldsEqual(
  a: ReadonlyArray<{ name: string; type: PortType; optional?: boolean }>,
  b: ReadonlyArray<{ name: string; type: PortType; optional?: boolean }>,
): boolean {
  if (a.length !== b.length) return false;
  const byName = new Map(b.map((field) => [field.name, field]));
  for (const field of a) {
    const other = byName.get(field.name);
    if (!other) return false;
    if ((field.optional ?? false) !== (other.optional ?? false)) return false;
    if (!portTypesEqual(field.type, other.type)) return false;
  }
  return true;
}

/** Human-readable rendering for validation messages. */
export function describePortType(type: PortType): string {
  switch (type.kind) {
    case 'object':
      return `object{${type.fields
        .map((field) => `${field.name}${field.optional ? '?' : ''}:${describePortType(field.type)}`)
        .join(',')}}`;
    case 'array':
      return `array<${describePortType(type.element)}>`;
    default:
      return type.kind;
  }
}
