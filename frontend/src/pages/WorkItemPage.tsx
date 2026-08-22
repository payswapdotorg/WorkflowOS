import { useParams } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import {
  workItems, workflow, agentRuns, reviews, verification, audit,
  type WorkItem, type WorkflowExecution, type WorkflowTransition,
  type WorkOrder, type PrAssociation, type AgentRun,
  type Review, type AuditEvent,
  type VerificationRun, type VerificationEvidence, type CriterionEvidenceMapping,
  ApiError,
} from '../api/client';

/**
 * WORK-022 Work Item page (UI-AC-01, UI2-AC-01, UI2-AC-02, UI3-AC-01).
 *
 * Every section renders AUTHORITATIVE backend state. The page never derives
 * workflow state, never evaluates verification evidence, never decides
 * authorization — it only displays backend responses and triggers backend
 * actions.
 *
 * PR #21 correction (UI2-AC-01): the Verification section renders ACTUAL
 * VerificationRun + Evidence records fetched from /verification, NOT workflow
 * convergence metadata. The previous implementation substituted the
 * convergence status endpoint for verification data.
 */
export default function WorkItemPage() {
  const { workItemId } = useParams<{ workItemId: string }>();
  const [wi, setWi] = useState<WorkItem | null>(null);
  const [wfState, setWfState] = useState<WorkflowExecution | null>(null);
  const [history, setHistory] = useState<WorkflowTransition[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [prAssocs, setPrAssocs] = useState<PrAssociation[]>([]);
  const [agentRunList, setAgentRunList] = useState<AgentRun[]>([]);
  const [reviewList, setReviewList] = useState<Review[]>([]);
  const [auditList, setAuditList] = useState<AuditEvent[]>([]);
  const [verificationRuns, setVerificationRuns] = useState<VerificationRun[]>([]);
  const [evidenceByRun, setEvidenceByRun] = useState<Record<string, VerificationEvidence[]>>({});
  const [mappingsByRun, setMappingsByRun] = useState<Record<string, CriterionEvidenceMapping[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const loadAll = useCallback(async () => {
    if (!workItemId) return;
    setLoading(true);
    setError(null);
    try {
      const [item, wf, hist, wos, prs, ars, revs, auds, runs] = await Promise.all([
        workItems.get(workItemId),
        workflow.getState(workItemId).catch(() => null),
        workflow.getHistory(workItemId).then(h => h.transitions).catch(() => []),
        workItems.listWorkOrders(workItemId).catch(() => []),
        workItems.listPrAssociations(workItemId).catch(() => []),
        agentRuns.listForWorkItem(workItemId).catch(() => []),
        reviews.listForWorkItem(workItemId).catch(() => []),
        audit.listForWorkItem(workItemId).catch(() => []),
        // UI2-AC-01: fetch ACTUAL VerificationRun records, not convergence metadata.
        verification.listRunsForWorkItem(workItemId).catch(() => []),
      ]);
      setWi(item);
      setWfState(wf);
      setHistory(hist);
      setWorkOrders(wos);
      setPrAssocs(prs);
      setAgentRunList(ars);
      setReviewList(revs);
      setAuditList(auds);
      setVerificationRuns(runs);

      // Fetch evidence + mappings for each run (parallel). These are the
      // actual persisted Evidence records owned by /verification.
      const evidenceEntries: Array<[string, VerificationEvidence[]]> = [];
      const mappingEntries: Array<[string, CriterionEvidenceMapping[]]> = [];
      await Promise.all(runs.map(async (run) => {
        const [ev, mp] = await Promise.all([
          verification.listEvidence(run.id).catch(() => [] as VerificationEvidence[]),
          verification.listMappings(run.id).catch(() => [] as CriterionEvidenceMapping[]),
        ]);
        evidenceEntries.push([run.id, ev]);
        mappingEntries.push([run.id, mp]);
      }));
      setEvidenceByRun(Object.fromEntries(evidenceEntries));
      setMappingsByRun(Object.fromEntries(mappingEntries));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load work item');
    } finally {
      setLoading(false);
    }
  }, [workItemId]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const handleAction = async (action: () => Promise<unknown>) => {
    setActionError(null);
    setActionLoading(true);
    try {
      await action();
      await loadAll(); // UI2-AC-02: re-fetch authoritative state after mutation.
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) return <div data-testid="wi-loading">Loading work item...</div>;
  if (error) return <div data-testid="wi-error" style={{ color: 'red' }}>Error: {error}</div>;
  if (!wi) return <div>Work item not found</div>;

  return (
    <div>
      <h1>{wi.workItemId}: {wi.title}</h1>
      <p><strong>ID:</strong> {wi.id}</p>
      <p><strong>Completed:</strong> {wi.completed ? 'Yes' : 'No'}</p>

      <h2>Workflow State</h2>
      {wfState ? (
        <div data-testid="workflow-state" style={{ padding: 10, border: '1px solid #ddd', marginBottom: 10 }}>
          <p><strong>Current State:</strong> <span data-testid="workflow-current-state">{wfState.currentState}</span></p>
          <p><strong>Version:</strong> {wfState.version}</p>
        </div>
      ) : <p>No workflow state found.</p>}

      <h3>Workflow Actions</h3>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <button onClick={() => handleAction(() => workflow.transition(workItemId!, 'ready'))} disabled={actionLoading}>→ Ready</button>
        <button onClick={() => handleAction(() => workflow.converge(workItemId!))} disabled={actionLoading}>Converge</button>
        <button onClick={() => handleAction(() => workflow.beginVerification(workItemId!))} disabled={actionLoading}>Begin Verification</button>
        <button onClick={() => handleAction(() => workflow.beginArchitectReview(workItemId!))} disabled={actionLoading}>Begin Architect Review</button>
        <button onClick={() => handleAction(() => workflow.requestMerge(workItemId!))} disabled={actionLoading}>Request Merge</button>
        <button onClick={() => handleAction(() => workflow.advanceToVerified(workItemId!))} disabled={actionLoading}>Advance to Verified</button>
      </div>
      {actionError && <p data-testid="action-error" style={{ color: 'red' }}>Action error: {actionError}</p>}
      {actionLoading && <p>Processing...</p>}

      <h3>Transition History</h3>
      {history.length === 0 ? <p>No transitions recorded.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
            <th style={{ padding: 5 }}>From</th><th style={{ padding: 5 }}>To</th>
            <th style={{ padding: 5 }}>Actor</th><th style={{ padding: 5 }}>Date</th>
          </tr></thead>
          <tbody>
            {history.map(t => (
              <tr key={t.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 5 }}>{t.fromState}</td>
                <td style={{ padding: 5 }}>{t.toState}</td>
                <td style={{ padding: 5 }}>{t.actor || '-'}</td>
                <td style={{ padding: 5 }}>{new Date(t.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Work Orders</h2>
      {workOrders.length === 0 ? <p>No work orders.</p> : workOrders.map(wo => (
        <div key={wo.id} style={{ padding: 5, border: '1px solid #eee', marginBottom: 5 }}>
          {wo.id.slice(0, 8)}... — State: {wo.state} — Scope: {wo.scope || 'N/A'}
        </div>
      ))}

      <h2>Pull Requests</h2>
      {prAssocs.length === 0 ? <p>No PR associations.</p> : prAssocs.map(pr => (
        <div key={pr.id} style={{ padding: 5, border: '1px solid #eee', marginBottom: 5 }}>
          {pr.externalPrId} — Status: <strong>{pr.status}</strong>
        </div>
      ))}

      <h2>Agent Runs</h2>
      {agentRunList.length === 0 ? <p>No agent runs.</p> : agentRunList.map(ar => (
        <div key={ar.id} style={{ padding: 5, border: '1px solid #eee', marginBottom: 5 }}>
          Provider: {ar.provider} — Status: <strong>{ar.status}</strong>
          {ar.commitRef && <span> — Commit: {ar.commitRef}</span>}
          {ar.pullRequestRef && <span> — PR: {ar.pullRequestRef}</span>}
        </div>
      ))}

      <h2>Architect Reviews</h2>
      {reviewList.length === 0 ? <p>No reviews.</p> : reviewList.map(r => (
        <div key={r.id} style={{ padding: 5, border: '1px solid #eee', marginBottom: 5 }}>
          Status: <strong>{r.status}</strong> — Outcome: {r.outcome || 'N/A'}
          {r.summary && <span> — {r.summary}</span>}
        </div>
      ))}

      {/* UI2-AC-01 (PR #21 correction): render ACTUAL VerificationRun + Evidence
          records owned by /verification. The previous implementation substituted
          workflow convergence metadata here, which did not satisfy UI2-AC-01. */}
      <h2>Verification</h2>
      {verificationRuns.length === 0 ? (
        <p data-testid="verification-empty">No verification runs.</p>
      ) : (
        <div data-testid="verification-runs">
          {verificationRuns.map(run => (
            <div key={run.id} data-testid={`verification-run-${run.id}`} style={{ padding: 10, border: '1px solid #ddd', marginBottom: 10 }}>
              <p>
                <strong>Run:</strong> <span data-testid={`run-${run.id}-id`}>{run.id.slice(0, 8)}</span>
                {' — '}
                <strong>Status:</strong> <span data-testid={`run-${run.id}-status`}>{run.status}</span>
                {' — '}
                <strong>Source:</strong> {run.source}
                {run.sourceRef && <span> — Ref: {run.sourceRef}</span>}
              </p>
              <p><strong>Started:</strong> {run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'} — <strong>Finished:</strong> {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '-'}</p>
              <h4>Evidence ({(evidenceByRun[run.id] || []).length})</h4>
              {(evidenceByRun[run.id] || []).length === 0 ? (
                <p data-testid={`run-${run.id}-evidence-empty`}>No evidence attached.</p>
              ) : (
                <ul data-testid={`run-${run.id}-evidence`}>
                  {(evidenceByRun[run.id] || []).map(ev => (
                    <li key={ev.id} data-testid={`evidence-${ev.id}`}>
                      <strong>{ev.evidenceType}</strong> — provider: {ev.provider}
                      {' — authority: '}<span data-testid={`evidence-${ev.id}-authority`}>{ev.authority}</span>
                      {' — result: '}<strong data-testid={`evidence-${ev.id}-result`}>{ev.result}</strong>
                      {ev.headSha && <span> — SHA: {ev.headSha.slice(0, 8)}</span>}
                      {ev.contentSummary && <span> — {ev.contentSummary}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <h4>Evidence→Criterion Mappings ({(mappingsByRun[run.id] || []).length})</h4>
              {(mappingsByRun[run.id] || []).length === 0 ? (
                <p>No mappings.</p>
              ) : (
                <ul>
                  {(mappingsByRun[run.id] || []).map(mp => (
                    <li key={mp.id}>
                      evidence {mp.evidenceId.slice(0, 8)}... → criterion {mp.criterionId} — relevance: {mp.relevance} — status: {mp.status}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <h2>Audit History</h2>
      {auditList.length === 0 ? <p>No audit events.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
            <th style={{ padding: 5 }}>Event</th><th style={{ padding: 5 }}>Actor</th>
            <th style={{ padding: 5 }}>Source</th><th style={{ padding: 5 }}>Date</th>
          </tr></thead>
          <tbody>
            {auditList.map(e => (
              <tr key={e.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 5 }}>{e.eventType}</td>
                <td style={{ padding: 5 }}>{e.actor}</td>
                <td style={{ padding: 5 }}>{e.source}</td>
                <td style={{ padding: 5 }}>{new Date(e.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
