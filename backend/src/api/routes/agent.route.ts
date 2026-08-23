import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type {
  AgentGateway,
  AgentRunRepository,
  AgentProviderConfig,
  AgentProviderConfigRepository,
  AgentProviderConfigRecord,
  ExecutionProviderInfo,
} from '@modules/agents/index.js';
import type { Queue } from '@platform/index.js';
import { generateExecutionId } from '@platform/ids.js';
import { requireProjectAuthorization, requireUser, runAuthed } from '../plugins/auth.plugin.js';

/**
 * Structural type satisfied by `DefaultAgentProviderRegistryService`
 * (constructed by the composition root in app.ts). Declared locally so this
 * route file does not import from `/agents/internal/` (PLAT-AC-02 forbids
 * API-layer imports of any module's `internal/` directory). TypeScript
 * structural typing makes the concrete impl assignable to this interface.
 */
export interface AgentProviderRegistryService {
  getProviders(projectId?: string): Promise<AgentProviderConfig[]>;
  isProviderConfigured(
    provider: string,
    model: string,
    projectId?: string,
  ): Promise<boolean>;
  /** WORK-027: execution capability surface (native readiness + external UI). */
  getExecutionProviders(projectId?: string): Promise<ExecutionProviderInfo[]>;
  isExternalProviderSupported(provider: string, projectId?: string): Promise<boolean>;
}

export interface AgentRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  agentGateway: AgentGateway;
  agentRunRepository: AgentRunRepository;
  queue: Queue;
  /**
   * WORK-026: provider registry service (platform-level + per-project).
   * When absent, the /agents/providers and /projects/:id/agents/providers
   * routes are not registered (preserves existing test wiring).
   */
  agentProviderRegistryService?: AgentProviderRegistryService;
  /**
   * WORK-026: per-project provider config repository.
   * When absent, the POST /projects/:id/agents/providers route is not
   * registered.
   */
  agentProviderConfigRepository?: AgentProviderConfigRepository;
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

  // -----------------------------------------------------------------------
  // WORK-026 (SUB-F): Agent provider registry routes.
  // -----------------------------------------------------------------------

  // GET /agents/providers — global agent providers (no project auth needed,
  // but require auth). Returns the platform-level readiness list (env-var
  // backed). Secret values never surface — only readiness flags.
  if (deps.agentProviderRegistryService) {
    app.get('/agents/providers', async (req, reply) => {
      return runAuthed(req, async () => {
        // Require authentication (returns the user — throws if absent).
        await requireUser(req, reply);
        const providers = await deps.agentProviderRegistryService!.getProviders();
        return reply.code(200).send({ providers });
      });
    });

    // GET /projects/:projectId/agents/providers — project-specific providers
    // (project.read). Returns the per-project overrides (or the platform
    // list when no overrides are configured for this project).
    app.get('/projects/:projectId/agents/providers', async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId } = req.params as { projectId: string };
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.read',
          projectId,
        });
        const providers = await deps.agentProviderRegistryService!.getProviders(
          projectId,
        );
        return reply.code(200).send({ providers });
      });
    });

    // WORK-027: GET /agents/execution-providers — execution capability list
    // (native API readiness + external UI availability per provider).
    // Readiness metadata only — never secrets. Safe for frontend display.
    app.get('/agents/execution-providers', async (req, reply) => {
      return runAuthed(req, async () => {
        await requireUser(req, reply);
        const providers = await deps.agentProviderRegistryService!.getExecutionProviders();
        return reply.code(200).send({ providers });
      });
    });

    // WORK-027: GET /projects/:projectId/agents/execution-providers —
    // project-scoped execution capability list (project.read).
    app.get('/projects/:projectId/agents/execution-providers', async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId } = req.params as { projectId: string };
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.read',
          projectId,
        });
        const providers = await deps.agentProviderRegistryService!.getExecutionProviders(
          projectId,
        );
        return reply.code(200).send({ providers });
      });
    });

    // POST /projects/:projectId/agents/providers — create a project-specific
    // provider config (project.admin). Body:
    //   { provider, model, secretRef, metadata?, isDefault? }
    //
    // The `secretRef` is the NAME of the SecretStore ref (e.g. env var name),
    // NOT the secret value. The actual secret lives in EnvSecretStore or a
    // future Vault-backed SecretStore (SEC-001). The route NEVER accepts the
    // secret value in the request body.
    if (deps.agentProviderConfigRepository) {
      app.post('/projects/:projectId/agents/providers', async (req, reply) => {
        return runAuthed(req, async () => {
          const { projectId } = req.params as { projectId: string };
          await requireProjectAuthorization(req, reply, deps, {
            permission: 'project.admin',
            projectId,
          });
          const body = req.body as {
            provider?: string;
            model?: string;
            secretRef?: string;
            metadata?: Record<string, unknown>;
            isDefault?: boolean;
          };
          if (!body?.provider || !body?.model || !body?.secretRef) {
            return reply.code(400).send({
              error: 'provider, model, and secretRef required',
            });
          }
          const project = await deps.projectRepository.findById(projectId);
          if (!project) {
            return reply.code(404).send({ error: 'project-not-found' });
          }
          const record: AgentProviderConfigRecord =
            await deps.agentProviderConfigRepository!.create({
              projectId,
              provider: body.provider,
              model: body.model,
              secretRef: body.secretRef,
              metadata: body.metadata,
              isDefault: body.isDefault,
            });
          return reply.code(201).send(record);
        });
      });
    }
  }
}
