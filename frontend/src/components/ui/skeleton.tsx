import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Skeleton — shadcn/ui placeholder. Used by LoadingState for shimmer.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
