/**
 * ProductActivityPage — the universal activity timeline (V2-017 Task 10).
 *
 * Activity is the universal timeline for runs, approvals, and workflow
 * version updates (UX spec §16), composed over EXISTING authorities only:
 *   - the V2-002 workflow list + per-workflow version list reads (the
 *     "New version" events — the versions stay T11's own experience; the
 *     timeline only lists the authoritative version records);
 *   - the V2-005 organization run-list read (one event per run, the §15
 *     human state vocabulary) + the reconstructed-history read for the
 *     paused-run approval derivation ("Waiting for you") and the on-demand
 *     "How do you know?" trust disclosure (§17, TrustDisclosure);
 *   - NO second activity log, NO client-side event model: every timeline
 *     entry derives from an authoritative record — events absent from the
 *     records are never fabricated.
 *
 * STATE HONESTY (the frozen contract):
 *   - each source (workflows / runs / versions) keeps its own
 *     loading/error/data state — a failed read renders its own visible
 *     Unavailable surface with retry and NEVER becomes a successful empty
 *     timeline;
 *   - a successful read with no organizations is the derivable empty state;
 *   - teaching sessions have NO list read on the V2-006/V2-010 authorities
 *     (and device events expose no product timeline read either): the
 *     surface discloses that honestly ("not shown here yet") instead of
 *     inventing entries or rendering a fake empty success.
 *
 * The per-run "How do you know?" region loads the run's history on demand
 * (progressive disclosure): concise evidence first, then advanced
 * verification, with the no-physical-proof boundary (§17 / rule 6).
 *
 * §16 DIRECT LINKS (architect F02): every run entry reaches BOTH its
 * Workflow (the name link) and its SPECIFIC Run — the explicit
 * "Open the run" link carries ?run=<id> to the workflow route, where
 * the run-status surface presents exactly that run.
 *
 * THE NEEDS-ME BUCKET (architect F01): the filter uses the SAME
 * authoritative approval derivation as the "Waiting for you" state
 * word — a run enters Needs me only when the history read proves the
 * pause rides an IR approval node. A paused run whose history or
 * version facts are unavailable (loading, failed read, missing
 * version) is NEVER upgraded into the bucket: no evidence, no claim.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  organizations,
  workflowRepository,
  workflowRuns,
  type ProductRunHistory,
  type ProductWorkflow,
  type ProductWorkflowRun,
  type ProductWorkflowVersion,
} from '../api/client';
import TrustDisclosure from '../components/activity/TrustDisclosure';
import { humanRunState } from '../components/activity/run-state-language';
import { lastPauseAtApprovalStep } from '../components/activity/workflow-ir-facts';
import { formatRelative } from '../lib/format';

type SourceState<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; items: T[] };

type ReadState<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'data'; value: T };

type ActivityFilter = 'all' | 'needs-me' | 'completed' | 'failed';

/**
 * One timeline event — derived ONLY from an authoritative record:
 * a run (its latest record state) or a version (its creation record).
 */
type ActivityEvent =
  | {
      kind: 'run';
      key: string;
      run: ProductWorkflowRun;
      occurredAt: string;
    }
  | {
      kind: 'version';
      key: string;
      version: ProductWorkflowVersion;
      occurredAt: string;
    };

/**
 * The needs-you derivation (the SHARED approval-waiting source — the same
 * derivation as the run-status surface and Home's Pending approvals):
 * a PAUSED run whose last pause rides detail.atStepId at an IR approval
 * node. Never guessed; if the history or the version facts are unavailable,
 * the honest word stays "Paused".
 */
function needsYouWord(
  run: ProductWorkflowRun,
  histories: Record<string, ReadState<ProductRunHistory>>,
  versions: ProductWorkflowVersion[] | null,
): 'Waiting for you' | null {
  if (run.state !== 'paused') return null;
  const entry = histories[run.id];
  if (!entry || entry.kind !== 'data') return null;
  const version = versions?.find((v) => v.id === run.versionId) ?? null;
  return lastPauseAtApprovalStep(entry.value.timeline, version?.content ?? null)
    ? 'Waiting for you'
    : null;
}

