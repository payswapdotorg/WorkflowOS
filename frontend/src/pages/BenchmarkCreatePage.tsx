import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Trash2, CheckCircle2, ArrowRight, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { PageHeader } from '@/components/domain/page-header';
import { SectionHeader } from '@/components/domain/page-header';
import {
  benchmarks,
  projects,
  architecture,
  workItems,
  type Project,
  type Architecture,
  type ArchitectureVersion,
  type WorkItem,
  type BenchmarkSnapshotPreview,
  type BenchmarkTrialSpec,
  type BenchmarkExecutionMode,
  ApiError,
} from '@/api/client';

/**
 * WORK-032: BenchmarkCreatePage — the §44 creation flow.
 *
 * Five steps:
 *   1. select Project + Work Item (two Selects)
 *   2. preview snapshot (shows canonical prompt + digest + checks)
 *   3. name + description inputs
 *   4. trial matrix builder (provider × mode × repetitions)
 *   5. optional randomization checkbox + seed input
 *
 * The "Create Experiment" button freezes a snapshot AND creates the experiment
 * in one backend round-trip (the snapshot create call persists the snapshot,
 * then the experiment create call references the returned snapshot id).
 *
 * The frontend never derives integrity or computes the prompt digest — it
 * only renders backend-supplied preview values and forwards them as-is.
 */

const DEFAULT_PROVIDERS = ['zai', 'chatgpt', 'claude', 'fake'] as const;
const DEFAULT_MODES: BenchmarkExecutionMode[] = ['native', 'external'];

interface TrialRow {
  provider: string;
  mode: BenchmarkExecutionMode;
  repetitions: number;
}

function defaultTrialRows(): TrialRow[] {
  return [
    { provider: 'zai', mode: 'native', repetitions: 1 },
    { provider: 'zai', mode: 'external', repetitions: 1 },
    { provider: 'chatgpt', mode: 'native', repetitions: 1 },
    { provider: 'chatgpt', mode: 'external', repetitions: 1 },
    { provider: 'claude', mode: 'native', repetitions: 1 },
    { provider: 'claude', mode: 'external', repetitions: 1 },
  ];
}

