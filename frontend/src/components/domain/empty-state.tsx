import * as React from 'react';
import { cn } from '@/lib/cn';

interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  'data-testid': testid,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testid}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center',
        className,
      )}
    >
      {Icon && (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && (
        <div className="max-w-md text-xs text-muted-foreground">{description}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
