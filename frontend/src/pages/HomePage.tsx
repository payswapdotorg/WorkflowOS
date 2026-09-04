import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  organizations,
  workflowRepository,
  workflowRuns,
  type ProductWorkflow,
  type ProductWorkflowRun,
} from '../api/client';

/**
 * HomePage — the workflow-first Home (V2-017 Task 2).
 *
 * Home answers "What do you want to get done?" (UX spec §4): a single
 * goal/search/creation entry, the recent-workflow read, the run-derived
 * needs-attention read, and the remaining attention surfaces.
 *
 * STATE HONESTY (the dispatch's explicit contract):
 *   loading — a read is in flight;
 *   error   — a read was attempted and failed (visible error + retry;
 *             NEVER rendered as a successful empty state);
 *   empty   — the read succeeded and the items are derivably absent
 *             (e.g. no organization ⇒ no workflows can exist);
 *   data    — real records from the existing public reads;
 *   Unavailable — the surface has no exposed read yet (approvals,
 *             updates, device issues) — an honest "not shown here yet",
 *             never a fabricated empty list.
 *
 * The reads are consume-only: the V2-002 workflow list and the V2-005 run
 * list, aggregated across EVERY organization of the session user (F-T2-001:
 * there is no authoritative current-organization selection — the user's
 * Home scope is the full organization collection, so dropping any of them
 * would silently discard authoritative records). The frontend owns no
 * workflow/run/approval state of its own.
 */

type ReadState<T> =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'data'; items: T[] };

