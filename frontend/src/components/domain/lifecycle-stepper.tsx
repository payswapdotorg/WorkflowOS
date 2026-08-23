import { cn } from '@/lib/cn';

/**
 * LifecycleStepper — a vertical stepper for the Work Item "Workflow
 * Actions" panel. Each step has a label, a description, and a state
 * (`complete` | `current` | `upcoming`). The component is purely
 * presentational: the caller decides which step is current based on the
 * backend-supplied workflow state string.
 */
export interface Step {
  key: string;
  label: string;
  description?: string;
  state: 'complete' | 'current' | 'upcoming';
}

interface LifecycleStepperProps {
  steps: Step[];
  className?: string;
}

export function LifecycleStepper({ steps, className }: LifecycleStepperProps) {
  return (
    <ol className={cn('relative', className)} aria-label="Lifecycle steps">
      {steps.map((step, idx) => {
        const isLast = idx === steps.length - 1;
        const dotClass =
          step.state === 'complete'
            ? 'border-success/40 bg-success text-success-foreground'
            : step.state === 'current'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-muted-foreground';
        return (
          <li
            key={step.key}
            className="relative flex gap-3 pb-5 last:pb-0"
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold',
                  dotClass,
                )}
              >
                {step.state === 'complete' ? '✓' : idx + 1}
              </span>
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-1 w-px flex-1',
                    step.state === 'complete' ? 'bg-success/40' : 'bg-border',
                  )}
                />
              )}
            </div>
            <div className="flex-1 pt-0.5">
              <div
                className={cn(
                  'text-sm font-medium',
                  step.state === 'upcoming' && 'text-muted-foreground',
                )}
              >
                {step.label}
              </div>
              {step.description && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {step.description}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
