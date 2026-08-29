/**
 * WORK-050 — the unified execution section.
 *
 * A CONSUMER of existing authorities, never an authority itself. Native and
 * external execution render from the SAME authoritative execution model; the
 * WORK-044 routing and WORK-047 intelligence recommendations render as
 * ADVISORY (visually and semantically distinct from the authoritative
 * "Actually selected" — the record's own provider/model/mode); the WORK-042
 * handoff, the WORK-046 delegated units, the WORK-043 constraints, the
 * verification runs, and the workflow authority's next-action facts render
 * verbatim from their own records.
 *
 * The WORK-048 read-state discipline applies to EVERY surface: a failed
 * read is an ERROR (explicitly rendered, the surface named) — NEVER "No
 * execution / No handoff / No verification". Only a successful empty answer
 * renders an empty state. The section performs ZERO mutations (the Start
 * Implementation / External Handoff mutations stay in the page's existing
 * components, reached through the onOpenExternalHandoff callback).
 */
import * as React from 'react';
import { Zap, Lightbulb, BrainCircuit, ArrowLeftRight, Users, FlaskConical, Compass, AlertTriangle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/domain/status-badge';
import { readLoading, readReason, settleRead, type ReadState } from '@/lib/read-state';
import { deriveExecutionView, type ExecutionView } from '@/lib/execution-view';
import {
  execution, executionRouting, agentIntelligence, executionPolicy,
  crossModeHandoff, delegationPlans, verification, workflow,
  type ExecutionSummary, type RoutingRecommendation,
  type AgentIntelligenceRecommendation, type ExecutionRecommendation,
  type CrossModeHandoffView, type DelegationPlanView,
  type VerificationRun, type WorkflowExecution, type MergeGateResult,
} from '@/api/client';

interface UnifiedExecutionSectionProps {
  workItemId: string;
  workItemLabel: string;
  /** The work item's project (resolved server-side by the work-item GET). */
  projectId: string | null;
  /**
   * WORK-050: the post-action refresh tick — the page bumps it after every
   * authoritative action (a workflow transition, an execution start, an
   * external-handoff status change) so this section re-reads the fresh
   * backend truth. A stale "No execution" can never survive an action that
   * created one (adversarial #8: stale UI cannot override fresh server state).
   */
  refreshKey?: number;
  /** Opens the page's EXISTING external-handoff dialog (no new mutation path). */
  onOpenExternalHandoff?: (execution: ExecutionSummary) => void;
}

/** One per-surface error line (the WORK-048 discipline: errors are explicit,
 * with a per-surface testid so tests never depend on broken-up text). */
function SurfaceError({ surface, message, testid }: { surface: string; message: string; testid: string }) {
  return (
    <div className="flex items-start gap-2 text-sm text-muted-foreground" data-testid={testid}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <span>
        <span className="font-medium">{surface}</span> unavailable — {message}
      </span>
    </div>
  );
}

function SurfaceLoading({ surface }: { surface: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="execution-surface-loading">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading {surface.toLowerCase()}…
    </div>
  );
}

export function UnifiedExecutionSection({
  workItemId, workItemLabel, projectId, refreshKey = 0, onOpenExternalHandoff,
}: UnifiedExecutionSectionProps) {
  // --- per-surface read states (loading / success / error, always distinct) ---
  const [executionsRead, setExecutionsRead] = React.useState<ReadState<ExecutionSummary[]>>(readLoading);
  const [handoffRead, setHandoffRead] = React.useState<ReadState<CrossModeHandoffView | null>>(readLoading);
  const [routingRead, setRoutingRead] = React.useState<ReadState<RoutingRecommendation>>(readLoading);
  const [intelligenceRead, setIntelligenceRead] = React.useState<ReadState<AgentIntelligenceRecommendation>>(readLoading);
  const [policyRead, setPolicyRead] = React.useState<ReadState<ExecutionRecommendation>>(readLoading);
  const [delegationRead, setDelegationRead] = React.useState<ReadState<DelegationPlanView[]>>(readLoading);
  const [verificationRead, setVerificationRead] = React.useState<ReadState<VerificationRun[]>>(readLoading);
  const [workflowRead, setWorkflowRead] = React.useState<ReadState<{
    state: WorkflowExecution;
    readiness: { ok: true; value: MergeGateResult | null } | { ok: false; message: string };
  }>>(readLoading);

  const load = React.useCallback(() => {
    // The execution records (the execution authority's own list, its order).
    settleRead(execution.listForWorkItem(workItemId)).then(setExecutionsRead);
    // The WORK-044 routing recommendation (advisory).
    settleRead(executionRouting.getRecommendation(workItemId)).then(setRoutingRead);
    // The WORK-047 intelligence recommendation (advisory; project-scoped).
    if (projectId) {
      settleRead(agentIntelligence.getExecutionRecommendation(projectId, workItemId)).then(setIntelligenceRead);
    } else {
      setIntelligenceRead({ status: 'error', message: "the work item's project could not be resolved" });
    }
    // The WORK-043 policy recommendation (the constraints).
    settleRead(executionPolicy.recommendation.get(workItemId)).then(setPolicyRead);
    // The WORK-046 delegation plans (project-scoped).
    if (projectId) {
      settleRead(delegationPlans.listForWorkItem(projectId, workItemId)).then(setDelegationRead);
    } else {
      setDelegationRead({ status: 'error', message: "the work item's project could not be resolved" });
    }
    // The verification authority's own runs.
    settleRead(verification.listRunsForWorkItem(workItemId)).then(setVerificationRead);
    // The workflow authority's state + merge readiness (the next-action
    // facts). The STATE read governs the surface; the READINESS read settles
    // separately INSIDE it — a failed readiness read renders an explicit
    // "merge gates unavailable" note, never a silent null (failure ≠ empty).
    void settleRead(
      workflow.getState(workItemId).then(async (state) => ({
        state,
        readiness: await workflow.getMergeReadiness(workItemId).then(
          (value): { ok: true; value: MergeGateResult | null } => ({ ok: true, value }),
          (error): { ok: false; message: string } => ({ ok: false, message: readReason(error) }),
        ),
      })),
    ).then(setWorkflowRead);
  }, [workItemId, projectId]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  // The handoff read targets the CURRENT execution (the authority's newest
  // record): it follows the executions read, and a fresh executions response
  // re-triggers it (refresh consistency — a stale handoff never survives a
  // refresh that brings a new current execution).
  React.useEffect(() => {
    if (executionsRead.status !== 'success') return;
    const current = executionsRead.data[0];
    if (!current) {
      // No executions → no handoff read applies (the empty executions state
      // renders; the handoff surface is skipped, never fabricated).
      setHandoffRead({ status: 'success', data: null });
      return;
    }
    settleRead(crossModeHandoff.getForExecution(current.executionId)).then(setHandoffRead);
  }, [executionsRead]);

  // --- the pure derivation over whatever facts have arrived -------------------
  const view: ExecutionView | null = React.useMemo(() => {
    if (executionsRead.status !== 'success') return null;
    return deriveExecutionView({
      executions: executionsRead.data,
      handoff: handoffRead.status === 'success' ? handoffRead.data : null,
      routing: routingRead.status === 'success' ? routingRead.data : null,
      intelligence: intelligenceRead.status === 'success' ? intelligenceRead.data : null,
      policy: policyRead.status === 'success' ? policyRead.data : null,
      delegationPlans: delegationRead.status === 'success' ? delegationRead.data : [],
      verificationRuns: verificationRead.status === 'success' ? verificationRead.data : [],
      workflowState: workflowRead.status === 'success' ? workflowRead.data.state.currentState : null,
      mergeReadiness: workflowRead.status === 'success' && workflowRead.data.readiness.ok
        ? workflowRead.data.readiness.value
        : null,
    });
  }, [executionsRead, handoffRead, routingRead, intelligenceRead, policyRead, delegationRead, verificationRead, workflowRead]);

  // (Every surface renders its own error inline — the WORK-048 discipline;
  // no error is ever swallowed or duplicated.)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-4 w-4" />
          Execution
        </CardTitle>
        <CardDescription>
          One execution capability for {workItemLabel} — native and external from the same
          authoritative records. Recommendations are advisory; the selection is what the
          execution record says.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">

        {/* --- Current state + Actually selected (the execution authority) --- */}
        <div className="flex flex-col gap-2" data-testid="execution-current">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Current state</div>
          {executionsRead.status === 'loading' && <SurfaceLoading surface="Execution records" />}
          {executionsRead.status === 'error' && (
            <SurfaceError testid="execution-records-unavailable" surface="Execution records" message={executionsRead.message} />
          )}
          {executionsRead.status === 'success' && !view?.currentExecution && (
            <p className="text-sm text-muted-foreground" data-testid="execution-none">
              No execution — implementation has not been started for this work item.
            </p>
          )}
          {executionsRead.status === 'success' && view?.currentExecution && (
            <div className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge value={view.currentExecution.status} />
                <span className="text-sm font-medium" data-testid="execution-actually-selected">
                  {view.currentExecution.mode === 'external' ? 'External' : 'Native'} · {view.currentExecution.provider}
                  {view.currentExecution.model ? <span className="text-muted-foreground"> ({view.currentExecution.model})</span> : null}
                </span>
                {view.selectionDiffersFromRoutingRecommendation === true && (
                  <Badge variant="outline">differs from routing recommendation</Badge>
                )}
              </div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{view.currentExecution.executionId}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Actually selected — the execution record's own provider/model/mode (started{' '}
                {view.currentExecution.startedAt ? new Date(view.currentExecution.startedAt).toLocaleString() : '—'});
                recommendations never decide this.
              </p>
              {view.currentExecution.mode === 'external'
                && (view.currentExecution.status === 'handoff_ready' || view.currentExecution.status === 'submitted')
                && onOpenExternalHandoff && (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => onOpenExternalHandoff(view.currentExecution!)}>
                  External Handoff
                </Button>
              )}
              {/* The execution HISTORY — every authoritative record, native and
                  external rendered from the SAME model (parity). */}
              {view.executionHistory.length > 1 && (
                <div className="mt-3 border-t pt-2">
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Prior executions ({view.executionHistory.length - 1})
                  </div>
                  <div className="mt-1 space-y-1">
                    {view.executionHistory.slice(1).map((ex) => (
                      <div key={ex.executionId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5">
                        <span className="font-mono text-xs text-muted-foreground">
                          {ex.executionId.slice(0, 12)} · {ex.mode === 'external' ? 'External' : 'Native'} · {ex.provider}
                          {ex.model ? ` (${ex.model})` : ''}
                        </span>
                        <span className="flex items-center gap-2">
                          <StatusBadge value={ex.status} />
                          {ex.mode === 'external'
                            && (ex.status === 'handoff_ready' || ex.status === 'submitted')
                            && onOpenExternalHandoff && (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => onOpenExternalHandoff(ex)}>
                              Handoff
                            </Button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* --- Recommendation (advisory: routing + intelligence) -------------- */}
        <div className="flex flex-col gap-2" data-testid="execution-recommendation">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recommendation <span className="font-normal normal-case">(advisory — never the selection)</span>
          </div>
          {routingRead.status === 'loading' && <SurfaceLoading surface="Routing recommendation" />}
          {routingRead.status === 'error' && (
            <SurfaceError testid="routing-recommendation-unavailable" surface="Routing recommendation" message={routingRead.message} />
          )}
          {routingRead.status === 'success' && (
            <div className="rounded-md border border-dashed p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Lightbulb className="h-4 w-4 text-muted-foreground" />
                <Badge variant="secondary">Routing recommends</Badge>
                {view?.routingAdvisory.recommends ? (
                  <span className="text-sm font-medium">
                    {view.routingAdvisory.recommends.provider}
                    {view.routingAdvisory.recommends.model ? ` / ${view.routingAdvisory.recommends.model}` : ''}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">No eligible candidate (fail closed)</span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {view?.routingAdvisory.eligibleCount ?? 0} eligible · {view?.routingAdvisory.excludedCount ?? 0} excluded by hard constraints ·{' '}
                {view?.routingAdvisory.selectionReason}
              </p>
            </div>
          )}
          {intelligenceRead.status === 'loading' && <SurfaceLoading surface="Agent intelligence recommendation" />}
          {intelligenceRead.status === 'error' && (
            <SurfaceError testid="intelligence-recommendation-unavailable" surface="Agent intelligence recommendation" message={intelligenceRead.message} />
          )}
          {intelligenceRead.status === 'success' && view && (
            <div className="rounded-md border border-dashed p-3" data-testid="execution-intelligence">
              <div className="flex flex-wrap items-center gap-2">
                <BrainCircuit className="h-4 w-4 text-muted-foreground" />
                <Badge variant="secondary">Intelligence recommends</Badge>
                {view.intelligenceAdvisory.recommends ? (
                  <span className="text-sm font-medium">
                    {view.intelligenceAdvisory.recommends.provider}
                    {view.intelligenceAdvisory.recommends.model ? ` / ${view.intelligenceAdvisory.recommends.model}` : ''}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">No recommendation</span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Why: {view.intelligenceAdvisory.headline}
              </p>
              {view.intelligenceAdvisory.reasons.slice(0, 3).map((r, i) => (
                <p key={i} className="text-xs text-muted-foreground">· {r.dimension}: {r.detail}</p>
              ))}
              {view.intelligenceAdvisory.fallbackCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {view.intelligenceAdvisory.fallbackCount} ordered fallback{view.intelligenceAdvisory.fallbackCount > 1 ? 's' : ''}
                </p>
              )}
              {view.intelligenceAdvisory.warnings.map((w, i) => (
                <p key={i} className="text-xs text-warning">{w}</p>
              ))}
            </div>
          )}
        </div>

        {/* --- Constraints (the WORK-043 policy authority) --------------------- */}
        <div className="flex flex-col gap-2" data-testid="execution-constraints">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Constraints</div>
          {policyRead.status === 'loading' && <SurfaceLoading surface="Execution policy constraints" />}
          {policyRead.status === 'error' && (
            <SurfaceError testid="policy-constraints-unavailable" surface="Execution policy constraints" message={policyRead.message} />
          )}
          {policyRead.status === 'success' && view && (
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{view.constraints.eligibleCount} eligible</Badge>
              <Badge variant="secondary">{view.constraints.excludedCount} excluded</Badge>
              {view.constraints.benchmarkMode && (
                <Badge variant="outline">mode: {view.constraints.benchmarkMode}</Badge>
              )}
              {view.constraints.frozen === true && <Badge variant="warning">policy frozen</Badge>}
              {view.constraints.allowedModes.length > 0 && (
                <Badge variant="outline">allowed: {view.constraints.allowedModes.join(' + ')}</Badge>
              )}
              {view.constraints.headline && (
                <p className="w-full text-xs text-muted-foreground">{view.constraints.headline}</p>
              )}
            </div>
          )}
        </div>

        {/* --- Handoff (the WORK-042 authority) -------------------------------- */}
        <div className="flex flex-col gap-2" data-testid="execution-handoff">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Handoff <span className="font-normal normal-case">(native ⇄ external, the same logical execution)</span>
          </div>
          {handoffRead.status === 'loading' && <SurfaceLoading surface="Handoff state" />}
          {handoffRead.status === 'error' && (
            <SurfaceError testid="handoff-state-unavailable" surface="Handoff state" message={handoffRead.message} />
          )}
          {handoffRead.status === 'success' && !view?.handoff && (
            <p className="text-sm text-muted-foreground" data-testid="execution-no-handoff">
              No cross-mode handoff — this execution stayed in its original mode.
            </p>
          )}
          {handoffRead.status === 'success' && view?.handoff && (
            <div className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">
                  {view.handoff.fromMode} → {view.handoff.toMode}
                </span>
                <StatusBadge value={view.handoff.resultingStatus} />
                {!view.handoff.authorized && <Badge variant="destructive">unauthorized</Badge>}
              </div>
              {view.handoff.reason && <p className="mt-1 text-xs text-muted-foreground">Reason: {view.handoff.reason}</p>}
              <p className="mt-1 text-xs text-muted-foreground">
                The WORK-042 handoff log's own record ({new Date(view.handoff.createdAt).toLocaleString()}) — one
                logical execution, one ExecutionRecord.
              </p>
            </div>
          )}
        </div>

        {/* --- Delegated units (the WORK-046 authority) ------------------------ */}
        <div className="flex flex-col gap-2" data-testid="execution-delegation">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Delegated units <span className="font-normal normal-case">(the delegation records' own state)</span>
          </div>
          {delegationRead.status === 'loading' && <SurfaceLoading surface="Delegation plans" />}
          {delegationRead.status === 'error' && (
            <SurfaceError testid="delegation-plans-unavailable" surface="Delegation plans" message={delegationRead.message} />
          )}
          {delegationRead.status === 'success' && view?.delegatedUnitCount === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="execution-no-delegation">
              No delegated units — this work item executes as one unit.
            </p>
          )}
          {delegationRead.status === 'success' && view && view.delegatedUnitCount > 0 && (
            <div className="space-y-2">
              {view.delegatedUnits.map((u) => (
                <div key={`${u.planKey}:${u.unitKey}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                  <div>
                    <p className="text-sm font-medium">
                      <Users className="mr-1 inline h-3.5 w-3.5 text-muted-foreground" />
                      {u.roleId} <span className="font-mono text-xs text-muted-foreground">({u.roleRevision.slice(0, 8)})</span>
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {u.planKey} / {u.unitKey} · {u.mode === 'external' ? 'External' : 'Native'} · {u.provider}
                      {u.model ? ` (${u.model})` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{u.attemptCount} attempt{u.attemptCount === 1 ? '' : 's'}</Badge>
                    <StatusBadge value={u.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* --- Verification (the verification authority) ----------------------- */}
        <div className="flex flex-col gap-2" data-testid="execution-verification">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Verification</div>
          {verificationRead.status === 'loading' && <SurfaceLoading surface="Verification runs" />}
          {verificationRead.status === 'error' && (
            <SurfaceError testid="verification-runs-unavailable" surface="Verification runs" message={verificationRead.message} />
          )}
          {verificationRead.status === 'success' && view?.verification.runCount === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="execution-no-verification">
              No verification runs — verification has not begun.
            </p>
          )}
          {verificationRead.status === 'success' && view && view.verification.runCount > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <FlaskConical className="h-4 w-4 text-muted-foreground" />
              <StatusBadge value={view.verification.latestStatus} />
              <span className="text-xs text-muted-foreground">
                latest of {view.verification.runCount} run{view.verification.runCount === 1 ? '' : 's'} — the
                verification authority's own record.
              </span>
            </div>
          )}
        </div>

        {/* --- Next action (the workflow authority's own facts) ---------------- */}
        <div className="flex flex-col gap-2" data-testid="execution-next-action">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Next action</div>
          {workflowRead.status === 'loading' && <SurfaceLoading surface="Workflow state" />}
          {workflowRead.status === 'error' && (
            <SurfaceError testid="workflow-state-unavailable" surface="Workflow state" message={workflowRead.message} />
          )}
          {workflowRead.status === 'success' && view && (
            <div className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Compass className="h-4 w-4 text-muted-foreground" />
                <StatusBadge value={view.nextAction.currentState} />
                {view.nextAction.mergeReady === true && <Badge variant="success">ready to merge</Badge>}
                {view.nextAction.mergeReady === false && <Badge variant="warning">not ready to merge</Badge>}
              </div>
              {view.nextAction.reasons.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                  {view.nextAction.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              )}
              {!workflowRead.data.readiness.ok && (
                <div className="mt-1 text-xs text-muted-foreground" data-testid="merge-readiness-unavailable">
                  Merge gates unavailable — {workflowRead.data.readiness.message} (the workflow state above is the
                  authority's own answer; the gates could not be read.)
                </div>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                The workflow authority's own state and merge gates — the governed next step follows from it
                (the actions live in Workflow Actions below).
              </p>
            </div>
          )}
        </div>

      </CardContent>
    </Card>
  );
}
