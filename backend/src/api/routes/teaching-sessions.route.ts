/**
 * V2-017 T9 — the teaching-sessions TRANSPORT routes.
 *
 * Transport ONLY (the workflow-runs/workflow-deployments route
 * precedent): every teaching decision, state transition, derivation,
 * and validation stays V2-006's `TeachingSessionService` (the frozen
 * authority — no teaching semantics are defined, redefined, or
 * re-validated here). This route layer exists because the consumer
 * Teach Me surface (V2-017 T9) must compose the AUTHORITY over HTTP —
 * the V2-017 rule-9 pattern: a backend addition that consumes an
 * existing public authority.
 *
 * Composition (all consumed):
 *   - the V2-002 repository read (getVersion — visibility-checked) +
 *     the V2-003 barrel (parseWorkflowIrDocument +
 *     computeWorkflowVersionSemanticDigest) resolve the session pin
 *     from the authoritative version content — the route NEVER trusts
 *     a client-supplied digest or document;
 *   - the V2-006 service owns createSession / beginLesson / checkpoint
 *     / practice / pause / resume / assessment;
 *   - a ROUTE-LEVEL learner→session pointer index (a Map from
 *     learner|workflow|version to the session id) gives the consumer
 *     create-or-converge semantics for RESUMABILITY. It stores NO
 *     teaching state — only the request-routing pointer; every read
 *     and every transition goes to the authority's own store.
 *
 * Honesty rules: typed errors map to HTTP codes (never message
 * parsing); the wire identifiers are kebab-case; the session payload
 * is a pass-through of the authority's own JSON-safe record (the
 * frontend renders, never re-derives).
 */
import type { FastifyInstance } from 'fastify';
import type {
  TeachingSessionErrorCode,
  TeachingSessionService,
} from '../../teaching-sessions/index.js';
import { TeachingSessionError } from '../../teaching-sessions/index.js';
import type { WorkflowRepositoryService } from '../../workflow-repository/index.js';
import type { WorkflowIrDocument } from '../../workflow-ir/index.js';
import { parseWorkflowIrDocument, computeWorkflowVersionSemanticDigest } from '../../workflow-ir/index.js';
import { requireUser, runAuthed } from '../plugins/auth.plugin.js';

export interface TeachingSessionsRouteDeps {
  /** The one teaching authority (V2-006 service). */
  teachingSessionService: TeachingSessionService;
  /** The V2-002 repository (the authoritative version read for pins). */
  workflowRepositoryService: WorkflowRepositoryService;
}

/** Typed error code → HTTP status (never parse message strings). */
const ERROR_STATUS: Record<TeachingSessionErrorCode, number> = {
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_ACTIVE: 409,
  SESSION_NOT_PAUSED: 409,
  SESSION_ALREADY_PAUSED: 409,
  SESSION_ALREADY_COMPLETED: 409,
  LEARNER_NOT_AUTHORIZED: 403,
  LESSON_NOT_BEGUN: 409,
  CHECKPOINT_NOT_IN_LESSON: 400,
  CHECKPOINT_OUT_OF_ORDER: 409,
  CHECKPOINT_ALREADY_CONFIRMED: 409,
  CHECKPOINTS_NOT_COMPLETE: 409,
  PRACTICE_STEP_NOT_IN_LESSON: 400,
  ASSESSMENT_INVALID_STRUCTURE: 400,
  VERSION_PIN_MISMATCH: 409,
  PIN_DIGEST_ALGORITHM_UNSUPPORTED: 400,
  PIN_DIGEST_DOMAIN_MISMATCH: 400,
  IR_DOCUMENT_INVALID: 400,
  IR_GRAPH_CYCLE: 400,
  QUESTION_NOT_FOUND: 404,
  QUESTION_ALREADY_RESOLVED: 409,
  TEACHING_INPUT_INVALID: 400,
};

/** Typed error code → the stable wire identifier (kebab-case). */
function errorIdentifier(code: TeachingSessionErrorCode): string {
  return `teaching-sessions-${code.toLowerCase().replace(/_/g, '-')}`;
}

/** A structurally-typed reply (the workflow-runs route precedent). */
type ReplyLike = { code: (n: number) => { send: (b: unknown) => void } };

function sendError(reply: ReplyLike, err: unknown): void {
  if (err instanceof TeachingSessionError) {
    reply.code(ERROR_STATUS[err.code]).send({
      error: errorIdentifier(err.code),
      code: err.code,
      message: err.message,
    });
    return;
  }
  reply.code(500).send({ error: 'teaching-sessions-internal', message: String(err) });
}

function invalidRequest(reply: ReplyLike, message: string): void {
  reply.code(400).send({
    error: 'teaching-sessions-teaching-input-invalid',
    code: 'TEACHING_INPUT_INVALID',
    message,
  });
}

/** The authoritative pin + document (the V2-002 read + the V2-003 parse/digest). */
type PinResolution =
  | { ok: false; status: number; body: unknown }
  | { ok: true; pinned: { workflowId: string; versionId: string; semanticDigest: unknown }; document: WorkflowIrDocument };

async function resolvePin(
  repository: WorkflowRepositoryService,
  userId: string,
  workflowId: string,
  versionId: string,
): Promise<PinResolution> {
  let versionContent: unknown;
  try {
    const version = await repository.getVersion({ userId }, workflowId, versionId);
    versionContent = version.content;
  } catch {
    return {
      ok: false,
      status: 404,
      body: {
        error: 'teaching-sessions-session-not-found',
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
        error: 'teaching-sessions-ir-document-invalid',
        code: 'IR_DOCUMENT_INVALID',
        message: 'the pinned version content is not a parseable WorkflowIR document',
      },
    };
  }
  return {
    ok: true,
    pinned: {
      workflowId,
      versionId,
      semanticDigest: computeWorkflowVersionSemanticDigest(parsed.document),
    },
    document: parsed.document,
  };
}

