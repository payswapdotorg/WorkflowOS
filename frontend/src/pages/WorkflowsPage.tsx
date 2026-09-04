import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  organizations,
  workflowRepository,
  workflowRuns,
  workflowDeployments,
  type ProductWorkflow,
  type ProductWorkflowRun,
  type ProductInstallationDetail,
  type ProductDeployment,
  type ProductTriggerSubscription,
} from '../api/client';

/**
 * WorkflowsPage — the workflow library (V2-017 Task 3).
 *
 * The library is the user's primary durable mental model (UX spec §5): the
 * five approved sections (My Workflows / Installed / Shared with me /
 * Drafts / Archived), contextual filters, and workflow cards with useful
 * human-readable metadata.
 *
 * HONESTY RULES (the same contract as T2, extended to the library):
 *   - the three wired sections (My / Installed / Shared) distinguish
 *     loading / error-with-retry / successful-empty / data explicitly;
 *   - a failed read is NEVER rendered as a successful empty state;
 *   - Drafts and Archived have NO authoritative read — the workflow model
 *     carries no draft/archived state (the repository vocabulary is
 *     explicitly "never a workflow state") — so those panels render honest
 *     Unavailable states, never fabricated empties;
 *   - every read aggregates across EVERY organization of the session user
 *     (the F-T2-001 correction), all-or-error: any failed per-organization
 *     read errors the wired sections — a partial collection is never
 *     presented as a successful result.
 *
 * The reads are consume-only: the V2-002 workflow + installation reads, the
 * V2-005 run read, and the workflow-deployments reads (placement /
 * enable-state / trigger subscriptions). The frontend owns no workflow
 * state; every card fact is derived from an authoritative response.
 */

// --- the composed library read (all-or-error across every organization) ------

interface LibraryData {
  workflows: ProductWorkflow[];
  runs: ProductWorkflowRun[];
  installations: ProductInstallationDetail[];
  deployments: ProductDeployment[];
  subscriptions: ProductTriggerSubscription[];
}

const EMPTY_LIBRARY: LibraryData = {
  workflows: [],
  runs: [],
  installations: [],
  deployments: [],
  subscriptions: [],
};

async function fetchLibrary(): Promise<LibraryData> {
  const orgs = await organizations.listForUser();
  if (orgs.length === 0) return EMPTY_LIBRARY;
  const perOrg = await Promise.all(
    orgs.map(async (org) => {
      const [workflows, runs, installations, deployments] = await Promise.all([
        workflowRepository.listForOrganization(org.id),
        workflowRuns.listForOrganization(org.id),
        workflowRepository.listInstallationsForOrganization(org.id),
        workflowDeployments.listForOrganization(org.id),
      ]);
      const subscriptions = await Promise.all(
        deployments.map((deployment) =>
          workflowDeployments.listSubscriptionsForDeployment(deployment.id),
        ),
      );
      return { workflows, runs, installations, deployments, subscriptions: subscriptions.flat() };
    }),
  );
  return {
    workflows: perOrg.flatMap((o) => o.workflows),
    runs: perOrg.flatMap((o) => o.runs),
    installations: perOrg.flatMap((o) => o.installations),
    deployments: perOrg.flatMap((o) => o.deployments),
    subscriptions: perOrg.flatMap((o) => o.subscriptions),
  };
}

type LibraryState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; library: LibraryData };

