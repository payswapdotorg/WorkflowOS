/**
 * V2-016 — the dependent-step composition-precondition ADMISSION battery
 * (work order spec/architecture/v2/work-orders/V2-016.md, "Required
 * regressions" 1–8, 11, 12 + "Fail-closed admission").
 *
 * Every test drives the REAL public V2-008 execution/resume path
 * (ComputerAgentRuntime.executeRun / resumeAfterHuman) over the established
 * deterministic unit composition: the recorder double (the structural
 * V2-005 command seam with typed results + an audit log), the real V2-004
 * registration protocol + matcher, a REAL Ed25519 attester key on the
 * desktop host, and the canonical V2-014 verifier producing the
 * VerifiedExecutionFact the precondition carries.
 *
 * The fixture workflow mirrors the cross-device composition shape the work
 * order exists for: an attested predecessor step (`collect`) → a human
 * approval pause point (`approve`) → the DEPENDENT step (`acknowledge`)
 * whose admission requires a V2-014-derived verified predecessor fact
 * supplied on the resume drive.
 *
 * ADMISSION SEMANTICS UNDER TEST (all fail-closed, all typed):
 *   1. a valid predecessor precondition is consumed before the first
 *      dependent side effect (the happy path completes; the dependent
 *      attestation carries exactly the declared causal parent);
 *   2. a missing precondition fails closed BEFORE any host invocation
 *      (AGENT_PRECONDITION_REJECTED, actions: 0, run failed);
 *   3. a wrong-RUN binding is rejected at drive entry (typed
 *      COMPUTER_AGENT_PRECONDITION_REJECTED, run untouched, zero commands);
 *   4. a wrong-WorkflowVersion binding (id and semantic digest) — same;
 *   5. a wrong predecessor/step relationship (identity mismatch,
 *      self-predecessor, non-dependent target) — same;
 *   6. an unverified / stale / replayed / insufficient-assurance
 *      predecessor fails closed THROUGH the V2-014-derived verification
 *      results: the canonical verifier's typed rejection produces NO
 *      VerifiedExecutionFact, so admission has nothing to consume;
 *   7. an invented (uncovered) or silently-dropped causal parent digest is
 *      rejected (never invented, never dropped);
 *   8. admission is NOT authorization: an admitted dependent step without
 *      the safe-action grant still fails AGENT_CAPABILITY_UNAUTHORIZED with
 *      zero side effects;
 *  11. duplicate delivery / re-drive of the admitted dependent action
 *      remains exactly-once (duplicate preconditions converge; terminal
 *      states reject re-drives typed; one write effect per host);
 *  12. a precondition minted for one Run/WorkflowVersion cannot be
 *      consumed by another (declared binding + fact statement binding).
 */
import { describe, it, expect } from 'vitest';
import {
  ComputerAgentRuntime,
  DesktopHostAdapter,
  DESKTOP_HOST_CAPABILITIES,
  registerComputerHost,
  ScriptedDesktopEnvironment,
  addMs,
  type ComputerAgentPolicy,
  type ComputerAgentRunRecorder,
  type DependentStepPrecondition,
  type AgentDecider,
  type AgentDecisionContext,
} from '../../../src/computer-agent/index.js';
import {
  verifyAttestation,
  generateAttesterKeyPair,
  InMemoryReplayRegistry,
  type AttestationVerification,
  type ExecutionAttestation,
  type VerifiedExecutionFact,
} from '../../../src/execution-attestation/index.js';
import { DefaultNodeCapabilityService } from '../../../src/node-capability/index.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';
import type { WorkflowVersion } from '../../../src/workflow-repository/index.js';
import {
  createManualClock,
  createRecorderDouble,
  createVersionDouble,
  createRecordingDecider,
  PRINCIPAL,
  type RecorderDouble,
  type ScriptedDecider,
} from './helpers.js';

// ============================================================================
// §0 Deterministic fixture constants
// ============================================================================

const RUN_ID = 'run_v2016_1';
const WORKFLOW_ID = 'wf_v2016_1';
const VERSION_ID = 'ver_v2016_1';
const DEPENDENT_STEP_ID = 'acknowledge';
const PREDECESSOR_STEP_ID = 'collect';
const HUMAN_STEP_ID = 'approve';
const EPOCH = 7;
const ATTESTER_KEY = generateAttesterKeyPair();
const COLLECT_CONTENT = 'TRIAGE REPORT v2016';
const ACK_CONTENT = 'ACK v2016';

