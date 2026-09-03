import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { expectTypeOf } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  generateAttesterKeyPair,
  signExecutionAttestation,
  executionValueCommitment,
  serializeAttestation,
  parseAttestation,
  verifyAttestation,
  InMemoryReplayRegistry,
  type ExecutionAttestation,
  type ExecutionStatement,
  type AttestationVerification,
  type VerifiedExecutionFact,
} from '../../../src/execution-attestation/index.js';
import type { WorkflowRunService, WorkflowRunHistory } from '../../../src/workflow-runs/index.js';
import type { DependentStepPrecondition, ResumeAfterHumanInput } from '../../../src/computer-agent/index.js';
import {
  reconstructProofGraphFromRunHistory,
  createProofGraphBuilder,
  planCrossDeviceContinuation,
  recordContinuationOutcome,
  deliverGraphFragment,
  serializeProofGraph,
  type CrossDeviceContinuationDecision,
} from '../../../src/execution-proof-graph/index.js';
import {
  buildWorkflowRunTestStack,
  createTriageWorkflow,
  createManualClock,
  commitmentOf,
  type WorkflowRunTestStack,
} from '../workflow-runs/run-test-support.js';

/**
 * V2-015 Task 6 — cross-device continuation composition at the integration
 * boundary (real PGlite + ALL migrations + the REAL V2-005 run service +
 * REAL Ed25519 attestations from TWO host contexts).
 *
 * Proves (invariants 4/5/7/12):
 *   - Node A produces an attestation (bound durably through the REAL
 *     attachAttestation boundary); Node B independently obtains a V2-014
 *     VerifiedExecutionFact in its OWN verifier context (fresh replay
 *     registry, run-derived binding expectations, its own trusted list);
 *   - V2-015 admits the dependent continuation ONLY after exact predecessor
 *     and graph bindings are satisfied — and materializes the V2-016
 *     DependentStepPrecondition (the exact runtime currency, type-pinned
 *     against ResumeAfterHumanInput.preconditions);
 *   - denials materialize NOTHING (untrusted/stale/replayed/wrong-run
 *     predecessors never mint the runtime currency);
 *   - the RUNTIME-PRODUCED dependent attestation folds back into the graph
 *     with its own declared causal parents (never a hand-built positive);
 *   - reconnect/replay: duplicate delivery converges at the graph level and
 *     the run boundary rejects duplicate attaches (no duplicate side
 *     effects at the integration boundary);
 *   - the coordination layer NEVER executes anything (type-only V2-008
 *     consumption — no second execution engine).
 */

const NOW = '2026-09-01T12:00:30.000Z';
const EXECUTED_AT = '2026-09-01T12:00:00.000Z';
const EXECUTED_AT_LATER = '2026-09-01T12:01:00.000Z';
const VALID_UNTIL = '2026-09-01T12:30:00.000Z';
const ISSUED_AT = '2026-09-01T12:00:01.000Z';
const EPOCH = 7;

