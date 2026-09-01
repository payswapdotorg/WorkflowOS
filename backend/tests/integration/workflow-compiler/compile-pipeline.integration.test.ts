import { describe, it, expect } from 'vitest';
import {
  compileWorkflow,
  serializeCompiledWorkflowArtifact,
  parseCompiledWorkflowArtifact,
  verifyCompiledWorkflowArtifact,
  verifySourceVersionBinding,
  computeCompiledWorkflowDigest,
  projectCompiledPlanSemantics,
  WORKFLOW_COMPILER_ID,
  WORKFLOW_COMPILER_VERSION,
  COMPILED_WORKFLOW_OBJECT_TYPE,
} from '../../../src/workflow-compiler/index.js';
import {
  createWorkflowIrBuilder,
  validateWorkflowIrDocument,
  serializeWorkflowIrDocument,
  parseWorkflowIrDocument,
  computeWorkflowVersionSemanticDigest,
} from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../../src/workflow-ir/index.js';
import { buildTriageDocument } from '../../unit/workflow-ir/helpers.js';

/**
 * V2-007 (integration) — the real end-to-end compilation pipeline.
 *
 * An INDEPENDENT authoring client builds the support-ticket-triage workflow
 * with the merged V2-003 fluent builder → validates → serializes → parses →
 * re-validates (transport round-trip) → compiles with the V2-007 compiler →
 * verifies the source-version binding and the artifact digest → projects the
 * compiled plan back to IR form and proves semantic equivalence against the
 * source IR's own canonical serialization → exports the artifact → re-imports
 * it → re-verifies. Deterministic double compilation proves byte identity.
 * The IR-valid-but-compiler-rejectable fixtures are rejected through the same
 * real pipeline (typed diagnostics, never silent partial output).
 */

const issueObjectType = {
  kind: 'object',
  fields: [
    { name: 'title', type: { kind: 'string' } },
    { name: 'body', type: { kind: 'string' } },
  ],
} as const;

const pipelineNodes: WorkflowNode[] = [
  {
    id: 'fetch_issue',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'github.repository.read' },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
      { name: 'issueUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'issueUrl' } },
    ],
    outputs: [{ name: 'issue', type: issueObjectType }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  },
  {
    id: 'draft_summary',
    executionClass: 'agentic_computer_use',
    spec: {
      class: 'agentic_computer_use',
      task: 'Draft a triage summary and severity classification for the inbound GitHub issue.',
    },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'issue',
        type: issueObjectType,
        binding: { kind: 'node_output', node: 'fetch_issue', output: 'issue' },
      },
    ],
    outputs: [
      { name: 'summary', type: { kind: 'string' } },
      { name: 'severity', type: { kind: 'string' } },
    ],
    failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
  },
  {
    id: 'review_gate',
    executionClass: 'human',
    spec: {
      class: 'human',
      human: {
        kind: 'approval',
        instruction: 'Approve posting the triage summary and syncing the backlog for this issue.',
      },
    },
    capabilityRequirements: [],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'human_confirmation',
  },
  {
    id: 'notify_channel',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'messaging.send' },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_preferred',
    inputs: [
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
        binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'verification',
  },
  {
    id: 'sync_backlog',
    executionClass: 'subworkflow',
    spec: {
      class: 'subworkflow',
      subworkflow: {
        workflowId: 'wf-backlog-sync',
        versionRef: 'wfv_0192837465afdeadbeef-candidate-1',
      },
    },
    capabilityRequirements: ['workflow.execute'],
    placement: 'any_supported_node',
    inputs: [
      {
        name: 'summary',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
    ],
    outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
  },
  {
    id: 'log_rejection',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'filesystem.write' },
    capabilityRequirements: ['filesystem.write'],
    placement: 'device_local',
    inputs: [
      { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'rejected-triage.log' } },
      {
        name: 'content',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
    ],
    outputs: [],
    failurePolicy: { strategy: 'ignore_and_continue' },
  },
];

/** The support-ticket-triage workflow authored through the REAL V2-003 builder. */
function authorTriageWorkflowWithBuilder(): WorkflowIrDocument {
  const builder = createWorkflowIrBuilder()
    .withStart('fetch_issue')
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .addWorkflowInput({ name: 'issueUrl', type: { kind: 'string' } })
    .addWorkflowInput({ name: 'channel', type: { kind: 'string' }, optional: true })
    .addWorkflowOutput({
      name: 'summary',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
    })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'notify_channel', output: 'messageId' },
    });
  for (const node of pipelineNodes) {
    builder.addNode(node);
  }
  builder.addEdge({ from: 'fetch_issue', to: 'draft_summary', on: 'success' });
  builder.addEdge({ from: 'draft_summary', to: 'review_gate', on: 'success' });
  builder.addEdge({ from: 'review_gate', to: 'notify_channel', on: { outcome: 'approved' } });
  builder.addEdge({ from: 'review_gate', to: 'sync_backlog', on: { outcome: 'approved' } });
  builder.addEdge({ from: 'review_gate', to: 'log_rejection', on: { outcome: 'rejected' } });
  return builder.build();
}

