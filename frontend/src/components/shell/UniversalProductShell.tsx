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
 * V2-017 Task 14 — the responsive adaptation: the SAME approved model is
 * presented platform-appropriately per viewport. Below `sm` the primary
 * navigation is a bottom bar at thumb reach (the four destinations plus
 * the universal Create entry as the center action — the UX spec §3 mobile
 * hierarchy); from `sm` up it is the header row, unchanged (tablet and
 * desktop behavior is preserved). The two surfaces are separated purely
 * by CSS display, so every real viewport exposes exactly one Primary
 * navigation landmark, and both surfaces render the identical
 * destinations and active state — no mobile-only destinations, no
 * semantics drift, no second navigation model. Touch targets meet the
 * platform minimum with margin (min-h-14 = 56px), the home-indicator
 * safe area is reserved, and a clearance spacer guarantees the fixed bar
 * never covers the footer.
 *
 * The shell owns NO product state: it renders navigation and frames
 * content. Every value shown by the pages inside it comes from the
 * backend authorities — the frontend is a consumer only.
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
      {/* Persistent product header: brand + primary navigation (sm+) + Create. */}
      <header className="sticky top-0 z-30 border-b border-border bg-card/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:gap-4 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2" aria-label="WorkflowOS home">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Activity className="h-4 w-4" />
            </div>
            <span className="hidden text-sm font-semibold tracking-tight sm:inline">WorkflowOS</span>
          </Link>

          <nav
            data-testid="header-primary-nav"
            className="wfos-scroll hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto sm:flex"
            aria-label="Primary"
          >
            {PRODUCT_NAV.map((item) => {
              const active = item.match(location.pathname);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  aria-label={item.label}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
                  )}
                >
                  <item.icon className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden md:inline">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            {/* The universal Create entry (T14: hidden below sm — the
                bottom bar carries it there as the center action). */}
            <Link
              to="/create"
              data-testid="header-create-entry"
              className="hidden items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:inline-flex"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
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

      {/* V2-017 T14 — the mobile primary navigation. Below `sm` the
          approved model lives at thumb reach: the four destinations with
          the universal Create entry as the emphasized center action.
          `sm:hidden` — from `sm` up the header carries the model and this
          surface is not rendered (display-level separation: each real
          viewport exposes exactly one Primary landmark). */}
      <nav
        data-testid="mobile-primary-nav"
        data-safe-area="true"
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        <div className="mx-auto grid h-16 w-full max-w-6xl grid-cols-5 items-stretch px-2">
          {PRODUCT_NAV.slice(0, 2).map((item) => (
            <MobileNavItem key={item.to} item={item} active={item.match(location.pathname)} />
          ))}
          <Link
            to="/create"
            aria-label="Create"
            className="flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-transform active:scale-95">
              <Plus className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="text-muted-foreground">Create</span>
          </Link>
          {PRODUCT_NAV.slice(2).map((item) => (
            <MobileNavItem key={item.to} item={item} active={item.match(location.pathname)} />
          ))}
        </div>
      </nav>

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

      {/* T14 clearance: the fixed bottom bar reserves flow space below sm
          so the footer (and any short page's end) is never covered — the
          4rem bar + margin, and the same home-indicator safe inset the bar
          reserves. From `sm` up the spacer collapses — the desktop layout
          is unchanged. */}
      <div
        data-testid="mobile-nav-clearance"
        aria-hidden="true"
        className="h-[calc(4rem+1.25rem)] pb-[env(safe-area-inset-bottom)] sm:hidden"
      />
    </div>
  );
}

/** One bottom-bar destination (T14): icon + label, 56px touch target,
 *  the same aria-current active state as the header surface. */
function MobileNavItem({
  item,
  active,
}: {
  item: ProductNavItem;
  active: boolean;
}) {
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors',
        active
          ? 'text-primary'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <item.icon className="h-5 w-5" aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}

export default UniversalProductShell;
