/**
 * V2-005 — evidence provenance + attestation bindings at the Run boundary
 * (real PG + REAL V2-014 Ed25519 attestations bound to the real run).
 *
 * Pins the Work Order's required regressions:
 *   - evidence provenance (classes carry + enforce provenance; wrong-class or
 *     provenance-less recording typed-rejected; classes never impersonate);
 *   - failed verification (invalid signature / failed policy NEVER becomes
 *     verification evidence; typed failure recorded durably);
 *   - attestation-binding mismatch (different run/attempt/step, mutated
 *     statement → typed rejection at the Run boundary; never attached);
 *   - replay / stale attestation at the Run boundary (same attestation twice
 *     → DURABLE single-use rejection; expired validity → typed rejection).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  generateAttesterKeyPair,
  signExecutionAttestation,
  executionValueCommitment,
  type ExecutionStatement,
  type ExecutionAttestation,
  type AssuranceLevel,
} from '../../../src/execution-attestation/index.js';
import {
  WorkflowRunError,
  type WorkflowRunService,
  type WorkflowRunHistory,
} from '../../../src/workflow-runs/index.js';
import {
  buildWorkflowRunTestStack,
  createTriageWorkflow,
  createManualClock,
  commitmentOf,
  type WorkflowRunTestStack,
} from './run-test-support.js';

/** Fixed freshness window (the manual clock drives the boundary's now). */
const NOW = '2026-09-01T12:00:30.000Z';
const EXECUTED_AT = '2026-09-01T12:00:00.000Z';
const VALID_UNTIL = '2026-09-01T12:05:00.000Z';
const ISSUED_AT = '2026-09-01T12:00:01.000Z';
const EPOCH = 7;

