/**
 * V2-008 — shared deterministic composition fixtures for the computer-agent
 * unit battery (the smoke-dev.ts composition made typed + reusable).
 *
 * DETERMINISM RULES (absolute, work-order "Deterministic-first"):
 *   - every clock is a manually-advanced injected clock (fixed base epoch,
 *     explicit `advance(ms)` in the test/decider script — never wall clock);
 *   - every key seed is a fixed string (node ids derive deterministically);
 *   - every run/version id is a fixed string;
 *   - the attester keys are REAL Ed25519 pairs generated per test process
 *     through the merged V2-014 `generateAttesterKeyPair` (real cryptography;
 *     assertions are key-normalized — they never depend on which concrete
 *     key was generated).
 *
 * The recorder double implements the `ComputerAgentRunRecorder` port (the
 * structural subset of the merged V2-005 WorkflowRunService) with TYPED
 * results and an audit log; commands converge by commandId (the V2-005
 * idempotency discipline) so a re-drive of the same command id returns the
 * recorded outcome without a second side effect.
 */
import {
  ComputerAgentRuntime,
  DesktopHostAdapter,
  DESKTOP_HOST_CAPABILITIES,
  registerComputerHost,
  ScriptedDesktopEnvironment,
  formatUtcTimestamp,
} from '../../../src/computer-agent/index.js';
import type {
  AgentDecider,
  AgentDecision,
  AgentDecisionContext,
  ComputerAgentPolicy,
  ComputerAgentRunRecorder,
} from '../../../src/computer-agent/index.js';
import { DefaultNodeCapabilityService } from '../../../src/node-capability/index.js';
import type { AttesterKeyPair } from '../../../src/execution-attestation/index.js';
import { InMemoryReplayRegistry } from '../../../src/execution-attestation/index.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
} from '../../../src/workflow-ir/index.js';
import type {
  WorkflowIrDocument,
  WorkflowNode,
  PlacementId,
} from '../../../src/workflow-ir/index.js';
import type { WorkflowPrincipal, WorkflowVersion } from '../../../src/workflow-repository/index.js';
import type {
  RunAttempt,
  RunCommandEnvelope,
  RunEvidenceRecord,
  RunInvocationOutcome,
  RunAttestationBinding,
  RunCapabilityInvocation,
  RunCommandOutcome,
  RunStepExecution,
  WorkflowRun,
  WorkflowRunHistory,
  WorkflowRunState,
} from '../../../src/workflow-runs/index.js';

/** The fixed base epoch for every test clock (deterministic; no Date API). */
export const CLOCK_BASE_MS = 1_788_264_000_000;
/** A fixed UTC stamp used for run/attempt bookkeeping fields. */
export const FIXED_STAMP = formatUtcTimestamp(CLOCK_BASE_MS);
/** The acting principal of every unit drive. */
export const PRINCIPAL: WorkflowPrincipal = { userId: 'user_unit' };

/** A manually-advanced injected clock (the only clock in these tests). */
export interface ManualClock {
  now(): string;
  advance(ms: number): void;
  epochMs(): number;
}

export function createManualClock(baseMs: number = CLOCK_BASE_MS): ManualClock {
  let current = baseMs;
  return {
    now: () => formatUtcTimestamp(current),
    advance: (ms: number) => {
      current += ms;
    },
    epochMs: () => current,
  };
}

// ============================================================================
// §1 The IR document (one agentic filesystem step)
// ============================================================================

export interface AgenticDocumentOptions {
  readonly stepId?: string;
  readonly placement?: PlacementId;
  readonly task?: string;
}

/** One agentic step that observes + writes a file at a workflow-input path. */
export function buildAgenticWriteDocument(options: AgenticDocumentOptions = {}): WorkflowIrDocument {
  const stepId = options.stepId ?? 'organize';
  const node: WorkflowNode = {
    id: stepId,
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: options.task ?? 'Write the triage report to the given path' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: options.placement ?? 'device_local',
    inputs: [{ name: 'reportPath', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'reportPath' } }],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart(stepId)
    .addWorkflowInput({ name: 'reportPath', type: { kind: 'string' } })
    .addNode(node)
    .build();
}

