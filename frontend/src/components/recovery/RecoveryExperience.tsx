import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  workflowRuns,
  ApiError,
  type ProductWorkflow,
  type ProductWorkflowVersion,
  type ProductWorkflowRun,
  type ProductInstallationDetail,
} from '../../api/client';
import {
  nodeLabelsFromContent,
  failureReasonFromHistory,
  cancelReasonFromHistory,
  knownFactsFromHistory,
  unknownLinesFromHistory,
  advancedRecoveryFacts,
  RECOVERY_FAILED_SENTENCE,
  RECOVERY_CANCELLED_SENTENCE,
  RECOVERY_NO_REASON_SENTENCE,
  RECOVERY_HISTORY_UNAVAILABLE,
} from './failure-language';

/**
 * RecoveryExperience — the §18 failure / recovery / takeover surface
 * (V2-017 T7).
 *
 * Composes over EXISTING authorities only: the V2-005 run record + the
 * history read (the crash-recovery projection — the timeline's recorded
 * reason, the step outcomes, the attempts), the V2-005 lifecycle
 * commands (resume, cancel), and the T6 request/start path for "Try
 * again" (a FRESH manual trigger = a fresh run identity — honest, never
 * a fake resume of a terminal run).
 *
 * HONESTY RULES:
 *   - failures answer §18's questions: the known ✓/✕ facts (V2-003
 *     presentation labels — internal step IDs NEVER surface; unlabeled
 *     steps degrade to honest generic lines), the honest unknowns
 *     (never fabricated specifics), and only the actions the authority
 *     admits for the state (terminal runs never offer Resume/Stop);
 *   - a failed history read is the honest unavailable surface — never a
 *     successful empty "nothing happened"; the read-retry label stays
 *     distinct from the run-level "Try again";
 *   - Stop is consequential (§2.4): an explicit summary + confirm
 *     before the real cancel command;
 *   - takeover is presented honestly: no takeover command exists on
 *     the public routes, so [Take over] explains the preserved-run
 *     semantics and points at the execution host surface — it never
 *     sends an invented command;
 *   - typed backend rejections render verbatim as alerts, never as
 *     state;
 *   - the raw state word, run id, attempt count, trigger, and start
 *     instant stay expert-only (Advanced details).
 */

interface RecoveryExperienceProps {
  workflow: ProductWorkflow;
  versions: ProductWorkflowVersion[];
  installation: ProductInstallationDetail | null;
  latestRun: ProductWorkflowRun;
  onRunsChanged: () => void;
}

type HistoryState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; history: Record<string, unknown> };

