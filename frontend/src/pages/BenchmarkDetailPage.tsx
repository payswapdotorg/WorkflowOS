import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Play, Pause, X, Download, ArrowRight, FlaskConical, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { StatusBadge } from '@/components/domain/status-badge';
import { KeyValue } from '@/components/domain/key-value';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SectionHeader } from '@/components/domain/page-header';
import {
  benchmarks,
  type BenchmarkExperiment,
  type BenchmarkTrial,
  type BenchmarkTrialMetrics,
  type BenchmarkIntegrityRecord,
  type BenchmarkRecommendation,
  type BenchmarkTaskSnapshot,
  ApiError,
} from '@/api/client';
import { shortId, formatDateTime } from '@/lib/format';

/**
 * WORK-032: BenchmarkDetailPage — experiment detail + run control + live
 * execution (§46). Mirrors WorkItemPage: title row + many Card sections +
 * action buttons.
 *
 * The frontend never mutates experiment state itself — Start/Pause/Cancel
 * all delegate to backend routes that transition the experiment status. The
 * "Start" call is synchronous (it runs all queued trials through the
 * ExecutionService). A loading state covers the wait.
 */
export default function BenchmarkDetailPage() {
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  const navigate = useNavigate();

  const [experiment, setExperiment] = useState<BenchmarkExperiment | null>(null);
  const [snapshot, setSnapshot] = useState<BenchmarkTaskSnapshot | null>(null);
  const [trials, setTrials] = useState<BenchmarkTrial[]>([]);
  const [trialMetrics, setTrialMetrics] = useState<Record<string, BenchmarkTrialMetrics | null>>({});
  const [integrity, setIntegrity] = useState<BenchmarkIntegrityRecord | null>(null);
  const [recommendation, setRecommendation] = useState<BenchmarkRecommendation | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!benchmarkId) return;
    setError(null);
    try {
      const exp = await benchmarks.get(benchmarkId);
      setExperiment(exp);

      const snap = await benchmarks.snapshots
        .get(exp.benchmarkTaskSnapshotId)
        .catch(() => null);
      setSnapshot(snap);

      const trialResult = await benchmarks.listTrials(benchmarkId, { limit: 200, offset: 0 });
      setTrials(trialResult.trials ?? []);

      // Fetch metrics for each trial (parallel; metrics may be null until collected).
      const metricsMap: Record<string, BenchmarkTrialMetrics | null> = {};
      await Promise.all(
        (trialResult.trials ?? []).map(async (t) => {
          metricsMap[t.id] = await benchmarks.getTrialMetrics(t.id).catch(() => null);
        }),
      );
      setTrialMetrics(metricsMap);

      const ig = await benchmarks.getIntegrity(benchmarkId).catch(() => null);
      setIntegrity(ig);

      // Recommendation is only meaningful for completed + integrity-valid experiments.
      if (exp.status === 'completed') {
        const rec = await benchmarks.recommend(benchmarkId).catch(() => null);
        setRecommendation(rec);
      } else {
        setRecommendation(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load experiment');
    } finally {
      setLoading(false);
    }
  }, [benchmarkId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleAction = async (action: () => Promise<BenchmarkExperiment>) => {
    setActionError(null);
    setActionLoading(true);
    try {
      const updated = await action();
      setExperiment(updated);
      // Refresh trials + metrics + integrity after a state transition.
      await loadAll();
      void updated; // satisfy linter (state was set above)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleExport = async (format: 'json' | 'csv') => {
    if (!benchmarkId) return;
    setExportError(null);
    setExportLoading(true);
    try {
      const blob = await benchmarks.exportExperiment(benchmarkId, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `benchmark-${benchmarkId.slice(0, 8)}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'Export failed');
    } finally {
      setExportLoading(false);
    }
  };

  if (loading) return <LoadingState label="Loading experiment…" />;
  if (error) return <ErrorState message={error} onRetry={loadAll} />;
  if (!experiment) return <ErrorState message="Experiment not found" />;

  const canStart = experiment.status === 'created' || experiment.status === 'paused';
  const canPause = experiment.status === 'running';
  const canCancel = experiment.status === 'running' || experiment.status === 'paused';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{experiment.name}</h1>
          <StatusBadge value={experiment.status} />
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{experiment.id}</p>
        {experiment.description && (
          <p className="mt-2 text-sm text-muted-foreground">{experiment.description}</p>
        )}
      </div>

      {/* Snapshot Card — shows the frozen task snapshot */}
      {snapshot && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Snapshot</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <KeyValue label="Prompt Digest" mono>
                {snapshot.promptDigest.slice(0, 16)}…
              </KeyValue>
              <KeyValue label="Baseline Commit" mono>
                {snapshot.baseCommit.slice(0, 12)}…
              </KeyValue>
              <KeyValue label="Repository" mono>
                {snapshot.repository}
              </KeyValue>
              <KeyValue label="Snapshot Hash" mono>
                {snapshot.snapshotHash.slice(0, 16)}…
              </KeyValue>
              <KeyValue label="Harness Version" mono>
                {snapshot.harnessVersion}
              </KeyValue>
              <KeyValue label="Scoring Version" mono>
                {snapshot.scoringVersion}
              </KeyValue>
              <KeyValue label="Architecture Version" mono>
                {shortId(snapshot.architectureVersionId)}
              </KeyValue>
              <KeyValue label="Work Item" mono>
                {shortId(snapshot.workItemId)}
              </KeyValue>
              <KeyValue label="Created">
                {formatDateTime(snapshot.createdAt)}
              </KeyValue>
            </div>
            <div className="flex items-center gap-3 rounded-md border border-border bg-card p-3 text-sm">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="font-medium text-foreground">SAME TASK BASELINE</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {snapshot.snapshotHash.slice(0, 16)}…
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Run Control Card — Start/Pause/Cancel */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Run Control</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canStart || actionLoading}
              onClick={() => handleAction(() => benchmarks.start(experiment.id))}
            >
              <Play className="mr-1 h-3.5 w-3.5" />
              {actionLoading ? 'Running…' : 'Start'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canPause || actionLoading}
              onClick={() => handleAction(() => benchmarks.pause(experiment.id))}
            >
              <Pause className="mr-1 h-3.5 w-3.5" />
              Pause
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canCancel || actionLoading}
              onClick={() => handleAction(() => benchmarks.cancel(experiment.id))}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
          {actionError && <ErrorState message={actionError} />}
          {actionLoading && (
            <p className="text-xs text-muted-foreground">
              Running trials synchronously — this may take a while. The backend
              is driving every trial through ExecutionService; results will
              appear here when the call returns.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Integrity Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Integrity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!integrity ? (
            <p className="text-sm text-muted-foreground">
              No integrity record yet. The harness validates integrity once
              the experiment transitions to <code>completed</code>.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <KeyValue label="Valid">
                  <StatusBadge value={integrity.valid ? 'verified' : 'failed'} />
                </KeyValue>
                <KeyValue label="Snapshot Hash" mono>
                  {integrity.snapshotHash.slice(0, 16)}…
                </KeyValue>
                <KeyValue label="Prompt Digest" mono>
                  {integrity.promptDigest.slice(0, 16)}…
                </KeyValue>
                <KeyValue label="Baseline Commit" mono>
                  {integrity.baselineCommit.slice(0, 12)}…
                </KeyValue>
                <KeyValue label="Scoring Version" mono>
                  {integrity.scoringVersion}
                </KeyValue>
                <KeyValue label="Harness Version" mono>
                  {integrity.harnessVersion}
                </KeyValue>
                <KeyValue label="Validated At">
                  {formatDateTime(integrity.validatedAt)}
                </KeyValue>
              </div>
              {!integrity.valid && integrity.invalidationReason && (
                <Alert variant="destructive">
                  <AlertTitle>Integrity Invalid</AlertTitle>
                  <AlertDescription>
                    {integrity.invalidationReason}
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Trials Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Trials ({trials.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trials.length === 0 ? (
            <EmptyState
              icon={FlaskConical}
              title="No trials yet"
              description="Start the experiment to queue trial executions."
            />
          ) : (
            <div className="space-y-2">
              {trials.map((t) => {
                const m = trialMetrics[t.id];
                return (
                  <div
                    key={t.id}
                    className="flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-border bg-card p-3 hover:shadow-sm"
                    onClick={() => navigate(`/benchmarks/trials/${t.id}`)}
                  >
                    <div className="flex items-center gap-2">
                      <StatusBadge
                        value={t.executionMode}
                        tone={t.executionMode === 'native' ? 'success' : 'info'}
                      />
                      <span className="text-sm font-medium">{t.provider}</span>
                    </div>
                    <StatusBadge value={t.status} />
                    <div className="ml-auto flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      <span>rep: {t.repetitionIndex}</span>
                      <span>
                        branch:{' '}
                        <span className="font-mono">{t.trialBranch.slice(0, 12)}…</span>
                      </span>
                      <span>
                        corrections:{' '}
                        <span className="font-mono">
                          {m?.correctionCycles ?? '—'}
                        </span>
                      </span>
                      <span>
                        time-to-verified:{' '}
                        <span className="font-mono">
                          {m?.timeToVerifiedMs ?? '—'}
                        </span>
                      </span>
                      <span>
                        quality:{' '}
                        <span className="font-mono">
                          {m?.engineeringQualityScore ?? '—'}
                        </span>
                      </span>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recommendation Card (only when completed + integrity valid) */}
      {experiment.status === 'completed' && integrity?.valid && recommendation && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recommendation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <KeyValue label="Recommended Provider">
                {recommendation.recommendedProvider ?? '—'}
              </KeyValue>
              <KeyValue label="Recommended Mode">
                {recommendation.recommendedMode ?? '—'}
              </KeyValue>
              <KeyValue label="Confidence">
                <StatusBadge
                  value={recommendation.confidence}
                  humanize={false}
                />
              </KeyValue>
              <KeyValue label="Sample Size">
                {recommendation.sampleSize}
              </KeyValue>
            </div>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Reason
              </div>
              <p className="mt-1 text-sm text-foreground">{recommendation.reason}</p>
            </div>
            <div>
              <SectionHeader title="Evidence" />
              <div className="mt-2 space-y-1">
                {recommendation.evidence.map((ev, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-3 rounded-md border border-border bg-card p-2 text-xs"
                  >
                    <span className="font-medium text-foreground">{ev.metric}</span>
                    <span className="font-mono text-muted-foreground">{ev.value}</span>
                    <span className="ml-auto text-muted-foreground">{ev.cell}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              The user decides the weighting. This is observed evidence, not a
              declaration.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Export Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={exportLoading}
              onClick={() => handleExport('json')}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Export JSON
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={exportLoading}
              onClick={() => handleExport('csv')}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
          {exportError && <ErrorState message={exportError} />}
        </CardContent>
      </Card>
    </div>
  );
}
