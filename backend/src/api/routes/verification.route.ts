import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  ArchitectureRepository,
  ArchitectureVersionRepository,
} from '@modules/architecture/index.js';
import type {
  WorkItemRepository,
} from '@modules/work-items/index.js';
import type {
  RequirementRepository,
  AcceptanceCriterionRepository,
} from '@modules/requirements/index.js';
import type {
  VerificationService,
} from '@modules/verification/index.js';
import type {
  CiEvidenceIngestionService,
} from '@modules/github/index.js';
import { generateExecutionId } from '@platform/ids.js';
import { requireProjectAuthorization, runAuthed } from '../plugins/auth.plugin.js';

/**
 * Protected verification routes (VERIFY-001..003).
 *
 * All routes are backend-authorized via the reusable {@link AuthorizationService}
 * (reused from WORK-002). Authorization resolves through the traceability chain:
 *   VerificationRun → Work Item → ArchitectureVersion → Architecture → Project
 *
 * Boundary ownership:
 *   - /verification OWNS verification semantics (create runs, attach evidence,
 *     map evidence→criteria, evaluate, persist derived statuses).
 *   - /github OWNS CI ingestion — the route exposes an endpoint that lets an
 *     authorized user manually trigger CI evidence attachment to a run (the
 *     translation happens via the VerificationService.attachCiEvidence method).
 *   - /requirements remains the owner of AcceptanceCriterion persistence —
 *     the persist endpoint routes derived statuses through the existing
 *     AcceptanceCriterionRepository.update + RequirementRepository.update
 *     contracts (never raw SQL).
 */
export interface VerificationRouteDeps {
  authorizationService: AuthorizationService;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  requirementRepository: RequirementRepository;
  acceptanceCriterionRepository: AcceptanceCriterionRepository;
  verificationService: VerificationService;
  ciEvidenceIngestionService: CiEvidenceIngestionService;
}

async function resolveProjectForWorkItem(
  deps: VerificationRouteDeps,
  workItemId: string,
): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

async function resolveProjectForVerificationRun(
  deps: VerificationRouteDeps,
  verificationRunId: string,
): Promise<{ projectId: string; workItemId: string } | null> {
  const run = await deps.verificationService.findRun(verificationRunId);
  if (!run) return null;
  return { projectId: run.projectId, workItemId: run.workItemId };
}

