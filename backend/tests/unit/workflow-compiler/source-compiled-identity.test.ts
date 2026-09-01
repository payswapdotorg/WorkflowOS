import { describe, it, expect } from 'vitest';
import {
  compileWorkflow,
  verifySourceVersionBinding,
  computeCompiledWorkflowDigest,
} from '../../../src/workflow-compiler/index.js';
import { computeWorkflowVersionSemanticDigest, WORKFLOW_IR_OBJECT_TYPE } from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import {
  buildTriageDocument,
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
  withCompatibility,
  clone,
  TRIAGE_SECRET_REF,
} from './helpers.js';

/**
 * V2-007 — source/compiled identity battery.
 *
 * A compiled artifact is BOUND to the exact source WorkflowVersion semantic
 * digest (computed by the merged V2-003 implementation — never reimplemented
 * here). ANY semantic change to the source → a different source digest → a
 * different compiled artifact identity. Presentation-only changes keep both.
 * The binding is verifiable: verifySourceVersionBinding(artifact, document).
 */

const AUTHORED = buildTriageDocument();

function okArtifact(document: WorkflowIrDocument) {
  const result = compileWorkflow(document);
  if (!result.ok) {
    throw new Error(`fixture must compile: ${result.diagnostics.map((d) => d.message).join('; ')}`);
  }
  return result.artifact;
}

describe('V2-007 — the compiled artifact is tied to the source WorkflowVersion digest', () => {
  it('provenance.source.semanticDigest equals the merged V2-003 semantic digest of the source', () => {
    const artifact = okArtifact(AUTHORED);
    const sourceDigest = computeWorkflowVersionSemanticDigest(AUTHORED);
    expect(artifact.provenance.source.semanticDigest).toBe(sourceDigest.digest);
  });

  it('provenance.source records the digest algorithm, domain and IR schema version', () => {
    const artifact = okArtifact(AUTHORED);
    expect(artifact.provenance.source.digestAlgorithm).toBe('sha-256');
    expect(artifact.provenance.source.digestDomain).toBe(WORKFLOW_IR_OBJECT_TYPE);
    expect(artifact.provenance.source.objectType).toBe(WORKFLOW_IR_OBJECT_TYPE);
    expect(artifact.provenance.source.irSchemaVersion).toBe(1);
  });

  it('verifySourceVersionBinding accepts the exact source document', () => {
    const artifact = okArtifact(AUTHORED);
    expect(verifySourceVersionBinding(artifact, AUTHORED)).toBe(true);
  });

  it('verifySourceVersionBinding accepts a presentation-only variant (same version semantics)', () => {
    const artifact = okArtifact(AUTHORED);
    const relabeled = withPresentation(AUTHORED, {
      title: 'Different title, same semantics',
      notes: 'presentation excluded',
    });
    expect(verifySourceVersionBinding(artifact, relabeled)).toBe(true);
  });

  it('verifySourceVersionBinding rejects a semantically different document', () => {
    const artifact = okArtifact(AUTHORED);
    const mutated = withEdge(AUTHORED, { from: 'sync_backlog', to: 'log_rejection', on: 'success' });
    expect(verifySourceVersionBinding(artifact, mutated)).toBe(false);
  });
});

describe('V2-007 — ANY source semantic change → different source digest AND different artifact', () => {
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
      name: 'a changed declared compatibility metadata',
      mutate: (doc) =>
        withCompatibility(doc, {
          compatibilityLevel: 'compatible',
          inputSurfaceChange: 'additive',
          outputSurfaceChange: 'none',
        }),
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
    it(`${mutation.name} → different source digest and different compiled artifact`, () => {
      const base = okArtifact(AUTHORED);
      const mutatedDocument = mutation.mutate(clone(AUTHORED));
      const mutated = okArtifact(mutatedDocument);
      expect(computeWorkflowVersionSemanticDigest(mutatedDocument).digest).not.toBe(
        computeWorkflowVersionSemanticDigest(AUTHORED).digest,
      );
      expect(mutated.provenance.source.semanticDigest).not.toBe(base.provenance.source.semanticDigest);
      expect(mutated.artifactDigest).not.toBe(base.artifactDigest);
      expect(computeCompiledWorkflowDigest(mutated).digest).not.toBe(
        computeCompiledWorkflowDigest(base).digest,
      );
      expect(verifySourceVersionBinding(base, mutatedDocument)).toBe(false);
    });
  }
});

describe('V2-007 — the compiled artifact is NOT the source version identity', () => {
  it('the artifact digest and the source semantic digest are different commitments', () => {
    const artifact = okArtifact(AUTHORED);
    const artifactDigest = computeCompiledWorkflowDigest(artifact).digest;
    const sourceDigest = computeWorkflowVersionSemanticDigest(AUTHORED).digest;
    expect(artifactDigest).not.toBe(sourceDigest);
    expect(artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the artifact carries the source digest as a verifiable binding, not as its own identity', () => {
    const artifact = okArtifact(AUTHORED);
    expect(artifact.provenance.source.semanticDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.provenance.source.digestDomain).toBe(WORKFLOW_IR_OBJECT_TYPE);
  });
});

describe('V2-007 — the source secret reference is preserved as the bound reference', () => {
  it('the compiled plan carries the same opaque secret reference the source declares', () => {
    const artifact = okArtifact(AUTHORED);
    const notify = artifact.plan.units.find((unit) => unit.unit === 'notify_channel');
    expect(notify).toBeDefined();
    const secretPort = notify?.inputs.find((input) => input.name === 'credentials');
    expect(secretPort?.binding).toEqual({ kind: 'secret_ref', ref: TRIAGE_SECRET_REF });
  });
});
