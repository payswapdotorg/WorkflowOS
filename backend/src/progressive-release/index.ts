/**
 * WORK-069 — Progressive Release & Runtime Validation (public barrel).
 *
 * The FEEDBACK BINDING LAYER lives at `src/progressive-release/`
 * (application-layer capability OUTSIDE src/modules/ — the WORK-064
 * continuous-validation / WORK-065 browser-validation / WORK-066
 * validation-scheduling / WORK-067 engineering-signals precedent; NOT
 * the 18th frozen module) and CONSUMES the existing authorities:
 *
 *   - validation: the WORK-064 `ContinuousValidationService` (completed
 *     POST_RELEASE runs — findRun is the read boundary);
 *   - signals: the WORK-067 `EngineeringSignalService` (the halt/recover
 *     consequence channel through its public intake);
 *   - runtime observation: the existing /runtime deployment authority
 *     (WORK-019/026 — through the read-only port, bound by the
 *     composition root over the module's public DeploymentRepository);
 *   - audit: the existing /audit authority (WORK-020 — through the
 *     AuditEventWriter application boundary);
 *   - rollback: the EXISTING rollback authority through its port
 *     (repository truth: unbound today — the documented future binding
 *     point; NO second rollback engine);
 *   - release mechanics: the existing `/workflows` + `/github` + `/runtime`
 *     distributed authority (no ReleaseService exists — the releaseRef is
 *     recorded, never invented);
 *   - composition: `buildApp` constructs the service and exposes it on
 *     AppDeps for FUTURE governed consumers (the runtime drive surfaces,
 *     WORK-070 architecture fitness).
 *
 * WORK-068 (the signal → governed Work Item converter) and WORK-070
 * (architecture fitness) are NOT implemented here. They are future
 * CONSUMERS of the signal flow this layer produces. WORK-069 NEVER
 * creates a Work Item, NEVER transitions a workflow, NEVER mutates code,
 * NEVER merges a PR, and NEVER advances a rollout.
 */
export {
  // §1 the vocabularies
  PROGRESSIVE_ROLLOUT_STAGES,
  PROGRESSIVE_STAGE_ORDER,
  PROGRESSIVE_DECISIONS,
  PROGRESSIVE_DECISION_REASONS,
  PROGRESSIVE_DEPLOYMENT_STATUSES,
  PROGRESSIVE_DELIVERY_OUTCOMES,
  // §2 the typed error surface
  PROGRESSIVE_RELEASE_ERROR_CODES,
  ProgressiveReleaseError,
} from './types.js';
export {
  // the deterministic identity derivations (pure)
  deriveDecisionIdentity,
  deriveContentFingerprint,
  runtimeObservationReference,
  requireValidDecisionRequest,
} from './internal/decision-identity.js';
export type { DecisionIdentityInput } from './internal/decision-identity.js';
export {
  // the governed-decision policy (pure, deterministic, explainable)
  deriveProgressiveDecision,
  PROGRESSIVE_POLICY_VERSION,
} from './internal/decision-policy.js';
export {
  // §8 the persistence port's in-memory adapter (the composition default)
  InMemoryProgressiveReleaseDecisionRepository,
  // §4 the /runtime observation adapter (bound by the composition root)
  RuntimeModuleDeploymentObservationReader,
  // §9 the service
  DefaultProgressiveReleaseService,
  // the recorded-rollout-state derivation (pure)
  derivePriorRolloutState,
} from './internal/index.js';
export type {
  // §1 vocabularies
  ProgressiveRolloutStage,
  ProgressiveDecision,
  ProgressiveDecisionReason,
  ProgressiveDeploymentStatus,
  ProgressiveDeliveryOutcome,
  // §2 errors
  ProgressiveReleaseErrorCode,
  // §3 the decision request
  DecideProgressiveReleaseInput,
  // §4 the runtime observation port
  RolloutRuntimeObservation,
  RuntimeObservationReader,
  // §5 the rollback authority port
  RollbackInvocationInput,
  RollbackInvocationResult,
  RollbackAuthority,
  // §6 the signal outcomes
  HaltSignalOutcome,
  // §7 the decision record
  ProgressiveReleaseDecisionRecord,
  ProgressiveReleaseDecisionResult,
  // §8 the persistence port
  ProgressiveReleaseDecisionRepository,
  // §9 the service contract
  ProgressiveReleaseServiceDeps,
  ProgressiveReleaseService,
  // §10 the pure derivation facts
  ValidationEvidenceStatus,
  RuntimeObservationStatus,
  PriorRolloutState,
  DerivationResult,
} from './types.js';
