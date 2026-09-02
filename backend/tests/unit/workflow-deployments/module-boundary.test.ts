/**
 * V2-009 — module boundary regressions (static, deterministic; the
 * workflow-runs/computer-agent module-boundary pattern adapted to the
 * workflow-deployments scope).
 *
 * Covers the load-bearing boundary contract pinned in
 * src/workflow-deployments/types.ts:
 *
 *   1. DETERMINISM: no Math.random / Date.now / new Date / fetch / timers /
 *      process.env in module CODE (comments stripped first) — every clock and
 *      id source is injected; timezone math receives epochs as NUMBERS.
 *   2. SIBLING SEPARATION: imports are node:crypto, relative module-internal
 *      paths, and the merged sibling BARRELS ONLY (workflow-repository,
 *      workflow-runs, node-capability, workflow-ir, workflow-compiler) —
 *      never a sibling internal/ path.
 *   3. NO RUN/REPOSITORY MUTATION: the module structurally cannot call any
 *      V2-005 service method EXCEPT requestRun (runs are created through the
 *      merged boundary — never started/completed/recorded here), and no
 *      V2-002 mutation method (create/update/install/fork) appears at all.
 *   4. NO SECOND ENGINE: the module never imports the V2-008 computer-agent
 *      runtime and never executes workflow steps (the trigger layer only
 *      instantiates runs).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_URL = new URL('../../../src/workflow-deployments/', import.meta.url);
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

const DETERMINISM_TOKENS = /Math\.random|Date\.now|new Date\b|\bfetch\s*\(|setTimeout|setInterval|setImmediate|process\.env/;

describe('V2-009 — module boundary (static)', () => {
  it('the module exists and is non-trivial', () => {
    expect(MODULE_FILES.length).toBeGreaterThan(0);
    expect(MODULE_FILES.map((f) => relative(MODULE_DIR, f))).toContain('types.ts');
  });

  it('DETERMINISM: no ambient clock, randomness, network or timers in module code', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (DETERMINISM_TOKENS.test(code)) {
        violations.push(`${file} matches nondeterminism pattern ${DETERMINISM_TOKENS}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('imports only sanctioned specifiers (node:crypto, module-internal, merged sibling BARRELS, platform types)', () => {
    const violations: string[] = [];
    const specifierPattern =
      /(?:import\s+[^;]*?from\s*|export\s+(?:type\s+)?\{[^}]*\}\s*from\s*|import\s*['"])['"]([^'"]+)['"]/g;
    const SIBLING_BARREL_PATHS = new Set(
      [
        '../workflow-repository/index.ts',
        '../workflow-ir/index.ts',
        '../workflow-compiler/index.ts',
        '../node-capability/index.ts',
        '../workflow-runs/index.ts',
      ].map((rel) => join(MODULE_DIR, rel)),
    );
    const resolveCandidates = (from: string, specifier: string): string[] => {
      const resolved = join(from, specifier);
      return [resolved, `${resolved}.ts`, resolved.replace(/\.js$/, '.ts'), join(resolved, 'index.ts')];
    };
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] as string;
        if (specifier === 'node:crypto' || specifier.startsWith('node:')) continue;
        if (specifier.startsWith('@platform/')) continue;
        if (specifier.startsWith('.')) {
          const candidates = resolveCandidates(dirname(file), specifier);
          const inside = candidates.some((c) => existsSync(c) && c.startsWith(MODULE_DIR));
          if (inside) continue;
          const isSiblingBarrel = candidates.some((c) => SIBLING_BARREL_PATHS.has(c) && existsSync(c));
          if (!isSiblingBarrel) {
            violations.push(
              `${relative(MODULE_DIR, file)} imports outside the module (not a merged sibling barrel): "${specifier}"`,
            );
          }
          continue;
        }
        violations.push(`${relative(MODULE_DIR, file)} imports unsanctioned "${specifier}"`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('never reaches into a merged sibling\'s internal/ (barrel-only consumption)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      const internalImports = /['"][^'"]*\/internal\/[^'"]*['"]/g;
      for (const match of code.matchAll(internalImports)) {
        const specifier = match[0];
        if (specifier.includes('./internal/') || specifier.includes('../internal/')) continue; // own internals
        violations.push(`${file} imports a sibling internal path: ${specifier}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('RUN BOUNDARY: structurally cannot mutate V2-005 run state — requestRun is the ONLY consumed run method', () => {
    const violations: string[] = [];
    // Service/engine/store code may reference runs.requestRun (the creation
    // boundary); any other V2-005 mutating method name is a boundary breach.
    const forbiddenRunMethods = /\.(startRun|pauseRun|resumeRun|interruptRunAttempt|cancelRun|completeRun|failRun|recordStepStarted|recordStepCompleted|recordInvocationRequested|recordInvocationCompleted|recordEvidence|attachAttestation)\s*\(/;
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (forbiddenRunMethods.test(code)) {
        violations.push(`${file} calls a V2-005 mutation method (runs are created via requestRun only)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('REPOSITORY BOUNDARY: no V2-002 mutation method is called (read-only pin resolution)', () => {
    const violations: string[] = [];
    const forbiddenRepositoryMethods = /\.(createWorkflow|updateWorkflow|createVersion|forkWorkflow|installVersion)\s*\(/;
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (forbiddenRepositoryMethods.test(code)) {
        violations.push(`${file} calls a V2-002 repository mutation method (read-only consumption only)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('NO SECOND ENGINE: never imports the V2-008 computer-agent runtime (execution is the computer-agent runtime, driven elsewhere)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/computer-agent/.test(code)) {
        violations.push(`${file} references the computer-agent module (out of V2-009 scope)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('NO ATTESTATION concepts: V2-014 domain literals never appear in module code', () => {
    const violations: string[] = [];
    const attestationLiterals = /workflowos\/execution-statement\/v1|workflowos\/execution-attestation\/v1|workflowos\/execution-proof-graph\/v1/;
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (attestationLiterals.test(code)) {
        violations.push(`${file} contains a V2-014 domain identifier literal`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
