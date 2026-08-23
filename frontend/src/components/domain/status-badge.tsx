import { Badge, type BadgeProps } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { titleCase } from '@/lib/format';

/**
 * StatusBadge — domain component for rendering backend-supplied state
 * strings. The variant mapping is purely cosmetic; the canonical state
 * lives on the backend (the /workflows module owns the legal transition
 * map). The frontend never decides which state should display — it only
 * classifies an arbitrary backend string into one of {neutral, progress,
 * success, warning, destructive, info} for color.
 */

type Tone =
  | 'neutral'
  | 'progress'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'info'
  | 'outline'
  | 'neutral';

const TONE_TO_VARIANT: Record<Tone, BadgeProps['variant']> = {
  neutral: 'secondary',
  progress: 'info',
  success: 'success',
  warning: 'warning',
  destructive: 'destructive',
  info: 'info',
  outline: 'outline',
};

const DOT_CLASS: Record<Tone, string> = {
  outline: 'bg-muted-foreground',
  neutral: 'bg-muted-foreground',
  progress: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  info: 'bg-info',
};

/**
 * Cosmetically classify a backend-supplied state string into a tone.
 *
 * IMPORTANT: this is purely a DISPLAY heuristic. The frontend does NOT
 * derive canonical workflow states, transitions, or authorization. It only
 * picks a reasonable color for an opaque backend string so the UI doesn't
 * look like a sea of grey badges. Strings that don't match any pattern
 * fall through to `neutral`.
 */
export function classifyTone(value: string | null | undefined): Tone {
  if (!value) return 'outline';
  const v = value.toLowerCase();
  if (/(^|_)?draft\b/.test(v) || /\bpending\b/.test(v)) return 'neutral';
  if (/(^|_)?ready\b|assigned|implementing|pr_open|verifying|architect_review|changes_requested|requested\b|processing|active\b|in_progress|in-progress|in_review|in-review|running/.test(v))
    return 'progress';
  if (/(^|_)?verified\b|completed|completed\b|approved\b|merged\b|frozen\b|consumed\b|pass(ed)?\b|satisfied\b|success(ful)?\b/.test(v))
    return 'success';
  if (/(^|_)?blocked\b|verification_failed|implementation_blocked|architecture_change_required|architecture_change_request|rejected|changes_required|outdated|stale\b|warn(ing)?\b/.test(v))
    return 'warning';
  if (/(^|_)?failed\b|destructive|cancelled|abandoned|error\b/.test(v))
    return 'destructive';
  if (/(^|_)?archived\b|superseded\b|closed\b|terminal\b/.test(v)) return 'outline';
  return 'neutral';
}

export interface StatusBadgeProps {
  /** Backend-supplied state string (e.g. `architect_review`, `pass`, `merged`). */
  value: string | null | undefined;
  /** Optional override tone — when set, skips the cosmetic classifier. */
  tone?: Tone;
  /** Whether to render a leading dot indicator. Defaults to true. */
  showDot?: boolean;
  /** Whether to title-case the value (e.g. `architect_review` → `Architect Review`). */
  humanize?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function StatusBadge({
  value,
  tone,
  showDot = true,
  humanize = true,
  className,
  'data-testid': testid,
}: StatusBadgeProps) {
  const resolvedTone = tone ?? classifyTone(value);
  const label = value ? (humanize ? titleCase(value) : value) : '—';
  return (
    <Badge
      variant={TONE_TO_VARIANT[resolvedTone]}
      className={cn('gap-1.5', className)}
      data-testid={testid}
    >
      {showDot && (
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full',
            DOT_CLASS[resolvedTone],
          )}
          aria-hidden="true"
        />
      )}
      {label}
    </Badge>
  );
}

export { type Tone as StatusTone };
