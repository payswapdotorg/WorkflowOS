import { AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  className?: string;
  'data-testid'?: string;
}

/**
 * ErrorState — presentational error block. The frontend never fabricates
 * error text: it surfaces the message the backend returned (the api client
 * unwraps the 4xx body for us). The optional `Error:` prefix is preserved
 * so existing rendered-UI integration tests (which match `/Error:/i`) keep
 * passing.
 */
export function ErrorState({
  message,
  onRetry,
  className,
  'data-testid': testid,
}: ErrorStateProps) {
  return (
    <div
      data-testid={testid}
      role="alert"
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <span className="font-medium">Error:</span>{' '}
        <span>{message}</span>
      </div>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="h-7 border-destructive/30 text-destructive hover:bg-destructive/10"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      )}
    </div>
  );
}
