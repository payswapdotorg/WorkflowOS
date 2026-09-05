/**
 * V2-017 T11 — the versions/updates/improvements experience (Issue #202).
 *
 * Composes EXISTING authorities only:
 *   - the V2-002 version/installation reads the page already holds, and
 *     the EXISTING V2-002 command routes for adoption (install the new
 *     version + retire the old installation — no adoption authority is
 *     invented: "a newer version can never move an installation");
 *   - the V2-011 optimization authority through its transport routes
 *     (analysis, proposals, the owner approval gate, materialization as
 *     NEW versions, the deterministic comparison).
 *
 * HONESTY RULES (UX §19/§20 + V2-017 rules 3/4/9):
 *   - "Nothing changes until you approve the update." — the installed pin
 *     renders verbatim and moves ONLY through the explicit adoption
 *     action;
 *   - historical versions stay addressable and inspectable (the §19
 *     "trust feature");
 *   - "What changed" comes ONLY from the V2-011 comparison (correctness
 *     first; the modeled rubric deltas render as ESTIMATES — a worse
 *     score renders verbatim);
 *   - improvements are recommendations that become NEW versions only
 *     through the owner's explicit approval + materialization — never a
 *     silent mutation of the installed version;
 *   - failed reads stay visibly unavailable (never empty successes);
 *   - internal node IDs never render (V2-003 presentation labels).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  optimization,
  workflowRepository,
  type ProductInstallationDetail,
  type ProductOptimizationOpportunity,
  type ProductOptimizationProposal,
  type ProductVersionComparison,
  type ProductWorkflow,
  type ProductWorkflowVersion,
} from '../../api/client';
import {
  nodeLabelsFromContent,
  stepLabel,
  improvementHeadline,
  improvementDetail,
  correctnessLine,
  compatibilityLine,
  tradeOffLines,
  ESTIMATES_NOTE,
  proposalStatusWord,
} from './versions-language';

interface VersionsExperienceProps {
  workflow: ProductWorkflow;
  versions: ProductWorkflowVersion[];
  installation: ProductInstallationDetail | null;
  /** Re-run the page's authoritative reads after adoption/materialization. */
  onRefresh: () => void;
}

type AnalysisState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'data'; opportunities: ProductOptimizationOpportunity[] };

type ComparisonState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'data'; comparison: ProductVersionComparison };

