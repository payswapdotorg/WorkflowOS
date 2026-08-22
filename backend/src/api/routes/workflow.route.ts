import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { WorkflowEngine, WorkflowState, TransitionRequest, WorkflowOrchestrator } from '@modules/workflows/index.js';
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
  //
  // This is the ONLY client-facing convergence operation. It starts the loop
  // (DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN) but does NOT forge
  // any trusted domain outcome. All downstream transitions (verification pass,
  // review approve, PR merge) require trusted INTERNAL signals that validate
  // against persisted authoritative domain records — NOT client-submitted signals.
  //
  // The public generic signal endpoint (POST /signals) was REMOVED in the
  // PR #16 correction: it allowed a project writer to forge trusted outcomes
  // (e.g. review_finalized with outcome:APPROVE) and advance canonical workflow
  // state without the underlying event occurring.
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
      const signal = await deps.orchestrator.initiateConvergence({
        workItemId,
        sourceEventId: executionId,
        executionId,
        payload: body,
      });
      return reply.code(202).send({ signalId: signal.id, accepted: true });
    });
  });

  // POST /work-items/:workItemId/workflow/begin-verification — begin verification (WORK-018).
  // Transitions PR_OPEN → VERIFYING + creates a VerificationRun. Does NOT accept
  // verification outcomes — the result comes from the persisted VerificationRun.
  app.post('/work-items/:workItemId/workflow/begin-verification', async (req, reply) => {
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
      const executionId = generateExecutionId();
      const result = await deps.orchestrator.beginVerification({
        workItemId, executionId, sourceEventId: executionId,
      });
      return reply.code(202).send({
        signalId: result.signal.id, accepted: true,
        verificationRunId: result.verificationRunId,
      });
    });
  });

  // POST /work-items/:workItemId/workflow/begin-architect-review — begin architect review (WORK-018).
  // Invokes ArchitectService + creates + finalizes Review + drives workflow transition.
  // Does NOT accept review outcomes — the verdict comes from the authoritative ArchitectExecutionResult.
  app.post('/work-items/:workItemId/workflow/begin-architect-review', async (req, reply) => {
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
      const body = (req.body ?? {}) as { provider?: string; model?: string; task?: string };
      const executionId = generateExecutionId();
      const result = await deps.orchestrator.beginArchitectReview({
        workItemId, executionId, sourceEventId: executionId,
        provider: body.provider, model: body.model, task: body.task,
      });
      return reply.code(202).send({
        signalId: result.signal.id, accepted: true,
        reviewId: result.reviewId,
      });
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

  // --- WORK-019: Merge gating + advancement routes ---

  // POST /work-items/:workItemId/workflow/request-merge — request merge (WORK-019).
  // Validates all merge gates. Does NOT set MERGED — that happens via the
  // pull_request_merged signal (triggered by authoritative GitHub webhook).
  app.post('/work-items/:workItemId/workflow/request-merge', async (req, reply) => {
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
      const executionId = generateExecutionId();
      const result = await deps.orchestrator.requestMerge({
        workItemId, executionId, sourceEventId: executionId,
      });
      return reply.code(202).send({
        signalId: result.signal.id, accepted: true,
        mergeReady: result.mergeReady, gates: result.gates,
      });
    });
  });

  // GET /work-items/:workItemId/workflow/merge-readiness — inspect merge readiness (WORK-019).
  app.get('/work-items/:workItemId/workflow/merge-readiness', async (req, reply) => {
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
      const gates = await deps.orchestrator.inspectMergeReadiness(workItemId);
      return reply.code(200).send(gates);
    });
  });

  // POST /work-items/:workItemId/workflow/advance-to-verified — advance MERGED → VERIFIED (WORK-019).
  app.post('/work-items/:workItemId/workflow/advance-to-verified', async (req, reply) => {
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
      const executionId = generateExecutionId();
      const result = await deps.orchestrator.advanceToVerified({
        workItemId, executionId, sourceEventId: executionId,
      });
      return reply.code(202).send({
        signalId: result.signal.id, accepted: true,
        verified: result.verified, reason: result.reason,
      });
    });
  });

  // GET /projects/:projectId/workflow/next-work-item — select next eligible Work Item (WORK-019).
  app.get('/projects/:projectId/workflow/next-work-item', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      if (!deps.orchestrator) {
        return reply.code(501).send({ error: 'orchestrator-not-configured' });
      }
      const nextWorkItemId = await deps.orchestrator.selectNextWorkItem(projectId);
      return reply.code(200).send({ nextWorkItemId });
    });
  });
}
