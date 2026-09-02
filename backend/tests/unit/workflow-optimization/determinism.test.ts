import { describe, it, expect } from 'vitest';
import {
  authorCleanSubstitutableDocument,
  BASELINE,
  composeOptimizationService,
} from './helpers.js';

/**
 * V2-011 — full-pipeline determinism: two INDEPENDENT service
 * compositions (own stores, same deterministic factory seeds) produce
 * byte-identical proposal lifecycle records for the same inputs —
 * analysis → proposal → approval → materialization included. The module
 * contains zero wall clock, zero randomness, zero network.
 */
describe('V2-011 — the full lifecycle is deterministic across independent compositions', () => {
  async function runFullLifecycle() {
    const { service } = composeOptimizationService();
    const analysis = service.analyzeWorkflow(authorCleanSubstitutableDocument());
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });
    await service.approveProposal({
      proposalId: proposal.id,
      ownerId: BASELINE.ownerId,
      note: 'determinism run',
    });
    const materialized = await service.materializeProposal({
      proposalId: proposal.id,
      ownerId: BASELINE.ownerId,
    });
    return { analysis, materialized };
  }

  it('two fresh compositions produce identical analysis + materialized proposal records', async () => {
    const first = await runFullLifecycle();
    const second = await runFullLifecycle();
    expect(second.analysis).toEqual(first.analysis);
    expect(second.materialized.proposal).toEqual(first.materialized.proposal);
    expect(second.materialized.materialization).toEqual(first.materialized.materialization);
  });

  it('repeated analyses of the same document never drift (100 identical derivations)', () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const first = service.analyzeWorkflow(document);
    for (let i = 0; i < 100; i += 1) {
      expect(service.analyzeWorkflow(document)).toEqual(first);
    }
  });
});
