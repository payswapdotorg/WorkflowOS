/**
 * V2-017 T9 — the reverse-teaching TRANSPORT routes.
 *
 * Transport ONLY (same pattern as teaching-sessions.route.ts): every
 * reverse-teaching decision, derivation, safety gate, and state
 * transition stays V2-010's `ReverseTeachingSessionService` (the frozen
 * authority). The consumer §13 surface composes the authority over
 * HTTP (V2-017 rule 9).
 *
 * The INSTALLATION PIN AUTHORITY (the architect gate correction): the
 * client-supplied (organizationId, workflowId, versionId, installationId)
 * tuple is never trusted. `resolvePin` resolves the installation through
 * V2-002's `getInstallation` (the authoritative, membership-checked read),
 * requires the client tuple to EXACTLY match the installation's immutable
 * pinned (workflowId, versionId) tuple (the run-service
 * RUN_INSTALLATION_MISMATCH precedent — any mismatch FAILS CLOSED with
 * the typed INSTALLATION_PIN_INVALID), then reads the pinned version by
 * the installation's own identifiers and computes the V2-003 digest from
 * that authoritative content.
 *
 * A ROUTE-LEVEL learner→session pointer index gives create-or-converge
 * resumability (transport state only — no teaching state lives here).
 */
import type { FastifyInstance } from 'fastify';
import type {
  ReverseTeachingErrorCode,
  ReverseTeachingSessionService,
} from '../../reverse-teaching/index.js';
import { ReverseTeachingError } from '../../reverse-teaching/index.js';
import type { WorkflowRepositoryService } from '../../workflow-repository/index.js';
import type { WorkflowIrDocument } from '../../workflow-ir/index.js';
import { parseWorkflowIrDocument, computeWorkflowVersionSemanticDigest } from '../../workflow-ir/index.js';
import { requireUser, runAuthed } from '../plugins/auth.plugin.js';

/** The client-supplied pin request — validated, never trusted. */
interface PinRequest {
  organizationId: string;
  workflowId: string;
  versionId: string;
  installationId: string;
}

/** The authoritative installation record (the V2-002 read's shape). */
interface AuthoritativeInstallation {
  id: string;
  organizationId: string;
  workflowId: string;
  versionId: string;
}

export interface ReverseTeachingRouteDeps {
  /** The one reverse-teaching authority (V2-010 service). */
  reverseTeachingService: ReverseTeachingSessionService;
  /** The V2-002 repository (the authoritative version read for pins). */
  workflowRepositoryService: WorkflowRepositoryService;
}

/** Typed error code → HTTP status (never parse message strings). */
const ERROR_STATUS: Record<ReverseTeachingErrorCode, number> = {
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_ACTIVE: 409,
  SESSION_NOT_PAUSED: 409,
  SESSION_ALREADY_PAUSED: 409,
  SESSION_ALREADY_COMPLETED: 409,
  LEARNER_NOT_AUTHORIZED: 403,
  LESSON_NOT_BEGUN: 409,
  STEP_NOT_IN_LESSON: 400,
  STEP_OUT_OF_ORDER: 409,
  STEP_ALREADY_PERFORMED: 409,
  SAFETY_ACKNOWLEDGMENT_REQUIRED: 409,
  SAFETY_ACKNOWLEDGMENT_NOT_APPLICABLE: 409,
  SAFETY_ACKNOWLEDGMENT_ALREADY_GIVEN: 409,
  MANUAL_MODE_MISMATCH: 409,
  LEARNER_RESULT_INVALID: 400,
  STEPS_NOT_COMPLETE: 409,
  INSTALLATION_PIN_INVALID: 400,
  VERSION_PIN_MISMATCH: 409,
  PIN_DIGEST_ALGORITHM_UNSUPPORTED: 400,
  PIN_DIGEST_DOMAIN_MISMATCH: 400,
  IR_DOCUMENT_INVALID: 400,
  IR_GRAPH_CYCLE: 400,
  REVERSE_TEACHING_INPUT_INVALID: 400,
};

/** Typed error code → the stable wire identifier (kebab-case). */
function errorIdentifier(code: ReverseTeachingErrorCode): string {
  return `reverse-teaching-${code.toLowerCase().replace(/_/g, '-')}`;
}

/** A structurally-typed reply (the workflow-runs route precedent). */
type ReplyLike = { code: (n: number) => { send: (b: unknown) => void } };

function sendError(reply: ReplyLike, err: unknown): void {
  if (err instanceof ReverseTeachingError) {
    reply.code(ERROR_STATUS[err.code]).send({
      error: errorIdentifier(err.code),
      code: err.code,
      message: err.message,
    });
    return;
  }
  reply.code(500).send({ error: 'reverse-teaching-internal', message: String(err) });
}

