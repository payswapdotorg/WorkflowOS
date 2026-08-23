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
import type {
  LlmGateway,
  ArchitectService,
  ConversationalArchitectService,
  ArchitectSessionRepository,
} from '@modules/llm/index.js';
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
  conversationalArchitectService: ConversationalArchitectService;
  sessionRepository: ArchitectSessionRepository;
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
  // POST /projects/:projectId/architect/execute — existing WORK-014 route (unchanged).
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

  // POST /projects/:projectId/architect/generate-work-order — existing WORK-014 route (unchanged).
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
      if (!body?.architectureVersionId || !body?.task || !body?.provider || !body?.model) {
        return reply.code(400).send({ error: 'architectureVersionId, task, provider, and model required' });
      }
      const executionId = generateExecutionId();
      const archResult = await deps.architectService.execute({
        projectId,
        architectureVersionId: body.architectureVersionId,
        workItemId: body.workItemId,
        task: body.task,
        executionId,
        provider: body.provider,
        model: body.model,
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
  // WORK-025: Conversational Architect — delegates to ConversationalArchitectService.
  //
  // POST /projects/:projectId/architect/converse
  //
  // The route is THIN — it delegates to ConversationalArchitectService which:
  // - Assembles authoritative project context
  // - Calls the existing LlmGateway (NOT a second LLM implementation)
  // - Parses the response into a structured plan
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

      // Get or create the architect session.
      let session = await deps.sessionRepository.findActiveByProject(projectId);
      if (!session) {
        const providers = deps.conversationalArchitectService.getProviders();
        const provider = body.provider ?? providers[0]?.provider ?? 'zai';
        const model = body.model ?? providers[0]?.model ?? 'glm-4-flash';
        session = await deps.sessionRepository.create({ projectId, provider, model });
      }

      // Delegate to the service — it assembles context + calls LlmGateway.
      const result = await deps.conversationalArchitectService.converse({
        projectId,
        prompt: body.prompt,
        conversation: body.conversation?.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: new Date().toISOString(),
        })) ?? session.messages,
        provider: session.provider,
        model: session.model,
      });

      // Save the revision (immutable history entry).
      await deps.sessionRepository.saveRevision({
        sessionId: session.id,
        revisionNumber: session.revisionCount + 1,
        userPrompt: body.prompt,
        architectResponse: result.content,
        parsedPlan: result.parsedPlan,
      });

      // Update the session messages + parsed plan.
      const newMessages = [
        ...session.messages,
        { role: 'user' as const, content: body.prompt, timestamp: new Date().toISOString() },
        { role: 'assistant' as const, content: result.content, timestamp: new Date().toISOString() },
      ];
      await deps.sessionRepository.updateMessages(session.id, newMessages, result.parsedPlan);

      return reply.code(200).send({
        sessionId: session.id,
        executionId: result.executionId,
        content: result.content,
        parsed: result.parsedPlan,
        usage: result.usage,
        revisionNumber: session.revisionCount + 1,
      });
    });
  });

  // -----------------------------------------------------------------------
  // WORK-025: Apply generated architecture — persists structured artifacts
  // through existing domain services. Includes Work Item → Requirement/Criterion
  // associations (explicit, NOT all-to-all) + Work Orders.
  //
  // POST /projects/:projectId/architect/apply
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
          requirementIds?: string[];
          criterionIds?: string[];
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
      const createdCriteria: Array<{ id: string; criterionId: string; requirementId: string }> = [];
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
              createdCriteria.push({ id: createdCrit.id, criterionId: crit.criterionId, requirementId: req.requirementId });
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

      // 5. Associate Work Items with Requirements + Criteria (EXPLICIT, not all-to-all).
      //    Each Work Item specifies which requirementIds and criterionIds it implements.
      for (const wi of body.workItems ?? []) {
        const workItem = createdWorkItems.find(c => c.workItemId === wi.workItemId);
        if (!workItem) continue;

        // Associate only the specified requirements.
        for (const reqId of wi.requirementIds ?? []) {
          const req = createdReqs.find(r => r.requirementId === reqId);
          if (req) {
            try {
              await deps.workItemRequirementRepository.associate(workItem.id, req.id);
            } catch {
              // Association may already exist — ignore.
            }
          }
        }

        // Associate only the specified criteria.
        for (const critId of wi.criterionIds ?? []) {
          const crit = createdCriteria.find(c => c.criterionId === critId);
          if (crit) {
            try {
              await deps.workItemCriterionRepository.associate(workItem.id, crit.id);
            } catch {
              // Association may already exist — ignore.
            }
          }
        }
      }

      // 6. Create dependencies through the existing WorkItemDependencyRepository.
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

      // 7. Create Work Orders through the existing WorkOrderRepository.
      const createdWorkOrders: Array<{ id: string; workItemId: string }> = [];
      for (const wi of createdWorkItems) {
        try {
          const wo = await deps.workOrderRepository.create({
            workItemId: wi.id,
            projectId,
            architectureVersionId: version.id,
            scope: body.workItems?.find(b => b.workItemId === wi.workItemId)?.objective,
          });
          createdWorkOrders.push({ id: wo.id, workItemId: wi.workItemId });
        } catch {
          // Work Order creation may fail if one already exists — ignore.
        }
      }

      // 8. Mark the architect session as accepted.
      const session = await deps.sessionRepository.findActiveByProject(projectId);
      if (session) {
        await deps.sessionRepository.markAccepted(session.id);
      }

      return reply.code(201).send({
        architectureId: arch.id,
        architectureVersionId: version.id,
        requirements: createdReqs,
        criteria: createdCriteria,
        workItems: createdWorkItems,
        workOrders: createdWorkOrders,
      });
    });
  });

  // -----------------------------------------------------------------------
  // WORK-025: Provider configuration — delegates to ConversationalArchitectService.
  // No secrets exposed. The service checks readiness through the SecretStore boundary.
  // -----------------------------------------------------------------------
  app.get('/projects/:projectId/architect/providers', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      // Delegate to the service — no process.env access in the route.
      const providers = deps.conversationalArchitectService.getProviders();
      return reply.code(200).send({ providers });
    });
  });

  // -----------------------------------------------------------------------
  // WORK-025: Architect session — delegates to ArchitectSessionRepository.
  // The route does NOT query wfos_architect_sessions directly.
  // -----------------------------------------------------------------------
  app.get('/projects/:projectId/architect/session', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      const session = await deps.sessionRepository.findActiveByProject(projectId);
      const revisions = session ? await deps.sessionRepository.listRevisions(session.id) : [];
      return reply.code(200).send({ session, revisions });
    });
  });

  app.get('/projects/:projectId/architect/revisions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      const session = await deps.sessionRepository.findActiveByProject(projectId);
      if (!session) {
        return reply.code(200).send({ revisions: [] });
      }
      const revisions = await deps.sessionRepository.listRevisions(session.id);
      return reply.code(200).send({ revisions });
    });
  });
}
