import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type {
  WorkItemRepository,
  WorkOrderRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
  WorkItemDependencyRepository,
} from '@modules/work-items/index.js';
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
  workItemRequirementRepository: WorkItemRequirementRepository;
  workItemCriterionRepository: WorkItemCriterionRepository;
  workItemDependencyRepository: WorkItemDependencyRepository;
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
      const createdCriteria: Array<{ id: string; criterionId: string }> = [];
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
              const createdCrit = await deps.acceptanceCriterionRepository.create({
                requirementId: created.id,
                criterionId: crit.criterionId,
                description: crit.description,
              });
              createdCriteria.push({ id: createdCrit.id, criterionId: crit.criterionId });
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

      // 5. Associate Work Items with Requirements + Criteria through the
      //    existing /work-items repository contracts (NOT raw SQL).
      //    Each generated Work Item is associated with ALL generated requirements
      //    and criteria (they all belong to the same architecture version).
      for (const wi of createdWorkItems) {
        for (const req of createdReqs) {
          try {
            await deps.workItemRequirementRepository.associate(wi.id, req.id);
          } catch {
            // Association may already exist — ignore.
          }
        }
        for (const crit of createdCriteria) {
          try {
            await deps.workItemCriterionRepository.associate(wi.id, crit.id);
          } catch {
            // Association may already exist — ignore.
          }
        }
      }

      // 6. Create dependencies through the existing WorkItemDependencyRepository
      //    contract (NOT raw SQL). This preserves the /work-items authority boundary.
      if (body.workItems) {
        for (const wi of body.workItems) {
          if (wi.dependencies) {
            const source = createdWorkItems.find(c => c.workItemId === wi.workItemId);
            if (!source) continue;
            for (const depId of wi.dependencies) {
              const target = createdWorkItems.find(c => c.workItemId === depId);
              if (target) {
                try {
                  await deps.workItemDependencyRepository.add(source.id, target.id);
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
        criteria: createdCriteria,
        workItems: createdWorkItems,
      });
    });
  });

  // -----------------------------------------------------------------------
  // WORK-025: Provider configuration — returns available LLM/agent providers
  // without exposing secrets. The frontend uses this to show provider
  // readiness and let the user select a provider/model.
  // -----------------------------------------------------------------------
  app.get('/projects/:projectId/architect/providers', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      // Return configured providers based on environment.
      // The actual secrets (API keys) stay server-side — only the
      // provider name, model, and readiness are returned.
      const providers: Array<{
        name: string;
        provider: string;
        model: string;
        status: 'ready' | 'not-configured';
      }> = [];
      // Check if LLM_API_KEY is configured.
      const llmKey = process.env.LLM_API_KEY;
      const llmProvider = process.env.LLM_PROVIDER_NAME ?? 'openai-compatible';
      const llmModel = process.env.LLM_DEFAULT_MODEL ?? 'gpt-4o';
      if (llmKey) {
        providers.push({
          name: llmProvider,
          provider: llmProvider,
          model: llmModel,
          status: 'ready',
        });
      } else {
        providers.push({
          name: 'No provider configured',
          provider: 'none',
          model: '',
          status: 'not-configured',
        });
      }
      return reply.code(200).send({ providers });
    });
  });

  // -----------------------------------------------------------------------
  // WORK-025: Architect conversation persistence.
  //
  // GET /projects/:projectId/architect/session
  // Returns the active architect session (messages + last parsed plan).
  //
  // PUT /projects/:projectId/architect/session
  // Updates the session (appends a message, updates the parsed plan).
  // -----------------------------------------------------------------------
  app.get('/projects/:projectId/architect/session', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      const result = await deps.db.query(
        'SELECT id, messages, parsed_plan, revision_count, provider, model, status, created_at, updated_at FROM wfos_architect_sessions WHERE project_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
        [projectId, 'active'],
      );
      if (result.rows.length === 0) {
        return reply.code(200).send({ session: null });
      }
      return reply.code(200).send({ session: result.rows[0] });
    });
  });

  app.put('/projects/:projectId/architect/session', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write', projectId,
      });
      const body = req.body as {
        messages?: Array<{ role: string; content: string }>;
        parsedPlan?: Record<string, unknown>;
        provider?: string;
        model?: string;
      };
      // Find or create an active session.
      const existing = await deps.db.query(
        'SELECT id FROM wfos_architect_sessions WHERE project_id = $1 AND status = $2',
        [projectId, 'active'],
      );
      if (existing.rows.length > 0) {
        const sessionId = existing.rows[0]!.id;
        await deps.db.query(
          `UPDATE wfos_architect_sessions
           SET messages = $1, parsed_plan = $2, provider = $3, model = $4,
               revision_count = revision_count + 1, updated_at = NOW()
           WHERE id = $5`,
          [
            JSON.stringify(body.messages ?? []),
            body.parsedPlan ? JSON.stringify(body.parsedPlan) : null,
            body.provider ?? '',
            body.model ?? '',
            sessionId,
          ],
        );
        return reply.code(200).send({ sessionId });
      } else {
        const result = await deps.db.query(
          `INSERT INTO wfos_architect_sessions (project_id, messages, parsed_plan, provider, model)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            projectId,
            JSON.stringify(body.messages ?? []),
            body.parsedPlan ? JSON.stringify(body.parsedPlan) : null,
            body.provider ?? '',
            body.model ?? '',
          ],
        );
        return reply.code(201).send({ sessionId: result.rows[0]!.id });
      }
    });
  });
}
