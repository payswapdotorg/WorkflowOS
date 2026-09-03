import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  generateAttesterKeyPair,
  signExecutionAttestation,
  executionValueCommitment,
  verifyAttestation,
  InMemoryReplayRegistry,
  type ExecutionAttestation,
  type ExecutionStatement,
} from '../../../src/execution-attestation/index.js';
import type { WorkflowRunService, WorkflowRunHistory } from '../../../src/workflow-runs/index.js';
import {
  reconstructProofGraphFromRunHistory,
  serializeProofGraph,
  computeGraphDigest,
  validateGraphState,
  createProofGraphBuilder,
} from '../../../src/execution-proof-graph/index.js';
import {
  buildWorkflowRunTestStack,
  createTriageWorkflow,
  createManualClock,
  commitmentOf,
  type WorkflowRunTestStack,
} from '../workflow-runs/run-test-support.js';

/**
 * V2-015 Task 5 — evidence composition at the V2-005 boundary (real PGlite
 * + ALL migrations + the REAL run service + REAL Ed25519 attestations).
 *
 * Proves:
 *   - a graph node/reference persisted for a real attestation (through the
 *     REAL attachAttestation boundary: single-use nonce, typed rejections)
 *     reconstructs the same logical execution identity from the existing
 *     Run/evidence records — with NO new tables, NO duplicated persistence
 *     (the graph is a deterministic composition over existing evidence);
 *   - the causal chain reconstructs from the persisted statements' declared
 *     causalParents (the dependent binds the predecessor's digest);
 *   - append-only: a rewrite attempt of a previously verified graph node is
 *     a typed rejection, never a merge;
 *   - reconstruction is deterministic (byte-identical serialization across
 *     repeated reconstruction AND across a FRESH service instance over the
 *     same database);
 *   - a tampered history (scope-substituted binding) is rejected typed.
 */

const NOW = '2026-09-01T12:00:30.000Z';
const EXECUTED_AT = '2026-09-01T12:00:00.000Z';
const VALID_UNTIL = '2026-09-01T12:30:00.000Z';
const ISSUED_AT = '2026-09-01T12:00:01.000Z';
const EPOCH = 7;

