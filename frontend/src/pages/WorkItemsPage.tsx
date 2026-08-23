import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { architecture, workItems, type WorkItem, ApiError } from '@/api/client';
import { Plus, ArrowRight } from 'lucide-react';

export default function WorkItemsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [versionId, setVersionId] = useState<string | null>(null);
  const [workItemList, setWorkItemList] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const archs = await architecture.listForProject(projectId);
      if (archs.length === 0) {
        setVersionId(null);
        setWorkItemList([]);
        return;
      }
      const vs = await architecture.listVersions(archs[0].id);
      const frozen = vs.find(v => v.state === 'frozen') ?? vs[0];
      if (!frozen) {
        setVersionId(null);
        setWorkItemList([]);
        return;
      }
      setVersionId(frozen.id);
      // Actually fetch work items from the backend
      const items = await workItems.listForVersion(frozen.id);
      setWorkItemList(items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load work items');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingState label="Loading work items…" />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Work Items</h1>
          <p className="text-sm text-muted-foreground">Implementation lifecycle</p>
        </div>
        {versionId && (
          <CreateWorkItemForm
            versionId={versionId}
            onCreated={(wi) => {
              // Navigate directly to the created work item — don't just reload the list
              navigate(`/work-items/${wi.id}`);
            }}
          />
        )}
      </div>

      {!versionId ? (
        <Card>
          <CardContent className="py-12">
            <EmptyState
              title="No frozen architecture"
              description="Freeze an architecture version before creating work items."
            />
          </CardContent>
        </Card>
      ) : workItemList.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <EmptyState
              title="No work items yet"
              description="Create a work item to start the implementation lifecycle."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {workItemList.map((wi) => (
            <Card
              key={wi.id}
              className="cursor-pointer hover:shadow-md"
              onClick={() => navigate(`/work-items/${wi.id}`)}
            >
              <CardContent className="flex items-center justify-between py-4">
                <div>
                  <p className="font-medium">{wi.workItemId}: {wi.title}</p>
                  {wi.objective && <p className="text-sm text-muted-foreground">{wi.objective}</p>}
                  <p className="text-xs text-muted-foreground font-mono mt-1">{wi.id.slice(0, 8)}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateWorkItemForm({
  versionId,
  onCreated,
}: {
  versionId: string;
  onCreated: (wi: WorkItem) => void;
}) {
  const [show, setShow] = useState(false);
  const [wiId, setWiId] = useState('');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wiId.trim() || !title.trim()) {
      setError('Work Item ID and Title are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Use the typed API client — not raw fetch. The client handles
      // auth, error parsing, and response unwrapping.
      const created = await workItems.create(versionId, {
        workItemId: wiId.trim(),
        title: title.trim(),
        objective: objective.trim() || undefined,
      });
      // Success — navigate to the created work item.
      // Do NOT call onCreated() on failure.
      onCreated(created);
    } catch (err) {
      // Preserve form values. Show the actual backend error.
      // Do NOT clear the form or reload the list.
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!show) {
    return (
      <Button onClick={() => setShow(true)}>
        <Plus className="mr-1 h-4 w-4" />New Work Item
      </Button>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="wi-id">ID</Label>
              <Input
                id="wi-id"
                value={wiId}
                onChange={(e) => setWiId(e.target.value)}
                placeholder="WORK-001"
                className="w-32"
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="wi-title">Title</Label>
              <Input
                id="wi-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Implement authentication"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="wi-objective">Objective (optional)</Label>
            <Input
              id="wi-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Describe the implementation objective"
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" data-testid="create-wi-error">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={loading}>
              {loading ? 'Creating…' : 'Create'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShow(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
