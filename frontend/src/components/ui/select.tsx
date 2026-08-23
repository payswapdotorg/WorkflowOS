import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Select — lightweight native-styled select. We deliberately keep the
 * implementation tiny (no Radix Select dependency) since the frontend
 * only needs controlled dropdowns for forms (org picker, status filters).
 * Style tuned to match Input.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'flex h-9 w-full appearance-none rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'bg-[url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%2380766d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>\')] bg-[length:16px] bg-[right_0.5rem_center] bg-no-repeat pr-8',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

export { Select };
