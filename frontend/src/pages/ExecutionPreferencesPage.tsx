import * as React from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ShieldCheck,
  Gauge,
  Settings2,
  Brain,
  Plus,
  Pencil,
  Lock,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusBadge } from '@/components/domain/status-badge';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/domain/page-header';
import {
  executionPolicy,
  ApiError,
  type ProjectPolicyRecord,
  type UserPreferenceRecord,
  type ProviderAccessProfileRecord,
  type BenchmarkMode,
  type PrivacyLevel,
  type ExecutionMode,
  type CapabilityReadiness,
} from '@/api/client';

/**
 * WORK-033 (§31): ExecutionPreferencesPage — the project-scoped execution
 * policy + user preference + provider-access-profile surface.
 *
 * The frontend is a pure consumer (§34): it loads backend state, lets the
 * user edit fields, and PATCHes back through the typed `executionPolicy`
 * client namespace. All authority (eligibility, scoring, recommendations,
 * freeze state) lives on the backend.
 *
 * §9 frozen policy: once a benchmark experiment starts, the project policy
 * becomes IMMUTABLE. This page surfaces `policy.frozen === true` by
 * disabling all policy-editing controls and showing a "Frozen" badge.
 */

// --- constants ---

const BENCHMARK_MODES: BenchmarkMode[] = [
  'maximum_capability',
  'controlled_comparison',
  'cost_constrained',
  'latency_constrained',
  'subscription_constrained',
  'privacy_constrained',
];

const PRIVACY_LEVELS: PrivacyLevel[] = ['standard', 'private', 'local_only', 'regulated'];

const EXECUTION_MODES: ExecutionMode[] = ['native', 'external'];

const READINESS_OPTIONS: CapabilityReadiness[] = [
  'supported',
  'ready',
  'unverified',
  'unavailable',
];

const STATUS_SOURCES: Array<'verified' | 'user_configured' | 'unknown'> = [
  'verified',
  'user_configured',
  'unknown',
];

// --- shared bits ---

function Toggle({
  checked,
  onChange,
  disabled,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description && (
          <span className="block text-xs text-muted-foreground">{description}</span>
        )}
      </span>
    </label>
  );
}

// --- the page ---

