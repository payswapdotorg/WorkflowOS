import { describe, expect, it } from 'vitest';
import indexCss from './index.css?raw';

describe('V2-017 T14 — responsive shell keyboard focus baseline', () => {
  it('keeps focus-visible treatment present for interactive shell controls', () => {
    expect(indexCss).toContain('a:focus-visible');
    expect(indexCss).toContain('button:focus-visible');
    expect(indexCss).toContain('outline: 2px solid var(--color-ring)');
    expect(indexCss).toContain('outline-offset: 2px');
  });
});
