/**
 * V2-009 — Workflow Deployments routes: the HTTP surface for the trigger
 * layer (deployments, subscriptions, the event inbox, the engine tick,
 * delivery reads, manual launch).
 *
 * ROUTES (all backend-authorized: a resolved human principal via the auth
 * plugin's API-key/session path; tenant scoping + typed rejections are
 * decided by the WorkflowDeploymentService, which consumes the identity
 * authority's membership facts):
 *
 *   POST   /organizations/:orgId/workflow-deployments/deployments
 *          — create a deployment (pin + placement policy; plan-compatibility
 *            validated; 201 created / 200 converged)
 *   GET    /organizations/:orgId/workflow-deployments/deployments
 *          — the tenant's deployments (member-only; the user-visible
 *            enable/disable state)
 *   GET    /workflow-deployments/deployments/:deploymentId
 *          — read one deployment (tenant-scoped)
 *   POST   /workflow-deployments/deployments/:deploymentId/{enable|disable}
 *          — the user-visible enable/disable state (typed same-state rejections)
 *   POST   /workflow-deployments/deployments/:deploymentId/subscriptions
 *          — create a trigger subscription (schedule or typed event pattern)
 *   GET    /workflow-deployments/deployments/:deploymentId/subscriptions
 *          — list the deployment's subscriptions
 *   GET    /workflow-deployments/subscriptions/:subscriptionId
 *   POST   /workflow-deployments/subscriptions/:subscriptionId/{enable|disable}
 *   POST   /organizations/:orgId/workflow-deployments/events
 *          — deliver one inbound event (idempotent: duplicate (source,
 *            eventId) converges; typed schema validation)
 *   POST   /organizations/:orgId/workflow-deployments/tick
 *          — advance the engine for the tenant (due schedules + pending
 *            retries; deterministic given clock + state; NO hidden
 *            autonomous engine — the platform drives the tick)
 *   GET    /workflow-deployments/deliveries/:deliveryId
 *          — one delivery (state, attempts, placement, run correlation)
 *   GET    /workflow-deployments/deployments/:deploymentId/deliveries
 *          — the deployment's deliveries
 *   POST   /workflow-deployments/deployments/:deploymentId/runs
 *          — manual launch through the deployment pin (enable-gated; the
 *            V2-005 boundary create-or-converges on the command envelope)
 *
 * Denied reads answer a UNIFORM 404 'workflow-deployment-not-found' so
 * cross-tenant resources do not leak their existence. The route layer is
 * transport only — the module is the authority.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  TriggerDelivery,
  TriggerSubscription,
  WorkflowDeployment,
  WorkflowDeploymentErrorCode,
  WorkflowDeploymentService,
} from '../../workflow-deployments/index.js';
import { WorkflowDeploymentError } from '../../workflow-deployments/index.js';
import { requireUser, runAuthed } from '../plugins/auth.plugin.js';

export interface WorkflowDeploymentsRouteDeps {
  /** The one trigger-layer authority (V2-009 service). */
  workflowDeploymentService: WorkflowDeploymentService;
}

/** Typed error code → HTTP status (never parse message strings). */
const ERROR_STATUS: Record<WorkflowDeploymentErrorCode, number> = {
  DEPLOYMENT_NOT_FOUND: 404,
  // Uniform 404 for cross-tenant/missing deployments: no existence leak.
  DEPLOYMENT_NOT_ORGANIZATION_MEMBER: 403,
  DEPLOYMENT_INVALID_REQUEST: 400,
  DEPLOYMENT_INVALID_NAME: 400,
  DEPLOYMENT_INVALID_PLACEMENT: 400,
  DEPLOYMENT_VERSION_NOT_OF_WORKFLOW: 400,
  DEPLOYMENT_PLAN_INCOMPATIBLE: 422,
  DEPLOYMENT_ALREADY_DISABLED: 409,
  DEPLOYMENT_ALREADY_ENABLED: 409,
  SUBSCRIPTION_NOT_FOUND: 404,
  SUBSCRIPTION_KIND_INVALID: 400,
  SUBSCRIPTION_SCHEDULE_INVALID: 400,
  SUBSCRIPTION_EVENT_PATTERN_INVALID: 400,
  SUBSCRIPTION_EVENT_TYPE_UNKNOWN: 400,
  SUBSCRIPTION_EVENT_MATCH_INVALID: 400,
  SUBSCRIPTION_DELIVERY_POLICY_INVALID: 400,
  SUBSCRIPTION_ALREADY_DISABLED: 409,
  SUBSCRIPTION_ALREADY_ENABLED: 409,
  EVENT_INVALID_REQUEST: 400,
  EVENT_TYPE_UNKNOWN: 400,
  EVENT_SCHEMA_INVALID: 400,
  DELIVERY_NOT_FOUND: 404,
  DELIVERY_NOT_PENDING: 409,
  TRIGGER_COMMAND_ID_INVALID: 400,
  TRIGGER_COMMAND_CORRELATION_ID_INVALID: 400,
  TRIGGER_MANUAL_DISABLED: 409,
};

