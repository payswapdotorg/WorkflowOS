/**
 * WORK-028: Companion extension handoff redemption route.
 *
 * POST /companion/redeem — the ONE endpoint the WorkflowOS Companion browser
 * extension calls WITHOUT any WorkflowOS API key. Authentication is by
 * POSSESSION of the one-time, short-lived handoff token (x-handoff-token
 * header), which was issued only to an authorized (project.write) user by
 * POST /execution/:id/handoff and transported to the extension solely as an
 * opaque reference inside the /companion/handoff#ref=… deep-link fragment.
 *
 * Precedent: the GitHub webhook route is likewise not API-key authenticated —
 * its authority is the signature; here the authority is the one-time token.
 *
 * One-time semantics are preserved: redemption consumes the token (a second
 * redemption by ANYONE — including the original user — is rejected 409).
 * The response carries the execution summary + the full secret-free
 * ExternalExecutionPackage + a scoped event-ingestion CALLBACK token, which
 * is the ONLY credential the extension retains (memory only) for reporting
 * execution events via POST /execution/:id/events.
 *
 * This route MUST NOT call requireProjectAuthorization — the extension can
 * hold no API key. The token's one-time + short-lived + single-execution
 * scoping IS the authorization.
 */
import type { FastifyInstance } from 'fastify';
import type {
  ExecutionCallbackService,
  ExecutionHandoffService,
} from '@modules/agents/index.js';
import { runAuthed } from '../plugins/auth.plugin.js';

export interface CompanionRouteDeps {
  /** WORK-027/028: one-time handoff tokens (issue + token-only redeemByToken). */
  executionHandoffService: ExecutionHandoffService;
  /** WORK-027 (PR #30 fix #2): scoped event-ingestion callback tokens. */
  executionCallbackService: ExecutionCallbackService;
}

interface CodedError {
  code?: string;
}

function codedErrorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  const code = (err as CodedError).code;
  const message = (err as Error).message;
  switch (code) {
    case 'handoff-token-invalid':
      return { status: 403, body: { error: 'handoff-token-invalid', message } };
    case 'handoff-token-expired':
      return { status: 410, body: { error: 'handoff-token-expired', message } };
    case 'handoff-token-already-used':
      return { status: 409, body: { error: 'handoff-token-already-used', message } };
    case 'execution-expired':
      return { status: 410, body: { error: 'execution-expired', message } };
    case 'execution-not-found':
      return { status: 404, body: { error: 'execution-not-found', message } };
    case 'not-external-execution':
    case 'invalid-execution-state':
      return { status: 409, body: { error: code, message } };
    default:
      return { status: 500, body: { error: 'companion-service-error', message } };
  }
}

export async function companionRoutes(
  app: FastifyInstance,
  deps: CompanionRouteDeps,
): Promise<void> {
  // POST /companion/redeem — one-time handoff-token-only redemption.
  // No API key required or consulted; possession of the unconsumed,
  // unexpired one-time token for exactly one execution is the authority.
  app.post('/companion/redeem', async (req, reply) => {
    return runAuthed(req, async () => {
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const rawToken = Array.isArray(headers['x-handoff-token'])
        ? headers['x-handoff-token'][0]
        : headers['x-handoff-token'];
      if (!rawToken) {
        return reply.code(403).send({
          error: 'handoff-token-invalid',
          message: 'x-handoff-token header is required',
        });
      }
      try {
        // Consumes the one-time token (replay → 409 on any second attempt).
        const redeemed = await deps.executionHandoffService.redeemByToken(rawToken);
        // Issue the scoped event-ingestion credential — the ONLY token the
        // extension keeps (memory only, never persisted, never logged).
        const callback = await deps.executionCallbackService.issue(
          redeemed.record.executionId,
        );
        return reply.code(200).send({
          execution: {
            executionId: redeemed.record.executionId,
            projectId: redeemed.record.projectId,
            workItemId: redeemed.record.workItemId,
            mode: redeemed.record.mode,
            provider: redeemed.record.provider,
            model: redeemed.record.model,
            status: redeemed.status,
            repository: redeemed.record.repositoryRef,
            branch: redeemed.record.branch,
            promptDigest: redeemed.record.promptDigest,
            expiresAt: redeemed.record.expiresAt,
          },
          package: redeemed.pkg,
          callbackToken: callback.callbackToken,
          callbackExpiresAt: callback.expiresAt,
        });
      } catch (err) {
        const { status, body } = codedErrorBody(err);
        return reply.code(status).send(body);
      }
    });
  });
}
