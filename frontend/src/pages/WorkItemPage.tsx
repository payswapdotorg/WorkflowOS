import { Play, GitMerge, CheckCircle2, FlaskConical, FileCheck, Activity, Rocket, Target, ListTree, ShieldCheck } from 'lucide-react';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { AdvisoryCard } from '@/components/domain/advisory-card';
import { useParams, Link } from 'react-router-dom';
import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusBadge } from '@/components/domain/status-badge';
import { WorkflowTimeline } from '@/components/domain/workflow-timeline';
import { ExecutionModeDialog } from '@/components/execution/ExecutionModeDialog';
import { ExternalExecutionDialog } from '@/components/execution/ExternalExecutionDialog';
import {
  workItems, workflow, agentRuns, reviews, verification, audit,
  execution, executionProviders,
  type WorkItem, type WorkflowExecution, type WorkflowTransition,
  type WorkOrder, type PrAssociation, type AgentRun,
  type Review, type ReviewFinding, type AuditEvent,
  type VerificationRun, type VerificationEvidence,
  type ExecutionMode, type ExecutionSummary, type ExecutionProviderInfo,
  type WorkItemDependency, type MergeGateResult,
  ApiError,
} from '@/api/client';

export default function WorkItemPage() {
  const { workItemId } = useParams<{ workItemId: string }>();

  // --- Each resource has its own explicitly-named state ---
  const [workItem, setWorkItem] = useState<WorkItem | null>(null);
  const [workflowState, setWorkflowState] = useState<WorkflowExecution | null>(null);
  const [workflowHistory, setWorkflowHistory] = useState<WorkflowTransition[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [prAssociations, setPrAssociations] = useState<PrAssociation[]>([]);
  const [agentRunList, setAgentRunList] = useState<AgentRun[]>([]);
  const [reviewList, setReviewList] = useState<Review[]>([]);
  const [reviewFindings, setReviewFindings] = useState<Record<string, ReviewFinding[]>>({});
  const [auditList, setAuditList] = useState<AuditEvent[]>([]);
  const [verRuns, setVerRuns] = useState<VerificationRun[]>([]);
  const [verEvidence, setVerEvidence] = useState<Record<string, VerificationEvidence[]>>({});

  // WORK-048: dependencies (the dependency authority) + merge gates (the
  // workflow authority's own readiness picture).
  const [dependencies, setDependencies] = useState<WorkItemDependency[]>([]);
  const [dependencyItems, setDependencyItems] = useState<Record<string, WorkItem | null>>({});
  const [mergeReadiness, setMergeReadiness] = useState<MergeGateResult | null>(null);

  // WORK-027: execution mode selection + external handoff state.
  const [executions, setExecutions] = useState<ExecutionSummary[]>([]);
  const [executionProviderList, setExecutionProviderList] = useState<ExecutionProviderInfo[]>([]);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [externalDialogExecution, setExternalDialogExecution] = useState<ExecutionSummary | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const loadAll = useCallback(async () => {
    if (!workItemId) return;
    // WORK-027: refreshes never flip `loading` back on — the initial mount
    // state (true) covers the first load, and refreshes keep the DOM mounted
    // so dialog state (e.g. the external handoff package view) survives
    // background reloads after actions.
    setError(null);
    try {
      // --- Explicitly named variables for each resource ---
      const item = await workItems.get(workItemId);
      setWorkItem(item);

      const wfState = await workflow.getState(workItemId).catch(() => null);
      setWorkflowState(wfState);

      const history = await workflow.getHistory(workItemId).catch(() => [] as WorkflowTransition[]);
      setWorkflowHistory(history);

      const wos = await workItems.listWorkOrders(workItemId).catch(() => []);
      setWorkOrders(wos);

      const prs = await workItems.listPrAssociations(workItemId).catch(() => []);
      setPrAssociations(prs);

      const ars = await agentRuns.listForWorkItem(workItemId).catch(() => []);
      setAgentRunList(ars);

      // WORK-027: safe execution metadata + provider readiness (safe data).
      const execs = await execution.listForWorkItem(workItemId).catch(() => []);
      setExecutions(execs);
      const eprovs = await executionProviders.listGlobal().catch(() => []);
      setExecutionProviderList(eprovs);

      const revs = await reviews.listForWorkItem(workItemId).catch(() => []);
      setReviewList(revs);

      const auds = await audit.listForWorkItem(workItemId).catch(() => []);
      setAuditList(auds);

      const runs = await verification.listRunsForWorkItem(workItemId).catch(() => []);
      setVerRuns(runs);

      // WORK-048: the dependency authority's rows + each dependency's own
      // record (for the human id + completion flag — never derived here).
      const deps = await workItems.listDependencies(workItemId).catch(() => []);
      setDependencies(deps);
      const depMap: Record<string, WorkItem | null> = {};
      await Promise.all(deps.map(async (d) => {
        depMap[d.dependsOnId] = await workItems.get(d.dependsOnId).catch(() => null);
      }));
      setDependencyItems(depMap);

      // WORK-048: the workflow authority's merge-readiness picture.
      const gates = await workflow.getMergeReadiness(workItemId).catch(() => null);
      setMergeReadiness(gates);

      // Fetch evidence for each verification run
      const evMap: Record<string, VerificationEvidence[]> = {};
      await Promise.all(runs.map(async (run) => {
        evMap[run.id] = await verification.listEvidence(run.id).catch(() => []);
      }));
      setVerEvidence(evMap);

      // Fetch findings for each review
      const findingsMap: Record<string, ReviewFinding[]> = {};
      await Promise.all(revs.map(async (rev) => {
        if (rev.id) {
          findingsMap[rev.id] = await reviews.listFindings(rev.id).catch(() => []);
        }
      }));
      setReviewFindings(findingsMap);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load work item');
    } finally {
      setLoading(false);
    }
  }, [workItemId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleAction = async (action: () => Promise<unknown>) => {
    setActionError(null);
    setActionLoading(true);
    try {
      await action();
      await loadAll();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  // WORK-027: Start Implementation submits through the mode-aware execution
  // endpoint. Native completes synchronously (agentRunId appears in Agent
  // Runs); external returns handoff-ready → open the External Execution view.
  const startExecution = async (input: { mode: ExecutionMode; provider: string; model?: string }) => {
    setStartBusy(true);
    setStartError(null);
    try {
      const created = await execution.start(workItemId!, input);
      setModeDialogOpen(false);
      if (created.mode === 'external') {
        // Refresh, then open the external handoff view for the new execution.
        const summary = await execution.get(created.executionId).catch(() => null);
        setExternalDialogExecution(summary ?? {
          executionId: created.executionId,
          mode: 'external',
          provider: created.provider,
          model: created.model,
          status: created.status,
          agentRunId: null,
          externalSessionRef: null,
          repository: created.repository,
          branch: created.branch,
          promptDigest: '',
          benchmarkMetadata: {},
          startedAt: null,
          completedAt: null,
          expiresAt: created.expiresAt,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      await loadAll();
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setStartBusy(false);
    }
  };

  const canStartImplementation =
    workflowState?.currentState === 'ready' || workflowState?.currentState === 'changes_requested';

  if (loading) return <LoadingState label="Loading work item…" />;
  if (error) return <ErrorState message={error} />;
  if (!workItem) return <ErrorState message="Work item not found" />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{workItem.workItemId}: {workItem.title}</h1>
          {workflowState && <StatusBadge value={workflowState.currentState} />}
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{workItem.id}</p>
      </div>

      {/* WORK-048: the objective card — the authoritative WorkItem fields
          (objective / scope / out-of-scope / constraints / assignee),
          rendered verbatim from the backend record. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Target className="h-4 w-4" />
            Objective
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Objective</div>
            <p className="mt-1 text-sm">{workItem.objective || <span className="text-muted-foreground">Not specified</span>}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Scope</div>
              <p className="mt-1 text-sm">{workItem.scope || <span className="text-muted-foreground">Not specified</span>}</p>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Out of scope</div>
              <p className="mt-1 text-sm">{workItem.outOfScope || <span className="text-muted-foreground">Not specified</span>}</p>
            </div>
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Architecture constraints</div>
            <p className="mt-1 text-sm">{workItem.architectureConstraints || <span className="text-muted-foreground">None recorded</span>}</p>
          </div>
          {workItem.assignee && (
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="secondary">Assignee</Badge>
              <span>{workItem.assignee}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* WORK-048: the dependencies card — the dependency authority's rows,
          each rendered with the dependency's own completion flag. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ListTree className="h-4 w-4" />
            Dependencies
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dependencies.length === 0 ? (
            <p className="text-sm text-muted-foreground">No dependencies — this item blocks on nothing.</p>
          ) : (
            <div className="space-y-2">
              {dependencies.map((d) => {
                const dep = dependencyItems[d.dependsOnId];
                return (
                  <div key={d.id} className="flex items-center justify-between rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/work-items/${d.dependsOnId}`}
                        className="font-mono text-xs text-primary underline-offset-4 hover:underline"
                      >
                        {dep ? dep.workItemId : d.dependsOnId.slice(0, 8)}
                      </Link>
                      <span className="text-sm text-muted-foreground">
                        {dep ? dep.title : 'Dependency record unavailable'}
                      </span>
                    </div>
                    {dep ? (
                      dep.completed ? (
                        <Badge variant="success">Satisfied</Badge>
                      ) : (
                        <Badge variant="destructive">Not satisfied</Badge>
                      )
                    ) : (
                      <Badge variant="secondary">Unknown</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* WORK-048: the merge gates card — the workflow authority's own
          merge-readiness verdict (facts only; nothing derived here). */}
      {mergeReadiness && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4" />
              Merge Gates
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              {mergeReadiness.ready ? (
                <Badge variant="success">Ready to merge</Badge>
              ) : (
                <Badge variant="warning">Not ready</Badge>
              )}
              <span className="text-xs text-muted-foreground">
                The workflow authority's merge-readiness verdict.
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={mergeReadiness.hasApprovedReview ? 'success' : 'secondary'}>
                Approved review: {mergeReadiness.hasApprovedReview ? 'yes' : 'no'}
              </Badge>
              <Badge variant={mergeReadiness.hasActivePrAssociation ? 'success' : 'secondary'}>
                Active PR: {mergeReadiness.hasActivePrAssociation ? 'yes' : 'no'}
              </Badge>
              <Badge variant={mergeReadiness.verificationSatisfied ? 'success' : 'secondary'}>
                Verification: {mergeReadiness.verificationSatisfied ? 'satisfied' : 'not satisfied'}
              </Badge>
              <Badge variant={mergeReadiness.dependenciesSatisfied ? 'success' : 'secondary'}>
                Dependencies: {mergeReadiness.dependenciesSatisfied ? 'satisfied' : 'not satisfied'}
              </Badge>
            </div>
            {mergeReadiness.reasons.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {mergeReadiness.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Workflow Timeline */}
      {workflowState && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Lifecycle</CardTitle></CardHeader>
          <CardContent><WorkflowTimeline.Stages currentState={workflowState.currentState} /></CardContent>
        </Card>
      )}

      {/* Workflow Actions */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Workflow Actions</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={actionLoading || !canStartImplementation}
              title={canStartImplementation ? 'Choose Native or External execution' : 'Requires workflow state ready or changes_requested'}
              onClick={() => setModeDialogOpen(true)}
            >
              <Rocket className="mr-1 h-3.5 w-3.5" />Start Implementation
            </Button>
            <Button size="sm" variant="outline" disabled={actionLoading} onClick={() => handleAction(() => workflow.transition(workItemId!, 'ready'))}>
              <Play className="mr-1 h-3.5 w-3.5" />Ready
            </Button>
            <Button size="sm" variant="outline" disabled={actionLoading} onClick={() => handleAction(() => workflow.converge(workItemId!))}>
              <Play className="mr-1 h-3.5 w-3.5" />Converge
            </Button>
            <Button size="sm" variant="outline" disabled={actionLoading} onClick={() => handleAction(() => workflow.beginVerification(workItemId!))}>
              <FlaskConical className="mr-1 h-3.5 w-3.5" />Begin Verification
            </Button>
            <Button size="sm" variant="outline" disabled={actionLoading} onClick={() => handleAction(() => workflow.beginArchitectReview(workItemId!))}>
              <FileCheck className="mr-1 h-3.5 w-3.5" />Begin Architect Review
            </Button>
            <Button size="sm" variant="outline" disabled={actionLoading} onClick={() => handleAction(() => workflow.requestMerge(workItemId!))}>
              <GitMerge className="mr-1 h-3.5 w-3.5" />Request Merge
            </Button>
            <Button size="sm" variant="outline" disabled={actionLoading} onClick={() => handleAction(() => workflow.advanceToVerified(workItemId!))}>
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />Advance to Verified
            </Button>
          </div>
          {actionError && <p className="mt-2 text-sm text-destructive">{actionError}</p>}
          {actionLoading && <p className="mt-2 text-sm text-muted-foreground">Processing…</p>}
        </CardContent>
      </Card>

      {/* Workflow History */}
      {workflowHistory.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Transition History</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {workflowHistory.map((t) => (
                <div key={t.id} className="flex items-center gap-3 text-sm border-b pb-2 last:border-0">
                  <StatusBadge value={t.fromState} />
                  <span className="text-muted-foreground">→</span>
                  <StatusBadge value={t.toState} />
                  <span className="text-xs text-muted-foreground ml-auto">
                    {t.actor || 'system'} · {new Date(t.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs defaultValue="implementation">
        <TabsList>
          <TabsTrigger value="implementation">Implementation</TabsTrigger>
          <TabsTrigger value="verification">Verification</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        {/* Implementation Tab */}
        <TabsContent value="implementation" className="space-y-4">
          {/* WORK-048: the ADVISORY routing recommendation (WORK-044) —
              rendered strictly as a recommendation, never a decision. */}
          <AdvisoryCard workItemId={workItemId ?? ''} workItemLabel={workItem.workItemId} />

          {/* Work Orders */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Work Orders</CardTitle></CardHeader>
            <CardContent>
              {workOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No work orders</p>
              ) : (
                <div className="space-y-2">
                  {workOrders.map((wo) => (
                    <div key={wo.id} className="rounded-md border p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs text-muted-foreground">{wo.id.slice(0, 8)}</span>
                        <StatusBadge value={wo.state} />
                      </div>
                      {wo.scope && <p className="mt-1 text-sm">{wo.scope}</p>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Executions (WORK-027: native + external, safe metadata) */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Executions</CardTitle></CardHeader>
            <CardContent>
              {executions.length === 0 ? (
                <EmptyState title="No executions" description="Start implementation to create an execution (native or external)." />
              ) : (
                <div className="space-y-2">
                  {executions.map((ex) => (
                    <div key={ex.executionId} className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <p className="text-sm font-medium">
                          {ex.mode === 'external' ? 'External' : 'Native'} · {ex.provider}
                          {ex.model ? <span className="text-muted-foreground"> ({ex.model})</span> : null}
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">{ex.executionId}</p>
                        {ex.repository && <p className="text-xs text-muted-foreground">repo: {ex.repository}</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge value={ex.status} />
                        {ex.mode === 'external' && (ex.status === 'handoff_ready' || ex.status === 'submitted') && (
                          <Button size="sm" variant="outline" onClick={() => setExternalDialogExecution(ex)}>
                            External Handoff
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Agent Runs */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Agent Runs</CardTitle></CardHeader>
            <CardContent>
              {agentRunList.length === 0 ? (
                <EmptyState title="No agent runs" description="Start implementation to trigger an agent run." />
              ) : (
                <div className="space-y-2">
                  {agentRunList.map((ar) => (
                    <div key={ar.id} className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <p className="text-sm font-medium">{ar.provider}</p>
                        <p className="text-xs text-muted-foreground font-mono">{ar.executionId.slice(0, 12)}</p>
                        {ar.commitRef && <p className="text-xs text-muted-foreground">commit: {ar.commitRef}</p>}
                        {ar.pullRequestRef && <p className="text-xs text-muted-foreground">PR: {ar.pullRequestRef}</p>}
                      </div>
                      <StatusBadge value={ar.status} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pull Requests */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Pull Requests</CardTitle></CardHeader>
            <CardContent>
              {prAssociations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No PR associations</p>
              ) : (
                <div className="space-y-2">
                  {prAssociations.map((pr) => (
                    <div key={pr.id} className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <p className="text-sm font-medium font-mono">{pr.externalPrId}</p>
                        {pr.branch && <p className="text-xs text-muted-foreground">{pr.branch}</p>}
                      </div>
                      <StatusBadge value={pr.status} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Verification Tab */}
        <TabsContent value="verification">
          <Card>
            <CardContent className="pt-6">
              <h3 className="mb-3 font-medium">Verification Runs</h3>
              {verRuns.length === 0 ? (
                <EmptyState title="No verification runs" description="Begin verification to create a run." />
              ) : (
                <div className="space-y-3">
                  {verRuns.map((run) => (
                    <div key={run.id} className="rounded-md border p-3">
                      <div className="flex items-center justify-between">
                        <StatusBadge value={run.status} />
                        <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
                      </div>
                      <div className="mt-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          Evidence ({(verEvidence[run.id] || []).length})
                        </p>
                        {(verEvidence[run.id] || []).map((ev) => (
                          <div key={ev.id} className="mt-1 flex items-center gap-2 text-xs">
                            <StatusBadge value={ev.authority === 'authoritative' ? 'active' : 'pending'} />
                            <span>{ev.evidenceType} — {ev.provider}</span>
                            <StatusBadge value={ev.result} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Review Tab */}
        <TabsContent value="review">
          <Card>
            <CardContent className="pt-6">
              <h3 className="mb-3 font-medium">Architect Reviews</h3>
              {reviewList.length === 0 ? (
                <EmptyState title="No reviews" description="Begin architect review to create a review." />
              ) : (
                <div className="space-y-3">
                  {reviewList.map((r, idx) => (
                    <div key={r.id} className="rounded-md border p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">Review #{idx + 1}</p>
                          <p className="text-xs text-muted-foreground">{r.source}</p>
                          {r.summary && <p className="text-xs text-muted-foreground mt-1">{r.summary}</p>}
                          {r.reviewer && <p className="text-xs text-muted-foreground">reviewer: {r.reviewer}</p>}
                        </div>
                        {r.outcome ? <StatusBadge value={r.outcome.toLowerCase()} /> : <StatusBadge value={r.status} />}
                      </div>
                      {/* Findings */}
                      {(reviewFindings[r.id] || []).length > 0 && (
                        <div className="mt-2 border-t pt-2">
                          <p className="text-xs font-medium text-muted-foreground">Findings ({(reviewFindings[r.id] || []).length})</p>
                          {(reviewFindings[r.id] || []).map((f) => (
                            <div key={f.id} className="mt-1 text-xs">
                              <span className="font-medium">{f.severity}:</span> {f.title}
                              {f.description && <p className="text-muted-foreground">{f.description}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Activity Tab */}
        <TabsContent value="activity">
          <Card>
            <CardContent className="pt-6">
              <h3 className="mb-3 font-medium">Audit Trail</h3>
              {auditList.length === 0 ? (
                <p className="text-sm text-muted-foreground">No audit events</p>
              ) : (
                <div className="space-y-2">
                  {auditList.map((e) => (
                    <div key={e.id} className="flex items-start gap-3 border-b pb-2 last:border-0">
                      <Activity className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
                      <div className="flex-1">
                        <p className="text-sm font-medium">{e.eventType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</p>
                        <p className="text-xs text-muted-foreground">
                          {e.actor} · {e.source} · {e.resourceType}
                          {e.executionId && <span className="font-mono"> · exec:{e.executionId.slice(0, 8)}</span>}
                        </p>
                        <p className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* WORK-027: Execution Mode selector + External Execution handoff view */}
      <ExecutionModeDialog
        open={modeDialogOpen}
        onOpenChange={setModeDialogOpen}
        workItemLabel={workItem.workItemId}
        providers={executionProviderList}
        busy={startBusy}
        error={startError}
        onSubmit={startExecution}
      />
      <ExternalExecutionDialog
        open={externalDialogExecution !== null}
        onOpenChange={(open) => { if (!open) setExternalDialogExecution(null); }}
        executionSummary={externalDialogExecution}
        onStatusChange={loadAll}
      />
    </div>
  );
}