describe('V2-015 evidence composition — the real V2-005 run boundary (real PGlite + real Ed25519)', () => {
  let harness: WorkflowRunTestStack;
  let service: WorkflowRunService;
  let clock: ReturnType<typeof createManualClock>;
  let workflowId: string;
  let version1Id: string;
  let attester: ReturnType<typeof generateAttesterKeyPair>;

  beforeAll(async () => {
    harness = await buildWorkflowRunTestStack();
    clock = createManualClock(NOW);
    service = harness.freshRunService(clock);
    const triage = await createTriageWorkflow(harness, 'v2-015-evidence');
    workflowId = triage.workflowId;
    version1Id = triage.version.id;
    attester = generateAttesterKeyPair();
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

  /** Bring a real running run to a mid-execution state (attempt 1). */
  async function runningRun(): Promise<{ runId: string; versionSemanticDigest: string }> {
    const requested = await service.requestRun(OWNER(), {
      commandId: 'cmd-v2015-req-0001',
      correlationId: 'delivery-v2015-0001',
      causationId: 'evt-v2015-1',
    }, {
      organizationId: harness.orgAId,
      workflowId,
      versionId: version1Id,
      trigger: { type: 'webhook', id: 'delivery-v2015-0001' },
      inputCommitments: [commitmentOf('v2-015-input')],
    });
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), { commandId: 'cmd-v2015-start-0001', correlationId: 'delivery-v2015-0001' }, { runId });
    const run = await service.getRun(OWNER(), runId);
    return { runId, versionSemanticDigest: run.versionSemanticDigest };
  }

  function statementFor(
    run: { runId: string; versionSemanticDigest: string },
    overrides: Partial<ExecutionStatement> = {},
  ): ExecutionStatement {
    return {
      objectType: 'workflowos/execution-statement/v1',
      statementSchemaVersion: 1,
      workflowId,
      workflowVersionId: version1Id,
      workflowVersionSemanticDigest: run.versionSemanticDigest,
      deploymentId: 'wfin_not_used_here',
      runId: run.runId,
      attemptId: 1,
      stepId: 'fetch_issue',
      nodeId: 'node_v2015_host_a',
      executionClass: 'deterministic_api',
      capability: 'github.repository.read',
      action: 'Fetch the issue from the repository',
      inputCommitments: [executionValueCommitment('v2-015-input')],
      outputCommitments: [executionValueCommitment('v2-015-output')],
      observationCommitments: [executionValueCommitment('v2-015-observation')],
      evidenceReferences: ['wfre_v2015-evidence-1'],
      causalParents: [],
      nonce: 'challenge-v2015-run-0001-attempt-1-fetch',
      epoch: EPOCH,
      outcome: 'succeeded',
      executedAt: EXECUTED_AT,
      validUntil: VALID_UNTIL,
      ...overrides,
    } as ExecutionStatement;
  }

  function signed(statement: ExecutionStatement): ExecutionAttestation {
    return signExecutionAttestation({
      statement,
      attesterPrivateKey: attester.privateKey,
      attesterPublicKeyDer: attester.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: ISSUED_AT,
    });
  }

  let attachCounter = 0;
  async function attach(runId: string, attestation: ExecutionAttestation, stepId: string): Promise<void> {
    attachCounter += 1;
    await service.attachAttestation(OWNER(), {
      commandId: `cmd-v2015-attach-${String(attachCounter).padStart(4, '0')}`,
      correlationId: 'delivery-v2015-0001',
    }, {
      runId,
      attemptNumber: 1,
      stepId,
      attestation,
    });
  }

  it('reconstructs the proof graph from the real run history (two bindings + the causal edge)', async () => {
    const { runId, versionSemanticDigest } = await runningRun();
    const predecessor = signed(statementFor({ runId, versionSemanticDigest }));
    const dependent = signed(
      statementFor({ runId, versionSemanticDigest }, {
        stepId: 'notify_channel',
        nodeId: 'node_v2015_host_b',
        capability: 'messaging.send',
        action: 'Post the approved summary to the team channel',
        causalParents: [predecessor.executionDigest.digest],
        nonce: 'challenge-v2015-run-0001-attempt-1-notify',
      }),
    );

    await attach(runId, predecessor, 'fetch_issue');
    await attach(runId, dependent, 'notify_channel');

    const history: WorkflowRunHistory = await service.getRunHistory(OWNER(), runId);
    expect(history.attestations).toHaveLength(2);
    expect(history.attestationRejections).toHaveLength(0);

    const reconstruction = reconstructProofGraphFromRunHistory(history);
    expect(reconstruction.rejectedBindings).toEqual([]);
    expect(reconstruction.unresolvedCausalParents).toEqual([]);
    expect(reconstruction.graph.nodes).toHaveLength(2);
    expect(reconstruction.graph.edges).toHaveLength(1);
    expect(reconstruction.graph.edges[0]?.relation).toBe('causal');
    expect(reconstruction.graph.edges[0]?.parentExecutionDigest).toBe(predecessor.executionDigest.digest);
    expect(reconstruction.graph.runId).toBe(runId);
    expect(reconstruction.graph.workflowVersionId).toBe(version1Id);

    // the dependent node carries the declared causal parent from the
    // PERSISTED statement (never re-invented)
    const dependentNode = reconstruction.graph.nodes.find((n) => n.stepId === 'notify_channel')!;
    expect(dependentNode.declaredCausalParents).toEqual([predecessor.executionDigest.digest]);
    expect(dependentNode.executorNodeId).toBe('node_v2015_host_b');

    // the reconstruction validates clean under the full structural battery
    expect(validateGraphState(reconstruction.graph)).toEqual([]);

    // node identity is the SAME as the runtime-path projection (incl. the
    // causal edge derived from the persisted declared parents)
    const runtimeBuilder = createProofGraphBuilder({
      workflowId,
      workflowVersionId: version1Id,
      workflowVersionSemanticDigest: versionSemanticDigest,
      runId,
    });
    runtimeBuilder.addAttestationNode(predecessor);
    runtimeBuilder.addAttestationNode(dependent);
    runtimeBuilder.addCausalEdge({
      parentAttestationId: predecessor.attestationId,
      childAttestationId: dependent.attestationId,
    });
    expect(serializeProofGraph(reconstruction.graph)).toBe(serializeProofGraph(runtimeBuilder.graph));
  });

  it('reconstruction is deterministic across repetitions AND a fresh service instance (same database)', async () => {
    const { runId, versionSemanticDigest } = await runningRun();
    const predecessor = signed(statementFor({ runId, versionSemanticDigest }));
    const dependent = signed(
      statementFor({ runId, versionSemanticDigest }, {
        stepId: 'notify_channel',
        nodeId: 'node_v2015_host_b',
        causalParents: [predecessor.executionDigest.digest],
        nonce: 'challenge-v2015-run-0001-attempt-1-notify-d',
      }),
    );
    await attach(runId, predecessor, 'fetch_issue');
    await attach(runId, dependent, 'notify_channel');

    const first = reconstructProofGraphFromRunHistory(await service.getRunHistory(OWNER(), runId));
    const second = reconstructProofGraphFromRunHistory(await service.getRunHistory(OWNER(), runId));
    const freshService = harness.freshRunService(clock);
    const third = reconstructProofGraphFromRunHistory(await freshService.getRunHistory(OWNER(), runId));

    expect(serializeProofGraph(second.graph)).toBe(serializeProofGraph(first.graph));
    expect(serializeProofGraph(third.graph)).toBe(serializeProofGraph(first.graph));
    expect(computeGraphDigest(third.graph)).toBe(computeGraphDigest(first.graph));
  });

  it('append-only: rewriting a previously verified node is a typed rejection (never a merge)', async () => {
    const { runId, versionSemanticDigest } = await runningRun();
    const predecessor = signed(statementFor({ runId, versionSemanticDigest }));
    await attach(runId, predecessor, 'fetch_issue');

    const history = await service.getRunHistory(OWNER(), runId);
    const reconstruction = reconstructProofGraphFromRunHistory(history);
    const builder = createProofGraphBuilder({
      workflowId,
      workflowVersionId: version1Id,
      workflowVersionSemanticDigest: versionSemanticDigest,
      runId,
    });
    for (const node of reconstruction.graph.nodes) {
      builder.addNode(node);
    }
    // the attempted REWRITE: same node identity, flipped outcome
    const rewriteAttempt = { ...reconstruction.graph.nodes[0]!, outcome: 'failed' as const };
    const mutation = builder.addNode(rewriteAttempt);
    expect(mutation.kind).toBe('rejected');
    if (mutation.kind === 'rejected') {
      expect(mutation.failure.code).toBe('GRAPH_NODE_CONFLICT');
    }
    // the prior verified fact is unchanged
    expect(builder.graph.nodes[0]?.outcome).toBe('succeeded');
    expect(builder.graph.nodes).toHaveLength(1);
  });

  it('a scope-substituted binding statement is rejected typed (fail-closed, never merged)', async () => {
    const { runId, versionSemanticDigest } = await runningRun();
    const predecessor = signed(statementFor({ runId, versionSemanticDigest }));
    await attach(runId, predecessor, 'fetch_issue');

    const history = await service.getRunHistory(OWNER(), runId);
    // the coordinator tampers with the delivered history: the binding's
    // statement claims a different run
    const tampered: WorkflowRunHistory = JSON.parse(JSON.stringify(history)) as WorkflowRunHistory;
    (tampered.attestations[0]!.statement as Record<string, unknown>)['runId'] = 'wfr-tampered-run';
    const reconstruction = reconstructProofGraphFromRunHistory(tampered);
    expect(reconstruction.rejectedBindings).toHaveLength(1);
    expect(reconstruction.rejectedBindings[0]?.code).toBe('GRAPH_SCOPE_MISMATCH');
    expect(reconstruction.graph.nodes).toHaveLength(0);
  });

  it('an unresolvable declared causal parent is tallied, never invented', async () => {
    const { runId, versionSemanticDigest } = await runningRun();
    // the statement declares a parent that is NEVER bound to this run
    const orphanParentDigest = 'c'.repeat(64);
    const dependent = signed(
      statementFor({ runId, versionSemanticDigest }, {
        stepId: 'notify_channel',
        nodeId: 'node_v2015_host_b',
        causalParents: [orphanParentDigest],
        nonce: 'challenge-v2015-orphan-parent',
      }),
    );
    await attach(runId, dependent, 'notify_channel');

    const history = await service.getRunHistory(OWNER(), runId);
    const reconstruction = reconstructProofGraphFromRunHistory(history);
    expect(reconstruction.unresolvedCausalParents).toEqual([orphanParentDigest]);
    expect(reconstruction.graph.nodes).toHaveLength(1);
    expect(reconstruction.graph.edges).toHaveLength(0);
  });

  it('duplicate attestation delivery at the RUN boundary converges (one binding, one node)', async () => {
    const { runId, versionSemanticDigest } = await runningRun();
    const predecessor = signed(statementFor({ runId, versionSemanticDigest }));
    await attach(runId, predecessor, 'fetch_issue');

    // the same attestation re-delivered: the run boundary's DURABLE
    // single-use replay state rejects the attach (typed) — the persisted
    // binding stays the single logical fact
    await expect(
      attach(runId, predecessor, 'fetch_issue'),
    ).rejects.toMatchObject({ code: 'RUN_ATTESTATION_REJECTED' });

    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attestations).toHaveLength(1);
    const reconstruction = reconstructProofGraphFromRunHistory(history);
    expect(reconstruction.graph.nodes).toHaveLength(1);
  });

  it('the reconstructed graph feeds admission (verification-derived, real verifier facts)', async () => {
    const { runId, versionSemanticDigest } = await runningRun();
    const predecessor = signed(statementFor({ runId, versionSemanticDigest }));
    const dependent = signed(
      statementFor({ runId, versionSemanticDigest }, {
        stepId: 'notify_channel',
        nodeId: 'node_v2015_host_b',
        causalParents: [predecessor.executionDigest.digest],
        nonce: 'challenge-v2015-admission-composition',
      }),
    );
    await attach(runId, predecessor, 'fetch_issue');
    await attach(runId, dependent, 'notify_channel');

    // Node B independently verifies the PREDECESSOR envelope in its own
    // verifier context (fresh replay registry, trusted key, full freshness)
    const verification = verifyAttestation(predecessor, {
      bindings: {
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: versionSemanticDigest,
        runId,
        attemptId: 1,
        stepId: 'fetch_issue',
      },
      freshness: {
        now: NOW,
        currentEpoch: EPOCH,
        expectedNonce: 'challenge-v2015-run-0001-attempt-1-fetch',
        replayRegistry: new InMemoryReplayRegistry(),
        maxAgeMs: 60 * 60 * 1000,
      },
      attesterKeyIds: [attester.keyId],
      requiredAssurance: 'software_signed',
    });
    expect(verification.ok).toBe(true);

    // the graph-grounded admission over the RECONSTRUCTED graph
    const { evaluateGraphAdmission } = await import('../../../src/execution-proof-graph/index.js');
    const reconstruction = reconstructProofGraphFromRunHistory(await service.getRunHistory(OWNER(), runId));
    const admission = evaluateGraphAdmission({
      graph: reconstruction.graph,
      dependent: {
        stepId: 'notify_channel',
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: versionSemanticDigest,
        runId,
      },
      declaredParents: [predecessor.executionDigest.digest],
      predecessorEvidence: [{ executionDigest: predecessor.executionDigest.digest, verification }],
      trustPolicy: {
        trustedAttesterKeyIds: [attester.keyId],
        requiredAssurance: 'software_signed',
        now: NOW,
        currentEpoch: EPOCH,
        maxVerificationAgeMs: 10 * 60 * 1000,
      },
    });
    if (!admission.admitted) {
      throw new Error(`expected admitted, got ${admission.failure.code}: ${admission.failure.detail}`);
    }
    expect(admission.satisfiedParents).toEqual([predecessor.executionDigest.digest]);
  });
});
