/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FROZEN_MODULE_NAMES, type ModuleContract } from '@platform/module-contract.js';

/**
 * Static architecture checks for WORK-001.
 *
 * - PLAT-AC-01: Frozen modules exist as explicit backend boundaries.
 *   Evidence: every module in {@link FROZEN_MODULE_NAMES} has a directory at
 *   `src/modules/<name>/` exporting a `ModuleContract` whose `name` matches.
 *
 * - PLAT-AC-02: Cross-module calls use declared interfaces rather than another
 *   module's internal implementation.
 *   Evidence: scanning every `import`/`export from` specifier in
 *   `src/modules/**` and verifying none resolves into another module's
 *   `internal/` directory or any non-index file.
 *
 * These tests run statically (no running process) and are part of `npm test`
 * so they execute on every CI run.
 */

const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MODULES_DIR = join(BACKEND_ROOT, 'src', 'modules');
const SRC_ROOT = join(BACKEND_ROOT, 'src');

// Eagerly import every frozen module's public surface so we can assert its
// runtime contract value, not just that the file exists. This is the
// PLAT-AC-01 "static architecture check" evidence: the module boundary is
// mechanically present AND exports a ModuleContract with the canonical name.
const moduleImports = import.meta.glob<{ default?: ModuleContract } & Record<string, unknown>>(
  '../../src/modules/*/index.ts',
  { eager: true },
);

function kebabToCamel(s: string): string {
  const parts = s.split('-');
  return parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join('');
}

function moduleDir(name: string): string {
  // '/work-items' -> 'work-items'
  return name.slice(1);
}

/** Recursively yield every `.ts` file under `dir`. */
function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTs(full);
    } else if (st.isFile() && entry.endsWith('.ts')) {
      yield full;
    }
  }
}

/**
 * Returns the module name (directory name under `src/modules/`) that owns
 * `absPath`, or `undefined` when the path is not under any module.
 */
function moduleOf(absPath: string): string | undefined {
  const rel = relative(MODULES_DIR, absPath);
  if (rel.startsWith('..') || rel === '') return undefined;
  const firstSep = rel.indexOf(sep);
  if (firstSep === -1) return undefined;
  return rel.slice(0, firstSep);
}

/** True when `absPath` is inside any module's `internal/` directory. */
function isInsideInternal(absPath: string): boolean {
  const rel = relative(MODULES_DIR, absPath);
  return rel.split(sep).includes('internal');
}

const FROM_RE = /(?:import|export)(?:\s+type)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extract every static + dynamic import specifier from a TS file. */
function extractSpecifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(FROM_RE)) out.push(m[1]!);
  for (const m of src.matchAll(DYNAMIC_IMPORT_RE)) out.push(m[1]!);
  return out;
}

/** Resolve a specifier relative to an importer file. Returns the resolved
 * absolute path (with .ts extension), or undefined if it cannot be resolved.
 *
 * Handles the TypeScript ESM convention where imports use a `.js` suffix that
 * refers to a `.ts` source file (e.g. `import { Foo } from './foo.js'`).
 */
function resolveSpecifier(importer: string, specifier: string): string | undefined {
  const normalized = specifier.replace(/\.js$/, '');
  let candidate: string | undefined;
  if (normalized.startsWith('./') || normalized.startsWith('../') || normalized.startsWith('/')) {
    candidate = resolve(dirname(importer), normalized);
  } else if (normalized.startsWith('@modules/')) {
    candidate = join(SRC_ROOT, 'modules', normalized.slice('@modules/'.length));
  } else if (normalized.startsWith('@platform/')) {
    candidate = join(SRC_ROOT, 'platform', normalized.slice('@platform/'.length));
  } else if (normalized.startsWith('@api/')) {
    candidate = join(SRC_ROOT, 'api', normalized.slice('@api/'.length));
  } else if (normalized.startsWith('@root/')) {
    candidate = join(SRC_ROOT, normalized.slice('@root/'.length));
  } else {
    return undefined;
  }
  const tries = [candidate, `${candidate}.ts`, join(candidate, 'index.ts')];
  for (const t of tries) {
    if (t && existsSync(t) && statSync(t).isFile()) return t;
  }
  return undefined;
}

describe('PLAT-AC-01 — frozen modules exist as explicit boundaries', () => {
  it('FROZEN_MODULE_NAMES covers exactly the 17 frozen backend modules', () => {
    expect(FROZEN_MODULE_NAMES).toHaveLength(17);
    expect(new Set(FROZEN_MODULE_NAMES).size).toBe(17);
    for (const name of FROZEN_MODULE_NAMES) expect(name.startsWith('/')).toBe(true);
  });
  for (const name of FROZEN_MODULE_NAMES) {
    const dir = moduleDir(name);
    it(`module ${name} has a directory at src/modules/${dir}`, () => {
      const path = join(MODULES_DIR, dir);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).isDirectory()).toBe(true);
    });
    it(`module ${name} exposes index.ts`, () => {
      const index = join(MODULES_DIR, dir, 'index.ts');
      expect(existsSync(index)).toBe(true);
      expect(statSync(index).isFile()).toBe(true);
    });
    it(`module ${name} has an internal/ private area`, () => {
      const internal = join(MODULES_DIR, dir, 'internal');
      expect(existsSync(internal)).toBe(true);
      expect(statSync(internal).isDirectory()).toBe(true);
    });
    it(`module ${name} exports a ModuleContract with the canonical name`, () => {
      const suffix = `src/modules/${dir}/index.ts`;
      const key = Object.keys(moduleImports).find((k) => k.endsWith(suffix));
      const mod = key ? (moduleImports[key] as ({ default?: ModuleContract } & Record<string, unknown>) | undefined) : undefined;
      expect(mod, `expected to find imported module for ${suffix}`).toBeDefined();
      const contract = mod?.default ?? mod?.[`${kebabToCamel(dir)}Module`];
      expect(contract).toBeDefined();
      expect((contract as ModuleContract).name).toBe(name);
    });
  }
  it('no unexpected module directories exist under src/modules/', () => {
    const present = readdirSync(MODULES_DIR).filter((e) => statSync(join(MODULES_DIR, e)).isDirectory());
    const expected = FROZEN_MODULE_NAMES.map(moduleDir);
    expect(new Set(present)).toEqual(new Set(expected));
  });
});

