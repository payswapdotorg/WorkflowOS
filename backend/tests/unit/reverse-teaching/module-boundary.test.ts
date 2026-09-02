import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * V2-010 — the module source boundary (HARD RULE).
 *
 * V2-010 owns the reverse-teaching derivation, lesson content, interactive
 * manual flow, learner practice state and reverse-teaching evidence only.
 * The module CODE imports exactly three sibling barrels — the merged, frozen
 * V2-003 workflow-ir, V2-006 teaching-sessions and the V2-008
 * computer-agent (safe-action classification) — and NOTHING else. No
 * workflow-runs import (the execution/teaching distinction is structural),
 * no sibling INTERNALS (barrel-only consumption), no persistence, no
 * platform/provider packages, no wall clock, no randomness, no network.
 */
const MODULE_ROOT = fileURLToPath(new URL('../../../src/reverse-teaching', import.meta.url));
const TESTS_ROOT = fileURLToPath(new URL('.', import.meta.url));

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Strip comments so boundary NOTES (which say "NOT owned here") never count as concepts — only CODE identifiers do. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const MODULE_FILES = walkTsFiles(MODULE_ROOT);

describe('V2-010 — no execution, run or attestation concepts in the module source code', () => {
  it('src/reverse-teaching/**.ts declares no run/execution/attestation concept in code', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const pattern = /WorkflowRun|requestRun|RunEvidence|RUN_TRIGGER|runId|ExecutionStatement|ExecutionDigest|workflowos\/execution|ExecutionAttestation|proof[-_]?graph/i;
      const matches = source.match(pattern);
      if (matches) {
        violations.push(`${relative(MODULE_ROOT, file)}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the module never mutates V2-006 concepts (no re-export of the ordinary TeachingSession as its own)', () => {
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      // teaching-sessions types are consumed via `import type` only (read-only composition)
      if (source.includes("from '../teaching-sessions/index.js'")) {
        expect(source).toMatch(/import type \{/);
      }
    }
  });
});

describe('V2-010 — the module consumes ONLY the merged workflow-ir, teaching-sessions and computer-agent barrels', () => {
  it('src/reverse-teaching imports no other sibling domain, no internals, no persistence, no providers', () => {
    const violations: string[] = [];
    const allowed = /from\s+'\.\.\/(?:\.\.\/)?(workflow-ir|teaching-sessions|computer-agent)\/index\.js'/;
    const siblingImport = /from\s+'\.\.\/(\.\.\/)?([a-z-]+)\/([a-z./-]*)'/g;
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const matches = [...source.matchAll(siblingImport)];
      for (const match of matches) {
        const target = `../${match[1] ?? ''}${match[2]}/${match[3]}`;
        if (!allowed.test(match[0])) {
          violations.push(`${relative(MODULE_ROOT, file)}: forbidden sibling import "${match[0]}" (${target})`);
        }
        // barrel-only: never a sibling internal path
        if (match[2] === 'teaching-sessions' || match[2] === 'computer-agent' || match[2] === 'workflow-ir') {
          if (match[3] !== 'index.js') {
            violations.push(`${relative(MODULE_ROOT, file)}: non-barrel sibling import "${match[0]}"`);
          }
        }
      }
      const forbiddenImports = /from\s+'(pg|pglite|ioredis|@api|@platform|@modules|fastify)/;
      if (forbiddenImports.test(source)) {
        violations.push(`${relative(MODULE_ROOT, file)}: forbidden provider import`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the module consumes the V2-006 lesson derivation (implementation dependency, not a re-derivation)', () => {
    const derivation = readFileSync(join(MODULE_ROOT, 'internal', 'derivation.ts'), 'utf-8');
    expect(derivation).toContain("from '../../teaching-sessions/index.js'");
    expect(derivation).toContain('deriveLessonFromIrDocument');
  });

  it('the module consumes the V2-008 sensitive-capability classification (contract dependency)', () => {
    const derivation = readFileSync(join(MODULE_ROOT, 'internal', 'derivation.ts'), 'utf-8');
    expect(derivation).toContain("from '../../computer-agent/index.js'");
    expect(derivation).toMatch(/capabilitySensitivityOf/);
  });
});

describe('V2-010 — determinism discipline in the module source', () => {
  it('no wall clock, no randomness, no network in the module code', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const pattern = /\bDate\b|Math\.random|crypto\.random|setTimeout|setInterval|fetch\(|net\.|https?\./;
      const matches = source.match(pattern);
      if (matches) {
        violations.push(`${relative(MODULE_ROOT, file)}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no wall clock, no randomness, no network in the unit tests (injected deterministic sources only)', () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(TESTS_ROOT)) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const pattern = /\bnew Date\b|Date\.now|Math\.random|crypto\.random|\bfetch\(/;
      const matches = source.match(pattern);
      if (matches) {
        violations.push(`${relative(TESTS_ROOT, file)}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
