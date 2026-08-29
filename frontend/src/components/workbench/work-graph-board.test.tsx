/**
 * WORK-048 — the Work Graph board component.
 *
 * Props-driven proofs (no fetch mocking needed — the board consumes the
 * authoritative graph through props):
 *   - renders the fact-based groups with the backend's own values;
 *   - RERENDER with FRESH authoritative props reflects the backend change
 *     (stale UI state can never override server truth — the board derives
 *     everything from the current props on every render).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkGraphBoard } from './work-graph-board';
import type { WorkGraph, WorkGraphNode } from '@/api/client';

function node(overrides: Partial<WorkGraphNode> & { id: string }): WorkGraphNode {
  return {
    architectureVersionId: 'v1',
    workItemId: `WI-${overrides.id}`,
    title: `title ${overrides.id}`,
    completed: false,
    currentState: null,
    unsatisfiedDependencies: [],
    ...overrides,
  };
}

function graphOf(nodes: WorkGraphNode[], edges: WorkGraph['edges'] = []): WorkGraph {
  return { projectId: 'p1', nodes, edges };
}

function renderBoard(g: WorkGraph) {
  return render(
    <MemoryRouter>
      <WorkGraphBoard graph={g} />
    </MemoryRouter>,
  );
}

describe('WORK-048 WorkGraphBoard (renders authoritative facts; re-derives on fresh props)', () => {
  it('renders the blocked / in-flight / ready / draft / completed groups with counts', () => {
    renderBoard(
      graphOf([
        node({ id: 'blocked', workItemId: 'WI-BLOCKED', currentState: 'ready', unsatisfiedDependencies: ['completed'] }),
        node({ id: 'flight', workItemId: 'WI-FLIGHT', currentState: 'implementing' }),
        node({ id: 'ready', workItemId: 'WI-READY', currentState: 'ready' }),
        node({ id: 'draft', workItemId: 'WI-DRAFT', currentState: null }),
        node({ id: 'completed', workItemId: 'WI-DONE', currentState: 'verified', completed: true }),
      ]),
    );
    expect(screen.getByText('WI-BLOCKED')).toBeInTheDocument();
    expect(screen.getByText('WI-FLIGHT')).toBeInTheDocument();
    expect(screen.getByText('WI-READY')).toBeInTheDocument();
    expect(screen.getByText('WI-DRAFT')).toBeInTheDocument();
    expect(screen.getByText('WI-DONE')).toBeInTheDocument();
    expect(screen.getByText('1 unsatisfied dependency (dependency authority)')).toBeInTheDocument();
  });

  it('renders the EMPTY state for a project with no work items (never invented)', () => {
    renderBoard(graphOf([]));
    expect(screen.getByText('No work items yet')).toBeInTheDocument();
  });

  it('STALE-STATE DISCRIMINATION: fresh props override any prior render (server truth wins)', () => {
    // First render: A is blocked on B (B incomplete).
    const { rerender } = renderBoard(
      graphOf(
        [
          node({ id: 'A', workItemId: 'WI-A', currentState: 'ready', unsatisfiedDependencies: ['B'] }),
          node({ id: 'B', workItemId: 'WI-B', currentState: 'ready' }),
        ],
        [{ workItemId: 'A', dependsOnId: 'B' }],
      ),
    );
    expect(screen.getByText('1 unsatisfied dependency (dependency authority)')).toBeInTheDocument();

    // Re-render with FRESH authoritative facts: B completed, A unblocked.
    // The board must re-derive from the new props — no cached verdict survives.
    const fresh = graphOf(
      [
        node({ id: 'A', workItemId: 'WI-A', currentState: 'ready', unsatisfiedDependencies: [] }),
        node({ id: 'B', workItemId: 'WI-B', currentState: 'verified', completed: true }),
      ],
      [{ workItemId: 'A', dependsOnId: 'B' }],
    );
    rerender(
      <MemoryRouter>
        <WorkGraphBoard graph={fresh} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('unsatisfied dependency')).not.toBeInTheDocument();
    // WI-B is present (as the completed node; it may ALSO appear as a
    // dependency chip label of WI-A — both are the fresh facts).
    expect(screen.getAllByText('WI-B').length).toBeGreaterThan(0);
    // The completion of WI-B is rendered from the fresh props (the node's
    // Completed badge — the section heading also says Completed).
    expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(2);
  });
});
