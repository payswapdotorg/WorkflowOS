import { describe, it, expect } from 'vitest';
import {
  authorCleanSubstitutableDocument,
  authorReuseDocument,
  withRenamedOutputPort,
  withChangedFailurePolicy,
  BASELINE,
  composeOptimizationService,
} from './helpers.js';
import {
  computeWorkflowVersionSemanticDigest,
  validateWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';

/**
 * V2-011 — SEMANTIC EQUIVALENCE (the required regression).
 *
 * The derived candidate is proven to preserve the baseline's TASK SURFACE:
 * the workflow interface (inputs/outputs), the control structure (nodes,
 * edges, human decision points) and every node's data contracts (port
 * bindings/declarations, failure policies). What changes is ONLY the
 * execution mechanism (the spec class / capability / subworkflow
 * reference). The merged V2-003 negotiation cross-checks the candidate's
 * public-surface declaration ('equivalent' + none/none → accept
 * 'public-surface-unchanged').
 */
describe('V2-011 — the derived api_substitution candidate preserves the task surface', () => {
  it('the service comparison proves equivalence and the merged negotiation accepts the candidate', () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_board',
    });

    // the candidate changes ONLY the substituted node's mechanism
    const candidateNode = proposal.candidateDocument.ir.nodes.find((n) => n.id === 'scan_board')!;
    expect(candidateNode.executionClass).toBe('deterministic_api');
    expect(candidateNode.spec).toEqual({
      class: 'deterministic_api',
      capability: 'github.repository.read',
    });
    expect(candidateNode.capabilityRequirements).toEqual(['github.repository.read']);
    // ports, bindings, failure policy and placement are preserved verbatim
    const baselineNode = document.ir.nodes.find((n) => n.id === 'scan_board')!;
    expect(candidateNode.inputs).toEqual(baselineNode.inputs);
    expect(candidateNode.outputs).toEqual(baselineNode.outputs);
    expect(candidateNode.failurePolicy).toEqual(baselineNode.failurePolicy);
    expect(candidateNode.placement).toBe(baselineNode.placement);
    // every OTHER node is untouched
    expect(
      proposal.candidateDocument.ir.nodes.filter((n) => n.id !== 'scan_board'),
    ).toEqual(document.ir.nodes.filter((n) => n.id !== 'scan_board'));
    expect(proposal.candidateDocument.ir.edges).toEqual(document.ir.edges);
    expect(proposal.candidateDocument.ir.start).toBe(document.ir.start);
    expect(proposal.candidateDocument.ir.inputs).toEqual(document.ir.inputs);
    expect(proposal.candidateDocument.ir.outputs).toEqual(document.ir.outputs);

    // the comparison proves semantic equivalence
    expect(proposal.comparison.correctness.equivalent).toBe(true);
    expect(proposal.comparison.correctness.firstDivergence).toBeNull();
    // the merged V2-003 negotiation cross-check accepts the declaration
    expect(proposal.comparison.negotiation.decision).toBe('accept');
    expect(proposal.comparison.negotiation.reason).toBe('public-surface-unchanged');
    // the candidate declares the honest compatibility level
    expect(proposal.candidateDocument.compatibility).toEqual({
      compatibilityLevel: 'equivalent',
      inputSurfaceChange: 'none',
      outputSurfaceChange: 'none',
    });
    // the candidate is a VALID WorkflowIR document (merged validation)
    expect(validateWorkflowIrDocument(proposal.candidateDocument).ok).toBe(true);
    // and it is a DIFFERENT version (the semantic digest changed — new content)
    expect(computeWorkflowVersionSemanticDigest(proposal.candidateDocument).digest).not.toBe(
      computeWorkflowVersionSemanticDigest(document).digest,
    );
  });
});

describe('V2-011 — the comparison engine detects task-surface divergence', () => {
  it('a renamed output port breaks the surface (not equivalent, first divergence reported)', () => {
    const { service } = composeOptimizationService();
    const baseline = authorCleanSubstitutableDocument();
    const candidate = withRenamedOutputPort(baseline);
    const comparison = service.compareVersions(baseline, candidate);
    expect(comparison.correctness.equivalent).toBe(false);
    expect(comparison.correctness.firstDivergence).toContain('send_digest');
    expect(comparison.correctness.firstDivergence).toContain('messageIdentifier');
  });

  it('a changed failure policy breaks the surface', () => {
    const { service } = composeOptimizationService();
    const baseline = authorCleanSubstitutableDocument();
    const candidate = withChangedFailurePolicy(baseline);
    const comparison = service.compareVersions(baseline, candidate);
    expect(comparison.correctness.equivalent).toBe(false);
    expect(comparison.correctness.firstDivergence).toContain('scan_board');
    expect(comparison.correctness.firstDivergence).toContain('failurePolicy');
  });

  it('the comparison is deterministic (same inputs → identical output)', () => {
    const { service } = composeOptimizationService();
    const baseline = authorCleanSubstitutableDocument();
    const candidate = withRenamedOutputPort(baseline);
    expect(service.compareVersions(baseline, candidate)).toEqual(
      service.compareVersions(baseline, candidate),
    );
  });
});

describe('V2-011 — the derived workflow_reuse candidate preserves the task surface', () => {
  it('the duplicate site becomes an opaque subworkflow reference with identical ports', () => {
    const { service } = composeOptimizationService();
    const document = authorReuseDocument();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'normalize_b',
      reuseTarget: { workflowId: 'wf-existing-normalizer', versionRef: 'wfv_normalizer_v1' },
    });

    const candidateNode = proposal.candidateDocument.ir.nodes.find((n) => n.id === 'normalize_b')!;
    expect(candidateNode.executionClass).toBe('subworkflow');
    expect(candidateNode.spec).toEqual({
      class: 'subworkflow',
      subworkflow: { workflowId: 'wf-existing-normalizer', versionRef: 'wfv_normalizer_v1' },
    });
    expect(candidateNode.capabilityRequirements).toEqual(['workflow.execute']);
    const baselineNode = document.ir.nodes.find((n) => n.id === 'normalize_b')!;
    expect(candidateNode.inputs).toEqual(baselineNode.inputs);
    expect(candidateNode.outputs).toEqual(baselineNode.outputs);
    expect(candidateNode.failurePolicy).toEqual(baselineNode.failurePolicy);

    // the task surface is preserved and the negotiation accepts the candidate
    expect(proposal.comparison.correctness.equivalent).toBe(true);
    expect(proposal.comparison.negotiation.decision).toBe('accept');
    expect(validateWorkflowIrDocument(proposal.candidateDocument).ok).toBe(true);
  });
});