// ============================================================================
// §2 The version double (read-only fetch; the runtime JSON.stringifies content)
// ============================================================================

/**
 * The version double. `createdAt`/`parentVersionId`/`protocol`/`createdByUserId`
 * are repository bookkeeping the runtime NEVER reads (it reads `content`
 * only); the double pins them to fixed constants. The cast is honest: no
 * Date API is constructed (determinism rule), and the runtime's consumption
 * surface (content) is fully real.
 */
export function createVersionDouble(options: {
  id: string;
  workflowId: string;
  document: WorkflowIrDocument;
}): WorkflowVersion {
  return {
    id: options.id,
    workflowId: options.workflowId,
    versionNumber: 1,
    contentDigest: 'unit-version-content-digest',
    content: JSON.parse(JSON.stringify(options.document)) as Record<string, unknown>,
    protocol: { irSchemaVersion: '1' },
    parentVersionId: null,
    createdByUserId: 'user_unit_author',
    createdAt: FIXED_STAMP,
  } as unknown as WorkflowVersion;
}

// ============================================================================
// §3 The recorder double (the V2-005 command surface seam + audit log)
// ============================================================================

export interface RecordedStepCompletion {
  readonly stepId: string;
  readonly outcome: RunInvocationOutcome;
  readonly outputCommitments: readonly string[];
}

export interface RecordedEvidence {
  readonly id: string;
  readonly commandId: string;
  readonly evidenceClass: string;
  readonly producerKind: string;
  readonly producerId: string;
  readonly stepId: string | null;
  readonly description: string | null;
}

export interface RecorderDouble {
  readonly recorder: ComputerAgentRunRecorder;
  /** Every executed command id, in order (converged re-deliveries excluded). */
  readonly commands: string[];
  readonly stepCompletions: RecordedStepCompletion[];
  readonly invocationRequests: { id: string; capability: string; commandId: string }[];
  readonly invocationCompletions: { id: string; outcome: RunInvocationOutcome; commandId: string }[];
  readonly evidence: RecordedEvidence[];
  readonly attestationAttachments: { attestationId: string; stepId: string | null; commandId: string }[];
  readonly stateTransitions: WorkflowRunState[];
  setState(state: WorkflowRunState): void;
  state(): WorkflowRunState;
  /** The last step id a pause was recorded at (resume bookkeeping). */
  pausedAtStepId(): string | null;
}

interface StepRecordState {
  readonly record: RunStepExecution;
  outcome: RunInvocationOutcome | null;
  outputCommitments: string[];
}

interface InvocationRecordState {
  readonly record: RunCapabilityInvocation;
  outcome: RunInvocationOutcome | null;
  outputCommitments: string[];
}

