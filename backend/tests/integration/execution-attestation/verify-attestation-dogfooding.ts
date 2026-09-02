/**
 * V2-014 — INDEPENDENT dogfooding verifier (the receiving/verifying side).
 *
 * This script is deliberately separate from the issuing runner
 * (run-attestation-dogfooding.ts): it imports ONLY the public verification
 * API of src/execution-attestation (plus node builtins) and the RAW exported
 * canonical attestation bytes. It holds NO issuer state: no private key, no
 * statement fixture, no issuer helpers, no sibling-module imports. The
 * out-of-band verifier context (the execution the verifier expects, and the
 * attester key id trusted out-of-band — key distribution is not V2-014's
 * concern) is read from a context file, exactly as a real verifier operator
 * would hold their own expectations.
 *
 * Performed checks (each a typed outcome, fail-closed):
 *   V1  fresh verification of the exported bytes → VerifiedExecutionFact;
 *   V2  re-presentation with the verifier epoch ADVANCED → ATTESTATION_EPOCH_STALE;
 *   V3  re-presentation with the verifier clock ADVANCED past validity → ATTESTATION_EXPIRED;
 *   V4  re-presentation of the SAME bytes under the SAME freshness state
 *       (single-use nonce already consumed by V1) → ATTESTATION_REPLAYED;
 *   V5  one canonical byte of the action field tampered → ATTESTATION_SIGNATURE_INVALID;
 *   V6  the Run binding mutated in the parsed envelope (re-serialized) →
 *       ATTESTATION_SIGNATURE_INVALID (the signature covers the binding).
 *
 * Usage (spawned by the runner; usable standalone):
 *   bunx tsx tests/integration/execution-attestation/verify-attestation-dogfooding.ts <runDir> [contextFile]
 *
 * Exit code 0 = every check produced its expected typed outcome.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  InMemoryReplayRegistry,
  parseAttestation,
  verifyAttestation,
} from '../../../src/execution-attestation/index.js';
import type {
  AttestationVerification,
  AttestationVerificationPolicy,
  ExecutionAttestation,
  VerifiedExecutionFact,
} from '../../../src/execution-attestation/index.js';

interface VerifierContext {
  readonly runLabel: string;
  readonly attestationFile: string;
  readonly trustedAttesterKeyId: string;
  readonly expected: {
    readonly workflowId: string;
    readonly workflowVersionId: string;
    readonly workflowVersionSemanticDigest: string;
    readonly deploymentId: string;
    readonly runId: string;
    readonly attemptId: number;
    readonly stepId: string;
    readonly nodeId: string;
    readonly causalParents: readonly string[];
  };
  readonly freshness: {
    readonly now: string;
    readonly currentEpoch: number;
    readonly expectedNonce: string;
    readonly maxAgeMs: number;
    readonly advancedEpoch: number;
    readonly lateNow: string;
  };
}

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

/** Assert a typed rejection and return its failure code. */
function expectRejection(
  label: string,
  result: AttestationVerification,
  expectedCode: string,
): string {
  if (result.ok) {
    check(label, false, 'verification SUCCEEDED where a typed rejection was required');
    return '<unexpected-success>';
  }
  const code = result.failure.code;
  check(label, code === expectedCode, `typed rejection code=${code} (expected ${expectedCode}); detail: ${result.failure.detail}`);
  return code;
}

// ---------------------------------------------------------------------------
// Inputs: raw exported bytes + the verifier's own out-of-band context
// ---------------------------------------------------------------------------

const runDir = process.argv[2];
const contextFile = process.argv[3] ?? 'verifier-context.json';
if (runDir === undefined) {
  process.stderr.write('usage: verify-attestation-dogfooding.ts <runDir> [contextFile]\n');
  process.exit(2);
}
const context = JSON.parse(readFileSync(join(runDir, contextFile), 'utf8')) as VerifierContext;
const rawBytes = readFileSync(join(runDir, context.attestationFile), 'utf8');

transcript.push(`independent verifier — ${context.runLabel}`);
transcript.push(`  raw bytes source: ${join(runDir, context.attestationFile)} (${rawBytes.length} chars)`);
transcript.push(`  trusted attester key (out-of-band): ${context.trustedAttesterKeyId}`);
transcript.push(`  expected execution: workflow ${context.expected.workflowId}, version ${context.expected.workflowVersionId}`);
transcript.push(`                    run ${context.expected.runId}, attempt ${context.expected.attemptId}, step ${context.expected.stepId}, node ${context.expected.nodeId}`);
transcript.push('checks:');

// ---------------------------------------------------------------------------
// V1 — fresh verification of the exported bytes (own policy, own registry)
// ---------------------------------------------------------------------------

const parsed = parseAttestation(rawBytes);
check('V1a parse exported canonical bytes', parsed.ok, parsed.ok ? `parsed envelope ${parsed.attestation.attestationId}` : `typed parse failure ${parsed.failure.code}: ${parsed.failure.detail}`);

let attestation: ExecutionAttestation | null = null;
if (parsed.ok) {
  attestation = parsed.attestation;
}

function policyFor(overrides: { now?: string; currentEpoch?: number; reuseRegistry?: InMemoryReplayRegistry }): AttestationVerificationPolicy {
  return {
    bindings: { ...context.expected, causalParents: [...context.expected.causalParents] },
    freshness: {
      now: overrides.now ?? context.freshness.now,
      currentEpoch: overrides.currentEpoch ?? context.freshness.currentEpoch,
      expectedNonce: context.freshness.expectedNonce,
      maxAgeMs: context.freshness.maxAgeMs,
      replayRegistry: overrides.reuseRegistry ?? new InMemoryReplayRegistry(),
    },
    attesterKeyIds: [context.trustedAttesterKeyId],
    requiredAssurance: 'software_signed',
  };
}

