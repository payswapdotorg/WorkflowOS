import { describe, it, expect } from 'vitest';
import {
  computeWorkflowVersionSemanticDigest,
  negotiateIrSchemaVersion,
  negotiateWorkflowVersionUpdate,
  semanticallyEqual,
} from '../../../src/workflow-ir/index.js';
import type {
  PortDeclaration,
  WorkflowOutputBinding,
  WorkflowSurfaceSnapshot,
} from '../../../src/workflow-ir/index.js';
import {
  buildMinimalDocument,
  buildTriageDocument,
  buildTriageDocumentAltOrder,
  clone,
} from './helpers.js';

/**
 * V2-003 — compatibility and version negotiation.
 *
 * Deterministic accept/upgrade/reject decisions:
 *   1. between IR SCHEMA versions (consumer vs offered artifact), using the
 *      declared upgrade-path metadata;
 *   2. between WORKFLOW versions, using the declared version-affecting
 *      compatibility metadata cross-checked against the computed public
 *      surface diff.
 */

const stringInput = { name: 'sourceUrl', type: { kind: 'string' } } as const;
const stringOutput = {
  name: 'text',
  type: { kind: 'string' },
  from: { kind: 'node_output', node: 'observe', output: 'pageText' },
} as const;

const equivalent = {
  compatibilityLevel: 'equivalent',
  inputSurfaceChange: 'none',
  outputSurfaceChange: 'none',
} as const;

const compatibleAdditive = {
  compatibilityLevel: 'compatible',
  inputSurfaceChange: 'additive',
  outputSurfaceChange: 'none',
} as const;

const incompatibleBreaking = {
  compatibilityLevel: 'incompatible',
  inputSurfaceChange: 'breaking',
  outputSurfaceChange: 'none',
} as const;

function surface(
  inputs: readonly PortDeclaration[],
  outputs: readonly WorkflowOutputBinding[],
  compatibility: WorkflowSurfaceSnapshot['compatibility'],
): WorkflowSurfaceSnapshot {
  return { inputs: clone(inputs), outputs: clone(outputs), compatibility };
}