export function createRecorderDouble(options: {
  runId: string;
  workflowId: string;
  versionId: string;
  versionSemanticDigest: string;
  clock: ManualClock;
  /**
   * The typed V2-005 attach rejection the REAL boundary throws on a bad
   * attestation (WorkflowRunError — RUN_ATTESTATION_*; durably recorded,
   * never returned as a value). Set to make every attachAttestation call
   * reject with this typed discipline (the completion-gate regressions).
   */
  attachAttestationRejection?: { code: string; message: string };
}): RecorderDouble {
  const { runId } = options;
  const baseRun: WorkflowRun = {
    id: runId,
    organizationId: 'org_unit',
    workflowId: options.workflowId,
    versionId: options.versionId,
    versionContentDigest: 'unit-version-content-digest',
    versionSemanticDigest: options.versionSemanticDigest,
    installationId: null,
    trigger: { type: 'manual', id: 'trig_unit_1' },
    triggeredByUserId: 'user_unit',
    inputCommitments: [],
    inputDigest: 'unit-input-digest',
    state: 'requested',
    createdAt: FIXED_STAMP,
    updatedAt: FIXED_STAMP,
  };
  let runState: WorkflowRunState = 'requested';
  let pausedStepId: string | null = null;
  let attempt: RunAttempt = {
    id: `${runId}-attempt-1`,
    runId,
    attemptNumber: 1,
    state: 'running',
    nodeId: null,
    pausedAtStepId: null,
    startedAt: FIXED_STAMP,
    endedAt: null,
  };
  const commands: string[] = [];
  const recordedCommands = new Map<string, unknown>();
  const stepCompletions: RecordedStepCompletion[] = [];
  const steps = new Map<string, StepRecordState>();
  const invocationRequests: { id: string; capability: string; commandId: string }[] = [];
  const invocationCompletions: { id: string; outcome: RunInvocationOutcome; commandId: string }[] = [];
  const invocations = new Map<string, InvocationRecordState>();
  const evidence: RecordedEvidence[] = [];
  const evidenceRecords: RunEvidenceRecord[] = [];
  const attestationAttachments: { attestationId: string; stepId: string | null; commandId: string }[] = [];
  const stateTransitions: WorkflowRunState[] = [];

  const runView = (): WorkflowRun => ({ ...baseRun, state: runState });
  const attemptView = (): RunAttempt => ({ ...attempt, pausedAtStepId: pausedStepId });

  /** Idempotent command execution (the V2-005 convergence discipline). */
  const execute = <T>(command: RunCommandEnvelope, effect: () => T): RunCommandOutcome<T> => {
    const recorded = recordedCommands.get(command.commandId);
    if (recorded !== undefined) {
      return { executed: false, commandId: command.commandId, result: recorded as T };
    }
    const result = effect();
    recordedCommands.set(command.commandId, result);
    commands.push(command.commandId);
    return { executed: true, commandId: command.commandId, result };
  };

  const transition = (state: WorkflowRunState): void => {
    runState = state;
    stateTransitions.push(state);
  };

  const recorder: ComputerAgentRunRecorder = {
    async startRun(_principal, command) {
      return execute(command, () => {
        transition('running');
        return { run: runView(), attempt: null };
      });
    },
    async pauseRun(_principal, command, input) {
      return execute(command, () => {
        transition('paused');
        pausedStepId = input.atStepId ?? null;
        attempt = { ...attempt, state: 'suspended' };
        return { run: runView(), attempt: attemptView() };
      });
    },
    async resumeRun(_principal, command) {
      return execute(command, () => {
        const resumedAt = pausedStepId;
        transition('running');
        attempt = { ...attempt, state: 'running', endedAt: null };
        pausedStepId = null;
        return { run: runView(), attempt: attemptView(), resumedAtStepId: resumedAt, newAttempt: false };
      });
    },
    async completeRun(_principal, command) {
      return execute(command, () => {
        transition('completed');
        attempt = { ...attempt, state: 'ended', endedAt: options.clock.now() };
        return { run: runView(), attempt: attemptView() };
      });
    },
    async failRun(_principal, command) {
      return execute(command, () => {
        transition('failed');
        attempt = { ...attempt, state: 'ended', endedAt: options.clock.now() };
        return { run: runView(), attempt: attemptView() };
      });
    },
    async recordStepStarted(_principal, command, input) {
      return execute(command, () => {
        const record: RunStepExecution = {
          id: `${runId}-step-${input.stepId}`,
          runId,
          attemptNumber: attempt.attemptNumber,
          stepId: input.stepId,
          status: 'started',
          inputCommitments: [...(input.inputCommitments ?? [])],
          outputCommitments: [],
          outcome: null,
          startedAt: options.clock.now(),
          completedAt: null,
        };
        steps.set(input.stepId, { record, outcome: null, outputCommitments: [] });
        return { step: record };
      });
    },
    async recordStepCompleted(_principal, command, input) {
      return execute(command, () => {
        const state = steps.get(input.stepId);
        const record: RunStepExecution = {
          id: `${runId}-step-${input.stepId}`,
          runId,
          attemptNumber: attempt.attemptNumber,
          stepId: input.stepId,
          status: 'completed',
          inputCommitments: state?.record.inputCommitments ?? [],
          outputCommitments: [...(input.outputCommitments ?? [])],
          outcome: input.outcome,
          startedAt: state?.record.startedAt ?? options.clock.now(),
          completedAt: options.clock.now(),
        };
        if (state) {
          state.outcome = input.outcome;
          state.outputCommitments = [...(input.outputCommitments ?? [])];
        } else {
          steps.set(input.stepId, { record, outcome: input.outcome, outputCommitments: [...(input.outputCommitments ?? [])] });
        }
        stepCompletions.push({
          stepId: input.stepId,
          outcome: input.outcome,
          outputCommitments: [...(input.outputCommitments ?? [])],
        });
        return { step: record };
      });
    },
    async recordInvocationRequested(_principal, command, input) {
      return execute(command, () => {
        const id = `${runId}-inv-${invocations.size + 1}`;
        const record: RunCapabilityInvocation = {
          id,
          runId,
          attemptNumber: attempt.attemptNumber,
          stepId: input.stepId ?? null,
          capability: input.capability,
          executionClass: input.executionClass,
          inputCommitments: [...(input.inputCommitments ?? [])],
          outputCommitments: [],
          outcome: null,
          requestedAt: options.clock.now(),
          completedAt: null,
        };
        invocations.set(id, { record, outcome: null, outputCommitments: [] });
        invocationRequests.push({ id, capability: input.capability, commandId: command.commandId });
        return { invocation: record };
      });
    },
    async recordInvocationCompleted(_principal, command, input) {
      return execute(command, () => {
        const state = invocations.get(input.invocationId);
        const record: RunCapabilityInvocation = {
          id: input.invocationId,
          runId,
          attemptNumber: state?.record.attemptNumber ?? attempt.attemptNumber,
          stepId: state?.record.stepId ?? null,
          capability: state?.record.capability ?? 'unknown',
          executionClass: state?.record.executionClass ?? 'agentic_computer_use',
          inputCommitments: state?.record.inputCommitments ?? [],
          outputCommitments: [...(input.outputCommitments ?? [])],
          outcome: input.outcome,
          requestedAt: state?.record.requestedAt ?? options.clock.now(),
          completedAt: options.clock.now(),
        };
        if (state) {
          state.outcome = input.outcome;
          state.outputCommitments = [...(input.outputCommitments ?? [])];
        } else {
          invocations.set(input.invocationId, { record, outcome: input.outcome, outputCommitments: [...(input.outputCommitments ?? [])] });
        }
        invocationCompletions.push({ id: input.invocationId, outcome: input.outcome, commandId: command.commandId });
        return { invocation: record };
      });
    },
    async recordEvidence(_principal, command, input) {
      return execute(command, () => {
        const record: RunEvidenceRecord = {
          id: `${runId}-ev-${evidenceRecords.length + 1}`,
          runId,
          attemptNumber: input.attemptNumber ?? null,
          stepId: input.stepId ?? null,
          evidenceClass: input.evidenceClass,
          producerKind: input.producerKind,
          producerId: input.producerId,
          contentCommitment: input.contentCommitment,
          description: input.description ?? null,
          recordedAt: options.clock.now(),
        };
        evidenceRecords.push(record);
        evidence.push({
          id: record.id,
          commandId: command.commandId,
          evidenceClass: input.evidenceClass,
          producerKind: input.producerKind,
          producerId: input.producerId,
          stepId: record.stepId,
          description: record.description,
        });
        return { evidence: record, created: true };
      });
    },
    async attachAttestation(_principal, command, input) {
      if (options.attachAttestationRejection !== undefined) {
        // The REAL V2-005 boundary claims the command row and then RAISES the
        // typed rejection (executeCommand: fillCommandResult({ok:false}) +
        // re-throw). The double mirrors that ledger discipline exactly: the
        // command is claimed, the rejection is a THROW, never a value.
        commands.push(command.commandId);
        throw Object.assign(new Error(options.attachAttestationRejection.message), {
          name: 'WorkflowRunError',
          code: options.attachAttestationRejection.code,
        });
      }
      return execute(command, () => {
        const binding: RunAttestationBinding = {
          attestationId: input.attestation.attestationId,
          runId,
          attemptNumber: input.attemptNumber,
          stepId: input.stepId ?? null,
          executionDigest: input.attestation.executionDigest.digest,
          attesterKeyId: input.attestation.attesterKeyId,
          assurance: input.attestation.assurance,
          nonce: input.attestation.statement.nonce,
          statement: input.attestation.statement as unknown as Record<string, unknown>,
          verifiedAt: options.clock.now(),
          attachedAt: options.clock.now(),
        };
        // the boundary-verification evidence of the attach (V2-005 records
        // one per accepted attestation):
        const attachEvidence: RunEvidenceRecord = {
          id: `${runId}-ev-att-${attestationAttachments.length + 1}`,
          runId,
          attemptNumber: input.attemptNumber,
          stepId: input.stepId ?? null,
          evidenceClass: 'verification',
          producerKind: 'computer_agent',
          producerId: 'workflowos/computer-agent-runtime',
          contentCommitment: input.attestation.executionDigest.digest,
          description: `attestation ${input.attestation.attestationId} attached after independent verification`,
          recordedAt: options.clock.now(),
        };
        evidenceRecords.push(attachEvidence);
        evidence.push({
          id: attachEvidence.id,
          commandId: command.commandId,
          evidenceClass: attachEvidence.evidenceClass,
          producerKind: attachEvidence.producerKind,
          producerId: attachEvidence.producerId,
          stepId: attachEvidence.stepId,
          description: attachEvidence.description,
        });
        attestationAttachments.push({
          attestationId: input.attestation.attestationId,
          stepId: input.stepId ?? null,
          commandId: command.commandId,
        });
        return { binding, evidence: attachEvidence };
      });
    },
    async getRun() {
      return runView();
    },
    async getRunHistory(): Promise<WorkflowRunHistory> {
      return {
        run: runView(),
        timeline: [],
        attempts: [attemptView()],
        steps: [...steps.values()].map((state) => ({
          ...state.record,
          outcome: state.outcome,
          outputCommitments: [...state.outputCommitments],
        })),
        invocations: [...invocations.values()].map((state) => ({
          ...state.record,
          outcome: state.outcome,
          outputCommitments: [...state.outputCommitments],
        })),
        evidence: [...evidenceRecords],
        attestations: [],
        attestationRejections: [],
        commands: [],
      };
    },
  };

  return {
    recorder,
    commands,
    stepCompletions,
    invocationRequests,
    invocationCompletions,
    evidence,
    attestationAttachments,
    stateTransitions,
    setState: (state: WorkflowRunState) => {
      transition(state);
    },
    state: () => runState,
    pausedAtStepId: () => pausedStepId,
  };
}

