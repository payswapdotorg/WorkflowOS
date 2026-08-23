import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { useParams, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { architecture } from '@/api/client';
import { Plus } from 'lucide-react';
export default function WorkItemsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [versionId, setVersionId] = useState<string | null>(null);
  const [workItems, _setWorkItems] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      setLoading(true);
      try {
        const archs = await architecture.listForProject(projectId);
        if (archs.length > 0) {
          const vs = await architecture.listVersions(archs[0].id);
          const frozen = vs.find(v => v.state === 'frozen') ?? vs[0];
          if (frozen) setVersionId(frozen.id);
        }
      } catch (err) { setError((err as Error).message); }
      finally { setLoading(false); }
    })();
  }, [projectId]);
  if (loading) return <LoadingState label="Loading work items…" />;
  if (error) return <ErrorState message={error} />;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-semibold">Work Items</h1><p className="text-sm text-muted-foreground">Implementation lifecycle</p></div>
        {versionId && <CreateWorkItemForm versionId={versionId} onCreated={() => window.location.reload()} />}
      </div>
      {workItems.length === 0 ? (
        <Card><CardContent className="py-12"><EmptyState title="No work items yet" description="Create a work item to start the implementation lifecycle." /></CardContent></Card>
      ) : (
        <div className="space-y-3">
          {workItems.map((wi) => (
            <Link key={(wi as any).id} to={`/work-items/${(wi as any).id}`}>
              <Card className="cursor-pointer hover:shadow-md"><CardContent className="flex items-center justify-between py-4">
                <div><p className="font-medium">{(wi as any).workItemId}: {(wi as any).title}</p><p className="text-xs text-muted-foreground font-mono">{(wi as any).id.slice(0, 8)}</p></div>
              </CardContent></Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
function CreateWorkItemForm({ versionId, onCreated }: { versionId: string; onCreated: () => void }) {
  const [show, setShow] = useState(false);
  const [wiId, setWiId] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wiId.trim() || !title.trim()) return;
    setLoading(true);
    try {
      await fetch('/api/architecture-versions/' + versionId + '/work-items', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': localStorage.getItem('wfos_api_key') || '' },
        body: JSON.stringify({ workItemId: wiId.trim(), title: title.trim() }),
      });
      onCreated();
    } finally { setLoading(false); }
  };
  if (!show) return <Button onClick={() => setShow(true)}><Plus className="mr-1 h-4 w-4" />New Work Item</Button>;
  return (
    <Card><CardContent className="pt-6"><form onSubmit={submit} className="flex items-end gap-2">
      <div className="space-y-1"><Label htmlFor="wi-id">ID</Label><Input id="wi-id" value={wiId} onChange={(e) => setWiId(e.target.value)} placeholder="WORK-001" className="w-32" /></div>
      <div className="flex-1 space-y-1"><Label htmlFor="wi-title">Title</Label><Input id="wi-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Implement authentication" /></div>
      <Button type="submit" disabled={loading}>{loading ? '…' : 'Create'}</Button>
    </form></CardContent></Card>
  );
}
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
