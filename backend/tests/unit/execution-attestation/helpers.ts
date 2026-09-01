import type {
  AssuranceEvidence,
  AssuranceLevel,
  AttestationVerificationPolicy,
  ExecutionAttestation,
  ExecutionStatement,
  ReplayRegistry,
} from '../../../src/execution-attestation/index.js';
import {
  generateAttesterKeyPair,
  InMemoryReplayRegistry,
  signExecutionAttestation,
} from '../../../src/execution-attestation/index.js';

/**
 * V2-014 — shared deterministic fixtures for the execution-attestation battery.
 *
 * Determinism rules (work-order "Deterministic-first"):
 *   - every clock value is a fixed ISO-8601 UTC constant (injected, never wall);
 *   - every nonce/epoch is a fixed constant;
 *   - the attester keys are REAL Ed25519 key pairs generated once per test
 *     process through the module's own `generateAttesterKeyPair` (real
 *     cryptography; Ed25519 key material cannot be seeded). Assertions in the
 *     battery are key-NORMALIZED: they never depend on which concrete key was
 *     generated, only on relations between the generated keys.
 *
 * Binding reference data is real merged-W1 dogfooding data: the WorkflowIR
 * semantic digest of the support-ticket-triage workflow (V2-003 evidence) and
 * the V2-004 dogfooding node identity.
 */

// ---------------------------------------------------------------------------
// Injected clocks / freshness material (fixed constants)
// ---------------------------------------------------------------------------

export const EXECUTED_AT = '2026-09-01T12:00:00.000Z';
export const VALID_UNTIL = '2026-09-01T12:05:00.000Z';
export const ATTESTATION_ISSUED_AT = '2026-09-01T12:00:01.000Z';
export const VERIFY_NOW = '2026-09-01T12:00:30.000Z';
export const STATEMENT_EPOCH = 7;
export const NONCE = 'challenge-triage-run-0001-attempt-1';

/** An epoch strictly newer than STATEMENT_EPOCH (staleness experiments). */
export const NEWER_EPOCH = 8;
/** A clock strictly beyond VALID_UNTIL (expiry experiments). */
export const LATE_NOW = '2026-09-01T12:06:00.000Z';

// ---------------------------------------------------------------------------
// Fixed commitment material (fixed 64-hex constants — raw values never enter)
// ---------------------------------------------------------------------------

/**
 * The REAL WorkflowVersion semantic digest of the support-ticket-triage
 * workflow (V2-003 dogfooding evidence: sha-256, domain
 * `workflowos/workflow-ir/v1`). Used as reference binding data.
 */
export const TRIAGE_SEMANTIC_DIGEST = '571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37';

export const INPUT_COMMITMENT_SUMMARY = '911c7e2937a7ebb6267c3a37d97891b6537a65c4614bf20bbe0601a2d0b024bd';
export const OUTPUT_COMMITMENT_MESSAGE = '75e7a62b8d67c523d606bc30f6f6db33196491972443a82a7d69ba2bffa39124';
export const OBSERVATION_COMMITMENT = '37c6609997a4a7b01569185b47620d2ecc1ed63c232cb0fe84b0ad42b1df9f83';
export const AUTHORIZATION_CONTEXT_DIGEST = '9683cca88094bc5b0def214d6d3367a04897c95af3b055dd8c9ae0914e7be3ed';
export const PLACEMENT_POLICY_DIGEST = 'bf20edd3ebe9c44822ba85ede1f88a6a28e89685935b828543e8863a172deebe';
export const CAUSAL_PARENT_DIGEST = 'f9bf1037a1e738739d20a489223b9f53e9a892ac99cc5228880f02b51e424c6f';

// ---------------------------------------------------------------------------
// Real Ed25519 attester key material (generated once per test process)
// ---------------------------------------------------------------------------

/** The primary attester (signs the fixture attestations). */
export const ATTESTER_A = generateAttesterKeyPair();
/** A second, independent attester (substitution experiments). */
export const ATTESTER_B = generateAttesterKeyPair();

// ---------------------------------------------------------------------------
// The canonical statement fixture (support-ticket-triage notify step)
// ---------------------------------------------------------------------------

export const STATEMENT_FIXTURE_BASE = {
  workflowId: 'wf-support-ticket-triage',
  workflowVersionId: 'wfv-support-ticket-triage-1',
  workflowVersionSemanticDigest: TRIAGE_SEMANTIC_DIGEST,
  deploymentId: 'wfd-triage-deployment-1',
  runId: 'wfr-triage-20260901-0001',
  attemptId: 1,
  stepId: 'notify_channel',
  nodeId: 'node_795e8b12eaef3e45',
  workloadIdentity: 'wl_triage-runner-2026-09',
  executionClass: 'deterministic_api',
  capability: 'messaging.send',
  action: 'Post the approved triage summary to the team notifications channel',
  inputCommitments: [INPUT_COMMITMENT_SUMMARY],
  outputCommitments: [OUTPUT_COMMITMENT_MESSAGE],
  observationCommitments: [OBSERVATION_COMMITMENT],
  evidenceReferences: ['wfev-message-delivery-0001'],
  causalParents: [CAUSAL_PARENT_DIGEST],
  authorizationContextDigest: AUTHORIZATION_CONTEXT_DIGEST,
  placementPolicyDigest: PLACEMENT_POLICY_DIGEST,
  nonce: NONCE,
  epoch: STATEMENT_EPOCH,
  outcome: 'succeeded',
  executedAt: EXECUTED_AT,
  validUntil: VALID_UNTIL,
} as const;

