import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Skeleton } from '@/components/ui/skeleton';

interface LoadingStateProps {
  label?: string;
  className?: string;
  'data-testid'?: string;
}

export function LoadingState({
  label = 'Loading…',
  className,
  'data-testid': testid,
}: LoadingStateProps) {
  return (
    <div
      data-testid={testid}
      className={cn(
        'flex items-center gap-2 text-sm text-muted-foreground',
        className,
      )}
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

/**
 * Skeleton list — for sections that show a list of cards while loading.
 * Renders `count` skeleton card placeholders.
 */
export function SkeletonList({
  count = 3,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="rounded-md border border-border bg-card p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-3 w-2/3" />
          <Skeleton className="mt-2 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
