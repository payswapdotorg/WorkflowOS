import { describe, expect, it } from 'vitest';
import type { ProductVersionComparison } from '../../api/client';
import { tradeOffLines } from './versions-language';

describe('V2-017 T11 — modeled trade-off wording', () => {
  it('labels rubric scores as estimates rather than measurements', () => {
    const comparison = {
      latency: { baseline: 3, candidate: 2 },
    } as ProductVersionComparison;

    expect(tradeOffLines(comparison)).toEqual(['Speed estimated score 3 to 2']);
  });
});
