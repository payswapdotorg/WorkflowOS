/**
 * WORK-046: Delegation routes — the bounded HTTP surface for multi-agent
 * delegation (COORDINATION, NOT AUTHORITY):
 *
 *   POST /projects/:projectId/work-items/:workItemId/delegation-plans
 *        — create-or-converge a delegation plan (idempotent by planKey)
 *   GET  /projects/:projectId/work-items/:workItemId/delegation-plans/:planKey
 *        — the structured plan state (for WORK-047)
 *   POST /projects/:projectId/work-items/:workItemId/delegation-plans/:planKey/drive
 *        — dispatch ready units + re-drive in-flight units (EXPLICIT — no
 *           scheduler; W046-AC12)
 *   POST /projects/:projectId/work-items/:workItemId/delegation-plans/:planKey/units/:unitKey/retry
 *        — retry a failed/unresolved unit (new attempt, stable identities)
 *   POST /projects/:projectId/work-items/:workItemId/delegation-plans/:planKey/interrupt
 *        — abandon the plan (pending units cancelled; in-flight executions
 *           untouched — the execution authority owns them)
 *
 * All routes are backend-authorized within the caller's project context
 * (project.read for reads; project.write for mutations). The Work Item must
 * belong to the project (server-side resolution — caller-controlled scope is
 * impossible by construction).
 *
 * Provider validation mirrors the EXISTING execution route exactly
 * (WORK-046 adds no provider-selection semantics of its own): native units
 * validate (provider, model) against the existing registry; external units
 * validate external-UI support. Delegation itself performs no routing.
 *
 * SECURITY: no route returns credentials, tokens, or packages (the external
 * package stays behind the existing one-time handoff token mechanism).
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type {
  DelegationCoordinator,
  DelegationPlanInput,
  DelegationPlanService,
  DelegationUnitSpec,
} from '../../delegation/index.js';
import { DelegationError } from '../../delegation/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

export interface DelegationRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  workItemRepository: WorkItemRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  delegationPlanService: DelegationPlanService;
  delegationCoordinator: DelegationCoordinator;
  /**
   * The EXISTING agent provider registry — used for provider validation
   * exactly like the existing execution route (no new selection semantics).
   */
  agentProviderRegistryService?: {
    isProviderConfigured(provider: string, model: string, projectId?: string): Promise<boolean>;
    isExternalProviderSupported(provider: string, projectId?: string): Promise<boolean>;
  };
}

/** Map the typed DelegationError code to an HTTP status (never parse strings). */
const ERROR_STATUS: Record<string, number> = {
  DELEGATION_WORK_ITEM_NOT_FOUND: 404,
  DELEGATION_PLAN_NOT_FOUND: 404,
  DELEGATION_UNIT_NOT_FOUND: 404,
  DELEGATION_UNKNOWN_ROLE: 400,
  DELEGATION_EMPTY_PLAN: 400,
  DELEGATION_DUPLICATE_UNIT_KEY: 400,
  DELEGATION_UNKNOWN_DEPENDENCY: 400,
  DELEGATION_DEPENDENCY_CYCLE: 400,
  DELEGATION_NATIVE_MODEL_REQUIRED: 400,
  DELEGATION_UNIT_NOT_RETRYABLE: 409,
  DELEGATION_PLAN_NOT_ACTIVE: 409,
};

function sendDelegationError(reply: { code: (n: number) => { send: (b: unknown) => void } }, err: unknown): void {
  if (err instanceof DelegationError) {
    const status = ERROR_STATUS[err.code] ?? 400;
    reply.code(status).send({ error: err.code.toLowerCase().replace(/^delegation_/, 'delegation-'), message: err.message });
    return;
  }
  reply.code(500).send({ error: 'delegation-internal-error', message: (err as Error).message });
}

