import { describe, it, expect } from 'vitest';
import {
  ExecutionAttestationError,
  InMemoryReplayRegistry,
  verifyAttestation,
} from '../../../src/execution-attestation/index.js';
import {
  LATE_NOW,
  NEWER_EPOCH,
  STATEMENT_EPOCH,
  VERIFY_NOW,
  buildTriageStatement,
  defaultVerifyPolicy,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — freshness + anti-replay (invariant 6): timestamps alone are
 * INSUFFICIENT replay protection. Every replay with a VALID signature but a
 * stale nonce/epoch, an expired interval, or an already-consumed nonce is
 * rejected with a typed failure.
 */

describe('V2-014 replay rejection (valid signature, consumed nonce)', () => {
  it('rejects a re-presented attestation whose nonce was already consumed — even though its timestamps are still fresh', () => {
    const attestation = signTriageAttestation();
    const replayRegistry = new InMemoryReplayRegistry();
    const policy = defaultVerifyPolicy({ replayRegistry, now: VERIFY_NOW });

    const first = verifyAttestation(attestation, policy);
    expect(first.ok).toBe(true);

    // Same bytes, same clock (timestamps fine), same epoch — but the nonce is
    // single-use: the second presentation is a REPLAY.
    const second = verifyAttestation(attestation, policy);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure.code).toBe('ATTESTATION_REPLAYED');
    }
  });

  it('proves timestamps alone are insufficient: fresh clock + fresh interval + consumed nonce still rejects', () => {
    const attestation = signTriageAttestation();
    const registry = new InMemoryReplayRegistry();
    const policy = defaultVerifyPolicy({ replayRegistry: registry });
    expect(verifyAttestation(attestation, policy).ok).toBe(true);

    // even with the clock moved BACK inside the validity interval and the
    // max-age window enlarged, the consumed nonce still rejects:
    const relaxed = defaultVerifyPolicy({
      replayRegistry: registry,
      now: VERIFY_NOW,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
    });
    const replay = verifyAttestation(attestation, relaxed);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.failure.code).toBe('ATTESTATION_REPLAYED');
    }
  });
});

describe('V2-014 stale freshness rejection', () => {
  it('rejects an attestation from a stale epoch (typed EPOCH_STALE)', () => {
    const attestation = signTriageAttestation({ statement: buildTriageStatement({ epoch: STATEMENT_EPOCH - 1 }) });
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ currentEpoch: STATEMENT_EPOCH }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_EPOCH_STALE');
    }
    // the same attestation is acceptable at the older epoch (it is the epoch
    // gap, not the signature, that fails):
    expect(verifyAttestation(attestation, defaultVerifyPolicy({ currentEpoch: STATEMENT_EPOCH - 1 })).ok).toBe(true);
  });

  it('rejects an attestation whose validity interval has expired (typed EXPIRED)', () => {
    const attestation = signTriageAttestation();
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ now: LATE_NOW }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_EXPIRED');
    }
  });

  it('rejects an attestation older than the policy max-age even inside its own validity interval (typed EXPIRED)', () => {
    const attestation = signTriageAttestation();
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ now: VERIFY_NOW, maxAgeMs: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_EXPIRED');
    }
  });

  it('rejects an attestation carrying an unexpected nonce (typed NONCE_UNEXPECTED)', () => {
    const attestation = signTriageAttestation();
    const result = verifyAttestation(attestation, defaultVerifyPolicy({ expectedNonce: 'challenge-for-a-different-attempt' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_NONCE_UNEXPECTED');
    }
  });
});

describe('V2-014 replay-registry consumption semantics (fail-closed)', () => {
  it('consumes the nonce exactly once per successful verification', () => {
    const attestation = signTriageAttestation();
    const registry = new InMemoryReplayRegistry();
    const policy = defaultVerifyPolicy({ replayRegistry: registry });

    expect(registry.isConsumed({ runId: 'wfr-triage-20260901-0001', attemptId: 1, nonce: 'challenge-triage-run-0001-attempt-1' })).toBe(false);
    expect(verifyAttestation(attestation, policy).ok).toBe(true);
    expect(registry.isConsumed({ runId: 'wfr-triage-20260901-0001', attemptId: 1, nonce: 'challenge-triage-run-0001-attempt-1' })).toBe(true);
  });

  it('does NOT consume the nonce when verification fails (a rejected attestation never burns freshness state)', () => {
    const wrongRun = signTriageAttestation({ statement: buildTriageStatement({ runId: 'wfr-triage-20260901-9999' }) });
    const registry = new InMemoryReplayRegistry();
    const policy = defaultVerifyPolicy({ replayRegistry: registry });

    const result = verifyAttestation(wrongRun, policy);
    expect(result.ok).toBe(false);
    expect(registry.isConsumed({ runId: 'wfr-triage-20260901-9999', attemptId: 1, nonce: 'challenge-triage-run-0001-attempt-1' })).toBe(false);
  });

  it('scopes replay state to the exact (run, attempt, nonce) binding — not to the nonce alone', () => {
    const attestation = signTriageAttestation();
    const registry = new InMemoryReplayRegistry();
    expect(verifyAttestation(attestation, defaultVerifyPolicy({ replayRegistry: registry })).ok).toBe(true);

    // the same nonce string in a DIFFERENT run is a different execution
    // binding (fresh state for that run):
    const otherRun = signTriageAttestation({ statement: buildTriageStatement({ runId: 'wfr-triage-20260901-0002' }) });
    const result = verifyAttestation(otherRun, defaultVerifyPolicy({ bindings: { runId: 'wfr-triage-20260901-0002' }, replayRegistry: registry }));
    expect(result.ok).toBe(true);
  });
});

describe('V2-014 freshness policy is mandatory (structural fail-closed)', () => {
  it('rejects a verification policy with NO nonce binding and NO replay registry (timestamps alone are insufficient by construction)', () => {
    const attestation = signTriageAttestation();
    const policy = defaultVerifyPolicy();
    const timestampsOnly = {
      ...policy,
      freshness: { ...policy.freshness, expectedNonce: undefined, replayRegistry: undefined },
    };
    expect(() => verifyAttestation(attestation, timestampsOnly)).toThrow(ExecutionAttestationError);
    expect(() => verifyAttestation(attestation, timestampsOnly)).toThrowError(/nonce/);
  });

  it('accepts a policy that binds the nonce expectation OR the replay registry (either freshness anchor suffices)', () => {
    const attestation = signTriageAttestation();
    const withRegistryOnly = defaultVerifyPolicy();
    (withRegistryOnly.freshness as Record<string, unknown>)['expectedNonce'] = undefined;
    expect(verifyAttestation(attestation, withRegistryOnly).ok).toBe(true);
  });
});
