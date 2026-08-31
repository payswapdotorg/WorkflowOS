import * as React from 'react';
import { Link, useLocation, useParams, useNavigate } from 'react-router-dom';
import {
  FolderKanban,
  Boxes,
  Sparkles,
  ListChecks,
  Activity,
  Settings,
  ChevronRight,
  Menu,
  LogOut,
  CircleUser,
  PanelsTopLeft,
  Gauge,
  MonitorCog,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/hooks/useAuth';
import { projects as projectsApi, type Project } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Breadcrumbs } from '@/components/domain/breadcrumbs';
import { ToastHost } from '@/components/ui/toast';

/**
 * AppShell — the persistent product frame (sidebar + topbar + footer).
 *
 * The shell NEVER owns project state. It only:
 *   - renders navigation;
 *   - reads route params to derive breadcrumbs;
 *   - fetches the current project (if any) for sidebar context display.
 *
 * The backend remains the authority for every visible value. A 403 from
 * `GET /projects/:id` propagates as a null project context — the sidebar
 * shows the project picker instead of the project name.
 */

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (pathname: string) => boolean;
}

/**
 * WORK-032: top-level (non-project) navigation. The Benchmarks nav is a
 * cross-cutting harness outside any single project's lifecycle — it lives
 * above the project nav so it is reachable from anywhere in the product.
 */
const GLOBAL_NAV: NavItem[] = [
  { to: '/benchmarks', label: 'Benchmarks', icon: Gauge, match: (p) => p.startsWith('/benchmarks') },
];

const PROJECT_NAV: NavItem[] = [
  // WORK-048: the Developer Workbench — the primary human-facing engineering
  // workspace (a consumer of backend authorities, never one itself).
  { to: 'workbench', label: 'Workbench', icon: MonitorCog, match: (p) => p.startsWith('workbench') },
  { to: '', label: 'Overview', icon: FolderKanban, match: (p) => p === '' || p === '/' },
  { to: 'architect', label: 'Architect', icon: Sparkles, match: (p) => p.startsWith('architect') },
  { to: 'architecture', label: 'Architecture', icon: Boxes, match: (p) => p.startsWith('architecture') },
  { to: 'requirements', label: 'Requirements', icon: ListChecks, match: (p) => p.startsWith('requirements') },
  { to: 'work-items', label: 'Work Items', icon: PanelsTopLeft, match: (p) => p.startsWith('work-items') },
  { to: 'activity', label: 'Activity', icon: Activity, match: (p) => p.startsWith('activity') },
];

interface ProjectContextValue {
  project: Project | null;
  loading: boolean;
  error: string | null;
}

const ProjectContext = React.createContext<ProjectContextValue>({
  project: null,
  loading: false,
  error: null,
});

export function useProjectContext(): ProjectContextValue {
  return React.useContext(ProjectContext);
}

interface SidebarNavProps {
  _pid: string | undefined;
  project: Project | null;
  onNavigate?: () => void;
}

