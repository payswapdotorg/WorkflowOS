/**
 * V2-008 — module boundary regressions (static, deterministic; the
 * workflow-runs module-boundary pattern adapted to the computer-agent scope).
 *
 * Covers the required regressions (the load-bearing boundary contract pinned
 * in src/computer-agent/types.ts):
 *
 *   1. DETERMINISM: no Math.random / Date.now / new Date / fetch / timers /
 *      process.env in module CODE (comments stripped first) — every clock,
 *      id, epoch and key seed is injected.
 *   2. FILESYSTEM ISOLATION: only internal/real-desktop-environment.ts (the
 *      dogfooding-only real host) may import node:fs — every other module
 *      file must NOT (the vitest batteries drive scripted environments).
 *   3. SIBLING SEPARATION: imports are node:crypto, node:fs/promises +
 *      node:path (real-desktop only), relative module-internal paths, and
 *      the merged sibling BARRELS ONLY (workflow-ir, workflow-runs,
 *      node-capability, execution-attestation, workflow-compiler,
 *      workflow-repository) — never a sibling internal/ path.
 *   4. ATTESTATION BOUNDARY: the module never calls raw Ed25519
 *      signing/verification primitives (no generateKeyPairSync / createSign /
 *      createVerify / signSync / verifySync — attestation flows through the
 *      merged V2-014 barrel's sign/verify functions ONLY); the V2-014 frozen
 *      object-type literals never appear in module code (comments only) —
 *      they are referenced through the merged barrel's exported constants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_URL = new URL('../../../src/computer-agent/', import.meta.url);
const MODULE_DIR = fileURLToPath(MODULE_URL);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (entry.endsWith('.ts')) {
      yield full;
    }
  }
}

const MODULE_FILES = existsSync(MODULE_DIR) ? [...walkTs(MODULE_DIR)] : [];

/** Strip // line comments and /* block comments * from TypeScript source. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"])\/\/.*$/gm, '$1');
}

const CODE_WITHOUT_COMMENTS = MODULE_FILES.map((file) => ({
  file: relative(MODULE_DIR, file),
  code: stripComments(readFileSync(file, 'utf8')),
}));

const DETERMINISM_TOKENS = /Math\.random|Date\.now|new Date\b|\bfetch\s*\(|setTimeout|setInterval|process\.env/;

/** The V2-014 frozen object-type literals (registry attestationObjectTypes). */
const ATTESTATION_DOMAIN_LITERALS = [
  /workflowos\/execution-statement\/v1/,
  /workflowos\/execution-attestation\/v1/,
  /workflowos\/execution-proof-graph/,
];

/** Raw Ed25519 signing/verification primitives (V2-014 owns signing). */
const SIGNING_PRIMITIVES = /generateKeyPairSync|createSign|createVerify|signSync|verifySync/;

const REAL_DESKTOP_FILE = 'internal/real-desktop-environment.ts';

/** The merged sibling barrel entry points this module may consume. */
const SIBLING_BARREL_PATHS = new Set(
  [
    '../workflow-ir/index.ts',
    '../workflow-runs/index.ts',
    '../node-capability/index.ts',
    '../execution-attestation/index.ts',
    '../workflow-compiler/index.ts',
    '../workflow-repository/index.ts',
  ].map((rel) => join(MODULE_DIR, rel)),
);

