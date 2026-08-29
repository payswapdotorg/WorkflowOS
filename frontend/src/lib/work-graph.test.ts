/**
 * WORK-048 — the pure work-graph presentation helpers.
 *
 * These tests prove the helpers are PURE over the authoritative facts:
 * classification, counting, and attention derivation NEVER invent state,
 * and the SAME facts always produce the SAME output. The refresh-consistency
 * case (new authoritative facts → new derived output) is the frontend half
 * of the "backend state changes are reflected after refresh" adversarial
 * requirement — the helpers can never return a stale verdict for fresh facts.
 */
import { describe, it, expect } from 'vitest';
import { countByState, dependentsOf, dependencyNames, deriveAttention, groupNodes } from './work-graph';
import type { WorkGraph, WorkGraphNode } from '@/api/client';

function node(overrides: Partial<WorkGraphNode> & { id: string }): WorkGraphNode {
  return {
    architectureVersionId: 'v1',
    workItemId: `WI-${overrides.id.slice(0, 4)}`,
    title: `title ${overrides.id}`,
    completed: false,
    currentState: null,
    unsatisfiedDependencies: [],
    ...overrides,
  };
}

function graph(nodes: WorkGraphNode[], edges: WorkGraph['edges']): WorkGraph {
  return { projectId: 'p1', nodes, edges };
}

