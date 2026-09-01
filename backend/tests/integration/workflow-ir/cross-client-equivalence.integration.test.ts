import { describe, it, expect } from 'vitest';
import {
  computeWorkflowVersionSemanticDigest,
  createWorkflowIrBuilder,
  negotiateIrSchemaVersion,
  negotiateWorkflowVersionUpdate,
  parseWorkflowIrDocument,
  semanticallyEqual,
  serializeWorkflowIrDocument,
  validateWorkflowIrDocument,
  IR_SCHEMA_VERSION,
} from '../../../src/workflow-ir/index.js';
import type { ControlEdge, WorkflowNode } from '../../../src/workflow-ir/index.js';
import {
  buildTriageDocument,
  buildTriageDocumentAltOrder,
} from '../../unit/workflow-ir/helpers.js';

/**
 * V2-003 (integration) — cross-client semantic equivalence.
 *
 * Two INDEPENDENT construction paths (client A: the fluent builder; client B:
 * the raw literal document; plus the alt-order raw reconstruction from the
 * unit fixtures) produce the same workflow. They must serialize to IDENTICAL
 * canonical bytes — the multi-module in-process composition of builder →
 * serializer → parser → validator → negotiator → digest.
 */

const builderDocument = (() => {
  const fetchIssue: WorkflowNode = {
    id: 'fetch_issue',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'github.repository.read' },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
      { name: 'issueUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'issueUrl' } },
    ],
    outputs: [
      {
        name: 'issue',
        type: {
          kind: 'object',
          fields: [
            { name: 'title', type: { kind: 'string' } },
            { name: 'body', type: { kind: 'string' } },
          ],
        },
      },
    ],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const draftSummary: WorkflowNode = {
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
        type: {
          kind: 'object',
          fields: [
            { name: 'title', type: { kind: 'string' } },
            { name: 'body', type: { kind: 'string' } },
          ],
        },
        binding: { kind: 'node_output', node: 'fetch_issue', output: 'issue' },
      },
    ],
    outputs: [
      { name: 'summary', type: { kind: 'string' } },
      { name: 'severity', type: { kind: 'string' } },
    ],
    failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
  };
  const reviewGate: WorkflowNode = {
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
  };
  const notifyChannel: WorkflowNode = {
    id: 'notify_channel',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'messaging.send' },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_preferred',
    inputs: [
      { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' } },
      { name: 'channel', type: { kind: 'string' }, optional: true, binding: { kind: 'workflow_input', input: 'channel' } },
      { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' } },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'verification',
  };
  const syncBacklog: WorkflowNode = {
    id: 'sync_backlog',
    executionClass: 'subworkflow',
    spec: {
      class: 'subworkflow',
      subworkflow: { workflowId: 'wf-backlog-sync', versionRef: 'wfv_0192837465afdeadbeef-candidate-1' },
    },
    capabilityRequirements: ['workflow.execute'],
    placement: 'any_supported_node',
    inputs: [
      { name: 'summary', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' } },
    ],
    outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
  };
  const logRejection: WorkflowNode = {
    id: 'log_rejection',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'filesystem.write' },
    capabilityRequirements: ['filesystem.write'],
    placement: 'device_local',
    inputs: [
      { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'rejected-triage.log' } },
      { name: 'content', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' } },
    ],
    outputs: [],
    failurePolicy: { strategy: 'ignore_and_continue' },
  };

  // NOTE: deliberately scrambled add-order and edge-order relative to the raw
  // fixture — canonical set semantics must absorb the difference.
  const edges: ControlEdge[] = [
    { from: 'review_gate', to: 'log_rejection', on: { outcome: 'rejected' } },
    { from: 'review_gate', to: 'sync_backlog', on: { outcome: 'approved' } },
    { from: 'draft_summary', to: 'review_gate', on: 'success' },
    { from: 'review_gate', to: 'notify_channel', on: { outcome: 'approved' } },
    { from: 'fetch_issue', to: 'draft_summary', on: 'success' },
  ];

  const base = createWorkflowIrBuilder()
    .withCompatibility({ compatibilityLevel: 'equivalent', inputSurfaceChange: 'none', outputSurfaceChange: 'none' })
    .withProvenance({ origin: 'authored' })
    .withDefaultPlacement('any_supported_node')
    .withStart('fetch_issue')
    .withPresentation({
      title: 'Triage inbound GitHub issue',
      nodeLabels: { review_gate: 'Human review gate' },
      nodePositions: {
        fetch_issue: { x: 40, y: 20 },
        draft_summary: { x: 40, y: 180 },
        review_gate: { x: 40, y: 340 },
      },
      notes: 'Drafted during V2-003 dogfooding.',
    })
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
    })
    .addNode(logRejection)
    .addNode(syncBacklog)
    .addNode(notifyChannel)
    .addNode(reviewGate)
    .addNode(draftSummary)
    .addNode(fetchIssue);

  return edges.reduce((builder, edge) => builder.addEdge(edge), base).build();
})();

