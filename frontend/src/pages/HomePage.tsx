import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  organizations,
  workflowRepository,
  workflowRuns,
  type ProductInstallationDetail,
  type ProductWorkflow,
  type ProductWorkflowRun,
  type ProductWorkflowVersion,
} from '../api/client';
import OrganizationOnboarding from '../components/onboarding/OrganizationOnboarding';
import {
  humanRunStateSentence,
} from '../components/activity/run-state-language';
import { lastPauseAtApprovalStep } from '../components/activity/workflow-ir-facts';

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
 *   Unavailable — the surface has no exposed read yet (device issues)
 *             — an honest "not shown here yet", never a fabricated empty
 *             list.
 *
 * The reads are consume-only: the V2-002 workflow list and the V2-005 run
 * list, aggregated across EVERY organization of the session user (F-T2-001:
 * there is no authoritative current-organization selection — the user's
 * Home scope is the full organization collection, so dropping any of them
 * would silently discard authoritative records). The frontend owns no
 * workflow/run/approval state of its own.
 *
 * REALITY-REPAIR-002 (F-002): a fresh signup with ZERO organizations lands
 * here FIRST, so this is where the first-run organization onboarding lives.
 * When the organizations read succeeds and is empty, the explicit onboarding
 * card renders above the attention surfaces — creation consumes ONLY the
 * existing POST /organizations authority (the user becomes the owner), and
 * on success every surface refetches so the org-scoped reads target the
 * created organization. A failed organizations read stays an honest error
 * (the surfaces' own error states) — never a fake onboarding-empty.
 *
 * REALITY-REPAIR-005 (F-005): Pending approvals and Updates are COMPOSED
 * surfaces (below) — derived from the existing V2-005/V2-002 reads and the
 * SAME derivations the workflow detail already uses. No aggregate
 * authority, no duplicated attention state: Home links to where the real
 * actions live (the run on the workflow detail; the adoption action there).
 * Device issues stays the honest Unavailable surface (F-006: an explicit
 * product deferral — no public device-status read exists).
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

/**
 * One Pending-approvals item (REALITY-REPAIR-005, F-005) — a presentation
 * record derived from the existing reads, never an authority of its own.
 */
interface PendingApprovalItem {
  run: ProductWorkflowRun;
  workflowName: string | null;
}

/**
 * Pending approvals (REALITY-REPAIR-005, F-005): a paused run waiting at an
 * IR approval step — the approval gates that ARE part of the product. The
 * composition reuses ONLY the existing reads and derivations (the same
 * ones the RunExperience status surface and the Activity timeline hold):
 *   - the paused runs of EVERY caller organization (the V2-005 run read,
 *     F-T2-001 all-or-error);
 *   - each paused run's reconstructed history (the V2-005 read whose
 *     workflow.run.paused entry carries the executor-reported pause point
 *     detail.atStepId — never guessed);
 *   - the run-pinned version's WorkflowIR (the public versions read) for
 *     the SHARED approval-waiting derivation (lastPauseAtApprovalStep);
 *   - the public workflow read for the item's name (the V2-002 read the
 *     detail page itself consumes).
 *
 * All-or-error: any failed read errors the surface (a failed read is NEVER
 * a successful empty). A paused run without approval evidence is simply
 * not an item (no evidence, no claim — it stays in Needs attention as
 * Paused); the successful empty means no paused run provably waits at an
 * approval step.
 */
async function fetchPendingApprovals(): Promise<PendingApprovalItem[]> {
  const orgs = await organizations.listForUser();
  if (orgs.length === 0) return [];
  const perOrg = await Promise.all(
    orgs.map((org) => workflowRuns.listForOrganization(org.id)),
  );
  const paused = perOrg.flat().filter((run) => run.state === 'paused');
  if (paused.length === 0) return [];
  const histories = await Promise.all(
    paused.map((run) => workflowRuns.getHistory(run.id)),
  );
  const workflowIds = [...new Set(paused.map((run) => run.workflowId))];
  const [versionLists, workflows] = await Promise.all([
    Promise.all(workflowIds.map((id) => workflowRepository.listVersionsForWorkflow(id))),
    Promise.all(workflowIds.map((id) => workflowRepository.get(id))),
  ]);
  const items: PendingApprovalItem[] = [];
  paused.forEach((run, i) => {
    const idx = workflowIds.indexOf(run.workflowId);
    const workflow = workflows[idx] ?? null;
    // Fail closed: an authoritative read that yields no usable record is
    // the honest error surface — never a fabricated item.
    if (!workflow) throw new Error('The workflow read returned no record.');
    const version = (versionLists[idx] ?? []).find((v) => v.id === run.versionId) ?? null;
    if (!lastPauseAtApprovalStep(histories[i].timeline, version?.content ?? null)) return;
    items.push({ run, workflowName: workflow.name });
  });
  return items;
}

/**
 * One Updates item (REALITY-REPAIR-005, F-005) — an installed workflow
 * whose pinned version is behind the workflow's head version (the §19
 * update semantics), presented as a link to where adoption actually lives.
 */
interface WorkflowUpdateItem {
  installation: ProductInstallationDetail;
  headVersion: ProductWorkflowVersion;
  workflowName: string | null;
}

/**
 * Updates (REALITY-REPAIR-005, F-005): the installed workflows behind their
 * head version — the version updates that ARE part of the product. The
 * composition reuses ONLY the existing reads and the §19 derivation
 * semantics the VersionsExperience update banner already holds:
 *   - the installations of EVERY caller organization (the V2-002 read,
 *     F-T2-001 all-or-error), bound per (workflow, org) by the SAME rule
 *     the detail page uses (the enabled installation is the caller's live
 *     pin — after an explicit adoption there can be a retired row too);
 *   - the public versions read: an installation whose
 *     pinnedVersion.versionNumber is behind the workflow's head version
 *     number (the highest number — versions are immutable and append-only)
 *     is the update item;
 *   - the public workflow read for the item's name.
 *
 * The honest §19 vocabulary travels with the item (the pin is verbatim and
 * never auto-updated; nothing changes until the user approves the update).
 * Home NEVER duplicates the adoption action — the item links to the
 * workflow detail, where the real action lives. All-or-error throughout.
 */
async function fetchWorkflowUpdates(): Promise<WorkflowUpdateItem[]> {
  const orgs = await organizations.listForUser();
  if (orgs.length === 0) return [];
  const perOrg = await Promise.all(
    orgs.map((org) => workflowRepository.listInstallationsForOrganization(org.id)),
  );
  const installations = perOrg.flat();
  if (installations.length === 0) return [];
  // The detail page's binding rule (T11 adoption): per (workflow, org) the
  // ENABLED installation is the live pin; only when every row is retired
  // does the first row stand in — a retired pin must never fabricate an
  // update the caller already adopted.
  const bound = new Map<string, ProductInstallationDetail>();
  for (const installation of installations) {
    const key = `${installation.installation.workflowId}:${installation.installation.organizationId}`;
    const current = bound.get(key) ?? null;
    if (
      current === null ||
      (current.installation.status !== 'enabled' &&
        installation.installation.status === 'enabled')
    ) {
      bound.set(key, installation);
    }
  }
  const workflowIds = [...new Set([...bound.values()].map((i) => i.installation.workflowId))];
  const [versionLists, workflows] = await Promise.all([
    Promise.all(workflowIds.map((id) => workflowRepository.listVersionsForWorkflow(id))),
    Promise.all(workflowIds.map((id) => workflowRepository.get(id))),
  ]);
  const items: WorkflowUpdateItem[] = [];
  for (const installation of bound.values()) {
    const idx = workflowIds.indexOf(installation.installation.workflowId);
    const workflow = workflows[idx] ?? null;
    // Fail closed: an authoritative read that yields no usable record is
    // the honest error surface — never a fabricated item.
    if (!workflow) throw new Error('The workflow read returned no record.');
    const versions = versionLists[idx] ?? [];
    const head = versions.reduce<ProductWorkflowVersion | null>(
      (max, v) => (max === null || v.versionNumber > max.versionNumber ? v : max),
      null,
    );
    // No head version fact ⇒ no claim; the pin is at head ⇒ no update.
    if (!head) continue;
    if (installation.pinnedVersion.versionNumber >= head.versionNumber) continue;
    items.push({ installation, headVersion: head, workflowName: workflow.name });
  }
  return items;
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
  // REALITY-REPAIR-002: the organization-collection read that owns the
  // zero-org onboarding condition (loading/error/empty/data, same honesty
  // contract as the other surfaces).
  const orgs = useHomeRead(organizations.listForUser);
  // REALITY-REPAIR-005 (F-005): the two composed attention surfaces —
  // each with the same honesty contract as its siblings.
  const approvals = useHomeRead(fetchPendingApprovals);
  const updates = useHomeRead(fetchWorkflowUpdates);
  const [goal, setGoal] = useState('');

  const onOrganizationCreated = useCallback(() => {
    // The authoritative record exists now (POST /organizations responded
    // 201): re-read the collection AND every attention surface so every
    // org-scoped aggregation targets the created organization.
    orgs.refetch();
    workflows.refetch();
    attention.refetch();
    approvals.refetch();
    updates.refetch();
  }, [orgs, workflows, attention, approvals, updates]);

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

      {/* REALITY-REPAIR-002 (F-002): the explicit first-run onboarding — ONLY
          when the organizations read succeeded and the fresh user has zero
          organizations. Creation consumes the existing POST /organizations
          authority; afterwards every surface re-reads for the created org. */}
      {orgs.state.kind === 'empty' && (
        <OrganizationOnboarding onCreated={onOrganizationCreated} />
      )}

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

        {/* REALITY-REPAIR-005 (F-005): the COMPOSED approval surface — the
            existing reads + the shared approval-waiting derivation (never
            an Unavailable claim: the V2-005 approval gates are the
            product). The item links to the run on the workflow detail
            (the T10 F02 direct link); the approval action itself is NOT
            duplicated here. */}
        <SurfaceFrame title="Pending approvals">
          <ReadStates
            state={approvals.state}
            refetch={approvals.refetch}
            emptyCopy="No run is waiting at an approval step right now."
            renderItems={(items) => (
              <ul className="space-y-3">
                {items.map((item) => (
                  <li key={item.run.id} className="text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <p>
                        <span className="mr-2 rounded bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-foreground">
                          Waiting for you
                        </span>
                        <span className="font-medium">{item.workflowName}</span>
                      </p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDate(item.run.updatedAt)}
                      </span>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      {humanRunStateSentence('Waiting for you')}{' '}
                      <Link
                        to={`/workflows/${item.run.workflowId}?run=${item.run.id}`}
                        className="text-foreground underline-offset-4 transition-colors hover:underline"
                      >
                        Open the run
                      </Link>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          />
        </SurfaceFrame>

        {/* REALITY-REPAIR-005 (F-005): the COMPOSED updates surface — the
            installation read + the public versions read + the §19
            installed-behind-head derivation (never an Unavailable claim:
            the V2-002 versions are the product). The item carries the
            honest pin vocabulary and links to the workflow detail, where
            the real adoption action lives — NEVER duplicated here. */}
        <SurfaceFrame title="Updates">
          <ReadStates
            state={updates.state}
            refetch={updates.refetch}
            emptyCopy="No updates available right now — an installed workflow stays pinned until you approve its update."
            renderItems={(items) => (
              <ul className="space-y-3">
                {items.map((item) => (
                  <li
                    key={`${item.installation.installation.organizationId}:${item.installation.installation.id}`}
                    className="text-sm"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <p>
                        <span className="mr-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                          Update available
                        </span>
                        <span className="font-medium">{item.workflowName}</span>
                      </p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDate(item.headVersion.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      Version {item.headVersion.versionNumber} is available — your installed
                      Version {item.installation.pinnedVersion.versionNumber} stays pinned (it
                      never auto-updates).
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Nothing changes until you approve the update.{' '}
                      <Link
                        to={`/workflows/${item.installation.installation.workflowId}`}
                        className="text-foreground underline-offset-4 transition-colors hover:underline"
                      >
                        Open the workflow
                      </Link>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          />
        </SurfaceFrame>

        <UnavailableSurface
          title="Device issues"
          copy="Device and connectivity problems aren’t shown here yet — they’ll appear once device status becomes part of the product."
        />
      </section>
    </div>
  );
}
