/**
 * V2-016 — standalone dogfooding RUN (real process, real product paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/computer-agent/run-v2-016-dogfooding.ts
 *
 * Executes the frozen V2-016 dogfooding clause (narrowly focused on the
 * newly added runtime contract, exactly as the work order requires):
 *
 *   "Node A produces an attestation; the canonical V2-014 verifier
 *    independently verifies it; the resulting V2-014-derived verified fact
 *    is passed into Node B's dependent execution boundary; Node B consumes
 *    that precondition before its first side effect; the dependent Node-B
 *    attestation records Node A's execution digest in causalParents;
 *    negative precondition cases produce typed rejection with zero side
 *    effects; replay/duplicate delivery still converges."
 *
 * THE REAL CROSS-DEVICE SHAPE (two real hosts, one run, one WorkflowVersion):
 *   - Node A: a WebBrowserHostAdapter over the scripted browser environment
 *     with REAL Ed25519 key material (the attested predecessor step
 *     `collect` — a REAL grounded browser click);
 *   - Node B: a DesktopHostAdapter over RealFilesystemDesktopEnvironment —
 *     REAL node:fs I/O rooted at a real sandbox directory (the DEPENDENT
 *     step `acknowledge` whose admission requires the V2-014-derived
 *     verified predecessor fact; its side effect is a REAL file write with
 *     REAL bytes asserted);
 *   - a human approval pause point between them (the exact surface the
 *     IG-006 blocking finding named: the resume drive).
 *
 * Real stack throughout: real PGlite + all migrations, real V2-002
 * repository (authoring + version pinning), real V2-005 run service (all
 * durable state/evidence — the dependent step's typed rejection and the
 * still-paused negative state are read back through the REAL run history),
 * real V2-004 registration protocol (both hosts are genuinely registered
 * nodes; capability sets + placement steer the browser step to Node A and
 * the device-local step to Node B through the merged matcher), real V2-003
 * parser + V2-007 compiler, the canonical V2-014 verifier producing the
 * VerifiedExecutionFact, and the merged V2-008 runtime carrying the
 * V2-016 dependent-admission contract.
 *
 * NEGATIVES (each on its own fresh run + fresh sandbox):
 *   - MISSING precondition → the run FAILS AGENT_PRECONDITION_REJECTED
 *     with the Node-B file NOT written (zero side effects, actions 0);
 *   - WRONG-RUN binding (a fact minted for run A re-targeted at run C) →
 *     typed COMPUTER_AGENT_PRECONDITION_REJECTED at drive entry with the
 *     run still PAUSED (read back through the real run service) and the
 *     file NOT written;
 *   - STALE / REPLAYED / INSUFFICIENT-ASSURANCE predecessor → the CANONICAL
 *     V2-014 verifier's typed rejections produce NO fact → admission has
 *     nothing to consume (the runtime consumes verification RESULTS).
 *
 * CONVERGENCE: duplicate re-drive of the completed run is typed-rejected
 * (terminal) with the Node-B file byte-identical (exactly one write); a
 * duplicate precondition entry in one drive converges to one admission.
 *
 * DETERMINISM: the whole experiment runs TWICE on fresh stacks; the
 * normalized transcript (every check line — repository ids and key
 * material excluded by construction, everything else derived from fixed
 * seeds, fixed inputs, and stepping injected clocks) must be
 * byte-identical. The only wall-clock lines are run-instance bookkeeping.
 * Exits non-zero when any experiment check fails (fail-closed runner).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComputerAgentRuntime,
  RealFilesystemDesktopEnvironment,
  addMs,
  type AgentDecider,
  type ComputerHostAdapter,
  type DependentStepPrecondition,
} from '../../../src/computer-agent/index.js';
import {
  InMemoryReplayRegistry,
  generateAttesterKeyPair,
  serializeAttestation,
  parseAttestation,
  verifyAttestation,
  type AttesterKeyPair,
  type ExecutionAttestation,
  type VerifiedExecutionFact,
} from '../../../src/execution-attestation/index.js';
import { createWorkflowIrBuilder, type WorkflowIrDocument, type WorkflowNode } from '../../../src/workflow-ir/index.js';
import {
  buildComputerAgentTestStack,
  CapturingHost,
  freshBrowserEnvironment,
  type ComputerAgentTestStack,
} from './computer-agent-test-support.js';

const WORK_ORDER_ID = 'V2-016';

// ============================================================================
// §0 Fixed protocol constants (deterministic; key material is per-run)
// ============================================================================

const DEPENDENT_STEP_ID = 'acknowledge';
const PREDECESSOR_STEP_ID = 'collect';
const HUMAN_STEP_ID = 'approve';
const ACK_PATH = 'reports/ack.md';
const ACK_CONTENT = 'ACK: the cross-device predecessor was admitted and consumed before this write';
const FORM_URL = 'https://integration.example/triage';
const HUMAN_USER_ID = 'v2-016-dogfooding-human';
const HOST_SEED_A = 'v2-016-dogfooding-web-host';
const HOST_SEED_B = 'v2-016-dogfooding-desktop-host';
const VALIDITY_MS = 600_000;

// ============================================================================
// §1 The per-experiment check/record collector (the normalized transcript)
// ============================================================================

interface Collector {
  check(ok: boolean, label: string, detail?: string): boolean;
  record(line: string): void;
  readonly transcript: readonly string[];
  readonly failures: number;
  readonly checks: number;
}

function createCollector(): Collector {
  const lines: string[] = [];
  let checks = 0;
  let failures = 0;
  return {
    check(ok, label, detail = ''): boolean {
      checks += 1;
      if (!ok) {
        failures += 1;
      }
      const mark = ok ? 'PASS' : 'FAIL';
      const line = `  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`;
      lines.push(line);
      // eslint-disable-next-line no-console
      console.log(line);
      return ok;
    },
    record(line: string): void {
      lines.push(line);
      // eslint-disable-next-line no-console
      console.log(line);
    },
    get transcript(): readonly string[] {
      return [...lines];
    },
    get failures(): number {
      return failures;
    },
    get checks(): number {
      return checks;
    },
  };
}

// ============================================================================
// §2 The workflow (authored through the real V2-003 builder; the browser
//     step is cloud-allowed (Node A), the dependent filesystem step is
//     device-local (Node B) — capability sets + placement steer the two
//     real hosts through the merged V2-004 matcher)
// ============================================================================

function authorCrossDeviceWorkflow(): WorkflowIrDocument {
  const collect: WorkflowNode = {
    id: PREDECESSOR_STEP_ID,
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Submit the triage form through the browser on Node A' },
    capabilityRequirements: ['browser.observe', 'browser.click'],
    placement: 'cloud_allowed',
    inputs: [{ name: 'formUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'formUrl' } }],
    outputs: [{ name: 'submitted', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const approve: WorkflowNode = {
    id: HUMAN_STEP_ID,
    executionClass: 'human',
    spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve the dependent device-local acknowledgment step.' } },
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
    spec: { class: 'agentic_computer_use', task: 'Write the acknowledgment file on Node B (the dependent device-local step)' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: 'device_local',
    inputs: [{ name: 'ackPath', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ackPath' } }],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart(PREDECESSOR_STEP_ID)
    .addWorkflowInput({ name: 'formUrl', type: { kind: 'string' } })
    .addWorkflowInput({ name: 'ackPath', type: { kind: 'string' } })
    .addNode(collect)
    .addNode(approve)
    .addNode(acknowledge)
    .addEdge({ from: PREDECESSOR_STEP_ID, to: HUMAN_STEP_ID, on: 'success' })
    .addEdge({ from: HUMAN_STEP_ID, to: DEPENDENT_STEP_ID, on: { outcome: 'approved' } })
    .addEdge({ from: HUMAN_STEP_ID, to: DEPENDENT_STEP_ID, on: { outcome: 'rejected' } })
    .build();
}

/** The step-aware decider: the browser submit on Node A, the ack write on Node B. */
function createCrossDeviceDecider(): AgentDecider {
  return (ctx) => {
    if (ctx.stepId === PREDECESSOR_STEP_ID) {
      if (ctx.observation === null) {
        return { decision: 'observe', capability: 'browser.observe', subject: FORM_URL };
      }
      const clicked = ctx.history.some((record) => record.capability === 'browser.click' && record.ok);
      if (!clicked) {
        const target = ctx.observation.elements.find((element) => element.elementId === 'btn-submit');
        return {
          decision: 'act',
          capability: 'browser.click',
          grounding: target
            ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
            : null,
          parameters: {},
        };
      }
      return {
        decision: 'complete',
        verify: { capability: 'browser.observe', subject: FORM_URL, expect: { elementId: 'btn-submit', state: 'clicked' } },
        outputs: { submitted: true },
      };
    }
    const ackPath = String(ctx.inputs.ackPath ?? ACK_PATH);
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'filesystem.read', subject: ackPath };
    }
    const wrote = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
    if (!wrote) {
      const target = ctx.observation.elements.find((element) => element.elementId === ackPath);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: target
          ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
          : null,
        parameters: { path: ackPath, content: ACK_CONTENT },
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'filesystem.read', subject: ackPath, expect: { elementId: ackPath, state: ACK_CONTENT } },
      outputs: { written: true },
    };
  };
}