describe('V2-015 cross-device continuation — two host contexts over the real run boundary', () => {
  let harness: WorkflowRunTestStack;
  let service: WorkflowRunService;
  let clock: ReturnType<typeof createManualClock>;
  let workflowId: string;
  let version1Id: string;
  /** Node A's attester (the web host). */
  let attesterA: ReturnType<typeof generateAttesterKeyPair>;
  /** Node B's attester (the desktop host — signs the produced dependent step). */
  let attesterB: ReturnType<typeof generateAttesterKeyPair>;

  beforeAll(async () => {
    harness = await buildWorkflowRunTestStack();
    clock = createManualClock(NOW);
    service = harness.freshRunService(clock);
    const triage = await createTriageWorkflow(harness, 'v2-015-cross-device');
    workflowId = triage.workflowId;
    version1Id = triage.version.id;
    attesterA = generateAttesterKeyPair();
    attesterB = generateAttesterKeyPair();
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

  async function runningRun(): Promise<{ runId: string; versionSemanticDigest: string }> {
    const requested = await service.requestRun(OWNER(), {
      commandId: 'cmd-v2015cd-req-0001',
      correlationId: 'delivery-v2015cd-0001',
      causationId: 'evt-v2015cd-1',
    }, {
      organizationId: harness.orgAId,
      workflowId,
      versionId: version1Id,
      trigger: { type: 'webhook', id: 'delivery-v2015cd-0001' },
      inputCommitments: [commitmentOf('v2-015-cd-input')],
    });
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), { commandId: 'cmd-v2015cd-start-0001', correlationId: 'delivery-v2015cd-0001' }, { runId });
    const run = await service.getRun(OWNER(), runId);
    return { runId, versionSemanticDigest: run.versionSemanticDigest };
  }

  function predecessorStatement(scope: { runId: string; versionSemanticDigest: string }): ExecutionStatement {
    return {
      objectType: 'workflowos/execution-statement/v1',
      statementSchemaVersion: 1,
      workflowId,
      workflowVersionId: version1Id,
      workflowVersionSemanticDigest: scope.versionSemanticDigest,
      deploymentId: 'wfin_not_used_here',
      runId: scope.runId,
      attemptId: 1,
      stepId: 'fetch_issue',
      nodeId: 'node_v2015_web_a',
      workloadIdentity: 'wl_v2015_web_runner',
      executionClass: 'deterministic_api',
      capability: 'github.repository.read',
      action: 'Fetch the issue from the repository (web host)',
      inputCommitments: [executionValueCommitment('v2-015-cd-input')],
      outputCommitments: [executionValueCommitment('v2-015-cd-out')],
      observationCommitments: [executionValueCommitment('v2-015-cd-obs')],
      evidenceReferences: ['wfre_v2015-cd-1'],
      causalParents: [],
      nonce: 'challenge-v2015cd-fetch',
      epoch: EPOCH,
      outcome: 'succeeded',
      executedAt: EXECUTED_AT,
      validUntil: VALID_UNTIL,
    } as ExecutionStatement;
  }

  /** The RUNTIME-PRODUCED dependent attestation (Node B's signing host). */
  function producedDependentStatement(
    scope: { runId: string; versionSemanticDigest: string },
    predecessorDigest: string,
    nonce: string,
  ): ExecutionStatement {
    return {
      ...predecessorStatement(scope),
      stepId: 'notify_channel',
      nodeId: 'node_v2015_desktop_b',
      workloadIdentity: 'wl_v2015_desktop_runner',
      capability: 'messaging.send',
      action: 'Post the approved summary to the team channel (desktop host)',
      causalParents: [predecessorDigest],
      nonce,
      executedAt: EXECUTED_AT_LATER,
    } as ExecutionStatement;
  }

  function signWith(statement: ExecutionStatement, attester: ReturnType<typeof generateAttesterKeyPair>): ExecutionAttestation {
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
      commandId: `cmd-v2015cd-attach-${String(attachCounter).padStart(4, '0')}`,
      correlationId: 'delivery-v2015cd-0001',
    }, {
      runId,
      attemptNumber: 1,
      stepId,
      attestation,
    });
  }

  /**
   * Node B's INDEPENDENT verifier context: the transferred canonical bytes
   * are parsed and verified with a FRESH replay registry, run-derived
   * binding expectations, and Node B's own trusted-attester list.
   */
  function nodeBVerifies(
    envelopeBytes: string,
    scope: { runId: string; versionSemanticDigest: string },
    options: { trustedKeys?: readonly string[]; now?: string } = {},
  ): AttestationVerification {
    const parsed = parseAttestation(envelopeBytes);
    if (!parsed.ok) {
      throw new Error(`parse failed: ${parsed.failure.code}`);
    }
    const replayRegistry = new InMemoryReplayRegistry();
    return verifyAttestation(parsed.attestation, {
      bindings: {
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
        attemptId: 1,
        stepId: 'fetch_issue',
      },
      freshness: {
        now: options.now ?? NOW,
        currentEpoch: EPOCH,
        expectedNonce: 'challenge-v2015cd-fetch',
        replayRegistry,
        maxAgeMs: 60 * 60 * 1000,
      },
      attesterKeyIds: options.trustedKeys ?? [attesterA.keyId],
      requiredAssurance: 'software_signed',
    });
  }

  it('admits the continuation and materializes the exact V2-016 runtime currency', async () => {
    const scope = await runningRun();
    const predecessor = signWith(predecessorStatement(scope), attesterA);
    await attach(scope.runId, predecessor, 'fetch_issue');

    // Node B receives the canonical bytes and verifies independently
    const verification = nodeBVerifies(serializeAttestation(predecessor), scope);
    expect(verification.ok).toBe(true);

    const graph = reconstructProofGraphFromRunHistory(
      (await service.getRunHistory(OWNER(), scope.runId)) as WorkflowRunHistory,
    ).graph;

    const decision = planCrossDeviceContinuation({
      graph,
      dependent: {
        stepId: 'notify_channel',
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
      },
      declaredParents: [predecessor.executionDigest.digest],
      predecessorEvidence: [{ executionDigest: predecessor.executionDigest.digest, verification }],
      trustPolicy: {
        trustedAttesterKeyIds: [attesterA.keyId],
        requiredAssurance: 'software_signed',
        now: NOW,
        currentEpoch: EPOCH,
        maxVerificationAgeMs: 10 * 60 * 1000,
      },
    });

    if (decision.continuation !== 'admitted') {
      throw new Error(`expected admitted, got ${decision.failure.code}: ${decision.failure.detail}`);
    }
    // the materialized precondition is the EXACT V2-016 currency
    expect(decision.precondition.dependentStepId).toBe('notify_channel');
    expect(decision.precondition.predecessorAttestationId).toBe(predecessor.attestationId);
    expect(decision.precondition.verifiedPredecessor.attestationId).toBe(predecessor.attestationId);
    expect(decision.precondition.causalParentDigests).toEqual([predecessor.executionDigest.digest]);
    expect(decision.precondition.runId).toBe(scope.runId);
    expect(decision.precondition.workflowVersionId).toBe(version1Id);
    expect(decision.precondition.workflowVersionSemanticDigest).toBe(scope.versionSemanticDigest);
    expect(decision.satisfiedParents).toEqual([predecessor.executionDigest.digest]);

    // compile-time pin: the materialized precondition fits the runtime's
    // resume input EXACTLY (the V2-016 surface — type-only consumption)
    expectTypeOf(decision.precondition).toEqualTypeOf<DependentStepPrecondition>();
    expectTypeOf<ResumeAfterHumanInput['preconditions']>().toEqualTypeOf<readonly DependentStepPrecondition[] | undefined>();

    // ...and the RUNTIME-PRODUCED dependent attestation folds back in
    const produced = signWith(
      producedDependentStatement(scope, predecessor.executionDigest.digest, 'challenge-v2015cd-notify'),
      attesterB,
    );
    const builder = createProofGraphBuilder({
      workflowId,
      workflowVersionId: version1Id,
      workflowVersionSemanticDigest: scope.versionSemanticDigest,
      runId: scope.runId,
    });
    for (const node of graph.nodes) {
      builder.addNode(node);
    }
    const recording = recordContinuationOutcome(builder, produced);
    expect(recording.nodeResult.kind).toBe('accepted');
    expect(recording.edgeResults).toHaveLength(1);
    expect(recording.edgeResults[0]?.kind).toBe('accepted');
    expect(recording.graph.nodes).toHaveLength(2);
    // the causal edge carries the produced statement's OWN declared parent
    expect(recording.graph.edges[0]?.parentExecutionDigest).toBe(predecessor.executionDigest.digest);
    expect(recording.graph.edges[0]?.childExecutionDigest).toBe(produced.executionDigest.digest);
  });

  it('a denial materializes NOTHING (untrusted verifier context)', async () => {
    const scope = await runningRun();
    const predecessor = signWith(predecessorStatement(scope), attesterA);
    await attach(scope.runId, predecessor, 'fetch_issue');

    // Node B does NOT trust Node A's attester key
    const verification = nodeBVerifies(serializeAttestation(predecessor), scope, { trustedKeys: [] });
    expect(verification.ok).toBe(false);

    const graph = reconstructProofGraphFromRunHistory(
      (await service.getRunHistory(OWNER(), scope.runId)) as WorkflowRunHistory,
    ).graph;
    const decision = planCrossDeviceContinuation({
      graph,
      dependent: {
        stepId: 'notify_channel',
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
      },
      declaredParents: [predecessor.executionDigest.digest],
      predecessorEvidence: [{ executionDigest: predecessor.executionDigest.digest, verification }],
      trustPolicy: {
        trustedAttesterKeyIds: [attesterA.keyId],
        requiredAssurance: 'software_signed',
        now: NOW,
        currentEpoch: EPOCH,
      },
    });
    expect(decision.continuation).toBe('denied');
    if (decision.continuation === 'denied') {
      expect(decision.failure.code).toBe('ADMISSION_PREDECESSOR_UNVERIFIED');
      expect(decision.failure.verifierFailureCode).toBe('ATTESTATION_ATTESTER_UNEXPECTED');
    }
    // the denied decision carries NO runtime currency
    expect('precondition' in decision).toBe(false);
  });

  it('a replayed predecessor at Node B\'s verifier denies the continuation (freshness/replay)', async () => {
    const scope = await runningRun();
    const predecessor = signWith(predecessorStatement(scope), attesterA);
    await attach(scope.runId, predecessor, 'fetch_issue');

    // Node B verifies the SAME envelope twice with the SAME replay registry
    const replayRegistry = new InMemoryReplayRegistry();
    const parsed = parseAttestation(serializeAttestation(predecessor));
    if (!parsed.ok) {
      throw new Error('parse failed');
    }
    const policy = {
      bindings: {
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
        attemptId: 1,
        stepId: 'fetch_issue',
      },
      freshness: {
        now: NOW,
        currentEpoch: EPOCH,
        expectedNonce: 'challenge-v2015cd-fetch',
        replayRegistry,
        maxAgeMs: 60 * 60 * 1000,
      },
      attesterKeyIds: [attesterA.keyId],
      requiredAssurance: 'software_signed' as const,
    };
    const first = verifyAttestation(parsed.attestation, policy);
    expect(first.ok).toBe(true);
    const replayed = verifyAttestation(parsed.attestation, policy);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.failure.code).toBe('ATTESTATION_REPLAYED');
    }

    const graph = reconstructProofGraphFromRunHistory(
      (await service.getRunHistory(OWNER(), scope.runId)) as WorkflowRunHistory,
    ).graph;
    const decision = planCrossDeviceContinuation({
      graph,
      dependent: {
        stepId: 'notify_channel',
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
      },
      declaredParents: [predecessor.executionDigest.digest],
      predecessorEvidence: [{ executionDigest: predecessor.executionDigest.digest, verification: replayed }],
      trustPolicy: {
        trustedAttesterKeyIds: [attesterA.keyId],
        requiredAssurance: 'software_signed',
        now: NOW,
        currentEpoch: EPOCH,
      },
    });
    expect(decision.continuation).toBe('denied');
    if (decision.continuation === 'denied') {
      expect(decision.failure.code).toBe('ADMISSION_PREDECESSOR_UNVERIFIED');
      expect(decision.failure.verifierFailureCode).toBe('ATTESTATION_REPLAYED');
    }
  });

  it('a verified fact bound to a DIFFERENT run denies the continuation (binding)', async () => {
    const scope = await runningRun();
    const other = await runningRun(); // a second, real run
    const foreign = signWith(predecessorStatement(other), attesterA);
    // the foreign attestation binds the OTHER run
    const verification = nodeBVerifies(serializeAttestation(foreign), other);
    expect(verification.ok).toBe(true);

    const graph = reconstructProofGraphFromRunHistory(
      (await service.getRunHistory(OWNER(), scope.runId)) as WorkflowRunHistory,
    ).graph;
    const decision = planCrossDeviceContinuation({
      graph,
      dependent: {
        stepId: 'notify_channel',
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
      },
      declaredParents: [foreign.executionDigest.digest],
      predecessorEvidence: [{ executionDigest: foreign.executionDigest.digest, verification }],
      trustPolicy: {
        trustedAttesterKeyIds: [attesterA.keyId],
        requiredAssurance: 'software_signed',
        now: NOW,
        currentEpoch: EPOCH,
      },
    });
    // the foreign parent is not in THIS run's graph
    expect(decision.continuation).toBe('denied');
    if (decision.continuation === 'denied') {
      expect(decision.failure.code).toBe('ADMISSION_PARENT_MISSING');
    }
  });

  it('reconnect/replay: duplicate fragment delivery converges and the run boundary refuses duplicate side effects', async () => {
    const scope = await runningRun();
    const predecessor = signWith(predecessorStatement(scope), attesterA);
    const produced = signWith(
      producedDependentStatement(scope, predecessor.executionDigest.digest, 'challenge-v2015cd-notify-dup'),
      attesterB,
    );
    await attach(scope.runId, predecessor, 'fetch_issue');
    await attach(scope.runId, produced, 'notify_channel');

    // the "reconnected" node reconstructs the graph from durable history
    const graph = reconstructProofGraphFromRunHistory(
      (await service.getRunHistory(OWNER(), scope.runId)) as WorkflowRunHistory,
    ).graph;
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);

    // duplicate delivery of the SAME fragment converges (one logical fact)
    const reconnecting = createProofGraphBuilder({
      workflowId,
      workflowVersionId: version1Id,
      workflowVersionSemanticDigest: scope.versionSemanticDigest,
      runId: scope.runId,
    });
    const first = deliverGraphFragment(reconnecting, graph);
    const second = deliverGraphFragment(reconnecting, graph);
    expect(first.converged).toBe(true);
    expect(second.converged).toBe(true);
    expect(second.nodesAccepted).toBe(0);
    expect(second.nodesDuplicated).toBe(2);
    expect(serializeProofGraph(second.graph)).toBe(serializeProofGraph(graph));

    // the run boundary refuses the DUPLICATE attach (durable single-use
    // nonce) — no duplicate side effects at the integration boundary
    await expect(attach(scope.runId, produced, 'notify_channel')).rejects.toMatchObject({
      code: 'RUN_ATTESTATION_REJECTED',
    });
    const history = await service.getRunHistory(OWNER(), scope.runId);
    expect(history.attestations).toHaveLength(2);
    expect(history.attestationRejections).toHaveLength(1);
    expect(history.attestationRejections[0]?.failureCode).toBe('ATTESTATION_REPLAYED');
  });

  it('a self-predecessor (dependent step == predecessor step) is denied structurally', async () => {
    const scope = await runningRun();
    const predecessor = signWith(predecessorStatement(scope), attesterA);
    await attach(scope.runId, predecessor, 'fetch_issue');
    const verification = nodeBVerifies(serializeAttestation(predecessor), scope);
    const graph = reconstructProofGraphFromRunHistory(
      (await service.getRunHistory(OWNER(), scope.runId)) as WorkflowRunHistory,
    ).graph;

    // the "dependent" declares ITSELF as predecessor (fetch_issue)
    const decision: CrossDeviceContinuationDecision = planCrossDeviceContinuation({
      graph,
      dependent: {
        stepId: 'fetch_issue',
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
      },
      declaredParents: [predecessor.executionDigest.digest],
      predecessorEvidence: [{ executionDigest: predecessor.executionDigest.digest, verification }],
      trustPolicy: {
        trustedAttesterKeyIds: [attesterA.keyId],
        requiredAssurance: 'software_signed',
        now: NOW,
        currentEpoch: EPOCH,
      },
    });
    expect(decision.continuation).toBe('denied');
    if (decision.continuation === 'denied') {
      expect(decision.failure.dimension).toBe('binding');
    }
  });

  it('verifies the transferred envelope in a SEPARATE PROCESS and feeds only the resulting fact into admission', async () => {
    const scope = await runningRun();
    const predecessor = signWith(predecessorStatement(scope), attesterA);
    await attach(scope.runId, predecessor, 'fetch_issue');

    // the transfer medium: canonical envelope bytes + the out-of-band
    // verifier context + a runtime-generated verifier script importing ONLY
    // the merged V2-014 public barrel (zero production context)
    const transferDir = mkdtempSync(join(tmpdir(), 'v2-015-cd-verify-'));
    const envelopeFile = join(transferDir, 'attestation-node-a.json');
    writeFileSync(envelopeFile, serializeAttestation(predecessor), 'utf8');
    const contextFile = join(transferDir, 'verifier-context.json');
    writeFileSync(contextFile, JSON.stringify({
      bindings: {
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
        attemptId: 1,
        stepId: 'fetch_issue',
      },
      freshness: { now: NOW, currentEpoch: EPOCH },
      attesterKeyIds: [attesterA.keyId],
    }), 'utf8');
    const factFile = join(transferDir, 'verified-fact.json');
    const verifierScript = join(transferDir, 'independent-verifier.mts');
    writeFileSync(verifierScript, [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'async function verify(): Promise<void> {',
      `  const barrel = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'src', 'execution-attestation', 'index.js')).href)});`,
      "  const bytes = readFileSync(process.argv[2], 'utf8');",
      "  const context = JSON.parse(readFileSync(process.argv[3], 'utf8'));",
      '  const parsed = barrel.parseAttestation(bytes);',
      '  if (!parsed.ok) { console.log(JSON.stringify({ ok: false, code: parsed.failure.code })); return; }',
      '  const verification = barrel.verifyAttestation(parsed.attestation, {',
      '    bindings: context.bindings,',
      '    freshness: { now: context.freshness.now, currentEpoch: context.freshness.currentEpoch, replayRegistry: new barrel.InMemoryReplayRegistry() },',
      '    attesterKeyIds: context.attesterKeyIds,',
      '  });',
      '  if (verification.ok) {',
      "    writeFileSync(process.argv[4], JSON.stringify(verification.fact), 'utf8');",
      "    console.log(JSON.stringify({ ok: true }));",
      '  } else {',
      '    console.log(JSON.stringify({ ok: false, code: verification.failure.code }));',
      '  }',
      '}',
      'verify().catch((error) => { console.error(String(error)); process.exit(1); });',
    ].join('\n'), 'utf8');

    const verifier = spawnSync('bunx', ['tsx', verifierScript, envelopeFile, contextFile, factFile], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(verifier.status).toBe(0);
    const outcome = JSON.parse((verifier.stdout ?? '').trim()) as { ok: boolean; code?: string };
    expect(outcome.ok).toBe(true);
    expect(existsSync(factFile)).toBe(true);

    // the fact crosses the process boundary as DATA and is the ONLY
    // admissible currency for the continuation
    const fact = JSON.parse(readFileSync(factFile, 'utf8')) as VerifiedExecutionFact;
    const graph = reconstructProofGraphFromRunHistory(
      (await service.getRunHistory(OWNER(), scope.runId)) as WorkflowRunHistory,
    ).graph;
    const decision = planCrossDeviceContinuation({
      graph,
      dependent: {
        stepId: 'notify_channel',
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
      },
      declaredParents: [fact.executionDigest.digest],
      predecessorEvidence: [{ executionDigest: fact.executionDigest.digest, verification: { ok: true, fact } }],
      trustPolicy: {
        trustedAttesterKeyIds: [attesterA.keyId],
        requiredAssurance: 'software_signed',
        now: NOW,
        currentEpoch: EPOCH,
      },
    });
    if (decision.continuation !== 'admitted') {
      throw new Error(`expected admitted, got ${decision.failure.code}: ${decision.failure.detail}`);
    }
    expect(decision.precondition.verifiedPredecessor.attestationId).toBe(predecessor.attestationId);
  });

  it('the coordination layer composes the multi-parent continuation (two verified predecessors)', async () => {
    const scope = await runningRun();
    const parentA = signWith(predecessorStatement(scope), attesterA);
    // a second predecessor on Node B's own host (a human approval step)
    const parentB = signWith(
      {
        ...predecessorStatement(scope),
        stepId: 'review_gate',
        nodeId: 'node_v2015_desktop_b',
        executionClass: 'human',
        capability: undefined,
        action: 'The human approves the triage summary (desktop host)',
        nonce: 'challenge-v2015cd-review',
        causalParents: [parentA.executionDigest.digest],
      } as ExecutionStatement,
      attesterB,
    );
    await attach(scope.runId, parentA, 'fetch_issue');
    await attach(scope.runId, parentB, 'review_gate');

    const verificationA = nodeBVerifies(serializeAttestation(parentA), scope);
    const verificationB = (() => {
      const parsed = parseAttestation(serializeAttestation(parentB));
      if (!parsed.ok) {
        throw new Error('parse failed');
      }
      return verifyAttestation(parsed.attestation, {
        bindings: {
          workflowId,
          workflowVersionId: version1Id,
          workflowVersionSemanticDigest: scope.versionSemanticDigest,
          runId: scope.runId,
          attemptId: 1,
          stepId: 'review_gate',
        },
        freshness: {
          now: NOW,
          currentEpoch: EPOCH,
          expectedNonce: 'challenge-v2015cd-review',
          replayRegistry: new InMemoryReplayRegistry(),
          maxAgeMs: 60 * 60 * 1000,
        },
        attesterKeyIds: [attesterA.keyId, attesterB.keyId],
        requiredAssurance: 'software_signed',
      });
    })();
    expect(verificationA.ok && verificationB.ok).toBe(true);

    const graph = reconstructProofGraphFromRunHistory(
      (await service.getRunHistory(OWNER(), scope.runId)) as WorkflowRunHistory,
    ).graph;
    const decision = planCrossDeviceContinuation({
      graph,
      dependent: {
        stepId: 'notify_channel',
        workflowId,
        workflowVersionId: version1Id,
        workflowVersionSemanticDigest: scope.versionSemanticDigest,
        runId: scope.runId,
      },
      declaredParents: [parentA.executionDigest.digest, parentB.executionDigest.digest].sort(),
      predecessorEvidence: [
        { executionDigest: parentA.executionDigest.digest, verification: verificationA },
        { executionDigest: parentB.executionDigest.digest, verification: verificationB },
      ],
      trustPolicy: {
        trustedAttesterKeyIds: [attesterA.keyId, attesterB.keyId],
        requiredAssurance: 'software_signed',
        now: NOW,
        currentEpoch: EPOCH,
      },
    });
    if (decision.continuation !== 'admitted') {
      throw new Error(`expected admitted, got ${decision.failure.code}: ${decision.failure.detail}`);
    }
    // the materialized currency carries BOTH parents as the declared set
    expect(decision.precondition.causalParentDigests).toEqual(
      [parentA.executionDigest.digest, parentB.executionDigest.digest].sort(),
    );
    // ...and the produced dependent binds both in its own statement
    const produced = signWith(
      producedDependentStatement(
        scope,
        // multi-parent: declare BOTH digests
        parentA.executionDigest.digest,
        'challenge-v2015cd-notify-mp',
      ),
      attesterB,
    );
    const multiParentProduced = signWith(
      {
        ...produced.statement,
        causalParents: [parentA.executionDigest.digest, parentB.executionDigest.digest].sort(),
      } as ExecutionStatement,
      attesterB,
    );
    const builder = createProofGraphBuilder({
      workflowId,
      workflowVersionId: version1Id,
      workflowVersionSemanticDigest: scope.versionSemanticDigest,
      runId: scope.runId,
    });
    for (const node of graph.nodes) {
      builder.addNode(node);
    }
    const recording = recordContinuationOutcome(builder, multiParentProduced);
    expect(recording.nodeResult.kind).toBe('accepted');
    expect(recording.edgeResults).toHaveLength(2);
    expect(recording.edgeResults.every((r) => r.kind === 'accepted')).toBe(true);
    void produced;
  });
});
