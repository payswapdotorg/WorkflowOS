import { describe, it, expect } from 'vitest';
import { isPortTypeAssignable, validateWorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import type { PortType } from '../../../src/workflow-ir/index.js';
import {
  buildTriageDocument,
  withNode,
  withNodeInputs,
  withWorkflowOutputs,
} from './helpers.js';

/**
 * V2-003 — typed data binding rejection battery.
 *
 * A data binding between an output port and an input port must be type
 * sound. Structurally unsound graphs are rejected, never silently coerced.
 */

describe('V2-003 — the port type assignability relation', () => {
  const cases: Array<{ source: PortType; target: PortType; assignable: boolean; why: string }> = [
    { source: { kind: 'string' }, target: { kind: 'string' }, assignable: true, why: 'identity' },
    { source: { kind: 'number' }, target: { kind: 'number' }, assignable: true, why: 'identity' },
    { source: { kind: 'string' }, target: { kind: 'number' }, assignable: false, why: 'primitive mismatch' },
    { source: { kind: 'boolean' }, target: { kind: 'string' }, assignable: false, why: 'primitive mismatch' },
    { source: { kind: 'string' }, target: { kind: 'json' }, assignable: true, why: 'any typed value is json' },
    { source: { kind: 'json' }, target: { kind: 'string' }, assignable: false, why: 'json cannot prove string' },
    { source: { kind: 'json' }, target: { kind: 'json' }, assignable: true, why: 'identity' },
    {
      source: { kind: 'secret' },
      target: { kind: 'json' },
      assignable: false,
      why: 'a secret handle can never widen to json (leak prevention)',
    },
    {
      source: { kind: 'secret' },
      target: { kind: 'string' },
      assignable: false,
      why: 'a secret handle is never a string (leak prevention)',
    },
    {
      source: { kind: 'json' },
      target: { kind: 'secret' },
      assignable: false,
      why: 'json can never masquerade as a secret handle',
    },
    {
      source: { kind: 'secret' },
      target: { kind: 'secret' },
      assignable: true,
      why: 'identity',
    },
    {
      source: {
        kind: 'object',
        fields: [
          { name: 'title', type: { kind: 'string' } },
          { name: 'body', type: { kind: 'string' } },
        ],
      },
      target: {
        kind: 'object',
        fields: [
          { name: 'title', type: { kind: 'string' } },
          { name: 'body', type: { kind: 'string' } },
          { name: 'labels', type: { kind: 'array', element: { kind: 'string' } }, optional: true },
        ],
      },
      assignable: true,
      why: 'object structural: target optional field may be absent',
    },
    {
      source: {
        kind: 'object',
        fields: [
          { name: 'title', type: { kind: 'string' } },
          { name: 'body', type: { kind: 'string' } },
        ],
      },
      target: {
        kind: 'object',
        fields: [{ name: 'title', type: { kind: 'string' } }],
      },
      assignable: true,
      why: 'object structural: source extra fields are fine',
    },
    {
      source: {
        kind: 'object',
        fields: [{ name: 'title', type: { kind: 'string' } }],
      },
      target: {
        kind: 'object',
        fields: [
          { name: 'title', type: { kind: 'string' } },
          { name: 'body', type: { kind: 'string' } },
        ],
      },
      assignable: false,
      why: 'object structural: source misses a required field',
    },
    {
      source: {
        kind: 'object',
        fields: [{ name: 'title', type: { kind: 'number' } }],
      },
      target: {
        kind: 'object',
        fields: [{ name: 'title', type: { kind: 'string' } }],
      },
      assignable: false,
      why: 'object structural: field type mismatch',
    },
    {
      source: { kind: 'array', element: { kind: 'string' } },
      target: { kind: 'array', element: { kind: 'number' } },
      assignable: false,
      why: 'array element mismatch',
    },
    {
      source: { kind: 'array', element: { kind: 'string' } },
      target: { kind: 'array', element: { kind: 'string' } },
      assignable: true,
      why: 'array identity',
    },
  ];

  for (const { source, target, assignable, why } of cases) {
    it(`${JSON.stringify(source)} → ${JSON.stringify(target)} is ${assignable ? 'assignable' : 'NOT assignable'} (${why})`, () => {
      expect(isPortTypeAssignable(source, target)).toBe(assignable);
    });
  }

  it('is deterministic and total over the closed vocabulary', () => {
    const kinds: PortType['kind'][] = ['string', 'number', 'boolean', 'json', 'secret', 'object', 'array'];
    for (const sourceKind of kinds) {
      for (const targetKind of kinds) {
        const source = structuralTypeOf(sourceKind);
        const target = structuralTypeOf(targetKind);
        expect(typeof isPortTypeAssignable(source, target)).toBe('boolean');
        expect(isPortTypeAssignable(source, target)).toBe(isPortTypeAssignable(source, target));
      }
    }
  });
});

function structuralTypeOf(kind: PortType['kind']): PortType {
  switch (kind) {
    case 'object':
      return { kind: 'object', fields: [{ name: 'f', type: { kind: 'string' } }] };
    case 'array':
      return { kind: 'array', element: { kind: 'string' } };
    default:
      return { kind } as PortType;
  }
}

describe('V2-003 — typed binding rejection inside a real graph', () => {
  it('a string output bound to a number input is rejected', () => {
    const doc = withNodeInputs(buildTriageDocument(), 'sync_backlog', [
      {
        name: 'summary',
        type: { kind: 'number' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_BINDING_TYPE_MISMATCH')).toBe(true);
    }
  });

  it('a literal string bound to a number input is rejected', () => {
    const doc = withNodeInputs(buildTriageDocument(), 'fetch_issue', [
      {
        name: 'repository',
        type: { kind: 'number' },
        binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' },
      },
      {
        name: 'issueUrl',
        type: { kind: 'string' },
        binding: { kind: 'workflow_input', input: 'issueUrl' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_BINDING_TYPE_MISMATCH')).toBe(true);
    }
  });

  it('an object output missing a required field of the input port type is rejected', () => {
    const doc = withNodeInputs(buildTriageDocument(), 'draft_summary', [
      {
        name: 'issue',
        type: {
          kind: 'object',
          fields: [
            { name: 'title', type: { kind: 'string' } },
            { name: 'body', type: { kind: 'string' } },
            { name: 'reporter', type: { kind: 'string' } },
          ],
        },
        binding: { kind: 'node_output', node: 'fetch_issue', output: 'issue' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_BINDING_TYPE_MISMATCH')).toBe(true);
    }
  });

  it('a json output bound to a string input is rejected (no silent downcast)', () => {
    const doc = withNodeInputs(buildTriageDocument(), 'sync_backlog', [
      {
        name: 'summary',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
    ]);
    const widened = withNode(doc, 'draft_summary', {
      outputs: [
        { name: 'summary', type: { kind: 'json' } },
        { name: 'severity', type: { kind: 'string' } },
      ],
    });
    const result = validateWorkflowIrDocument(widened);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_BINDING_TYPE_MISMATCH')).toBe(true);
    }
  });

  it('a workflow output whose type does not match its source is rejected', () => {
    const doc = withWorkflowOutputs(buildTriageDocument(), [
      {
        name: 'summary',
        type: { kind: 'number' },
        from: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_BINDING_TYPE_MISMATCH')).toBe(true);
    }
  });

  it('a required node input bound to an optional workflow input is rejected (unsound optionality)', () => {
    const doc = withNodeInputs(buildTriageDocument(), 'notify_channel', [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
      {
        name: 'channel',
        type: { kind: 'string' },
        binding: { kind: 'workflow_input', input: 'channel' },
      },
      {
        name: 'credentials',
        type: { kind: 'secret' },
        binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_BINDING_OPTIONALITY_MISMATCH')).toBe(true);
    }
  });

  it('an optional node input accepting a required workflow input is sound', () => {
    const doc = withNodeInputs(buildTriageDocument(), 'notify_channel', [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
      {
        name: 'channel',
        type: { kind: 'string' },
        optional: true,
        binding: { kind: 'workflow_input', input: 'issueUrl' },
      },
      {
        name: 'credentials',
        type: { kind: 'secret' },
        binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(true);
  });
});
