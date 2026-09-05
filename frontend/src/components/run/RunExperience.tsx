import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  workflowRuns,
  type ProductWorkflow,
  type ProductWorkflowVersion,
  type ProductInstallationDetail,
  type ProductDeployment,
  type ProductWorkflowRun,
  type ProductRunHistory,
} from '../../api/client';
import { humanRunState, humanRunStateSentence } from '../activity/run-state-language';
import { approvalStepIdsFromContent } from '../activity/workflow-ir-facts';
import TrustDisclosure from '../activity/TrustDisclosure';

/**
 * RunExperience — the Run / approval / where-it-runs surface (V2-017 Task 6).
 *
 * Composed over EXISTING authorities only — no second run model:
 *   - the preview's steps come from the run-pinned version's V2-003
 *     presentation layer (nodeLabels — the F-T4-001 rule: internal node
 *     IDs never render);
 *   - the "Approval required" fact comes from the IR's approval nodes
 *     (spec.human.kind === 'approval'): the human CONSENT boundary, shown
 *     only when the version declares it (never fabricated);
 *   - "Needs access to" stays the canonical CAPABILITY language, kept
 *     separate from consent; AUTHORIZATION stays the backend's — typed
 *     command rejections render verbatim as errors, never as state;
 *   - where-it-runs options + availability reasons derive from the
 *     workflow-deployments placement policy (the public placement read);
 *     an unavailable option carries its explicit reason; no deployment →
 *     the honest not-set-up fact (never a fabricated available choice);
 *   - the Run command preserves the authoritative semantics: the real
 *     V2-005 request (the command envelope + a fresh manual trigger + the
 *     installation pin) followed by the real start command — the run id
 *     is re-READ from the runs list after the request (never guessed);
 *   - the status states use the human vocabulary (UX spec §15) derived
 *     ONLY from authoritative facts: Ready (requested) / Running /
 *     Waiting for you (paused at an approval step — history-derived) /
 *     Paused / Completed / Couldn't complete (failed) / Cancelled, with
 *     the honest Unavailable surface when the run-details read fails (the
 *     record-derived state word stays factual — a known fact is never
 *     discarded);
 *   - T10 F02 (§16 direct links): the surface presents the ?run=
 *     selected run (the Activity "Open the run" link) — by default the
 *     workflow's newest run; an earlier run is disclosed as such
 *     (isLatest=false), never mistaken for the current status;
 *   - internal run-state terminology (state words, run ids, trigger
 *     types) appears ONLY inside Advanced details (progressive
 *     disclosure).
 */

/** The steps from the authoritative presentation layer (F-T4-001 rules). */
function stepsFromContent(content: unknown): string[] | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null;
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

/** The distinct capabilities the version's nodes require (access facts). */
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

/** The run's human state word (UX spec §15) from the authoritative record
 *  — the SHARED vocabulary (run-state-language), one source for the
 *  run-status surface and the Activity timeline. */
function humanState(run: ProductWorkflowRun): string {
  return humanRunState(run);
}

function humanStateSentence(state: string): string {
  return humanRunStateSentence(state);
}

interface WhereOption {
  label: string;
  available: boolean;
  qualifier: string | null;
  reason: string | null;
}

/**
 * The V2-004 placement vocabulary, consumed faithfully (the frozen
 * placement contract — never collapsed to a binary heuristic):
 *
 *   device_local        → device only;
 *   device_preferred    → device preferred, cloud ONLY through an
 *                         explicit fallback;
 *   cloud_allowed       → device and cloud both admitted;
 *   cloud_preferred     → cloud preferred, device ONLY through an
 *                         explicit fallback;
 *   cloud_required      → cloud only;
 *   any_supported_node  → device and cloud.
 *
 * The fallbackOrder carries placement tokens: a fallback admits an
 * environment iff it intersects that environment's admitting tokens.
 */
const BOTH_ADMITTED = new Set(['cloud_allowed', 'any_supported_node']);
const CLOUD_FALLBACK_TOKENS = new Set([
  'cloud_allowed',
  'cloud_preferred',
  'cloud_required',
  'any_supported_node',
]);
const DEVICE_FALLBACK_TOKENS = new Set([
  'device_local',
  'device_preferred',
  'cloud_allowed',
  'any_supported_node',
]);

type Admission = false | 'primary-required' | 'primary-preferred' | 'fallback' | 'admitted';

