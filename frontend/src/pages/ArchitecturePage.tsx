import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/domain/status-badge';
import { architecture, type Architecture, type ArchitectureVersion } from '@/api/client';
import { Snowflake, Plus, FileText } from 'lucide-react';
export default function ArchitecturePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [archs, setArchs] = useState<Architecture[]>([]);
  const [versions, setVersions] = useState<Record<string, ArchitectureVersion[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
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
      {showCreate && <CreateArchitectureForm projectId={projectId!} onCreated={load} onCancel={() => setShowCreate(false)} />}
      {archs.length === 0 ? (
        <Card><CardContent className="py-12"><EmptyState title="No architecture yet" description="Create your first architecture to start defining constraints." /></CardContent></Card>
      ) : (
        archs.map((arch) => (
          <Card key={arch.id}>
            <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4 text-muted-foreground" />{arch.name}</CardTitle></CardHeader>
            <CardContent>
              {(versions[arch.id] ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No versions</p>
              ) : (
                <div className="space-y-2">
                  {(versions[arch.id] ?? []).map((v) => (
                    <div key={v.id} className="flex items-center justify-between rounded-md border p-3">
                      <div className="flex items-center gap-3">
                        <StatusBadge value={v.state} />
                        <span className="font-mono text-xs text-muted-foreground">{v.id.slice(0, 8)}</span>
                      </div>
                      {v.state === 'draft' && (
                        <Button size="sm" variant="outline" onClick={() => freezeVersion(v.id, load)}>
                          <Snowflake className="mr-1 h-3.5 w-3.5" />Freeze
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <Button size="sm" variant="ghost" className="mt-3" onClick={() => createVersion(arch.id, load)}>+ Add Version</Button>
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
    try {
      await fetch('/api/projects/' + projectId + '/architectures', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': localStorage.getItem('wfos_api_key') || '' },
        body: JSON.stringify({ name: name.trim() }),
      });
      onCreated(); setName('');
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  };
  return (
    <Card className="mb-4"><CardContent className="pt-6"><form onSubmit={submit} className="flex items-end gap-2">
      <div className="flex-1 space-y-2"><Label htmlFor="arch-name">Architecture Name</Label>
      <Input id="arch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monolith Architecture" /></div>
      <Button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create'}</Button>
      <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form></CardContent></Card>
  );
}
async function freezeVersion(versionId: string, onDone: () => void) {
  await fetch('/api/architecture-versions/' + versionId + '/freeze', {
    method: 'POST', headers: { 'x-api-key': localStorage.getItem('wfos_api_key') || '' },
  });
  onDone();
}
async function createVersion(archId: string, onDone: () => void) {
  await fetch('/api/architectures/' + archId + '/versions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': localStorage.getItem('wfos_api_key') || '' },
    body: JSON.stringify({ contentInline: 'Architecture constraints' }),
  });
  onDone();
}
