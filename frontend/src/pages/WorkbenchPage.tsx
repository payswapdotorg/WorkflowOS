/**
 * WORK-048 — the Developer Workbench: the primary human-facing engineering
 * workspace.
 *
 * ARCHITECTURE (non-negotiable): this page is a CONSUMER of backend
 * authorities. Every rendered value comes from a backend API response —
 * the work graph (nodes + edges + unsatisfied dependencies + workflow
 * states from the WORK-048 read model), the rollups (executions, changes,
 * verification runs, reviews), the runtime/deployment authority, the
 * maintenance/planning authorities, and the audit activity feed. This page:
 *
 *   - performs ZERO mutations (no POST/PATCH calls — read-only surface);
 *   - owns NO workflow/authorization/execution/verification/review state;
 *   - renders missing data as explicitly unavailable (never invented);
 *   - renders failed requests as errors (never fabricated success);
 *   - re-derives everything from fresh responses on every refresh (stale UI
 *     state can never override server truth).
 *
 * READ-STATE MODEL (the architect's PR #76 review correction): every
 * authoritative read settles into an explicit ReadState — loading / success /
 * error (see lib/read-state.ts). A FAILED read can NEVER become an empty
 * result: an execution/changes/verification/review/deployment/activity
 * failure renders "… unavailable", never "No …"; a failed
 * getNextWorkItem() renders "Next work item unavailable", never "No eligible
 * next work item". success([]) (the authority genuinely answered "none") and
 * error (the authority could not be reached) are always distinguishable.
 *
 * HEALTH TAB (WORK-049 — the Project Health & Maintenance UX): the Health
 * tab is a read-model presentation over the SAME authoritative responses
 * this page already loads (the maintenance authority's signals, the
 * verification runs, the work graph, the executions, the runtime status,
 * the deployments). The derivation is the PURE helper in lib/health.ts
 * (facts in → findings out; severity is ALWAYS the authority's own value,
 * never computed); a failed contributing read withholds the all-healthy
 * conclusion ("Health assessment incomplete — …"); open maintenance
 * findings and COMPLETED maintenance work are always distinguishable; the
 * tab performs ZERO mutations (health recommendations cannot mutate state).
 */
import * as React from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  RefreshCw,
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowRight,
  CircleCheckBig,
  Cpu,
  GitPullRequest,
  HeartPulse,
  Layers,
  ListChecks,
  Rocket,
  ShieldCheck,
  Stethoscope,
  Users,
} from 'lucide-react';
import {
  audit,
  architecture,
  maintenance,
  planning,
  projects as projectsApi,
  runtime as runtimeApi,
  workflow as workflowApi,
  workbench as workbenchApi,
  type AuditEvent,
  type Deployment,
  type ExecutionSummary,
  type MaintenanceHealth,
  type PlanningRecommendationItem,
  type PrAssociation,
  type Project,
  type ProjectRuntimeStatus,
  type Review,
  type VerificationRun,
  type WorkGraph,
  type WorkGraphNode,
} from '@/api/client';
import { PageHeader } from '@/components/domain/page-header';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { StatusBadge } from '@/components/domain/status-badge';
import { AuditEventItem } from '@/components/domain/audit-event-item';
import { WorkGraphBoard } from '@/components/workbench/work-graph-board';
import { countByState, deriveAttention } from '@/lib/work-graph';
import { deriveHealthFindings, splitMaintenanceWork } from '@/lib/health';
import { formatRelative, shortId, titleCase } from '@/lib/format';
import { readLoading, settleRead, type ReadState } from '@/lib/read-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

const TABS = [
  { value: 'overview', label: 'Overview', icon: Layers },
  { value: 'graph', label: 'Work Graph', icon: ListChecks },
  { value: 'work', label: 'Work', icon: Layers },
  { value: 'executions', label: 'Executions', icon: Cpu },
  { value: 'changes', label: 'Changes', icon: GitPullRequest },
  { value: 'verification', label: 'Verification', icon: ShieldCheck },
  { value: 'reviews', label: 'Reviews', icon: Users },
  { value: 'deployments', label: 'Deployments', icon: Rocket },
  { value: 'health', label: 'Health', icon: HeartPulse },
  { value: 'activity', label: 'Activity', icon: ActivityIcon },
] as const;

type TabValue = (typeof TABS)[number]['value'];

