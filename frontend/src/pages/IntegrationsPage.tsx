import * as React from 'react';
import { useParams, Link } from 'react-router-dom';
import { Rocket, Sparkles, Bot, ExternalLink, Plus, Link2, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { StatusBadge } from '@/components/domain/status-badge';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  runtime,
  githubProvisioning,
  agentProviders,
  type ProjectRuntimeStatus,
  type RuntimeProviderStatus,
  type ProjectGitHubRepositoryLink,
  ApiError,
} from '@/api/client';

/**
 * WORK-026 (SUB-I): IntegrationsPage — surfaces the project's runtime /
 * provisioning state across four dimensions:
 *   - GitHub repository link (created vs linked)
 *   - Vercel integration + latest preview deployment
 *   - Architect (LLM) readiness
 *   - Implementation Agent provider readiness + per-project overrides
 *
 * The page ONLY calls WorkflowOS API endpoints. It never makes direct GitHub
 * or Vercel API calls — secrets stay inside the backend adapter boundary (the
 * static-architecture check `frontend has no direct GitHub/Vercel API from
 * frontend` enforces this).
 *
 * Backend authority:
 *   GET  /projects/:projectId/runtime                  → ProjectRuntimeStatus
 *   GET  /projects/:projectId/runtime/integrations     → list Vercel/fake integrations
 *   POST /projects/:projectId/runtime/integrations     → create integration
 *   DELETE /projects/:projectId/runtime/integrations/:id → remove
 *   GET  /projects/:projectId/runtime/deployments      → recent deployments
 *   GET  /projects/:projectId/github/repository       → GitHub repo link
 *   POST /projects/:projectId/github/repository       → create GitHub repo (adapter call)
 *   POST /projects/:projectId/github/link              → link existing repo
 *   POST /projects/:projectId/agents/providers         → create per-project provider config
 *
 * The page NEVER accepts secret values in any form — `secretRef` is the NAME
 * of the env var (SecretStore key), not the value.
 */

function StatusTone({ status }: { status: RuntimeProviderStatus }) {
  const tone =
    status === 'connected'
      ? 'success'
      : status === 'test-mode'
        ? 'info'
        : status === 'error'
          ? 'destructive'
          : 'warning';
  return <StatusBadge value={status} tone={tone} humanize />;
}

function ProviderList({
  providers,
  emptyLabel = 'No providers configured',
}: {
  providers: Array<{ name: string; provider: string; model: string; status: 'ready' | 'not-configured' }>;
  emptyLabel?: string;
}) {
  if (!providers || providers.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-1">
      {providers.map((p) => (
        <li key={`${p.provider}-${p.model}`} className="flex items-center justify-between gap-2 text-sm">
          <span className="font-mono text-xs">
            {p.provider}
            <span className="text-muted-foreground">/</span>
            {p.model}
          </span>
          <StatusBadge value={p.status} tone={p.status === 'ready' ? 'success' : 'warning'} />
        </li>
      ))}
    </ul>
  );
}

interface GitHubLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'link';
  projectId: string;
  onSubmitted: (link: ProjectGitHubRepositoryLink) => void;
}

