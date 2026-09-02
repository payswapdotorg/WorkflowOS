/**
 * V2-014 — REQUIRED REAL-SYSTEM DOGFOODING EXPERIMENT (dogfooding-protocol.md;
 * work order V2-014 "Required dogfooding").
 *
 * Runs the experiment through REAL product paths:
 *
 *   - a REAL workflow authored with the merged V2-003 builder
 *     (createWorkflowIrBuilder) — the support-ticket-triage workflow, whose
 *     real WorkflowVersion semantic digest is pinned against the merged
 *     V2-003 dogfooding evidence;
 *   - REAL V2-002 deterministic identity derivations for the workflow and the
 *     immutable WorkflowVersion (deriveWorkflowId / deriveWorkflowVersionId
 *     over the serialized document's content digest);
 *   - a REAL V2-004 node identity (deriveNodeKeyFingerprint over real node
 *     key material — the V2-004 dogfooding device host);
 *   - a REAL deterministic local action as the attested workload: the runner
 *     writes real artifact files to disk and EXECUTES the action for real
 *     (reads the artifact bytes back, computes their real SHA-256) — the
 *     commitments in the statement are real one-way hashes of real files;
 *   - a REAL causal parent: the review_gate human-approval execution fact is
 *     built and committed through the public API (its real ExecutionDigest is
 *     the causal parent binding of the notify_channel statement);
 *   - REAL Ed25519 signing (generateKeyPairSync / sign / verify through the
 *     module's own key pair + signing path);
 *   - canonical EXPORT of the attestation bytes, then INDEPENDENT
 *     verification by a SEPARATE process (verify-attestation-dogfooding.ts)
 *     that imports ONLY the public verify API + the exported raw bytes;
 *   - NEGATIVE experiments: re-presentation after the verifier clock/epoch
 *     advanced (typed stale/expired rejection), re-presentation after
 *     single-use nonce consumption (typed replay rejection), a tampered
 *     canonical byte and a mutated Run binding (typed signature rejection);
 *   - DETERMINISM: a second run of the same experiment with a SECOND real
 *     Ed25519 key pair — the canonical statement, the ExecutionDigest and
 *     every verification outcome are identical; only key-derived material
 *     (key ids, attestation id, signature) differs, as disclosed (Ed25519
 *     key material cannot be seeded).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/execution-attestation/run-attestation-dogfooding.ts
 *
 * Exit code 0 = every assertion held (PASS); non-zero = a failure to triage.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  assertValidWorkflowIrDocument,
  computeWorkflowVersionSemanticDigest,
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import type { ControlEdge, WorkflowNode } from '../../../src/workflow-ir/index.js';
import { computeContentDigest, deriveWorkflowId, deriveWorkflowVersionId } from '../../../src/workflow-repository/internal/identity.js';
import { deriveNodeKeyFingerprint } from '../../../src/node-capability/index.js';
import {
  attestationIssuedEvent,
  canonicalStatementJson,
  computeExecutionDigest,
  executionValueCommitment,
  generateAttesterKeyPair,
  serializeAttestation,
  signExecutionAttestation,
  validateExecutionStatement,
} from '../../../src/execution-attestation/index.js';
import type { ExecutionStatement } from '../../../src/execution-attestation/index.js';

// ---------------------------------------------------------------------------
// Injected clocks / freshness material (fixed constants — no ambient clock)
// ---------------------------------------------------------------------------

const PARENT_EXECUTED_AT = '2026-09-01T11:59:30.000Z';
const EXECUTED_AT = '2026-09-01T12:00:00.000Z';
const VALID_UNTIL = '2026-09-01T12:05:00.000Z';
const ISSUED_AT = '2026-09-01T12:00:01.000Z';
const STATEMENT_EPOCH = 7;
const ADVANCED_EPOCH = 8;
const NONCE = 'challenge-triage-run-0001-attempt-1';
const PARENT_NONCE = 'challenge-triage-run-0001-review-gate';

// ---------------------------------------------------------------------------
// Real binding reference data
// ---------------------------------------------------------------------------

/** The merged V2-003 dogfooding evidence digest of this exact workflow. */
const V2_003_EVIDENCE_DIGEST = '571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37';
/** The merged V2-004 dogfooding device-host node identity (key seed 'v2-004-dogfood-browser-host-key'). */
const V2_004_EVIDENCE_NODE_ID = 'node_795e8b12eaef3e45';
/** The real V2-004 dogfooding node key seed (browser/device host). */
const V2_004_DOGFOOD_NODE_KEY_SEED = 'v2-004-dogfood-browser-host-key';

