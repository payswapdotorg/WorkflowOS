/**
 * V2-016 — the causal-parent PRODUCTION battery (work order "Required
 * regressions" 9 + 10 + "Causal-parent production").
 *
 * Proves, at the attestation-material layer AND through the real runtime
 * drive, that:
 *
 *   9. a dependent runtime-produced attestation contains EXACTLY the
 *      declared causal parent digest(s) — flowing unchanged through
 *      `buildStepStatement` into the canonical V2-014
 *      `ExecutionStatement.causalParents` (sorted set semantics,
 *      deterministic ordering, never an invented parent, never a silent
 *      `[]` fallback when parents were declared);
 *  10. zero-parent behavior remains valid for non-dependent steps
 *      (materials without `causalParents` produce the exact pre-V2-016
 *      statement shape);
 *  and that the runtime's independent verification BINDS the produced
 *  statement to exactly the declared set (a mismatched declaration is a
 *  typed ATTESTATION_BINDING_MISMATCH on the causalParents dimension —
 *  the machine-checked reason a dependent step can never silently fall
 *  back to `causalParents: []`).
 *
 * The full runtime-path proof (admitted precondition → side effect →
 * attached dependent attestation carrying the predecessor's execution
 * digest) lives in dependent-precondition-admission.test.ts (regression 1);
 * this file pins the production contract deterministically.
 */
import { describe, it, expect } from 'vitest';
import {
  DesktopHostAdapter,
  ScriptedDesktopEnvironment,
  buildStepStatement,
  produceStepAttestation,
  verifyStepAttestationIndependently,
  type AttestingComputerHost,
  type StepAttestationMaterial,
  type AgentAttestationPolicy,
} from '../../../src/computer-agent/index.js';
import {
  generateAttesterKeyPair,
  InMemoryReplayRegistry,
  type ExecutionAttestation,
} from '../../../src/execution-attestation/index.js';
import { createManualClock, FIXED_STAMP } from './helpers.js';

const KEY = generateAttesterKeyPair();
const CLOCK = createManualClock();
const NOW = FIXED_STAMP;
const EPOCH = 7;
const VALIDITY_MS = 300_000;
const CONTEXT = { now: NOW, epoch: EPOCH, validityMs: VALIDITY_MS };

const MATCHING_POLICY: AgentAttestationPolicy = {
  required: false,
  trustedAttesterKeyIds: [KEY.keyId],
  requiredAssurance: 'software_signed',
  maxAgeMs: VALIDITY_MS,
};

function attestingHost(nodeId: string): AttestingComputerHost {
  return new DesktopHostAdapter({
    nodeId,
    sessionToken: `session-${nodeId}`,
    clock: () => CLOCK.now(),
    attestation: { supported: true, attesterKeyId: KEY.keyId },
    attesterKey: KEY,
    environment: new ScriptedDesktopEnvironment({ directories: ['reports'] }),
  }) as AttestingComputerHost;
}

const BASE_MATERIAL: Omit<StepAttestationMaterial, 'causalParents'> = {
  workflowId: 'wf_v2016_1',
  workflowVersionId: 'ver_v2016_1',
  workflowVersionSemanticDigest: 'ab'.repeat(32),
  deploymentId: 'none',
  runId: 'run_v2016_1',
  attemptNumber: 1,
  stepId: 'acknowledge',
  executionClass: 'agentic_computer_use',
  capability: 'filesystem.write',
  action: 'dependent acknowledgment write',
  inputCommitments: [],
  outputCommitments: [],
  observationCommitments: [],
  evidenceReferences: [],
};

/** sha-256-hex-shaped deterministic fixture digests (sorted order matters). */
const DIGEST_Z = 'aa'.repeat(32);
const DIGEST_A = 'bb'.repeat(32);
const DIGEST_M = 'cc'.repeat(32);

