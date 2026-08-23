import { describe, it, expect } from 'vitest';
import {
  parseHandoffFragment,
  isHandoffPage,
  buildHandoffFragment,
} from '../src/shared/handoff.js';

describe('handoff parsing (§6/§20)', () => {
  it('parses a well-formed ref + exec fragment', () => {
    const ref = 'wfht_' + 'ab'.repeat(32);
    const parsed = parseHandoffFragment(buildHandoffFragment(ref, 'wf_abc12345'));
    expect(parsed).toEqual({ ref, executionId: 'wf_abc12345' });
  });

  it('parses a ref-only fragment', () => {
    const ref = 'wfht_' + 'cd'.repeat(32);
    const parsed = parseHandoffFragment(`#ref=${ref}`);
    expect(parsed).toEqual({ ref, executionId: undefined });
  });

  it('rejects missing ref', () => {
    expect(parseHandoffFragment('#exec=wf_1')).toBeNull();
    expect(parseHandoffFragment('')).toBeNull();
    expect(parseHandoffFragment('ref=xyz')).toBeNull(); // not a fragment
  });

  it('rejects malformed refs (strict wfht_hex shape)', () => {
    expect(parseHandoffFragment('#ref=garbage')).toBeNull();
    expect(parseHandoffFragment('#ref=wfht_SHORT')).toBeNull();
    expect(parseHandoffFragment('#ref=wfht_not-hex!')).toBeNull();
    // Anything that is not the opaque one-time reference must never pass.
    expect(parseHandoffFragment('#ref=sk-live-api-key')).toBeNull();
  });

  it('never carries prompt or callback-token-shaped values', () => {
    const ref = 'wfht_' + 'ef'.repeat(32);
    const fragment = buildHandoffFragment(ref, 'wf_1');
    expect(fragment).not.toMatch(/wfct_/); // callback token
    expect(fragment).not.toMatch(/prompt/i);
  });

  it('identifies handoff pages', () => {
    expect(isHandoffPage('/companion/handoff')).toBe(true);
    expect(isHandoffPage('/companion/handoff/')).toBe(true);
    expect(isHandoffPage('/projects/123')).toBe(false);
    expect(isHandoffPage('/companion')).toBe(false);
  });
});
