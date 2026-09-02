/**
 * V2-008 — Computer-Agent Runtime: the public contracts.
 *
 * WORK ORDER: spec/architecture/v2/work-orders/V2-008.md
 * REGISTRY:   spec/architecture/v2/V2-CTRL-003-protocol-registry.md (+ .json)
 * CONSTITUTION: §5 (authorization is a separate dimension), §6 (execution
 *   classes; computer-use is not the default substitute for a known reliable
 *   API), §7 (evidence truth — a model statement is never evidence of a side
 *   effect), §12 (locality is a correctness constraint), §16 (per-capability
 *   consent boundaries), §19 (forbidden drift), §21 (attestation boundaries).
 *
 * The domain lives at `src/computer-agent/` (application-layer pure domain
 * module — the workflow-ir / node-capability / execution-attestation /
 * workflow-runs precedent). It owns EXACTLY the V2-008 scope:
 *
 *   - the observation/action loop bounded by WorkflowIR and policy (the
 *     agentic executor for `agentic_computer_use` steps, plus the structured
 *     single-invocation path for `deterministic_api` steps);
 *   - observation/action grounding (stale-observation bounds, wrong-target
 *     prevention, duplicate action suppression);
 *   - host adapters for web, desktop and mobile implementing ONE universal
 *     invocation protocol (platform differences appear only in capabilities
 *     offered, never in protocol semantics);
 *   - explicit safe-action boundaries for sensitive capabilities (per-
 *     capability consent grants — the runtime-side authorization dimension);
 *   - human takeover (a human acts through the SAME host protocol on a
 *     paused run, recorded as human-confirmation evidence);
 *   - bounded recovery with failure classification that never invents
 *     successful (or failed) side effects — after a failed action the
 *     effect is UNKNOWN until re-observed;
 *   - ExecutionAttestation production where the host supports the merged
 *     V2-014 contract, verified through the merged verifier (the independent
 *     verifier path) before attachment — and honest representation of
 *     unsupported attestation assurance (no key ⇒ no attestation, never a
 *     fabricated or upclaimed one).
 *
 * BOUNDARY CONTRACT (load-bearing, pinned by
 * tests/unit/computer-agent/module-boundary.test.ts):
 *
 *   - NOT WorkflowIR semantics (V2-003): the runtime consumes the merged
 *     parser/semantic digest to pin and compile the executed version; it
 *     never redefines node/edge/binding semantics.
 *   - NOT repository/version semantics (V2-002): read-only version fetch for
 *     pin resolution; the run records carry the pins.
 *   - NOT Run lifecycle/evidence authority (V2-005): every durable fact this
 *     runtime produces is recorded through the merged run service's command
 *     surface (the recorder port is a structural subset of it); the runtime
 *     holds no durable state of its own.
 *   - NOT Node/capability matching semantics (V2-004): host adapters
 *     register through the real V2-004 registration protocol and the runtime
 *     routes via the merged matcher with requirement sets projected from IR
 *     nodes as DATA; capability advertisement is never authorization.
 *   - NOT compiler semantics (V2-007): the merged compiler produces the
 *     executable plan (source-semantic-digest-bound); this module never
 *     re-derives compilation.
 *   - NOT ExecutionStatement/ExecutionDigest/ExecutionAttestation semantics
 *     (V2-014): the runtime PRODUCES statements and signs/verifies only
 *     through the merged execution-attestation barrel — never a second
 *     signing or verification authority, never proof-graph concepts.
 *   - NO platform-specific workflow semantics: one protocol request/response
 *     shape for every host class; workflow meaning never depends on which
 *     host class executes a step.
 *   - NO secrets: invocations carry only typed parameter values the workflow
 *     itself declared; secret ports are never materialized here.
 */


import type { RunExecutionClass, WorkflowRunState, WorkflowRunService } from '../workflow-runs/index.js';
import type { ExecutionAttestation, ExecutionStatement } from '../execution-attestation/index.js';
import type { CapabilityAdvertisement, NodePlatformClass } from '../node-capability/index.js';
import type { AssuranceLevel } from '../execution-attestation/index.js';

// ============================================================================
// §0 Runtime identity
// ============================================================================

/** The stable identity of this computer-agent runtime implementation. */
export const COMPUTER_AGENT_RUNTIME_ID = 'workflowos/computer-agent-runtime';

/** The runtime protocol version implemented by this module. */
export const COMPUTER_AGENT_RUNTIME_VERSION = 1;

// ============================================================================
// §1 Safe-action vocabulary (the runtime-side authorization dimension)
// ============================================================================