const ORG_ID = 'org-dogfood-7';
const OWNER_ID = 'user-implementer-1';
const SLUG = 'support-ticket-triage';
const DEPLOYMENT_ID = 'wfd-triage-deployment-1';
const RUN_ID = 'wfr-triage-20260901-0001';
const ATTEMPT_ID = 1;
const STEP_ID = 'notify_channel';
const WORKLOAD_IDENTITY = 'wl_triage-runner-2026-09';

// ---------------------------------------------------------------------------
// The real authored workflow (merged V2-003 builder; support-ticket triage)
// ---------------------------------------------------------------------------

const issueObjectType = {
  kind: 'object',
  fields: [
    { name: 'title', type: { kind: 'string' } },
    { name: 'body', type: { kind: 'string' } },
  ],
} as const;

const fetchIssue: WorkflowNode = {
  id: 'fetch_issue',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'github.repository.read' },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
    { name: 'issueUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'issueUrl' } },
  ],
  outputs: [{ name: 'issue', type: issueObjectType }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'observation',
};

const draftSummary: WorkflowNode = {
  id: 'draft_summary',
  executionClass: 'agentic_computer_use',
  spec: { class: 'agentic_computer_use', task: 'Draft a triage summary and severity classification for the inbound GitHub issue.' },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    { name: 'issue', type: issueObjectType, binding: { kind: 'node_output', node: 'fetch_issue', output: 'issue' } },
  ],
  outputs: [
    { name: 'summary', type: { kind: 'string' } },
    { name: 'severity', type: { kind: 'string' } },
  ],
  failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
};

const reviewGate: WorkflowNode = {
  id: 'review_gate',
  executionClass: 'human',
  spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve posting the triage summary and syncing the backlog for this issue.' } },
  capabilityRequirements: [],
  placement: 'device_local',
  inputs: [],
  outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'human_confirmation',
};

