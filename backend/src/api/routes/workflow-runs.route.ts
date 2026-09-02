/**
 * V2-005 — Workflow Runs routes: the HTTP surface for durable Run state and
 * evidence (run commands + reconstructed history over the WorkflowRunService).
 *
 * ROUTES (all backend-authorized: a resolved human principal via the auth
 * plugin's API-key/session path; tenant scoping + lifecycle legality is
 * decided by the WorkflowRunService, which consumes the identity authority's
 * membership facts):
 *
 *   POST   /organizations/:orgId/workflow-runs/runs
 *          — request a run (create-or-converge on the deterministic trigger
 *            surface; 201 created / 200 converged)
 *   GET    /organizations/:orgId/workflow-runs/runs
 *          — the tenant's runs (member-only)
 *   GET    /workflow-runs/runs/:runId
 *          — read one run (tenant-scoped)
 *   GET    /workflow-runs/runs/:runId/history
 *          — the full reconstructed execution history (the crash-recovery
 *            projection: timeline, attempts, steps, invocations, evidence,
 *            attestation bindings + rejections, the command log)
 *   POST   /workflow-runs/runs/:runId/{start|pause|resume|interrupt|cancel|complete|fail}
 *          — the lifecycle commands (idempotent; typed rejections)
 *   POST   /workflow-runs/runs/:runId/steps/:stepId/{started|completed}
 *          — step execution records (declared steps only)
 *   POST   /workflow-runs/runs/:runId/invocations
 *          — capability invocation records (canonical registry names only)
 *   POST   /workflow-runs/runs/:runId/invocations/:invocationId/completed
 *          — invocation outcome records
 *   POST   /workflow-runs/runs/:runId/evidence
 *          — evidence records (registry classes + provenance; 201/200)
 *   POST   /workflow-runs/runs/:runId/attestations
 *          — attach a V2-014 ExecutionAttestation (the Run boundary verifies
 *            digest, statement binding, freshness + durable single-use; a
 *            typed rejection is never attached and never evidence)
 *
 * Every mutating route body carries the deterministic command envelope
 * (commandId + correlationId, optional causationId) — the exactly-once
 * idempotency boundary lives in the service's PostgreSQL command log.
 *
 * Denied reads answer a UNIFORM 404 'workflow-run-not-found' so cross-tenant
 * runs do not leak their existence. The route layer is transport only — the
 * module is the authority.
 */
import type { FastifyInstance } from 'fastify';
import type {
  RunAttempt,
  RunAttestationBinding,
  RunAttestationRejection,
  RunCapabilityInvocation,
  RunCommandRecord,
  RunEvidenceRecord,
  RunStepExecution,
  RunTimelineEntry,
  WorkflowRun,
  WorkflowRunErrorCode,
  WorkflowRunHistory,
  WorkflowRunService,
} from '../../workflow-runs/index.js';
import { WorkflowRunError } from '../../workflow-runs/index.js';
import { requireUser, runAuthed } from '../plugins/auth.plugin.js';

export interface WorkflowRunsRouteDeps {
  /** The one run/evidence authority (V2-005 service). */
  workflowRunService: WorkflowRunService;
}

/** Typed error code → HTTP status (never parse message strings). */
const ERROR_STATUS: Record<WorkflowRunErrorCode, number> = {
  RUN_NOT_FOUND: 404,
  // Uniform 404 for cross-tenant/missing runs: no existence leak.
  RUN_NOT_ORGANIZATION_MEMBER: 403,
  RUN_VERSION_NOT_OF_WORKFLOW: 400,
  RUN_VERSION_CONTENT_NOT_PARSEABLE: 400,
  RUN_INSTALLATION_MISMATCH: 400,
  RUN_INVALID_TRIGGER_TYPE: 400,
  RUN_INVALID_INPUT_COMMITMENTS: 400,
  RUN_INVALID_STATE_TRANSITION: 409,
  RUN_TERMINAL: 409,
  RUN_NOT_RUNNING: 409,
  RUN_ATTEMPT_NOT_FOUND: 404,
  RUN_STEP_NOT_DECLARED: 409,
  RUN_STEP_ALREADY_RECORDED: 409,
  RUN_INVOCATION_NOT_FOUND: 404,
  RUN_INVOCATION_ALREADY_COMPLETED: 409,
  RUN_CAPABILITY_NON_CANONICAL: 400,
  RUN_EXECUTION_CLASS_INVALID: 400,
  RUN_EVIDENCE_CLASS_INVALID: 400,
  RUN_EVIDENCE_PRODUCER_REQUIRED: 400,
  RUN_ATTESTATION_MALFORMED: 400,
  RUN_ATTESTATION_REJECTED: 422,
  RUN_ATTESTATION_REPLAYED: 409,
  RUN_COMMAND_ID_INVALID: 400,
  RUN_COMMAND_CORRELATION_ID_INVALID: 400,
  RUN_COMMAND_PAYLOAD_CONFLICT: 409,
  RUN_COMMAND_IN_FLIGHT: 409,
  RUN_INVALID_REQUEST: 400,
};

