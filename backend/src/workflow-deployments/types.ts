/**
 * V2-009 — Scheduling + Events + Placement: the public contracts.
 *
 * Scope (spec/architecture/v2/work-orders/V2-009.md, frozen):
 * owns trigger subscriptions, schedule definitions, event matching /
 * deduplication, execution placement resolution, enable/disable semantics,
 * missed-window handling and scheduling/event tests.
 *
 * BOUNDARY REMINDER (constitution §2/§5/§11/§12/§16/§19 + V2-CTRL-003):
 *   - Workflow/WorkflowVersion/installation-pin semantics are V2-002's
 *     (consumed read-only; the deployment pins the SAME immutable version
 *     identity the installation pins — V2-002's WorkflowDeployment forward
 *     note is discharged HERE);
 *   - WorkflowIR semantics + the semantic digest are V2-003's; the compiled
 *     executable plan is V2-007's (consumed for placement compatibility +
 *     resolution — never redefined);
 *   - Run lifecycle/evidence persistence is V2-005's: every triggered run is
 *     created ONLY through the merged run service's requestRun boundary
 *     (create-or-converge on the deterministic trigger surface — V2-009
 *     NEVER inserts run rows, never starts/completes runs, never records
 *     run evidence);
 *   - Node/capability/placement matching is V2-004's: placement resolution
 *     flows through the merged NodeCapabilityService.matchNodes (capability
 *     advertisement is never authorization — constitution §5);
 *   - computer-agent execution is V2-008's (the trigger layer hands runs to
 *     the run boundary; execution is the runtime's, driven by its caller);
 *   - attestation semantics are V2-014's (no attestation concepts here);
 *   - NO second workflow engine: the trigger engine only instantiates runs
 *     through the V2-005 protocol boundary — it never executes workflow
 *     steps itself (constitution §19).
 *
 * Time discipline: every timestamp is an injected fixed-format UTC string
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`); wall-clock timezone math is a PURE function
 * of (injected epoch, IANA zone) — no Date API, no ambient clock, no
 * randomness anywhere in this module (pinned by the module-boundary battery).
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  NodeMatchResult,
  NodeRecord,
  NodeRequirementSet,
  NodeTrustTier,
  PlacementConstraint,
  PlacementId,
  PrivacyConstraint,
} from '../node-capability/index.js';
import type {
  OrganizationMembershipResolver,
  Workflow,
  WorkflowPrincipal,
  WorkflowVersion,
} from '../workflow-repository/index.js';
import type { WorkflowRunService } from '../workflow-runs/index.js';

// Re-export the consumed contract types under the module's namespace so
// consumers need one import surface (the definitions stay V2-004's/V2-002's).
export type { PlacementConstraint, PlacementId, PrivacyConstraint, NodeTrustTier } from '../node-capability/index.js';
export type { WorkflowPrincipal } from '../workflow-repository/index.js';
export type { RunTriggerType } from '../workflow-runs/index.js';

// ============================================================================
// §0 vocabularies (frozen registry identifiers, verbatim)
// ============================================================================

/** Subscription kinds this module owns (manual launch needs no subscription). */
export const TRIGGER_SUBSCRIPTION_KINDS = ['schedule', 'event'] as const;
export type TriggerSubscriptionKind = (typeof TRIGGER_SUBSCRIPTION_KINDS)[number];

/** Missed-window policies (work order: "retry and missed-window semantics"). */
export const MISSED_WINDOW_POLICIES = ['skip', 'catch_up_run_now'] as const;
export type MissedWindowPolicy = (typeof MISSED_WINDOW_POLICIES)[number];

/** The trigger delivery state machine (terminal states are lifecycle-immutable). */
export const TRIGGER_DELIVERY_STATES = [
  'pending',
  'delivered',
  'converged',
  'missed',
  'superseded',
  'skipped_disabled',
  'failed',
] as const;
export type TriggerDeliveryState = (typeof TRIGGER_DELIVERY_STATES)[number];

