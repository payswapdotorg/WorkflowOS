import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./TrustDisclosure.tsx', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');

describe('V2-017 T10 — trust disclosure keyboard affordance', () => {
  it('keeps the advanced verification disclosure visibly focusable', () => {
    expect(source).toContain('focus-visible:outline-2');
    expect(source).toContain('focus-visible:outline-offset-2');
    expect(source).toContain('focus-visible:outline-ring');
  });
});