export type StatementOverrides = Partial<Record<keyof ExecutionStatement, unknown>>;

/**
 * The canonical statement fixture. Overrides are applied shallowly; passing
 * `undefined` removes an optional field (exactOptionalPropertyTypes is off).
 */
export function buildTriageStatement(overrides: StatementOverrides = {}): ExecutionStatement {
  const base: Record<string, unknown> = {
    objectType: 'workflowos/execution-statement/v1',
    statementSchemaVersion: 1,
    ...STATEMENT_FIXTURE_BASE,
  };
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = value;
  }
  return base as unknown as ExecutionStatement;
}

/**
 * The same statement with every object key inserted in a DIFFERENT order and
 * the set-declared arrays in different orders: canonically identical.
 */
export function buildTriageStatementAltOrder(): ExecutionStatement {
  return {
    validUntil: VALID_UNTIL,
    executedAt: EXECUTED_AT,
    outcome: 'succeeded' as const,
    epoch: STATEMENT_EPOCH,
    nonce: NONCE,
    placementPolicyDigest: PLACEMENT_POLICY_DIGEST,
    authorizationContextDigest: AUTHORIZATION_CONTEXT_DIGEST,
    causalParents: [CAUSAL_PARENT_DIGEST],
    evidenceReferences: ['wfev-message-delivery-0001'],
    observationCommitments: [OBSERVATION_COMMITMENT],
    outputCommitments: [OUTPUT_COMMITMENT_MESSAGE],
    inputCommitments: [INPUT_COMMITMENT_SUMMARY],
    action: 'Post the approved triage summary to the team notifications channel',
    capability: 'messaging.send',
    executionClass: 'deterministic_api' as const,
    workloadIdentity: 'wl_triage-runner-2026-09',
    nodeId: 'node_795e8b12eaef3e45',
    stepId: 'notify_channel',
    attemptId: 1,
    runId: 'wfr-triage-20260901-0001',
    deploymentId: 'wfd-triage-deployment-1',
    workflowVersionSemanticDigest: TRIAGE_SEMANTIC_DIGEST,
    workflowVersionId: 'wfv-support-ticket-triage-1',
    workflowId: 'wf-support-ticket-triage',
    statementSchemaVersion: 1,
    objectType: 'workflowos/execution-statement/v1',
  };
}

// ---------------------------------------------------------------------------
// Signing + verification policy fixtures
// ---------------------------------------------------------------------------

/** Sign the fixture statement (or an override) with a real Ed25519 key. */
export function signTriageAttestation(options: {
  statement?: ExecutionStatement;
  attester?: typeof ATTESTER_A;
  assurance?: AssuranceLevel;
  assuranceEvidence?: readonly AssuranceEvidence[];
  issuedAt?: string;
} = {}): ExecutionAttestation {
  return signExecutionAttestation({
    statement: options.statement ?? buildTriageStatement(),
    attesterPrivateKey: (options.attester ?? ATTESTER_A).privateKey,
    attesterPublicKeyDer: (options.attester ?? ATTESTER_A).publicKeyDer,
    assurance: options.assurance ?? 'software_signed',
    ...(options.assuranceEvidence !== undefined ? { assuranceEvidence: options.assuranceEvidence } : {}),
    issuedAt: options.issuedAt ?? ATTESTATION_ISSUED_AT,
  });
}

/**
 * The default verification policy: binds EVERYTHING to the fixture statement,
 * requires software_signed assurance, pins ATTESTER_A, and enforces full
 * freshness (nonce + epoch + validity + replay registry).
 */
export function defaultVerifyPolicy(
  overrides: {
    bindings?: Partial<Record<string, unknown>>;
    now?: string;
    currentEpoch?: number;
    expectedNonce?: string;
    maxAgeMs?: number;
    replayRegistry?: ReplayRegistry;
    attesterKeyIds?: readonly string[];
    requiredAssurance?: AssuranceLevel;
  } = {},
): AttestationVerificationPolicy {
  return {
    bindings: {
      workflowId: 'wf-support-ticket-triage',
      workflowVersionId: 'wfv-support-ticket-triage-1',
      workflowVersionSemanticDigest: TRIAGE_SEMANTIC_DIGEST,
      deploymentId: 'wfd-triage-deployment-1',
      runId: 'wfr-triage-20260901-0001',
      attemptId: 1,
      stepId: 'notify_channel',
      nodeId: 'node_795e8b12eaef3e45',
      causalParents: [CAUSAL_PARENT_DIGEST],
      ...overrides.bindings,
    },
    freshness: {
      now: overrides.now ?? VERIFY_NOW,
      currentEpoch: overrides.currentEpoch ?? STATEMENT_EPOCH,
      expectedNonce: overrides.expectedNonce ?? NONCE,
      maxAgeMs: overrides.maxAgeMs ?? 300000,
      replayRegistry: overrides.replayRegistry ?? new InMemoryReplayRegistry(),
    },
    attesterKeyIds: 'attesterKeyIds' in overrides ? overrides.attesterKeyIds : [ATTESTER_A.keyId],
    requiredAssurance: 'requiredAssurance' in overrides ? overrides.requiredAssurance : 'software_signed',
  };
}
