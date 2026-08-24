import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, ArrowRight, FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { StatusBadge } from '@/components/domain/status-badge';
import { PageHeader } from '@/components/domain/page-header';
import {
  benchmarks,
  projects,
  type BenchmarkExperiment,
  type Project,
  ApiError,
} from '@/api/client';

/**
 * WORK-032: BenchmarkListPage — the top-level list of execution benchmark
 * experiments. Mirrors the ProjectListPage pattern: a card grid of
 * experiments, each clickable to its detail page, with a "New Benchmark"
 * button to enter the creation flow.
 *
 * The frontend never derives experiment state — it only renders backend
 * values (status, promptDigest, snapshot id, trial count, dates). The
 * project selector is required because experiments are project-scoped
 * (the backend's requireProjectAuthorization enforces this).
 *
 * If `?projectId=...` is present in the URL, that project is used. Otherwise
 * the user picks a project from the dropdown (populated from projects.listForUser).
 */
export default function BenchmarkListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProjectId = searchParams.get('projectId') ?? '';

  const [projectList, setProjectList] = useState<Project[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectId, setProjectId] = useState(initialProjectId);

  const [experiments, setExperiments] = useState<BenchmarkExperiment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the user's projects (for the project selector).
  useEffect(() => {
    let cancelled = false;
    setProjectLoading(true);
    projects
      .listForUser()
      .then((list) => {
        if (cancelled) return;
        setProjectList(list);
        // If no project is preselected via URL and the user has at least one,
        // default to the first so the experiment list isn't empty.
        if (!projectId && list.length > 0) {
          setProjectId(list[0]!.id);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load projects');
      })
      .finally(() => {
        if (!cancelled) setProjectLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load experiments for the selected project.
  const load = useCallback(async () => {
    if (!projectId) {
      setExperiments([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await benchmarks.list(projectId, { limit: 50, offset: 0 });
      setExperiments(result.experiments ?? []);
      setTotal(result.total ?? 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load benchmarks');
      setExperiments([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const onSelectProject = (id: string) => {
    setProjectId(id);
    setSearchParams(id ? { projectId: id } : {}, { replace: true });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Execution Benchmarks"
        description="Measure native API execution vs external Companion execution against the same task snapshot."
        actions={
          <Button onClick={() => navigate('/benchmarks/new')}>
            <Plus className="mr-1 h-4 w-4" />
            New Benchmark
          </Button>
        }
      />

      {/* Project selector — required because experiments are project-scoped. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Project</CardTitle>
        </CardHeader>
        <CardContent>
          {projectLoading ? (
            <LoadingState label="Loading projects…" />
          ) : projectList.length === 0 ? (
            <EmptyState
              title="No projects available"
              description="Create a project first — benchmarks are scoped to a project."
            />
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 space-y-1.5">
                <label
                  htmlFor="benchmark-project-select"
                  className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Project
                </label>
                <select
                  id="benchmark-project-select"
                  value={projectId}
                  onChange={(e) => onSelectProject(e.target.value)}
                  className="flex h-9 w-full max-w-md appearance-none rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {projectList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id.slice(0, 8)})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Experiment list */}
      {loading ? (
        <LoadingState label="Loading benchmarks…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : experiments.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <EmptyState
              icon={FlaskConical}
              title="No benchmark experiments yet"
              description="Start a new benchmark to compare native vs external execution on a frozen task snapshot."
              action={
                <Button onClick={() => navigate('/benchmarks/new')}>
                  <Plus className="mr-1 h-4 w-4" />
                  New Benchmark
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {experiments.map((exp) => (
            <Card
              key={exp.id}
              className="cursor-pointer hover:shadow-md"
              onClick={() => navigate(`/benchmarks/${exp.id}`)}
            >
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="truncate">{exp.name}</span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <StatusBadge value={exp.status} />
                  <span className="font-mono text-xs text-muted-foreground">
                    {exp.id.slice(0, 8)}
                  </span>
                </div>
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  <p>
                    Snapshot: <span className="font-mono">{exp.benchmarkTaskSnapshotId.slice(0, 12)}…</span>
                  </p>
                  <p>
                    Repetitions: <span className="font-mono">{exp.repetitions}</span>
                  </p>
                  <p>
                    Created: {exp.createdAt ? new Date(exp.createdAt).toLocaleString() : '—'}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {total > experiments.length && (
        <p className="text-xs text-muted-foreground">
          Showing {experiments.length} of {total} experiments.
        </p>
      )}
    </div>
  );
}