function useLibraryRead() {
  const [state, setState] = useState<LibraryState>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchLibrary()
      .then((library) => {
        if (!cancelled) setState({ kind: 'data', library });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { state, refetch };
}

// --- honest derivations (presentation-level filters over authoritative reads) --

/** Attention (run-derived): failed or paused runs exist for the workflow. */
function needsAttention(runs: ProductWorkflowRun[], workflowId: string): boolean {
  return runs.some(
    (run) =>
      run.workflowId === workflowId && (run.state === 'failed' || run.state === 'paused'),
  );
}

/** The workflow's most recent run (by updatedAt; null when never run). */
function latestRunFor(
  runs: ProductWorkflowRun[],
  workflowId: string,
): ProductWorkflowRun | null {
  let latest: ProductWorkflowRun | null = null;
  for (const run of runs) {
    if (run.workflowId !== workflowId) continue;
    if (!latest || run.updatedAt > latest.updatedAt) latest = run;
  }
  return latest;
}

/** The workflow's deployments (the placement/environment authority). */
function deploymentsFor(
  deployments: ProductDeployment[],
  workflowId: string,
): ProductDeployment[] {
  return deployments.filter((d) => d.workflowId === workflowId);
}

/** The enabled trigger subscriptions attached to the workflow's deployments. */
function enabledSubscriptionsFor(
  library: Pick<LibraryData, 'deployments' | 'subscriptions'>,
  workflowId: string,
): ProductTriggerSubscription[] {
  const deploymentIds = new Set(
    deploymentsFor(library.deployments, workflowId).map((d) => d.id),
  );
  return library.subscriptions.filter(
    (s) => s.enabled && deploymentIds.has(s.deploymentId),
  );
}

const DEVICE_PLACEMENTS: ReadonlySet<string> = new Set(['device_local', 'device_preferred']);
const CLOUD_PLACEMENTS: ReadonlySet<string> = new Set([
  'cloud_allowed',
  'cloud_preferred',
  'cloud_required',
]);

/** Environment at a human level (the enabled deployment's placement policy). */
function environmentLabel(
  deployments: ProductDeployment[],
  workflowId: string,
): string | null {
  const enabled = deploymentsFor(deployments, workflowId).filter((d) => d.enabled);
  if (enabled.length === 0) return null;
  const required = enabled[0].placement.placement.required;
  if (DEVICE_PLACEMENTS.has(required)) return 'This device';
  if (CLOUD_PLACEMENTS.has(required)) return 'Cloud';
  if (required === 'any_supported_node') return 'Any supported';
  return null;
}

/** Human-level date (the library's card vocabulary, UX spec §5). */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCDate()}, ${parsed.getUTCFullYear()}`;
}

/** The schedule fact at card level (human-readable, from the subscription). */
function scheduleLabel(library: LibraryData, workflowId: string): string {
  const subs = enabledSubscriptionsFor(library, workflowId);
  if (subs.length === 0) return 'Runs when you start it';
  const first = subs[0];
  if (first.kind === 'event') return 'Runs on events';
  const schedule = first.schedule as { kind?: string; at?: string; everyMs?: number } | null;
  switch (schedule?.kind) {
    case 'one_shot':
      return `Runs once ${schedule.at ? formatDate(schedule.at) : 'scheduled'}`;
    case 'interval': {
      const ms = schedule.everyMs ?? 0;
      if (ms > 0 && ms % 3_600_000 === 0) return `Runs every ${ms / 3_600_000} hour(s)`;
      if (ms > 0 && ms % 60_000 === 0) return `Runs every ${ms / 60_000} minutes`;
      return 'Runs on an interval';
    }
    case 'daily':
      return 'Runs daily';
    case 'weekly':
      return 'Runs weekly';
    default:
      // An enabled subscription exists, so it does run automatically even
      // when the schedule shape is unknown to this presentation.
      return 'Runs automatically';
  }
}

/** The contextual-filter facts for one workflow (honestly derived). */
interface FilterFacts {
  attention: boolean;
  automatic: boolean;
  device: boolean;
  cloud: boolean;
  shared: boolean;
}

function filterFactsFor(library: LibraryData, workflow: ProductWorkflow): FilterFacts {
  const enabledDeployments = deploymentsFor(library.deployments, workflow.id).filter(
    (d) => d.enabled,
  );
  return {
    attention: needsAttention(library.runs, workflow.id),
    automatic: enabledSubscriptionsFor(library, workflow.id).length > 0,
    device: enabledDeployments.some((d) => DEVICE_PLACEMENTS.has(d.placement.placement.required)),
    cloud: enabledDeployments.some((d) => CLOUD_PLACEMENTS.has(d.placement.placement.required)),
    shared: workflow.visibility === 'organization' || workflow.visibility === 'public',
  };
}

// --- the section vocabulary (UX spec §5) --------------------------------------

const SECTIONS = [
  { key: 'mine', label: 'My Workflows' },
  { key: 'installed', label: 'Installed' },
  { key: 'shared', label: 'Shared with me' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'archived', label: 'Archived' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

const FILTERS = [
  { key: 'needs-attention', label: 'Needs attention', fact: 'attention' },
  { key: 'runs-automatically', label: 'Runs automatically', fact: 'automatic' },
  { key: 'on-this-device', label: 'On this device', fact: 'device' },
  { key: 'cloud', label: 'Cloud', fact: 'cloud' },
  { key: 'shared', label: 'Shared', fact: 'shared' },
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

const DATA_SECTIONS: ReadonlySet<SectionKey> = new Set(['mine', 'installed', 'shared']);

// --- cards --------------------------------------------------------------------

function WorkflowCard({
  workflow,
  library,
}: {
  workflow: ProductWorkflow;
  library: LibraryData;
}) {
  const lastRun = latestRunFor(library.runs, workflow.id);
  const attention = needsAttention(library.runs, workflow.id);
  const schedule = scheduleLabel(library, workflow.id);
  const environment = environmentLabel(library.deployments, workflow.id);
  return (
    <li className="rounded-xl border border-border bg-card p-5">
      <article>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-medium">{workflow.name}</h3>
          {attention && (
            <span
              className="shrink-0 rounded bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
              aria-label="Needs attention"
            >
              Needs attention
            </span>
          )}
        </div>
        {workflow.description && (
          <p className="mt-1 text-sm text-muted-foreground">{workflow.description}</p>
        )}
        {/* Human-level card facts — each honestly derived from an
            authoritative read (runs, subscriptions, placement). */}
        <div className="mt-3 space-y-1 text-sm">
          <p className="text-muted-foreground">
            Last run{' '}
            {lastRun ? `${formatDate(lastRun.updatedAt)} · ${lastRun.state}` : 'Not run yet'}
          </p>
          <p className="text-muted-foreground">{schedule}</p>
          {environment && <p className="text-muted-foreground">{environment}</p>}
        </div>
        {/* Implementation identifiers stay secondary (a muted detail line;
            digests never appear on the card). */}
        <p className="mt-2 font-mono text-xs text-muted-foreground/70">{workflow.slug}</p>
        {/* T4: the card opens the workflow detail — the product route
            carries the authoritative workflow id forward. */}
        <div className="mt-3">
          <Link
            to={`/workflows/${workflow.id}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Open
          </Link>
        </div>
      </article>
    </li>
  );
}