describe('WORK-048 work-graph helpers (pure presentation over authoritative facts)', () => {
  it('groups nodes by FACTS: completion flag, unsatisfied dependencies, workflow state', () => {
    const nodes = [
      node({ id: 'completed1', completed: true, currentState: 'verified' }),
      node({ id: 'blocked1', currentState: 'ready', unsatisfiedDependencies: ['completed1'] }),
      node({ id: 'ready1', currentState: 'ready' }),
      node({ id: 'draft1', currentState: null }),
      node({ id: 'flight1', currentState: 'implementing' }),
    ];
    const grouped = groupNodes(nodes);
    expect(grouped.completed.map((n) => n.id)).toEqual(['completed1']);
    expect(grouped.blocked.map((n) => n.id)).toEqual(['blocked1']);
    expect(grouped.ready.map((n) => n.id)).toEqual(['ready1']);
    expect(grouped.draft.map((n) => n.id)).toEqual(['draft1']);
    expect(grouped.inFlight.map((n) => n.id)).toEqual(['flight1']);
  });

  it('a completed node is completed EVEN IF it has unsatisfied dependencies (the completion flag is the fact)', () => {
    const grouped = groupNodes([node({ id: 'c1', completed: true, unsatisfiedDependencies: ['x'] })]);
    expect(grouped.completed.map((n) => n.id)).toEqual(['c1']);
    expect(grouped.blocked).toEqual([]);
  });

  it('counts by the workflow authority\'s own state values (deterministic order)', () => {
    const nodes = [
      node({ id: 'a', currentState: 'ready' }),
      node({ id: 'b', currentState: 'ready' }),
      node({ id: 'c', currentState: 'implementing' }),
      node({ id: 'd', currentState: null }),
    ];
    expect(countByState(nodes)).toEqual([
      { state: 'ready', count: 2 },
      { state: 'implementing', count: 1 },
      { state: 'no workflow state', count: 1 },
    ]);
  });

  it('REFRESH CONSISTENCY: fresh authoritative facts produce the fresh verdict — never a cached one', () => {
    // Before: B is incomplete, so A is blocked.
    const before = graph(
      [node({ id: 'A', currentState: 'ready', unsatisfiedDependencies: ['B'] }), node({ id: 'B', currentState: 'ready' })],
      [{ workItemId: 'A', dependsOnId: 'B' }],
    );
    expect(groupNodes(before.nodes).blocked.map((n) => n.id)).toEqual(['A']);

    // The backend changes: B completes. The SAME helpers over the FRESH graph
    // must produce the fresh verdict (A is no longer blocked).
    const after = graph(
      [
        node({ id: 'A', currentState: 'ready', unsatisfiedDependencies: [] }),
        node({ id: 'B', currentState: 'verified', completed: true }),
      ],
      [{ workItemId: 'A', dependsOnId: 'B' }],
    );
    expect(groupNodes(after.nodes).blocked).toEqual([]);
    expect(groupNodes(after.nodes).ready.map((n) => n.id)).toEqual(['A']);
  });

  it('derives attention from facts only — blocked work, running executions, failed verification, reviews in progress, high-severity maintenance', () => {
    const g = graph(
      [node({ id: 'blocked', currentState: 'ready', unsatisfiedDependencies: ['dep1'], workItemId: 'WI-001' })],
      [],
    );
    const attention = deriveAttention({
      graph: g,
      executions: [
        { executionId: 'e1', mode: 'native', provider: 'p', model: 'm', status: 'running', agentRunId: null, externalSessionRef: null, repository: null, branch: null, promptDigest: '', benchmarkMetadata: {}, startedAt: null, completedAt: null, expiresAt: null, createdAt: '', updatedAt: '' },
        { executionId: 'e2', mode: 'native', provider: 'p', model: 'm', status: 'completed', agentRunId: null, externalSessionRef: null, repository: null, branch: null, promptDigest: '', benchmarkMetadata: {}, startedAt: null, completedAt: null, expiresAt: null, createdAt: '', updatedAt: '' },
      ],
      verificationRuns: [
        { id: 'run-1', projectId: 'p1', workItemId: 'w-1', workOrderId: null, architectureVersionId: 'v', source: 'manual', sourceRef: null, status: 'failed', executionId: 'e1', startedAt: null, finishedAt: null, summary: null, errorMetadata: null, createdAt: '', updatedAt: '' },
      ],
      reviews: [
        { id: 'rev-1', workItemId: 'w-1', status: 'in_progress', outcome: null, summary: null, source: 'architect-llm', reviewer: null },
      ],
      maintenanceHealth: {
        architectureVersionId: 'v',
        totalSignals: 1,
        byCategory: { vulnerability: 1 },
        bySeverity: { high: 1 },
        signals: [
          {
            workItemId: 'w-maint',
            workItemHumanId: 'WI-MAINT',
            title: 'Upgrade dependency X',
            objective: null,
            scope: null,
            completed: false,
            planner: {
              source: 'maintenance',
              priority: 'high',
              rationale: 'r',
              whyNow: 'w',
              expectedImpact: 'i',
              maintenance: { category: 'vulnerability', severity: 'high' },
            },
          },
        ],
      },
    });
    const kinds = attention.map((a) => a.kind);
    expect(kinds).toContain('blocked-work');
    expect(kinds).toContain('running-execution');
    expect(kinds).toContain('failed-verification');
    expect(kinds).toContain('review-in-progress');
    expect(kinds).toContain('maintenance-signal');
    // Deterministic: the same facts produce the identical list.
    expect(deriveAttention({
      graph: g,
      executions: [{ executionId: 'e1', mode: 'native', provider: 'p', model: 'm', status: 'running', agentRunId: null, externalSessionRef: null, repository: null, branch: null, promptDigest: '', benchmarkMetadata: {}, startedAt: null, completedAt: null, expiresAt: null, createdAt: '', updatedAt: '' }],
      verificationRuns: [],
      reviews: [],
    }).map((a) => a.kind)).toEqual(['blocked-work', 'running-execution']);
  });

  it('derives NOTHING when nothing needs attention (never invented)', () => {
    const g = graph([node({ id: 'ok', currentState: 'ready' })], []);
    expect(
      deriveAttention({ graph: g, executions: [], verificationRuns: [], reviews: [], maintenanceHealth: null }),
    ).toEqual([]);
  });

  it('derives NOTHING when the graph itself is unavailable (missing data ≠ invented data)', () => {
    expect(deriveAttention({ graph: null })).toEqual([]);
  });

  it('resolves dependency + dependent names from the graph itself (never a guess)', () => {
    const g = graph(
      [
        node({ id: 'A', workItemId: 'WI-A' }),
        node({ id: 'B', workItemId: 'WI-B' }),
        node({ id: 'C', workItemId: 'WI-C' }),
      ],
      [
        { workItemId: 'A', dependsOnId: 'B' },
        { workItemId: 'A', dependsOnId: 'C' },
        { workItemId: 'C', dependsOnId: 'B' },
      ],
    );
    expect(dependencyNames(g, 'A')).toEqual([
      { id: 'B', label: 'WI-B', completed: false },
      { id: 'C', label: 'WI-C', completed: false },
    ]);
    expect(dependentsOf(g, 'B')).toEqual([
      { id: 'A', label: 'WI-A' },
      { id: 'C', label: 'WI-C' },
    ]);
    expect(dependencyNames(g, 'B')).toEqual([]);
  });
});
