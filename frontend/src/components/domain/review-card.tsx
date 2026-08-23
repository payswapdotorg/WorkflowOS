import * as React from 'react';
import { MessageSquare, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Review, ReviewFinding } from '@/api/client';
import { StatusBadge } from '@/components/domain/status-badge';
import { Badge } from '@/components/ui/badge';

/**
 * ReviewCard — renders an architect review + its findings. The frontend
 * does NOT mutate review verdicts; it only displays the authoritative
 * outcome the backend persisted. The caller may pass the findings fetched
 * separately via `GET /reviews/:reviewId/findings`.
 */
interface ReviewCardProps {
  review: Review;
  findings?: ReviewFinding[];
  className?: string;
}

const SEVERITY_TONE: Record<string, 'destructive' | 'warning' | 'info' | 'outline'> = {
  blocker: 'destructive',
  major: 'warning',
  minor: 'info',
  info: 'outline',
};

const OUTCOME_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  approve: CheckCircle2,
  approved: CheckCircle2,
  reject: XCircle,
  rejected: XCircle,
  changes_requested: AlertCircle,
};

export function ReviewCard({ review, findings, className }: ReviewCardProps) {
  const OutcomeIcon =
    OUTCOME_ICON[(review.outcome || '').toLowerCase()] ?? MessageSquare;
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-md border border-border bg-card p-4',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <OutcomeIcon className="h-3.5 w-3.5" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              {review.source}
              <span className="text-xs font-normal text-muted-foreground">
                · {review.reviewer || 'unattributed'}
              </span>
            </div>
            {review.summary && (
              <p className="text-sm text-muted-foreground">{review.summary}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusBadge value={review.status} />
          {review.outcome && (
            <Badge variant={review.outcome.toLowerCase().includes('approve') ? 'success' : review.outcome.toLowerCase().includes('reject') ? 'destructive' : 'warning'}>
              {review.outcome}
            </Badge>
          )}
        </div>
      </div>
      {findings && findings.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-border pt-3">
          {findings.map((f) => (
            <li
              key={f.id}
              className="flex flex-col gap-1 rounded-sm bg-muted/40 p-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  {f.title}
                </span>
                <Badge variant={SEVERITY_TONE[f.severity] ?? 'outline'}>
                  {f.severity}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{f.description}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <Badge variant="outline">
                  disposition: {f.disposition}
                </Badge>
                {f.criterionId && (
                  <Badge variant="outline">
                    criterion: {f.criterionId.slice(0, 8)}
                  </Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
