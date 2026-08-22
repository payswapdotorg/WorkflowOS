import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { AgentGateway, AgentRunRepository } from '@modules/agents/index.js';
import type { Queue } from '@platform/index.js';
import { generateExecutionId } from '@platform/ids.js';
import { requireProjectAuthorization, runAuthed } from '../plugins/auth.plugin.js';

export interface AgentRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  agentGateway: AgentGateway;
  agentRunRepository: AgentRunRepository;
  queue: Queue;
}

async function resolveProjectForWorkItem(deps: AgentRouteDeps, workItemId: string): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

export async function agentRoutes(app: FastifyInstance, deps: AgentRouteDeps): Promise<void> {
  // POST /work-items/:workItemId/agent-runs — create + enqueue async.
  app.post('/work-items/:workItemId/agent-runs', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, { permission: 'project.write', projectId });
      const body = req.body as {
        provider?: string; configuration?: Record<string, unknown>;
        workOrderId?: string; repositoryRef?: string; branch?: string; input?: string;
      };
      if (!body?.provider || !body?.input || !body?.workOrderId) {
        return reply.code(400).send({ error: 'provider, input, and workOrderId required' });
      }
      const executionId = generateExecutionId();
      // Enqueue async execution (does NOT block the request).
      // The gateway's execute() method creates the Agent Run record.
      await deps.queue.enqueue('agent.execute', {
        provider: body.provider, configuration: body.configuration ?? {},
        workItemId, workOrderId: body.workOrderId,
        architectureVersionId: undefined,
        executionId, repositoryRef: body.repositoryRef, branch: body.branch,
        input: body.input,
      }, { executionId });
      return reply.code(202).send({ accepted: true, executionId });
    });
  });

  // GET /work-items/:workItemId/agent-runs — list runs for a work item.
  app.get('/work-items/:workItemId/agent-runs', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId });
      const runs = await deps.agentRunRepository.findByWorkItem(workItemId);
      return { agentRuns: runs };
    });
  });

  // GET /agent-runs/:runId — retrieve a single Agent Run.
  app.get('/agent-runs/:runId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { runId } = req.params as { runId: string };
      const run = await deps.agentRunRepository.findById(runId);
      if (!run) return reply.code(404).send({ error: 'not-found' });
      const projectId = await resolveProjectForWorkItem(deps, run.workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId });
      return run;
    });
  });
}
