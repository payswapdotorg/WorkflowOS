import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/domain/status-badge';
import { architecture, type Architecture, type ArchitectureVersion } from '@/api/client';
import { Snowflake, Plus, FileText, Lock, ArrowRight } from 'lucide-react';

function getApiKey(): string {
  return localStorage.getItem('wfos_api_key') || '';
}

export default function ArchitecturePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [archs, setArchs] = useState<Architecture[]>([]);
  const [versions, setVersions] = useState<Record<string, ArchitectureVersion[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showVersionForm, setShowVersionForm] = useState<string | null>(null);

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const list = await architecture.listForProject(projectId);
      setArchs(list);
      const vs: Record<string, ArchitectureVersion[]> = {};
      for (const a of list) {
        vs[a.id] = await architecture.listVersions(a.id);
      }
      setVersions(vs);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [projectId]);

  if (loading) return <LoadingState label="Loading architecture…" />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Architecture</h1>
          <p className="text-sm text-muted-foreground">Manage architecture versions and lifecycle</p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}><Plus className="mr-1 h-4 w-4" />New Architecture</Button>
      </div>

      {showCreate && (
        <CreateArchitectureForm
          projectId={projectId!}
          onCreated={() => { load(); setShowCreate(false); }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {archs.length === 0 ? (
        <Card><CardContent className="py-12"><EmptyState title="No architecture yet" description="Create your first architecture to start defining constraints." /></CardContent></Card>
      ) : (
        archs.map((arch) => (
          <Card key={arch.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                {arch.name}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(versions[arch.id] ?? []).length === 0 ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">No versions yet</p>
                  <Button size="sm" variant="outline" onClick={() => setShowVersionForm(arch.id)}>
                    <Plus className="mr-1 h-3.5 w-3.5" />Create Version
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {(versions[arch.id] ?? []).map((v) => (
                    <div key={v.id} className="rounded-md border p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <StatusBadge value={v.state} />
                          <span className="font-mono text-xs text-muted-foreground">{v.id.slice(0, 8)}</span>
                        </div>
                        {v.state === 'draft' && (
                          <Button size="sm" variant="outline" onClick={() => freezeVersion(v.id, load)}>
                            <Snowflake className="mr-1 h-3.5 w-3.5" />Freeze
                          </Button>
                        )}
                        {v.state === 'frozen' && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Lock className="h-3 w-3" /> Immutable
                          </div>
                        )}
                      </div>

                      {/* Architecture content display */}
                      {v.contentInline ? (
                        <div className={`rounded-md bg-muted p-3 ${v.state === 'frozen' ? 'opacity-75' : ''}`}>
                          <pre className="whitespace-pre-wrap text-sm font-mono">{v.contentInline}</pre>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">No content</p>
                      )}

                      {/* Continue to Requirements CTA — only when frozen */}
                      {v.state === 'frozen' && (
                        <div className="mt-3 flex justify-end">
                          <Button
                            size="sm"
                            onClick={() => navigate(`/projects/${projectId}/requirements`)}
                          >
                            Continue to Requirements
                            <ArrowRight className="ml-1 h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" onClick={() => setShowVersionForm(arch.id)}>
                    <Plus className="mr-1 h-3.5 w-3.5" />Add Version
                  </Button>
                </div>
              )}

              {showVersionForm === arch.id && (
                <CreateVersionForm
                  archId={arch.id}
                  onCreated={() => { load(); setShowVersionForm(null); }}
                  onCancel={() => setShowVersionForm(null)}
                />
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function CreateArchitectureForm({ projectId, onCreated, onCancel }: { projectId: string; onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/projects/' + projectId + '/architectures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': getApiKey() },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed: ${res.status}`);
      }
      onCreated();
      setName('');
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <Card className="mb-4">
      <CardContent className="pt-6">
        <form onSubmit={submit} className="flex items-end gap-2">
          <div className="flex-1 space-y-2">
            <Label htmlFor="arch-name">Architecture Name</Label>
            <Input id="arch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Modular Monolith Architecture" autoFocus />
          </div>
          <Button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create'}</Button>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

function CreateVersionForm({ archId, onCreated, onCancel }: { archId: string; onCreated: () => void; onCancel: () => void }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) {
      setError('Architecture content is required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/architectures/' + archId + '/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': getApiKey() },
        body: JSON.stringify({ contentInline: content.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed: ${res.status}`);
      }
      onCreated();
      setContent('');
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <Card className="mt-3">
      <CardHeader><CardTitle className="text-sm">Create Architecture Version</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="version-content">Architecture Content</Label>
            <textarea
              id="version-content"
              className="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={`# Architecture Constraints

## System Overview
Describe the system architecture...

## Module Boundaries
- /auth: owns identity and authorization
- /projects: owns project lifecycle
- /workflows: owns canonical workflow state

## Constraints
- PostgreSQL is the authoritative persistence layer
- Redis is non-authoritative (queue, locks, cache only)
- The frontend is a consumer — never an authority`}
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create Version'}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

async function freezeVersion(versionId: string, onDone: () => void) {
  await fetch('/api/architecture-versions/' + versionId + '/freeze', {
    method: 'POST',
    headers: { 'x-api-key': getApiKey() },
  });
  onDone();
}