function useHomeRead<T>(fetcher: () => Promise<T[]>) {
  const [state, setState] = useState<ReadState<T>>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetcher()
      .then((items) => {
        if (cancelled) return;
        setState(items.length > 0 ? { kind: 'data', items } : { kind: 'empty' });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // The fetcher is a stable module-level function per surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { state, refetch };
}

/**
 * Recent workflows: the V2-002 read aggregated across every organization of
 * the session user (F-T2-001). All-or-error: Promise.all propagates ANY
 * failed per-organization read, so a partial collection is never presented
 * as a successful result. Empty only when the organization collection is
 * empty (derivably no workflows) or every read succeeded with no items.
 */
async function fetchRecentWorkflows(): Promise<ProductWorkflow[]> {
  const orgs = await organizations.listForUser();
  if (orgs.length === 0) return [];
  const perOrg = await Promise.all(
    orgs.map((org) => workflowRepository.listForOrganization(org.id)),
  );
  return perOrg.flat();
}

/**
 * Needs attention: failed/paused runs (V2-005 read, presentation filter)
 * aggregated across every organization of the session user (F-T2-001), with
 * the same all-or-error semantics: any failed run read errors the surface.
 */
async function fetchAttentionRuns(): Promise<ProductWorkflowRun[]> {
  const orgs = await organizations.listForUser();
  if (orgs.length === 0) return [];
  const perOrg = await Promise.all(
    orgs.map((org) => workflowRuns.listForOrganization(org.id)),
  );
  return perOrg
    .flat()
    .filter((run) => run.state === 'failed' || run.state === 'paused');
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function SurfaceFrame({
  title,
  seeAll,
  children,
}: {
  title: string;
  seeAll?: { to: string };
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex flex-col rounded-xl border border-border bg-card p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">{title}</h2>
        {seeAll && (
          <Link
            to={seeAll.to}
            className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            See all
          </Link>
        )}
      </div>
      <div className="mt-3 flex-1">{children}</div>
    </section>
  );
}

/** The honest Unavailable state: no exposed read for this surface yet. */
function UnavailableSurface({ title, copy }: { title: string; copy: string }) {
  return (
    <SurfaceFrame title={title}>
      <p role="status" aria-label="Unavailable" className="text-sm font-medium text-muted-foreground">
        Unavailable
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{copy}</p>
    </SurfaceFrame>
  );
}

function ReadStates<T>({
  state,
  refetch,
  emptyCopy,
  renderItems,
}: {
  state: ReadState<T>;
  refetch: () => void;
  emptyCopy: string;
  renderItems: (items: T[]) => React.ReactNode;
}) {
  if (state.kind === 'loading') {
    return (
      <p role="status" aria-label="Loading" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div>
        <p role="alert" className="text-sm text-muted-foreground">
          Couldn’t load this right now.
        </p>
        <button
          type="button"
          onClick={refetch}
          className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
        >
          Try again
        </button>
      </div>
    );
  }
  if (state.kind === 'empty') {
    return <p className="text-sm text-muted-foreground">{emptyCopy}</p>;
  }
  return renderItems(state.items);
}

const ENTRY_MODES = [
  { label: 'Describe it', mode: 'tell' },
  { label: 'Show me', mode: 'show' },
  { label: 'Describe + show', mode: 'tell-show' },
] as const;

export default function HomePage() {
  const navigate = useNavigate();
  const workflows = useHomeRead(fetchRecentWorkflows);
  const attention = useHomeRead(fetchAttentionRuns);
  const [goal, setGoal] = useState('');

  const recentWorkflows =
    workflows.state.kind === 'data'
      ? [...workflows.state.items]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 5)
      : [];

  return (
    <div className="space-y-8">
      {/* The primary goal/search/creation entry (UX spec §4). */}
      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-10">
        <p className="text-sm font-medium text-muted-foreground">
          Make · Do · Learn · Share · Improve
        </p>
        <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          What do you want to get done?
        </h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Start with a goal — describe it, show it, or both. Your workflows
          keep their durable state behind the scenes.
        </p>

        <form
          role="search"
          aria-label="Start with a goal or search"
          className="mt-6 flex max-w-xl gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = goal.trim();
            navigate(
              trimmed
                ? `/create?mode=tell&q=${encodeURIComponent(trimmed)}`
                : '/create?mode=tell',
            );
          }}
        >
          <input
            type="text"
            aria-label="Goal or search"
            placeholder="Type a goal, like “send the weekly invoice digest”"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Start
          </button>
        </form>

        <div className="mt-3 flex flex-wrap gap-3" aria-label="Ways to start">
          {ENTRY_MODES.map(({ label, mode }) => (
            <button
              key={mode}
              type="button"
              onClick={() => navigate(`/create?mode=${mode}`)}
              className={
                mode === 'tell'
                  ? 'rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
                  : 'rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent'
              }
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* The attention surfaces. */}
      <section className="grid gap-4 md:grid-cols-2" aria-label="Home attention surfaces">
        <SurfaceFrame title="Recent workflows" seeAll={{ to: '/workflows' }}>
          <ReadStates
            state={workflows.state}
            refetch={workflows.refetch}
            emptyCopy="No workflows yet — the ones you create or install will appear here."
            renderItems={() => (
              <ul className="space-y-3">
                {recentWorkflows.map((workflow) => (
                  <li
                    key={workflow.id}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span className="font-medium">{workflow.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(workflow.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          />
        </SurfaceFrame>

        <SurfaceFrame title="Needs attention" seeAll={{ to: '/activity' }}>
          <ReadStates
            state={attention.state}
            refetch={attention.refetch}
            emptyCopy="Nothing needs your attention right now."
            renderItems={(items) => (
              <ul className="space-y-3">
                {items.map((run) => (
                  <li key={run.id} className="flex items-baseline justify-between gap-3 text-sm">
                    <span>
                      <span
                        className={
                          run.state === 'failed'
                            ? 'mr-2 rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium text-destructive'
                            : 'mr-2 rounded bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-foreground'
                        }
                      >
                        {run.state === 'failed' ? 'Failed' : 'Paused'}
                      </span>
                      A workflow run needs a decision
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(run.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          />
        </SurfaceFrame>

        <UnavailableSurface
          title="Pending approvals"
          copy="Approvals aren’t shown here yet — they’ll appear once approvals become part of the product."
        />
        <UnavailableSurface
          title="Updates"
          copy="Workflow and version updates aren’t shown here yet — they’ll appear once updates become part of the product."
        />
        <UnavailableSurface
          title="Device issues"
          copy="Device and connectivity problems aren’t shown here yet — they’ll appear once device status becomes part of the product."
        />
      </section>
    </div>
  );
}