const importSpecifierPattern =
  /(?:import\s+[^;]*?from\s*|export\s+(?:type\s+)?\{[^}]*\}\s*from\s*|import\s*['"])['"]([^'"]+)['"]/g;

describe('V2-008 module boundary (determinism, filesystem isolation, sibling separation, attestation authority)', () => {
  it('scans a non-empty module with the canonical layout', () => {
    expect(MODULE_FILES.length).toBeGreaterThanOrEqual(10);
    const files = MODULE_FILES.map((file) => relative(MODULE_DIR, file)).sort();
    expect(files).toContain('index.ts');
    expect(files).toContain('types.ts');
    expect(files.filter((file) => file.startsWith('internal')).length).toBeGreaterThanOrEqual(8);
    expect(files).toContain(REAL_DESKTOP_FILE);
  });

  it('contains no wall-clock/randomness/network/env dependence in module code (comments stripped)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (DETERMINISM_TOKENS.test(code)) {
        violations.push(`${file} matches nondeterminism pattern ${DETERMINISM_TOKENS}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('FILESYSTEM ISOLATION: only the dogfooding real-desktop host may import node:fs', () => {
    const violations: string[] = [];
    let realDesktopImportsFs = false;
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      const specifiers = [...source.matchAll(importSpecifierPattern)].map((match) => match[1] as string);
      const fsSpecifiers = specifiers.filter((specifier) => /^node:fs(\/|$)/.test(specifier) || /^fs(\/|$)/.test(specifier));
      const rel = relative(MODULE_DIR, file);
      if (rel === REAL_DESKTOP_FILE) {
        realDesktopImportsFs = fsSpecifiers.length > 0 && fsSpecifiers.includes('node:fs/promises');
        continue;
      }
      if (fsSpecifiers.length > 0) {
        violations.push(`${rel} imports filesystem module(s) ${fsSpecifiers.join(', ')} (real-desktop only)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
    // the pin is two-sided: the real host REALLY uses the real fs
    expect(realDesktopImportsFs, 'internal/real-desktop-environment.ts must import node:fs/promises').toBe(true);
  });

  it('imports only sanctioned specifiers (builtins, module-internal, merged sibling BARRELS)', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(MODULE_DIR, file);
      for (const match of source.matchAll(importSpecifierPattern)) {
        const specifier = match[1] as string;
        // pure deterministic node builtins (crypto anywhere; fs/promises +
        // path only for the real filesystem host)
        if (specifier === 'node:crypto') continue;
        if (specifier === 'node:fs/promises' || specifier === 'node:path') {
          if (rel === REAL_DESKTOP_FILE) continue;
          violations.push(`${rel} imports "${specifier}" (real-desktop only)`);
          continue;
        }
        if (specifier.startsWith('node:')) {
          violations.push(`${rel} imports unsanctioned builtin "${specifier}"`);
          continue;
        }
        if (specifier.startsWith('.')) {
          const resolved = join(dirname(file), specifier);
          const candidates = [resolved, `${resolved}.ts`, resolved.replace(/\.js$/, '.ts'), join(resolved, 'index.ts')];
          const inside = candidates.some((candidate) => existsSync(candidate) && candidate.startsWith(MODULE_DIR));
          if (inside) continue;
          const isSiblingBarrel = candidates.some(
            (candidate) => SIBLING_BARREL_PATHS.has(candidate) && existsSync(candidate),
          );
          if (!isSiblingBarrel) {
            violations.push(`${rel} imports outside the module (not a merged sibling barrel): "${specifier}"`);
          }
          continue;
        }
        violations.push(`${rel} imports unsanctioned "${specifier}"`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('never reaches into a merged sibling\'s internal/ (barrel-only consumption)', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(MODULE_DIR, file);
      for (const match of source.matchAll(/['"](\.\.?\/[^'"]+)['"]/g)) {
        const specifier = match[1] as string;
        if (/workflow-ir\/internal|workflow-runs\/internal|node-capability\/internal|execution-attestation\/internal|workflow-compiler\/internal|workflow-repository\/internal/.test(specifier)) {
          violations.push(`${rel} reaches into a sibling internal/: "${specifier}"`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('contains NO V2-014 domain-identifier literals in code (attestation object types are V2-014\'s)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      for (const pattern of ATTESTATION_DOMAIN_LITERALS) {
        if (pattern.test(code)) {
          violations.push(`${file} matches ${pattern}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('signs NOTHING directly: no raw Ed25519 signing/verification primitives in code', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (SIGNING_PRIMITIVES.test(code)) {
        violations.push(`${file} matches ${SIGNING_PRIMITIVES}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('consumes the merged sibling barrels the boundary contract names (structural presence)', () => {
    // the module's real consumption surface is pinned by the source itself:
    // the barrels the runtime/hosts/attesting path actually import.
    const allSource = CODE_WITHOUT_COMMENTS.map(({ code }) => code).join('\n');
    for (const barrel of [
      'workflow-ir/index.js',
      'workflow-runs/index.js',
      'node-capability/index.js',
      'execution-attestation/index.js',
      'workflow-compiler/index.js',
      'workflow-repository/index.js',
    ]) {
      expect(allSource, `the module consumes the merged ${barrel} barrel`).toContain(barrel);
    }
  });
});
