import * as React from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, FlaskConical } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/domain/status-badge';
import { KeyValue } from '@/components/domain/key-value';
import { EmptyState } from '@/components/domain/empty-state';
import { SectionHeader } from '@/components/domain/page-header';
import {
  executionPolicy,
  ApiError,
  type ExecutionMode,
  type ExecutionCandidate,
  type ExecutionRecommendation,
  type ControlledComparisonDimensions,
} from '@/api/client';

/**
 * WORK-033 (§18): Execution Policy Dialog — the recommendation-aware
 * execution-mode selector.
 *
 * DESIGN INTENT — Stripe-level clarity, developer-oriented density, minimal
 * decoration, strong typography, obvious status, detailed "why".
 *
 * The dialog is ADVISORY ONLY (§27, §34). It fetches the backend
 * recommendation + controlled-comparison dimensions for a Work Item and
 * surfaces them to INFORM selection. The actual execution still goes through
 * `execution.start(workItemId, { mode, provider, model })` — the dialog
 * itself only calls `onSubmit` with the user-selected candidate. The
 * backend owns eligibility verdicts, scoring, and "why"; the frontend is a
 * pure consumer.
 *
 * Candidate list order:
 *   1. Recommended candidate (highlighted, pre-selected)
 *   2. Other eligible candidates (selectable)
 *   3. Excluded candidates (greyed, DISABLED, with destructive Alert showing
 *      blocking reasons — §17 hard-block)
 */
export interface ExecutionPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workItemId: string;
  workItemLabel: string;
  /** Invoked with the user-selected candidate. The caller still calls
   *  `execution.start(workItemId, input)` — the dialog only informs. */
  onSubmit: (input: { mode: ExecutionMode; provider: string; model?: string }) => void;
  busy: boolean;
  /** Optional parent error to surface (e.g. execution.start failure). */
  error?: string | null;
}

interface LoadState {
  loading: boolean;
  error: string | null;
  recommendation: ExecutionRecommendation | null;
  comparison: ControlledComparisonDimensions | null;
}

const INITIAL_LOAD: LoadState = {
  loading: true,
  error: null,
  recommendation: null,
  comparison: null,
};

/**
 * Build a stable per-candidate key for radio selection. The backend's
 * `ExecutionCandidate` does not carry an explicit `id` field — the
 * (provider, model, executionMode) triple is the natural unique identity
 * (matches the `wfos_benchmark_trials` UNIQUE(experiment_id, provider,
 * execution_mode, repetition_index) constraint from migration 0025).
 */
export function candidateKey(c: ExecutionCandidate): string {
  return `${c.provider}::${c.model || '_'}::${c.executionMode}`;
}

/** Percent formatter — handles null + 0..1 ratios. */
function formatPct(v: number | null): string {
  if (v == null) return '—';
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

/** USD-style cents formatter — never fabricated; '—' for null. */
function formatCost(cents: number | null, currency: string): string {
  if (cents == null) return '—';
  const value = (cents / 100).toFixed(2);
  return currency ? `${currency} ${value}` : value;
}

/** Milliseconds → humanized duration string (e.g. "12m 30s" / "1h 5m"). */
function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Compact row of benchmark evidence KeyValues. Mirrors BenchmarkDetailPage. */
function CandidateEvidence({ c }: { c: ExecutionCandidate }) {
  const ev = c.historicalPerformance;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KeyValue label="Observed Quality">
        {ev.observedQuality != null ? ev.observedQuality.toFixed(1) : '—'}
      </KeyValue>
      <KeyValue label="Sample Size">{ev.sampleSize}</KeyValue>
      <KeyValue label="CI 1st Pass">{formatPct(ev.ciFirstPassRate)}</KeyValue>
      <KeyValue label="Verified 1st Pass">{formatPct(ev.verificationFirstPassRate)}</KeyValue>
      <KeyValue label="Median Corrections">
        {ev.medianCorrectionCycles != null ? ev.medianCorrectionCycles.toFixed(1) : '—'}
      </KeyValue>
      <KeyValue label="Median Time-to-Verified">{formatMs(ev.medianTimeToVerifiedMs)}</KeyValue>
      <KeyValue label="Cost (est.)">
        {formatCost(c.estimatedCost.cents, c.estimatedCost.currency)}
        <span className="ml-1 text-[10px] text-muted-foreground">
          {c.estimatedCost.confidence}
        </span>
      </KeyValue>
      <KeyValue label="Latency (est.)">
        {formatMs(c.estimatedLatency.estimatedMs)}
        <span className="ml-1 text-[10px] text-muted-foreground">
          {c.estimatedLatency.source.replace(/_/g, ' ')}
        </span>
      </KeyValue>
    </div>
  );
}