function invalidRequest(reply: ReplyLike, message: string): void {
  reply.code(400).send({
    error: 'reverse-teaching-reverse-teaching-input-invalid',
    code: 'REVERSE_TEACHING_INPUT_INVALID',
    message,
  });
}

/**
 * The authoritative installed pin + document: the V2-002 installation
 * read (the pin authority) → the tuple validation → the pinned version
 * read BY THE INSTALLATION'S IDENTIFIERS → the V2-003 parse/digest.
 */
type PinResolution =
  | { ok: false; status: number; body: unknown }
  | {
      ok: true;
      pin: { workflowId: string; versionId: string; installationId: string; semanticDigest: unknown };
      document: WorkflowIrDocument;
    };

/** The unresolvable pin (installation invisible / not a member). */
function installationUnresolvable(): { ok: false; status: number; body: unknown } {
  return {
    ok: false,
    status: 404,
    body: {
      error: 'reverse-teaching-session-not-found',
      code: 'SESSION_NOT_FOUND',
      message: 'the installed workflow to teach from was not found',
    },
  };
}

async function resolvePin(
  repository: WorkflowRepositoryService,
  userId: string,
  input: PinRequest,
): Promise<PinResolution> {
  // 1. The AUTHORITATIVE installation read (V2-002 `getInstallation` —
  //    membership-checked, org-scoped). The installation's pinned tuple
  //    is the ONLY trusted source; client identifiers never reach the pin.
  let installation: AuthoritativeInstallation;
  try {
    const detail = await repository.getInstallation(
      { userId },
      input.organizationId,
      input.installationId,
    );
    installation = detail.installation;
  } catch {
    return installationUnresolvable();
  }

  // 2. The tuple validation (the run-service RUN_INSTALLATION_MISMATCH
  //    precedent): any disagreement between the client-supplied tuple and
  //    the installation's immutable pin FAILS CLOSED — a valid installation
  //    id can never be paired with another visible workflow/version/org.
  if (
    installation.organizationId !== input.organizationId ||
    installation.workflowId !== input.workflowId ||
    installation.versionId !== input.versionId
  ) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'reverse-teaching-installation-pin-invalid',
        code: 'INSTALLATION_PIN_INVALID',
        message: `installation ${input.installationId} pins (${installation.workflowId}, ${installation.versionId}) — not the requested (${input.workflowId}, ${input.versionId})`,
      },
    };
  }

  // 3. The pinned version read BY THE INSTALLATION'S OWN identifiers (the
  //    authoritative tuple, never the client's), then the V2-003 digest of
  //    that authoritative content.
  const documentResolution = await resolvePinnedDocument(
    repository,
    userId,
    installation,
  );
  if (!documentResolution.ok) {
    return documentResolution;
  }
  return {
    ok: true,
    pin: {
      workflowId: installation.workflowId,
      versionId: installation.versionId,
      installationId: installation.id,
      semanticDigest: computeWorkflowVersionSemanticDigest(documentResolution.document),
    },
    document: documentResolution.document,
  };
}

/**
 * The pinned version's document, read by the AUTHORITATIVE tuple. Used
 * both by `resolvePin` (creation) and by begin-lesson (the session's pin
 * already carries the installation-derived tuple; the V2-010 authority
 * itself verifies the document against the pin digest — VERSION_PIN_MISMATCH).
 */
async function resolvePinnedDocument(
  repository: WorkflowRepositoryService,
  userId: string,
  pin: Pick<AuthoritativeInstallation, 'workflowId' | 'versionId'>,
): Promise<{ ok: false; status: number; body: unknown } | { ok: true; document: WorkflowIrDocument }> {
  let versionContent: unknown;
  try {
    const version = await repository.getVersion({ userId }, pin.workflowId, pin.versionId);
    versionContent = version.content;
  } catch {
    return {
      ok: false,
      status: 404,
      body: {
        error: 'reverse-teaching-session-not-found',
        code: 'SESSION_NOT_FOUND',
        message: 'the workflow or version to teach was not found',
      },
    };
  }
  const parsed = parseWorkflowIrDocument(JSON.stringify(versionContent));
  if (!parsed.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'reverse-teaching-ir-document-invalid',
        code: 'IR_DOCUMENT_INVALID',
        message: 'the pinned version content is not a parseable WorkflowIR document',
      },
    };
  }
  return { ok: true, document: parsed.document };
}

