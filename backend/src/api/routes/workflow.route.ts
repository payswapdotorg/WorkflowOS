import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { WorkflowEngine, WorkflowState, TransitionRequest } from '@modules/workflows/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * Protected workflow routes (WORKFLOW-001..005).
 *
 * All routes are backend-authorized. The API submits transition requests to
 * the Workflow Engine — it does NOT put the state machine in route handlers.
 * No endpoint accepts arbitrary state values; only transition requests
 * validated by the engine are accepted.
 */
export interface WorkflowRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  workflowEngine: WorkflowEngine;
}

async function resolveProjectForWorkItem(
  deps: WorkflowRouteDeps,
  workItemId: string,
): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

export async function workflowRoutes(
  app: FastifyInstance,
  deps: WorkflowRouteDeps,
): Promise<void> {
  // GET /work-items/:workItemId/workflow — current canonical state.
  app.get('/work-items/:workItemId/workflow', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const execution = await deps.workflowEngine.getOrCreate(workItemId);
      return execution;
    });
  });

  // GET /work-items/:workItemId/workflow/history — transition history.
  app.get('/work-items/:workItemId/workflow/history', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const history = await deps.workflowEngine.getHistory(workItemId);
      return { transitions: history };
    });
  });

  // POST /work-items/:workItemId/workflow/transitions — request a transition.
  app.post('/work-items/:workItemId/workflow/transitions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        toState?: WorkflowState;
        transitionType?: string;
        idempotencyKey?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.toState) {
        return reply.code(400).send({ error: 'toState required' });
      }
      const request: TransitionRequest = {
        workItemId,
        toState: body.toState,
        transitionType: body.transitionType,
        actor: user.id,
        executionId: (req as unknown as { executionId?: string }).executionId,
        idempotencyKey: body.idempotencyKey,
        metadata: body.metadata,
      };
      const result = await deps.workflowEngine.transition(request);
      if (!result.success) {
        return reply.code(409).send({
          error: 'transition-rejected',
          fromState: result.fromState,
          toState: result.toState,
          reason: result.reason,
        });
      }
      return reply.code(200).send(result);
    });
  });
}
