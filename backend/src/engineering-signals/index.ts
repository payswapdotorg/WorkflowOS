/**
 * WORK-067 — Engineering Signal & Regression Correlation (public barrel).
 *
 * The ADVISORY correlation layer lives at `src/engineering-signals/`
 * (application-layer capability OUTSIDE src/modules/ — the WORK-064
 * continuous-validation / WORK-065 browser-validation / WORK-066
 * validation-scheduling precedent; NOT the 18th frozen module) and
 * CONSUMES the existing authorities:
 *
 *   - validation: the WORK-064 `ContinuousValidationService` (completed
 *     runs' typed outcomes — the primary validation-originated signal
 *     source, consumed through its public barrel, never re-implemented);
 *   - persistence: the EngineeringSignalRepository PORT (in-memory
 *     adapter in this Work Order — NO schema migration is authorized; the
 *     durable binding point is the documented future ACR at the port);
 *   - composition: `buildApp` constructs the service and exposes it on
 *     AppDeps for FUTURE governed consumers (WORK-068 feedback → Work
 *     Item conversion, WORK-070 architecture fitness — NOT implemented
 *     here).
 *
 * WORK-056 (signal taxonomy/intake — planned) is CONSUMED when it lands
 * (the normalization seam here is the documented TEMPORARY compatibility
 * boundary, not a competing permanent intake authority). WORK-068/069/070
 * are NOT implemented here. They are future CONSUMERS of these contracts.
 */
export {
  // §1 vocabularies
  SIGNAL_SOURCES,
  SIGNAL_SEVERITIES,
  SEVERITY_ORDER,
  // §2 the typed error surface
  ENGINEERING_SIGNAL_ERROR_CODES,
  EngineeringSignalError,
  // §8 the ingestion outcome vocabulary
  INGEST_OUTCOMES,
} from './types.js';
export type {
  // §1 vocabularies
  SignalSource,
  SignalSeverity,
  // §2 errors
  EngineeringSignalErrorCode,
  // §3 the temporary normalization seam
  SignalObservationReference,
  RawObservationInput,
  // §4 identity
  SignalIdentityInput,
  SignalIdentity,
  SignalOccurrenceIdentity,
  // §5 the signal record
  SignalOccurrence,
  ReleaseCorrelationEntry,
  ReleaseRegressionAssessment,
  RegressionAssessment,
  EngineeringSignal,
  // §6 the persistence port
  EngineeringSignalRepository,
  // §7 release correlation
  ReleaseCorrelationContext,
  CorrelateReleaseInput,
  // §8 the service contract
  IngestOutcome,
  IngestObservationResult,
  IngestValidationRunInput,
  IngestValidationRunResult,
  EngineeringSignalService,
} from './types.js';
export {
  // the deterministic identity derivations (pure)
  deriveSignalIdentity,
  deriveOccurrenceIdentity,
  compareOccurrences,
} from './internal/signal-identity.js';
export {
  // the temporary seam normalization boundary (fail-closed validation)
  requireValidSource,
  requireValidSeverity,
  requireValidObservedAt,
  requireValidObservationRef,
  normalizeObservation,
} from './internal/observation-normalization.js';
export {
  // the release correlation engine (pure, deterministic)
  requireValidReleaseContext,
  recordedCausalBindings,
  correlateSignalToReleases,
} from './internal/release-correlation.js';
export {
  // the regression assessment engine (pure, ADVISORY)
  assessRegression,
  deriveSignalTimelineAttributes,
} from './internal/regression-assessment.js';
export {
  // the WORK-064 validation-source adapter (consumed authority → observations)
  VALIDATION_OUTCOME_SEVERITY,
  validationRunToObservationInputs,
} from './internal/validation-source-adapter.js';
export type { ValidationObservationScope } from './internal/validation-source-adapter.js';
export {
  // the composition defaults
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
} from './internal/index.js';
