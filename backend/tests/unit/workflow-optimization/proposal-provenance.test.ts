import { describe, it, expect } from 'vitest';
import {
  authorCleanSubstitutableDocument,
  BASELINE,
  composeOptimizationService,
} from './helpers.js';
import {
  OPTIMIZATION_RULES_VERSION,
} from '../../../src/workflow-optimization/index.js';
import {
  computeWorkflowVersionSemanticDigest,
} from '../../../src/workflow-ir/index.js';

/**
 * V2-011 — PROPOSAL PROVENANCE (the required regression).
 *
 * Every proposal carries verifiable provenance: the exact baseline pin
 * (workflow + version + the V2-003 semantic digest of the analyzed
 * content), the deterministic analysis identity it derives from, the rules
 * version, the opportunity reference and the candidate digest. A second
 * agent re-running the same analysis reproduces the same identity.
 */
describe('V2-011 — proposal provenance fields', () => {
  it('the proposal records the full verifiable provenance chain', () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const analysis = service.analyzeWorkflow(document);
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_board',
    });

    // the baseline pin: the exact (workflow, version) tuple + the V2-003 digest
    expect(proposal.provenance.baseline.workflowId).toBe(BASELINE.workflowId);
    expect(proposal.provenance.baseline.versionId).toBe(BASELINE.versionId);
    expect(proposal.provenance.baseline.semanticDigest).toBe(
      computeWorkflowVersionSemanticDigest(document).digest,
    );
    // the analysis identity the proposal derives from (reproducible)
    expect(proposal.provenance.analysisId).toBe(analysis.analysisId);
    expect(proposal.provenance.rulesVersion).toBe(OPTIMIZATION_RULES_VERSION);
    // the opportunity reference
    expect(proposal.provenance.opportunityKind).toBe('api_substitution');
    expect(proposal.provenance.opportunityNodeIds).toEqual(['scan_board']);
    // the candidate digest: the V2-003 semantic digest of the DERIVED document
    expect(proposal.provenance.candidateDigest).toBe(
      computeWorkflowVersionSemanticDigest(proposal.candidateDocument).digest,
    );
  });

  it('the embedded baseline document matches the supplied document byte-for-byte', () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_board',
    });
    expect(proposal.baselineDocument).toEqual(document);
  });
});

describe('V2-011 — provenance reproducibility', () => {
  it('a second independent composition reproduces the identical analysis + provenance', () => {
    const first = composeOptimizationService();
    const second = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();

    const firstAnalysis = first.service.analyzeWorkflow(document);
    const secondAnalysis = second.service.analyzeWorkflow(document);
    expect(secondAnalysis).toEqual(firstAnalysis);

    const firstProposal = first.service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_board',
    });
    const secondProposal = second.service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_board',
    });
    // fully identical records (same deterministic factories → same ids/timestamps)
    expect(secondProposal).toEqual(firstProposal);
    expect(secondProposal.provenance.analysisId).toBe(firstProposal.provenance.analysisId);
    expect(secondProposal.candidateDocument).toEqual(firstProposal.candidateDocument);
  });

  it('proposals for different opportunities carry different provenance', () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const first = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_board',
    });
    const second = service.createProposal({
      ownerId: 'owner-other',
      workflowId: 'wf-other',
      versionId: 'wfv-other-v1',
      document,
      opportunityNodeId: 'scan_board',
    });
    expect(second.provenance.baseline.workflowId).not.toBe(first.provenance.baseline.workflowId);
    expect(second.id).not.toBe(first.id);
  });
});