/** The fixture workflow: collect (attested) → approve (human) → acknowledge (DEPENDENT). */
function buildDependentFlowDocument(): WorkflowIrDocument {
  const collect: WorkflowNode = {
    id: PREDECESSOR_STEP_ID,
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Write the triage report to the given path' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: 'device_local',
    inputs: [{ name: 'reportPath', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'reportPath' } }],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const approve: WorkflowNode = {
    id: HUMAN_STEP_ID,
    executionClass: 'human',
    spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve the acknowledgment step.' } },
    capabilityRequirements: [],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'human_confirmation',
  };
  const acknowledge: WorkflowNode = {
    id: DEPENDENT_STEP_ID,
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Write the acknowledgment file for the verified report' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: 'device_local',
    inputs: [{ name: 'ackPath', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ackPath' } }],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart(PREDECESSOR_STEP_ID)
    .addWorkflowInput({ name: 'reportPath', type: { kind: 'string' } })
    .addWorkflowInput({ name: 'ackPath', type: { kind: 'string' } })
    .addNode(collect)
    .addNode(approve)
    .addNode(acknowledge)
    .addEdge({ from: PREDECESSOR_STEP_ID, to: HUMAN_STEP_ID, on: 'success' })
    .addEdge({ from: HUMAN_STEP_ID, to: DEPENDENT_STEP_ID, on: { outcome: 'approved' } })
    .addEdge({ from: HUMAN_STEP_ID, to: DEPENDENT_STEP_ID, on: { outcome: 'rejected' } })
    .build();
}

/** The step-aware scripted decider: observe absent → grounded write → verify. */
function createFlowDecider(): ScriptedDecider {
  return createRecordingDecider((ctx: AgentDecisionContext) => {
    const path =
      ctx.stepId === PREDECESSOR_STEP_ID
        ? String(ctx.inputs.reportPath ?? '')
        : String(ctx.inputs.ackPath ?? '');
    const content = ctx.stepId === PREDECESSOR_STEP_ID ? COLLECT_CONTENT : ACK_CONTENT;
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'filesystem.read', subject: path };
    }
    const writeSucceeded = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
    if (!writeSucceeded) {
      const target = ctx.observation.elements.find((element) => element.elementId === path);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: target
          ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
          : null,
        parameters: { path, content },
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'filesystem.read', subject: path, expect: { elementId: path, state: content } },
      outputs: { written: true },
    };
  });
}

// ============================================================================
// §1 The V2-016 unit harness (capturing recorder over the double)
// ============================================================================

interface AdmissionHarness {
  readonly runtime: ComputerAgentRuntime;
  readonly recorderDouble: RecorderDouble;
  readonly decider: AgentDecider;
  readonly clock: ReturnType<typeof createManualClock>;
  readonly runId: string;
  readonly versionId: string;
  readonly workflowId: string;
  readonly semanticDigest: string;
  /** The (single) attached attesting desktop host for every drive. */
  readonly host: DesktopHostAdapter;
  /** Every attestation the runtime attached, in order (the real envelopes). */
  readonly attached: ExecutionAttestation[];
}

