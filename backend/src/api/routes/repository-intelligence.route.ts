import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  ProjectRepository,
  ProjectBaselineRepository,
  ProjectContextIndexRepository,
} from '@modules/projects/index.js';
import type {
  ProjectGitHubRepositoryRepository,
  GitHubAdapter,
  ArchitectureVersionRepository,
  ArchitectureRepository,
  RequirementRepository,
  AcceptanceCriterionRepository,
  WorkItemRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
  RepositoryIntelligenceService,
  ContextIndexQuery,
  ContextQueryTerms,
  ContextIndexQueryKind,
  ContextResolutionContext,
} from '@repository-intelligence/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * WORK-039: Repository and Context Intelligence routes — surface the
 * revision-bound, explainable, provenance-preserving context-intelligence
 * capability over HTTP.
 *
 *   POST   /projects/:projectId/baselines/:baselineId/context-index
 *     — build (or re-use) the context index for a baseline+query. Idempotent
 *       per (baseline, query_kind, query_ref). Requires project.write.
 *   GET    /projects/:projectId/baselines/:baselineId/context-index
 *          ?queryKind=work_item&queryRef=<wiId>
 *     — retrieve the context selection. Builds if missing. Requires
 *       project.read.
 *   GET    /projects/:projectId/baselines/:baselineId/context-index/:indexId
 *     — read a specific index + its items. Requires project.read.
 *   GET    /projects/:projectId/baselines/:baselineId/context-index/:indexId/stale
 *     — the stale advisory (compares the index's baseline_commit_sha against
 *       the current repo HEAD). Requires project.read.
 *
 * Every route is backend-authorized via the reusable AuthorizationService
 * (AUTHZ-AC-01..03). A repository, baseline, or index UUID is NOT an
 * authorization credential — every mutation resolves the resource, verifies
 * authorization server-side, then mutates.
 *
 * The route is THIN: it delegates to the RepositoryIntelligenceService (the
 * orchestrator that composes /github + /agents + /projects + /architecture +
 * /requirements + /work-items) and the ProjectContextIndexRepository (the
 * /projects storage authority). No GitHub SDK, no credentials, no DB access
 * here.
 */
export interface RepositoryIntelligenceRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  projectBaselineRepository: ProjectBaselineRepository;
  projectContextIndexRepository: ProjectContextIndexRepository;
  repositoryIntelligenceService: RepositoryIntelligenceService;
  projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository;
  githubAdapter: GitHubAdapter;
  architectureVersionRepository: ArchitectureVersionRepository;
  architectureRepository: ArchitectureRepository;
  requirementRepository: RequirementRepository;
  acceptanceCriterionRepository: AcceptanceCriterionRepository;
  workItemRepository: WorkItemRepository;
  workItemRequirementRepository: WorkItemRequirementRepository;
  workItemCriterionRepository: WorkItemCriterionRepository;
}

async function resolveContext(
  deps: RepositoryIntelligenceRouteDeps,
  projectId: string,
  baselineId: string,
): Promise<ContextResolutionContext & { baselineCommitSha: string }> {
  // Resolve the baseline (server-side ownership check — the baseline must
  // belong to the authorized project; a UUID is NEVER a credential).
  const baseline = await deps.projectBaselineRepository.findById(baselineId);
  if (!baseline || baseline.projectId !== projectId) {
    throw new Error('not-found');
  }
  // Resolve the repo link (the /github authority row — owner, name,
  // installationId, defaultBranch).
  const repoLink = await deps.projectGitHubRepositoryRepository.findByProject(projectId);
  if (!repoLink) {
    throw new Error('no-repository-link');
  }
  return {
    organizationId: baseline.organizationId,
    projectGithubRepositoryId: repoLink.id,
    baselineCommitSha: baseline.baselineCommitSha,
    repositoryOwner: repoLink.owner,
    repositoryName: repoLink.repository,
    installationId: String(repoLink.installationId),
    projectBaselineRepository: deps.projectBaselineRepository,
    projectContextIndexRepository: deps.projectContextIndexRepository,
    projectGitHubRepositoryRepository: deps.projectGitHubRepositoryRepository,
    githubAdapter: deps.githubAdapter,
    architectureVersionRepository: deps.architectureVersionRepository,
    architectureRepository: deps.architectureRepository,
    requirementRepository: deps.requirementRepository,
    acceptanceCriterionRepository: deps.acceptanceCriterionRepository,
    workItemRepository: deps.workItemRepository,
    workItemRequirementRepository: deps.workItemRequirementRepository,
    workItemCriterionRepository: deps.workItemCriterionRepository,
  };
}

