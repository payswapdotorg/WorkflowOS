import type { ExecutionAttestation, Sha256Hex } from '../../../src/execution-proof-graph/index.js';
import type { ExecutionStatement } from '../../../src/execution-attestation/index.js';
import {
  generateAttesterKeyPair,
  signExecutionAttestation,
} from '../../../src/execution-attestation/index.js';

/**
 * V2-015 — shared deterministic fixtures for the execution-proof-graph battery.
 *
 * Determinism rules (work-order "Deterministic-first", the V2-014 helpers
 * precedent):
 *   - every clock value is a fixed ISO-8601 UTC constant (injected, never wall);
 *   - every nonce/epoch is a fixed constant;
 *   - the attester keys are REAL Ed25519 key pairs generated once per test
 *     process through the merged V2-014 public `generateAttesterKeyPair`
 *     (real cryptography; Ed25519 key material cannot be seeded). Assertions
 *     are key-NORMALIZED: they never depend on which concrete key was
 *     generated, only on relations between the generated keys.
 *
 * The fixture models the canonical cross-device composition shape (the
 * IG-006 runtime path): one run, two hosts of two different supported kinds
 * (web Node A / desktop Node B), each carrying a REAL Ed25519 attester key,
 * with the dependent step's attestation declaring the predecessor's
 * execution digest in causalParents.
 */

// ---------------------------------------------------------------------------
// Injected clocks / freshness material (fixed constants)
// ---------------------------------------------------------------------------

export const PG_EXECUTED_AT = '2026-09-02T08:00:00.000Z';
export const PG_EXECUTED_AT_LATER = '2026-09-02T08:01:00.000Z';
export const PG_VALID_UNTIL = '2026-09-02T08:30:00.000Z';
export const PG_ISSUED_AT = '2026-09-02T08:00:01.000Z';
export const PG_EPOCH = 11;

// ---------------------------------------------------------------------------
// Fixed commitment material (fixed 64-hex constants — raw values never enter)
// ---------------------------------------------------------------------------

/** Reference binding data: a fixed WorkflowIR semantic digest (V2-003's). */
export const PG_SEMANTIC_DIGEST: Sha256Hex = 'd12a1c2654877e3d97dfa8d019233ec38c6644611a8bde0eaf8828842546b2a6';

export const PG_INPUT_COMMITMENT: Sha256Hex = '2f453bde4c45e6c3c0bf2cd5bc75a37d4c72eb6dc85cbfeb879bf21483e9e263';
export const PG_OUTPUT_COMMITMENT: Sha256Hex = '4c64f3ce8b065951d20b1e5175538a1b795a173440520f2be02dc7c26a0785c0';
export const PG_OBSERVATION_COMMITMENT: Sha256Hex = '4c0a117cbb915c59f3758d3cee94094fa56b83c709d172a618c2b3f933a2fdc2';
export const PG_AUTHORIZATION_CONTEXT_DIGEST: Sha256Hex = '9456f12cefe501fdd58a6face2ebde933d4be22a58c8461495301712eb2c2c02';
export const PG_PLACEMENT_POLICY_DIGEST: Sha256Hex = '49e478aeda75807b589c271f25ff769cb6960aa9783e05491cc7231281f2207d';

// ---------------------------------------------------------------------------
// Real Ed25519 attester key material (generated once per test process)
// ---------------------------------------------------------------------------

/** Node A's attester (the web host — signs the predecessor step). */
export const ATTESTER_NODE_A = generateAttesterKeyPair();
/** Node B's attester (the desktop host — signs the dependent step). */
export const ATTESTER_NODE_B = generateAttesterKeyPair();
/** A third, unrelated attester (trust-discrimination experiments). */
export const ATTESTER_UNTRUSTED = generateAttesterKeyPair();

// ---------------------------------------------------------------------------
// The graph scope fixture (one workflow, one version, one run, two nodes)
// ---------------------------------------------------------------------------

export const PG_SCOPE = {
  workflowId: 'wf-cross-device-report',
  workflowVersionId: 'wfv-cross-device-report-3',
  workflowVersionSemanticDigest: PG_SEMANTIC_DIGEST,
  runId: 'wfr-cdr-20260902-0001',
} as const;

export const NODE_A_ID = 'node_a_web_7f3a91c2';
export const NODE_B_ID = 'node_b_desktop_2e8d40b1';

// ---------------------------------------------------------------------------
// Statement fixtures
// ---------------------------------------------------------------------------

