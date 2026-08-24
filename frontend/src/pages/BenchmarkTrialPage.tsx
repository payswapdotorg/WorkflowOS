import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink, GitPullRequest, FileCheck, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { StatusBadge } from '@/components/domain/status-badge';
import { KeyValue } from '@/components/domain/key-value';
import { SectionHeader } from '@/components/domain/page-header';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  benchmarks,
  type BenchmarkTrial,
  type BenchmarkTrialMetrics,
  type BenchmarkReviewFinding,
  ApiError,
} from '@/api/client';
import { shortId, formatDateTime } from '@/lib/format';

/**
 * WORK-032: BenchmarkTrialPage — single trial deep detail (§25).
 * Mirrors WorkItemPage single-execution view: title row + many Card
 * sections + action buttons.
 *
 * The frontend never fabricates metrics — it renders backend-supplied
 * authoritative state (workflowEngine / verification / review / GitHub /
 * CI ingestion are all backend authorities).
 *
 * §31 human intervention MUST be visible when present.
 */
export default function BenchmarkTrialPage() {
  const { trialId } = useParams<{ trialId: string }>();
  const navigate = useNavigate();

  const [trial, setTrial] = useState<BenchmarkTrial | null>(null);
  const [metrics, setMetrics] = useState<BenchmarkTrialMetrics | null>(null);
  const [findings, setFindings] = useState<BenchmarkReviewFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!trialId) return;
    setError(null);
    try {
      const t = await benchmarks.getTrial(trialId);
      setTrial(t);
      const m = await benchmarks.getTrialMetrics(trialId).catch(() => null);
      setMetrics(m);
      const fs = await benchmarks.listTrialFindings(trialId).catch(() => []);
      setFindings(fs ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load trial');
    } finally {
      setLoading(false);
    }
  }, [trialId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (loading) return <LoadingState label="Loading trial…" />;
  if (error) return <ErrorState message={error} onRetry={loadAll} />;
  if (!trial) return <ErrorState message="Trial not found" />;

  const isExternal = trial.executionMode === 'external';
  const isNative = trial.executionMode === 'native';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {trial.provider} · {trial.executionMode} · rep {trial.repetitionIndex}
          </h1>
          <StatusBadge value={trial.status} />
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{trial.id}</p>
        <div className="mt-2">
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="mr-1 h-3.5 w-3.5" />
            Back
          </Button>
        </div>
      </div>

      {/* Execution Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Execution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <KeyValue label="Mode">
              <StatusBadge
                value={trial.executionMode}
                tone={isNative ? 'success' : 'info'}
              />
            </KeyValue>
            <KeyValue label="Provider">{trial.provider}</KeyValue>
            <KeyValue label="Model" mono>
              {trial.model ?? '—'}
            </KeyValue>
            <KeyValue label="Execution ID" mono>
              {shortId(trial.executionId)}
            </KeyValue>
            <KeyValue label="Trial Branch" mono>
              {trial.trialBranch}
            </KeyValue>
            <KeyValue label="Baseline Commit" mono>
              {trial.baselineCommit.slice(0, 12)}…
            </KeyValue>
            <KeyValue label="Prompt Digest" mono>
              {trial.promptDigest.slice(0, 16)}…
            </KeyValue>
            <KeyValue label="Started At">
              {formatDateTime(trial.startedAt)}
            </KeyValue>
            <KeyValue label="Completed At">
              {formatDateTime(trial.completedAt)}
            </KeyValue>
          </div>
        </CardContent>
      </Card>

      {/* Links Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Links</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!trial.pullRequestAssociationId &&
            !trial.executionId &&
            !findings.some((f) => f.reviewId) && (
              <p className="text-sm text-muted-foreground">
                No associated PR, execution, or review records yet.
              </p>
            )}
          <div className="flex flex-wrap gap-2">
            {trial.pullRequestAssociationId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  trial.workItemId &&
                  navigate(`/work-items/${trial.workItemId}`)
                }
              >
                <GitPullRequest className="mr-1 h-3.5 w-3.5" />
                Open PR
              </Button>
            )}
            {trial.executionId && trial.workItemId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(`/work-items/${trial.workItemId}`)}
              >
                <ExternalLink className="mr-1 h-3.5 w-3.5" />
                Open Execution
              </Button>
            )}
            {findings.some((f) => f.reviewId) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  trial.workItemId &&
                  navigate(`/work-items/${trial.workItemId}`)
                }
              >
                <FileCheck className="mr-1 h-3.5 w-3.5" />
                Open Review
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Metrics Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Metrics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {!metrics ? (
            <p className="text-sm text-muted-foreground">
              No metrics collected yet. The harness collects metrics once the
              trial reaches a terminal state.
            </p>
          ) : (
            <>
              {/* Execution metrics */}
              <div>
                <SectionHeader title="Execution" />
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <KeyValue label="Queue Time (ms)" mono>
                    {metrics.queueTimeMs ?? '—'}
                  </KeyValue>
                  <KeyValue label="Start Latency (ms)" mono>
                    {metrics.startLatencyMs ?? '—'}
                  </KeyValue>
                  <KeyValue label="Execution Duration (ms)" mono>
                    {metrics.executionDurationMs ?? '—'}
                  </KeyValue>
                  <KeyValue label="Time to PR (ms)" mono>
                    {metrics.timeToPrMs ?? '—'}
                  </KeyValue>
                  <KeyValue label="Time to Approved (ms)" mono>
                    {metrics.timeToApprovedMs ?? '—'}
                  </KeyValue>
                  <KeyValue label="Time to Merged (ms)" mono>
                    {metrics.timeToMergedMs ?? '—'}
                  </KeyValue>
                  <KeyValue label="Time to Verified (ms)" mono>
                    {metrics.timeToVerifiedMs ?? '—'}
                  </KeyValue>
                </div>
              </div>

              {/* Engineering metrics */}
              <div>
                <SectionHeader title="Engineering" />
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <KeyValue label="Files Changed" mono>
                    {metrics.filesChanged ?? '—'}
                  </KeyValue>
                  <KeyValue label="Lines Added" mono>
                    {metrics.linesAdded ?? '—'}
                  </KeyValue>
                  <KeyValue label="Lines Deleted" mono>
                    {metrics.linesDeleted ?? '—'}
                  </KeyValue>
                  <KeyValue label="Commits" mono>
                    {metrics.commits ?? '—'}
                  </KeyValue>
                  <KeyValue label="Pull Requests" mono>
                    {metrics.pullRequests ?? '—'}
                  </KeyValue>
                  <KeyValue label="Agent Runs" mono>
                    {metrics.agentRuns ?? '—'}
                  </KeyValue>
                </div>
              </div>

              {/* CI metrics */}
              <div>
                <SectionHeader title="CI" />
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <KeyValue label="CI Runs" mono>
                    {metrics.ciRuns ?? '—'}
                  </KeyValue>
                  <KeyValue label="CI Failures" mono>
                    {metrics.ciFailures ?? '—'}
                  </KeyValue>
                  <KeyValue label="CI First Pass">
                    <StatusBadge
                      value={metrics.ciFirstPass ? 'pass' : 'fail'}
                      humanize={false}
                    />
                  </KeyValue>
                  <KeyValue label="Total CI Duration (ms)" mono>
                    {metrics.totalCiDurationMs ?? '—'}
                  </KeyValue>
                </div>
              </div>

              {/* Verification metrics */}
              <div>
                <SectionHeader title="Verification" />
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <KeyValue label="Verification Runs" mono>
                    {metrics.verificationRuns ?? '—'}
                  </KeyValue>
                  <KeyValue label="Criteria Passed" mono>
                    {metrics.criteriaPassed ?? '—'}
                  </KeyValue>
                  <KeyValue label="Criteria Failed" mono>
                    {metrics.criteriaFailed ?? '—'}
                  </KeyValue>
                  <KeyValue label="Total Criteria" mono>
                    {metrics.totalCriteria ?? '—'}
                  </KeyValue>
                  <KeyValue label="Verification First Pass">
                    <StatusBadge
                      value={metrics.verificationFirstPass ? 'pass' : 'fail'}
                      humanize={false}
                    />
                  </KeyValue>
                  <KeyValue label="Final Pass">
                    <StatusBadge
                      value={metrics.finalPass ? 'verified' : 'failed'}
                      humanize={false}
                    />
                  </KeyValue>
                </div>
              </div>

              {/* Review metrics */}
              <div>
                <SectionHeader title="Review" />
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <KeyValue label="Review Count" mono>
                    {metrics.reviewCount ?? '—'}
                  </KeyValue>
                  <KeyValue label="Request Changes Count" mono>
                    {metrics.requestChangesCount ?? '—'}
                  </KeyValue>
                  <KeyValue label="Approval Count" mono>
                    {metrics.approvalCount ?? '—'}
                  </KeyValue>
                  <KeyValue label="Correction Cycles" mono>
                    {metrics.correctionCycles ?? '—'}
                  </KeyValue>
                </div>
              </div>

              {/* Quality score */}
              <div>
                <SectionHeader title="Quality Score" />
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <KeyValue label="Engineering Quality Score" mono>
                    {metrics.engineeringQualityScore ?? '—'}
                  </KeyValue>
                  <KeyValue label="Score Version" mono>
                    {metrics.scoreVersion ?? '—'}
                  </KeyValue>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Review Findings Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Review Findings ({findings.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {findings.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No review findings"
              description="No architect review findings have been associated with this trial."
            />
          ) : (
            <div className="space-y-2">
              {findings.map((f) => (
                <div
                  key={f.id}
                  className="rounded-md border border-border bg-card p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      value={f.severity}
                      tone={
                        f.severity === 'blocker'
                          ? 'destructive'
                          : f.severity === 'major'
                            ? 'warning'
                            : f.severity === 'minor'
                              ? 'info'
                              : 'neutral'
                      }
                      humanize={false}
                    />
                    {f.category && (
                      <span className="text-xs text-muted-foreground">
                        {f.category}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatDateTime(f.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-foreground">{f.description}</p>
                  {(f.file || f.line != null) && (
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {f.file ?? ''}
                      {f.line != null ? `:${f.line}` : ''}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* External Metadata Card (only when external) */}
      {isExternal && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">External Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <KeyValue label="Companion Version" mono>
                {trial.companionVersion ?? '—'}
              </KeyValue>
              <KeyValue label="Provider Adapter Version" mono>
                {trial.providerAdapterVersion ?? '—'}
              </KeyValue>
              <KeyValue label="Browser" mono>
                {trial.browser ?? '—'}
              </KeyValue>
              <KeyValue label="Provider Surface" mono>
                {trial.providerSurface ?? '—'}
              </KeyValue>
              <KeyValue label="External Session Ref" mono>
                {trial.externalSessionRef ?? '—'}
              </KeyValue>
              <KeyValue label="Handoff Issued At">
                {formatDateTime(trial.handoffIssuedAt)}
              </KeyValue>
              <KeyValue label="Handoff Redeemed At">
                {formatDateTime(trial.handoffRedeemedAt)}
              </KeyValue>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Native Metadata Card (only when native) */}
      {isNative && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Native Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <KeyValue label="Adapter Version" mono>
                {trial.adapterVersion ?? '—'}
              </KeyValue>
              <KeyValue label="Model Configuration Version" mono>
                {trial.modelConfigurationVersion ?? '—'}
              </KeyValue>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Human Intervention Card (§31 — must be visible when present) */}
      {trial.humanInterventionCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Human Intervention</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Alert variant="warning">
              <AlertTitle>Human Intervention Required</AlertTitle>
              <AlertDescription>
                This trial required {trial.humanInterventionCount} human
                intervention(s)
                {trial.interventionDurationMs
                  ? ` totaling ${trial.interventionDurationMs} ms`
                  : ''}
                . The intervention count and duration are part of the
                authoritative record (§31) and MUST be surfaced to the user.
              </AlertDescription>
            </Alert>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <KeyValue label="Intervention Count" mono>
                {trial.humanInterventionCount}
              </KeyValue>
              <KeyValue label="Intervention Duration (ms)" mono>
                {trial.interventionDurationMs ?? '—'}
              </KeyValue>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Failure Card (if trial failed) */}
      {trial.failureKind && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Failure</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Alert variant="destructive">
              <AlertTitle>
                {trial.failureKind} failure
              </AlertTitle>
              {trial.failureReason && (
                <AlertDescription>{trial.failureReason}</AlertDescription>
              )}
            </Alert>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
