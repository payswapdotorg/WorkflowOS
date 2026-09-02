/**
 * V2-008 — Computer-Agent Runtime (public barrel).
 *
 * Structure (the workflow-ir / node-capability / execution-attestation /
 * workflow-runs precedent): public contracts in `types.ts`; the universal
 * host protocol, the environment ports + scripted/real implementations,
 * the three host adapters, the safe-action boundary, the attestation path,
 * the pure clock and the runtime loop in `internal/*` (private — the
 * architecture boundary suite enforces that nothing outside this directory
 * reaches into `internal/`).
 *
 * Consumers (the API route, the tests, later Work Orders) import ONLY from
 * this barrel.
 *
 * BOUNDARY REMINDER (constitution §2/§4/§5/§7/§12/§16/§19/§21):
 *   - WorkflowIR semantics + the semantic digest are V2-003's (consumed
 *     through the merged parser/digest for pin + plan resolution);
 *   - the executable plan is the merged V2-007 compiler's (consumed);
 *   - repository/version semantics are V2-002's (read-only version fetch);
 *   - run/evidence/attestation-binding persistence is V2-005's (every
 *     durable fact flows through the recorder port — the real run service
 *     satisfies it structurally);
 *   - node/capability matching is V2-004's (hosts register through the real
 *     registration protocol; routing flows through the merged matcher);
 *   - ExecutionStatement/ExecutionAttestation semantics are V2-014's
 *     (production + verification only through the merged barrel — never a
 *     second signing/verification authority);
 *   - no platform-specific workflow semantics; no secrets materialized.
 */
export {
  // §0 runtime identity
  COMPUTER_AGENT_RUNTIME_ID,
  COMPUTER_AGENT_RUNTIME_VERSION,
  // §1 safe-action vocabulary
  COMPUTER_AGENT_ERROR_CODES,
  ComputerAgentError,
  // §2 the universal host protocol vocabularies
  HOST_ELEMENT_KINDS,
  HOST_FAILURE_CODES,
  AGENT_FAILURE_CODES,
} from './types.js';
export type {
  CapabilitySensitivity,
  SafeActionGrant,
  SafeActionPolicy,
  HostSubject,
  HostElementKind,
  ObservedElement,
  HostObservation,
  ActionGrounding,
  HostActionParameters,
  HostInvocationRequest,
  HostActionOutcome,
  HostFailure,
  HostFailureCode,
  HostInvocationResult,
  HostAttestationSupport,
  ComputerHostAdapter,
  AttestingComputerHost,
  AgentFailure,
  AgentFailureCode,
  AgentAttestationPolicy,
  ComputerAgentPolicy,
  AgentActionRecord,
  ElementExpectation,
  AgentDecision,
  AgentDecisionContext,
  AgentDecider,
  ComputerAgentRunRecorder,
  ExecuteRunInput,
  StepExecutionReport,
  RunExecutionReport,
  TakeoverSession,
  TakeoverActionResult,
  ComputerAgentErrorCode,
} from './types.js';

// The frozen registry vocabulary snapshot (no-drift; pinned against the
// registry file on disk by the registry-conformance battery).
export { COMPUTER_AGENT_REGISTRY_VOCABULARY } from './internal/registry-vocabulary.js';

// The safe-action boundary (the runtime-side authorization dimension).
export {
  capabilitySensitivityOf,
  sensitiveCapabilities,
  isCapabilityGranted,
  checkInvocationAuthorization,
} from './internal/safe-action.js';

// The pure injected clock (fixed-format UTC; no Date API).
export {
  formatUtcTimestamp,
  epochMsOf,
  ageMs,
  addMs,
  createSteppingAgentClock,
} from './internal/clock.js';

// The host-protocol discipline helpers.
export {
  FILE_ABSENT_DIGEST,
  elementDigest,
  HostInvocationLedger,
  createHostObservationIdSource,
  createHostNonceSource,
  groundingRequiredFor,
} from './internal/host-protocol.js';

// The environment ports + deterministic scripted implementations.
export {
  ScriptedBrowserEnvironment,
  ScriptedDesktopEnvironment,
  ScriptedMobileEnvironment,
  browserElementToProtocolElement,
  screenElementToProtocolElement,
  callToProtocolElement,
  notificationToProtocolElement,
} from './internal/environments.js';
export type {
  BrowserPageElement,
  BrowserSessionEnvironment,
  DesktopDirectoryEntry,
  DesktopScreenElement,
  DesktopEnvironment,
  MobileCall,
  MobileNotification,
  MobileEnvironment,
} from './internal/environments.js';

// The real filesystem desktop environment (dogfooding host).
export { RealFilesystemDesktopEnvironment } from './internal/real-desktop-environment.js';

// The three host adapters (one universal protocol).
export {
  WEB_HOST_CAPABILITIES,
  DESKTOP_HOST_CAPABILITIES,
  MOBILE_HOST_CAPABILITIES,
  FILE_ABSENT_SENTINEL,
  WebBrowserHostAdapter,
  DesktopHostAdapter,
  MobileHostAdapter,
  registerComputerHost,
} from './internal/host-adapters.js';
export type { ProtocolHostAdapterDeps, RegisterComputerHostInput } from './internal/host-adapters.js';

// The attestation path (production + independent verification).
export {
  buildStepStatement,
  produceStepAttestation,
  verifyStepAttestationIndependently,
  observationCommitmentOf,
  valueCommitmentOf,
} from './internal/attesting.js';
export type { StepAttestationMaterial, AttestationProductionContext } from './internal/attesting.js';

// The runtime (the observation/action loop + the run walk + takeover).
export { ComputerAgentRuntime } from './internal/runtime.js';
export type {
  ComputerAgentRuntimeDeps,
  FinishTakeoverInput,
  ResumeAfterHumanInput,
} from './internal/runtime.js';
