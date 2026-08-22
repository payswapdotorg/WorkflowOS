import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { LlmGateway, LlmExecutionRecordRepository } from '@modules/llm/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';
import { generateExecutionId } from '@platform/ids.js';

export interface LlmRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  llmGateway: LlmGateway;
  executionRecordRepository: LlmExecutionRecordRepository;
}

async function resolveProjectForWorkItem(
  deps: LlmRouteDeps,
  workItemId: string,
): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

export async function llmRoutes(app: FastifyInstance, deps: LlmRouteDeps): Promise<void> {
  const recordRepo = deps.executionRecordRepository;

  // POST /work-items/:workItemId/llm/generate — invoke the LLM gateway.
  app.post('/work-items/:workItemId/llm/generate', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        provider?: string;
        model?: string;
        messages?: { role: string; content: string }[];
        systemInstruction?: string;
        maxTokens?: number;
        temperature?: number;
      };
      if (!body?.provider || !body?.model || !body?.messages) {
        return reply.code(400).send({ error: 'provider, model, and messages required' });
      }
      const executionId = generateExecutionId();
      try {
        const response = await deps.llmGateway.generate({
          provider: body.provider,
          model: body.model,
          messages: body.messages as never,
          systemInstruction: body.systemInstruction,
          maxTokens: body.maxTokens,
          temperature: body.temperature,
          executionId,
          workItemId,
        });
        return reply.code(200).send(response);
      } catch (err) {
        return reply.code(502).send({ error: 'llm-failed', detail: (err as Error).message });
      }
    });
  });

  // GET /work-items/:workItemId/llm/executions — list LLM execution records.
  app.get('/work-items/:workItemId/llm/executions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const records = await recordRepo.findByWorkItem(workItemId);
      return { executions: records };
    });
  });
}
