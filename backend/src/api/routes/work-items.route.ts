import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  ArchitectureRepository,
  ArchitectureVersionRepository,
} from '@modules/architecture/index.js';
import type {
  WorkItemRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
  WorkItemDependencyRepository,
  PullRequestAssociationRepository,
  WorkOrderRepository,
} from '@modules/work-items/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * Protected work-items routes demonstrating WORK-007 contracts.
 *
 * All routes are backend-authorized via the reusable {@link AuthorizationService}
 * (reused from WORK-002). Authorization resolves through the traceability chain:
 *   Work Item → ArchitectureVersion → Architecture → Project
 */
export interface WorkItemsRouteDeps {
  authorizationService: AuthorizationService;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  workItemRequirementRepository: WorkItemRequirementRepository;
  workItemCriterionRepository: WorkItemCriterionRepository;
  workItemDependencyRepository: WorkItemDependencyRepository;
  pullRequestAssociationRepository: PullRequestAssociationRepository;
  workOrderRepository: WorkOrderRepository;
}

async function resolveProjectForWorkItem(
  deps: WorkItemsRouteDeps,
  workItemId: string,
): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

export async function workItemsRoutes(
  app: FastifyInstance,
  deps: WorkItemsRouteDeps,
): Promise<void> {
  // --- Work Items ---

  app.post('/architecture-versions/:versionId/work-items', async (req, reply) => {
    return runAuthed(req, async () => {
      const { versionId } = req.params as { versionId: string };
      const version = await deps.architectureVersionRepository.findById(versionId);
      if (!version) return reply.code(404).send({ error: 'version-not-found' });
      const arch = await deps.architectureRepository.findById(version.architectureId);
      if (!arch) return reply.code(404).send({ error: 'architecture-not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: arch.projectId,
      });
      const body = req.body as {
        workItemId?: string;
        title?: string;
        objective?: string;
        scope?: string;
        outOfScope?: string;
        architectureConstraints?: string;
        assignee?: string;
      };
      if (!body?.workItemId || !body?.title) {
        return reply.code(400).send({ error: 'workItemId and title required' });
      }
      const wi = await deps.workItemRepository.create({
        architectureVersionId: versionId,
        workItemId: body.workItemId,
        title: body.title,
        objective: body.objective,
        scope: body.scope,
        outOfScope: body.outOfScope,
        architectureConstraints: body.architectureConstraints,
        assignee: body.assignee,
      });
      return reply.code(201).send(wi);
    });
  });

  app.get('/work-items/:workItemId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const wi = await deps.workItemRepository.findById(workItemId);
      if (!wi) return reply.code(404).send({ error: 'not-found' });
      return wi;
    });
  });

  // GET /architecture-versions/:versionId/work-items — list work items for a
  // frozen (or draft) architecture version. The frontend product UI uses this
  // on the architecture + requirements workspaces to render the work-item
  // backlog. Authorization walks the same traceability chain as every other
  // work-item route: ArchitectureVersion → Architecture → Project.
  // Returns `{ workItems: WorkItem[] }` (consistent with other list endpoints).
  app.get('/architecture-versions/:versionId/work-items', async (req, reply) => {
    return runAuthed(req, async () => {
      const { versionId } = req.params as { versionId: string };
      const version = await deps.architectureVersionRepository.findById(versionId);
      if (!version) return reply.code(404).send({ error: 'version-not-found' });
      const arch = await deps.architectureRepository.findById(version.architectureId);
      if (!arch) return reply.code(404).send({ error: 'architecture-not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: arch.projectId,
      });
      const list = await deps.workItemRepository.findByArchitectureVersion(versionId);
      return { workItems: list };
    });
  });

  // --- Requirement / Criterion associations ---

  app.post('/work-items/:workItemId/requirements', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as { requirementId?: string };
      if (!body?.requirementId) return reply.code(400).send({ error: 'requirementId required' });
      try {
        const assoc = await deps.workItemRequirementRepository.associate(workItemId, body.requirementId);
        return reply.code(201).send(assoc);
      } catch (err) {
        return reply.code(400).send({ error: 'invalid-association', message: (err as Error).message });
      }
    });
  });

  app.post('/work-items/:workItemId/criteria', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as { criterionId?: string };
      if (!body?.criterionId) return reply.code(400).send({ error: 'criterionId required' });
      try {
        const assoc = await deps.workItemCriterionRepository.associate(workItemId, body.criterionId);
        return reply.code(201).send(assoc);
      } catch (err) {
        return reply.code(400).send({ error: 'invalid-association', message: (err as Error).message });
      }
    });
  });

  // --- Dependencies ---

  app.post('/work-items/:workItemId/dependencies', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const sourceProjectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!sourceProjectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: sourceProjectId,
      });
      const body = req.body as { dependsOnId?: string };
      if (!body?.dependsOnId) return reply.code(400).send({ error: 'dependsOnId required' });
      // Cross-tenant guard: resolve target's project.
      const targetProjectId = await resolveProjectForWorkItem(deps, body.dependsOnId);
      if (!targetProjectId) return reply.code(400).send({ error: 'target-not-found' });
      if (targetProjectId !== sourceProjectId) {
        return reply.code(403).send({ error: 'forbidden', reason: 'cross-tenant-dependency' });
      }
      try {
        const dep = await deps.workItemDependencyRepository.add(workItemId, body.dependsOnId);
        return reply.code(201).send(dep);
      } catch (err) {
        return reply.code(409).send({ error: 'invalid-dependency', message: (err as Error).message });
      }
    });
  });

  app.get('/work-items/:workItemId/dependencies', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const list = await deps.workItemDependencyRepository.listForWorkItem(workItemId);
      return { dependencies: list };
    });
  });

  // --- PR associations ---

  app.post('/work-items/:workItemId/pr-associations', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        externalPrId?: string;
        provider?: string;
        repositoryRef?: string;
        branch?: string;
        baseBranch?: string;
        headCommit?: string;
      };
      if (!body?.externalPrId) return reply.code(400).send({ error: 'externalPrId required' });
      try {
        const assoc = await deps.pullRequestAssociationRepository.create({
          workItemId,
          externalPrId: body.externalPrId,
          provider: body.provider,
          repositoryRef: body.repositoryRef,
          branch: body.branch,
          baseBranch: body.baseBranch,
          headCommit: body.headCommit,
        });
        return reply.code(201).send(assoc);
      } catch (err) {
        return reply.code(409).send({ error: 'pr-association-failed', message: (err as Error).message });
      }
    });
  });

  app.get('/work-items/:workItemId/pr-associations', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const list = await deps.pullRequestAssociationRepository.listForWorkItem(workItemId);
      return { prAssociations: list };
    });
  });

  // --- Work Orders ---

  app.post('/work-items/:workItemId/work-orders', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const wi = await deps.workItemRepository.findById(workItemId);
      if (!wi) return reply.code(404).send({ error: 'not-found' });
      const body = req.body as {
        requirementIds?: string[];
        criterionIds?: string[];
        architectureConstraints?: string;
        implementationContext?: Record<string, unknown>;
        scope?: string;
        outOfScope?: string;
        verificationRequirements?: unknown[];
      };
      const wo = await deps.workOrderRepository.create({
        workItemId,
        projectId,
        architectureVersionId: wi.architectureVersionId,
        requirementIds: body?.requirementIds,
        criterionIds: body?.criterionIds,
        architectureConstraints: body?.architectureConstraints,
        implementationContext: body?.implementationContext,
        scope: body?.scope,
        outOfScope: body?.outOfScope,
        verificationRequirements: body?.verificationRequirements,
      });
      void user;
      return reply.code(201).send(wo);
    });
  });

  app.get('/work-items/:workItemId/work-orders', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const list = await deps.workOrderRepository.listForWorkItem(workItemId);
      return { workOrders: list };
    });
  });
}
