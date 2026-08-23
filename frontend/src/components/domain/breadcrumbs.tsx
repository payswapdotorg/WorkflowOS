import * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Crumb {
  label: React.ReactNode;
  to?: string;
}

interface BreadcrumbsProps {
  items: Crumb[];
  className?: string;
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav
      aria-label="Breadcrumbs"
      className={cn(
        'flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground',
        className,
      )}
    >
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <span key={idx} className="flex items-center gap-0.5">
            {item.to && !isLast ? (
              <Link
                to={item.to}
                className="rounded-sm px-1 py-0.5 hover:bg-accent hover:text-foreground"
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={cn(
                  'rounded-sm px-1 py-0.5',
                  isLast && 'text-foreground',
                )}
                aria-current={isLast ? 'page' : undefined}
              >
                {item.label}
              </span>
            )}
            {!isLast && (
              <ChevronRight className="h-3 w-3 opacity-50" aria-hidden="true" />
            )}
          </span>
        );
      })}
    </nav>
  );
}
