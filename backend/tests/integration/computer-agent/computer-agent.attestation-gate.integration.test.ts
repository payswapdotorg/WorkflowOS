/**
 * V2-008 — attestation completion-boundary integration regressions on the
 * REAL stack (the ARCHITECT BLOCKER correction on PR #142): the real PGlite
 * run store + the real V2-005 DefaultWorkflowRunService boundary + real
 * V2-004 node registration + a REAL Ed25519 attester key.
 *
 * `AgentAttestationPolicy.required` is a COMPLETION GATE: a
 * required-attestation failure must leave the step durably NON-succeeded
 * and must prevent completeRun() — the run fails honestly instead.
 *
 * The three negative cases (architect blocker, required correction #4):
 *   (1) NO ATTESTER KEY — the real host honestly reports no V2-014 support
 *       while the policy requires attestation → typed
 *       AGENT_ATTESTATION_UNAVAILABLE; the durable step record is
 *       outcome 'failed' (status 'failed'), the run state is 'failed';
 *   (2) INDEPENDENT V2-014 VERIFICATION REJECTION — a real, validly-signed
 *       attestation from a host whose key nobody trusts
 *       (trustedAttesterKeyIds: [] trusts nobody) → typed
 *       AGENT_ATTESTATION_REJECTED carrying ATTESTATION_ATTESTER_UNEXPECTED;
 *       the V2-005 boundary is never asked (no rejection row, no binding);
 *   (3) V2-005 ATTACH REJECTION — two attested steps in one run whose host
 *       signs with a CONSTANT single-use nonce: the first attach consumes
 *       the nonce in the boundary's DURABLE run-scoped replay registry, the
 *       second attach is the typed RUN_ATTESTATION_REJECTED / ATTESTATION_REPLAYED
 *       throw (the real boundary RAISES, never returns) → typed
 *       AGENT_ATTESTATION_REJECTED; the durable rejection row records
 *       ATTESTATION_REPLAYED; the second step NEVER succeeds; the run fails.
 *
 * Determinism: the injected agent clock (fixed base, fixed step), real key
 * material generated per test (assertions never depend on key bytes), fixed
 * seeds and slugs, no wall clock, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { WorkflowRunHistory } from '../../../src/workflow-runs/index.js';
import { createWorkflowIrBuilder, type WorkflowIrDocument, type WorkflowNode } from '../../../src/workflow-ir/index.js';
import type {
  AttestingComputerHost,
  ComputerHostAdapter,
  AgentDecider,
  ScriptedDesktopEnvironment,
} from '../../../src/computer-agent/index.js';
import type { ExecutionAttestation, ReplayRegistry } from '../../../src/execution-attestation/index.js';
import {
  buildComputerAgentTestStack,
  buildAgenticWriteDocument,
  createObserveWriteVerifyDecider,
  freshDesktopEnvironment,
  newAttesterKey,
  TRIAGE_REPORT_CONTENT,
  WORKFLOW_INPUTS,
  type ComputerAgentTestStack,
} from './computer-agent-test-support.js';

const REPORT_PATH = WORKFLOW_INPUTS.reportPath;

/**
 * A delegating attesting host whose `nextNonce()` returns ONE constant
 * nonce: every attestation it signs carries the same single-use nonce, so
 * the V2-005 boundary's DURABLE run-scoped replay registry rejects the
 * second attach (ATTESTATION_REPLAYED) exactly like a real nonce-reuse
 * defect on a host would.
 */
class FixedNonceHost implements AttestingComputerHost {
  readonly nodeId: string;
  readonly sessionToken: string;
  readonly platformClass: AttestingComputerHost['platformClass'];
  readonly capabilities: AttestingComputerHost['capabilities'];
  readonly attestationSupport: AttestingComputerHost['attestationSupport'];
  private readonly inner: AttestingComputerHost;
  private signed = 0;

