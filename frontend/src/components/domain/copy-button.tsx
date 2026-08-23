import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * CopyButton — copy a string to clipboard with a transient "Copied!" state.
 * Used in the Settings page to copy the masked API key prefix. The button
 * NEVER displays the full secret — callers pass a safe value (prefix only).
 */
interface CopyButtonProps {
  value: string;
  className?: string;
  children?: React.ReactNode;
}

export function CopyButton({ value, className, children }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const onClick = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (older browsers / sandboxed iframes).
      setCopied(false);
    }
  }, [value]);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {copied ? 'Copied' : children ?? 'Copy'}
    </button>
  );
}