/** Capability surface row — small caps + readiness tone. */
function SurfaceBadges({ c }: { c: ExecutionCandidate }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusBadge
        value={c.executionMode}
        tone={c.executionMode === 'native' ? 'info' : 'progress'}
        showDot={false}
        humanize
      />
      <StatusBadge
        value={c.availability}
        tone={
          c.availability === 'ready'
            ? 'success'
            : c.availability === 'unverified'
              ? 'warning'
              : 'destructive'
        }
        humanize
      />
      {c.eligibility.eligible ? (
        <StatusBadge value="eligible" tone="success" />
      ) : (
        <StatusBadge value="excluded" tone="destructive" />
      )}
    </div>
  );
}

/** §17/§4 destructive Alert listing blocking reasons for an excluded candidate. */
function BlockingReasonsAlert({ c }: { c: ExecutionCandidate }) {
  if (c.eligibility.eligible) return null;
  const blocks = c.eligibility.blockingReasons ?? [];
  if (blocks.length === 0) {
    return (
      <Alert variant="destructive" className="mt-2">
        <AlertTitle>Excluded</AlertTitle>
        <AlertDescription>
          The policy layer marked this candidate as ineligible. No structured
          blocking reason was supplied.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive" className="mt-2">
      <AlertTitle>Excluded — {c.eligibility.status.replace(/_/g, ' ')}</AlertTitle>
      <AlertDescription>
        <ul className="ml-4 list-disc space-y-1 text-xs">
          {blocks.map((b, idx) => (
            <li key={`${b.category}-${b.constraint}-${idx}`}>
              <span className="font-mono text-[11px] uppercase tracking-wider">
                {b.category}
              </span>{' '}
              <span className="font-medium">{b.constraint}:</span>{' '}
              <span>{b.reason}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

interface CandidateRowProps {
  c: ExecutionCandidate;
  recommended: boolean;
  selected: boolean;
  selectable: boolean;
  onSelect: () => void;
}

function CandidateRow({ c, recommended, selected, selectable, onSelect }: CandidateRowProps) {
  const disabled = !selectable;
  return (
    <div
      role="radiogroup"
      aria-label={`Candidate ${c.name}`}
      className={`rounded-md border bg-card p-3 text-left transition-colors ${
        selected
          ? 'border-primary ring-1 ring-primary'
          : recommended
            ? 'border-primary/40'
            : disabled
              ? 'border-border bg-muted/30 opacity-70'
              : 'border-border'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <label
          className={`flex cursor-pointer items-start gap-3 ${
            disabled ? 'cursor-not-allowed' : ''
          }`}
        >
          <input
            type="radio"
            name="execution-policy-candidate"
            className="mt-1"
            checked={selected}
            disabled={disabled}
            onChange={onSelect}
            aria-label={`Select ${c.name} (${c.provider}/${c.model || 'default'} ${c.executionMode})`}
          />
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{c.name}</span>
              {recommended && (
                <Badge variant="default" className="text-[10px]">
                  Recommended
                </Badge>
              )}
              {disabled && (
                <Badge variant="destructive" className="text-[10px]">
                  Hard-blocked
                </Badge>
              )}
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {c.provider}
              <span className="text-muted-foreground/60"> / </span>
              {c.model || 'default'}
            </div>
          </div>
        </label>
        <SurfaceBadges c={c} />
      </div>

      <div className="mt-3">
        <CandidateEvidence c={c} />
      </div>

      <BlockingReasonsAlert c={c} />
    </div>
  );
}

/** §10 controlled-comparison dimension grid (✓ same / ≠ differing). */
function ComparisonDimensions({ d }: { d: ControlledComparisonDimensions }) {
  const rows: { label: string; value: boolean; tone: 'same' | 'differ' }[] = [
    { label: 'Same task', value: d.sameTask, tone: 'same' },
    { label: 'Same architecture', value: d.sameArchitecture, tone: 'same' },
    { label: 'Same baseline', value: d.sameBaseline, tone: 'same' },
    { label: 'Same impl context', value: d.sameImplementationContext, tone: 'same' },
    { label: 'Same verification', value: d.sameVerification, tone: 'same' },
    { label: 'Comparable tool class', value: d.comparableToolClass, tone: 'same' },
    { label: 'Surfaces differ', value: d.differingSurfaces, tone: 'differ' },
    { label: 'Context window differs', value: d.differingContextWindow, tone: 'differ' },
    { label: 'Tool impl differs', value: d.differingToolImplementation, tone: 'differ' },
  ];
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {rows.map((r) => {
        const satisfied = r.tone === 'same' ? r.value : r.value;
        const Icon = satisfied ? CheckCircle2 : XCircle;
        const tone = r.tone === 'same' ? (r.value ? 'success' : 'destructive') : (r.value ? 'warning' : 'neutral');
        return (
          <div
            key={r.label}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
              tone === 'success'
                ? 'border-success/30 bg-success/5 text-success'
                : tone === 'destructive'
                  ? 'border-destructive/30 bg-destructive/5 text-destructive'
                  : tone === 'warning'
                    ? 'border-warning/30 bg-warning/5 text-warning'
                    : 'border-border bg-muted/30 text-muted-foreground'
            }`}
            title={`${r.label}: ${satisfied ? 'yes' : 'no'}`}
          >
            <Icon className="h-3 w-3" />
            <span>{r.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** §19 "Why?" collapsible — mirrors the BenchmarkDetailPage Recommendation card. */
function WhyExpander({ why }: { why: ExecutionRecommendation['why'] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="why-panel"
      >
        <span className="text-xs font-semibold tracking-tight text-foreground">Why?</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {open ? 'Collapse' : 'Expand'}
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>
      {open && (
        <div id="why-panel" className="space-y-3 border-t border-border p-3">
          <p className="text-sm text-foreground">{why.headline}</p>
          {why.reasons.length > 0 ? (
            <ul className="space-y-1.5">
              {why.reasons.map((r, idx) => {
                const Icon = r.satisfied ? CheckCircle2 : XCircle;
                return (
                  <li
                    key={`${r.dimension}-${idx}`}
                    className="flex items-start gap-2 text-xs"
                  >
                    <Icon
                      className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                        r.satisfied ? 'text-success' : 'text-destructive'
                      }`}
                    />
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {r.dimension.replace(/_/g, ' ')}
                      </span>
                      <span className="text-foreground">{r.detail}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No structured reasons were supplied. The recommendation is the
              policy layer's ordered output — see candidate evidence for the
              underlying benchmark metrics.
            </p>
          )}
          {why.alternatives.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Alternatives the user could select:</span>{' '}
              <span className="font-mono">{why.alternatives.join(', ')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SkeletonCandidateList() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-md border border-border bg-card p-3">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, j) => (
              <Skeleton key={j} className="h-8 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ExecutionPolicyDialog({
  open,
  onOpenChange,
  workItemId,
  workItemLabel,
  onSubmit,
  busy,
  error,
}: ExecutionPolicyDialogProps) {
  const [state, setState] = React.useState<LoadState>(INITIAL_LOAD);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [retryNonce, setRetryNonce] = React.useState(0);

  // Reset + load on open.
  React.useEffect(() => {
    if (!open) {
      setSelectedKey(null);
      return;
    }
    let cancelled = false;
    setState(INITIAL_LOAD);
    (async () => {
      try {
        const [rec, cmp] = await Promise.all([
          executionPolicy.recommendation.get(workItemId),
          executionPolicy.controlledComparison(workItemId).catch(() => null),
        ]);
        if (cancelled) return;
        setState({ loading: false, error: null, recommendation: rec, comparison: cmp });
        // Pre-select the recommended candidate (if any).
        if (rec.recommendedCandidate) {
          setSelectedKey(candidateKey(rec.recommendedCandidate));
        } else if (rec.eligibleCandidates.length > 0) {
          setSelectedKey(candidateKey(rec.eligibleCandidates[0]!));
        }
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.message
            : (err as Error).message || 'Failed to load execution recommendation';
        setState({ loading: false, error: msg, recommendation: null, comparison: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workItemId, retryNonce]);

  const rec = state.recommendation;
  const cmp = state.comparison;
  const recommended = rec?.recommendedCandidate ?? null;
  const eligible = rec?.eligibleCandidates ?? [];
  const excluded = rec?.excludedCandidates ?? [];

  // Order: recommended (if not already in eligible), then other eligible, then excluded.
  const eligibleOrdered: ExecutionCandidate[] = [];
  if (recommended) eligibleOrdered.push(recommended);
  for (const c of eligible) {
    if (!recommended || candidateKey(c) !== candidateKey(recommended)) {
      eligibleOrdered.push(c);
    }
  }

  const selectedCandidate: ExecutionCandidate | null = (() => {
    if (!selectedKey) return null;
    for (const c of [...eligibleOrdered, ...excluded]) {
      if (candidateKey(c) === selectedKey) return c;
    }
    return null;
  })();

  const canSubmit = !!selectedCandidate && selectedCandidate.eligibility.eligible && !busy;

  function handleSubmit() {
    if (!selectedCandidate) return;
    onSubmit({
      mode: selectedCandidate.executionMode,
      provider: selectedCandidate.provider,
      model: selectedCandidate.model || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-muted-foreground" />
            Execution Policy — {workItemLabel}
          </DialogTitle>
          <DialogDescription>
            The policy layer ranks eligible providers against the Work Item's
            task profile + project policy + historical benchmark evidence.
            Eligibility is a hard filter — quality never makes an ineligible
            candidate eligible.
          </DialogDescription>
        </DialogHeader>

        {/* Loading state */}
        {state.loading && (
          <div className="space-y-3">
            <SkeletonCandidateList />
          </div>
        )}

        {/* Error state */}
        {!state.loading && state.error && (
          <Alert variant="destructive">
            <AlertTitle>Failed to load recommendation</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{state.error}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRetryNonce((n) => n + 1)}
                disabled={busy}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Recommendation loaded */}
        {!state.loading && !state.error && rec && (
          <div className="space-y-4">
            {/* Recommendation headline + policy summary */}
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Recommendation
                  </span>
                  <p className="text-sm text-foreground">{rec.why.headline}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge
                    value={rec.policy.benchmarkMode}
                    tone={
                      rec.policy.benchmarkMode === 'controlled_comparison'
                        ? 'info'
                        : rec.policy.benchmarkMode === 'maximum_capability'
                          ? 'progress'
                          : 'neutral'
                    }
                    humanize
                  />
                  {rec.policy.frozen && (
                    <StatusBadge value="frozen" tone="neutral" />
                  )}
                </div>
              </div>
            </div>

            {/* Null recommendation → all candidates blocked */}
            {eligibleOrdered.length === 0 && excluded.length > 0 && (
              <EmptyState
                title="No eligible candidates"
                description="Every candidate was excluded by the policy layer's hard filter. Review the blocking reasons below and adjust the project policy on the Execution Preferences page."
              />
            )}

            {/* Eligible candidates (recommended first) */}
            {eligibleOrdered.length > 0 && (
              <div className="space-y-2">
                <SectionHeader
                  title="Eligible candidates"
                  description={`${eligibleOrdered.length} eligible — the recommended candidate is pre-selected`}
                />
                <div
                  role="radiogroup"
                  aria-label="Eligible execution candidates"
                  className="space-y-2"
                >
                  {eligibleOrdered.map((c) => (
                    <CandidateRow
                      key={candidateKey(c)}
                      c={c}
                      recommended={
                        !!recommended && candidateKey(c) === candidateKey(recommended)
                      }
                      selected={!!selectedKey && candidateKey(c) === selectedKey}
                      selectable
                      onSelect={() => setSelectedKey(candidateKey(c))}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Excluded candidates — disabled + destructive Alert */}
            {excluded.length > 0 && (
              <div className="space-y-2">
                <SectionHeader
                  title="Excluded candidates"
                  description={`${excluded.length} blocked by the hard filter — selection disabled (§17)`}
                />
                <div className="space-y-2">
                  {excluded.map((c) => (
                    <CandidateRow
                      key={candidateKey(c)}
                      c={c}
                      recommended={false}
                      selected={false}
                      selectable={false}
                      onSelect={() => undefined}
                    />
                  ))}
                </div>
              </div>
            )}

            <Separator />

            {/* Controlled-comparison dimensions (§10) */}
            {cmp && (
              <div className="space-y-2">
                <SectionHeader
                  title="Controlled comparison dimensions"
                  description="Which dimensions are held fixed (✓) vs genuinely differ (≠)"
                />
                <ComparisonDimensions d={cmp} />
              </div>
            )}

            {/* Why? expander */}
            <WhyExpander why={rec.why} />

            {/* Selected candidate summary */}
            {selectedCandidate && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Selected for submission
                    </span>
                    <span className="text-sm font-semibold text-foreground">
                      {selectedCandidate.name}
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {selectedCandidate.provider}/{selectedCandidate.model || 'default'}
                      </span>
                    </span>
                  </div>
                  <StatusBadge
                    value={selectedCandidate.executionMode}
                    tone={selectedCandidate.executionMode === 'native' ? 'info' : 'progress'}
                    showDot={false}
                    humanize
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Submitting will call <span className="font-mono">POST /work-items/:id/execution</span>{' '}
                  with this candidate's mode/provider/model. The backend owns
                  authorization, execution dispatch, and the audit trail.
                </p>
              </div>
            )}

            {/* Parent error (e.g. execution.start failure) */}
            {error && (
              <Alert variant="destructive">
                <AlertTitle>Execution start failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {/* Null recommendation (no candidates at all) */}
        {!state.loading && !state.error && !rec && (
          <EmptyState
            title="No recommendation available"
            description="The policy layer returned no recommendation. This may be a temporary backend issue — retry or close and reopen the dialog."
            action={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRetryNonce((n) => n + 1)}
                disabled={busy}
              >
                Retry
              </Button>
            }
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? 'Starting…' : 'Start Implementation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ExecutionPolicyDialog;
