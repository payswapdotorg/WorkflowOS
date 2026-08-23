import { Play, GitMerge, CheckCircle2, FlaskConical, FileCheck, Activity } from 'lucide-react';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { useParams } from 'react-router-dom';
import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusBadge } from '@/components/domain/status-badge';
import { WorkflowTimeline } from '@/components/domain/workflow-timeline';
import {
  workItems, workflow, agentRuns, reviews, verification, audit,
  type WorkItem, type WorkflowExecution, type AgentRun, type Review, type AuditEvent,
  type VerificationRun, type VerificationEvidence,
  ApiError,
} from '@/api/client';
export default function WorkItemPage() {
  const { workItemId } = useParams<{ workItemId: string }>();
  const [wi, _setWi] = useState<WorkItem | null>(null);
  const [wfState, _setWfState] = useState<WorkflowExecution | null>(null);
  const [agentRunList, _setAgentRunList] = useState<AgentRun[]>([]);
  const [reviewList, setReviewList] = useState<Review[]>([]);
  const [auditList, setAuditList] = useState<AuditEvent[]>([]);
  const [verRuns, setVerRuns] = useState<VerificationRun[]>([]);
  const [verEvidence, setVerEvidence] = useState<Record<string, VerificationEvidence[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const loadAll = useCallback(async () => {
    if (!workItemId) return;
    setLoading(true); setError(null);
    try {
      const [_item, _wf, _hist, _ars, revs, auds, runs]: unknown[] = await Promise.all([
        workItems.get(workItemId),
        workflow.getState(workItemId).catch(() => null),
        null,
        workItems.listWorkOrders(workItemId).catch(() => []),
        agentRuns.listForWorkItem(workItemId).catch(() => []),
        reviews.listForWorkItem(workItemId).catch(() => []),
        audit.listForWorkItem(workItemId).catch(() => []),
        verification.listRunsForWorkItem(workItemId).catch(() => []),
      ]);
      setReviewList(revs as Review[]); setAuditList(auds as AuditEvent[]);
      setVerRuns(runs as VerificationRun[]);
      const evMap: Record<string, VerificationEvidence[]> = {};
      await Promise.all((runs as VerificationRun[]).map(async (run) => {
        evMap[run.id] = await verification.listEvidence(run.id).catch(() => []);
      }));
      setVerEvidence(evMap);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to load work item'); }
    finally { setLoading(false); }
  }, [workItemId]);
  useEffect(() => { loadAll(); }, [loadAll]);
  const handleAction = async (action: () => Promise<unknown>) => {
    setActionError(null); setActionLoading(true);
    try { await action(); await loadAll(); }
    catch (err) { setActionError(err instanceof ApiError ? err.message : (err as Error).message); }
    finally { setActionLoading(false); }
  };
  if (loading) return <LoadingState label="Loading work item…" />;
  if (error) return <ErrorState message={error} />;
  if (!wi) return <ErrorState message="Work item not found" />;
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{wi.workItemId}: {wi.title}</h1>
          {wfState && <StatusBadge value={wfState.currentState} />}
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{wi.id}</p>
      </div>
      {/* Workflow Timeline */}
      {wfState && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Lifecycle</CardTitle></CardHeader>
          <CardContent><WorkflowTimeline.Stages currentState={wfState.currentState} /></CardContent>
        </Card>
      )}
      {/* Workflow Actions */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Workflow Actions</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
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
      {/* Tabs */}
      <Tabs defaultValue="implementation">
        <TabsList>
          <TabsTrigger value="implementation">Implementation</TabsTrigger>
          <TabsTrigger value="verification">Verification</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="implementation">
          <Card><CardContent className="pt-6">
            <h3 className="mb-3 font-medium">Agent Runs</h3>
            {agentRunList.length === 0 ? <p className="text-sm text-muted-foreground">No agent runs</p> : (
              <div className="space-y-2">
                {agentRunList.map((ar) => (
                  <div key={ar.id} className="flex items-center justify-between rounded-md border p-3">
                    <div><p className="text-sm font-medium">{ar.provider}</p><p className="text-xs text-muted-foreground font-mono">{ar.executionId.slice(0, 12)}</p></div>
                    <StatusBadge value={ar.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="verification">
          <Card><CardContent className="pt-6">
            <h3 className="mb-3 font-medium">Verification Runs</h3>
            {verRuns.length === 0 ? <p className="text-sm text-muted-foreground">No verification runs</p> : (
              <div className="space-y-3">
                {verRuns.map((run) => (
                  <div key={run.id} className="rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <StatusBadge value={run.status} />
                      <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
                    </div>
                    <div className="mt-2">
                      <p className="text-xs font-medium text-muted-foreground">Evidence ({(verEvidence[run.id] || []).length})</p>
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
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="review">
          <Card><CardContent className="pt-6">
            <h3 className="mb-3 font-medium">Architect Reviews</h3>
            {reviewList.length === 0 ? <p className="text-sm text-muted-foreground">No reviews</p> : (
              <div className="space-y-2">
                {reviewList.map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <p className="text-sm font-medium">{r.source}</p>
                      {r.summary && <p className="text-xs text-muted-foreground">{r.summary}</p>}
                    </div>
                    {r.outcome ? <StatusBadge value={r.outcome.toLowerCase()} /> : <StatusBadge value={r.status} />}
                  </div>
                ))}
              </div>
            )}
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="activity">
          <Card><CardContent className="pt-6">
            <h3 className="mb-3 font-medium">Audit Trail</h3>
            {auditList.length === 0 ? <p className="text-sm text-muted-foreground">No audit events</p> : (
              <div className="space-y-2">
                {auditList.map((e) => (
                  <div key={e.id} className="flex items-start gap-3 border-b pb-2">
                    <Activity className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{e.eventType}</p>
                      <p className="text-xs text-muted-foreground">{e.actor} · {e.source} · {new Date(e.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
