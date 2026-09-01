import { describe, it, expect } from 'vitest';
import {
  validateWorkflowIrDocument,
  WORKFLOW_IR_OBJECT_TYPE,
  IR_SCHEMA_VERSION,
} from '../../../src/workflow-ir/index.js';
import {
  buildMinimalDocument,
  buildTriageDocument,
  clone,
  withEdge,
  withIr,
  withNode,
  withNodeInputs,
  withNodeOutputs,
} from './helpers.js';

/**
 * V2-003 — invalid/ambiguous graph rejection battery.
 *
 * Every ambiguity an author can express must be a typed rejection, never a
 * silent default: unknown node references, dangling edges, ambiguous control
 * semantics, duplicate identifiers, unsupported IR schema versions,
 * non-canonical vocabularies, malformed subworkflow dependencies and
 * malformed secret references.
 */

function issueCodes(result: ReturnType<typeof validateWorkflowIrDocument>): string[] {
  if (result.ok) return [];
  return result.issues.map((issue) => issue.code);
}

describe('V2-003 — the valid fixtures validate', () => {
  it('the minimal single-node document is valid', () => {
    const result = validateWorkflowIrDocument(buildMinimalDocument());
    expect(result.ok).toBe(true);
  });

  it('the full triage document (human gate, subworkflow, secret ref) is valid', () => {
    const result = validateWorkflowIrDocument(buildTriageDocument());
    expect(result.ok).toBe(true);
  });
});

describe('V2-003 — unsupported IR schema versions are rejected', () => {
  it('a future schema version is rejected (fail closed, no guessing)', () => {
    const doc = clone(buildMinimalDocument());
    (doc as { irSchemaVersion: number }).irSchemaVersion = IR_SCHEMA_VERSION + 1;
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_SCHEMA_VERSION_UNSUPPORTED');
  });

  it('a wrong object type is rejected (no aliasing of the IR domain)', () => {
    const doc = clone(buildMinimalDocument());
    (doc as { objectType: string }).objectType = 'workflowos/workflow-ir/v2';
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_OBJECT_TYPE_MISMATCH');
  });
});

describe('V2-003 — duplicate identifiers are rejected', () => {
  it('duplicate node ids are rejected', () => {
    const doc = clone(buildMinimalDocument());
    const first = doc.ir.nodes[0];
    if (first === undefined) throw new Error('fixture node missing');
    doc.ir.nodes = [...doc.ir.nodes, first];
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_NODE_ID_DUPLICATE');
  });

  it('duplicate workflow input names are rejected', () => {
    const doc = clone(buildMinimalDocument());
    const first = doc.ir.inputs[0];
    if (first === undefined) throw new Error('fixture input missing');
    doc.ir.inputs = [...doc.ir.inputs, first];
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_PORT_NAME_DUPLICATE');
  });

  it('duplicate input port names on one node are rejected', () => {
    const doc = withNodeInputs(buildMinimalDocument(), 'observe', [
      { name: 'url', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'sourceUrl' } },
      { name: 'url', type: { kind: 'string' }, binding: { kind: 'literal', value: 'x' } },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_PORT_NAME_DUPLICATE');
  });

  it('duplicate workflow output names are rejected', () => {
    const doc = withIr(buildMinimalDocument(), {
      outputs: [
        {
          name: 'text',
          type: { kind: 'string' },
          from: { kind: 'node_output', node: 'observe', output: 'pageText' },
        },
        {
          name: 'text',
          type: { kind: 'string' },
          from: { kind: 'node_output', node: 'observe', output: 'pageText' },
        },
      ],
    });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_PORT_NAME_DUPLICATE');
  });

  it('duplicate control edges (same from/to/trigger) are rejected', () => {
    const doc = clone(buildMinimalDocument());
    const first = doc.ir.nodes[0];
    if (first === undefined) throw new Error('fixture node missing');
    doc.ir.nodes[0] = { ...first, failurePolicy: { strategy: 'failover' } };
    doc.ir.nodes = [
      ...doc.ir.nodes,
      {
        id: 'record',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'filesystem.write' },
        capabilityRequirements: ['filesystem.write'],
        placement: 'device_local',
        inputs: [],
        outputs: [],
        failurePolicy: { strategy: 'fail_workflow' },
      },
    ];
    doc.ir.edges = [
      { from: 'observe', to: 'record', on: 'success' },
      { from: 'observe', to: 'record', on: 'success' },
      { from: 'observe', to: 'record', on: 'failure' },
    ];
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_EDGE_DUPLICATE');
  });
});