export async function reverseTeachingRoutes(
  app: FastifyInstance,
  deps: ReverseTeachingRouteDeps,
): Promise<void> {
  const service = deps.reverseTeachingService;
  // The route-level resumability pointer (transport state ONLY).
  const sessionIndex = new Map<string, string>();
  const keyOf = (learnerId: string, workflowId: string, versionId: string, installationId: string) =>
    `${learnerId}|${workflowId}|${versionId}|${installationId}`;

  // --- session create-or-converge (the installed pin) ---------------------

  app.post('/reverse-teaching/sessions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.organizationId !== 'string' ||
        typeof body.workflowId !== 'string' ||
        typeof body.versionId !== 'string' ||
        typeof body.installationId !== 'string' ||
        body.organizationId.length === 0 ||
        body.workflowId.length === 0 ||
        body.versionId.length === 0 ||
        body.installationId.length === 0
      ) {
        invalidRequest(
          reply,
          'organizationId, workflowId, versionId and installationId are required',
        );
        return reply;
      }
      const existingId = sessionIndex.get(
        keyOf(user.id, body.workflowId, body.versionId, body.installationId),
      );
      if (existingId !== undefined) {
        try {
          const existing = service.getSession({ sessionId: existingId, learnerId: user.id });
          return reply.code(200).send({ session: existing, created: false });
        } catch (err) {
          sendError(reply, err);
          return reply;
        }
      }
      const resolved = await resolvePin(deps.workflowRepositoryService, user.id, {
        organizationId: body.organizationId,
        workflowId: body.workflowId,
        versionId: body.versionId,
        installationId: body.installationId,
      });
      if (!resolved.ok) {
        reply.code(resolved.status).send(resolved.body);
        return reply;
      }
      try {
        const session = service.createSession({
          learnerId: user.id,
          pin: resolved.pin as never,
        });
        sessionIndex.set(
          keyOf(user.id, body.workflowId, body.versionId, body.installationId),
          session.id,
        );
        return reply.code(201).send({ session, created: true });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- session read ---------------------------------------------------------

  app.get('/reverse-teaching/sessions/:sessionId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      try {
        const session = service.getSession({ sessionId, learnerId: user.id });
        return reply.code(200).send({ session });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- begin the lesson (the authority derives the manual-task view) -------

  app.post('/reverse-teaching/sessions/:sessionId/begin-lesson', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      try {
        const current = service.getSession({ sessionId, learnerId: user.id });
        // The session's pin carries the installation-derived authoritative
        // tuple (creation validated it against the V2-002 installation
        // read); the document is read BY THAT tuple and the V2-010 authority
        // verifies it against the pin digest (VERSION_PIN_MISMATCH).
        const resolved = await resolvePinnedDocument(
          deps.workflowRepositoryService,
          user.id,
          current.pin,
        );
        if (!resolved.ok) {
          reply.code(resolved.status).send(resolved.body);
          return reply;
        }
        const session = service.beginLesson({ sessionId, document: resolved.document });
        return reply.code(200).send({ session });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- safety acknowledgment (the gate before manual performance) ----------

  app.post('/reverse-teaching/sessions/:sessionId/steps/:nodeId/safety-ack', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId, nodeId } = req.params as { sessionId: string; nodeId: string };
      try {
        const session = service.acknowledgeStepSafety({
          sessionId,
          learnerId: user.id,
          nodeId,
        });
        return reply.code(200).send({ session });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- manual step performance (learning, never execution) -----------------

  app.post('/reverse-teaching/sessions/:sessionId/steps/:nodeId/perform', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId, nodeId } = req.params as { sessionId: string; nodeId: string };
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        (body.mode !== 'performed' && body.mode !== 'acknowledged_disclosure') ||
        typeof body.learnerResult !== 'string' ||
        (body.mode === 'performed' && body.learnerResult.trim().length === 0)
      ) {
        invalidRequest(reply, 'mode (performed | acknowledged_disclosure) and learnerResult are required');
        return reply;
      }
      try {
        const session = service.performManualStep({
          sessionId,
          learnerId: user.id,
          nodeId,
          mode: body.mode,
          learnerResult: body.learnerResult,
        });
        return reply.code(200).send({ session });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- pause / resume --------------------------------------------------------

  app.post('/reverse-teaching/sessions/:sessionId/pause', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      try {
        const session = service.pauseSession({ sessionId, learnerId: user.id });
        return reply.code(200).send({ session });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  app.post('/reverse-teaching/sessions/:sessionId/resume', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      try {
        const result = service.resumeSession({ sessionId, learnerId: user.id });
        return reply.code(200).send({
          session: result.session,
          resumeStepNodeId: result.resumeStepNodeId,
        });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- finalization (the manual lesson's completion) -------------------------

  app.post('/reverse-teaching/sessions/:sessionId/finalize', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      try {
        const finalization = service.finalizeLesson({ sessionId, learnerId: user.id });
        const session = service.getSession({ sessionId, learnerId: user.id });
        return reply.code(200).send({ session, finalization });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });
}
