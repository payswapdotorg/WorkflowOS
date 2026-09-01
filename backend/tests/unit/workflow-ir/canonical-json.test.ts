import { describe, it, expect } from 'vitest';
import {
  computeWorkflowVersionSemanticDigest,
  serializeWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import { buildMinimalDocument, withNodeInputs, clone } from './helpers.js';

/**
 * V2-003 — canonical JSON primitive normalization (the registry's
 * "normalized primitive representations defined by the owning schema").
 *
 * The IR schema defines: UTF-8 JSON, lexicographically sorted object keys,
 * no insignificant whitespace, −0 normalized to 0, no NaN/Infinity, and
 * `undefined` treated as absent (never serialized).
 */

describe('V2-003 — primitive normalization inside the canonical serializer', () => {
  it('−0 and 0 serialize identically (negative zero is not semantic)', () => {
    const negativeZero = withNodeInputs(buildMinimalDocument(), 'observe', [
      {
        name: 'url',
        type: { kind: 'number' },
        binding: { kind: 'literal', value: -0 },
      },
    ]);
    const positiveZero = withNodeInputs(buildMinimalDocument(), 'observe', [
      {
        name: 'url',
        type: { kind: 'number' },
        binding: { kind: 'literal', value: 0 },
      },
    ]);
    expect(serializeWorkflowIrDocument(negativeZero)).toBe(
      serializeWorkflowIrDocument(positiveZero),
    );
    expect(computeWorkflowVersionSemanticDigest(negativeZero).digest).toBe(
      computeWorkflowVersionSemanticDigest(positiveZero).digest,
    );
  });

  it('distinct numbers serialize distinctly', () => {
    const one = withNodeInputs(buildMinimalDocument(), 'observe', [
      { name: 'url', type: { kind: 'number' }, binding: { kind: 'literal', value: 1 } },
    ]);
    const two = withNodeInputs(buildMinimalDocument(), 'observe', [
      { name: 'url', type: { kind: 'number' }, binding: { kind: 'literal', value: 2 } },
    ]);
    expect(serializeWorkflowIrDocument(one)).not.toBe(serializeWorkflowIrDocument(two));
  });

  it('nested object literal keys are canonically sorted', () => {
    const docA = withNodeInputs(buildMinimalDocument(), 'observe', [
      {
        name: 'url',
        type: { kind: 'json' },
        binding: { kind: 'literal', value: { z: 1, a: 2, m: { y: 1, b: 2 } } },
      },
    ]);
    const docB = withNodeInputs(buildMinimalDocument(), 'observe', [
      {
        name: 'url',
        type: { kind: 'json' },
        binding: { kind: 'literal', value: { a: 2, z: 1, m: { b: 2, y: 1 } } },
      },
    ]);
    expect(serializeWorkflowIrDocument(docA)).toBe(serializeWorkflowIrDocument(docB));
  });

  it('an explicitly-undefined optional field is identical to an absent field', () => {
    const explicit = clone(buildMinimalDocument());
    const absent = clone(buildMinimalDocument());
    explicit.ir.inputs = [{ name: 'sourceUrl', type: { kind: 'string' }, optional: undefined }];
    absent.ir.inputs = [{ name: 'sourceUrl', type: { kind: 'string' } }];
    expect(serializeWorkflowIrDocument(explicit)).toBe(serializeWorkflowIrDocument(absent));
  });
});
