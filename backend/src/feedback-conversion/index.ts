/**
 * WORK-068 — Feedback → Governed Work Items (public barrel).
 *
 * The conversion layer lives at `src/feedback-conversion/`
 * (application-layer capability OUTSIDE src/modules/ — the WORK-040
 * development-planner / WORK-064 continuous-validation / WORK-065
 * browser-validation / WORK-066 validation-scheduling / WORK-067
 * engineering-signals precedent; NOT the 18th frozen module) and CONSUMES
 * the existing authorities:
 *
 *   - engineering-signals (WORK-067): the ADVISORY signal source —
 *     consumed read-only through its public service (listSignalsForProject
 *     / findSignal). Never re-implemented, never mutated.
 *   - work-items (the ONE Work Item authority): the EXISTING intake —
 *     WorkItemRepository.create is the single creation path; the
 *     conversion evidence is embedded in the authoritative Work Item's
 *     existing `metadata` JSONB (field `metadata.feedbackConversion`).
 *     This domain owns NO tables and NO parallel work-item store.
 *   - composition: `buildApp` constructs the service and exposes it on
 *     AppDeps for the governed HTTP surface + the future downstream
 *     consumers (WORK-070 architecture fitness — NOT implemented here).
 *
 * WORK-069 (progressive release) and WORK-070 (architecture fitness) are
 * NOT implemented here. They are downstream CONSUMERS of the governed
 * Work Items this conversion produces.
 */
export {
  // §1 vocabularies
  CONVERSION_PRIORITIES,
  BLAST_RADIUS_BANDS,
  // §2 the typed error surface
  FEEDBACK_CONVERSION_ERROR_CODES,
  FeedbackConversionError,
} from './types.js';
export type {
  // §1 vocabularies
  ConversionPriority,
  BlastRadiusBand,
  // §2 errors
  FeedbackConversionErrorCode,
  // §3 the governed decision
  ConversionDecision,
  ConversionDecisionRecord,
  // §4 the assessment model
  ConversionAssessmentFactor,
  BlastRadiusAssessment,
  SignalGroupAssessment,
  SignalRegressionEvidence,
  // §5 the proposal
  ProposalIdentity,
  ProposalDedupOutcome,
  BacklogContext,
  ConversionPriorityFactor,
  ConversionProposal,
  // §6 the embedded provenance payload
  FeedbackConversionMetadataPayload,
  OccurrenceProvenanceEntry,
  // §7 the service contract
  ConversionEvaluationInput,
  ProposalConversionOutcome,
  ProposalConversionResult,
  AssessmentResult,
  ConversionResult,
  // §8 the resolution context + service
  ConversionContext,
  FeedbackConversionService,
  FeedbackConversionServiceDeps,
  // §9 the consumed authority types (the single import surface)
  EngineeringSignal,
  SignalSeverity,
  SignalSource,
  WorkItem,
} from './types.js';
export {
  // the deterministic identity derivations (pure)
  deriveProposalIdentity,
  compareProposals,
} from './internal/conversion-identity.js';
export {
  // the assessment engine (pure, deterministic)
  assessBlastRadius,
  assessSignalGroup,
  occurrenceProvenanceOf,
  earliestObservationTime,
  latestObservationTime,
} from './internal/signal-assessment.js';
export {
  // the dedup boundary (pure, deterministic)
  matchOpenWorkItems,
  readConversionMetadata,
  isSameProposalFamily,
  deriveCreationId,
  FEEDBACK_CONVERSION_METADATA_FIELD,
} from './internal/open-work-item-matcher.js';
export {
  // the priority engine (pure, deterministic, explainable)
  prioritizeProposal,
  priorityScore,
  deriveBacklogContext,
} from './internal/conversion-prioritizer.js';
export {
  // the composition defaults
  DefaultFeedbackConversionService,
  FEEDBACK_CONVERSION_VERSION,
} from './internal/index.js';
