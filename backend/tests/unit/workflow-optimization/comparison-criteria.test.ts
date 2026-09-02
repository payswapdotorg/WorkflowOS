import { describe, it, expect } from 'vitest';
import {
  authorCleanSubstitutableDocument,
  authorReuseDocument,
  BASELINE,
  composeOptimizationService,
} from './helpers.js';
import { OPTIMIZATION_RUBRIC, OPTIMIZATION_RULES_VERSION } from '../../../src/workflow-optimization/index.js';

/**
 * V2-011 — deterministic comparison criteria (the must-deliver).
 *
 * Correctness, latency, cost, reliability and maintenance: the frozen
 * modeled rubric over DECLARED facts. Every number below is pinned: the
 * clean fixture is 5 nodes (d, agentic, h, d, h) and the substitution
 * turns the single agentic node into a deterministic API call.
 */
describe('V2-011 — the frozen rubric', () => {
  it('the rubric is frozen and carries the rules version', () => {
    expect(OPTIMIZATION_RUBRIC.rulesVersion).toBe(OPTIMIZATION_RULES_VERSION);
    expect(OPTIMIZATION_RUBRIC.latencyUnitsPerExecutionClass).toEqual({
      deterministic_api: 1,
      agentic_computer_use: 3,
      human: 1,
      subworkflow: 1,
    });
    expect(OPTIMIZATION_RUBRIC.costUnitsPerExecutionClass).toEqual({
      deterministic_api: 1,
      agentic_computer_use: 4,
      human: 0,
      subworkflow: 1,
    });
    expect(OPTIMIZATION_RUBRIC.maintenanceWeights).toEqual({
      perNode: 1,
      perDuplicateNode: 2,
      perAgenticNode: 1,
    });
    expect(() => {
      (OPTIMIZATION_RUBRIC as { rulesVersion: string }).rulesVersion = 'x';
    }).toThrow();
  });
});

describe('V2-011 — the api_substitution comparison deltas (all five criteria)', () => {
  it('latency, cost, reliability and maintenance all improve; correctness is proven FIRST', () => {
    const { service } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorCleanSubstitutableDocument(),
      opportunityNodeId: 'scan_board',
    });
    const { comparison } = proposal;

    // CORRECTNESS FIRST (the proof, not a score)
    expect(comparison.correctness.equivalent).toBe(true);

    // latency: d1 + a3 + h1 + d1 + h1 = 7  →  d1 + d1 + h1 + d1 + h1 = 5
    expect(comparison.latency).toEqual({ baseline: 7, candidate: 5, delta: -2 });
    // cost: 1 + 4 + 0 + 1 + 0 = 6  →  1 + 1 + 0 + 1 + 0 = 3
    expect(comparison.cost).toEqual({ baseline: 6, candidate: 3, delta: -3 });
    // reliability (modeled failure weight): .02 + .15 + .05 + .02 + .05 = .29 → .16
    expect(comparison.reliability.baseline).toBeCloseTo(0.29, 10);
    expect(comparison.reliability.candidate).toBeCloseTo(0.16, 10);
    expect(comparison.reliability.delta).toBeCloseTo(-0.13, 10);
    // maintenance: 5 nodes + 2·0 duplicates + 1 agentic = 6  →  5 + 0 + 0 = 5
    expect(comparison.maintenanceBreakdown.baseline).toEqual({
      nodeCount: 5,
      duplicateNodeCount: 0,
      agenticNodeCount: 1,
      score: 6,
    });
    expect(comparison.maintenanceBreakdown.candidate).toEqual({
      nodeCount: 5,
      duplicateNodeCount: 0,
      agenticNodeCount: 0,
      score: 5,
    });
    expect(comparison.maintenance).toEqual({ baseline: 6, candidate: 5, delta: -1 });
  });
});

describe('V2-011 — the workflow_reuse comparison deltas', () => {
  it('maintenance improves (duplication removed); delegation costs are reported honestly', () => {
    const { service } = composeOptimizationService();
    const proposal = service.createProposal({
      ownerId: BASELINE.ownerId,
      workflowId: BASELINE.workflowId,
      versionId: BASELINE.versionId,
      document: authorReuseDocument(),
      opportunityNodeId: 'normalize_b',
      reuseTarget: { workflowId: 'wf-existing-normalizer', versionRef: 'wfv_normalizer_v1' },
    });
    const { comparison } = proposal;

    expect(comparison.correctness.equivalent).toBe(true);
    // the reuse fixture is 6 nodes (d, d, d, h, d, h) with one duplicated pair
    // latency: 6 → 6 (subworkflow 1 == deterministic 1)
    expect(comparison.latency).toEqual({ baseline: 6, candidate: 6, delta: 0 });
    // cost: 1+1+1+0+1+0 = 4 → 4
    expect(comparison.cost).toEqual({ baseline: 4, candidate: 4, delta: 0 });
    // reliability: the delegation is modeled slightly LESS reliable (.03 vs .02)
    expect(comparison.reliability.baseline).toBeCloseTo(0.18, 10);
    expect(comparison.reliability.candidate).toBeCloseTo(0.19, 10);
    expect(comparison.reliability.delta).toBeCloseTo(0.01, 10);
    // maintenance: 6 nodes + 2·1 duplicate + 0 agentic = 8  →  6 + 0 + 0 = 6
    expect(comparison.maintenanceBreakdown.baseline).toEqual({
      nodeCount: 6,
      duplicateNodeCount: 1,
      agenticNodeCount: 0,
      score: 8,
    });
    expect(comparison.maintenanceBreakdown.candidate).toEqual({
      nodeCount: 6,
      duplicateNodeCount: 0,
      agenticNodeCount: 0,
      score: 6,
    });
    expect(comparison.maintenance).toEqual({ baseline: 8, candidate: 6, delta: -2 });
  });
});

describe('V2-011 — comparison determinism', () => {
  it('the same two documents always compare identically', () => {
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
    // same documents → identical comparison records (only provenance differs)
    expect(second.comparison).toEqual(first.comparison);
    // and the standalone comparison is stable too
    expect(
      service.compareVersions(document, first.candidateDocument),
    ).toEqual(first.comparison);
    expect(
      service.compareVersions(document, first.candidateDocument),
    ).toEqual(service.compareVersions(document, first.candidateDocument));
  });
});