describe('PLAT-AC-02 — cross-module calls use declared interfaces', () => {
  it('no module imports another module internal/ directory', () => {
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const importerModule = moduleOf(file);
      if (!importerModule) continue;
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === importerModule) continue;
        if (isInsideInternal(resolved)) {
          violations.push(`${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ${relative(BACKEND_ROOT, resolved)}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no module imports another module non-index file (only the index.ts public interface)', () => {
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const importerModule = moduleOf(file);
      if (!importerModule) continue;
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === importerModule) continue;
        const relToModule = relative(join(MODULES_DIR, targetModule), resolved);
        const firstSeg = relToModule.split(sep)[0];
        if (firstSeg !== 'index.ts') {
          violations.push(`${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ${relative(BACKEND_ROOT, resolved)}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('architecture invariants — forbidden dependency directions', () => {
  it('platform runtime does not import from any domain module', () => {
    const platformDir = join(SRC_ROOT, 'platform');
    const violations: string[] = [];
    for (const file of walkTs(platformDir)) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        if (moduleOf(resolved)) violations.push(`${relative(BACKEND_ROOT, file)} imports domain module "${specifier}" -> ${relative(BACKEND_ROOT, resolved)}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('api layer does not reach into any module internal/', () => {
    const apiDir = join(SRC_ROOT, 'api');
    const violations: string[] = [];
    for (const file of walkTs(apiDir)) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        if (moduleOf(resolved) && isInsideInternal(resolved)) violations.push(`${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ${relative(BACKEND_ROOT, resolved)}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

// The remainder of this file is the repository's existing architecture checks
// unchanged. WORK-043 adds its invariants below.

describe('WORK-043 invariants — Execution Eligibility and Constraint Engine (§33.3)', () => {
  const EXEC_POLICY = join(SRC_ROOT, 'execution-policy');
  const HANDOFF = join(SRC_ROOT, 'modules', 'agents', 'internal', 'default-cross-mode-handoff-service.ts');
  const EXECUTION_ROUTE = join(SRC_ROOT, 'api', 'routes', 'execution.route.ts');

  it('the handoff gate re-evaluates the RESOLVED destination AFTER provider resolution + BEFORE the reserve', () => {
    const src = readFileSync(HANDOFF, 'utf8');
    const policyGateIdx = src.indexOf('await this.policyGate(');
    const resolveIdx = src.indexOf('await this.resolveProviderModel(');
    const destGateIdx = src.indexOf('await this.destinationEligibilityGate(');
    const reserveIdx = src.indexOf('await this.reserveAndClaim(');
    expect(policyGateIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(policyGateIdx);
    expect(destGateIdx, 'the destination gate runs after provider resolution').toBeGreaterThan(resolveIdx);
    expect(reserveIdx, 'the destination gate runs before the reserve (side-effect-free rejection)').toBeGreaterThan(destGateIdx);
    expect(src).toMatch(/handoff-ineligible-destination/);
    expect(src).toMatch(/failing closed/);
    // WORK-043: the destination gate is mandatory and requires an authoritative
    // Project → Organization resolution. No pre-WORK-043 `not_evaluated` bypass
    // is permitted: an unresolved organization fails the handoff closed.
    expect(src).toMatch(/evaluateCandidateEligibility\(input:/);
    expect(src).toMatch(/organizationResolver\.getOrganizationId\(record\.projectId\)/);
    expect(src).not.toMatch(/organizationId:\s*null/);
    const types = readFileSync(join(SRC_ROOT, 'modules', 'agents', 'internal', 'cross-mode-handoff.types.ts'), 'utf8');
    expect(types).toMatch(/'handoff-ineligible-destination'/);
    const route = readFileSync(EXECUTION_ROUTE, 'utf8');
    expect(route).toMatch(/case 'handoff-ineligible-destination'/);
  });

  it('the execution service has a mandatory final admission boundary before provider submission', () => {
    const src = readFileSync(join(SRC_ROOT, 'modules', 'agents', 'internal', 'execution-service.ts'), 'utf8');
    expect(src).toMatch(/readonly executionAdmission:\s*ExecutionAdmissionPort/);
    expect(src).toMatch(/await this\.deps\.executionAdmission\.admit\(task\)/);
    expect(src.indexOf('executionAdmission.admit')).toBeLessThan(src.indexOf('provider.submit'));
  });
});
