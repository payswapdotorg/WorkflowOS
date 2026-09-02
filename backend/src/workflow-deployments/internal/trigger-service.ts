/**
 * V2-009 — the workflow-deployment service (the composition root).
 *
 * Every command is tenant-scoped through the identity authority's membership
 * facts (the V2-002/V2-005 consumed port); every pin resolution goes through
 * the merged V2-002 repository (read-only); every placement decision through
 * the merged V2-004 matcher; every plan-compatibility check through the
 * merged V2-007 compiler over the pinned version's content; every run
 * creation through the merged V2-005 requestRun boundary (via the engine).
 * The clock is injected; PostgreSQL is the authority.
 */
import {
  WorkflowDeploymentError,
  type CreateDeploymentInput,
  type CreateDeploymentResult,
  type CreateSubscriptionInput,
  type CreateSubscriptionResult,
  type DeliverEventInput,
  type DeliverEventResult,
  type DefaultWorkflowDeploymentServiceDeps,
  type SetDeploymentEnabledInput,
  type SetSubscriptionEnabledInput,
  type TickInput,
  type TickResult,
  type TriggerDelivery,
  type TriggerManualRunInput,
  type TriggerManualRunResult,
  type TriggerSubscription,
  type WorkflowDeployment,
  type WorkflowDeploymentService,
  type WorkflowPrincipal,
} from '../types.js';
import { TriggerEngine } from './engine.js';
import {
  canonicalJson,
  assertCommandId,
  assertCorrelationId,
  deriveDeploymentId,
  deriveSubscriptionId,
} from './identity.js';
import {
  mapDeliveryRow,
  mapDeploymentRow,
  mapSubscriptionRow,
  PgTriggerStore,
} from './pg-trigger-store.js';
import { resolveDeliveryPolicy } from './delivery-policy.js';
import { validateScheduleSpec } from './schedule.js';
import { validateEventPattern } from './event-schema.js';
import {
  checkPlacementCompatibility,
  assertPrivacyConstraint,
  deploymentRequirementSetOf,
} from './placement.js';
import { compileWorkflow } from '../../workflow-compiler/index.js';
import type { DeliveryPolicy } from '../types.js';

export class DefaultWorkflowDeploymentService implements WorkflowDeploymentService {
  private readonly store: PgTriggerStore;
  private readonly engine: TriggerEngine;
  private readonly memberships: DefaultWorkflowDeploymentServiceDeps['memberships'];
  private readonly repository: DefaultWorkflowDeploymentServiceDeps['workflowRepository'];
  private readonly runs: DefaultWorkflowDeploymentServiceDeps['runs'];
  private readonly clock: DefaultWorkflowDeploymentServiceDeps['clock'];

  constructor(deps: DefaultWorkflowDeploymentServiceDeps) {
    this.store = new PgTriggerStore(deps.db);
    this.engine = new TriggerEngine({
      store: this.store,
      runs: deps.runs,
      nodes: deps.nodes,
      clock: () => deps.clock.now(),
    });
    this.memberships = deps.memberships;
    this.repository = deps.workflowRepository;
    this.runs = deps.runs;
    this.clock = deps.clock;
  }

  // ==========================================================================
  // deployments
  // ==========================================================================