describe('V2-005 — evidence + attestation boundary (real PG, real Ed25519)', () => {
  let harness: WorkflowRunTestStack;
  let service: WorkflowRunService;
  let clock: ReturnType<typeof createManualClock>;
  let workflowId: string;
  let version1Id: string;
  let attester: ReturnType<typeof generateAttesterKeyPair>;
  let runId: string;

  beforeAll(async () => {
    harness = await buildWorkflowRunTestStack();
    clock = createManualClock(NOW);
    service = harness.freshRunService(clock);
    const triage = await createTriageWorkflow(harness, 'triage-attestation');
    workflowId = triage.workflowId;
    version1Id = triage.version.id;
    attester = generateAttesterKeyPair();
    runId = '';
  });

  beforeEach(async () => {
    await harness.stack.db.client.exec(
      'TRUNCATE wfos_v2_run_commands, wfos_v2_run_events, wfos_v2_run_attestation_rejections, ' +
      'wfos_v2_run_attestations, wfos_v2_run_evidence, wfos_v2_run_invocations, wfos_v2_run_steps, ' +
      'wfos_v2_run_attempts, wfos_v2_runs CASCADE',
    );
    clock.setNow(NOW);
  });

  afterAll(async () => {
    await harness.teardown();
  });

  const OWNER = () => ({ userId: harness.ownerAId });

  /** Bring a real running run to a mid-execution state (attempt 1, fetch done). */
  async function runningRun(): Promise<{ runId: string; run: { id: string; versionSemanticDigest: string } }> {
    const requested = await service.requestRun(OWNER(), {
      commandId: 'cmd-att-req-0001',
      correlationId: 'delivery-att-0001',
      causationId: 'evt-att-1',
    }, {
      organizationId: harness.orgAId,
      workflowId,
      versionId: version1Id,
      trigger: { type: 'webhook', id: 'delivery-att-0001' },
      inputCommitments: [commitmentOf('att-input')],
    });
    const id = requested.result.run.id;
    runId = id;
    await service.startRun(OWNER(), { commandId: 'cmd-att-start-0001', correlationId: 'delivery-att-0001' }, { runId: id });
    await service.recordStepStarted(OWNER(), { commandId: 'cmd-att-step-0001', correlationId: 'delivery-att-0001' }, {
      runId: id,
      stepId: 'fetch_issue',
    });
    const run = await service.getRun(OWNER(), id);
    return { runId: id, run: { id: run.id, versionSemanticDigest: run.versionSemanticDigest } };
  }

  function statementFor(
    run: { id: string; versionSemanticDigest: string },
    overrides: Partial<ExecutionStatement> = {},
  ): ExecutionStatement {
    return {
      objectType: 'workflowos/execution-statement/v1',
      statementSchemaVersion: 1,
      workflowId,
      workflowVersionId: version1Id,
      workflowVersionSemanticDigest: run.versionSemanticDigest,
      deploymentId: 'wfin_not_used_here',
      runId: run.id,
      attemptId: 1,
      stepId: 'notify_channel',
      nodeId: 'node_test_host_1',
      executionClass: 'deterministic_api',
      capability: 'messaging.send',
      action: 'Post the approved triage summary to the team notifications channel',
      inputCommitments: [executionValueCommitment('att-input')],
      outputCommitments: [executionValueCommitment('att-output')],
      observationCommitments: [executionValueCommitment('att-observation')],
      evidenceReferences: ['wfre_att-evidence-1'],
      causalParents: [],
      nonce: 'challenge-att-run-0001-attempt-1',
      epoch: EPOCH,
      outcome: 'succeeded',
      executedAt: EXECUTED_AT,
      validUntil: VALID_UNTIL,
      ...overrides,
    } as ExecutionStatement;
  }

  function signed(statement: ExecutionStatement, assurance: AssuranceLevel = 'software_signed'): ExecutionAttestation {
    return signExecutionAttestation({
      statement,
      attesterPrivateKey: attester.privateKey,
      attesterPublicKeyDer: attester.publicKeyDer,
      assurance,
      issuedAt: ISSUED_AT,
    });
  }

  let attachCounter = 0;
  async function attach(
    attestation: ExecutionAttestation,
    attemptNumber = 1,
    stepId: string | undefined = 'notify_channel',
  ) {
    attachCounter += 1;
    return service.attachAttestation(OWNER(), {
      commandId: `cmd-att-attach-${String(attachCounter).padStart(4, '0')}`,
      correlationId: 'delivery-att-0001',
    }, {
      runId,
      attemptNumber,
      stepId,
      attestation,
    });
  }

  it('EVIDENCE PROVENANCE: classes + producers are enforced; wrong class typed-rejected', async () => {
    const { runId: id } = await runningRun();
    // provenance-less recording is rejected
    for (const bad of [{ producerKind: '', producerId: 'x' }, { producerKind: 'executor', producerId: '' }]) {
      try {
        await service.recordEvidence(OWNER(), { commandId: `cmd-ev-bad-${bad.producerKind.length}`, correlationId: 'delivery-att-0001' }, {
          runId: id,
          evidenceClass: 'observation',
          ...bad,
          contentCommitment: commitmentOf('evidence-content'),
        });
        expect.unreachable('missing provenance must be rejected');
      } catch (err) {
        expect((err as WorkflowRunError).code).toBe('RUN_EVIDENCE_PRODUCER_REQUIRED');
      }
    }
    // wrong class is rejected
    try {
      await service.recordEvidence(OWNER(), { commandId: 'cmd-ev-bad-class', correlationId: 'delivery-att-0001' }, {
        runId: id,
        evidenceClass: 'obseravtion' as never,
        producerKind: 'executor',
        producerId: 'host-1',
        contentCommitment: commitmentOf('evidence-content'),
      });
      expect.unreachable('wrong class must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_EVIDENCE_CLASS_INVALID');
    }
    // a REAL observation commitment is recorded distinctly
    const observation = await service.recordEvidence(OWNER(), { commandId: 'cmd-ev-obs-1', correlationId: 'delivery-att-0001' }, {
      runId: id,
      evidenceClass: 'observation',
      producerKind: 'executor',
      producerId: 'node_test_host_1',
      contentCommitment: commitmentOf('real observation over real artifacts'),
      description: 'observed the message-delivery receipt bytes',
    });
    expect(observation.result.evidence.evidenceClass).toBe('observation');
    expect(observation.result.evidence.producerKind).toBe('executor');
    expect(observation.result.evidence.producerId).toBe('node_test_host_1');

    const history: WorkflowRunHistory = await service.getRunHistory(OWNER(), id);
    expect(history.evidence.map((e) => e.evidenceClass)).toEqual(['observation']);
    // the observation recorded projects the registry observation.recorded event
    expect(history.timeline.map((e) => e.eventName)).toContain('observation.recorded');
  });

  it('classes never impersonate one another: verification is a DISTINCT record class', async () => {
    const { runId: id, run } = await runningRun();
    // record one observation + one verification manually with the SAME commitment
    await service.recordEvidence(OWNER(), { commandId: 'cmd-ev-obs-2', correlationId: 'delivery-att-0001' }, {
      runId: id,
      evidenceClass: 'observation',
      producerKind: 'executor',
      producerId: 'node_test_host_1',
      contentCommitment: commitmentOf('shared-content'),
    });
    await service.recordEvidence(OWNER(), { commandId: 'cmd-ev-ver-2', correlationId: 'delivery-att-0001' }, {
      runId: id,
      evidenceClass: 'verification',
      producerKind: 'verifier',
      producerId: 'run-boundary-verifier',
      contentCommitment: commitmentOf('shared-content'),
    });
    const history = await service.getRunHistory(OWNER(), id);
    const classes = history.evidence.map((e) => e.evidenceClass).sort();
    expect(classes).toEqual(['observation', 'verification']);
    // duplicate evidence delivery converges on the SAME record (no duplicates)
    const again = await service.recordEvidence(OWNER(), { commandId: 'cmd-ev-obs-3', correlationId: 'delivery-att-0001' }, {
      runId: id,
      evidenceClass: 'observation',
      producerKind: 'executor',
      producerId: 'node_test_host_1',
      contentCommitment: commitmentOf('shared-content'),
    });
    expect(again.result.created).toBe(false);
    const history2 = await service.getRunHistory(OWNER(), id);
    expect(history2.evidence.length).toBe(2);
    void run;
  });

  it('a VALID correctly-bound attestation attaches: binding + verification evidence + registry event', async () => {
    const { run } = await runningRun();
    const attestation = signed(statementFor(run));
    const outcome = await attach(attestation);
    expect(outcome.executed).toBe(true);
    expect(outcome.result.binding.attestationId).toBe(attestation.attestationId);
    expect(outcome.result.binding.runId).toBe(run.id);
    expect(outcome.result.binding.attemptNumber).toBe(1);
    expect(outcome.result.binding.stepId).toBe('notify_channel');
    expect(outcome.result.binding.executionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.result.binding.attesterKeyId).toBe(attester.keyId);
    expect(outcome.result.binding.assurance).toBe('software_signed');
    // the attach records VERIFICATION-CLASS evidence (distinct from observation)
    expect(outcome.result.evidence.evidenceClass).toBe('verification');
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attestations.length).toBe(1);
    expect(history.attestationRejections.length).toBe(0);
    expect(history.timeline.map((e) => e.eventName)).toContain('execution.attestation.verified');
    expect(history.timeline.map((e) => e.eventName)).toContain('verification.completed');
  });

  it('MODIFIED attestation (mutated statement) → typed rejection, NEVER attached, rejection recorded', async () => {
    const { run } = await runningRun();
    const attestation = signed(statementFor(run));
    const modified: ExecutionAttestation = {
      ...attestation,
      statement: { ...attestation.statement, action: 'MUTATED action text' },
    };
    try {
      await attach(modified);
      expect.unreachable('modified attestation must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_ATTESTATION_REJECTED');
    }
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attestations.length).toBe(0);
    expect(history.attestationRejections.length).toBe(1);
    expect(['ATTESTATION_DIGEST_MISMATCH', 'ATTESTATION_SIGNATURE_INVALID']).toContain(
      history.attestationRejections[0]!.failureCode,
    );
    // and no verification evidence was created
    expect(history.evidence.filter((e) => e.evidenceClass === 'verification').length).toBe(0);
  });

  it('MISMATCHED attestation (bound to another run) → typed rejection, never attached', async () => {
    const { run } = await runningRun();
    const foreign = signed(statementFor(run, { runId: 'wfr_deadbeefdeadbeefdeadbeefdeadbeef' }));
    try {
      await attach(foreign);
      expect.unreachable('mismatched attestation must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_ATTESTATION_REJECTED');
    }
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attestations.length).toBe(0);
    expect(history.attestationRejections[0]!.failureCode).toBe('ATTESTATION_BINDING_MISMATCH');
  });

  it('MISMATCHED attempt (unknown attempt for the run) → typed rejection, never attached', async () => {
    const { run } = await runningRun();
    const attestation = signed(statementFor(run, { attemptId: 9 }));
    try {
      await attach(attestation, 9);
      expect.unreachable('unknown attempt must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_ATTESTATION_REJECTED');
    }
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attestations.length).toBe(0);
  });

  it('REPLAY: the SAME valid attestation attached twice → DURABLE single-use rejection', async () => {
    const { run } = await runningRun();
    const attestation = signed(statementFor(run, { nonce: 'challenge-att-replay-1' }));
    const first = await attach(attestation);
    expect(first.executed).toBe(true);
    // second delivery of the SAME attestation
    try {
      await attach(attestation);
      expect.unreachable('replayed attestation must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_ATTESTATION_REJECTED');
    }
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attestations.length).toBe(1);
    expect(history.attestationRejections[0]!.failureCode).toBe('ATTESTATION_REPLAYED');
    // a FRESH service instance still rejects (durable replay state, not memory)
    const fresh = harness.freshRunService(clock);
    try {
      await fresh.attachAttestation(OWNER(), { commandId: 'cmd-att-replay-fresh', correlationId: 'delivery-att-0001' }, {
        runId,
        attemptNumber: 1,
        stepId: 'notify_channel',
        attestation,
      });
      expect.unreachable('fresh instance must also reject the replay');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_ATTESTATION_REJECTED');
    }
    expect((await service.getRunHistory(OWNER(), runId)).attestations.length).toBe(1);
  });

  it('STALE attestation (expired validity) → typed rejection, never attached', async () => {
    const { run } = await runningRun();
    // a DIFFERENT attestation (fresh nonce) whose validity window has passed
    const stale = signed(statementFor(run, { nonce: 'challenge-att-stale-1' }));
    clock.setNow('2026-09-01T12:06:00.000Z'); // past validUntil 12:05
    try {
      await attach(stale);
      expect.unreachable('stale attestation must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_ATTESTATION_REJECTED');
    }
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attestations.length).toBe(0);
    expect(history.attestationRejections[0]!.failureCode).toBe('ATTESTATION_EXPIRED');
    clock.setNow(NOW);
  });

  it('FAILED VERIFICATION: invalid signature NEVER becomes verification evidence (typed failure recorded)', async () => {
    const { run } = await runningRun();
    const attestation = signed(statementFor(run, { nonce: 'challenge-att-sig-1' }));
    // corrupt the signature (flip a trailing byte pair)
    const flipped = attestation.signature.slice(0, -2) + (attestation.signature.endsWith('00') ? '11' : '00');
    const corrupted: ExecutionAttestation = { ...attestation, signature: flipped };
    try {
      await attach(corrupted);
      expect.unreachable('invalid signature must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_ATTESTATION_REJECTED');
    }
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attestations.length).toBe(0);
    expect(history.attestationRejections[0]!.failureCode).toBe('ATTESTATION_SIGNATURE_INVALID');
    expect(history.evidence.filter((e) => e.evidenceClass === 'verification').length).toBe(0);
  });

  it('a VALID signature with INSUFFICIENT assurance is NOT accepted (never auto-proof)', async () => {
    const { run } = await runningRun();
    const attestation = signed(statementFor(run, { nonce: 'challenge-att-assur-1' }));
    try {
      await service.attachAttestation(OWNER(), { commandId: 'cmd-att-assur-1', correlationId: 'delivery-att-0001' }, {
        runId,
        attemptNumber: 1,
        stepId: 'notify_channel',
        attestation,
        policy: { requiredAssurance: 'hardware_backed' },
      });
      expect.unreachable('insufficient assurance must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_ATTESTATION_REJECTED');
    }
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attestationRejections[0]!.failureCode).toBe('ATTESTATION_ASSURANCE_INSUFFICIENT');
    expect(history.attestations.length).toBe(0);
  });

  it('evidence remains appendable after terminal state, but attestation freshness still governs attach', async () => {
    const { runId: id } = await runningRun();
    await service.completeRun(OWNER(), { commandId: 'cmd-att-complete-1', correlationId: 'delivery-att-0001' }, { runId: id });
    // late observation evidence is appendable (append-only-for-evidence)
    const late = await service.recordEvidence(OWNER(), { commandId: 'cmd-att-late-obs', correlationId: 'delivery-att-0001' }, {
      runId: id,
      evidenceClass: 'observation',
      producerKind: 'executor',
      producerId: 'node_test_host_1',
      contentCommitment: commitmentOf('late observation'),
    });
    expect(late.result.evidence.evidenceClass).toBe('observation');
    // a late attestation for a completed run is still freshness-bound (valid attach allowed if fresh)
    const { run } = { run: await service.getRun(OWNER(), id) };
    const freshLate = signed(statementFor(run, { nonce: 'challenge-att-late-1' }));
    const outcome = await attach(freshLate);
    expect(outcome.executed).toBe(true);
    expect(outcome.result.binding.runId).toBe(id);
  });
});