function createAdmissionHarness(options: {
  policy?: Partial<ComputerAgentPolicy>;
  runId?: string;
}): AdmissionHarness {
  const runId = options.runId ?? RUN_ID;
  const clock = createManualClock();
  const document = buildDependentFlowDocument();
  const semanticDigest = computeWorkflowVersionSemanticDigest(document).digest;
  const recorderDouble = createRecorderDouble({
    runId,
    workflowId: WORKFLOW_ID,
    versionId: VERSION_ID,
    versionSemanticDigest: semanticDigest,
    clock,
  });
  // The capturing recorder: wraps the double's attachAttestation so the
  // driver-side verifier receives the EXACT envelope the runtime produced
  // (never a reconstruction) — the cross-device transfer seam.
  const attached: ExecutionAttestation[] = [];
  const capturingRecorder: ComputerAgentRunRecorder = {
    ...recorderDouble.recorder,
    attachAttestation: async (principal, command, input) => {
      attached.push(input.attestation);
      return recorderDouble.recorder.attachAttestation(principal, command, input);
    },
  };
  const nodes = new DefaultNodeCapabilityService({ clock: () => clock.epochMs() });
  const version: WorkflowVersion = createVersionDouble({ id: VERSION_ID, workflowId: WORKFLOW_ID, document });
  const { nodeId, sessionToken } = registerComputerHost({
    nodes,
    keySeed: 'v2016-host-seed',
    platformClass: 'desktop',
    capabilities: DESKTOP_HOST_CAPABILITIES,
  });
  const host = new DesktopHostAdapter({
    nodeId,
    sessionToken,
    clock: () => clock.now(),
    capabilities: DESKTOP_HOST_CAPABILITIES,
    attestation: { supported: true, attesterKeyId: ATTESTER_KEY.keyId },
    attesterKey: ATTESTER_KEY,
    environment: new ScriptedDesktopEnvironment({ directories: ['reports'] }),
  });
  const basePolicy: ComputerAgentPolicy = {
    maxActionsPerStep: 12,
    maxObservationAgeMs: 30_000,
    maxRecoveryCyclesPerStep: 4,
    safeAction: {
      grants: [
        { capability: 'filesystem.read', scope: 'run' },
        { capability: 'filesystem.write', scope: 'run' },
      ],
    },
    attestation: {
      required: true,
      trustedAttesterKeyIds: [ATTESTER_KEY.keyId],
      requiredAssurance: 'software_signed',
      validityMs: 300_000,
    },
    dependentStepIds: [DEPENDENT_STEP_ID],
  };
  const runtime = new ComputerAgentRuntime({
    recorder: capturingRecorder,
    nodes,
    workflowRepository: { getVersion: async () => version },
    clock: () => clock.now(),
    epoch: EPOCH,
    policy: { ...basePolicy, ...options.policy },
    replayRegistry: new InMemoryReplayRegistry(),
  });
  return {
    runtime,
    recorderDouble,
    decider: createFlowDecider().decider,
    clock,
    runId,
    versionId: VERSION_ID,
    workflowId: WORKFLOW_ID,
    semanticDigest,
    host,
    attached,
  };
}

const WORKFLOW_INPUTS = { reportPath: 'reports/summary.md', ackPath: 'reports/ack.md' } as const;

/** The attached predecessor attestation (narrowed; throws on fixture absence). */
function predecessorAttestationOf(harness: AdmissionHarness): ExecutionAttestation {
  const attestation = harness.attached[0];
  if (attestation === undefined) {
    throw new Error('fixture: the predecessor attestation was not attached');
  }
  return attestation;
}

// ============================================================================
// §2 The driver-side canonical verification (the fact-producing seam)
// ============================================================================

/**
 * Verify one runtime-produced attestation through the CANONICAL V2-014
 * verifier with a DRIVER-side policy (fresh replay registry — the
 * independent-verifier discipline: the runtime's own registry consumption
 * never leaks into the driver's verification).
 */
function verifyPredecessor(
  harness: AdmissionHarness,
  attestation: ExecutionAttestation,
  options: { nowOffsetMs?: number; requiredAssurance?: 'software_signed' | 'hardware_backed'; replayRegistry?: InMemoryReplayRegistry } = {},
): AttestationVerification {
  const replayRegistry = options.replayRegistry ?? new InMemoryReplayRegistry();
  const now = options.nowOffsetMs !== undefined ? addMs(harness.clock.now(), options.nowOffsetMs) : harness.clock.now();
  return verifyAttestation(attestation, {
    bindings: {
      workflowId: harness.workflowId,
      workflowVersionId: harness.versionId,
      workflowVersionSemanticDigest: harness.semanticDigest,
      runId: harness.runId,
      attemptId: 1,
      stepId: PREDECESSOR_STEP_ID,
    },
    freshness: {
      now,
      currentEpoch: EPOCH,
      replayRegistry,
      maxAgeMs: 300_000,
    },
    attesterKeyIds: [ATTESTER_KEY.keyId],
    requiredAssurance: options.requiredAssurance ?? 'software_signed',
  });
}

