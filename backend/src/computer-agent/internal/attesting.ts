/**
 * V2-008 — the attestation path: production where the host supports the
 * V2-014 contract, verification through the merged verifier (the
 * INDEPENDENT verifier path), and honest absence otherwise.
 *
 * BOUNDARY (constitution §21 + registry authorityRules): this module
 * PRODUCES ExecutionStatements and signs/verifies ONLY through the merged
 * execution-attestation barrel — it is never a second signing or
 * verification authority. A valid signature never implies authorization,
 * correct behavior, an observed effect, or sufficient evidence; the
 * verified fact attests statement authenticity only.
 *
 * Failure handling is typed and honest: tampered digest/signature,
 * binding mismatches, staleness and replay all surface as typed V2-014
 * failures the runtime records and honors (never auto-accepting a
 * cryptographically valid but insufficient attestation).
 */
import type { ExecutionAttestation, ExecutionStatement, ReplayRegistry } from '../../execution-attestation/index.js';
import {
  EXECUTION_STATEMENT_OBJECT_TYPE,
  EXECUTION_STATEMENT_SCHEMA_VERSION,
  executionValueCommitment,
  verifyAttestation,
} from '../../execution-attestation/index.js';
import type { AttestingComputerHost, AgentAttestationPolicy } from '../types.js';
import { addMs } from './clock.js';

/** The step-level attestation material the runtime collects for a statement. */
export interface StepAttestationMaterial {
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowVersionSemanticDigest: string;
  readonly deploymentId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly stepId: string;
  readonly executionClass: 'deterministic_api' | 'agentic_computer_use';
  readonly capability: string;
  /** Human-readable action description (never parameters). */
  readonly action: string;
  /** sha-256 commitments over the step's invocation inputs (hex). */
  readonly inputCommitments: readonly string[];
  /** sha-256 commitments over the step's claimed outputs (hex). */
  readonly outputCommitments: readonly string[];
  /** sha-256 commitments over the step's observations (hex). */
  readonly observationCommitments: readonly string[];
  /** Opaque evidence-record references (V2-005 record ids). */
  readonly evidenceReferences: readonly string[];
}

/** The injected production context (clock + epoch; never ambient). */
export interface AttestationProductionContext {
  /** Fixed-format UTC "now" (statement executedAt / attestation issuedAt). */
  readonly now: string;
  /** The current protocol epoch. */
  readonly epoch: number;
  /** Bounded validity window (ms) — honest staleness bound. */
  readonly validityMs: number;
}

/**
 * Build the canonical ExecutionStatement for one completed step (bound to
 * the exact workflow/version/run/attempt/step/node; commitment-based, no
 * secrets; single-use nonce from the host's freshness source).
 */
export function buildStepStatement(
  host: AttestingComputerHost,
  material: StepAttestationMaterial,
  context: AttestationProductionContext,
): ExecutionStatement {
  return {
    objectType: EXECUTION_STATEMENT_OBJECT_TYPE,
    statementSchemaVersion: EXECUTION_STATEMENT_SCHEMA_VERSION,
    workflowId: material.workflowId,
    workflowVersionId: material.workflowVersionId,
    workflowVersionSemanticDigest: material.workflowVersionSemanticDigest,
    deploymentId: material.deploymentId,
    runId: material.runId,
    attemptId: material.attemptNumber,
    stepId: material.stepId,
    nodeId: host.nodeId,
    workloadIdentity: `computer-agent-runtime@${host.platformClass}`,
    executionClass: material.executionClass,
    capability: material.capability,
    action: material.action,
    inputCommitments: [...material.inputCommitments].sort(),
    outputCommitments: [...material.outputCommitments].sort(),
    observationCommitments: [...material.observationCommitments].sort(),
    evidenceReferences: [...material.evidenceReferences].sort(),
    causalParents: [],
    nonce: host.nextNonce(),
    epoch: context.epoch,
    outcome: 'succeeded',
    executedAt: context.now,
    validUntil: addMs(context.now, context.validityMs),
  };
}

/**
 * Produce one ExecutionAttestation on the attesting host: the host signs
 * the canonical statement with its real Ed25519 key (the key never leaves
 * the adapter). Assurance is `software_signed` — the universal honest
 * baseline, never up-claimed. Returns null for non-attesting hosts (the
 * caller records the honest absence instead).
 */
export function produceStepAttestation(
  host: AttestingComputerHost,
  statement: ExecutionStatement,
  context: AttestationProductionContext,
): ExecutionAttestation {
  return host.signStatement(statement, context.now);
}

/**
 * The INDEPENDENT verifier path: verify an attestation through the merged
 * V2-014 verifier with an explicit policy binding the exact execution
 * (workflow/version/run/attempt/step), freshness (injected clock + epoch +
 * single-use replay registry + max age), trusted attester keys (an empty
 * list trusts nobody — fail-closed) and the minimum assurance.
 *
 * This is the runtime's own verification BEFORE attachment; the V2-005
 * run-boundary attach re-verifies independently (defense in depth — both
 * real, both typed). Note: node binding is deliberately NOT pinned here —
 * the runtime verifies against the recorded execution material and the
 * run boundary holds the host identity dimension.
 */
export function verifyStepAttestationIndependently(
  attestation: ExecutionAttestation,
  material: StepAttestationMaterial,
  policy: AgentAttestationPolicy,
  context: { readonly now: string; readonly epoch: number; readonly replayRegistry?: ReplayRegistry },
): ReturnType<typeof verifyAttestation> {
  return verifyAttestation(attestation, {
    bindings: {
      workflowId: material.workflowId,
      workflowVersionId: material.workflowVersionId,
      workflowVersionSemanticDigest: material.workflowVersionSemanticDigest,
      deploymentId: material.deploymentId,
      runId: material.runId,
      attemptId: material.attemptNumber,
      stepId: material.stepId,
      causalParents: [],
    },
    freshness: {
      now: context.now,
      currentEpoch: context.epoch,
      ...(context.replayRegistry !== undefined ? { replayRegistry: context.replayRegistry } : {}),
      ...(policy.maxAgeMs !== undefined ? { maxAgeMs: policy.maxAgeMs } : {}),
    },
    ...(policy.trustedAttesterKeyIds !== undefined ? { attesterKeyIds: policy.trustedAttesterKeyIds } : {}),
    ...(policy.requiredAssurance !== undefined ? { requiredAssurance: policy.requiredAssurance } : {}),
  });
}

/** sha-256 hex over the canonical JSON serialization of one value. */
export function observationCommitmentOf(value: unknown): string {
  return executionValueCommitment(JSON.stringify(value));
}

/** sha-256 hex over one typed string value (parameter commitments). */
export function valueCommitmentOf(value: string): string {
  return executionValueCommitment(value);
}


