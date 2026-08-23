import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { useParams, } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/domain/status-badge';
import { projects, architecture, type Project, type Architecture, type ArchitectureVersion } from '@/api/client';
import { ArrowRight, GitBranch, Boxes, ListChecks } from 'lucide-react';
export default function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [archs, setArchs] = useState<Architecture[]>([]);
  const [versions, setVersions] = useState<ArchitectureVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    Promise.all([
      projects.get(projectId),
      architecture.listForProject(projectId),
    ]).then(async ([proj, archs]) => {
      setProject(proj);
      setArchs(archs);
      if (archs.length > 0) {
        const vs = await architecture.listVersions(archs[0]?.id ?? '');
        setVersions(vs);
      }
    }).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, [projectId]);
  if (loading) return <LoadingState label="Loading project…" />;
  if (error) return <ErrorState message={error} />;
  if (!project) return <EmptyState title="Project not found" />;
  const frozenVersion = versions.find(v => v.state === 'frozen') ?? versions[0];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
          <StatusBadge value={project.state} />
          <span className="font-mono text-xs">{project.id}</span>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="cursor-pointer hover:shadow-md" onClick={() => window.location.href = `/projects/${projectId}/architecture`}>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Boxes className="h-4 w-4" />Architecture</CardTitle></CardHeader>
          <CardContent>
            {archs.length === 0 ? <p className="text-sm text-muted-foreground">No architecture yet</p> : (
              <div>
                <p className="text-sm font-medium">{archs[0]?.name ?? "Untitled"}</p>
                {frozenVersion ? <StatusBadge value={frozenVersion.state} className="mt-2" /> : null}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md" onClick={() => window.location.href = `/projects/${projectId}/requirements`}>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-4 w-4" />Requirements</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">Manage requirements and criteria</p></CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md" onClick={() => window.location.href = `/projects/${projectId}/work-items`}>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><GitBranch className="h-4 w-4" />Work Items</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Implementation lifecycle</p>
            <Button variant="link" size="sm" className="mt-2 p-0">
              View <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