/** Terminal delivery states (immutable once entered; history is append-only). */
export const TERMINAL_TRIGGER_DELIVERY_STATES: readonly TriggerDeliveryState[] = [
  'delivered',
  'converged',
  'missed',
  'superseded',
  'skipped_disabled',
  'failed',
];

/** Delivery attempt outcomes (append-only audit on every attempt). */
export const DELIVERY_ATTEMPT_OUTCOMES = [
  'placement_unavailable',
  'run_requested',
  'run_converged',
  'missed_window',
  'disabled',
  'rejected',
  'exhausted',
] as const;
export type DeliveryAttemptOutcome = (typeof DELIVERY_ATTEMPT_OUTCOMES)[number];

/** Typed event field kinds (the closed typed-schema value space). */
export const EVENT_FIELD_TYPES = ['string', 'number', 'boolean'] as const;
export type EventFieldType = (typeof EVENT_FIELD_TYPES)[number];

// ============================================================================
// §6 typed error surface (codes are the contract; messages are diagnostics)
// ============================================================================

export const WORKFLOW_DEPLOYMENT_ERROR_CODES = [
  // principal / scoping
  'DEPLOYMENT_NOT_FOUND',
  'DEPLOYMENT_NOT_ORGANIZATION_MEMBER',
  // deployment creation
  'DEPLOYMENT_INVALID_REQUEST',
  'DEPLOYMENT_INVALID_NAME',
  'DEPLOYMENT_INVALID_PLACEMENT',
  'DEPLOYMENT_VERSION_NOT_OF_WORKFLOW',
  'DEPLOYMENT_PLAN_INCOMPATIBLE',
  'DEPLOYMENT_ALREADY_DISABLED',
  'DEPLOYMENT_ALREADY_ENABLED',
  // subscriptions
  'SUBSCRIPTION_NOT_FOUND',
  'SUBSCRIPTION_KIND_INVALID',
  'SUBSCRIPTION_SCHEDULE_INVALID',
  'SUBSCRIPTION_EVENT_PATTERN_INVALID',
  'SUBSCRIPTION_EVENT_TYPE_UNKNOWN',
  'SUBSCRIPTION_EVENT_MATCH_INVALID',
  'SUBSCRIPTION_DELIVERY_POLICY_INVALID',
  'SUBSCRIPTION_ALREADY_DISABLED',
  'SUBSCRIPTION_ALREADY_ENABLED',
  // events
  'EVENT_INVALID_REQUEST',
  'EVENT_TYPE_UNKNOWN',
  'EVENT_SCHEMA_INVALID',
  // deliveries
  'DELIVERY_NOT_FOUND',
  'DELIVERY_NOT_PENDING',
  // commands
  'TRIGGER_COMMAND_ID_INVALID',
  'TRIGGER_COMMAND_CORRELATION_ID_INVALID',
  // manual launch
  'TRIGGER_MANUAL_DISABLED',
] as const;
export type WorkflowDeploymentErrorCode = (typeof WORKFLOW_DEPLOYMENT_ERROR_CODES)[number];

/** The typed module error (fail-closed; code is the machine contract). */
export class WorkflowDeploymentError extends Error {
  readonly code: WorkflowDeploymentErrorCode;
  readonly detail: string | null;