export interface GraphStatementOverrides {
  readonly stepId: string;
  readonly nodeId: string;
  readonly action: string;
  readonly capability?: string;
  readonly executionClass?: 'deterministic_api' | 'agentic_computer_use' | 'human';
  readonly causalParents?: readonly Sha256Hex[];
  readonly nonce: string;
  readonly outcome?: 'succeeded' | 'failed';
  readonly attemptId?: number;
  readonly runId?: string;
  readonly workflowVersionId?: string;
  readonly workflowVersionSemanticDigest?: string;
  readonly workloadIdentity?: string;
  readonly executedAt?: string;
}

/** Build a canonical statement inside the fixture scope (deterministic). */
export function buildGraphStatement(overrides: GraphStatementOverrides): ExecutionStatement {
  return {
    objectType: 'workflowos/execution-statement/v1',
    statementSchemaVersion: 1,
    workflowId: PG_SCOPE.workflowId,
    workflowVersionId: overrides.workflowVersionId ?? PG_SCOPE.workflowVersionId,
    workflowVersionSemanticDigest:
      (overrides.workflowVersionSemanticDigest as Sha256Hex | undefined) ?? PG_SCOPE.workflowVersionSemanticDigest,
    deploymentId: 'wfd-cdr-deployment-1',
    runId: overrides.runId ?? PG_SCOPE.runId,
    attemptId: overrides.attemptId ?? 1,
    stepId: overrides.stepId,
    nodeId: overrides.nodeId,
    workloadIdentity: overrides.workloadIdentity ?? 'wl_cdr-runner-2026-09',
    executionClass: overrides.executionClass ?? 'deterministic_api',
    ...(overrides.capability !== undefined ? { capability: overrides.capability } : {}),
    action: overrides.action,
    inputCommitments: [PG_INPUT_COMMITMENT],
    outputCommitments: [PG_OUTPUT_COMMITMENT],
    observationCommitments: [PG_OBSERVATION_COMMITMENT],
    evidenceReferences: [`wfev-cdr-${overrides.stepId}-0001`],
    causalParents: overrides.causalParents ?? [],
    authorizationContextDigest: PG_AUTHORIZATION_CONTEXT_DIGEST,
    placementPolicyDigest: PG_PLACEMENT_POLICY_DIGEST,
    nonce: overrides.nonce,
    epoch: PG_EPOCH,
    outcome: overrides.outcome ?? 'succeeded',
    executedAt: overrides.executedAt ?? PG_EXECUTED_AT,
    validUntil: PG_VALID_UNTIL,
  };
}

/** Sign a fixture statement with a real Ed25519 attester key. */
export function signGraphAttestation(
  statement: ExecutionStatement,
  attester: { privateKey: import('node:crypto').KeyObject; publicKeyDer: string },
  options: { issuedAt?: string } = {},
): ExecutionAttestation {
  return signExecutionAttestation({
    statement,
    attesterPrivateKey: attester.privateKey,
    attesterPublicKeyDer: attester.publicKeyDer,
    assurance: 'software_signed',
    issuedAt: options.issuedAt ?? PG_ISSUED_AT,
  });
}

// ---------------------------------------------------------------------------
// The canonical two-step cross-device pair (predecessor → dependent)
// ---------------------------------------------------------------------------

/** Node A's predecessor step attestation (the web step). */
export function buildPredecessorAttestation(): ExecutionAttestation {
  return signGraphAttestation(
    buildGraphStatement({
      stepId: 'collect_intake',
      nodeId: NODE_A_ID,
      action: 'Collect the intake form submission from the web portal',
      capability: 'browser.observe',
      executionClass: 'agentic_computer_use',
      nonce: 'challenge-cdr-run-0001-step-collect',
    }),
    ATTESTER_NODE_A,
  );
}

/** Node B's dependent step attestation (declares the predecessor's digest). */
export function buildDependentAttestation(predecessor: ExecutionAttestation): ExecutionAttestation {
  return signGraphAttestation(
    buildGraphStatement({
      stepId: 'write_report',
      nodeId: NODE_B_ID,
      action: 'Write the acknowledged report to the local reports directory',
      capability: 'filesystem.write',
      executionClass: 'agentic_computer_use',
      causalParents: [predecessor.executionDigest.digest],
      nonce: 'challenge-cdr-run-0001-step-write',
      executedAt: PG_EXECUTED_AT_LATER,
    }),
    ATTESTER_NODE_B,
  );
}