export default function ExecutionPreferencesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();

  const [policy, setPolicy] = React.useState<ProjectPolicyRecord | null>(null);
  const [preferences, setPreferences] = React.useState<UserPreferenceRecord | null>(null);
  const [accessProfiles, setAccessProfiles] = React.useState<ProviderAccessProfileRecord[]>([]);

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [savingPolicy, setSavingPolicy] = React.useState(false);
  const [savingPreferences, setSavingPreferences] = React.useState(false);
  const [freezing, setFreezing] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingProfile, setEditingProfile] = React.useState<ProviderAccessProfileRecord | null>(null);

  const loadAll = React.useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      // Load policy + preferences (both may be null — call ensure if so).
      const [p, prefs, profiles] = await Promise.all([
        executionPolicy.policy.get(projectId).catch(() => null),
        executionPolicy.preferences.get(projectId).catch(() => null),
        executionPolicy.accessProfiles.list(projectId).catch(() => []),
      ]);
      // Ensure defaults when null (§31 + §12 — non-destructive if already present).
      let policy = p;
      if (!policy) {
        policy = await executionPolicy.policy.ensure(projectId).catch(() => null);
      }
      let preferences = prefs;
      if (!preferences) {
        preferences = await executionPolicy.preferences.ensure(projectId).catch(() => null);
      }
      setPolicy(policy);
      setPreferences(preferences);
      setAccessProfiles(profiles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  // --- policy updates (§31) ---

  async function patchPolicy(input: Partial<ProjectPolicyRecord>) {
    if (!projectId || !policy) return;
    if (policy.frozen) {
      toast({
        title: 'Policy is frozen',
        description: 'The benchmark experiment has started — the policy is immutable (§9).',
        variant: 'destructive',
      });
      return;
    }
    setSavingPolicy(true);
    try {
      const next = await executionPolicy.policy.update(projectId, input);
      setPolicy(next);
      toast({ title: 'Policy updated', description: 'Changes applied.' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast({ title: 'Update failed', description: msg, variant: 'destructive' });
    } finally {
      setSavingPolicy(false);
    }
  }

  async function freezePolicy() {
    if (!projectId || !policy) return;
    setFreezing(true);
    try {
      const next = await executionPolicy.policy.freeze(projectId);
      setPolicy(next);
      toast({
        title: 'Policy frozen',
        description: 'The policy is now immutable for benchmark integrity (§9).',
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast({ title: 'Freeze failed', description: msg, variant: 'destructive' });
    } finally {
      setFreezing(false);
    }
  }

  // --- preferences updates (§12) ---

  async function patchPreferences(input: Partial<UserPreferenceRecord>) {
    if (!projectId || !preferences) return;
    setSavingPreferences(true);
    try {
      const next = await executionPolicy.preferences.update(projectId, input);
      setPreferences(next);
      toast({ title: 'Preferences updated', description: 'Changes applied.' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast({ title: 'Update failed', description: msg, variant: 'destructive' });
    } finally {
      setSavingPreferences(false);
    }
  }

  // --- access profile upsert (§5) ---

  async function upsertProfile(input: {
    provider: string;
    plan?: string | null;
    codingAgent?: CapabilityReadiness;
    externalUi?: CapabilityReadiness;
    nativeApi?: CapabilityReadiness;
    statusSource?: 'verified' | 'user_configured' | 'unknown';
    notes?: string | null;
  }) {
    if (!projectId) return;
    try {
      const saved = await executionPolicy.accessProfiles.upsert(projectId, input);
      setAccessProfiles((prev) => {
        const idx = prev.findIndex((p) => p.provider === saved.provider);
        if (idx === -1) return [...prev, saved];
        const next = [...prev];
        next[idx] = saved;
        return next;
      });
      toast({
        title: editingProfile ? 'Profile updated' : 'Profile added',
        description: saved.provider,
      });
      setDialogOpen(false);
      setEditingProfile(null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast({ title: 'Save failed', description: msg, variant: 'destructive' });
    }
  }

  if (loading) return <LoadingState label="Loading execution preferences…" />;
  if (error) return <ErrorState message={error} onRetry={loadAll} />;

  const frozen = policy?.frozen ?? false;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span>
            <Link to={`/projects/${projectId}`} className="hover:underline">
              Project
            </Link>{' '}
            / Settings / Execution
          </span>
        }
        title="Execution Preferences"
        description="Project execution policy, user preferences, and provider access profiles. Eligibility + recommendations are computed backend-side; this page only edits policy inputs."
      />

      <div className="grid gap-4 md:grid-cols-2">
        {/* --- Execution Modes --- */}
        <PreferencesCard
          title="Execution Modes"
          description="Allowable execution surfaces for this project"
          icon={Settings2}
          status={frozen ? <StatusBadge value="frozen" tone="neutral" /> : null}
        >
          <div className="space-y-3">
            <Toggle
              label="External execution"
              description="Allow external AI platforms via secure handoff (§15)"
              checked={policy?.externalExecutionAllowed ?? false}
              disabled={frozen || savingPolicy}
              onChange={(v) => patchPolicy({ externalExecutionAllowed: v })}
            />
            <Toggle
              label="Native execution"
              description="Allow WorkflowOS-backed agent API execution"
              checked={policy?.nativeExecutionAllowed ?? false}
              disabled={frozen || savingPolicy}
              onChange={(v) => patchPolicy({ nativeExecutionAllowed: v })}
            />
          </div>
        </PreferencesCard>

        {/* --- Benchmarking --- */}
        <PreferencesCard
          title="Benchmarking"
          description="Default mode for benchmark experiments (§8/§9)"
          icon={Gauge}
        >
          <div className="space-y-2">
            <Label htmlFor="bm-mode">Default benchmark mode</Label>
            <Select
              id="bm-mode"
              value={policy?.defaultBenchmarkMode ?? 'maximum_capability'}
              disabled={frozen || savingPolicy}
              onChange={(e) =>
                patchPolicy({
                  defaultBenchmarkMode: e.target.value as BenchmarkMode,
                })
              }
            >
              {BENCHMARK_MODES.map((m) => (
                <option key={m} value={m}>
                  {m.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">maximum_capability</span> lets each
              candidate use its strongest config;{' '}
              <span className="font-medium">controlled_comparison</span> holds
              task/architecture/baseline fixed and only differs surfaces/context-window/tool-impl.
            </p>
            <div className="pt-2">
              <Button
                size="sm"
                variant={policy?.frozen ? 'outline' : 'default'}
                disabled={!policy || freezing}
                onClick={freezePolicy}
                title="Freeze the policy so a benchmark experiment can start (§9 — one-way, immutable after this)"
              >
                <Lock className="mr-1 h-3.5 w-3.5" />
                {policy?.frozen ? 'Already frozen' : 'Freeze policy'}
              </Button>
              {policy?.frozen && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The policy is now immutable. Start the benchmark experiment;
                  the policy snapshot is fixed for the audit trail.
                </p>
              )}
            </div>
          </div>
        </PreferencesCard>

        {/* --- Privacy --- */}
        <PreferencesCard
          title="Privacy"
          description="Data residency + privacy classification (§12)"
          icon={ShieldCheck}
          status={frozen ? <StatusBadge value="frozen" tone="neutral" /> : null}
        >
          <div className="space-y-2">
            <Label htmlFor="privacy">Privacy level</Label>
            <Select
              id="privacy"
              value={policy?.privacyLevel ?? 'standard'}
              disabled={frozen || savingPolicy}
              onChange={(e) =>
                patchPolicy({ privacyLevel: e.target.value as PrivacyLevel })
              }
            >
              {PRIVACY_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">local_only</span> blocks external
              providers entirely. <span className="font-medium">regulated</span>{' '}
              restricts to org-approved providers only.
            </p>
          </div>
        </PreferencesCard>

        {/* --- Budget --- */}
        <PreferencesCard
          title="Budget"
          description="Maximum cost ceilings in cents (§24)"
          icon={Gauge}
          status={frozen ? <StatusBadge value="frozen" tone="neutral" /> : null}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="max-task">Max cost per task (cents)</Label>
              <Input
                id="max-task"
                type="number"
                min={0}
                placeholder="e.g. 200"
                value={policy?.maxCostPerTaskCents ?? ''}
                disabled={frozen || savingPolicy}
                onChange={(e) =>
                  patchPolicy({
                    maxCostPerTaskCents: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
              <p className="text-xs text-muted-foreground">null = no cap</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="max-trial">Max cost per trial (cents)</Label>
              <Input
                id="max-trial"
                type="number"
                min={0}
                placeholder="e.g. 50"
                value={policy?.maxCostPerTrialCents ?? ''}
                disabled={frozen || savingPolicy}
                onChange={(e) =>
                  patchPolicy({
                    maxCostPerTrialCents: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
              <p className="text-xs text-muted-foreground">null = no cap</p>
            </div>
          </div>
        </PreferencesCard>

        {/* --- Latency --- */}
        <PreferencesCard
          title="Latency"
          description="Maximum time-to-PR ceiling (§25)"
          icon={Gauge}
          status={frozen ? <StatusBadge value="frozen" tone="neutral" /> : null}
        >
          <div className="space-y-1.5">
            <Label htmlFor="max-latency">Max time-to-PR (milliseconds)</Label>
            <Input
              id="max-latency"
              type="number"
              min={0}
              placeholder="e.g. 3600000 (1 hour)"
              value={policy?.maxTimeToPrMs ?? ''}
              disabled={frozen || savingPolicy}
              onChange={(e) =>
                patchPolicy({
                  maxTimeToPrMs: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Authoritative WorkflowOS timestamps only; never provider self-report.
            </p>
          </div>
        </PreferencesCard>

        {/* --- Human Intervention --- */}
        <PreferencesCard
          title="Human Intervention"
          description="Allow operator involvement mid-execution (§26)"
          icon={Settings2}
          status={frozen ? <StatusBadge value="frozen" tone="neutral" /> : null}
        >
          <Toggle
            label="Allow human intervention"
            description="If disabled, external strategies that require user confirmation become ineligible (§26)."
            checked={policy?.humanInterventionAllowed ?? false}
            disabled={frozen || savingPolicy}
            onChange={(v) => patchPolicy({ humanInterventionAllowed: v })}
          />
        </PreferencesCard>

        {/* --- User Preferences (Weights) --- */}
        <PreferencesCard
          title="User Preference Weights"
          description="Advisory weights — never override hard constraints (§12)"
          icon={Brain}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="w-quality">Quality weight</Label>
              <Input
                id="w-quality"
                type="number"
                min={0}
                step={0.1}
                value={preferences?.qualityWeight ?? 0}
                disabled={savingPreferences}
                onChange={(e) =>
                  patchPreferences({ qualityWeight: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-cost">Cost weight</Label>
              <Input
                id="w-cost"
                type="number"
                min={0}
                step={0.1}
                value={preferences?.costWeight ?? 0}
                disabled={savingPreferences}
                onChange={(e) =>
                  patchPreferences({ costWeight: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-latency">Latency weight</Label>
              <Input
                id="w-latency"
                type="number"
                min={0}
                step={0.1}
                value={preferences?.latencyWeight ?? 0}
                disabled={savingPreferences}
                onChange={(e) =>
                  patchPreferences({ latencyWeight: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-privacy">Privacy weight</Label>
              <Input
                id="w-privacy"
                type="number"
                min={0}
                step={0.1}
                value={preferences?.privacyWeight ?? 0}
                disabled={savingPreferences}
                onChange={(e) =>
                  patchPreferences({ privacyWeight: Number(e.target.value) })
                }
              />
            </div>
          </div>
          <Separator className="my-3" />
          <div className="space-y-2">
            <Label htmlFor="pref-mode">Preferred mode</Label>
            <Select
              id="pref-mode"
              value={preferences?.preferredMode ?? ''}
              disabled={savingPreferences}
              onChange={(e) =>
                patchPreferences({
                  preferredMode:
                    e.target.value === '' ? null : (e.target.value as ExecutionMode),
                })
              }
            >
              <option value="">(no preference)</option>
              {EXECUTION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <div className="flex flex-col gap-2 pt-1">
              <Toggle
                label="Prefer external"
                checked={preferences?.externalPreferred ?? false}
                disabled={savingPreferences}
                onChange={(v) => patchPreferences({ externalPreferred: v })}
              />
              <Toggle
                label="Prefer native"
                checked={preferences?.nativePreferred ?? false}
                disabled={savingPreferences}
                onChange={(v) => patchPreferences({ nativePreferred: v })}
              />
            </div>
            <div className="space-y-1.5 pt-2">
              <Label htmlFor="pref-bm">Default benchmark mode (user)</Label>
              <Select
                id="pref-bm"
                value={preferences?.defaultBenchmarkMode ?? 'maximum_capability'}
                disabled={savingPreferences}
                onChange={(e) =>
                  patchPreferences({
                    defaultBenchmarkMode: e.target.value as BenchmarkMode,
                  })
                }
              >
                {BENCHMARK_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </PreferencesCard>

        {/* --- Provider Access Profiles --- */}
        <PreferencesCard
          title="Provider Access Profiles"
          description="User-configured subscription capability (§5)"
          icon={ShieldCheck}
          actions={
            <Button
              size="sm"
              variant="default"
              onClick={() => {
                setEditingProfile(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add provider
            </Button>
          }
        >
          {accessProfiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No provider access profiles configured. Profiles whose
              subscription capability is <span className="font-mono">unknown</span>{' '}
              default to blocked (§5).
            </p>
          ) : (
            <ul className="space-y-2">
              {accessProfiles.map((p) => (
                <li
                  key={p.id}
                  className="rounded-md border border-border bg-card p-2.5 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-medium">{p.provider}</span>
                    <div className="flex items-center gap-2">
                      <StatusBadge
                        value={p.statusSource}
                        tone={
                          p.statusSource === 'verified'
                            ? 'success'
                            : p.statusSource === 'user_configured'
                              ? 'info'
                              : 'warning'
                        }
                        humanize
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => {
                          setEditingProfile(p);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                        Edit
                      </Button>
                    </div>
                  </div>
                  {p.plan && (
                    <div className="mt-1 text-muted-foreground">
                      Plan: <span className="font-mono">{p.plan}</span>
                    </div>
                  )}
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    <span>
                      coding:{' '}
                      <StatusBadge value={p.codingAgent} humanize showDot={false} />
                    </span>
                    <span>
                      external:{' '}
                      <StatusBadge value={p.externalUi} humanize showDot={false} />
                    </span>
                    <span>
                      native:{' '}
                      <StatusBadge value={p.nativeApi} humanize showDot={false} />
                    </span>
                  </div>
                  {p.notes && (
                    <p className="mt-1.5 text-muted-foreground">{p.notes}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </PreferencesCard>
      </div>

      <AccessProfileDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setEditingProfile(null);
        }}
        editing={editingProfile}
        onSubmit={upsertProfile}
      />
    </div>
  );
}

// --- subcomponents ---

interface PreferencesCardProps {
  title: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  actions?: React.ReactNode;
  status?: React.ReactNode;
}

function PreferencesCard({
  title,
  description,
  icon: Icon,
  children,
  actions,
  status,
}: PreferencesCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">{title}</CardTitle>
              {description && <CardDescription>{description}</CardDescription>}
            </div>
          </div>
          {status}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {children}
        {actions && <div className="flex flex-wrap gap-2 pt-2">{actions}</div>}
      </CardContent>
    </Card>
  );
}

// --- access profile dialog ---

interface AccessProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: ProviderAccessProfileRecord | null;
  onSubmit: (input: {
    provider: string;
    plan?: string | null;
    codingAgent?: CapabilityReadiness;
    externalUi?: CapabilityReadiness;
    nativeApi?: CapabilityReadiness;
    statusSource?: 'verified' | 'user_configured' | 'unknown';
    notes?: string | null;
  }) => void;
}

function AccessProfileDialog({
  open,
  onOpenChange,
  editing,
  onSubmit,
}: AccessProfileDialogProps) {
  const [provider, setProvider] = React.useState('');
  const [plan, setPlan] = React.useState('');
  const [codingAgent, setCodingAgent] = React.useState<CapabilityReadiness>('unverified');
  const [externalUi, setExternalUi] = React.useState<CapabilityReadiness>('unverified');
  const [nativeApi, setNativeApi] = React.useState<CapabilityReadiness>('unverified');
  const [statusSource, setStatusSource] = React.useState<
    'verified' | 'user_configured' | 'unknown'
  >('user_configured');
  const [notes, setNotes] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Re-sync form when opening / switching target.
  React.useEffect(() => {
    if (!open) return;
    setProvider(editing?.provider ?? '');
    setPlan(editing?.plan ?? '');
    setCodingAgent(editing?.codingAgent ?? 'unverified');
    setExternalUi(editing?.externalUi ?? 'unverified');
    setNativeApi(editing?.nativeApi ?? 'unverified');
    setStatusSource(editing?.statusSource ?? 'user_configured');
    setNotes(editing?.notes ?? '');
    setError(null);
  }, [open, editing]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider.trim()) {
      setError('Provider is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        provider: provider.trim(),
        plan: plan.trim() || null,
        codingAgent,
        externalUi,
        nativeApi,
        statusSource,
        notes: notes.trim() || null,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit provider access profile' : 'Add provider access profile'}
          </DialogTitle>
          <DialogDescription>
            Configure the subscription capability profile for a provider (§5).
            WorkflowOS does not scrape provider billing pages and never
            collects provider credentials.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ap-provider">Provider</Label>
            <Input
              id="ap-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="e.g. chatgpt"
              disabled={saving || !!editing}
            />
            {editing && (
              <p className="text-xs text-muted-foreground">
                Provider is the natural key — change the surface readings instead.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ap-plan">Plan (optional)</Label>
            <Input
              id="ap-plan"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              placeholder="e.g. pro, team, enterprise"
              disabled={saving}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="ap-coding">Coding agent</Label>
              <Select
                id="ap-coding"
                value={codingAgent}
                disabled={saving}
                onChange={(e) => setCodingAgent(e.target.value as CapabilityReadiness)}
              >
                {READINESS_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ap-external">External UI</Label>
              <Select
                id="ap-external"
                value={externalUi}
                disabled={saving}
                onChange={(e) => setExternalUi(e.target.value as CapabilityReadiness)}
              >
                {READINESS_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ap-native">Native API</Label>
              <Select
                id="ap-native"
                value={nativeApi}
                disabled={saving}
                onChange={(e) => setNativeApi(e.target.value as CapabilityReadiness)}
              >
                {READINESS_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ap-source">Status source</Label>
            <Select
              id="ap-source"
              value={statusSource}
              disabled={saving}
              onChange={(e) =>
                setStatusSource(
                  e.target.value as 'verified' | 'user_configured' | 'unknown',
                )
              }
            >
              {STATUS_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">unknown</span> defaults to blocked
              (§5 — do NOT auto-promote).
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ap-notes">Notes (optional)</Label>
            <Input
              id="ap-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="free-form metadata — NEVER credentials"
              disabled={saving}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add profile'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
