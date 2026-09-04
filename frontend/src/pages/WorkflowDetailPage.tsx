import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  workflowRepository,
  workflowRuns,
  workflowDeployments,
  type ProductWorkflow,
  type ProductWorkflowVersion,
  type ProductWorkflowRun,
  type ProductInstallationDetail,
  type ProductDeployment,
  type ProductTriggerSubscription,
} from '../api/client';

/**
 * WorkflowDetailPage — the workflow detail experience (V2-017 Task 4).
 *
 * The detail page is the core product screen (UX spec §6): it communicates
 * the workflow's purpose, the primary actions (Run / Teach Me / Edit), the
 * current state and attention, what it does (steps), when and where it
 * runs, recent activity, the current version and immutable-version
 * context, access and safety, and the advanced inspection entry.
 *
 * HONESTY RULES:
 *   - composed over EXISTING authorities only: the V2-002 workflow +
 *     versions + installations reads, the V2-005 runs read, and the
 *     workflow-deployments reads; no second workflow model, no mutations;
 *   - loading / error / data states explicitly — a failed read is never a
 *     successful empty;
 *   - steps derive ONLY from the authoritative V2-003 presentation layer
 *     (presentation.nodeLabels, nodeId → label — F-T4-001): internal
 *     WorkflowNode IDs NEVER surface in the consumer UX (neither raw nor
 *     humanized); when any node lacks a usable presentation label, or the
 *     content is not a WorkflowIR document, the surface FAILS CLOSED to
 *     the honest steps-unavailable state — never a partial list, never
 *     the internal ID;
 *   - the primary actions are communicated: Run and Teach Me carry honest
 *     arrives-with notes (their flows belong to the run/teaching tasks);
 *     Edit enters the EXISTING expert workspace (the authoring authority);
 *   - the installed pin is shown verbatim — no update is implied before an
 *     explicit authoritative action;
 *   - digests and internal identifiers stay expert-only.
 */

type DetailState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | {
      kind: 'data';
      workflow: ProductWorkflow;
      versions: ProductWorkflowVersion[];
      runs: ProductWorkflowRun[];
      installation: ProductInstallationDetail | null;
      deployments: ProductDeployment[];
      subscriptions: ProductTriggerSubscription[];
    };

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * The steps from the authoritative V2-003 presentation layer (F-T4-001).
 *
 * presentation.nodeLabels (document top level, nodeId → label) is the ONLY
 * source of consumer-facing step names. Internal node IDs never render.
 * Fail-closed rules: non-WorkflowIR content, no presentation, a node
 * without a usable label, or a whitespace-only label → null (the honest
 * steps-unavailable state) — never a partial list, never the internal ID.
 */
function stepsFromContent(content: unknown): string[] | null {
  if (
    typeof content !== 'object' ||
    content === null ||
    Array.isArray(content)
  ) {
    return null;
  }
  const doc = content as {
    objectType?: unknown;
    ir?: { nodes?: unknown } | null;
    presentation?: unknown;
  };
  if (doc.objectType !== 'workflowos/workflow-ir/v1') return null;
  if (!doc.ir || !Array.isArray(doc.ir.nodes)) return null;
  const nodeLabels =
    typeof doc.presentation === 'object' &&
    doc.presentation !== null &&
    !Array.isArray(doc.presentation)
      ? (doc.presentation as { nodeLabels?: unknown }).nodeLabels
      : undefined;
  const labels: Record<string, unknown> =
    typeof nodeLabels === 'object' && nodeLabels !== null && !Array.isArray(nodeLabels)
      ? (nodeLabels as Record<string, unknown>)
      : {};
  const steps: string[] = [];
  for (const node of doc.ir.nodes) {
    if (typeof node !== 'object' || node === null) return null;
    const { id } = node as { id?: unknown };
    if (typeof id !== 'string') return null;
    const label = labels[id];
    if (typeof label !== 'string' || label.trim() === '') return null;
    steps.push(label);
  }
  return steps;
}

/** The distinct capabilities from the IR content (the access needs). */
function capabilitiesFromContent(content: unknown): string[] {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return [];
  const doc = content as { objectType?: unknown; ir?: { nodes?: unknown } | null };
  if (doc.objectType !== 'workflowos/workflow-ir/v1') return [];
  if (!doc.ir || !Array.isArray(doc.ir.nodes)) return [];
  const capabilities = new Set<string>();
  for (const node of doc.ir.nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const req = (node as { capabilityRequirements?: unknown }).capabilityRequirements;
    if (!Array.isArray(req)) continue;
    for (const c of req) if (typeof c === 'string') capabilities.add(c);
  }
  return [...capabilities];
}

const DEVICE_PLACEMENTS: ReadonlySet<string> = new Set(['device_local', 'device_preferred']);