  constructor(code: WorkflowDeploymentErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'WorkflowDeploymentError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

// ============================================================================
// §1 the WorkflowDeployment record (constitution §2: the version-to-execution
// binding — placement and policy; V2-002's forward note discharged here)
// ============================================================================

/**
 * One WorkflowDeployment: the explicit binding of ONE EXACT immutable
 * WorkflowVersion to execution placement and policy (constitution §2), plus
 * the user-visible enable/disable state (work order "user-visible
 * enable/disable state"). A deployment pins the SAME immutable version
 * identity a WorkflowInstallation pins (V2-002's contract).
 */
export interface WorkflowDeployment {
  readonly id: string;
  readonly organizationId: string;
  readonly workflowId: string;
  /** The pinned EXACT immutable version (the (workflow, version) tuple). */
  readonly versionId: string;
  /** The V2-002 installation pin when the deployment is installation-backed. */
  readonly installationId: string | null;
  readonly name: string;
  readonly description: string | null;
  /** The execution placement policy (V2-004's contracts, consumed verbatim). */
  readonly placement: DeploymentPlacementPolicy;
  /** User-visible enable/disable state (a disabled deployment never fires). */
  readonly enabled: boolean;
  readonly enabledAt: string | null;
  readonly disabledAt: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The deployment's execution placement policy. Locality is a CORRECTNESS
 * constraint (constitution §12) — the placement/privacy shapes are V2-004's
 * frozen contracts, consumed verbatim (never redefined here).
 */
export interface DeploymentPlacementPolicy {
  readonly placement: PlacementConstraint;
  readonly privacy: PrivacyConstraint;
  /** Minimum node trust tier for placement resolution (V2-004's tiers). */
  readonly minTrustTier?: NodeTrustTier;
}

// ============================================================================
// §2 schedules (work order: "one-shot and recurring schedules" + "timezone/
// time-source correctness")
// ============================================================================

/**
 * A schedule definition. All forms are deterministic derivations:
 *   - one_shot: fires once at a fixed UTC instant;
 *   - interval: fixed-duration recurrence (UTC-anchored — timezone-free);
 *   - daily / weekly: wall-clock recurrence in an IANA timezone (DST-aware:
 *     a skipped local time resolves FORWARD to the gap end; an ambiguous
 *     local time resolves to the FIRST occurrence — recorded honestly on
 *     the occurrence).
 */
export type ScheduleSpec =
  | { readonly kind: 'one_shot'; readonly at: string }
  | { readonly kind: 'interval'; readonly everyMs: number }
  | { readonly kind: 'daily'; readonly timezone: string; readonly timeOfDay: string }
  | {
      readonly kind: 'weekly';
      readonly timezone: string;
      readonly timeOfDay: string;
      /** ISO 8601 weekdays 1 (Monday) .. 7 (Sunday); sorted, non-empty. */
      readonly daysOfWeek: readonly number[];
    };

/** One derived schedule occurrence (pure function of spec + cursor). */
export interface ScheduleOccurrence {
  /** The UTC instant the occurrence is scheduled for (fixed-format UTC). */
  readonly scheduledAt: string;
  /** normal | gap_shifted (spring-forward) | ambiguous_first (fall-back). */
  readonly resolution: 'normal' | 'gap_shifted' | 'ambiguous_first';
}

// ============================================================================
// §3 event subscriptions with typed event schemas (work order must-deliver)
// ============================================================================

/** One typed field of a registry event's payload schema. */
export interface EventFieldSchema {
  readonly field: string;
  readonly type: EventFieldType;
  readonly required: boolean;
}

/**
 * A typed event schema: the declared fields + types of one registry event
 * name. Ingest validates the payload against this schema (fail-closed);
 * subscription match predicates may reference ONLY declared fields.
 */
export interface EventSchema {
  readonly eventType: string;
  readonly fields: readonly EventFieldSchema[];
}

/** One typed equality match on a DECLARED field of the event's schema. */
export interface EventFieldMatch {
  readonly field: string;
  readonly value: string | number | boolean;
}

/** The event pattern a subscription matches (typed, fail-closed). */
export interface EventPattern {
  /** Canonical registry event name (V2-CTRL-003, verbatim). */
  readonly eventType: string;
  /** Exact event-source identity filter (optional). */
  readonly source?: string;
  /** Typed equality matches on declared fields (optional). */
  readonly match?: readonly EventFieldMatch[];
}

// ============================================================================
// §4 delivery policy (work order: "retry and missed-window semantics")
// ============================================================================

/**
 * The per-subscription delivery policy: bounded retries with deterministic
 * backoff for transient unavailability (placement), and the missed-window
 * rule for occurrences that aged out while undelivered.
 */
export interface DeliveryPolicy {
  /** An occurrence older than this when first evaluated is "missed". */
  readonly missWindowMs: number;
  /**
   * skip = record missed, never fire; catch_up_run_now = fire the LATEST
   * missed occurrence immediately (never a backlog — older ones are
   * superseded, honestly recorded).
   */
  readonly missedWindow: MissedWindowPolicy;
  /** Maximum delivery attempts (transient retries) before terminal failure. */
  readonly maxAttempts: number;
  /** Deterministic exponential backoff base (attempt n → base * 2^(n-1)). */
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
}

/** The default delivery policy (bounded; documented, overridable per subscription). */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  missWindowMs: 86_400_000,
  missedWindow: 'skip',
  maxAttempts: 8,
  backoffBaseMs: 60_000,
  backoffMaxMs: 3_600_000,
};

// ============================================================================
// §5 durable records: subscriptions, inbound events, deliveries
// ============================================================================

/** One trigger subscription attached to a deployment. */
export interface TriggerSubscription {
  readonly id: string;
  readonly organizationId: string;
  readonly deploymentId: string;
  readonly kind: TriggerSubscriptionKind;
  readonly schedule: ScheduleSpec | null;
  readonly eventPattern: EventPattern | null;
  readonly deliveryPolicy: DeliveryPolicy;
  readonly enabled: boolean;
  /**
   * The schedule cursor: the last occurrence instant CONSIDERED (the next
   * derivation is strictly after it). null = derive from creation time.
   */
  readonly cursor: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One deduplicated inbound event (the inbox record). */
export interface InboundEvent {
  /** Deterministic internal identity (derived from org+source+external id). */
  readonly id: string;
  readonly organizationId: string;
  /** The producer-supplied event identity (idempotency key part 2). */
  readonly eventId: string;
  /** Canonical registry event name (verbatim). */
  readonly eventType: string;
  /** The event source identity (idempotency key part 1). */
  readonly source: string;
  /** The producer-declared occurrence instant (UTC; default = received). */
  readonly occurredAt: string;
  readonly receivedAt: string;
  /** sha-256 over the canonical typed payload (privacy: no raw persistence). */
  readonly payloadCommitment: string;
}

/**
 * One trigger delivery: the durable fire record for one (subscription,
 * trigger-key) pair — the idempotency, retry, placement and event/run
 * correlation surface. Terminal states are immutable; history append-only.
 */
export interface TriggerDelivery {
  readonly id: string;
  readonly organizationId: string;
  readonly deploymentId: string;
  readonly subscriptionId: string;
  readonly kind: TriggerSubscriptionKind;
  /** schedule occurrence instant (ISO) | inbound event id. */
  readonly triggerKey: string;
  readonly state: TriggerDeliveryState;
  /** The scheduled occurrence instant (schedule deliveries only). */
  readonly scheduledAt: string | null;
  /** The occurrence resolution (honest DST record; schedule deliveries only). */
  readonly scheduleResolution: 'normal' | 'gap_shifted' | 'ambiguous_first' | null;
  /** The missed-window policy applied to this delivery (audit honesty). */
  readonly missedWindowApplied: 'skip' | 'catch_up_run_now' | null;
  /** Append-only attempt audit (every attempt, in order). */
  readonly attempts: readonly DeliveryAttempt[];
  /** When the next retry is due (pending deliveries only). */
  readonly retryAt: string | null;
  /** The placement resolution (V2-004 matcher output — consumed verbatim). */
  readonly resolvedNodeId: string | null;
  readonly resolvedPlacement: PlacementId | null;
  readonly placementRank: number | null;
  /** EVENT/RUN CORRELATION: the run created (or converged on) by this delivery. */
  readonly runId: string | null;
  /** The typed terminal failure (failed deliveries only). */
  readonly failure: TriggerFailure | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One delivery attempt (append-only audit). */
export interface DeliveryAttempt {
  readonly at: string;
  readonly outcome: DeliveryAttemptOutcome;
  /** Typed detail (e.g. the V2-005 rejection code, the matcher reason codes). */
  readonly detail: string | null;
}

/** A typed terminal delivery failure. */
export interface TriggerFailure {
  readonly code: TriggerFailureCode;
  readonly detail: string | null;
}

export const TRIGGER_FAILURE_CODES = [
  'TRIGGER_PLACEMENT_UNAVAILABLE',
  'TRIGGER_RUN_REQUEST_REJECTED',
  'TRIGGER_DELIVERY_EXHAUSTED',
] as const;
export type TriggerFailureCode = (typeof TRIGGER_FAILURE_CODES)[number];

// ============================================================================
// §6 commands and results (create-or-converge everywhere)
// ============================================================================

export interface CreateDeploymentInput {
  readonly organizationId: string;
  readonly workflowId: string;
  readonly versionId: string;
  /** The V2-002 installation pin (optional; null = org-local direct pin). */
  readonly installationId?: string | null;
  readonly name: string;
  readonly description?: string | null;
  readonly placement: DeploymentPlacementPolicy;
  /** Deployments are born enabled unless explicitly disabled. */
  readonly enabled?: boolean;
}

export interface CreateDeploymentResult {
  readonly deployment: WorkflowDeployment;
  /** false = converged on an existing deployment (duplicate create). */
  readonly created: boolean;
}

export interface CreateSubscriptionInput {
  readonly deploymentId: string;
  readonly kind: TriggerSubscriptionKind;
  readonly schedule?: ScheduleSpec;
  readonly eventPattern?: EventPattern;
  readonly deliveryPolicy?: Partial<DeliveryPolicy>;
  readonly enabled?: boolean;
}

export interface CreateSubscriptionResult {
  readonly subscription: TriggerSubscription;
  /** false = converged on an existing subscription (duplicate create). */
  readonly created: boolean;
}

export interface DeliverEventInput {
  readonly organizationId: string;
  /** The producer identity (e.g. a V2-004 node id, an application id). */
  readonly source: string;
  /** The producer-supplied event identity (dedup key with source). */
  readonly eventId: string;
  readonly eventType: string;
  /** Occurrence instant (UTC; defaults to the injected receive time). */
  readonly occurredAt?: string;
  /** The typed payload (validated against the event's typed schema). */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DeliverEventResult {
  readonly event: InboundEvent;
  /** false = duplicate delivery converged on the existing inbox record. */
  readonly created: boolean;
  /** The subscriptions that matched (created path only; deterministic order). */
  readonly matchedSubscriptionIds: readonly string[];
  /** The deliveries created for this event (created path only). */
  readonly deliveries: readonly TriggerDelivery[];
}

/** The engine tick: fires due schedules + retries pending deliveries. */
export interface TickInput {
  readonly organizationId: string;
}

export interface TickResult {
  /** The schedule occurrences evaluated (per subscription, in order). */
  readonly occurrencesConsidered: number;
  readonly deliveriesCreated: readonly TriggerDelivery[];
  readonly deliveriesDelivered: readonly string[];
  readonly deliveriesConverged: readonly string[];
  readonly deliveriesMissed: readonly string[];
  readonly deliveriesSuperseded: readonly string[];
  readonly deliveriesSkippedDisabled: readonly string[];
  readonly deliveriesFailed: readonly string[];
  /** Pending deliveries left awaiting retry (with their retryAt). */
  readonly stillPending: readonly { readonly deliveryId: string; readonly retryAt: string }[];
}

export interface TriggerManualRunInput {
  readonly deploymentId: string;
  readonly commandId: string;
  readonly correlationId: string;
  /** One-way input commitments (V2-005's RequestRunInput contract). */
  readonly inputCommitments: readonly string[];
}

export interface TriggerManualRunResult {
  /** The run (created or converged — V2-005's create-or-converge). */
  readonly runId: string;
  readonly created: boolean;
  readonly deployment: WorkflowDeployment;
}

export interface SetDeploymentEnabledInput {
  readonly deploymentId: string;
  readonly enabled: boolean;
}

export interface SetSubscriptionEnabledInput {
  readonly subscriptionId: string;
  readonly enabled: boolean;
}

// ============================================================================
// §7 the injected clock + the service contract
// ============================================================================

/** The injected trigger clock (fixed-format UTC; never ambient). */
export interface WorkflowTriggerClock {
  now(): string;
}

/**
 * The trigger service: the one authority for deployment/subscription state,
 * the event inbox, trigger deliveries and placement resolution. Every run
 * creation flows through the merged V2-005 boundary; every placement
 * decision flows through the merged V2-004 matcher; every pin resolution
 * through the merged V2-002 repository; the compiled plan through V2-007.
 */
export interface WorkflowDeploymentService {
  createDeployment(
    principal: WorkflowPrincipal,
    input: CreateDeploymentInput,
  ): Promise<CreateDeploymentResult>;
  getDeployment(principal: WorkflowPrincipal, deploymentId: string): Promise<WorkflowDeployment>;
  listDeploymentsInOrganization(
    principal: WorkflowPrincipal,
    organizationId: string,
  ): Promise<WorkflowDeployment[]>;
  setDeploymentEnabled(
    principal: WorkflowPrincipal,
    input: SetDeploymentEnabledInput,
  ): Promise<WorkflowDeployment>;

  createSubscription(
    principal: WorkflowPrincipal,
    input: CreateSubscriptionInput,
  ): Promise<CreateSubscriptionResult>;
  getSubscription(principal: WorkflowPrincipal, subscriptionId: string): Promise<TriggerSubscription>;
  listSubscriptionsForDeployment(
    principal: WorkflowPrincipal,
    deploymentId: string,
  ): Promise<TriggerSubscription[]>;
  setSubscriptionEnabled(
    principal: WorkflowPrincipal,
    input: SetSubscriptionEnabledInput,
  ): Promise<TriggerSubscription>;

  deliverEvent(principal: WorkflowPrincipal, input: DeliverEventInput): Promise<DeliverEventResult>;
  tick(principal: WorkflowPrincipal, input: TickInput): Promise<TickResult>;

  getDelivery(principal: WorkflowPrincipal, deliveryId: string): Promise<TriggerDelivery>;
  listDeliveriesForDeployment(
    principal: WorkflowPrincipal,
    deploymentId: string,
  ): Promise<TriggerDelivery[]>;

  triggerManualRun(
    principal: WorkflowPrincipal,
    input: TriggerManualRunInput,
  ): Promise<TriggerManualRunResult>;
}

/**
 * The V2-002 surface this module consumes (read-only pin resolution + plan
 * compatibility). Narrowed on purpose: structurally satisfied by the merged
 * WorkflowRepositoryService, and structurally CANNOT mutate it.
 */
export type WorkflowRepositoryReadPort = {
  getWorkflow: (principal: WorkflowPrincipal, workflowId: string) => Promise<Workflow>;
  getVersion: (
    principal: WorkflowPrincipal,
    workflowId: string,
    versionId: string,
  ) => Promise<WorkflowVersion>;
};

export type { Workflow, WorkflowVersion } from '../workflow-repository/index.js';
export type {
  NodeMatchResult,
  NodeRecord,
  NodeRequirementSet,
} from '../node-capability/index.js';

/**
 * The V2-004 surface this module consumes (the matcher + the node list for
 * offline-recovery observation). Narrowed on purpose: structurally satisfied
 * by the merged NodeCapabilityService.
 */
export type NodeDirectoryReadPort = {
  /** The merged matcher is synchronous (V2-004's contract). */
  matchNodes: (requirement: NodeRequirementSet) => NodeMatchResult;
  listNodes: () => readonly NodeRecord[];
};

export interface DefaultWorkflowDeploymentServiceDeps {
  /** The authoritative PostgreSQL client (the persistence authority). */
  readonly db: DatabaseClient;
  /** The identity authority's membership fact source (consumed port). */
  readonly memberships: OrganizationMembershipResolver;
  /** The merged V2-002 repository service (read-only pin resolution). */
  readonly workflowRepository: WorkflowRepositoryReadPort;
  /** The merged V2-005 run service (the ONLY run-creation boundary). */
  readonly runs: WorkflowRunService;
  /** The merged V2-004 node directory (the ONLY placement matcher). */
  readonly nodes: NodeDirectoryReadPort;
  /** The injected trigger clock (fixed-format UTC). */
  readonly clock: WorkflowTriggerClock;
}