describe('V2-003 — cross-client semantic equivalence (integration)', () => {
  it('client A (fluent builder) and client B (raw literal) serialize to IDENTICAL canonical bytes', () => {
    const builderBytes = serializeWorkflowIrDocument(builderDocument);
    const rawBytes = serializeWorkflowIrDocument(buildTriageDocument());
    expect(builderBytes).toBe(rawBytes);
  });

  it('a third client (raw alt-order) also produces the identical canonical bytes', () => {
    const altBytes = serializeWorkflowIrDocument(buildTriageDocumentAltOrder());
    expect(altBytes).toBe(serializeWorkflowIrDocument(builderDocument));
  });

  it('all three clients agree on the WorkflowVersion semantic digest', () => {
    const digests = new Set([
      computeWorkflowVersionSemanticDigest(builderDocument).digest,
      computeWorkflowVersionSemanticDigest(buildTriageDocument()).digest,
      computeWorkflowVersionSemanticDigest(buildTriageDocumentAltOrder()).digest,
    ]);
    expect(digests.size).toBe(1);
  });

  it('the composed pipeline (builder → serialize → parse → validate → digest) is internally consistent', () => {
    const bytes = serializeWorkflowIrDocument(builderDocument);
    const parsed = parseWorkflowIrDocument(bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(validateWorkflowIrDocument(parsed.document).ok).toBe(true);
      expect(semanticallyEqual(parsed.document, builderDocument)).toBe(true);
      expect(serializeWorkflowIrDocument(parsed.document)).toBe(bytes);
      expect(computeWorkflowVersionSemanticDigest(parsed.document).digest).toBe(
        computeWorkflowVersionSemanticDigest(builderDocument).digest,
      );
    }
  });

  it('the composed negotiation layer accepts the parsed artifact for the current schema version', () => {
    const bytes = serializeWorkflowIrDocument(builderDocument);
    const parsed = parseWorkflowIrDocument(bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const negotiation = negotiateIrSchemaVersion(
        { supportedIrSchemaVersions: [IR_SCHEMA_VERSION] },
        { irSchemaVersion: parsed.document.irSchemaVersion },
      );
      expect(negotiation.decision).toBe('accept');
    }
  });

  it('the composed update negotiation treats an identical re-authored surface as a drop-in accept', () => {
    const a = builderDocument;
    const b = buildTriageDocument();
    const decision = negotiateWorkflowVersionUpdate({
      installed: {
        inputs: a.ir.inputs,
        outputs: a.ir.outputs,
        compatibility: a.compatibility,
      },
      candidate: {
        inputs: b.ir.inputs,
        outputs: b.ir.outputs,
        compatibility: b.compatibility,
      },
    });
    expect(decision.decision).toBe('accept');
  });

  it('the whole pipeline is deterministic end-to-end (byte-identical on repetition)', () => {
    const runOnce = () => {
      const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(builderDocument));
      return parsed.ok ? computeWorkflowVersionSemanticDigest(parsed.document).digest : 'PARSE_FAILED';
    };
    expect(runOnce()).toBe(runOnce());
    expect(runOnce()).not.toBe('PARSE_FAILED');
  });
});
