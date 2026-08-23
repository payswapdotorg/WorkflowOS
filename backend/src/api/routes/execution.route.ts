/**
 * WORK-027: Execution routes — the secure external-handoff + event-ingestion
 * boundary.
 *
 * Routes (all backend-authorized; the frontend is a consumer, never an
 * authority):
 *
 *   GET  /work-items/:workItemId/executions
 *        Safe execution metadata for a Work Item (no packages, no tokens).
 *
 *   GET  /execution/:executionId
 *        Safe execution metadata + ingested events.
 *
 *   POST /execution/:executionId/handoff
 *        Issue a ONE-TIME, short-lived handoff token for an external
 *        execution package (project.write required).
 *
 *   GET  /execution/:executionId/package
 *        Redeem a handoff token (x-handoff-token header) for the full
 *        ExternalExecutionPackage. One-time (replay → 409), short-lived
 *        (expiry → 410), malformed/unknown token → 403. The package is never
 *        exposed through a public/unauthenticated URL: the caller must ALSO
 *        be authorized for the execution's project (project.read), so a
 *        stolen token alone is insufficient.
 *
 *   POST /execution/:executionId/events
 *        Provider-independent external result ingestion (started | progress |
 *        completed | failed). Updates ONLY the execution record — NEVER
 *        workflow/verification/review state. Native executions reject events.
 *
 * There is deliberately NO route that lets an external execution declare
 * MERGED / VERIFIED / PASS / APPROVED — GitHub/CI/verification/review remain
 * authoritative through their own boundaries.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  ExecutionEventIngestionService,
  ExecutionHandoffService,
  ExecutionRecordRepository,
  IngestExecutionEventInput,
} from '@modules/agents/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

export interface ExecutionRouteDeps {
  authorizationService: AuthorizationService;
  executionRecordRepository: ExecutionRecordRepository;
  /** WORK-027: issues + redeems one-time handoff tokens. Required. */
  executionHandoffService: ExecutionHandoffService;
  /** WORK-027: external result ingestion boundary. Required. */
  executionEventIngestionService: ExecutionEventIngestionService;
}

interface CodedError {
  code?: string;
  message?: string;
}

/** Map an ingestion/handoff service error code to an HTTP status + body. */
function codedErrorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  const coded = err as CodedError;
  const message = (err as Error).message;
  switch (coded.code) {
    case 'execution-not-found':
      return { status: 404, body: { error: 'execution-not-found', message } };
    case 'handoff-token-invalid':
      return { status: 403, body: { error: 'handoff-token-invalid', message } };
    case 'handoff-token-expired':
      return { status: 410, body: { error: 'handoff-token-expired', message } };
    case 'handoff-token-already-used':
      return { status: 409, body: { error: 'handoff-token-already-used', message } };
    case 'execution-expired':
      return { status: 410, body: { error: 'execution-expired', message } };
    case 'not-external-execution':
    case 'invalid-execution-state':
      return { status: 409, body: { error: coded.code, message } };
    case 'native-execution-events-not-allowed':
      return { status: 409, body: { error: 'native-execution-events-not-allowed', message } };
    case 'invalid-event-type':
      return { status: 400, body: { error: 'invalid-event-type', message } };
    default:
      return { status: 500, body: { error: 'execution-service-error', message } };
  }
}

