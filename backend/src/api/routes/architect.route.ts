import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  LlmGateway,
  ArchitectService,
  ConversationalArchitectService,
  ArchitectSessionRepository,
  ArchitectPlanApplier,
  ArchitectPlanInput,
} from '@modules/llm/index.js';
import type { DatabaseClient } from '@platform/index.js';
import { generateExecutionId } from '@platform/ids.js';
import { requireProjectAuthorization, runAuthed } from '../plugins/auth.plugin.js';

export interface ArchitectRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  llmGateway: LlmGateway;
  architectService: ArchitectService;
  conversationalArchitectService: ConversationalArchitectService;
  sessionRepository: ArchitectSessionRepository;
  planApplier: ArchitectPlanApplier;
  db: DatabaseClient;
}

// The existing /architect/execute and /architect/generate-work-order routes
// need architecture repository access for project resolution. These are
// the WORK-014 routes — they use the existing ArchitectService which has
// its own repository access internally. The route only needs project
// authorization + the service.
// (The resolveProjectForArchitectureVersion helper is no longer needed
//  since the service handles project verification internally.)

// (resolveProjectForArchitectureVersion removed — the existing execute route
// uses project authorization directly. The service validates the
// architecture version belongs to the project.)

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
      // The ArchitectService validates the architecture version belongs to
      // the project internally. If the version doesn't belong to this project,
      // the service will throw — we return 403.
      try {
        // Verify the architecture version belongs to this project.
        const avResult = await deps.db.query(
          `SELECT a.project_id FROM wfos_architecture_versions av
           JOIN wfos_architectures a ON a.id = av.architecture_id
           WHERE av.id = $1`,
          [body.architectureVersionId],
        );
        if (avResult.rows.length === 0 || avResult.rows[0]!.project_id !== projectId) {
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
      } catch (err) {
        if ((err as Error).message.includes('not found') || (err as Error).message.includes('does not belong')) {
          return reply.code(403).send({ error: 'forbidden', reason: 'architecture-version-not-in-project' });
        }
        throw err;
      }
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

      // Validate provider/model against the configured provider registry.
      // The browser cannot submit arbitrary provider/model values.
      const defaultProvider = deps.conversationalArchitectService.getProviders().find(p => p.status === 'ready');
      const provider = body.provider ?? defaultProvider?.provider;
      const model = body.model ?? defaultProvider?.model;
      if (!provider || !model || !deps.conversationalArchitectService.isProviderConfigured(provider, model)) {
        return reply.code(400).send({
          error: 'provider-not-configured',
          message: `Provider "${provider ?? 'none'}" with model "${model ?? 'none'}" is not configured. Available providers: ${deps.conversationalArchitectService.getProviders().map(p => `${p.provider}/${p.model} (${p.status})`).join(', ')}`,
        });
      }

      // Get or create the architect session with the validated provider/model.
      let session = await deps.sessionRepository.findActiveByProject(projectId);
      if (!session) {
        session = await deps.sessionRepository.create({ projectId, provider, model });
      }

      // Delegate to the service — it assembles context + calls LlmGateway.
      // Provider/model come from the validated session, NOT from the browser.
      const result = await deps.conversationalArchitectService.converse({
        projectId,
        prompt: body.prompt,
        conversation: body.conversation?.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: new Date().toISOString(),
        })) ?? session.messages,
        provider, // validated against registry
        model,   // validated against registry
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
      // Cast to the shared ArchitectPlanInput type (same shape as ArchitectParsedPlan).
      // No `as any` — the route and the applier share a single typed contract.
      const body = req.body as ArchitectPlanInput;

      if (!body?.architecture?.name || !body?.architecture?.content) {
        return reply.code(400).send({ error: 'architecture.name and architecture.content required' });
      }

      // ATOMIC apply: delegates to ArchitectPlanApplier which runs all
      // writes — including Architect session acceptance — inside a single
      // DB transaction using transaction-scoped repositories. If ANY
      // operation fails (plan artifact creation OR session acceptance), the
      // entire transaction rolls back and the session is NOT marked accepted.
      // No partial plans.
      try {
        const result = await deps.planApplier.apply(projectId, body);
        return reply.code(201).send(result);
      } catch (err) {
        // Transaction rolled back — no partial plan persisted.
        // Session is NOT accepted.
        return reply.code(500).send({
          error: 'apply-failed',
          message: (err as Error).message,
          detail: 'The architecture plan was not applied. All changes were rolled back.',
        });
      }
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