// ============================================================================
// §3 One composed run (fresh sandbox, fresh node directory, fresh keys)
// ============================================================================

interface ComposedRun {
  readonly stack: ComputerAgentTestStack;
  readonly runtime: ComputerAgentRuntime;
  readonly runId: string;
  readonly sandbox: string;
  readonly capturingA: CapturingHost;
  readonly capturingB: CapturingHost;
  readonly keyA: AttesterKeyPair;
  readonly keyB: AttesterKeyPair;
  readonly clock: () => string;
  readonly semanticDigest: string;
  readonly versionId: string;
  readonly workflowId: string;
  readonly decider: AgentDecider;
}

async function composeRun(
  stack: ComputerAgentTestStack,
  label: string,
): Promise<ComposedRun> {
  const sandbox = await mkdtemp(join(tmpdir(), `v2-016-${label}-`));
  await mkdir(join(sandbox, 'reports'), { recursive: true });
  const nodes = stack.freshNodeDirectory();
  const keyA = generateAttesterKeyPair();
  const keyB = generateAttesterKeyPair();

  // Node A — the REAL web host (scripted browser environment, real key):
  const webAttached = stack.attachWebHost({
    nodes,
    keySeed: HOST_SEED_A,
    environment: freshBrowserEnvironment(),
    attesterKey: keyA,
  });
  const capturingA = new CapturingHost(webAttached.host);

  // Node B — the REAL desktop host (REAL node:fs, real key):
  const realEnvironment = new RealFilesystemDesktopEnvironment({
    root: sandbox,
    screenProvider: () => [],
    onOpenApplication: () => undefined,
    onInteract: () => undefined,
  });
  const desktopAttached = stack.attachDesktopHost({
    nodes,
    keySeed: HOST_SEED_B,
    environment: realEnvironment,
    attesterKey: keyB,
  });
  const capturingB = new CapturingHost(desktopAttached.host);

  const clock = stack.freshAgentClock();
  const runtime = stack.createRuntime({
    nodes,
    clock,
    replayRegistry: new InMemoryReplayRegistry(),
    policy: {
      maxActionsPerStep: 12,
      maxObservationAgeMs: 120_000,
      maxRecoveryCyclesPerStep: 4,
      safeAction: {
        grants: [
          { capability: 'browser.observe', scope: 'run' },
          { capability: 'browser.click', scope: 'run' },
          { capability: 'filesystem.read', scope: 'run' },
          { capability: 'filesystem.write', scope: 'run' },
        ],
      },
      attestation: {
        required: true,
        trustedAttesterKeyIds: [keyA.keyId, keyB.keyId],
        requiredAssurance: 'software_signed',
        validityMs: VALIDITY_MS,
      },
      // THE V2-016 RUNTIME CONTRACT UNDER DOGFOOD:
      dependentStepIds: [DEPENDENT_STEP_ID],
    },
  });

  const document = authorCrossDeviceWorkflow();
  const authored = await stack.authorWorkflow({ document, slug: `cross-device-${label}` });
  const run = await stack.requestRun({
    workflowId: authored.workflowId,
    versionId: authored.versionId,
    triggerId: `v2-016-${label}-manual-1`,
  });

  return {
    stack,
    runtime,
    runId: run.id,
    sandbox,
    capturingA,
    capturingB,
    keyA,
    keyB,
    clock,
    semanticDigest: authored.semanticDigest,
    versionId: authored.versionId,
    workflowId: authored.workflowId,
    decider: createCrossDeviceDecider(),
  };
}

