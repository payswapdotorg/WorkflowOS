import * as React from 'react';
import { cn } from '@/lib/cn';

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'destructive' | 'info' | 'success' | 'warning';
}

const VARIANT_CLASS: Record<NonNullable<AlertProps['variant']>, string> = {
  default: 'bg-muted text-foreground border-border',
  destructive: 'bg-destructive/5 text-destructive border-destructive/30',
  info: 'bg-info/5 text-info border-info/30',
  success: 'bg-success/5 text-success border-success/30',
  warning: 'bg-warning/10 text-warning-foreground border-warning/40',
};

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(
        'relative w-full rounded-md border p-4 text-sm [&_svg]:size-4 [&_svg]:shrink-0',
        VARIANT_CLASS[variant],
        className,
      )}
      {...props}
    />
  ),
);
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn('mb-1 font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
