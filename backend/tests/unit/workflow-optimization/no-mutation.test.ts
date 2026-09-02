import { describe, it, expect } from 'vitest';
import {
  authorCleanSubstitutableDocument,
  BASELINE,
  composeOptimizationService,
  documentToPlainJson,
} from './helpers.js';
import {
  computeWorkflowVersionSemanticDigest,
} from '../../../src/workflow-ir/index.js';

/**
 * V2-011 — NO SILENT MUTATION (the required regression).
 *
 * The baseline WorkflowVersion is never touched: analysis, proposal
 * creation and materialization all consume the baseline document
 * read-only (deep-cloned internally); every record handed out is
 * deep-frozen; the proposed change ALWAYS materializes as a NEW
 * WorkflowVersion (a new version id through the materializer port, with
 * the baseline as the parent) — never an edit of the baseline.
 */
describe('V2-011 — the baseline document is never mutated', () => {
  it('analysis + proposal + materialization leave the input document unchanged', async () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const before = documentToPlainJson(document);

    service.analyzeWorkflow(document);
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_board',
    });
    await service.approveProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });
    await service.materializeProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });

    expect(documentToPlainJson(document)).toEqual(before);
    // the baseline's semantic digest is unchanged too
    expect(computeWorkflowVersionSemanticDigest(document).digest).toBe(
      proposal.provenance.baseline.semanticDigest,
    );
  });
});

describe('V2-011 — handed-out records are deep-frozen', () => {
  it('proposal records (and their embedded documents) reject mutation', () => {
    const { service } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });
    expect(() => {
      (proposal as { status: string }).status = 'approved';
    }).toThrow();
    expect(() => {
      (proposal as { candidateDocument: { ir: { start: string } } }).candidateDocument.ir.start = 'x';
    }).toThrow();
    expect(() => {
      (proposal as { baselineDocument: { ir: { start: string } } }).baselineDocument.ir.start = 'x';
    }).toThrow();
    expect(() => {
      (proposal as { provenance: { rulesVersion: string } }).provenance.rulesVersion = 'x';
    }).toThrow();
  });
});

describe('V2-011 — materialization creates a NEW WorkflowVersion (never an edit)', () => {
  it('the materializer is called once, with the candidate content and the baseline as parent', async () => {
    const { service, materializer } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document,
      opportunityNodeId: 'scan_board',
    });
    await service.approveProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });
    const result = await service.materializeProposal({
      proposalId: proposal.id,
      ownerId: BASELINE.ownerId,
    });

    // exactly ONE version-creation call
    expect(materializer.calls).toHaveLength(1);
    const call = materializer.calls[0]!;
    // the call creates a version of the SAME workflow, parented on the baseline
    expect(call.workflowId).toBe(BASELINE.workflowId);
    expect(call.parentVersionId).toBe(BASELINE.versionId);
    // the carried content IS the candidate document (canonical serialization)
    expect(call.content).toEqual(documentToPlainJson(proposal.candidateDocument));
    expect(call.protocol.irSchemaVersion).toBe('workflowos-workflow-ir-v1');

    // the materialized version id is a NEW identity — never the baseline's
    expect(result.materialization.versionId).not.toBe(BASELINE.versionId);
    expect(result.materialization.workflowId).toBe(BASELINE.workflowId);
    expect(result.materialization.candidateDigest).toBe(proposal.provenance.candidateDigest);

    // the recorded candidate never changed across the materialization
    const after = service.getProposal(proposal.id);
    expect(computeWorkflowVersionSemanticDigest(after.candidateDocument).digest).toBe(
      proposal.provenance.candidateDigest,
    );
  });

  it('materializing twice is rejected (one candidate version per proposal)', async () => {
    const { service } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });
    await service.approveProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });
    await service.materializeProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });
    await expect(
      service.materializeProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_ALREADY_MATERIALIZED' });
  });
});
