import { describe, it, expect } from 'vitest';
import {
  compileWorkflow,
  serializeCompiledWorkflowArtifact,
  parseCompiledWorkflowArtifact,
  projectCompiledPlanSemantics,
} from '../../../src/workflow-compiler/index.js';
import type { CompiledWorkflowArtifact } from '../../../src/workflow-compiler/index.js';
import {
  serializeWorkflowIrDocument,
  validateWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import {
  buildTriageDocument,
  buildTriageDocumentAltOrder,
  buildGeneratedSourceDocument,
  withEdge,
  withNode,
  withNodeCapabilityRequirements,
  withNodeFailurePolicy,
  withNodePlacement,
  withNodeInputs,
  withPresentation,
  withProvenance,
  withWorkflowOutputs,
  withWorkflowInputs,
  withDefaultPlacement,
  clone,
} from './helpers.js';

/**
 * V2-007 — semantic-equivalence preservation battery (the strongest feasible
 * equivalence check at this boundary).
 *
 * The compiled plan is projected back into the WorkflowIR's canonical
 * semantic form (`projectCompiledPlanSemantics`) — reconstructing the node
 * set, the control-edge set from the flattened per-unit successor lists, the
 * typed input/output surface, failure policies, capability requirements,
 * placements, completion disclosures and provenance — and compared for deep
 * equality against the source IR's OWN canonical semantic form produced by
 * the merged V2-003 serializer (`serializeWorkflowIrDocument` → canonical
 * set-normalized `ir`). Compilation therefore proves it changed NOTHING the
 * source version declared: it is a derived transformation, never a second
 * workflow representation and never a second authority.
 */

const AUTHORED = buildTriageDocument();

function okArtifact(document: WorkflowIrDocument): CompiledWorkflowArtifact {
  const result = compileWorkflow(document);
  if (!result.ok) {
    throw new Error(`fixture must compile: ${result.diagnostics.map((d) => d.message).join('; ')}`);
  }
  return result.artifact;
}

/** The source IR's canonical (set-normalized) semantic form, via the merged V2-003 serializer. */
function canonicalIrOf(document: WorkflowIrDocument): Record<string, unknown> {
  return (JSON.parse(serializeWorkflowIrDocument(document)) as { ir: Record<string, unknown> }).ir;
}

describe('V2-007 — the compiled plan semantics equal the source IR declared semantics', () => {
  it('the support-ticket-triage workflow: projection === canonical IR (deep equality)', () => {
    const artifact = okArtifact(AUTHORED);
    expect(projectCompiledPlanSemantics(artifact)).toEqual(canonicalIrOf(AUTHORED));
  });

  it('the model-generated source workflow: projection === canonical IR (origin preserved)', () => {
    const artifact = okArtifact(buildGeneratedSourceDocument());
    expect(projectCompiledPlanSemantics(artifact)).toEqual(canonicalIrOf(buildGeneratedSourceDocument()));
  });

  it('an independently order-scrambled authoring produces the identical projection', () => {
    const a = okArtifact(AUTHORED);
    const b = okArtifact(buildTriageDocumentAltOrder());
    expect(projectCompiledPlanSemantics(a)).toEqual(projectCompiledPlanSemantics(b));
  });

  it('presentation-only source changes keep the projection identical', () => {
    const relabeled = okArtifact(
      withPresentation(AUTHORED, { title: 'Relabeled', notes: 'presentation is not semantics' }),
    );
    expect(projectCompiledPlanSemantics(relabeled)).toEqual(projectCompiledPlanSemantics(okArtifact(AUTHORED)));
  });

  it('the projection survives artifact export/import unchanged', () => {
    const artifact = okArtifact(AUTHORED);
    const bytes = serializeCompiledWorkflowArtifact(artifact);
    const parsed = parseCompiledWorkflowArtifact(bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(projectCompiledPlanSemantics(parsed.artifact)).toEqual(canonicalIrOf(AUTHORED));
    }
  });
});

describe('V2-007 — the projection is the full declared semantic surface', () => {
  // The deep-equality check above already pins everything; these tests make
  // each dimension individually legible (inspectability of the check itself).
  const artifact = okArtifact(AUTHORED);
  const projection = projectCompiledPlanSemantics(artifact) as {
    start: string;
    nodes: Array<{ id: string; executionClass: string; capabilityRequirements: string[]; placement: string; completionEvidence?: string }>;
    edges: Array<{ from: string; to: string; on: unknown }>;
    inputs: unknown[];
    outputs: unknown[];
    defaultPlacement: string;
    provenance: { origin: string };
  };

  it('carries the step set keyed by the source node ids (one unit per node)', () => {
    const projectedIds = projection.nodes.map((node) => node.id).sort();
    const sourceIds = AUTHORED.ir.nodes.map((node) => node.id).sort();
    expect(projectedIds).toEqual(sourceIds);
  });

  it('carries the ordering semantics: the reconstructed control-edge set equals the source edge set', () => {
    const sourceEdges = [...AUTHORED.ir.edges]
      .map((edge) => JSON.stringify({ from: edge.from, to: edge.to, on: edge.on }))
      .sort();
    const projectedEdges = projection.edges.map((edge) => JSON.stringify(edge)).sort();
    expect(projectedEdges).toEqual(sourceEdges);
    // the human outcome fan-out survives flattening unambiguously
    expect(projection.edges.filter((edge) => typeof edge.on === 'object').length).toBe(3);
  });

  it('carries capability requirements, placements, execution classes and completion disclosures per step', () => {
    const fetch = projection.nodes.find((node) => node.id === 'fetch_issue');
    expect(fetch?.executionClass).toBe('deterministic_api');
    expect(fetch?.capabilityRequirements).toEqual(['github.repository.read']);
    expect(fetch?.placement).toBe('cloud_allowed');
    expect(fetch?.completionEvidence).toBe('observation');
    const gate = projection.nodes.find((node) => node.id === 'review_gate');
    expect(gate?.completionEvidence).toBe('human_confirmation');
    const draft = projection.nodes.find((node) => node.id === 'draft_summary');
    expect(draft && draft.completionEvidence === undefined).toBe(true);
  });

  it('carries the typed workflow input/output surface and default placement', () => {
    expect(projection.inputs).toHaveLength(2);
    expect(projection.outputs).toHaveLength(2);
    expect(projection.defaultPlacement).toBe('any_supported_node');
    expect(projection.start).toBe('fetch_issue');
  });

  it('carries the source provenance origin', () => {
    expect(projection.provenance.origin).toBe('authored');
  });
});

describe('V2-007 — the projection is deterministic and computed FROM the compiled plan', () => {
  it('repeated projection of the same artifact yields the identical record', () => {
    const artifact = okArtifact(AUTHORED);
    expect(projectCompiledPlanSemantics(artifact)).toEqual(projectCompiledPlanSemantics(artifact));
  });

  it('the projection is plain JSON (canonical serialization is stable)', () => {
    const artifact = okArtifact(AUTHORED);
    expect(JSON.stringify(projectCompiledPlanSemantics(artifact))).toBe(
      JSON.stringify(projectCompiledPlanSemantics(artifact)),
    );
  });

  it('mutating the ARTIFACT changes the projection (the projection reads the plan, not the source)', () => {
    const artifact = okArtifact(AUTHORED);
    const tampered = clone(artifact);
    const notify = tampered.plan.units.find((unit) => unit.unit === 'notify_channel');
    if (notify) notify.placement = 'cloud_allowed';
    expect(projectCompiledPlanSemantics(tampered)).not.toEqual(projectCompiledPlanSemantics(artifact));
  });
});

describe('V2-007 — ANY source semantic change breaks compiled/IR equivalence (discrimination)', () => {
  type Mutation = { name: string; mutate: (document: WorkflowIrDocument) => WorkflowIrDocument };

  const mutations: Mutation[] = [
    {
      name: 'an added control edge',
      mutate: (doc) => withEdge(doc, { from: 'sync_backlog', to: 'log_rejection', on: 'success' }),
    },
    {
      name: 'a changed human instruction',
      mutate: (doc) =>
        withNode(doc, 'review_gate', {
          spec: {
            class: 'human',
            human: { kind: 'approval', instruction: 'A DIFFERENT approval instruction.' },
          },
        }),
    },
    {
      name: 'a changed capability requirement',
      mutate: (doc) => withNodeCapabilityRequirements(doc, 'fetch_issue', ['github.repository.read', 'browser.observe']),
    },
    {
      name: 'a changed node placement',
      mutate: (doc) => withNodePlacement(doc, 'notify_channel', 'cloud_allowed'),
    },
    {
      name: 'a changed failure policy',
      mutate: (doc) => withNodeFailurePolicy(doc, 'sync_backlog', { strategy: 'fail_workflow' }),
    },
    {
      name: 'a changed secret reference',
      mutate: (doc) =>
        withNodeInputs(doc, 'notify_channel', [
          {
            name: 'text',
            type: { kind: 'string' },
            binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
          },
          {
            name: 'channel',
            type: { kind: 'string' },
            optional: true,
            binding: { kind: 'workflow_input', input: 'channel' },
          },
          {
            name: 'credentials',
            type: { kind: 'secret' },
            binding: { kind: 'secret_ref', ref: 'other-team@secrets' },
          },
        ]),
    },
    {
      name: 'a changed literal value',
      mutate: (doc) =>
        withNodeInputs(doc, 'log_rejection', [
          { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'other.log' } },
          {
            name: 'content',
            type: { kind: 'string' },
            binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
          },
        ]),
    },
    {
      name: 'a changed workflow input surface',
      mutate: (doc) =>
        withWorkflowInputs(doc, [
          { name: 'issueUrl', type: { kind: 'string' } },
          { name: 'channel', type: { kind: 'string' }, optional: true },
          { name: 'priority', type: { kind: 'string' }, optional: true },
        ]),
    },
    {
      name: 'a changed workflow output binding',
      mutate: (doc) =>
        withWorkflowOutputs(doc, [
          {
            name: 'summary',
            type: { kind: 'string' },
            from: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
          },
          {
            name: 'backlogRef',
            type: { kind: 'string' },
            from: { kind: 'node_output', node: 'sync_backlog', output: 'backlogRef' },
          },
        ]),
    },
    {
      name: 'a changed port type',
      mutate: (doc) =>
        withNodeInputs(doc, 'draft_summary', [
          {
            name: 'issue',
            type: { kind: 'json' },
            binding: { kind: 'node_output', node: 'fetch_issue', output: 'issue' },
          },
        ]),
    },
    {
      name: 'a changed default placement',
      mutate: (doc) => withDefaultPlacement(doc, 'cloud_allowed'),
    },
    {
      name: 'a changed provenance origin',
      mutate: (doc) => withProvenance(doc, { origin: 'compiled' }),
    },
    {
      name: 'added provenance source references',
      mutate: (doc) => withProvenance(doc, { origin: 'authored', sourceRefs: ['session-2'] }),
    },
  ];

  for (const mutation of mutations) {
    it(`${mutation.name} → the compiled projection no longer equals the base source IR`, () => {
      const baseProjection = projectCompiledPlanSemantics(okArtifact(AUTHORED));
      const mutatedDocument = mutation.mutate(clone(AUTHORED));
      expect(validateWorkflowIrDocument(mutatedDocument).ok).toBe(true);
      const mutatedProjection = projectCompiledPlanSemantics(okArtifact(mutatedDocument));
      expect(mutatedProjection).not.toEqual(baseProjection);
      // the mutated projection DOES equal its own source's canonical IR
      // (equivalence is exact per-document, not accidentally shared)
      expect(mutatedProjection).toEqual(canonicalIrOf(mutatedDocument));
    });
  }
});