/**
 * The sensitivity classification of one canonical capability under this
 * runtime's safe-action policy.
 *
 *   - `sensitive` — the capability reads private device data beyond the
 *     active browser page, senses the environment, or causes an external
 *     side effect. Invoking it requires an explicit per-capability grant in
 *     the run's SafeActionPolicy (constitution §16: device access is not
 *     blanket access to device data).
 *   - `ordinary` — observation/navigation of the active surface; allowed by
 *     default within the runtime's other bounds.
 *
 * This classification is the RUNTIME's own policy vocabulary (the registry
 * has no sensitivity dimension — recorded honestly; it is not a registry
 * authority). Every classified name is a canonical registry capability name
 * verbatim (pinned by the registry-conformance battery).
 */
export type CapabilitySensitivity = 'sensitive' | 'ordinary';

/** One explicit safe-action grant (capability-scoped, run- or step-scoped). */
export interface SafeActionGrant {
  /** The canonical registry capability name the grant covers. */
  readonly capability: string;
  /** `run` = whole run; `step` = only the referenced step. */
  readonly scope: 'run' | 'step';
  /** The step id when scope is `step`. */
  readonly stepId?: string;
}

/** The safe-action policy: the explicit grants that authorize sensitive use. */
export interface SafeActionPolicy {
  readonly grants: readonly SafeActionGrant[];
}

// ============================================================================
// §2 The universal host invocation protocol (all host classes, identical)
// ============================================================================

/** A host subject: URL, filesystem path, screen, call log, … (host-scoped). */
export type HostSubject = string;

/** The closed observed-element kind vocabulary (host-protocol scoped). */
export const HOST_ELEMENT_KINDS = [
  'text',
  'button',
  'link',
  'input',
  'select',
  'file',
  'directory',
  'window',
  'call',
  'notification',
] as const;
export type HostElementKind = (typeof HOST_ELEMENT_KINDS)[number];

/** One observed element: host-stable address + kind + label + current state. */
export interface ObservedElement {
  /** The host-stable element address (DOM id, file path, call id, …). */
  readonly elementId: string;
  readonly kind: HostElementKind;
  readonly label: string;
  /** The element's current value/content/state (never secret material). */
  readonly state: string;
  /**
   * sha-256 over canonical JSON {elementId, kind, label, state} — the
   * grounding digest wrong-target prevention compares against.
   */
  readonly digest: string;
}

/** One host observation: the grounded view the runtime acts upon. */
export interface HostObservation {
  /** Host-assigned deterministic observation id. */
  readonly observationId: string;
  /** The injected host clock at observation time (fixed-format UTC). */
  readonly observedAt: string;
  readonly subject: HostSubject;
  readonly elements: readonly ObservedElement[];
}

/**
 * The grounding reference of an action: which observation, which element,
 * and the digest the target MUST still match (wrong-target prevention —
 * fail-closed, never silent re-targeting).
 */
export interface ActionGrounding {
  readonly observationId: string;
  readonly targetElementId: string;
  readonly targetDigest: string;
}

/** Typed, JSON-shaped action parameters (never secret material). */
export type HostActionParameters = Readonly<Record<string, unknown>>;

/**
 * One universal protocol invocation request. `kind: 'observe'` reads a
 * subject through a capability; `kind: 'act'` performs a grounded mutation.
 * Structured (deterministic_api) invocations are acts without grounding.
 */
export type HostInvocationRequest =
  | {
      readonly kind: 'observe';
      readonly capability: string;
      readonly subject: HostSubject;
    }
  | {
      readonly kind: 'act';
      readonly capability: string;
      readonly grounding: ActionGrounding | null;
      readonly parameters: HostActionParameters;
    };

/** The outcome of an act invocation (what the host CLAIMS — a claim). */
export interface HostActionOutcome {
  readonly outcome: 'succeeded' | 'failed';
  /**
   * The host's own fresh post-action observation of the affected subject —
   * the REAL effect the runtime verifies against (never a trust-me claim).
   */
  readonly effect: HostObservation | null;
  readonly detail: string | null;
}

/** The closed host-side failure taxonomy (typed, fail-closed). */
export const HOST_FAILURE_CODES = [
  /** the host adapter does not implement the requested capability */
  'HOST_CAPABILITY_NOT_SUPPORTED',
  /** the observe subject does not exist on the host */
  'HOST_SUBJECT_NOT_FOUND',
  /** the grounded target element no longer exists */
  'HOST_TARGET_NOT_FOUND',
  /** the target's current digest ≠ grounding digest (no execution happened) */
  'HOST_TARGET_CHANGED',
  /** the request parameters are invalid for the capability */
  'HOST_PARAMETER_INVALID',
  /** transient host unavailability (recoverable by retry) */
  'HOST_TRANSIENT_UNAVAILABLE',
  /** permanent environment error (fail-closed honest) */
  'HOST_ENVIRONMENT_ERROR',
] as const;
export type HostFailureCode = (typeof HOST_FAILURE_CODES)[number];