export async function verificationRoutes(
  app: FastifyInstance,
  deps: VerificationRouteDeps,
): Promise<void> {
  // --- Create a VerificationRun for a Work Item ---

  app.post('/work-items/:workItemId/verification-runs', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        workOrderId?: string;
        source?: string;
        sourceRef?: string;
      };
      if (!body?.source) {
        return reply.code(400).send({ error: 'source required' });
      }
      const wi = await deps.workItemRepository.findById(workItemId);
      if (!wi) return reply.code(404).send({ error: 'work-item-not-found' });
      const executionId = generateExecutionId();
      const run = await deps.verificationService.createRun({
        projectId,
        workItemId,
        workOrderId: body.workOrderId ?? null,
        architectureVersionId: wi.architectureVersionId,
        source: body.source,
        sourceRef: body.sourceRef ?? null,
        executionId,
      });
      return reply.code(201).send(run);
    });
  });

  // --- Attach Evidence to a VerificationRun ---

  app.post('/verification-runs/:runId/evidence', async (req, reply) => {
    return runAuthed(req, async () => {
      const { runId } = req.params as { runId: string };
      const resolved = await resolveProjectForVerificationRun(deps, runId);
      if (!resolved) {
        return reply.code(404).send({ error: 'verification-run-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: resolved.projectId,
      });
      const body = req.body as {
        evidenceType?: string;
        // NOTE: `authority` is intentionally NOT accepted from the client.
        // The public/manual evidence path always produces `claim` evidence.
        // Authoritative evidence can only come through the trusted CI
        // ingestion path (POST /verification-runs/:runId/ci-evidence).
        // See PR #14 architect review.
        provider?: string;
        externalRef?: string;
        headSha?: string;
        result?: 'pass' | 'fail' | 'blocked' | 'unknown';
        contentSummary?: string;
        storageKey?: string;
        storageProvider?: string;
        artifactDigest?: string;
        artifactSizeBytes?: number;
        artifactContentType?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.evidenceType || !body?.provider) {
        return reply.code(400).send({ error: 'evidenceType and provider required' });
      }
      const evidence = await deps.verificationService.attachEvidence({
        projectId: resolved.projectId,
        verificationRunId: runId,
        evidenceType: body.evidenceType,
        provider: body.provider,
        externalRef: body.externalRef,
        headSha: body.headSha,
        result: body.result,
        contentSummary: body.contentSummary,
        storageKey: body.storageKey,
        storageProvider: body.storageProvider,
        artifactDigest: body.artifactDigest,
        artifactSizeBytes: body.artifactSizeBytes,
        artifactContentType: body.artifactContentType,
        metadata: body.metadata,
      });
      return reply.code(201).send(evidence);
    });
  });

  // --- Attach CI Evidence (ingested by /github) to a VerificationRun ---

  app.post('/verification-runs/:runId/ci-evidence', async (req, reply) => {
    return runAuthed(req, async () => {
      const { runId } = req.params as { runId: string };
      const resolved = await resolveProjectForVerificationRun(deps, runId);
      if (!resolved) {
        return reply.code(404).send({ error: 'verification-run-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: resolved.projectId,
      });
      const body = req.body as { ciEvidenceId?: string };
      if (!body?.ciEvidenceId) {
        return reply.code(400).send({ error: 'ciEvidenceId required' });
      }
      const evidence = await deps.verificationService.attachCiEvidence({
        verificationRunId: runId,
        ciEvidenceId: body.ciEvidenceId,
      });
      return reply.code(201).send(evidence);
    });
  });

  // --- Map Evidence to a Criterion ---

  app.post('/verification-runs/:runId/evidence-mappings', async (req, reply) => {
    return runAuthed(req, async () => {
      const { runId } = req.params as { runId: string };
      const resolved = await resolveProjectForVerificationRun(deps, runId);
      if (!resolved) {
        return reply.code(404).send({ error: 'verification-run-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: resolved.projectId,
      });
      const body = req.body as {
        evidenceId?: string;
        criterionId?: string;
        relevance?: 'proves' | 'supports' | 'contradicts' | 'blocks';
        source?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.evidenceId || !body?.criterionId) {
        return reply.code(400).send({ error: 'evidenceId and criterionId required' });
      }
      const mapping = await deps.verificationService.mapEvidenceToCriterion({
        projectId: resolved.projectId,
        verificationRunId: runId,
        evidenceId: body.evidenceId,
        criterionId: body.criterionId,
        relevance: body.relevance,
        source: body.source,
        metadata: body.metadata,
      });
      return reply.code(201).send(mapping);
    });
  });

  // --- Evaluate + persist results for a VerificationRun ---

  app.post('/verification-runs/:runId/evaluate', async (req, reply) => {
    return runAuthed(req, async () => {
      const { runId } = req.params as { runId: string };
      const resolved = await resolveProjectForVerificationRun(deps, runId);
      if (!resolved) {
        return reply.code(404).send({ error: 'verification-run-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: resolved.projectId,
      });
      const result = await deps.verificationService.persistEvaluations(runId);
      return reply.code(200).send(result);
    });
  });

  // --- Read-only evaluation (no persistence) ---

  app.get('/verification-runs/:runId/evaluation', async (req, reply) => {
    return runAuthed(req, async () => {
      const { runId } = req.params as { runId: string };
      const resolved = await resolveProjectForVerificationRun(deps, runId);
      if (!resolved) {
        return reply.code(404).send({ error: 'verification-run-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: resolved.projectId,
      });
      const result = await deps.verificationService.evaluateForRun(runId);
      return reply.code(200).send(result);
    });
  });

  // --- WORK-022 (UI2-AC-01) read paths for the web application ---
  //
  // These GET endpoints expose ACTUAL VerificationRun + Evidence + mapping
  // records so the frontend can render authoritative verification state.
  // They exist specifically so the frontend never substitutes workflow-
  // convergence metadata for actual verification data (PR #21 issue 3).
  //
  // Authorization resolves through the same traceability chain as every
  // other verification route: VerificationRun → Work Item →
  // ArchitectureVersion → Architecture → Project. Tenant isolation is
  // preserved by requireProjectAuthorization.

  // GET /work-items/:workItemId/verification-runs — list runs for a work item.
  app.get('/work-items/:workItemId/verification-runs', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const runs = await deps.verificationService.listRunsForWorkItem(workItemId);
      return reply.code(200).send(runs);
    });
  });

  // GET /verification-runs/:runId — fetch a single run.
  app.get('/verification-runs/:runId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { runId } = req.params as { runId: string };
      const resolved = await resolveProjectForVerificationRun(deps, runId);
      if (!resolved) {
        return reply.code(404).send({ error: 'verification-run-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: resolved.projectId,
      });
      const run = await deps.verificationService.findRun(runId);
      if (!run) return reply.code(404).send({ error: 'verification-run-not-found' });
      return reply.code(200).send(run);
    });
  });

  // GET /verification-runs/:runId/evidence — list evidence attached to a run.
  app.get('/verification-runs/:runId/evidence', async (req, reply) => {
    return runAuthed(req, async () => {
      const { runId } = req.params as { runId: string };
      const resolved = await resolveProjectForVerificationRun(deps, runId);
      if (!resolved) {
        return reply.code(404).send({ error: 'verification-run-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: resolved.projectId,
      });
      const evidence = await deps.verificationService.listEvidenceForRun(runId);
      return reply.code(200).send(evidence);
    });
  });

  // GET /verification-runs/:runId/evidence-mappings — list evidence→criterion mappings.
  app.get('/verification-runs/:runId/evidence-mappings', async (req, reply) => {
    return runAuthed(req, async () => {
      const { runId } = req.params as { runId: string };
      const resolved = await resolveProjectForVerificationRun(deps, runId);
      if (!resolved) {
        return reply.code(404).send({ error: 'verification-run-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: resolved.projectId,
      });
      const mappings = await deps.verificationService.listMappingsForRun(runId);
      return reply.code(200).send(mappings);
    });
  });

  // --- CI evidence ingestion endpoint (manual trigger for testing) ---

  app.post('/projects/:projectId/ci-evidence', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        payload: string;
        eventType?: string;
        webhookDeliveryId?: string;
      };
      if (!body?.payload || !body?.eventType) {
        return reply.code(400).send({ error: 'payload and eventType required' });
      }
      // The webhook delivery id is used for traceability (stored on the CI
      // evidence row). For the manual ingestion route it's optional.
      const webhookEventId = body.webhookDeliveryId ?? '';
      const result = await deps.ciEvidenceIngestionService.ingestFromWebhookPayload({
        webhookEventId,
        eventType: body.eventType,
        payload: body.payload,
      });
      if (!result) {
        return reply.code(200).send({ ingested: false, reason: 'not-a-ci-event-or-no-project' });
      }
      return reply.code(201).send({ ingested: true, ciEvidence: result });
    });
  });
}
