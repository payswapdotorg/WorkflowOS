import { describe, it, expect } from 'vitest';
import {
  isCompanionMessage,
  message,
  MESSAGE_TYPES,
  type CompanionMessage,
} from '../src/shared/messages.js';

describe('message protocol (§14)', () => {
  it('exposes the full §14 type set', () => {
    for (const t of [
      'WORKFLOWOS_HANDOFF',
      'PROVIDER_DETECTED',
      'START_EXECUTION',
      'STOP_EXECUTION',
      'EXECUTION_PROGRESS',
      'EXECUTION_COMPLETED',
      'EXECUTION_FAILED',
      'EXECUTION_BLOCKED',
      'OPEN_PROVIDER',
    ]) {
      expect(MESSAGE_TYPES).toContain(t);
    }
  });

  it('every envelope carries type, executionId, timestamp, payload', () => {
    const msg = message('EXECUTION_COMPLETED', 'wf_1', { output: 'done' });
    expect(msg.type).toBe('EXECUTION_COMPLETED');
    expect(msg.executionId).toBe('wf_1');
    expect(typeof msg.timestamp).toBe('number');
    expect(msg.payload).toEqual({ output: 'done' });
  });

  it('isCompanionMessage accepts valid envelopes and rejects junk', () => {
    expect(isCompanionMessage(message('GET_STATE', null, {}))).toBe(true);
    expect(isCompanionMessage({ type: 'NOT_A_TYPE', timestamp: 1 })).toBe(false);
    expect(isCompanionMessage({ type: 'GET_STATE' })).toBe(false); // no timestamp
    expect(isCompanionMessage(null)).toBe(false);
    expect(isCompanionMessage('GET_STATE')).toBe(false);
  });

  it('the union is discriminated by type (compile-time contract)', () => {
    const msgs: CompanionMessage[] = [
      message('WORKFLOWOS_HANDOFF', null, { ref: 'wfht_x', origin: 'http://localhost:5173' }),
      message('PROVIDER_DETECTED', null, {
        providerId: 'zai', supported: true, adapterAvailable: false, url: 'https://z.ai',
      }),
      message('EXECUTION_BLOCKED', 'wf_1', { reason: 'adapter pending' }),
    ];
    for (const m of msgs) {
      expect(isCompanionMessage(m)).toBe(true);
    }
    // Narrowing works on the discriminated union.
    if (msgs[2]!.type === 'EXECUTION_BLOCKED') {
      expect(msgs[2].payload.reason).toBe('adapter pending');
    }
  });

  it('handoff messages never embed credentials beyond the one-time ref', () => {
    const handoff = message('WORKFLOWOS_HANDOFF', null, {
      ref: 'wfht_' + 'a'.repeat(32),
      origin: 'http://localhost:5173',
    });
    const serialized = JSON.stringify(handoff);
    expect(serialized).not.toMatch(/wfct_/); // callback token never travels in messages TO content scripts
    expect(serialized).not.toMatch(/x-api-key/i);
  });
});