function hostsOf(composed: ComposedRun): readonly ComputerHostAdapter[] {
  return [composed.capturingA, composed.capturingB];
}

async function driveToPause(composed: ComposedRun) {
  return composed.runtime.executeRun(composed.stack.principal, {
    runId: composed.runId,
    hosts: hostsOf(composed),
    decider: composed.decider,
    workflowInputs: { formUrl: FORM_URL, ackPath: ACK_PATH },
  });
}

async function resumeWith(
  composed: ComposedRun,
  preconditions: readonly DependentStepPrecondition[] | undefined,
) {
  return composed.runtime.resumeAfterHuman(composed.stack.principal, {
    runId: composed.runId,
    hosts: hostsOf(composed),
    humanOutcome: 'approved',
    humanUserId: HUMAN_USER_ID,
    decider: composed.decider,
    workflowInputs: { formUrl: FORM_URL, ackPath: ACK_PATH },
    ...(preconditions !== undefined ? { preconditions } : {}),
  });
}

// ============================================================================
// §4 The driver-side canonical verification (the fact-producing seam)
// ============================================================================

/**
 * Verify one runtime-produced attestation through the CANONICAL V2-014
 * verifier with the DRIVER-side policy: the statement's OWN exact
 * workflow/version identities (read from the envelope — never re-derived),
 * the composed run + step bindings, a FRESH replay registry (the
 * independent-verifier discipline), trusted attester = Node A's key, and
 * `nowOffsetMs` simulating the verifier context's clock running later.
 */