type ProposalRecord = {
  proposal: ProductOptimizationProposal | null;
  error?: string;
  busy?: boolean;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export default function VersionsExperience({
  workflow,
  versions,
  installation,
  onRefresh,
}: VersionsExperienceProps) {
  // The analyzed version: the installed pin (what the user runs), else the
  // head (the newest state) — the same selection rule as the page.
  const pinnedVersionId = installation
    ? installation.installation.versionId
    : workflow.headVersionId;
  const pinnedVersion = versions.find((v) => v.id === pinnedVersionId) ?? null;
  const labels = useMemo(
    () => nodeLabelsFromContent(pinnedVersion?.content ?? null),
    [pinnedVersion],
  );

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [comparisonState, setComparisonState] = useState<ComparisonState>({ kind: 'idle' });
  const [reviewing, setReviewing] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ kind: 'loading' });
  const [proposals, setProposals] = useState<Record<string, ProposalRecord>>({});

  // --- the analysis + the proposal converge read (§20) ----------------------

  const loadAnalysis = useCallback(async () => {
    if (pinnedVersionId === null) {
      setAnalysisState({ kind: 'unavailable' });
      return;
    }
    setAnalysisState({ kind: 'loading' });
    try {
      const { analysis } = await optimization.analyze(workflow.id, pinnedVersionId);
      setAnalysisState({ kind: 'data', opportunities: analysis.opportunities ?? [] });
      // converge on already-created proposals (the transport store)
      const { proposals: existing } = await optimization.listProposals(workflow.id);
      setProposals((prev) => {
        const next = { ...prev };
        for (const p of existing) {
          for (const nodeId of p.provenance?.opportunityNodeIds ?? []) {
            if (next[nodeId] === undefined) next[nodeId] = { proposal: p };
          }
        }
        return next;
      });
    } catch {
      setAnalysisState({ kind: 'unavailable' });
    }
  }, [workflow.id, pinnedVersionId]);

  useEffect(() => {
    void loadAnalysis();
  }, [loadAnalysis]);

  // --- §19: the update comparison (only from the V2-011 authority) --------

  const updateAvailable =
    installation !== null && pinnedVersionId !== null && workflow.headVersionId !== pinnedVersionId;
  const headVersion = versions.find((v) => v.id === workflow.headVersionId) ?? null;

  const reviewUpdate = async () => {
    if (!reviewing) {
      setReviewing(true);
      return;
    }
    setReviewing(false);
  };

  useEffect(() => {
    if (!reviewing || !updateAvailable || !installation || !headVersion) return;
    let cancelled = false;
    setComparisonState({ kind: 'loading' });
    (async () => {
      try {
        const { comparison } = await optimization.compareVersions(
          workflow.id,
          installation.installation.versionId,
          headVersion.id,
        );
        if (!cancelled) setComparisonState({ kind: 'data', comparison });
      } catch {
        if (!cancelled) setComparisonState({ kind: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reviewing, updateAvailable, installation, headVersion, workflow.id, workflow.headVersionId]);

  // --- §19: explicit adoption (the EXISTING V2-002 commands only) ----------

  const approveUpdate = async () => {
    if (!installation || !headVersion) return;
    setAdopting(true);
    setAdoptError(null);
    try {
      // Install the NEW version (a NEW immutable pin; the old row is
      // untouched) …
      await workflowRepository.installVersion(
        installation.installation.organizationId,
        workflow.id,
        headVersion.id,
      );
      // … then retire the old installation (the existing lifecycle
      // command — never touches versions).
      if (installation.installation.id) {
        await workflowRepository.setInstallationStatus(
          installation.installation.organizationId,
          installation.installation.id,
          'disable',
        );
      }
      onRefresh();
    } catch (err) {
      setAdoptError(
        err instanceof ApiError
          ? `The update couldn't be approved: ${err.message}`
          : "The update couldn't be approved.",
      );
    } finally {
      setAdopting(false);
    }
  };

  // --- §20: the improvement proposal lifecycle -------------------------------

  const reviewImprovement = async (opportunity: ProductOptimizationOpportunity) => {
    const nodeId = opportunity.nodeId ?? opportunity.nodeIds?.[0];
    if (nodeId === undefined || proposals[nodeId] !== undefined) return;
    setProposals((prev) => ({ ...prev, [nodeId]: { proposal: null, busy: true } }));
    try {
      const { proposal } = await optimization.createProposal(
        workflow.id,
        pinnedVersionId!,
        nodeId,
      );
      setProposals((prev) => ({ ...prev, [nodeId]: { proposal } }));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The improvement couldn't be reviewed.";
      setProposals((prev) => ({
        ...prev,
        [nodeId]: { proposal: null, error: message },
      }));
    }
  };

  const actOnProposal = async (
    nodeId: string,
    action: 'approve' | 'materialize',
  ): Promise<void> => {
    const record = proposals[nodeId];
    if (!record?.proposal) return;
    try {
      if (action === 'approve') {
        const { proposal } = await optimization.approveProposal(record.proposal.id);
        setProposals((prev) => ({ ...prev, [nodeId]: { proposal } }));
      } else {
        const { proposal } = await optimization.materializeProposal(record.proposal.id);
        setProposals((prev) => ({ ...prev, [nodeId]: { proposal } }));
        onRefresh();
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'The action failed.';
      setProposals((prev) => ({
        ...prev,
        [nodeId]: { proposal: record.proposal, error: message },
      }));
    }
  };

  // --- render -----------------------------------------------------------------

  const installedNumber = installation?.pinnedVersion.versionNumber;
  const headNumber = headVersion?.versionNumber;

  return (
    <div className="mt-6 space-y-6">
      {/* Version history — §19: addressable + inspectable. */}
      <section
        aria-label="Version history"
        className="rounded-xl border border-border bg-card p-5"
      >
        <h2 className="font-medium">Version history</h2>
        {versions.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {[...versions].reverse().map((v) => {
              const isCurrent = v.id === workflow.headVersionId;
              const isInstalled = installation !== null && v.id === installation.installation.versionId;
              const isOpen = expanded[v.id] === true;
              const versionLabels = labelsOf(v.content);
              return (
                <li key={v.id} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">Version {v.versionNumber}</span>
                    {isCurrent && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                        Current
                      </span>
                    )}
                    {isInstalled && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Installed
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDate(v.createdAt)}
                    </span>
                    <button
                      type="button"
                      className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      onClick={() => setExpanded((prev) => ({ ...prev, [v.id]: !isOpen }))}
                    >
                      {isOpen ? 'Hide steps' : 'View steps'}
                    </button>
                  </div>
                  {isOpen &&
                    (versionLabels === null ? (
                      // The failed presentation-label read stays VISIBLY
                      // unavailable — never a successful empty steps list
                      // (the V2-017 rule; the architect finding T11-F02).
                      <p className="mt-2 text-sm text-muted-foreground">
                        This version's steps aren't available right now.
                      </p>
                    ) : (
                      <ol
                        aria-label={`Version ${v.versionNumber} steps`}
                        className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground"
                      >
                        {versionLabels.map((label) => (
                          <li key={label}>{label}</li>
                        ))}
                      </ol>
                    ))}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            The version history isn't available right now.
          </p>
        )}
      </section>

      {/* Update available — §19: the immutable pin + explicit adoption. */}
      <section
        aria-label="Update available"
        className="rounded-xl border border-border bg-card p-5"
      >
        <h2 className="font-medium">Updates</h2>
        {installation === null ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No installed version yet — updates appear here once you install this workflow.
          </p>
        ) : updateAvailable ? (
          <div className="mt-2 space-y-3">
            <div>
              <p className="text-sm font-medium">An update is available</p>
              <p className="mt-1 text-sm">
                <span>{workflow.name}</span> · <span>Version {headNumber ?? '—'}</span>
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              Your installed version: <span>Version {installedNumber ?? '—'}</span> — pinned
            </p>
            <p className="text-sm text-muted-foreground">
              Nothing changes until you approve the update.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                onClick={() => void reviewUpdate()}
              >
                {reviewing ? 'Hide what changed' : 'Review update'}
              </button>
              {reviewing && comparisonState.kind === 'data' && (
                <button
                  type="button"
                  className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  disabled={adopting}
                  onClick={() => void approveUpdate()}
                >
                  {adopting ? 'Approving…' : 'Approve update'}
                </button>
              )}
            </div>
            {adoptError && (
              <p role="alert" className="text-sm text-destructive">
                {adoptError}
              </p>
            )}
            {reviewing && <ComparisonDetail state={comparisonState} />}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            You're on the newest version.
          </p>
        )}
      </section>

      {/* Improvements — §20: recommendations that become NEW versions. */}
      <section aria-label="Improvements" className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-medium">Improvements</h2>
        {analysisState.kind === 'loading' && (
          <p className="mt-2 text-sm text-muted-foreground">Checking for improvements…</p>
        )}
        {analysisState.kind === 'unavailable' && (
          <p className="mt-2 text-sm text-muted-foreground">
            Improvements aren't available right now.
          </p>
        )}
        {analysisState.kind === 'data' && analysisState.opportunities.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">No improvements found yet.</p>
        )}
        {analysisState.kind === 'data' && analysisState.opportunities.length > 0 && (
          <div className="mt-2 space-y-3">
            <p className="text-sm text-muted-foreground">
              WorkflowOS found {analysisState.opportunities.length}{' '}
              {analysisState.opportunities.length === 1 ? 'improvement' : 'improvements'}
            </p>
            {analysisState.opportunities.map((opportunity) => {
              const nodeId = opportunity.nodeId ?? opportunity.nodeIds?.[0] ?? '';
              const record = proposals[nodeId];
              const stepName = stepLabel(labels, nodeId) ?? 'a workflow step';
              return (
                <div key={nodeId} className="rounded-lg border border-border p-3">
                  <p className="text-sm font-medium">{improvementHeadline(opportunity.kind)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{stepName}</p>
                  {record?.proposal ? (
                    <ProposalDetail
                      proposal={record.proposal}
                      error={record.error}
                      onApprove={() => void actOnProposal(nodeId, 'approve')}
                      onMaterialize={() => void actOnProposal(nodeId, 'materialize')}
                    />
                  ) : record?.error ? (
                    <p role="alert" className="mt-2 text-sm text-destructive">
                      {record.error}
                    </p>
                  ) : (
                    <>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {improvementDetail(opportunity)}
                      </p>
                      <button
                        type="button"
                        className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                        disabled={record?.busy === true || record !== undefined}
                        onClick={() => void reviewImprovement(opportunity)}
                      >
                        Review
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/** The §19/§20 comparison detail (correctness first, then the estimates). */
function ComparisonDetail({ state }: { state: ComparisonState }): React.ReactNode {
  if (state.kind === 'idle' || state.kind === 'loading') {
    return <p className="text-sm text-muted-foreground">Comparing the versions…</p>;
  }
  if (state.kind === 'unavailable') {
    return (
      <p className="text-sm text-muted-foreground">
        What changed isn't available right now.
      </p>
    );
  }
  const comparison = state.comparison;
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-sm font-medium">What changed</p>
      <p className="mt-1 text-sm">{correctnessLine(comparison)}</p>
      <p className="mt-1 text-sm text-muted-foreground">{compatibilityLine(comparison)}</p>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {tradeOffLines(comparison).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">{ESTIMATES_NOTE}</p>
    </div>
  );
}

/** The §20 proposal card (the approval gate → the new version). */
function ProposalDetail({
  proposal,
  error,
  onApprove,
  onMaterialize,
}: {
  proposal: ProductOptimizationProposal;
  error?: string;
  onApprove: () => void;
  onMaterialize: () => void;
}): React.ReactNode {
  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-sm">{proposal.rationale}</p>
      <p className="mt-1 text-sm">{correctnessLine(proposal.comparison)}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {compatibilityLine(proposal.comparison)}
      </p>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {tradeOffLines(proposal.comparison).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">{ESTIMATES_NOTE}</p>
      <p className="mt-2 text-sm font-medium" data-proposal-status={proposal.status}>
        {proposalStatusWord(proposal.status)}
      </p>
      {error && (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {error}
        </p>
      )}
      {proposal.status === 'proposed' && (
        <button
          type="button"
          className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          onClick={onApprove}
        >
          Approve improvement
        </button>
      )}
      {proposal.status === 'approved' && (
        <button
          type="button"
          className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          onClick={onMaterialize}
        >
          Create the new version
        </button>
      )}
    </div>
  );
}

/**
 * The step labels of one version (the presentation layer — F-T4-001).
 * `null` = the V2-003 presentation-label read FAILED for that version —
 * the V2-017 rule: a failed read must remain distinct from a successful
 * empty result (it renders visibly unavailable, never an empty list).
 */
function labelsOf(content: unknown): string[] | null {
  const labels = nodeLabelsFromContent(content);
  if (labels === null) return null;
  return Object.values(labels);
}
