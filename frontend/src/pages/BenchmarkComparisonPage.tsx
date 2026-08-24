import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { KeyValue } from '@/components/domain/key-value';
import { PageHeader } from '@/components/domain/page-header';
import { SectionHeader } from '@/components/domain/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { BenchmarkMetricBar } from '@/components/domain/benchmark-metric-bar';
import {
  benchmarks,
  type BenchmarkComparison,
  type BenchmarkTrial,
  type BenchmarkTrialMetrics,
  ApiError,
} from '@/api/client';

/**
 * WORK-032: BenchmarkComparisonPage — side-by-side comparison (§26).
 * Takes `?trialIds=a,b,c` query params, calls POST /benchmarks/compare,
 * and renders the per-trial metric groups with hand-rolled SVG bars.
 *
 * If `integrityValid` is false, a destructive alert is shown explaining
 * the trials do not share the same task baseline.
 *
 * The frontend never recomputes a "winner" — bars are purely cosmetic
 * relative-magnitude visualizations. The user reads the evidence.
 */
export default function BenchmarkComparisonPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const trialIdsParam = searchParams.get('trialIds') ?? '';
  const trialIds = trialIdsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const [comparison, setComparison] = useState<BenchmarkComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (trialIds.length < 2) {
      setComparison(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const c = await benchmarks.compare(trialIds);
      setComparison(c);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load comparison');
      setComparison(null);
    } finally {
      setLoading(false);
    }
  }, [trialIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  if (trialIds.length < 2) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Trial Comparison"
          description="Select two or more trials from the experiment detail page to compare side by side."
          actions={
            <Button variant="outline" onClick={() => navigate('/benchmarks')}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Button>
          }
        />
        <Card>
          <CardContent className="py-12">
            <EmptyState
              title="No trials selected"
              description="Open an experiment and click into trials to compare them."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) return <LoadingState label="Loading comparison…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!comparison) return <ErrorState message="No comparison available" />;

  const trials: BenchmarkTrial[] = comparison.trials;
  const metrics = comparison.metrics;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trial Comparison"
        description={`${trials.length} trials compared against the same task snapshot.`}
        actions={
          <Button variant="outline" onClick={() => navigate('/benchmarks')}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back
          </Button>
        }
      />

      {/* SAME TASK BASELINE check row */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-3 rounded-md border border-border bg-card p-3 text-sm">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <span className="font-medium text-foreground">SAME TASK BASELINE</span>
            <div className="ml-auto flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
              <span>digest: {comparison.promptDigest.slice(0, 16)}…</span>
              <span>commit: {comparison.baselineCommit.slice(0, 12)}…</span>
            </div>
          </div>
          {!comparison.integrityValid && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Comparison invalid</AlertTitle>
              <AlertDescription>
                Trials do not share the same task baseline. The comparison
                below may be misleading — re-run the experiment or pick trials
                from the same snapshot.
              </AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KeyValue label="Snapshot" mono>
              {comparison.benchmarkTaskSnapshotId.slice(0, 12)}…
            </KeyValue>
            <KeyValue label="Prompt Digest" mono>
              {comparison.promptDigest.slice(0, 16)}…
            </KeyValue>
            <KeyValue label="Baseline Commit" mono>
              {comparison.baselineCommit.slice(0, 12)}…
            </KeyValue>
          </div>
        </CardContent>
      </Card>

      {/* Metric groups */}
      <MetricGroup
        title="Correction"
        description="How many review-driven correction cycles each trial needed."
        trials={trials}
        metrics={metrics}
        metricKey="correctionCycles"
        lowerIsBetter
      />
      <MetricGroup
        title="Completion Time"
        description="Milliseconds from trial start to verified state."
        trials={trials}
        metrics={metrics}
        metricKey="timeToVerifiedMs"
        lowerIsBetter
        formatMs
      />
      <MetricGroup
        title="Engineering"
        description="Lines added across all commits."
        trials={trials}
        metrics={metrics}
        metricKey="linesAdded"
      />
      <MetricGroup
        title="CI"
        description="CI runs vs CI failures (lower failures is better)."
        trials={trials}
        metrics={metrics}
        metricKey="ciFailures"
        lowerIsBetter
      />
      <MetricGroup
        title="Verification"
        description="Criteria passed out of the total. Higher is better."
        trials={trials}
        metrics={metrics}
        metricKey="criteriaPassed"
      />
      <MetricGroup
        title="Review"
        description="REQUEST_CHANGES reviews received. Lower is better."
        trials={trials}
        metrics={metrics}
        metricKey="requestChangesCount"
        lowerIsBetter
      />
      <MetricGroup
        title="Quality Score"
        description="Backend-computed engineering quality score (v1)."
        trials={trials}
        metrics={metrics}
        metricKey="engineeringQualityScore"
      />

      {/* Cell statistics summary */}
      {comparison.cells.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Cell Statistics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {comparison.cells.map((cell, idx) => (
              <div
                key={idx}
                className="rounded-md border border-border bg-card p-3"
              >
                <SectionHeader
                  title={`${cell.provider} · ${cell.mode}`}
                  description={`${cell.trialCount} trial(s) · ${cell.completed} completed · ${cell.failed} failed · ${cell.unavailable} unavailable`}
                />
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <KeyValue label="Correction (median)">
                    {cell.correctionCycles.median ?? '—'}
                  </KeyValue>
                  <KeyValue label="Time-to-Verified (median)">
                    {cell.timeToVerifiedMs.median ?? '—'}
                  </KeyValue>
                  <KeyValue label="CI First Pass Rate">
                    {formatPercent(cell.ciFirstPassRate)}
                  </KeyValue>
                  <KeyValue label="Quality Score (median)">
                    {cell.engineeringQualityScore.median ?? '—'}
                  </KeyValue>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MetricGroup({
  title,
  description,
  trials,
  metrics,
  metricKey,
  lowerIsBetter,
  formatMs,
}: {
  title: string;
  description: string;
  trials: BenchmarkTrial[];
  metrics: Record<string, BenchmarkTrialMetrics>;
  metricKey: keyof BenchmarkTrialMetrics;
  lowerIsBetter?: boolean;
  formatMs?: boolean;
}) {
  // Compute the max across this metric group so the bars are scaled to the
  // same baseline. min is the smallest non-null value (for the isMin flag).
  const values = trials.map((t) => {
    const m = metrics[t.id];
    const raw = m ? (m[metricKey] as number | null | undefined) : null;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  });
  const numericValues = values.filter((v): v is number => v !== null);
  const max = numericValues.length > 0 ? Math.max(...numericValues) : 1;
  const min = numericValues.length > 0 ? Math.min(...numericValues) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {trials.map((t, idx) => {
          const value = values[idx];
          const isMin = min !== null && value === min;
          const isMax = value === max;
          return (
            <BenchmarkMetricBar
              key={t.id}
              label={`${t.provider} · ${t.executionMode} · rep ${t.repetitionIndex}`}
              value={value}
              max={max}
              lowerIsBetter={lowerIsBetter}
              isMin={isMin}
              isMax={isMax}
              format={
                formatMs
                  ? (n) => formatDurationMs(n)
                  : undefined
              }
            />
          );
        })}
      </CardContent>
    </Card>
  );
}

function formatDurationMs(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

function formatPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}