describe('V2-003 — unknown node references and dangling edges are rejected', () => {
  it('an edge referencing an unknown node is rejected', () => {
    const doc = withEdge(buildMinimalDocument(), { from: 'observe', to: 'ghost', on: 'success' });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_EDGE_NODE_UNKNOWN');
  });

  it('a binding referencing an unknown node is rejected', () => {
    const doc = withNodeInputs(buildMinimalDocument(), 'observe', [
      {
        name: 'url',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'ghost', output: 'pageText' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_BINDING_NODE_UNKNOWN');
  });

  it('a binding referencing an unknown output port is rejected', () => {
    const doc = withNodeInputs(buildMinimalDocument(), 'observe', [
      {
        name: 'url',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'observe', output: 'nope' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_BINDING_OUTPUT_UNKNOWN');
  });

  it('a binding referencing an unknown workflow input is rejected', () => {
    const doc = withNodeInputs(buildMinimalDocument(), 'observe', [
      {
        name: 'url',
        type: { kind: 'string' },
        binding: { kind: 'workflow_input', input: 'ghostInput' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_BINDING_WORKFLOW_INPUT_UNKNOWN');
  });

  it('an unknown start node is rejected', () => {
    const doc = withIr(buildMinimalDocument(), { start: 'ghost' });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_START_UNKNOWN');
  });

  it('a workflow with zero nodes is rejected', () => {
    const doc = withIr(buildMinimalDocument(), { nodes: [], edges: [], start: 'none' });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_NODES_REQUIRED');
  });
});

describe('V2-003 — ambiguous control semantics are rejected', () => {
  it('a self-edge is rejected', () => {
    const doc = withEdge(buildMinimalDocument(), { from: 'observe', to: 'observe', on: 'success' });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_EDGE_SELF_LOOP');
  });

  it('an edge INTO the start node is rejected (the start is the single entry point)', () => {
    const doc = withEdge(buildTriageDocument(), { from: 'log_rejection', to: 'fetch_issue', on: 'success' });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_EDGE_INTO_START');
  });

  it('an unreachable node is rejected (dead steps are ambiguous meaning)', () => {
    const doc = clone(buildMinimalDocument());
    const first = doc.ir.nodes[0];
    if (first === undefined) throw new Error('fixture node missing');
    const orphan: typeof first = { ...first, id: 'orphan' };
    doc.ir.nodes = [...doc.ir.nodes, orphan];
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_NODE_UNREACHABLE');
  });

  it('multiple on_failure edges from one node are rejected', () => {
    let doc = buildTriageDocument();
    doc = withNodeFailurePolicyAndEdges(doc);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_FAILURE_POLICY_EDGE_CONFLICT');
  });

  it('an on_failure edge contradicts an ignore_and_continue policy', () => {
    let doc = buildTriageDocument();
    doc = withNode(doc, 'log_rejection', { failurePolicy: { strategy: 'failover' } });
    // log_rejection has NO on_failure edge → failover requires exactly one
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_FAILURE_POLICY_EDGE_REQUIRED');
  });

  it('a fail_workflow policy together with an on_failure edge is contradictory', () => {
    const doc = clone(buildMinimalDocument());
    doc.ir.nodes = [
      ...doc.ir.nodes,
      {
        id: 'record',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'filesystem.write' },
        capabilityRequirements: ['filesystem.write'],
        placement: 'device_local',
        inputs: [],
        outputs: [],
        failurePolicy: { strategy: 'fail_workflow' },
      },
    ];
    doc.ir.edges = [
      { from: 'observe', to: 'record', on: 'success' },
      { from: 'observe', to: 'record', on: 'failure' },
    ];
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_FAILURE_POLICY_EDGE_CONFLICT');
  });

  it('a human approval node with an uncovered outcome is rejected', () => {
    const doc = clone(buildTriageDocument());
    doc.ir.edges = doc.ir.edges.filter(
      (edge) => !(edge.from === 'review_gate' && typeof edge.on === 'object' && edge.on.outcome === 'rejected'),
    );
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_HUMAN_OUTCOME_UNCOVERED');
  });

  it('a human approval node with a plain success edge is rejected (outcomes are the control semantics)', () => {
    const doc = clone(buildTriageDocument());
    doc.ir.edges = doc.ir.edges.filter((edge) => edge.from !== 'review_gate');
    doc.ir.edges.push({ from: 'review_gate', to: 'notify_channel', on: 'success' });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_HUMAN_SUCCESS_EDGE_FORBIDDEN');
  });

  it('an on_outcome edge for an outcome the human node never declared is rejected', () => {
    const doc = clone(buildTriageDocument());
    doc.ir.edges.push({ from: 'review_gate', to: 'log_rejection', on: { outcome: 'maybe' } });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_HUMAN_OUTCOME_UNDECLARED');
  });

  it('an approval node without the canonical approved:boolean output is rejected', () => {
    const doc = withNodeOutputs(buildTriageDocument(), 'review_gate', [
      { name: 'verdict', type: { kind: 'string' } },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_HUMAN_OUTPUT_CONTRACT');
  });
});

describe('V2-003 — non-canonical vocabularies are rejected', () => {
  it('an unknown execution class is rejected', () => {
    const doc = withNode(buildMinimalDocument(), 'observe', {
      executionClass: 'api',
    } as never);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_EXECUTION_CLASS_UNKNOWN');
  });

  it('a spec class that disagrees with the declared execution class is rejected', () => {
    const doc = withNode(buildTriageDocument(), 'fetch_issue', {
      executionClass: 'agentic_computer_use',
    });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_SPEC_CLASS_MISMATCH');
  });

  it('an unknown placement identifier is rejected', () => {
    const doc = withIr(buildMinimalDocument(), { defaultPlacement: 'cloud_only' as never });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_PLACEMENT_UNKNOWN');
  });

  it('an unknown node placement identifier is rejected', () => {
    const doc = withNode(buildMinimalDocument(), 'observe', {
      placement: 'sometimes' as never,
    });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_PLACEMENT_UNKNOWN');
  });

  it("completion evidence 'claim' can never establish completion (constitution §7)", () => {
    const doc = withNode(buildMinimalDocument(), 'observe', {
      completionEvidence: 'claim' as never,
    });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_COMPLETION_EVIDENCE_INVALID');
  });

  it("completion evidence 'intent' can never establish completion", () => {
    const doc = withNode(buildMinimalDocument(), 'observe', {
      completionEvidence: 'intent' as never,
    });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_COMPLETION_EVIDENCE_INVALID');
  });
});

describe('V2-003 — malformed subworkflow dependencies are rejected', () => {
  it('a subworkflow node missing workflow.execute in its capability requirements is rejected', () => {
    const doc = withNode(buildTriageDocument(), 'sync_backlog', {
      capabilityRequirements: [],
    });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_SUBWORKFLOW_CAPABILITY_REQUIRED');
  });

  it('a subworkflow node with an empty version reference is rejected', () => {
    const doc = clone(buildTriageDocument());
    const index = doc.ir.nodes.findIndex((node) => node.id === 'sync_backlog');
    (doc.ir.nodes[index] as { spec: { subworkflow: { workflowId: string; versionRef: string } } }).spec.subworkflow.versionRef = '';
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_SUBWORKFLOW_DEPENDENCY_INVALID');
  });
});

describe('V2-003 — strict shape checking rejects unknown/malformed fields', () => {
  it('an unknown binding kind is rejected', () => {
    const doc = withNodeInputs(buildMinimalDocument(), 'observe', [
      {
        name: 'url',
        type: { kind: 'string' },
        binding: { kind: 'sdk_call', sdk: 'chrome.tabs' } as never,
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_BINDING_KIND_UNKNOWN');
  });

  it('an unknown top-level document field is rejected', () => {
    const doc = clone(buildMinimalDocument());
    (doc as unknown as Record<string, unknown>).deploymentPlacement = 'us-east-1';
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_FIELD_UNEXPECTED');
  });

  it('a literal that is not valid JSON data is rejected', () => {
    const doc = withNodeInputs(buildMinimalDocument(), 'observe', [
      {
        name: 'url',
        type: { kind: 'string' },
        binding: { kind: 'literal', value: Number.NaN } as never,
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('IR_LITERAL_NOT_JSON');
  });

  it('validation is deterministic: the same invalid document yields the same issues in the same order', () => {
    const doc = withEdge(buildMinimalDocument(), { from: 'observe', to: 'ghost', on: 'success' });
    const first = validateWorkflowIrDocument(doc);
    const second = validateWorkflowIrDocument(doc);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('every issue carries a code, a path and a human message', () => {
    const doc = withEdge(buildMinimalDocument(), { from: 'observe', to: 'ghost', on: 'success' });
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const issue of result.issues) {
        expect(issue.code.length).toBeGreaterThan(0);
        expect(issue.path.length).toBeGreaterThan(0);
        expect(issue.message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('V2-003 — the IR domain identifier is exported for discrimination', () => {
  it('exposes the schema-internal object type and current schema version', () => {
    expect(WORKFLOW_IR_OBJECT_TYPE).toBe('workflowos/workflow-ir/v1');
    expect(IR_SCHEMA_VERSION).toBe(1);
  });
});

/** failover policy + TWO on_failure edges (ambiguous failure routing). */
function withNodeFailurePolicyAndEdges(doc: import('../../../src/workflow-ir/index.js').WorkflowIrDocument) {
  const next = clone(doc);
  const index = next.ir.nodes.findIndex((node) => node.id === 'fetch_issue');
  const target = next.ir.nodes[index];
  if (target === undefined) throw new Error('fixture node not found: fetch_issue');
  next.ir.nodes[index] = {
    ...target,
    failurePolicy: { strategy: 'failover' },
  };
  next.ir.edges.push({ from: 'fetch_issue', to: 'log_rejection', on: 'failure' });
  next.ir.edges.push({ from: 'fetch_issue', to: 'draft_summary', on: 'failure' });
  return next;
}