function InstallationCard({
  detail,
  workflow,
  library,
}: {
  detail: ProductInstallationDetail;
  workflow: ProductWorkflow | undefined;
  library: LibraryData;
}) {
  // The installation read pins an EXACT immutable version (never
  // auto-updates); the card preserves those semantics verbatim. When the
  // pinned workflow is not in the visible repository read, the card stays
  // honest: the authoritative name simply is not available here.
  const name = workflow?.name ?? 'Installed workflow';
  const facts = workflow ? filterFactsFor(library, workflow) : null;
  const lastRun = latestRunFor(library.runs, detail.installation.workflowId);
  return (
    <li className="rounded-xl border border-border bg-card p-5">
      <article>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-medium">{name}</h3>
          <span className="shrink-0 rounded bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
            {detail.installation.status === 'enabled' ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        {workflow?.description && (
          <p className="mt-1 text-sm text-muted-foreground">{workflow.description}</p>
        )}
        {/* The pinned version — the immutable (workflow, version) tuple the
            installation read resolved. */}
        <p className="mt-3 text-sm font-medium">
          Version {detail.pinnedVersion.versionNumber} — pinned
        </p>
        <div className="mt-1 space-y-1 text-sm">
          <p className="text-muted-foreground">
            Last run{' '}
            {lastRun ? `${formatDate(lastRun.updatedAt)} · ${lastRun.state}` : 'Not run yet'}
          </p>
          {workflow && (
            <p className="text-muted-foreground">{scheduleLabel(library, workflow.id)}</p>
          )}
          {workflow && environmentLabel(library.deployments, workflow.id) && (
            <p className="text-muted-foreground">
              {environmentLabel(library.deployments, workflow.id)}
            </p>
          )}
          {facts?.attention && (
            <p className="font-medium text-destructive">Needs attention</p>
          )}
        </div>
        {workflow && (
          <p className="mt-2 font-mono text-xs text-muted-foreground/70">{workflow.slug}</p>
        )}
        {/* T4: the install card opens the pinned workflow's detail — the
            product route carries the authoritative workflow id forward. */}
        <div className="mt-3">
          <Link
            to={`/workflows/${detail.installation.workflowId}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Open
          </Link>
        </div>
      </article>
    </li>
  );
}

// --- the page -----------------------------------------------------------------

export default function WorkflowsPage() {
  const { state, refetch } = useLibraryRead();
  const { user } = useAuth();
  const [activeSection, setActiveSection] = useState<SectionKey>('mine');
  const [filters, setFilters] = useState<ReadonlySet<FilterKey>>(new Set());

  const toggleFilter = useCallback((key: FilterKey) => {
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const passesFilters = useCallback(
    (facts: FilterFacts): boolean => {
      for (const { key, fact } of FILTERS) {
        if (filters.has(key) && !facts[fact]) return false;
      }
      return true;
    },
    [filters],
  );

  /** The section's items, honestly derived + filtered (presentation level). */
  const sectionItems = useMemo(() => {
    if (state.kind !== 'data') return null;
    const { library } = state;
    const workflowsById = new Map(library.workflows.map((w) => [w.id, w]));

    if (activeSection === 'mine' || activeSection === 'shared') {
      const owned = user
        ? library.workflows.filter((w) => w.ownerUserId === user.id)
        : library.workflows.filter(() => false);
      const items =
        activeSection === 'mine'
          ? owned
          : library.workflows.filter((w) => w.ownerUserId !== user?.id);
      const visible = items
        .filter((w) => passesFilters(filterFactsFor(library, w)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { kind: 'workflows' as const, items: visible, total: items.length };
    }

    if (activeSection === 'installed') {
      // Presentation-level: an 'uninstalled' installation is not installed.
      const items = library.installations.filter(
        (d) => d.installation.status !== 'uninstalled',
      );
      const visible = items.filter((detail) => {
        const workflow = workflowsById.get(detail.installation.workflowId);
        if (!workflow) return filters.size === 0;
        return passesFilters(filterFactsFor(library, workflow));
      });
      return { kind: 'installations' as const, items: visible, total: items.length };
    }

    return null; // drafts / archived have no authoritative read
  }, [state, activeSection, user, passesFilters, filters]);

  const noWorkflowsAnywhere =
    state.kind === 'data' && state.library.workflows.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Workflows</h1>
        <p className="mt-2 text-muted-foreground">
          Your installed, shared, draft, and archived workflows live here.
        </p>
      </div>

      {/* The approved library sections. */}
      <div role="tablist" aria-label="Library sections" className="flex flex-wrap gap-2">
        {SECTIONS.map(({ key, label }) => {
          const active = activeSection === key;
          return (
            <button
              key={key}
              role="tab"
              id={`library-tab-${key}`}
              aria-selected={active}
              onClick={() => setActiveSection(key)}
              className={
                active
                  ? 'rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground'
                  : 'rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground'
              }
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Contextual filters — presentation-level toggles over the honest
          derivations (runs, subscriptions, placement, visibility). */}
      {DATA_SECTIONS.has(activeSection) && state.kind === 'data' && (
        <div aria-label="Contextual filters" className="flex flex-wrap gap-2">
          {FILTERS.map(({ key, label }) => {
            const active = filters.has(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => toggleFilter(key)}
                className={
                  active
                    ? 'rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-foreground'
                    : 'rounded-md border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground'
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      <div role="tabpanel" aria-labelledby={`library-tab-${activeSection}`}>
        {/* Drafts and Archived: no authoritative read exists — the honest
            Unavailable state, never a fabricated empty list. */}
        {activeSection === 'drafts' && (
          <div className="rounded-xl border border-border bg-card p-6">
            <p
              role="status"
              aria-label="Unavailable"
              className="text-sm font-medium text-muted-foreground"
            >
              Unavailable
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Drafts aren’t distinguishable in the workflow records yet — they’ll
              appear here once draft state becomes part of the product.
            </p>
          </div>
        )}
        {activeSection === 'archived' && (
          <div className="rounded-xl border border-border bg-card p-6">
            <p
              role="status"
              aria-label="Unavailable"
              className="text-sm font-medium text-muted-foreground"
            >
              Unavailable
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Archived workflows aren’t distinguishable in the workflow records yet —
              they’ll appear here once archived state becomes part of the product.
            </p>
          </div>
        )}

        {/* The wired sections: loading / error / empty / data, honestly. */}
        {DATA_SECTIONS.has(activeSection) && state.kind === 'loading' && (
          <p role="status" aria-label="Loading" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )}
        {DATA_SECTIONS.has(activeSection) && state.kind === 'error' && (
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
        )}
        {DATA_SECTIONS.has(activeSection) && state.kind === 'data' && sectionItems && (
          <>
            {noWorkflowsAnywhere ? (
              <p className="text-sm text-muted-foreground">
                No workflows yet — the ones you create or install will appear here.
              </p>
            ) : sectionItems.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {activeSection === 'mine' && "You haven't created any workflows yet."}
                {activeSection === 'shared' && 'Nothing has been shared with you yet.'}
                {activeSection === 'installed' &&
                  'Nothing installed yet — workflows you install will appear here.'}
              </p>
            ) : sectionItems.kind === 'workflows' ? (
              <ul className="grid gap-4 md:grid-cols-2">
                {sectionItems.items.map((workflow) => (
                  <WorkflowCard key={workflow.id} workflow={workflow} library={state.library} />
                ))}
              </ul>
            ) : (
              <ul className="grid gap-4 md:grid-cols-2">
                {sectionItems.items.map((detail) => (
                  <InstallationCard
                    key={detail.installation.id}
                    detail={detail}
                    workflow={state.library.workflows.find(
                      (w) => w.id === detail.installation.workflowId,
                    )}
                    library={state.library}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
