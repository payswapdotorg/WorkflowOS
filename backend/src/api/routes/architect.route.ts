import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository, WorkOrderRepository } from '@modules/work-items/index.js';
import type { RequirementRepository, AcceptanceCriterionRepository } from '@modules/requirements/index.js';
import type { LlmGateway, ArchitectService } from '@modules/llm/index.js';
import type { DatabaseClient } from '@platform/index.js';
import { generateExecutionId } from '@platform/ids.js';
import { requireProjectAuthorization, runAuthed } from '../plugins/auth.plugin.js';

export interface ArchitectRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  workOrderRepository: WorkOrderRepository;
  requirementRepository: RequirementRepository;
  acceptanceCriterionRepository: AcceptanceCriterionRepository;
  llmGateway: LlmGateway;
  architectService: ArchitectService;
  db: DatabaseClient;
}

async function resolveProjectForArchitectureVersion(
  deps: ArchitectRouteDeps,
  architectureVersionId: string,
): Promise<string | null> {
  const version = await deps.architectureVersionRepository.findById(architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

export async function architectRoutes(app: FastifyInstance, deps: ArchitectRouteDeps): Promise<void> {
  // POST /projects/:projectId/architect/execute — request architect execution.
  app.post('/projects/:projectId/architect/execute', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write', projectId,
      });
      const body = req.body as {
        architectureVersionId?: string;
        workItemId?: string;
        task?: string;
        provider?: string;
        model?: string;
      };
      if (!body?.architectureVersionId || !body?.task || !body?.provider || !body?.model) {
        return reply.code(400).send({ error: 'architectureVersionId, task, provider, and model required' });
      }
      // Verify the architecture version belongs to this project.
      const avProjectId = await resolveProjectForArchitectureVersion(deps, body.architectureVersionId);
      if (!avProjectId || avProjectId !== projectId) {
        return reply.code(403).send({ error: 'forbidden', reason: 'architecture-version-not-in-project' });
      }
      const executionId = generateExecutionId();
      const result = await deps.architectService.execute({
        projectId,
        architectureVersionId: body.architectureVersionId,
        workItemId: body.workItemId,
        task: body.task,
        executionId,
        provider: body.provider,
        model: body.model,
      });
      void user;
      return reply.code(200).send(result);
    });
  });

  // POST /projects/:projectId/architect/generate-work-order — generate a Work Order from an architect result.
  app.post('/projects/:projectId/architect/generate-work-order', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write', projectId,
      });
      const body = req.body as {
        architectureVersionId?: string;
        workItemId?: string;
        task?: string;
        provider?: string;
        model?: string;
      };
      if (!body?.architectureVersionId || !body?.task || !body?.provider || !body?.model || !body?.workItemId) {
        return reply.code(400).send({ error: 'architectureVersionId, workItemId, task, provider, and model required' });
      }
      const avProjectId = await resolveProjectForArchitectureVersion(deps, body.architectureVersionId);
      if (!avProjectId || avProjectId !== projectId) {
        return reply.code(403).send({ error: 'forbidden', reason: 'architecture-version-not-in-project' });
      }
      const executionId = generateExecutionId();
      const archResult = await deps.architectService.execute({
        projectId, architectureVersionId: body.architectureVersionId,
        workItemId: body.workItemId, task: body.task,
        executionId, provider: body.provider, model: body.model,
      });
      if (!archResult.workOrderCandidate) {
        return reply.code(409).send({ error: 'no-work-order-candidate', architectResult: archResult });
      }
      const woResult = await deps.architectService.generateWorkOrder(
        { projectId, architectureVersionId: body.architectureVersionId,
          workItemId: body.workItemId, task: body.task,
          executionId, provider: body.provider, model: body.model },
        archResult,
      );
      return reply.code(201).send({
        workOrderId: woResult.workOrderId,
        architectExecutionId: woResult.architectExecutionId,
        architectResult: archResult,
      });
    });
  });
}