function verifyPredecessor(
  composed: ComposedRun,
  attestation: ExecutionAttestation,
  options: { nowOffsetMs?: number; replayRegistry?: InMemoryReplayRegistry; requiredAssurance?: 'software_signed' | 'hardware_backed' } = {},
): ReturnType<typeof verifyAttestation> {
  const now = options.nowOffsetMs !== undefined ? addMs(composed.clock(), options.nowOffsetMs) : composed.clock();
  return verifyAttestation(attestation, {
    bindings: {
      workflowId: composed.workflowId,
      workflowVersionId: composed.versionId,
      workflowVersionSemanticDigest: composed.semanticDigest,
      runId: composed.runId,
      attemptId: 1,
      stepId: PREDECESSOR_STEP_ID,
    },
    freshness: {
      now,
      currentEpoch: 7,
      replayRegistry: options.replayRegistry ?? new InMemoryReplayRegistry(),
      maxAgeMs: VALIDITY_MS,
    },
    attesterKeyIds: [composed.keyA.keyId],
    requiredAssurance: options.requiredAssurance ?? 'software_signed',
  });
}

// ============================================================================
// §5 The experiment (all machine-checkable facts; the transcript excludes
//     repository ids, key material, sandbox paths, and wall time by
//     construction — node ids derive from fixed key seeds, digests from
//     fixed content + stepping clocks, file bytes from fixed constants)
// ============================================================================