describe('V2-016 causal-parent production (declared digests flow unchanged into the canonical V2-014 statement)', () => {
  it('9a. carries EXACTLY the declared parents, in deterministic sorted order, de-duplicated as a set', () => {
    const host = attestingHost('node_v2016_causal');
    const material: StepAttestationMaterial = {
      ...BASE_MATERIAL,
      causalParents: [DIGEST_Z, DIGEST_A, DIGEST_Z, DIGEST_M],
    };
    const statement = buildStepStatement(host, material, CONTEXT);
    // sorted + de-duplicated + EXACTLY the declared set (nothing invented,
    // nothing dropped, order deterministic; the fixture digests sort
    // DIGEST_Z('aa..') < DIGEST_A('bb..') < DIGEST_M('cc..')):
    expect([...statement.causalParents]).toEqual([DIGEST_Z, DIGEST_A, DIGEST_M]);
    expect(statement.causalParents.length).toBe(3);
    // the canonical V2-014 field IS the runtime's output (type-level proof:
    // ExecutionStatement.causalParents is the merged V2-014 contract field):
    expect(statement.objectType).toBe('workflowos/execution-statement/v1');
  });

  it('9b. a declared single parent flows through unchanged (the canonical cross-device shape)', () => {
    const host = attestingHost('node_v2016_causal_single');
    const material: StepAttestationMaterial = {
      ...BASE_MATERIAL,
      causalParents: [DIGEST_A],
    };
    const statement = buildStepStatement(host, material, CONTEXT);
    expect([...statement.causalParents]).toEqual([DIGEST_A]);
  });

  it('10. materials without causalParents produce the exact pre-V2-016 zero-parent statement shape', () => {
    const host = attestingHost('node_v2016_zero');
    const statement = buildStepStatement(host, BASE_MATERIAL, CONTEXT);
    expect([...statement.causalParents]).toEqual([]);
    // and the signed + independently verified attestation still passes with
    // the zero-parent binding expectation (backwards compatibility):
    const attestation = produceStepAttestation(host, statement, CONTEXT);
    const verification = verifyStepAttestationIndependently(attestation, BASE_MATERIAL, MATCHING_POLICY, {
      now: NOW,
      epoch: EPOCH,
      replayRegistry: new InMemoryReplayRegistry(),
    });
    expect(verification.ok).toBe(true);
  });

  it('the produced dependent attestation verifies against EXACTLY the declared set (the independent verification binds causalParents)', () => {
    const host = attestingHost('node_v2016_bind');
    const material: StepAttestationMaterial = {
      ...BASE_MATERIAL,
      causalParents: [DIGEST_A, DIGEST_M],
    };
    const statement = buildStepStatement(host, material, CONTEXT);
    const attestation = produceStepAttestation(host, statement, CONTEXT);

    // matching declaration → the canonical verifier accepts:
    const matching = verifyStepAttestationIndependently(attestation, material, MATCHING_POLICY, {
      now: NOW,
      epoch: EPOCH,
      replayRegistry: new InMemoryReplayRegistry(),
    });
    expect(matching.ok).toBe(true);

    // a DIFFERENT declared set (the silent-fallback shape: []) → typed
    // binding mismatch on the causalParents dimension (this is the
    // machine-checked reason a dependent step can never silently fall back
    // to causalParents: [] when parents were declared):
    const emptyDeclared: StepAttestationMaterial = { ...BASE_MATERIAL, causalParents: [] };
    const emptyCheck = verifyStepAttestationIndependently(attestation, emptyDeclared, MATCHING_POLICY, {
      now: NOW,
      epoch: EPOCH,
      replayRegistry: new InMemoryReplayRegistry(),
    });
    expect(emptyCheck.ok).toBe(false);
    if (!emptyCheck.ok) {
      expect(emptyCheck.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(emptyCheck.failure.dimension).toBe('causalParents');
    }

    // a REORDERED declaration of the same set still verifies (set
    // semantics — deterministic ordering is canonical, not restrictive):
    const reordered: StepAttestationMaterial = {
      ...BASE_MATERIAL,
      causalParents: [DIGEST_M, DIGEST_A],
    };
    const reorderedCheck = verifyStepAttestationIndependently(attestation, reordered, MATCHING_POLICY, {
      now: NOW,
      epoch: EPOCH,
      replayRegistry: new InMemoryReplayRegistry(),
    });
    expect(reorderedCheck.ok).toBe(true);

    // an EXTRA invented parent in the expectation → typed mismatch (the
    // produced statement never carries more than the declared set):
    const extraDeclared: StepAttestationMaterial = {
      ...BASE_MATERIAL,
      causalParents: [DIGEST_A, DIGEST_M, DIGEST_Z],
    };
    const extraCheck = verifyStepAttestationIndependently(attestation, extraDeclared, MATCHING_POLICY, {
      now: NOW,
      epoch: EPOCH,
      replayRegistry: new InMemoryReplayRegistry(),
    });
    expect(extraCheck.ok).toBe(false);
    if (!extraCheck.ok) {
      expect(extraCheck.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(extraCheck.failure.dimension).toBe('causalParents');
    }
  });

  it('two separately-produced dependent attestations over the same declaration are identical in their causal field (determinism)', () => {
    const host = attestingHost('node_v2016_det');
    const material: StepAttestationMaterial = {
      ...BASE_MATERIAL,
      causalParents: [DIGEST_M, DIGEST_A, DIGEST_M],
    };
    const first = buildStepStatement(host, material, CONTEXT);
    // the host nonce advances between statements — the causal field must
    // NOT (it is a pure function of the declared set):
    const second = buildStepStatement(host, material, CONTEXT);
    expect([...first.causalParents]).toEqual([...second.causalParents]);
    expect([...first.causalParents]).toEqual([DIGEST_A, DIGEST_M]);
  });
});

// ============================================================================
// §2 Type-level pins (the causal field reaches V2-014's canonical statement)
// ============================================================================

describe('V2-016 type-level pins (the causal-parent field reaches the canonical statement, not test metadata)', () => {
  it('StepAttestationMaterial.causalParents and ExecutionStatement.causalParents are the same typed carrier', () => {
    // compile-time pin: the material's optional field and the canonical
    // statement's field are both present and assignable to each other:
    const material: StepAttestationMaterial = {
      ...BASE_MATERIAL,
      causalParents: [DIGEST_A],
    };
    const host = attestingHost('node_v2016_types');
    const statement = buildStepStatement(host, material, CONTEXT);
    // the canonical V2-014 field carries the runtime's declared parents:
    const carried: readonly string[] = statement.causalParents;
    expect(carried).toEqual([DIGEST_A]);
    // and the produced, signed envelope embeds the same statement (the
    // causal field is INSIDE the signed canonical object, never a
    // test-only sidecar):
    const attestation: ExecutionAttestation = produceStepAttestation(host, statement, CONTEXT);
    expect([...attestation.statement.causalParents]).toEqual([DIGEST_A]);
    expect(attestation.executionDigest.domain).toBe('workflowos/execution-statement/v1');
  });
});
