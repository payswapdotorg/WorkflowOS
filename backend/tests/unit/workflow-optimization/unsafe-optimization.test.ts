import { describe, it, expect } from 'vitest';
import {
  authorSensitiveSubstitutableDocument,
  authorHumanDuplicateDocument,
  authorCleanSubstitutableDocument,
  authorMultiRequirementAgenticDocument,
  BASELINE,
  composeOptimizationService,
} from './helpers.js';
import {
  WorkflowOptimizationError,
  type OptimizationAnalysis,
} from '../../../src/workflow-optimization/index.js';
import { deriveApiSubstitutionCandidate } from '../../../src/workflow-optimization/internal/candidate-derivation.js';

/**
 * V2-011 — UNSAFE OPTIMIZATION REJECTION (the required regression).
 *
 * Two typed unsafe rules, enforced at analysis AND proposal creation:
 *
 *   1. SENSITIVE_CAPABILITY_SUBSTITUTION — substituting a node whose
 *      declared requirements intersect the V2-008 computer-agent runtime's
 *      SENSITIVE set would move the capability from the computer-use path
 *      (per-capability grants + takeover boundaries) to an unattended
 *      deterministic path: REJECTED, never proposed;
 *   2. HUMAN_NODE_MODIFIED — optimizations may never remove or alter human
 *      decision points: duplicated HUMAN nodes are never reuse candidates.
 */
function expectTypedError(
  action: () => unknown,
  code: string,
): WorkflowOptimizationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowOptimizationError);
    const typed = error as WorkflowOptimizationError;
    expect(typed.code, typed.message).toBe(code);
    return typed;
  }
  throw new Error(`expected a typed ${code} rejection`);
}

describe('V2-011 — SENSITIVE_CAPABILITY_SUBSTITUTION (the unsafe rule from V2-008)', () => {
  it('the analysis DETECTS the sensitive node structurally but REJECTS it with the typed reason', () => {
    const { service } = composeOptimizationService();
    const analysis = service.analyzeWorkflow(authorSensitiveSubstitutableDocument()) as OptimizationAnalysis;

    // structurally API-stable (filesystem.write is not a UI capability) but unsafe
    expect(analysis.opportunities).toEqual([]);
    expect(analysis.rejected).toHaveLength(1);
    const rejection = analysis.rejected[0]!;
    expect(rejection.kind).toBe('api_substitution');
    expect(rejection.nodeIds).toEqual(['write_report']);
    expect(rejection.reason).toBe('SENSITIVE_CAPABILITY_SUBSTITUTION');
    // the rejection rationale interpolates ONLY declared facts
    expect(rejection.rationale).toContain('write_report');
    expect(rejection.rationale).toContain('filesystem.write');
  });

  it('createProposal on the sensitive node is rejected with the typed UNSAFE_OPTIMIZATION error', () => {
    const { service } = composeOptimizationService();
    const document = authorSensitiveSubstitutableDocument();
    const typed = expectTypedError(
      () =>
        service.createProposal({
          ownerId: BASELINE.ownerId,
          workflowId: BASELINE.workflowId,
          versionId: BASELINE.versionId,
          document,
          opportunityNodeId: 'write_report',
        }),
      'UNSAFE_OPTIMIZATION',
    );
    expect(typed.details.reason).toBe('SENSITIVE_CAPABILITY_SUBSTITUTION');
    expect(typed.details.nodeIds).toEqual(['write_report']);
  });
});

describe('V2-011 — HUMAN_NODE_MODIFIED (human decision points are untouchable)', () => {
  it('duplicated HUMAN nodes are detected structurally but rejected with the typed reason', () => {
    const { service } = composeOptimizationService();
    const analysis = service.analyzeWorkflow(authorHumanDuplicateDocument()) as OptimizationAnalysis;

    expect(analysis.opportunities).toEqual([]);
    expect(analysis.rejected).toHaveLength(1);
    const rejection = analysis.rejected[0]!;
    expect(rejection.kind).toBe('workflow_reuse');
    expect(rejection.nodeIds).toEqual(['gate_a', 'gate_b']);
    expect(rejection.reason).toBe('HUMAN_NODE_MODIFIED');
    expect(rejection.rationale).toContain('gate_a');
    expect(rejection.rationale).toContain('gate_b');
  });

  it('createProposal on a human node id finds no opportunity (human nodes are never candidates)', () => {
    const { service } = composeOptimizationService();
    expectTypedError(
      () =>
        service.createProposal({
          ownerId: BASELINE.ownerId,
          workflowId: BASELINE.workflowId,
          versionId: BASELINE.versionId,
          document: authorCleanSubstitutableDocument(),
          opportunityNodeId: 'approve_digest',
        }),
      'OPPORTUNITY_NOT_FOUND',
    );
  });
});