async function runExperiment(instance: number): Promise<Collector> {
  const collector = createCollector();
  // the instance banner is run-instance bookkeeping (console-only — never
  // part of the compared normalized transcript):
  // eslint-disable-next-line no-console
  console.log(`--- V2-016 dogfooding experiment instance ${instance} ---`);
  const stack = await buildComputerAgentTestStack();
  try {
    // ============ RUN A: the canonical cross-device happy path ============
    const runA = await composeRun(stack, 'a');
    collector.record(`run A composed (fresh sandbox, fresh node directory, two real attesting hosts; ids normalized)`);

    // ---- drive 1: Node A executes the attested predecessor; pause at human:
    const paused = await driveToPause(runA);
    if (!collector.check(paused.state === 'paused' && paused.pausedAtStepId === HUMAN_STEP_ID, '1.drive-1: Node A executed the attested predecessor and the run paused at the human step (Node B untouched)', `state=${paused.state} pausedAt=${String(paused.pausedAtStepId)}`)) {
      return collector;
    }
    const ackBefore = await readFile(join(runA.sandbox, ACK_PATH)).then(
      () => 'present',
      () => 'absent',
    );
    collector.check(ackBefore === 'absent', '1.side-effects: Node B\'s ack file is ABSENT before the dependent drive', `ack=${ackBefore}`);

    // ---- Node A's attestation: captured, transferred, canonically verified:
    const capturedA = runA.capturingA.attestations[0];
    if (capturedA === undefined || capturedA.statement.stepId !== PREDECESSOR_STEP_ID) {
      collector.check(false, '2.node-a: the attested predecessor produced exactly one attestation on Node A', `count=${runA.capturingA.attestations.length}`);
      return collector;
    }
    const attestationA: ExecutionAttestation = capturedA;
    const envelopeBytes = serializeAttestation(attestationA);
    const transferred = parseAttestation(envelopeBytes);
    if (!collector.check(transferred.ok && transferred.attestation.attestationId === attestationA.attestationId, '3.envelope: the attestation transferred as the V2-014 canonical envelope bytes (serialize → parse, same identity)', `${envelopeBytes.length} chars`)) {
      return collector;
    }
    const verification = verifyPredecessor(runA, attestationA);
    if (!verification.ok) {
      collector.check(false, '4.independent-verification: the CANONICAL V2-014 verifier verified Node A\'s attestation (trusted key, fresh replay registry, freshness, exact bindings)', `failure=${verification.failure.code}`);
      return collector;
    }
    collector.check(true, '4.independent-verification: the CANONICAL V2-014 verifier verified Node A\'s attestation (trusted key, fresh replay registry, freshness, exact bindings)', `attests=${verification.fact.attests}`);
    const fact: VerifiedExecutionFact = verification.fact;
    collector.check(
      fact.neverAsserts.includes('authorization') && fact.attests === 'statement_authenticity',
      '4.fact-shape: the V2-014-derived fact attests statement authenticity ONLY (never authorization)',
    );

    // ---- the canonical verifier's TYPED negatives (no fact from failures):
    const stale = verifyPredecessor(runA, attestationA, { nowOffsetMs: VALIDITY_MS + 100_000 });
    collector.check(!stale.ok && stale.failure.code === 'ATTESTATION_EXPIRED', '4.negative-stale: an aged envelope is rejected TYPED by the canonical verifier (ATTESTATION_EXPIRED)', stale.ok ? 'unexpected-ok' : stale.failure.code);
    const replayRegistry = new InMemoryReplayRegistry();
    const firstLeg = verifyPredecessor(runA, attestationA, { replayRegistry });
    const replayedLeg = verifyPredecessor(runA, attestationA, { replayRegistry });
    collector.check(firstLeg.ok && !replayedLeg.ok && replayedLeg.failure.code === 'ATTESTATION_REPLAYED', '4.negative-replay: the re-presented envelope is a REPLAY (single-use nonce, ATTESTATION_REPLAYED)', replayedLeg.ok ? 'unexpected-ok' : replayedLeg.failure.code);
    const insufficient = verifyPredecessor(runA, attestationA, { requiredAssurance: 'hardware_backed' });
    collector.check(!insufficient.ok && insufficient.failure.code === 'ATTESTATION_ASSURANCE_INSUFFICIENT', '4.negative-assurance: an assurance floor above the envelope\'s level is a TYPED rejection (no fact)', insufficient.ok ? 'unexpected-ok' : insufficient.failure.code);

    // ---- the precondition (the fact + the declared causal parent):
    const precondition: DependentStepPrecondition = {
      dependentStepId: DEPENDENT_STEP_ID,
      predecessorAttestationId: fact.attestationId,
      verifiedPredecessor: fact,
      causalParentDigests: [fact.executionDigest.digest],
      runId: runA.runId,
      workflowVersionId: runA.versionId,
      workflowVersionSemanticDigest: runA.semanticDigest,
    };

    // ---- the resume drive: Node B consumes the precondition before its
    //      first side effect, writes the REAL file, and records the parent:
    const completed = await resumeWith(runA, [precondition]);
    collector.check(completed.state === 'completed', '5.admission: Node B\'s dependent step was ADMITTED (the V2-014-derived fact consumed before the first side effect) and the run completed', `state=${completed.state}${completed.failure ? ` failure=${completed.failure.code}` : ''}`);
    const ack = await readFile(join(runA.sandbox, ACK_PATH), 'utf8').then(
      (content) => content,
      () => null,
    );
    collector.check(ack === ACK_CONTENT, '5.side-effect: Node B\'s ack file is REALLY written (real node:fs bytes, exact content)', ack === null ? 'absent' : `${ack.length} chars`);
    const dependentAttestation = runA.capturingB.attestations.find(
      (candidate) => candidate.statement.stepId === DEPENDENT_STEP_ID,
    );
    if (dependentAttestation === undefined) {
      collector.check(false, '5.dependent-attestation: the dependent step produced its attestation on Node B');
      return collector;
    }
    collector.check(true, '5.dependent-attestation: the dependent step produced its attestation on Node B');
    const causalParents = [...dependentAttestation.statement.causalParents];
    collector.check(
      causalParents.length === 1 && causalParents[0] === fact.executionDigest.digest,
      '5.causal-parents: the dependent Node-B attestation records EXACTLY Node A\'s execution digest in causalParents',
      `parents=${String(causalParents.length)} (digest normalized out of the transcript)`,
    );
    const dependentReport = completed.steps.find((step) => step.stepId === DEPENDENT_STEP_ID);
    collector.check(dependentReport?.outcome === 'completed' && dependentReport?.attestationsAttached === 1, '5.gates: the dependent step passed every existing gate (attestation attached = independently verified + boundary-attached)', `outcome=${String(dependentReport?.outcome)} attached=${String(dependentReport?.attestationsAttached)}`);

    // ---- the durable record (read back through the REAL V2-005 service):
    const history = await stack.runService.getRunHistory(stack.principal, runA.runId);
    const dependentBinding = history.attestations.find((binding) => binding.stepId === DEPENDENT_STEP_ID);
    const predecessorBinding = history.attestations.find((binding) => binding.stepId === PREDECESSOR_STEP_ID);
    collector.check(
      dependentBinding !== undefined && predecessorBinding !== undefined &&
        JSON.stringify(dependentBinding.statement['causalParents']) === JSON.stringify([fact.executionDigest.digest]),
      '5.durable-record: the real run history carries the dependent attestation binding with the declared causal parent',
    );
    collector.check(
      dependentBinding !== undefined && predecessorBinding !== undefined &&
        dependentBinding.statement['runId'] === predecessorBinding.statement['runId'] &&
        dependentBinding.statement['workflowVersionId'] === predecessorBinding.statement['workflowVersionId'],
      '5.run-identity: both attestations bind the SAME run + WorkflowVersion (run/version identity across the two nodes)',
    );

    // ---- CONVERGENCE: duplicate re-drive of the completed run is typed:
    let duplicateRejected = false;
    try {
      await resumeWith(runA, [precondition]);
    } catch (error) {
      duplicateRejected = (error as { code?: unknown }).code === 'COMPUTER_AGENT_RUN_NOT_PAUSED';
    }
    collector.check(duplicateRejected, '6.duplicate-re-drive: the completed run rejects re-delivery TYPED (RUN_NOT_PAUSED)');
    const ackAfterDuplicate = await readFile(join(runA.sandbox, ACK_PATH), 'utf8');
    collector.check(ackAfterDuplicate === ACK_CONTENT, '6.exactly-once: the Node-B file is byte-identical after the duplicate re-drive (no second write)');

    // ============ RUN B: the MISSING precondition (fail closed) ============
    const runB = await composeRun(stack, 'b');
    await driveToPause(runB);
    const missing = await resumeWith(runB, undefined);
    const dependentMissing = missing.steps.find((step) => step.stepId === DEPENDENT_STEP_ID);
    collector.check(
      missing.state === 'failed' && dependentMissing?.failure?.code === 'AGENT_PRECONDITION_REJECTED' && dependentMissing?.actions === 0,
      '7.missing-precondition: the dependent step fails closed TYPED with ZERO side effects (run failed, actions 0)',
      `state=${missing.state} failure=${String(dependentMissing?.failure?.code)} actions=${String(dependentMissing?.actions)}`,
    );
    const ackB = await readFile(join(runB.sandbox, ACK_PATH)).then(() => 'present', () => 'absent');
    collector.check(ackB === 'absent', '7.zero-side-effects: run B\'s Node-B file is NOT written (the admission gate fired before any host invocation)');

    // ============ RUN C: the WRONG-RUN binding (typed entry rejection) ====
    const runC = await composeRun(stack, 'c');
    await driveToPause(runC);
    // The fact still attests run A while the declared binding is re-targeted
    // at run C — cross-run/cross-version substitution, rejected at entry:
    const stolenPrecondition: DependentStepPrecondition = {
      ...precondition,
      runId: runC.runId,
    };
    let entryRejected = false;
    try {
      await resumeWith(runC, [stolenPrecondition]);
    } catch (error) {
      entryRejected = (error as { code?: unknown }).code === 'COMPUTER_AGENT_PRECONDITION_REJECTED';
    }
    collector.check(entryRejected, '8.wrong-run-binding: a fact minted for run A supplied to run C is rejected TYPED at drive entry (cross-run substitution)');
    const runCHistory = await stack.runService.getRunHistory(stack.principal, runC.runId);
    collector.check(runCHistory.run.state === 'paused', '8.zero-durable-mutations: run C is STILL PAUSED (the resume never happened — read back through the real run service)', `state=${runCHistory.run.state}`);
    const ackC = await readFile(join(runC.sandbox, ACK_PATH)).then(() => 'present', () => 'absent');
    collector.check(ackC === 'absent', '8.zero-side-effects: run C\'s Node-B file is NOT written');

    // ============ RUN D: duplicate precondition ENTRIES converge ============
    const runD = await composeRun(stack, 'd');
    await driveToPause(runD);
    const attestationD = runD.capturingA.attestations[0];
    if (attestationD === undefined) {
      collector.check(false, '9.run-d-verification: run D\'s predecessor canonically verified', 'no attestation captured');
      return collector;
    }
    const verificationD = verifyPredecessor(runD, attestationD);
    if (!verificationD.ok) {
      collector.check(false, '9.run-d-verification: run D\'s predecessor canonically verified', verificationD.failure.code);
      return collector;
    }
    collector.check(true, '9.run-d-verification: run D\'s predecessor canonically verified');
    const preconditionD: DependentStepPrecondition = {
      dependentStepId: DEPENDENT_STEP_ID,
      predecessorAttestationId: verificationD.fact.attestationId,
      verifiedPredecessor: verificationD.fact,
      causalParentDigests: [verificationD.fact.executionDigest.digest],
      runId: runD.runId,
      workflowVersionId: runD.versionId,
      workflowVersionSemanticDigest: runD.semanticDigest,
    };
    const converged = await resumeWith(runD, [preconditionD, { ...preconditionD }]);
    const dependentConverged = converged.steps.find((step) => step.stepId === DEPENDENT_STEP_ID);
    const ackD = await readFile(join(runD.sandbox, ACK_PATH), 'utf8');
    const parentsD = runD.capturingB.attestations
      .filter((candidate) => candidate.statement.stepId === DEPENDENT_STEP_ID)
      .flatMap((candidate) => [...candidate.statement.causalParents]);
    collector.check(
      converged.state === 'completed' && dependentConverged?.outcome === 'completed' && ackD === ACK_CONTENT && parentsD.length === 1,
      '9.duplicate-entries: delivering the SAME precondition twice converges (one admission, one write, one causal parent)',
      `state=${converged.state} parents=${String(parentsD.length)}`,
    );

    collector.record('--- experiment instance complete ---');
    return collector;
  } finally {
    await stack.teardown();
  }
}