/** A typed host-side invocation failure. */
export interface HostFailure {
  readonly code: HostFailureCode;
  readonly detail: string;
  /** The digest the target actually had, when TARGET_CHANGED (audit only). */
  readonly actualDigest?: string;
}

/** The universal invocation result (observation, action claim, or failure). */
export type HostInvocationResult =
  | { readonly ok: true; readonly kind: 'observed'; readonly observation: HostObservation; readonly converged: boolean }
  | { readonly ok: true; readonly kind: 'acted'; readonly outcome: HostActionOutcome; readonly converged: boolean }
  | { readonly ok: false; readonly failure: HostFailure };

// ============================================================================
// §3 Attestation support (honest — where the host supports the V2-014 contract)
// ============================================================================

/**
 * The host's attestation capability. `supported: false` is an HONEST
 * declaration (e.g. no attester key on this host): the runtime then records
 * the absence and never fabricates or up-claims assurance.
 */
export type HostAttestationSupport =
  | { readonly supported: true; readonly attesterKeyId: string }
  | { readonly supported: false; readonly reason: 'no-attester-key' };

// ============================================================================
// §4 Host adapters (web, desktop, mobile — one protocol)
// ============================================================================

/**
 * One attached computer host: a node registered through the real V2-004
 * protocol (nodeId + sessionToken) plus the universal invocation surface.
 * Platform differences appear ONLY in the advertised capabilities and the
 * platform class — never in the protocol semantics.
 */
export interface ComputerHostAdapter {
  readonly nodeId: string;
  readonly sessionToken: string;
  readonly platformClass: NodePlatformClass;
  /** The V2-004 advertisement this host registered with (verbatim). */
  readonly capabilities: readonly CapabilityAdvertisement[];
  readonly attestationSupport: HostAttestationSupport;
  /** The universal invocation entry point (idempotent per invocation id). */
  invoke(invocationId: string, request: HostInvocationRequest): Promise<HostInvocationResult>;
  /**
   * A single-use freshness nonce source for attestation statements produced
   * on this host (deterministic when injected; never wall-clock).
   */
  nextNonce(): string;
}

/**
 * A host that supports the V2-014 contract WITH real key material: it signs
 * canonical statements through the merged execution-attestation barrel
 * (the key never leaves the adapter). Hosts WITHOUT a key stay honest
 * plain ComputerHostAdapters (`supported: false, reason: 'no-attester-key'`).
 */
export interface AttestingComputerHost extends ComputerHostAdapter {
  readonly attestationSupport: { readonly supported: true; readonly attesterKeyId: string };
  /** Sign one canonical statement with the host's real Ed25519 key. */
  signStatement(statement: ExecutionStatement, issuedAt: string): ExecutionAttestation;
}

// ============================================================================
// §5 The runtime-side failure taxonomy (classification + recoverability)
// ============================================================================

/**
 * The closed runtime failure vocabulary. Every failure of an executed step
 * is one of these typed codes — never a silent default, never an invented
 * outcome.
 */
export const AGENT_FAILURE_CODES = [
  /** no node in the V2-004 directory satisfies the step's requirements */
  'AGENT_NO_ELIGIBLE_HOST',
  /** an eligible node has no attached host adapter (host not connected) */
  'AGENT_HOST_NOT_CONNECTED',
  /** sensitive capability invoked without an explicit safe-action grant */
  'AGENT_CAPABILITY_UNAUTHORIZED',
  /** the action's grounding observation is older than the policy bound */
  'AGENT_OBSERVATION_STALE',
  /** the host reported the grounded target changed (recoverable: re-ground) */
  'AGENT_TARGET_CHANGED',
  /** the host reported the target/subject missing (recoverable: re-observe) */
  'AGENT_TARGET_NOT_FOUND',
  /** transient host failure (recoverable: bounded retry) */
  'AGENT_HOST_TRANSIENT',
  /** permanent host failure (fail-closed) */
  'AGENT_HOST_PERMANENT',
  /** the bounded action budget was exhausted before completion evidence */
  'AGENT_MAX_ACTIONS_EXCEEDED',
  /** the completion claim did not verify against the effect observation */
  'AGENT_COMPLETION_UNVERIFIED',
  /** the pinned version's semantic digest does not match the run record */
  'AGENT_VERSION_PIN_MISMATCH',
  /** the compiled plan for the pinned version could not be produced */
  'AGENT_PLAN_UNAVAILABLE',
  /** attestation required by policy but honestly unavailable on the host */
  'AGENT_ATTESTATION_UNAVAILABLE',
  /**
   * A REQUIRED attestation was rejected — by the runtime's independent
   * V2-014 verification or by the V2-005 run-boundary attach. Required
   * attestation is a completion gate: the step is durably failed (never
   * succeeded) and the run cannot complete on this path.
   */
  'AGENT_ATTESTATION_REJECTED',
  /** subworkflow execution is out of this runtime's scope (honest, typed) */
  'AGENT_SUBWORKFLOW_UNSUPPORTED',
] as const;
export type AgentFailureCode = (typeof AGENT_FAILURE_CODES)[number];