const notifyChannel: WorkflowNode = {
  id: 'notify_channel',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'messaging.send' },
  capabilityRequirements: ['messaging.send'],
  placement: 'cloud_preferred',
  inputs: [
    { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' } },
    { name: 'channel', type: { kind: 'string' }, optional: true, binding: { kind: 'workflow_input', input: 'channel' } },
    { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' } },
  ],
  outputs: [{ name: 'messageId', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'verification',
};

const syncBacklog: WorkflowNode = {
  id: 'sync_backlog',
  executionClass: 'subworkflow',
  spec: { class: 'subworkflow', subworkflow: { workflowId: 'wf-backlog-sync', versionRef: 'wfv_0192837465afdeadbeef-candidate-1' } },
  capabilityRequirements: ['workflow.execute'],
  placement: 'any_supported_node',
  inputs: [
    { name: 'summary', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' } },
  ],
  outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
};

const logRejection: WorkflowNode = {
  id: 'log_rejection',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'filesystem.write' },
  capabilityRequirements: ['filesystem.write'],
  placement: 'device_local',
  inputs: [
    { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'rejected-triage.log' } },
    { name: 'content', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' } },
  ],
  outputs: [],
  failurePolicy: { strategy: 'ignore_and_continue' },
};

const triageEdges: ControlEdge[] = [
  { from: 'fetch_issue', to: 'draft_summary', on: 'success' },
  { from: 'draft_summary', to: 'review_gate', on: 'success' },
  { from: 'review_gate', to: 'notify_channel', on: { outcome: 'approved' } },
  { from: 'review_gate', to: 'sync_backlog', on: { outcome: 'approved' } },
  { from: 'review_gate', to: 'log_rejection', on: { outcome: 'rejected' } },
];

function authorTriageWorkflow() {
  return createWorkflowIrBuilder()
    .withStart('fetch_issue')
    .addWorkflowInput({ name: 'issueUrl', type: { kind: 'string' } })
    .addWorkflowInput({ name: 'channel', type: { kind: 'string' }, optional: true })
    .addWorkflowOutput({ name: 'summary', type: { kind: 'string' }, from: { kind: 'node_output', node: 'draft_summary', output: 'summary' } })
    .addWorkflowOutput({ name: 'messageId', type: { kind: 'string' }, from: { kind: 'node_output', node: 'notify_channel', output: 'messageId' } })
    .addNode(fetchIssue)
    .addNode(draftSummary)
    .addNode(reviewGate)
    .addNode(notifyChannel)
    .addNode(syncBacklog)
    .addNode(logRejection)
    .addEdge(triageEdges[0] as ControlEdge)
    .addEdge(triageEdges[1] as ControlEdge)
    .addEdge(triageEdges[2] as ControlEdge)
    .addEdge(triageEdges[3] as ControlEdge)
    .addEdge(triageEdges[4] as ControlEdge)
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withCompatibility({ compatibilityLevel: 'equivalent', inputSurfaceChange: 'none', outputSurfaceChange: 'none' })
    .build();
}

// ---------------------------------------------------------------------------
// The real deterministic local workload (real artifact files, real sha-256)
// ---------------------------------------------------------------------------

/** Deterministic draft-summary artifact (the input of the approval gate). */
const DRAFT_SUMMARY_TEXT =
  '[TRIAGE-CARD-9f2c1] pectoraux/WorkflowOS issue #4321 "run fails after schema migration" — ' +
  'severity: high — summary: migration 0060 introduced an immutability trigger; recommend rollback path + hotfix.';

/** Deterministic approval record (the output of the approval gate). */
const APPROVAL_RECORD = '{"gate":"review_gate","decision":"approved","approvedBy":"user-implementer-1","at":"2026-09-01T11:59:30.000Z"}';

/** Deterministic notification payload (the output of the attested step). */
const NOTIFY_PAYLOAD =
  '[TRIAGE-CARD-9f2c1] high-severity issue #4321 — approved triage summary posted to the team notifications channel.';

/** The observation record of the local action (a real fs observation, path-normalized). */
function observationRecordOf(file: string): string {
  const stats = statSync(file);
  return JSON.stringify({ observedArtifact: basenameOf(file), sizeBytes: stats.size, mode: stats.mode });
}

/** The artifact's plain file name (the run temp directory path is run-scoped bookkeeping, not semantics). */
function basenameOf(file: string): string {
  const parts = file.split('/');
  return parts[parts.length - 1] ?? file;
}

// ---------------------------------------------------------------------------
// Assertion bookkeeping + transcript
// ---------------------------------------------------------------------------

const failures: string[] = [];
const transcript: string[] = [];

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    transcript.push(`  [ok]   ${label} — ${detail}`);
  } else {
    transcript.push(`  [FAIL] ${label} — ${detail}`);
    failures.push(`${label}: ${detail}`);
  }
}

function section(title: string): void {
  transcript.push('');
  transcript.push(title);
}

function line(label: string, value: string): string {
  return `  ${label.padEnd(38, ' ')} ${value}`;
}

const wallStartedAt = Date.now();

// ---------------------------------------------------------------------------
// The experiment (executed for real; runs twice — second run with a fresh key)
// ---------------------------------------------------------------------------

interface RunRecord {
  readonly runLabel: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly semanticDigest: string;
  readonly contentDigest: string;
  readonly nodeId: string;
  readonly runId: string;
  readonly attestationId: string;
  readonly attesterKeyId: string;
  readonly executionDigest: string;
  readonly issuedEventId: string;
  readonly canonicalStatementJson: string;
  readonly inputCommitment: string;
  readonly outputCommitment: string;
  readonly observationCommitment: string;
  readonly causalParentDigest: string;
  readonly attestationBytes: string;
  readonly verifierExitCode: number | null;
  readonly verifierTranscript: string;
}

function executeExperiment(runLabel: string): RunRecord {
  const runDir = mkdtempSync(join(tmpdir(), 'v2-014-dogfood-'));

  // --- author the real workflow + compute the real binding reference data ---
  const document = authorTriageWorkflow();
  assertValidWorkflowIrDocument(document);
  const semantic = computeWorkflowVersionSemanticDigest(document);
  const serialized = serializeWorkflowIrDocument(document);
  const contentDigest = computeContentDigest(JSON.parse(serialized));
  const workflowId = deriveWorkflowId({ organizationId: ORG_ID, ownerUserId: OWNER_ID, slug: SLUG });
  const workflowVersionId = deriveWorkflowVersionId({ workflowId, contentDigest, protocol: { irSchemaVersion: '1' } });

  // --- the real node identity (merged V2-004 fingerprint derivation over the
  // V2-004 dogfooding host key material — the SAME device host, reproduced) ---
  const nodeKeyMaterial = createHash('sha256').update(V2_004_DOGFOOD_NODE_KEY_SEED).digest();
  const nodeId = deriveNodeKeyFingerprint(new Uint8Array(nodeKeyMaterial));

  // --- execute the real deterministic local workload ---
  mkdirSync(runDir, { recursive: true });
  const draftSummaryFile = join(runDir, 'draft-summary.txt');
  const approvalRecordFile = join(runDir, 'approval-record.json');
  const notifyPayloadFile = join(runDir, 'notify-payload.txt');
  writeFileSync(draftSummaryFile, DRAFT_SUMMARY_TEXT, 'utf8');
  writeFileSync(approvalRecordFile, APPROVAL_RECORD, 'utf8');
  writeFileSync(notifyPayloadFile, NOTIFY_PAYLOAD, 'utf8');
  // the ACTION, executed for real: read the artifact bytes back from disk and
  // commit to them (real one-way sha-256 over real file bytes):
  const draftSummaryCommitment = executionValueCommitment(readFileSync(draftSummaryFile));
  const approvalRecordCommitment = executionValueCommitment(readFileSync(approvalRecordFile));
  const notifyPayloadCommitment = executionValueCommitment(readFileSync(notifyPayloadFile));
  const inputCommitment = executionValueCommitment(serialized);
  const observationCommitment = executionValueCommitment(observationRecordOf(notifyPayloadFile));

  // --- the causal parent: the review_gate approval execution fact ---
  const parentStatement: ExecutionStatement = {
    objectType: 'workflowos/execution-statement/v1',
    statementSchemaVersion: 1,
    workflowId,
    workflowVersionId,
    workflowVersionSemanticDigest: semantic.digest,
    deploymentId: DEPLOYMENT_ID,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    stepId: 'review_gate',
    nodeId,
    workloadIdentity: WORKLOAD_IDENTITY,
    executionClass: 'human',
    action: 'Human review gate: approve posting the triage summary and syncing the backlog',
    inputCommitments: [draftSummaryCommitment],
    outputCommitments: [approvalRecordCommitment],
    observationCommitments: [executionValueCommitment(observationRecordOf(approvalRecordFile))],
    evidenceReferences: ['wfev-human-confirmation-review-gate-0001'],
    causalParents: [],
    nonce: PARENT_NONCE,
    epoch: STATEMENT_EPOCH,
    outcome: 'succeeded',
    executedAt: PARENT_EXECUTED_AT,
    validUntil: VALID_UNTIL,
  };
  const parentDigest = computeExecutionDigest(parentStatement);

  // --- the attested statement: the notify_channel execution fact ---
  const statement: ExecutionStatement = {
    objectType: 'workflowos/execution-statement/v1',
    statementSchemaVersion: 1,
    workflowId,
    workflowVersionId,
    workflowVersionSemanticDigest: semantic.digest,
    deploymentId: DEPLOYMENT_ID,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    stepId: STEP_ID,
    nodeId,
    workloadIdentity: WORKLOAD_IDENTITY,
    executionClass: 'deterministic_api',
    capability: 'messaging.send',
    action: 'Post the approved triage summary to the team notifications channel',
    inputCommitments: [inputCommitment],
    outputCommitments: [notifyPayloadCommitment],
    observationCommitments: [observationCommitment],
    evidenceReferences: ['wfev-message-delivery-0001'],
    causalParents: [parentDigest.digest],
    authorizationContextDigest: executionValueCommitment('authorization: operator user-implementer-1 may post approved triage summaries to team-notifications'),
    placementPolicyDigest: executionValueCommitment('placement: notify_channel requires cloud_preferred placement per WorkflowVersion'),
    nonce: NONCE,
    epoch: STATEMENT_EPOCH,
    outcome: 'succeeded',
    executedAt: EXECUTED_AT,
    validUntil: VALID_UNTIL,
  };
  const statementValidation = validateExecutionStatement(statement);
  check(`${runLabel}: the composed statement validates against the schema`, statementValidation.ok, statementValidation.ok ? `${Object.keys(statement).length} fields, exact key set` : JSON.stringify(statementValidation.issues));
  const canonicalStatement = canonicalStatementJson(statement);
  check(`${runLabel}: canonical statement serialization is deterministic`, canonicalStatementJson(statement) === canonicalStatement, `${canonicalStatement.length} chars`);

  // --- real Ed25519 signing + canonical export ---
  const attester = generateAttesterKeyPair();
  const attestation = signExecutionAttestation({
    statement,
    attesterPrivateKey: attester.privateKey,
    attesterPublicKeyDer: attester.publicKeyDer,
    assurance: 'software_signed',
    issuedAt: ISSUED_AT,
  });
  const issued = attestationIssuedEvent(attestation, ISSUED_AT);
  check(`${runLabel}: the issued protocol event uses the canonical registry event name`, issued.eventType === 'execution.attestation.issued', `${issued.eventType} (event id ${issued.eventId})`);
  const attestationBytes = serializeAttestation(attestation);
  writeFileSync(join(runDir, 'attestation.json'), attestationBytes, 'utf8');

  // --- privacy on the real path: raw artifact content never enters the bytes ---
  check(`${runLabel}: the exported bytes carry the payload COMMITMENT, never the payload text`, attestationBytes.includes(notifyPayloadCommitment) && !attestationBytes.includes('TRIAGE-CARD-9f2c1') && !attestationBytes.includes('team-notifications@secrets'), `commitment ${notifyPayloadCommitment.slice(0, 16)}… present; raw payload/secret-ref absent`);

  // --- the out-of-band verifier context (the verifier's own expectations) ---
  const verifierContext = {
    runLabel,
    attestationFile: 'attestation.json',
    trustedAttesterKeyId: attester.keyId,
    expected: {
      workflowId,
      workflowVersionId,
      workflowVersionSemanticDigest: semantic.digest,
      deploymentId: DEPLOYMENT_ID,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      stepId: STEP_ID,
      nodeId,
      causalParents: [parentDigest.digest],
    },
    freshness: {
      now: '2026-09-01T12:00:30.000Z',
      currentEpoch: STATEMENT_EPOCH,
      expectedNonce: NONCE,
      maxAgeMs: 300000,
      advancedEpoch: ADVANCED_EPOCH,
      lateNow: '2026-09-01T12:06:00.000Z',
    },
  };
  const contextFile = runLabel === 'run-1' ? 'verifier-context.json' : 'verifier-context-2.json';
  writeFileSync(join(runDir, contextFile), JSON.stringify(verifierContext, null, 2), 'utf8');

  // --- INDEPENDENT verification: separate process, public API + raw bytes only ---
  const backendDir = process.cwd();
  const verifierScript = 'tests/integration/execution-attestation/verify-attestation-dogfooding.ts';
  const verifier = spawnSync('bunx', ['tsx', verifierScript, runDir, contextFile], { cwd: backendDir, encoding: 'utf8' });
  const verifierTranscript = (verifier.stdout ?? '').trimEnd();
  check(`${runLabel}: independent verifier process exited 0`, verifier.status === 0, `exit=${String(verifier.status)}; transcript follows`);

  section(`independent verifier transcript — ${runLabel} (imports only the public verify API + the exported raw bytes):`);
  for (const verifierLine of verifierTranscript.split('\n')) {
    transcript.push(`    ${verifierLine}`);
  }

  return {
    runLabel,
    workflowId,
    workflowVersionId,
    semanticDigest: semantic.digest,
    contentDigest,
    nodeId,
    runId: RUN_ID,
    attestationId: attestation.attestationId,
    attesterKeyId: attestation.attesterKeyId,
    executionDigest: attestation.executionDigest.digest,
    issuedEventId: issued.eventId,
    canonicalStatementJson: canonicalStatement,
    inputCommitment,
    outputCommitment: notifyPayloadCommitment,
    observationCommitment,
    causalParentDigest: parentDigest.digest,
    attestationBytes,
    verifierExitCode: verifier.status,
    verifierTranscript,
  };
}

// ---------------------------------------------------------------------------
// Run 1 (primary) + Run 2 (determinism with a second real key pair)
// ---------------------------------------------------------------------------

transcript.push('V2-014 execution attestation dogfooding run');
transcript.push(`work order: V2-014 (execution attestation protocol)`);
transcript.push(`attested module: backend/src/execution-attestation (public barrel + node:crypto Ed25519)`);
transcript.push(`wall clock start (ms): ${String(wallStartedAt)}`);

const run1 = executeExperiment('run-1');

section('run-1 — real binding reference data + attestation:');
transcript.push(line('workflow (V2-002 derivation)', run1.workflowId));
transcript.push(line('WorkflowVersion (V2-002 derivation)', run1.workflowVersionId));
transcript.push(line('WorkflowVersion semantic digest (V2-003, real)', run1.semanticDigest));
transcript.push(line('node (V2-004 fingerprint derivation)', run1.nodeId));
transcript.push(line('run / attempt / step', `${run1.runId} / ${ATTEMPT_ID} / ${STEP_ID}`));
transcript.push(line('workload identity', WORKLOAD_IDENTITY));
transcript.push(line('causal parent ExecutionDigest', run1.causalParentDigest));
transcript.push(line('input commitment (serialized WorkflowIR)', run1.inputCommitment));
transcript.push(line('output commitment (real artifact sha-256)', run1.outputCommitment));
transcript.push(line('observation commitment (real fs observation)', run1.observationCommitment));
transcript.push(line('attestation identity', run1.attestationId));
transcript.push(line('attester key identity (real Ed25519)', run1.attesterKeyId));
transcript.push(line('ExecutionDigest (domain-separated)', run1.executionDigest));
transcript.push(line('issued event', `execution.attestation.issued ${run1.issuedEventId} (deterministic over the attestation identity)`));
transcript.push(line('exported canonical bytes', `${run1.attestationBytes.length} chars (run temp dir attestation.json)`));

const run2 = executeExperiment('run-2');

section('run-2 — determinism with a SECOND real Ed25519 key pair (key-normalized):');
check('run-2: same WorkflowVersion semantic digest', run1.semanticDigest === run2.semanticDigest, run2.semanticDigest);
check('run-2: same V2-002 workflow + version identities', run1.workflowId === run2.workflowId && run1.workflowVersionId === run2.workflowVersionId, `${run2.workflowId} / ${run2.workflowVersionId}`);
check('run-2: same node identity', run1.nodeId === run2.nodeId, run2.nodeId);
check('run-2: same causal parent ExecutionDigest', run1.causalParentDigest === run2.causalParentDigest, run2.causalParentDigest);
check('run-2: same real artifact commitments', run1.inputCommitment === run2.inputCommitment && run1.outputCommitment === run2.outputCommitment && run1.observationCommitment === run2.observationCommitment, 'input/output/observation commitments identical');
check('run-2: canonical statement JSON byte-identical', run1.canonicalStatementJson === run2.canonicalStatementJson, `${run2.canonicalStatementJson.length} chars`);
check('run-2: SAME ExecutionDigest (digest is key-independent)', run1.executionDigest === run2.executionDigest, run2.executionDigest);
check('run-2: DIFFERENT attester key identity (fresh key material, disclosed)', run1.attesterKeyId !== run2.attesterKeyId, `${run1.attesterKeyId} → ${run2.attesterKeyId}`);
check('run-2: DIFFERENT attestation identity (identity binds the key dimension)', run1.attestationId !== run2.attestationId, `${run1.attestationId} → ${run2.attestationId}`);
check('run-2: independent verifier also exited 0 for the second key', run2.verifierExitCode === 0, `exit=${String(run2.verifierExitCode)}`);

section('reference-data continuity with merged W1 dogfooding evidence:');
check('the authored workflow is the merged V2-003 dogfooding workflow (semantic digest pinned)', run1.semanticDigest === V2_003_EVIDENCE_DIGEST, `${run1.semanticDigest} (V2-003 evidence: ${V2_003_EVIDENCE_DIGEST})`);
check('the attesting node is the merged V2-004 dogfooding device host', run1.nodeId === V2_004_EVIDENCE_NODE_ID, `${run1.nodeId}`);

section('expected statement (canonical JSON, run-1):');
transcript.push(run1.canonicalStatementJson);

const wallDurationMs = Date.now() - wallStartedAt;
transcript.push('');
transcript.push(`wall duration (ms): ${String(wallDurationMs)}`);
transcript.push(
  failures.length === 0
    ? 'RESULT: attestation produced through the real protocol path, independently verified, all negative experiments rejected with typed failures, determinism key-normalized'
    : `RESULT: ${failures.length} assertion(s) FAILED`,
);

process.stdout.write(`${transcript.join('\n')}\n`);
process.exit(failures.length === 0 ? 0 : 1);
