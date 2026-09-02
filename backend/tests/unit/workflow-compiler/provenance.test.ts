import { describe, it, expect } from 'vitest';
import {
  compileWorkflow,
  serializeCompiledWorkflowArtifact,
  computeCompiledWorkflowDigest,
  WORKFLOW_COMPILER_ID,
  WORKFLOW_COMPILER_VERSION,
  COMPILED_WORKFLOW_OBJECT_TYPE,
} from '../../../src/workflow-compiler/index.js';
import {
  buildTriageDocument,
  buildGeneratedSourceDocument,
  withProvenance,
} from './helpers.js';
import type { CompiledWorkflowArtifact } from '../../../src/workflow-compiler/index.js';

/**
 * V2-007 — provenance preservation battery.
 *
 * The compiled artifact carries a provenance block that records: the compiler
 * identity + version, the source WorkflowIR semantic digest (the immutable
 * WorkflowVersion binding), the compile-options digest, the source origin and
 * source references, and the artifact's own deterministic digest.
 *
 * GENERATED INTENT IS NOT PROOF OF EXECUTION (issue #120 hard rule): a
 * model-generated source (IR provenance origin `compiled`) compiles to an
 * artifact that carries ZERO execution/proof claims — the artifact shape is
 * identical to the authored-source artifact and structurally contains no
 * execution-status fields. Compilation is a semantic transformation, never an
 * execution event.
 */

const AUTHORED = buildTriageDocument();
const GENERATED = buildGeneratedSourceDocument();

function okArtifact(document: Parameters<typeof compileWorkflow>[0]): CompiledWorkflowArtifact {
  const result = compileWorkflow(document);
  if (!result.ok) {
    throw new Error(`fixture must compile: ${result.diagnostics.map((d) => d.message).join('; ')}`);
  }
  return result.artifact;
}

/** The complete closed key set a compiled artifact may expose (no smuggling). */
const ARTIFACT_KEYS = ['artifactDigest', 'objectType', 'plan', 'provenance'] as const;
const PROVENANCE_KEYS = ['compiler', 'optionsDigest', 'source'] as const;
const SOURCE_PROVENANCE_KEYS = [
  'digestAlgorithm',
  'digestDomain',
  'irSchemaVersion',
  'objectType',
  'origin',
  'semanticDigest',
] as const;
const UNIT_KEYS = [
  'capabilityRequirements',
  'completionEvidence',
  'executionClass',
  'failurePolicy',
  'inputs',
  'onFailure',
  'onOutcomes',
  'onSuccess',
  'outputs',
  'placement',
  'spec',
  'unit',
] as const;

