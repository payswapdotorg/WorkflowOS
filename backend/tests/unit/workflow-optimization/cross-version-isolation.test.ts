import { describe, it, expect } from 'vitest';
import {
  authorTwoSubstitutableNodesDocument,
  BASELINE,
  composeOptimizationService,
  documentToPlainJson,
} from './helpers.js';
import {
  computeWorkflowVersionSemanticDigest,
} from '../../../src/workflow-ir/index.js';

/**
 * V2-011 — CROSS-VERSION ISOLATION (the required regression).
 *
 * Candidate versions are independent identities: materializing one
 * proposal never affects another proposal's record, the shared baseline,
 * or the other candidate. Each candidate derives from the SAME pinned
 * baseline (never from a sibling candidate), and every materialized
 * version gets its own new version identity.
 */
describe('V2-011 — two proposals on one baseline materialize independently', () => {
  it('materializing the first proposal leaves the second and the baseline untouched', async () => {
    const { service, materializer } = composeOptimizationService();
    const document = authorTwoSubstitutableNodesDocument();

    const first = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_a',
    });
    const second = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_b',
    });
    const secondSnapshot = JSON.parse(JSON.stringify(second)) as typeof second;
    const baselineSnapshot = documentToPlainJson(document);

    await service.approveProposal({ proposalId: first.id, ownerId: BASELINE.ownerId });
    const firstResult = await service.materializeProposal({
      proposalId: first.id,
      ownerId: BASELINE.ownerId,
    });

    // the second proposal is UNCHANGED (still proposed, no materialization)
    const secondAfter = service.getProposal(second.id);
    expect(secondAfter.status).toBe('proposed');
    expect(secondAfter.materialization).toBeNull();
    expect(JSON.parse(JSON.stringify(secondAfter)) as typeof second).toEqual(secondSnapshot);

    // the baseline document is unchanged
    expect(documentToPlainJson(document)).toEqual(baselineSnapshot);

    // only ONE version was created so far
    expect(materializer.calls).toHaveLength(1);

    // now materialize the second proposal: a DIFFERENT new version identity
    await service.approveProposal({ proposalId: second.id, ownerId: BASELINE.ownerId });
    const secondResult = await service.materializeProposal({
      proposalId: second.id,
      ownerId: BASELINE.ownerId,
    });
    expect(materializer.calls).toHaveLength(2);
    expect(secondResult.materialization.versionId).not.toBe(firstResult.materialization.versionId);

    // both candidates derived from the SAME baseline parent (never stacked)
    expect(materializer.calls[0]!.parentVersionId).toBe(BASELINE.versionId);
    expect(materializer.calls[1]!.parentVersionId).toBe(BASELINE.versionId);
  });

  it('the two candidates are distinct versions (different semantic digests, different content)', () => {
    const { service } = composeOptimizationService();
    const document = authorTwoSubstitutableNodesDocument();
    const first = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_a',
    });
    const second = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_b',
    });
    expect(first.provenance.candidateDigest).not.toBe(second.provenance.candidateDigest);
    expect(
      computeWorkflowVersionSemanticDigest(first.candidateDocument).digest,
    ).not.toBe(computeWorkflowVersionSemanticDigest(second.candidateDocument).digest);

    // each candidate substitutes exactly its own node
    const firstCandidateNode = first.candidateDocument.ir.nodes.find((n) => n.id === 'scan_a')!;
    const secondCandidateNode = second.candidateDocument.ir.nodes.find((n) => n.id === 'scan_b')!;
    expect(firstCandidateNode.executionClass).toBe('deterministic_api');
    expect(secondCandidateNode.executionClass).toBe('deterministic_api');
    // the FIRST candidate leaves scan_b agentic; the SECOND leaves scan_a agentic
    expect(first.candidateDocument.ir.nodes.find((n) => n.id === 'scan_b')!.executionClass).toBe(
      'agentic_computer_use',
    );
    expect(second.candidateDocument.ir.nodes.find((n) => n.id === 'scan_a')!.executionClass).toBe(
      'agentic_computer_use',
    );
  });

  it('both candidates are each semantically equivalent to the shared baseline', () => {
    const { service } = composeOptimizationService();
    const document = authorTwoSubstitutableNodesDocument();
    for (const nodeId of ['scan_a', 'scan_b'] as const) {
      const proposal = service.createProposal({
        ownerId: BASELINE.ownerId,
        workflowId: BASELINE.workflowId,
        versionId: BASELINE.versionId,
        document,
        opportunityNodeId: nodeId,
      });
      expect(proposal.comparison.correctness.equivalent).toBe(true);
      expect(proposal.comparison.negotiation.decision).toBe('accept');
    }
  });
});
