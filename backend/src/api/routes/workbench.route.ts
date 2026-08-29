/**
 * WORK-048 — the Developer Workbench read model (a THIN composition layer,
 * never a second business domain).
 *
 * The Workbench is the primary human-facing engineering workspace. It is a
 * CONSUMER of backend authorities: every response below is composed from the
 * OWNING modules' repositories/services through their declared interfaces —
 * nothing here owns workflow, authorization, execution, verification, review,
 * GitHub, or dependency truth, and nothing here mutates anything.
 *
 * Routes (ALL READ-ONLY — GET only; all project.read; project scope resolved
 * SERVER-SIDE through requireProjectAuthorization BEFORE any data is queried;
 * cross-project data leakage is impossible by construction — a caller without
 * project access receives 403 with no existence oracle):
 *
 *   GET /projects/:projectId/work-graph
 *        The project's engineering graph — every work item of the project
 *        (through the AUTHORITATIVE work-item → architecture-version →
 *        architecture → project chain), each node carrying the work item's
 *        fields + its CURRENT workflow state (from the WorkflowEngine — the
 *        workflow authority) + its UNSATISFIED dependencies (from the
 *        WorkItemDependencyService — the dependency authority; the
 *        satisfaction rule is NEVER re-implemented here), plus the full
 *        dependency EDGE list. Classification (ready/active/blocked/…) is a
 *        PRESENTATION concern left to the consumer — this endpoint returns
 *        facts only.
 *
 *   GET /projects/:projectId/executions
 *        The project execution rollup (newest first) — SAFE execution
 *        metadata only (the same secret-free, package-free shape as
 *        GET /work-items/:id/executions). Optional ?limit= (default 100).
 *
 *   GET /projects/:projectId/pr-associations
 *        The project changes rollup (newest first) — the authoritative
 *        GitHub-derived PR identities (external PR id, provider, repository,
 *        branch, base branch, head commit, merge status). Optional ?limit=.
 *
 *   GET /projects/:projectId/verification-runs
 *        The project verification rollup (newest first) — the
 *        /verification authority's own runs (the Workbench never evaluates
 *        evidence; it renders the authority's records). Optional ?limit=.
 *
 *   GET /projects/:projectId/reviews
 *        The project review rollup (newest first) — the /reviews authority's
 *        own records (verdict/outcome, status). Optional ?limit=.
 *
 * There is deliberately NO write surface here and NO aggregated decision
 * logic: recommendations (WORK-044 routing / WORK-047 intelligence) remain
 * RECOMMENDATIONS from their own endpoints — this layer never converts a
 * recommendation into a decision, never selects providers, never advances
 * workflow state.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  WorkItemRepository,
  WorkItemDependencyRepository,
  WorkItemDependencyService,
  PullRequestAssociationRepository,
} from '@modules/work-items/index.js';
import type { ExecutionRecordRepository } from '@modules/agents/index.js';
import type { WorkflowEngine } from '@modules/workflows/index.js';
import type { VerificationService } from '@modules/verification/index.js';
import type { ReviewService } from '@modules/reviews/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/** A work-graph node: the authoritative WorkItem + its live graph facts. */
export interface WorkGraphNode {
  readonly id: string;
  readonly architectureVersionId: string;
  readonly workItemId: string;
  readonly title: string;
  readonly objective: string | null;
  readonly scope: string | null;
  readonly outOfScope: string | null;
  readonly architectureConstraints: string | null;
  readonly assignee: string | null;
  readonly executionMetadata: Record<string, unknown>;
  readonly completed: boolean;
  readonly metadata: Record<string, unknown>;
  readonly architectureImpact: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Current workflow state from the WorkflowEngine (null before the first transition). */
  readonly currentState: string | null;
  /** Dependency ids NOT yet satisfied, from the WorkItemDependencyService (the authority). */
  readonly unsatisfiedDependencies: readonly string[];
}

/** A directed dependency edge: `workItemId` depends on `dependsOnId`. */
export interface WorkGraphEdge {
  readonly workItemId: string;
  readonly dependsOnId: string;
}

export interface WorkbenchRouteDeps {
  authorizationService: AuthorizationService;
  workItemRepository: WorkItemRepository;
  workItemDependencyRepository: WorkItemDependencyRepository;
  dependencyService: WorkItemDependencyService;
  workflowEngine: WorkflowEngine;
  executionRecordRepository: ExecutionRecordRepository;
  pullRequestAssociationRepository: PullRequestAssociationRepository;
  verificationService: VerificationService;
  reviewService: ReviewService;
}

