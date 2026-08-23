import { Check, Circle, Dot } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import type { WorkflowTransition } from '@/api/client';

/**
 * WorkflowTimeline — display-only lifecycle visualization.
 *
 * The frontend does NOT own the canonical workflow state graph. The
 * `/workflows` module is the EXCLUSIVE owner. The buckets below are
 * purely cosmetic groupings of opaque backend state strings — they
 * control only which icon/color a stage renders, never whether a
 * transition is legal. The authoritative current state is always
 * whatever the backend returned via the API.
 *
 * The component has two surfaces:
 *
 *  - `<WorkflowTimeline.Stages>` — the horizontal stage indicator at the
 *    top of the Work Item page (Draft → Implementation → Review →
 *    Merge → Verified). The current stage is derived from the
 *    backend-supplied current state string; never from a frontend state
 *    machine.
 *
 *  - `<WorkflowTimeline.History>` — the vertical, append-only transition
 *    history. Each entry is rendered as a timeline row with the from→to
 *    states, actor, and timestamp — all backend-supplied.
 */

/** Cosmetic display buckets. NOT a transition map — just visual groupings. */
export const LIFECYCLE_STAGES = [
  'Draft',
  'Ready',
  'Implementation',
  'Review',
  'Merge',
  'Verified',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/**
 * Cosmetically classify an opaque backend state string into one of the
 * display stages. The frontend does NOT use this to decide transitions —
 * it only uses it to pick which stage indicator to highlight. Unknown
 * states fall back to the closest stage by keyword.
 */
export function classifyStage(currentState: string | null | undefined): LifecycleStage {
  if (!currentState) return 'Draft';
  const v = currentState.toLowerCase();
  if (v.includes('verified')) return 'Verified';
  if (v.includes('merged')) return 'Merge';
  if (v.includes('approved')) return 'Merge';
  if (v.includes('architect_review') || v.includes('changes_requested') || v.includes('architecture_change'))
    return 'Review';
  if (v.includes('verifying') || v.includes('verification')) return 'Review';
  if (v.includes('implement') || v.includes('pr_open') || v.includes('assigned') || v.includes('blocked'))
    return 'Implementation';
  if (v.includes('ready')) return 'Ready';
  return 'Draft';
}

interface StagesProps {
  currentState: string | null | undefined;
  className?: string;
}

function Stages({ currentState, className }: StagesProps) {
  const currentStage = classifyStage(currentState);
  const currentIndex = LIFECYCLE_STAGES.indexOf(currentStage);

  return (
    <ol
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-3 text-xs',
        className,
      )}
      aria-label="Lifecycle stages"
    >
      {LIFECYCLE_STAGES.map((stage, idx) => {
        const isCurrent = stage === currentStage;
        const isComplete = idx < currentIndex;
        return (
          <li key={stage} className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-medium transition-colors',
                isCurrent &&
                  'border-primary/40 bg-primary/10 text-primary',
                isComplete &&
                  'border-success/30 bg-success/10 text-success',
                !isCurrent &&
                  !isComplete &&
                  'border-border bg-card text-muted-foreground',
              )}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {isComplete ? (
                <Check className="h-3 w-3" />
              ) : isCurrent ? (
                <Circle className="h-2.5 w-2.5 fill-current" />
              ) : (
                <Dot className="h-3 w-3 opacity-50" />
              )}
              {stage}
            </span>
            {idx < LIFECYCLE_STAGES.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  'h-px w-4 sm:w-6',
                  idx < currentIndex ? 'bg-success/40' : 'bg-border',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

interface HistoryProps {
  transitions: WorkflowTransition[];
  className?: string;
}

function History({ transitions, className }: HistoryProps) {
  if (transitions.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No transitions recorded yet.
      </div>
    );
  }
  return (
    <ol className={cn('relative', className)} aria-label="Transition history">
      <span
        aria-hidden="true"
        className="absolute left-[7px] top-1 bottom-1 w-px bg-border"
      />
      {transitions.map((t) => (
        <li
          key={t.id}
          className="relative flex gap-3 pb-4 last:pb-0"
        >
          <span
            aria-hidden="true"
            className="mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-border bg-card"
          >
            <span className="h-1 w-1 rounded-full bg-muted-foreground" />
          </span>
          <div className="flex flex-col gap-0.5 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-foreground">
                {t.fromState} → {t.toState}
              </span>
              {t.transitionType && (
                <span className="text-xs text-muted-foreground">
                  ({t.transitionType})
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              {t.actor && <span>by {t.actor}</span>}
              <span>{formatDateTime(t.createdAt)}</span>
              {t.executionId && (
                <span className="font-mono text-[10px] opacity-70">
                  exec {t.executionId.slice(0, 8)}
                </span>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export const WorkflowTimeline = {
  Stages,
  History,
  classifyStage,
  LIFECYCLE_STAGES,
};
