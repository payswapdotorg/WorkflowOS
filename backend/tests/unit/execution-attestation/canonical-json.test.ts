import { describe, it, expect } from 'vitest';
import { canonicalJsonStringify } from '../../../src/execution-attestation/index.js';
import { ExecutionAttestationError } from '../../../src/execution-attestation/index.js';

/**
 * V2-014 — canonical JSON discipline (registry §"Canonical identity and digest
 * rules"): UTF-8 JSON, deterministic object-key ordering, no insignificant
 * whitespace, normalized primitive representations, `undefined` members
 * treated as absent, non-JSON values rejected (typed, fail-closed).
 */

describe('V2-014 canonical JSON', () => {
  it('orders object keys lexicographically and emits no whitespace', () => {
    const value = { b: 1, a: 2, c: { z: true, y: null, x: 's' } };
    expect(canonicalJsonStringify(value)).toBe('{"a":2,"b":1,"c":{"x":"s","y":null,"z":true}}');
  });

  it('is deterministic regardless of key insertion order', () => {
    const a = { z: 1, y: 2, x: { deep: { q: 'r', p: [3, 2, 1] } } };
    const b = { x: { deep: { p: [3, 2, 1], q: 'r' } }, y: 2, z: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('preserves array order (the owning schema declares set semantics)', () => {
    expect(canonicalJsonStringify(['b', 'a', 'c'])).toBe('["b","a","c"]');
    expect(canonicalJsonStringify(['c', 'a', 'b'])).toBe('["c","a","b"]');
  });

  it('normalizes -0 to 0', () => {
    expect(canonicalJsonStringify({ n: -0 })).toBe('{"n":0}');
    expect(canonicalJsonStringify(0)).toBe('0');
  });

  it('treats undefined object members as absent', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('rejects non-finite numbers with the typed canonical error', () => {
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(ExecutionAttestationError);
    expect(() => canonicalJsonStringify({ x: Number.NaN })).toThrowError(/not JSON data/);
  });

  it('rejects functions and symbols with the typed canonical error', () => {
    expect(() => canonicalJsonStringify(() => 1)).toThrow(ExecutionAttestationError);
    expect(() => canonicalJsonStringify(Symbol('x'))).toThrow(ExecutionAttestationError);
  });

  it('serializes strings with standard JSON escaping', () => {
    expect(canonicalJsonStringify('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it('serializes nested arrays and objects recursively', () => {
    expect(canonicalJsonStringify([{ b: 1 }, [2, { a: 3 }]])).toBe('[{"b":1},[2,{"a":3}]]');
  });
});
