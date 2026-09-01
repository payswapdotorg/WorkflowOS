import { describe, it, expect } from 'vitest';
import {
  canonicalStatementJson,
  computeExecutionDigest,
  executionValueCommitment,
  serializeAttestation,
} from '../../../src/execution-attestation/index.js';
import { buildTriageStatement, signTriageAttestation } from './helpers.js';

/**
 * V2-014 — secret/payload non-leakage (invariant 8, execution-attestation.md
 * §Privacy): secrets, raw credentials, bearer tokens and unnecessary sensitive
 * parameter values never enter the statement. Values are bound through
 * one-way sha-256 commitments; the schema has no parameter-carrying field.
 */

const SECRET_MATERIAL_CANARY = 'ghp_live_DEADBEEF_never_serialize_me';
const SECRET_TOKEN_CANARY = 'AKIA1234567890EXAMPLE';
const SECRET_PASSWORD_CANARY = 'hunter2-super-secret-password';

describe('V2-014 one-way commitment of sensitive values', () => {
  it('commits a value to opaque 64-hex sha-256 (the raw value never appears)', () => {
    const commitment = executionValueCommitment(SECRET_MATERIAL_CANARY);
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment).not.toContain(SECRET_MATERIAL_CANARY);
    expect(commitment).not.toContain('ghp');
  });

  it('is deterministic (the same secret → the same commitment — equality without disclosure)', () => {
    expect(executionValueCommitment(SECRET_MATERIAL_CANARY)).toBe(executionValueCommitment(SECRET_MATERIAL_CANARY));
    expect(executionValueCommitment(SECRET_MATERIAL_CANARY)).not.toBe(executionValueCommitment('other-secret'));
  });

  it('commits binary artifacts deterministically (Uint8Array input)', () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]);
    expect(executionValueCommitment(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(executionValueCommitment(bytes)).toBe(executionValueCommitment(new Uint8Array([104, 101, 108, 108, 111])));
    expect(executionValueCommitment(bytes)).not.toBe(executionValueCommitment('hello'));
  });

  it('commits arbitrary byte content the same way regardless of encoding path', () => {
    expect(executionValueCommitment('hello')).toBe(executionValueCommitment(Buffer.from('hello', 'utf8')));
  });
});

describe('V2-014 canonical forms never leak secret material', () => {
  it('the statement canonical JSON contains only commitments for secret-backed inputs', () => {
    const secretCommitment = executionValueCommitment(SECRET_MATERIAL_CANARY);
    const statement = buildTriageStatement({ inputCommitments: [secretCommitment] });
    const bytes = canonicalStatementJson(statement);
    expect(bytes).toContain(secretCommitment);
    expect(bytes).not.toContain(SECRET_MATERIAL_CANARY);
    expect(bytes).not.toContain('DEADBEEF');
  });

  it('the exported attestation bytes contain no canary from any committed input', () => {
    const attestation = signTriageAttestation({
      statement: buildTriageStatement({
        inputCommitments: [executionValueCommitment(SECRET_MATERIAL_CANARY)],
        outputCommitments: [executionValueCommitment(SECRET_TOKEN_CANARY)],
        authorizationContextDigest: executionValueCommitment(SECRET_PASSWORD_CANARY),
      }),
    });
    const bytes = serializeAttestation(attestation);
    expect(bytes).not.toContain(SECRET_MATERIAL_CANARY);
    expect(bytes).not.toContain(SECRET_TOKEN_CANARY);
    expect(bytes).not.toContain(SECRET_PASSWORD_CANARY);
    expect(bytes).not.toContain('ghp_live');
    expect(bytes).not.toContain('AKIA');
    expect(bytes).not.toContain('hunter2');
  });

  it('the digest commits to the committed form (leak-free end to end)', () => {
    const statement = buildTriageStatement({ inputCommitments: [executionValueCommitment(SECRET_MATERIAL_CANARY)] });
    const digest = computeExecutionDigest(statement).digest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(SECRET_MATERIAL_CANARY);
  });
});

describe('V2-014 the schema has no parameter-smuggling surface', () => {
  it('rejects unknown keys (a credentials field cannot be attached to the statement)', () => {
    const smuggled = { ...buildTriageStatement(), credentials: SECRET_MATERIAL_CANARY } as never;
    expect(() => canonicalStatementJson(smuggled)).toThrowError(/invalid|unknown/i);
  });

  it('rejects raw values in commitment positions (only 64-hex commitments are valid)', () => {
    expect(() => computeExecutionDigest(buildTriageStatement({ inputCommitments: [SECRET_MATERIAL_CANARY] }))).toThrow();
    expect(() => computeExecutionDigest(buildTriageStatement({ causalParents: [SECRET_TOKEN_CANARY] }))).toThrow();
  });

  it('documents the honest boundary: opaque string fields carry references, not material', () => {
    // workloadIdentity / evidenceReferences / keyReference are OPAQUE
    // references by contract (the schema validation enforces shape, not
    // content); the SUPPORTED path for sensitive values is the one-way
    // commitment above. This test pins that the schema itself never gains a
    // value-carrying parameter field:
    const statement = buildTriageStatement();
    const keys = Object.keys(JSON.parse(canonicalStatementJson(statement)) as Record<string, unknown>);
    for (const key of keys) {
      expect(key).not.toMatch(/secret|token|password|credential|apikey|api_key/i);
    }
  });
});