export default function ProductActivityPage() {
  const [workflowsState, setWorkflowsState] = useState<SourceState<ProductWorkflow>>({
    kind: 'loading',
  });
  const [runsState, setRunsState] = useState<SourceState<ProductWorkflowRun>>({
    kind: 'loading',
  });
  const [versionsState, setVersionsState] = useState<SourceState<ProductWorkflowVersion>>({
    kind: 'loading',
  });
  const [runHistories, setRunHistories] = useState<
    Record<string, ReadState<ProductRunHistory>>
  >({});
  const [trustOpen, setTrustOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [reloadNonce, setReloadNonce] = useState(0);

  // The sources load independently (a failed read never fails its siblings):
  // orgs → { workflows, runs } → versions (needs the workflow list).
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setWorkflowsState({ kind: 'loading' });
    setRunsState({ kind: 'loading' });
    setVersionsState({ kind: 'loading' });
    (async () => {
      let orgIds: string[] = [];
      try {
        const orgs = await organizations.listForUser();
        orgIds = orgs.map((o) => o.id);
        if (orgIds.length === 0) {
          // Derivably empty: no organization ⇒ no workflows/runs/versions.
          if (!cancelled) {
            setWorkflowsState({ kind: 'data', items: [] });
            setRunsState({ kind: 'data', items: [] });
            setVersionsState({ kind: 'data', items: [] });
          }
          return;
        }
      } catch {
        if (!cancelled) {
          setWorkflowsState({ kind: 'error' });
          setRunsState({ kind: 'error' });
          setVersionsState({ kind: 'error' });
        }
        return;
      }
      // Workflows (V2-002) — all-or-error across the user's organizations.
      void (async () => {
        try {
          const perOrg = await Promise.all(
            orgIds.map((id) => workflowRepository.listForOrganization(id)),
          );
          const workflows = perOrg.flat();
          if (!cancelled) setWorkflowsState({ kind: 'data', items: workflows });
          // Versions (V2-002) — all-or-error across the workflows.
          try {
            const perWorkflow = await Promise.all(
              workflows.map((w) => workflowRepository.listVersionsForWorkflow(w.id)),
            );
            if (!cancelled) {
              setVersionsState({ kind: 'data', items: perWorkflow.flat() });
            }
          } catch {
            if (!cancelled) setVersionsState({ kind: 'error' });
          }
        } catch {
          if (!cancelled) {
            setWorkflowsState({ kind: 'error' });
            setVersionsState({ kind: 'idle' });
          }
        }
      })();
      // Runs (V2-005) — all-or-error, independent of the workflow read.
      try {
        const perOrg = await Promise.all(
          orgIds.map((id) => workflowRuns.listForOrganization(id)),
        );
        if (!cancelled) setRunsState({ kind: 'data', items: perOrg.flat() });
      } catch {
        if (!cancelled) setRunsState({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  // The run-history reads: eagerly for PAUSED runs (the needs-you
  // derivation) and on demand for the open "How do you know?" regions.
  // Each read keeps its own honest state (loading/error/data).
  useEffect(() => {
    if (runsState.kind !== 'data') return;
    const wanted = runsState.items.filter(
      (r) => r.state === 'paused' || trustOpen[r.id] === true,
    );
    const missing = wanted.filter((r) => !(r.id in runHistories));
    if (missing.length === 0) return;
    setRunHistories((prev) => {
      const next = { ...prev };
      for (const r of missing) next[r.id] = { kind: 'loading' };
      return next;
    });
    for (const run of missing) {
      workflowRuns
        .getHistory(run.id)
        .then((history) => {
          setRunHistories((prev) => ({ ...prev, [run.id]: { kind: 'data', value: history } }));
        })
        .catch(() => {
          setRunHistories((prev) => ({ ...prev, [run.id]: { kind: 'error' } }));
        });
    }
    // runHistories is a deliberate dependency: the retry path DELETES a
    // failed entry, and this effect must observe that removal to refetch.
  }, [runsState, trustOpen, runHistories]);

  const workflows = useMemo<ProductWorkflow[]>(
    () => (workflowsState.kind === 'data' ? workflowsState.items : []),
    [workflowsState],
  );
  const versions = versionsState.kind === 'data' ? versionsState.items : null;

  const events = useMemo<ActivityEvent[]>(() => {
    const runEvents: ActivityEvent[] =
      runsState.kind === 'data'
        ? runsState.items.map((run) => ({
            kind: 'run' as const,
            key: `run-${run.id}`,
            run,
            occurredAt: run.updatedAt,
          }))
        : [];
    const versionEvents: ActivityEvent[] =
      versionsState.kind === 'data'
        ? versionsState.items.map((version) => ({
            kind: 'version' as const,
            key: `version-${version.id}`,
            version,
            occurredAt: version.createdAt,
          }))
        : [];
    return [...runEvents, ...versionEvents].sort((a, b) =>
      b.occurredAt.localeCompare(a.occurredAt),
    );
  }, [runsState, versionsState]);

  const filtered = useMemo(() => {
    if (filter === 'all') return events;
    return events.filter((event) => {
      if (event.kind !== 'run') return false;
      // F01: Needs me is the SAME authoritative derivation as the state
      // word (needsYouWord) — never the raw paused state. When the
      // history/version facts are unavailable, the run is not upgraded
      // into the Needs-me bucket.
      if (filter === 'needs-me')
        return needsYouWord(event.run, runHistories, versions) !== null;
      if (filter === 'completed') return event.run.state === 'completed';
      return event.run.state === 'failed';
    });
  }, [events, filter, runHistories, versions]);

  const anyLoading =
    workflowsState.kind === 'loading' ||
    runsState.kind === 'loading' ||
    versionsState.kind === 'loading';

  const retryHistory = useCallback((runId: string) => {
    setRunHistories((prev) => {
      const next = { ...prev };
      delete next[runId];
      return next;
    });
  }, []);

  const workflowName = useCallback(
    (workflowId: string): { name: string | null; to: string } => {
      const workflow = workflows.find((w) => w.id === workflowId) ?? null;
      return {
        name: workflow?.name ?? null,
        to: `/workflows/${workflowId}`,
      };
    },
    [workflows],
  );

  const sourceError = (
    label: string,
    message: string,
    onRetry: () => void,
  ) => (
    <p role="status" aria-label={label} className="text-sm text-muted-foreground">
      {message}
      <button
        type="button"
        onClick={onRetry}
        className="ml-2 rounded-md border border-border px-2 py-0.5 text-xs font-medium transition-colors hover:bg-accent"
      >
        Try again
      </button>
    </p>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-2 text-muted-foreground">
          Runs, approvals, and version updates across your workflows — with
          the evidence behind each run.
        </p>
      </div>

      {/* Honest per-source states: a failed read is never a successful
          empty timeline. */}
      {workflowsState.kind === 'error' &&
        sourceError(
          'Workflows unavailable',
          'Workflows unavailable — couldn\u2019t load the workflow list.',
          reload,
        )}
      {runsState.kind === 'error' &&
        sourceError(
          'Runs unavailable',
          'Runs unavailable — couldn\u2019t load the run list.',
          reload,
        )}
      {versionsState.kind === 'error' &&
        sourceError(
          'Version history unavailable',
          'Version history unavailable — couldn\u2019t load the version records.',
          reload,
        )}

      {/* The filters (UX spec §16 — presentation-only over the record
          states; "Shared" arrives with the sharing surface). */}
      <div role="group" aria-label="Activity filters" className="flex flex-wrap gap-2">
        {(
          [
            ['all', 'All'],
            ['needs-me', 'Needs me'],
            ['completed', 'Completed'],
            ['failed', 'Failed'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={
              filter === value
                ? 'rounded-full border border-primary bg-primary/10 px-3 py-1 text-sm font-medium text-primary'
                : 'rounded-full border border-border px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {anyLoading && filtered.length === 0 ? (
        <p role="status" aria-label="Loading" className="text-sm text-muted-foreground">
          Loading activity…
        </p>
      ) : filtered.length === 0 &&
        workflowsState.kind !== 'error' &&
        runsState.kind !== 'error' &&
        versionsState.kind !== 'error' ? (
        <p className="text-sm text-muted-foreground">No activity yet</p>
      ) : (
        filtered.length > 0 && (
          <ul aria-label="Activity timeline" className="space-y-3">
            {filtered.map((event) => {
              if (event.kind === 'version') {
                const { name, to } = workflowName(event.version.workflowId);
                return (
                  <li
                    key={event.key}
                    className="rounded-xl border border-border bg-card p-4"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <p className="text-sm">
                        <Link
                          to={to}
                          className="font-medium underline-offset-4 transition-colors hover:underline"
                        >
                          {name ?? 'Open the workflow'}
                        </Link>{' '}
                        — <span>New version</span> ·{' '}
                        <span className="text-muted-foreground">
                          Version {event.version.versionNumber}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatRelative(event.occurredAt)}
                      </p>
                    </div>
                  </li>
                );
              }
              const { name, to } = workflowName(event.run.workflowId);
              // F02 (§16): the run-level direct link — ?run= selects THIS
              // run on the workflow's run-status surface.
              const runTo = `/workflows/${event.run.workflowId}?run=${event.run.id}`;
              const stateWord =
                needsYouWord(event.run, runHistories, versions) ??
                humanRunState(event.run);
              const trust = trustOpen[event.run.id] === true;
              const history = runHistories[event.run.id];
              return (
                <li
                  key={event.key}
                  className="rounded-xl border border-border bg-card p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <p className="text-sm">
                      <Link
                        to={to}
                        className="font-medium underline-offset-4 transition-colors hover:underline"
                      >
                        {name ?? 'Open the workflow'}
                      </Link>{' '}
                      —{' '}
                      <span className={stateWord === 'Waiting for you' ? 'font-medium text-primary' : 'font-medium'}>
                        {stateWord}
                      </span>{' '}
                      ·{' '}
                      <Link
                        to={runTo}
                        className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                      >
                        Open the run
                      </Link>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatRelative(event.occurredAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setTrustOpen((prev) => ({
                        ...prev,
                        [event.run.id]: !(prev[event.run.id] === true),
                      }))
                    }
                    className="mt-2 rounded-md border border-border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent"
                  >
                    {trust ? 'Hide how you know' : 'How do you know?'}
                  </button>
                  {trust && (
                    <section
                      aria-label="How do you know?"
                      className="mt-3 border-t border-border pt-3"
                    >
                      {!history || history.kind === 'loading' ? (
                        <p
                          role="status"
                          aria-label="Loading"
                          className="text-sm text-muted-foreground"
                        >
                          Loading run details…
                        </p>
                      ) : history.kind === 'error' ? (
                        <div>
                          <p
                            role="status"
                            aria-label="Unavailable"
                            className="text-sm font-medium text-muted-foreground"
                          >
                            Unavailable
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Run details unavailable — couldn’t load the
                            execution history.
                          </p>
                          <button
                            type="button"
                            onClick={() => retryHistory(event.run.id)}
                            className="mt-1 rounded-md border border-border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent"
                          >
                            Try again
                          </button>
                        </div>
                      ) : (
                        <TrustDisclosure history={history.value} />
                      )}
                    </section>
                  )}
                </li>
              );
            })}
          </ul>
        )
      )}

      {/* The honest capability disclosure: teaching records (V2-006/V2-010)
          and device events expose NO product timeline read — entries are
          never fabricated, and the absence is disclosed instead of being
          rendered as a fake empty success. */}
      <p className="text-xs text-muted-foreground">
        Teaching activity isn’t shown here yet — teaching records don’t
        offer a timeline read. Device events aren’t shown here yet either.
      </p>
    </div>
  );
}