/** How ONE deployment's policy admits the device environment. */
function deviceAdmission(policy: {
  placement: { required: string; fallbackOrder?: string[] };
}): Admission {
  const required = policy.placement.required;
  if (required === 'device_local') return 'primary-required';
  if (required === 'device_preferred') return 'primary-preferred';
  if (BOTH_ADMITTED.has(required)) return 'admitted';
  // cloud_preferred: the device ONLY through an explicit fallback;
  // cloud_required: never.
  if (required === 'cloud_preferred') {
    return policy.placement.fallbackOrder?.some((f) => DEVICE_FALLBACK_TOKENS.has(f))
      ? 'fallback'
      : false;
  }
  return false;
}

/** How ONE deployment's policy admits the cloud environment. */
function cloudAdmission(policy: {
  placement: { required: string; fallbackOrder?: string[] };
}): Admission {
  const required = policy.placement.required;
  if (required === 'cloud_required') return 'primary-required';
  if (required === 'cloud_preferred') return 'primary-preferred';
  if (BOTH_ADMITTED.has(required)) return 'admitted';
  // device_preferred: the cloud ONLY through an explicit fallback;
  // device_local: never.
  if (required === 'device_preferred') {
    return policy.placement.fallbackOrder?.some((f) => CLOUD_FALLBACK_TOKENS.has(f))
      ? 'fallback'
      : false;
  }
  return false;
}

const ADMISSION_RANK: Record<Exclude<Admission, false>, number> = {
  'primary-required': 3,
  'primary-preferred': 2,
  admitted: 1,
  fallback: 1,
};

/**
 * The where-it-runs options from the placement policies (the deployment
 * read — the public placement authority). Multiple enabled policies
 * COMBINE: an environment is available when any policy admits it (with
 * the strongest qualifier), and unavailable only when every policy
 * denies it (with the explicit reason). The Run command itself takes no
 * location parameter (the authoritative command semantics); these are
 * the FACTS of where this workflow runs.
 */
function whereOptions(deployments: ProductDeployment[]): WhereOption[] | null {
  const enabled = deployments.filter((d) => d.enabled);
  if (enabled.length === 0) return null;
  const deviceAdmissions = enabled
    .map((d) => deviceAdmission(d.placement))
    .filter((a): a is Exclude<Admission, false> => a !== false);
  const cloudAdmissions = enabled
    .map((d) => cloudAdmission(d.placement))
    .filter((a): a is Exclude<Admission, false> => a !== false);

  const strongest = (admissions: Array<Exclude<Admission, false>>): string | null => {
    if (admissions.length === 0) return null;
    return admissions.reduce((best, current) =>
      ADMISSION_RANK[current] > ADMISSION_RANK[best] ? current : best,
    );
  };
  const deviceAdmissionStrongest = strongest(deviceAdmissions);
  const cloudAdmissionStrongest = strongest(cloudAdmissions);

  const qualifierWord = (admission: string | null): string | null => {
    if (admission === 'primary-required') return 'required by this workflow';
    if (admission === 'primary-preferred') return 'preferred by this workflow';
    if (admission === 'fallback') return 'as an explicit fallback';
    return null; // plainly admitted (both-admitted policies)
  };

  return [
    {
      label: 'This device',
      available: deviceAdmissionStrongest !== null,
      qualifier: qualifierWord(deviceAdmissionStrongest),
      reason:
        deviceAdmissionStrongest === null
          ? 'Not available — this workflow runs in the cloud only'
          : null,
    },
    {
      label: 'Cloud',
      available: cloudAdmissionStrongest !== null,
      qualifier: qualifierWord(cloudAdmissionStrongest),
      reason:
        cloudAdmissionStrongest === null
          ? 'Not available — this workflow runs on your device only'
          : null,
    },
  ];
}

