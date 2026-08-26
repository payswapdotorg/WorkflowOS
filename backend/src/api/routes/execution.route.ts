/**
 * WORK-027: Execution routes — the secure external-handoff + event-ingestion
 * boundary.
 *
 * Routes (all backend-authorized; the frontend is a consumer, never an
 * authority):
 *
 *   GET  /work-items/:workItemId/executions
 *        Safe execution metadata for a Work Item. PR #30 review fix #1:
 *        authorization resolves WorkItem → ArchitectureVersion →
 *        Architecture → Project and runs requireProjectAuthorization BEFORE
 *        any execution data is queried — even when zero executions exist
 *        (no cross-tenant existence oracle).
 *
 *   GET  /execution/:executionId
 *        Safe execution metadata.
 *
 *   POST /execution/:executionId/handoff
 *        Prepare an external session: issues the ONE-TIME, short-lived
 *        package handoff token AND the scoped event-ingestion callback token
 *        (PR #30 review fix #2 — the extension never needs the user's
 *        WorkflowOS API key). project.write required.
 *
 *   GET  /execution/:executionId/package
 *        Redeem a handoff token (x-handoff-token header) for the full
 *        ExternalExecutionPackage. One-time (replay → 409), short-lived
 *        (expiry → 410), malformed/unknown token → 403. Project auth runs
 *        FIRST: a stolen token alone is insufficient.
 *
 *   POST /execution/:executionId/events
 *        Provider-independent external result ingestion (started | progress |
 *        completed | failed). TWO accepted credentials:
 *          - x-callback-token header (scoped to exactly THIS execution's
 *            event ingestion — the Companion extension path; NO API key), or
 *          - the standard API key + project.write.
 *        Updates ONLY the execution record — NEVER workflow/verification/
 *        review state. Native executions reject events.
 *
 * There is deliberately NO route that lets an external execution declare
 * MERGED / VERIFIED / PASS / APPROVED — GitHub/CI/verification/review remain
 * authoritative through their own boundaries.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  ArchitectureRepository,
  ArchitectureVersionRepository,
} from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type {
  ExecutionEventIngestionService,
  ExecutionHandoffService,
  ExecutionCallbackService,
  ExecutionRecordRepository,
  CrossModeHandoffService,
  IngestExecutionEventInput,
} from '@modules/agents/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

export interface ExecutionRouteDeps {
  authorizationService: AuthorizationService;
  /** PR #30 review fix #1: resolve WorkItem → project for the list route. */
  workItemRepository: WorkItemRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  architectureRepository: ArchitectureRepository;
  executionRecordRepository: ExecutionRecordRepository;
  /** WORK-027: issues + redeems one-time handoff tokens. Required. */
  executionHandoffService: ExecutionHandoffService;
  /** WORK-027 (PR #30 fix #2): scoped event-ingestion callback tokens. Required. */
  executionCallbackService: ExecutionCallbackService;
  /** WORK-027: external result ingestion boundary. Required. */
  executionEventIngestionService: ExecutionEventIngestionService;
  /**
   * WORK-042: cross-mode handoff boundary (native <-> external for the SAME
   * logical execution — ONE ExecutionRecord preserved). OPTIONAL — the
   * existing execution routes (list/handoff/package/events) keep working
   * without it; the cross-mode-handoff route returns 503 when it is absent
   * (the service is wired only when DB + agent-policy + execution-policy +
   * agent-provider-registry are all configured).
   */
  crossModeHandoffService?: CrossModeHandoffService;
}

interface CodedError {
  code?: string;
  message?: string;
}

/** Map an ingestion/handoff/callback/cross-mode-handoff service error code to an HTTP status + body. */
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
    case 'callback-token-invalid':
      return { status: 403, body: { error: 'callback-token-invalid', message } };
    case 'callback-token-expired':
      return { status: 410, body: { error: 'callback-token-expired', message } };
    case 'execution-expired':
      return { status: 410, body: { error: 'execution-expired', message } };
    case 'handoff-policy-denied':
      return { status: 403, body: { error: 'handoff-policy-denied', message } };
    case 'handoff-policy-approval-required':
      // An ask decision is a client-actionable conflict: the caller resolves
      // the pending approval, then re-requests the handoff. 422 (the policy
      // authority requires an approval that does not yet exist).
      return { status: 422, body: { error: 'handoff-policy-approval-required', message } };
    case 'not-external-execution':
    case 'invalid-execution-state':
      return { status: 409, body: { error: coded.code, message } };
    case 'native-execution-events-not-allowed':
      return { status: 409, body: { error: 'native-execution-events-not-allowed', message } };
    case 'invalid-event-type':
      return { status: 400, body: { error: 'invalid-event-type', message } };
    // WORK-042: cross-mode handoff error codes.
    case 'already-handed-off':
      // ONE handoff per execution (UNIQUE(execution_record_id)); a second
      // handoff with a different idempotency_key is a 409 conflict.
      return { status: 409, body: { error: 'already-handed-off', message } };
    case 'invalid-target-mode':
      return { status: 400, body: { error: 'invalid-target-mode', message } };
    case 'handoff-ineligible-state':
      // The execution is in a state that does not admit a cross-mode handoff
      // (e.g. native/completed -> external, or external/cancelled -> native).
      return { status: 409, body: { error: 'handoff-ineligible-state', message } };
    case 'native-provider-unavailable':
      // No platform-native provider is configured (fail-closed). 503 (the
      // service is unavailable, not a client error).
      return { status: 503, body: { error: 'native-provider-unavailable', message } };
    case 'handoff-dispatch-failed':
      return { status: 500, body: { error: 'handoff-dispatch-failed', message } };
    case 'cross-mode-handoff-not-external':
      // Reserved: a non-external record on the external-handoff token path.
      return { status: 409, body: { error: 'cross-mode-handoff-not-external', message } };
    default:
      return { status: 500, body: { error: 'execution-service-error', message } };
  }
}

