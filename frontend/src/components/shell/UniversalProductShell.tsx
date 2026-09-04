import * as React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Activity, Code2, Compass, Home, ListChecks, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';

/**
 * UniversalProductShell — the human-facing product frame (V2-017 Task 1).
 *
 * The approved universal model: primary navigation is intentionally small —
 * Home / Workflows / Explore / Activity — plus the universal Create entry.
 * The developer/engineering workspace remains reachable through the Expert
 * workspace entry in the footer: progressive disclosure, never primary
 * navigation (UX spec §3/§25; work-order rule 8 — re-contextualized, not
 * deleted).
 *
 * The shell owns NO product state: it renders navigation and frames content.
 * Every value shown by the pages inside it comes from the backend
 * authorities — the frontend is a consumer only.
 */

interface ProductNavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (pathname: string) => boolean;
}

const PRODUCT_NAV: ProductNavItem[] = [
  { to: '/', label: 'Home', icon: Home, match: (p) => p === '/' },
  { to: '/workflows', label: 'Workflows', icon: ListChecks, match: (p) => p.startsWith('/workflows') },
  { to: '/explore', label: 'Explore', icon: Compass, match: (p) => p.startsWith('/explore') },
  { to: '/activity', label: 'Activity', icon: Activity, match: (p) => p.startsWith('/activity') },
];

interface UniversalProductShellProps {
  children: React.ReactNode;
}

export function UniversalProductShell({ children }: UniversalProductShellProps) {
  const location = useLocation();
  // V2-017: the session surface stays on the human-facing frame (the
  // WORK-074 journey signs out from the product root). Sign-out goes
  // through the canonical auth client — the backend remains the session
  // authority and the App gate re-renders without a reload.
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Persistent product header: brand + primary navigation + Create. */}
      <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:gap-4 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2" aria-label="WorkflowOS home">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Activity className="h-4 w-4" />
            </div>
            <span className="hidden text-sm font-semibold tracking-tight sm:inline">WorkflowOS</span>
          </Link>

          <nav
            className="wfos-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            aria-label="Primary"
          >
            {PRODUCT_NAV.map((item) => {
              const active = item.match(location.pathname);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/create"
              className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              <span>Create</span>
            </Link>
            <span
              className="hidden max-w-[12rem] truncate text-xs text-muted-foreground lg:inline"
              title={user?.email ?? user?.displayName ?? undefined}
            >
              {user?.email ?? user?.displayName ?? 'Session user'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      {/* Page content. */}
      <main className="wfos-scroll flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</div>
      </main>

      {/* Product footer: user-facing brand + the intentional expert entry
          (INSPECT level). V2-017 HOLD correction: no implementation-authority
          copy — architectural machinery stays behind the interface (UX
          spec §3/§25); the footer stays navigation/action-focused. */}
      <footer className="mt-auto border-t border-border bg-card">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 text-xs text-muted-foreground sm:px-6">
          <span>WorkflowOS</span>
          <Link
            to="/expert"
            className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
          >
            <Code2 className="h-3.5 w-3.5" />
            Expert workspace
          </Link>
        </div>
      </footer>
    </div>
  );
}

export default UniversalProductShell;
