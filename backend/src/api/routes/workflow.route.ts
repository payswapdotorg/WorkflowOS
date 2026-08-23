import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type {
  WorkItemRepository,
  ImplementationContextBuilder,
} from '@modules/work-items/index.js';
import type { WorkflowEngine, WorkflowState, TransitionRequest, WorkflowOrchestrator } from '@modules/workflows/index.js';
import { generateExecutionId } from '@platform/ids.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * Required start-implementation service — submits the persisted
 * ImplementationContext to the AgentGateway and returns the agent run id.
 *
 * In PRODUCTION composition (app.ts + index.ts), this MUST be wired — there
 * is NO production no-op path that returns success without an AgentRun.
 * The service is optional only in isolated test fixtures that construct
 * WorkflowRouteDeps directly without the production wiring.
 *
 * The route handler treats absence as a 503 'service-unavailable' error
 * (NOT a silent success) so production misconfiguration fails loudly.
 */
export interface StartImplementationService {
  start(input: {
    workItemId: string;
    implementationContextId: string;
    implementationContextRevision: number;
    implementationContextKind: 'initial' | 'correction';
    executionId: string;
    provider: string;
    model: string;
  }): Promise<{
    agentRunId: string;
    executionId: string;
  }>;
}

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
  /** WORK-026: builds + persists the ImplementationContext revision. */
  implementationContextBuilder?: ImplementationContextBuilder;
  /**
   * WORK-026: submits the persisted context to the AgentGateway. In PRODUCTION
   * composition (app.ts + index.ts), this MUST be wired — there is no
   * production no-op path. The route returns 503 if absent.
   */
  startImplementationService?: StartImplementationService;
  /**
   * WORK-026: agent provider registry — used by the start-implementation
   * route to validate provider/model + resolve platform defaults. Optional
   * (tests may omit it), but production wires it.
   */
  agentProviderRegistryService?: {
    isProviderConfigured(provider: string, model: string, projectId?: string): Promise<boolean>;
    getPlatformDefaultProvider(): string | undefined;
    getPlatformDefaultModel(): string | undefined;
  };
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

  // POST /work-items/:workItemId/workflow/complete-verification — submit the
  // verification_completed signal (WORK-024 additive API seam).
  //
  // This route exposes the existing orchestrator.submitVerificationCompleted
  // method through HTTP so the E2E lifecycle can be driven entirely through
  // API calls. It does NOT change any authority: it validates the
  // VerificationRun is completed (status='completed', set by persistEvaluations)
  // and reads the authoritative result from the persisted summary — it never
  // accepts a client-supplied pass/fail outcome.
  //
  // The caller is expected to have already:
  //   1. POST /work-items/:id/workflow/begin-verification (creates the run)
  //   2. POST /projects/:projectId/ci-evidence (ingests CI evidence)
  //   3. POST /verification-runs/:runId/ci-evidence (attaches to the run)
  //   4. POST /verification-runs/:runId/evidence-mappings (maps to criteria)
  //   5. POST /verification-runs/:runId/evaluate (persists evaluations + sets run to 'completed')
  //   6. POST /work-items/:id/workflow/complete-verification (this route — submits the signal)
  //
  // The signal is processed asynchronously by the WorkerHost, which transitions
  // VERIFYING → ARCHITECT_REVIEW (if all criteria pass) or VERIFYING → VERIFICATION_FAILED.
  app.post('/work-items/:workItemId/workflow/complete-verification', async (req, reply) => {
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
      const body = req.body as { verificationRunId?: string };
      if (!body?.verificationRunId) {
        return reply.code(400).send({ error: 'verificationRunId required' });
      }
      const executionId = generateExecutionId();
      const signal = await deps.orchestrator.submitVerificationCompleted({
        workItemId,
        verificationRunId: body.verificationRunId,
        executionId,
      });
      return reply.code(202).send({
        signalId: signal.id, accepted: true,
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

  // POST /work-items/:workItemId/workflow/submit-pr-merged — submit the
  // pull_request_merged signal (WORK-024 additive API seam).
  //
  // This route exposes the existing orchestrator.submitPullRequestMerged
  // method through HTTP. In production, this signal is triggered by the
  // authoritative GitHub webhook. The E2E lifecycle uses this route (after
  // marking the PR as merged via POST /work-items/:id/pr-associations/:prId/merge)
  // to drive the APPROVED → MERGED transition.
  //
  // It does NOT change any authority — the orchestrator validates the PR
  // association is persisted with status='merged' before submitting the signal.
  app.post('/work-items/:workItemId/workflow/submit-pr-merged', async (req, reply) => {
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
      const body = req.body as { prAssociationId?: string };
      if (!body?.prAssociationId) {
        return reply.code(400).send({ error: 'prAssociationId required' });
      }
      const executionId = generateExecutionId();
      const signal = await deps.orchestrator.submitPullRequestMerged({
        workItemId,
        prAssociationId: body.prAssociationId,
        executionId,
      });
      return reply.code(202).send({
        signalId: signal.id, accepted: true,
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

  // --- WORK-026: Autonomous-implementation entry point ---

  // POST /work-items/:workItemId/start-implementation — build + persist the
  // ImplementationContext for the work item, then submit it to the
  // AgentGateway via the startImplementationService. There is NO production
  // no-op path: if the service is absent, the route returns 503
  // 'service-unavailable' (NOT a silent 201).
  //
  // The route validates:
  //   - the work item exists (404 'work-item-not-found' if not),
  //   - the caller has project.write (403 'forbidden' if not),
  //   - the workflow state is 'ready' (initial run) or 'changes_requested'
  //     (correction cycle) — 400 'invalid-state' otherwise,
  //   - the implementationContextBuilder is wired (503 if not),
  //   - the startImplementationService is wired (503 if not),
  //   - the provider + model are supplied and validated against the
  //     AgentProviderRegistry (400 'provider-not-configured' if invalid).
  //
  // The route does NOT mutate workflow state — that remains the exclusive
  // authority of the /workflows WorkflowEngine. It builds + persists the
  // context, submits to the AgentGateway, and returns the agent run id.
  app.post('/work-items/:workItemId/start-implementation', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };

      // 1. Validate work item exists + belongs to the project.
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }

      // 2. Check the caller has project.write on the work item's project.
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write', projectId,
      });

      if (!deps.implementationContextBuilder) {
        return reply
          .code(503)
          .send({ error: 'service-unavailable', reason: 'implementation-context-builder-not-configured' });
      }

      if (!deps.startImplementationService) {
        return reply
          .code(503)
          .send({ error: 'service-unavailable', reason: 'start-implementation-service-not-configured' });
      }

      // 3. Check workflow state is 'ready' or 'changes_requested'.
      const execution = await deps.workflowEngine.getState(workItemId);
      const currentState = execution?.currentState ?? null;
      if (currentState !== 'ready' && currentState !== 'changes_requested') {
        return reply.code(400).send({
          error: 'invalid-state',
          currentState,
          expectedStates: ['ready', 'changes_requested'],
        });
      }

      // 4. Validate provider + model against the AgentProviderRegistry (when
      //    wired). The route never accepts arbitrary provider/model values
      //    from the browser — the same pattern as the /architect/converse
      //    route validates against the LLM ProviderRegistry.
      const body = req.body as { provider?: string; model?: string } | null;
      const provider = body?.provider ?? deps.agentProviderRegistryService?.getPlatformDefaultProvider();
      const model = body?.model ?? deps.agentProviderRegistryService?.getPlatformDefaultModel();
      if (!provider || !model) {
        return reply.code(400).send({
          error: 'provider-not-configured',
          message: 'No implementation agent provider is configured. Set AGENT_PROVIDER_NAME / AGENT_API_KEY / AGENT_DEFAULT_MODEL on the server, or POST /projects/:projectId/agents/providers to configure a project-specific provider.',
        });
      }
      if (deps.agentProviderRegistryService) {
        const configured = await deps.agentProviderRegistryService.isProviderConfigured(provider, model, projectId);
        if (!configured) {
          return reply.code(400).send({
            error: 'provider-not-configured',
            message: `Provider "${provider}" with model "${model}" is not configured.`,
          });
        }
      }

      // 5. Build + persist the ImplementationContext. The builder resolves
      // the latest Work Order internally and derives `kind` from the prior
      // context + prior review findings (correction cycle).
      const implementationContext =
        await deps.implementationContextBuilder.build(workItemId);

      // 6. Submit to the AgentGateway via the startImplementationService.
      //    If the gateway rejects, the service propagates the error — the
      //    route returns 502 'agent-gateway-failed' and NO fake AgentRun is
      //    persisted as successful.
      const executionId = generateExecutionId();
      try {
        const submission = await deps.startImplementationService.start({
          workItemId,
          implementationContextId: implementationContext.id,
          implementationContextRevision: implementationContext.revision,
          implementationContextKind: implementationContext.kind,
          executionId,
          provider,
          model,
        });
        return reply.code(201).send({
          implementationContextId: implementationContext.id,
          workItemId,
          revision: implementationContext.revision,
          kind: implementationContext.kind,
          agentRunId: submission.agentRunId,
          executionId: submission.executionId,
        });
      } catch (err) {
        return reply.code(502).send({
          error: 'agent-gateway-failed',
          message: (err as Error).message,
          implementationContextId: implementationContext.id,
          detail: 'The implementation context was persisted but the agent execution failed. No fake AgentRun was recorded.',
        });
      }
    });
  });
}