/**
 * PR #30 review fix #1: resolve a Work Item to its project id via the
 * established chain (WorkItem → ArchitectureVersion → Architecture →
 * Project). Returns null when the work item (or its chain) does not exist.
 */
async function resolveProjectForWorkItem(
  deps: ExecutionRouteDeps,
  workItemId: string,
): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
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

/**
 * WORK-042: safe (secret-free, package-snapshot-free) cross-mode handoff
 * summary for API responses. The `previousPackageValue` (the prior phase's
 * ExternalExecutionPackage snapshot — which itself contains NO secrets per
 * WORK-027) is deliberately NOT returned to the route caller; the
 * correction-chain evidence stays internal (the audit + the handoff log row
 * are the authoritative record). The route returns only the safe transition
 * metadata.
 */
function toSafeHandoff(handoff: {
  id: string;
  executionId: string;
  fromMode: string;
  toMode: string;
  reason: string | null;
  actor: string | null;
  source: string | null;
  previousStatus: string;
  resultingStatus: string;
  authorized: boolean;
  policyDecision: string | null;
  idempotencyKey: string;
  createdAt: Date;
}) {
  return {
    id: handoff.id,
    executionId: handoff.executionId,
    fromMode: handoff.fromMode,
    toMode: handoff.toMode,
    reason: handoff.reason,
    actor: handoff.actor,
    source: handoff.source,
    previousStatus: handoff.previousStatus,
    resultingStatus: handoff.resultingStatus,
    authorized: handoff.authorized,
    policyDecision: handoff.policyDecision,
    idempotencyKey: handoff.idempotencyKey,
    createdAt: handoff.createdAt,
  };
}

