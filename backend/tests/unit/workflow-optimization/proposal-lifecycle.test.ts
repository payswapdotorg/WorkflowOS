import { describe, it, expect } from 'vitest';
import {
  authorCleanSubstitutableDocument,
  authorReuseDocument,
  BASELINE,
  composeOptimizationService,
} from './helpers.js';

/**
 * V2-011 — the proposal lifecycle: the human/owner APPROVAL GATE.
 *
 * proposed → (owner approval) → materialized (a NEW candidate
 * WorkflowVersion through the port), with every premature or unauthorized
 * transition rejected typed and fail-closed. The module NEVER activates
 * anything — materialization only creates the candidate version.
 */
describe('V2-011 — the approval gate', () => {
  it('materialization BEFORE approval is rejected (the explicit human gate)', async () => {
    const { service, materializer } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });
    expect(proposal.status).toBe('proposed');
    expect(proposal.decision).toBeNull();
    expect(proposal.materialization).toBeNull();

    await expect(
      service.materializeProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(materializer.calls).toHaveLength(0);
    expect(service.getProposal(proposal.id).status).toBe('proposed');
  });

  it('the full approved path: approve → materialize → materialized', async () => {
    const { service, materializer } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });

    const approved = await service.approveProposal({
      proposalId: proposal.id,
      ownerId: BASELINE.ownerId,
      note: 'API is stable — approved for evaluation',
    });
    expect(approved.status).toBe('approved');
    expect(approved.decision?.ownerId).toBe(BASELINE.ownerId);
    expect(approved.decision?.decidedAt).toBeGreaterThan(0);
    expect(approved.decision?.note).toBe('API is stable — approved for evaluation');

    const result = await service.materializeProposal({
      proposalId: proposal.id,
      ownerId: BASELINE.ownerId,
    });
    expect(result.proposal.status).toBe('materialized');
    expect(result.materialization.versionId).toBe('wfv_scripted_1');
    expect(result.proposal.materialization?.versionId).toBe('wfv_scripted_1');
    expect(materializer.calls).toHaveLength(1);

    // the recorded proposal reflects the materialization
    const stored = service.getProposal(proposal.id);
    expect(stored.status).toBe('materialized');
    expect(stored.materialization?.workflowId).toBe(BASELINE.workflowId);
  });

  it('decisions are single-shot: double-approve and approve-after-reject are rejected', async () => {
    const { service } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });
    await service.approveProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });
    expect(() =>
      service.approveProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId }),
    ).toThrow(/PROPOSAL_ALREADY_DECIDED/);
    expect(() =>
      service.rejectProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId }),
    ).toThrow(/PROPOSAL_ALREADY_DECIDED/);
  });

  it('rejection is terminal: a rejected proposal can never be materialized', async () => {
    const { service, materializer } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });
    const rejected = await service.rejectProposal({
      proposalId: proposal.id,
      ownerId: BASELINE.ownerId,
      note: 'Keep the agent loop — the board UI is the source of truth',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.decision?.note).toBe('Keep the agent loop — the board UI is the source of truth');

    await expect(
      service.materializeProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_NOT_APPROVED' });
    expect(materializer.calls).toHaveLength(0);
  });

  it('only the owner may act (typed OWNER_MISMATCH otherwise)', async () => {
    const { service } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });
    expect(() =>
      service.approveProposal({ proposalId: proposal.id, ownerId: 'someone-else' }),
    ).toThrow(/OWNER_MISMATCH/);
    await service.approveProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });
    await expect(
      service.materializeProposal({ proposalId: proposal.id, ownerId: 'someone-else' }),
    ).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
    expect(service.getProposal(proposal.id).status).toBe('approved');
  });
});

describe('V2-011 — reuse proposals require an explicit target to materialize', () => {
  it('a reuse proposal without a target is a suggestion (REUSE_TARGET_REQUIRED at materialization)', async () => {
    const { service, materializer } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorReuseDocument(),
      opportunityNodeId: 'normalize_b',
    });
    expect(proposal.kind).toBe('workflow_reuse');
    expect(proposal.reuseTarget).toBeNull();

    await service.approveProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });
    await expect(
      service.materializeProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId }),
    ).rejects.toMatchObject({ code: 'REUSE_TARGET_REQUIRED' });
    expect(materializer.calls).toHaveLength(0);
  });

  it('a reuse proposal WITH an explicit existing-workflow target materializes', async () => {
    const { service, materializer } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorReuseDocument(),
      opportunityNodeId: 'normalize_b',
      reuseTarget: { workflowId: 'wf-existing-normalizer', versionRef: 'wfv_normalizer_v1' },
    });
    expect(proposal.reuseTarget).toEqual({
      workflowId: 'wf-existing-normalizer',
      versionRef: 'wfv_normalizer_v1',
    });

    await service.approveProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });
    const result = await service.materializeProposal({
      proposalId: proposal.id,
      ownerId: BASELINE.ownerId,
    });
    expect(result.proposal.status).toBe('materialized');
    expect(materializer.calls).toHaveLength(1);
  });
});

describe('V2-011 — materializer failures are typed and leave the proposal approved', () => {
  it('a failing materializer rejects with MATERIALIZER_FAILED and no record is written', async () => {
    const { service, materializer } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });
    await service.approveProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId });
    materializer.failure = new Error('repository unavailable');

    await expect(
      service.materializeProposal({ proposalId: proposal.id, ownerId: BASELINE.ownerId }),
    ).rejects.toMatchObject({ code: 'MATERIALIZER_FAILED' });
    // the materializer WAS called (the failure is the port's), but no
    // materialization record exists and the proposal stays approved
    expect(materializer.calls).toHaveLength(1);
    const stored = service.getProposal(proposal.id);
    expect(stored.status).toBe('approved');
    expect(stored.materialization).toBeNull();
  });
});

describe('V2-011 — listing and reading', () => {
  it('unknown proposals are typed PROPOSAL_NOT_FOUND', () => {
    const { service } = composeOptimizationService();
    expect(() => service.getProposal('opt_unknown')).toThrowError(/PROPOSAL_NOT_FOUND/);
  });

  it('listProposals returns creation order and filters by workflow', () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const first = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: 'wf-one',
      versionId: 'wfv-one-v1',
      document,
      opportunityNodeId: 'scan_board',
    });
    const second = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: 'wf-two',
      versionId: 'wfv-two-v1',
      document,
      opportunityNodeId: 'scan_board',
    });
    expect(service.listProposals().map((p) => p.id)).toEqual([first.id, second.id]);
    expect(service.listProposals({ workflowId: 'wf-two' }).map((p) => p.id)).toEqual([second.id]);
    expect(service.listProposals({ workflowId: 'wf-none' })).toEqual([]);
  });
});