/** Typed error code → the stable wire identifier (kebab-case, no leak). */
function errorIdentifier(code: WorkflowDeploymentErrorCode): string {
  return `workflow-deployment-${code.toLowerCase().replace(/_/g, '-')}`;
}

function sendError(reply: FastifyReply, err: unknown): Promise<void> {
  if (err instanceof WorkflowDeploymentError) {
    return reply.code(ERROR_STATUS[err.code]).send({
      error: errorIdentifier(err.code),
      code: err.code,
      message: err.message,
      detail: err.detail,
    });
  }
  return reply.code(500).send({ error: 'workflow-deployment-internal', message: String(err) });
}

export async function workflowDeploymentsRoutes(
  app: FastifyInstance,
  deps: WorkflowDeploymentsRouteDeps,
): Promise<void> {
  const service = deps.workflowDeploymentService;

  // --- deployments ------------------------------------------------------------

  app.post('/organizations/:orgId/workflow-deployments/deployments', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.workflowId !== 'string' ||
        typeof body.versionId !== 'string' ||
        typeof body.name !== 'string' ||
        typeof body.placement !== 'object' ||
        body.placement === null
      ) {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'workflowId, versionId, name and placement are required',
        });
      }
      try {
        const result = await service.createDeployment({ userId: user.id }, {
          organizationId: orgId,
          workflowId: body.workflowId,
          versionId: body.versionId,
          installationId:
            body.installationId === undefined || body.installationId === null
              ? null
              : String(body.installationId),
          name: body.name,
          description: body.description === undefined || body.description === null ? null : String(body.description),
          placement: body.placement as never,
          enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        });
        return reply.code(result.created ? 201 : 200).send({
          deployment: serializeDeployment(result.deployment),
          created: result.created,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.get('/organizations/:orgId/workflow-deployments/deployments', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      try {
        const deployments = await service.listDeploymentsInOrganization({ userId: user.id }, orgId);
        return reply.code(200).send({ deployments: deployments.map(serializeDeployment) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.get('/workflow-deployments/deployments/:deploymentId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { deploymentId } = req.params as { deploymentId: string };
      try {
        const deployment = await service.getDeployment({ userId: user.id }, deploymentId);
        return reply.code(200).send({ deployment: serializeDeployment(deployment) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.post('/workflow-deployments/deployments/:deploymentId/enable', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { deploymentId } = req.params as { deploymentId: string };
      try {
        const deployment = await service.setDeploymentEnabled(
          { userId: user.id },
          { deploymentId, enabled: true },
        );
        return reply.code(200).send({ deployment: serializeDeployment(deployment) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.post('/workflow-deployments/deployments/:deploymentId/disable', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { deploymentId } = req.params as { deploymentId: string };
      try {
        const deployment = await service.setDeploymentEnabled(
          { userId: user.id },
          { deploymentId, enabled: false },
        );
        return reply.code(200).send({ deployment: serializeDeployment(deployment) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- subscriptions ----------------------------------------------------------

  app.post('/workflow-deployments/deployments/:deploymentId/subscriptions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { deploymentId } = req.params as { deploymentId: string };
      const body = req.body as Record<string, unknown> | null;
      if (!body || typeof body.kind !== 'string' || (body.kind !== 'schedule' && body.kind !== 'event')) {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'kind must be schedule | event',
        });
      }
      try {
        const result = await service.createSubscription({ userId: user.id }, {
          deploymentId,
          kind: body.kind,
          schedule: body.schedule as never,
          eventPattern: body.eventPattern as never,
          deliveryPolicy: body.deliveryPolicy as never,
          enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        });
        return reply.code(result.created ? 201 : 200).send({
          subscription: serializeSubscription(result.subscription),
          created: result.created,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.get('/workflow-deployments/deployments/:deploymentId/subscriptions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { deploymentId } = req.params as { deploymentId: string };
      try {
        const subscriptions = await service.listSubscriptionsForDeployment({ userId: user.id }, deploymentId);
        return reply.code(200).send({ subscriptions: subscriptions.map(serializeSubscription) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.get('/workflow-deployments/subscriptions/:subscriptionId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { subscriptionId } = req.params as { subscriptionId: string };
      try {
        const subscription = await service.getSubscription({ userId: user.id }, subscriptionId);
        return reply.code(200).send({ subscription: serializeSubscription(subscription) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.post('/workflow-deployments/subscriptions/:subscriptionId/enable', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { subscriptionId } = req.params as { subscriptionId: string };
      try {
        const subscription = await service.setSubscriptionEnabled(
          { userId: user.id },
          { subscriptionId, enabled: true },
        );
        return reply.code(200).send({ subscription: serializeSubscription(subscription) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.post('/workflow-deployments/subscriptions/:subscriptionId/disable', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { subscriptionId } = req.params as { subscriptionId: string };
      try {
        const subscription = await service.setSubscriptionEnabled(
          { userId: user.id },
          { subscriptionId, enabled: false },
        );
        return reply.code(200).send({ subscription: serializeSubscription(subscription) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- the event inbox (idempotent ingest) ------------------------------------

  app.post('/organizations/:orgId/workflow-deployments/events', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.source !== 'string' ||
        typeof body.eventId !== 'string' ||
        typeof body.eventType !== 'string' ||
        typeof body.payload !== 'object' ||
        body.payload === null
      ) {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'source, eventId, eventType and payload are required',
        });
      }
      try {
        const result = await service.deliverEvent({ userId: user.id }, {
          organizationId: orgId,
          source: body.source,
          eventId: body.eventId,
          eventType: body.eventType,
          occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : undefined,
          payload: body.payload as Record<string, unknown>,
        });
        return reply.code(result.created ? 201 : 200).send({
          event: {
            id: result.event.id,
            eventId: result.event.eventId,
            eventType: result.event.eventType,
            source: result.event.source,
            occurredAt: result.event.occurredAt,
            receivedAt: result.event.receivedAt,
            payloadCommitment: result.event.payloadCommitment,
          },
          created: result.created,
          matchedSubscriptionIds: result.matchedSubscriptionIds,
          deliveries: result.deliveries.map(serializeDelivery),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- the engine tick (explicit drive; no hidden autonomous engine) ----------

  app.post('/organizations/:orgId/workflow-deployments/tick', async (req: FastifyRequest, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      try {
        const result = await service.tick({ userId: user.id }, { organizationId: orgId });
        return reply.code(200).send({
          occurrencesConsidered: result.occurrencesConsidered,
          deliveriesCreated: result.deliveriesCreated.map(serializeDelivery),
          deliveriesDelivered: result.deliveriesDelivered,
          deliveriesConverged: result.deliveriesConverged,
          deliveriesMissed: result.deliveriesMissed,
          deliveriesSuperseded: result.deliveriesSuperseded,
          deliveriesSkippedDisabled: result.deliveriesSkippedDisabled,
          deliveriesFailed: result.deliveriesFailed,
          stillPending: result.stillPending,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- deliveries (the fire history + correlation reads) ----------------------

  app.get('/workflow-deployments/deliveries/:deliveryId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { deliveryId } = req.params as { deliveryId: string };
      try {
        const delivery = await service.getDelivery({ userId: user.id }, deliveryId);
        return reply.code(200).send({ delivery: serializeDelivery(delivery) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.get('/workflow-deployments/deployments/:deploymentId/deliveries', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { deploymentId } = req.params as { deploymentId: string };
      try {
        const deliveries = await service.listDeliveriesForDeployment({ userId: user.id }, deploymentId);
        return reply.code(200).send({ deliveries: deliveries.map(serializeDelivery) });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- manual launch (no subscription; enable-gated) --------------------------

  app.post('/workflow-deployments/deployments/:deploymentId/runs', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { deploymentId } = req.params as { deploymentId: string };
      const body = req.body as Record<string, unknown> | null;
      if (!body || typeof body.commandId !== 'string' || typeof body.correlationId !== 'string') {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'commandId and correlationId are required (the deterministic envelope)',
        });
      }
      try {
        const result = await service.triggerManualRun({ userId: user.id }, {
          deploymentId,
          commandId: body.commandId,
          correlationId: body.correlationId,
          inputCommitments: Array.isArray(body.inputCommitments)
            ? (body.inputCommitments as unknown[]).map((c) => String(c))
            : [],
        });
        return reply.code(result.created ? 201 : 200).send({
          runId: result.runId,
          created: result.created,
          deployment: serializeDeployment(result.deployment),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });
}

// --- serializers (stable wire shapes; never raw internals) ---------------------

function serializeDeployment(deployment: WorkflowDeployment) {
  return {
    id: deployment.id,
    organizationId: deployment.organizationId,
    workflowId: deployment.workflowId,
    versionId: deployment.versionId,
    installationId: deployment.installationId,
    name: deployment.name,
    description: deployment.description,
    placement: deployment.placement,
    enabled: deployment.enabled,
    enabledAt: deployment.enabledAt,
    disabledAt: deployment.disabledAt,
    createdByUserId: deployment.createdByUserId,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
  };
}

function serializeSubscription(subscription: TriggerSubscription) {
  return {
    id: subscription.id,
    organizationId: subscription.organizationId,
    deploymentId: subscription.deploymentId,
    kind: subscription.kind,
    schedule: subscription.schedule,
    eventPattern: subscription.eventPattern,
    deliveryPolicy: subscription.deliveryPolicy,
    enabled: subscription.enabled,
    cursor: subscription.cursor,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

function serializeDelivery(delivery: TriggerDelivery) {
  return {
    id: delivery.id,
    organizationId: delivery.organizationId,
    deploymentId: delivery.deploymentId,
    subscriptionId: delivery.subscriptionId,
    kind: delivery.kind,
    triggerKey: delivery.triggerKey,
    state: delivery.state,
    scheduledAt: delivery.scheduledAt,
    scheduleResolution: delivery.scheduleResolution,
    missedWindowApplied: delivery.missedWindowApplied,
    attempts: delivery.attempts,
    retryAt: delivery.retryAt,
    resolvedNodeId: delivery.resolvedNodeId,
    resolvedPlacement: delivery.resolvedPlacement,
    placementRank: delivery.placementRank,
    runId: delivery.runId,
    failure: delivery.failure,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}