function SidebarNav({ _pid, project, onNavigate }: SidebarNavProps) {
  const location = useLocation();
  const projectBase = _pid ? `/projects/${_pid}` : null;
  return (
    <nav className="flex h-full flex-col gap-1.5 p-3" aria-label="Primary">
      <Link
        to="/"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent"
      >
        <FolderKanban className="h-4 w-4" />
        All Projects
      </Link>
      <div className="mt-2 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Global
      </div>
      <div className="flex flex-col gap-0.5">
        {GLOBAL_NAV.map((item) => {
          const active = item.match(location.pathname);
          return (
            <Link
              key={item.label}
              to={item.to}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </div>
      <div className="mt-2 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Project
      </div>
      {projectBase ? (
        <div className="flex flex-col gap-0.5">
          <div className="px-3 py-1">
            <div className="truncate text-sm font-semibold text-sidebar-foreground">
              {project ? project.name : '—'}
            </div>
            {project && (
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {project.id}
              </div>
            )}
          </div>
          {PROJECT_NAV.map((item) => {
            const to = `${projectBase}${item.to ? `/${item.to}` : ''}`;
            const sub = location.pathname.replace(projectBase, '').replace(/^\//, '');
            const active = item.match(sub);
            return (
              <Link
                key={item.label}
                to={to}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
          <Link
            to={`/projects/${_pid}/settings`}
            onClick={onNavigate}
            className={cn(
              'mt-1 flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
              location.pathname.endsWith('/settings')
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
            )}
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
        </div>
      ) : (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          No project selected. Pick a project from the dashboard.
        </div>
      )}
    </nav>
  );
}

function useBreadcrumbs(): { items: { label: string; to?: string }[] } {
  const location = useLocation();
  const { projectId: _pid = "" } = useParams<{ projectId: string }>();
  const path = location.pathname;
  const items: { label: string; to?: string }[] = [
    { label: 'WorkflowOS', to: '/' },
  ];
  if (path === '/' || path === '/projects') {
    items.push({ label: 'Projects' });
    return { items };
  }
  if (path === '/settings') {
    items.push({ label: 'Settings' });
    return { items };
  }
  const projectMatch = path.match(/^\/projects\/([^/]+)(\/([^/]+))?/);
  if (projectMatch) {
    const _pid = projectMatch[1]!;
    items.push({ label: 'Projects', to: '/' });
    items.push({ label: _pid.slice(0, 8), to: `/projects/${_pid}` });
    const section = projectMatch[3];
    if (section) {
      items.push({ label: section.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) });
    }
    return { items };
  }
  const workItemMatch = path.match(/^\/work-items\/([^/]+)/);
  if (workItemMatch) {
    items.push({ label: 'Projects', to: '/' });
    items.push({ label: `Work Item ${workItemMatch[1]!.slice(0, 8)}` });
    return { items };
  }
  // WORK-032: Benchmarks top-level nav section. The benchmarks harness
  // is a cross-cutting consumer that lives outside any single project.
  if (path.startsWith('/benchmarks')) {
    items.push({ label: 'Projects', to: '/' });
    items.push({ label: 'Benchmarks', to: '/benchmarks' });
    const newMatch = path.match(/^\/benchmarks\/new$/);
    if (newMatch) {
      items.push({ label: 'New' });
      return { items };
    }
    const trialMatch = path.match(/^\/benchmarks\/trials\/([^/]+)/);
    if (trialMatch) {
      items.push({ label: `Trial ${trialMatch[1]!.slice(0, 8)}` });
      return { items };
    }
    const detailMatch = path.match(/^\/benchmarks\/([^/]+)(?:\/(compare))?$/);
    if (detailMatch && detailMatch[1] !== 'new') {
      items.push({ label: detailMatch[1]!.slice(0, 8), to: `/benchmarks/${detailMatch[1]}` });
      if (detailMatch[2] === 'compare') {
        items.push({ label: 'Compare' });
      }
      return { items };
    }
    return { items };
  }
  return { items };
}

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  // WORK-074: sign-out goes through the canonical auth client (server-side
  // session revocation); the demo-key prefix display is retired.
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { projectId: _pid = "" } = useParams<{ projectId: string }>();
  
  
  const [project, setProject] = React.useState<any | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (!_pid) {
      setProject(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    projectsApi
      .get(_pid)
      .then((p) => {
        if (!cancelled) {
          setProject(p);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load project');
          setProject(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [_pid]);

  const ctx = React.useMemo<ProjectContextValue>(
    () => ({ project, loading, error }),
    [project, loading, error],
  );

  const { items: crumbs } = useBreadcrumbs();

  const handleSignOut = async () => {
    await logout();
    navigate('/');
  };

  return (
    <ToastHost>
      <ProjectContext.Provider value={ctx}>
        <div className="flex min-h-screen flex-col bg-background">
          <div className="flex flex-1">
            {/* Desktop sidebar */}
            <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
              <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
                <Link to="/" className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Activity className="h-4 w-4" />
                  </div>
                  <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
                    WorkflowOS
                  </span>
                </Link>
              </div>
              <div className="wfos-scroll h-[calc(100vh-3.5rem)] overflow-y-auto">
                <SidebarNav _pid={_pid} project={project} />
              </div>
            </aside>

            {/* Mobile sidebar (Sheet) */}
            <div className="fixed left-0 top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-card px-4 md:hidden w-full">
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Open navigation">
                    <Menu className="h-4 w-4" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-72 p-0">
                  <SheetTitle className="sr-only">Navigation</SheetTitle>
                  <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                      <Activity className="h-4 w-4" />
                    </div>
                    <span className="text-sm font-semibold tracking-tight">
                      WorkflowOS
                    </span>
                  </div>
                  <div className="wfos-scroll h-[calc(100vh-3.5rem)] overflow-y-auto">
                    <SidebarNav
                      _pid={_pid}
                      project={project}
                      onNavigate={() => setMobileOpen(false)}
                    />
                  </div>
                </SheetContent>
              </Sheet>
              <Link to="/" className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Activity className="h-4 w-4" />
                </div>
                <span className="text-sm font-semibold tracking-tight">
                  WorkflowOS
                </span>
              </Link>
            </div>

            {/* Main column */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Desktop top bar */}
              <header className="sticky top-0 z-30 hidden h-14 items-center justify-between gap-4 border-b border-border bg-card/80 px-6 backdrop-blur md:flex">
                <Breadcrumbs items={crumbs} />
                <div className="flex items-center gap-2">
                  <span className="hidden text-xs text-muted-foreground lg:inline">
                    Backend retains all authoritative state
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="gap-1.5">
                        <CircleUser className="h-4 w-4" />
                        <span className="hidden sm:inline">Session</span>
                        <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
                      <DropdownMenuItem disabled className="text-[11px] opacity-70">
                        {user?.email ?? user?.displayName ?? 'Session user'}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <Link to="/settings">Settings</Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={handleSignOut} className="text-destructive focus:text-destructive">
                        <LogOut className="h-3.5 w-3.5" />
                        Sign out
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </header>

              {/* Mobile top bar */}
              <header className="sticky top-14 z-20 flex h-12 items-center justify-between gap-2 border-b border-border bg-card px-4 md:hidden">
                <Breadcrumbs items={crumbs} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Session menu">
                      <CircleUser className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem asChild>
                      <Link to="/settings">Settings</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={handleSignOut} className="text-destructive focus:text-destructive">
                      <LogOut className="h-3.5 w-3.5" />
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </header>

              <main className="wfos-scroll flex-1 overflow-y-auto p-4 pt-6 md:p-8">
                <div className="mx-auto w-full max-w-6xl">{children}</div>
              </main>
            </div>
          </div>

          {/* Footer — preserved text from WORK-022 regression test */}
          <footer className="mt-auto flex h-10 items-center justify-between gap-3 border-t border-border bg-card px-4 text-xs text-muted-foreground md:px-6">
            <span>WorkflowOS — Backend retains all authoritative state.</span>
            <span className="hidden sm:inline">Frontend is a consumer only.</span>
          </footer>
        </div>
      </ProjectContext.Provider>
    </ToastHost>
  );
}

export default AppShell;
