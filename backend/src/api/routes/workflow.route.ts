import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { WorkflowEngine, WorkflowState, TransitionRequest, WorkflowOrchestrator, SignalType } from '@modules/workflows/index.js';
import { generateExecutionId } from '@platform/ids.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * Protected workflow routes (WORKFLOW-001..005, WORK-017 convergence).
 *
 * All routes are backend-authorized. The API submits transition requests to
 * the Workflow Engine — it does NOT put the state machine in route handlers.
 * No endpoint accepts arbitrary state values; only transition requests
 * validated by the engine are accepted.
 *
 * WORK-017: Added convergence routes that submit signals to the
 * WorkflowOrchestrator. The orchestrator processes signals asynchronously
 * via the existing Queue/WorkerHost and invokes WorkflowEngine.transition()
 * for every state change.
 */
export interface WorkflowRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  workflowEngine: WorkflowEngine;
  /** WORK-017: convergence orchestrator (optional — present when wired). */
  orchestrator?: WorkflowOrchestrator;
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

  // --- WORK-017: Convergence routes ---

  // POST /work-items/:workItemId/workflow/converge — initiate the convergence loop.
  app.post('/work-items/:workItemId/workflow/converge', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write', projectId,
      });
      if (!deps.orchestrator) {
        return reply.code(501).send({ error: 'orchestrator-not-configured' });
      }
      const body = (req.body ?? {}) as {
        provider?: string;
        model?: string;
        agentProvider?: string;
        agentConfiguration?: Record<string, unknown>;
        agentInput?: string;
        task?: string;
      };
      const executionId = generateExecutionId();
      const signal = await deps.orchestrator.submitSignal({
        workItemId,
        signalType: 'initiate',
        sourceEventId: executionId,
        executionId,
        payload: body,
      });
      return reply.code(202).send({ signalId: signal.id, accepted: true });
    });
  });

  // POST /work-items/:workItemId/workflow/signals — submit a domain signal.
  app.post('/work-items/:workItemId/workflow/signals', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write', projectId,
      });
      if (!deps.orchestrator) {
        return reply.code(501).send({ error: 'orchestrator-not-configured' });
      }
      const body = req.body as {
        signalType?: SignalType;
        sourceEventId?: string;
        payload?: Record<string, unknown>;
      };
      if (!body?.signalType || !body?.sourceEventId) {
        return reply.code(400).send({ error: 'signalType and sourceEventId required' });
      }
      const executionId = generateExecutionId();
      const signal = await deps.orchestrator.submitSignal({
        workItemId,
        signalType: body.signalType,
        sourceEventId: body.sourceEventId,
        executionId,
        payload: body.payload ?? {},
      });
      return reply.code(202).send({ signalId: signal.id, accepted: true });
    });
  });

  // GET /work-items/:workItemId/workflow/convergence — inspect convergence status.
  app.get('/work-items/:workItemId/workflow/convergence', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      if (!deps.orchestrator) {
        return reply.code(501).send({ error: 'orchestrator-not-configured' });
      }
      const status = await deps.orchestrator.getConvergenceStatus(workItemId);
      return reply.code(200).send(status);
    });
  });
}
