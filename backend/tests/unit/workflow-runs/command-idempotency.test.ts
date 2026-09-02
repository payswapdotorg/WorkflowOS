/**
 * V2-005 — deterministic command correlation + causation (PURE): every command
 * carries a deterministic idempotency/correlation identity; the payload
 * commitment is canonical and order-stable; envelope validation is typed.
 */
import { describe, it, expect } from 'vitest';
import {
  WorkflowRunError,
  type RunCommandEnvelope,
} from '../../../src/workflow-runs/index.js';
import {
  assertRunCommandEnvelope,
  commandPayloadDigest,
} from '../../../src/workflow-runs/internal/run-validation.js';

describe('V2-005 — command envelope validation (typed, fail-closed)', () => {
  it('accepts a well-formed envelope with correlation + optional causation', () => {
    const envelope: RunCommandEnvelope = {
      commandId: 'cmd-triage-start-0001',
      correlationId: 'delivery-9f2c1',
      causationId: 'evt-github-issue-opened-4321',
    };
    expect(() => assertRunCommandEnvelope(envelope)).not.toThrow();
    const withoutCausation: RunCommandEnvelope = {
      commandId: 'cmd-2',
      correlationId: 'delivery-9f2c1',
    };
    expect(() => assertRunCommandEnvelope(withoutCausation)).not.toThrow();
  });

  it('a missing/empty/oversized command id is typed-rejected', () => {
    for (const commandId of ['', '   ', 'x'.repeat(257)]) {
      try {
        assertRunCommandEnvelope({ commandId, correlationId: 'c' });
        expect.unreachable('invalid commandId must be rejected');
      } catch (err) {
        expect((err as WorkflowRunError).code).toBe('RUN_COMMAND_ID_INVALID');
      }
    }
  });

  it('a missing/empty correlation id is typed-rejected (deterministic correlation is REQUIRED)', () => {
    for (const correlationId of ['', '   ']) {
      try {
        assertRunCommandEnvelope({ commandId: 'cmd-1', correlationId });
        expect.unreachable('invalid correlationId must be rejected');
      } catch (err) {
        expect((err as WorkflowRunError).code).toBe('RUN_COMMAND_CORRELATION_ID_INVALID');
      }
    }
  });
});

describe('V2-005 — command payload commitment (canonical, deterministic)', () => {
  it('the same payload always digests identically', () => {
    const payload = { runId: 'wfr_1', stepId: 'notify', outputCommitments: ['a'.repeat(64)] };
    expect(commandPayloadDigest(payload)).toBe(commandPayloadDigest({ ...payload }));
    expect(commandPayloadDigest(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('object key ORDER never changes the payload commitment (canonical JSON)', () => {
    const a = { runId: 'wfr_1', stepId: 'notify' };
    const b = { stepId: 'notify', runId: 'wfr_1' };
    expect(commandPayloadDigest(a)).toBe(commandPayloadDigest(b));
  });

  it('any semantic payload change changes the commitment', () => {
    const payload = { runId: 'wfr_1', stepId: 'notify' };
    expect(commandPayloadDigest({ ...payload, stepId: 'fetch' })).not.toBe(commandPayloadDigest(payload));
    expect(commandPayloadDigest({ ...payload, runId: 'wfr_2' })).not.toBe(commandPayloadDigest(payload));
  });

  it('array order IS preserved in the payload commitment (sequences are not sets here)', () => {
    const a = { commitments: ['a'.repeat(64), 'b'.repeat(64)] };
    const b = { commitments: ['b'.repeat(64), 'a'.repeat(64)] };
    expect(commandPayloadDigest(a)).not.toBe(commandPayloadDigest(b));
  });
});