/** Build the typed composition precondition from a canonical verified fact. */
function preconditionOf(
  harness: AdmissionHarness,
  fact: VerifiedExecutionFact,
  overrides: Partial<DependentStepPrecondition> = {},
): DependentStepPrecondition {
  return {
    dependentStepId: DEPENDENT_STEP_ID,
    predecessorAttestationId: fact.attestationId,
    verifiedPredecessor: fact,
    causalParentDigests: [fact.executionDigest.digest],
    runId: harness.runId,
    workflowVersionId: harness.versionId,
    workflowVersionSemanticDigest: harness.semanticDigest,
    ...overrides,
  };
}

/** Drive 1: executeRun to the human pause point (collect attested + attached). */
async function driveToPause(harness: AdmissionHarness) {
  return harness.runtime.executeRun(PRINCIPAL, {
    runId: harness.runId,
    hosts: [harness.host],
    decider: harness.decider,
    workflowInputs: { ...WORKFLOW_INPUTS },
  });
}

async function resumeWith(
  harness: AdmissionHarness,
  preconditions: readonly DependentStepPrecondition[] | undefined,
) {
  return harness.runtime.resumeAfterHuman(PRINCIPAL, {
    runId: harness.runId,
    hosts: [harness.host],
    humanOutcome: 'approved',
    humanUserId: 'user_v2016_human',
    decider: harness.decider,
    workflowInputs: { ...WORKFLOW_INPUTS },
    ...(preconditions !== undefined ? { preconditions } : {}),
  });
}

// ============================================================================
// §3 The battery
// ============================================================================