export default function RecoveryExperience({
  workflow,
  versions,
  installation,
  latestRun,
  onRunsChanged,
}: RecoveryExperienceProps) {
  const [historyState, setHistoryState] = useState<HistoryState>({ kind: 'loading' });
  const [submitting, setSubmitting] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [takeOverOpen, setTakeOverOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryState({ kind: 'loading' });
    try {
      const history = await workflowRuns.getHistory(latestRun.id);
      setHistoryState({ kind: 'data', history: history as unknown as Record<string, unknown> });
    } catch {
      setHistoryState({ kind: 'error' });
    }
  }, [latestRun.id]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // The run's own version carries the labels (the history's step ids
  // are that version's node ids); the pinned/head version is the
  // fallback. F-T4-001: presentation labels only, never internal ids.
  const runVersion = useMemo(
    () => versions.find((v) => v.id === latestRun.versionId) ?? null,
    [versions, latestRun.versionId],
  );
  const labels = useMemo(
    () => nodeLabelsFromContent(runVersion?.content ?? null),
    [runVersion],
  );

  // The version a new run would pin (the installation pin verbatim —
  // never auto-updated; else the head).
  const pinnedVersionId = installation
    ? installation.installation.versionId
    : workflow.headVersionId;

  const terminal = latestRun.state === 'failed' || latestRun.state === 'cancelled';
  const failed = latestRun.state === 'failed';
  const paused = latestRun.state === 'paused';

  // The §18 explanation derives ONLY from the history record.
  const historyRecord =
    historyState.kind === 'data'
      ? (historyState.history as { timeline?: unknown; steps?: unknown; attempts?: unknown })
      : null;
  const reason = historyRecord
    ? failed
      ? failureReasonFromHistory(historyRecord)
      : cancelReasonFromHistory(historyRecord)
    : null;
  const knownFacts = historyRecord ? knownFactsFromHistory(historyRecord, labels) : [];
  const unknownLines = historyRecord ? unknownLinesFromHistory(historyRecord, labels) : [];

  // "Try again": the REAL T6 command path — a fresh manual trigger (a
  // NEW run; a failed run cannot be restarted: failed is terminal),
  // then the exact-run re-read discipline, then start.
  const tryAgain = useCallback(async () => {
    if (!pinnedVersionId) {
      setCommandError('This workflow has no version to run yet.');
      return;
    }
    setSubmitting(true);
    setCommandError(null);
    try {
      // REALITY-REPAIR-003 (F-003): the org the run commands operate in —
      // the INSTALLATION's organization (the authoritative org of the
      // pinned target; the backend validates the installation's org
      // against the request org, so the consumer's retry lands in THEIR
      // org, never the publisher's). Without an installation the
      // workflow's own org is the owner/member path (unchanged).
      const commandOrganizationId = installation
        ? installation.installation.organizationId
        : workflow.organizationId;
      const requested = await workflowRuns.request(commandOrganizationId, {
        workflowId: workflow.id,
        versionId: pinnedVersionId,
        installationId: installation ? installation.installation.id : null,
      });
      // The mandated re-read: locate the EXACT run this command created
      // (a concurrent sibling run must never be started by mistake);
      // fail closed if the authoritative run is absent.
      const runs = await workflowRuns.listForOrganization(commandOrganizationId);
      const exact = runs.find((r) => r.id === requested.run.id);
      if (!exact) {
        setCommandError(
          'The requested run is not in the runs list — it could not be started safely.',
        );
        return;
      }
      await workflowRuns.start(exact.id);
      onRunsChanged();
    } catch (err) {
      // A typed rejection: the honest error, verbatim — never a state.
      setCommandError(err instanceof ApiError ? err.message : 'The run command couldn\u2019t be sent.');
    } finally {
      setSubmitting(false);
    }
  }, [pinnedVersionId, workflow, installation, onRunsChanged]);

  const resume = useCallback(async () => {
    setSubmitting(true);
    setCommandError(null);
    try {
      await workflowRuns.resume(latestRun.id);
      onRunsChanged();
    } catch (err) {
      setCommandError(err instanceof ApiError ? err.message : 'The run couldn\u2019t be resumed.');
    } finally {
      setSubmitting(false);
    }
  }, [latestRun.id, onRunsChanged]);

  const stop = useCallback(async () => {
    setSubmitting(true);
    setCommandError(null);
    try {
      await workflowRuns.cancel(latestRun.id);
      onRunsChanged();
    } catch (err) {
      setCommandError(err instanceof ApiError ? err.message : 'The run couldn\u2019t be stopped.');
    } finally {
      setSubmitting(false);
      setStopConfirm(false);
    }
  }, [latestRun.id, onRunsChanged]);

  return (
    <section aria-label="Recovery" className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-medium">{paused ? 'What you can do' : 'What happened'}</h2>

      <div className="mt-2 space-y-1 text-sm">
        {failed && <p>{RECOVERY_FAILED_SENTENCE}</p>}
        {!failed && latestRun.state === 'cancelled' && <p>{RECOVERY_CANCELLED_SENTENCE}</p>}
        {historyRecord && (
          <p className="text-muted-foreground">
            {terminal
              ? failed
                ? reason
                  ? `It stopped: ${reason}`
                  : RECOVERY_NO_REASON_SENTENCE
                : reason
                  ? `It was stopped: ${reason}`
                  : null
              : null}
          </p>
        )}
        {historyState.kind === 'loading' && (
          <p role="status" aria-label="Loading" className="text-xs text-muted-foreground">
            Loading the details…
          </p>
        )}
        {historyState.kind === 'error' && (
          <div className="space-y-1">
            <p role="status" aria-label="Unavailable" className="text-muted-foreground">
              {RECOVERY_HISTORY_UNAVAILABLE}
            </p>
            <button
              type="button"
              onClick={() => void loadHistory()}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
            >
              Load the details again
            </button>
          </div>
        )}
      </div>

      {historyState.kind === 'data' && (
        <div className="mt-3 space-y-3">
          {knownFacts.length > 0 && (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                What I know
              </h3>
              <ul aria-label="What I know" className="mt-1 space-y-0.5 text-sm">
                {knownFacts.map((fact) => (
                  <li key={fact.text}>{fact.text}</li>
                ))}
              </ul>
            </div>
          )}
          {unknownLines.length > 0 && (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                What we don&rsquo;t know yet
              </h3>
              <ul aria-label="What we don&rsquo;t know yet" className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                {unknownLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        {terminal && (
          <button
            type="button"
            onClick={() => void tryAgain()}
            disabled={submitting}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {submitting ? 'Starting a new run…' : 'Try again'}
          </button>
        )}
        {paused && (
          <>
            <button
              type="button"
              onClick={() => void resume()}
              disabled={submitting}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              {submitting ? 'Resuming…' : 'Resume'}
            </button>
            <button
              type="button"
              onClick={() => setStopConfirm((v) => !v)}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={() => setTakeOverOpen((v) => !v)}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              Take over
            </button>
          </>
        )}
        <Link
          to="/expert"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          Edit workflow
        </Link>
      </div>

      {stopConfirm && (
        <div className="mt-3 space-y-2 rounded-md bg-accent/40 p-3 text-sm">
          <p>This ends the run — it can&rsquo;t be restarted. You can always run the workflow again.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void stop()}
              disabled={submitting}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              {submitting ? 'Stopping…' : 'Stop it'}
            </button>
            <button
              type="button"
              onClick={() => setStopConfirm(false)}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
            >
              Keep it going
            </button>
          </div>
        </div>
      )}

      {takeOverOpen && (
        <div className="mt-3 space-y-2 rounded-md bg-accent/40 p-3 text-sm">
          <p>
            Taking over preserves this run and hands control to you. It runs through the
            execution host in the expert workspace.
          </p>
          <p>
            <Link
              to="/expert"
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Open the expert workspace
            </Link>
          </p>
        </div>
      )}

      {commandError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {commandError}
        </p>
      )}

      <details
        className="mt-3 text-xs"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary className="cursor-pointer text-muted-foreground">Advanced details</summary>
        {advancedOpen && (
          <ul aria-label="Recovery facts" className="mt-1 space-y-0.5 pl-4 text-muted-foreground">
            {advancedRecoveryFacts(latestRun, historyRecord ?? {}).map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