  constructor(inner: ComputerHostAdapter, private readonly nonce: string) {
    if (!inner.attestationSupport.supported || typeof (inner as AttestingComputerHost).signStatement !== 'function') {
      throw new Error('FixedNonceHost requires a host with real attester key material');
    }
    this.inner = inner as AttestingComputerHost;
    this.nodeId = inner.nodeId;
    this.sessionToken = inner.sessionToken;
    this.platformClass = inner.platformClass;
    this.capabilities = inner.capabilities;
    this.attestationSupport = inner.attestationSupport;
  }

  /** How many attestations this host has signed (1 per completed step). */
  get signedCount(): number {
    return this.signed;
  }

  invoke(invocationId: string, request: Parameters<ComputerHostAdapter['invoke']>[1]): ReturnType<ComputerHostAdapter['invoke']> {
    return this.inner.invoke(invocationId, request);
  }

  nextNonce(): string {
    return this.nonce;
  }

  signStatement(statement: Parameters<AttestingComputerHost['signStatement']>[0], issuedAt: string): ExecutionAttestation {
    this.signed += 1;
    return this.inner.signStatement(statement, issuedAt);
  }
}

/** The permissive replay registry: the runtime's OWN verification passes. */
const NEVER_CONSUMED: ReplayRegistry = {
  isConsumed: () => false,
  consume: () => undefined,
};

/**
 * Two capability steps in ONE run (no human pause — a single drive, one
 * attempt): an agentic write step followed by a deterministic_api flag
 * write. Both steps complete through the attestation path.
 */
function buildTwoStepAttestedDocument(): WorkflowIrDocument {
  const organize: WorkflowNode = {
    id: 'organize',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Write the triage report to the given path' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: 'device_local',
    inputs: [{ name: 'reportPath', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'reportPath' } }],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const notify: WorkflowNode = {
    id: 'notify',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'filesystem.write' },
    capabilityRequirements: ['filesystem.write'],
    placement: 'device_local',
    inputs: [
      { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'reports/notified.flag' } },
      { name: 'content', type: { kind: 'string' }, binding: { kind: 'literal', value: 'TRIAGE APPROVED' } },
    ],
    outputs: [],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('organize')
    .addWorkflowInput({ name: 'reportPath', type: { kind: 'string' } })
    .addNode(organize)
    .addNode(notify)
    .addEdge({ from: 'organize', to: 'notify', on: 'success' })
    .build();
}

/** The single-agentic-step document (the house shape). */