// ============================================================================
// §4 The scripted decider wrapper (context capture for history assertions)
// ============================================================================

export interface ScriptedDecider {
  readonly decider: AgentDecider;
  readonly contexts: AgentDecisionContext[];
}

/** A decider whose every decision context is captured (history assertions). */
export function createRecordingDecider(
  decide: (context: AgentDecisionContext) => AgentDecision,
): ScriptedDecider {
  const contexts: AgentDecisionContext[] = [];
  const decider: AgentDecider = async (context) => {
    contexts.push(context);
    return decide(context);
  };
  return { decider, contexts };
}

// ============================================================================
// §5 The full harness (runtime + nodes + recorder + version + hosts)
// ============================================================================

export interface AgentHarness {
  readonly runtime: ComputerAgentRuntime;
  readonly nodes: DefaultNodeCapabilityService;
  readonly clock: ManualClock;
  readonly recorderDouble: RecorderDouble;
  readonly document: WorkflowIrDocument;
  readonly semanticDigest: string;
  readonly runId: string;
  readonly stepId: string;
  readonly workflowRepository: { getVersion(): Promise<WorkflowVersion> };
  /** Register + attach a desktop host through the REAL V2-004 protocol. */
  attachDesktopHost(options: {
    keySeed: string;
    environment: ScriptedDesktopEnvironment;
    attesterKey?: AttesterKeyPair;
    capabilities?: readonly { name: string; version: number; availability: 'available' }[];
  }): { host: DesktopHostAdapter; nodeId: string; sessionToken: string };
}