/** Safe (secret-free, package-free) execution summary for API responses. */
function toSafeExecution(record: {
  executionId: string;
  mode: string;
  provider: string;
  model: string | null;
  status: string;
  agentRunId: string | null;
  externalSessionRef: string | null;
  repositoryRef: string | null;
  branch: string | null;
  promptDigest: string;
  benchmarkMetadata: Record<string, unknown>;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    executionId: record.executionId,
    mode: record.mode,
    provider: record.provider,
    model: record.model,
    status: record.status,
    agentRunId: record.agentRunId,
    externalSessionRef: record.externalSessionRef,
    repository: record.repositoryRef,
    branch: record.branch,
    promptDigest: record.promptDigest,
    benchmarkMetadata: record.benchmarkMetadata,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function executionRoutes(
  app: FastifyInstance,
  deps: ExecutionRouteDeps,
): Promise<void> {
  // GET /work-items/:workItemId/executions — safe execution list.
  app.get('/work-items/:workItemId/executions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const records = await deps.executionRecordRepository.listForWorkItem(workItemId);
      if (records.length > 0) {
        const projectId = records[0]!.projectId;
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.read',
          projectId,
        });
      }
      return { executions: records.map(toSafeExecution) };
    });
  });

  // GET /execution/:executionId — safe execution metadata.
  app.get('/execution/:executionId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { executionId } = req.params as { executionId: string };
      const record = await deps.executionRecordRepository.findByExecutionId(executionId);
      if (!record) {
        return reply.code(404).send({ error: 'execution-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: record.projectId,
      });
      return { execution: toSafeExecution(record) };
    });
  });

  // POST /execution/:executionId/handoff — issue a one-time handoff token.
  app.post('/execution/:executionId/handoff', async (req, reply) => {
    return runAuthed(req, async () => {
      const { executionId } = req.params as { executionId: string };
      // Authorize against the execution's project BEFORE touching the
      // handoff service — cross-project callers get 403 regardless of any
      // token knowledge.
      const record = await deps.executionRecordRepository.findByExecutionId(executionId);
      if (!record) {
        return reply.code(404).send({ error: 'execution-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: record.projectId,
      });
      try {
        const issued = await deps.executionHandoffService.issue(executionId);
        // The RAW token is returned exactly once; only its hash is stored.
        return reply.code(201).send({
          executionId: issued.executionId,
          handoffToken: issued.handoffToken,
          expiresAt: issued.expiresAt,
        });
      } catch (err) {
        const { status, body } = codedErrorBody(err);
        return reply.code(status).send(body);
      }
    });
  });

  // GET /execution/:executionId/package — redeem a one-time handoff token.
  app.get('/execution/:executionId/package', async (req, reply) => {
    return runAuthed(req, async () => {
      const { executionId } = req.params as { executionId: string };
      const record = await deps.executionRecordRepository.findByExecutionId(executionId);
      if (!record) {
        return reply.code(404).send({ error: 'execution-not-found' });
      }
      // Project auth comes FIRST: the extension must never be able to use
      // another user's execution package, even with a valid token. (This
      // also ensures unauthenticated callers get 401 before any token
      // validation output.)
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: record.projectId,
      });
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const rawToken = Array.isArray(headers['x-handoff-token'])
        ? headers['x-handoff-token'][0]
        : headers['x-handoff-token'];
      if (!rawToken) {
        return reply
          .code(403)
          .send({ error: 'handoff-token-invalid', message: 'x-handoff-token header is required' });
      }
      try {
        const redeemed = await deps.executionHandoffService.redeem(executionId, rawToken);
        return reply.code(200).send({
          executionId: redeemed.executionId,
          status: redeemed.status,
          package: redeemed.package,
        });
      } catch (err) {
        const { status, body } = codedErrorBody(err);
        return reply.code(status).send(body);
      }
    });
  });

  // POST /execution/:executionId/events — provider-independent ingestion.
  // Updates ONLY the execution record. NEVER mutates workflow state —
  // WorkflowOS observes authoritative GitHub/CI/verification/review state.
  app.post('/execution/:executionId/events', async (req, reply) => {
    return runAuthed(req, async () => {
      const { executionId } = req.params as { executionId: string };
      const record = await deps.executionRecordRepository.findByExecutionId(executionId);
      if (!record) {
        return reply.code(404).send({ error: 'execution-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: record.projectId,
      });
      const body = req.body as Partial<IngestExecutionEventInput> | null;
      if (!body || typeof body.eventType !== 'string') {
        return reply.code(400).send({
          error: 'invalid-event-type',
          message: 'eventType must be one of started|progress|completed|failed',
        });
      }
      if (
        body.commitRef !== undefined && body.commitRef !== null && typeof body.commitRef !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-event-payload', field: 'commitRef' });
      }
      if (
        body.branch !== undefined && body.branch !== null && typeof body.branch !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-event-payload', field: 'branch' });
      }
      if (
        body.pullRequestRef !== undefined &&
        body.pullRequestRef !== null &&
        typeof body.pullRequestRef !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-event-payload', field: 'pullRequestRef' });
      }
      if (
        body.output !== undefined && body.output !== null && typeof body.output !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-event-payload', field: 'output' });
      }
      if (
        body.externalSessionRef !== undefined &&
        body.externalSessionRef !== null &&
        typeof body.externalSessionRef !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-event-payload', field: 'externalSessionRef' });
      }
      if (
        body.idempotencyKey !== undefined &&
        body.idempotencyKey !== null &&
        typeof body.idempotencyKey !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-event-payload', field: 'idempotencyKey' });
      }
      try {
        const ingested = await deps.executionEventIngestionService.ingest({
          executionId,
          eventType: body.eventType as IngestExecutionEventInput['eventType'],
          commitRef: body.commitRef ?? null,
          branch: body.branch ?? null,
          pullRequestRef: body.pullRequestRef ?? null,
          testSummary:
            body.testSummary && typeof body.testSummary === 'object' && !Array.isArray(body.testSummary)
              ? (body.testSummary as Record<string, unknown>)
              : null,
          output: body.output ?? null,
          externalSessionRef: body.externalSessionRef ?? null,
          idempotencyKey: body.idempotencyKey ?? null,
        });
        return reply.code(202).send({
          accepted: ingested.accepted,
          duplicate: ingested.duplicate,
          executionId: ingested.executionId,
          status: ingested.status,
        });
      } catch (err) {
        const { status, body: errorBody } = codedErrorBody(err);
        return reply.code(status).send(errorBody);
      }
    });
  });
}
