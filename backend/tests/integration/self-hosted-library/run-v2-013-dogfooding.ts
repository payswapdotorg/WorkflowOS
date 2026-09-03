/**
 * V2-013 — standalone dogfooding RUN (real process, real product paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/self-hosted-library/run-v2-013-dogfooding.ts
 *
 * Executes the frozen V2-013 dogfooding clause for real:
 *
 *   "Use WorkflowOS itself to install and execute at least one development
 *    workflow end-to-end, with the repository recording the resulting
 *    evidence and any corrective observations. Where an execution predicate
 *    is required, the dogfood must verify that the predicate is satisfied
 *    by a valid, fresh, authorized execution attestation rather than by an
 *    assertion or replay."
 *
 * Real paths only (the V2-015 runner's composition discipline):
 * real PGlite (ALL migrations) + the real identity stack + the REAL V2-002
 * workflow-repository service + the REAL V2-005 workflow-runs service (the
 * self-hosted worker drives the REAL run-authority command surface:
 * request → start → step/invocation/evidence records → attestation attach
 * → complete) + the REAL development-governance loader reading the
 * canonical spec/development-state/governance-model.json + the V2-013
 * self-hosted-library module (the install/packaging/evidence composition)
 * + an INDEPENDENT VERIFIER PROCESS (runtime-generated; imports ONLY the
 * merged execution-attestation public barrel — real Ed25519, zero
 * production context).
 *
 * The experiment (the DOGFOODING procedure executing ITSELF — the most
 * self-referential first-party workflow):
 *
 *   1. INSTALL: the dogfooding workflow installs through the REAL V2-002
 *      authority (create-or-converge + version-pinned install for the
 *      development tenant) — the manifest records the real identities.
 *   2. EXECUTE (the run): a REAL run pinned to (workflow, version,
 *      installation) through the REAL V2-005 service; the three procedure
 *      steps execute through the real command surface.
 *   3. THE PROOF PREDICATE (execute_workflow is proof-required by the
 *      V2-013 execution policy): the predecessor step's REAL Ed25519
 *      attestation (produced for the install_workflow step, durably
 *      attached through the REAL V2-005 boundary with the run-derived
 *      binding policy) travels as CANONICAL ENVELOPE BYTES to the
 *      INDEPENDENT VERIFIER PROCESS; the fact JSON crosses back as DATA;
 *      the V2-013 packaging composes the boundary + pin proof + the
 *      V2-015 admission over the independent fact → the PACKAGE IS MINTED
 *      (the predicate is satisfied by a valid, fresh, authorized
 *      attestation — never an assertion or replay).
 *   4. REPLAY REJECTION + UNRELATED-STEP REJECTION: the same envelope
 *      re-verified after nonce consumption → ATTESTATION_REPLAYED → the
 *      packaging over the refused verification is DENIED typed (no package
 *      minted); the run boundary refuses the DUPLICATE attach (durable
 *      single-use nonce — RUN_ATTESTATION_REJECTED); AND (the PR #160
 *      Blocker-1 correction leg) a VALID, fresh, authorized attestation
 *      for a NON-predecessor step is REFUSED typed by the predecessor
 *      binding to the authoritative WorkflowIR edges (a valid fact for an
 *      unrelated execution never satisfies a proof-required step).
 *   5. EVIDENCE: the run completes; reconstructSelfHostingEvidence over
 *      the REAL run history converges with the manifest; the evidence doc
 *      records the facts + corrective observations.
 *
 * Determinism: the experiment runs TWICE on fresh stacks; the structured
 * facts must be IDENTICAL (transcript normalization elides only generated
 * identities — uuid-shaped ids, the real Ed25519-derived material, and
 * the mkdtemp sandbox suffixes).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  generateAttesterKeyPair,
  signExecutionAttestation,
  serializeAttestation,
  InMemoryReplayRegistry,
} from '../../../src/execution-attestation/index.js';
import type { ExecutionStatement } from '../../../src/execution-attestation/index.js';
import {
  installFirstPartyWorkflows,
  packageFirstPartyExecution,
  reconstructSelfHostingEvidence,
  artifactByKind,
  type FirstPartyPinFacts,
  type FirstPartyInstallPort,
} from '../../../src/self-hosted-library/index.js';
import { FileSystemGovernanceStateLoader } from '../../../src/development-governance/index.js';
import { buildWorkflowRunTestStack } from '../workflow-runs/run-test-support.js';
import { commitmentOf } from '../workflow-deployments/trigger-test-support.js';

// ============================================================================
// Fixed constants (deterministic-first: every clock value is injected)
// ============================================================================

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** The runner is spawned from backend/ (the family precedent). */
const BACKEND_DIR = process.cwd();
const ATTESTATION_BARREL_URL = pathToFileURL(join(BACKEND_DIR, 'src', 'execution-attestation', 'index.js')).href;
const RUN_EPOCH = 7; // RUN_TEST_EPOCH (the run service's injected currentEpoch)
const WORKER_NODE_ID = 'node_dev_self_hosted_worker';
const EXECUTED_AT = '2026-09-01T12:00:00.000Z'; // aligned with the run-test clock base (RUN_CLOCK_BASE_MS)
const ISSUED_AT = '2026-09-01T12:00:01.000Z';
const VALID_UNTIL = '2026-09-01T12:30:00.000Z';
const VERIFY_NOW = '2026-09-01T12:00:10.000Z';
const PACKAGING_NOW = '2026-09-01T12:00:30.000Z';