const DEFAULT_POLICY: ComputerAgentPolicy = {
  maxActionsPerStep: 12,
  maxObservationAgeMs: 30_000,
  maxRecoveryCyclesPerStep: 4,
  safeAction: {
    grants: [
      { capability: 'filesystem.read', scope: 'run' },
      { capability: 'filesystem.write', scope: 'run' },
    ],
  },
  attestation: { required: false },
};

export function createAgentHarness(options: {
  policy?: Partial<ComputerAgentPolicy>;
  nowMs?: number;
  placement?: PlacementId;
  runId?: string;
  stepId?: string;
  epoch?: number;
  /** The typed V2-005 attach rejection (see createRecorderDouble). */
  attachAttestationRejection?: { code: string; message: string };
}): AgentHarness {
  const runId = options.runId ?? 'run_unit_1';
  const stepId = options.stepId ?? 'organize';
  const clock = createManualClock(options.nowMs ?? CLOCK_BASE_MS);
  const document = buildAgenticWriteDocument({ stepId, placement: options.placement });
  const semanticDigest = computeWorkflowVersionSemanticDigest(document).digest;
  const recorderDouble = createRecorderDouble({
    runId,
    workflowId: 'wf_unit_1',
    versionId: 'ver_unit_1',
    versionSemanticDigest: semanticDigest,
    clock,
    ...(options.attachAttestationRejection !== undefined
      ? { attachAttestationRejection: options.attachAttestationRejection }
      : {}),
  });
  const nodes = new DefaultNodeCapabilityService({ clock: () => clock.epochMs() });
  const version = createVersionDouble({ id: 'ver_unit_1', workflowId: 'wf_unit_1', document });
  const policy: ComputerAgentPolicy = { ...DEFAULT_POLICY, ...options.policy };
  const runtime = new ComputerAgentRuntime({
    recorder: recorderDouble.recorder,
    nodes,
    workflowRepository: { getVersion: async () => version },
    clock: () => clock.now(),
    epoch: options.epoch ?? 7,
    policy,
    replayRegistry: new InMemoryReplayRegistry(),
  });
  return {
    runtime,
    nodes,
    clock,
    recorderDouble,
    document,
    semanticDigest,
    runId,
    stepId,
    workflowRepository: { getVersion: async () => version },
    attachDesktopHost: (hostOptions) => {
      const capabilities = hostOptions.capabilities ?? DESKTOP_HOST_CAPABILITIES;
      const { nodeId, sessionToken } = registerComputerHost({
        nodes,
        keySeed: hostOptions.keySeed,
        platformClass: 'desktop',
        capabilities,
      });
      const host = new DesktopHostAdapter({
        nodeId,
        sessionToken,
        clock: () => clock.now(),
        // the adapter advertises EXACTLY the capabilities the node registered
        // with through the REAL V2-004 protocol (never a widened surface):
        capabilities,
        attestation: hostOptions.attesterKey
          ? { supported: true, attesterKeyId: hostOptions.attesterKey.keyId }
          : { supported: false, reason: 'no-attester-key' },
        ...(hostOptions.attesterKey ? { attesterKey: hostOptions.attesterKey } : {}),
        environment: hostOptions.environment,
      });
      return { host, nodeId, sessionToken };
    },
  };
}

/** A scripted desktop environment with a `reports` directory, no files. */
export function freshDesktopEnvironment(): ScriptedDesktopEnvironment {
  return new ScriptedDesktopEnvironment({ directories: ['reports'] });
}

/** The workflow inputs every drive uses (fixed path string). */
export const WORKFLOW_INPUTS = { reportPath: 'reports/summary.md' } as const;