export async function teachingSessionsRoutes(
  app: FastifyInstance,
  deps: TeachingSessionsRouteDeps,
): Promise<void> {
  const service = deps.teachingSessionService;
  // The route-level resumability pointer (transport state ONLY: which
  // session id to read for this learner+pin; no teaching state lives
  // here — every read/transition goes to the authority's store).
  const sessionIndex = new Map<string, string>();
  const keyOf = (learnerId: string, workflowId: string, versionId: string) =>
    `${learnerId}|${workflowId}|${versionId}`;

  // --- session create-or-converge (the resumable entry) -----------------

  app.post('/teaching-sessions/sessions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.workflowId !== 'string' ||
        typeof body.versionId !== 'string' ||
        body.workflowId.length === 0 ||
        body.versionId.length === 0
      ) {
        invalidRequest(reply, 'workflowId and versionId are required');
        return reply;
      }
      // Converge on the learner's existing session for this exact pin.
      const existingId = sessionIndex.get(keyOf(user.id, body.workflowId, body.versionId));
      if (existingId !== undefined) {
        try {
          const existing = service.getSession({ sessionId: existingId, learnerId: user.id });
          return reply.code(200).send({ session: existing, created: false });
        } catch (err) {
          sendError(reply, err);
          return reply;
        }
      }
      const pin = await resolvePin(
        deps.workflowRepositoryService,
        user.id,
        body.workflowId,
        body.versionId,
      );
      if (!pin.ok) {
        reply.code(pin.status).send(pin.body);
        return reply;
      }
      try {
        const session = service.createSession({
          learnerId: user.id,
          pinned: pin.pinned as never,
        });
        sessionIndex.set(keyOf(user.id, body.workflowId, body.versionId), session.id);
        return reply.code(201).send({ session, created: true });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- session read -------------------------------------------------------

  app.get('/teaching-sessions/sessions/:sessionId', async (req, reply) => {
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

  // --- begin the lesson (the authority derives from the pinned content) --

  app.post('/teaching-sessions/sessions/:sessionId/begin-lesson', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      try {
        const current = service.getSession({ sessionId, learnerId: user.id });
        const pin = await resolvePin(
          deps.workflowRepositoryService,
          user.id,
          current.pinned.workflowId,
          current.pinned.versionId,
        );
        if (!pin.ok) {
          reply.code(pin.status).send(pin.body);
          return reply;
        }
        const session = service.beginLesson({ sessionId, document: pin.document });
        return reply.code(200).send({ session });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- practice questions (the authority's own derivation) ---------------

  app.get('/teaching-sessions/sessions/:sessionId/practice-questions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      try {
        const questions = service.listPracticeQuestions({ sessionId, learnerId: user.id });
        return reply.code(200).send({ questions });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- checkpoint confirmation (the learner action) ------------------------

  app.post('/teaching-sessions/sessions/:sessionId/checkpoints/confirm', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      const body = req.body as Record<string, unknown> | null;
      if (!body || typeof body.nodeId !== 'string' || body.nodeId.length === 0) {
        invalidRequest(reply, 'nodeId is required');
        return reply;
      }
      try {
        const session = service.confirmCheckpoint({
          sessionId,
          learnerId: user.id,
          nodeId: body.nodeId,
        });
        return reply.code(200).send({ session });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- practice attempt (typed outcome, never a session error) -------------

  app.post('/teaching-sessions/sessions/:sessionId/practice', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.nodeId !== 'string' ||
        body.nodeId.length === 0 ||
        typeof body.answer !== 'string'
      ) {
        invalidRequest(reply, 'nodeId and answer are required');
        return reply;
      }
      try {
        const result = service.attemptPractice({
          sessionId,
          learnerId: user.id,
          nodeId: body.nodeId,
          answer: body.answer,
        });
        const session = service.getSession({ sessionId, learnerId: user.id });
        return reply.code(200).send({ session, result });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- pause / resume (resumable state) ------------------------------------

  app.post('/teaching-sessions/sessions/:sessionId/pause', async (req, reply) => {
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

  app.post('/teaching-sessions/sessions/:sessionId/resume', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      try {
        const result = service.resumeSession({ sessionId, learnerId: user.id });
        return reply.code(200).send({
          session: result.session,
          resumeCheckpointNodeId: result.resumeCheckpointNodeId,
        });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- the independent performance assessment (completion) ----------------

  app.post('/teaching-sessions/sessions/:sessionId/assessment', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { sessionId } = req.params as { sessionId: string };
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        !Array.isArray(body.orderedStepIds) ||
        body.orderedStepIds.some((id) => typeof id !== 'string') ||
        typeof body.semanticsByStep !== 'object' ||
        body.semanticsByStep === null ||
        Array.isArray(body.semanticsByStep)
      ) {
        invalidRequest(reply, 'orderedStepIds and semanticsByStep are required');
        return reply;
      }
      try {
        const outcome = service.submitIndependentPerformance({
          sessionId,
          learnerId: user.id,
          orderedStepIds: body.orderedStepIds as string[],
          semanticsByStep: body.semanticsByStep as Record<string, string>,
        });
        const session = service.getSession({ sessionId, learnerId: user.id });
        return reply.code(200).send({ session, outcome });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });
}