describe('V2-008 attestation completion boundary — the three negatives on the real stack', () => {
  let harness: ComputerAgentTestStack;

  beforeAll(async () => {
    harness = await buildComputerAgentTestStack();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('(1) no attester key + required policy → AGENT_ATTESTATION_UNAVAILABLE; the step durably fails; the run fails (no completeRun)', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment: ScriptedDesktopEnvironment = freshDesktopEnvironment();
    // NO attesterKey: the real adapter honestly reports no V2-014 support.
    const { host } = harness.attachDesktopHost({
      nodes,
      keySeed: 'gate-int-no-key',
      environment,
    });
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: { required: true } },
    });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'att-gate-no-key' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'gate-int-no-key',
    });

    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });

    // the typed runtime failure propagates (never a completed report):
    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_ATTESTATION_UNAVAILABLE');
    expect(report.steps[0]?.outcome).toBe('failed');
    expect(report.steps[0]?.failure?.code).toBe('AGENT_ATTESTATION_UNAVAILABLE');
    expect(report.steps[0]?.attestationsAttached).toBe(0);

    // the DURABLE shape (real PGlite): the step is NOT succeeded:
    const history: WorkflowRunHistory = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.run.state).toBe('failed');
    expect(history.steps.length).toBe(1);
    expect(history.steps[0]!.stepId).toBe('organize');
    expect(history.steps[0]!.outcome).toBe('failed');
    expect(history.steps[0]!.status).toBe('failed');
    expect(history.attestations).toEqual([]);
    expect(history.attestationRejections).toEqual([]);
  });

  it('(2) independent V2-014 verification rejection (nobody trusted) → AGENT_ATTESTATION_REJECTED; the boundary is never asked; the run fails', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment: ScriptedDesktopEnvironment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host } = harness.attachDesktopHost({
      nodes,
      keySeed: 'gate-int-untrusted',
      environment,
      attesterKey: key,
    });
    const runtime = harness.createRuntime({
      nodes,
      // the empty list trusts NOBODY (fail-closed): the runtime's own
      // independent verifier must reject the host's validly-signed attestation.
      policy: { attestation: { required: true, trustedAttesterKeyIds: [] } },
    });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'att-gate-untrusted' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'gate-int-untrusted',
    });

    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });

    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_ATTESTATION_REJECTED');
    expect(report.failure?.detail).toContain('ATTESTATION_ATTESTER_UNEXPECTED');
    expect(report.steps[0]?.outcome).toBe('failed');

    // the DURABLE shape: the step durably failed, the boundary was never
    // asked (no binding, no rejection row — the rejection is the runtime's
    // own independent verification, exactly where it should happen):
    const history: WorkflowRunHistory = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.run.state).toBe('failed');
    expect(history.steps[0]!.outcome).toBe('failed');
    expect(history.steps[0]!.status).toBe('failed');
    expect(history.attestations).toEqual([]);
    expect(history.attestationRejections).toEqual([]);
  });

  it('(3) V2-005 attach rejection (durable replay registry, typed throw) → AGENT_ATTESTATION_REJECTED; the second step never succeeds; the run fails', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment: ScriptedDesktopEnvironment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host } = harness.attachDesktopHost({
      nodes,
      keySeed: 'gate-int-attach-rejected',
      environment,
      attesterKey: key,
    });
    // the host signs EVERY attestation with the SAME single-use nonce: the
    // first attach consumes it in the boundary's durable replay registry,
    // the second attach is the typed ATTESTATION_REPLAYED rejection.
    const fixedNonce = new FixedNonceHost(host, 'gate-fixed-nonce-0001');
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: { required: true, trustedAttesterKeyIds: [key.keyId] } },
      // the runtime's OWN verification must pass (the durable boundary
      // registry is the rejection authority under test — defense in depth):
      replayRegistry: NEVER_CONSUMED,
    });
    const authored = await harness.authorWorkflow({ document: buildTwoStepAttestedDocument(), slug: 'att-gate-attach-rejected' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'gate-int-attach-rejected',
    });

    const report = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [fixedNonce],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }) as AgentDecider,
      workflowInputs: { reportPath: REPORT_PATH },
    });

    // the FIRST step completed + attested; the SECOND step failed the
    // completion gate; the RUN failed (completeRun never called):
    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_ATTESTATION_REJECTED');
    expect(report.failure?.detail).toContain('RUN_ATTESTATION_REJECTED');
    const organizeStep = report.steps.find((step) => step.stepId === 'organize');
    const notifyStep = report.steps.find((step) => step.stepId === 'notify');
    expect(organizeStep?.outcome).toBe('completed');
    expect(organizeStep?.attestationsAttached).toBe(1);
    expect(notifyStep?.outcome).toBe('failed');
    expect(notifyStep?.failure?.code).toBe('AGENT_ATTESTATION_REJECTED');
    expect(notifyStep?.attestationsAttached).toBe(0);
    // the host signed exactly two attestations (one per completed attempt):
    expect(fixedNonce.signedCount).toBe(2);

    // the DURABLE shape: organize succeeded with ONE binding; notify is
    // durably 'failed'; the typed replay rejection is PERSISTED by the
    // boundary; the run state is 'failed':
    const history: WorkflowRunHistory = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.run.state).toBe('failed');
    const durableOrganize = history.steps.find((step) => step.stepId === 'organize');
    const durableNotify = history.steps.find((step) => step.stepId === 'notify');
    expect(durableOrganize?.outcome).toBe('succeeded');
    expect(durableOrganize?.status).toBe('completed');
    expect(durableNotify?.outcome).toBe('failed');
    expect(durableNotify?.status).toBe('failed');
    expect(history.attestations.length).toBe(1);
    expect(history.attestations[0]!.stepId).toBe('organize');
    expect(history.attestationRejections.length).toBe(1);
    expect(history.attestationRejections[0]!.failureCode).toBe('ATTESTATION_REPLAYED');
  });
});