describe('V2-007 — the provenance block records compiler + source + options identity', () => {
  it('records the compiler identity and version', () => {
    const provenance = okArtifact(AUTHORED).provenance;
    expect(provenance.compiler.id).toBe(WORKFLOW_COMPILER_ID);
    expect(provenance.compiler.version).toBe(WORKFLOW_COMPILER_VERSION);
  });

  it('records the source object type, schema version, digest algorithm and domain', () => {
    const source = okArtifact(AUTHORED).provenance.source;
    expect(source.objectType).toBe('workflowos/workflow-ir/v1');
    expect(source.irSchemaVersion).toBe(1);
    expect(source.digestAlgorithm).toBe('sha-256');
    expect(source.digestDomain).toBe('workflowos/workflow-ir/v1');
  });

  it('records the authored source origin', () => {
    expect(okArtifact(AUTHORED).provenance.source.origin).toBe('authored');
  });

  it('carries the sourceRefs when the source declares them', () => {
    const provenance = okArtifact(GENERATED).provenance.source;
    expect(provenance.sourceRefs).toEqual(['model-session:v0-neutral-planner:run-42']);
  });

  it('omits sourceRefs entirely when the source declares none (deterministic omission)', () => {
    const source = okArtifact(AUTHORED).provenance.source as unknown as Record<string, unknown>;
    expect(source['sourceRefs']).toBeUndefined();
  });

  it('records a compile-options digest commitment (sha-256 hex)', () => {
    const provenance = okArtifact(AUTHORED).provenance;
    expect(provenance.optionsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the artifact declares its object type and embeds its own digest', () => {
    const artifact = okArtifact(AUTHORED);
    expect(artifact.objectType).toBe(COMPILED_WORKFLOW_OBJECT_TYPE);
    expect(artifact.artifactDigest).toBe(computeCompiledWorkflowDigest(artifact).digest);
  });
});

describe('V2-007 — provenance preservation across origins (authored vs generated)', () => {
  it('a model-generated source records origin `compiled` (authored-vs-generated is preserved)', () => {
    const source = okArtifact(GENERATED).provenance.source;
    expect(source.origin).toBe('compiled');
  });

  it('an imported source records origin `imported`', () => {
    const imported = okArtifact(withProvenance(AUTHORED, { origin: 'imported' }));
    expect(imported.provenance.source.origin).toBe('imported');
  });

  it('the origin is part of artifact identity (authored vs generated differ)', () => {
    const authored = okArtifact(AUTHORED);
    const generated = okArtifact(GENERATED);
    expect(generated.artifactDigest).not.toBe(authored.artifactDigest);
    expect(generated.provenance.source.semanticDigest).not.toBe(
      authored.provenance.source.semanticDigest,
    );
  });
});

describe('V2-007 — GENERATED INTENT IS NOT PROOF OF EXECUTION (pinned)', () => {
  // The hard rule from issue #120 and constitution §7: a model-generated plan
  // is intent. Compiling it produces an executable plan — it does NOT execute
  // anything, and the artifact carries no execution/proof claims. This test
  // pins that rule structurally, so an accidental execution-claim field can
  // never silently appear on the compiled artifact.
  it('the generated-source artifact exposes exactly the same closed key set as the authored one', () => {
    const authoredKeys = Object.keys(okArtifact(AUTHORED)).sort();
    const generatedKeys = Object.keys(okArtifact(GENERATED)).sort();
    expect(authoredKeys).toEqual([...ARTIFACT_KEYS]);
    expect(generatedKeys).toEqual([...ARTIFACT_KEYS]);
  });

  it('every compiled unit exposes a closed key set with NO execution-status fields', () => {
    for (const unit of okArtifact(GENERATED).plan.units) {
      const expected = [...UNIT_KEYS].filter(
        (key) => key !== 'completionEvidence' || unit.completionEvidence !== undefined,
      );
      expect(Object.keys(unit).sort()).toEqual(expected.sort());
    }
  });

  it('the provenance block exposes a closed key set with no execution/proof fields', () => {
    const provenance = okArtifact(GENERATED).provenance as unknown as Record<string, unknown>;
    expect(Object.keys(provenance).sort()).toEqual([...PROVENANCE_KEYS]);
    const source = provenance['source'] as Record<string, unknown>;
    const expectedSourceKeys = [...SOURCE_PROVENANCE_KEYS, 'sourceRefs'];
    expect(Object.keys(source).sort()).toEqual(expectedSourceKeys.sort());
  });

  it('the serialized generated-source artifact contains no execution-claim vocabulary', () => {
    const bytes = serializeCompiledWorkflowArtifact(okArtifact(GENERATED));
    expect(bytes).not.toMatch(/"executed"/i);
    expect(bytes).not.toMatch(/"completedAt"/i);
    expect(bytes).not.toMatch(/"startedAt"/i);
    expect(bytes).not.toMatch(/"runId"/i);
    expect(bytes).not.toMatch(/"status"\s*:/i);
    expect(bytes).not.toMatch(/attestation/i);
    expect(bytes).not.toMatch(/proof/i);
  });

  it('the serialized authored-source artifact equally contains no execution-claim vocabulary', () => {
    const bytes = serializeCompiledWorkflowArtifact(okArtifact(AUTHORED));
    expect(bytes).not.toMatch(/"executed"/i);
    expect(bytes).not.toMatch(/"runId"/i);
    expect(bytes).not.toMatch(/"status"\s*:/i);
    expect(bytes).not.toMatch(/attestation/i);
  });
});

describe('V2-007 — inspectability: the artifact is a readable, structured plan', () => {
  it('the plan exposes entry, units, workflow inputs/outputs and default placement', () => {
    const plan = okArtifact(AUTHORED).plan;
    expect(plan.entry).toBe('fetch_issue');
    expect(plan.units.length).toBe(6);
    expect(plan.inputs.map((input) => input.name).sort()).toEqual(['channel', 'issueUrl']);
    expect(plan.outputs.map((output) => output.name).sort()).toEqual(['messageId', 'summary']);
    expect(plan.defaultPlacement).toBe('any_supported_node');
  });

  it('every source node is compiled to exactly one unit, keyed by its node id', () => {
    const artifact = okArtifact(AUTHORED);
    const unitIds = artifact.plan.units.map((unit) => unit.unit).sort();
    const nodeIds = AUTHORED.ir.nodes.map((node) => node.id).sort();
    expect(unitIds).toEqual(nodeIds);
  });

  it('a human pause point is compiled with its outcome successors, not success edges', () => {
    const gate = okArtifact(AUTHORED).plan.units.find((unit) => unit.unit === 'review_gate');
    expect(gate).toBeDefined();
    expect(gate?.onSuccess).toEqual([]);
    expect(gate?.onFailure).toBeNull();
    // the two `approved` continuation edges fan out to two distinct units;
    // the DECLARED outcomes covered by the flattening are approved/rejected
    const coveredOutcomes = gate ? [...new Set(gate.onOutcomes.map((o) => o.outcome))] : [];
    expect(coveredOutcomes.sort()).toEqual(['approved', 'rejected']);
    expect(gate?.onOutcomes.length).toBe(3);
  });
});
