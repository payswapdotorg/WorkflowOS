import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { auth, projects, organizations, type Project } from '@/api/client';

export default function ProjectListPage() {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [projectList, setProjectList] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await projects.listForUser();
      setProjectList(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between border-b px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="text-xs font-bold">W</span>
          </div>
          <span className="font-semibold">WorkflowOS</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void auth.logout()}>
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

        {showCreate && (
          <CreateProjectForm
            onCreated={(id) => navigate(`/projects/${id}`)}
            onCancel={() => setShowCreate(false)}
          />
        )}

        {loading ? (
          <LoadingState label="Loading projects…" />
        ) : error ? (
          <ErrorState message={error} />
        ) : projectList.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                title="No projects yet"
                description="Create your first project or enter a project ID below to access an existing one."
                action={<Button onClick={() => setShowCreate(true)}><Plus className="mr-1 h-4 w-4" />Create Project</Button>}
              />
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projectList.map((p) => (
              <Card
                key={p.id}
                className="cursor-pointer hover:shadow-md"
                onClick={() => navigate(`/projects/${p.id}`)}
              >
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>{p.name}</span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground font-mono">{p.id.slice(0, 8)}</p>
                  {p.state && <p className="mt-1 text-xs text-muted-foreground capitalize">{p.state}</p>}
                </CardContent>
              </Card>
            ))}
          </div>
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
  const [orgList, setOrgList] = useState<{ id: string; name: string }[]>([]);
  const [selectedOrg, setSelectedOrg] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    organizations.listForUser()
      .then((orgs) => {
        setOrgList(orgs);
        if (orgs.length > 0) setSelectedOrg(orgs[0].id);
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !selectedOrg) {
      setError('Project name and organization are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const project = await projects.create(selectedOrg, { name: name.trim() });
      onCreated(project.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader><CardTitle>Create Project</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {orgList.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="org-select">Organization</Label>
              <select
                id="org-select"
                value={selectedOrg}
                onChange={(e) => setSelectedOrg(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              >
                {orgList.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No organizations available. Enter an org ID manually.</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="project-name">Project Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
            />
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
