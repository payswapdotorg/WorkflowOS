import { describe, it, expect } from 'vitest';
import {
  runWithExecutionContext,
  getExecutionContext,
  getExecutionId,
  ensureExecutionId,
} from '@platform/execution-context.js';
import { generateExecutionId } from '@platform/ids.js';

describe('execution context', () => {
  it('generates execution ids with the workflowos prefix', () => {
    const id = generateExecutionId();
    expect(id).toMatch(/^wf_[0-9a-f]{8}$/);
  });

  it('returns undefined outside of a context', () => {
    expect(getExecutionContext()).toBeUndefined();
    expect(getExecutionId()).toBeUndefined();
  });

  it('propagates the execution id through async chains (AsyncLocalStorage)', async () => {
    const executionId = 'wf_test1234';
    const seen: (string | undefined)[] = [];
    await runWithExecutionContext({ executionId }, async () => {
      seen.push(getExecutionId());
      await new Promise((r) => setTimeout(r, 0));
      seen.push(getExecutionId());
      await Promise.resolve().then(() => {
        seen.push(getExecutionId());
      });
    });
    expect(seen).toEqual([executionId, executionId, executionId]);
    // Cleared once the context exits.
    expect(getExecutionId()).toBeUndefined();
  });

  it('does not leak across concurrent contexts', async () => {
    const observed: Record<string, string | undefined> = {};
    const a = runWithExecutionContext({ executionId: 'wf_aaaaaaaa' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      observed.a = getExecutionId();
    });
    const b = runWithExecutionContext({ executionId: 'wf_bbbbbbbb' }, async () => {
      await new Promise((r) => setTimeout(r, 0));
      observed.b = getExecutionId();
    });
    await Promise.all([a, b]);
    expect(observed.a).toBe('wf_aaaaaaaa');
    expect(observed.b).toBe('wf_bbbbbbbb');
  });

  it('ensureExecutionId returns the active id when present', async () => {
    await runWithExecutionContext({ executionId: 'wf_active1' }, async () => {
      expect(ensureExecutionId()).toBe('wf_active1');
    });
  });

  it('ensureExecutionId generates a fresh id when no context is active', () => {
    const id = ensureExecutionId();
    expect(id).toMatch(/^wf_[0-9a-f]{8}$/);
  });

  it('preserves correlationId and actor fields', async () => {
    await runWithExecutionContext(
      { executionId: 'wf_corr1', correlationId: 'wf_corr_root', actor: 'user-1' },
      async () => {
        const ctx = getExecutionContext();
        expect(ctx?.executionId).toBe('wf_corr1');
        expect(ctx?.correlationId).toBe('wf_corr_root');
        expect(ctx?.actor).toBe('user-1');
      },
    );
  });
});