export default function RunExperience({
  workflow,
  versions,
  installation,
  deployments,
  run,
  isLatest = true,
  onRunsChanged,
}: {
  workflow: ProductWorkflow;
  versions: ProductWorkflowVersion[];
  installation: ProductInstallationDetail | null;
  deployments: ProductDeployment[];
  /** The run this surface presents — by default the workflow's newest
   *  run; a ?run= direct link (T10 F02) may select an earlier one. */
  run: ProductWorkflowRun | null;
  /** Whether `run` is the newest run (an earlier run is disclosed as
   *  such — never mistaken for the current status). */
  isLatest?: boolean;
  onRunsChanged: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [historyState, setHistoryState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'data'; history: ProductRunHistory }
    | { kind: 'error' }
  >({ kind: 'idle' });

  // The version a run would pin: the installation's pinned version when
  // installed (the pin is verbatim — never auto-updated), else the head.
  // The content comes from the versions read (the authority); when the
  // pinned version is not visible in the read, the preview facts degrade
  // honestly — the Run command still pins the authoritative ids and the
  // backend's typed decision governs.
  const pinnedVersionId = installation
    ? installation.installation.versionId
    : workflow.headVersionId;
  const pinnedVersion = versions.find((v) => v.id === pinnedVersionId) ?? null;
  const content = pinnedVersion?.content ?? null;
  const steps = content ? stepsFromContent(content) : null;
  const capabilities = content ? capabilitiesFromContent(content) : [];
  const approvalRequired = content !== null && approvalStepIdsFromContent(content).size > 0;
  const where = whereOptions(deployments);

  // The run-details history read: powers the Waiting-for-you derivation and
  // the Advanced details. A failure is the honest Unavailable surface — the
  // record-derived state word stays factual.
  const loadHistory = useCallback(async () => {
    if (!run) return;
    setHistoryState({ kind: 'loading' });
    try {
      const history = await workflowRuns.getHistory(run.id);
      setHistoryState({ kind: 'data', history });
    } catch {
      setHistoryState({ kind: 'error' });
    }
  }, [run]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // The Waiting-for-you derivation: paused at an approval step. The pause
  // timeline entry carries the executor-reported pause point in
  // detail.atStepId (the authoritative wire shape) — never guessed.
  let stateWord = run ? humanState(run) : null;
  if (run && run.state === 'paused' && historyState.kind === 'data') {
    const approvalIds = content ? approvalStepIdsFromContent(content) : new Set<string>();
    const pauses = historyState.history.timeline
      .filter((e) => e.eventName === 'workflow.run.paused')
      .sort((a, b) => a.sequence - b.sequence);
    const last = pauses[pauses.length - 1];
    const atStepId =
      (last?.detail && typeof last.detail.atStepId === 'string'
        ? (last.detail.atStepId as string)
        : null) ?? last?.stepId ?? null;
    if (atStepId && approvalIds.has(atStepId)) {
      stateWord = 'Waiting for you';
    }
  }

  const runCommand = useCallback(async () => {
    if (!pinnedVersionId) return;
    setSubmitting(true);
    setCommandError(null);
    try {
      // The request succeeds (the backend owns every decision) and returns
      // the authoritative run id — the create-or-converge identity of THIS
      // command.
      const requested = await workflowRuns.request(workflow.organizationId, {
        workflowId: workflow.id,
        versionId: pinnedVersionId,
        installationId: installation ? installation.installation.id : null,
      });
      // The mandated re-read of the runs list — locating the EXACT run this
      // command created/converged (never a workflowId + newest heuristic:
      // a concurrent sibling run must never be started by mistake). Fail
      // closed if the authoritative run is absent from the list.
      const runs = await workflowRuns.listForOrganization(workflow.organizationId);
      const exact = runs.find((r) => r.id === requested.run.id);
      if (!exact) {
        setCommandError(
          'The requested run is not in the runs list — it could not be started safely.',
        );
        return;
      }
      await workflowRuns.start(exact.id);
      setPreviewOpen(false);
      onRunsChanged();
    } catch (err) {
      // A typed command rejection: the honest error, verbatim — never a
      // fabricated success and never a parallel run state. (The typed wire
      // identifier IS the ApiError message.)
      const message = err instanceof ApiError ? err.message : 'The run command could not be sent.';
      setCommandError(message);
    } finally {
      setSubmitting(false);
    }
  }, [workflow, installation, pinnedVersionId, onRunsChanged]);

  return (
    <div className="space-y-4">
      {/* The primary Run action + the current state word. While the
          preview is open it owns the Run flow (one Run verb at a time). */}
      <section aria-label="Run entry" className="flex flex-wrap items-center gap-4">
        {!previewOpen && (
          <button
            type="button"
            onClick={() => {
              setCommandError(null);
              setPreviewOpen(true);
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Run
          </button>
        )}
        {stateWord && (
          <p className="text-sm">
            <span className="font-medium">{stateWord}</span>
          </p>
        )}
      </section>

      {/* The run status surface (the human vocabulary + Advanced details). */}
      {run && stateWord && (
        <section aria-label="Run status" className="rounded-xl border border-border bg-card p-5">
          <p className="font-medium">{stateWord}</p>
          <p className="mt-1 text-sm text-muted-foreground">{humanStateSentence(stateWord)}</p>
          {!isLatest && (
            <p className="mt-1 text-xs text-muted-foreground">
              An earlier run — the newest run appears in Recent activity.
            </p>
          )}
          {historyState.kind === 'loading' && (
            <p
              role="status"
              aria-label="Loading"
              className="mt-2 text-xs text-muted-foreground"
            >
              Loading run details…
            </p>
          )}
          {historyState.kind === 'error' && (
            <div className="mt-2">
              <p
                role="status"
                aria-label="Unavailable"
                className="text-sm font-medium text-muted-foreground"
              >
                Unavailable
              </p>
              <p className="text-sm text-muted-foreground">Run details unavailable — couldn't load the execution history.</p>
              <button
                type="button"
                onClick={() => void loadHistory()}
                className="mt-1 rounded-md border border-border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent"
              >
                Try again
              </button>
            </div>
          )}
          {historyState.kind === 'data' && (
            // T10 (V2-017): the §17 "How do you know?" trust presentation —
            // composed from the SAME history read (no second evidence
            // authority): concise evidence first, advanced verification on
            // demand, the no-physical-proof boundary always stated.
            <section
              aria-label="How do you know?"
              className="mt-3 border-t border-border pt-3"
            >
              <TrustDisclosure history={historyState.history} />
            </section>
          )}
          {historyState.kind === 'data' && (
            <details
              className="mt-3"
              open={advancedOpen}
              onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
            >
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Advanced details
              </summary>
              {advancedOpen && (
                <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
                  <div className="flex gap-2">
                    <dt className="font-medium">Run state</dt>
                    <dd>{run.state}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium">Run id</dt>
                    <dd className="font-mono">{run.id}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium">Trigger</dt>
                    <dd>{(run.trigger as { type?: string } | null)?.type ?? 'unknown'}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium">Started</dt>
                    <dd>{run.createdAt}</dd>
                  </div>
                </dl>
              )}
            </details>
          )}
        </section>
      )}

      {/* The consequential-action preview (before any command is sent). */}
      {previewOpen && (
        <section
          role="region"
          aria-label="Run preview"
          className="rounded-xl border border-border bg-card p-5"
        >
          <h2 className="font-medium">Run {workflow.name}?</h2>
          <p className="mt-2 text-sm text-muted-foreground">This will:</p>
          {steps ? (
            <ol aria-label="This will" className="mt-1 list-decimal space-y-1 pl-5 text-sm">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              The steps aren't available in a human-readable form yet.
            </p>
          )}
          {pinnedVersion ? (
            <p className="mt-3 text-sm">Version {pinnedVersion.versionNumber}</p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Version facts unavailable — the pinned version isn't visible.
            </p>
          )}
          {approvalRequired && (
            <p className="mt-1 text-sm text-muted-foreground">
              Approval required — you'll confirm before it continues.
            </p>
          )}
          {capabilities.length > 0 && (
            <div className="mt-1 text-sm">
              <span className="text-muted-foreground">Needs access to</span>
              <ul className="mt-0.5 space-y-0.5 pl-4 text-muted-foreground">
                {capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3">
            <p className="text-sm text-muted-foreground">Where it runs</p>
            {where ? (
              <ul aria-label="Where it runs" className="mt-1 space-y-1 text-sm">
                {where.map((option) => (
                  <li key={option.label}>
                    <span className="font-medium">{option.label}</span>{' '}
                    {option.available ? (
                      <span className="text-muted-foreground">
                        Available
                        {option.qualifier ? ` · ${option.qualifier}` : ''}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{option.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Where it runs isn't set up yet — this workflow has no deployment.
              </p>
            )}
          </div>
          {commandError && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              Couldn't start this run — {commandError}
            </p>
          )}
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              disabled={submitting}
              onClick={() => setPreviewOpen(false)}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={submitting || !pinnedVersion}
              onClick={() => void runCommand()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? 'Starting…' : 'Run'}
            </button>
          </div>
          {submitting && (
            <p role="status" aria-label="Starting" className="mt-2 text-xs text-muted-foreground">
              Requesting the run…
            </p>
          )}
        </section>
      )}
    </div>
  );
}