describe('V2-016 dependent-step composition admission (fail-closed, typed, zero-side-effect negatives)', () => {
  it('1. consumes a valid predecessor precondition before the first dependent side effect and records the declared causal parent', async () => {
    const harness = createAdmissionHarness({});
    const paused = await driveToPause(harness);
    expect(paused.state).toBe('paused');
    expect(paused.pausedAtStepId).toBe(HUMAN_STEP_ID);
    expect(harness.attached.length).toBe(1);
    expect(predecessorAttestationOf(harness).statement.stepId).toBe(PREDECESSOR_STEP_ID);

    // The DRIVER-side canonical verification → the V2-014-derived fact:
    const verification = verifyPredecessor(harness, predecessorAttestationOf(harness));
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    const fact = verification.fact;
    expect(fact.attests).toBe('statement_authenticity');
    expect(fact.neverAsserts).toContain('authorization');

    const completed = await resumeWith(harness, [preconditionOf(harness, fact)]);
    expect(completed.state).toBe('completed');
    const dependent = completed.steps.find((step) => step.stepId === DEPENDENT_STEP_ID);
    expect(dependent?.outcome).toBe('completed');
    expect(dependent?.actions).toBeGreaterThan(0);
    expect(dependent?.attestationsAttached).toBe(1);

    // The dependent runtime-produced attestation carries EXACTLY the
    // declared causal parent (the predecessor's execution digest):
    const dependentAttestation = harness.attached.find(
      (attestation) => attestation.statement.stepId === DEPENDENT_STEP_ID,
    );
    expect(dependentAttestation).toBeDefined();
    if (dependentAttestation === undefined) return;
    expect([...dependentAttestation.statement.causalParents]).toEqual([
      fact.executionDigest.digest,
    ]);
    // Exactly one write effect per host step (collect + acknowledge each
    // wrote once; the attested predecessor + the admitted dependent):
    const writes = harness.recorderDouble.invocationRequests.filter(
      (invocation) => invocation.capability === 'filesystem.write',
    );
    expect(writes.length).toBe(2);
  });

  it('2. a MISSING precondition fails closed before any host invocation (typed step failure, run failed)', async () => {
    const harness = createAdmissionHarness({});
    await driveToPause(harness);
    const writesBefore = harness.recorderDouble.invocationRequests.filter(
      (invocation) => invocation.capability === 'filesystem.write',
    ).length;
    const invocationsBefore = harness.recorderDouble.invocationRequests.length;

    const report = await resumeWith(harness, undefined);
    expect(report.state).toBe('failed');
    const dependent = report.steps.find((step) => step.stepId === DEPENDENT_STEP_ID);
    expect(dependent?.outcome).toBe('failed');
    expect(dependent?.failure?.code).toBe('AGENT_PRECONDITION_REJECTED');
    expect(dependent?.actions).toBe(0);
    expect(dependent?.observations).toBe(0);
    // ZERO host side effects: no new host invocation of ANY kind for the
    // dependent step (the admission gate fired before host routing):
    expect(harness.recorderDouble.invocationRequests.length).toBe(invocationsBefore);
    const writesAfter = harness.recorderDouble.invocationRequests.filter(
      (invocation) => invocation.capability === 'filesystem.write',
    ).length;
    expect(writesAfter).toBe(writesBefore);
    // the honest durable trace (step started -> failed, run failed) exists:
    const dependentCompletion = harness.recorderDouble.stepCompletions.find(
      (completion) => completion.stepId === DEPENDENT_STEP_ID,
    );
    expect(dependentCompletion?.outcome).toBe('failed');
  });

  it('3. a wrong-RUN binding is rejected at drive entry — typed throw, run untouched, zero commands', async () => {
    const harness = createAdmissionHarness({});
    await driveToPause(harness);
    const verification = verifyPredecessor(harness, predecessorAttestationOf(harness));
    if (!verification.ok) throw new Error('fixture verification unexpectedly failed');
    const commandsBefore = harness.recorderDouble.commands.length;

    const wrongRun = preconditionOf(harness, verification.fact, { runId: 'run_v2016_OTHER' });
    await expect(resumeWith(harness, [wrongRun])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });
    // the run stays PAUSED (the resume never happened — validation ran
    // BEFORE resumeRun), zero durable mutations of this drive:
    expect(harness.recorderDouble.state()).toBe('paused');
    expect(harness.recorderDouble.commands.length).toBe(commandsBefore);
  });

  it('4. a wrong-WorkflowVersion binding (id, then semantic digest) is rejected at drive entry', async () => {
    const harness = createAdmissionHarness({});
    await driveToPause(harness);
    const verification = verifyPredecessor(harness, predecessorAttestationOf(harness));
    if (!verification.ok) throw new Error('fixture verification unexpectedly failed');
    const commandsBefore = harness.recorderDouble.commands.length;

    const wrongVersion = preconditionOf(harness, verification.fact, { workflowVersionId: 'ver_v2016_OTHER' });
    await expect(resumeWith(harness, [wrongVersion])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });
    expect(harness.recorderDouble.commands.length).toBe(commandsBefore);
    expect(harness.recorderDouble.state()).toBe('paused');

    const wrongDigest = preconditionOf(harness, verification.fact, {
      workflowVersionSemanticDigest: 'ab'.repeat(32),
    });
    await expect(resumeWith(harness, [wrongDigest])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });
    expect(harness.recorderDouble.commands.length).toBe(commandsBefore);
    expect(harness.recorderDouble.state()).toBe('paused');
  });

  it('5. wrong predecessor/step relationships are rejected at drive entry (identity mismatch, self-predecessor, non-dependent target)', async () => {
    const harness = createAdmissionHarness({});
    await driveToPause(harness);
    const verification = verifyPredecessor(harness, predecessorAttestationOf(harness));
    if (!verification.ok) throw new Error('fixture verification unexpectedly failed');
    const fact = verification.fact;
    const commandsBefore = harness.recorderDouble.commands.length;

    // (a) the relied-upon attestation identity is not the fact's own:
    const identityMismatch = preconditionOf(harness, fact, { predecessorAttestationId: 'wfea_wrong_identity' });
    await expect(resumeWith(harness, [identityMismatch])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });

    // (b) a step cannot be its own predecessor (the fact attests the
    // dependent step itself — wrong relationship binding):
    const selfPredecessor: VerifiedExecutionFact = {
      ...fact,
      statement: { ...fact.statement, stepId: DEPENDENT_STEP_ID },
    };
    const selfParent = preconditionOf(harness, selfPredecessor);
    await expect(resumeWith(harness, [selfParent])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });

    // (c) a precondition may only target a step the runtime's
    // dependent-admission policy declares (configuration mismatch):
    const wrongTarget = preconditionOf(harness, fact, { dependentStepId: PREDECESSOR_STEP_ID });
    await expect(resumeWith(harness, [wrongTarget])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });

    expect(harness.recorderDouble.commands.length).toBe(commandsBefore);
    expect(harness.recorderDouble.state()).toBe('paused');
  });

  it('6. unverified / stale / replayed predecessors fail closed THROUGH the V2-014-derived verification results (no fact → no admission)', async () => {
    const harness = createAdmissionHarness({});
    await driveToPause(harness);
    const predecessor = predecessorAttestationOf(harness);

    // (a) STALE — the verifier clock runs past the attestation's validity:
    const stale = verifyPredecessor(harness, predecessor, { nowOffsetMs: 400_000 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.failure.code).toBe('ATTESTATION_EXPIRED');
    }
    // (b) REPLAYED — the canonical verifier's single-use nonce registry
    // rejects the re-presented attestation (the driver verifies twice with
    // the SAME registry):
    const registry = new InMemoryReplayRegistry();
    const first = verifyPredecessor(harness, predecessor, { replayRegistry: registry });
    expect(first.ok).toBe(true);
    const replayed = verifyPredecessor(harness, predecessor, { replayRegistry: registry });
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.failure.code).toBe('ATTESTATION_REPLAYED');
    }
    // (c) INSUFFICIENT ASSURANCE — the canonical verifier's assurance floor:
    const insufficient = verifyPredecessor(harness, predecessor, { requiredAssurance: 'hardware_backed' });
    expect(insufficient.ok).toBe(false);
    if (!insufficient.ok) {
      expect(insufficient.failure.code).toBe('ATTESTATION_ASSURANCE_INSUFFICIENT');
    }

    // Every rejected verification produces NO VerifiedExecutionFact, so the
    // dependent step admits nothing and fails closed with ZERO side
    // effects (the runtime consumes verification RESULTS — the absence of
    // the result IS the closed gate):
    const invocationsBefore = harness.recorderDouble.invocationRequests.length;
    const report = await resumeWith(harness, undefined);
    expect(report.state).toBe('failed');
    const dependent = report.steps.find((step) => step.stepId === DEPENDENT_STEP_ID);
    expect(dependent?.failure?.code).toBe('AGENT_PRECONDITION_REJECTED');
    expect(dependent?.actions).toBe(0);
    expect(harness.recorderDouble.invocationRequests.length).toBe(invocationsBefore);
  });

  it('7. invented, uncovered, dropped, or empty causal-parent declarations are rejected (never invented, never silently dropped)', async () => {
    const harness = createAdmissionHarness({});
    await driveToPause(harness);
    const verification = verifyPredecessor(harness, predecessorAttestationOf(harness));
    if (!verification.ok) throw new Error('fixture verification unexpectedly failed');
    const fact = verification.fact;
    const commandsBefore = harness.recorderDouble.commands.length;

    // (a) an INVENTED parent digest (not any supplied fact's execution digest):
    const invented = preconditionOf(harness, fact, {
      causalParentDigests: [fact.executionDigest.digest, 'ff'.repeat(32)],
    });
    await expect(resumeWith(harness, [invented])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });

    // (b) a DROPPED relied-upon predecessor (the fact is supplied but its
    // digest is not declared — only an unrelated digest is):
    const dropped = preconditionOf(harness, fact, { causalParentDigests: ['ee'.repeat(32)] });
    await expect(resumeWith(harness, [dropped])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });

    // (c) an EMPTY declaration (a dependent execution declares one or more):
    const empty = preconditionOf(harness, fact, { causalParentDigests: [] });
    await expect(resumeWith(harness, [empty])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });

    // (d) the fact's own statement bound to a DIFFERENT run (predecessor
    // cross-run substitution):
    const foreignFact: VerifiedExecutionFact = {
      ...fact,
      statement: { ...fact.statement, runId: 'run_v2016_FOREIGN' },
    };
    const foreign = preconditionOf(harness, foreignFact);
    await expect(resumeWith(harness, [foreign])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });

    // (e) the fact's statement bound to a DIFFERENT WorkflowVersion:
    const foreignVersionFact: VerifiedExecutionFact = {
      ...fact,
      statement: { ...fact.statement, workflowVersionId: 'ver_v2016_FOREIGN' },
    };
    const foreignVersion = preconditionOf(harness, foreignVersionFact);
    await expect(resumeWith(harness, [foreignVersion])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });

    expect(harness.recorderDouble.commands.length).toBe(commandsBefore);
    expect(harness.recorderDouble.state()).toBe('paused');
  });

  it('8. admission is NOT authorization: an admitted dependent step without the safe-action grant fails AGENT_CAPABILITY_UNAUTHORIZED', async () => {
    // Step-scoped grants cover ONLY the predecessor step: the dependent
    // step is ADMITTED (valid precondition) but its sensitive capability
    // invocation is NOT authorized — the two dimensions stay separate.
    const harness = createAdmissionHarness({
      policy: {
        safeAction: {
          grants: [
            { capability: 'filesystem.read', scope: 'step', stepId: PREDECESSOR_STEP_ID },
            { capability: 'filesystem.write', scope: 'step', stepId: PREDECESSOR_STEP_ID },
          ],
        },
      },
    });
    await driveToPause(harness);
    const verification = verifyPredecessor(harness, predecessorAttestationOf(harness));
    if (!verification.ok) throw new Error('fixture verification unexpectedly failed');

    const report = await resumeWith(harness, [preconditionOf(harness, verification.fact)]);
    expect(report.state).toBe('failed');
    const dependent = report.steps.find((step) => step.stepId === DEPENDENT_STEP_ID);
    expect(dependent?.failure?.code).toBe('AGENT_CAPABILITY_UNAUTHORIZED');
    // zero side effects: no filesystem.write was ever dispatched for the dependent step
    const writes = harness.recorderDouble.invocationRequests.filter(
      (invocation) => invocation.capability === 'filesystem.write',
    );
    expect(writes.length).toBe(1); // only the predecessor's write
  });

  it('11. duplicate delivery / re-drive of the admitted dependent action remains exactly-once', async () => {
    const harness = createAdmissionHarness({});
    await driveToPause(harness);
    const verification = verifyPredecessor(harness, predecessorAttestationOf(harness));
    if (!verification.ok) throw new Error('fixture verification unexpectedly failed');
    const precondition = preconditionOf(harness, verification.fact);

    // (a) duplicate precondition ENTRIES converge (the same fact delivered
    // twice: one admission set, one causal parent, one write):
    const report = await resumeWith(harness, [precondition, { ...precondition }]);
    expect(report.state).toBe('completed');
    const writes = harness.recorderDouble.invocationRequests.filter(
      (invocation) => invocation.capability === 'filesystem.write',
    );
    expect(writes.length).toBe(2); // exactly one per step — no third write
    const dependentAttestation = harness.attached.find(
      (attestation) => attestation.statement.stepId === DEPENDENT_STEP_ID,
    );
    expect(dependentAttestation).toBeDefined();
    if (dependentAttestation === undefined) return;
    expect([...dependentAttestation.statement.causalParents]).toEqual([
      verification.fact.executionDigest.digest,
    ]);

    // (b) re-drive of the COMPLETED run is typed-rejected (terminal), with
    // zero additional side effects — the existing V2-005/V2-008
    // idempotency/terminal discipline:
    await expect(resumeWith(harness, [precondition])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_RUN_NOT_PAUSED',
    });
    await expect(
      harness.runtime.executeRun(PRINCIPAL, {
        runId: harness.runId,
        hosts: [harness.host],
        decider: harness.decider,
        workflowInputs: { ...WORKFLOW_INPUTS },
        preconditions: [precondition],
      }),
    ).rejects.toMatchObject({ code: 'COMPUTER_AGENT_RUN_TERMINAL' });
    const writesAfter = harness.recorderDouble.invocationRequests.filter(
      (invocation) => invocation.capability === 'filesystem.write',
    );
    expect(writesAfter.length).toBe(2);
  });

  it('12. a precondition cannot be supplied for one Run and consumed by another (driver B driving run B with run A\'s fact)', async () => {
    // Run A completes its predecessor + pause; the fact is minted for A.
    const harnessA = createAdmissionHarness({});
    await driveToPause(harnessA);
    const verification = verifyPredecessor(harnessA, predecessorAttestationOf(harnessA));
    if (!verification.ok) throw new Error('fixture verification unexpectedly failed');
    const factForA = verification.fact;

    // Run B (a DIFFERENT run id, same workflow/version) pauses the same way:
    const harnessB = createAdmissionHarness({ runId: 'run_v2016_B' });
    await driveToPause(harnessB);

    // Supplying run A's precondition (declared binding AND fact statement)
    // to run B's resume drive is a typed entry rejection — zero commands:
    const commandsBefore = harnessB.recorderDouble.commands.length;
    const stolenBinding = preconditionOf(harnessA, factForA, { runId: 'run_v2016_B' });
    await expect(resumeWith(harnessB, [stolenBinding])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });
    const stolenFact = preconditionOf(harnessA, factForA);
    await expect(resumeWith(harnessB, [stolenFact])).rejects.toMatchObject({
      code: 'COMPUTER_AGENT_PRECONDITION_REJECTED',
    });
    expect(harnessB.recorderDouble.commands.length).toBe(commandsBefore);
    expect(harnessB.recorderDouble.state()).toBe('paused');
  });
});