function GitHubLinkDialog({ open, onOpenChange, mode, projectId, onSubmitted }: GitHubLinkDialogProps) {
  const { toast } = useToast();
  const [owner, setOwner] = React.useState('');
  const [repo, setRepo] = React.useState('');
  const [installationId, setInstallationId] = React.useState('');
  const [defaultBranch, setDefaultBranch] = React.useState('main');
  const [visibility, setVisibility] = React.useState<'public' | 'private'>('private');
  const [description, setDescription] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset form when dialog closes
  React.useEffect(() => {
    if (!open) {
      setOwner('');
      setRepo('');
      setInstallationId('');
      setDefaultBranch('main');
      setVisibility('private');
      setDescription('');
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!owner.trim() || !repo.trim() || !installationId.trim()) {
      setError('Owner, repository, and installationId are required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (mode === 'create') {
        const result = await githubProvisioning.createRepository(projectId, {
          owner: owner.trim(),
          repository: repo.trim(),
          visibility,
          description: description.trim() || undefined,
          defaultBranch: defaultBranch.trim() || undefined,
          installationId: installationId.trim(),
        });
        onSubmitted(result.repository);
        toast({ title: 'GitHub repository created', description: `${owner}/${repo}` });
      } else {
        const result = await githubProvisioning.linkRepository(projectId, {
          owner: owner.trim(),
          repository: repo.trim(),
          installationId: installationId.trim(),
          defaultBranch: defaultBranch.trim() || undefined,
        });
        onSubmitted(result.repository);
        toast({ title: 'Repository linked', description: `${owner}/${repo}` });
      }
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'Create GitHub repository' : 'Link existing repository'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'WorkflowOS will call the GitHub App to create the repository and link it to this project.'
              : 'Attach an existing GitHub repository to this project. No GitHub API call is made.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="gh-owner">Owner / Org</Label>
            <Input id="gh-owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="pectoraux" disabled={loading} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gh-repo">Repository</Label>
            <Input id="gh-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="my-project" disabled={loading} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gh-installation">GitHub App installation ID</Label>
            <Input id="gh-installation" value={installationId} onChange={(e) => setInstallationId(e.target.value)} placeholder="123456" disabled={loading} />
            <p className="text-xs text-muted-foreground">
              The installation must be linked to this project (POST /github/installations).
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="gh-branch">Default branch</Label>
              <Input id="gh-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="main" disabled={loading} />
            </div>
            {mode === 'create' && (
              <div className="space-y-1.5">
                <Label htmlFor="gh-visibility">Visibility</Label>
                <Select id="gh-visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'private')} disabled={loading}>
                  <option value="private">private</option>
                  <option value="public">public</option>
                </Select>
              </div>
            )}
          </div>
          {mode === 'create' && (
            <div className="space-y-1.5">
              <Label htmlFor="gh-desc">Description (optional)</Label>
              <Input id="gh-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short repository description" disabled={loading} />
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Working…' : mode === 'create' ? 'Create repository' : 'Link repository'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface VercelConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onSubmitted: () => void;
}

function VercelConnectDialog({ open, onOpenChange, projectId, onSubmitted }: VercelConnectDialogProps) {
  const { toast } = useToast();
  const [projectExternalId, setProjectExternalId] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setProjectExternalId('');
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectExternalId.trim()) {
      setError('Vercel project ID is required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await runtime.createIntegration(projectId, {
        provider: 'vercel',
        projectExternalId: projectExternalId.trim(),
      });
      toast({ title: 'Vercel integration connected', description: projectExternalId });
      onSubmitted();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Vercel project</DialogTitle>
          <DialogDescription>
            Record the Vercel project ID returned by your Vercel dashboard. WorkflowOS stores the link — it never stores your Vercel API token (that stays in the backend SecretStore).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="vercel-id">Vercel project external ID</Label>
            <Input id="vercel-id" value={projectExternalId} onChange={(e) => setProjectExternalId(e.target.value)} placeholder="prj_abc123" disabled={loading} />
            <p className="text-xs text-muted-foreground">
              No API key is requested. Backend credentials live in environment variables (configure on the server).
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface AgentProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onSubmitted: () => void;
}

function AgentProviderDialog({ open, onOpenChange, projectId, onSubmitted }: AgentProviderDialogProps) {
  const { toast } = useToast();
  const [provider, setProvider] = React.useState('openai');
  const [model, setModel] = React.useState('');
  const [secretRef, setSecretRef] = React.useState('');
  const [isDefault, setIsDefault] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setProvider('openai');
      setModel('');
      setSecretRef('');
      setIsDefault(false);
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider.trim() || !model.trim() || !secretRef.trim()) {
      setError('Provider, model, and secretRef (env var name) are required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await agentProviders.createForProject(projectId, {
        provider: provider.trim(),
        model: model.trim(),
        secretRef: secretRef.trim(),
        isDefault,
      });
      toast({
        title: 'Agent provider configured',
        description: `${provider}/${model} → ref ${secretRef}`,
      });
      onSubmitted();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add agent provider config</DialogTitle>
          <DialogDescription>
            Configure which (provider, model) the implementation agent should use for this project. The <span className="font-mono">secretRef</span> is the NAME of the env var that holds the API key — never the secret value itself.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ap-provider">Provider</Label>
            <Select id="ap-provider" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={loading}>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="gemini">gemini</option>
              <option value="fake">fake (test)</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ap-model">Model</Label>
            <Input id="ap-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o" disabled={loading} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ap-secret-ref">Secret ref (env var name)</Label>
            <Input id="ap-secret-ref" value={secretRef} onChange={(e) => setSecretRef(e.target.value)} placeholder="ENV_VAR_NAME" disabled={loading} />
            <p className="text-xs text-muted-foreground">
              Enter the NAME of the env var that already holds the API key. Never enter the key itself.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} disabled={loading} />
            Set as default provider for this project
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving…' : 'Save config'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface IntegrationsCardProps {
  title: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  status?: RuntimeProviderStatus;
  children: React.ReactNode;
  actions?: React.ReactNode;
}

function IntegrationsCard({ title, description, icon: Icon, status, children, actions }: IntegrationsCardProps) {
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
          {status && <StatusTone status={status} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {children}
        {actions && <div className="flex flex-wrap gap-2 pt-2">{actions}</div>}
      </CardContent>
    </Card>
  );
}

export default function IntegrationsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [status, setStatus] = React.useState<ProjectRuntimeStatus | null>(null);
  const [githubLink, setGithubLink] = React.useState<ProjectGitHubRepositoryLink | null>(null);
  const [integrations, setIntegrations] = React.useState<Array<{ id: string; provider: string; projectExternalId: string }>>([]);
  const [latest, setLatest] = React.useState<{ deployment: { id: string; previewUrl: string | null; commitSha: string | null; branch: string | null; status: string; createdAt?: string } | null } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [ghDialogMode, setGhDialogMode] = React.useState<'create' | 'link' | null>(null);
  const [vercelDialogOpen, setVercelDialogOpen] = React.useState(false);
  const [agentDialogOpen, setAgentDialogOpen] = React.useState(false);

  const loadAll = React.useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, gh, integrationsList, latestResp] = await Promise.all([
        runtime.getStatus(projectId).catch(() => null),
        githubProvisioning.getRepository(projectId).then((r) => r.repository).catch(() => null),
        runtime.listIntegrations(projectId).catch(() => []),
        runtime.getLatestDeployment(projectId).catch(() => null),
      ]);
      setStatus(s);
      setGithubLink(gh);
      setIntegrations(integrationsList.map((i) => ({ id: i.id, provider: i.provider, projectExternalId: i.projectExternalId })));
      setLatest(latestResp);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (loading) return <LoadingState label="Loading integrations…" />;
  if (error) return <ErrorState message={error} onRetry={loadAll} />;

  const githubStatus = status?.github.status;
  const vercelStatus = status?.vercel.status;
  const architectStatus = status?.architect.status;
  const agentStatus = status?.agent.status;

  const vercelIntegration = integrations.find((i) => i.provider === 'vercel');
  const latestDeployment = latest?.deployment ?? status?.vercel.latestDeployment ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect this project to GitHub, Vercel, the Architect LLM, and the Implementation Agent. Secrets live in the backend — the UI only shows readiness.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* GitHub */}
        <IntegrationsCard
          title="GitHub"
          description="Repository provisioning + PR boundary"
          icon={Rocket}
          status={githubStatus ?? undefined}
          actions={
            <>
              {!githubLink && (
                <>
                  <Button size="sm" variant="default" onClick={() => setGhDialogMode('create')}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Create repository
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setGhDialogMode('link')}>
                    <Link2 className="mr-1 h-3.5 w-3.5" />
                    Link existing
                  </Button>
                </>
              )}
              {githubLink && (
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                >
                  <a
                    href={`https://github.com/${githubLink.owner}/${githubLink.repository}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="mr-1 h-3.5 w-3.5" />
                    Open GitHub
                  </a>
                </Button>
              )}
            </>
          }
        >
          {githubLink ? (
            <div className="space-y-1 text-sm">
              <div className="font-mono text-xs text-muted-foreground">
                {githubLink.owner}/{githubLink.repository}
              </div>
              <div className="text-xs text-muted-foreground">
                Default branch: <span className="font-mono">{githubLink.defaultBranch}</span> · link type:{' '}
                <span className="font-mono">{githubLink.linkType}</span>
              </div>
              {githubLink.installationId && (
                <div className="text-xs text-muted-foreground">
                  Installation: <span className="font-mono">{githubLink.installationId}</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No GitHub repository linked to this project yet.</p>
          )}
        </IntegrationsCard>

        {/* Vercel */}
        <IntegrationsCard
          title="Vercel"
          description="Preview deployment provider"
          icon={Rocket}
          status={vercelStatus ?? undefined}
          actions={
            !vercelIntegration ? (
              <Button size="sm" variant="default" onClick={() => setVercelDialogOpen(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Connect Vercel
              </Button>
            ) : null
          }
        >
          {vercelIntegration ? (
            <div className="space-y-1 text-sm">
              <div className="text-xs text-muted-foreground">
                Project external ID: <span className="font-mono">{vercelIntegration.projectExternalId}</span>
              </div>
              {latestDeployment ? (
                <div className="rounded-md border border-border bg-muted/30 p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">Latest deployment</span>
                    <StatusBadge value={latestDeployment.status} />
                  </div>
                  {latestDeployment.previewUrl && (
                    <a
                      href={latestDeployment.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Open preview
                    </a>
                  )}
                  {latestDeployment.commitSha && (
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      commit: {latestDeployment.commitSha.slice(0, 12)}
                      {latestDeployment.branch && ` · branch: ${latestDeployment.branch}`}
                    </div>
                  )}
                  {latestDeployment.createdAt && (
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(latestDeployment.createdAt).toLocaleString()}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No deployments recorded yet.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No Vercel project connected.</p>
          )}
        </IntegrationsCard>

        {/* Architect */}
        <IntegrationsCard
          title="Architect"
          description="LLM that drives the conversational architect"
          icon={Sparkles}
          status={architectStatus ?? undefined}
        >
          <ProviderList providers={status?.architect.providers ?? []} />
          <p className="text-xs text-muted-foreground">
            Provider readiness is resolved from env vars (configured by the operator). See <Link to="/settings/providers" className="underline">Provider settings</Link>.
          </p>
        </IntegrationsCard>

        {/* Agent */}
        <IntegrationsCard
          title="Implementation Agent"
          description="Provider registry for autonomous implementation"
          icon={Bot}
          status={agentStatus ?? undefined}
          actions={
            <Button size="sm" variant="default" onClick={() => setAgentDialogOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add provider config
            </Button>
          }
        >
          <ProviderList providers={status?.agent.providers ?? []} />
          {vercelIntegration && (
            <div className="mt-2 border-t border-border pt-2">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Active integrations
              </div>
              <ul className="space-y-1 text-xs">
                {integrations.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2">
                    <span className="font-mono">
                      {i.provider} → {i.projectExternalId}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10"
                      onClick={async () => {
                        try {
                          await runtime.removeIntegration(projectId!, i.id);
                          await loadAll();
                        } catch {
                          /* swallowed — toast handled by retry */
                        }
                      }}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </IntegrationsCard>
      </div>

      {ghDialogMode && (
        <GitHubLinkDialog
          open={!!ghDialogMode}
          onOpenChange={(o) => !o && setGhDialogMode(null)}
          mode={ghDialogMode}
          projectId={projectId!}
          onSubmitted={(link) => {
            setGithubLink(link);
          }}
        />
      )}
      <VercelConnectDialog
        open={vercelDialogOpen}
        onOpenChange={setVercelDialogOpen}
        projectId={projectId!}
        onSubmitted={loadAll}
      />
      <AgentProviderDialog
        open={agentDialogOpen}
        onOpenChange={setAgentDialogOpen}
        projectId={projectId!}
        onSubmitted={loadAll}
      />
    </div>
  );
}