export default function BenchmarkCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialProjectId = searchParams.get('projectId') ?? '';

  const [projectList, setProjectList] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [archList, setArchList] = useState<Architecture[]>([]);
  const [versionId, setVersionId] = useState('');
  const [versionMap, setVersionMap] = useState<Record<string, ArchitectureVersion[]>>({});
  const [workItemList, setWorkItemList] = useState<WorkItem[]>([]);
  const [workItemId, setWorkItemId] = useState('');

  const [preview, setPreview] = useState<BenchmarkSnapshotPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [trials, setTrials] = useState<TrialRow[]>(defaultTrialRows);
  const [randomizeOrder, setRandomizeOrder] = useState(false);
  const [randomizationSeed, setRandomizationSeed] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Load projects for the picker.
  useEffect(() => {
    let cancelled = false;
    projects
      .listForUser()
      .then((list) => {
        if (cancelled) return;
        setProjectList(list);
        if (!projectId && list.length > 0) setProjectId(list[0]!.id);
      })
      .catch(() => {
        /* non-fatal — picker stays empty */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the project changes, load architectures + versions for that project.
  useEffect(() => {
    if (!projectId) {
      setArchList([]);
      setVersionMap({});
      setVersionId('');
      setWorkItemList([]);
      setWorkItemId('');
      return;
    }
    let cancelled = false;
    architecture
      .listForProject(projectId)
      .then(async (archs) => {
        if (cancelled) return;
        setArchList(archs);
        const vMap: Record<string, ArchitectureVersion[]> = {};
        for (const a of archs) {
          vMap[a.id] = await architecture.listVersions(a.id).catch(() => []);
        }
        if (cancelled) return;
        setVersionMap(vMap);
      })
      .catch(() => {
        if (cancelled) return;
        setArchList([]);
        setVersionMap({});
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // When the version changes, load work items.
  useEffect(() => {
    if (!versionId) {
      setWorkItemList([]);
      setWorkItemId('');
      return;
    }
    let cancelled = false;
    workItems
      .listForVersion(versionId)
      .then((wis) => {
        if (cancelled) return;
        setWorkItemList(wis);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkItemList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  // When project + work item are both selected, fetch the snapshot preview.
  const loadPreview = useCallback(async () => {
    if (!projectId || !workItemId) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const p = await benchmarks.snapshots.preview(projectId, workItemId);
      setPreview(p);
    } catch (err) {
      setPreview(null);
      setPreviewError(err instanceof ApiError ? err.message : 'Failed to preview snapshot');
    } finally {
      setPreviewLoading(false);
    }
  }, [projectId, workItemId]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  const addTrial = () => {
    setTrials((rows) => [...rows, { provider: 'fake', mode: 'native', repetitions: 1 }]);
  };
  const removeTrial = (idx: number) => {
    setTrials((rows) => rows.filter((_, i) => i !== idx));
  };
  const updateTrial = (idx: number, patch: Partial<TrialRow>) => {
    setTrials((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const canSubmit =
    !!projectId &&
    !!workItemId &&
    !!name.trim() &&
    trials.length > 0 &&
    trials.every((t) => !!t.provider && t.repetitions > 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Step 1: freeze the snapshot from the template work item.
      const snapshot = await benchmarks.snapshots.create({
        projectId: projectId!,
        workItemId: workItemId!,
        name: name.trim(),
        description: description.trim() || undefined,
      });
      // Step 2: create the experiment referencing the snapshot.
      const trialSpecs: BenchmarkTrialSpec[] = trials.map((t) => ({
        provider: t.provider,
        mode: t.mode,
        repetitions: t.repetitions,
      }));
      const experiment = await benchmarks.create({
        projectId: projectId!,
        benchmarkTaskSnapshotId: snapshot.id,
        name: name.trim(),
        description: description.trim() || undefined,
        // PR #35 review fix #5: `createdBy` is NOT sent by the frontend — the
        // backend derives it from the authenticated identity.
        trials: trialSpecs,
        randomizeOrder,
        randomizationSeed: randomizationSeed.trim() || undefined,
      });
      navigate(`/benchmarks/${experiment.id}`);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to create experiment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Benchmark Experiment"
        description="Freeze a task snapshot, define trial cells, then run native vs external side by side."
        actions={
          <Button variant="outline" onClick={() => navigate('/benchmarks')}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back
          </Button>
        }
      />

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Step 1: project + work item selection */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              1. Select Project + Work Item
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="bc-project">Project</Label>
              <select
                id="bc-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="flex h-9 w-full max-w-md appearance-none rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">— select project —</option>
                {projectList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id.slice(0, 8)})
                  </option>
                ))}
              </select>
            </div>

            {archList.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="bc-version">Architecture Version</Label>
                <select
                  id="bc-version"
                  value={versionId}
                  onChange={(e) => setVersionId(e.target.value)}
                  className="flex h-9 w-full max-w-md appearance-none rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">— select version —</option>
                  {archList.flatMap((a) =>
                    (versionMap[a.id] ?? []).map((v) => (
                      <option key={v.id} value={v.id}>
                        {a.name} / {v.id.slice(0, 8)} ({v.state})
                      </option>
                    )),
                  )}
                </select>
              </div>
            )}

            {workItemList.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="bc-workitem">Work Item (template)</Label>
                <select
                  id="bc-workitem"
                  value={workItemId}
                  onChange={(e) => setWorkItemId(e.target.value)}
                  className="flex h-9 w-full max-w-md appearance-none rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">— select work item —</option>
                  {workItemList.map((wi) => (
                    <option key={wi.id} value={wi.id}>
                      {wi.workItemId}: {wi.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 2: snapshot preview */}
        {projectId && workItemId && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">2. Snapshot Preview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {previewLoading ? (
                <LoadingState label="Computing snapshot preview…" />
              ) : previewError ? (
                <ErrorState message={previewError} />
              ) : !preview ? (
                <p className="text-sm text-muted-foreground">No preview available.</p>
              ) : (
                <SnapshotPreviewCard preview={preview} />
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 3: name + description */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">3. Name + Description</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="bc-name">Experiment Name</Label>
              <Input
                id="bc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Z.ai native vs ChatGPT external — auth module"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bc-desc">Description (optional)</Label>
              <Textarea
                id="bc-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this experiment trying to measure?"
                rows={3}
              />
            </div>
          </CardContent>
        </Card>

        {/* Step 4: trial matrix builder */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              <span>4. Trial Matrix</span>
              <Button type="button" size="sm" variant="outline" onClick={addTrial}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add Row
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {trials.map((t, idx) => (
              <div
                key={idx}
                className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
              >
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor={`trial-provider-${idx}`}>Provider</Label>
                  <select
                    id={`trial-provider-${idx}`}
                    value={t.provider}
                    onChange={(e) => updateTrial(idx, { provider: e.target.value })}
                    className="flex h-9 w-full appearance-none rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {DEFAULT_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor={`trial-mode-${idx}`}>Mode</Label>
                  <select
                    id={`trial-mode-${idx}`}
                    value={t.mode}
                    onChange={(e) =>
                      updateTrial(idx, { mode: e.target.value as BenchmarkExecutionMode })
                    }
                    className="flex h-9 w-full appearance-none rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {DEFAULT_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-24 space-y-1.5">
                  <Label htmlFor={`trial-reps-${idx}`}>Reps</Label>
                  <Input
                    id={`trial-reps-${idx}`}
                    type="number"
                    min={1}
                    max={10}
                    value={t.repetitions}
                    onChange={(e) =>
                      updateTrial(idx, { repetitions: parseInt(e.target.value, 10) || 1 })
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeTrial(idx)}
                  aria-label={`Remove trial ${idx + 1}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Step 5: randomization */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">5. Randomization (optional)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={randomizeOrder}
                onChange={(e) => setRandomizeOrder(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input"
              />
              <span>
                Randomize trial execution order. The harness will shuffle trials
                using the seed below and persist the seed for reproducibility.
              </span>
            </label>
            {randomizeOrder && (
              <div className="space-y-1.5">
                <Label htmlFor="bc-seed">Randomization Seed</Label>
                <Input
                  id="bc-seed"
                  value={randomizationSeed}
                  onChange={(e) => setRandomizationSeed(e.target.value)}
                  placeholder="leave blank for harness-generated seed"
                  className="font-mono"
                />
              </div>
            )}
          </CardContent>
        </Card>

        {submitError && <ErrorState message={submitError} />}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => navigate('/benchmarks')}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || submitting}>
            {submitting ? 'Creating…' : 'Create Experiment'}
            {!submitting && <ArrowRight className="ml-1 h-4 w-4" />}
          </Button>
        </div>
      </form>
    </div>
  );
}

function SnapshotPreviewCard({ preview }: { preview: BenchmarkSnapshotPreview }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Work Item
          </div>
          <div className="text-sm text-foreground">{preview.workItemLabel}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Architecture Version
          </div>
          <div className="font-mono text-xs text-foreground">
            {preview.architectureVersionId.slice(0, 12)}…
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Repository
          </div>
          <div className="font-mono text-xs text-foreground">{preview.repository}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Base Commit
          </div>
          <div className="font-mono text-xs text-foreground">{preview.baseCommit.slice(0, 12)}…</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Prompt Digest
          </div>
          <div className="font-mono text-xs text-foreground">{preview.promptDigest.slice(0, 16)}…</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Snapshot Hash
          </div>
          <div className="font-mono text-xs text-foreground">{preview.snapshotHash.slice(0, 16)}…</div>
        </div>
      </div>

      {/* Prompt excerpt */}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Prompt Excerpt
        </div>
        <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs text-foreground">
          {preview.promptExcerpt}
        </pre>
      </div>

      {/* SAME TASK SNAPSHOT / SAME PROMPT DIGEST / SAME BASELINE checks */}
      <div className="space-y-2 rounded-md border border-border bg-card p-3">
        <SectionHeader title="Equality Invariants (§27/§28/§29)" />
        <CheckRow label="SAME TASK SNAPSHOT" value={preview.snapshotHash.slice(0, 16) + '…'} />
        <CheckRow label="SAME PROMPT DIGEST" value={preview.promptDigest.slice(0, 16) + '…'} />
        <CheckRow label="SAME BASELINE" value={preview.baseCommit.slice(0, 16) + '…'} />
      </div>
    </div>
  );
}

function CheckRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <CheckCircle2 className="h-4 w-4 text-success" />
      <span className="font-medium text-foreground">{label}</span>
      <span className="ml-auto font-mono text-xs text-muted-foreground">{value}</span>
    </div>
  );
}
