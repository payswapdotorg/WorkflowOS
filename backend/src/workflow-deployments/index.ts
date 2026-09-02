/**
 * V2-009 — Scheduling + Events + Placement: the public module surface
 * (barrel).
 *
 * Structure (the workflow-runs/computer-agent precedent): public contracts in
 * `types.ts`; the deterministic derivations, the pure timezone engine, the
 * schedule derivations, the typed event schemas, the delivery policy, the
 * placement projection, the frozen registry vocabulary snapshot, the
 * PostgreSQL store and the service in `internal/*` (private — the
 * architecture boundary suite enforces that nothing outside this directory
 * reaches into `internal/`).
 *
 * Consumers (the API route, the tests, later Work Orders) import ONLY from
 * this barrel.
 *
 * BOUNDARY REMINDER (constitution §2/§4/§5/§7/§11/§12/§16/§19/§21 +
 * V2-CTRL-003):
 *   - Workflow/WorkflowVersion/installation semantics are V2-002's (consumed
 *     read-only for pin resolution; the WorkflowDeployment pins the SAME
 *     immutable version identity);
 *   - WorkflowIR semantics + the semantic digest are V2-003's; the compiled
 *     plan is V2-007's (consumed for placement compatibility);
 *   - Run lifecycle/evidence is V2-005's: triggered runs are created ONLY
 *     through the merged run service's requestRun boundary (create-or-
 *     converge); this module never starts/completes runs or records run
 *     evidence;
 *   - Node/capability/placement matching is V2-004's (the merged matcher is
 *     the only placement authority);
 *   - computer-use execution is V2-008's (not imported here — the trigger
 *     layer hands runs to the run boundary; no second engine);
 *   - attestation semantics are V2-014's (no attestation concepts here);
 *   - PostgreSQL is the authority: no in-memory trigger state is a source of
 *     truth; PGlite is the Postgres-compatible test/dev implementation of
 *     the same single persistence boundary.
 */
export {
  // §0 vocabularies
  TRIGGER_SUBSCRIPTION_KINDS,
  MISSED_WINDOW_POLICIES,
  TRIGGER_DELIVERY_STATES,
  TERMINAL_TRIGGER_DELIVERY_STATES,
  DELIVERY_ATTEMPT_OUTCOMES,
  EVENT_FIELD_TYPES,
  // §4 the default delivery policy
  DEFAULT_DELIVERY_POLICY,
  // §6 typed error surface
  WORKFLOW_DEPLOYMENT_ERROR_CODES,
  WorkflowDeploymentError,
  // failures
  TRIGGER_FAILURE_CODES,
} from './types.js';
export type {
  TriggerSubscriptionKind,
  MissedWindowPolicy,
  TriggerDeliveryState,
  DeliveryAttemptOutcome,
  EventFieldType,
  WorkflowDeploymentErrorCode,
  TriggerFailureCode,
  // re-exported consumed contracts
  PlacementConstraint,
  PlacementId,
  PrivacyConstraint,
  NodeTrustTier,
  NodeMatchResult,
  NodeRecord,
  NodeRequirementSet,
  WorkflowPrincipal,
  Workflow,
  WorkflowVersion,
  RunTriggerType,
  // §1 records
  WorkflowDeployment,
  DeploymentPlacementPolicy,
  TriggerSubscription,
  InboundEvent,
  TriggerDelivery,
  DeliveryAttempt,
  TriggerFailure,
  // §2 schedules
  ScheduleSpec,
  ScheduleOccurrence,
  // §3 typed event schemas
  EventFieldSchema,
  EventSchema,
  EventFieldMatch,
  EventPattern,
  // §4 delivery policy
  DeliveryPolicy,
  // §6 commands and results
  CreateDeploymentInput,
  CreateDeploymentResult,
  CreateSubscriptionInput,
  CreateSubscriptionResult,
  DeliverEventInput,
  DeliverEventResult,
  TickInput,
  TickResult,
  TriggerManualRunInput,
  TriggerManualRunResult,
  SetDeploymentEnabledInput,
  SetSubscriptionEnabledInput,
  // §7 clock + service + ports
  WorkflowTriggerClock,
  WorkflowDeploymentService,
  WorkflowRepositoryReadPort,
  NodeDirectoryReadPort,
  DefaultWorkflowDeploymentServiceDeps,
} from './types.js';

// The service (PostgreSQL-authoritative; injected clock).
export { DefaultWorkflowDeploymentService } from './internal/trigger-service.js';

// The deterministic injected stepping clock (tests + harnesses).
export { createSteppingTriggerClock } from './internal/clock.js';
export {
  formatUtcTimestamp,
  epochMsOf,
} from './internal/clock.js';