/** Typed error code → the stable wire identifier (kebab-case, no leak). */
function errorIdentifier(code: WorkflowRunErrorCode): string {
  return `workflow-run-${code.toLowerCase().replace(/^run_/, '').replace(/_/g, '-')}`;
}

function sendRunError(
  reply: { code: (n: number) => { send: (b: unknown) => void } },
  err: unknown,
): void {
  if (err instanceof WorkflowRunError) {
    const status = ERROR_STATUS[err.code] ?? 400;
    reply.code(status).send({
      error: errorIdentifier(err.code),
      code: err.code,
      message: err.message,
    });
    return;
  }
  reply.code(500).send({
    error: 'workflow-runs-internal-error',
    message: (err as Error).message,
  });
}

// --- wire serializers (deterministic key order; fixed-format UTC) ----------

function serializeRun(run: WorkflowRun): Record<string, unknown> {
  return {
    id: run.id,
    organizationId: run.organizationId,
    workflowId: run.workflowId,
    versionId: run.versionId,
    versionContentDigest: run.versionContentDigest,
    versionSemanticDigest: run.versionSemanticDigest,
    installationId: run.installationId,
    trigger: run.trigger,
    triggeredByUserId: run.triggeredByUserId,
    inputCommitments: run.inputCommitments,
    inputDigest: run.inputDigest,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function serializeAttempt(attempt: RunAttempt): Record<string, unknown> {
  return {
    id: attempt.id,
    runId: attempt.runId,
    attemptNumber: attempt.attemptNumber,
    state: attempt.state,
    nodeId: attempt.nodeId,
    pausedAtStepId: attempt.pausedAtStepId,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
  };
}

function serializeStep(step: RunStepExecution): Record<string, unknown> {
  return {
    id: step.id,
    runId: step.runId,
    attemptNumber: step.attemptNumber,
    stepId: step.stepId,
    status: step.status,
    inputCommitments: step.inputCommitments,
    outputCommitments: step.outputCommitments,
    outcome: step.outcome,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
  };
}

function serializeInvocation(invocation: RunCapabilityInvocation): Record<string, unknown> {
  return {
    id: invocation.id,
    runId: invocation.runId,
    attemptNumber: invocation.attemptNumber,
    stepId: invocation.stepId,
    capability: invocation.capability,
    executionClass: invocation.executionClass,
    inputCommitments: invocation.inputCommitments,
    outputCommitments: invocation.outputCommitments,
    outcome: invocation.outcome,
    requestedAt: invocation.requestedAt,
    completedAt: invocation.completedAt,
  };
}

function serializeEvidence(evidence: RunEvidenceRecord): Record<string, unknown> {
  return {
    id: evidence.id,
    runId: evidence.runId,
    attemptNumber: evidence.attemptNumber,
    stepId: evidence.stepId,
    evidenceClass: evidence.evidenceClass,
    producerKind: evidence.producerKind,
    producerId: evidence.producerId,
    contentCommitment: evidence.contentCommitment,
    description: evidence.description,
    recordedAt: evidence.recordedAt,
  };
}

function serializeBinding(binding: RunAttestationBinding): Record<string, unknown> {
  return {
    attestationId: binding.attestationId,
    runId: binding.runId,
    attemptNumber: binding.attemptNumber,
    stepId: binding.stepId,
    executionDigest: binding.executionDigest,
    attesterKeyId: binding.attesterKeyId,
    assurance: binding.assurance,
    nonce: binding.nonce,
    statement: binding.statement,
    verifiedAt: binding.verifiedAt,
    attachedAt: binding.attachedAt,
  };
}

function serializeRejection(rejection: RunAttestationRejection): Record<string, unknown> {
  return {
    id: rejection.id,
    runId: rejection.runId,
    attestationId: rejection.attestationId,
    failureCode: rejection.failureCode,
    detail: rejection.detail,
    rejectedAt: rejection.rejectedAt,
  };
}

function serializeTimelineEntry(entry: RunTimelineEntry): Record<string, unknown> {
  return {
    id: entry.id,
    runId: entry.runId,
    attemptNumber: entry.attemptNumber,
    stepId: entry.stepId,
    eventName: entry.eventName,
    occurredAt: entry.occurredAt,
    sequence: entry.sequence,
    detail: entry.detail,
  };
}

function serializeCommand(command: RunCommandRecord): Record<string, unknown> {
  return {
    id: command.id,
    organizationId: command.organizationId,
    commandId: command.commandId,
    correlationId: command.correlationId,
    causationId: command.causationId,
    commandType: command.commandType,
    payloadDigest: command.payloadDigest,
    result: command.result,
    executedAt: command.executedAt,
  };
}

function serializeHistory(history: WorkflowRunHistory): Record<string, unknown> {
  return {
    run: serializeRun(history.run),
    timeline: history.timeline.map(serializeTimelineEntry),
    attempts: history.attempts.map(serializeAttempt),
    steps: history.steps.map(serializeStep),
    invocations: history.invocations.map(serializeInvocation),
    evidence: history.evidence.map(serializeEvidence),
    attestations: history.attestations.map(serializeBinding),
    attestationRejections: history.attestationRejections.map(serializeRejection),
    commands: history.commands.map(serializeCommand),
  };
}

/** Structural presence checks (the service validates canonical shapes). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The deterministic command envelope (idempotency + correlation + causation). */
function readEnvelope(body: Record<string, unknown>): {
  commandId: string;
  correlationId: string;
  causationId?: string;
} {
  if (typeof body.commandId !== 'string' || typeof body.correlationId !== 'string') {
    throw new WorkflowRunError(
      'RUN_COMMAND_ID_INVALID',
      'every mutating run command carries a deterministic envelope: commandId and correlationId are required (causationId optional)',
    );
  }
  return typeof body.causationId === 'string'
    ? { commandId: body.commandId, correlationId: body.correlationId, causationId: body.causationId }
    : { commandId: body.commandId, correlationId: body.correlationId };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalCommitments(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined;
}

export async function workflowRunsRoutes(
  app: FastifyInstance,
  deps: WorkflowRunsRouteDeps,
): Promise<void> {
  const service = deps.workflowRunService;

  // --- request a run (create-or-converge on the trigger surface) ------------

  app.post('/organizations/:orgId/workflow-runs/runs', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.workflowId !== 'string' ||
        typeof body.versionId !== 'string' ||
        !isRecord(body.trigger)
      ) {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'workflowId, versionId and trigger are required',
        });
      }
      try {
        const envelope = readEnvelope(body);
        const outcome = await service.requestRun({ userId: user.id }, envelope, {
          organizationId: orgId,
          workflowId: body.workflowId,
          versionId: body.versionId,
          installationId:
            body.installationId === undefined || body.installationId === null
              ? null
              : String(body.installationId),
          trigger: body.trigger as never,
          inputCommitments: Array.isArray(body.inputCommitments)
            ? (body.inputCommitments as string[])
            : [],
        });
        return reply
          // 201 ONLY when THIS request actually created the run; a converged
          // replay (or a duplicate trigger delivery under a new command id)
          // answers 200 with the SAME durable run identity.
          .code(outcome.executed && outcome.result.created ? 201 : 200)
          .send({
            run: serializeRun(outcome.result.run),
            created: outcome.result.created,
            executed: outcome.executed,
          });
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  // --- list the tenant's runs (member-only) -----------------------------------

  app.get('/organizations/:orgId/workflow-runs/runs', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      try {
        const runs = await service.listRunsInOrganization({ userId: user.id }, orgId);
        return { runs: runs.map(serializeRun) };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  // --- read one run (tenant-scoped; uniform 404) -------------------------------

  app.get('/workflow-runs/runs/:runId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      try {
        const run = await service.getRun({ userId: user.id }, runId);
        return { run: serializeRun(run) };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  // --- the full reconstructed execution history ---------------------------------

  app.get('/workflow-runs/runs/:runId/history', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      try {
        const history = await service.getRunHistory({ userId: user.id }, runId);
        return serializeHistory(history);
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  // --- the lifecycle commands -----------------------------------------------------

  app.post('/workflow-runs/runs/:runId/start', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const outcome = await service.startRun({ userId: user.id }, readEnvelope(body), {
          runId,
          nodeId: optionalString(body.nodeId),
        });
        return {
          run: serializeRun(outcome.result.run),
          attempt: outcome.result.attempt ? serializeAttempt(outcome.result.attempt) : null,
          executed: outcome.executed,
        };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  app.post('/workflow-runs/runs/:runId/pause', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const outcome = await service.pauseRun({ userId: user.id }, readEnvelope(body), {
          runId,
          atStepId: optionalString(body.atStepId),
        });
        return {
          run: serializeRun(outcome.result.run),
          attempt: outcome.result.attempt ? serializeAttempt(outcome.result.attempt) : null,
          executed: outcome.executed,
        };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  app.post('/workflow-runs/runs/:runId/resume', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const outcome = await service.resumeRun({ userId: user.id }, readEnvelope(body), {
          runId,
          nodeId: optionalString(body.nodeId),
        });
        return {
          run: serializeRun(outcome.result.run),
          attempt: serializeAttempt(outcome.result.attempt),
          resumedAtStepId: outcome.result.resumedAtStepId,
          newAttempt: outcome.result.newAttempt,
          executed: outcome.executed,
        };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  app.post('/workflow-runs/runs/:runId/interrupt', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const outcome = await service.interruptRunAttempt({ userId: user.id }, readEnvelope(body), {
          runId,
          reason: optionalString(body.reason),
        });
        return {
          run: serializeRun(outcome.result.run),
          attempt: outcome.result.attempt ? serializeAttempt(outcome.result.attempt) : null,
          executed: outcome.executed,
        };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  app.post('/workflow-runs/runs/:runId/cancel', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const outcome = await service.cancelRun({ userId: user.id }, readEnvelope(body), {
          runId,
          reason: optionalString(body.reason),
        });
        return {
          run: serializeRun(outcome.result.run),
          attempt: outcome.result.attempt ? serializeAttempt(outcome.result.attempt) : null,
          executed: outcome.executed,
        };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  app.post('/workflow-runs/runs/:runId/complete', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const outcome = await service.completeRun({ userId: user.id }, readEnvelope(body), {
          runId,
          outputCommitments: optionalCommitments(body.outputCommitments),
        });
        return {
          run: serializeRun(outcome.result.run),
          attempt: outcome.result.attempt ? serializeAttempt(outcome.result.attempt) : null,
          executed: outcome.executed,
        };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  app.post('/workflow-runs/runs/:runId/fail', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const outcome = await service.failRun({ userId: user.id }, readEnvelope(body), {
          runId,
          reason: optionalString(body.reason),
        });
        return {
          run: serializeRun(outcome.result.run),
          attempt: outcome.result.attempt ? serializeAttempt(outcome.result.attempt) : null,
          executed: outcome.executed,
        };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  // --- step execution records (declared steps only) ------------------------------

  app.post('/workflow-runs/runs/:runId/steps/:stepId/started', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId, stepId } = req.params as { runId: string; stepId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const outcome = await service.recordStepStarted({ userId: user.id }, readEnvelope(body), {
          runId,
          stepId,
          inputCommitments: optionalCommitments(body.inputCommitments),
        });
        return { step: serializeStep(outcome.result.step), executed: outcome.executed };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  app.post('/workflow-runs/runs/:runId/steps/:stepId/completed', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId, stepId } = req.params as { runId: string; stepId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.outcome !== 'succeeded' && body.outcome !== 'failed') {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'outcome must be succeeded|failed (the executor\'s claimed outcome)',
        });
      }
      try {
        const outcome = await service.recordStepCompleted({ userId: user.id }, readEnvelope(body), {
          runId,
          stepId,
          outcome: body.outcome,
          outputCommitments: optionalCommitments(body.outputCommitments),
        });
        return { step: serializeStep(outcome.result.step), executed: outcome.executed };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  // --- capability invocation records (canonical registry names only) ---------------

  app.post('/workflow-runs/runs/:runId/invocations', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.capability !== 'string' || typeof body.executionClass !== 'string') {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'capability and executionClass are required (canonical registry identifiers)',
        });
      }
      try {
        const outcome = await service.recordInvocationRequested(
          { userId: user.id },
          readEnvelope(body),
          {
            runId,
            capability: body.capability,
            executionClass: body.executionClass as never,
            stepId: optionalString(body.stepId),
            inputCommitments: optionalCommitments(body.inputCommitments),
          },
        );
        return {
          invocation: serializeInvocation(outcome.result.invocation),
          executed: outcome.executed,
        };
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  app.post(
    '/workflow-runs/runs/:runId/invocations/:invocationId/completed',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const user = await requireUser(req, reply);
        const { runId, invocationId } = req.params as {
          runId: string;
          invocationId: string;
        };
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (body.outcome !== 'succeeded' && body.outcome !== 'failed') {
          return reply.code(400).send({
            error: 'invalid-request',
            message: 'outcome must be succeeded|failed (the executor\'s claimed outcome)',
          });
        }
        try {
          const outcome = await service.recordInvocationCompleted(
            { userId: user.id },
            readEnvelope(body),
            {
              runId,
              invocationId,
              outcome: body.outcome,
              outputCommitments: optionalCommitments(body.outputCommitments),
            },
          );
          return {
            invocation: serializeInvocation(outcome.result.invocation),
            executed: outcome.executed,
          };
        } catch (err) {
          return sendRunError(reply, err);
        }
      });
    },
  );

  // --- evidence records (registry classes + provenance) ---------------------------

  app.post('/workflow-runs/runs/:runId/evidence', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (
        typeof body.evidenceClass !== 'string' ||
        typeof body.producerKind !== 'string' ||
        typeof body.producerId !== 'string' ||
        typeof body.contentCommitment !== 'string'
      ) {
        return reply.code(400).send({
          error: 'invalid-request',
          message:
            'evidenceClass, producerKind, producerId and contentCommitment are required (provenance is mandatory)',
        });
      }
      try {
        const outcome = await service.recordEvidence({ userId: user.id }, readEnvelope(body), {
          runId,
          attemptNumber: typeof body.attemptNumber === 'number' ? body.attemptNumber : undefined,
          stepId: optionalString(body.stepId),
          evidenceClass: body.evidenceClass as never,
          producerKind: body.producerKind,
          producerId: body.producerId,
          contentCommitment: body.contentCommitment,
          description: optionalString(body.description),
        });
        return reply
          // 201 ONLY when THIS request recorded the new evidence record; a
          // converged re-delivery answers 200 with the SAME record identity.
          .code(outcome.executed && outcome.result.created ? 201 : 200)
          .send({
            evidence: { ...serializeEvidence(outcome.result.evidence), created: outcome.result.created },
            executed: outcome.executed,
          });
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });

  // --- attach a V2-014 ExecutionAttestation (the Run boundary verifies) -----------

  app.post('/workflow-runs/runs/:runId/attestations', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { runId } = req.params as { runId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.attemptNumber !== 'number' || !isRecord(body.attestation)) {
        return reply.code(400).send({
          error: 'invalid-request',
          message:
            'attemptNumber and attestation (the V2-014 envelope) are required; policy is optional',
        });
      }
      try {
        const outcome = await service.attachAttestation({ userId: user.id }, readEnvelope(body), {
          runId,
          attemptNumber: body.attemptNumber,
          stepId: optionalString(body.stepId),
          attestation: body.attestation as never,
          policy: isRecord(body.policy)
            ? {
                maxAgeMs: typeof body.policy.maxAgeMs === 'number' ? body.policy.maxAgeMs : undefined,
                requiredAssurance:
                  typeof body.policy.requiredAssurance === 'string'
                    ? (body.policy.requiredAssurance as never)
                    : undefined,
                trustedAttesterKeyIds: Array.isArray(body.policy.trustedAttesterKeyIds)
                  ? (body.policy.trustedAttesterKeyIds as string[])
                  : undefined,
              }
            : undefined,
        });
        return reply.code(201).send({
          binding: serializeBinding(outcome.result.binding),
          evidence: serializeEvidence(outcome.result.evidence),
          executed: outcome.executed,
        });
      } catch (err) {
        return sendRunError(reply, err);
      }
    });
  });
}
