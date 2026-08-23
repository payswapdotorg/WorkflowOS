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

  // -----------------------------------------------------------------------
  // WORK-025: Conversational Architect — generate architecture from natural language.
  //
  // POST /projects/:projectId/architect/converse
  //
  // Takes a user prompt + optional conversation history and returns a structured
  // architecture proposal. The LLM is instructed to return JSON with:
  //   architecture, requirements, criteria, workItems, dependencies
  //
  // This does NOT persist anything — the user reviews the proposal and then
  // calls /architect/apply to persist the real domain objects.
  // -----------------------------------------------------------------------
  app.post('/projects/:projectId/architect/converse', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write', projectId,
      });
      const body = req.body as {
        prompt?: string;
        conversation?: Array<{ role: 'user' | 'assistant'; content: string }>;
        provider?: string;
        model?: string;
      };
      if (!body?.prompt) {
        return reply.code(400).send({ error: 'prompt required' });
      }
      const provider = body.provider ?? 'zai';
      const model = body.model ?? 'glm-4-flash';
      const executionId = generateExecutionId();

      // Build the system prompt that instructs the LLM to return structured JSON.
      const systemPrompt = `You are the WorkflowOS Architect. The user describes a software system they want to build. You generate a structured architecture proposal as JSON.

Return ONLY valid JSON with this exact shape:
{
  "architecture": { "name": "...", "content": "...", "constraints": ["..."] },
  "requirements": [{ "requirementId": "REQ-001", "title": "...", "description": "...", "criteria": [{ "criterionId": "AC-001", "description": "..." }] }],
  "workItems": [{ "workItemId": "WORK-001", "title": "...", "objective": "...", "scope": "...", "dependencies": [] }],
  "summary": "Brief summary of the architecture"
}

Rules:
- PostgreSQL is authoritative. Redis is non-authoritative.
- The frontend is a consumer, never an authority.
- Use modular monolith architecture unless the user specifies otherwise.
- Generate 3-8 requirements with 1-3 criteria each.
- Generate 2-6 work items with clear objectives.
- Include dependency references between work items where relevant.
- Be concise but complete.`;

      // Build the messages array — include conversation history if provided.
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt },
      ];
      if (body.conversation) {
        for (const msg of body.conversation) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
      messages.push({ role: 'user', content: body.prompt });

      // Call the LLM gateway.
      try {
        const result = await deps.llmGateway.generate({
          provider,
          model,
          messages,
          executionId,
          metadata: { projectId },
        });

        // Try to parse the response as JSON.
        let parsed: Record<string, unknown> | null = null;
        try {
          // Extract JSON from the response (it may be wrapped in markdown).
          const jsonMatch = result.content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          }
        } catch {
          // If parsing fails, return the raw content.
        }

        return reply.code(200).send({
          executionId,
          content: result.content,
          parsed,
          usage: result.usage,
        });
      } catch (err) {
        return reply.code(502).send({
          error: 'architect-llm-failed',
          message: (err as Error).message,
        });
      }
    });
  });

  // -----------------------------------------------------------------------
  // WORK-025: Apply generated architecture — persist structured artifacts.
  //
  // POST /projects/:projectId/architect/apply
  //
  // Takes the generated architecture/requirements/criteria/work items and
  // persists them through the existing domain services. This creates:
  //   - Architecture + ArchitectureVersion (DRAFT)
  //   - Requirements + Acceptance Criteria
  //   - Work Items
  //
  // Does NOT freeze — the user must explicitly freeze afterwards.
  // -----------------------------------------------------------------------
  app.post('/projects/:projectId/architect/apply', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write', projectId,
      });
      const body = req.body as {
        architecture?: { name: string; content: string; constraints?: string[] };
        requirements?: Array<{
          requirementId: string;
          title: string;
          description?: string;
          criteria?: Array<{ criterionId: string; description: string }>;
        }>;
        workItems?: Array<{
          workItemId: string;
          title: string;
          objective?: string;
          scope?: string;
          dependencies?: string[];
        }>;
      };

      if (!body?.architecture?.name || !body?.architecture?.content) {
        return reply.code(400).send({ error: 'architecture.name and architecture.content required' });
      }

      // 1. Create Architecture
      const arch = await deps.architectureRepository.create({
        projectId,
        name: body.architecture.name,
      });

      // 2. Create Architecture Version (DRAFT)
      const version = await deps.architectureVersionRepository.create({
        architectureId: arch.id,
        contentInline: body.architecture.content,
      });

      // 3. Create Requirements + Criteria
      const createdReqs: Array<{ id: string; requirementId: string }> = [];
      if (body.requirements) {
        for (const req of body.requirements) {
          const created = await deps.requirementRepository.create({
            architectureVersionId: version.id,
            requirementId: req.requirementId,
            title: req.title,
            description: req.description ?? undefined,
          });
          createdReqs.push({ id: created.id, requirementId: req.requirementId });

          if (req.criteria) {
            for (const crit of req.criteria) {
              await deps.acceptanceCriterionRepository.create({
                requirementId: created.id,
                criterionId: crit.criterionId,
                description: crit.description,
              });
            }
          }
        }
      }

      // 4. Create Work Items
      const createdWorkItems: Array<{ id: string; workItemId: string }> = [];
      if (body.workItems) {
        for (const wi of body.workItems) {
          const created = await deps.workItemRepository.create({
            architectureVersionId: version.id,
            workItemId: wi.workItemId,
            title: wi.title,
            objective: wi.objective,
            scope: wi.scope,
          });
          createdWorkItems.push({ id: created.id, workItemId: wi.workItemId });
        }
      }

      // 5. Create dependencies via DB (the work-items dependency route requires
      // auth context — here we use the DB directly since we're already authorized).
      if (body.workItems) {
        for (const wi of body.workItems) {
          if (wi.dependencies) {
            const source = createdWorkItems.find(c => c.workItemId === wi.workItemId);
            if (!source) continue;
            for (const depId of wi.dependencies) {
              const target = createdWorkItems.find(c => c.workItemId === depId);
              if (target) {
                try {
                  await deps.db.query(
                    'INSERT INTO wfos_work_item_dependencies (work_item_id, depends_on_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [source.id, target.id],
                  );
                } catch {
                  // Dependency may already exist — ignore.
                }
              }
            }
          }
        }
      }

      return reply.code(201).send({
        architectureId: arch.id,
        architectureVersionId: version.id,
        requirements: createdReqs,
        workItems: createdWorkItems,
      });
    });
  });
}