  async createDeployment(
    principal: WorkflowPrincipal,
    input: CreateDeploymentInput,
  ): Promise<CreateDeploymentResult> {
    const now = this.clock.now();
    if (typeof input !== 'object' || input === null) {
      throw new WorkflowDeploymentError('DEPLOYMENT_INVALID_REQUEST', 'the create input must be an object');
    }
    if (
      typeof input.organizationId !== 'string' ||
      typeof input.workflowId !== 'string' ||
      typeof input.versionId !== 'string' ||
      input.workflowId.length === 0 ||
      input.versionId.length === 0
    ) {
      throw new WorkflowDeploymentError('DEPLOYMENT_INVALID_REQUEST', 'organizationId, workflowId and versionId are required');
    }
    if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 128) {
      throw new WorkflowDeploymentError(
        'DEPLOYMENT_INVALID_NAME',
        'name must be 1..128 chars (leading/trailing whitespace is trimmed for identity)',
      );
    }
    if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
      throw new WorkflowDeploymentError('DEPLOYMENT_INVALID_REQUEST', 'description must be a string or null');
    }
    await this.assertMember(principal, input.organizationId);

    // Read-only pin resolution through the merged V2-002 repository (typed
    // 404s / version-not-of-workflow rejections propagate).
    const version = await this.repository.getVersion(principal, input.workflowId, input.versionId);
    void version;

    // Placement policy validation + plan compatibility (V2-007 consumed).
    assertPrivacyConstraint(input.placement?.privacy);
    const policy = input.placement;
    if (typeof policy !== 'object' || policy === null) {
      throw new WorkflowDeploymentError('DEPLOYMENT_INVALID_PLACEMENT', 'placement policy is required');
    }
    const requirement = deploymentRequirementSetOf(policy); // validates the chain (typed)
    void requirement;
    const compiled = compileWorkflow(version.content);
    if (!compiled.ok) {
      throw new WorkflowDeploymentError(
        'DEPLOYMENT_PLAN_INCOMPATIBLE',
        'the pinned version does not compile (V2-007 diagnostics)',
        compiled.diagnostics.map((d) => `${d.code} at ${d.path}: ${d.message}`).join('; '),
      );
    }
    const compatibility = checkPlacementCompatibility({
      policy,
      plan: compiled.artifact.plan,
    });
    if (!compatibility.ok) {
      throw new WorkflowDeploymentError(
        'DEPLOYMENT_PLAN_INCOMPATIBLE',
        'the placement policy is incompatible with the pinned version plan (locality is a correctness constraint)',
        compatibility.detail,
      );
    }

    const id = deriveDeploymentId(input.organizationId, input.workflowId, input.versionId, input.name);
    const enabled = input.enabled ?? true;
    const inserted = await this.store.insertDeploymentOrConverge({
      id,
      organizationId: input.organizationId,
      workflowId: input.workflowId,
      versionId: input.versionId,
      installationId: input.installationId ?? null,
      name: input.name.trim(),
      description: input.description ?? null,
      placement: storedPlacement(policy.placement),
      privacy: storedPrivacy(policy.privacy),
      minTrustTier: policy.minTrustTier ?? null,
      enabled,
      enabledAt: enabled ? now : null,
      createdByUserId: principal.userId,
      createdAt: now,
    });
    return {
      deployment: mapDeploymentRow(inserted.row),
      created: inserted.created,
    };
  }

  async getDeployment(principal: WorkflowPrincipal, deploymentId: string): Promise<WorkflowDeployment> {
    const row = await this.store.findDeploymentById(deploymentId);
    if (row === null) {
      throw new WorkflowDeploymentError('DEPLOYMENT_NOT_FOUND', 'no such deployment', deploymentId);
    }
    await this.assertMember(principal, row.organization_id);
    return mapDeploymentRow(row);
  }

  async listDeploymentsInOrganization(
    principal: WorkflowPrincipal,
    organizationId: string,
  ): Promise<WorkflowDeployment[]> {
    await this.assertMember(principal, organizationId);
    const rows = await this.store.listDeploymentsInOrganization(organizationId);
    return rows.map(mapDeploymentRow);
  }

  async setDeploymentEnabled(
    principal: WorkflowPrincipal,
    input: SetDeploymentEnabledInput,
  ): Promise<WorkflowDeployment> {
    const now = this.clock.now();
    const existing = await this.getDeployment(principal, input.deploymentId);
    if (existing.enabled === input.enabled) {
      throw new WorkflowDeploymentError(
        input.enabled ? 'DEPLOYMENT_ALREADY_ENABLED' : 'DEPLOYMENT_ALREADY_DISABLED',
        `the deployment is already ${input.enabled ? 'enabled' : 'disabled'}`,
        input.deploymentId,
      );
    }
    const row = await this.store.updateDeploymentEnabled({
      deploymentId: input.deploymentId,
      enabled: input.enabled,
      at: now,
    });
    if (row === null) {
      throw new WorkflowDeploymentError('DEPLOYMENT_NOT_FOUND', 'no such deployment', input.deploymentId);
    }
    return mapDeploymentRow(row);
  }

  // ==========================================================================
  // subscriptions
  // ==========================================================================

  async createSubscription(
    principal: WorkflowPrincipal,
    input: CreateSubscriptionInput,
  ): Promise<CreateSubscriptionResult> {
    const now = this.clock.now();
    const deployment = await this.getDeployment(principal, input.deploymentId);
    if (input.kind !== 'schedule' && input.kind !== 'event') {
      throw new WorkflowDeploymentError('SUBSCRIPTION_KIND_INVALID', 'kind must be schedule | event');
    }
    let schedule: object | null = null;
    let eventPattern: object | null = null;
    if (input.kind === 'schedule') {
      schedule = validateScheduleSpec(input.schedule);
    } else {
      eventPattern = validateEventPattern(input.eventPattern);
    }
    const deliveryPolicy: DeliveryPolicy = resolveDeliveryPolicy(input.deliveryPolicy);

    const id = deriveSubscriptionId(deployment.id, input.kind, schedule ?? eventPattern);
    const inserted = await this.store.insertSubscriptionOrConverge({
      id,
      organizationId: deployment.organizationId,
      deploymentId: deployment.id,
      kind: input.kind,
      schedule,
      eventPattern,
      deliveryPolicy,
      enabled: input.enabled ?? true,
      cursor: null,
      createdAt: now,
    });
    return {
      subscription: mapSubscriptionRow(inserted.row),
      created: inserted.created,
    };
  }

  private async getSubscriptionRow(principal: WorkflowPrincipal, subscriptionId: string) {
    const row = await this.store.findSubscriptionById(subscriptionId);
    if (row === null) {
      throw new WorkflowDeploymentError('SUBSCRIPTION_NOT_FOUND', 'no such subscription', subscriptionId);
    }
    await this.assertMember(principal, row.organization_id);
    return row;
  }

  async getSubscription(principal: WorkflowPrincipal, subscriptionId: string): Promise<TriggerSubscription> {
    const row = await this.getSubscriptionRow(principal, subscriptionId);
    return mapSubscriptionRow(row);
  }

  async listSubscriptionsForDeployment(
    principal: WorkflowPrincipal,
    deploymentId: string,
  ): Promise<TriggerSubscription[]> {
    const deployment = await this.getDeployment(principal, deploymentId);
    const rows = await this.store.listSubscriptionsForDeployment(deployment.id);
    return rows.map(mapSubscriptionRow);
  }

  async setSubscriptionEnabled(
    principal: WorkflowPrincipal,
    input: SetSubscriptionEnabledInput,
  ): Promise<TriggerSubscription> {
    const now = this.clock.now();
    const existing = await this.getSubscription(principal, input.subscriptionId);
    if (existing.enabled === input.enabled) {
      throw new WorkflowDeploymentError(
        input.enabled ? 'SUBSCRIPTION_ALREADY_ENABLED' : 'SUBSCRIPTION_ALREADY_DISABLED',
        `the subscription is already ${input.enabled ? 'enabled' : 'disabled'}`,
        input.subscriptionId,
      );
    }
    const row = await this.store.updateSubscriptionEnabled({
      subscriptionId: input.subscriptionId,
      enabled: input.enabled,
      updatedAt: now,
    });
    if (row === null) {
      throw new WorkflowDeploymentError('SUBSCRIPTION_NOT_FOUND', 'no such subscription', input.subscriptionId);
    }
    return mapSubscriptionRow(row);
  }

  // ==========================================================================
  // events + tick (the engine, driven explicitly)
  // ==========================================================================

  async deliverEvent(principal: WorkflowPrincipal, input: DeliverEventInput): Promise<DeliverEventResult> {
    await this.assertMember(principal, input.organizationId);
    return this.engine.deliverEvent(input);
  }

  async tick(principal: WorkflowPrincipal, input: TickInput): Promise<TickResult> {
    await this.assertMember(principal, input.organizationId);
    return this.engine.tick(input.organizationId);
  }

  // ==========================================================================
  // deliveries (reads)
  // ==========================================================================

  async getDelivery(principal: WorkflowPrincipal, deliveryId: string): Promise<TriggerDelivery> {
    const row = await this.store.findDeliveryById(deliveryId);
    if (row === null) {
      throw new WorkflowDeploymentError('DELIVERY_NOT_FOUND', 'no such delivery', deliveryId);
    }
    await this.assertMember(principal, row.organization_id);
    return mapDeliveryRow(row);
  }

  async listDeliveriesForDeployment(
    principal: WorkflowPrincipal,
    deploymentId: string,
  ): Promise<TriggerDelivery[]> {
    const deployment = await this.getDeployment(principal, deploymentId);
    const rows = await this.store.listDeliveriesForDeployment(deployment.id);
    return rows.map(mapDeliveryRow);
  }

  // ==========================================================================
  // manual launch (no subscription; the V2-005 boundary, enable-gated)
  // ==========================================================================

  async triggerManualRun(
    principal: WorkflowPrincipal,
    input: TriggerManualRunInput,
  ): Promise<TriggerManualRunResult> {
    assertCommandId(input.commandId);
    assertCorrelationId(input.correlationId);
    const deployment = await this.getDeployment(principal, input.deploymentId);
    if (!deployment.enabled) {
      throw new WorkflowDeploymentError(
        'TRIGGER_MANUAL_DISABLED',
        'the deployment is disabled (enable it to launch manually)',
        input.deploymentId,
      );
    }
    if (!Array.isArray(input.inputCommitments) || input.inputCommitments.some((c) => typeof c !== 'string')) {
      throw new WorkflowDeploymentError(
        'DEPLOYMENT_INVALID_REQUEST',
        'inputCommitments must be an array of one-way commitment strings',
      );
    }
    const outcome = await this.runs.requestRun(
      principal,
      { commandId: input.commandId, correlationId: input.correlationId },
      {
        organizationId: deployment.organizationId,
        workflowId: deployment.workflowId,
        versionId: deployment.versionId,
        installationId: deployment.installationId,
        trigger: { type: 'manual', id: `man:${input.commandId}` },
        inputCommitments: input.inputCommitments,
      },
    );
    return {
      runId: outcome.result.run.id,
      created: outcome.result.created,
      deployment,
    };
  }

  // ==========================================================================
  // membership scoping (the consumed identity-authority port)
  // ==========================================================================

  private async assertMember(principal: WorkflowPrincipal, organizationId: string): Promise<void> {
    const isMember = await this.memberships.isMember(principal.userId, organizationId);
    if (!isMember) {
      throw new WorkflowDeploymentError(
        'DEPLOYMENT_NOT_ORGANIZATION_MEMBER',
        'the principal is not a member of the organization',
        organizationId,
      );
    }
  }
}

/** Structural copy helpers (the stored policy is the canonical JSON shape). */
function storedPlacement(placement: unknown): unknown {
  return JSON.parse(canonicalJson(placement ?? null));
}
function storedPrivacy(privacy: unknown): unknown {
  return JSON.parse(canonicalJson(privacy ?? null));
}