export async function delegationRoutes(app: FastifyInstance, deps: DelegationRouteDeps): Promise<void> {
  /** Resolve the Work Item's project (server-side — callers cannot spoof scope). */
  const resolveProjectForWorkItem = async (
    workItemId: string,
  ): Promise<string | null> => {
    const wi = await deps.workItemRepository.findById(workItemId);
    if (!wi) return null;
    const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
    if (!version) return null;
    const arch = await deps.architectureRepository.findById(version.architectureId);
    return arch?.projectId ?? null;
  };

  // --- create-or-converge a delegation plan ---------------------------------

  app.post('/projects/:projectId/work-items/:workItemId/delegation-plans', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, workItemId } = req.params as { projectId: string; workItemId: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      if (!user) return;

      const actualProjectId = await resolveProjectForWorkItem(workItemId);
      if (!actualProjectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      if (actualProjectId !== projectId) {
        return reply.code(403).send({ error: 'work-item-not-in-project' });
      }

      const body = req.body as { planKey?: string; units?: unknown } | null;
      const planKey = body?.planKey;
      if (!planKey || typeof planKey !== 'string') {
        return reply.code(400).send({ error: 'plan-key-required' });
      }

      // Parse + validate the unit specs (structural shape; the service
      // validates roles/dependencies fail-closed).
      const rawUnits = body?.units;
      if (!Array.isArray(rawUnits) || rawUnits.length === 0) {
        return reply.code(400).send({ error: 'units-required', message: 'a delegation plan requires at least one unit' });
      }
      const units: DelegationUnitSpec[] = [];
      for (const raw of rawUnits) {
        const u = raw as Record<string, unknown>;
        const unitKey = typeof u.unitKey === 'string' ? u.unitKey : '';
        const role = typeof u.role === 'string' ? u.role : '';
        const mode = u.mode === 'external' ? 'external' : u.mode === 'native' ? 'native' : null;
        const provider = typeof u.provider === 'string' ? u.provider : '';
        if (!unitKey || !role || !mode || !provider) {
          return reply.code(400).send({
            error: 'invalid-unit',
            message: 'each unit requires unitKey, role, mode (native|external), and provider',
          });
        }
        units.push({
          unitKey,
          role: role as DelegationUnitSpec['role'],
          mode,
          provider,
          model: typeof u.model === 'string' && u.model ? u.model : null,
          dependsOn: Array.isArray(u.dependsOn) ? u.dependsOn.filter((d): d is string => typeof d === 'string') : [],
        });
      }

      // Provider validation — mirroring the EXISTING execution route (no
      // new selection semantics; delegation performs no routing).
      if (deps.agentProviderRegistryService) {
        for (const unit of units) {
          if (unit.mode === 'native') {
            if (!unit.model) {
              return reply.code(400).send({
                error: 'model-required',
                message: `native unit '${unit.unitKey}' requires a model`,
              });
            }
            const configured = await deps.agentProviderRegistryService.isProviderConfigured(
              unit.provider, unit.model, projectId,
            );
            if (!configured) {
              return reply.code(400).send({
                error: 'provider-not-configured',
                message: `Provider "${unit.provider}" with model "${unit.model}" (unit '${unit.unitKey}') is not configured.`,
              });
            }
          } else {
            const supported = await deps.agentProviderRegistryService.isExternalProviderSupported(
              unit.provider, projectId,
            );
            if (!supported) {
              return reply.code(400).send({
                error: 'external-provider-not-supported',
                message: `Provider "${unit.provider}" (unit '${unit.unitKey}') does not support external UI execution.`,
              });
            }
          }
        }
      }

      const input: DelegationPlanInput = { workItemId, planKey, units };
      try {
        const plan = await deps.delegationPlanService.createPlan(input);
        return reply.code(201).send({ plan: serializePlan(plan) });
      } catch (err) {
        return sendDelegationError(reply, err);
      }
    });
  });

  // --- read the structured plan state ---------------------------------------

  app.get('/projects/:projectId/work-items/:workItemId/delegation-plans/:planKey', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, workItemId, planKey } = req.params as {
        projectId: string; workItemId: string; planKey: string;
      };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;

      const actualProjectId = await resolveProjectForWorkItem(workItemId);
      if (!actualProjectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      if (actualProjectId !== projectId) {
        return reply.code(403).send({ error: 'work-item-not-in-project' });
      }

      const plan = await deps.delegationPlanService.getPlan(workItemId, planKey);
      if (!plan) {
        return reply.code(404).send({ error: 'delegation-plan-not-found' });
      }
      return { plan: serializePlan(plan) };
    });
  });

  // --- drive the plan (EXPLICIT — no scheduler) ------------------------------

  app.post('/projects/:projectId/work-items/:workItemId/delegation-plans/:planKey/drive', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, workItemId, planKey } = req.params as {
        projectId: string; workItemId: string; planKey: string;
      };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      if (!user) return;

      const actualProjectId = await resolveProjectForWorkItem(workItemId);
      if (!actualProjectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      if (actualProjectId !== projectId) {
        return reply.code(403).send({ error: 'work-item-not-in-project' });
      }

      try {
        const result = await deps.delegationCoordinator.drivePlan(workItemId, planKey);
        return { drive: result };
      } catch (err) {
        return sendDelegationError(reply, err);
      }
    });
  });

  // --- retry one unit ---------------------------------------------------------

  app.post('/projects/:projectId/work-items/:workItemId/delegation-plans/:planKey/units/:unitKey/retry', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, workItemId, planKey, unitKey } = req.params as {
        projectId: string; workItemId: string; planKey: string; unitKey: string;
      };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      if (!user) return;

      const actualProjectId = await resolveProjectForWorkItem(workItemId);
      if (!actualProjectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      if (actualProjectId !== projectId) {
        return reply.code(403).send({ error: 'work-item-not-in-project' });
      }

      try {
        const result = await deps.delegationCoordinator.retryUnit(workItemId, planKey, unitKey);
        return { unit: result };
      } catch (err) {
        return sendDelegationError(reply, err);
      }
    });
  });

  // --- interrupt the plan ------------------------------------------------------

  app.post('/projects/:projectId/work-items/:workItemId/delegation-plans/:planKey/interrupt', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, workItemId, planKey } = req.params as {
        projectId: string; workItemId: string; planKey: string;
      };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      if (!user) return;

      const actualProjectId = await resolveProjectForWorkItem(workItemId);
      if (!actualProjectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      if (actualProjectId !== projectId) {
        return reply.code(403).send({ error: 'work-item-not-in-project' });
      }

      try {
        const plan = await deps.delegationCoordinator.interruptPlan(workItemId, planKey);
        return { plan: serializePlan(plan) };
      } catch (err) {
        return sendDelegationError(reply, err);
      }
    });
  });
}

/** The wire shape of a plan (dates ISO; structured state for WORK-047). */
function serializePlan(plan: import('../../delegation/index.js').DelegationPlan): Record<string, unknown> {
  return {
    id: plan.id,
    workItemId: plan.workItemId,
    planKey: plan.planKey,
    status: plan.status,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    units: plan.units.map((u) => ({
      id: u.id,
      unitKey: u.unitKey,
      role: u.role,
      mode: u.mode,
      provider: u.provider,
      model: u.model,
      dependsOn: u.dependsOn,
      status: u.status,
      attemptCount: u.attemptCount,
      createdAt: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    })),
  };
}