/** One classified runtime failure: typed code + recoverability honesty. */
export interface AgentFailure {
  readonly code: AgentFailureCode;
  readonly detail: string;
  /**
   * True when the runtime's bounded recovery loop may retry the step
   * (re-observe / re-ground / retry). Never true for authorization or
   * boundary failures — those are honest terminal rejections.
   */
  readonly recoverable: boolean;
}

// ============================================================================
// §6 The runtime policy (bounds, grants, attestation expectations)
// ============================================================================

/** The attestation policy of the runtime (V2-014 consumption expectations). */
export interface AgentAttestationPolicy {
  /** Require attestation for every completed capability step (fail-closed). */
  readonly required: boolean;
  /** Trusted attester key ids (empty trusts nobody — fail-closed). */
  readonly trustedAttesterKeyIds?: readonly string[];
  /** Minimum required assurance level (default: software_signed). */
  readonly requiredAssurance?: AssuranceLevel;
  /** Maximum attestation age at independent verification. */
  readonly maxAgeMs?: number;
  /**
   * The statement's bounded validity window (validUntil = issuedAt + this).
   * Default 300_000 (5 min). Must tolerate bounded clock skew between the
   * producing host's clock and the verifying boundary's clock — the
   * freshness discipline itself is maxAgeMs + single-use nonces, never the
   * window alone.
   */
  readonly validityMs?: number;
}

/** The bounded-loop and authorization policy of the runtime. */
export interface ComputerAgentPolicy {
  /** Maximum host invocations per step execution cycle (bounded loop). */
  readonly maxActionsPerStep: number;
  /** Maximum age of a grounding observation when an act is issued (ms). */
  readonly maxObservationAgeMs: number;
  /** Maximum recovery cycles (re-observe/re-ground/retry) per action. */
  readonly maxRecoveryCyclesPerStep: number;
  /** The safe-action grants authorizing sensitive capability use. */
  readonly safeAction: SafeActionPolicy;
  /** The attestation expectations (production + independent verification). */
  readonly attestation: AgentAttestationPolicy;
}

// ============================================================================
// §7 The injected agent decision function (the loop's intelligence port)
// ============================================================================

/** One recorded action in the decision context history. */
export interface AgentActionRecord {
  readonly invocationId: string;
  readonly capability: string;
  readonly kind: 'observe' | 'act';
  readonly by: 'agent' | 'human';
  readonly ok: boolean;
  readonly failureCode?: HostFailureCode | AgentFailureCode;
  readonly detail: string | null;
}

/** The expectation a completion claim is verified against (evidence truth). */
export interface ElementExpectation {
  readonly elementId?: string;
  readonly kind?: HostElementKind;
  readonly label?: string;
  readonly state?: string;
}

/** The closed decision vocabulary of the injected agent policy. */
export type AgentDecision =
  | { readonly decision: 'observe'; readonly capability: string; readonly subject: HostSubject }
  | {
      readonly decision: 'act';
      readonly capability: string;
      readonly grounding: ActionGrounding | null;
      readonly parameters: HostActionParameters;
    }
  | {
      readonly decision: 'complete';
      /** The verification observation establishing completion (evidence). */
      readonly verify: { readonly capability: string; readonly subject: HostSubject; readonly expect: ElementExpectation };
      /** The step's declared output values (agent-extracted, verified data). */
      readonly outputs?: Readonly<Record<string, unknown>>;
    }
  | { readonly decision: 'takeover'; readonly reason: string }
  | { readonly decision: 'fail'; readonly reason: string };

/** The decision context: everything the policy may legitimately see. */
export interface AgentDecisionContext {
  readonly runId: string;
  readonly attemptNumber: number;
  readonly stepId: string;
  /** The IR-declared task of the agentic step (spec.task). */
  readonly task: string;
  /** The step's resolved input values (typed port bindings, JSON values). */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** The latest observation (null before the first observe). */
  readonly observation: HostObservation | null;
  /** The step's action history this cycle (agent + human, in order). */
  readonly history: readonly AgentActionRecord[];
  readonly actionsRemaining: number;
}

