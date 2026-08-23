/**
 * WORK-022 design system utility: combine class names safely.
 *
 * `clsx` handles conditional classes; `tailwind-merge` deduplicates
 * conflicting Tailwind utilities (e.g. `p-2 p-4` → `p-4`). Together they
 * give us the ergonomic `cn('foo', condition && 'bar', baz)` pattern used
 * across shadcn/ui components.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
