/**
 * V2-005 — Workflow Runs + Evidence: the public module surface (barrel).
 *
 * Structure (the V2-002 workflow-repository structural precedent): public
 * contracts in `types.ts`; deterministic derivations, the pure validation
 * layer, the injected clock, the state machine, the attempt rule, the
 * attestation boundary policy, the PostgreSQL store and the service in
 * `internal/*` (private — the architecture boundary suite enforces that
 * nothing outside this directory reaches into `internal/`).
 *
 * Consumers (the API route, the tests, later Work Orders) import ONLY from
 * this barrel.
 *
 * BOUNDARY REMINDER (constitution §2/§7/§11/§19/§21 + V2-CTRL-003):
 *   - Workflow/WorkflowVersion/repository semantics are V2-002's (consumed
 *     read-only through the merged repository service for pin resolution);
 *   - WorkflowIR semantics + the semantic digest are V2-003's (the merged
 *     parser/digest are the declared-step authority);
 *   - attestation protocol semantics are V2-014's (the merged verifier is the
 *     ONLY verification authority at the Run boundary; durable single-use
 *     replay state is THIS module's and lives in migration 0061);
 *   - Node/Capability definitions are V2-004's (node identity is an opaque
 *     external reference); computer-use execution is V2-008's and
 *     scheduling/events are V2-009's (the Run records what the commanded
 *     execution path reports);
 *   - PostgreSQL is the authority (migration 0061): no in-memory run state is
 *     a source of truth;
 *   - no secrets: runs carry one-way content commitments only.
 */
export {
  // §0 vocabularies (frozen registry identifiers, verbatim)
  RUN_EVIDENCE_CLASSES,
  RUN_EXECUTION_CLASSES,
  RUN_TRIGGER_TYPES,
  // §1 the run state machine
  WORKFLOW_RUN_STATES,
  TERMINAL_WORKFLOW_RUN_STATES,
  RUN_ATTEMPT_STATES,
  RUN_STEP_STATUSES,
  RUN_INVOCATION_OUTCOMES,
  RUN_PROTOCOL_EVENT_NAMES,
  RUN_TIMELINE_EVENT_NAMES,
  RUN_COMMAND_TYPES,
  // §6 typed error surface
  WORKFLOW_RUN_ERROR_CODES,
  WorkflowRunError,
} from './types.js';
export type {
  RunEvidenceClass,
  RunExecutionClass,
  RunTriggerType,
  WorkflowRunState,
  RunAttemptState,
  RunStepStatus,
  RunInvocationOutcome,
  RunProtocolEventName,
  RunTimelineEventName,
  RunCommandType,
  // §2 durable records
  RunTrigger,
  WorkflowRun,
  RunAttempt,
  RunStepExecution,
  RunCapabilityInvocation,
  RunEvidenceRecord,
  RunAttestationBinding,
  RunAttestationRejection,
  RunCommandRecord,
  RunTimelineEntry,
  WorkflowRunHistory,
  // §3 commands
  RunCommandEnvelope,
  RequestRunInput,
  StartRunInput,
  PauseRunInput,
  ResumeRunInput,
  InterruptRunAttemptInput,
  CancelRunInput,
  CompleteRunInput,
  FailRunInput,
  RecordStepStartedInput,
  RecordStepCompletedInput,
  RecordInvocationRequestedInput,
  RecordInvocationCompletedInput,
  RecordRunEvidenceInput,
  AttachRunAttestationInput,
  // §4 command results
  RequestRunResult,
  LifecycleRunResult,
  ResumeRunResult,
  RecordStepResult,
  RecordInvocationResult,
  RecordRunEvidenceResult,
  AttachRunAttestationResult,
  RunCommandOutcome,
  // §5 the service contract
  WorkflowRunClock,
  DefaultWorkflowRunServiceDeps,
  WorkflowRunService,
  // §6 typed errors
  WorkflowRunErrorCode,
} from './types.js';

// The frozen registry vocabulary snapshot (no-drift; pinned against the
// registry file on disk by the registry-conformance battery).
export { RUN_REGISTRY_VOCABULARY } from './internal/registry-vocabulary.js';

// The service (PostgreSQL-authoritative; injected clock/epoch).
export { DefaultWorkflowRunService } from './internal/run-service.js';

// The deterministic injected-clock composition (tests + harnesses).
export {
  createSteppingRunClock,
  formatUtcTimestamp,
  toUtcIsoString,
} from './internal/run-clock.js';
