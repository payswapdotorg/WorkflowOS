/**
 * V2-008 — end-to-end integration on the REAL stack: real PGlite (all 61
 * migrations) + the real V2-002 workflow-repository + the real V2-005
 * DefaultWorkflowRunService as the runtime's ComputerAgentRunRecorder (the
 * structural subset — no adapter code) + real V2-004 node registration for
 * the desktop host + a REAL Ed25519 attester key (the merged V2-014 barrel)
 * on the host adapter.
 *
 * Pins the Work Order's required regressions:
 *   - the full agentic drive: observe the ABSENT target → grounded
 *     filesystem.write → verification observation → complete — the run
 *     reaches 'completed' and the file is REALLY written in the environment;
 *   - the durable shape in PostgreSQL: the step completed, the read/write
 *     capability invocations, the intent/observation/claim evidence trail,
 *     and exactly ONE attestation binding at assurance software_signed;
 *   - timeline reconstruction: the registry protocol event-name sequence;
 *   - TAMPER: a mutated clone of the runtime's real attestation is
 *     typed-rejected at the run boundary (never attached; count stays 1);
 *   - REPLAY: re-attaching the byte-identical attestation is the durable
 *     single-use replay rejection (count stays 1);
 *   - DETERMINISM: an identical drive in a SECOND organization produces the
 *     identical durable shape (event names, evidence provenance, invocation
 *     outcomes, step outputs, attestation material — ids excluded).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RUN_PROTOCOL_EVENT_NAMES,
  type WorkflowRunHistory,
} from '../../../src/workflow-runs/index.js';
import { InMemoryReplayRegistry, type ExecutionAttestation } from '../../../src/execution-attestation/index.js';
import {
  buildComputerAgentTestStack,
  buildAgenticWriteDocument,
  createObserveWriteVerifyDecider,
  freshDesktopEnvironment,
  newAttesterKey,
  CapturingHost,
  attestationPolicyFor,
  TRIAGE_REPORT_CONTENT,
  WORKFLOW_INPUTS,
  type ComputerAgentTestStack,
} from './computer-agent-test-support.js';

const STEP_ID = 'organize';
const REPORT_PATH = WORKFLOW_INPUTS.reportPath;

describe('V2-008 computer-agent runtime — end-to-end on the real stack', () => {
  let harness: ComputerAgentTestStack;

  beforeAll(async () => {
    harness = await buildComputerAgentTestStack();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('full drive: observe absent → grounded write → verify → complete (run completed, file really written)', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host, nodeId } = harness.attachDesktopHost({
      nodes,
      keySeed: 'e2e-full-desktop',
      environment,
      attesterKey: key,
    });
    const capturing = new CapturingHost(host);
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([host]) },
    });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-full' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'e2e-full',
    });

    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [capturing],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });

    // the drive completed and the effect is REAL (the host environment file):
    expect(report.state).toBe('completed');
    expect(report.pausedAtStepId).toBeNull();
    expect(report.takeoverRequested).toBe(false);
    expect(report.failure).toBeNull();
    expect(environment.readFile(REPORT_PATH)).toBe(TRIAGE_REPORT_CONTENT);
    expect(capturing.attestations.length).toBe(1);

    // the one step's execution report (the real run service's own view):
    expect(report.steps.length).toBe(1);
    const step = report.steps[0]!;
    expect(step.stepId).toBe(STEP_ID);
    expect(step.executionClass).toBe('agentic_computer_use');
    expect(step.outcome).toBe('completed');
    expect(step.nodeId).toBe(nodeId);
    expect(step.actions).toBe(3); // observe + grounded act + verification observe
    expect(step.observations).toBe(3); // initial + effect + verification
    expect(step.attestationsAttached).toBe(1);
    expect(step.attestationsRejected).toBe(0);
    expect(step.failure).toBeNull();
  });

  it('durable shape: step completed, read/write invocations, intent/observation/claim evidence, ONE software_signed binding', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host, nodeId } = harness.attachDesktopHost({
      nodes,
      keySeed: 'e2e-shape-desktop',
      environment,
      attesterKey: key,
    });
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([host]) },
    });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-shape' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'e2e-shape',
    });
    await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });

    const history: WorkflowRunHistory = await harness.runService.getRunHistory(harness.principal, run.id);

    // the run itself: completed, pinned to the authored semantic digest:
    expect(history.run.state).toBe('completed');
    expect(history.run.versionSemanticDigest).toBe(authored.semanticDigest);
    expect(history.run.versionId).toBe(authored.versionId);

    // the step: one completed step record with succeeded outcome:
    expect(history.steps.length).toBe(1);
    expect(history.steps[0]!.stepId).toBe(STEP_ID);
    expect(history.steps[0]!.status).toBe('completed');
    expect(history.steps[0]!.outcome).toBe('succeeded');
    expect(history.steps[0]!.attemptNumber).toBe(1);
    expect(history.steps[0]!.outputCommitments).toEqual([
      // sha-256 over JSON true (the declared `written` boolean output):
      'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b',
    ]);

    // the capability invocations: read → write → read (all succeeded):
    expect(history.invocations.map((invocation) => invocation.capability)).toEqual([
      'filesystem.read',
      'filesystem.write',
      'filesystem.read',
    ]);
    for (const invocation of history.invocations) {
      expect(invocation.outcome).toBe('succeeded');
      expect(invocation.executionClass).toBe('agentic_computer_use');
      expect(invocation.stepId).toBe(STEP_ID);
      expect(invocation.attemptNumber).toBe(1);
    }

    // the evidence trail (in recorded order): intent → observation → intent
    // → claim → intent → observation → verification (the attach):
    expect(history.evidence.map((evidence) => evidence.evidenceClass)).toEqual([
      'intent',
      'observation',
      'intent',
      'claim',
      'intent',
      'observation',
      'verification',
    ]);
    const intents = history.evidence.filter((evidence) => evidence.evidenceClass === 'intent');
    expect(intents.length).toBe(3);
    for (const intent of intents) {
      expect(intent.producerKind).toBe('computer_agent');
      expect(intent.producerId).toBe('workflowos/computer-agent-runtime');
      expect(intent.stepId).toBe(STEP_ID);
    }
    for (const observation of history.evidence.filter((evidence) => evidence.evidenceClass === 'observation')) {
      expect(observation.producerKind).toBe('computer_host');
      expect(observation.producerId).toBe(nodeId);
    }
    const claims = history.evidence.filter((evidence) => evidence.evidenceClass === 'claim');
    expect(claims.length).toBe(1);
    expect(claims[0]!.producerKind).toBe('computer_host');
    expect(claims[0]!.producerId).toBe(nodeId);
    const verification = history.evidence.filter((evidence) => evidence.evidenceClass === 'verification');
    expect(verification.length).toBe(1);
    expect(verification[0]!.producerKind).toBe('verifier');
    expect(verification[0]!.producerId).toBe('workflow-runs/attestation-boundary');

    // exactly ONE attestation binding, at the honest software_signed baseline:
    expect(history.attestations.length).toBe(1);
    const binding = history.attestations[0]!;
    expect(binding.runId).toBe(run.id);
    expect(binding.attemptNumber).toBe(1);
    expect(binding.stepId).toBe(STEP_ID);
    expect(binding.assurance).toBe('software_signed');
    expect(binding.attesterKeyId).toBe(key.keyId);
    expect(binding.executionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.nonce).toBe(`nonce-${nodeId}-0001`);
    expect(history.attestationRejections.length).toBe(0);
  });

  it('timeline reconstruction: the registry protocol event-name sequence (append-only, stable order)', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host } = harness.attachDesktopHost({
      nodes,
      keySeed: 'e2e-timeline-desktop',
      environment,
      attesterKey: key,
    });
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([host]) },
    });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-timeline' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'e2e-timeline',
    });
    await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });

    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    const events = history.timeline.map((entry) => entry.eventName);
    // every name is a REGISTRY protocol event name (verbatim — no drift):
    const registryNames = new Set<string>(RUN_PROTOCOL_EVENT_NAMES);
    for (const name of events) {
      expect(registryNames.has(name)).toBe(true);
    }
    // the exact reconstructed sequence (deterministic drive): the
    // attestation is verified + attached BEFORE the step is durably
    // completed (the PR #142 blocker correction — required attestation is
    // a completion gate, so the attestation boundary events precede
    // workflow.step.completed):
    expect(events).toEqual([
      'workflow.run.requested',
      'workflow.run.started',
      'workflow.step.started',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'observation.recorded',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'observation.recorded',
      'execution.attestation.verified',
      'verification.completed',
      'workflow.step.completed',
      'workflow.run.completed',
    ]);
    // the timeline is sequence-ordered (stable reconstruction order):
    const sequences = history.timeline.map((entry) => entry.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });

  it('tamper negative: a mutated clone of the runtime attestation is typed-rejected; the binding count stays 1', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host } = harness.attachDesktopHost({
      nodes,
      keySeed: 'e2e-tamper-desktop',
      environment,
      attesterKey: key,
    });
    const capturing = new CapturingHost(host);
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([host]) },
    });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-tamper' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'e2e-tamper',
    });
    await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [capturing],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });

    // the EXACT attestation the runtime produced and the boundary accepted:
    expect(capturing.attestations.length).toBe(1);
    const original = capturing.attestations[0]!;
    // a deep clone with a MUTATED statement (never the signed bytes):
    const clone = JSON.parse(JSON.stringify(original)) as ExecutionAttestation;
    const tampered: ExecutionAttestation = {
      ...clone,
      // a pattern-valid FRESH identity (the tamper probe, not the replay probe):
      attestationId: `wfea_${'0'.repeat(31)}1`,
      statement: { ...clone.statement, action: `${clone.statement.action} (TAMPERED)` },
    };
    expect(tampered.statement.action).not.toBe(original.statement.action);

    await expect(
      harness.runService.attachAttestation(
        harness.principal,
        { commandId: 'cmd-ca-tamper-e2e', correlationId: 'ca-e2e-tamper' },
        {
          runId: run.id,
          attemptNumber: 1,
          stepId: STEP_ID,
          attestation: tampered,
          policy: { trustedAttesterKeyIds: [key.keyId] },
        },
      ),
    ).rejects.toMatchObject({ name: 'WorkflowRunError', code: 'RUN_ATTESTATION_REJECTED' });

    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    // NEVER attached: still exactly the ONE real binding:
    expect(history.attestations.length).toBe(1);
    expect(history.attestations[0]!.attestationId).toBe(original.attestationId);
    // the typed rejection is durably recorded (fail-closed, append-only):
    expect(history.attestationRejections.length).toBe(1);
    expect(['ATTESTATION_SIGNATURE_INVALID', 'ATTESTATION_DIGEST_MISMATCH']).toContain(
      history.attestationRejections[0]!.failureCode,
    );
    // and no second verification evidence was created:
    expect(history.evidence.filter((evidence) => evidence.evidenceClass === 'verification').length).toBe(1);
  });

  it('replay negative: re-attaching the byte-identical attestation is the durable single-use replay rejection', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host } = harness.attachDesktopHost({
      nodes,
      keySeed: 'e2e-replay-desktop',
      environment,
      attesterKey: key,
    });
    const capturing = new CapturingHost(host);
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([host]) },
    });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-replay' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'e2e-replay',
    });
    await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [capturing],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    const original = capturing.attestations[0]!;

    // the second delivery of the SAME (byte-identical) attestation:
    await expect(
      harness.runService.attachAttestation(
        harness.principal,
        { commandId: 'cmd-ca-replay-e2e', correlationId: 'ca-e2e-replay' },
        {
          runId: run.id,
          attemptNumber: 1,
          stepId: STEP_ID,
          attestation: original,
          policy: { trustedAttesterKeyIds: [key.keyId] },
        },
      ),
    ).rejects.toMatchObject({ name: 'WorkflowRunError', code: 'RUN_ATTESTATION_REJECTED' });

    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    // the persisted binding row IS the durable single-use consumption:
    expect(history.attestations.length).toBe(1);
    expect(history.attestationRejections.length).toBe(1);
    expect(history.attestationRejections[0]!.failureCode).toBe('ATTESTATION_REPLAYED');
    expect(history.attestationRejections[0]!.attestationId).toBe(original.attestationId);
    expect(history.evidence.filter((evidence) => evidence.evidenceClass === 'verification').length).toBe(1);
  });

  it('determinism: an identical drive in a second organization produces the identical durable shape', async () => {
    const orgB = await harness.createOrganization('V2-008 Org B', 'v2-008-owner-b');
    const key = newAttesterKey(); // ONE attester key shared by both hosts (key-normalized assertions)

    // ---- drive A (organization A) ----
    const nodesA = harness.freshNodeDirectory();
    const environmentA = freshDesktopEnvironment();
    const clockA = harness.freshAgentClock();
    const hostA = harness.attachDesktopHost({
      nodes: nodesA,
      keySeed: 'e2e-det-desktop', // the SAME seed → the SAME deterministic node id
      environment: environmentA,
      attesterKey: key,
      clock: clockA,
    });
    const runtimeA = harness.createRuntime({
      nodes: nodesA,
      recorder: harness.freshRunService(),
      clock: clockA,
      replayRegistry: new InMemoryReplayRegistry(),
      policy: { attestation: attestationPolicyFor([hostA.host]) },
    });
    const authoredA = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-det' });
    const runA = await harness.requestRun({
      workflowId: authoredA.workflowId,
      versionId: authoredA.versionId,
      triggerId: 'e2e-det-a',
    });
    const reportA = await runtimeA.executeRun(harness.principal, {
      runId: runA.id,
      hosts: [hostA.host],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    expect(reportA.state).toBe('completed');
    expect(environmentA.readFile(REPORT_PATH)).toBe(TRIAGE_REPORT_CONTENT);

    // ---- drive B (organization B): same document, same seeds, fresh clocks ----
    const nodesB = harness.freshNodeDirectory();
    const environmentB = freshDesktopEnvironment();
    const clockB = harness.freshAgentClock();
    const hostB = harness.attachDesktopHost({
      nodes: nodesB,
      keySeed: 'e2e-det-desktop',
      environment: environmentB,
      attesterKey: key,
      clock: clockB,
    });
    expect(hostB.nodeId).toBe(hostA.nodeId); // the deterministic V2-004 node identity
    const runtimeB = harness.createRuntime({
      nodes: nodesB,
      recorder: harness.freshRunService(),
      clock: clockB,
      replayRegistry: new InMemoryReplayRegistry(),
      policy: { attestation: attestationPolicyFor([hostB.host]) },
    });
    const authoredB = await harness.authorWorkflow({
      document: buildAgenticWriteDocument(),
      slug: 'agentic-write-det',
      organizationId: orgB.orgId,
      principal: orgB.principal,
    });
    // the V2-003 semantic digest is org-independent (identical pinned semantics):
    expect(authoredB.semanticDigest).toBe(authoredA.semanticDigest);
    const runB = await harness.requestRun({
      workflowId: authoredB.workflowId,
      versionId: authoredB.versionId,
      triggerId: 'e2e-det-b',
      organizationId: orgB.orgId,
      principal: orgB.principal,
    });
    const reportB = await runtimeB.executeRun(orgB.principal, {
      runId: runB.id,
      hosts: [hostB.host],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    expect(reportB.state).toBe('completed');
    expect(environmentB.readFile(REPORT_PATH)).toBe(TRIAGE_REPORT_CONTENT);

    // ---- the identical durable shape (ids excluded) ----
    const historyA = await harness.runService.getRunHistory(harness.principal, runA.id);
    const historyB = await harness.runService.getRunHistory(orgB.principal, runB.id);

    expect(historyB.run.state).toBe(historyA.run.state);
    expect(historyB.run.versionSemanticDigest).toBe(historyA.run.versionSemanticDigest);
    expect(reportB.steps.map((step) => ({ ...step, nodeId: null }))).toEqual(
      reportA.steps.map((step) => ({ ...step, nodeId: null })),
    );
    expect(historyB.timeline.map((entry) => entry.eventName)).toEqual(historyA.timeline.map((entry) => entry.eventName));
    expect(
      historyB.evidence.map((evidence) => ({
        cls: evidence.evidenceClass,
        kind: evidence.producerKind,
        producer: evidence.producerId,
        step: evidence.stepId,
      })),
    ).toEqual(
      historyA.evidence.map((evidence) => ({
        cls: evidence.evidenceClass,
        kind: evidence.producerKind,
        producer: evidence.producerId,
        step: evidence.stepId,
      })),
    );
    expect(
      historyB.invocations.map((invocation) => ({
        capability: invocation.capability,
        cls: invocation.executionClass,
        step: invocation.stepId,
        outcome: invocation.outcome,
        inputs: invocation.inputCommitments,
        outputs: invocation.outputCommitments,
      })),
    ).toEqual(
      historyA.invocations.map((invocation) => ({
        capability: invocation.capability,
        cls: invocation.executionClass,
        step: invocation.stepId,
        outcome: invocation.outcome,
        inputs: invocation.inputCommitments,
        outputs: invocation.outputCommitments,
      })),
    );
    expect(
      historyB.steps.map((step) => ({
        step: step.stepId,
        status: step.status,
        outcome: step.outcome,
        inputs: step.inputCommitments,
        outputs: step.outputCommitments,
      })),
    ).toEqual(
      historyA.steps.map((step) => ({
        step: step.stepId,
        status: step.status,
        outcome: step.outcome,
        inputs: step.inputCommitments,
        outputs: step.outputCommitments,
      })),
    );
    expect(historyB.attempts.map((attempt) => ({ n: attempt.attemptNumber, state: attempt.state }))).toEqual(
      historyA.attempts.map((attempt) => ({ n: attempt.attemptNumber, state: attempt.state })),
    );
    expect(
      historyB.attestations.map((binding) => ({
        assurance: binding.assurance,
        attester: binding.attesterKeyId,
        step: binding.stepId,
        attempt: binding.attemptNumber,
        nonce: binding.nonce,
      })),
    ).toEqual(
      historyA.attestations.map((binding) => ({
        assurance: binding.assurance,
        attester: binding.attesterKeyId,
        step: binding.stepId,
        attempt: binding.attemptNumber,
        nonce: binding.nonce,
      })),
    );
    expect(historyB.attestationRejections.length).toBe(0);
  });
});
