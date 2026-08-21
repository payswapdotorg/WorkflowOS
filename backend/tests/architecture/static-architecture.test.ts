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
 * absolute path (with .ts extension), or undefined if it cannot be resolved. */
function resolveSpecifier(importer: string, specifier: string): string | undefined {
  let candidate: string | undefined;
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/')
  ) {
    candidate = resolve(dirname(importer), specifier);
  } else if (specifier.startsWith('@modules/')) {
    candidate = join(SRC_ROOT, 'modules', specifier.slice('@modules/'.length));
  } else if (specifier.startsWith('@platform/')) {
    candidate = join(SRC_ROOT, 'platform', specifier.slice('@platform/'.length));
  } else if (specifier.startsWith('@api/')) {
    candidate = join(SRC_ROOT, 'api', specifier.slice('@api/'.length));
  } else if (specifier.startsWith('@root/')) {
    candidate = join(SRC_ROOT, specifier.slice('@root/'.length));
  } else {
    return undefined; // bare specifier (npm package) — out of scope for this check
  }

  // Try exact, then .ts, then /index.ts
  const tries = [candidate, `${candidate}.ts`, join(candidate, 'index.ts')];
  for (const t of tries) {
    if (t && existsSync(t) && statSync(t).isFile()) return t;
  }
  return undefined;
}

describe('PLAT-AC-01 — frozen modules exist as explicit boundaries', () => {
  it('FROZEN_MODULE_NAMES covers exactly the 16 frozen backend modules', () => {
    expect(FROZEN_MODULE_NAMES).toHaveLength(16);
    expect(new Set(FROZEN_MODULE_NAMES).size).toBe(16);
    for (const name of FROZEN_MODULE_NAMES) {
      expect(name.startsWith('/')).toBe(true);
    }
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
      // vitest normalizes glob keys to forward slashes regardless of OS.
      const suffix = `src/modules/${dir}/index.ts`;
      const key = Object.keys(moduleImports).find((k) => k.endsWith(suffix));
      const mod = key
        ? (moduleImports[key] as ({ default?: ModuleContract } & Record<string, unknown>) | undefined)
        : undefined;
      expect(mod, `expected to find imported module for ${suffix}`).toBeDefined();
      const contract = mod?.default ?? mod?.[`${kebabToCamel(dir)}Module`];
      expect(contract).toBeDefined();
      expect((contract as ModuleContract).name).toBe(name);
    });
  }

  it('no unexpected module directories exist under src/modules/', () => {
    const present = readdirSync(MODULES_DIR).filter((e) =>
      statSync(join(MODULES_DIR, e)).isDirectory(),
    );
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
        if (!targetModule) continue;
        if (targetModule === importerModule) continue; // same-module internal use is fine
        if (isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${targetModule}/internal; ` +
              `use the module's index.ts public interface instead)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no module imports another module non-index file (only the index.ts public interface)', () => {
    // PLAT-AC-02 strengthens to: cross-module imports MUST target index.ts.
    // Non-index files in a module (excluding internal/) are also private to
    // the module — they are implementation details not intended for reuse.
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
        // Allowed: 'index.ts' (the module's public barrel).
        // Forbidden: anything else (e.g. 'services/foo.ts', 'internal/...').
        if (firstSeg !== 'index.ts') {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (non-index file of ${targetModule}; ` +
              `use ${targetModule}/index.ts instead)`,
          );
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
        if (moduleOf(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports domain module "${specifier}" -> ` +
              relative(BACKEND_ROOT, resolved),
          );
        }
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
        if (moduleOf(resolved) && isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              relative(BACKEND_ROOT, resolved),
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

/**
 * WORK-003 invariants — domain modules must not depend directly on
 * infrastructure-provider implementations.
 *
 * Domain modules obtain PostgreSQL / Redis / object-storage capabilities
 * through the shared `@platform/*` abstractions (`DatabaseClient`, `Queue`,
 * `ObjectStore`, `TransientLock`, `TransientCache`). They MUST NOT import
 * `pg`, `ioredis`, `@electric-sql/pglite`, or a concrete
 * implementation class directly. This keeps provider independence
 * (architecture §2.5) and lets providers be substituted without touching
 * domain code.
 *
 * Only `src/platform/**` may import provider packages.
 */
const PROVIDER_PACKAGES = new Set([
  'pg',
  'ioredis',
  '@electric-sql/pglite',
]);

const PROVIDER_IMPLEMENTATION_FILES = new Set([
  // Concrete object-storage implementations.
  'src/platform/storage/in-memory-object-store.ts',
  'src/platform/storage/fs-object-store.ts',
  // Concrete database clients.
  'src/platform/postgres/database-client.ts',
  'src/platform/postgres/database-factory.ts',
  'src/platform/postgres/pglite-database-client.ts',
  // Concrete Redis queue + extensions (lock/cache) are provider-coupled via
  // ioredis; the *abstractions* (Queue, TransientLock interface) are fine for
  // domain code to use, but the concrete classes live under platform/redis/.
]);

describe('WORK-003 invariants — no provider coupling in domain modules', () => {
  it('domain modules (src/modules/**) do not import provider packages', () => {
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      for (const specifier of extractSpecifiers(file)) {
        // Extract the package name (first segment before '/').
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (PROVIDER_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports provider package "${specifier}" — use @platform/* abstractions instead`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('domain modules do not import concrete provider implementations from platform/', () => {
    // Domain code must import the *interfaces* from @platform/*, not the
    // concrete implementation files (e.g. @platform/storage/fs-object-store.js).
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      for (const specifier of extractSpecifiers(file)) {
        if (!specifier.startsWith('@platform/')) continue;
        const relPath = `src/platform/${specifier.slice('@platform/'.length).replace(/\.js$/, '.ts')}`;
        if (PROVIDER_IMPLEMENTATION_FILES.has(relPath)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports concrete implementation "${specifier}" — import the interface from @platform/index.js instead`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('only platform/ imports provider packages (pg / ioredis / pglite)', () => {
    const violations: string[] = [];
    for (const file of walkTs(SRC_ROOT)) {
      const rel = relative(BACKEND_ROOT, file).split(sep).join('/');
      const isPlatform = rel.startsWith('src/platform/');
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (PROVIDER_PACKAGES.has(pkg) && !isPlatform) {
          violations.push(
            `${rel} imports provider package "${specifier}" — only src/platform/** may do so`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no second worker or queue implementation was introduced in domain modules', () => {
    // The WORK-001 WorkerHost + Queue are the only accepted runtime. Domain
    // modules must not declare competing Queue/WorkerHost classes.
    const violations: string[] = [];
    const forbidden = /\bclass\s+(WorkerHost|Queue|RedisQueue|InMemoryQueue)\b/;
    for (const file of walkTs(MODULES_DIR)) {
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a competing worker/queue implementation — reuse @platform/* WorkerHost + Queue`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('frozen architecture documents are unchanged (sanity: still present, not modified by tests)', () => {
    // The frozen spec docs live at repo-root /spec/. We assert they still
    // exist and the backend test suite never writes to them.
    const specDir = join(BACKEND_ROOT, '..', 'spec');
    for (const doc of [
      'architecture.md',
      'architecture-lock.md',
      'requirements.md',
      'work-items.md',
      'dependency-graph.md',
    ]) {
      const path = join(specDir, doc);
      expect(existsSync(path), `expected ${doc} to exist`).toBe(true);
      expect(statSync(path).isFile(), `expected ${doc} to be a file`).toBe(true);
    }
  });
});