// ============================================================================
// §4 Zero-parent compatibility (required regression 10 + the entry surface)
// ============================================================================

describe('V2-016 non-dependent zero-parent behavior + drive-entry validation', () => {
  it('10. without dependentStepIds the same flow runs unchanged with zero-parent attestations (pre-V2-016 behavior)', async () => {
    const harness = createAdmissionHarness({ policy: { dependentStepIds: undefined } });
    const paused = await driveToPause(harness);
    expect(paused.state).toBe('paused');
    // The resume needs NO precondition (nothing is dependent) and the
    // produced attestations remain zero-parent:
    const report = await resumeWith(harness, undefined);
    expect(report.state).toBe('completed');
    for (const attestation of harness.attached) {
      expect([...attestation.statement.causalParents]).toEqual([]);
    }
  });

  it('a supplied precondition on a fresh executeRun drive is validated BEFORE startRun (zero durable mutations)', async () => {
    const harness = createAdmissionHarness({});
    // A fresh 'requested' run; an invalid precondition (a typed fact shape
    // whose statement binds a DIFFERENT run) is rejected at entry before
    // ANY recorder command — not even startRun executes:
    const fabricated: DependentStepPrecondition = {
      dependentStepId: DEPENDENT_STEP_ID,
      predecessorAttestationId: 'wfea_fabricated',
      verifiedPredecessor: {
        attestationId: 'wfea_fabricated',
        executionDigest: { algorithm: 'sha-256', domain: 'workflowos/execution-statement/v1', digest: 'cd'.repeat(32) },
        statement: {
          objectType: 'workflowos/execution-statement/v1',
          statementSchemaVersion: 1,
          workflowId: WORKFLOW_ID,
          workflowVersionId: VERSION_ID,
          workflowVersionSemanticDigest: harness.semanticDigest,
          deploymentId: 'none',
          runId: 'run_v2016_OTHER',
          attemptId: 1,
          stepId: PREDECESSOR_STEP_ID,
          nodeId: 'node_unit_v2016',
          executionClass: 'agentic_computer_use',
          action: 'fabricated for the entry-order negative',
          inputCommitments: [],
          outputCommitments: [],
          observationCommitments: [],
          evidenceReferences: [],
          causalParents: [],
          nonce: 'nonce-fabricated',
          epoch: EPOCH,
          outcome: 'succeeded',
          executedAt: harness.clock.now(),
        },
        attesterKeyId: ATTESTER_KEY.keyId,
        assurance: 'software_signed',
        verifiedAt: harness.clock.now(),
        attests: 'statement_authenticity',
        neverAsserts: ['authorization', 'capability_possession', 'correct_behavior', 'observed_effect', 'sufficient_evidence'],
        nonAuthorityNote: 'fabricated typed fact for the drive-entry ordering negative',
      },
      causalParentDigests: ['cd'.repeat(32)],
      runId: 'run_v2016_OTHER',
      workflowVersionId: VERSION_ID,
      workflowVersionSemanticDigest: harness.semanticDigest,
    };
    const commandsBefore = harness.recorderDouble.commands.length;
    await expect(
      harness.runtime.executeRun(PRINCIPAL, {
        runId: harness.runId,
        hosts: [harness.host],
        decider: harness.decider,
        workflowInputs: { ...WORKFLOW_INPUTS },
        preconditions: [fabricated],
      }),
    ).rejects.toMatchObject({ code: 'COMPUTER_AGENT_PRECONDITION_REJECTED' });
    // ZERO durable mutations: the run is still 'requested', nothing ran:
    expect(harness.recorderDouble.commands.length).toBe(commandsBefore);
    expect(harness.recorderDouble.state()).toBe('requested');
  });
});
