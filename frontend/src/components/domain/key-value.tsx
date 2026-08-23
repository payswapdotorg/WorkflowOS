import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Code/KeyValue display — a small two-column row used in detail panels.
 * The label is muted + small caps; the value is foreground + mono when
 * `mono` is set. Used for IDs, refs, SHAs, etc.
 */
interface KeyValueProps {
  label: React.ReactNode;
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}

export function KeyValue({ label, children, mono = false, className }: KeyValueProps) {
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          'text-sm text-foreground',
          mono && 'font-mono text-xs',
        )}
      >
        {children}
      </dd>
    </div>
  );
}