function parseQueryTerms(body: unknown): ContextQueryTerms {
  const b = (body ?? {}) as Record<string, unknown>;
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((t) => typeof t === 'string') : undefined;
  // Build the terms via conditional spreads (ContextQueryTerms fields are
  // readonly — construct the object once, do not mutate).
  const partial: Record<string, string[]> = {};
  const w = strList(b.workItemTerms); if (w) partial.workItemTerms = w;
  const a = strList(b.architectureRefs); if (a) partial.architectureRefs = a;
  const r = strList(b.requirementRefs); if (r) partial.requirementRefs = r;
  const t = strList(b.testPatterns); if (t) partial.testPatterns = t;
  const d = strList(b.dependencyRefs); if (d) partial.dependencyRefs = d;
  const f = strList(b.freeformTerms); if (f) partial.freeformTerms = f;
  return partial as unknown as ContextQueryTerms;
}

export async function repositoryIntelligenceRoutes(
  app: FastifyInstance,
  deps: RepositoryIntelligenceRouteDeps,
): Promise<void> {
  // POST /projects/:projectId/baselines/:baselineId/context-index
  // Body: { queryKind: 'work_item'|'architecture'|'requirement'|'freeform',
  //         queryRef?: string, queryTerms: ContextQueryTerms }
  // Returns the index header (201 on fresh build; 200 on idempotent re-use).
  app.post('/projects/:projectId/baselines/:baselineId/context-index', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, baselineId } = req.params as { projectId: string; baselineId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        queryKind?: ContextIndexQueryKind;
        queryRef?: string | null;
        queryTerms?: ContextQueryTerms;
      } | undefined;
      if (!body?.queryKind || !['work_item', 'architecture', 'requirement', 'freeform'].includes(body.queryKind)) {
        return reply.code(400).send({ error: 'invalid-query-kind', queryKind: body?.queryKind });
      }
      const query: ContextIndexQuery = {
        projectId,
        baselineId,
        kind: body.queryKind,
        queryRef: body.queryRef ?? null,
        queryTerms: body.queryTerms ?? parseQueryTerms({}),
      };
      try {
        const ctx = await resolveContext(deps, projectId, baselineId);
        const result = await deps.repositoryIntelligenceService.buildIndex(query, ctx);
        return reply.code(result.kind === 'complete' ? 201 : 200).send({
          index: result.index,
          freshlyBuilt: result.kind === 'complete',
        });
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('not-found')) {
          return reply.code(404).send({ error: 'baseline-not-found', baselineId });
        }
        if (msg.includes('no-repository-link')) {
          return reply.code(409).send({ error: 'no-repository-link' });
        }
        if (msg.includes('context-index-baseline-not-complete')) {
          return reply.code(409).send({ error: 'baseline-not-complete', message: msg.slice(0, 500) });
        }
        return reply.code(500).send({ error: 'index-build-failed', message: msg.slice(0, 500) });
      }
    });
  });

  // GET /projects/:projectId/baselines/:baselineId/context-index
  //   ?queryKind=work_item&queryRef=<wiId>
  // Returns the context selection (index + items + reason). Builds if missing.
  app.get('/projects/:projectId/baselines/:baselineId/context-index', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, baselineId } = req.params as { projectId: string; baselineId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const q = req.query as {
        queryKind?: ContextIndexQueryKind;
        queryRef?: string | null;
        workItemTerms?: string;
        freeformTerms?: string;
        architectureRefs?: string;
        requirementRefs?: string;
        testPatterns?: string;
        dependencyRefs?: string;
      };
      if (!q.queryKind || !['work_item', 'architecture', 'requirement', 'freeform'].includes(q.queryKind)) {
        return reply.code(400).send({ error: 'invalid-query-kind', queryKind: q.queryKind });
      }
      const commaList = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
      const query: ContextIndexQuery = {
        projectId,
        baselineId,
        kind: q.queryKind,
        queryRef: q.queryRef ?? null,
        queryTerms: {
          workItemTerms: commaList(q.workItemTerms),
          freeformTerms: commaList(q.freeformTerms),
          architectureRefs: commaList(q.architectureRefs),
          requirementRefs: commaList(q.requirementRefs),
          testPatterns: commaList(q.testPatterns),
          dependencyRefs: commaList(q.dependencyRefs),
        },
      };
      try {
        const ctx = await resolveContext(deps, projectId, baselineId);
        const selection = await deps.repositoryIntelligenceService.retrieve(query, ctx);
        return reply.code(200).send(selection);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('not-found')) {
          return reply.code(404).send({ error: 'baseline-not-found', baselineId });
        }
        if (msg.includes('no-repository-link')) {
          return reply.code(409).send({ error: 'no-repository-link' });
        }
        if (msg.includes('context-index-baseline-not-complete')) {
          return reply.code(409).send({ error: 'baseline-not-complete', message: msg.slice(0, 500) });
        }
        return reply.code(500).send({ error: 'retrieve-failed', message: msg.slice(0, 500) });
      }
    });
  });

  // GET /projects/:projectId/baselines/:baselineId/context-index/:indexId
  // — read a specific index + its items. Server-side ownership check.
  app.get(
    '/projects/:projectId/baselines/:baselineId/context-index/:indexId',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId, baselineId, indexId } = req.params as {
          projectId: string;
          baselineId: string;
          indexId: string;
        };
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.read',
          projectId,
        });
        const index = await deps.projectContextIndexRepository.findById(indexId);
        if (!index || index.projectId !== projectId || index.baselineId !== baselineId) {
          return reply.code(404).send({ error: 'not-found' });
        }
        const items = await deps.projectContextIndexRepository.listItems(indexId);
        return { index, items };
      });
    },
  );

  // GET /projects/:projectId/baselines/:baselineId/context-index/:indexId/stale
  // — the stale advisory (compares the index's baseline_commit_sha against
  // the current repo HEAD). The index is NEVER swapped; this is advisory.
  app.get(
    '/projects/:projectId/baselines/:baselineId/context-index/:indexId/stale',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId, baselineId, indexId } = req.params as {
          projectId: string;
          baselineId: string;
          indexId: string;
        };
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.read',
          projectId,
        });
        const index = await deps.projectContextIndexRepository.findById(indexId);
        if (!index || index.projectId !== projectId || index.baselineId !== baselineId) {
          return reply.code(404).send({ error: 'not-found' });
        }
        // Reuse the query from the index header (the stored queryTermsJson).
        const query: ContextIndexQuery = {
          projectId,
          baselineId,
          kind: index.queryKind,
          queryRef: index.queryRef,
          queryTerms: index.queryTermsJson as unknown as ContextQueryTerms,
        };
        try {
          const ctx = await resolveContext(deps, projectId, baselineId);
          const report = await deps.repositoryIntelligenceService.detectStale(query, ctx);
          return report;
        } catch (err) {
          const msg = (err as Error).message ?? '';
          if (msg.includes('not-found')) {
            return reply.code(404).send({ error: 'baseline-not-found', baselineId });
          }
          if (msg.includes('no-repository-link')) {
            return reply.code(409).send({ error: 'no-repository-link' });
          }
          return reply.code(500).send({ error: 'stale-detection-failed', message: msg.slice(0, 500) });
        }
      });
    },
  );
}
