import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * WORK-032: hand-rolled SVG metric bar — used inside the BenchmarkComparison
 * page to visualize a numeric value (e.g. correctionCycles, timeToVerifiedMs)
 * relative to a max across compared trials. Deliberately tiny: NO tooltip,
 * NO animation, NO chart library. Uses the OKLCH palette tokens directly via
 * `var(--color-*)` so the bar matches the design system.
 *
 * Color rules (purely cosmetic — the frontend never derives verdicts):
 *   - if `lowerIsBetter` AND value is the min of the sibling set → success tone
 *   - if value is the max of the sibling set → destructive tone
 *   - otherwise → primary tone
 *
 * Pass `isMin` and `isMax` from the parent (the parent already iterates the
 * comparison set and knows the bounds). This component never recomputes the
 * bounds — it is purely presentational.
 */
export interface BenchmarkMetricBarProps {
  label: React.ReactNode;
  value: number | null | undefined;
  max: number;
  /** When true, a lower numeric value is "better" (e.g. correctionCycles). */
  lowerIsBetter?: boolean;
  /** Set by the parent — true when this row's value is the minimum of the set. */
  isMin?: boolean;
  /** Set by the parent — true when this row's value is the maximum of the set. */
  isMax?: boolean;
  /** Optional formatter (e.g. format ms as "5m 12s"). Falls back to String(value). */
  format?: (n: number) => string;
  className?: string;
}

const TOKEN_PRIMARY = 'var(--color-primary)';
const TOKEN_SUCCESS = 'var(--color-success)';
const TOKEN_DESTRUCTIVE = 'var(--color-destructive)';

export function BenchmarkMetricBar({
  label,
  value,
  max,
  lowerIsBetter = false,
  isMin = false,
  isMax = false,
  format,
  className,
}: BenchmarkMetricBarProps) {
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.max(0, Math.min(1, safeValue / safeMax));
  const BAR_WIDTH = 160; // SVG user units
  const BAR_HEIGHT = 10;
  const width = Math.max(2, ratio * BAR_WIDTH);

  let fill = TOKEN_PRIMARY;
  if (lowerIsBetter && isMin && safeValue > 0) fill = TOKEN_SUCCESS;
  if (!lowerIsBetter && isMax && safeValue > 0) fill = TOKEN_DESTRUCTIVE;
  if (lowerIsBetter && isMax && safeValue > 0) fill = TOKEN_DESTRUCTIVE;
  if (!lowerIsBetter && isMin && safeValue > 0) fill = TOKEN_SUCCESS;

  const displayValue =
    typeof value === 'number' && Number.isFinite(value)
      ? format
        ? format(value)
        : String(value)
      : '—';

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border border-border bg-card p-3',
        className,
      )}
    >
      <div className="min-w-32 flex-1 text-sm text-foreground">{label}</div>
      <svg
        viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}
        width={BAR_WIDTH}
        height={BAR_HEIGHT}
        role="img"
        aria-label={`${label}: ${displayValue}`}
        className="shrink-0"
      >
        <rect
          x={0}
          y={0}
          width={BAR_WIDTH}
          height={BAR_HEIGHT}
          rx={3}
          ry={3}
          fill="var(--color-muted)"
        />
        <rect
          x={0}
          y={0}
          width={width}
          height={BAR_HEIGHT}
          rx={3}
          ry={3}
          fill={fill}
        />
      </svg>
      <div className="w-16 text-right font-mono text-xs text-foreground tabular-nums">
        {displayValue}
      </div>
    </div>
  );
}