// ============================================================================
// §6 The runner (double-run determinism + fail-closed exit code)
// ============================================================================

async function main(): Promise<number> {
  const wallStart = Date.now();
  // eslint-disable-next-line no-console
  console.log(`V2-016 dogfooding run — Work Order ${WORK_ORDER_ID} (narrowly scoped to the new runtime contract)`);
  // eslint-disable-next-line no-console
  console.log(`wall clock start: ${wallStart}ms (the only wall-clock lines; all product clocks are injected)`);

  const first = await runExperiment(1);
  const second = await runExperiment(2);

  // Determinism: the normalized transcripts (every check line; repository
  // ids, key material, sandbox paths, digests, and wall time excluded by
  // construction) must be byte-identical across the two fresh stacks:
  const transcriptA = first.transcript.join('\n');
  const transcriptB = second.transcript.join('\n');
  // eslint-disable-next-line no-console
  console.log('--- determinism proof ---');
  const determinism = createCollector();
  determinism.check(
    transcriptA === transcriptB,
    '10.determinism: the two fresh-stack experiment transcripts are byte-identical',
    `lengths ${transcriptA.length}/${transcriptB.length}`,
  );
  const transcriptSha = createHash('sha256').update(transcriptA, 'utf8').digest('hex');
  // eslint-disable-next-line no-console
  console.log(`normalized-transcript-sha256: ${transcriptSha}`);

  const totalFailures = first.failures + second.failures + determinism.failures;
  const totalChecks = first.checks + second.checks + determinism.checks;
  // eslint-disable-next-line no-console
  console.log(`DOGFOODING RESULT: ${totalFailures === 0 ? 'PASS' : 'FAIL'} — ${totalChecks - totalFailures}/${totalChecks} checks PASS`);
  const wallEnd = Date.now();
  // eslint-disable-next-line no-console
  console.log(`wall clock end: ${wallEnd}ms (duration ${wallEnd - wallStart}ms for the double-run experiment)`);
  return totalFailures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    console.error('DOGFOODING RESULT: FAIL — experiment crashed', error);
    process.exit(1);
  },
);