export async function executionRoutes(
  app: FastifyInstance,
  deps: ExecutionRouteDeps,
): Promise<void> {
  // GET /work-items/:workItemId/executions — safe execution list.
  //
  // PR #30 review fix #1: authorize BEFORE querying. The project is resolved
  // from the WorkItem chain and requireProjectAuthorization runs even when
  // the work item has ZERO executions — an unauthorized caller must never
  // learn whether another tenant's Work Item exists (200 vs 403 oracle).
  app.get('/work-items/:workItemId/executions', async (req, reply) => {
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
      const records = await deps.executionRecordRepository.listForWorkItem(workItemId);
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

  // POST /execution/:executionId/handoff — prepare an external session:
  // issue the one-time package handoff token + the scoped callback token.
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
        // One-time package redemption token (unchanged semantics).
        const issued = await deps.executionHandoffService.issue(executionId);
        // PR #30 review fix #2: scoped event-ingestion credential — the ONLY
        // credential the Companion extension needs (no WorkflowOS API key).
        const callback = await deps.executionCallbackService.issue(executionId);
        // Both RAW tokens are returned exactly once; only hashes are stored.
        return reply.code(201).send({
          executionId: issued.executionId,
          handoffToken: issued.handoffToken,
          expiresAt: issued.expiresAt,
          callbackToken: callback.callbackToken,
          callbackExpiresAt: callback.expiresAt,
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
      // validation output. A callback token is NOT accepted here — it is
      // scoped to event ingestion only.)
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
  //
  // Accepted credentials (exactly one path):
  //   1. x-callback-token header (PR #30 review fix #2) — the scoped
  //      Companion-extension credential. NO WorkflowOS API key is required
  //      or accepted as a supplement: if the header is present it MUST be a
  //      valid callback token for EXACTLY this execution. It grants nothing
  //      else — this is the only route that reads it.
  //   2. Standard API key + project.write (operator/console path).
  //
  // Updates ONLY the execution record. NEVER mutates workflow state —
  // WorkflowOS observes authoritative GitHub/CI/verification/review state.
  app.post('/execution/:executionId/events', async (req, reply) => {
    return runAuthed(req, async () => {
      const { executionId } = req.params as { executionId: string };
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const callbackToken = Array.isArray(headers['x-callback-token'])
        ? headers['x-callback-token'][0]
        : headers['x-callback-token'];

      const record = await deps.executionRecordRepository.findByExecutionId(executionId);
      if (!record) {
        return reply.code(404).send({ error: 'execution-not-found' });
      }

      if (callbackToken !== undefined) {
        // Scoped credential path — validates the token against EXACTLY this
        // execution (wrong execution → 403, expired → 410, execution window
        // elapsed → 410 with lazy expiry). No API-key authorization applies.
        try {
          await deps.executionCallbackService.validate(executionId, callbackToken);
        } catch (err) {
          const { status, body } = codedErrorBody(err);
          return reply.code(status).send(body);
        }
      } else {
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.write',
          projectId: record.projectId,
        });
      }

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

  // POST /execution/:executionId/cross-mode-handoff — transition the SAME
  // logical ExecutionRecord from native -> external or external -> native.
  //
  // ONE logical execution is preserved (ONE ExecutionRecord, ONE
  // ExecutionSession, ONE AgentWorkspace). The handoff is a SUBORDINATE
  // state transition + an append-only history log row; the route accepts NO
  // authoritative fields (executionId from path; projectId resolved server-
  // side; policy decision server-side; audit identity server-side).
  //
  // The cross-project guard runs BEFORE any mutation: record.projectId is
  // resolved server-side + requireProjectAuthorization(project.write) gates
  // the caller; the service re-resolves + validates record.projectId for
  // defense-in-depth. NO GET mutation (POST-only). NO workflow/verification/
  // review mutation. NO secrets persisted (the handoff log's
  // previous_package_json is the ExternalExecutionPackage — NO secrets per
  // WORK-027).
  app.post('/execution/:executionId/cross-mode-handoff', async (req, reply) => {
    return runAuthed(req, async () => {
      // 503 when the cross-mode handoff service is not wired (the execution
      // module is configured but the cross-mode service is absent — e.g.
      // agent-policy / execution-policy / agent-provider-registry not all
      // configured). The existing execution routes (list/handoff/package/
      // events) are unaffected. Capture the non-null reference into a local
      // const so TS narrowing survives the awaits below.
      const crossModeHandoffService = deps.crossModeHandoffService;
      if (!crossModeHandoffService) {
        return reply.code(503).send({
          error: 'cross-mode-handoff-unavailable',
          message: 'the cross-mode handoff service is not configured',
        });
      }
      const { executionId } = req.params as { executionId: string };
      // Authorize against the execution's project BEFORE touching the
      // cross-mode service — cross-project callers get 403 regardless of any
      // executionId knowledge. The 404 (record not found) is returned FIRST
      // only when the record genuinely does not exist (requireProjectAuthorization
      // below gates the caller against record.projectId; a missing record is
      // 404 before any auth decision, mirroring the other execution routes).
      const record = await deps.executionRecordRepository.findByExecutionId(executionId);
      if (!record) {
        return reply.code(404).send({ error: 'execution-not-found' });
      }
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: record.projectId,
      });

      const body = req.body as {
        targetMode?: string;
        reason?: string;
        userInstruction?: string;
        idempotencyKey?: string;
        provider?: string;
        model?: string | null;
      } | null;
      if (!body || (body.targetMode !== 'native' && body.targetMode !== 'external')) {
        return reply.code(400).send({
          error: 'invalid-target-mode',
          message: 'targetMode must be one of native|external',
        });
      }
      // Validate the optional advisory fields are well-typed (defense-in-depth;
      // the service re-validates the cross-mode invariants).
      if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
        return reply.code(400).send({ error: 'invalid-handoff-payload', field: 'reason' });
      }
      if (
        body.userInstruction !== undefined &&
        body.userInstruction !== null &&
        typeof body.userInstruction !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-handoff-payload', field: 'userInstruction' });
      }
      if (
        body.idempotencyKey !== undefined &&
        body.idempotencyKey !== null &&
        typeof body.idempotencyKey !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-handoff-payload', field: 'idempotencyKey' });
      }
      if (
        body.provider !== undefined &&
        body.provider !== null &&
        typeof body.provider !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-handoff-payload', field: 'provider' });
      }
      if (
        body.model !== undefined &&
        body.model !== null &&
        typeof body.model !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid-handoff-payload', field: 'model' });
      }

      try {
        const result = await crossModeHandoffService.handoff(
          executionId,
          {
            targetMode: body.targetMode as 'native' | 'external',
            reason: body.reason ?? undefined,
            userInstruction: body.userInstruction ?? undefined,
            idempotencyKey: body.idempotencyKey ?? undefined,
            provider: body.provider ?? undefined,
            // Preserve an explicit null model (meaningful for external mode;
            // for native, the service fails closed with 'native-provider-
            // unavailable' when the model resolves to null).
            model: body.model,
          },
          { userId: user.id, source: 'execution-cross-mode-handoff-route' },
        );
        return reply.code(200).send({
          executionId: result.executionId,
          handoff: toSafeHandoff(result.handoff),
          record: toSafeExecution(result.record),
        });
      } catch (err) {
        const { status, body: errorBody } = codedErrorBody(err);
        return reply.code(status).send(errorBody);
      }
    });
  });
}
