import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// T15 correction: read the stylesheet from disk instead of `import ...
// from './index.css?raw'`. With this repo's frozen vitest config (`css:
// false`), vitest stubs CSS-shaped modules — including the `?raw` query —
// so the `?raw` import resolved to an EMPTY string and the T14 focus-visible
// assertions failed against '' (the inherited T15 baseline failure; the
// stylesheet itself contains the rules). Reading the resolved file path is
// deterministic under the repo's own config.
const indexCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8');

describe('V2-017 T14 — responsive shell keyboard focus baseline', () => {
  it('keeps focus-visible treatment present for interactive shell controls', () => {
    expect(indexCss).toContain('a:focus-visible');
    expect(indexCss).toContain('button:focus-visible');
    expect(indexCss).toContain('outline: 2px solid var(--color-ring)');
    expect(indexCss).toContain('outline-offset: 2px');
  });
});