describe('V2-011 — fail-closed input guards', () => {
  it('an invalid baseline document is rejected (merged V2-003 validation, fail-closed)', () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    // break reachability: the scan_board edges reference a node that no longer exists
    const broken = {
      ...document,
      ir: { ...document.ir, start: 'nonexistent_start_node' },
    };
    expectTypedError(
      () =>
        service.createProposal({
          ownerId: BASELINE.ownerId,
          workflowId: BASELINE.workflowId,
          versionId: BASELINE.versionId,
          document: broken,
          opportunityNodeId: 'scan_board',
        }),
      'IR_DOCUMENT_INVALID',
    );
  });

  it('empty required inputs are rejected with OPTIMIZATION_INPUT_INVALID', () => {
    const { service } = composeOptimizationService();
    expectTypedError(
      () =>
        service.createProposal({
          ownerId: '',
          workflowId: BASELINE.workflowId,
          versionId: BASELINE.versionId,
          document: authorCleanSubstitutableDocument(),
          opportunityNodeId: 'scan_board',
        }),
      'OPTIMIZATION_INPUT_INVALID',
    );
  });

  it('an unknown opportunity node id is rejected with OPPORTUNITY_NOT_FOUND', () => {
    const { service } = composeOptimizationService();
    expectTypedError(
      () =>
        service.createProposal({
          ownerId: BASELINE.ownerId,
          workflowId: BASELINE.workflowId,
          versionId: BASELINE.versionId,
          document: authorCleanSubstitutableDocument(),
          opportunityNodeId: 'no_such_node',
        }),
      'OPPORTUNITY_NOT_FOUND',
    );
  });

  it('a malformed reuse target is rejected with REUSE_TARGET_INVALID', () => {
    const { service } = composeOptimizationService();
    expectTypedError(
      () =>
        service.createProposal({
          ownerId: BASELINE.ownerId,
          workflowId: BASELINE.workflowId,
          versionId: BASELINE.versionId,
          document: authorCleanSubstitutableDocument(),
          opportunityNodeId: 'scan_board',
          reuseTarget: { workflowId: '', versionRef: '' },
        }),
      'REUSE_TARGET_INVALID',
    );
  });

  // ---------------------------------------------------------------------
  // The capability-contract preservation guard (architect review, PR #146
  // point 1, defense in depth): the derivation itself is fail-closed — an
  // api_substitution candidate can ONLY be derived for a node declaring
  // EXACTLY ONE capability requirement. The deterministic_api spec carries a
  // single capability; deriving for a multi-requirement (or zero-requirement)
  // node would silently DROP part of the node's execution contract, so the
  // derivation refuses instead (a future rules version that wants genuine
  // multi-capability composition must extend this derivation deliberately).
  // The analyzer never routes such nodes here; the guard holds regardless.
  // ---------------------------------------------------------------------
  it('deriving an api_substitution candidate for a MULTI-requirement node is fail-closed (the contract can never silently shrink)', () => {
    const document = authorMultiRequirementAgenticDocument();
    const typed = expectTypedError(
      () => deriveApiSubstitutionCandidate(document, 'scan_board'),
      'OPTIMIZATION_INPUT_INVALID',
    );
    expect(typed.details.nodeId).toBe('scan_board');
    expect(typed.details.declaredRequirements).toEqual([
      'github.repository.read',
      'spreadsheet.read',
    ]);
  });

  it('deriving an api_substitution candidate for a ZERO-requirement node is fail-closed', () => {
    const document = authorCleanSubstitutableDocument();
    const stripped = {
      ...document,
      ir: {
        ...document.ir,
        nodes: document.ir.nodes.map((node) =>
          node.id === 'scan_board' ? { ...node, capabilityRequirements: [] } : node,
        ),
      },
    };
    expectTypedError(
      () => deriveApiSubstitutionCandidate(stripped as never, 'scan_board'),
      'OPTIMIZATION_INPUT_INVALID',
    );
  });

  it('deriving an api_substitution candidate for an unknown node id is fail-closed (no silent no-op)', () => {
    const document = authorCleanSubstitutableDocument();
    expectTypedError(
      () => deriveApiSubstitutionCandidate(document, 'no_such_node'),
      'OPTIMIZATION_INPUT_INVALID',
    );
  });
});