describe('V2-007 real pipeline: V2-003 builder → transport round-trip → compiler → validation', () => {
  const authored = authorTriageWorkflowWithBuilder();

  it('the builder-authored workflow is a valid WorkflowIR document', () => {
    const validation = validateWorkflowIrDocument(authored);
    expect(validation.ok).toBe(true);
  });

  it('the builder-authored workflow is semantically the merged triage fixture (independent client)', () => {
    // cross-client equivalence through the merged V2-003 canonical serializer
    expect(serializeWorkflowIrDocument(authored)).toBe(serializeWorkflowIrDocument(buildTriageDocument()));
  });

  it('transport round-trip (serialize → parse → re-validate) then compile succeeds', () => {
    const bytes = serializeWorkflowIrDocument(authored);
    const parsed = parseWorkflowIrDocument(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateWorkflowIrDocument(parsed.document).ok).toBe(true);
    const compiled = compileWorkflow(parsed.document);
    expect(compiled.ok).toBe(true);
  });

  describe('the compiled artifact binds to the source WorkflowVersion and compiles deterministically', () => {
    const transportDocument = (() => {
      const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(authored));
      if (!parsed.ok) throw new Error('pipeline fixture failed to round-trip');
      return parsed.document;
    })();
    const first = compileWorkflow(transportDocument);
    if (!first.ok) throw new Error('pipeline fixture failed to compile');
    const second = compileWorkflow(transportDocument);
    if (!second.ok) throw new Error('pipeline fixture failed to compile');

    it('compiling the same source twice produces byte-identical artifacts', () => {
      expect(serializeCompiledWorkflowArtifact(first.artifact)).toBe(
        serializeCompiledWorkflowArtifact(second.artifact),
      );
    });

    it('the artifact is bound to the real V2-003 semantic digest of the source', () => {
      const sourceDigest = computeWorkflowVersionSemanticDigest(transportDocument);
      expect(first.artifact.provenance.source.semanticDigest).toBe(sourceDigest.digest);
      expect(verifySourceVersionBinding(first.artifact, transportDocument)).toBe(true);
      expect(verifySourceVersionBinding(first.artifact, authored)).toBe(true);
      expect(verifySourceVersionBinding(first.artifact, buildTriageDocument())).toBe(true);
    });

    it('the artifact is compiler-attributed, well-formed and self-consistent', () => {
      expect(first.artifact.objectType).toBe(COMPILED_WORKFLOW_OBJECT_TYPE);
      expect(first.artifact.provenance.compiler.id).toBe(WORKFLOW_COMPILER_ID);
      expect(first.artifact.provenance.compiler.version).toBe(WORKFLOW_COMPILER_VERSION);
      expect(first.artifact.artifactDigest).toBe(computeCompiledWorkflowDigest(first.artifact).digest);
      expect(verifyCompiledWorkflowArtifact(first.artifact).ok).toBe(true);
    });

    it('the compiled semantics project back exactly to the source IR declared semantics', () => {
      const projected = projectCompiledPlanSemantics(first.artifact);
      const canonicalIr = (JSON.parse(serializeWorkflowIrDocument(transportDocument)) as { ir: unknown }).ir;
      expect(projected).toEqual(canonicalIr);
    });

    it('export → import → re-verify preserves identity, binding and equivalence', () => {
      const bytes = serializeCompiledWorkflowArtifact(first.artifact);
      const imported = parseCompiledWorkflowArtifact(bytes);
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      expect(serializeCompiledWorkflowArtifact(imported.artifact)).toBe(bytes);
      expect(verifyCompiledWorkflowArtifact(imported.artifact).ok).toBe(true);
      expect(verifySourceVersionBinding(imported.artifact, transportDocument)).toBe(true);
      expect(projectCompiledPlanSemantics(imported.artifact)).toEqual(
        projectCompiledPlanSemantics(first.artifact),
      );
    });
  });
});

describe('V2-007 real pipeline: IR-valid-but-compiler-rejectable sources fail closed', () => {
  const authored = authorTriageWorkflowWithBuilder();

  it('a placement conflict (cloud_required default + device_local nodes) is rejected through the real path', () => {
    const conflicted: WorkflowIrDocument = {
      ...authored,
      ir: { ...authored.ir, defaultPlacement: 'cloud_required' },
    };
    expect(validateWorkflowIrDocument(conflicted).ok).toBe(true);
    const result = compileWorkflow(conflicted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_PLACEMENT_CONFLICT')).toBe(true);
      expect('artifact' in result).toBe(false);
    }
  });

  it('a human pause point with a retry budget is rejected through the real path', () => {
    const policyViolating: WorkflowIrDocument = {
      ...authored,
      ir: {
        ...authored.ir,
        nodes: authored.ir.nodes.map((node) =>
          node.id === 'review_gate'
            ? { ...node, failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 } }
            : node,
        ),
      },
    };
    expect(validateWorkflowIrDocument(policyViolating).ok).toBe(true);
    const result = compileWorkflow(policyViolating);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_POLICY_VIOLATION')).toBe(true);
    }
  });

  it('a cyclic control graph (IR-valid) is rejected through the real path', () => {
    const cyclic: WorkflowIrDocument = {
      ...authored,
      ir: {
        ...authored.ir,
        edges: [...authored.ir.edges, { from: 'log_rejection', to: 'draft_summary', on: 'success' }],
      },
    };
    expect(validateWorkflowIrDocument(cyclic).ok).toBe(true);
    const result = compileWorkflow(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_GRAPH_INVALID')).toBe(true);
    }
  });

  it('duplicate capability requirements (IR-valid) are rejected as ambiguous input through the real path', () => {
    const duplicated: WorkflowIrDocument = {
      ...authored,
      ir: {
        ...authored.ir,
        nodes: authored.ir.nodes.map((node) =>
          node.id === 'fetch_issue'
            ? {
                ...node,
                capabilityRequirements: ['github.repository.read', 'github.repository.read'],
              }
            : node,
        ),
      },
    };
    expect(validateWorkflowIrDocument(duplicated).ok).toBe(true);
    const result = compileWorkflow(duplicated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_AMBIGUOUS_INPUT')).toBe(true);
    }
  });

  it('an unsupported requested compiler version is rejected before any compilation happens', () => {
    const result = compileWorkflow(authored, { compilerVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_VERSION_UNSUPPORTED')).toBe(true);
    }
  });
});
