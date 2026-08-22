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
 * refers to a `.ts` source file (e.g. `import { Foo } from './foo.js'` resolves
 * to `./foo.ts`). The `.js` suffix is stripped BEFORE resolution so the
 * resolver finds the actual source file. Without this normalization, `.js`
 * imports would fail to resolve and PLAT-AC-02 boundary checks would silently
 * pass even when cross-module `internal/` violations exist (architect review,
 * PR #4).
 */
function resolveSpecifier(importer: string, specifier: string): string | undefined {
  // Normalize: TypeScript ESM imports use `.js` suffixes that refer to `.ts`
  // source files. Strip the trailing `.js` so the resolver finds the source.
  // This is the convention used throughout this repository.
  const normalized = specifier.replace(/\.js$/, '');
  let candidate: string | undefined;
  if (
    normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
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
 *
 * Correction 2 (architect review): the forbidden set now covers ALL concrete
 * WORK-003 infrastructure implementations — including the Redis
 * `TransientLock` / `TransientCache` classes, `RedisQueue`, `InMemoryQueue`,
 * the concrete object-store implementations, the database client/factory
 * classes, the migration runner, the DI container, and the artifact-metadata
 * repository. A complementary name-level check parses barrel value-imports
 * so a domain module cannot import a concrete class/factory by name from
 * `@platform/index.js` either.
 */
const PROVIDER_PACKAGES = new Set([
  'pg',
  'ioredis',
  '@electric-sql/pglite',
]);

/**
 * Every concrete infrastructure/provider implementation file under
 * `src/platform/`. Domain modules MUST NOT import these files directly (via
 * `@platform/<subpath>`); they must use the provider-independent interfaces
 * re-exported from `@platform/index.js`.
 *
 * This list is exhaustive for the WORK-003 foundation. When a future work
 * item adds a new concrete implementation, it must be added here too.
 */
const PROVIDER_IMPLEMENTATION_FILES = new Set([
  // --- PostgreSQL (DATA-001) ---
  'src/platform/postgres/database-client.ts', // PgDatabaseClient (imports pg)
  'src/platform/postgres/database-factory.ts', // createDatabaseClient (imports pg)
  'src/platform/postgres/pglite-database-client.ts', // PgliteDatabaseClient (imports pglite)
  'src/platform/postgres/migration-runner.ts', // runMigrations / resetMigrationsTable
  // --- Redis queue + extensions (DATA-002; reuses WORK-001 queue) ---
  'src/platform/redis/redis-client.ts', // createRedisClient (imports ioredis)
  'src/platform/redis/redis-queue.ts', // RedisQueue (imports ioredis)
  'src/platform/redis/transient-lock.ts', // TransientLock (imports ioredis)
  'src/platform/redis/transient-cache.ts', // TransientCache (imports ioredis)
  'src/platform/queue/in-memory-queue.ts', // InMemoryQueue (concrete queue impl)
  // --- Object storage (DATA-003) ---
  'src/platform/storage/in-memory-object-store.ts', // InMemoryObjectStore
  'src/platform/storage/fs-object-store.ts', // FsObjectStore + createTempFsObjectStore
  // --- Persistence / DI wiring ---
  'src/platform/persistence/infrastructure.ts', // buildInfrastructure (DI container)
  'src/platform/persistence/artifact-metadata-repository.ts', // ArtifactMetadataRepository
  // --- WORK-001 worker runtime (concrete) ---
  'src/platform/worker/worker-host.ts', // WorkerHost
  'src/platform/worker/job-handler.ts', // buildHandlerRegistry
  'src/platform/worker/fixtures/echo.job.ts', // createEchoJobHandler (fixture)
  // --- WORK-002 secrets (SEC-001) ---
  'src/platform/secrets/env-secret-store.ts', // EnvSecretStore (concrete secret impl)
]);

/**
 * Concrete value exports (classes / factories) that domain modules MUST NOT
 * import as runtime values. They may import the corresponding TYPES (e.g.
 * `import type { Queue }`) for type annotations, but must not construct or
 * reference the concrete implementation at runtime.
 *
 * Domain modules receive infrastructure from the `Infrastructure` container
 * (app.ts wiring); they never construct these themselves.
 *
 * This complements {@link PROVIDER_IMPLEMENTATION_FILES}: even if a domain
 * module imports from the barrel (`@platform/index.js`), importing one of
 * these names as a VALUE is forbidden. `import type { ... }` is allowed.
 */
const FORBIDDEN_CONCRETE_EXPORTS = new Set([
  // PostgreSQL
  'PgDatabaseClient',
  'createDatabaseClient',
  'defaultPoolConfig',
  'PgliteDatabaseClient',
  'createPgliteDatabaseClient',
  'runMigrations',
  'resetMigrationsTable',
  // Redis queue + extensions
  'RedisQueue',
  'InMemoryQueue',
  'createRedisClient',
  'TransientLock',
  'TransientCache',
  // Object storage
  'InMemoryObjectStore',
  'FsObjectStore',
  'createTempFsObjectStore',
  // Persistence / DI
  'ArtifactMetadataRepository',
  'buildInfrastructure',
  // WORK-001 worker runtime (concrete)
  'WorkerHost',
  'buildHandlerRegistry',
  'createEchoJobHandler',
  // WORK-002 secrets (SEC-001)
  'EnvSecretStore',
  // WORK-002 auth / identity concrete implementations (owned by /auth, /users,
  // /organizations, /projects — domain modules must receive them via the
  // composition root, never construct them directly).
  'ApiKeyAuthProvider',
  'DefaultAuthorizationService',
  'ApiKeyCredentialProvisioner',
  'PgUserRepository',
  'PgOrganizationRepository',
  'PgMembershipRepository',
  'PgRolePermissionRepository',
  'PgProjectRepository',
  'PgProjectAccessRepository',
]);

/**
 * Extract the VALUE-imported names from a TS source file for `@platform/*`
 * specifiers. Returns a map of `specifier → [imported local names]` for
 * runtime-value imports (not type-only).
 *
 * Handles:
 *   import { Foo, Bar } from '@platform/...'        → { Foo, Bar }
 *   import { type Foo, Bar } from '@platform/...'   → { Bar }          (inline type)
 *   import { Foo as Bar } from '@platform/...'      → { Bar }          (local name)
 *   import type { Foo } from '@platform/...'        → {}               (all type)
 *   import Foo from '@platform/...'                 → { Foo }          (default)
 *   import * as Foo from '@platform/...'            → { Foo }          (namespace)
 *
 * Multi-line imports (`import {\n  Foo,\n  Bar,\n} from '...'`) are supported.
 */
function extractPlatformValueImports(file: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const src = readFileSync(file, 'utf8');

  // Match any `import ... from '@platform/...'` statement. The clause between
  // `import` and `from` may span multiple lines and contain braces.
  // Group 1: optional `type` keyword.
  // Group 2: the import clause (default, namespace, or braced names).
  // Group 3: the specifier (without quotes).
  const importRe =
    /import\s+(?:(type)\s+)?([\s\S]+?)\s+from\s+['"](@platform\/[^'"]+)['"]\s*;?/g;

  for (const m of src.matchAll(importRe)) {
    const isTypeOnly = m[1] === 'type';
    const clause = m[2]!.trim();
    const specifier = m[3]!;

    if (isTypeOnly) continue; // `import type { ... }` — no value imports.

    const names: string[] = [];

    if (clause.startsWith('*')) {
      // import * as Ns from '...'
      const nsMatch = clause.match(/^\*\s+as\s+(\w+)/);
      if (nsMatch) names.push(nsMatch[1]!);
    } else if (clause.startsWith('{')) {
      // import { A, B as C, type D } from '...'
      const inner = clause.replace(/^[{]\s*/, '').replace(/\s*[}]$/, '');
      for (const part of inner.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // Skip inline `type` specifiers: `type Foo` or `type Foo as Bar`.
        if (/^type\b/.test(trimmed)) continue;
        // Extract the local name (after `as`, or the first token).
        const asMatch = trimmed.match(/\bas\s+(\w+)$/);
        const token = asMatch ? asMatch[1]! : trimmed.split(/\s+/)[0]!;
        if (token) names.push(token);
      }
    } else if (clause) {
      // import Default from '...' (default import, possibly with type)
      // e.g. `import Default, { Foo } from '...'` — handle default + named.
      const parts = clause.split(/,(?![^{]*})/); // split on commas outside braces
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('{')) continue; // named part handled above if present
        if (trimmed.startsWith('*')) {
          const nsMatch = trimmed.match(/^\*\s+as\s+(\w+)/);
          if (nsMatch) names.push(nsMatch[1]!);
        } else if (trimmed) {
          names.push(trimmed.split(/\s+/)[0]!);
        }
      }
    }

    if (names.length > 0) {
      const existing = result.get(specifier) ?? [];
      result.set(specifier, [...existing, ...names]);
    }
  }
  return result;
}

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

  it('domain modules do not import concrete provider implementation files from platform/', () => {
    // Domain code must import the *interfaces* from @platform/*, not the
    // concrete implementation files (e.g. @platform/storage/fs-object-store.js).
    // This covers ALL concrete WORK-003 implementations including TransientLock,
    // TransientCache, RedisQueue, the object stores, the database clients, the
    // migration runner, and the DI container.
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

  it('domain modules do not import forbidden concrete exports (by name) from the platform barrel', () => {
    // Even when a domain module imports from the barrel (@platform/index.js),
    // it must not import a concrete infrastructure class/factory by name.
    // `import type { Queue }` is allowed; `import { RedisQueue }` is not.
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const imports = extractPlatformValueImports(file);
      for (const [specifier, names] of imports) {
        for (const name of names) {
          if (FORBIDDEN_CONCRETE_EXPORTS.has(name)) {
            violations.push(
              `${relative(BACKEND_ROOT, file)} imports concrete export "${name}" from "${specifier}" — use the provider-independent interface (import type) or receive it from the Infrastructure container`,
            );
          }
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

  it('the forbidden-exports set covers every concrete value exported by the platform barrel', () => {
    // Meta-check: ensure FORBIDDEN_CONCRETE_EXPORTS stays in sync with the
    // barrel. If a new concrete class/factory is added to the barrel without
    // being added to the forbidden set, this test fails so the architect's
    // Correction 2 requirement ("cover all concrete WORK-003 infrastructure
    // implementations") is not accidentally weakened.
    const barrelPath = join(SRC_ROOT, 'platform', 'index.ts');
    const barrelSrc = readFileSync(barrelPath, 'utf8');
    // Collect every value export name from `export { Foo }` / `export { Foo as Bar }`.
    const exportedNames = new Set<string>();
    for (const m of barrelSrc.matchAll(/export\s+(?!type\b)\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g)) {
      const inner = m[1]!;
      for (const part of inner.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const asMatch = trimmed.match(/\bas\s+(\w+)$/);
        const name = asMatch ? asMatch[1]! : trimmed.split(/\s+/)[0]!;
        if (name && !name.startsWith('type ')) exportedNames.add(name);
      }
    }
    // Known allowed (non-concrete) runtime exports that domain modules may use.
    const allowedRuntimeExports = new Set([
      // Module contract
      'FROZEN_MODULE_NAMES',
      // Execution context
      'runWithExecutionContext',
      'getExecutionContext',
      'getExecutionId',
      'ensureExecutionId',
      // Logging / metrics / error tracking (integration points, not provider impls)
      'createLogger',
      'setMetricsSink',
      'metrics',
      'setErrorTracker',
      'errorTracker',
      // IDs
      'generateExecutionId',
    ]);
    const uncovered = [...exportedNames].filter(
      (n) => !allowedRuntimeExports.has(n) && !FORBIDDEN_CONCRETE_EXPORTS.has(n),
    );
    expect(
      uncovered,
      `barrel exports not classified as allowed or forbidden: ${uncovered.join(', ')}.\n` +
        `Add each to FORBIDDEN_CONCRETE_EXPORTS (if concrete) or allowedRuntimeExports (if a safe runtime helper).`,
    ).toEqual([]);
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

/**
 * WORK-002 invariants — module-interface boundaries + provider independence
 * for the identity/authorization/secret stack.
 *
 * Extends the WORK-001/003 checks with WORK-002-specific rules:
 *
 * 1. /auth, /users, /organizations, /projects obey the cross-module interface
 *    convention (no reaching into another module's internal/ or non-index
 *    file). This is already covered by PLAT-AC-02 above, but we add explicit
 *    assertions here so a violation in the new modules is reported by name.
 *
 * 2. Domain modules MUST NOT import concrete auth-provider / secret-store
 *    implementations. They consume the provider-independent interfaces
 *    (`AuthProvider`, `AuthorizationService`, `SecretStore`,
 *    `UserRepository`, etc.) and receive concrete instances from the
 *    composition root.
 *
 * 3. No frontend source becomes an authoritative authorization implementation.
 *    (There is no frontend yet; this is a forward-looking guard that fails
 *    if any src/frontend or src/client file declares an AuthorizationService
 *    or AuthProvider.)
 *
 * 4. Authorization authority remains backend-owned: the only
 *    `AuthorizationService` implementation lives under `src/modules/auth/`.
 */
describe('WORK-002 invariants — identity/authorization module boundaries', () => {
  const WORK_002_MODULES = ['auth', 'users', 'organizations', 'projects'];

  it('WORK-002 modules (auth/users/organizations/projects) exist as explicit boundaries', () => {
    for (const dir of WORK_002_MODULES) {
      const index = join(MODULES_DIR, dir, 'index.ts');
      expect(existsSync(index), `expected ${dir}/index.ts to exist`).toBe(true);
      const internal = join(MODULES_DIR, dir, 'internal');
      expect(existsSync(internal), `expected ${dir}/internal/ to exist`).toBe(true);
    }
  });

  it('WORK-002 modules do not reach into each other internal/ directories', () => {
    // PLAT-AC-02 already covers this for all modules, but we re-assert
    // specifically for the WORK-002 quartet so violations are reported by name.
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const importerModule = moduleOf(file);
      if (!importerModule || !WORK_002_MODULES.includes(importerModule)) continue;
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === importerModule) continue;
        if (isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${targetModule}/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('domain modules do not import concrete auth/secret implementations from @modules/* subpaths', () => {
    // Domain code must import the *interfaces* (types) from a module's
    // index.ts, never the concrete implementation files (e.g.
    // @modules/auth/internal/api-key-auth-provider.js).
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      for (const specifier of extractSpecifiers(file)) {
        if (!specifier.startsWith('@modules/')) continue;
        // Any import that reaches into a module's internal/ is forbidden.
        const rest = specifier.slice('@modules/'.length);
        if (rest.includes('/internal/') || rest.startsWith('internal/')) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" — use the module's index.ts public interface`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('only src/modules/auth/ declares an AuthorizationService implementation', () => {
    // Authorization authority stays in /auth. No other module (and no
    // frontend) may declare a competing AuthorizationService.
    const violations: string[] = [];
    for (const file of walkTs(SRC_ROOT)) {
      const rel = relative(BACKEND_ROOT, file).split(sep).join('/');
      if (rel === 'src/modules/auth/internal/authorization-service.ts') continue;
      if (rel === 'src/modules/auth/internal/auth.types.ts') continue; // interface only
      const src = readFileSync(file, 'utf8');
      if (/\bclass\s+\w+\s+implements\s+AuthorizationService\b/.test(src)) {
        violations.push(`${rel} declares an AuthorizationService implementation — only /auth may`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no frontend/client source declares an auth-provider or authorization implementation', () => {
    // Forward-looking guard: frontend code must not become authoritative for
    // auth/authorization decisions (architecture §5, AUTHZ-AC-03).
    const violations: string[] = [];
    for (const file of walkTs(SRC_ROOT)) {
      const rel = relative(BACKEND_ROOT, file).split(sep).join('/');
      if (!/\/(frontend|client|web|ui)\//.test(rel)) continue;
      const src = readFileSync(file, 'utf8');
      if (/\bclass\s+\w+\s+implements\s+(AuthProvider|AuthorizationService)\b/.test(src)) {
        violations.push(
          `${rel} declares an authoritative auth/authorization implementation — backend-owned only`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('PROJ-001 scope limit: /projects exposes only project-domain contracts', () => {
    // WORK-004 evolved the project domain. The /projects public interface
    // may export project ownership/lifecycle/repository-association contracts;
    // it must NOT export specification, architecture, requirement, or work-item
    // domain types (those belong to /specifications, /architecture, etc.).
    const projectsIndex = readFileSync(join(MODULES_DIR, 'projects', 'index.ts'), 'utf8');
    const allowed = new Set([
      // WORK-002 minimal types (preserved).
      'Project',
      'CreateProjectInput',
      'ProjectAccess',
      'GrantProjectAccessInput',
      'ProjectRepository',
      'ProjectAccessRepository',
      // WORK-004 project-domain types (PROJ-AC-01..03).
      'UpdateProjectInput',
      'ProjectState',
      'ProjectLifecycleTransition',
      'ProjectRepositoryAssociation',
      'AssociateRepositoryInput',
      'ProjectRepositoryAssociationRepository',
      // Module contract marker (every frozen module exports one).
      'projectsModule',
    ]);
    // Collect every exported name from the projects barrel.
    const exported: string[] = [];
    for (const m of projectsIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of projectsIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(
      unexpected,
      `/projects exports unexpected names (WORK-002 scope): ${unexpected.join(', ')}`,
    ).toEqual([]);
  });

  it('module barrels (index.ts) do not export concrete implementations', () => {
    // Architect review (PR #4): concrete PostgreSQL repository / auth-provider
    // implementations must NOT be exposed through public module barrels "merely
    // for composition." The composition root (src/app.ts) wires concrete impls
    // by importing from module internal/ — the sanctioned wiring boundary.
    //
    // This check enforces that module barrels contain ONLY:
    //   - `export type { ... } from '...'` (type-only re-exports)
    //   - `export const xxxModule: ModuleContract & ... = { ... }` (the marker)
    //   - `export default`
    // Any `export { ConcreteClass } from '...'` (value re-export) is forbidden.
    const violations: string[] = [];
    for (const name of FROZEN_MODULE_NAMES) {
      const dir = moduleDir(name);
      const index = join(MODULES_DIR, dir, 'index.ts');
      if (!existsSync(index)) continue;
      const src = readFileSync(index, 'utf8');
      // Match value re-exports: `export { Foo } from '...'` (NOT `export type`).
      // `export\s+` followed by `{` (not preceded by `type`).
      const valueReExportRe = /export\s+(?!type\b)\{([^}]+)\}\s+from\s+['"]/g;
      for (const m of src.matchAll(valueReExportRe)) {
        const names = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
        for (const n of names) {
          // The local binding (after `as`) is what matters.
          const localName = n.includes(' as ') ? n.split(' as ')[1]!.trim() : n;
          violations.push(
            `src/modules/${dir}/index.ts value-exports "${localName}" — ` +
              `module barrels must expose only types/interfaces; concrete impls ` +
              `belong in internal/ and are wired by the composition root (src/app.ts)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('regression: the resolver normalizes .js ESM imports to .ts source files', () => {
    // Architect review (PR #4): the resolver MUST strip the `.js` suffix used by
    // TypeScript ESM imports so it finds the actual `.ts` source file. Without
    // this, cross-module `internal/` imports using `.js` specifiers would
    // silently bypass PLAT-AC-02.
    //
    // Verify the resolver correctly resolves a known `.js` import to its `.ts`
    // source. We use a real internal file as the test fixture.
    const importer = join(MODULES_DIR, 'auth', 'internal', 'authorization-service.ts');
    // This specifier uses the `.js` suffix convention.
    const specifier = '../../users/internal/user.types.js';
    const resolved = resolveSpecifier(importer, specifier);
    expect(resolved, `expected ${specifier} to resolve to a .ts file`).toBeDefined();
    expect(resolved!.endsWith('user.types.ts')).toBe(true);
    expect(existsSync(resolved!)).toBe(true);

    // Also verify the @platform/ path with .js suffix resolves.
    const platformResolved = resolveSpecifier(
      join(SRC_ROOT, 'app.ts'),
      '@platform/index.js',
    );
    expect(platformResolved, `expected @platform/index.js to resolve`).toBeDefined();
    expect(platformResolved!.endsWith('index.ts')).toBe(true);
  });

  it('regression: a .js import that does NOT correspond to a .ts source is flagged', () => {
    // If someone writes `import { Foo } from './nonexistent.js'`, the resolver
    // should return undefined (not silently resolve to something wrong). This
    // ensures the `.js` normalization does not over-match.
    const importer = join(MODULES_DIR, 'auth', 'internal', 'authorization-service.ts');
    const resolved = resolveSpecifier(importer, './does-not-exist.js');
    expect(resolved).toBeUndefined();
  });
});

/**
 * WORK-004 invariants — project + specification module boundaries.
 *
 * Ensures /projects owns project domain logic and /specifications owns
 * specification domain logic, with no cross-contamination and no GitHub
 * provider coupling (WORK-008 territory).
 */
describe('WORK-004 invariants — project + specification boundaries', () => {
  it('/projects does not import from /specifications and vice versa', () => {
    // Project authority and specification authority must not collapse into a
    // single module (architecture §42). /projects must not import /specifications
    // internal/ or non-index files; /specifications must not import /projects
    // beyond the public interface (for the project-id reference).
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const importerModule = moduleOf(file);
      if (!importerModule) continue;
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === importerModule) continue;
        // /projects → /specifications forbidden entirely (except the public
        // interface is also disallowed: projects should not reference specs).
        if (importerModule === 'projects' && targetModule === 'specifications') {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (/projects must not depend on /specifications)`,
          );
        }
        // /specifications → /projects must use ONLY the public index.ts
        // (for the Project reference). Reaching into internal/ is forbidden
        // by PLAT-AC-02 already; this re-asserts it by name.
        if (importerModule === 'specifications' && targetModule === 'projects' && isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (/specifications must use /projects public interface only)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/projects and /specifications do not import GitHub provider packages', () => {
    // The actual GitHub adapter is WORK-008. /projects may persist a
    // provider-independent repository reference (PROJ-AC-02) but MUST NOT
    // couple to the GitHub SDK or any provider runtime.
    const GITHUB_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'projects'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (GITHUB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports GitHub provider package "${specifier}" — GitHub integration is WORK-008`,
          );
        }
      }
    }
    for (const file of walkTs(join(MODULES_DIR, 'specifications'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (GITHUB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports GitHub provider package "${specifier}" — GitHub integration is WORK-008`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/projects and /specifications do not create their own infrastructure', () => {
    // Reuse WORK-001/003 infrastructure (DatabaseClient, ObjectStore, etc.).
    // Neither module may declare a competing DatabaseClient, Pool, ObjectStore,
    // Queue, or WorkerHost class.
    const forbidden = /\bclass\s+\w+\s+(implements|extends)\s+(DatabaseClient|ObjectStore|Queue|WorkerHost)\b/;
    const violations: string[] = [];
    for (const mod of ['projects', 'specifications']) {
      for (const file of walkTs(join(MODULES_DIR, mod))) {
        const src = readFileSync(file, 'utf8');
        if (forbidden.test(src)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} declares a competing infrastructure implementation — reuse @platform/*`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/specifications barrel exposes only specification-domain contracts', () => {
    // /specifications must not export project-domain authority (architecture §42).
    const specIndex = readFileSync(join(MODULES_DIR, 'specifications', 'index.ts'), 'utf8');
    const allowed = new Set([
      'Specification',
      'CreateSpecificationInput',
      'UpdateSpecificationInput',
      'SpecificationState',
      'SpecificationLifecycleTransition',
      'SpecificationVersion',
      'CreateSpecificationVersionInput',
      'SpecificationRepository',
      'SpecificationVersionRepository',
      'specificationsModule',
    ]);
    const exported: string[] = [];
    for (const m of specIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of specIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(
      unexpected,
      `/specifications exports unexpected names: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * WORK-005 invariants — architecture module boundaries.
 *
 * Ensures /architecture owns Architecture/Version/ADR/ChangeRequest domain
 * authority, does not import other modules' internal/, does not couple to
 * GitHub, and does not create its own infrastructure.
 */
describe('WORK-005 invariants — architecture module boundaries', () => {
  it('/architecture does not import from other modules internal/', () => {
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'architecture'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === 'architecture') continue;
        if (isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${targetModule}/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/architecture does not import GitHub provider packages', () => {
    const GITHUB_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'architecture'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (GITHUB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports GitHub provider package "${specifier}" — GitHub integration is WORK-008`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/architecture does not declare competing infrastructure', () => {
    const forbidden = /\bclass\s+\w+\s+(implements|extends)\s+(DatabaseClient|ObjectStore|Queue|WorkerHost)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'architecture'))) {
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a competing infrastructure implementation — reuse @platform/*`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/architecture does not own workflow state', () => {
    // /architecture must not declare workflow state-machine types
    // (DRAFT/READY/ASSIGNED/IMPLEMENTING/etc. are /workflows territory).
    const WORKFLOW_STATES = /\b(READY|ASSIGNED|IMPLEMENTING|PR_OPEN|VERIFYING|ARCHITECT_REVIEW|MERGED|VERIFIED|IMPLEMENTATION_BLOCKED)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'architecture'))) {
      const src = readFileSync(file, 'utf8');
      // Only flag workflow states in type/value declarations, not in comments.
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (WORKFLOW_STATES.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} references workflow states — /architecture must not own workflow state`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/architecture barrel exposes only architecture-domain contracts', () => {
    const archIndex = readFileSync(join(MODULES_DIR, 'architecture', 'index.ts'), 'utf8');
    const allowed = new Set([
      'Architecture',
      'CreateArchitectureInput',
      'ArchitectureVersion',
      'ArchitectureVersionState',
      'CreateArchitectureVersionInput',
      'ArchitectureVersionRepository',
      'ArchitectureRepository',
      'ArchitectureDecisionRecord',
      'CreateAdrInput',
      'ArchitectureDecisionRepository',
      'ArchitectureChangeRequest',
      'ChangeRequestStatus',
      'CreateChangeRequestInput',
      'ArchitectureChangeRequestRepository',
      'ArchitectureService',
      'architectureModule',
    ]);
    const exported: string[] = [];
    for (const m of archIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of archIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(
      unexpected,
      `/architecture exports unexpected names: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });

  it('replacement-version creation is only possible through the ArchitectureService path', () => {
    // The ArchitectureService.approveChangeAndCreateReplacement is the ONLY
    // sanctioned path to create a replacement version from a Change Request.
    // The approve route must call it; the route must NOT call
    // architectureVersionRepository.transitionState directly (that would
    // bypass the service's atomic supersession logic).
    const routeFile = join(SRC_ROOT, 'api', 'routes', 'architecture.route.ts');
    const src = readFileSync(routeFile, 'utf8');
    // The approve route must call architectureService.approveChangeAndCreateReplacement.
    expect(src).toMatch(/architectureService\.approveChangeAndCreateReplacement/);
    // The approve route must NOT call transitionState directly (bypasses the service).
    // The freeze route calls architectureService.freezeVersion (not transitionState).
    const approveSection = src.match(/app\.post\('\/change-requests\/:crId\/approve'[\s\S]*?\}\);/);
    expect(approveSection, 'expected approve route to exist').not.toBeNull();
    expect(approveSection![0]).not.toMatch(/architectureVersionRepository\.transitionState/);
  });
});

/**
 * WORK-006 invariants — requirements module boundaries.
 *
 * Ensures /requirements owns Requirement + AcceptanceCriterion authority,
 * does not own verification semantics or workflow state, does not couple to
 * GitHub, and does not create its own infrastructure.
 */
describe('WORK-006 invariants — requirements module boundaries', () => {
  it('/requirements does not import from other modules internal/', () => {
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'requirements'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === 'requirements') continue;
        if (isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${targetModule}/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/requirements does not import GitHub provider packages', () => {
    const GITHUB_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'requirements'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (GITHUB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports GitHub provider package "${specifier}" — GitHub integration is WORK-008`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/requirements does not declare competing infrastructure', () => {
    const forbidden = /\bclass\s+\w+\s+(implements|extends)\s+(DatabaseClient|ObjectStore|Queue|WorkerHost)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'requirements'))) {
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a competing infrastructure implementation — reuse @platform/*`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/requirements does not own verification semantics', () => {
    // /requirements must not implement evidence evaluation or verification
    // engine logic — that belongs to /verification (WORK-015). It may store
    // evidence REFERENCES but must not evaluate them.
    const VERIFICATION_LOGIC = /\b(evaluateEvidence|deriveStatus|verifyCriterion|runVerification)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'requirements'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (VERIFICATION_LOGIC.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} implements verification semantics — /requirements must not own verification logic`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/requirements does not own workflow state', () => {
    const WORKFLOW_STATES = /\b(READY|ASSIGNED|IMPLEMENTING|PR_OPEN|VERIFYING|ARCHITECT_REVIEW|MERGED|VERIFIED|IMPLEMENTATION_BLOCKED)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'requirements'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (WORKFLOW_STATES.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} references workflow states — /requirements must not own workflow state`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/requirements barrel exposes only requirements-domain contracts', () => {
    const reqIndex = readFileSync(join(MODULES_DIR, 'requirements', 'index.ts'), 'utf8');
    const allowed = new Set([
      'Requirement',
      'RequirementStatus',
      'CreateRequirementInput',
      'UpdateRequirementInput',
      'RequirementRepository',
      'RequirementDependency',
      'RequirementDependencyRepository',
      'AcceptanceCriterion',
      'CriterionStatus',
      'CreateCriterionInput',
      'UpdateCriterionInput',
      'AcceptanceCriterionRepository',
      'EvidenceReference',
      'AddEvidenceReferenceInput',
      'EvidenceReferenceRepository',
      'requirementsModule',
    ]);
    const exported: string[] = [];
    for (const m of reqIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of reqIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(
      unexpected,
      `/requirements exports unexpected names: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * WORK-007 invariants — work-items module boundaries.
 *
 * Ensures /work-items owns Work Item + Work Order authority, does not own
 * workflow state or verification semantics, does not couple to GitHub, and
 * does not create its own infrastructure.
 */
describe('WORK-007 invariants — work-items module boundaries', () => {
  it('/work-items does not import from other modules internal/', () => {
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'work-items'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === 'work-items') continue;
        if (isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${targetModule}/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/work-items does not import GitHub provider packages', () => {
    const GITHUB_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'work-items'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (GITHUB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports GitHub provider package "${specifier}" — GitHub integration is WORK-008`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/work-items does not declare competing infrastructure', () => {
    const forbidden = /\bclass\s+\w+\s+(implements|extends)\s+(DatabaseClient|ObjectStore|Queue|WorkerHost)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'work-items'))) {
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) {
        violations.push(`${relative(BACKEND_ROOT, file)} declares a competing infrastructure implementation — reuse @platform/*`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/work-items does not own workflow state', () => {
    const WORKFLOW_STATES = /\b(READY|ASSIGNED|IMPLEMENTING|PR_OPEN|VERIFYING|ARCHITECT_REVIEW|MERGED|VERIFIED|IMPLEMENTATION_BLOCKED)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'work-items'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (WORKFLOW_STATES.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} references workflow states — /work-items must not own workflow state`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('WO-AC-02: Work Order state is not declared in /workflows, /llm, or /agents', () => {
    // WorkOrderState (draft/generated/consumed) is owned by /work-items.
    // No other module may declare a competing WorkOrderState type.
    const violations: string[] = [];
    for (const mod of ['workflows', 'llm', 'agents']) {
      const modDir = join(MODULES_DIR, mod);
      if (!existsSync(modDir)) continue;
      for (const file of walkTs(modDir)) {
        const src = readFileSync(file, 'utf8');
        const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/\bWorkOrderState\b/.test(codeOnly)) {
          violations.push(`${relative(BACKEND_ROOT, file)} declares WorkOrderState — owned by /work-items only`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/work-items barrel exposes only work-items-domain contracts', () => {
    const wiIndex = readFileSync(join(MODULES_DIR, 'work-items', 'index.ts'), 'utf8');
    const allowed = new Set([
      'WorkItem', 'CreateWorkItemInput', 'UpdateWorkItemInput', 'WorkItemRepository',
      'WorkItemRequirementAssociation', 'WorkItemRequirementRepository',
      'WorkItemCriterionAssociation', 'WorkItemCriterionRepository',
      'WorkItemDependency', 'WorkItemDependencyRepository',
      'PullRequestAssociation', 'CreatePrAssociationInput', 'PrAssociationStatus',
      'PullRequestAssociationRepository',
      'WorkOrder', 'CreateWorkOrderInput', 'WorkOrderState', 'WorkOrderRepository',
      'WorkItemDependencyService',
      'WorkItemCompletionService',
      'workItemsModule',
    ]);
    const exported: string[] = [];
    for (const m of wiIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of wiIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(unexpected, `/work-items exports unexpected names: ${unexpected.join(', ')}`).toEqual([]);
  });
});

/**
 * WORK-014 invariants — /llm (Architect Service) module boundaries.
 *
 * Ensures /llm owns the Architect Service + LLM Gateway, may consume the
 * public contracts of other modules (provider-independent), and does NOT:
 *
 * - write directly to `wfos_work_orders` (the regression fixed in PR #13:
 *   the Architect Service must route Work Order mutations through the
 *   existing /work-items `WorkOrderRepository` contract, not raw SQL via
 *   `DatabaseClient`);
 * - import other modules' `internal/`;
 * - import GitHub SDK / provider code;
 * - declare a competing WorkOrderState type (already enforced by WO-AC-02);
 * - declare a second Work Order persistence model;
 * - mutate canonical workflow state;
 * - define verification semantics.
 *
 * The frozen architecture (spec/architecture.md §17, §18, §42 + WORK-014
 * prompt §3, §11, §17, §23) requires:
 *
 *   /llm (Architect Service)
 *       → WorkOrderRepository contract (owned by /work-items)
 *       → /work-items persistence (wfos_work_orders)
 */
describe('WORK-014 invariants — /llm (Architect Service) module boundaries', () => {
  it('REGRESSION (PR #13): /llm does not write directly to wfos_work_orders', () => {
    // The Architect Service must not bypass the /work-items WorkOrderRepository
    // contract by issuing raw `INSERT INTO wfos_work_orders` / `UPDATE
    // wfos_work_orders` SQL through DatabaseClient. Doing so would make /llm a
    // second Work Order persistence authority and is the exact violation the
    // architect review caught on PR #13.
    //
    // This check scans every .ts file under src/modules/llm/ for raw SQL
    // mutations of wfos_work_orders. The /work-items PgWorkOrderRepository is
    // the ONLY sanctioned author of wfos_work_orders rows.
    const violations: string[] = [];
    const llmDir = join(MODULES_DIR, 'llm');
    if (existsSync(llmDir)) {
      for (const file of walkTs(llmDir)) {
        const src = readFileSync(file, 'utf8');
        // Strip comments so a TODO/NOTE mentioning the table doesn't trip the
        // check — only executable code matters.
        const codeOnly = src
          .replace(/\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        // Any INSERT/UPDATE/DELETE/UPSERT/MERGE against wfos_work_orders
        // authored inside /llm is a boundary violation.
        const directMutation = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|UPSERT\s+INTO|MERGE\s+INTO)\s+wfos_work_orders\b/i;
        if (directMutation.test(codeOnly)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} issues a direct SQL mutation against wfos_work_orders — ` +
              `Work Order persistence is owned by /work-items; route through WorkOrderRepository instead`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('REGRESSION (PR #13): /llm routes Work Order mutation through WorkOrderRepository', () => {
    // Positive counterpart of the previous check: the Architect Service must
    // depend on the /work-items WorkOrderRepository contract and call its
    // create()/updateState() methods. If someone deletes the dependency or
    // stops calling the repository, this check fails.
    const architectFile = join(MODULES_DIR, 'llm', 'internal', 'architect-service.ts');
    expect(existsSync(architectFile), `${relative(BACKEND_ROOT, architectFile)} must exist`).toBe(true);
    const src = readFileSync(architectFile, 'utf8');
    expect(src).toMatch(/import[^;]*WorkOrderRepository[^;]*from\s*['"]@modules\/work-items\/index\.js['"]/);
    expect(src).toMatch(/this\.workOrderRepository\.create\s*\(/);
    expect(src).toMatch(/this\.workOrderRepository\.updateState\s*\(/);
  });

  it('/llm does not import from other modules internal/', () => {
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'llm'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === 'llm') continue;
        if (isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${targetModule}/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/llm does not import GitHub provider packages', () => {
    const GITHUB_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'llm'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (GITHUB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports GitHub provider package "${specifier}" — GitHub integration is WORK-008; /llm consumes provider-independent /github contracts only`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/llm does not declare competing infrastructure', () => {
    const forbidden = /\bclass\s+\w+\s+(implements|extends)\s+(DatabaseClient|ObjectStore|Queue|WorkerHost)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'llm'))) {
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) {
        violations.push(`${relative(BACKEND_ROOT, file)} declares a competing infrastructure implementation — reuse @platform/*`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/llm does not own canonical workflow state', () => {
    // The canonical workflow state machine (READY/ASSIGNED/IMPLEMENTING/...)
    // is owned by /workflows. /llm must not declare those states.
    const WORKFLOW_STATES = /\b(READY|ASSIGNED|IMPLEMENTING|PR_OPEN|VERIFYING|ARCHITECT_REVIEW|MERGED|VERIFIED|IMPLEMENTATION_BLOCKED)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'llm'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (WORKFLOW_STATES.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} references workflow states — /workflows remains the sole workflow-state authority`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/llm does not define a second Work Order persistence model', () => {
    // /llm may consume the /work-items WorkOrderRepository + WorkOrder types.
    // It must not define its own "WorkOrderRecord" / "PersistedWorkOrder" /
    // "LlmWorkOrder" table-mapped persistence model — that would duplicate
    // /work-items authority.
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'llm'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // A persistence model is implied by a CREATE TABLE statement or by a
      // class/interface explicitly named *WorkOrder*Repository / *WorkOrder*Store.
      const declaresTable = /\bCREATE\s+TABLE\s+\w*work_?order/i.test(codeOnly);
      const declaresRepo = /\bclass\s+\w*(WorkOrder|WorkOrderStore)\w*\s+(implements|extends)\s*\w*Repository/i.test(codeOnly)
        || /\binterface\s+\w*(WorkOrder|WorkOrderStore)\w*Repository\b/i.test(codeOnly);
      if (declaresTable || declaresRepo) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a Work Order persistence model — /work-items is the sole Work Order persistence authority`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/llm barrel exposes only llm-domain contracts', () => {
    const llmIndex = readFileSync(join(MODULES_DIR, 'llm', 'index.ts'), 'utf8');
    const allowed = new Set([
      // LLM Gateway (WORK-013)
      'LlmMessage', 'LlmRequest', 'LlmResponse', 'LlmUsage',
      'LlmError', 'LlmErrorType', 'LlmGateway',
      'LlmExecutionRecord', 'LlmExecutionStatus', 'LlmExecutionRecordRepository',
      // Architect Service (WORK-014)
      'ArchitectContext', 'ArchitectRequirementSummary', 'ArchitectCriterionSummary',
      'ArchitectRepositoryEvidence', 'ArchitectVerificationEvidence',
      'ArchitectExecutionRequest', 'ArchitectExecutionResult',
      'WorkOrderCandidate', 'ArchitectService',
      // Module contract const
      'llmModule',
    ]);
    const exported: string[] = [];
    for (const m of llmIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of llmIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(unexpected, `/llm exports unexpected names: ${unexpected.join(', ')}`).toEqual([]);
  });
});

/**
 * WORK-015 invariants — /verification + /github CI ingestion boundaries.
 *
 * Ensures:
 * - /verification owns VerificationRun, Evidence, mapping, and evaluation authority;
 * - /verification does not import GitHub SDK/provider implementations;
 * - /github does not evaluate Acceptance Criteria (GH6-AC-02);
 * - /agents cannot directly mutate criterion status;
 * - /llm cannot directly mutate criterion status;
 * - /workflows does not directly evaluate Evidence;
 * - /requirements remains the owner of AcceptanceCriterion persistence;
 * - /verification uses existing PostgreSQL/ObjectStore/authorization infrastructure;
 * - no duplicate evidence/artifact store is introduced;
 * - no module defines a competing criterion-status authority;
 * - workflow state remains exclusively owned by /workflows.
 */
describe('WORK-015 invariants — /verification + /github CI ingestion', () => {
  it('/verification does not import GitHub SDK/provider packages', () => {
    const GITHUB_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'verification'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (GITHUB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports GitHub provider package "${specifier}" — GitHub integration is /github; /verification consumes provider-independent CI evidence only`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/verification does not import from /github internal/', () => {
    // /verification may consume /github's PUBLIC barrel (@modules/github/index.js)
    // but must NOT reach into /github/internal/ — that would couple /verification
    // to GitHub provider implementation details.
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'verification'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (targetModule === 'github' && isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside github/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/github does not evaluate Acceptance Criteria (GH6-AC-02)', () => {
    // /github OWNS CI ingestion + translation. It must NOT:
    // - call AcceptanceCriterionRepository.update (criterion status mutation);
    // - call RequirementRepository.update (requirement status mutation);
    // - declare criterion evaluation logic (deriveCriterionStatus, evaluateCriterion).
    const violations: string[] = [];
    const EVAL_PATTERNS = [
      /\bAcceptanceCriterionRepository\b/,
      /\bRequirementRepository\b/,
      /\bderiveCriterionStatus\b/,
      /\bevaluateCriterion\b/,
      /\bevaluateForRun\b/,
      /\bpersistEvaluations\b/,
      /\bderivateRequirementStatus\b/,
    ];
    for (const file of walkTs(join(MODULES_DIR, 'github'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const pattern of EVAL_PATTERNS) {
        if (pattern.test(codeOnly)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} references ${pattern.source} — /github must not evaluate acceptance criteria (GH6-AC-02)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/agents cannot directly mutate criterion status', () => {
    // /agents must NOT call AcceptanceCriterionRepository.update — that's
    // /verification's authority (via the /requirements contract).
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'agents'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\bAcceptanceCriterionRepository\b/.test(codeOnly) && /\.update\s*\(/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} references AcceptanceCriterionRepository.update — agent output must not directly mutate criterion status`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/llm cannot directly mutate criterion status', () => {
    // /llm must NOT call AcceptanceCriterionRepository.update — that's
    // /verification's authority (via the /requirements contract).
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'llm'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\bAcceptanceCriterionRepository\b/.test(codeOnly) && /\.update\s*\(/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} references AcceptanceCriterionRepository.update — LLM/Architect output must not directly mutate criterion status`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/workflows does not directly evaluate Evidence', () => {
    // /workflows owns the canonical state machine. It must NOT:
    // - import Evidence/EvidenceRepository/VerificationService evaluation methods;
    // - declare criterion evaluation logic.
    const violations: string[] = [];
    const EVAL_PATTERNS = [
      /\bderiveCriterionStatus\b/,
      /\bevaluateCriterion\b/,
      /\bevaluateForRun\b/,
      /\bpersistEvaluations\b/,
    ];
    for (const file of walkTs(join(MODULES_DIR, 'workflows'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const pattern of EVAL_PATTERNS) {
        if (pattern.test(codeOnly)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} references ${pattern.source} — /workflows must not evaluate evidence; /verification owns evaluation`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/verification does not declare competing infrastructure', () => {
    const forbidden = /\bclass\s+\w+\s+(implements|extends)\s+(DatabaseClient|ObjectStore|Queue|WorkerHost)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'verification'))) {
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) {
        violations.push(`${relative(BACKEND_ROOT, file)} declares a competing infrastructure implementation — reuse @platform/*`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/verification does not own canonical workflow state', () => {
    const WORKFLOW_STATES = /\b(READY|ASSIGNED|IMPLEMENTING|PR_OPEN|VERIFYING|ARCHITECT_REVIEW|MERGED|VERIFIED|IMPLEMENTATION_BLOCKED)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'verification'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (WORKFLOW_STATES.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} references workflow states — /workflows remains the sole workflow-state authority`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/verification does not define a competing criterion-status enum', () => {
    // The criterion status enum (PENDING/PASS/FAIL/BLOCKED) is owned by
    // /requirements (REQ-002, AC-AC-03). /verification may IMPORT the type
    // but must not DECLARE a competing CriterionStatus type.
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'verification'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // A competing enum is implied by `export type CriterionStatus = ...`
      // (NOT `import type { CriterionStatus }`).
      if (/export\s+type\s+CriterionStatus\b/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a CriterionStatus type — /requirements is the sole owner`,
        );
      }
      if (/export\s+type\s+RequirementStatus\b/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a RequirementStatus type — /requirements is the sole owner`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/verification does not create a duplicate evidence/artifact store', () => {
    // /verification must use the existing ObjectStore abstraction (DATA-003),
    // not declare its own artifact storage implementation.
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'verification'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const declaresStore = /\bclass\s+\w+\s+(implements|extends)\s*(ObjectStore|EvidenceStore|ArtifactStore)\b/.test(codeOnly)
        || /\bCREATE\s+TABLE\s+\w*(evidence|artifact)_?store/i.test(codeOnly);
      if (declaresStore) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a competing evidence/artifact store — reuse @platform ObjectStore (DATA-003)`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/verification barrel exposes only verification-domain contracts', () => {
    const vIndex = readFileSync(join(MODULES_DIR, 'verification', 'index.ts'), 'utf8');
    const allowed = new Set([
      // CriterionStatus + RequirementStatus are RE-EXPORTED from /requirements
      // (they're owned by /requirements, /verification just re-exports for consumer convenience).
      'CriterionStatus', 'RequirementStatus',
      // Verification domain types (WORK-015)
      'VerificationRunStatus',
      'EvidenceAuthority', 'EvidenceResult',
      'Evidence', 'CreateEvidenceInput', 'EvidenceRepository',
      'VerificationRun', 'CreateVerificationRunInput', 'UpdateVerificationRunInput',
      'VerificationRunRepository',
      'MappingRelevance', 'MappingStatus',
      'CriterionEvidenceMapping', 'CreateMapInput', 'CriterionEvidenceMappingRepository',
      'CriterionEvaluation', 'RequirementDerivation',
      'VerificationService',
      // Module contract const
      'verificationModule',
    ]);
    const exported: string[] = [];
    for (const m of vIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of vIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(unexpected, `/verification exports unexpected names: ${unexpected.join(', ')}`).toEqual([]);
  });

  it('/github barrel exposes CI evidence contracts alongside existing ones', () => {
    // GH6-AC-01: GitHub Actions results are ingested as CI evidence.
    // The /github barrel must export the CI evidence types so /verification
    // can consume them through the provider-independent contract.
    const ghIndex = readFileSync(join(MODULES_DIR, 'github', 'index.ts'), 'utf8');
    expect(ghIndex).toMatch(/CiArtifactReference/);
    expect(ghIndex).toMatch(/CiRunEvidence/);
    expect(ghIndex).toMatch(/CiEvidenceIngestionRepository/);
    expect(ghIndex).toMatch(/CiEvidenceIngestionService/);
  });

  // --- REGRESSION (PR #14 architect review): verification-authority bypass ---

  it('REGRESSION (PR #14): CreateEvidenceInput does NOT have an authority field', () => {
    // The public CreateEvidenceInput type must NOT include `authority` —
    // authority is determined SERVER-SIDE based on the trusted source path,
    // never accepted from the client. This is the structural fix for the
    // verification-authority bypass: an ordinary project writer cannot
    // manufacture authoritative PASS evidence by self-declaring
    // `authority: 'authoritative'`.
    const typesFile = join(MODULES_DIR, 'verification', 'internal', 'verification.types.ts');
    expect(existsSync(typesFile), `${relative(BACKEND_ROOT, typesFile)} must exist`).toBe(true);
    const src = readFileSync(typesFile, 'utf8');
    // Strip comments so only executable code is checked.
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Find the CreateEvidenceInput interface body (everything between the
    // opening { and the matching closing }).
    const match = codeOnly.match(/export\s+interface\s+CreateEvidenceInput\s*\{([\s\S]*?)^\}/m);
    expect(match, 'CreateEvidenceInput interface not found').not.toBeNull();
    const interfaceBody = match![1]!;
    expect(
      interfaceBody,
      'CreateEvidenceInput must NOT have an `authority` field — it is server-side only',
    ).not.toMatch(/^\s*authority\b/m);
  });

  it('REGRESSION (PR #14): EvidenceRepository.create requires authority as a server-side parameter', () => {
    // The repository create() method must take `authority` as a separate
    // required parameter — NOT from CreateEvidenceInput. This enforces that
    // the service (not the client) sets the authority based on the trusted
    // source path.
    const typesFile = join(MODULES_DIR, 'verification', 'internal', 'verification.types.ts');
    const src = readFileSync(typesFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // The create() signature must include `authority: EvidenceAuthority` as a
    // separate parameter (not inside CreateEvidenceInput).
    expect(codeOnly).toMatch(/create\s*\(\s*input:\s*CreateEvidenceInput\s*,\s*authority:\s*EvidenceAuthority\s*\)/);
  });

  it('REGRESSION (PR #14): attachEvidence always passes claim authority to the repository', () => {
    // The public/manual attachEvidence() method must ALWAYS pass 'claim' to
    // evidenceRepo.create() — it must NOT read authority from the input.
    const serviceFile = join(MODULES_DIR, 'verification', 'internal', 'verification-service.ts');
    expect(existsSync(serviceFile)).toBe(true);
    const src = readFileSync(serviceFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // The attachEvidence method must call evidenceRepo.create(input, 'claim').
    expect(codeOnly).toMatch(/async\s+attachEvidence[\s\S]*?evidenceRepo\.create\s*\(\s*input,\s*['"]claim['"]\s*\)/);
    // The attachCiEvidence method must call evidenceRepo.create(..., 'authoritative').
    expect(codeOnly).toMatch(/async\s+attachCiEvidence[\s\S]*?evidenceRepo\.create\s*\([\s\S]*?,\s*['"]authoritative['"]\s*\)/);
  });

  it('REGRESSION (PR #14): the verification evidence route does NOT pass authority to the service', () => {
    // The POST /verification-runs/:runId/evidence route must NOT pass
    // `authority` from the client body to the service. The field is not
    // accepted at the API boundary.
    const routeFile = join(SRC_ROOT, 'api', 'routes', 'verification.route.ts');
    expect(existsSync(routeFile)).toBe(true);
    const src = readFileSync(routeFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Find the attachEvidence call in the route and verify it does NOT include
    // `authority:`. The attachEvidence call looks like:
    //   deps.verificationService.attachEvidence({
    //     projectId: ..., verificationRunId: ..., evidenceType: ..., provider: ...,
    //     ...
    //   })
    const match = codeOnly.match(/verificationService\.attachEvidence\s*\(\{([\s\S]*?)\}\s*\)/);
    expect(match, 'attachEvidence call in route not found').not.toBeNull();
    const callBody = match![1]!;
    expect(
      callBody,
      'the route must NOT pass authority to attachEvidence — it is server-side only',
    ).not.toMatch(/\bauthority\b/);
  });
});

/**
 * WORK-016 invariants — /reviews (Architect Reviews) module boundaries.
 *
 * Ensures /reviews owns Architect Review + Review Finding persistence and
 * semantics, and does NOT:
 * - import /workflows/internal (boundary — /workflows owns canonical state);
 * - import GitHub SDK/provider implementations;
 * - define criterion/verification semantics;
 * - mutate workflow persistence directly (no INSERT/UPDATE/DELETE on
 *   wfos_workflow_executions);
 * - define canonical workflow states;
 * - create duplicate Work Order or Architect Execution persistence;
 * - import /verification/internal or /llm/internal (consume public contracts only).
 *
 * The frozen architecture (architecture.md §6, §19, §20; architecture-lock.md
 * §61) requires:
 *
 *   /llm executes architect reasoning → /reviews persists the verdict + findings
 *   → /workflows consumes the public ArchitectReviewResult to drive state
 *     transitions.
 */
describe('WORK-016 invariants — /reviews (Architect Reviews) module boundaries', () => {
  it('/reviews does not import from /workflows/internal', () => {
    // /reviews exposes a public ArchitectReviewResult that /workflows consumes,
    // but /reviews must NOT reach into /workflows/internal — that would couple
    // reviews to workflow implementation details and risk workflow-state mutation.
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (targetModule === 'workflows' && isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside workflows/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/reviews does not import from /verification/internal', () => {
    // /reviews may consume /verification's PUBLIC barrel
    // (@modules/verification/index.js) but must NOT reach into
    // /verification/internal/ — that would couple reviews to verification
    // implementation details.
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (targetModule === 'verification' && isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside verification/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/reviews does not import from /llm/internal', () => {
    // /reviews may reference the architect execution via the /llm PUBLIC barrel
    // (@modules/llm/index.js) but must NOT reach into /llm/internal/.
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (targetModule === 'llm' && isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside llm/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/reviews does not import GitHub SDK/provider packages', () => {
    const GITHUB_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (GITHUB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports GitHub provider package "${specifier}" — GitHub integration is /github; /reviews references provider-independent contracts only`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('REGRESSION: /reviews does not mutate workflow persistence directly', () => {
    // /reviews MUST NOT write directly to wfos_workflow_executions — that would
    // bypass the Workflow Engine (boundary — /workflows owns canonical state).
    // /reviews exposes a public ArchitectReviewResult that /workflows consumes.
    const violations: string[] = [];
    const DIRECT_MUTATION = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|UPSERT\s+INTO|MERGE\s+INTO)\s+wfos_workflow_executions\b/i;
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (DIRECT_MUTATION.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} issues a direct SQL mutation against wfos_workflow_executions — ` +
            `canonical workflow state is owned by /workflows; expose a public ReviewResult instead`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/reviews does not own canonical workflow state', () => {
    // The canonical workflow state machine is owned by /workflows. /reviews
    // must not declare those states. NOTE: ARCHITECTURE_CHANGE_REQUIRED and
    // IMPLEMENTATION_BLOCKED are BOTH verdicts (frozen architecture §19) AND
    // workflow states (§13) — they are valid in /reviews as VERDICT values.
    // The pure workflow states that /reviews must NOT reference are:
    //   DRAFT, READY, ASSIGNED, IMPLEMENTING, PR_OPEN, VERIFYING,
    //   ARCHITECT_REVIEW, CHANGES_REQUESTED, APPROVED, MERGED, VERIFIED,
    //   ARCHITECTURE_CHANGE_REQUEST
    const PURE_WORKFLOW_STATES = /\b(DRAFT|READY|ASSIGNED|IMPLEMENTING|PR_OPEN|VERIFYING|ARCHITECT_REVIEW|CHANGES_REQUESTED|APPROVED|MERGED|VERIFIED|ARCHITECTURE_CHANGE_REQUEST)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (PURE_WORKFLOW_STATES.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} references pure workflow states — /workflows remains the sole workflow-state authority`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/reviews does not define criterion/verification semantics', () => {
    // /reviews must NOT:
    // - call AcceptanceCriterionRepository.update (criterion status mutation);
    // - call RequirementRepository.update (requirement status mutation);
    // - declare criterion evaluation logic (deriveCriterionStatus, evaluateCriterion).
    // /verification owns verification semantics.
    const violations: string[] = [];
    const EVAL_PATTERNS = [
      /\bAcceptanceCriterionRepository\b/,
      /\bRequirementRepository\b/,
      /\bderiveCriterionStatus\b/,
      /\bevaluateCriterion\b/,
      /\bevaluateForRun\b/,
      /\bpersistEvaluations\b/,
    ];
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const pattern of EVAL_PATTERNS) {
        if (pattern.test(codeOnly)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} references ${pattern.source} — /reviews must not evaluate evidence or modify criterion status (that's /verification)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/reviews does not declare competing infrastructure', () => {
    const forbidden = /\bclass\s+\w+\s+(implements|extends)\s+(DatabaseClient|ObjectStore|Queue|WorkerHost)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) {
        violations.push(`${relative(BACKEND_ROOT, file)} declares a competing infrastructure implementation — reuse @platform/*`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/reviews does not create duplicate Work Order or Architect Execution persistence', () => {
    // /reviews must NOT create its own Work Order or Architect Execution
    // persistence — those are owned by /work-items and /llm respectively.
    // /reviews references them via FK + text columns.
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // A competing persistence model is implied by a CREATE TABLE statement
      // for a work_order or architect_execution table, or by a class/interface
      // explicitly named *WorkOrder*Repository / *ArchitectExecution*Repository.
      const declaresTable = /\bCREATE\s+TABLE\s+\w*(work_?order|architect_?execution)\w*/i.test(codeOnly);
      const declaresRepo = /\bclass\s+\w*(WorkOrder|ArchitectExecution)\w*\s+(implements|extends)\s*\w*Repository/i.test(codeOnly)
        || /\binterface\s+\w*(WorkOrder|ArchitectExecution)\w*Repository\b/i.test(codeOnly);
      if (declaresTable || declaresRepo) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a competing Work Order / Architect Execution persistence model — those are owned by /work-items and /llm`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/reviews barrel exposes only review-domain contracts', () => {
    const rIndex = readFileSync(join(MODULES_DIR, 'reviews', 'index.ts'), 'utf8');
    const allowed = new Set([
      // Review domain types (WORK-016)
      'ReviewVerdict', 'ReviewStatus', 'ReviewSource',
      'FindingSeverity', 'FindingDisposition',
      'Review', 'CreateReviewInput', 'FinalizeReviewInput', 'ReviewRepository',
      'ReviewFinding', 'CreateFindingInput', 'ReviewFindingRepository',
      'ArchitectReviewResult', 'ReviewService',
      // Module contract const
      'reviewsModule',
    ]);
    const exported: string[] = [];
    for (const m of rIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of rIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(unexpected, `/reviews exports unexpected names: ${unexpected.join(', ')}`).toEqual([]);
  });
});

/**
 * WORK-017 invariants — /workflows convergence boundaries.
 *
 * Ensures the convergence orchestration layer consumes public contracts from
 * other modules without importing their internal/ implementations, and that
 * no other module mutates canonical workflow persistence directly.
 */
describe('WORK-017 invariants — /workflows convergence boundaries', () => {
  it('/workflows does not import from other modules internal/', () => {
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'workflows'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === 'workflows') continue;
        if (isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${targetModule}/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/workflows does not import GitHub/LLM/agent provider SDKs', () => {
    const PROVIDER_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'workflows'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (PROVIDER_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports provider SDK "${specifier}" — /workflows consumes public contracts only`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('REGRESSION: /agents does not mutate workflow persistence directly', () => {
    const violations: string[] = [];
    const DIRECT_MUTATION = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|UPSERT\s+INTO|MERGE\s+INTO)\s+wfos_workflow_executions\b/i;
    for (const file of walkTs(join(MODULES_DIR, 'agents'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (DIRECT_MUTATION.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} issues a direct SQL mutation against wfos_workflow_executions — /workflows owns canonical workflow state`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('REGRESSION: /verification does not mutate workflow persistence directly', () => {
    const violations: string[] = [];
    const DIRECT_MUTATION = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|UPSERT\s+INTO|MERGE\s+INTO)\s+wfos_workflow_executions\b/i;
    for (const file of walkTs(join(MODULES_DIR, 'verification'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (DIRECT_MUTATION.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} issues a direct SQL mutation against wfos_workflow_executions — /workflows owns canonical workflow state`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('REGRESSION: /reviews does not mutate workflow persistence directly', () => {
    const violations: string[] = [];
    const DIRECT_MUTATION = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|UPSERT\s+INTO|MERGE\s+INTO)\s+wfos_workflow_executions\b/i;
    for (const file of walkTs(join(MODULES_DIR, 'reviews'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (DIRECT_MUTATION.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} issues a direct SQL mutation against wfos_workflow_executions — /workflows owns canonical workflow state`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('REGRESSION: /llm does not mutate workflow persistence directly', () => {
    const violations: string[] = [];
    const DIRECT_MUTATION = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|UPSERT\s+INTO|MERGE\s+INTO)\s+wfos_workflow_executions\b/i;
    for (const file of walkTs(join(MODULES_DIR, 'llm'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (DIRECT_MUTATION.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} issues a direct SQL mutation against wfos_workflow_executions — /workflows owns canonical workflow state`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('REGRESSION: /github does not mutate workflow persistence directly', () => {
    const violations: string[] = [];
    const DIRECT_MUTATION = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|UPSERT\s+INTO|MERGE\s+INTO)\s+wfos_workflow_executions\b/i;
    for (const file of walkTs(join(MODULES_DIR, 'github'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (DIRECT_MUTATION.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} issues a direct SQL mutation against wfos_workflow_executions — /workflows owns canonical workflow state`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/workflows does not create duplicate domain stores', () => {
    // /workflows must NOT create its own Work Item, Work Order, Agent Run,
    // Review, or Verification persistence — those are owned by their
    // respective modules.
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'workflows'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const declaresTable = /\bCREATE\s+TABLE\s+\w*(work_item|work_order|agent_run|review|evidence|criterion)\w*/i.test(codeOnly);
      const declaresRepo = /\bclass\s+\w*(WorkItem|WorkOrder|AgentRun|Review|Evidence|Criterion)\w*\s+(implements|extends)\s*\w*Repository/i.test(codeOnly);
      if (declaresTable || declaresRepo) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a competing domain persistence model — /workflows must not duplicate domain stores`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/workflows barrel exposes convergence types alongside existing ones', () => {
    const wfIndex = readFileSync(join(MODULES_DIR, 'workflows', 'index.ts'), 'utf8');
    // WORK-009 types must still be exported.
    expect(wfIndex).toMatch(/WorkflowState/);
    expect(wfIndex).toMatch(/WorkflowEngine/);
    // WORK-017 types must be exported.
    expect(wfIndex).toMatch(/SignalType/);
    expect(wfIndex).toMatch(/ConvergenceSignal/);
    expect(wfIndex).toMatch(/WorkflowOrchestrator/);
  });

  it('REGRESSION (PR #16): no public signal endpoint accepts arbitrary signalType', () => {
    // The public generic signal endpoint (POST /signals) was REMOVED because
    // it allowed a project writer to forge trusted internal outcomes. The only
    // client-facing convergence operation is POST /converge (initiate). Trusted
    // signals (agent_run_completed, verification_completed, review_finalized,
    // pull_request_merged) are submitted internally by the orchestrator, which
    // validates each source against the persisted authoritative domain record.
    const routeFile = join(SRC_ROOT, 'api', 'routes', 'workflow.route.ts');
    expect(existsSync(routeFile)).toBe(true);
    const src = readFileSync(routeFile, 'utf8');
    // The route must NOT register a POST /signals endpoint.
    expect(src).not.toMatch(/app\.post\([^)]*\/signals['"]/);
    // The route must NOT reference SignalType (arbitrary signal type acceptance).
    expect(src).not.toMatch(/\bSignalType\b/);
    // The route MUST use initiateConvergence (the only public entry point).
    expect(src).toMatch(/initiateConvergence/);
  });

  // --- WORK-018: Verification/Review orchestration checks ---

  it('REGRESSION (WORK-018): workflow route exposes begin-verification and begin-architect-review', () => {
    // WORK-018 adds two new API endpoints that initiate verification and
    // architect review. These endpoints do NOT accept verification/review
    // outcomes — they only initiate the process.
    const routeFile = join(SRC_ROOT, 'api', 'routes', 'workflow.route.ts');
    const src = readFileSync(routeFile, 'utf8');
    expect(src).toMatch(/begin-verification/);
    expect(src).toMatch(/begin-architect-review/);
    expect(src).toMatch(/beginVerification/);
    expect(src).toMatch(/beginArchitectReview/);
  });

  it('REGRESSION (WORK-018): no public endpoint accepts verification/review outcomes', () => {
    // The begin-verification and begin-architect-review endpoints must NOT
    // accept outcome/payload fields that could forge results.
    const routeFile = join(SRC_ROOT, 'api', 'routes', 'workflow.route.ts');
    const src = readFileSync(routeFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Find the begin-verification handler body — must NOT accept allCriteriaPass.
    const beginVerifyMatch = codeOnly.match(/begin-verification[\s\S]*?begin-architect-review/);
    if (beginVerifyMatch) {
      expect(beginVerifyMatch[0]).not.toMatch(/allCriteriaPass/);
    }
    // Find the begin-architect-review handler body — must NOT accept outcome.
    const beginReviewMatch = codeOnly.match(/begin-architect-review[\s\S]*?convergence/);
    if (beginReviewMatch) {
      expect(beginReviewMatch[0]).not.toMatch(/outcome/);
    }
  });

  // --- WORK-019: Merge gating + advancement checks ---

  it('REGRESSION (WORK-019): workflow route exposes merge + advancement endpoints', () => {
    const routeFile = join(SRC_ROOT, 'api', 'routes', 'workflow.route.ts');
    const src = readFileSync(routeFile, 'utf8');
    expect(src).toMatch(/request-merge/);
    expect(src).toMatch(/merge-readiness/);
    expect(src).toMatch(/advance-to-verified/);
    expect(src).toMatch(/next-work-item/);
  });

  it('REGRESSION (WORK-019): no public endpoint can directly set MERGED or VERIFIED', () => {
    // No API endpoint may directly set workflow state to 'merged' or 'verified'.
    // The transitions go through WorkflowEngine.transition() via the orchestrator.
    const routeFile = join(SRC_ROOT, 'api', 'routes', 'workflow.route.ts');
    const src = readFileSync(routeFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // The route must NOT directly call workflowEngine.transition with 'merged' or 'verified'.
    // Only the orchestrator methods (requestMerge, advanceToVerified) may invoke transitions.
    expect(codeOnly).not.toMatch(/toState:\s*['"]merged['"]/);
    expect(codeOnly).not.toMatch(/toState:\s*['"]verified['"]/);
  });

  it('REGRESSION (PR #18): requestMerge invokes githubAdapter.mergePullRequest', () => {
    // Issue 1: requestMerge() must actually invoke the GitHub merge boundary,
    // not just record a signal.
    const orchFile = join(MODULES_DIR, 'workflows', 'internal', 'workflow-orchestrator.ts');
    const src = readFileSync(orchFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).toMatch(/githubAdapter\.mergePullRequest\s*\(/);
  });

  it('REGRESSION (PR #18): /workflows does not query wfos_verification_runs summary directly', () => {
    // Issue 2: /workflows must consume /verification's public contract
    // (VerificationService.findRun), not query wfos_verification_runs directly
    // for the summary.
    const orchFile = join(MODULES_DIR, 'workflows', 'internal', 'workflow-orchestrator.ts');
    const src = readFileSync(orchFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // The orchestrator must NOT read the summary column directly from wfos_verification_runs.
    // It should use verificationService.findRun() and read run.summary.
    expect(codeOnly).not.toMatch(/SELECT.*summary.*FROM\s+wfos_verification_runs/i);
    // It MUST use verificationService.findRun to load the run.
    expect(codeOnly).toMatch(/verificationService\.findRun\s*\(/);
  });

  it('REGRESSION (PR #18): advanceToVerified uses WorkItemCompletionService (not `as never`)', () => {
    // Issue 3: advanceToVerified() must use WorkItemCompletionService.markCompleted(),
    // not bypass UpdateWorkItemInput with `as never`.
    const orchFile = join(MODULES_DIR, 'workflows', 'internal', 'workflow-orchestrator.ts');
    const src = readFileSync(orchFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).toMatch(/workItemCompletionService\.markCompleted\s*\(/);
    expect(codeOnly).not.toMatch(/completed:\s*true\s*\}\s*as\s*never/);
  });
});

/**
 * WORK-020 invariants — /audit module boundaries.
 */
describe('WORK-020 invariants — /audit module boundaries', () => {
  it('/audit does not import from other modules internal/', () => {
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'audit'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === 'audit') continue;
        if (isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${targetModule}/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/audit does not import provider SDKs', () => {
    const PROVIDER_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'audit'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (PROVIDER_PACKAGES.has(pkg)) {
          violations.push(`${relative(BACKEND_ROOT, file)} imports provider SDK "${specifier}"`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/audit does not mutate workflow persistence directly', () => {
    const violations: string[] = [];
    const DIRECT_MUTATION = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+wfos_workflow_executions\b/i;
    for (const file of walkTs(join(MODULES_DIR, 'audit'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (DIRECT_MUTATION.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} mutates wfos_workflow_executions — /workflows owns canonical state`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/audit does not declare competing infrastructure', () => {
    const forbidden = /\bclass\s+\w+\s+(implements|extends)\s+(DatabaseClient|ObjectStore|Queue|WorkerHost)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'audit'))) {
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) {
        violations.push(`${relative(BACKEND_ROOT, file)} declares competing infrastructure`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no other module imports /audit/internal', () => {
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const targetModule = moduleOf(file);
      if (!targetModule || targetModule === 'audit') continue;
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const mod = moduleOf(resolved);
        if (mod === 'audit' && isInsideInternal(resolved)) {
          violations.push(`${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ${relative(BACKEND_ROOT, resolved)}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/audit barrel exposes only audit-domain contracts', () => {
    const aIndex = readFileSync(join(MODULES_DIR, 'audit', 'index.ts'), 'utf8');
    const allowed = new Set([
      'AuditEvent', 'WriteAuditEventInput', 'AuditEventWriter',
      'AuditEventRepository', 'AuditEventQuery', 'AuditService',
      'WorkflowAuditEmitter',
      'auditModule',
    ]);
    const exported: string[] = [];
    for (const m of aIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of aIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(unexpected, `/audit exports unexpected names: ${unexpected.join(', ')}`).toEqual([]);
  });

  // --- REGRESSION (PR #19): 3 blocking fixes ---

  it('REGRESSION (PR #19): app.ts wires DefaultAuditService + DefaultWorkflowEngine with audit emitter', () => {
    // Issue 1: production workflow transitions must emit audit events.
    // Verify app.ts imports + constructs both services.
    const appFile = join(SRC_ROOT, 'app.ts');
    const src = readFileSync(appFile, 'utf8');
    expect(src).toMatch(/import.*DefaultAuditService.*from.*audit\/internal\/audit-service/);
    expect(src).toMatch(/import.*DefaultWorkflowEngine.*from.*workflows\/internal\/workflow-engine/);
    expect(src).toMatch(/new DefaultAuditService\s*\(/);
    expect(src).toMatch(/new DefaultWorkflowEngine\s*\(/);
    // The workflow engine must be constructed with the audit service as the emitter.
    expect(src).toMatch(/auditService.*WorkflowAuditEmitter|auditService,\s*\/\/ WorkflowAuditEmitter/);
  });

  it('REGRESSION (PR #19): audit route resolves project BEFORE querying work-item audit', () => {
    // Issue 2: the work-item audit endpoint must resolve the project from
    // the work item chain and authorize BEFORE returning any results.
    const routeFile = join(SRC_ROOT, 'api', 'routes', 'audit.route.ts');
    const src = readFileSync(routeFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // The route must NOT return 200 [] without authorization.
    expect(codeOnly).not.toMatch(/events\.length\s*===\s*0.*\n.*return reply\.code\(200\)\.send\(\[\]\)/s);
    // The route MUST resolve the project from the work item chain.
    expect(codeOnly).toMatch(/resolveProjectForWorkItem/);
    expect(codeOnly).toMatch(/requireProjectAuthorization/);
  });

  it('REGRESSION (PR #19): audit integrity trigger checks all resource references', () => {
    // Issue 3: the integrity trigger must check ALL persisted references,
    // not just work_item_id.
    const migrationFile = join(SRC_ROOT, 'platform', 'postgres', 'migrations', '0015_audit.sql');
    const src = readFileSync(migrationFile, 'utf8');
    // Must check work_item_id (already existed).
    expect(src).toMatch(/NEW\.work_item_id/);
    // Must check work_order_id (new).
    expect(src).toMatch(/NEW\.work_order_id/);
    // Must check architecture_version_id (new).
    expect(src).toMatch(/NEW\.architecture_version_id/);
    // Must check review_id (new).
    expect(src).toMatch(/NEW\.review_id/);
    // Must check verification_run_id (new).
    expect(src).toMatch(/NEW\.verification_run_id/);
    // Must check agent_run_id (new).
    expect(src).toMatch(/NEW\.agent_run_id/);
    // Must check pull_request_association_id (new).
    expect(src).toMatch(/NEW\.pull_request_association_id/);
  });

  it('REGRESSION (PR #19 issue 4): index.ts wires workflow + audit routes into production buildServer', () => {
    // The production entry point (index.ts) must pass the audited
    // workflowEngine + auditService into buildServer so production
    // workflow transitions emit audit events and the audit API is served.
    const indexFile = join(SRC_ROOT, 'index.ts');
    const src = readFileSync(indexFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Must pass workflowEngine into the workflow route deps.
    expect(codeOnly).toMatch(/workflowEngine:\s*app\.deps\.workflowEngine/);
    // Must pass auditService into the audit route deps.
    expect(codeOnly).toMatch(/auditQuery:\s*app\.deps\.auditService/);
  });
});

/**
 * WORK-021 invariants -- /notifications module boundaries.
 */
describe('WORK-021 invariants -- /notifications module boundaries', () => {
  it('/notifications does not import from other modules internal/', () => {
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'notifications'))) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === 'notifications') continue;
        if (isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${targetModule}/internal)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/notifications does not import provider SDKs', () => {
    const PROVIDER_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'notifications'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (PROVIDER_PACKAGES.has(pkg)) {
          violations.push(`${relative(BACKEND_ROOT, file)} imports provider SDK "${specifier}"`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/notifications does not mutate workflow persistence directly', () => {
    const violations: string[] = [];
    const DIRECT_MUTATION = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+wfos_workflow_executions\b/i;
    for (const file of walkTs(join(MODULES_DIR, 'notifications'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (DIRECT_MUTATION.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} mutates wfos_workflow_executions`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/notifications does not declare competing infrastructure', () => {
    const forbidden = /\bclass\s+\w+\s+(implements|extends)\s+(DatabaseClient|ObjectStore|Queue|WorkerHost)\b/;
    const violations: string[] = [];
    for (const file of walkTs(join(MODULES_DIR, 'notifications'))) {
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) {
        violations.push(`${relative(BACKEND_ROOT, file)} declares competing infrastructure`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('/notifications barrel exposes only notification-domain contracts', () => {
    const nIndex = readFileSync(join(MODULES_DIR, 'notifications', 'index.ts'), 'utf8');
    const allowed = new Set([
      'NotificationRequest', 'NotificationStatus', 'CreateNotificationInput',
      'NotificationService', 'NotificationProviderAdapter',
      'NotificationDeliveryInput', 'NotificationDeliveryResult',
      'NotificationRepository',
      'notificationsModule',
    ]);
    const exported: string[] = [];
    for (const m of nIndex.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of nIndex.matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(unexpected, `/notifications exports unexpected names: ${unexpected.join(', ')}`).toEqual([]);
  });

  // --- REGRESSION (PR #20): 3 blocking fixes ---

  it('REGRESSION (PR #20): app.ts wires DefaultNotificationService + notification.send handler', () => {
    const appFile = join(SRC_ROOT, 'app.ts');
    const src = readFileSync(appFile, 'utf8');
    expect(src).toMatch(/import.*DefaultNotificationService.*from.*notification-service/);
    expect(src).toMatch(/import.*createNotificationJobHandler.*from.*notification-service/);
    expect(src).toMatch(/new DefaultNotificationService\s*\(/);
    expect(src).toMatch(/createNotificationJobHandler\s*\(/);
  });

  it('REGRESSION (PR #20): missing provider marks notification as FAILED (not delivered)', () => {
    const serviceFile = join(MODULES_DIR, 'notifications', 'internal', 'notification-service.ts');
    const src = readFileSync(serviceFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // The no-provider path must use 'failed', NOT 'delivered'.
    const noProviderMatch = codeOnly.match(/!provider[\s\S]*?return/);
    expect(noProviderMatch).not.toBeNull();
    expect(noProviderMatch![0]).toMatch(/'failed'/);
    expect(noProviderMatch![0]).not.toMatch(/'delivered'/);
  });

  it('REGRESSION (PR #20): notification integrity trigger checks resource references', () => {
    const migrationFile = join(SRC_ROOT, 'platform', 'postgres', 'migrations', '0016_notifications.sql');
    const src = readFileSync(migrationFile, 'utf8');
    expect(src).toMatch(/NEW\.work_item_id/);
    expect(src).toMatch(/NEW\.review_id/);
    expect(src).toMatch(/NEW\.verification_run_id/);
    expect(src).toMatch(/wfos_check_notification_integrity/);
  });

  it('REGRESSION (PR #20): index.ts wires notification routes into production buildServer', () => {
    const indexFile = join(SRC_ROOT, 'index.ts');
    const src = readFileSync(indexFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).toMatch(/notificationService:\s*app\.deps\.notificationService/);
  });
});

/**
 * WORK-022 invariants -- Frontend web application boundaries.
 *
 * Ensures the frontend:
 * - does not define canonical workflow states or transition graphs;
 * - does not implement authorization policy;
 * - does not import backend internal modules;
 * - does not import provider SDKs;
 * - does not write workflow persistence;
 * - does not evaluate verification evidence;
 * - consumes backend APIs only.
 */
describe('WORK-022 invariants -- Frontend web application boundaries', () => {
  const FRONTEND_DIR = join(BACKEND_ROOT, '..', 'frontend');

  it('frontend does not define canonical workflow transition maps', () => {
    if (!existsSync(FRONTEND_DIR)) return;
    const violations: string[] = [];
    const TRANSITION_MAP = /\bLEGAL_TRANSITIONS\b|\bworkflowGraph\b|\btransitionMap\b|\blegalTransitions\b/;
    for (const file of walkTs(join(FRONTEND_DIR, 'src'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (TRANSITION_MAP.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} defines a canonical workflow transition map`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('frontend does not implement authorization policy', () => {
    if (!existsSync(FRONTEND_DIR)) return;
    const violations: string[] = [];
    const AUTH_PATTERNS = /\bauthorize\s*\(|\bauthorizationService\b|\bcheckPermission\b|\bisAuthorized\b/;
    for (const file of walkTs(join(FRONTEND_DIR, 'src'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // Exclude API client type references (they reference types, not logic)
      if (AUTH_PATTERNS.test(codeOnly) && !file.includes('api/client')) {
        violations.push(`${relative(BACKEND_ROOT, file)} implements authorization policy`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('frontend does not import backend internal modules', () => {
    if (!existsSync(FRONTEND_DIR)) return;
    const violations: string[] = [];
    for (const file of walkTs(join(FRONTEND_DIR, 'src'))) {
      for (const specifier of extractSpecifiers(file)) {
        if (specifier.includes('/internal/') || specifier.includes('@modules/') || specifier.includes('@platform/')) {
          violations.push(`${relative(BACKEND_ROOT, file)} imports backend internal "${specifier}"`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('frontend does not import provider SDKs', () => {
    if (!existsSync(FRONTEND_DIR)) return;
    const PROVIDER_PACKAGES = new Set(['pg', 'ioredis', '@octokit/rest', '@octokit/graphql', '@octokit/webhooks', '@electric-sql/pglite']);
    const violations: string[] = [];
    for (const file of walkTs(join(FRONTEND_DIR, 'src'))) {
      for (const specifier of extractSpecifiers(file)) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/', 2).slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (PROVIDER_PACKAGES.has(pkg)) {
          violations.push(`${relative(BACKEND_ROOT, file)} imports provider SDK "${specifier}"`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('frontend does not evaluate verification evidence', () => {
    if (!existsSync(FRONTEND_DIR)) return;
    const violations: string[] = [];
    const EVAL_PATTERNS = /\bderiveCriterionStatus\b|\bevaluateCriterion\b|\bevaluateForRun\b|\bpersistEvaluations\b/;
    for (const file of walkTs(join(FRONTEND_DIR, 'src'))) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (EVAL_PATTERNS.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} evaluates verification evidence`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

// ===========================================================================
// WORK-023 — Deployable runtime invariants.
//
// Static checks that verify the frozen deployment topology is not violated:
//   - no Kubernetes manifests are introduced (DEPLOY-AC-03);
//   - no separate backend microservices are introduced (DEPLOY-AC-03);
//   - no deployment file hard-codes secrets (SEC-001);
//   - the backend remains one modular-monolith codebase;
//   - the worker uses the existing WorkerHost/queue (not a new framework);
//   - PostgreSQL remains authoritative (no SQLite/file-based authority);
//   - Redis remains non-authoritative (no Redis-as-database writes);
//   - ObjectStore remains behind its abstraction (no direct fs writes in
//     domain code);
//   - existing WORK-001 through WORK-022 checks remain intact.
// ===========================================================================

describe('WORK-023 invariants -- Deployable runtime', () => {
  const REPO_ROOT = join(BACKEND_ROOT, '..');
  const FE_DIR = join(REPO_ROOT, 'frontend');
  const DEPLOY_FILES = [
    join(REPO_ROOT, 'docker-compose.yml'),
    join(BACKEND_ROOT, 'Dockerfile'),
    join(FE_DIR, 'Dockerfile'),
    join(FE_DIR, 'nginx.conf'),
  ];

  // --- DEPLOY-AC-03: no Kubernetes ---

  it('no Kubernetes manifests are introduced', () => {
    const violations: string[] = [];
    // Check for k8s manifest files anywhere in the repo (excluding node_modules).
    function* walkDir(dir: string): Generator<string> {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          yield* walkDir(full);
        } else if (st.isFile() && (entry.endsWith('.yaml') || entry.endsWith('.yml'))) {
          yield full;
        }
      }
    }
    const K8S_KINDS = /\bkind:\s*(Pod|Deployment|Service|ConfigMap|Secret|Ingress|StatefulSet|DaemonSet|Job|CronJob|Namespace|ClusterRole|ClusterRoleBinding|Role|RoleBinding|ServiceAccount)\b/;
    for (const file of walkDir(REPO_ROOT)) {
      const src = readFileSync(file, 'utf8');
      if (K8S_KINDS.test(src)) {
        violations.push(`${relative(REPO_ROOT, file)} contains a Kubernetes manifest`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // --- DEPLOY-AC-03: no separate backend microservices ---

  it('backend remains one modular-monolith codebase (no separate service dirs)', () => {
    // The backend has one src/ directory with one entrypoint. There should
    // be no additional backend service directories (e.g. services/auth/,
    // services/workflow/) that would indicate microservice extraction.
    const srcDir = join(BACKEND_ROOT, 'src');
    const forbiddenDirs = ['services', 'microservices'];
    const violations: string[] = [];
    for (const dir of forbiddenDirs) {
      if (existsSync(join(srcDir, dir))) {
        violations.push(`${srcDir}/${dir} exists — microservice extraction detected`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('api and worker share the same Dockerfile (no separate images)', () => {
    // The backend Dockerfile is the single image for both api and worker.
    // There should not be separate Dockerfiles per role.
    const dockerfiles = readdirSync(BACKEND_ROOT).filter((f) => f.startsWith('Dockerfile'));
    // Exactly one Dockerfile in the backend dir.
    expect(dockerfiles.filter((f) => f === 'Dockerfile')).toHaveLength(1);
    // No role-specific Dockerfiles.
    const roleSpecific = dockerfiles.filter((f) => f !== 'Dockerfile');
    expect(roleSpecific, `found role-specific Dockerfiles: ${roleSpecific.join(', ')}`).toEqual([]);
  });

  // --- SEC-001: no secrets in deployment files ---
  //
  // PR #22 review found that docker-compose.yml hard-coded the PostgreSQL
  // credential (`POSTGRES_PASSWORD: wfos`) and embedded it in DATABASE_URL
  // (`postgres://wfos:wfos@...`). The previous version of this check did NOT
  // catch it because (a) the YAML values were unquoted (the regex required
  // quotes), and (b) there was an explicit carve-out that allowed the
  // DATABASE_URL password to match POSTGRES_PASSWORD. Both gaps are now
  // closed: the check forbids ANY literal credential in a deployment file
  // and requires `${VAR}` substitution instead.

  it('no deployment file hard-codes secrets (literal passwords / DATABASE_URL with embedded credential)', () => {
    const violations: string[] = [];
    for (const file of DEPLOY_FILES) {
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf8');
      // Strip comments (YAML #, Dockerfile #, nginx #, HTML <!-- -->).
      const codeOnly = src.replace(/^\s*#.*/gm, '').replace(/<!--[\s\S]*?-->/g, '');

      // 1. No literal POSTGRES_PASSWORD value. The value MUST be ${VAR}.
      //    Matches `POSTGRES_PASSWORD: <value>` or `POSTGRES_PASSWORD=<value>`
      //    where <value> is NOT a ${...} substitution.
      const pgPassMatches = codeOnly.matchAll(/POSTGRES_PASSWORD\s*[:=]\s*(\S+)/gi);
      for (const m of pgPassMatches) {
        const val = m[1]!.replace(/^['"]|['"]$/g, '');
        if (!val.startsWith('${')) {
          violations.push(`${relative(REPO_ROOT, file)} hard-codes POSTGRES_PASSWORD="${val}" — use \${VAR} substitution`);
        }
      }

      // 2. No literal DATABASE_URL with an embedded credential. The URL
      //    password MUST be ${VAR}, not a literal string.
      const dbUrlMatches = codeOnly.matchAll(/DATABASE_URL\s*[:=]\s*postgres:\/\/[^:]+:([^@]+)@/gi);
      for (const m of dbUrlMatches) {
        const pass = m[1]!.replace(/^['"]|['"]$/g, '');
        if (!pass.startsWith('${')) {
          violations.push(`${relative(REPO_ROOT, file)} embeds a literal password in DATABASE_URL — use \${VAR} substitution`);
        }
      }

      // 3. No other literal secret-like assignments (password, token,
      //    api_key, secret) with a non-${VAR} value.
      const SECRET_KEYS = /\b(password|token|api_key|secret_key|private_key)\s*[:=]\s*(\S+)/gi;
      const secretMatches = codeOnly.matchAll(SECRET_KEYS);
      for (const m of secretMatches) {
        const val = m[2]!.replace(/^['"]|['"]$/g, '');
        if (!val.startsWith('${') && val.length > 0) {
          violations.push(`${relative(REPO_ROOT, file)} hard-codes ${m[1]}="${val}" — use \${VAR} substitution`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // --- Worker uses existing WorkerHost/queue ---

  it('worker uses the existing WorkerHost (not a new framework)', () => {
    // The index.ts entrypoint uses WorkerHost from @platform/index.js.
    // Verify no competing worker framework is imported.
    const src = readFileSync(join(BACKEND_ROOT, 'src', 'index.ts'), 'utf8');
    expect(src).toMatch(/WorkerHost/);
    expect(src).not.toMatch(/\bbull\b|\bbullmq\b|\bcelery\b|\bsidekiq\b/i);
  });

  // --- PostgreSQL remains authoritative ---

  it('PostgreSQL remains authoritative (no SQLite/file-based authority)', () => {
    // The database factory creates pg.Pool (PostgreSQL) — no SQLite.
    const factorySrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'database-factory.ts'),
      'utf8',
    );
    expect(factorySrc).toMatch(/pg.*Pool/);
    // pglite is allowed for tests only (it IS real PostgreSQL compiled to WASM).
    expect(factorySrc).not.toMatch(/\bsqlite3\b|\bbetter-sqlite3\b/);
  });

  // --- Redis remains non-authoritative ---

  it('Redis remains non-authoritative (no Redis-as-database writes)', () => {
    // Redis is used for queue, locks, and cache — NOT for authoritative state.
    // Verify no Redis SET is used to persist domain state (only queue/lock/cache).
    const redisDir = join(BACKEND_ROOT, 'src', 'platform', 'redis');
    const violations: string[] = [];
    for (const file of walkTs(redisDir)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // Redis SET/HSET/LPUSH/RPUSH are allowed for queue/lock/cache — but
      // the files should be clearly queue/lock/cache (not domain persistence).
      // This is a light heuristic: we check that no file creates a Redis
      // "repository" pattern (e.g. `class *RedisRepository` that SETs domain
      // records). The existing RedisQueue, TransientLock, TransientCache are
      // the only allowed Redis consumers.
      if (/\bclass\s+\w*Repository\w*\b/.test(codeOnly) && /\.set\s*\(/.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} defines a Redis-backed repository (Redis is non-authoritative)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // --- ObjectStore remains behind its abstraction ---

  it('domain modules do not import fs/promises directly (ObjectStore boundary)', () => {
    // Domain modules (src/modules/**) must not write to the filesystem
    // directly — they use the ObjectStore abstraction.
    const violations: string[] = [];
    const MODULES = join(BACKEND_ROOT, 'src', 'modules');
    for (const file of walkTs(MODULES)) {
      for (const specifier of extractSpecifiers(file)) {
        if (specifier === 'node:fs/promises' || specifier === 'fs/promises' || specifier === 'fs') {
          violations.push(`${relative(BACKEND_ROOT, file)} imports fs directly — use ObjectStore instead`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // --- Health/readiness endpoint exists ---

  it('API exposes /health and /health/ready endpoints', () => {
    const healthSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'api', 'routes', 'health.route.ts'),
      'utf8',
    );
    expect(healthSrc).toMatch(/app\.get\('\/health'/);
    expect(healthSrc).toMatch(/app\.get\('\/health\/ready'/);
  });

  // --- docker-compose.yml has the frozen topology ---

  it('docker-compose.yml defines the frozen six-component topology', () => {
    const composeFile = join(REPO_ROOT, 'docker-compose.yml');
    if (!existsSync(composeFile)) {
      throw new Error('docker-compose.yml not found');
    }
    const src = readFileSync(composeFile, 'utf8');
    // The five services + object storage volume = six topology components.
    const REQUIRED_SERVICES = ['postgres', 'redis', 'api', 'worker', 'web'];
    for (const svc of REQUIRED_SERVICES) {
      expect(src, `docker-compose.yml missing service: ${svc}`).toMatch(new RegExp(`^\\s+${svc}:`, 'm'));
    }
    // Object storage is a shared volume.
    expect(src).toMatch(/objectdata:/);
  });

  // --- CI deployment validation exists ---

  it('CI workflow for deployment validation exists', () => {
    const deployYml = join(REPO_ROOT, '.github', 'workflows', 'deploy.yml');
    expect(existsSync(deployYml), 'deploy.yml workflow not found').toBe(true);
    const src = readFileSync(deployYml, 'utf8');
    expect(src).toMatch(/docker compose/);
    expect(src).toMatch(/validate-deployment/);
  });
});
