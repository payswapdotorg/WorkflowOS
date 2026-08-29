/**
 * WORK-048 — the Work Graph board.
 *
 * Renders the AUTHORITATIVE work-graph read model as fact-based groups
 * (blocked / in flight / ready / draft / completed) with per-node dependency
 * edges, blockers, and workflow states. Purely presentational: every value
 * comes from the backend graph (props); the grouping is a display concern
 * (see lib/work-graph.ts), never a workflow authority. Clicking a node
 * navigates to the authoritative Work Item page.
 */
import * as React from 'react';
import { Link } from 'react-router-dom';
import { Ban, CircleDot, CircleCheckBig, GitBranch, Layers } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/domain/empty-state';
import { StatusBadge } from '@/components/domain/status-badge';
import type { WorkGraph, WorkGraphNode } from '@/api/client';
import { dependencyNames, dependentsOf, groupNodes } from '@/lib/work-graph';

interface WorkGraphBoardProps {
  graph: WorkGraph;
}

function NodeCard({ graph, node }: { graph: WorkGraph; node: WorkGraphNode }) {
  const deps = dependencyNames(graph, node.id);
  const dependents = dependentsOf(graph, node.id);
  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/work-items/${node.id}`}
            className="font-mono text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {node.workItemId}
          </Link>
          <StatusBadge value={node.currentState} />
          {node.completed && <Badge variant="success">Completed</Badge>}
        </div>
        <div className="text-sm text-foreground">{node.title}</div>
        {node.objective && (
          <div className="line-clamp-2 text-xs text-muted-foreground">{node.objective}</div>
        )}
        {deps.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Depends on:</span>
            {deps.map((d) => (
              <Link
                key={d.id}
                to={`/work-items/${d.id}`}
                className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted/70"
              >
                {d.label}
                {d.completed && <CircleCheckBig className="h-3 w-3 text-success" aria-label="dependency complete" />}
              </Link>
            ))}
          </div>
        )}
        {node.unsatisfiedDependencies.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <Ban className="h-3.5 w-3.5" aria-hidden />
            {node.unsatisfiedDependencies.length} unsatisfied{' '}
            {node.unsatisfiedDependencies.length === 1 ? 'dependency' : 'dependencies'} (dependency authority)
          </div>
        )}
        {dependents.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Blocks:</span>
            {dependents.map((d) => (
              <span key={d.id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {d.label}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GroupSection({
  icon: Icon,
  title,
  description,
  nodes,
  graph,
  emptyLabel,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  nodes: WorkGraphNode[];
  graph: WorkGraph;
  emptyLabel: string;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant="secondary">{nodes.length}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      {nodes.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {nodes.map((n) => (
            <NodeCard key={n.id} graph={graph} node={n} />
          ))}
        </div>
      )}
    </section>
  );
}

export function WorkGraphBoard({ graph }: WorkGraphBoardProps) {
  const grouped = groupNodes(graph.nodes);
  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title="No work items yet"
        description="The project has no work items. Create them from Requirements or the Architect."
      />
    );
  }
  return (
    <div className="flex flex-col gap-6" data-testid="work-graph-board">
      <GroupSection
        icon={Ban}
        title="Blocked"
        description="Work items with unsatisfied dependencies (the dependency authority's verdict)."
        nodes={grouped.blocked}
        graph={graph}
        emptyLabel="Nothing is blocked."
      />
      <GroupSection
        icon={GitBranch}
        title="In flight"
        description="Live workflow states (implementing, PR open, verifying, reviewing, …)."
        nodes={grouped.inFlight}
        graph={graph}
        emptyLabel="No work items are in flight."
      />
      <GroupSection
        icon={CircleDot}
        title="Ready"
        description="Ready to begin (workflow state ready, dependencies satisfied)."
        nodes={grouped.ready}
        graph={graph}
        emptyLabel="No ready work items."
      />
      <GroupSection
        icon={Layers}
        title="Draft"
        description="Not yet started (no workflow state, or draft)."
        nodes={grouped.draft}
        graph={graph}
        emptyLabel="No draft work items."
      />
      <GroupSection
        icon={CircleCheckBig}
        title="Completed"
        description="Completed work items (the work item's own completion flag)."
        nodes={grouped.completed}
        graph={graph}
        emptyLabel="No completed work items yet."
      />
    </div>
  );
}