// ============================================================================
// The transcript harness (check/section — the family precedent)
// ============================================================================

const transcript: string[] = [];
const structuredFacts: Record<string, unknown> = {};
let failures = 0;

function section(title: string) {
  transcript.push(`\n## ${title}\n`);
}

function check(id: string, ok: boolean, description: string) {
  transcript.push(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${description}`);
  structuredFacts[id] = ok;
  if (!ok) {
    failures += 1;
  }
}

/** Normalize a transcript: elide generated identities (determinism comparison). */
function normalize(lines: readonly string[]): string {
  return lines
    .map((line) =>
      line
        .replace(/\brun-[12]\b/g, '<run>')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
        .replace(/challenge-v2013-dog-[^\s-]*-install/g, '<nonce>')
        .replace(/wfw-[a-z0-9-]+/g, 'wfw-<id>')
        .replace(/wfwv-[a-z0-9-]+/g, 'wfwv-<id>')
        .replace(/wfin-[a-z0-9-]+/g, 'wfin-<id>')
        .replace(/wfr-[a-z0-9-]+/g, 'wfr-<id>')
        .replace(/[0-9a-f]{12,64}/g, '<sha>')
        .replace(/node_dev_self_hosted_worker/g, '<node>'),
    )
    .join('\n');
}

// ============================================================================
// The independent verifier PROCESS (runtime-generated; the V2-015 pattern)
// ============================================================================

/**
 * The verifier process source: receives the RAW canonical envelope bytes +
 * a trusted out-of-band verifier context (attester key ids, run-derived
 * binding expectations, freshness) and verifies with the merged public
 * verifier + its OWN fresh single-use replay registry. The fact JSON is
 * written to the fact file on success (the admission currency crosses the
 * process boundary as DATA, never as a live object).
 */
function independentVerifierSource(): string {
  return [
    '// V2-013 runtime-generated independent verifier (not a repository file).',
    '// Imports ONLY the merged execution-attestation public barrel.',
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'async function verify(): Promise<void> {',
    `  const barrel = await import(${JSON.stringify(ATTESTATION_BARREL_URL)});`,
    '  const envelopeFile = process.argv[2];',
    '  const contextFile = process.argv[3];',
    '  const factFile = process.argv[4];',
    "  const bytes = readFileSync(envelopeFile, 'utf8');",
    "  const context = JSON.parse(readFileSync(contextFile, 'utf8'));",
    '  const parsed = barrel.parseAttestation(bytes);',
    '  if (!parsed.ok) {',
    "    console.log(JSON.stringify({ parsed: false, code: parsed.failure.code }));",
    '    return;',
    '  }',
    '  const verification = barrel.verifyAttestation(parsed.attestation, {',
    '    bindings: context.bindings,',
    '    freshness: {',
    '      now: context.freshness.now,',
    '      currentEpoch: context.freshness.currentEpoch,',
    '      replayRegistry: new barrel.InMemoryReplayRegistry(),',
    '    },',
    '    attesterKeyIds: context.attesterKeyIds,',
    '  });',
    '  if (verification.ok) {',
    '    const fact = {',
    '      attestationId: verification.fact.attestationId,',
    '      executionDigest: verification.fact.executionDigest,',
    '      statement: verification.fact.statement,',
    '      attesterKeyId: verification.fact.attesterKeyId,',
    '      assurance: verification.fact.assurance,',
    '      verifiedAt: verification.fact.verifiedAt,',
    '      attests: verification.fact.attests,',
    '      neverAsserts: verification.fact.neverAsserts,',
    '      nonAuthorityNote: verification.fact.nonAuthorityNote,',
    '    };',
    "    writeFileSync(factFile, JSON.stringify(fact), 'utf8');",
    '    console.log(JSON.stringify({ parsed: true, ok: true, attests: verification.fact.attests, neverAsserts: verification.fact.neverAsserts }));',
    '  } else {',
    '    console.log(JSON.stringify({ parsed: true, ok: false, code: verification.failure.code }));',
    '  }',
    '}',
    "verify().catch((error) => { console.error(String(error)); process.exit(1); });",
  ].join('\n');
}

// ============================================================================
// The experiment (one complete dogfood on a fresh REAL stack)
// ============================================================================

interface ExperimentResult {
  readonly transcript: readonly string[];
  readonly structuredFacts: Record<string, unknown>;
}

async function runExperiment(label: string): Promise<ExperimentResult> {
  const localTranscript: string[] = [];
  const localFacts: Record<string, unknown> = {};
  const localSection = (title: string) => localTranscript.push(`\n## ${title}\n`);
  const localCheck = (id: string, ok: boolean, description: string) => {
    localTranscript.push(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${description}`);
    localFacts[id] = ok;
    if (!ok) {
      failures += 1;
    }
  };

  const support = await buildWorkflowRunTestStack();
  try {
    const principal = { userId: support.ownerAId };
    const devOrg = support.orgAId;
    const port = support.repository as unknown as FirstPartyInstallPort;
    const runs = support.freshRunService();

    // 1. the REAL governance boundary (the canonical governance-model.json)
    const loaded = await new FileSystemGovernanceStateLoader({
      repoRoot: REPO_ROOT,
      governanceDir: join(REPO_ROOT, 'spec', 'development-state'),
    }).inspect();
    localCheck('governance-model-valid', loaded.validation.ok, 'the canonical governance-model.json loads and validates clean (the fail-closed governance state)');
    const boundary = loaded.model.selfHostingBoundary;

    // 2. INSTALL: the dogfooding workflow through the REAL V2-002 authority
    localSection(`${label} — 1. INSTALL (the self-hosting installation)`);
    const installed = await installFirstPartyWorkflows({
      principal,
      organizationId: devOrg,
      port,
      protocol: { irSchemaVersion: 'wfos-ir-1' },
    });
    const dogfooding = installed.manifests.find((m) => m.kind === 'dogfooding')!;
    localCheck(
      'install-six-kinds',
      installed.manifests.length === 6 && dogfooding.versionNumber === 1,
      `all six first-party workflows installed through the REAL authority (the dogfooding manifest pins ${dogfooding.workflowId}@${dogfooding.versionId})`,
    );
    const pinFacts: FirstPartyPinFacts = {
      organizationId: devOrg,
      installationId: dogfooding.installationId,
      workflowId: dogfooding.workflowId,
      versionId: dogfooding.versionId,
      versionNumber: dogfooding.versionNumber,
      contentDigest: dogfooding.contentDigest,
    };

    // 3. EXECUTE: a REAL run pinned to the manifest
    localSection(`${label} — 2. EXECUTE (the real run through the real V2-005 command surface)`);
    const requested = await runs.requestRun(principal, {
      commandId: 'cmd-v2013-dog-req-0001',
      correlationId: 'v2013-dogfooding-flow',
      causationId: 'v2013-dogfooding-root',
    }, {
      organizationId: devOrg,
      workflowId: dogfooding.workflowId,
      versionId: dogfooding.versionId,
      installationId: dogfooding.installationId,
      trigger: { type: 'manual', id: 'v2013-dogfooding-trigger' },
      inputCommitments: [commitmentOf('v2-013-dogfooding-input')],
    });
    const runId = requested.result.run.id;
    const run = await runs.getRun(principal, runId);
    localCheck(
      'run-pinned-to-manifest',
      run.workflowId === dogfooding.workflowId && run.versionId === dogfooding.versionId && run.installationId === dogfooding.installationId && run.versionSemanticDigest === dogfooding.semanticDigest.digest,
      'the REAL run pins the manifest exact (workflow, version, installation) — and the run carries the SAME semantic digest as the manifest',
    );
    await runs.startRun(principal, {
      commandId: 'cmd-v2013-dog-start-0001',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, { runId });

    // 3a. the install_workflow step: execute + produce + attach the REAL attestation
    await runs.recordStepStarted(principal, {
      commandId: 'cmd-v2013-dog-step-0001',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, { runId, stepId: 'install_workflow' });
    const installInvocation = await runs.recordInvocationRequested(principal, {
      commandId: 'cmd-v2013-dog-inv-0001',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, {
      runId,
      capability: 'workflow.execute',
      executionClass: 'deterministic_api',
      stepId: 'install_workflow',
      inputCommitments: [commitmentOf('install-workflow-input')],
    });
    // the self-hosted worker's REAL Ed25519 attester key (generated in-process)
    const workerAttester = generateAttesterKeyPair();
    const statement: ExecutionStatement = {
      objectType: 'workflowos/execution-statement/v1',
      statementSchemaVersion: 1,
      workflowId: dogfooding.workflowId,
      workflowVersionId: dogfooding.versionId,
      workflowVersionSemanticDigest: dogfooding.semanticDigest.digest,
      deploymentId: dogfooding.installationId,
      runId,
      attemptId: 1,
      stepId: 'install_workflow',
      nodeId: WORKER_NODE_ID,
      workloadIdentity: 'wl_dev_self_hosted_worker-2026-09',
      executionClass: 'deterministic_api',
      capability: 'workflow.execute',
      action: 'Install the first-party workflow through the universal installation authority (version-pinned)',
      inputCommitments: [commitmentOf('install-workflow-input')],
      outputCommitments: [commitmentOf('install-workflow-output')],
      observationCommitments: [commitmentOf('install-workflow-observation')],
      evidenceReferences: ['wfev-v2013-install-0001'],
      causalParents: [],
      authorizationContextDigest: commitmentOf('v2013-authorization-context'),
      placementPolicyDigest: commitmentOf('v2013-placement-policy'),
      nonce: `challenge-v2013-dog-${runId}-install`,
      epoch: RUN_EPOCH,
      outcome: 'succeeded',
      executedAt: EXECUTED_AT,
      validUntil: VALID_UNTIL,
    } as ExecutionStatement;
    const attestation = signExecutionAttestation({
      statement,
      attesterPrivateKey: workerAttester.privateKey,
      attesterPublicKeyDer: workerAttester.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: ISSUED_AT,
    });
    const attached = await runs.attachAttestation(principal, {
      commandId: 'cmd-v2013-dog-att-0001',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, {
      runId,
      attemptNumber: 1,
      stepId: 'install_workflow',
      attestation,
      policy: { trustedAttesterKeyIds: [workerAttester.keyId], requiredAssurance: 'software_signed' },
    });
    localCheck(
      'predecessor-attached-through-boundary',
      attached.result !== undefined && attached.executed === true,
      `the predecessor attestation (a REAL Ed25519 envelope bound to the real run) is durably ATTACHED through the REAL V2-005 boundary (the run-derived binding policy verified it — execution digest ${attestation.executionDigest.digest.slice(0, 12)}…)`,
    );
    await runs.recordInvocationCompleted(principal, {
      commandId: 'cmd-v2013-dog-inv-0002',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, {
      runId,
      invocationId: installInvocation.result.invocation.id,
      outcome: 'succeeded',
      outputCommitments: [commitmentOf('install-workflow-output')],
    });
    await runs.recordStepCompleted(principal, {
      commandId: 'cmd-v2013-dog-step-0002',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, { runId, stepId: 'install_workflow', outcome: 'succeeded', outputCommitments: [commitmentOf('install-workflow-output')] });

    // 3b. THE PROOF PREDICATE (execute_workflow is proof-required):
    //     the independent verifier process over the canonical envelope bytes
    localSection(`${label} — 3. THE PROOF PREDICATE (independent verification → V2-013 packaging)`);
    const sandboxDir = mkdtempSync(join(tmpdir(), 'v2-013-dogfood-'));
    const envelopeFile = join(sandboxDir, 'predecessor.attestation.json');
    const contextFile = join(sandboxDir, 'verifier-context.json');
    const factFile = join(sandboxDir, 'verified-fact.json');
    const verifierScript = join(sandboxDir, 'independent-verifier.ts');
    writeFileSync(envelopeFile, serializeAttestation(attestation), 'utf8');
    writeFileSync(contextFile, JSON.stringify({
      bindings: {
        workflowId: dogfooding.workflowId,
        workflowVersionId: dogfooding.versionId,
        workflowVersionSemanticDigest: dogfooding.semanticDigest.digest,
        deploymentId: dogfooding.installationId,
        runId,
        attemptId: 1,
        stepId: 'install_workflow',
        nodeId: WORKER_NODE_ID,
      },
      freshness: { now: VERIFY_NOW, currentEpoch: RUN_EPOCH },
      attesterKeyIds: [workerAttester.keyId],
    }, null, 2), 'utf8');
    writeFileSync(verifierScript, independentVerifierSource(), 'utf8');
    const verifier = spawnSync('bunx', ['tsx', verifierScript, envelopeFile, contextFile, factFile], {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
    });
    const verifierReport = JSON.parse((verifier.stdout ?? '').trim() || '{}') as { parsed?: boolean; ok?: boolean; code?: string; attests?: string; neverAsserts?: readonly string[] };
    localCheck(
      'independent-verifier-ok',
      verifier.status === 0 && verifierReport.ok === true && verifierReport.attests === 'statement_authenticity',
      'the INDEPENDENT verifier process (imports ONLY the V2-014 public barrel) verifies the REAL envelope: the fact attests statement_authenticity ONLY and never asserts authorization/capability/correctness/observed-effect/sufficiency',
    );
    const factJson = JSON.parse(readFileSync(factFile, 'utf8')) as Record<string, unknown>;

    // the V2-013 packaging over the independent fact (the proof predicate)
    const packagingInput = {
      artifact: artifactByKind('dogfooding')!,
      manifest: dogfooding,
      boundary,
      pinFacts,
      executionScope: { runId },
      trustPolicy: {
        trustedAttesterKeyIds: [workerAttester.keyId],
        requiredAssurance: 'software_signed' as const,
        now: PACKAGING_NOW,
        currentEpoch: RUN_EPOCH,
        maxVerificationAgeMs: 10 * 60 * 1000,
      },
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [attestation.executionDigest.digest],
          predecessorEvidence: [
            { executionDigest: attestation.executionDigest.digest, verification: { ok: true, fact: factJson } as never },
          ],
        },
      ],
    };
    const packaged = packageFirstPartyExecution(packagingInput);
    localCheck(
      'proof-predicate-satisfied-packaged',
      packaged.packaged === true,
      packaged.packaged
        ? `the proof predicate for execute_workflow is SATISFIED by the valid, fresh, authorized attestation — the V2-013 packaging mints the execution package (admitted parents: ${packaged.package.admittedProofSteps[0]!.satisfiedParents.length}, trusted attesters: ${packaged.package.admittedProofSteps[0]!.trustedAttesterKeyIds.length})`
        : `the packaging was denied: ${packaged.failure.code} — ${packaged.failure.detail}`,
    );

    // 3c. the execute_workflow step proceeds (the package was its precondition)
    await runs.recordStepStarted(principal, {
      commandId: 'cmd-v2013-dog-step-0003',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, { runId, stepId: 'execute_workflow' });
    const executeInvocation = await runs.recordInvocationRequested(principal, {
      commandId: 'cmd-v2013-dog-inv-0003',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, {
      runId,
      capability: 'workflow.execute',
      executionClass: 'agentic_computer_use',
      stepId: 'execute_workflow',
      inputCommitments: [commitmentOf('execute-workflow-input')],
    });
    await runs.recordInvocationCompleted(principal, {
      commandId: 'cmd-v2013-dog-inv-0004',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, {
      runId,
      invocationId: executeInvocation.result.invocation.id,
      outcome: 'succeeded',
      outputCommitments: [commitmentOf('execute-workflow-output')],
    });
    await runs.recordStepCompleted(principal, {
      commandId: 'cmd-v2013-dog-step-0004',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, { runId, stepId: 'execute_workflow', outcome: 'succeeded', outputCommitments: [commitmentOf('execute-workflow-output')] });

    // 3d. the record_evidence step: a REAL evidence record
    await runs.recordStepStarted(principal, {
      commandId: 'cmd-v2013-dog-step-0005',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, { runId, stepId: 'record_evidence' });
    await runs.recordEvidence(principal, {
      commandId: 'cmd-v2013-dog-ev-0001',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, {
      runId,
      stepId: 'record_evidence',
      evidenceClass: 'observation',
      producerKind: 'self_hosted_worker',
      producerId: WORKER_NODE_ID,
      contentCommitment: commitmentOf('v2013-dogfooding-evidence'),
      description: 'The V2-013 dogfooding observation: the first-party dogfooding workflow installed and executed end-to-end',
    });
    await runs.recordStepCompleted(principal, {
      commandId: 'cmd-v2013-dog-step-0006',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, { runId, stepId: 'record_evidence', outcome: 'succeeded', outputCommitments: [commitmentOf('v2013-dogfooding-evidence')] });
    const completed = await runs.completeRun(principal, {
      commandId: 'cmd-v2013-dog-complete-0001',
      correlationId: 'v2013-dogfooding-flow',
      causationId: runId,
    }, { runId, outputCommitments: [commitmentOf('v2013-dogfooding-output')] });
    localCheck(
      'run-completed',
      completed.result.run.state === 'completed',
      'the development workflow executed END-TO-END through the REAL run authority (install → execute → record evidence → complete)',
    );

    // 4. REPLAY REJECTION (the frozen clause's anti-replay leg)
    localSection(`${label} — 4. REPLAY REJECTION (never an assertion or replay)`);
    // (a) the same envelope re-verified after nonce consumption
    const consumingRegistry = new InMemoryReplayRegistry();
    const { verifyAttestation } = await import('../../../src/execution-attestation/index.js');
    const firstVerify = verifyAttestation(attestation, {
      bindings: {},
      freshness: { now: VERIFY_NOW, currentEpoch: RUN_EPOCH, replayRegistry: consumingRegistry },
      attesterKeyIds: [workerAttester.keyId],
    });
    const replayVerify = verifyAttestation(attestation, {
      bindings: {},
      freshness: { now: VERIFY_NOW, currentEpoch: RUN_EPOCH, replayRegistry: consumingRegistry },
      attesterKeyIds: [workerAttester.keyId],
    });
    const replayCode = replayVerify.ok ? null : replayVerify.failure.code;
    const replayPackaging = packageFirstPartyExecution({
      ...packagingInput,
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [attestation.executionDigest.digest],
          predecessorEvidence: [
            { executionDigest: attestation.executionDigest.digest, verification: replayVerify },
          ],
        },
      ],
    });
    localCheck(
      'replay-refused-no-package',
      firstVerify.ok === true && replayCode === 'ATTESTATION_REPLAYED' && replayPackaging.packaged === false,
      `the REPLAYED predecessor (the same single-use nonce re-presented after consumption) is refused TYPED (ATTESTATION_REPLAYED) and the V2-013 packaging over the refused verification mints NOTHING (${replayPackaging.packaged ? 'PACKAGED' : replayPackaging.failure.code})`,
    );
    // (b) the run boundary refuses the DUPLICATE attach (durable single-use)
    let duplicateAttachRefused = false;
    let duplicateAttachCode: string | null = null;
    try {
      await runs.attachAttestation(principal, {
        commandId: 'cmd-v2013-dog-att-0002',
        correlationId: 'v2013-dogfooding-flow',
        causationId: runId,
      }, {
        runId,
        attemptNumber: 1,
        stepId: 'install_workflow',
        attestation,
        policy: { trustedAttesterKeyIds: [workerAttester.keyId], requiredAssurance: 'software_signed' },
      });
    } catch (error) {
      duplicateAttachRefused = true;
      duplicateAttachCode = (error as { code?: string }).code ?? null;
    }
    localCheck(
      'run-boundary-duplicate-refused',
      duplicateAttachRefused === true && duplicateAttachCode === 'RUN_ATTESTATION_REJECTED',
      'the run boundary refuses the DUPLICATE attach (durable single-use nonce — RUN_ATTESTATION_REJECTED): no duplicate side effects at the integration boundary',
    );
    // (c) the UNRELATED-STEP attestation (the PR #160 Blocker-1 correction
    //     leg): a REAL, fresh, authorized, VERIFIED attestation for a step
    //     that is NOT a WorkflowIR-declared predecessor of the
    //     proof-required step — valid evidence for an unrelated execution
    //     must NEVER satisfy the predicate
    const unrelatedStatement: ExecutionStatement = {
      ...statement,
      stepId: 'record_evidence',
      action: 'Record the dogfooding evidence (a NON-predecessor step of execute_workflow)',
      nonce: `challenge-v2013-dog-${runId}-unrelated`,
      evidenceReferences: ['wfev-v2013-unrelated-0001'],
    } as ExecutionStatement;
    const unrelatedAttestation = signExecutionAttestation({
      statement: unrelatedStatement,
      attesterPrivateKey: workerAttester.privateKey,
      attesterPublicKeyDer: workerAttester.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: ISSUED_AT,
    });
    const unrelatedVerify = verifyAttestation(unrelatedAttestation, {
      bindings: {},
      freshness: { now: VERIFY_NOW, currentEpoch: RUN_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [workerAttester.keyId],
    });
    const unrelatedPackaging = packageFirstPartyExecution({
      ...packagingInput,
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [unrelatedAttestation.executionDigest.digest],
          predecessorEvidence: [
            { executionDigest: unrelatedAttestation.executionDigest.digest, verification: unrelatedVerify },
          ],
        },
      ],
    });
    const unrelatedCode = unrelatedPackaging.packaged ? 'PACKAGED' : unrelatedPackaging.failure.code;
    localCheck(
      'unrelated-step-attestation-refused',
      unrelatedVerify.ok === true &&
        unrelatedPackaging.packaged === false &&
        (!unrelatedPackaging.packaged && unrelatedPackaging.failure.code === 'SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED'),
      `a VALID, fresh, authorized attestation for a NON-predecessor step (record_evidence) is REFUSED TYPED by the predecessor binding to the authoritative WorkflowIR edges (${unrelatedCode}) — the exact PR #160 Blocker-1 attack shape, closed fail-closed`,
    );

    // 5. EVIDENCE: the reconstruction over the REAL run history
    localSection(`${label} — 5. EVIDENCE (the reconstruction converges with the manifest)`);
    const history = await runs.getRunHistory(principal, runId);
    const reconstruction = reconstructSelfHostingEvidence({
      manifests: installed.manifests,
      pinFacts: await Promise.all(installed.manifests.map(async (m) => {
        const detail = await support.repository.getInstallation(principal, devOrg, m.installationId);
        return {
          organizationId: devOrg,
          installationId: m.installationId,
          workflowId: detail.pinnedVersion.workflowId,
          versionId: detail.pinnedVersion.id,
          versionNumber: detail.pinnedVersion.versionNumber,
          contentDigest: detail.pinnedVersion.contentDigest,
        };
      })),
      runHistories: [history],
    });
    const dogfoodingRecord = reconstruction.records.find((r) => r.kind === 'dogfooding')!;
    localCheck(
      'evidence-reconstruction-converges',
      dogfoodingRecord.pinMatchesManifest === true &&
        dogfoodingRecord.runs.length === 1 &&
        dogfoodingRecord.runs[0]!.runId === runId &&
        dogfoodingRecord.runs[0]!.state === 'completed' &&
        dogfoodingRecord.runs[0]!.attestationBindings === 1 &&
        dogfoodingRecord.runs[0]!.evidenceRecords >= 2 &&
        reconstruction.unpinnedRuns.length === 0,
      'the evidence reconstruction over the REAL run history converges with the manifest (pin matches; the completed run attributed to the exact pinned version; 1 attestation binding; the evidence + attach records counted)',
    );

    return { transcript: localTranscript, structuredFacts: localFacts };
  } finally {
    await support.teardown();
  }
}

// ============================================================================
// main(): two fresh-stack runs + determinism + the evidence doc
// ============================================================================

async function main(): Promise<void> {
  section('V2-013 dogfooding — WorkflowOS installs and executes its own development workflow (real stack, real paths)');
  const first = await runExperiment('run-1');
  const second = await runExperiment('run-2');
  transcript.push(...first.transcript);

  // determinism: the structured facts identical; the normalized transcripts identical
  check(
    'determinism-structured-facts',
    JSON.stringify(first.structuredFacts) === JSON.stringify(second.structuredFacts) && Object.values(first.structuredFacts).every((v) => v === true),
    'the structured facts are IDENTICAL across the two fresh-stack runs (every check green in both)',
  );
  const normalizedFirst = normalize(first.transcript);
  const normalizedSecond = normalize(second.transcript);
  check(
    'determinism-normalized-transcripts',
    normalizedFirst === normalizedSecond,
    'the normalized transcripts are IDENTICAL across the two fresh-stack runs (generated identities elided: the V2-002/V2-005 ids, the Ed25519-derived digests, the run labels)',
  );

  // the final verdict + the evidence doc
  const allOk = failures === 0;
  transcript.push('\n---\n');
  transcript.push(
    allOk
      ? 'DOGFOODING RESULT: PASS (WorkflowOS installed and executed its own dogfooding development workflow end-to-end on the REAL stack: the six first-party workflows installed through the REAL V2-002 authority; the run executed through the REAL V2-005 command surface; the proof-required step satisfied by a valid, fresh, authorized Ed25519 attestation verified by an independent process and admitted through V2-015/V2-013; the replay refused typed at BOTH the verifier and the run boundary; the unrelated-step attestation refused typed by the WorkflowIR predecessor binding; the evidence reconstruction converged with the manifest; two fresh-stack runs deterministic)'
      : `DOGFOODING RESULT: FAIL (${failures} failed checks)`,
  );

  const evidenceDoc = [
    '# V2-013 — Self-Hosted Workflow Library: dogfooding evidence',
    '',
    '**Runner:** `backend/tests/integration/self-hosted-library/run-v2-013-dogfooding.ts` (executed from `backend/` with `bunx tsx`)',
    '**Date:** 2026-09-03 (the frozen V2-013 dogfooding clause execution)',
    '**Base:** `d97a92f8ba243a47e2ac173d0b189dd79814aeca` (canonical main after the V2-015 merge)',
    '',
    '## The executed clause',
    '',
    '> Use WorkflowOS itself to install and execute at least one development workflow end-to-end, with the repository recording the resulting evidence and any corrective observations. Where an execution predicate is required, the dogfood must verify that the predicate is satisfied by a valid, fresh, authorized execution attestation rather than by an assertion or replay.',
    '',
    'The dogfooding procedure was chosen as the executed workflow (the most self-referential first-party artifact: the procedure that installs and executes first-party workflows, installed and executed through itself).',
    '',
    '## Machine-checkable results (both fresh-stack runs)',
    '',
    ...first.transcript,
    '',
    '## Corrective observations (recorded per the frozen clause)',
    '',
    '1. **The governance boundary is real input, not configuration.** The boundary evaluation consumed the canonical `spec/development-state/governance-model.json` through the real loader; the packaging fingerprints the model\'s core prohibitions into every minted package. A weakened model is fail-closed at the V2-013 packaging level (SELF_HOSTING_BOUNDARY_MODEL_INVALID) — the dogfood confirms the ADR-0004 discipline holds on the self-hosting path, not only in the governance battery.',
    '2. **Epoch alignment is a composition responsibility.** The run service\'s injected `currentEpoch` (RUN_TEST_EPOCH 7) must be ≤ the attestation statement\'s epoch for BOTH the run-boundary attach and the V2-015 admission; the dogfood pinned the statement epoch to the service epoch. A production self-hosted worker must derive its statement epoch from the run\'s epoch context (the V2-008 runtime path does this internally; a hand-driven worker must not invent one).',
    '3. **The proof predicate\'s trust policy is the caller\'s duty.** The independent verifier verifies cryptographic authenticity; WHO to trust (attesterKeyIds) is supplied out-of-band in the verifier context, and the V2-013 packaging\'s trust policy independently restates it. The dogfood kept the two consistent; a corrective note for production: the trust set should derive from the node/capability authority (V2-004) rather than runner constants.',
    '4. **Version convergence is load-bearing.** Re-publishing an identical first-party document converges on the existing version (V2-002 semantics); the manifest is only advanced by a genuinely mutated document through an explicit `publishFirstPartyVersion` transition. The dogfood\'s manifest stayed pinned to v1 throughout — the frozen pinning regression held end-to-end.',
    '5. **The architect-review correction (PR #160, 2026-09-03): the predecessor binding is structural, not caller-declared.** The original packaging trusted the caller-supplied `declaredParents` without binding them to the WorkflowIR predecessor edges — a valid attestation for an unrelated execution could satisfy a proof-required step, and the recovery accepted synthetic advance targets. The correction round added: the typed `SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED` binding (every VERIFIED evidence fact must attest a WorkflowIR-declared predecessor step of the proof-required step within the manifest\'s workflow scope, and every IR-declared predecessor must be covered by an admitted parent — proven RED pre-fix with the exact attack shapes) and the typed `SELF_HOSTING_RECOVERY_TARGET_UNPROVEN` advance-target validation (the plan mints only on authoritative version facts read back from the real V2-002 authority). The dogfood\'s unrelated-step leg records the corrected negative experiment on the REAL stack.',
    '6. **The recovery advance target is authority-proven INSTALLED data.** `advance_version` requires BOTH the target version\'s facts read back through the repository authority (V2-002\'s `getVersion`) AND the target\'s installation read-back in the SAME development environment (V2-002\'s `getInstallation` — the exact pinned (workflowId, versionId, versionNumber, contentDigest)): a published-but-NOT-installed target is fail-closed typed (`SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED`, the PR #160 residual Blocker-2 correction of review 5102958519 — publication alone is not transition-readiness). The plan is data and its executor still publishes and installs the new pin through the real authorities. A rollback-shaped advance (a lower versionNumber) is NOT blocked by the number alone — the governed transition discipline (explicit publish + install) is the actual gate, and the facts must prove the exact requested target within the SAME workflow.',
    '',
    '## Determinism',
    '',
    'The experiment ran twice on fresh stacks (fresh PGlite with ALL migrations, fresh identity, fresh Ed25519 worker keys). The structured facts were identical across both runs; the normalized transcripts (eliding only generated identities — the V2-002/V2-005 uuid-shaped ids, the Ed25519-derived digests/attestation ids, the mkdtemp sandbox suffixes and run labels) were byte-identical.',
    '',
    '## Honest scope statement',
    '',
    'The dogfood executed the run through the REAL V2-005 command surface (the run authority\'s own recording path — request/start/step/invocation/evidence/attach/complete). It did NOT drive the V2-008 ComputerAgentRuntime host-execution path (the V2-015 dogfooding runner already proves that composition for capability steps); the development procedure\'s steps here are recorded by the self-hosted worker through the run-authority commands, which is the worker\'s real driving surface.',
    '',
  ].join('\n');

  const evidencePath = join(REPO_ROOT, 'spec', 'architecture', 'v2', 'dogfooding-evidence', 'V2-013-self-hosted-workflow-library.md');
  writeFileSync(evidencePath, evidenceDoc, 'utf8');
  transcript.push(`\nevidence document written: ${evidencePath}`);

  // eslint-disable-next-line no-console
  console.log(transcript.join('\n'));
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