describe('V2-003 — IR schema version negotiation', () => {
  it('accepts an offered schema version the consumer supports', () => {
    const result = negotiateIrSchemaVersion(
      { supportedIrSchemaVersions: [1] },
      { irSchemaVersion: 1 },
    );
    expect(result.decision).toBe('accept');
    if (result.decision === 'accept') expect(result.irSchemaVersion).toBe(1);
  });

  it('rejects a NEWER schema version (fail closed — the consumer cannot interpret it)', () => {
    const result = negotiateIrSchemaVersion(
      { supportedIrSchemaVersions: [1] },
      { irSchemaVersion: 2 },
    );
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') expect(result.reason).toBe('schema-too-new');
  });

  it('rejects an OLDER schema version when no upgrade path is declared', () => {
    const result = negotiateIrSchemaVersion(
      { supportedIrSchemaVersions: [1] },
      { irSchemaVersion: 0 },
    );
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') expect(result.reason).toBe('no-upgrade-path');
  });

  it('upgrades an older schema version when a safe migration path is declared', () => {
    const result = negotiateIrSchemaVersion(
      { supportedIrSchemaVersions: [1] },
      { irSchemaVersion: 0 },
      [
        {
          from: 0,
          to: 1,
          upgradeSafe: true,
          description: 'test-only hypothetical 0→1 path',
        },
      ],
    );
    expect(result.decision).toBe('upgrade');
    if (result.decision === 'upgrade') {
      expect(result.from).toBe(0);
      expect(result.to).toBe(1);
    }
  });

  it('never upgrades through an unsafe migration', () => {
    const result = negotiateIrSchemaVersion(
      { supportedIrSchemaVersions: [1] },
      { irSchemaVersion: 0 },
      [{ from: 0, to: 1, upgradeSafe: false, description: 'unsafe path' }],
    );
    expect(result.decision).toBe('reject');
  });

  it('a consumer with an empty supported set fails closed', () => {
    const result = negotiateIrSchemaVersion(
      { supportedIrSchemaVersions: [] },
      { irSchemaVersion: 1 },
    );
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') expect(result.reason).toBe('no-supported-versions');
  });

  it('is deterministic: identical inputs always yield the identical decision object', () => {
    for (const offered of [0, 1, 2, 7]) {
      const a = negotiateIrSchemaVersion({ supportedIrSchemaVersions: [1, 2] }, { irSchemaVersion: offered });
      const b = negotiateIrSchemaVersion({ supportedIrSchemaVersions: [1, 2] }, { irSchemaVersion: offered });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe('V2-003 — workflow version update negotiation (declared compatibility metadata)', () => {
  const installed = surface([stringInput], [stringOutput], equivalent);

  it('accepts a candidate with an unchanged public surface and an equivalent declaration', () => {
    const result = negotiateWorkflowVersionUpdate({
      installed,
      candidate: surface([stringInput], [stringOutput], equivalent),
    });
    expect(result.decision).toBe('accept');
  });

  it('upgrades to a compatible candidate that ADDS an optional input (additive-only change)', () => {
    const result = negotiateWorkflowVersionUpdate({
      installed,
      candidate: surface(
        [stringInput, { name: 'priority', type: { kind: 'string' }, optional: true }],
        [stringOutput],
        compatibleAdditive,
      ),
    });
    expect(result.decision).toBe('upgrade');
  });

  it('upgrades to a compatible candidate that ADDS an output', () => {
    const result = negotiateWorkflowVersionUpdate({
      installed,
      candidate: surface(
        [stringInput],
        [
          stringOutput,
          {
            name: 'extra',
            type: { kind: 'string' },
            from: { kind: 'node_output', node: 'observe', output: 'pageText' },
          },
        ],
        { compatibilityLevel: 'compatible', inputSurfaceChange: 'none', outputSurfaceChange: 'additive' },
      ),
    });
    expect(result.decision).toBe('upgrade');
  });

  it('rejects a breaking change (a new REQUIRED input) even when declared compatible', () => {
    const result = negotiateWorkflowVersionUpdate({
      installed,
      candidate: surface(
        [stringInput, { name: 'mandatory', type: { kind: 'string' } }],
        [stringOutput],
        compatibleAdditive,
      ),
    });
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') {
      expect(result.reason).toBe('compatibility-declaration-inconsistent');
    }
  });

  it('rejects an honestly-declared incompatible/breaking candidate', () => {
    const result = negotiateWorkflowVersionUpdate({
      installed,
      candidate: surface(
        [{ name: 'differentInput', type: { kind: 'string' } }],
        [stringOutput],
        incompatibleBreaking,
      ),
    });
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') expect(result.reason).toBe('breaking-change');
  });

  it('rejects an inconsistent declaration: claims equivalent but REMOVED an output', () => {
    const result = negotiateWorkflowVersionUpdate({
      installed,
      candidate: surface([stringInput], [], equivalent),
    });
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') {
      expect(result.reason).toBe('compatibility-declaration-inconsistent');
    }
  });

  it('rejects an inconsistent declaration: claims equivalent but changed an input type', () => {
    const result = negotiateWorkflowVersionUpdate({
      installed,
      candidate: surface(
        [{ name: 'sourceUrl', type: { kind: 'number' } }],
        [stringOutput],
        equivalent,
      ),
    });
    expect(result.decision).toBe('reject');
    if (result.decision === 'reject') {
      expect(result.reason).toBe('compatibility-declaration-inconsistent');
    }
  });

  it('accepts an input type WIDENING (old values still valid) when declared compatible/additive', () => {
    const result = negotiateWorkflowVersionUpdate({
      installed: surface([{ name: 'count', type: { kind: 'number' } }], [], equivalent),
      candidate: surface(
        [{ name: 'count', type: { kind: 'json' } }],
        [],
        { compatibilityLevel: 'compatible', inputSurfaceChange: 'additive', outputSurfaceChange: 'none' },
      ),
    });
    expect(result.decision).toBe('upgrade');
  });

  it('is deterministic across repeated evaluation', () => {
    const input = {
      installed,
      candidate: surface([stringInput], [stringOutput], compatibleAdditive),
    };
    expect(JSON.stringify(negotiateWorkflowVersionUpdate(input))).toBe(
      JSON.stringify(negotiateWorkflowVersionUpdate(input)),
    );
  });
});

describe('V2-003 — semantic equality across construction paths', () => {
  it('two semantically identical documents are equal regardless of ordering', () => {
    expect(semanticallyEqual(buildTriageDocument(), buildTriageDocumentAltOrder())).toBe(true);
  });

  it('presentation differences do not break semantic equality', () => {
    const a = buildTriageDocument();
    const b = clone(a);
    b.presentation = {
      title: 'A totally different title',
      nodeLabels: { fetch_issue: 'Whatever' },
    };
    expect(semanticallyEqual(a, b)).toBe(true);
  });

  it('a semantic difference breaks semantic equality', () => {
    const a = buildTriageDocument();
    const b = clone(a);
    b.ir.edges = b.ir.edges.filter(
      (edge) => !(edge.from === 'review_gate' && edge.to === 'log_rejection'),
    );
    expect(semanticallyEqual(a, b)).toBe(false);
  });

  it('a compatibility-metadata difference breaks semantic equality (version-affecting)', () => {
    const a = buildMinimalDocument();
    const b = clone(a);
    b.compatibility = {
      compatibilityLevel: 'compatible',
      inputSurfaceChange: 'additive',
      outputSurfaceChange: 'none',
    };
    expect(semanticallyEqual(a, b)).toBe(false);
  });

  it('semantic equality agrees with digest equality on these fixtures', () => {
    const a = buildTriageDocument();
    const alt = buildTriageDocumentAltOrder();
    expect(semanticallyEqual(a, alt)).toBe(
      computeWorkflowVersionSemanticDigest(a).digest === computeWorkflowVersionSemanticDigest(alt).digest,
    );
  });
});
