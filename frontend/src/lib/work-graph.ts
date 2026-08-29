/**
 * WORK-048 — pure presentation helpers over the work-graph read model.
 *
 * EVERY function here is PURE over its inputs: it classifies and counts the
 * AUTHORITATIVE facts the backend returned (workflow states, unsatisfied
 * dependencies, completion flags, verification/review/execution records) —
 * it never invents state, never queries anything, and never mutates
 * anything. The backend remains the authority; these helpers only shape
 * authoritative facts for display.
 */

import type {
  WorkGraph,
  WorkGraphNode,
  ExecutionSummary,
  VerificationRun,
  Review,
  MaintenanceHealth,
} from '@/api/client';

/** A fact-based display grouping (never a workflow authority). */
export type NodeGroup = 'blocked' | 'inFlight' | 'ready' | 'draft' | 'completed';

export interface GroupedNodes {
  blocked: WorkGraphNode[];
  inFlight: WorkGraphNode[];
  ready: WorkGraphNode[];
  draft: WorkGraphNode[];
  completed: WorkGraphNode[];
}

/**
 * Group nodes by AUTHORITATIVE facts only:
 *   - completed  — the work item's own `completed` flag;
 *   - blocked    — the dependency authority reports unsatisfied dependencies;
 *   - ready      — the workflow authority says the state is `ready`;
 *   - draft      — no workflow state yet (or literally `draft`);
 *   - inFlight   — any other live workflow state (implementing, pr_open,
 *                  verifying, … — the authority's own values, passed through).
 */
export function groupNodes(nodes: readonly WorkGraphNode[]): GroupedNodes {
  const grouped: GroupedNodes = {
    blocked: [], inFlight: [], ready: [], draft: [], completed: [],
  };
  for (const n of nodes) {
    if (n.completed) {
      grouped.completed.push(n);
    } else if (n.unsatisfiedDependencies.length > 0) {
      grouped.blocked.push(n);
    } else if (n.currentState === 'ready') {
      grouped.ready.push(n);
    } else if (n.currentState === null || n.currentState === 'draft') {
      grouped.draft.push(n);
    } else {
      grouped.inFlight.push(n);
    }
  }
  return grouped;
}

/** Count nodes per workflow state (the authority's own state values, title-cased keys). */
export function countByState(nodes: readonly WorkGraphNode[]): Array<{ state: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = n.currentState ?? 'no workflow state';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));
}

export interface AttentionItem {
  kind: 'blocked-work' | 'failed-verification' | 'review-in-progress' | 'running-execution' | 'maintenance-signal';
  label: string;
  detail: string;
  /** Where to look next (a workbench tab or a work item route). */
  href?: string;
}

/**
 * Derive "what needs attention" from the loaded authoritative facts. Pure:
 * the SAME facts always produce the SAME attention list (deterministic
 * order); when nothing needs attention the list is empty (never invented).
 */
export function deriveAttention(input: {
  graph: WorkGraph | null;
  executions?: readonly ExecutionSummary[];
  verificationRuns?: readonly VerificationRun[];
  reviews?: readonly Review[];
  maintenanceHealth?: MaintenanceHealth | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { graph, executions = [], verificationRuns = [], reviews = [], maintenanceHealth = null } = input;

  if (graph) {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const n of graph.nodes) {
      if (!n.completed && n.unsatisfiedDependencies.length > 0) {
        const names = n.unsatisfiedDependencies
          .map((id) => nodeById.get(id)?.workItemId ?? id.slice(0, 8));
        items.push({
          kind: 'blocked-work',
          label: `${n.workItemId} is blocked`,
          detail: `waiting on ${names.join(', ')} (dependency authority)`,
          href: `/work-items/${n.id}`,
        });
      }
    }
    for (const e of executions) {
      if (e.status === 'running' || e.status === 'queued' || e.status === 'submitted') {
        items.push({
          kind: 'running-execution',
          label: `${e.provider}${e.model ? ` / ${e.model}` : ''} is executing`,
          detail: `execution ${e.executionId} (${e.mode})`,
          href: e.workItemId ? `/work-items/${e.workItemId}` : undefined,
        });
      }
    }
    for (const run of verificationRuns) {
      if (run.status === 'failed') {
        items.push({
          kind: 'failed-verification',
          label: `Verification failed for ${run.workItemId.slice(0, 8)}`,
          detail: `run ${run.id.slice(0, 8)} (${run.source})`,
          href: `/work-items/${run.workItemId}`,
        });
      }
    }
    for (const review of reviews) {
      if (review.status === 'in_progress') {
        items.push({
          kind: 'review-in-progress',
          label: `Architect review in progress for ${review.workItemId.slice(0, 8)}`,
          detail: `review ${review.id.slice(0, 8)} (${review.source})`,
          href: `/work-items/${review.workItemId}`,
        });
      }
    }
    if (maintenanceHealth) {
      for (const signal of maintenanceHealth.signals) {
        const severity = signal.planner.maintenance?.severity;
        if (!signal.completed && (severity === 'critical' || severity === 'high')) {
          items.push({
            kind: 'maintenance-signal',
            label: `Maintenance: ${signal.title}`,
            detail: `${signal.planner.maintenance?.category ?? 'unknown category'} (${severity})`,
            href: `/work-items/${signal.workItemId}`,
          });
        }
      }
    }
  }
  return items.slice(0, 25);
}

/** Resolve a node's dependency display names (the graph's own edges + nodes — never a guess). */
export function dependencyNames(
  graph: WorkGraph,
  nodeId: string,
): Array<{ id: string; label: string; completed: boolean }> {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const direct = new Set(
    graph.edges.filter((e) => e.workItemId === nodeId).map((e) => e.dependsOnId),
  );
  return [...direct].map((id) => {
    const node = nodeById.get(id);
    return {
      id,
      label: node?.workItemId ?? id.slice(0, 8),
      completed: node?.completed ?? false,
    };
  });
}

/** Which nodes depend on the given node (the reverse edges — facts from the graph). */
export function dependentsOf(
  graph: WorkGraph,
  nodeId: string,
): Array<{ id: string; label: string }> {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .filter((e) => e.dependsOnId === nodeId)
    .map((e) => ({
      id: e.workItemId,
      label: nodeById.get(e.workItemId)?.workItemId ?? e.workItemId.slice(0, 8),
    }));
}