const v1Policy = policyFor({});
const v1Result = attestation !== null ? verifyAttestation(attestation, v1Policy) : null;
check('V1b fresh verification through the public verify API', v1Result !== null && v1Result.ok, v1Result === null ? 'no parsed attestation' : v1Result.ok ? `VerifiedExecutionFact ${v1Result.fact.attestationId} (digest ${v1Result.fact.executionDigest.digest.slice(0, 16)}…)` : `typed failure ${v1Result.failure.code}`);

if (v1Result !== null && v1Result.ok) {
  const fact: VerifiedExecutionFact = v1Result.fact;
  check(
    'V1c the verified fact attests ONLY statement authenticity',
    fact.attests === 'statement_authenticity' && fact.neverAsserts.includes('authorization') && fact.neverAsserts.includes('capability_possession') && fact.neverAsserts.includes('observed_effect'),
    `attests=${fact.attests}; neverAsserts=${fact.neverAsserts.join(',')}`,
  );
  check(
    'V1d the fact carries the domain-separated ExecutionDigest',
    fact.executionDigest.domain === 'workflowos/execution-statement/v1' && fact.executionDigest.algorithm === 'sha-256',
    `domain=${fact.executionDigest.domain}, algorithm=${fact.executionDigest.algorithm}`,
  );
  check(
    'V1e the fact binds the exact expected WorkflowVersion/Run/attempt/step/node',
    fact.statement.workflowVersionId === context.expected.workflowVersionId && fact.statement.runId === context.expected.runId && fact.statement.attemptId === context.expected.attemptId && fact.statement.stepId === context.expected.stepId && fact.statement.nodeId === context.expected.nodeId,
    `version=${fact.statement.workflowVersionId}, run=${fact.statement.runId}, attempt=${fact.statement.attemptId}, step=${fact.statement.stepId}, node=${fact.statement.nodeId}`,
  );
}

// ---------------------------------------------------------------------------
// V2/V3/V4 — freshness negatives (valid signature, stale context)
// ---------------------------------------------------------------------------

if (attestation !== null) {
  const epochStale = verifyAttestation(attestation, policyFor({ currentEpoch: context.freshness.advancedEpoch }));
  expectRejection('V2 re-presentation after the verifier epoch advanced', epochStale, 'ATTESTATION_EPOCH_STALE');

  const expired = verifyAttestation(attestation, policyFor({ now: context.freshness.lateNow }));
  expectRejection('V3 re-presentation after the verifier clock advanced past validity', expired, 'ATTESTATION_EXPIRED');

  // same freshness state as V1 (the single-use nonce was consumed by V1):
  const replay = verifyAttestation(attestation, policyFor({ reuseRegistry: (v1Policy.freshness.replayRegistry as InMemoryReplayRegistry) }));
  expectRejection('V4 re-presentation of the same bytes after nonce consumption (same clock, same epoch)', replay, 'ATTESTATION_REPLAYED');

  // -------------------------------------------------------------------------
  // V5 — tamper ONE canonical byte of the action field (payload integrity)
  // -------------------------------------------------------------------------

  const actionMarker = '"action":"';
  const actionIndex = rawBytes.indexOf(actionMarker);
  if (actionIndex < 0) {
    check('V5 tamper one action byte', false, 'the exported bytes carry no action field to tamper');
  } else {
    const flipAt = actionIndex + actionMarker.length;
    const original = rawBytes[flipAt] ?? '';
    const flipped = original === 'P' ? 'Q' : 'P';
    const tampered = rawBytes.slice(0, flipAt) + flipped + rawBytes.slice(flipAt + 1);
    const tamperedParsed = parseAttestation(tampered);
    if (tamperedParsed.ok) {
      const tamperedResult = verifyAttestation(tamperedParsed.attestation, policyFor({}));
      expectRejection('V5 tampered action byte still parses, but verification', tamperedResult, 'ATTESTATION_SIGNATURE_INVALID');
    } else {
      check('V5 tampered action byte', false, `the tampered bytes unexpectedly failed to parse: ${tamperedParsed.failure.code}`);
    }
  }

  // -------------------------------------------------------------------------
  // V6 — mutate the RUN binding in the parsed envelope, re-serialize raw
  // -------------------------------------------------------------------------

  const rebound = JSON.parse(rawBytes) as Record<string, unknown>;
  const reboundStatement = { ...(rebound['statement'] as Record<string, unknown>) };
  reboundStatement['runId'] = 'wfr-attacker-rebound-9999';
  rebound['statement'] = reboundStatement;
  const reboundBytes = JSON.stringify(rebound);
  const reboundParsed = parseAttestation(reboundBytes);
  if (reboundParsed.ok) {
    const reboundResult = verifyAttestation(reboundParsed.attestation, policyFor({}));
    expectRejection('V6 mutated Run binding (re-signed envelope required — attacker has no key)', reboundResult, 'ATTESTATION_SIGNATURE_INVALID');
  } else {
    check('V6 mutated Run binding', false, `the rebound bytes unexpectedly failed to parse: ${reboundParsed.failure.code}`);
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

transcript.push(failures.length === 0 ? '  RESULT: independent verification + all negative experiments behaved as specified' : `  RESULT: ${failures.length} check(s) FAILED`);
process.stdout.write(`${transcript.join('\n')}\n`);
process.exit(failures.length === 0 ? 0 : 1);