export default function WorkflowDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      try {
        const workflow = await workflowRepository.get(workflowId);
        // The org-scoped reads (the F-T2-001 all-orgs lesson applies to the
        // workflow's OWN organization: the authoritative orgId from the
        // workflow read scopes every follow-up read).
        const [versions, runs, installations, deployments] = await Promise.all([
          workflowRepository.listVersionsForWorkflow(workflowId),
          workflowRuns.listForOrganization(workflow.organizationId),
          workflowRepository.listInstallationsForOrganization(workflow.organizationId),
          workflowDeployments.listForOrganization(workflow.organizationId),
        ]);
        const subscriptions = (
          await Promise.all(
            deployments.map((d) =>
              workflowDeployments.listSubscriptionsForDeployment(d.id),
            ),
          )
        ).flat();
        if (cancelled) return;
        setState({
          kind: 'data',
          workflow,
          versions,
          runs: runs.filter((r) => r.workflowId === workflowId),
          installation:
            installations.find((i) => i.installation.workflowId === workflowId) ?? null,
          deployments: deployments.filter((d) => d.workflowId === workflowId),
          subscriptions,
        });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId, nonce]);

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
          Couldn't load this workflow right now.
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

  const { workflow, versions, runs, installation, deployments, subscriptions } = state;
  const headVersion = versions.find((v) => v.id === workflow.headVersionId) ?? null;
  const steps = headVersion ? stepsFromContent(headVersion.content) : null;
  const capabilities = headVersion ? capabilitiesFromContent(headVersion.content) : [];
  const attention = runs.some((r) => r.state === 'failed' || r.state === 'paused');
  const workflowSubscriptions = subscriptions.filter((s) => {
    const ids = new Set(deployments.map((d) => d.id));
    return s.enabled && ids.has(s.deploymentId);
  });
  let scheduleLabel = 'Runs when started manually';
  if (workflowSubscriptions.length > 0) {
    const first = workflowSubscriptions[0];
    if (first.kind === 'event') scheduleLabel = 'Runs on events';
    else {
      const spec = first.schedule as { kind?: string } | null;
      if (spec?.kind === 'daily') scheduleLabel = 'Runs daily';
      else if (spec?.kind === 'weekly') scheduleLabel = 'Runs weekly';
      else if (spec?.kind === 'one_shot') scheduleLabel = 'Runs once';
      else scheduleLabel = 'Runs automatically';
    }
  }
  const enabledDeployments = deployments.filter((d) => d.enabled);
  const whereLabel =
    enabledDeployments.length === 0
      ? null
      : enabledDeployments.some((d) => DEVICE_PLACEMENTS.has(d.placement.placement.required))
        ? 'This device'
        : 'Cloud';
  const latestRuns = [...runs]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <nav aria-label="Back to the library" className="text-sm">
        <Link to="/workflows" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          ← Workflows
        </Link>
      </nav>

      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{workflow.name}</h1>
          {attention && (
            <span className="rounded bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
              Needs attention
            </span>
          )}
        </div>
        {workflow.description && (
          <p className="mt-2 text-muted-foreground">{workflow.description}</p>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          {workflow.visibility === 'private'
            ? 'Private — only you'
            : workflow.visibility === 'organization'
              ? 'Shared with your organization'
              : 'Public — any signed-in user'}
        </p>
      </header>

      {/* The primary actions (UX spec §6). The deep flows belong to their
          tasks; the entries are honest about that. */}
      <section aria-label="Primary actions" className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setActionNote('The run experience arrives with the run task.')}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Run
        </button>
        <button
          type="button"
          onClick={() => setActionNote('The teaching experience arrives with the teaching task.')}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          Teach Me
        </button>
        <Link
          to="/expert"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          Edit
        </Link>
      </section>
      {actionNote && (
        <p role="status" className="rounded-md bg-accent/40 p-3 text-sm text-muted-foreground">
          {actionNote}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {/* What it does — steps from the authoritative V2-003
            presentation layer (nodeLabels); internal node IDs never
            render (F-T4-001). */}
        <section aria-label="What it does" className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-medium">What it does</h2>
          {steps ? (
            <ol aria-label="What it does" className="mt-3 list-decimal space-y-1 pl-5 text-sm">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Steps aren't available in a human-readable form yet — this
              version doesn't carry readable step labels.
            </p>
          )}
        </section>

        {/* When and where it runs. */}
        <section aria-label="When and where" className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-medium">When and where</h2>
          <p className="mt-2 text-sm text-muted-foreground">{scheduleLabel}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {whereLabel ?? 'Not deployed yet'}
          </p>
        </section>

        {/* Recent activity (the authoritative runs). */}
        <section aria-label="Recent activity" className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-medium">Recent activity</h2>
          {latestRuns.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Not run yet</p>
          ) : (
            <ul aria-label="Recent activity" className="mt-3 space-y-2 text-sm">
              {latestRuns.map((run) => (
                <li key={run.id} className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{run.state}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(run.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Version — the immutable head + the pinned install (verbatim). */}
        <section aria-label="Version" className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-medium">Version</h2>
          {headVersion ? (
            <p className="mt-2 text-sm">
              Version {headVersion.versionNumber} — immutable
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Version facts unavailable</p>
          )}
          {installation ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Installed: Version {installation.pinnedVersion.versionNumber} — pinned ·{' '}
              {installation.installation.status === 'enabled' ? 'Enabled' : 'Disabled'}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">No installs — run it from the library</p>
          )}
        </section>

        {/* Access — "Needs access to" (capabilities from the IR). */}
        <section aria-label="Access and safety" className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-medium">Access and safety</h2>
          {capabilities.length > 0 ? (
            <div className="mt-2">
              <p className="text-sm text-muted-foreground">Needs access to</p>
              <ul className="mt-1 space-y-1 text-sm">
                {capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Access needs aren't available yet
            </p>
          )}
        </section>
      </div>

      {/* Advanced inspection — the existing expert workspace. */}
      <p className="text-sm">
        <Link
          to="/expert"
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Inspect in the expert workspace
        </Link>
      </p>
    </div>
  );
}