/** Parse the optional ?limit= query parameter (audit-route convention; clamped 1..500, default 100). */
function parseLimit(query: { limit?: string }): { limit?: number } {
  if (query.limit === undefined) return {};
  const parsed = Number.parseInt(query.limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return { limit: 1 };
  return { limit: Math.min(parsed, 500) };
}

/**
 * WORK-048: safe (secret-free, package-snapshot-free) execution summary —
 * the execution-route field set PLUS the record's own workItemId (the rollup
 * is project-wide, so the work-item reference is needed for navigation; it
 * is an authoritative field of the record, never a frontend derivation).
 */
function toSafeExecution(record: {
  executionId: string;
  workItemId: string;
  mode: string;
  provider: string;
  model: string | null;
  status: string;
  agentRunId: string | null;
  externalSessionRef: string | null;
  repositoryRef: string | null;
  branch: string | null;
  promptDigest: string;
  benchmarkMetadata: Record<string, unknown>;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    executionId: record.executionId,
    workItemId: record.workItemId,
    mode: record.mode,
    provider: record.provider,
    model: record.model,
    status: record.status,
    agentRunId: record.agentRunId,
    externalSessionRef: record.externalSessionRef,
    repository: record.repositoryRef,
    branch: record.branch,
    promptDigest: record.promptDigest,
    benchmarkMetadata: record.benchmarkMetadata,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function workbenchRoutes(app: FastifyInstance, deps: WorkbenchRouteDeps): Promise<void> {
  // GET /projects/:projectId/work-graph — the project engineering graph.
  //
  // Composition of AUTHORITATIVE reads only: work items (the work-items
  // repository, project-scoped through the authoritative chain), workflow
  // states (the WorkflowEngine — one getState per node, the
  // selectNextWorkItem precedent), dependency edges (the dependency
  // repository), and unsatisfied dependencies (the dependency SERVICE — the
  // satisfaction rule is never re-implemented here).
  app.get('/projects/:projectId/work-graph', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });

      const workItems = await deps.workItemRepository.listForProject(projectId);
      const nodes: WorkGraphNode[] = [];
      const edges: WorkGraphEdge[] = [];
      for (const wi of workItems) {
        // Edges: the node's outgoing dependencies (the authoritative rows).
        const dependencies = await deps.workItemDependencyRepository.listForWorkItem(wi.id);
        for (const dep of dependencies) {
          edges.push({ workItemId: dep.workItemId, dependsOnId: dep.dependsOnId });
        }
        // Unsatisfied dependencies: delegated to the dependency AUTHORITY.
        const unsatisfied = await deps.dependencyService.getUnsatisfiedDependencies(wi.id);
        // Workflow state: delegated to the workflow AUTHORITY.
        const state = await deps.workflowEngine.getState(wi.id);
        nodes.push({
          ...wi,
          currentState: state?.currentState ?? null,
          unsatisfiedDependencies: unsatisfied,
        });
      }
      return reply.code(200).send({ workGraph: { projectId, nodes, edges } });
    });
  });

  // GET /projects/:projectId/executions — the project execution rollup.
  app.get('/projects/:projectId/executions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const query = req.query as { limit?: string };
      const records = await deps.executionRecordRepository.listForProject(projectId, parseLimit(query));
      return reply.code(200).send({ executions: records.map(toSafeExecution) });
    });
  });

  // GET /projects/:projectId/pr-associations — the project changes rollup.
  app.get('/projects/:projectId/pr-associations', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const query = req.query as { limit?: string };
      const prAssociations = await deps.pullRequestAssociationRepository.listForProject(
        projectId,
        parseLimit(query),
      );
      return reply.code(200).send({ prAssociations });
    });
  });

  // GET /projects/:projectId/verification-runs — the project verification rollup.
  app.get('/projects/:projectId/verification-runs', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const query = req.query as { limit?: string };
      const verificationRuns = await deps.verificationService.listRunsForProject(
        projectId,
        parseLimit(query),
      );
      return reply.code(200).send({ verificationRuns });
    });
  });

  // GET /projects/:projectId/reviews — the project review rollup.
  app.get('/projects/:projectId/reviews', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const query = req.query as { limit?: string };
      const reviews = await deps.reviewService.listReviewsForProject(projectId, parseLimit(query));
      return reply.code(200).send({ reviews });
    });
  });
}
