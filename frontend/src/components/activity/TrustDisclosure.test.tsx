import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// T15 correction: resolve the sibling source file WITHOUT `new URL(relative,
// import.meta.url)`. Under this suite's jsdom environment the global `URL`
// constructor resolves relative specifiers against the jsdom document base
// (http://localhost:3000/…) instead of the module's file URL, so
// `fileURLToPath(new URL('./TrustDisclosure.tsx', import.meta.url))` throws
// "The URL must be of scheme file" and the suite fails at collection — the
// inherited T15 baseline failure. `fileURLToPath` on the import.meta.url
// STRING uses Node's internal URL parser (immune to the jsdom global), then
// path.join resolves the sibling — the same discipline the backend vitest
// config documents for keeping `import.meta.url` usable (see
// backend/vitest.config.ts: avoid jsdom transforming module file lookups).
const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'TrustDisclosure.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('V2-017 T10 — trust disclosure keyboard affordance', () => {
  it('keeps the advanced verification disclosure visibly focusable', () => {
    expect(source).toContain('focus-visible:outline-2');
    expect(source).toContain('focus-visible:outline-offset-2');
    expect(source).toContain('focus-visible:outline-ring');
  });
});
