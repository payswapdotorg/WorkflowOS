import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { auth } from '@/api/client';
import { EmptyState } from '@/components/domain/empty-state';

export default function ProjectListPage() {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The backend doesn't have a "list projects for user" endpoint.
    // For the product, we show a create flow + a simple input to open a project by ID.
    setLoading(false);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between border-b px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="text-xs font-bold">W</span>
          </div>
          <span className="font-semibold">WorkflowOS</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => auth.clearApiKey()}>
          Sign Out
        </Button>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <p className="text-sm text-muted-foreground">Manage your WorkflowOS projects</p>
          </div>
          <Button onClick={() => setShowCreate(!showCreate)}>
            <Plus className="mr-1 h-4 w-4" />
            New Project
          </Button>
        </div>

        {showCreate && <CreateProjectForm onCreated={(id) => navigate(`/projects/${id}`)} onCancel={() => setShowCreate(false)} />}

        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                title="No projects yet"
                description="Create your first project or enter a project ID below to access an existing one."
              />
            </CardContent>
          </Card>
        )}

        {/* Open by ID */}
        <div className="mt-8 border-t pt-6">
          <OpenProjectById onOpen={(id) => navigate(`/projects/${id}`)} />
        </div>
      </main>
    </div>
  );
}

function CreateProjectForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !orgId.trim()) {
      setError('Project name and organization ID are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/organizations/' + orgId.trim() + '/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': localStorage.getItem('wfos_api_key') || '' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error(`Failed to create project: ${res.status}`);
      const project = await res.json() as { id: string };
      onCreated(project.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Create Project</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org-id">Organization ID</Label>
            <Input id="org-id" value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="UUID" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-name">Project Name</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Project" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create'}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function OpenProjectById({ onOpen }: { onOpen: (id: string) => void }) {
  const [id, setId] = useState('');
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1 space-y-2">
        <Label htmlFor="project-id-input">Open by Project ID</Label>
        <Input
          id="project-id-input"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="Enter project UUID"
          onKeyDown={(e) => { if (e.key === 'Enter' && id.trim()) onOpen(id.trim()); }}
        />
      </div>
      <Button onClick={() => id.trim() && onOpen(id.trim())}>Open</Button>
    </div>
  );
}