/** A one-line rollup row (icon + content), linked to the authoritative page. */
function RowCard({
  to,
  title,
  meta,
  badge,
}: {
  to?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  const inner = (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
        {meta && <div className="truncate text-xs text-muted-foreground">{meta}</div>}
      </div>
      {badge}
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}

function HealthChip({ label, status }: { label: string; status?: string }) {
  const tone =
    status === 'connected' || status === 'ready'
      ? 'success'
      : status === 'error'
        ? 'destructive'
        : 'secondary';
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {status !== undefined ? (
        <Badge variant={tone as 'success' | 'destructive' | 'secondary'}>{titleCase(status)}</Badge>
      ) : (
        <span className="text-xs text-muted-foreground">Unknown</span>
      )}
    </div>
  );
}

/** The explicit unavailable line for an inline (non-tab) failed read. */
function UnavailableLine({
  children,
  testid,
}: {
  children: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="text-sm text-destructive" data-testid={testid}>
      {children}
    </div>
  );
}

export default function WorkbenchPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as TabValue | null;
  const tab: TabValue = tabParam && TABS.some((t) => t.value === tabParam) ? tabParam : 'overview';

  const [loading, setLoading] = React.useState(true);
  const [refreshingAt, setRefreshingAt] = React.useState<number | null>(null);

  // Authoritative reads (never mutated here). Each read is an explicit
  // ReadState: loading / success(data) / error. A failure can never become
  // data — it renders as an explicit "… unavailable" error.
  const [projectRead, setProjectRead] = React.useState<ReadState<Project>>(readLoading);
  const [graphRead, setGraphRead] = React.useState<ReadState<WorkGraph>>(readLoading);
  const [runtimeRead, setRuntimeRead] = React.useState<ReadState<ProjectRuntimeStatus>>(readLoading);
  const [executionsRead, setExecutionsRead] = React.useState<ReadState<ExecutionSummary[]>>(readLoading);
  const [changesRead, setChangesRead] = React.useState<ReadState<PrAssociation[]>>(readLoading);
  const [verificationRead, setVerificationRead] = React.useState<ReadState<VerificationRun[]>>(readLoading);
  const [reviewsRead, setReviewsRead] = React.useState<ReadState<Review[]>>(readLoading);
  const [deploymentsRead, setDeploymentsRead] = React.useState<ReadState<Deployment[]>>(readLoading);
  const [activityRead, setActivityRead] = React.useState<ReadState<AuditEvent[]>>(readLoading);
  // The workflow authority's own next-item selection (null = it answered
  // "none eligible"; error = it could NOT answer — these never conflate).
  const [nextWorkItemRead, setNextWorkItemRead] = React.useState<ReadState<string | null>>(readLoading);
  // success(null) = the project genuinely has no architecture version to
  // inspect (a legitimate absence — NOT an error, and NOT "no records").
  const [planningRead, setPlanningRead] = React.useState<ReadState<PlanningRecommendationItem[] | null>>(readLoading);
  const [maintenanceRead, setMaintenanceRead] = React.useState<ReadState<MaintenanceHealth | null>>(readLoading);

  const loadAll = React.useCallback(() => {
    if (!projectId) return;
    setLoading(true);

    // Every authoritative read settles through settleRead: rejections become
    // { status: 'error' } — there is NO .catch(() => null) / .catch(() => [])
    // degradation anywhere on this page (the PR #76 review correction).

    // The version walk (the WorkItemsPage convention: first architecture →
    // frozen version, falling back to the first) feeds the maintenance +
    // planning reads, which are version-scoped by their authorities.
    const versionWalk = architecture
      .listForProject(projectId)
      .then(async (archs) => {
        if (archs.length === 0) return null;
        const versions = await architecture.listVersions(archs[0]!.id);
        const frozen = versions.find((v) => v.state === 'frozen') ?? versions[0];
        return frozen ?? null;
      });

    Promise.all([
      settleRead(projectsApi.get(projectId)),
      settleRead(workbenchApi.getWorkGraph(projectId)),
      settleRead(runtimeApi.getStatus(projectId)),
      settleRead(workbenchApi.listExecutions(projectId, 50)),
      settleRead(workbenchApi.listPrAssociations(projectId, 50)),
      settleRead(workbenchApi.listVerificationRuns(projectId, 50)),
      settleRead(workbenchApi.listReviews(projectId, 50)),
      settleRead(runtimeApi.listDeployments(projectId)),
      settleRead(audit.listForProject(projectId, { limit: 25 })),
    ]).then(
      ([
        project,
        graph,
        runtime,
        executions,
        changes,
        verification,
        reviews,
        deployments,
        activity,
      ]) => {
        setProjectRead(project);
        setGraphRead(graph);
        setRuntimeRead(runtime);
        setExecutionsRead(executions);
        setChangesRead(changes);
        setVerificationRead(verification);
        setReviewsRead(reviews);
        setDeploymentsRead(deployments);
        setActivityRead(activity);
        setRefreshingAt(Date.now());
      },
    );

    // The next work item (the workflow authority's own selection). A FAILED
    // query is an error — it must never render as "there is no next item".
    settleRead(workflowApi.getNextWorkItem(projectId)).then((read) => {
      setNextWorkItemRead(
        read.status === 'success'
          ? { status: 'success', data: read.data.nextWorkItemId }
          : read,
      );
    });

    // Planning + maintenance (version-scoped authorities). The walk's own
    // outcome is preserved: an error is an error (both surfaces report the
    // architecture authority as unreachable), and a successful walk with NO
    // version is a legitimate absence (success(null)), never an error.
    settleRead(versionWalk).then((versionRead) => {
      if (versionRead.status === 'error') {
        setMaintenanceRead({
          status: 'error',
          message: `Maintenance health unavailable — the architecture authority could not be reached (${versionRead.message}).`,
        });
        setPlanningRead({
          status: 'error',
          message: `Planner recommendations unavailable — the architecture authority could not be reached (${versionRead.message}).`,
        });
        return;
      }
      if (versionRead.status === 'loading') return; // cannot occur (settleRead settles)
      const version = versionRead.data;
      if (!version) {
        setMaintenanceRead({ status: 'success', data: null });
        setPlanningRead({ status: 'success', data: null });
        return;
      }
      settleRead(maintenance.getHealth(projectId, version.id)).then((healthRead) => {
        setMaintenanceRead(
          healthRead.status === 'error'
            ? {
                status: 'error',
                message: `Maintenance health unavailable — the maintenance authority could not be reached (${healthRead.message}).`,
              }
            : healthRead, // success (or the impossible loading) — passed through
        );
      });
      settleRead(planning.listRecommendations(projectId, version.id)).then((recsRead) => {
        setPlanningRead(
          recsRead.status === 'error'
            ? {
                status: 'error',
                message: `Planner recommendations unavailable — the planner authority could not be reached (${recsRead.message}).`,
              }
            : recsRead.status === 'success'
              ? {
                  status: 'success',
                  data: recsRead.data.filter((r) => !r.completed).slice(0, 5),
                }
              : recsRead, // 'loading' cannot occur (settleRead settles) — passed through
        );
      });
    });
  }, [projectId]);

  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Success-unwrapped views (a failed/pending read yields null/[] here ONLY
  // where the corresponding error/missing state is rendered separately).
  const project = projectRead.status === 'success' ? projectRead.data : null;
  const graph = graphRead.status === 'success' ? graphRead.data : null;
  const graphUnavailable =
    graphRead.status === 'error'
      ? `The work graph is unavailable for this project (${graphRead.message}).`
      : null;

  const nodeById = React.useMemo(() => {
    const m = new Map<string, WorkGraphNode>();
    if (graph) for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  // "What needs attention" is derived ONLY from reads that SUCCEEDED. When
  // any contributing read failed, the empty conclusion is withheld — an
  // incomplete assessment is reported instead ("I don't know" must not
  // become "nothing needs attention").
  const attention = React.useMemo(
    () =>
      deriveAttention({
        graph,
        executions: executionsRead.status === 'success' ? executionsRead.data : [],
        verificationRuns: verificationRead.status === 'success' ? verificationRead.data : [],
        reviews: reviewsRead.status === 'success' ? reviewsRead.data : [],
        maintenanceHealth: maintenanceRead.status === 'success' ? maintenanceRead.data : null,
      }),
    [graph, executionsRead, verificationRead, reviewsRead, maintenanceRead],
  );
  const attentionSurfaces: Array<{ name: string; failed: boolean; pending: boolean }> = [
    { name: 'work graph', failed: graphRead.status === 'error', pending: graphRead.status === 'loading' },
    { name: 'executions', failed: executionsRead.status === 'error', pending: executionsRead.status === 'loading' },
    { name: 'verification', failed: verificationRead.status === 'error', pending: verificationRead.status === 'loading' },
    { name: 'reviews', failed: reviewsRead.status === 'error', pending: reviewsRead.status === 'loading' },
    { name: 'maintenance', failed: maintenanceRead.status === 'error', pending: maintenanceRead.status === 'loading' },
  ];
  const attentionFailed = attentionSurfaces.filter((s) => s.failed).map((s) => s.name);
  const attentionPending = attentionSurfaces.some((s) => s.pending);

  // --- WORK-049: the Project Health view ---------------------------------
  //
  // The health findings are derived ONLY from reads that SUCCEEDED (a
  // failed read contributes NOTHING — its findings are simply unknown, and
  // the all-healthy conclusion is withheld below). The SAME facts always
  // produce the SAME findings (the pure helper); fresh responses re-derive
  // the view on every refresh (stale UI can never override server truth).
  const healthFindings = React.useMemo(
    () =>
      deriveHealthFindings({
        graph,
        executions: executionsRead.status === 'success' ? executionsRead.data : [],
        verificationRuns: verificationRead.status === 'success' ? verificationRead.data : [],
        maintenanceHealth: maintenanceRead.status === 'success' ? maintenanceRead.data : null,
        runtimeStatus: runtimeRead.status === 'success' ? runtimeRead.data : null,
        deployments: deploymentsRead.status === 'success' ? deploymentsRead.data : [],
      }),
    [graph, executionsRead, verificationRead, maintenanceRead, runtimeRead, deploymentsRead],
  );
  // A failed contributing read makes the all-healthy conclusion UNPROVABLE —
  // the health assessment reports the gap instead ("I don't know" must not
  // become "nothing is unhealthy").
  const healthSurfaces: Array<{ name: string; failed: boolean; pending: boolean }> = [
    { name: 'work graph', failed: graphRead.status === 'error', pending: graphRead.status === 'loading' },
    { name: 'executions', failed: executionsRead.status === 'error', pending: executionsRead.status === 'loading' },
    { name: 'verification', failed: verificationRead.status === 'error', pending: verificationRead.status === 'loading' },
    { name: 'deployments', failed: deploymentsRead.status === 'error', pending: deploymentsRead.status === 'loading' },
    { name: 'runtime', failed: runtimeRead.status === 'error', pending: runtimeRead.status === 'loading' },
    { name: 'maintenance', failed: maintenanceRead.status === 'error', pending: maintenanceRead.status === 'loading' },
  ];
  const healthFailed = healthSurfaces.filter((s) => s.failed).map((s) => s.name);
  const healthPending = healthSurfaces.some((s) => s.pending);

  // The maintenance authority's own signals, split into OPEN work (the
  // findings' work items — the governed next steps) and COMPLETED work
  // (done work, visibly never an open finding).
  const maintenanceWork = React.useMemo(
    () =>
      maintenanceRead.status === 'success' && maintenanceRead.data
        ? splitMaintenanceWork(maintenanceRead.data.signals)
        : null,
    [maintenanceRead],
  );

  const stateCounts = React.useMemo(
    () => (graph ? countByState(graph.nodes) : []),
    [graph],
  );

  const setTab = (value: string) => {
    setSearchParams(value === 'overview' ? {} : { tab: value }, { replace: true });
  };

  if (loading && !refreshingAt) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Workbench" description="Loading the engineering workspace…" />
        <LoadingState label="Loading the workbench…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Developer Workbench"
        title={project ? project.name : 'Workbench'}
        description={
          project
            ? `The authoritative engineering state of this project — work, executions, changes, verification, reviews, deployments, maintenance, activity.`
            : 'Project details unavailable — the backend could not be reached for this project.'
        }
        actions={
          <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      {graphUnavailable && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive"
        >
          {graphUnavailable}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* --- Overview ------------------------------------------------------------ */}
        <TabsContent value="overview" className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4" />
                  What needs attention
                </CardTitle>
                <CardDescription>
                  Derived from the authoritative graph, executions, verification,
                  reviews, and maintenance signals.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {attention.map((item, idx) => (
                  <RowCard
                    key={`${item.kind}-${idx}`}
                    to={item.href}
                    title={item.label}
                    meta={item.detail}
                    badge={
                      <Badge variant={item.kind === 'failed-verification' ? 'destructive' : 'secondary'}>
                        {titleCase(item.kind)}
                      </Badge>
                    }
                  />
                ))}
                {attentionFailed.length > 0 ? (
                  // A failed contributing read makes the "nothing needs
                  // attention" conclusion UNPROVABLE — report the gap.
                  <div className="text-sm text-destructive" data-testid="attention-incomplete">
                    Attention assessment incomplete — the following authority reads failed
                    and could not be assessed: {attentionFailed.join(', ')}.
                  </div>
                ) : attention.length === 0 && attentionPending ? (
                  <LoadingState label="Loading attention signals…" />
                ) : attention.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CircleCheckBig className="h-4 w-4 text-success" />
                    Nothing needs attention right now.
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ArrowRight className="h-4 w-4" />
                    What should happen next
                  </CardTitle>
                  <CardDescription>
                    The workflow authority's next eligible work item and the
                    planner's open recommendations.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {nextWorkItemRead.status === 'loading' ? (
                    <LoadingState label="Loading the next eligible work item…" />
                  ) : nextWorkItemRead.status === 'error' ? (
                    // A FAILED authority query — never "no eligible item".
                    <UnavailableLine testid="next-work-item-unavailable">
                      Next work item unavailable — the workflow authority could not be
                      reached ({nextWorkItemRead.message}).
                    </UnavailableLine>
                  ) : nextWorkItemRead.data ? (
                    <RowCard
                      to={`/work-items/${nextWorkItemRead.data}`}
                      title={
                        nodeById.get(nextWorkItemRead.data)
                          ? `${nodeById.get(nextWorkItemRead.data)!.workItemId} — ${nodeById.get(nextWorkItemRead.data)!.title}`
                          : `Next work item ${shortId(nextWorkItemRead.data)}`
                      }
                      meta="The workflow authority's next eligible item (dependencies satisfied, state ready)."
                      badge={<Badge variant="info">Next</Badge>}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      No eligible next work item (the workflow authority recommends none).
                    </div>
                  )}
                  {planningRead.status === 'loading' ? (
                    <LoadingState label="Loading planner recommendations…" />
                  ) : planningRead.status === 'error' ? (
                    <UnavailableLine testid="planner-unavailable">
                      {planningRead.message}
                    </UnavailableLine>
                  ) : planningRead.data === null ? (
                    <div className="text-sm text-muted-foreground">
                      No architecture version to plan against yet.
                    </div>
                  ) : planningRead.data.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      No open planner recommendations.
                    </div>
                  ) : (
                    planningRead.data.map((rec) => (
                      <RowCard
                        key={rec.workItemId}
                        to={`/work-items/${rec.workItemId}`}
                        title={`${rec.workItemHumanId} — ${rec.title}`}
                        meta={rec.planner.whyNow || rec.planner.rationale}
                        badge={<Badge variant="secondary">Planner</Badge>}
                      />
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ActivityIcon className="h-4 w-4" />
                    Health summary
                  </CardTitle>
                  <CardDescription>
                    The runtime authority's provider status for this project.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {runtimeRead.status === 'loading' ? (
                    <LoadingState label="Loading runtime status…" />
                  ) : runtimeRead.status === 'error' ? (
                    <UnavailableLine testid="runtime-unavailable">
                      Runtime status unavailable — the runtime authority could not be
                      reached ({runtimeRead.message}).
                    </UnavailableLine>
                  ) : (
                    <>
                      <HealthChip label="GitHub" status={runtimeRead.data.github?.status} />
                      <HealthChip label="Vercel" status={runtimeRead.data.vercel?.status} />
                      <HealthChip label="Architect" status={runtimeRead.data.architect?.status} />
                      <HealthChip label="Agent" status={runtimeRead.data.agent?.status} />
                    </>
                  )}
                  {deploymentsRead.status === 'success' && deploymentsRead.data.length > 0 && (
                    <RowCard
                      title={`Latest deployment: ${titleCase(deploymentsRead.data[0]!.status)}`}
                      meta={`${shortId(deploymentsRead.data[0]!.commitSha)} on ${deploymentsRead.data[0]!.branch ?? '—'} · ${formatRelative(deploymentsRead.data[0]!.createdAt)}`}
                      badge={<Badge variant="secondary">Deployment</Badge>}
                    />
                  )}
                  {deploymentsRead.status === 'error' && (
                    <UnavailableLine testid="latest-deployment-unavailable">
                      Latest deployment unavailable — the runtime authority could not be
                      reached ({deploymentsRead.message}).
                    </UnavailableLine>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Work state</CardTitle>
              <CardDescription>
                Every work item of the project, counted by the workflow
                authority's own state values.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {graphRead.status === 'loading' ? (
                <LoadingState label="Loading the work graph…" />
              ) : graphRead.status === 'error' ? (
                <UnavailableLine>Work graph unavailable (failed to load).</UnavailableLine>
              ) : stateCounts.length === 0 ? (
                <div className="text-sm text-muted-foreground">No work items yet.</div>
              ) : (
                stateCounts.map(({ state, count }) => (
                  <button
                    key={state}
                    type="button"
                    onClick={() => setTab('graph')}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:border-primary/40"
                  >
                    <StatusBadge value={state} />
                    <span className="font-mono text-foreground">{count}</span>
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent activity</CardTitle>
              <CardDescription>The audit authority's event feed for this project.</CardDescription>
            </CardHeader>
            <CardContent className="flex max-h-96 flex-col gap-2 overflow-y-auto">
              {activityRead.status === 'loading' ? (
                <LoadingState label="Loading recent activity…" />
              ) : activityRead.status === 'error' ? (
                <UnavailableLine testid="activity-unavailable">
                  Activity unavailable — the audit authority could not be reached
                  ({activityRead.message}).
                </UnavailableLine>
              ) : activityRead.data.length === 0 ? (
                <div className="text-sm text-muted-foreground">No recent activity recorded.</div>
              ) : (
                activityRead.data.slice(0, 8).map((event, idx) => (
                  <AuditEventItem key={event.id ?? idx} event={event} />
                ))
              )}
              <Link
                to="activity"
                className="self-start text-xs text-primary underline-offset-4 hover:underline"
              >
                View full activity →
              </Link>
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- Work Graph --------------------------------------------------------- */}
        <TabsContent value="graph" className="flex flex-col gap-4">
          {graphRead.status === 'error' ? (
            <ErrorState message={graphUnavailable ?? 'The work graph is unavailable.'} onRetry={loadAll} />
          ) : graph ? (
            <WorkGraphBoard graph={graph} />
          ) : (
            <LoadingState label="Loading the work graph…" />
          )}
        </TabsContent>

        {/* --- Work ---------------------------------------------------------------- */}
        <TabsContent value="work" className="flex flex-col gap-4">
          {graphRead.status === 'error' ? (
            <ErrorState message={graphUnavailable ?? 'The work graph is unavailable.'} onRetry={loadAll} />
          ) : !graph ? (
            <LoadingState label="Loading work items…" />
          ) : graph.nodes.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No work items"
              description="This project has no work items yet."
            />
          ) : (
            <div className="flex flex-col gap-2">
              {graph.nodes.map((n) => (
                <RowCard
                  key={n.id}
                  to={`/work-items/${n.id}`}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-primary">{n.workItemId}</span>
                      {n.title}
                    </span>
                  }
                  meta={
                    <span>
                      {n.objective ? `${n.objective.slice(0, 120)}${n.objective.length > 120 ? '…' : ''} · ` : ''}
                      updated {formatRelative(n.updatedAt)}
                    </span>
                  }
                  badge={
                    <span className="flex items-center gap-1.5">
                      {n.unsatisfiedDependencies.length > 0 && !n.completed && (
                        <Badge variant="destructive">Blocked</Badge>
                      )}
                      {n.completed ? (
                        <Badge variant="success">Completed</Badge>
                      ) : (
                        <StatusBadge value={n.currentState} />
                      )}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* --- Executions --------------------------------------------------------- */}
        <TabsContent value="executions" className="flex flex-col gap-4">
          {executionsRead.status === 'error' ? (
            <ErrorState
              data-testid="executions-unavailable"
              message={`Executions unavailable — the execution rollup could not be loaded (${executionsRead.message}).`}
              onRetry={loadAll}
            />
          ) : executionsRead.status === 'loading' ? (
            <LoadingState label="Loading executions…" />
          ) : executionsRead.data.length === 0 ? (
            <EmptyState
              icon={Cpu}
              title="No executions"
              description="No execution records exist for this project yet (the /agents authority reports none)."
            />
          ) : (
            executionsRead.data.map((e) => (
              <RowCard
                key={e.executionId}
                to={e.workItemId ? `/work-items/${e.workItemId}` : undefined}
                title={
                  <span className="font-mono text-xs">{e.executionId}</span>
                }
                meta={
                  <span>
                    {e.provider}
                    {e.model ? ` / ${e.model}` : ''} · {e.mode}
                    {e.branch ? ` · ${e.branch}` : ''}
                    {e.completedAt ? ` · completed ${formatRelative(e.completedAt)}` : e.startedAt ? ` · started ${formatRelative(e.startedAt)}` : ' · not started'}
                  </span>
                }
                badge={<StatusBadge value={e.status} />}
              />
            ))
          )}
        </TabsContent>

        {/* --- Changes --------------------------------------------------------- */}
        <TabsContent value="changes" className="flex flex-col gap-4">
          {changesRead.status === 'error' ? (
            <ErrorState
              data-testid="changes-unavailable"
              message={`Changes unavailable — the changes rollup could not be loaded (${changesRead.message}).`}
              onRetry={loadAll}
            />
          ) : changesRead.status === 'loading' ? (
            <LoadingState label="Loading changes…" />
          ) : changesRead.data.length === 0 ? (
            <EmptyState
              icon={GitPullRequest}
              title="No changes"
              description="No pull-request associations exist for this project yet (the GitHub-derived identity authority reports none)."
            />
          ) : (
            changesRead.data.map((pr) => (
              <RowCard
                key={pr.id}
                to={`/work-items/${pr.workItemId}`}
                title={<span className="font-mono text-xs">PR {pr.externalPrId}</span>}
                meta={
                  <span>
                    {pr.branch ?? '—'} → {pr.baseBranch ?? '—'}
                    {pr.repositoryRef ? ` · ${pr.repositoryRef}` : ''}
                    {pr.headCommit ? ` · head ${shortId(pr.headCommit)}` : ''}
                    {pr.createdAt ? ` · created ${formatRelative(pr.createdAt)}` : ''}
                  </span>
                }
                badge={<StatusBadge value={pr.status} />}
              />
            ))
          )}
        </TabsContent>

        {/* --- Verification --------------------------------------------------------- */}
        <TabsContent value="verification" className="flex flex-col gap-4">
          {verificationRead.status === 'error' ? (
            <ErrorState
              data-testid="verification-unavailable"
              message={`Verification runs unavailable — the verification rollup could not be loaded (${verificationRead.message}).`}
              onRetry={loadAll}
            />
          ) : verificationRead.status === 'loading' ? (
            <LoadingState label="Loading verification runs…" />
          ) : verificationRead.data.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No verification runs"
              description="The /verification authority reports no runs for this project yet."
            />
          ) : (
            verificationRead.data.map((run) => {
              const summary = run.summary as Record<string, unknown> | null;
              const pass = typeof summary?.criteriaPass === 'number' ? summary.criteriaPass : null;
              const fail = typeof summary?.criteriaFail === 'number' ? summary.criteriaFail : null;
              return (
                <RowCard
                  key={run.id}
                  to={`/work-items/${run.workItemId}`}
                  title={<span className="font-mono text-xs">Run {shortId(run.id)}</span>}
                  meta={
                    <span>
                      {titleCase(run.source)}
                      {run.sourceRef ? ` (${run.sourceRef})` : ''} · execution {run.executionId}
                      {pass !== null && fail !== null ? ` · ${pass} pass / ${fail} fail` : ''}
                      {run.finishedAt ? ` · finished ${formatRelative(run.finishedAt)}` : ''}
                    </span>
                  }
                  badge={<StatusBadge value={run.status} />}
                />
              );
            })
          )}
        </TabsContent>

        {/* --- Reviews --------------------------------------------------------- */}
        <TabsContent value="reviews" className="flex flex-col gap-4">
          {reviewsRead.status === 'error' ? (
            <ErrorState
              data-testid="reviews-unavailable"
              message={`Reviews unavailable — the reviews rollup could not be loaded (${reviewsRead.message}).`}
              onRetry={loadAll}
            />
          ) : reviewsRead.status === 'loading' ? (
            <LoadingState label="Loading reviews…" />
          ) : reviewsRead.data.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No reviews"
              description="The /reviews authority reports none for this project yet."
            />
          ) : (
            reviewsRead.data.map((review) => (
              <RowCard
                key={review.id}
                to={`/work-items/${review.workItemId}`}
                title={<span className="font-mono text-xs">Review {shortId(review.id)}</span>}
                meta={
                  <span>
                    {titleCase(review.source)}
                    {review.reviewer ? ` · ${review.reviewer}` : ''}
                    {review.summary ? ` · ${review.summary.slice(0, 100)}` : ''}
                    {review.createdAt ? ` · created ${formatRelative(review.createdAt)}` : ''}
                  </span>
                }
                badge={
                  review.outcome ? <StatusBadge value={review.outcome} /> : <StatusBadge value={review.status} />
                }
              />
            ))
          )}
        </TabsContent>

        {/* --- Deployments --------------------------------------------------------- */}
        <TabsContent value="deployments" className="flex flex-col gap-4">
          {deploymentsRead.status === 'error' ? (
            <ErrorState
              data-testid="deployments-unavailable"
              message={`Deployments unavailable — the runtime authority could not be reached (${deploymentsRead.message}).`}
              onRetry={loadAll}
            />
          ) : deploymentsRead.status === 'loading' ? (
            <LoadingState label="Loading deployments…" />
          ) : deploymentsRead.data.length === 0 ? (
            <EmptyState
              icon={Rocket}
              title="No deployments"
              description="The runtime authority reports no deployments for this project yet."
            />
          ) : (
            deploymentsRead.data.map((d) => (
              <RowCard
                key={d.id}
                title={
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{shortId(d.externalId)}</span>
                    {d.previewUrl && (
                      <a
                        href={d.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary underline-offset-4 hover:underline"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        preview ↗
                      </a>
                    )}
                  </span>
                }
                meta={
                  <span>
                    {shortId(d.commitSha)} on {d.branch ?? '—'} · created {formatRelative(d.createdAt)}
                  </span>
                }
                badge={<StatusBadge value={d.status} />}
              />
            ))
          )}
        </TabsContent>

        {/* --- Health (WORK-049: the Project Health & Maintenance UX) ------------ */}
        <TabsContent value="health" className="flex flex-col gap-4">
          {/* What is unhealthy? Why? How severe? What evidence supports it? */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <HeartPulse className="h-4 w-4" />
                Health findings
              </CardTitle>
              <CardDescription>
                Derived from the authoritative maintenance signals, verification
                runs, work graph, executions, and runtime status. Severity is
                the authority's own value; every finding links to its evidence.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {healthFindings.map((f, idx) => (
                <RowCard
                  key={`${f.kind}-${idx}`}
                  to={f.href}
                  title={f.what}
                  meta={
                    <span>
                      {f.why} · Evidence: {f.evidence}
                    </span>
                  }
                  badge={
                    <span className="flex items-center gap-1.5">
                      <Badge variant="secondary">{titleCase(f.kind)}</Badge>
                      {f.severity ? <StatusBadge value={f.severity} /> : null}
                    </span>
                  }
                />
              ))}
              {healthFailed.length > 0 ? (
                // A failed contributing read makes the all-healthy conclusion
                // UNPROVABLE — the gap is reported, never papered over.
                <div className="text-sm text-destructive" data-testid="health-incomplete">
                  Health assessment incomplete — the following authority reads
                  failed and could not be assessed: {healthFailed.join(', ')}.
                </div>
              ) : healthPending ? (
                <LoadingState label="Loading health findings…" />
              ) : healthFindings.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CircleCheckBig className="h-4 w-4 text-success" />
                  No health findings — the authorities report nothing unhealthy.
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* What maintenance work exists? (open findings vs COMPLETED work —
              always distinguishable; the authority's own records) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Stethoscope className="h-4 w-4" />
                Maintenance work
              </CardTitle>
              <CardDescription>
                The maintenance authority's own signals for this architecture
                version — each is an authoritative Work Item.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {maintenanceRead.status === 'error' ? (
                <UnavailableLine testid="maintenance-unavailable">
                  {maintenanceRead.message}
                </UnavailableLine>
              ) : maintenanceRead.status === 'loading' ? (
                <LoadingState label="Loading maintenance work…" />
              ) : maintenanceRead.data === null ? (
                <EmptyState
                  icon={Stethoscope}
                  title="No architecture version"
                  description="This project has no architecture version to inspect yet — the maintenance authority is version-scoped (no data is invented)."
                />
              ) : !maintenanceWork || (maintenanceWork.open.length === 0 && maintenanceWork.completed.length === 0) ? (
                <EmptyState
                  icon={Stethoscope}
                  title="No maintenance signals"
                  description="The maintenance authority reports no emerging maintenance for this architecture version."
                />
              ) : (
                <>
                  {maintenanceWork.open.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {maintenanceWork.open.map((m) => (
                        <RowCard
                          key={m.workItemId}
                          to={m.href}
                          title={`${m.workItemHumanId} — ${m.title}`}
                          meta={
                            <span>
                              {titleCase(m.category ?? 'unknown')}
                              {m.severity ? ` · ${m.severity}` : ''}
                              {m.advisoryId ? ` · ${m.advisoryId}` : ''}
                              {m.affectedCount !== null ? ` · ${m.affectedCount} affected` : ''}
                              {` · ${m.whyNow}`}
                            </span>
                          }
                          badge={<StatusBadge value={m.severity} />}
                        />
                      ))}
                    </div>
                  )}
                  {maintenanceWork.completed.length > 0 && (
                    // COMPLETED maintenance work: done work, visibly distinct
                    // from open findings — never presented as an open problem.
                    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <CircleCheckBig className="h-3.5 w-3.5 text-success" />
                        Completed maintenance work ({maintenanceWork.completed.length}) — done, not open
                      </div>
                      <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
                        {maintenanceWork.completed.map((m) => (
                          <RowCard
                            key={m.workItemId}
                            to={m.href}
                            title={
                              <span className="text-muted-foreground">
                                {m.workItemHumanId} — {m.title}
                              </span>
                            }
                            meta={
                              <span>
                                {titleCase(m.category ?? 'unknown')}
                                {m.severity ? ` · was ${m.severity}` : ''}
                              </span>
                            }
                            badge={<Badge variant="success">Completed</Badge>}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* What should happen next? (the governed path — the authoritative
              Work Items; the health view never invents an action) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ArrowRight className="h-4 w-4" />
                What should happen next
              </CardTitle>
              <CardDescription>
                The maintenance authority's open Work Items are the governed
                next steps — the health view recommends nothing beyond them
                (recommendations never become decisions here).
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {maintenanceRead.status === 'error' ? (
                <UnavailableLine testid="maintenance-next-unavailable">
                  Next maintenance step unavailable — the maintenance authority
                  could not be reached (the reason is on the maintenance work
                  card above).
                </UnavailableLine>
              ) : maintenanceRead.status === 'loading' ? (
                <LoadingState label="Loading next maintenance steps…" />
              ) : maintenanceRead.data === null ? (
                <div className="text-sm text-muted-foreground">
                  No architecture version to plan maintenance against yet.
                </div>
              ) : maintenanceWork && maintenanceWork.open.length > 0 ? (
                maintenanceWork.open.slice(0, 5).map((m) => (
                  <RowCard
                    key={m.workItemId}
                    to={m.href}
                    title={`${m.workItemHumanId} — ${m.title}`}
                    meta="The maintenance authority's Work Item — the governed path (act on it through the workflow)."
                    badge={
                      <span className="flex items-center gap-1.5">
                        <Badge variant="secondary">Maintenance</Badge>
                        {m.severity ? <StatusBadge value={m.severity} /> : null}
                      </span>
                    }
                  />
                ))
              ) : healthFindings.length > 0 ? (
                <div className="text-sm text-muted-foreground">
                  No open maintenance work — follow the evidence links on the
                  findings above (each links to its authoritative record).
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CircleCheckBig className="h-4 w-4 text-success" />
                  Nothing to act on — no open maintenance work and no health findings.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- Activity --------------------------------------------------------- */}
        <TabsContent value="activity" className="flex flex-col gap-4">
          {activityRead.status === 'error' ? (
            <ErrorState
              data-testid="activity-tab-unavailable"
              message={`Activity unavailable — the audit authority could not be reached (${activityRead.message}).`}
              onRetry={loadAll}
            />
          ) : activityRead.status === 'loading' ? (
            <LoadingState label="Loading activity…" />
          ) : activityRead.data.length === 0 ? (
            <EmptyState
              icon={ActivityIcon}
              title="No activity"
              description="The audit authority reports no events for this project yet."
            />
          ) : (
            <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto">
              {activityRead.data.map((event, idx) => (
                <AuditEventItem key={event.id ?? idx} event={event} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