/** The injected decision function (deterministic in tests; scripted in dogfooding). */
export type AgentDecider = (context: AgentDecisionContext) => AgentDecision | Promise<AgentDecision>;

// ============================================================================
// §8 The run recorder port (the V2-005 command surface seam)
// ============================================================================

/**
 * The structural subset of the merged V2-005 WorkflowRunService the runtime
 * commands. The REAL run service satisfies it structurally (the default
 * composition — no adapter code at all); deterministic unit tests provide a
 * scripted recorder implementing the same typed surface. The runtime holds
 * NO durable state of its own — every durable fact goes through here.
 */
export type ComputerAgentRunRecorder = Pick<
  WorkflowRunService,
  | 'startRun'
  | 'pauseRun'
  | 'resumeRun'
  | 'completeRun'
  | 'failRun'
  | 'recordStepStarted'
  | 'recordStepCompleted'
  | 'recordInvocationRequested'
  | 'recordInvocationCompleted'
  | 'recordEvidence'
  | 'attachAttestation'
  | 'getRun'
  | 'getRunHistory'
>;

// ============================================================================
// §9 Execution inputs and reports
// ============================================================================

/** Input to one full run execution drive. */
export interface ExecuteRunInput {
  readonly runId: string;
  /** The hosts attached for this drive (all must be V2-004-registered). */
  readonly hosts: readonly ComputerHostAdapter[];
  /** The injected agent decision policy for agentic steps. */
  readonly decider: AgentDecider;
  /** Resolved workflow input values (typed JSON; never secret material). */
  readonly workflowInputs?: Readonly<Record<string, unknown>>;
}

/** The per-step execution report. */
export interface StepExecutionReport {
  readonly stepId: string;
  readonly executionClass: RunExecutionClass;
  readonly outcome: 'completed' | 'failed' | 'paused';
  readonly actions: number;
  readonly observations: number;
  readonly attestationsAttached: number;
  readonly attestationsRejected: number;
  readonly failure: AgentFailure | null;
  /** The host node the step ran on (null when not dispatched). */
  readonly nodeId: string | null;
}

/** The full run-drive report. */
export interface RunExecutionReport {
  readonly runId: string;
  /** The run's state after the drive (from the run service). */
  readonly state: WorkflowRunState;
  readonly steps: readonly StepExecutionReport[];
  /** The step the run is paused at (null when not paused). */
  readonly pausedAtStepId: string | null;
  /** True when the pause is an agent-requested human takeover point. */
  readonly takeoverRequested: boolean;
  readonly failure: AgentFailure | null;
  readonly outputCommitments: readonly string[];
}

// ============================================================================
// §10 Human takeover (the human acts through the SAME host protocol)
// ============================================================================

/** An active takeover session on a paused run step. */
export interface TakeoverSession {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly userId: string;
  /** The host the human acts through (the paused step's execution host). */
  readonly nodeId: string;
}

/** The result of one human takeover action. */
export interface TakeoverActionResult {
  readonly result: HostInvocationResult;
  /** The command id of the human-confirmation evidence record. */
  readonly evidenceCommandId: string;
}

// ============================================================================
// §11 Typed error surface (fail-closed)
// ============================================================================

export const COMPUTER_AGENT_ERROR_CODES = [
  'COMPUTER_AGENT_RUN_NOT_FOUND',
  'COMPUTER_AGENT_RUN_NOT_PAUSED',
  'COMPUTER_AGENT_RUN_TERMINAL',
  'COMPUTER_AGENT_STEP_NOT_PAUSED',
  'COMPUTER_AGENT_HOST_UNKNOWN',
  'COMPUTER_AGENT_TAKEOVER_SESSION_NOT_FOUND',
  'COMPUTER_AGENT_TAKEOVER_SESSION_CLOSED',
  'COMPUTER_AGENT_ATTESTATION_KEY_REQUIRED',
  'COMPUTER_AGENT_INVALID_REQUEST',
] as const;
export type ComputerAgentErrorCode = (typeof COMPUTER_AGENT_ERROR_CODES)[number];

/** Typed, fail-closed error for runtime operations (never a silent default). */
export class ComputerAgentError extends Error {
  readonly code: ComputerAgentErrorCode;

  constructor(code: ComputerAgentErrorCode, message: string) {
    super(`computer-agent: ${message}`);
    this.name = 'ComputerAgentError';
    this.code = code;
  }
}
