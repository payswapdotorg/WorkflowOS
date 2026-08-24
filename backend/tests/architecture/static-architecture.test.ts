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
  it('FROZEN_MODULE_NAMES covers exactly the 17 frozen backend modules', () => {
    // WORK-026 added /runtime as the 17th module (provider-independent
    // deployment boundary). The spec's original 16 modules remain frozen.
    expect(FROZEN_MODULE_NAMES).toHaveLength(17);
    expect(new Set(FROZEN_MODULE_NAMES).size).toBe(17);
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
      // WORK-025: Provider registry + transaction adapter (platform infrastructure)
      'DefaultProviderRegistry',
      'TxDatabaseClientAdapter',
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
    //
    // WORK-033 exception: pure-data catalog constants (display + validation
    // metadata only — no credentials, URLs, or DOM automation) MAY be exposed
    // via the barrel so application-layer orchestrators (e.g. src/execution-policy)
    // can compose provider metadata without inventing a second catalog. The
    // allowlist enumerates these known pure-data catalogs.
    const PURE_DATA_CATALOG_EXPORTS = new Set<string>([
      'EXTERNAL_UI_CATALOG', // @modules/agents — display + validation metadata
      // WORK-034: the session-domain typed error. A discriminated error
      // CLASS is the sanctioned exception to the types-only barrel rule —
      // consumers must instanceof-check it (a type-only export cannot
      // carry a runtime prototype), and it is domain logic, not a concrete
      // implementation: it wires nothing, constructs nothing, and holds
      // only (code, message, context). The same reasoning applies to the
      // frozen pure-data error-code list.
      'ExecutionSessionError',      // @modules/agents — the typed domain error
      'EXECUTION_SESSION_ERROR_CODES', // @modules/agents — the stable code list
    ]);
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
          if (PURE_DATA_CATALOG_EXPORTS.has(localName)) continue;
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
      // WORK-025: re-exported for transaction-scoped plan apply
      'PgArchitectureRepository',
      'PgArchitectureVersionRepository',
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
      // WORK-025: re-exported for transaction-scoped plan apply
      'PgRequirementRepository',
      'PgAcceptanceCriterionRepository',
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
      // WORK-025: re-exported for transaction-scoped plan apply
      'PgWorkItemRepository',
      'PgWorkItemRequirementRepository',
      'PgWorkItemCriterionRepository',
      'PgWorkOrderRepository',
      'PgWorkItemDependencyRepository',
      // WORK-026: ImplementationContext snapshot consumed by the
      // autonomous-implementation entry point (start-implementation route).
      'ImplementationContext',
      'ImplementationContextContent',
      // PR #35 review fix #1: ImplementationContextPreview is the read-only
      // preview shape — returned by `buildPreview()` (no DB writes) for
      // benchmark snapshot previews + dry-run prompt inspection.
      'ImplementationContextPreview',
      'ImplementationContextRepository',
      'ImplementationContextBuilder',
      // WORK-027: deterministic implementation prompt + provider-independent
      // ExecutionTask construction (feeds the /agents ExecutionService).
      'ExecutionPrompt',
      'ExecutionPromptBuilder',
      'ExecutionTaskService',
      'ExecutionTaskServiceInput',
      'BuiltExecutionTask',
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
      // Conversational Architect (WORK-025)
      'ArchitectMessage', 'ArchitectRevision', 'ArchitectParsedPlan',
      'ArchitectSession', 'ArchitectSessionRepository',
      'ConversationalArchitectResult', 'ConversationalArchitectService',
      'ProviderConfig',
      // WORK-025: Atomic plan applier
      'ApplyPlanResult', 'RepositoryFactories', 'ArchitectPlanApplier', 'ArchitectPlanInput',
      'ArchitectPlanIntegrityError',
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

  // -------------------------------------------------------------------------
  // PR #28 regression — atomicity of Architect session acceptance.
  //
  // The plan artifacts (Architecture, ArchitectureVersion, Requirements,
  // Criteria, Work Items, associations, dependencies, Work Orders) and
  // Architect session acceptance MUST commit or roll back together inside
  // a single db.transaction callback. This is structurally enforced by
  // requiring:
  //   1. createArchitectSessionRepository is declared on RepositoryFactories
  //   2. The applier constructs the transaction-scoped session repo via
  //      factories.createArchitectSessionRepository(txClient) INSIDE the
  //      db.transaction callback.
  //   3. markAccepted is invoked INSIDE the db.transaction callback (NOT
  //      after it returns).
  //   4. The apply route does NOT cast the body with `as any` — it must
  //      use the shared ArchitectPlanInput type.
  // -------------------------------------------------------------------------

  it('ArchitectPlanApplier requires createArchitectSessionRepository on RepositoryFactories', () => {
    const applierFile = join(MODULES_DIR, 'llm', 'internal', 'architect-plan-applier.ts');
    const src = readFileSync(applierFile, 'utf8');
    expect(src).toMatch(/createArchitectSessionRepository\s*:\s*\(db\s*:\s*DatabaseClient\)\s*=>\s*ArchitectSessionRepository/);
  });

  it('ArchitectPlanApplier constructs a transaction-scoped session repo and calls markAccepted on it', () => {
    // The applier MUST use `factories.createArchitectSessionRepository(txClient)`
    // (transaction-scoped) and call `sessionRepo.markAccepted(...)` on it.
    // The txClient is the TxDatabaseClientAdapter bound to the transaction —
    // using it proves the session repo's writes go through the SAME
    // connection as the other plan artifacts, so they commit/rollback together.
    const applierFile = join(MODULES_DIR, 'llm', 'internal', 'architect-plan-applier.ts');
    const src = readFileSync(applierFile, 'utf8');
    expect(src).toMatch(/factories\.createArchitectSessionRepository\(txClient\)/);
    expect(src).toMatch(/sessionRepo\.markAccepted/);
  });

  it('ArchitectPlanApplier does NOT call markAccepted on the ROOT session repository', () => {
    // The root `sessionRepository` (constructor-injected) is used ONLY for
    // the pre-transaction `findActiveByProject` lookup. The `markAccepted`
    // call MUST go through the transaction-scoped `sessionRepo` (constructed
    // inside the db.transaction callback via the factory). This is the key
    // atomicity fix: if markAccepted were called on the root repo, it
    // would commit independently of the plan writes — the original PR #28 bug.
    const applierFile = join(MODULES_DIR, 'llm', 'internal', 'architect-plan-applier.ts');
    const src = readFileSync(applierFile, 'utf8');
    // Strip comments before checking — otherwise doc comments mentioning
    // the pattern would create false positives.
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // `sessionRepository.markAccepted` (root repo) must NOT appear in code.
    expect(codeOnly).not.toMatch(/sessionRepository\.markAccepted/);
    // `sessionRepository.findActiveByProject` (the only allowed root-repo use)
    // MUST appear — it's the pre-tx lookup.
    expect(codeOnly).toMatch(/sessionRepository\.findActiveByProject/);
  });

  it('architect apply route does not cast body with `as any`', () => {
    const routeFile = join(SRC_ROOT, 'api', 'routes', 'architect.route.ts');
    const src = readFileSync(routeFile, 'utf8');
    // Locate the /architect/apply route section.
    const applySection = src.match(/app\.post\('\/projects\/:projectId\/architect\/apply'[\s\S]*?\n  \}\);/);
    expect(applySection, 'expected /architect/apply route to exist').not.toBeNull();
    // The route must NOT cast the body with `as any`. It MUST cast to
    // ArchitectPlanInput (the shared type).
    expect(applySection![0]).not.toMatch(/body\s+as\s+any/);
    expect(applySection![0]).toMatch(/as\s+ArchitectPlanInput/);
  });

  // -------------------------------------------------------------------------
  // PR #28 correction #2 — plan-integrity validation.
  //
  // The applier MUST NOT silently ignore invalid references in the plan.
  // It must throw BEFORE any plan artifact is persisted for:
  //   1. Unknown requirementId referenced by a Work Item
  //   2. Unknown criterionId referenced by a Work Item
  //   3. Unknown dependency ID referenced by a Work Item
  //   4. Duplicate Work Item IDs
  //   5. Duplicate requirement IDs
  //   6. Duplicate criterion IDs
  //   7. Criterion declared under the wrong requirement (referenced by a
  //      Work Item that does NOT also reference the criterion's parent
  //      requirement)
  //
  // The static checks below structurally enforce that the applier:
  //   - Has a validatePlan method
  //   - Calls it BEFORE the db.transaction
  //   - Throws ArchitectPlanIntegrityError for each violation kind
  //   - Does NOT silently skip associations on `find` returning undefined
  //     (the `if (req) await associate(...)` anti-pattern was the original
  //     PR #28 #2 bug — silent skip let malformed plans partially apply)
  // -------------------------------------------------------------------------

  it('ArchitectPlanApplier exposes a validatePlan method called BEFORE the db.transaction', () => {
    const applierFile = join(MODULES_DIR, 'llm', 'internal', 'architect-plan-applier.ts');
    const src = readFileSync(applierFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // validatePlan must exist as a private method.
    expect(codeOnly).toMatch(/private\s+validatePlan\s*\(plan:\s*ArchitectPlanInput\)\s*:\s*void/);
    // apply() MUST call this.validatePlan(plan) BEFORE this.db.transaction(...).
    const applyMatch = codeOnly.match(/async\s+apply\s*\([\s\S]*?\n  \}/);
    expect(applyMatch, 'expected apply method').not.toBeNull();
    const applyBody = applyMatch![0];
    const validateIdx = applyBody.indexOf('this.validatePlan(plan)');
    const txIdx = applyBody.indexOf('this.db.transaction(');
    expect(validateIdx, 'apply() must call this.validatePlan(plan)').toBeGreaterThan(-1);
    expect(txIdx, 'apply() must call this.db.transaction(').toBeGreaterThan(-1);
    expect(validateIdx, 'validatePlan must be called BEFORE db.transaction').toBeLessThan(txIdx);
  });

  it('ArchitectPlanApplier.validatePlan throws ArchitectPlanIntegrityError for every violation kind', () => {
    const applierFile = join(MODULES_DIR, 'llm', 'internal', 'architect-plan-applier.ts');
    const src = readFileSync(applierFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // The ArchitectPlanIntegrityError class must be declared.
    expect(codeOnly).toMatch(/class\s+ArchitectPlanIntegrityError\s+extends\s+Error/);
    // Every required violation kind must be thrown inside validatePlan.
    // We extract the validatePlan body and check each kind appears in a
    // `new ArchitectPlanIntegrityError(...)` call.
    const validateMatch = codeOnly.match(/private\s+validatePlan\s*\([\s\S]*?\n  \}/);
    expect(validateMatch, 'expected validatePlan method').not.toBeNull();
    const validateBody = validateMatch![0];
    const requiredKinds = [
      'duplicate-work-item-id',
      'duplicate-requirement-id',
      'duplicate-criterion-id',
      'unknown-requirement-reference',
      'unknown-criterion-reference',
      'unknown-dependency-reference',
      'criterion-declared-under-wrong-requirement',
    ];
    for (const kind of requiredKinds) {
      expect(
        validateBody,
        `validatePlan must throw ArchitectPlanIntegrityError with kind "${kind}"`,
      ).toMatch(new RegExp(`'${kind}'`));
    }
  });

  it('ArchitectPlanApplier does NOT silently skip associations when a reference is missing', () => {
    // The original PR #28 #2 bug: the applier used `if (req) await associate(...)`
    // which silently skipped association if the reference didn't resolve.
    // After the fix, validatePlan throws BEFORE any write, so the
    // association code can safely use `find(...)!` (non-null assertion)
    // because the plan was already validated.
    //
    // This static check enforces that the association code does NOT contain
    // `if (req)`, `if (crit)`, or `if (target)` guards — those were the
    // silent-skip anti-pattern. The validated code uses non-null assertions.
    const applierFile = join(MODULES_DIR, 'llm', 'internal', 'architect-plan-applier.ts');
    const src = readFileSync(applierFile, 'utf8');
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Strip the validatePlan body — we don't want its `if (!requirementIds.has(...))`
    // checks to be confused with the association `if (req)` anti-pattern.
    const withoutValidate = codeOnly.replace(
      /private\s+validatePlan\s*\([\s\S]*?\n  \}/,
      '/* validatePlan removed */',
    );
    // The association code MUST NOT use the `if (X) await ...` silent-skip pattern.
    expect(withoutValidate).not.toMatch(/if\s*\(req\)\s+await\s+wiReqRepo\.associate/);
    expect(withoutValidate).not.toMatch(/if\s*\(crit\)\s+await\s+wiCritRepo\.associate/);
    expect(withoutValidate).not.toMatch(/if\s*\(target\)\s+await\s+depRepo\.add/);
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

// ===========================================================================
// WORK-024 — End-to-end lifecycle invariants.
//
// Static checks that verify the E2E suite does not bypass architectural
// boundaries:
//   - E2E tests do not import domain internal/ implementations to mutate
//     state (only for composition/wiring at the test boundary);
//   - E2E tests do not directly mutate workflow persistence (all state changes
//     go through HTTP API calls);
//   - no test-only shortcut bypasses AuthorizationService;
//   - no second workflow engine / verification engine / review system is
//     introduced;
//   - E2E CI workflow exists.
// ===========================================================================

describe('WORK-024 invariants -- E2E lifecycle boundaries', () => {
  const REPO_ROOT = join(BACKEND_ROOT, '..');
  const E2E_DIR = join(BACKEND_ROOT, 'tests', 'integration', 'e2e');

  it('E2E test directory exists with lifecycle test', () => {
    expect(existsSync(E2E_DIR), 'E2E test directory not found').toBe(true);
    const lifecycleTest = join(E2E_DIR, 'lifecycle.integration.test.ts');
    expect(existsSync(lifecycleTest), 'lifecycle.integration.test.ts not found').toBe(true);
  });

  it('E2E tests drive lifecycle through HTTP API calls (server.inject), not direct service mutation', () => {
    if (!existsSync(E2E_DIR)) return;
    const violations: string[] = [];
    for (const file of walkTs(E2E_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // E2E tests MUST use server.inject for lifecycle mutations.
      // They may import services for WIRING (composition boundary), but must
      // NOT call mutating methods directly to simulate completed domain actions.
      // The key mutating methods that must NOT be called directly in the
      // lifecycle assertions:
      const MUTATING_CALLS = [
        /\bworkflowEngine\.transition\s*\(/,
        /\bverificationService\.createRun\s*\(/,
        /\bverificationService\.attachEvidence\s*\(/,
        /\bverificationService\.attachCiEvidence\s*\(/,
        /\bverificationService\.mapEvidenceToCriterion\s*\(/,
        /\bverificationService\.persistEvaluations\s*\(/,
        /\breviewService\.createReview\s*\(/,
        /\breviewService\.finalizeReview\s*\(/,
        /\breviewService\.addFinding\s*\(/,
        /\borchestrator\.submitVerificationCompleted\s*\(/,
        /\borchestrator\.submitReviewFinalized\s*\(/,
        /\borchestrator\.submitPullRequestMerged\s*\(/,
        /\borchestrator\.beginVerification\s*\(/,
        /\borchestrator\.beginArchitectReview\s*\(/,
      ];
      for (const pattern of MUTATING_CALLS) {
        if (pattern.test(codeOnly)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} calls a mutating service method directly (${pattern}) — use HTTP API (server.inject) instead`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('E2E tests do not directly mutate workflow persistence (no raw SQL on wfos_workflow_)', () => {
    if (!existsSync(E2E_DIR)) return;
    const violations: string[] = [];
    for (const file of walkTs(E2E_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // No direct SQL mutations on workflow tables.
      if (/UPDATE\s+wfos_workflow_|INSERT\s+INTO\s+wfos_workflow_|DELETE\s+FROM\s+wfos_workflow_/i.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} directly mutates wfos_workflow_ tables`);
      }
      // No direct SQL mutations on verification/review tables.
      if (/UPDATE\s+wfos_verification_|UPDATE\s+wfos_reviews_|UPDATE\s+wfos_evidence_/i.test(codeOnly)) {
        violations.push(`${relative(BACKEND_ROOT, file)} directly mutates verification/review/evidence tables`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('E2E tests do not bypass AuthorizationService (no direct DB seeding of protected resources in lifecycle assertions)', () => {
    if (!existsSync(E2E_DIR)) return;
    const violations: string[] = [];
    for (const file of walkTs(E2E_DIR)) {
      const src = readFileSync(file, 'utf8');
      // Strip comments.
      const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // The E2E test may create orgs/users/api-keys/Project B at the
      // composition boundary (in beforeAll) but must NOT seed
      // projects/work-items directly via repositories within `it(...)` blocks
      // (lifecycle assertions). We check only the content of `it(...)` blocks.
      // To isolate `it()` blocks, we split on `\nit(` or `\n  it(` at the
      // start of a line, and take everything until the next `it(`, `describe(`,
      // `beforeAll(`, `afterAll(`, or end of file.
      const itRegex = /\bit\s*\(\s*['"`]/g;
      let match: RegExpExecArray | null;
      while ((match = itRegex.exec(codeOnly)) !== null) {
        const start = match.index;
        // Find the end of this `it()` block: the next `it(`, `describe(`,
        // `beforeAll(`, `afterAll(`, or `});` at the same indentation level.
        // Simple heuristic: take the next 5000 chars or until the next `it(`.
        const rest = codeOnly.slice(start);
        const nextIt = rest.search(/\n\s*it\s*\(/);
        const nextDescribe = rest.search(/\n\s*describe\s*\(/);
        const nextBeforeAll = rest.search(/\n\s*beforeAll\s*\(/);
        const nextAfterAll = rest.search(/\n\s*afterAll\s*\(/);
        const ends = [nextIt, nextDescribe, nextBeforeAll, nextAfterAll].filter((n) => n > 0);
        const end = ends.length > 0 ? Math.min(...ends) : rest.length;
        const blockContent = rest.slice(0, end);
        if (/stack\.projectRepository\.create\s*\(/.test(blockContent)) {
          violations.push(`${relative(BACKEND_ROOT, file)} seeds a project via repository in a test block — use POST /organizations/:orgId/projects instead`);
        }
        if (/stack\.workItemRepository\.create\s*\(/.test(blockContent)) {
          violations.push(`${relative(BACKEND_ROOT, file)} seeds a work item via repository in a test block — use POST /architecture-versions/:versionId/work-items instead`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no second workflow engine / verification engine / review system is introduced', () => {
    // The E2E tests must reuse the existing DefaultWorkflowEngine,
    // DefaultVerificationService, DefaultReviewService — not introduce new ones.
    if (!existsSync(E2E_DIR)) return;
    for (const file of walkTs(E2E_DIR)) {
      const src = readFileSync(file, 'utf8');
      // Must import the existing services (not custom ones).
      expect(src).toMatch(/DefaultWorkflowOrchestrator/);
      expect(src).toMatch(/DefaultVerificationService/);
      expect(src).toMatch(/DefaultReviewService/);
      // Must NOT define new engines/services.
      expect(src).not.toMatch(/class\s+\w*WorkflowEngine\w*\s+implements/);
      expect(src).not.toMatch(/class\s+\w*VerificationService\w*\s+implements/);
      expect(src).not.toMatch(/class\s+\w*ReviewService\w*\s+implements/);
    }
  });

  it('E2E CI workflow exists', () => {
    const e2eYml = join(REPO_ROOT, '.github', 'workflows', 'e2e.yml');
    expect(existsSync(e2eYml), 'e2e.yml workflow not found').toBe(true);
    const src = readFileSync(e2eYml, 'utf8');
    expect(src).toMatch(/lifecycle\.integration/);
  });
});

// ===========================================================================
// WORK-026 invariants — project runtime + autonomous implementation boundaries.
//
// Static checks that enforce the WORK-026 architectural invariants:
//   - /runtime is the sole deployment/preview authority (no other module
//     calls Vercel; /runtime domain layer never imports an HTTP client SDK);
//   - /github remains the sole GitHub SDK caller (no other module imports
//     @octokit/*; the new provisioning extensions do not call the GitHub API
//     from the persistence/types layer);
//   - /work-items owns the ImplementationContextBuilder (no other module
//     instantiates it; the builder uses callback resolvers — never calls the
//     agent/github/vercel adapters directly);
//   - /agents owns agent execution (routes delegate to AgentGateway; the
//     start-implementation route delegates to StartImplementationService);
//   - /workflows owns workflow state transitions (the start-implementation
//     route must NOT call workflowEngine.transition — only the existing
//     /workflow/transitions endpoint may, once);
//   - /verification + /reviews remain the sole SQL authors of their tables
//     (no route file queries wfos_verification_runs / wfos_reviews directly);
//   - frontend never holds provider secrets, defines a workflow state
//     machine, opens a DB/GitHub/Vercel client directly;
//   - no module duplicates the Work Order / Agent authority;
//   - the composition root (app.ts + index.ts) wires the full WORK-026
//     service stack + the runtime + githubProvisioning route groups.
// ===========================================================================

describe('WORK-026 invariants — project runtime + autonomous implementation boundaries', () => {
  const SRC = join(BACKEND_ROOT, 'src');
  const ROUTES_DIR = join(SRC, 'api', 'routes');
  const FRONTEND_SRC_DIR = join(BACKEND_ROOT, '..', 'frontend', 'src');

  /** Strip line + block comments so TODO/NOTE text does not trip regex checks. */
  function stripComments(src: string): string {
    return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  // -------------------------------------------------------------------------
  // 1. /runtime module does not import from other modules internal/
  // -------------------------------------------------------------------------
  it('/runtime module does not import from other modules internal/', () => {
    const runtimeDir = join(MODULES_DIR, 'runtime');
    if (!existsSync(runtimeDir)) return;
    const violations: string[] = [];
    for (const file of walkTs(runtimeDir)) {
      for (const specifier of extractSpecifiers(file)) {
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved) continue;
        const targetModule = moduleOf(resolved);
        if (!targetModule || targetModule === 'runtime') continue;
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

  // -------------------------------------------------------------------------
  // 2. /runtime does not import Vercel SDK / HTTP client in domain layer
  //    (only vercel-deployment-provider.ts adapter may use the built-in fetch)
  // -------------------------------------------------------------------------
  it('/runtime does not import Vercel SDK / HTTP client in domain layer (only the adapter uses built-in fetch)', () => {
    const runtimeInternalDir = join(MODULES_DIR, 'runtime', 'internal');
    if (!existsSync(runtimeInternalDir)) return;
    // Forbidden HTTP client packages — the vercel-deployment-provider.ts adapter
    // uses Node 24's built-in global fetch, which requires NO import.
    const FORBIDDEN_HTTP_RE = /^(?:@vercel\/.+|undici|node-fetch|axios|got|got\/.+)$/;
    const violations: string[] = [];
    for (const file of walkTs(runtimeInternalDir)) {
      const base = file.split(sep).pop()!;
      // Only the Vercel adapter file may use a Vercel SDK / fetch.
      if (base === 'vercel-deployment-provider.ts') continue;
      for (const spec of extractSpecifiers(file)) {
        if (FORBIDDEN_HTTP_RE.test(spec)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports HTTP client "${spec}" — ` +
              `only vercel-deployment-provider.ts may use the built-in fetch against api.vercel.com`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 3. /runtime barrel exposes only runtime-domain contracts
  // -------------------------------------------------------------------------
  it('/runtime barrel exposes only runtime-domain contracts', () => {
    const runtimeIndex = readFileSync(join(MODULES_DIR, 'runtime', 'index.ts'), 'utf8');
    const allowed = new Set([
      // Domain types (SUB-B)
      'DeploymentStatus',
      'RuntimeIntegration',
      'Deployment',
      'CreateProjectDeploymentInput',
      'LinkRepositoryInput',
      'GetDeploymentInput',
      'DeploymentProvider',
      'RuntimeIntegrationRepository',
      'DeploymentRepository',
      'DeploymentService',
      'ProjectRuntimeStatus',
      'RuntimeStatusService',
      // Module contract (SUB-B)
      'RuntimeModuleApi',
      'runtimeModule',
    ]);
    const exported: string[] = [];
    for (const m of runtimeIndex.matchAll(/export\s+type\s*\{([^}]+)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed) exported.push(trimmed);
      }
    }
    for (const m of runtimeIndex.matchAll(/export\s+(?:const|class|function|interface)\s+(\w+)/g)) {
      exported.push(m[1]!);
    }
    const unexpected = exported.filter((n) => !allowed.has(n));
    expect(unexpected, `/runtime exports unexpected names: ${unexpected.join(', ')}`).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. GitHub provider code remains in /github (no other module imports @octokit/*)
  // -------------------------------------------------------------------------
  it('GitHub provider code remains in /github (no other module imports @octokit/*)', () => {
    const GITHUB_PACKAGES = new Set(['@octokit/rest', '@octokit/graphql', '@octokit/webhooks']);
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const mod = moduleOf(file);
      // /github owns the GitHub SDK; every other module is forbidden from
      // importing it. (/runtime talks to deployment providers via the
      // DeploymentProvider abstraction, not GitHub — it never needs @octokit.)
      if (mod === 'github') continue;
      for (const spec of extractSpecifiers(file)) {
        const pkg = spec.startsWith('@')
          ? spec.split('/', 2).slice(0, 2).join('/')
          : spec.split('/')[0]!;
        if (GITHUB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports GitHub SDK "${spec}" — ` +
              `GitHub integration is /github's authority; consume the provider-independent ` +
              `GitHubAdapter / ProjectGitHubRepositoryRepository contracts via @modules/github/index.js instead`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. /github provisioning extensions do not call GitHub SDK from domain layer
  //    (only the GitHub adapter files may do GitHub API work)
  // -------------------------------------------------------------------------
  it('/github provisioning extensions do not call GitHub SDK from domain layer', () => {
    // The two provisioning-domain files (types + persistence) MUST NOT import
    // @octokit/* or call fetch('https://api.github.com'). Only the adapter
    // files (DefaultGitHubAdapter in pg-github-repository.ts + FakeGitHubAdapter
    // in fake-github-adapter.ts) may perform GitHub API work.
    const GITHUB_SDK_RE = /@octokit\/(?:rest|graphql|webhooks)/;
    const GITHUB_API_FETCH_RE = /fetch\s*\(\s*['"`][^'"`]*api\.github\.com/;
    const violations: string[] = [];
    const domainFiles = [
      join(MODULES_DIR, 'github', 'internal', 'project-github-repository.types.ts'),
      join(MODULES_DIR, 'github', 'internal', 'pg-project-github-repository-repository.ts'),
    ];
    for (const file of domainFiles) {
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      for (const spec of extractSpecifiers(file)) {
        if (GITHUB_SDK_RE.test(spec)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports @octokit/* — ` +
              `only the GitHub adapter (DefaultGitHubAdapter / FakeGitHubAdapter) may import the GitHub SDK`,
          );
        }
      }
      if (GITHUB_API_FETCH_RE.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} calls fetch('https://api.github.com') directly — ` +
            `only the GitHub adapter may call the GitHub API`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 6. Agent execution uses AgentGateway (no route constructs/calls an agent
  //    adapter directly; start-implementation delegates to StartImplementationService)
  // -------------------------------------------------------------------------
  it('agent execution uses AgentGateway (routes delegate; start-implementation uses StartImplementationService)', () => {
    const violations: string[] = [];
    for (const file of walkTs(ROUTES_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      // No route file may construct an agent provider adapter directly.
      if (/\bnew\s+\w*AgentAdapter\s*\(/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} constructs an AgentAdapter — ` +
            `routes must enqueue through AgentGateway`,
        );
      }
      // No route file may call agentAdapter.run() directly.
      if (/\bagentAdapter\.run\s*\(/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} calls agentAdapter.run() directly — ` +
            `routes must enqueue through AgentGateway`,
        );
      }
    }
    // The start-implementation route (workflow.route.ts) MUST declare + delegate
    // to a StartImplementationService seam (which itself delegates to AgentGateway).
    const workflowRoute = join(ROUTES_DIR, 'workflow.route.ts');
    expect(existsSync(workflowRoute), 'workflow.route.ts must exist').toBe(true);
    if (existsSync(workflowRoute)) {
      const src = readFileSync(workflowRoute, 'utf8');
      expect(
        src,
        'workflow.route.ts must declare the StartImplementationService seam',
      ).toMatch(/StartImplementationService/);
      expect(
        src,
        'workflow.route.ts must register the start-implementation route',
      ).toMatch(/\/work-items\/:workItemId\/start-implementation/);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 7. Architect uses ArchitectService (no route constructs an LLM adapter)
  // -------------------------------------------------------------------------
  it('architect uses ArchitectService (no route constructs an LLM adapter / gateway)', () => {
    const violations: string[] = [];
    for (const file of walkTs(ROUTES_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      // No route file may construct an LLM adapter / gateway / OpenAI client.
      if (/\bnew\s+\w*(?:LlmAdapter|OpenAiCompatibleLlmAdapter|LlmGateway)\s*\(/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} constructs an LLM adapter / gateway — ` +
            `routes must delegate to the injected LlmGateway / ArchitectService`,
        );
      }
    }
    // The architect route MUST delegate via architectService.execute(...)
    // (the existing pattern from WORK-014).
    const architectRoute = join(ROUTES_DIR, 'architect.route.ts');
    expect(existsSync(architectRoute), 'architect.route.ts must exist').toBe(true);
    if (existsSync(architectRoute)) {
      const src = readFileSync(architectRoute, 'utf8');
      expect(src, 'architect.route.ts must call architectService.execute').toMatch(
        /architectService\.execute\s*\(/,
      );
      const codeOnly = stripComments(src);
      expect(
        codeOnly,
        'architect.route.ts must NOT construct an LlmGateway',
      ).not.toMatch(/\bnew\s+\w*LlmGateway\s*\(/);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 8. workflow transitions use WorkflowOrchestrator (start-implementation
  //    route must NOT mutate workflow state directly)
  // -------------------------------------------------------------------------
  it('workflow transitions use WorkflowOrchestrator (start-implementation route does not call workflowEngine.transition)', () => {
    const workflowRoute = join(ROUTES_DIR, 'workflow.route.ts');
    expect(existsSync(workflowRoute), 'workflow.route.ts must exist').toBe(true);
    if (!existsSync(workflowRoute)) return;
    const src = readFileSync(workflowRoute, 'utf8');
    const codeOnly = stripComments(src);
    // The EXISTING POST /work-items/:workItemId/workflow/transitions endpoint
    // is the low-level admin transition tool — it calls workflowEngine.transition
    // exactly ONCE. Any additional call (e.g. from the start-implementation
    // route) would be a violation: start-implementation must delegate state
    // changes to the orchestrator (initiateConvergence / handleInitiate).
    const transitionCalls = codeOnly.match(/\bworkflowEngine\.transition\s*\(/g) ?? [];
    expect(
      transitionCalls.length,
      `workflow.route.ts must invoke workflowEngine.transition at most once ` +
        `(the /workflow/transitions endpoint). Found ${transitionCalls.length} — ` +
        `the start-implementation route must NOT mutate workflow state directly; ` +
        `delegate to WorkflowOrchestrator.initiateConvergence() instead.`,
    ).toBeLessThanOrEqual(1);
    // The start-implementation route MUST exist + delegate via the builder +
    // (optional) startImplementationService.
    expect(src, 'workflow.route.ts must register the start-implementation route').toMatch(
      /\/work-items\/:workItemId\/start-implementation/,
    );
    expect(src, 'start-implementation must build via implementationContextBuilder').toMatch(
      /implementationContextBuilder\.build\s*\(/,
    );
  });

  // -------------------------------------------------------------------------
  // 9. verification uses VerificationService (no route queries wfos_verification_runs)
  // -------------------------------------------------------------------------
  it('verification uses VerificationService (no route file queries wfos_verification_runs directly)', () => {
    const violations: string[] = [];
    for (const file of walkTs(ROUTES_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      if (
        /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|UPSERT\s+INTO|MERGE\s+INTO)\s+wfos_verification_runs\b/i.test(
          codeOnly,
        )
      ) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} queries wfos_verification_runs directly — ` +
            `routes must delegate to VerificationService`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 10. review uses ReviewService (no route queries wfos_reviews)
  // -------------------------------------------------------------------------
  it('review uses ReviewService (no route file queries wfos_reviews directly)', () => {
    const violations: string[] = [];
    for (const file of walkTs(ROUTES_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      if (
        /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|UPSERT\s+INTO|MERGE\s+INTO)\s+wfos_reviews\b/i.test(
          codeOnly,
        )
      ) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} queries wfos_reviews directly — ` +
            `routes must delegate to ReviewService`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 11. frontend has no provider secrets (no process.env.<X>_API_KEY / _SECRET / _TOKEN)
  // -------------------------------------------------------------------------
  it('frontend has no provider secrets (no process.env.*_API_KEY / *_SECRET / *_TOKEN reads)', () => {
    if (!existsSync(FRONTEND_SRC_DIR)) return;
    const violations: string[] = [];
    // Match: process.env.<UPPER_NAME>_(API_KEY|API_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|TOKEN)
    const SECRET_ENV_RE =
      /\bprocess\.env\.[A-Z_]*(?:API_KEY|API_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|TOKEN)\b/;
    for (const file of walkTs(FRONTEND_SRC_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      if (SECRET_ENV_RE.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} reads a provider secret from process.env — ` +
            `secrets must stay backend-only (SEC-001)`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 12. frontend has no workflow state machine (extends WORK-022 check)
  // -------------------------------------------------------------------------
  it('frontend has no workflow state machine (no transition map / stateMachine declaration)', () => {
    if (!existsSync(FRONTEND_SRC_DIR)) return;
    const violations: string[] = [];
    // WORK-022 already covers LEGAL_TRANSITIONS/workflowGraph/transitionMap/legalTransitions.
    // WORK-026 extends to also catch state-machine declarations: transition:{},
    // nextState:, stateMachine:.
    const STATE_MACHINE_RE =
      /\bLEGAL_TRANSITIONS\b|\bworkflowGraph\b|\btransitionMap\b|\blegalTransitions\b|\btransition\s*:\s*\{|nextState\s*:|stateMachine\s*:/;
    for (const file of walkTs(FRONTEND_SRC_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      if (STATE_MACHINE_RE.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} defines a workflow state machine — ` +
            `only /workflows may own canonical workflow transitions`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 13. no direct DB access from frontend (no pg / ioredis / pglite / raw SQL)
  // -------------------------------------------------------------------------
  it('no direct DB access from frontend (no pg / ioredis / pglite / raw SQL)', () => {
    if (!existsSync(FRONTEND_SRC_DIR)) return;
    const DB_PACKAGES = new Set([
      'pg',
      'ioredis',
      '@electric-sql/pglite',
      'postgres',
      'pg-promise',
      'drizzle-orm',
      '@prisma/client',
    ]);
    const violations: string[] = [];
    for (const file of walkTs(FRONTEND_SRC_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      for (const spec of extractSpecifiers(file)) {
        const pkg = spec.startsWith('@')
          ? spec.split('/', 2).slice(0, 2).join('/')
          : spec.split('/')[0]!;
        if (DB_PACKAGES.has(pkg)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports DB client "${spec}" — ` +
              `frontend must go through backend HTTP routes`,
          );
        }
      }
      if (/\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\w+/i.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} issues a raw SQL statement — ` +
            `frontend must go through backend HTTP routes`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 14. no direct GitHub API from frontend (no api.github.com fetch / @octokit import)
  // -------------------------------------------------------------------------
  it('no direct GitHub API from frontend (no api.github.com fetch / @octokit import)', () => {
    if (!existsSync(FRONTEND_SRC_DIR)) return;
    const violations: string[] = [];
    for (const file of walkTs(FRONTEND_SRC_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      // Direct fetch to api.github.com (with a github URL as the first arg).
      if (/fetch\s*\(\s*['"`][^'"`]*api\.github\.com/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} calls api.github.com directly — ` +
            `must go through backend /github routes`,
        );
      }
      for (const spec of extractSpecifiers(file)) {
        if (/^@octokit\//.test(spec)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports @octokit/* SDK — ` +
              `must go through backend /github routes`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 15. no direct Vercel API from frontend (no api.vercel.com fetch / @vercel / VERCEL_API_TOKEN)
  // -------------------------------------------------------------------------
  it('no direct Vercel API from frontend (no api.vercel.com fetch / @vercel import / VERCEL_API_TOKEN)', () => {
    if (!existsSync(FRONTEND_SRC_DIR)) return;
    const violations: string[] = [];
    for (const file of walkTs(FRONTEND_SRC_DIR)) {
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      if (/fetch\s*\(\s*['"`][^'"`]*api\.vercel\.com/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} calls api.vercel.com directly — ` +
            `must go through backend /runtime routes`,
        );
      }
      if (/\bVERCEL_API_TOKEN\b/.test(codeOnly)) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} references VERCEL_API_TOKEN — ` +
            `Vercel credentials must stay backend-only (SEC-001)`,
        );
      }
      for (const spec of extractSpecifiers(file)) {
        if (/^@vercel\//.test(spec)) {
          violations.push(
            `${relative(BACKEND_ROOT, file)} imports @vercel/* SDK — ` +
              `must go through backend /runtime routes`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 16. no duplicate Work Order authority (only /work-items declares WorkOrderRepository)
  // -------------------------------------------------------------------------
  it('no duplicate Work Order authority (only /work-items declares a WorkOrderRepository)', () => {
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const mod = moduleOf(file);
      if (mod === 'work-items') continue;
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      const declaresRepo =
        /\bclass\s+\w*(?:WorkOrder)\w*Repository\b/.test(codeOnly) ||
        /\binterface\s+\w*(?:WorkOrder)\w*Repository\b/.test(codeOnly);
      if (declaresRepo) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares a WorkOrder*Repository — ` +
            `/work-items is the sole Work Order persistence authority`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 17. no duplicate Agent authority (only /agents declares AgentGateway / AgentRun*Repository)
  // -------------------------------------------------------------------------
  it('no duplicate Agent authority (only /agents declares AgentGateway / AgentRun*Repository)', () => {
    const violations: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const mod = moduleOf(file);
      if (mod === 'agents') continue;
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      const declaresGateway =
        /\bclass\s+\w*AgentGateway\w*\b/.test(codeOnly) ||
        /\binterface\s+\w*AgentGateway\w*\b/.test(codeOnly);
      const declaresRepo =
        /\bclass\s+\w*AgentRun\w*Repository\b/.test(codeOnly) ||
        /\binterface\s+\w*AgentRun\w*Repository\b/.test(codeOnly);
      if (declaresGateway || declaresRepo) {
        violations.push(
          `${relative(BACKEND_ROOT, file)} declares an AgentGateway / AgentRun*Repository — ` +
            `/agents is the sole agent-execution authority`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 18. ImplementationContextBuilder does not call agent/github/vercel directly
  //     (uses callback resolvers — no internal imports of those modules)
  // -------------------------------------------------------------------------
  it('ImplementationContextBuilder does not call agent / github / vercel directly (uses callback resolvers)', () => {
    const builderFile = join(
      MODULES_DIR,
      'work-items',
      'internal',
      'implementation-context-builder.ts',
    );
    expect(existsSync(builderFile), 'implementation-context-builder.ts must exist').toBe(true);
    if (!existsSync(builderFile)) return;
    const src = readFileSync(builderFile, 'utf8');
    const codeOnly = stripComments(src);
    // Must NOT import from /agents, /github, or /runtime internal/ — the
    // builder resolves runtime data via injected callback resolvers (avoids a
    // module cycle: /work-items → /agents → /work-items).
    for (const spec of extractSpecifiers(builderFile)) {
      expect(
        spec,
        `${relative(BACKEND_ROOT, builderFile)} must not import from /agents internal (use callback resolvers)`,
      ).not.toMatch(/@modules\/agents\/internal\//);
      expect(
        spec,
        `${relative(BACKEND_ROOT, builderFile)} must not import from /github internal (use callback resolvers)`,
      ).not.toMatch(/@modules\/github\/internal\//);
      expect(
        spec,
        `${relative(BACKEND_ROOT, builderFile)} must not import from /runtime internal (use callback resolvers)`,
      ).not.toMatch(/@modules\/runtime\/internal\//);
    }
    // Must NOT directly invoke the agent gateway / GitHub adapter / deployment service.
    expect(codeOnly).not.toMatch(/agentGateway\.execute\s*\(/);
    expect(codeOnly).not.toMatch(
      /githubAdapter\.(?:createRepository|createBranch|createPullRequest|mergePullRequest)\s*\(/,
    );
    expect(codeOnly).not.toMatch(/deploymentService\.provisionProject\s*\(/);
    expect(codeOnly).not.toMatch(
      /fetch\s*\(\s*['"`]https:\/\/(?:api\.github\.com|api\.vercel\.com|api\.openai\.com)/,
    );
  });

  // -------------------------------------------------------------------------
  // 19. Production readiness: app.ts wires the full WORK-026 service stack
  // -------------------------------------------------------------------------
  it('production readiness: app.ts constructs the full WORK-026 service stack', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    // The 11 WORK-026 services (SUB-B/C/D/E/F) that the composition root MUST
    // construct. (VercelDeploymentProvider is optional — wired only when
    // VERCEL_API_TOKEN env is set — so it is NOT in this list.)
    const REQUIRED_SERVICES = [
      'PgRuntimeIntegrationRepository',
      'PgDeploymentRepository',
      'DefaultDeploymentService',
      'FakeDeploymentProvider',
      'PgProjectGitHubRepositoryRepository',
      'PgImplementationContextRepository',
      'DefaultImplementationContextBuilder',
      'DefaultStartImplementationService',
      'PgAgentProviderConfigRepository',
      'DefaultAgentProviderRegistry',
      'DefaultAgentProviderRegistryService',
      'DefaultRuntimeStatusService',
      // WORK-027: execution provider abstraction services.
      'PgExecutionRecordRepository',
      'PgExecutionEventRepository',
      'PgExecutionHandoffRepository',
      'NativeExecutionProvider',
      'ExternalExecutionProvider',
      'DefaultExecutionService',
      'DefaultExecutionHandoffService',
      'DefaultExecutionEventIngestionService',
      'DefaultExecutionPromptBuilder',
      'DefaultExecutionTaskService',
      // PR #30 review fix #2: scoped callback credentials.
      'PgExecutionCallbackRepository',
      'DefaultExecutionCallbackService',
    ];
    const missing: string[] = [];
    for (const svc of REQUIRED_SERVICES) {
      if (!appSrc.includes(svc)) {
        missing.push(svc);
      }
    }
    expect(
      missing,
      `app.ts is missing WORK-026 service construction: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 20. index.ts passes WORK-026 route deps (runtime + githubProvisioning) to buildServer
  // -------------------------------------------------------------------------
  it('production readiness: index.ts passes runtime + githubProvisioning route deps to buildServer', () => {
    const indexSrc = readFileSync(join(BACKEND_ROOT, 'src', 'index.ts'), 'utf8');
    // The buildServer call must include both new WORK-026 route groups.
    expect(indexSrc, 'index.ts must wire the runtime route group').toMatch(/runtime\s*:/);
    expect(
      indexSrc,
      'index.ts must wire the githubProvisioning route group',
    ).toMatch(/githubProvisioning\s*:/);
  });

  // -------------------------------------------------------------------------
  // PR #29 fix #1: Start Implementation MUST actually invoke AgentGateway.
  //
  // The start-implementation route must NOT return success without an
  // AgentRun. The StartImplementationService must be wired in production
  // (app.ts) + passed to buildServer (index.ts). The route must return 503
  // (NOT 201) when the service is absent.
  // -------------------------------------------------------------------------

  it('PR #29 fix #1: app.ts wires DefaultStartImplementationService', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc).toMatch(/DefaultStartImplementationService/);
    expect(appSrc).toMatch(/startImplementationService\s*=\s*new\s+DefaultStartImplementationService/);
  });

  it('PR #29 fix #1: index.ts passes startImplementationService to buildServer', () => {
    const indexSrc = readFileSync(join(BACKEND_ROOT, 'src', 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/startImplementationService/);
  });

  it('PR #29 fix #1: start-implementation route returns 503 when service is absent (NOT 201)', () => {
    const routeSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'routes', 'workflow.route.ts'), 'utf8');
    // The route must check for the service + return 503 'service-unavailable'.
    expect(routeSrc).toMatch(/startImplementationService/);
    expect(routeSrc).toMatch(/503/);
    expect(routeSrc).toMatch(/service-unavailable/);
    // The route must NOT have a fallback that returns 201 without an agentRunId.
    // Extract the start-implementation route body + verify it doesn't contain
    // a bare `return reply.code(201)` that doesn't include agentRunId.
    const routeSection = routeSrc.match(/app\.post\('\/work-items\/:workItemId\/start-implementation'[\s\S]*?\n  \}\);/);
    expect(routeSection, 'expected start-implementation route').not.toBeNull();
    // The 201 response MUST include agentRunId (not optional).
    expect(routeSection![0]).toMatch(/agentRunId:\s*submission\.agentRunId/);
  });

  it('PR #29 fix #1 (WORK-027 refactor): NativeExecutionProvider calls AgentGateway.execute', () => {
    // WORK-027 moved the single native gateway invocation from
    // DefaultStartImplementationService (/work-items) into NativeExecutionProvider
    // (/agents) behind the ExecutionService boundary. The native path must
    // still reach the AgentGateway — from exactly one place.
    const svcFile = join(BACKEND_ROOT, 'src', 'modules', 'work-items', 'internal', 'start-implementation-service.ts');
    const src = readFileSync(svcFile, 'utf8');
    const codeOnly = stripComments(src);
    // The service delegates to the provider boundary instead.
    expect(codeOnly).toMatch(/executionService\.submit\s*\(/);
    expect(codeOnly).toMatch(/executionTaskService\.build\s*\(/);
    const providerFile = join(BACKEND_ROOT, 'src', 'modules', 'agents', 'internal', 'native-execution-provider.ts');
    const providerSrc = stripComments(readFileSync(providerFile, 'utf8'));
    expect(providerSrc).toMatch(/agentGateway\.execute\s*\(/);
  });

  // -------------------------------------------------------------------------
  // PR #29 fix #2: Vercel Connect must actually invoke the provider.
  //
  // The POST /runtime/connect route must call DeploymentService.provisionProject()
  // or linkRepository() — NOT just persist a manual external ID. The route
  // must return 503 when the provider is not configured (NO fake connected state).
  // -------------------------------------------------------------------------

  it('PR #29 fix #2: runtime route exposes POST /runtime/connect that invokes the provider', () => {
    const routeSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'routes', 'runtime.route.ts'), 'utf8');
    expect(routeSrc).toMatch(/app\.post\('\/projects\/:projectId\/runtime\/connect'/);
    // The route must call deploymentService.provisionProject or linkRepository.
    expect(routeSrc).toMatch(/deploymentService\.provisionProject\s*\(/);
    expect(routeSrc).toMatch(/deploymentService\.linkRepository\s*\(/);
    // The route must check provider health + return 503 when not configured.
    expect(routeSrc).toMatch(/provider-not-configured/);
    expect(routeSrc).toMatch(/health\(\)/);
  });

  // -------------------------------------------------------------------------
  // PR #29 fix #4: ImplementationContextBuilder must fail loudly on missing refs.
  //
  // The builder must NOT use the `if (!X) continue` silent-skip pattern for
  // requirements, criteria, or dependency targets. It must throw.
  // -------------------------------------------------------------------------

  it('PR #29 fix #4: ImplementationContextBuilder throws on missing requirement (no silent skip)', () => {
    const builderFile = join(BACKEND_ROOT, 'src', 'modules', 'work-items', 'internal', 'implementation-context-builder.ts');
    const src = readFileSync(builderFile, 'utf8');
    const codeOnly = stripComments(src);
    // Must NOT use the `if (!requirement) continue` silent-skip pattern.
    expect(codeOnly).not.toMatch(/if\s*\(!requirement\)\s*continue/);
    // MUST throw with a descriptive error.
    expect(codeOnly).toMatch(/implementation-context-requirement-missing/);
  });

  it('PR #29 fix #4: ImplementationContextBuilder throws on missing dependency target (no silent skip)', () => {
    const builderFile = join(BACKEND_ROOT, 'src', 'modules', 'work-items', 'internal', 'implementation-context-builder.ts');
    const src = readFileSync(builderFile, 'utf8');
    const codeOnly = stripComments(src);
    // Must NOT use the `if (!target) continue` silent-skip pattern.
    expect(codeOnly).not.toMatch(/if\s*\(!target\)\s*continue/);
    // MUST throw with a descriptive error.
    expect(codeOnly).toMatch(/implementation-context-dependency-missing/);
  });

  it('PR #29 fix #4: ImplementationContextBuilder throws on missing criterion (no silent skip)', () => {
    const builderFile = join(BACKEND_ROOT, 'src', 'modules', 'work-items', 'internal', 'implementation-context-builder.ts');
    const src = readFileSync(builderFile, 'utf8');
    const codeOnly = stripComments(src);
    // Must NOT use the `if (!crit) continue` silent-skip pattern.
    expect(codeOnly).not.toMatch(/if\s*\(!crit\)\s*continue/);
    // MUST throw with a descriptive error.
    expect(codeOnly).toMatch(/implementation-context-criterion-missing/);
  });
});

// ===========================================================================
// WORK-027 invariants — execution provider abstraction.
//
// One Work Order, two execution modes (native via AgentGateway / external via
// secure handoff package) behind one provider-independent boundary, with:
//   - workflow authority untouched (/workflows owns the state machine),
//   - verification/review authority untouched,
//   - GitHub authoritative for PR/merge (external execution only REPORTS),
//   - no secrets in execution packages,
//   - no provider-specific (Z.ai/ChatGPT/Claude) adapters/URLs/DOM logic yet,
//   - one-time, short-lived, authenticated handoff tokens.
// ===========================================================================

describe('WORK-027 invariants — execution provider abstraction', () => {
  const REPO_ROOT = join(BACKEND_ROOT, '..');
  const AGENTS_EXECUTION_FILES = [
    'execution.types.ts',
    'pg-execution-repository.ts',
    'native-execution-provider.ts',
    'external-execution-provider.ts',
    'execution-service.ts',
    'execution-handoff-service.ts',
    'execution-event-ingestion-service.ts',
    // PR #30 review fix #2: scoped event-ingestion callback credentials.
    'execution-callback-service.ts',
  ] as const;

  /** Strip block + line comments so checks match CODE, not prose in comments. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  function readAgentsExecutionFile(name: string): string {
    return readFileSync(
      join(BACKEND_ROOT, 'src', 'modules', 'agents', 'internal', name),
      'utf8',
    );
  }

  // --- Boundary shape ---

  it('WORK-027: /agents execution files exist and stay inside the module', () => {
    for (const f of AGENTS_EXECUTION_FILES) {
      expect(existsSync(join(BACKEND_ROOT, 'src', 'modules', 'agents', 'internal', f)), f).toBe(true);
    }
  });

  it('WORK-027: ExecutionTask carries the provider-independent execution contract', () => {
    const src = readAgentsExecutionFile('execution.types.ts');
    for (const field of [
      'projectId',
      'workItemId',
      'workOrderId',
      'implementationContextId',
      'repositoryOwner',
      'branch'.replace('branch', 'implementationBranch'),
      'expectedOutputs',
      'verificationRequirements',
      'mode',
      'promptDigest',
    ]) {
      expect(src, `ExecutionTask must declare ${field}`).toMatch(new RegExp(`readonly ${field}`));
    }
  });

  it('WORK-027: execution state machine is separate from the workflow state machine', () => {
    const types = readAgentsExecutionFile('execution.types.ts');
    // The 9 execution states belong to execution records only.
    for (const state of [
      "'created'", "'queued'", "'running'", "'handoff_ready'", "'submitted'",
      "'completed'", "'failed'", "'cancelled'", "'expired'",
    ]) {
      expect(types, `execution state ${state}`).toContain(state);
    }
    // No execution file may declare workflow states or a second workflow
    // state machine.
    for (const f of AGENTS_EXECUTION_FILES) {
      const codeOnly = stripComments(readAgentsExecutionFile(f));
      expect(codeOnly, `${f} must not declare LEGAL_TRANSITIONS`).not.toMatch(/LEGAL_TRANSITIONS/);
      expect(codeOnly, `${f} must not declare WorkflowState`).not.toMatch(
        /type\s+WorkflowState\s*=/,
      );
    }
  });

  it('WORK-027: NativeExecutionProvider uses the existing AgentGateway (no second gateway)', () => {
    const src = stripComments(readAgentsExecutionFile('native-execution-provider.ts'));
    expect(src).toMatch(/agentGateway\.execute\s*\(/);
    // It must NOT construct its own gateway or repository.
    expect(src).not.toMatch(/new\s+DefaultAgentGateway/);
    expect(src).not.toMatch(/new\s+PgAgentRunRepository/);
  });

  it('WORK-027: ImplementationContextBuilder remains the context authority', () => {
    // The ExecutionTaskService (/work-items) must build the context through
    // the builder — execution code never reconstructs Work Orders from raw
    // requirement/criterion repositories.
    const taskService = stripComments(
      readFileSync(
        join(BACKEND_ROOT, 'src', 'modules', 'work-items', 'internal', 'execution-task-service.ts'),
        'utf8',
      ),
    );
    expect(taskService).toMatch(/implementationContextBuilder\.build\s*\(/);
    // No /agents execution file may import requirement/architecture repos.
    for (const f of AGENTS_EXECUTION_FILES) {
      const src = readAgentsExecutionFile(f);
      expect(src, `${f} must not import /requirements`).not.toMatch(/@modules\/requirements/);
      expect(src, `${f} must not import /architecture`).not.toMatch(/@modules\/architecture/);
      expect(src, `${f} must not import /work-items`).not.toMatch(/@modules\/work-items/);
    }
  });

  // --- Authority invariants ---

  it('WORK-027: external execution never mutates workflow state directly', () => {
    for (const f of AGENTS_EXECUTION_FILES) {
      const codeOnly = stripComments(readAgentsExecutionFile(f));
      expect(codeOnly, `${f} must not import WorkflowEngine`).not.toMatch(
        /@modules\/workflows/,
      );
      expect(codeOnly, `${f} must not reference wfos_workflow_ tables`).not.toMatch(
        /wfos_workflow_/,
      );
      expect(codeOnly, `${f} must not call workflowEngine.transition`).not.toMatch(
        /workflowEngine\.transition\s*\(/,
      );
    }
    const ingestionRoute = readFileSync(
      join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution.route.ts'),
      'utf8',
    );
    expect(stripComments(ingestionRoute)).not.toMatch(/workflowEngine|orchestrator/);
  });

  it('WORK-027: external execution does not set verification PASS / APPROVED / MERGED', () => {
    for (const f of AGENTS_EXECUTION_FILES) {
      const codeOnly = stripComments(readAgentsExecutionFile(f));
      expect(codeOnly, `${f} must not import /verification`).not.toMatch(/@modules\/verification/);
      expect(codeOnly, `${f} must not import /reviews`).not.toMatch(/@modules\/reviews/);
      expect(codeOnly, `${f} must not reference verification tables`).not.toMatch(
        /wfos_verification_runs/,
      );
      expect(codeOnly, `${f} must not reference review tables`).not.toMatch(/wfos_reviews/);
      expect(codeOnly, `${f} must not set approved/merged workflow states`).not.toMatch(
        /toState:\s*'(approved|merged|verified)'/,
      );
    }
  });

  // --- Package security ---

  it('WORK-027: ExternalExecutionPackage declares no secret/token fields', () => {
    const src = readAgentsExecutionFile('execution.types.ts');
    // Extract the ExternalExecutionPackage interface body.
    const match = src.match(/interface ExternalExecutionPackage \{[\s\S]*?\n\}/);
    expect(match, 'ExternalExecutionPackage interface').not.toBeNull();
    const body = match![0];
    expect(body).not.toMatch(/(api[_-]?key|apikey|secret|github[_-]?token|access[_-]?token|webhook[_-]?secret|password|credential)\s*:/i);
  });

  it('WORK-027: external provider never reads secrets or SecretStore', () => {
    const src = stripComments(readAgentsExecutionFile('external-execution-provider.ts'));
    expect(src).not.toMatch(/SecretStore/);
    expect(src).not.toMatch(/getSecret\s*\(/);
    expect(src).not.toMatch(/process\.env/);
  });

  it('WORK-027: handoff tokens are stored hashed + one-time + short-lived', () => {
    const svc = readAgentsExecutionFile('execution-handoff-service.ts');
    expect(svc).toMatch(/createHash\('sha256'\)/);
    expect(svc).toMatch(/handoffTtlMs/);
    expect(svc).toMatch(/handoff-token-already-used/);
    expect(svc).toMatch(/handoff-token-expired/);
    expect(svc).toMatch(/handoff-token-invalid/);
    // The Pg repository must NOT store the raw token column.
    const repo = readAgentsExecutionFile('pg-execution-repository.ts');
    expect(repo).not.toMatch(/raw_token/);
  });

  it('WORK-027: execution package retrieval requires auth + one-time token (no public URLs)', () => {
    const routeSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution.route.ts'),
      'utf8',
    );
    // The package route must check project authorization + the token header.
    const packageRoute = routeSrc.match(/app\.get\('\/execution\/:executionId\/package'[\s\S]*?\n  \}\);/);
    expect(packageRoute, 'package route').not.toBeNull();
    expect(packageRoute![0]).toMatch(/requireProjectAuthorization/);
    expect(packageRoute![0]).toMatch(/x-handoff-token/);
    // The token must NOT travel in a URL query string.
    expect(routeSrc).not.toMatch(/querystring/);
    expect(packageRoute![0]).not.toMatch(/\?token=/);
  });

  // --- Provider-specific logic stays behind provider boundaries ---

  it('WORK-027: no provider-specific external adapters, URLs, or DOM automation exist yet', () => {
    // Backend: provider names may appear ONLY in the registry catalog file.
    const catalogFile = 'agent-provider-registry.types.ts';
    for (const file of walkTs(join(BACKEND_ROOT, 'src'))) {
      const rel = relative(BACKEND_ROOT, file);
      if (rel.includes('node_modules')) continue;
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      if (rel.endsWith(catalogFile)) continue;
      expect(
        codeOnly,
        `${rel} must not hard-code external provider names (zai/chatgpt/claude)`,
      ).not.toMatch(/['"`](zai|chatgpt|claude)['"`]/i);
    }
    // Frontend: no extension/DOM automation + no provider platform URLs.
    for (const file of walkTs(join(REPO_ROOT, 'frontend', 'src'))) {
      const rel = relative(REPO_ROOT, file);
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      expect(codeOnly, `${rel} must not contain extension APIs`).not.toMatch(
        /chrome\.runtime|browser\.runtime/,
      );
      expect(codeOnly, `${rel} must not contain provider platform URLs`).not.toMatch(
        /chat\.openai\.com|claude\.ai|z\.ai\/chat/i,
      );
    }
  });

  it('WORK-027: execution routes delegate to services (no SQL, no provider calls in routes)', () => {
    const routeSrc = stripComments(
      readFileSync(join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution.route.ts'), 'utf8'),
    );
    expect(routeSrc).not.toMatch(/SELECT |INSERT |UPDATE |DELETE FROM /i);
    expect(routeSrc).not.toMatch(/new\s+\w*ExecutionProvider/);
    expect(routeSrc).toMatch(/executionHandoffService\.issue\s*\(/);
    expect(routeSrc).toMatch(/executionHandoffService\.redeem\s*\(/);
    expect(routeSrc).toMatch(/executionEventIngestionService\.ingest\s*\(/);
  });

  it('WORK-027: workflow route exposes the mode-aware execution endpoint', () => {
    const routeSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'api', 'routes', 'workflow.route.ts'),
      'utf8',
    );
    expect(routeSrc).toMatch(/app\.post\('\/work-items\/:workItemId\/execution'/);
    expect(stripComments(routeSrc)).toMatch(/executionService\.submit\s*\(/);
    expect(stripComments(routeSrc)).toMatch(/executionTaskService\.build\s*\(/);
    // External mode must validate against the registry catalog.
    expect(stripComments(routeSrc)).toMatch(/isExternalProviderSupported/);
  });

  it('WORK-027: frontend never persists handoff tokens or packages', () => {
    for (const file of walkTs(join(REPO_ROOT, 'frontend', 'src'))) {
      const rel = relative(REPO_ROOT, file);
      const src = readFileSync(file, 'utf8');
      const codeOnly = stripComments(src);
      const storageWrites = [...codeOnly.matchAll(/localStorage\.setItem\(\s*['"]([^'"]+)['"]/g)];
      for (const m of storageWrites) {
        expect(m[1], `${rel} may only persist the API key in localStorage`).toBe('wfos_api_key');
      }
    }
  });

  it('WORK-027: audit events use the /audit authority with UPPER_SNAKE names', () => {
    const serviceSrc = readAgentsExecutionFile('execution-service.ts');
    expect(serviceSrc).toMatch(/auditService\.write\s*\(/);
    for (const evt of ['EXECUTION_CREATED', 'EXECUTION_HANDOFF_READY', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED']) {
      expect(serviceSrc, `execution-service must audit ${evt}`).toContain(evt);
    }
    const handoffSrc = readAgentsExecutionFile('execution-handoff-service.ts');
    expect(handoffSrc).toContain('EXECUTION_EXPIRED');
    const ingestSrc = readAgentsExecutionFile('execution-event-ingestion-service.ts');
    for (const evt of ['EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED']) {
      expect(ingestSrc, `ingestion must audit ${evt}`).toContain(evt);
    }
  });

  it('WORK-027: index.ts passes the execution route group to buildServer', () => {
    const indexSrc = readFileSync(join(BACKEND_ROOT, 'src', 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/execution:\s*\{/);
    expect(indexSrc).toMatch(/executionTaskService/);
    expect(indexSrc).toMatch(/executionService/);
  });

  // --- PR #30 review fix #1: execution list authorization ---

  it('PR #30 fix #1: execution list route authorizes BEFORE querying (no empty-list oracle)', () => {
    const routeSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution.route.ts'),
      'utf8',
    );
    const section = routeSrc.match(
      /app\.get\('\/work-items\/:workItemId\/executions'[\s\S]*?\n  \}\);/,
    );
    expect(section, 'executions list route').not.toBeNull();
    const body = section![0];
    // The established chain resolution must happen BEFORE authorization,
    // which must happen BEFORE the execution query.
    const resolveIdx = body.indexOf('resolveProjectForWorkItem');
    const authzIdx = body.indexOf('requireProjectAuthorization');
    const queryIdx = body.indexOf('listForWorkItem');
    expect(resolveIdx, 'list route must resolve the project').toBeGreaterThan(-1);
    expect(authzIdx, 'list route must authorize').toBeGreaterThan(-1);
    expect(queryIdx, 'list route must query executions').toBeGreaterThan(-1);
    expect(resolveIdx, 'resolve → authorize order').toBeLessThan(authzIdx);
    expect(authzIdx, 'authorize → query order').toBeLessThan(queryIdx);
    // The pre-fix bug: auth only ran when records.length > 0.
    expect(body, 'no conditional auth on non-empty results').not.toMatch(
      /records\.length > 0[\s\S]*requireProjectAuthorization/,
    );
  });

  // --- PR #30 review fix #2: scoped execution callback credentials ---

  it('PR #30 fix #2: callback tokens are hashed, short-lived, and scoped to exactly one execution', () => {
    const svc = readAgentsExecutionFile('execution-callback-service.ts');
    expect(svc).toMatch(/createHash\('sha256'\)/);
    expect(svc).toMatch(/wfct_/);
    expect(svc).toMatch(/callbackTtlMs/);
    expect(svc).toMatch(/callback-token-invalid/);
    expect(svc).toMatch(/callback-token-expired/);
    // Scope: the token's executionRecordId must match the addressed execution.
    const codeOnly = stripComments(svc);
    expect(codeOnly).toMatch(/callback\.executionRecordId !== record\.id/);
    // The Pg repository must NOT store a raw token column.
    const repo = readAgentsExecutionFile('pg-execution-repository.ts');
    expect(repo).not.toMatch(/raw_token/);
  });

  it('PR #30 fix #2: ONLY the events route accepts x-callback-token', () => {
    const apiDir = join(BACKEND_ROOT, 'src', 'api', 'routes');
    for (const file of walkTs(apiDir)) {
      const rel = relative(BACKEND_ROOT, file);
      const src = readFileSync(file, 'utf8');
      if (rel.endsWith('execution.route.ts')) {
        // Within execution.route.ts the header may appear ONLY in the events
        // handler — never in the package/handoff/list/get handlers.
        const eventsSection = src.match(
          /app\.post\('\/execution\/:executionId\/events'[\s\S]*?\n  \}\);\n\}/,
        );
        expect(eventsSection, 'events route').not.toBeNull();
        expect(eventsSection![0]).toContain('x-callback-token');
        const beforeEvents = src.slice(0, src.indexOf("app.post('/execution/:executionId/events'"));
        expect(
          stripComments(beforeEvents),
          'no x-callback-token outside the events route',
        ).not.toContain('x-callback-token');
        continue;
      }
      expect(src, `${rel} must not read x-callback-token`).not.toContain('x-callback-token');
    }
  });

  it('PR #30 fix #2: the external package returnCallback points at the scoped callback token, never an API key', () => {
    const src = readAgentsExecutionFile('external-execution-provider.ts');
    expect(src).toContain("auth: 'x-callback-token'");
    // The old instruction (use the WorkflowOS API key) must be gone.
    expect(src).not.toContain('with the WorkflowOS API key');
    // The package itself never embeds a token value.
    const codeOnly = stripComments(src);
    expect(codeOnly).not.toMatch(/wfct_|wfht_/);
  });

  it('PR #30 fix #2: app.ts + index.ts wire the callback service into the execution route group', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc).toMatch(/PgExecutionCallbackRepository/);
    expect(appSrc).toMatch(/DefaultExecutionCallbackService/);
    const indexSrc = readFileSync(join(BACKEND_ROOT, 'src', 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/executionCallbackService/);
  });
});


// ===========================================================================
// WORK-028 invariants — WorkflowOS Companion browser extension boundaries.
//
// The extension is an ISOLATED Manifest V3 Chromium extension under
// extension/ (own package.json/tsconfig/build; NOT part of the frontend SPA)
// that bridges WorkflowOS external executions to the user's AI platform
// session. Enforced:
//   - separation from the SPA + backend;
//   - no secrets / no API key usage (x-api-key, Bearer);
//   - exactly TWO WorkflowOS endpoints (companion/redeem + execution events);
//   - no DB/workflow/verification/review logic, no authority outcomes;
//   - callback token never persisted to localStorage/storage.local;
//   - no provider DOM automation (no selectors in providers/; no zai/chatgpt/
//     claude adapter files; names allow-listed to detector + registry);
//   - typed message protocol + provider-neutral registry;
//   - minimal manifest permissions;
//   - CSP hygiene (no eval/new Function/innerHTML).
// ===========================================================================

describe('WORK-028 invariants — Companion extension boundaries', () => {
  const REPO_ROOT = join(BACKEND_ROOT, '..');
  const EXT_ROOT = join(REPO_ROOT, 'extension');
  const EXT_SRC = join(EXT_ROOT, 'src');
  const FRONTEND_SRC = join(REPO_ROOT, 'frontend', 'src');

  function walkExtTs(dir: string): string[] {
    const files: string[] = [];
    if (!existsSync(dir)) return files;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) files.push(...walkExtTs(full));
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx') || entry.endsWith('.html')) {
        files.push(full);
      }
    }
    return files;
  }

  function strip(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('WORK-028: extension exists as an independent project (separate from the SPA)', () => {
    expect(existsSync(join(EXT_ROOT, 'package.json')), 'extension/package.json').toBe(true);
    expect(existsSync(join(EXT_ROOT, 'tsconfig.json')), 'extension/tsconfig.json').toBe(true);
    expect(existsSync(join(EXT_ROOT, 'build.mjs')), 'extension/build.mjs').toBe(true);
    expect(existsSync(join(EXT_ROOT, 'public', 'manifest.json')), 'manifest').toBe(true);
    // The SPA does not bundle or reference the extension; the extension does
    // not live under frontend/.
    expect(existsSync(join(FRONTEND_SRC, 'extension'))).toBe(false);
    for (const file of walkTs(FRONTEND_SRC)) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${relative(REPO_ROOT, file)} must not import extension code`).not.toMatch(
        /from ['"]\.\.\/\.\.\/extension|from ['"]@extension\//,
      );
    }
  });

  it('WORK-028: extension never imports backend or frontend modules', () => {
    for (const file of walkExtTs(EXT_SRC)) {
      const rel = relative(EXT_ROOT, file);
      const src = readFileSync(file, 'utf8');
      expect(src, `${rel} must not import @modules/@platform/@api`).not.toMatch(
        /@modules\/|@platform\/|@api\//,
      );
      expect(src, `${rel} must not reach into the frontend SPA`).not.toMatch(
        /\.\.\/\.\.\/frontend|frontend\/src/,
      );
    }
  });

  it('WORK-028: extension contains no secrets and never uses the WorkflowOS API key', () => {
    for (const file of walkExtTs(EXT_SRC)) {
      const rel = relative(EXT_ROOT, file);
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${rel} must not send x-api-key`).not.toContain("'x-api-key'");
      expect(code, `${rel} must not send x-api-key (double quotes)`).not.toContain('"x-api-key"');
      expect(code, `${rel} must not use Bearer auth`).not.toMatch(/Authorization['"]?\s*:/);
      expect(code, `${rel} must not assign literal secrets`).not.toMatch(
        /(?:api[_-]?key|apikey|secret|password|webhook[_-]?secret)\s*[:=]\s*['"][^'"]{8,}/i,
      );
    }
  });

  it('WORK-028: extension calls exactly TWO WorkflowOS endpoints (redeem + events)', () => {
    const allowed = /\/api\/(companion\/redeem|execution\/\$\{[^}]+\}\/events)/;
    for (const file of walkExtTs(EXT_SRC)) {
      const rel = relative(EXT_ROOT, file);
      const code = strip(readFileSync(file, 'utf8'));
      for (const m of code.matchAll(/['"`](\/api\/[^'"`\n]+)['"`]/g)) {
        expect(m[1], `${rel} references forbidden WorkflowOS path ${m[1]}`).toMatch(
          /\/api\/(companion\/redeem|execution\/)/,
        );
      }
      void allowed;
    }
    const clientSrc = readFileSync(join(EXT_SRC, 'workflowos', 'client.ts'), 'utf8');
    expect(clientSrc).toContain('/api/companion/redeem');
    expect(clientSrc).toMatch(/\/api\/execution\/\$\{session\.executionId\}\/events/);
  });

  it('WORK-028: extension has no DB / workflow / verification / review authority logic', () => {
    for (const file of walkExtTs(EXT_SRC)) {
      const rel = relative(EXT_ROOT, file);
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${rel} must not reference WorkflowOS tables`).not.toMatch(/wfos_[a-z_]+/);
      expect(code, `${rel} must not contain SQL`).not.toMatch(
        /SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i,
      );
      expect(code, `${rel} must not call workflow transitions`).not.toMatch(
        /workflow\/transitions|request-merge|advance-to-verified|begin-verification/,
      );
      expect(code, `${rel} must not touch verification/reviews`).not.toMatch(
        /verification-runs|\/reviews|begin-architect-review/,
      );
      expect(code, `${rel} must never claim authoritative outcomes`).not.toMatch(
        /['"](PASS|APPROVED|MERGED|VERIFIED)['"]\s*[:,}]/,
      );
    }
  });

  it('WORK-028: callback token is never persisted (no localStorage, no storage.local)', () => {
    for (const file of walkExtTs(EXT_SRC)) {
      const rel = relative(EXT_ROOT, file);
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${rel} must not use localStorage`).not.toMatch(/localStorage/);
      expect(code, `${rel} must not use disk-synced storage.local`).not.toMatch(/storage\.local/);
    }
  });

  it('WORK-028/029/030: provider DOM automation lives ONLY in provider adapter dirs', () => {
    for (const file of walkExtTs(join(EXT_SRC, 'providers'))) {
      const rel = relative(EXT_SRC, file).split(sep).join('/');
      // WORK-029: Z.ai; WORK-030: ChatGPT; WORK-031: Claude — real adapters
      // own their DOM logic.
      if (
        rel.startsWith('providers/zai/') ||
        rel.startsWith('providers/chatgpt/') ||
        rel.startsWith('providers/claude/')
      ) {
        continue;
      }
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${rel} must not use DOM selectors`).not.toMatch(
        /querySelector|getElementById|getElementsBy/,
      );
      expect(code, `${rel} must not inject HTML`).not.toMatch(/innerHTML|insertAdjacentHTML/);
    }
  });

  it('WORK-028/029: zai/chatgpt/claude literals exist ONLY in detector + registry + providers/zai/', () => {
    for (const file of walkExtTs(EXT_SRC)) {
      const rel = relative(EXT_SRC, file).replaceAll('\\', '/');
      const code = strip(readFileSync(file, 'utf8'));
      // detector + registry (metadata) and the real adapter dirs (WORK-029
      // Z.ai, WORK-030 ChatGPT, WORK-031 Claude) own their provider
      // identities.
      if (
        rel === 'providers/detector.ts' ||
        rel === 'providers/registry.ts' ||
        rel.startsWith('providers/zai/') ||
        rel.startsWith('providers/chatgpt/') ||
        rel.startsWith('providers/claude/')
      ) {
        continue;
      }
      expect(
        code,
        `${rel} must not hard-code provider names`,
      ).not.toMatch(/['"`](zai|chatgpt|claude)['"`]/i);
    }
    // providers/zai/ + providers/chatgpt/ + providers/claude/ are the ONLY
    // provider adapter directories (all shipped — WORK-029/030/031).
    const adapterDirs = new Set(
      walkExtTs(join(EXT_SRC, 'providers'))
        .map((f) => relative(join(EXT_SRC, 'providers'), f).split(sep)[0]!)
        .filter((d) => d !== 'fake' && !d.endsWith('.ts')),
    );
    expect([...adapterDirs].sort()).toEqual(['chatgpt', 'claude', 'zai']);
  });

  it('WORK-028: message protocol is a typed discriminated union', () => {
    const src = readFileSync(join(EXT_SRC, 'shared', 'messages.ts'), 'utf8');
    expect(src).toMatch(/export type CompanionMessage =/);
    expect(src).toMatch(/\| WorkflowOsHandoffMessage/);
    for (const t of [
      'WORKFLOWOS_HANDOFF', 'PROVIDER_DETECTED', 'START_EXECUTION', 'STOP_EXECUTION',
      'EXECUTION_PROGRESS', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED',
      'EXECUTION_BLOCKED', 'OPEN_PROVIDER',
    ]) {
      expect(src).toContain(`'${t}'`);
    }
    // Every envelope has type + executionId + timestamp + payload.
    expect(src).toMatch(/readonly type: T;/);
    expect(src).toMatch(/readonly executionId: string \| null;/);
    expect(src).toMatch(/readonly timestamp: number;/);
    expect(src).toMatch(/readonly payload: P;/);
  });

  it('WORK-028: provider adapter registry is provider-neutral (placeholders only)', () => {
    const src = readFileSync(join(EXT_SRC, 'providers', 'registry.ts'), 'utf8');
    const code = strip(src);
    expect(code).not.toMatch(/querySelector|innerHTML/);
    // Registered adapters: fake (028) + Z.ai (029) + ChatGPT (030) +
    // Claude (031) — the full set.
    expect(code).toMatch(/register\(fakeProviderAdapter\)/);
    expect(code).toMatch(/register\(zaiProviderAdapter\)/);
    expect(code).toMatch(/register\(chatgptProviderAdapter\)/);
    expect(code).toMatch(/register\(claudeProviderAdapter\)/);
  });

  it('WORK-028: manifest permissions are minimal (documented set only)', () => {
    const manifest = JSON.parse(
      readFileSync(join(EXT_ROOT, 'public', 'manifest.json'), 'utf8'),
    ) as {
      permissions: string[];
      host_permissions: string[];
      content_scripts?: { matches: string[] }[];
    };
    expect(manifest.permissions.sort()).toEqual(['activeTab', 'scripting', 'storage']);
    const forbidden = ['tabs', 'webRequest', 'cookies', 'history', 'downloads'];
    for (const perm of manifest.permissions) {
      expect(forbidden, `permission ${perm} must be justified`).not.toContain(perm);
    }
    const hosts = manifest.host_permissions.join(' ');
    expect(hosts, 'no <all_urls> host permission').not.toContain('<all_urls>');
    // Host permissions are limited to the WorkflowOS dev/test origin + the
    // supported provider domains (apex + subdomains — the least-privileged
    // wildcard form mirroring the detector's recognition rules). PR #34:
    // Claude's canonical host is now claude.com (claude.ai redirects here);
    // both are granted so the bridge attaches before AND after the redirect.
    for (const host of manifest.host_permissions) {
      expect(host).toMatch(
        /^https:\/\/\*\.(z\.ai|chatgpt\.com|claude\.com|claude\.ai)\/\*$|^http:\/\/(localhost|127\.0\.0\.1):(5173|3777|3778|3779)\/\*$/,
      );
    }
  });

  it('PR #31 fix: manifest covers the actual Z.ai chat domain + stays consistent with the detector', () => {
    const manifest = JSON.parse(
      readFileSync(join(EXT_ROOT, 'public', 'manifest.json'), 'utf8'),
    ) as {
      host_permissions: string[];
      content_scripts: { matches: string[]; js: string[] }[];
    };
    const hostPermissions = manifest.host_permissions;
    const providerDetectMatches =
      manifest.content_scripts.find((cs) => cs.js.some((j) => j.includes('provider-detect')))
        ?.matches ?? [];

    /**
     * Chrome host-pattern matcher (subset sufficient for these patterns):
     * `https://*.domain/*` covers the domain itself AND any subdomain
     * (exactly mirroring the detector's hostname === domain ||
     * hostname.endsWith('.' + domain) recognition); an exact host pattern
     * covers only that host.
     */
    function hostPatternCovers(pattern: string, url: URL): boolean {
      const m = pattern.match(/^(\*|https?):\/\/([^/]+)\//);
      if (!m || !m[1] || !m[2]) return false;
      const scheme = m[1];
      const patternHost = m[2];
      if (scheme !== '*' && url.protocol.replace(':', '') !== scheme) return false;
      const host = url.hostname.toLowerCase();
      if (patternHost.startsWith('*.')) {
        const base = patternHost.slice(2).toLowerCase();
        return host === base || host.endsWith('.' + base);
      }
      return host === patternHost.toLowerCase();
    }

    // --- The actual Z.ai chat application must be covered BOTH as a host
    //     permission AND as a provider-detect content-script match. Detector
    //     recognition alone is not enough — without the host permission the
    //     content script cannot run on the real chat domain.
    const chatUrl = new URL('https://chat.z.ai/chat/abc123');
    expect(
      hostPermissions.some((p) => hostPatternCovers(p, chatUrl)),
      'host_permissions must cover https://chat.z.ai (the actual Z.ai chat app)',
    ).toBe(true);
    expect(
      providerDetectMatches.some((p) => hostPatternCovers(p, chatUrl)),
      'provider-detect content-script matches must cover https://chat.z.ai',
    ).toBe(true);

    // --- Detector ↔ manifest consistency: every domain the detector
    //     recognizes (apex + ANY subdomain) must be covered by the manifest.
    //     Otherwise the detector can claim 'supported' where the extension
    //     cannot run at all — the exact PR #31 finding.
    const detectorSrc = readFileSync(join(EXT_SRC, 'providers', 'detector.ts'), 'utf8');
    const domains = [
      ...detectorSrc.matchAll(/providerId: '([a-z]+)', domain: '([a-z.]+)'/g),
    ].map((m) => m[2]!);
    expect(domains, 'detector should declare provider domains').toEqual(
      expect.arrayContaining([
        'z.ai',
        'chatgpt.com',
        // PR #34: BOTH Claude domains are recognized by the detector
        // (canonical current host + legacy/redirect host).
        'claude.com',
        'claude.ai',
      ]),
    );
    for (const domain of domains) {
      for (const host of [domain, `chat.${domain}`, `app.${domain}`]) {
        const url = new URL(`https://${host}/`);
        expect(
          hostPermissions.some((p) => hostPatternCovers(p, url)),
          `host_permissions must cover https://${host}/ (detector recognizes it)`,
        ).toBe(true);
        expect(
          providerDetectMatches.some((p) => hostPatternCovers(p, url)),
          `provider-detect matches must cover https://${host}/ (detector recognizes it)`,
        ).toBe(true);
      }
    }

    // Least privilege: the old apex-only pattern (the PR #31 finding) must
    // NOT be the z.ai grant.
    expect(hostPermissions, 'z.ai grant must be the wildcard form').toContain('https://*.z.ai/*');
    expect(hostPermissions).not.toContain('https://z.ai/*');
  });

  it('WORK-028: CSP hygiene — no eval / new Function / innerHTML anywhere in the extension', () => {
    for (const file of walkExtTs(EXT_SRC)) {
      const rel = relative(EXT_ROOT, file);
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${rel} must not eval`).not.toMatch(/\beval\s*\(/);
      expect(code, `${rel} must not use new Function`).not.toMatch(/new Function\s*\(/);
      expect(code, `${rel} must not assign innerHTML`).not.toMatch(/innerHTML\s*=/);
    }
  });

  it('WORK-028: companion redeem route is token-only (no API-key authorization) + one-time', () => {
    const routeSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'api', 'routes', 'companion.route.ts'),
      'utf8',
    );
    expect(routeSrc).toMatch(/app\.post\('\/companion\/redeem'/);
    expect(routeSrc).toMatch(/x-handoff-token/);
    // The route must NOT require an API key — the one-time token IS the authority.
    expect(strip(routeSrc)).not.toMatch(/requireProjectAuthorization|requireUser/);
    // Redemption consumes the one-time token (single-use semantics).
    const svcSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'modules', 'agents', 'internal', 'execution-handoff-service.ts'),
      'utf8',
    );
    expect(svcSrc).toMatch(/redeemByToken/);
    expect(svcSrc).toMatch(/COMPANION_HANDOFF_REDEEMED/);
  });

  it('WORK-028: the fake provider is the catalog test-mode entry (mirrors fake adapters)', () => {
    const src = readFileSync(
      join(BACKEND_ROOT, 'src', 'modules', 'agents', 'internal', 'agent-provider-registry.types.ts'),
      'utf8',
    );
    expect(src).toMatch(/name: 'Fake \(test\)',\s*provider: 'fake',/);
  });
});


// ===========================================================================
// WORK-029 invariants — the real Z.ai adapter.
//
//   - ALL Z.ai DOM selectors live under extension/src/providers/zai/;
//   - the adapter implements the provider-neutral ExternalProviderAdapter;
//   - the adapter NEVER sends WorkflowOS API keys / accesses cookies /
//     touches workflow/verification/review authority / merges PRs;
//   - prompt digest is verified BEFORE submission; duplicate submission is
//     double-guarded (session flag + in-page execution guard);
//   - detector/registry surface the adapter; the zai bridge stays thin
//     (no selectors outside the adapter).
// ===========================================================================

describe('WORK-029 invariants — Z.ai adapter boundaries', () => {
  const REPO_ROOT = join(BACKEND_ROOT, '..');
  const EXT_ROOT = join(REPO_ROOT, 'extension');
  const EXT_SRC = join(EXT_ROOT, 'src');
  const ZAI_DIR = join(EXT_SRC, 'providers', 'zai');

  function strip(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  function zaiFiles(): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(ZAI_DIR)) {
      if (entry.endsWith('.ts')) out.push(join(ZAI_DIR, entry));
    }
    return out;
  }

  it('WORK-029: the adapter package exists (adapter, selectors, types, runtime, README)', () => {
    for (const f of ['zai-provider-adapter.ts', 'zai-selectors.ts', 'zai-types.ts', 'zai-page-runtime.ts', 'README.md']) {
      expect(existsSync(join(ZAI_DIR, f)), `providers/zai/${f}`).toBe(true);
    }
  });

  it('WORK-029: ALL Z.ai DOM knowledge lives in providers/zai (selector strategies are centralized)', () => {
    // The selector strategies are declared ONLY in zai-selectors.ts.
    const selectors = readFileSync(join(ZAI_DIR, 'zai-selectors.ts'), 'utf8');
    expect(selectors).toMatch(/export const COMPOSER/);
    expect(selectors).toMatch(/export const SEND_CONTROL/);
    // Observed-contract anchors (documented in providers/zai/README.md).
    expect(selectors).toContain('textarea#chat-input');
    expect(selectors).toContain('Send Message');
    // The runtime uses the centralized resolvers, not ad-hoc selectors.
    const runtime = strip(readFileSync(join(ZAI_DIR, 'zai-page-runtime.ts'), 'utf8'));
    expect(runtime).not.toMatch(/querySelector\(['"`]#chat-input/);
    expect(runtime).not.toMatch(/querySelectorAll\(['"`]\*\)/);
    // No Z.ai DOM knowledge outside providers/zai/ (detector + registry hold
    // domain/identity metadata only — enforced by the literals check).
    for (const file of [
      join(EXT_SRC, 'providers', 'detector.ts'),
      join(EXT_SRC, 'providers', 'registry.ts'),
      join(EXT_SRC, 'content', 'zai-bridge.ts'),
    ]) {
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${relative(EXT_SRC, file)} must not hold Z.ai DOM anchors`).not.toMatch(
        /chat-input|Send Message|aria-label="New Chat"/,
      );
    }
  });

  it('WORK-029: the zai bridge content script is thin (no selectors, no DOM queries)', () => {
    const code = strip(readFileSync(join(EXT_SRC, 'content', 'zai-bridge.ts'), 'utf8'));
    expect(code).not.toMatch(/querySelector|getElementById|getElementsBy/);
    // It delegates to the page runtime instead of automating itself.
    expect(code).toMatch(/zaiPageRuntime\.appliesTo/);
    expect(code).toMatch(/zaiPageRuntime\.attach/);
  });

  it('WORK-029: ZaiProviderAdapter implements the neutral ExternalProviderAdapter contract', () => {
    const code = strip(readFileSync(join(ZAI_DIR, 'zai-provider-adapter.ts'), 'utf8'));
    expect(code).toMatch(/implements ExternalProviderAdapter/);
    expect(code).toMatch(/readonly providerId = 'zai'/);
    for (const method of [
      'matchesPage(',
      'openTask(',
      'injectPrompt(',
      'observeExecution(',
      'detectCompletion(',
      'detectFailure(',
      'collectObservations(',
      'stop(',
    ]) {
      expect(code, `adapter must implement ${method}`).toContain(method);
    }
    // No DOM APIs in the background-side adapter (page runtime owns them).
    expect(code).not.toMatch(/querySelector|document\.|window\./);
  });

  it('WORK-029: the adapter never sends API keys, reads cookies, or touches authority surfaces', () => {
    for (const file of zaiFiles()) {
      const rel = relative(EXT_ROOT, file);
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${rel} must not send API keys`).not.toMatch(/x-api-key|Authorization['"]?\s*:/);
      expect(code, `${rel} must not read cookies`).not.toMatch(/document\.cookie|chrome\.cookies/);
      expect(code, `${rel} must not set workflow states`).not.toMatch(
        /workflow\/transitions|request-merge|advance-to-verified|begin-verification/,
      );
      expect(code, `${rel} must not evaluate verification`).not.toMatch(
        /verification-runs|\/reviews|begin-architect-review/,
      );
      expect(code, `${rel} must not approve reviews or merge PRs`).not.toMatch(
        /mergePullRequest|APPROVED|VERIFIED|\bMERGED\b|\bPASS\b/,
      );
      expect(code, `${rel} must not call WorkflowOS HTTP directly`).not.toMatch(
        /\/api\/companion|\/api\/execution/,
      );
      expect(code, `${rel} must not evaluate untrusted output`).not.toMatch(
        /eval\s*\(|new Function\s*\(|innerHTML\s*=/,
      );
    }
  });

  it('WORK-029: prompt digest is verified BEFORE any submission (identity check ordering)', () => {
    const code = strip(readFileSync(join(ZAI_DIR, 'zai-page-runtime.ts'), 'utf8'));
    const digestCheck = code.indexOf('sha256Hex(session.prompt)');
    const guard = code.indexOf("'digest-mismatch'");
    const inject = code.indexOf('injectPrompt(');
    const submit = code.indexOf('submit()');
    expect(digestCheck, 'runtime must compute the digest').toBeGreaterThan(-1);
    expect(guard, 'runtime must refuse on mismatch').toBeGreaterThan(-1);
    expect(inject).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(-1);
    expect(digestCheck, 'digest check precedes injection').toBeLessThan(inject);
    expect(guard, 'mismatch refusal precedes injection').toBeLessThan(inject);
    expect(inject, 'injection precedes submit').toBeLessThan(submit);
    // The digest comparison itself is an equality guard on the session digest.
    expect(code).toContain('digest !== session.promptDigest');
  });

  it('WORK-029: duplicate submission is double-guarded (session flag + in-page execution guard)', () => {
    const runtime = strip(readFileSync(join(ZAI_DIR, 'zai-page-runtime.ts'), 'utf8'));
    expect(runtime).toMatch(/!session\.promptSubmitted && !state\.injectedExecutionIds\.has\(/);
    expect(runtime).toMatch(/state\.injectedExecutionIds\.add\(/);
    const adapter = strip(readFileSync(join(ZAI_DIR, 'zai-provider-adapter.ts'), 'utf8'));
    expect(adapter).toMatch(/if \(session\.promptSubmitted\) return;/);
    // The background persists the submitted flag (reload never resubmits).
    const background = readFileSync(join(EXT_SRC, 'background', 'index.ts'), 'utf8');
    expect(background).toMatch(/promptSubmitted = true/);
  });

  it('WORK-029/030/031: Z.ai + ChatGPT + Claude adapters registered + detected', () => {
    const registry = readFileSync(join(EXT_SRC, 'providers', 'registry.ts'), 'utf8');
    expect(registry).toMatch(/register\(zaiProviderAdapter\)/);
    expect(registry).toMatch(/register\(chatgptProviderAdapter\)/);
    expect(registry).toMatch(/register\(claudeProviderAdapter\)/);
    const detector = readFileSync(join(EXT_SRC, 'providers', 'detector.ts'), 'utf8');
    expect(detector).toMatch(/\['zai', 'chatgpt', 'claude'\]\.includes\(match\.providerId\)/);
  });

  it('WORK-029: manifest wires the zai bridge on Z.ai + the documented fixture test origin', () => {
    const manifest = JSON.parse(
      readFileSync(join(EXT_ROOT, 'public', 'manifest.json'), 'utf8'),
    ) as { host_permissions: string[]; content_scripts: { matches: string[]; js: string[] }[] };
    expect(manifest.host_permissions).toContain('http://127.0.0.1:3777/*');
    const zaiBridge = manifest.content_scripts.find((cs) =>
      cs.js.some((j) => j.includes('zai-bridge')),
    );
    expect(zaiBridge, 'zai-bridge content script registered').toBeTruthy();
    expect(zaiBridge!.matches).toContain('https://*.z.ai/*');
    expect(zaiBridge!.matches).toContain('http://127.0.0.1:3777/*');
    // The zai bridge does NOT run on chatgpt/claude (their adapters pending).
    expect(zaiBridge!.matches.join(' ')).not.toMatch(/chatgpt|claude/);
  });

  it('WORK-029: the fixture harness reproduces the observed contract (real-submit counter, variants)', () => {
    const fixtureDir = join(EXT_ROOT, 'tests', 'zai', 'fixture');
    const html = readFileSync(join(fixtureDir, 'index.html'), 'utf8');
    expect(html).toContain('id="chat-input"');
    expect(html).toContain('aria-label="Send Message"');
    const agent = readFileSync(join(fixtureDir, 'fixture-agent.js'), 'utf8');
    expect(agent).toMatch(/__zaiFixture/);
    expect(agent).toMatch(/counter\.submits/);
    for (const variant of ['wall=login', 'fail=1', 'confirm=1', 'xss=1']) {
      const [key, value] = variant.split('=');
      expect(agent).toContain(`params.get('${key}')`);
      expect(agent).toContain(`'${value}'`);
    }
  });
});


// ===========================================================================
// WORK-030 invariants — the real ChatGPT adapter.
//
//   - ALL ChatGPT DOM selectors live under extension/src/providers/chatgpt/;
//   - the bridge stays thin; the adapter implements the neutral contract;
//   - no cookies / API keys / workflow/verification/review/merge surfaces;
//   - prompt digest verified BEFORE submission; exactly one submit path,
//     double-guarded against duplicates;
//   - ChatGPT host permissions match the detector (§23);
//   - NO Claude automation exists (§36).
// ===========================================================================

describe('WORK-030 invariants — ChatGPT adapter boundaries', () => {
  const REPO_ROOT = join(BACKEND_ROOT, '..');
  const EXT_ROOT = join(REPO_ROOT, 'extension');
  const EXT_SRC = join(EXT_ROOT, 'src');
  const CGPT_DIR = join(EXT_SRC, 'providers', 'chatgpt');

  function strip(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  function chatgptFiles(): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(CGPT_DIR)) {
      if (entry.endsWith('.ts')) out.push(join(CGPT_DIR, entry));
    }
    return out;
  }

  it('WORK-030: the adapter package exists (adapter, selectors, types, runtime, README)', () => {
    for (const f of [
      'chatgpt-provider-adapter.ts',
      'chatgpt-selectors.ts',
      'chatgpt-types.ts',
      'chatgpt-page-runtime.ts',
      'README.md',
    ]) {
      expect(existsSync(join(CGPT_DIR, f)), `providers/chatgpt/${f}`).toBe(true);
    }
  });

  it('WORK-030: ALL ChatGPT DOM knowledge lives in providers/chatgpt (selectors centralized)', () => {
    const selectors = readFileSync(join(CGPT_DIR, 'chatgpt-selectors.ts'), 'utf8');
    expect(selectors).toMatch(/export const COMPOSER/);
    expect(selectors).toMatch(/export const SEND_CONTROL/);
    // Observed-contract anchors (documented in providers/chatgpt/README.md).
    expect(selectors).toContain('#prompt-textarea');
    expect(selectors).toContain('data-testid="send-button"');
    expect(selectors).toContain('data-testid="stop-button"');
    // The runtime uses centralized resolvers / generic message anchors.
    const runtime = strip(readFileSync(join(CGPT_DIR, 'chatgpt-page-runtime.ts'), 'utf8'));
    expect(runtime).not.toMatch(/querySelector\(['"]#prompt-textarea/);
    // No ChatGPT DOM anchors outside providers/chatgpt/ (detector + registry
    // hold domain/identity metadata only).
    for (const file of [
      join(EXT_SRC, 'providers', 'detector.ts'),
      join(EXT_SRC, 'providers', 'registry.ts'),
      join(EXT_SRC, 'content', 'chatgpt-bridge.ts'),
    ]) {
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${relative(EXT_SRC, file)} must not hold ChatGPT DOM anchors`).not.toMatch(
        /prompt-textarea|send-button|stop-button|data-message-author-role/,
      );
    }
  });

  it('WORK-030: the chatgpt bridge content script is thin (no selectors, no DOM queries)', () => {
    const code = strip(readFileSync(join(EXT_SRC, 'content', 'chatgpt-bridge.ts'), 'utf8'));
    expect(code).not.toMatch(/querySelector|getElementById|getElementsBy/);
    expect(code).toMatch(/chatgptPageRuntime\.appliesTo/);
    expect(code).toMatch(/chatgptPageRuntime\.attach/);
  });

  it('WORK-030: ChatgptProviderAdapter implements the neutral ExternalProviderAdapter contract', () => {
    const code = strip(readFileSync(join(CGPT_DIR, 'chatgpt-provider-adapter.ts'), 'utf8'));
    expect(code).toMatch(/implements ExternalProviderAdapter/);
    expect(code).toMatch(/readonly providerId = 'chatgpt'/);
    for (const method of [
      'matchesPage(',
      'openTask(',
      'injectPrompt(',
      'observeExecution(',
      'detectCompletion(',
      'detectFailure(',
      'collectObservations(',
      'stop(',
    ]) {
      expect(code, `adapter must implement ${method}`).toContain(method);
    }
    // No DOM APIs in the background-side adapter.
    expect(code).not.toMatch(/querySelector|document\.|window\./);
  });

  it('WORK-030: the adapter never sends API keys, reads cookies, or touches authority surfaces', () => {
    for (const file of chatgptFiles()) {
      const rel = relative(EXT_ROOT, file);
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${rel} must not send API keys`).not.toMatch(/x-api-key|Authorization['"]?\s*:/);
      expect(code, `${rel} must not read cookies`).not.toMatch(/document\.cookie|chrome\.cookies/);
      expect(code, `${rel} must not set workflow states`).not.toMatch(
        /workflow\/transitions|request-merge|advance-to-verified|begin-verification/,
      );
      expect(code, `${rel} must not evaluate verification`).not.toMatch(
        /verification-runs|\/reviews|begin-architect-review/,
      );
      expect(code, `${rel} must not approve reviews or merge PRs`).not.toMatch(
        /mergePullRequest|APPROVED|VERIFIED|\bMERGED\b|\bPASS\b/,
      );
      expect(code, `${rel} must not call WorkflowOS HTTP directly`).not.toMatch(
        /\/api\/companion|\/api\/execution/,
      );
      expect(code, `${rel} must not evaluate untrusted output`).not.toMatch(
        /eval\s*\(|new Function\s*\(|innerHTML\s*=/,
      );
    }
  });

  it('WORK-030: prompt digest is verified BEFORE any submission (identity check ordering)', () => {
    const code = strip(readFileSync(join(CGPT_DIR, 'chatgpt-page-runtime.ts'), 'utf8'));
    const digestCheck = code.indexOf('sha256Hex(session.prompt)');
    const guard = code.indexOf("'digest-mismatch'");
    const inject = code.indexOf('injectPrompt(');
    const submit = code.indexOf('submit()');
    expect(digestCheck).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(inject).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(-1);
    expect(digestCheck, 'digest check precedes injection').toBeLessThan(inject);
    expect(guard, 'mismatch refusal precedes injection').toBeLessThan(inject);
    expect(inject, 'injection precedes submit').toBeLessThan(submit);
    expect(code).toContain('digest !== session.promptDigest');
  });

  it('WORK-030: exactly ONE submit path exists, double-guarded against duplicates', () => {
    const runtime = strip(readFileSync(join(CGPT_DIR, 'chatgpt-page-runtime.ts'), 'utf8'));
    // One submit definition; call sites guarded.
    expect(runtime.match(/export function submit\(/g)?.length).toBe(1);
    expect(runtime).toMatch(/!session\.promptSubmitted && !state\.injectedExecutionIds\.has\(/);
    expect(runtime).toMatch(/state\.injectedExecutionIds\.add\(/);
    const adapter = strip(readFileSync(join(CGPT_DIR, 'chatgpt-provider-adapter.ts'), 'utf8'));
    expect(adapter).toMatch(/if \(session\.promptSubmitted\) return;/);
    const background = readFileSync(join(EXT_SRC, 'background', 'index.ts'), 'utf8');
    expect(background).toMatch(/promptSubmitted = true/);
  });

  it('WORK-030: ChatGPT host permissions match the detector (§23 consistency)', () => {
    const manifest = JSON.parse(
      readFileSync(join(EXT_ROOT, 'public', 'manifest.json'), 'utf8'),
    ) as { host_permissions: string[]; content_scripts: { matches: string[]; js: string[] }[] };
    const bridge = manifest.content_scripts.find((cs) =>
      cs.js.some((j) => j.includes('chatgpt-bridge')),
    );
    expect(bridge, 'chatgpt-bridge content script registered').toBeTruthy();
    expect(bridge!.matches).toContain('https://*.chatgpt.com/*');
    // The chatgpt bridge does NOT run on other providers.
    expect(bridge!.matches.join(' ')).not.toMatch(/z\.ai|claude/);
    // Detector-recognized chatgpt.com hosts are covered by host permissions
    // (apex + subdomains, mirroring the detector's recognition rules).
    function covers(pattern: string, url: URL): boolean {
      const m = pattern.match(/^(\*|https?):\/\/([^/]+)\//);
      if (!m || !m[1] || !m[2]) return false;
      if (m[1] !== '*' && url.protocol.replace(':', '') !== m[1]) return false;
      const host = url.hostname.toLowerCase();
      if (m[2].startsWith('*.')) {
        const base = m[2].slice(2).toLowerCase();
        return host === base || host.endsWith('.' + base);
      }
      return host === m[2].toLowerCase();
    }
    for (const host of ['chatgpt.com', 'ab.chatgpt.com']) {
      const url = new URL(`https://${host}/c/x`);
      expect(
        manifest.host_permissions.some((p) => covers(p, url)),
        `host_permissions must cover https://${host}/`,
      ).toBe(true);
      expect(
        bridge!.matches.some((p) => covers(p, url)),
        `chatgpt-bridge matches must cover https://${host}/`,
      ).toBe(true);
    }
  });

  it('WORK-030: the fixture harness reproduces the observed contract (real-submit counter, variants)', () => {
    const fixtureDir = join(EXT_ROOT, 'tests', 'chatgpt', 'fixture');
    const html = readFileSync(join(fixtureDir, 'index.html'), 'utf8');
    expect(html).toContain('id="prompt-textarea"');
    expect(html).toContain('contenteditable="true"');
    expect(html).toContain('data-testid="send-button"');
    expect(html).toContain('data-testid="stop-button"');
    const agent = readFileSync(join(fixtureDir, 'fixture-agent.js'), 'utf8');
    expect(agent).toMatch(/__chatgptFixture/);
    expect(agent).toMatch(/counter\.submits/);
    for (const variant of ['wall=login', 'fail=1', 'confirm=1', 'xss=1']) {
      const [key, value] = variant.split('=');
      expect(agent).toContain(`params.get('${key}')`);
      expect(agent).toContain(`'${value}'`);
    }
  });


  // --- PR #33 review correction: SURFACE gating (coding-agent vs Chat) ---

  it('PR #33 fix: implementation tasks REQUIRE the coding surface — gating precedes any injection (no silent Chat fallback)', () => {
    const runtime = strip(readFileSync(join(CGPT_DIR, 'chatgpt-page-runtime.ts'), 'utf8'));
    const surfaceGate = runtime.indexOf("'ChatGPT coding environment unavailable or unverified.'");
    const noFallback = runtime.indexOf('coding-surface-unavailable');
    const inject = runtime.indexOf('injectPrompt(');
    const submit = runtime.indexOf('submit()');
    expect(surfaceGate, 'surface-block reason must exist').toBeGreaterThan(-1);
    expect(noFallback, 'no-fallback detail must exist').toBeGreaterThan(-1);
    expect(surfaceGate, 'surface gating precedes injection').toBeLessThan(inject);
    expect(noFallback, 'surface gating precedes submit').toBeLessThan(submit);
    // Implementation tasks carry the requirement from the bridge.
    const bridge = strip(readFileSync(join(EXT_SRC, 'content', 'chatgpt-bridge.ts'), 'utf8'));
    expect(bridge).toContain("taskKind: 'implementation'");
  });

  it('PR #33 fix: openTask targets the CODING surface (chatgpt.com/codex) — never the Chat root', () => {
    const adapter = strip(readFileSync(join(CGPT_DIR, 'chatgpt-provider-adapter.ts'), 'utf8'));
    expect(adapter).toContain('`${chatgptOrigin}/codex`');
    expect(adapter).not.toContain('`${chatgptOrigin}/`;');
    expect(adapter).toMatch(/describeSurfaces\(\)/);
    expect(adapter).toContain("implementationSurface: 'coding-agent'");
  });

  it('PR #33 fix: the surface capability model exists on BOTH sides (backend catalog + extension types)', () => {
    // Backend catalog: chatgpt implementation surface = coding-agent, coding
    // readiness 'unverified' — flipping it to 'ready' requires a conscious
    // live signed-in verification pass (fixture-only proof is insufficient
    // per the review).
    const catalog = readFileSync(
      join(BACKEND_ROOT, 'src', 'modules', 'agents', 'internal', 'agent-provider-registry.types.ts'),
      'utf8',
    );
    expect(catalog).toMatch(/implementationSurface: 'coding-agent'/);
    expect(catalog).toMatch(/codingAgent: 'unverified'/);
    // Z.ai's implementation surface is unchanged (WORK-029 design).
    expect(catalog).toMatch(/implementationSurface: 'conversational-chat'/);
    // Extension: shared surface types + registry exposure.
    const types = readFileSync(join(EXT_SRC, 'providers', 'types.ts'), 'utf8');
    expect(types).toMatch(/export type ProviderSurfaceKind/);
    expect(types).toMatch(/export type SurfaceReadiness/);
    const registry = readFileSync(join(EXT_SRC, 'providers', 'registry.ts'), 'utf8');
    expect(registry).toMatch(/describeSurfaces\?\.\(\)/);
  });

  it('PR #33 fix: a CODING-AGENT fixture exists representing the actual target surface', () => {
    const fixtureDir = join(EXT_ROOT, 'tests', 'chatgpt', 'fixture');
    const html = readFileSync(join(fixtureDir, 'codex.html'), 'utf8');
    expect(html).toContain('data-testid="codex-sidebar"');
    expect(html).toContain('aria-label="Describe a new coding task"');
    const agent = readFileSync(join(fixtureDir, 'codex-agent.js'), 'utf8');
    expect(agent).toMatch(/__codexFixture/);
    expect(agent).toMatch(/\/codex\/t\//);
  });

  it('WORK-031: the Claude adapter exists and is properly isolated', () => {
    expect(existsSync(join(EXT_SRC, 'providers', 'claude', 'claude-provider-adapter.ts'))).toBe(true);
    expect(existsSync(join(EXT_SRC, 'content', 'claude-bridge.ts'))).toBe(true);
    expect(existsSync(join(EXT_ROOT, 'tests', 'claude', 'fixture', 'code.html'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(EXT_ROOT, 'public', 'manifest.json'), 'utf8'),
    ) as { content_scripts: { js: string[]; matches: string[] }[] };
    const claudeBridge = manifest.content_scripts.find((cs) =>
      cs.js.some((j) => j.includes('claude-bridge')),
    );
    expect(claudeBridge, 'claude-bridge registered').toBeTruthy();
    // PR #34: the claude bridge runs on BOTH the canonical current host
    // (claude.com) AND the legacy/redirect host (claude.ai) — claude.ai
    // redirects to claude.com so the bridge must attach before AND after.
    expect(claudeBridge!.matches).toContain('https://*.claude.com/*');
    expect(claudeBridge!.matches).toContain('https://*.claude.ai/*');
    // The claude bridge does NOT run on other providers.
    expect(claudeBridge!.matches.join(' ')).not.toMatch(/z\.ai|chatgpt/);
  });

  // -------------------------------------------------------------------------
  // PR #34 review: claude.ai → claude.com redirect — the detector, manifest,
  // AND adapter MUST all agree on the supported Claude Code hosts. Without
  // the canonical claude.com host grant, the extension could pass local
  // fixtures while failing in the real browser after the redirect because
  // the Claude content script would have no permission to run on the
  // canonical host.
  // -------------------------------------------------------------------------

  it('PR #34 fix: detector recognizes BOTH Claude hosts (claude.com canonical + claude.ai legacy/redirect)', () => {
    const detector = readFileSync(join(EXT_SRC, 'providers', 'detector.ts'), 'utf8');
    // Both domains are listed (canonical current + legacy/redirect).
    expect(detector).toMatch(/providerId: 'claude', domain: 'claude\.com'/);
    expect(detector).toMatch(/providerId: 'claude', domain: 'claude\.ai'/);
    // Claude is the only provider with multiple recognized domains — no
    // accidental duplicate of z.ai or chatgpt.com.
    const zaiMatches = [...detector.matchAll(/providerId: 'zai', domain: '([a-z.]+)'/g)];
    expect(zaiMatches.length, 'z.ai has exactly one domain entry').toBe(1);
    const chatgptMatches = [...detector.matchAll(/providerId: 'chatgpt', domain: '([a-z.]+)'/g)];
    expect(chatgptMatches.length, 'chatgpt has exactly one domain entry').toBe(1);
    const claudeMatches = [...detector.matchAll(/providerId: 'claude', domain: '([a-z.]+)'/g)];
    expect(claudeMatches.map((m) => m[1]!).sort()).toEqual(['claude.ai', 'claude.com']);
  });

  it('PR #34 fix: manifest grants host permissions to BOTH Claude hosts AND matches the detector', () => {
    const manifest = JSON.parse(
      readFileSync(join(EXT_ROOT, 'public', 'manifest.json'), 'utf8'),
    ) as {
      host_permissions: string[];
      content_scripts: { matches: string[]; js: string[] }[];
    };
    // The manifest MUST grant host permissions to BOTH Claude hosts.
    expect(manifest.host_permissions).toContain('https://*.claude.com/*');
    expect(manifest.host_permissions).toContain('https://*.claude.ai/*');
    // The apex-only form (the PR #34 finding) must NOT be the Claude grant.
    expect(manifest.host_permissions).not.toContain('https://claude.com/*');
    expect(manifest.host_permissions).not.toContain('https://claude.ai/*');

    /**
     * Chrome host-pattern matcher (subset sufficient for these patterns):
     * `https://*.domain/*` covers the domain itself AND any subdomain
     * (exactly mirroring the detector's hostname === domain ||
     * hostname.endsWith('.' + domain) recognition).
     */
    function covers(pattern: string, url: URL): boolean {
      const m = pattern.match(/^(\*|https?):\/\/([^/]+)\//);
      if (!m || !m[1] || !m[2]) return false;
      if (m[1] !== '*' && url.protocol.replace(':', '') !== m[1]) return false;
      const host = url.hostname.toLowerCase();
      if (m[2].startsWith('*.')) {
        const base = m[2].slice(2).toLowerCase();
        return host === base || host.endsWith('.' + base);
      }
      return host === m[2].toLowerCase();
    }

    // The canonical current Claude Code entry point — claude.com/code —
    // must be covered by BOTH host_permissions AND provider-detect matches.
    // This is the PR #34 finding: detector-only recognition of claude.ai is
    // insufficient because the content script cannot run on claude.com
    // (where the prompt actually lands after the redirect) without the host
    // permission.
    const canonicalCodeUrl = new URL('https://claude.com/code');
    expect(
      manifest.host_permissions.some((p) => covers(p, canonicalCodeUrl)),
      'host_permissions must cover https://claude.com/code (canonical Claude Code entry)',
    ).toBe(true);
    const providerDetectMatches =
      manifest.content_scripts.find((cs) => cs.js.some((j) => j.includes('provider-detect')))
        ?.matches ?? [];
    expect(
      providerDetectMatches.some((p) => covers(p, canonicalCodeUrl)),
      'provider-detect content-script matches must cover https://claude.com/code',
    ).toBe(true);

    // The claude-bridge content-script matches MUST cover BOTH hosts (the
    // bridge attaches before AND after the redirect).
    const claudeBridge = manifest.content_scripts.find((cs) =>
      cs.js.some((j) => j.includes('claude-bridge')),
    )!;
    expect(
      claudeBridge.matches.some((p) => covers(p, canonicalCodeUrl)),
      'claude-bridge matches must cover https://claude.com/code',
    ).toBe(true);
    const legacyCodeUrl = new URL('https://claude.ai/code');
    expect(
      claudeBridge.matches.some((p) => covers(p, legacyCodeUrl)),
      'claude-bridge matches must cover https://claude.ai/code (legacy/redirect host)',
    ).toBe(true);

    // Detector ↔ manifest consistency: every Claude domain the detector
    // recognizes (apex + subdomains) must be covered by the manifest on
    // BOTH host_permissions AND the claude-bridge matches AND
    // provider-detect matches.
    for (const domain of ['claude.com', 'claude.ai']) {
      for (const host of [domain, `app.${domain}`]) {
        const url = new URL(`https://${host}/code`);
        expect(
          manifest.host_permissions.some((p) => covers(p, url)),
          `host_permissions must cover https://${host}/code`,
        ).toBe(true);
        expect(
          claudeBridge.matches.some((p) => covers(p, url)),
          `claude-bridge matches must cover https://${host}/code`,
        ).toBe(true);
        expect(
          providerDetectMatches.some((p) => covers(p, url)),
          `provider-detect matches must cover https://${host}/code`,
        ).toBe(true);
      }
    }
  });

  it('PR #34 fix: the Claude adapter accepts BOTH hosts via matchesPage AND targets the canonical claude.com/code', () => {
    const adapter = readFileSync(join(EXT_SRC, 'providers', 'claude', 'claude-provider-adapter.ts'), 'utf8');
    // Canonical production origin is the canonical current host claude.com.
    expect(adapter).toMatch(/const CLAUDE_ORIGIN = 'https:\/\/claude\.com'/);
    // matchesPage accepts BOTH claude.com (canonical) AND claude.ai (legacy).
    expect(adapter).toMatch(/claude\.com/);
    expect(adapter).toMatch(/claude\.ai/);
    // openTask targets the canonical host's coding surface.
    expect(adapter).toContain('`${claudeOrigin}/code`');
    // The legacy host must NOT be the canonical origin (the PR #34 finding
    // — targeting claude.ai/code would trigger a redirect where the content
    // script may not have permission on the post-redirect canonical host).
    expect(adapter).not.toMatch(/const CLAUDE_ORIGIN = 'https:\/\/claude\.ai'/);
  });

  it('PR #34 fix: surface detection is host-agnostic (path-only) — works on both claude.com and claude.ai', () => {
    // The page-runtime detectSurface() must read ONLY location.pathname so
    // the same detection works on claude.com (canonical current host) AND
    // claude.ai (legacy/redirect host) — the redirect does not change the
    // conversation path.
    const runtime = readFileSync(join(EXT_SRC, 'providers', 'claude', 'claude-page-runtime.ts'), 'utf8');
    expect(runtime).toMatch(/export function detectSurface\(\): DetectedSurface/);
    expect(runtime).toMatch(/const path = location\.pathname;/);
    // The detection must NOT consult location.host or location.hostname
    // (host changes during redirect; path does not).
    const detectFnMatch = runtime.match(/export function detectSurface\(\)[\s\S]*?^}/m);
    expect(detectFnMatch, 'detectSurface function body found').toBeTruthy();
    const detectBody = detectFnMatch![0]!;
    expect(detectBody, 'detectSurface must not read location.host').not.toMatch(/location\.host\b/);
    expect(detectBody, 'detectSurface must not read location.hostname').not.toMatch(/location\.hostname/);
    expect(detectBody, 'detectSurface must not read location.origin').not.toMatch(/location\.origin/);
    expect(detectBody, 'detectSurface must not read location.href').not.toMatch(/location\.href/);
  });
});

// ===========================================================================
// PRODUCTION READINESS invariants.
//
// Static checks that verify the production composition is complete:
//   - index.ts wires every route group that buildServer() supports;
//   - app.ts constructs the full service stack (not just the test subset);
//   - CORS support is present;
//   - no production role defaults to fake providers (checked at runtime);
//   - production code does not depend on pglite/in-memory implementations
//     for authoritative state;
//   - frozen architecture files remain untouched.
// ===========================================================================

describe('PRODUCTION READINESS invariants', () => {
  const REPO_ROOT = join(BACKEND_ROOT, '..');

  // --- Production route wiring audit ---

  it('production index.ts wires every route group that buildServer() supports', () => {
    // Extract the route groups from server.ts (the `if (deps.X && deps.Y)` blocks).
    const serverSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'server.ts'), 'utf8');
    const routeGroups = new Set<string>();
    for (const m of serverSrc.matchAll(/deps\.(\w+)\s*&&/g)) {
      routeGroups.add(m[1]!);
    }
    // Also check the `await XRoutes(app, deps.Y)` registrations.
    for (const m of serverSrc.matchAll(/await\s+\w+Routes\(app,\s*deps\.(\w+)\)/g)) {
      routeGroups.add(m[1]!);
    }

    // The index.ts must reference each of these route groups.
    const indexSrc = readFileSync(join(BACKEND_ROOT, 'src', 'index.ts'), 'utf8');

    // Required route groups (excluding 'health' which is always wired + 'jobs'
    // which is part of ServerDeps directly).
    const REQUIRED_GROUPS = [
      'auth',
      'projects',
      'specifications',
      'architecture',
      'workItems',
      'requirements',
      'workflow',
      'agents',
      'verification',
      'reviews',
      'llm',
      'architect',
      'githubWebhook',
      'audit',
      'notifications',
      'health',
    ];

    const missing: string[] = [];
    for (const group of REQUIRED_GROUPS) {
      if (!indexSrc.includes(group)) {
        missing.push(group);
      }
    }
    expect(missing, `index.ts is missing route group wiring: ${missing.join(', ')}`).toEqual([]);
  });

  it('app.ts constructs the full service stack (orchestrator, agentGateway, llmGateway, architectService, verificationService, reviewService, webhookProcessing)', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    const REQUIRED_SERVICES = [
      'DefaultWorkflowOrchestrator',
      'DefaultAgentGateway',
      'DefaultLlmGateway',
      'DefaultArchitectService',
      'DefaultVerificationService',
      'DefaultReviewService',
      'DefaultWebhookProcessingService',
      'DefaultCiEvidenceIngestionService',
    ];
    const missing: string[] = [];
    for (const svc of REQUIRED_SERVICES) {
      if (!appSrc.includes(svc)) {
        missing.push(svc);
      }
    }
    expect(missing, `app.ts is missing service construction: ${missing.join(', ')}`).toEqual([]);
  });

  it('CORS support is present in server.ts', () => {
    const serverSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'server.ts'), 'utf8');
    expect(serverSrc).toMatch(/corsOrigin/);
    expect(serverSrc).toMatch(/Access-Control-Allow-Origin/);
  });

  it('config.ts includes CORS + GitHub webhook secret ref configuration', () => {
    const configSrc = readFileSync(join(BACKEND_ROOT, 'src', 'config.ts'), 'utf8');
    expect(configSrc).toMatch(/corsOrigin/);
    expect(configSrc).toMatch(/githubWebhookSecretRef/);
  });

  it('production deployment documentation exists', () => {
    const docPath = join(REPO_ROOT, 'docs', 'deployment', 'production.md');
    expect(existsSync(docPath), 'docs/deployment/production.md not found').toBe(true);
    const src = readFileSync(docPath, 'utf8');
    expect(src).toMatch(/Neon/i);
    expect(src).toMatch(/Railway/i);
    expect(src).toMatch(/R2|Cloudflare/i);
    expect(src).toMatch(/GitHub App/i);
    expect(src).toMatch(/Vercel/i);
    expect(src).toMatch(/CORS/i);
  });

  it('bootstrap script exists', () => {
    const scriptPath = join(REPO_ROOT, 'scripts', 'bootstrap-production.ts');
    expect(existsSync(scriptPath), 'scripts/bootstrap-production.ts not found').toBe(true);
  });
});

// ============================================================================
// WORK-032 — Native vs External Execution Benchmark architecture checks (§34)
// ============================================================================
// The benchmark domain lives at src/benchmark/ (application-layer orchestrator
// OUTSIDE src/modules/). It CONSUMES the 17 frozen domain modules via their
// public barrels. It does NOT create another workflow/verification/review/CI
// engine. These checks prove the boundary is intact.
// ============================================================================

describe('WORK-032 — benchmark architecture checks (§34)', () => {
  const BENCHMARK_DIR = join(BACKEND_ROOT, 'src', 'benchmark');
  const BENCHMARK_INTERNAL = join(BENCHMARK_DIR, 'internal');

  function readBenchmarkFiles(): { path: string; src: string }[] {
    if (!existsSync(BENCHMARK_DIR)) return [];
    const out: { path: string; src: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) {
          out.push({ path: full, src: readFileSync(full, 'utf8') });
        }
      }
    };
    walk(BENCHMARK_DIR);
    return out;
  }

  it('benchmark domain exists at src/benchmark/ (outside src/modules/)', () => {
    expect(existsSync(BENCHMARK_DIR), 'src/benchmark/ must exist').toBe(true);
    expect(existsSync(join(BENCHMARK_DIR, 'index.ts')), 'src/benchmark/index.ts must exist').toBe(true);
    expect(existsSync(join(BENCHMARK_DIR, 'types.ts')), 'src/benchmark/types.ts must exist').toBe(true);
    expect(existsSync(BENCHMARK_INTERNAL), 'src/benchmark/internal/ must exist').toBe(true);
  });

  it('benchmark does not create another workflow engine (no wfos_workflow_executions INSERT)', () => {
    const files = readBenchmarkFiles();
    const violations: string[] = [];
    for (const f of files) {
      if (/INSERT\s+INTO\s+wfos_workflow_executions/i.test(f.src)) {
        violations.push(`${f.path}: INSERT INTO wfos_workflow_executions`);
      }
      if (/INSERT\s+INTO\s+wfos_workflow_transitions/i.test(f.src)) {
        violations.push(`${f.path}: INSERT INTO wfos_workflow_transitions`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('benchmark does not create another verification engine (no wfos_verification_runs INSERT)', () => {
    const files = readBenchmarkFiles();
    const violations: string[] = [];
    for (const f of files) {
      if (/INSERT\s+INTO\s+wfos_verification_runs/i.test(f.src)) {
        violations.push(`${f.path}: INSERT INTO wfos_verification_runs`);
      }
      if (/INSERT\s+INTO\s+wfos_evidence/i.test(f.src)) {
        violations.push(`${f.path}: INSERT INTO wfos_evidence`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('benchmark does not create another review engine (no wfos_reviews INSERT)', () => {
    const files = readBenchmarkFiles();
    const violations: string[] = [];
    for (const f of files) {
      if (/INSERT\s+INTO\s+wfos_reviews/i.test(f.src)) {
        violations.push(`${f.path}: INSERT INTO wfos_reviews`);
      }
      if (/INSERT\s+INTO\s+wfos_review_findings/i.test(f.src)) {
        violations.push(`${f.path}: INSERT INTO wfos_review_findings (authoritative /reviews table)`);
      }
    }
    // NOTE: wfos_benchmark_review_findings is a benchmark-scoped projection
    // table (denormalized from /reviews for comparison views). It is NOT the
    // authoritative /reviews findings table. The check above only flags the
    // authoritative wfos_review_findings table.
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('benchmark does not calculate authoritative workflow state (reads workflowEngine.getState/getHistory only)', () => {
    const files = readBenchmarkFiles();
    const violations: string[] = [];
    for (const f of files) {
      // The benchmark may call workflowEngine.getOrCreate + transition for
      // trial initialization (draft → ready) but must NOT call the workflow
      // ORCHESTRATOR (the authority that drives pr_open → verifying →
      // approved → merged → verified).
      if (/orchestrator\./i.test(f.src) && !/benchmark/i.test(f.path)) {
        // skip — this is just the word "orchestrator" in a non-benchmark file
      }
    }
    // The benchmark trial orchestrator IS allowed to call workflowEngine.getOrCreate
    // + transition({toState:'ready'}) to initialize a cloned work item. But it
    // must NOT call transition({toState:'merged'|'verified'}) — those are the
    // /workflows orchestrator's authority.
    for (const f of files) {
      if (/toState:\s*['"]merged['"]/.test(f.src) || /toState:\s*['"]verified['"]/.test(f.src)) {
        violations.push(`${f.path}: transition to merged/verified (forbidden — /workflows authority)`);
      }
      if (/toState:\s*['"]approved['"]/.test(f.src)) {
        violations.push(`${f.path}: transition to approved (forbidden — /workflows authority)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('benchmark does not mutate MERGED / VERIFIED (no transition WRITE to those states)', () => {
    const files = readBenchmarkFiles();
    const violations: string[] = [];
    for (const f of files) {
      // Only flag WRITE calls: transition({ toState: 'merged'|'verified' }).
      // Reads (firstTransitionTo('merged'), h.toState) are allowed — the
      // metric collector reads workflow history to compute time-to-VERIFIED.
      if (/toState:\s*['"]merged['"]/.test(f.src)) {
        violations.push(`${f.path}: transition WRITE to 'merged' (forbidden — /workflows authority)`);
      }
      if (/toState:\s*['"]verified['"]/.test(f.src)) {
        violations.push(`${f.path}: transition WRITE to 'verified' (forbidden — /workflows authority)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('benchmark uses ExecutionService (delegates execution, no second engine)', () => {
    const files = readBenchmarkFiles();
    const hasExecutionServiceImport = files.some((f) =>
      f.src.includes('ExecutionService') && f.src.includes('@modules/agents'),
    );
    expect(hasExecutionServiceImport, 'benchmark must import ExecutionService from @modules/agents').toBe(true);
    // The trial orchestrator must call executionService.submit
    const orchestratorSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-trial-orchestrator.ts'), 'utf8');
    expect(orchestratorSrc).toMatch(/executionService\.submit/);
  });

  it('benchmark uses existing GitHub authority (GitHubAdapter + ProjectGitHubRepositoryRepository)', () => {
    const files = readBenchmarkFiles();
    const hasGithubImport = files.some((f) =>
      f.src.includes('GitHubAdapter') && f.src.includes('@modules/github'),
    );
    expect(hasGithubImport, 'benchmark must import GitHubAdapter from @modules/github').toBe(true);
  });

  it('benchmark uses existing Verification authority (VerificationService)', () => {
    const files = readBenchmarkFiles();
    const hasVerificationImport = files.some((f) =>
      f.src.includes('VerificationService') && f.src.includes('@modules/verification'),
    );
    expect(hasVerificationImport, 'benchmark must import VerificationService from @modules/verification').toBe(true);
    // The metric collector must call verificationService.listRunsForWorkItem
    const collectorSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-metric-collector.ts'), 'utf8');
    expect(collectorSrc).toMatch(/verificationService\.listRunsForWorkItem/);
  });

  it('benchmark uses existing Review authority (ReviewService)', () => {
    const files = readBenchmarkFiles();
    const hasReviewImport = files.some((f) =>
      f.src.includes('ReviewService') && f.src.includes('@modules/reviews'),
    );
    expect(hasReviewImport, 'benchmark must import ReviewService from @modules/reviews').toBe(true);
    const collectorSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-metric-collector.ts'), 'utf8');
    expect(collectorSrc).toMatch(/reviewService\.listReviewsForWorkItem/);
    expect(collectorSrc).toMatch(/reviewService\.listFindingsForReview/);
  });

  it('benchmark stores promptDigest (§27 equality key)', () => {
    const migrationSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0025_benchmark.sql'),
      'utf8',
    );
    expect(migrationSrc).toMatch(/prompt_digest/);
    // The trial table copies promptDigest from the snapshot.
    expect(migrationSrc).toMatch(/wfos_benchmark_trials/);
    // The snapshot table stores the canonical promptDigest.
    expect(migrationSrc).toMatch(/wfos_benchmark_task_snapshots.*prompt_digest/s);
  });

  it('benchmark requires baseline commit identity (§28 — NOT NULL base_commit)', () => {
    const migrationSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0025_benchmark.sql'),
      'utf8',
    );
    expect(migrationSrc).toMatch(/base_commit\s+TEXT\s+NOT\s+NULL/);
    // Trial table also has baseline_commit NOT NULL (copied from snapshot).
    expect(migrationSrc).toMatch(/baseline_commit\s+TEXT\s+NOT\s+NULL/);
  });

  it('benchmark trials are isolated (§6 — per-trial branch + cloned work item)', () => {
    const migrationSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0025_benchmark.sql'),
      'utf8',
    );
    // Each trial has its own trial_branch.
    expect(migrationSrc).toMatch(/trial_branch\s+TEXT\s+NOT\s+NULL/);
    // Each trial has its own work_item_id (the cloned work item).
    expect(migrationSrc).toMatch(/work_item_id\s+UUID\s+REFERENCES\s+wfos_work_items/);
    // Unique cell: (experiment, provider, mode, repetition) — no duplicate trials.
    expect(migrationSrc).toMatch(/UNIQUE\s*\(experiment_id,\s*provider,\s*execution_mode,\s*repetition_index\)/);
  });

  it('benchmark never stores credentials (§33 — no secret/token/key/cookie columns)', () => {
    const migrationSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0025_benchmark.sql'),
      'utf8',
    );
    // No column name may match the credential pattern. The external_session_ref
    // is an opaque provider-side reference (NOT a credential — the user's own
    // browser session already holds it; it is not an auth token).
    const violations: string[] = [];
    const lines = migrationSrc.split('\n');
    for (const line of lines) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith('--')) continue; // comment line
      if (/(?:secret|password|api_key|apikey|credential|private_key|cookie|access_token|refresh_token|callback_token|handoff_token)\b/.test(trimmed)) {
        // external_session_ref is allowed (opaque reference, not a credential)
        if (trimmed.includes('external_session_ref') && !trimmed.includes('token')) continue;
        violations.push(`credential-like column: ${trimmed}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
    // Also check the benchmark source files for credential writes.
    const files = readBenchmarkFiles();
    const srcViolations: string[] = [];
    for (const f of files) {
      // The export service has a sanitizeMetrics that CHECKS for these patterns
      // (defense in depth) — that's allowed. The check is: no code writes a
      // value that IS a credential.
      if (/localStorage\.setItem.*api_?key/i.test(f.src)) {
        srcViolations.push(`${f.path}: localStorage API key write`);
      }
    }
    expect(srcViolations, srcViolations.join('\n')).toEqual([]);
  });

  it('benchmark snapshot is immutable (§4 — DB trigger rejects UPDATE/DELETE)', () => {
    const migrationSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0025_benchmark.sql'),
      'utf8',
    );
    expect(migrationSrc).toMatch(/wfos_reject_benchmark_snapshot_mutation/);
    expect(migrationSrc).toMatch(/BEFORE UPDATE OR DELETE ON wfos_benchmark_task_snapshots/);
  });

  it('benchmark audit events use BENCHMARK_/TRIAL_ prefixes (§47 — do not duplicate workflow transition events)', () => {
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    // The benchmark emits its own audit event types — never WORKFLOW_TRANSITION.
    expect(serviceSrc).toMatch(/BENCHMARK_CREATED/);
    expect(serviceSrc).toMatch(/BENCHMARK_STARTED/);
    expect(serviceSrc).toMatch(/BENCHMARK_COMPLETED/);
    expect(serviceSrc).toMatch(/TRIAL_COMPLETED|TRIAL_FAILED/);
    // Must NOT emit WORKFLOW_TRANSITION (that's /workflows' authority).
    expect(serviceSrc).not.toMatch(/eventType:\s*['"]WORKFLOW_TRANSITION['"]/);
  });

  it('benchmark imports only @modules/* public barrels + @platform/* (never internal/)', () => {
    const files = readBenchmarkFiles();
    const violations: string[] = [];
    for (const f of files) {
      const importSpecifiers = f.src.match(/from\s+['"]([^'"]+)['"]/g) ?? [];
      for (const spec of importSpecifiers) {
        const path = spec.replace(/from\s+['"]/, '').replace(/['"]$/, '');
        if (path.includes('@modules/') && path.includes('/internal/')) {
          violations.push(`${f.path}: imports ${path} (forbidden — must use public barrel)`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('benchmark route is wired in server.ts + index.ts', () => {
    const serverSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'server.ts'), 'utf8');
    expect(serverSrc).toMatch(/benchmarkRoutes/);
    expect(serverSrc).toMatch(/BenchmarkRouteDeps/);
    const indexSrc = readFileSync(join(BACKEND_ROOT, 'src', 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/benchmark:/);
  });

  it('benchmark service is constructed in app.ts', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc).toMatch(/DefaultBenchmarkService/);
    expect(appSrc).toMatch(/PgBenchmarkRepository/);
    expect(appSrc).toMatch(/benchmarkService/);
  });

  it('benchmark migration 0025 exists + db.reset truncates benchmark tables', () => {
    expect(existsSync(join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0025_benchmark.sql'))).toBe(true);
    const testDbSrc = readFileSync(join(BACKEND_ROOT, 'tests', 'helpers', 'test-database.ts'), 'utf8');
    expect(testDbSrc).toMatch(/TRUNCATE wfos_benchmark_task_snapshots/);
    expect(testDbSrc).toMatch(/TRUNCATE wfos_benchmark_experiments/);
    expect(testDbSrc).toMatch(/TRUNCATE wfos_benchmark_trials/);
    expect(testDbSrc).toMatch(/TRUNCATE wfos_benchmark_trial_metrics/);
    expect(testDbSrc).toMatch(/TRUNCATE wfos_benchmark_review_findings/);
    expect(testDbSrc).toMatch(/TRUNCATE wfos_benchmark_integrity/);
  });

  it('frontend has no direct provider API access (§34 — no fetch to z.ai/openai/anthropic URLs)', () => {
    const FRONTEND_ROOT = join(BACKEND_ROOT, '..', '..', 'frontend');
    if (!existsSync(FRONTEND_ROOT)) return; // skip if frontend not present
    const violations: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          const src = readFileSync(full, 'utf8');
          if (/https?:\/\/[^'"]*(?:api\.openai|api\.anthropic|chat\.z\.ai|chatgpt\.com|claude\.(?:ai|com))/i.test(src)) {
            violations.push(`${full}: direct provider API URL`);
          }
        }
      }
    };
    walk(join(FRONTEND_ROOT, 'src'));
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // ==========================================================================
  // PR #35 follow-up (idempotency): the benchmark trial lifecycle MUST be
  // exactly-once under duplicate job delivery + concurrent workers. The
  // claim (queued→running) + finalization (running→terminal) transitions
  // are atomic compare-and-swap on the persisted `lifecycle_phase` column.
  // A duplicate delivery that loses the claim observes null + NO-OPS (never
  // reruns orchestration / refinalizes). These static checks enforce the
  // invariant at the source level so a future regression cannot silently
  // reintroduce the unconditional `UPDATE ... WHERE id=$1` pattern.
  // ==========================================================================

  it('benchmark trial lifecycle migration 0027 exists (lifecycle_phase column)', () => {
    const migrationPath = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0027_benchmark_trial_lifecycle_phase.sql');
    expect(existsSync(migrationPath), '0027_benchmark_trial_lifecycle_phase.sql must exist').toBe(true);
    const src = readFileSync(migrationPath, 'utf8');
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS lifecycle_phase/);
    expect(src).toMatch(/CHECK \(lifecycle_phase IN/);
    // The explicit phase set: queued → starting → execution_wait →
    // delivery_wait → completed | failed.
    expect(src).toMatch(/'queued'/);
    expect(src).toMatch(/'starting'/);
    expect(src).toMatch(/'execution_wait'/);
    expect(src).toMatch(/'delivery_wait'/);
    expect(src).toMatch(/'completed'/);
    expect(src).toMatch(/'failed'/);
  });

  it('benchmark migration 0027 MECHANICALLY ENFORCES the status↔lifecycle_phase invariant (NOT a dual-state model)', () => {
    // The review explicitly warned: "The dual-state model is dangerous unless
    // there is a mechanically enforced invariant between the two." Application-
    // layer sync alone is insufficient — a future raw UPDATE touching only one
    // column could silently introduce a divergent row (e.g.
    // status='running', lifecycle_phase='completed') that the concurrency
    // model does not know how to route. The DB itself MUST reject such rows.
    const migrationPath = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0027_benchmark_trial_lifecycle_phase.sql');
    const src = readFileSync(migrationPath, 'utf8');
    // The CHECK constraint exists + is named (so a grep can find it + so
    // drop/replace is explicit).
    expect(src).toMatch(/wfos_benchmark_trials_status_phase_invariant/);
    expect(src).toMatch(/ADD CONSTRAINT wfos_benchmark_trials_status_phase_invariant/);
    expect(src).toMatch(/CHECK \(/);
    // The 6 canonical pairs the review specified. Every allowed (phase,
    // status) combination must appear so the constraint is total — a row
    // with any other pairing is physically rejected.
    expect(src).toMatch(/lifecycle_phase = 'queued'\s+AND status = 'queued'/);
    expect(src).toMatch(/lifecycle_phase = 'starting'\s+AND status = 'running'/);
    expect(src).toMatch(/lifecycle_phase = 'execution_wait'\s+AND status = 'running'/);
    expect(src).toMatch(/lifecycle_phase = 'delivery_wait'\s+AND status = 'running'/);
    expect(src).toMatch(/lifecycle_phase = 'completed'\s+AND status = 'completed'/);
    expect(src).toMatch(/lifecycle_phase = 'failed'\s+AND status IN \('failed','unavailable'\)/);
    // CRITICAL ORDERING: the CHECK constraint MUST be added AFTER the
    // backfill UPDATEs. Otherwise the ADD would reject the pre-backfill
    // divergent rows (status='running' with the default lifecycle_phase=
    // 'queued'). Verify the constraint text appears after the last backfill
    // UPDATE for 'unavailable' → 'failed'.
    const backfillIdx = src.indexOf("status IN ('failed', 'unavailable') AND lifecycle_phase = 'queued'");
    const constraintIdx = src.indexOf('ADD CONSTRAINT wfos_benchmark_trials_status_phase_invariant');
    expect(backfillIdx, 'unavailable backfill UPDATE must be present').toBeGreaterThan(-1);
    expect(constraintIdx, 'invariant CHECK constraint must be present').toBeGreaterThan(-1);
    expect(constraintIdx, 'invariant CHECK must come AFTER the backfill (else ADD rejects pre-backfill rows)').toBeGreaterThan(backfillIdx);
  });

  it('benchmark trial claim is ATOMIC (claimTrialForSetup: queued→starting compare-and-swap)', () => {
    // The orchestrator's runTrial MUST claim via claimTrialForSetup (atomic
    // WHERE lifecycle_phase='queued' RETURNING *), NOT via an unconditional
    // updateTrial. A lost claim returns null + the orchestrator MUST NO-OP
    // (no clone / branch / submit).
    const orchestratorSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-trial-orchestrator.ts'), 'utf8');
    expect(orchestratorSrc).toMatch(/claimTrialForSetup/);
    expect(orchestratorSrc).toMatch(/claim-lost/);
    // The orchestrator must NOT use an unconditional updateTrial for the
    // initial claim (the old `UPDATE ... SET status='running' WHERE id=$1`
    // pattern that caused the claim race).
    expect(orchestratorSrc).not.toMatch(/updateTrial\(trial\.id,\s*\{\s*status:\s*'running'/);

    // The repository's claimTrialForSetup MUST guard on lifecycle_phase='queued'.
    const repoSrc = readFileSync(join(BENCHMARK_INTERNAL, 'pg-benchmark-repository.ts'), 'utf8');
    expect(repoSrc).toMatch(/claimTrialForSetup/);
    // The atomic compare-and-swap: WHERE id=$1 AND lifecycle_phase='queued'.
    const claimFn = repoSrc.match(/async claimTrialForSetup[\s\S]*?RETURNING \*/);
    expect(claimFn, 'claimTrialForSetup must exist + use RETURNING *').not.toBeNull();
    expect(claimFn![0]).toMatch(/WHERE id = \$1 AND lifecycle_phase = 'queued'/);
    expect(claimFn![0]).toMatch(/lifecycle_phase = 'starting'/);
  });

  it('benchmark trial finalization is ATOMIC (claimTerminal: execution_wait|delivery_wait→completed|failed compare-and-swap)', () => {
    // The service's finalizeTrial MUST use claimTerminal (atomic
    // WHERE lifecycle_phase=$fromPhase RETURNING *). A lost claim returns
    // null + the service MUST skip metrics / findings / audit (exactly-once
    // side effects).
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    expect(serviceSrc).toMatch(/claimTerminal/);
    expect(serviceSrc).toMatch(/finalize-lost-race/);
    // finalizeTrial must NOT use an unconditional updateTrial for the
    // terminal transition (the old pattern that caused the finalize race).
    expect(serviceSrc).not.toMatch(/updateTrial\(trial\.id,\s*\{\s*status:\s*'completed'/);
    expect(serviceSrc).not.toMatch(/updateTrial\(trial\.id,\s*\{\s*status:\s*'failed'/);

    // The repository's claimTerminal MUST guard on lifecycle_phase=$fromPhase.
    const repoSrc = readFileSync(join(BENCHMARK_INTERNAL, 'pg-benchmark-repository.ts'), 'utf8');
    const claimFn = repoSrc.match(/async claimTerminal[\s\S]*?RETURNING \*/);
    expect(claimFn, 'claimTerminal must exist + use RETURNING *').not.toBeNull();
    expect(claimFn![0]).toMatch(/WHERE id = \$1 AND lifecycle_phase = \$2/);
  });

  it('benchmark experiment completion is a TWO-PHASE protocol (reservation running→finalizing, then finalization after integrity, fenced on generation)', () => {
    // PR #36 review fix #2 + #4: `claimExperimentCompletion` MUST be a
    // RESERVATION (running → finalizing), NOT a direct completion.
    // `completed` must become authoritative ONLY via
    // `finalizeExperimentCompletion`, called AFTER integrity validation
    // passes. This closes the false-completion race the reviewer found
    // (the prior version flipped the experiment to `completed` before
    // validation ran). The finalization CAS MUST also be FENCED on the
    // `finalizing_generation` (PR #36 review fix #4) so a stale worker
    // holding an OLDER generation cannot finalize after a newer worker
    // reclaimed + advanced the generation.
    const repoSrc = readFileSync(join(BENCHMARK_INTERNAL, 'pg-benchmark-repository.ts'), 'utf8');

    // Phase 1 — RESERVATION. claimExperimentCompletion MUST set
    // status='finalizing' (NOT 'completed') + guard on status='running'
    // + set the fencing generation (COALESCE(NULL, 0) + 1 to handle legacy
    // pre-0030 rows whose generation is NULL).
    const claimFn = repoSrc.match(/async claimExperimentCompletion[\s\S]*?RETURNING \*/);
    expect(claimFn, 'claimExperimentCompletion must exist + use RETURNING *').not.toBeNull();
    expect(claimFn![0]).toMatch(/WHERE id = \$1 AND status = 'running'/);
    expect(claimFn![0]).toMatch(/SET status = 'finalizing'/);
    expect(claimFn![0]).toMatch(/finalizing_generation = COALESCE\(finalizing_generation, 0\) \+ 1/);
    // The reservation MUST NOT set 'completed' (that is the finalization's
    // job, after integrity passes).
    expect(claimFn![0]).not.toMatch(/SET status = 'completed'/);
    // The reservation MUST NOT set completed_at (no terminal timestamp
    // until the finalization).
    expect(claimFn![0]).not.toMatch(/completed_at/);

    // Phase 3a — success finalization. finalizeExperimentCompletion MUST
    // guard on status='finalizing' + the fencing generation + set
    // status='completed'.
    const finalizeFn = repoSrc.match(/async finalizeExperimentCompletion[\s\S]*?RETURNING \*/);
    expect(finalizeFn, 'finalizeExperimentCompletion must exist + use RETURNING *').not.toBeNull();
    expect(finalizeFn![0]).toMatch(/WHERE id = \$1 AND status = 'finalizing' AND finalizing_generation = \$2/);
    expect(finalizeFn![0]).toMatch(/SET status = 'completed'/);

    // Phase 3b — failure finalization. finalizeExperimentInvalidation MUST
    // guard on status='finalizing' + the fencing generation + set
    // status='invalidated'.
    const invalidateFn = repoSrc.match(/async finalizeExperimentInvalidation[\s\S]*?RETURNING \*/);
    expect(invalidateFn, 'finalizeExperimentInvalidation must exist + use RETURNING *').not.toBeNull();
    expect(invalidateFn![0]).toMatch(/WHERE id = \$1 AND status = 'finalizing' AND finalizing_generation = \$2/);
    expect(invalidateFn![0]).toMatch(/SET status = 'invalidated'/);
  });

  it('benchmark checkExperimentCompletion ORDERING: reservation → integrity validation → finalization → audit (NOT completed-then-validate)', () => {
    // PR #36 review fix #2: the integrity validation MUST run BETWEEN the
    // reservation + the finalization. The audit MUST run AFTER the
    // finalization (so BENCHMARK_COMPLETED is only written when the
    // experiment actually reached `completed`, + BENCHMARK_INVALIDATED is
    // written on the failure path). This is the ordering the reviewer
    // required: "the claim must occur before any of those side effects"
    // (the reservation claims before validation; the finalization claims
    // before the audit).
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    // Match the full method body up to its closing brace at 2-space indent.
    const fn = serviceSrc.match(/private async checkExperimentCompletion[\s\S]*?\n  \}/);
    expect(fn, 'checkExperimentCompletion must exist').not.toBeNull();
    const body = fn![0];
    // Phase 1 — reservation is the FIRST CAS.
    const claimIdx = body.indexOf('claimExperimentCompletion');
    const validateIdx = body.indexOf('integrityService.validate');
    const finalizeIdx = body.indexOf('finalizeExperimentCompletion');
    const invalidateFinIdx = body.indexOf('finalizeExperimentInvalidation');
    const auditCompletedIdx = body.indexOf("'BENCHMARK_COMPLETED'");
    const auditInvalidatedIdx = body.indexOf("'BENCHMARK_INVALIDATED'");
    expect(claimIdx, 'must call claimExperimentCompletion').toBeGreaterThan(-1);
    expect(validateIdx, 'must call integrityService.validate').toBeGreaterThan(-1);
    expect(finalizeIdx, 'must call finalizeExperimentCompletion').toBeGreaterThan(-1);
    expect(invalidateFinIdx, 'must call finalizeExperimentInvalidation').toBeGreaterThan(-1);
    expect(auditCompletedIdx, 'must emit BENCHMARK_COMPLETED').toBeGreaterThan(-1);
    expect(auditInvalidatedIdx, 'must emit BENCHMARK_INVALIDATED').toBeGreaterThan(-1);
    // Ordering: reservation BEFORE validation BEFORE finalization BEFORE audit.
    expect(claimIdx).toBeLessThan(validateIdx);
    expect(validateIdx).toBeLessThan(finalizeIdx);
    expect(validateIdx).toBeLessThan(invalidateFinIdx);
    expect(finalizeIdx).toBeLessThan(auditCompletedIdx);
    expect(invalidateFinIdx).toBeLessThan(auditInvalidatedIdx);
    // The success-path audit (BENCHMARK_COMPLETED) must come AFTER the
    // success finalization; the failure-path audit (BENCHMARK_INVALIDATED)
    // must come AFTER the failure finalization.
    expect(finalizeIdx).toBeLessThan(auditCompletedIdx);
    expect(invalidateFinIdx).toBeLessThan(auditInvalidatedIdx);
    // A thrown validation error MUST be treated as a failure (caught +
    // valid=false), NOT propagated (which would leave the experiment stuck
    // in 'finalizing' with no audit — but at least not a false completion).
    expect(body).toMatch(/valid = false/);
  });

  it('benchmark migration 0028 adds the finalizing reservation status to the experiment CHECK (two-phase completion)', () => {
    const migrationPath = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0028_benchmark_experiment_completion_protocol.sql');
    expect(existsSync(migrationPath), '0028_benchmark_experiment_completion_protocol.sql must exist').toBe(true);
    const src = readFileSync(migrationPath, 'utf8');
    expect(src).toMatch(/DROP CONSTRAINT IF EXISTS wfos_benchmark_experiments_status_check/);
    expect(src).toMatch(/ADD CONSTRAINT wfos_benchmark_experiments_status_check/);
    // The new CHECK must include 'finalizing' (the reservation state) +
    // preserve all prior statuses.
    expect(src).toMatch(/'created'/);
    expect(src).toMatch(/'running'/);
    expect(src).toMatch(/'paused'/);
    expect(src).toMatch(/'finalizing'/);
    expect(src).toMatch(/'completed'/);
    expect(src).toMatch(/'cancelled'/);
    expect(src).toMatch(/'invalidated'/);
  });

  it('benchmark migration 0027 backfill splits running trials by execution_mode (native→delivery_wait, external→execution_wait)', () => {
    // PR #36 review fix #1: a native `running` trial is past execution
    // (native is synchronous-completed) + awaiting delivery, so it MUST
    // backfill to `delivery_wait`. An external `running` trial is awaiting
    // external execution completion, so it backfills to `execution_wait`.
    // The prior single backfill (all running → execution_wait)
    // misclassified native trials + would cause runTrialJob to re-read a
    // non-existent execution record + finalize them as
    // 'execution-record-not-found'.
    const migrationPath = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0027_benchmark_trial_lifecycle_phase.sql');
    const src = readFileSync(migrationPath, 'utf8');
    expect(src).toMatch(/execution_mode = 'native'\s+AND lifecycle_phase = 'queued'/);
    expect(src).toMatch(/lifecycle_phase = 'delivery_wait'/);
    expect(src).toMatch(/execution_mode = 'external'\s+AND lifecycle_phase = 'queued'/);
    expect(src).toMatch(/lifecycle_phase = 'execution_wait'/);
    // The native backfill MUST set delivery_wait (NOT execution_wait) +
    // pair it with execution_mode='native' in the same UPDATE statement.
    // Assert the full SET→WHERE line adjacency directly (capture-group
    // approaches cross UPDATE statements because [\s\S]*? spans them).
    expect(src).toMatch(/SET lifecycle_phase = 'delivery_wait'\s+WHERE status = 'running' AND execution_mode = 'native'/);
    // The external backfill MUST set execution_wait (NOT delivery_wait) +
    // pair it with execution_mode='external'.
    expect(src).toMatch(/SET lifecycle_phase = 'execution_wait'\s+WHERE status = 'running' AND execution_mode = 'external'/);
    // The native backfill MUST NOT pair delivery_wait with external, + the
    // external backfill MUST NOT pair execution_wait with native (the
    // misclassification the review found).
    expect(src).not.toMatch(/SET lifecycle_phase = 'delivery_wait'\s+WHERE status = 'running' AND execution_mode = 'external'/);
    expect(src).not.toMatch(/SET lifecycle_phase = 'execution_wait'\s+WHERE status = 'running' AND execution_mode = 'native'/);
  });

  it('benchmark trial runTrialJob routes by lifecycle_phase (NOT coarse status)', () => {
    // The state machine MUST route by the explicit persisted phase so a
    // duplicate delivery observes the already-advanced phase + no-ops. The
    // 'starting' phase is the critical guard: a redelivery arriving while
    // the orchestrator is mid-setup observes 'starting' + returns (it does
    // NOT read executionId=null + finalize the active trial as
    // 'execution-record-not-found').
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    expect(serviceSrc).toMatch(/trial\.lifecyclePhase/);
    expect(serviceSrc).toMatch(/phase === 'starting'/);
    expect(serviceSrc).toMatch(/phase === 'execution_wait'/);
    expect(serviceSrc).toMatch(/phase === 'delivery_wait'/);
    expect(serviceSrc).toMatch(/skipped-starting/);
    // The old coarse `trial.status === 'running'` routing (which caused the
    // mid-orchestration clobber race) must NOT be the primary router.
    expect(serviceSrc).not.toMatch(/if \(trial\.status === 'running'\)/);
  });

  it('benchmark trial idempotency regression tests exist', () => {
    // The duplicate-delivery + concurrent-worker regression tests MUST
    // exist (the review required them before any merge).
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'benchmark', 'trial-idempotency.regression.test.ts');
    expect(existsSync(testPath), 'trial-idempotency.regression.test.ts must exist').toBe(true);
    const src = readFileSync(testPath, 'utf8');
    expect(src).toMatch(/duplicate runTrialJob on a QUEUED trial claims exactly once/);
    expect(src).toMatch(/concurrent finalization on a DELIVERY_WAIT trial finalizes exactly once/);
    expect(src).toMatch(/claimTrialForSetup compare-and-swap: exactly one winner/);
    expect(src).toMatch(/mid-orchestration redelivery NO-OPS on the starting phase/);
    // PR #36 review fix #1: migration 0027 backfill mode-split regression.
    expect(src).toMatch(/migration 0027 backfill classifies native running/);
    // PR #36 review fix #2a: integrity failure MUST NOT expose a false
    // `completed` experiment.
    expect(src).toMatch(/integrity failure does NOT expose a false completed experiment/);
    // PR #36 review fix #2b: exactly-once finalization under concurrent
    // checkExperimentCompletion calls.
    expect(src).toMatch(/concurrent experiment completion finalizes exactly once/);
    // PR #36 review fix #3: lost `finalizing` worker recovery — both the
    // success path (recovered to `completed` + one BENCHMARK_COMPLETED)
    // + the integrity-failure path (recovered to `invalidated` + one
    // BENCHMARK_INVALIDATED). The reviewer required a regression test
    // proving a lost worker can be safely recovered to exactly one
    // terminal state and exactly one terminal audit event.
    expect(src).toMatch(/lost `finalizing` worker is recovered to exactly one terminal state \+ exactly one terminal audit \(success path\)/);
    expect(src).toMatch(/lost `finalizing` worker is recovered to exactly one terminal state \+ exactly one terminal audit \(integrity-failure path\)/);
    // PR #36 review fix #4 (fencing): the regression suite MUST prove BOTH
    // (a) the stale-worker fencing scenario (an old generation cannot
    // finalize after a newer worker reclaims + advances the generation)
    // AND (b) the normal active-lease non-preemption case (an active
    // worker is never preempted by concurrent recovery CAS calls). The
    // reviewer required both scenarios: "The regression suite needs to
    // prove exactly that scenario, plus the normal active-lease
    // non-preemption case."
    expect(src).toMatch(/stale worker holding an old generation CANNOT finalize after a newer worker reclaims the reservation \(fencing\)/);
    expect(src).toMatch(/active lease is NOT preempted by concurrent recovery CAS calls \(active-lease non-preemption\)/);
  });

  it('benchmark migration 0029 adds the persisted finalizing lease + stale-reservation index (crash-safe recovery)', () => {
    // PR #36 review fix #3: the two-phase completion protocol (migration
    // 0028) introduced a durable `running → finalizing` reservation, but
    // there was NO recovery path if the worker that won the reservation
    // DIED before finalizing — the experiment would be permanently stuck
    // in `finalizing` (claimExperimentCompletion only matches
    // WHERE status='running'; checkExperimentCompletion is only triggered
    // when a trial reaches terminal, but all trials were already
    // terminal). Migration 0029 fixes this by adding a persisted lease
    // (`finalizing_lease_expires_at`) that the recovery CAS reclaims when
    // it expires.
    const migrationPath = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0029_benchmark_experiment_finalizing_lease.sql');
    expect(existsSync(migrationPath), '0029_benchmark_experiment_finalizing_lease.sql must exist').toBe(true);
    const src = readFileSync(migrationPath, 'utf8');
    // The column MUST exist (nullable — only set when status='finalizing').
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS finalizing_lease_expires_at TIMESTAMPTZ/);
    // A partial index scoped to status='finalizing' for the stale-lease
    // sweep query (keeps the index small — finalizing is transient).
    expect(src).toMatch(/CREATE INDEX IF NOT EXISTS idx_benchmark_experiments_finalizing_stale/);
    expect(src).toMatch(/WHERE status = 'finalizing'/);
  });

  it('benchmark recoverStaleFinalizingExperiment is an atomic CAS guarded on status=finalizing + an expired lease (NOT running) + INCREMENTS the fencing generation', () => {
    // PR #36 review fix #3 + #4: the recovery CAS MUST (a) guard on
    // status='finalizing' (NOT 'running' — the fresh-claim path owns
    // 'running'), (b) guard on finalizing_lease_expires_at < NOW() (the
    // previous winner's lease has expired = the previous winner is
    // presumed dead — an active worker is never preempted mid-validation),
    // (c) RENEW the lease (set finalizing_lease_expires_at = NOW()+ttl) so
    // the recovering worker has exclusive ownership — if it also dies, the
    // renewed lease eventually expires and another recovery attempt can
    // claim it again (forward progress), (d) INCREMENT the fencing
    // generation (PR #36 review fix #4) so the stale worker (holding the
    // OLD generation) is FENCED — its finalization CAS rejects because the
    // row's finalizing_generation has advanced past the stale value, (e) use
    // RETURNING * so the winner proceeds to phase 2 (validation +
    // finalization) + the loser no-ops.
    const repoSrc = readFileSync(join(BENCHMARK_INTERNAL, 'pg-benchmark-repository.ts'), 'utf8');
    const fn = repoSrc.match(/async recoverStaleFinalizingExperiment[\s\S]*?RETURNING \*/);
    expect(fn, 'recoverStaleFinalizingExperiment must exist + use RETURNING *').not.toBeNull();
    // Guard on status='finalizing' (NOT 'running' — that is the fresh-claim path).
    expect(fn![0]).toMatch(/status = 'finalizing'/);
    expect(fn![0]).not.toMatch(/status = 'running'/);
    // Guard on the expired lease (the previous winner is presumed dead).
    expect(fn![0]).toMatch(/finalizing_lease_expires_at < NOW\(\)/);
    // RENEW the lease (forward progress if the recovering worker also dies).
    expect(fn![0]).toMatch(/SET\s+finalizing_lease_expires_at = \$2/);
    // PR #36 review fix #4 — INCREMENT the fencing generation. The COALESCE
    // handles legacy pre-0030 `finalizing` rows whose generation is NULL
    // (COALESCE(NULL, 0) + 1 = 1 on the first reclaim).
    expect(fn![0]).toMatch(/finalizing_generation = COALESCE\(finalizing_generation, 0\) \+ 1/);
    // The recovery MUST NOT touch `status` (the reservation stays
    // `finalizing` — only the finalization CASes advance to
    // completed/invalidated) + MUST NOT touch `completed_at` (no terminal
    // timestamp until the finalization).
    expect(fn![0]).not.toMatch(/SET status/);
    expect(fn![0]).not.toMatch(/completed_at/);
  });

  it('benchmark claimExperimentCompletion sets the persisted lease + the fencing generation (NOT just status=finalizing)', () => {
    // PR #36 review fix #3 + #4: the reservation MUST set
    // finalizing_lease_expires_at alongside the running → finalizing CAS,
    // so a crashed worker's reservation is eventually reclaimable by the
    // recovery CAS. Without the lease, the recovery CAS has nothing to
    // check for staleness — the experiment would be permanently stuck.
    // The reservation MUST ALSO set finalizing_generation (the fencing
    // token) so the winner receives a generation it MUST pass to the
    // finalization CAS — a stale worker holding an OLDER generation is
    // fenced.
    const repoSrc = readFileSync(join(BENCHMARK_INTERNAL, 'pg-benchmark-repository.ts'), 'utf8');
    const fn = repoSrc.match(/async claimExperimentCompletion[\s\S]*?RETURNING \*/);
    expect(fn, 'claimExperimentCompletion must exist + use RETURNING *').not.toBeNull();
    // The reservation sets BOTH status='finalizing' AND the lease.
    expect(fn![0]).toMatch(/SET status = 'finalizing'/);
    expect(fn![0]).toMatch(/finalizing_lease_expires_at = \$2/);
    // PR #36 review fix #4 — the reservation ALSO sets the fencing
    // generation (COALESCE(NULL, 0) + 1 to handle legacy pre-0030 rows).
    expect(fn![0]).toMatch(/finalizing_generation = COALESCE\(finalizing_generation, 0\) \+ 1/);
    // The reservation MUST NOT set completed_at (no terminal timestamp
    // until the finalization — carried over from the PR #36 fix #2 check).
    expect(fn![0]).not.toMatch(/completed_at/);
  });

  it('benchmark checkExperimentCompletion runs RECOVERY BEFORE the fresh reservation (recovery-first ordering)', () => {
    // PR #36 review fix #3: checkExperimentCompletion MUST try the
    // recovery CAS (recoverStaleFinalizingExperiment) BEFORE the
    // fresh-claim CAS (claimExperimentCompletion). If a previous worker
    // died with a stale lease, the recovery reclaims it; only if there is
    // no stale reservation does the fresh claim run (which is the normal
    // path for an experiment still in 'running'). The recovery winner
    // reuses the SAME phase 2 (validation) + phase 3 (finalization) path
    // — only the reservation source differs.
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    const fn = serviceSrc.match(/private async checkExperimentCompletion[\s\S]*?\n  \}/);
    expect(fn, 'checkExperimentCompletion must exist').not.toBeNull();
    const body = fn![0];
    const recoverIdx = body.indexOf('recoverStaleFinalizingExperiment');
    const claimIdx = body.indexOf('claimExperimentCompletion');
    expect(recoverIdx, 'must call recoverStaleFinalizingExperiment').toBeGreaterThan(-1);
    expect(claimIdx, 'must call claimExperimentCompletion').toBeGreaterThan(-1);
    // Recovery MUST come before the fresh claim (recovery-first ordering).
    expect(recoverIdx).toBeLessThan(claimIdx);
    // The `claimed` variable MUST be the recovery winner OR the fresh-claim
    // winner (nullish coalescing) — both paths feed the SAME phase 2/3.
    expect(body).toMatch(/recovered \?\? .*claimExperimentCompletion/);
  });

  it('benchmark getExperiment is a PURE read (NO lazy recovery — authorization must precede mutation)', () => {
    // PR #35 review fix (control-plane boundary): the previous
    // implementation triggered LAZY RECOVERY in getExperiment — a read of
    // a `finalizing` experiment ran checkExperimentCompletion (recovery
    // CAS + finalization CASes + terminal audit events). Because every
    // route resolves the experiment's projectId via getExperiment(id)
    // BEFORE requireProjectAuthorization, that put a state-mutating
    // operation BEFORE authorization: an unauthorized caller could mutate
    // another project's experiment by knowing its UUID. The experiment
    // UUID is NOT an authorization credential.
    //
    // The fix: getExperiment is now a PURE read (select + map). The
    // recovery trigger lives in recoverExperimentIfStale, which the route
    // layer calls ONLY AFTER requireProjectAuthorization succeeded. This
    // test enforces the purity: NO checkExperimentCompletion call, NO
    // status branching on 'finalizing', NO catch, NO re-read — just the
    // single repository read.
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    const fn = serviceSrc.match(/async getExperiment[\s\S]*?\n  \}/);
    expect(fn, 'getExperiment must exist').not.toBeNull();
    // Strip comments — the fix's explanatory doc block legitimately
    // MENTIONS the removed lazy-recovery behavior ('finalizing',
    // 'checkExperimentCompletion'); purity is about the CODE, not the
    // comments.
    const body = fn![0].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // MUST read from the repository (the pure select).
    expect(body).toMatch(/repository\.getExperiment/);
    // MUST NOT run the completion/recovery protocol (no mutation).
    expect(body).not.toMatch(/checkExperimentCompletion/);
    // MUST NOT branch on the `finalizing` status (the old lazy-recovery
    // guard — a pure read has no status-dependent behavior).
    expect(body).not.toMatch(/finalizing/);
    // MUST NOT catch + log recovery failures (no side effects to guard).
    expect(body).not.toMatch(/catch/);
  });

  it('benchmark migration 0030 adds the fencing generation column (monotonic ownership token for the finalizing reservation)', () => {
    // PR #36 review fix #4 (fencing): the recovery CAS (fix #3) renews the
    // lease but does NOT fence the original worker — the stale worker can
    // still call the finalization CAS using stale validation after a newer
    // worker reclaimed. Migration 0030 fixes this by adding the
    // `finalizing_generation` column (a monotonic ownership token). The
    // reservation CAS sets it (COALESCE(NULL, 0) + 1), the recovery CAS
    // increments it, + the finalization CASes require it in their WHERE
    // clause. A stale worker holding an OLD generation is fenced (its CAS
    // rejects because the row's generation has advanced).
    const migrationPath = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0030_benchmark_experiment_finalizing_generation.sql');
    expect(existsSync(migrationPath), '0030_benchmark_experiment_finalizing_generation.sql must exist').toBe(true);
    const src = readFileSync(migrationPath, 'utf8');
    // The column MUST exist (nullable — only meaningful for `finalizing`
    // rows; NULL for non-`finalizing` rows + for legacy pre-0030
    // `finalizing` rows that were never reclaimed post-0030).
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS finalizing_generation BIGINT/);
    // The migration MUST NOT backfill — the column is only meaningful for
    // `finalizing` rows, + the recovery CAS handles NULL gracefully via
    // COALESCE(NULL, 0) + 1 = 1 on the first reclaim. A backfill would
    // imply the column needs a non-NULL starting value for non-`finalizing`
    // rows, which it does not (the finalization CAS guard
    // `status='finalizing'` already excludes them).
    expect(src).not.toMatch(/UPDATE wfos_benchmark_experiments/);
    // The migration MUST document the fencing invariant (the reviewer
    // required the diff to be self-explanatory — what + why).
    expect(src).toMatch(/finalizing_generation/);
    expect(src).toMatch(/FENCING/);
  });

  it('benchmark finalizeExperimentCompletion + finalizeExperimentInvalidation REQUIRE the fencing generation in the WHERE clause (stale-worker fencing)', () => {
    // PR #36 review fix #4 (fencing): the finalization CASes MUST require
    // the `expectedGeneration` parameter in their WHERE clause
    // (`WHERE id=$1 AND status='finalizing' AND finalizing_generation=$2`)
    // so a stale worker holding an OLDER generation cannot finalize after
    // a newer worker reclaimed + advanced the generation. This is the
    // exclusive-ownership invariant the reviewer required. (The two-phase
    // protocol test above already asserts the WHERE clause includes the
    // generation; this test isolates the FENCING invariant + asserts the
    // signatures require the generation parameter, so a caller CANNOT
    // accidentally call finalize without a generation.)
    const repoSrc = readFileSync(join(BENCHMARK_INTERNAL, 'pg-benchmark-repository.ts'), 'utf8');

    // finalizeExperimentCompletion signature MUST require expectedGeneration.
    const finalizeSig = repoSrc.match(/async finalizeExperimentCompletion\(id: string, expectedGeneration: number\)/);
    expect(finalizeSig, 'finalizeExperimentCompletion must accept (id, expectedGeneration)').not.toBeNull();
    // finalizeExperimentInvalidation signature MUST require expectedGeneration.
    const invalidateSig = repoSrc.match(/async finalizeExperimentInvalidation\(id: string, expectedGeneration: number\)/);
    expect(invalidateSig, 'finalizeExperimentInvalidation must accept (id, expectedGeneration)').not.toBeNull();

    // Both finalization CASes MUST guard on finalizing_generation = $2.
    const finalizeFn = repoSrc.match(/async finalizeExperimentCompletion[\s\S]*?RETURNING \*/);
    expect(finalizeFn![0]).toMatch(/AND finalizing_generation = \$2/);
    const invalidateFn = repoSrc.match(/async finalizeExperimentInvalidation[\s\S]*?RETURNING \*/);
    expect(invalidateFn![0]).toMatch(/AND finalizing_generation = \$2/);

    // The repository interface (benchmark.types.ts) MUST also require the
    // generation parameter on both signatures (so callers cannot bypass
    // the fencing token at the type level).
    const typesSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark.types.ts'), 'utf8');
    expect(typesSrc).toMatch(/finalizeExperimentCompletion\(id: string, expectedGeneration: number\)/);
    expect(typesSrc).toMatch(/finalizeExperimentInvalidation\(id: string, expectedGeneration: number\)/);
  });

  it('benchmark checkExperimentCompletion passes the claimed generation to the finalization CASes (with a defensive null check)', () => {
    // PR #36 review fix #4 (fencing): checkExperimentCompletion MUST read
    // `claimed.finalizingGeneration` (the fencing token the reservation
    // or recovery CAS returned) + pass it to BOTH finalization CASes. A
    // null generation (should not happen — every finalizing row post-0030
    // has a generation set by the reservation/recovery CAS) is treated as
    // a defensive abort: log + return WITHOUT finalizing (do NOT finalize
    // without fencing — a missing generation means we cannot prove
    // exclusive ownership). This is the wiring that makes the fencing
    // invariant end-to-end: the reservation sets the generation → the
    // service reads it → the finalization CAS requires it.
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    const fn = serviceSrc.match(/private async checkExperimentCompletion[\s\S]*?\n  \}/);
    expect(fn, 'checkExperimentCompletion must exist').not.toBeNull();
    const body = fn![0];
    // MUST read claimed.finalizingGeneration into a local variable.
    expect(body).toMatch(/claimed\.finalizingGeneration/);
    // MUST defensively abort on null generation (log + return — do NOT
    // finalize without fencing).
    expect(body).toMatch(/expectedGeneration === null/);
    expect(body).toMatch(/benchmark\.experiment-finalizing-missing-generation/);
    // MUST pass expectedGeneration to BOTH finalization CASes.
    expect(body).toMatch(/finalizeExperimentCompletion\(\s*experimentId,\s*expectedGeneration/);
    expect(body).toMatch(/finalizeExperimentInvalidation\(\s*experimentId,\s*expectedGeneration/);
  });

  it('benchmark recoverExperimentIfStale is the POST-AUTHORIZATION recovery trigger (guarded on finalizing, best-effort, re-reads)', () => {
    // PR #35 review fix (control-plane boundary): the recovery the lazy
    // hook used to perform is NOT removed — forward progress for a stuck
    // `finalizing` experiment is preserved. It is RE-HOMED in
    // recoverExperimentIfStale, a method that MUTATES and therefore MUST
    // only be called from a path that has ALREADY succeeded at
    // requireProjectAuthorization for the experiment's owning project.
    //   - not found → null
    //   - status ≠ 'finalizing' → returned as-is (no-op)
    //   - status = 'finalizing' → checkExperimentCompletion (phase 0
    //     recovery CAS + phase 2 validation + phase 3 finalization), best
    //     effort (failures caught + logged), then a re-read so the caller
    //     sees the recovered terminal state.
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    const fn = serviceSrc.match(/async recoverExperimentIfStale[\s\S]*?\n  \}/);
    expect(fn, 'recoverExperimentIfStale must exist').not.toBeNull();
    const body = fn![0];
    // MUST no-op unless the experiment is stuck in `finalizing`.
    expect(body).toMatch(/status !== 'finalizing'/);
    // MUST run the recovery protocol (phase 0 lives in
    // checkExperimentCompletion).
    expect(body).toMatch(/checkExperimentCompletion/);
    // MUST be best-effort: recovery failures are caught + logged so a
    // read never surfaces a false completion.
    expect(body).toMatch(/catch/);
    expect(body).toMatch(/benchmark\.experiment-finalizing-recovery-failed/);
    // MUST re-read after recovery so the caller sees the recovered state.
    expect(body).toMatch(/return this\.deps\.repository\.getExperiment/);
    // The public service interface MUST expose it (so the route layer can
    // call it post-authorization).
    const typesSrc = readFileSync(join(BACKEND_ROOT, 'src', 'benchmark', 'types.ts'), 'utf8');
    expect(typesSrc).toMatch(/recoverExperimentIfStale\(experimentId: string\)/);
  });

  it('benchmark GET /benchmarks/:id AUTHORIZES BEFORE recovery (pure read → requireProjectAuthorization → recoverExperimentIfStale)', () => {
    // PR #35 review fix (control-plane boundary): the route ordering MUST
    // be (1) PURE getExperiment read (resolves projectId), (2) 404, (3)
    // requireProjectAuthorization, (4) ONLY THEN the mutating
    // recoverExperimentIfStale hook. The reviewer's required invariant:
    // "A caller must be authorized before any mutation, even recovery."
    //
    // WORK-032 start-delivery durability widened the hook: it is now
    // called UNCONDITIONALLY post-authorization (recoverExperimentIfStale
    // internally replays incomplete start deliveries AND recovers a stuck
    // `finalizing` reservation, no-op-ing when there is nothing to
    // recover). The route itself stays a pure-read-then-authorize-then-
    // recover shape — the status gating lives INSIDE the service method.
    const routeSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'routes', 'benchmark.route.ts'), 'utf8');
    const fn = routeSrc.match(/app\.get\('\/benchmarks\/:id'[\s\S]*?\n  \}\);/);
    expect(fn, 'GET /benchmarks/:id route must exist').not.toBeNull();
    // Strip comments — the ordering assertions are about the CODE; the
    // fix's explanatory comments legitimately mention
    // requireProjectAuthorization before the code that calls it.
    const body = fn![0].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const pureReadIdx = body.indexOf('benchmarkService.getExperiment(id)');
    const authzIdx = body.indexOf('requireProjectAuthorization');
    const recoveryIdx = body.indexOf('recoverExperimentIfStale');
    expect(pureReadIdx).toBeGreaterThanOrEqual(0);
    expect(authzIdx).toBeGreaterThanOrEqual(0);
    expect(recoveryIdx).toBeGreaterThanOrEqual(0);
    // ORDER: pure read → authorization → recovery.
    expect(pureReadIdx).toBeLessThan(authzIdx);
    expect(authzIdx).toBeLessThan(recoveryIdx);
    // The recovery call MUST be UNCONDITIONAL (not gated on a status the
    // route inspects) — recoverExperimentIfStale owns the gating for BOTH
    // recovery kinds (incomplete start deliveries + stuck finalizing). A
    // route-level status ternary would leave running experiments with
    // incomplete start deliveries unrecoverable via the read path.
    expect(body).toMatch(/const recovered = await benchmarkService\.recoverExperimentIfStale\(id\)/);
    expect(body).not.toMatch(/status === 'finalizing'/);
    // MUST return the recovered row (the caller sees the post-recovery
    // state, not the stale pre-recovery row).
    expect(body).toMatch(/experiment: recovered \?\? experiment/);
  });

  it('benchmark claimExperimentStart is an ATOMIC CAS + DURABLE DELIVERY INTENT (ONE statement: created|paused → running + outbox rows)', () => {
    // WORK-032 start-delivery durability: the PR #35 CAS (created|paused →
    // running) is now ONE CTE statement that ALSO creates the durable
    // delivery intent — a start-delivery (outbox) row + one enqueue
    // obligation per trial queued at claim time. The reviewer's
    // requirement: "The repository should own the atomic state transition
    // and durable delivery record" — the transition and the intent are
    // INSEPARABLE (a crash after the statement leaves a recoverable,
    // replayable start; the CAS loser gets NO second start obligation).
    const repoSrc = readFileSync(join(BENCHMARK_INTERNAL, 'pg-benchmark-repository.ts'), 'utf8');
    const fn = repoSrc.match(/async claimExperimentStart[\s\S]*?\n  \}/);
    expect(fn, 'claimExperimentStart must exist').not.toBeNull();
    const body = fn![0];
    // ONE statement — a CTE chain (no separate INSERT the crash can fall
    // between).
    expect(body).toMatch(/WITH claimed AS \(/);
    // The CAS predicate MUST be guarded on the startable states.
    expect(body).toMatch(/WHERE id = \$1 AND status IN \('created', 'paused'\)/);
    // MUST set status='running' + preserve the first started_at
    // (COALESCE — a re-start after pause keeps the original start time).
    expect(body).toMatch(/SET status = 'running'/);
    expect(body).toMatch(/started_at = COALESCE\(started_at, NOW\(\)\)/);
    // The SAME statement MUST create the delivery intent row...
    expect(body).toMatch(/INSERT INTO wfos_benchmark_start_deliveries \(experiment_id, project_id\)/);
    // ...AND the per-trial enqueue obligations (the claim-time snapshot of
    // queued trials).
    expect(body).toMatch(/INSERT INTO wfos_benchmark_start_trial_deliveries \(start_delivery_id, trial_id\)/);
    expect(body).toMatch(/t\.lifecycle_phase = 'queued'/);
    // Only the CAS winner's row is returned (the loser → zero rows →
    // null → no obligation created).
    expect(body).toMatch(/RETURNING \*/);
    // The repository interface MUST require the new return shape (the
    // claimed experiment + the delivery id the winner drives the replay
    // with).
    const typesSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark.types.ts'), 'utf8');
    expect(typesSrc).toMatch(/claimExperimentStart\(id: string\): Promise<ClaimedExperimentStart \| null>/);
  });

  it('benchmark startExperiment delegates delivery to the REPLAYABLE path + enqueues the durable RELAY JOB first (no ad-hoc trial side effects)', () => {
    // WORK-032 start-delivery durability: startExperiment performs NO
    // ad-hoc side effects of its own — the audit write + the trial
    // enqueues live ONLY in the durable replay path
    // (replayStartDeliveries → deliverStartAudit / enqueue-then-mark),
    // shared by the happy path AND every recovery touch. This is what
    // makes a crash between the claim and full delivery recoverable: there
    // is no in-memory delivery intent left to lose.
    //
    // OUTBOX RELAY (the liveness correction): startExperiment's FIRST
    // action after the claim is enqueueing the DURABLE RELAY JOB (the
    // generic OutboxRelay integration with the existing queue) — BEFORE
    // the immediate replay — so a crash at ANY point after the claim
    // leaves a live worker able to drain the relay job from the durable
    // queue (recovery WITHOUT a restart). The relay-job enqueue is the
    // one permitted enqueue in this method; trial-job enqueues remain
    // exclusive to the replay path.
    //
    // The PR #35 invariant still holds: only the CAS winner reaches the
    // delivery path; the loser re-reads + throws the invalid-state error
    // (no side effects).
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    const fn = serviceSrc.match(/async startExperiment[\s\S]*?\n  \}/);
    expect(fn, 'startExperiment must exist').not.toBeNull();
    // Strip comments — the assertions are about the CODE.
    const body = fn![0].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const claimIdx = body.indexOf('claimExperimentStart(experimentId)');
    const relayIdx = body.indexOf('BENCHMARK_START_DELIVERY_RELAY_JOB_TYPE');
    const replayIdx = body.indexOf('replayStartDeliveries(experimentId)');
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(relayIdx).toBeGreaterThanOrEqual(0);
    expect(replayIdx).toBeGreaterThanOrEqual(0);
    // ORDER: the atomic claim → the durable relay job → the immediate
    // replay (the relay job must exist in the durable queue BEFORE any
    // delivery begins, so a mid-replay crash is recoverable without a
    // restart).
    expect(claimIdx).toBeLessThan(relayIdx);
    expect(relayIdx).toBeLessThan(replayIdx);
    // NO ad-hoc inline side effects — the audit write + the TRIAL-job
    // enqueues live ONLY in the replay path (a second copy would
    // reintroduce the crash hole). The relay-job enqueue is the one
    // permitted enqueue (the outbox-relay integration itself).
    expect(body).not.toMatch(/auditService\.write/);
    expect(body).not.toMatch(/queue\.enqueue\('benchmark\.trial'/);
    // The relay-job enqueue MUST be best-effort (a failed enqueue is
    // caught + logged — the obligations are durable; the boot sweep
    // re-enqueues at the next process start).
    expect(fn![0]).toMatch(/benchmark\.start-delivery-relay-enqueue-failed/);
    // The loser MUST throw the invalid-state error (no side effects, no
    // second start obligation).
    expect(body).toMatch(/benchmark-experiment-invalid-state/);
    // MUST NOT use the unconditional status update for the start
    // transition (the CAS owns created|paused → running).
    expect(body).not.toMatch(/updateExperimentStatus\(experimentId, 'running'/);
  });

  it('benchmark control-plane authz regression tests exist (unauthorized read cannot mutate; concurrent start is exactly-once)', () => {
    // PR #35 review fix: the reviewer required regressions proving (a) an
    // unauthorized cross-project read produces no mutation/audit, and (b)
    // concurrent starts produce exactly one transition, one audit, and
    // one set of enqueues. Both live in
    // control-plane-authz.regression.test.ts (HTTP-level, two projects,
    // two users — the cross-tenant read is meaningful because User B's
    // key cannot authorize Project A).
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'benchmark', 'control-plane-authz.regression.test.ts');
    expect(existsSync(testPath), 'control-plane-authz.regression.test.ts must exist').toBe(true);
    const src = readFileSync(testPath, 'utf8');
    expect(src).toMatch(/UNAUTHORIZED cross-project read produces NO mutation \+ NO audit \(authorization precedes recovery\)/);
    expect(src).toMatch(/CONCURRENT experiment starts finalize exactly once \(one transition, one audit, one set of enqueues\)/);
    // The unauthorized-read test MUST assert BOTH halves of the reviewer's
    // requirement: the unauthorized read mutates nothing AND the
    // authorized read still recovers (forward progress preserved).
    expect(src).toMatch(/forward progress is PRESERVED for the AUTHORIZED/);
    // The concurrent-start test MUST assert all three exactly-once
    // dimensions: one audit, one enqueue set, one transition.
    expect(src).toMatch(/BENCHMARK_STARTED/);
    expect(src).toMatch(/trialJobEnqueues - enqueuesBefore\)\.toBe\(1\)/);
    expect(src).toMatch(/toBe\('running'\)/);
  });

  it('benchmark migration 0031 adds the durable start-delivery outbox (transactional outbox for experiment start)', () => {
    // WORK-032 start-delivery durability: the start's side effects
    // (BENCHMARK_STARTED audit + benchmark.trial enqueues) were in-memory
    // intent — lost on any crash after the CAS. Migration 0031 adds the
    // durable intent: one delivery row per logical start + one enqueue
    // obligation per (logical start × trial queued at claim time). The
    // UNIQUE constraint is the "one logical enqueue obligation per trial"
    // invariant, mechanically enforced.
    const migrationPath = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0031_benchmark_start_delivery_durability.sql');
    expect(existsSync(migrationPath), '0031_benchmark_start_delivery_durability.sql must exist').toBe(true);
    const src = readFileSync(migrationPath, 'utf8');
    // The outbox tables.
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS wfos_benchmark_start_deliveries/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS wfos_benchmark_start_trial_deliveries/);
    // The audit-obligation flag (flipped atomically WITH the audit INSERT
    // by deliverStartAudit).
    expect(src).toMatch(/audit_delivered/);
    // ONE logical enqueue obligation per trial per logical start.
    expect(src).toMatch(/UNIQUE \(start_delivery_id, trial_id\)/);
    // The replay lookups are partial-index scans (incomplete deliveries +
    // pending obligations).
    expect(src).toMatch(/WHERE completed_at IS NULL/);
    expect(src).toMatch(/WHERE delivered = FALSE/);
    // NO polling/scheduler machinery in the migration (§34 — the replay is
    // touch-driven).
    expect(src).not.toMatch(/setInterval|set_timeout|pg_cron/i);
    // The test-DB reset must truncate the outbox tables (child first —
    // CASCADE handles the FK, but the established convention is explicit).
    const testDbSrc = readFileSync(join(BACKEND_ROOT, 'tests', 'helpers', 'test-database.ts'), 'utf8');
    expect(testDbSrc).toMatch(/TRUNCATE wfos_benchmark_start_trial_deliveries/);
    expect(testDbSrc).toMatch(/TRUNCATE wfos_benchmark_start_deliveries/);
  });

  it('benchmark deliverStartAudit is an ATOMIC exactly-once write (flag-CAS + deterministic-id audit INSERT in ONE statement)', () => {
    // WORK-032 start-delivery durability: the BENCHMARK_STARTED audit must
    // be written EXACTLY ONCE per logical start, even under concurrent
    // replays + crashes. deliverStartAudit achieves this with ONE CTE
    // statement:
    //   * the flag-CAS (audit_delivered FALSE → TRUE) — only ONE concurrent
    //     caller receives a row (the audit-write claim);
    //   * the INSERT INTO wfos_audit_events with the DETERMINISTIC id (the
    //     delivery id) ON CONFLICT (id) DO NOTHING — the row can never be
    //     duplicated;
    //   * both in one statement — the flag is never set without the audit
    //     row existing (a crash rolls back both).
    const repoSrc = readFileSync(join(BENCHMARK_INTERNAL, 'pg-benchmark-repository.ts'), 'utf8');
    const fn = repoSrc.match(/async deliverStartAudit[\s\S]*?\n  \}/);
    expect(fn, 'deliverStartAudit must exist').not.toBeNull();
    const body = fn![0];
    // ONE statement (CTE chain — no separate flag update + insert).
    expect(body).toMatch(/WITH flag AS \(/);
    // The flag-CAS.
    expect(body).toMatch(/WHERE id = \$1 AND audit_delivered = FALSE/);
    expect(body).toMatch(/SET audit_delivered = TRUE/);
    // The deterministic-id audit INSERT with conflict absorption.
    expect(body).toMatch(/INSERT INTO wfos_audit_events/);
    expect(body).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    // The audit payload mirrors the previous auditService.write call
    // (BENCHMARK_STARTED / benchmark_experiment / system / benchmark-service).
    expect(body).toMatch(/'BENCHMARK_STARTED'/);
    expect(body).toMatch(/'benchmark_experiment'/);
    // The id is the DELIVERY id (deterministic — the exactly-once key).
    expect(body).toMatch(/SELECT f\.id, f\.project_id, 'BENCHMARK_STARTED'/);
  });

  it('benchmark startExperiment owns NO retry loop or scheduler (start-delivery replay is touch-driven, single-pass — §34)', () => {
    // WORK-032 start-delivery durability, the reviewer-required static
    // invariant: startExperiment (and the replay path it shares) must NOT
    // become an ad-hoc retry loop / second scheduler. The replay is a
    // SINGLE PASS over durable obligation rows, invoked ONLY by existing
    // touch points — never a timer, never a self-scheduling loop, never a
    // new queue consumer.
    const serviceSrc = readFileSync(join(BENCHMARK_INTERNAL, 'benchmark-service.ts'), 'utf8');
    const startFn = serviceSrc.match(/async startExperiment[\s\S]*?\n  \}/);
    expect(startFn, 'startExperiment must exist').not.toBeNull();
    const replayFn = serviceSrc.match(/async replayStartDeliveries[\s\S]*?\n  \}/);
    expect(replayFn, 'replayStartDeliveries must exist').not.toBeNull();
    for (const [name, fn] of [['startExperiment', startFn], ['replayStartDeliveries', replayFn]] as const) {
      // Drop the declaration signature line — the recursion checks target
      // CALLS, not the method's own signature.
      const code = fn![0].replace(/^async [a-zA-Z]+\([^)]*\)[^\n]*\n/, '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // NO timers/schedulers.
      expect(code, `${name} must not schedule`).not.toMatch(/setInterval|setTimeout|setImmediate/);
      // NO unbounded retry loops.
      expect(code, `${name} must not spin`).not.toMatch(/while\s*\(\s*true\s*\)/);
    }
    // NO self-recursion: neither method may re-invoke ITSELF (note:
    // startExperiment DELEGATING to replayStartDeliveries is the design —
    // the happy path shares the replay code path; the forbidden shape is a
    // method scheduling/re-entering itself, e.g. replay → replay).
    const startCode = startFn![0].replace(/^async [a-zA-Z]+\([^)]*\)[^\n]*\n/, '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(startCode).not.toMatch(/startExperiment\(/);
    const replayCodeStripped = replayFn![0].replace(/^async [a-zA-Z]+\([^)]*\)[^\n]*\n/, '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(replayCodeStripped).not.toMatch(/replayStartDeliveries\(/);
    expect(replayCodeStripped).not.toMatch(/startExperiment\(/);
    // The replay is a bounded single pass (for...of over the durable rows).
    const replayCode = replayFn![0].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(replayCode).toMatch(/for \(const delivery of deliveries\)/);
    // The ONLY invocation sites of replayStartDeliveries are the touch
    // points: startExperiment (happy path), runTrialJob (worker touch),
    // recoverExperimentIfStale (post-auth read path) — in THIS file — plus
    // the start-delivery relay job handler (start-delivery-relay.ts, the
    // outbox-relay integration whose delivery the boot sweep guarantees).
    // Counting the call sites in the service file keeps the replay
    // touch-driven — a new scheduler would have to add a site, which this
    // count makes visible in review.
    const callSites = serviceSrc.split('replayStartDeliveries(').length - 1;
    // 1 (declaration) + 3 (startExperiment + runTrialJob + recoverExperimentIfStale)
    expect(callSites).toBe(4);
    // The FOURTH touch point — the relay job handler — lives in its own
    // file + must itself own NO scheduler machinery (no timers, no
    // self-perpetuation: the handler is fire-once; a failed attempt is
    // re-attempted by the next boot sweep or touch, NOT by the handler
    // re-enqueueing itself).
    const relaySrc = readFileSync(join(BENCHMARK_INTERNAL, 'start-delivery-relay.ts'), 'utf8');
    const relayHandlerFn = relaySrc.match(/export function createStartDeliveryRelayJobHandler[\s\S]*?\n\}/);
    expect(relayHandlerFn, 'createStartDeliveryRelayJobHandler must exist').not.toBeNull();
    const relayHandlerCode = relayHandlerFn![0].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(relayHandlerCode).not.toMatch(/setInterval|setTimeout|setImmediate/);
    expect(relayHandlerCode).not.toMatch(/while\s*\(\s*true\s*\)/);
    // Fire-once: the handler must NOT enqueue ANYTHING (in particular not
    // its own job type — that would be a self-perpetuating retry loop).
    expect(relayHandlerCode).not.toMatch(/\.enqueue\(/);
    // The relay class (the sweep) enqueues its job type — but ONLY inside
    // enqueuePendingRelayJobs (the boot-sweep entry point the WorkerHost
    // calls once per process start), never anywhere else.
    const sweepFn = relaySrc.match(/async enqueuePendingRelayJobs[\s\S]*?\n  \}/);
    expect(sweepFn, 'enqueuePendingRelayJobs must exist').not.toBeNull();
    const outsideSweep = relaySrc.replace(sweepFn![0], '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const handlerOnly = outsideSweep.replace(relayHandlerFn![0], '');
    expect(handlerOnly).not.toMatch(/\.enqueue\(/);
    // NO WorkerHost / queue-consumer construction in the benchmark domain
    // (the replay enqueues onto the EXISTING queue; it never consumes).
    const benchmarkFiles = readBenchmarkFiles();
    for (const f of benchmarkFiles) {
      expect(f.src, `${f.path} must not construct a worker`).not.toMatch(/new WorkerHost/);
    }
  });

  it('benchmark start-delivery durability regression tests exist (the crash matrix + the autonomous-liveness scenarios)', () => {
    // WORK-032 start-delivery durability: the reviewer required regression
    // coverage for the full crash matrix — a start must be recoverable
    // after ANY crash point, + repeated delivery must produce one logical
    // start / one audit / one enqueue obligation per trial. The outbox
    // relay re-review additionally required the AUTOONOMOUS-liveness
    // scenarios (the exact orphaned-outbox failure the reviewer flagged).
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'benchmark', 'start-delivery-durability.regression.test.ts');
    expect(existsSync(testPath), 'start-delivery-durability.regression.test.ts must exist').toBe(true);
    const src = readFileSync(testPath, 'utf8');
    // The six crash-matrix scenarios, by their test titles.
    expect(src).toMatch(/concurrent start → exactly one winner/);
    expect(src).toMatch(/crash after CAS → recovery resumes delivery/);
    expect(src).toMatch(/crash after audit → no duplicate audit/);
    expect(src).toMatch(/crash during trial enqueue → missing jobs are replayed/);
    expect(src).toMatch(/replay after complete delivery → zero duplicate logical deliveries/);
    expect(src).toMatch(/experiment already running → no second start obligation/);
    // The three outbox-relay liveness scenarios: (a) the orphaned outbox
    // is AUTONOMOUSLY recovered by a new worker process boot (the boot
    // sweep — the reviewer's exact blocking scenario), (b) the claim-time
    // relay job recovers a crash WITHOUT a restart (durable queue + live
    // worker), (c) duplicate relay jobs converge to exactly-once.
    expect(src).toMatch(/orphaned outbox after total process death is AUTONOMOUSLY recovered by a new worker process boot \(relay boot sweep\)/);
    expect(src).toMatch(/claim-time relay job recovers a crash after the claim WITHOUT a restart/);
    expect(src).toMatch(/duplicate relay jobs \(claim-time \+ boot sweep\) converge to exactly-once logical delivery/);
    // The tests must be built on the no-worker stack (deterministic
    // enqueue counting).
    expect(src).toMatch(/startWorker: false/);
  });

  it('platform OutboxRelay contract exists + WorkerHost runs the BOOT SWEEP exactly once per process start (NOT a periodic poll)', () => {
    // WORK-032 start-delivery durability (outbox relay liveness), the
    // reviewer's required hierarchy:
    //
    //   existing WorkflowOS durable job infrastructure (Queue + WorkerHost)
    //       ↓
    //   generic outbox relay / delivery mechanism (OutboxRelay + boot sweep)
    //       ↓
    //   Benchmark start-delivery obligation (replayStartDeliveries)
    //
    // The generic contract lives in the PLATFORM worker infrastructure;
    // domain relays implement it + are injected at composition time. The
    // WorkerHost invokes each relay's sweep exactly ONCE per process
    // start — process-startup recovery (like a DB crash-recovery pass),
    // NOT a periodic poll.
    const relayContractPath = join(BACKEND_ROOT, 'src', 'platform', 'worker', 'outbox-relay.ts');
    expect(existsSync(relayContractPath), 'platform/worker/outbox-relay.ts must exist').toBe(true);
    const contractSrc = readFileSync(relayContractPath, 'utf8');
    expect(contractSrc).toMatch(/export interface OutboxRelay/);
    expect(contractSrc).toMatch(/readonly jobType: string/);
    expect(contractSrc).toMatch(/enqueuePendingRelayJobs\(\): Promise<number>/);
    // The platform barrel exports the contract (domains import it from
    // @platform — the frozen boundary).
    const platformIndexSrc = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'index.ts'), 'utf8');
    expect(platformIndexSrc).toMatch(/OutboxRelay/);
    // WorkerHost: the options accept relays + start() runs the sweep.
    const workerHostSrc = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'worker', 'worker-host.ts'), 'utf8');
    expect(workerHostSrc).toMatch(/outboxRelays\?: readonly OutboxRelay\[\]/);
    expect(workerHostSrc).toMatch(/await this\.sweepOutboxRelays\(\)/);
    // The sweep is in start() ONLY — the poll loop must NOT re-sweep
    // (that would be a periodic poll). Extract the loop body + assert it
    // never touches the relays.
    const loopFn = workerHostSrc.match(/private async loop\(\)[\s\S]*?\n  \}/);
    expect(loopFn, 'WorkerHost.loop must exist').not.toBeNull();
    expect(loopFn![0]).not.toMatch(/outboxRelays|enqueuePendingRelayJobs|sweepOutboxRelays/);
    // A failing sweep MUST be caught (a relay's DB/queue failure must
    // never prevent the worker — or the other relays — from starting).
    const sweepFn = workerHostSrc.match(/private async sweepOutboxRelays\(\)[\s\S]*?\n  \}/);
    expect(sweepFn, 'WorkerHost.sweepOutboxRelays must exist').not.toBeNull();
    expect(sweepFn![0]).toMatch(/catch/);
  });

  it('benchmark start-delivery relay implements the generic OutboxRelay + is wired into the existing worker infrastructure (app.ts)', () => {
    // WORK-032 start-delivery durability (outbox relay liveness): the
    // benchmark relay implements the PLATFORM contract, its job handler is
    // registered in the SAME existing WorkerHost registry as
    // benchmark.trial, and the relay is injected via the WorkerHost
    // options — no new scheduler, no second execution engine (§34).
    const relaySrc = readFileSync(join(BENCHMARK_INTERNAL, 'start-delivery-relay.ts'), 'utf8');
    // The class implements the generic contract.
    expect(relaySrc).toMatch(/class BenchmarkStartDeliveryOutboxRelay implements OutboxRelay/);
    // The relay job type is namespaced under benchmark.
    expect(relaySrc).toMatch(/'benchmark\.start-delivery\.relay'/);
    // The sweep queries the DURABLE obligations (the repository owns the
    // delivery record) + enqueues one relay job per experiment.
    expect(relaySrc).toMatch(/listExperimentsWithIncompleteStartDeliveries/);
    expect(relaySrc).toMatch(/queue\.enqueue\(this\.jobType/);
    // The handler delegates to the idempotent consumer-side repair.
    expect(relaySrc).toMatch(/replayer\.replayStartDeliveries\(experimentId\)/);
    // The repository MUST own the boot-sweep query (the reviewer: "The
    // repository should own the atomic state transition and durable
    // delivery record" — the sweep reads those same durable rows).
    const repoSrc = readFileSync(join(BENCHMARK_INTERNAL, 'pg-benchmark-repository.ts'), 'utf8');
    expect(repoSrc).toMatch(/SELECT DISTINCT experiment_id FROM wfos_benchmark_start_deliveries/);
    expect(repoSrc).toMatch(/WHERE completed_at IS NULL/);
    // app.ts composition: the relay handler is registered NEXT TO the
    // trial handler in the SAME registry...
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc).toMatch(/createStartDeliveryRelayJobHandler\(benchmarkService, logger\)/);
    // ...the relay is constructed from the benchmark repository + the
    // existing queue...
    expect(appSrc).toMatch(/new BenchmarkStartDeliveryOutboxRelay\(/);
    // ...and injected into the WorkerHost options (the boot sweep).
    expect(appSrc).toMatch(/\.\.\.\(benchmarkStartDeliveryRelay \? \[benchmarkStartDeliveryRelay\] : \[\]\)/);
  });
});

// ============================================================================
// WORK-033 — Execution Policy & Fair Benchmarking architecture checks
// (§21 fairness, §9 immutability, §22 append-only, §27 server-side actor)
// ============================================================================
// The execution-policy domain lives at src/execution-policy/ (application-layer
// orchestrator OUTSIDE src/modules/, mirroring the §34 benchmark pattern). It
// CONSUMES the 17 frozen domain modules via their public barrels. It NEVER
// mutates workflow state, NEVER stores credentials, NEVER invents provider
// capabilities, NEVER instantiates another ExecutionService. These checks
// prove the boundary is intact (§1, §21, §34).
// ============================================================================

describe('WORK-033 invariants — execution policy & fair benchmarking', () => {
  const EXEC_POLICY_DIR = join(BACKEND_ROOT, 'src', 'execution-policy');
  const EXEC_POLICY_INTERNAL = join(EXEC_POLICY_DIR, 'internal');
  const MIGRATION_PATH = join(
    BACKEND_ROOT,
    'src',
    'platform',
    'postgres',
    'migrations',
    '0026_execution_policy.sql',
  );

  /** Strip line + block comments so TODO/NOTE text does not trip regex checks. */
  function stripComments(src: string): string {
    return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  // Strip SQL line comments (-- ...) and block comments for migration scans.
  function stripSqlComments(src: string): string {
    return src.replace(/--[^\n]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  function readExecPolicyFiles(): { path: string; src: string }[] {
    if (!existsSync(EXEC_POLICY_DIR)) return [];
    const out: { path: string; src: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) {
          out.push({ path: full, src: readFileSync(full, 'utf8') });
        }
      }
    };
    walk(EXEC_POLICY_DIR);
    return out;
  }

  // --- (a) execution-policy domain exists at src/execution-policy/ (with
  //     index.ts + types.ts + internal/) --------------------------------------

  it('execution policy domain exists at src/execution-policy/ with index.ts + types.ts + internal/', () => {
    expect(existsSync(EXEC_POLICY_DIR), 'src/execution-policy/ must exist').toBe(true);
    expect(existsSync(join(EXEC_POLICY_DIR, 'index.ts')), 'src/execution-policy/index.ts must exist').toBe(true);
    expect(existsSync(join(EXEC_POLICY_DIR, 'types.ts')), 'src/execution-policy/types.ts must exist').toBe(true);
    expect(existsSync(EXEC_POLICY_INTERNAL), 'src/execution-policy/internal/ must exist').toBe(true);
  });

  // --- (b) execution-policy is NOT a frozen module ---------------------------

  it('execution-policy is NOT a frozen module (no dir under src/modules/; not in 17-module list)', () => {
    // It must NOT appear under src/modules/ (it is an application-layer
    // orchestrator, mirroring the §34 benchmark pattern — NOT the 18th module).
    expect(existsSync(join(MODULES_DIR, 'execution-policy'))).toBe(false);
    expect(FROZEN_MODULE_NAMES, 'execution-policy must not be in FROZEN_MODULE_NAMES').not.toContain('/execution-policy');
    expect(FROZEN_MODULE_NAMES).toHaveLength(17);
  });

  // --- (c) execution-policy never imports any module's /internal/ ----------

  it('execution-policy never imports any module internal/ (must use @modules/* public barrels)', () => {
    const files = readExecPolicyFiles();
    const violations: string[] = [];
    for (const f of files) {
      for (const specifier of extractSpecifiers(f.path)) {
        const resolved = resolveSpecifier(f.path, specifier);
        if (!resolved) continue;
        // Forbidden: importing into src/modules/<m>/internal/ — must use the
        // module's index.ts public barrel instead.
        if (moduleOf(resolved) && isInsideInternal(resolved)) {
          violations.push(
            `${relative(BACKEND_ROOT, f.path)} imports "${specifier}" -> ` +
              `${relative(BACKEND_ROOT, resolved)} (inside ${moduleOf(resolved)}/internal; ` +
              `use the module's index.ts public interface instead)`,
          );
        }
        // Forbidden: importing the benchmark domain's internal/ — must use the
        // public barrel `../benchmark/index.js` (§34 boundary).
        if (specifier.includes('../benchmark/internal/') || specifier.includes('/benchmark/internal/')) {
          violations.push(
            `${relative(BACKEND_ROOT, f.path)} imports "${specifier}" -> ` +
              `benchmark/internal (forbidden — must use ../../benchmark/index.js public barrel)`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // --- (d) execution-policy never stores credentials -------------------------

  it('execution-policy never stores credentials (no secret/token/key/cookie columns in migration 0026)', () => {
    const migrationSrc = readFileSync(MIGRATION_PATH, 'utf8');
    const stripped = stripSqlComments(migrationSrc);
    const violations: string[] = [];
    for (const line of stripped.split('\n')) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed === '') continue;
      if (
        /(?:^|\s)(?:secret|password|api_key|apikey|credential|private_key|cookie|access_token|refresh_token|callback_token|handoff_token)\b/.test(
          trimmed,
        )
      ) {
        // `notes` is allowed (free-text annotation column — not a credential).
        if (trimmed.includes('notes') && !trimmed.includes('token')) continue;
        violations.push(`credential-like column: ${trimmed}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // --- (e) execution-policy never mutates workflow state ---------------------

  it('execution-policy never mutates workflow state (no INSERT INTO wfos_workflow_* / no toState=merged|verified|approved)', () => {
    const files = readExecPolicyFiles();
    const violations: string[] = [];
    for (const f of files) {
      const codeOnly = stripComments(f.src);
      if (/INSERT\s+INTO\s+wfos_workflow_executions/i.test(codeOnly)) {
        violations.push(`${f.path}: INSERT INTO wfos_workflow_executions (forbidden — /workflows authority)`);
      }
      if (/INSERT\s+INTO\s+wfos_workflow_transitions/i.test(codeOnly)) {
        violations.push(`${f.path}: INSERT INTO wfos_workflow_transitions (forbidden — /workflows authority)`);
      }
      if (/toState:\s*['"]merged['"]/.test(codeOnly)) {
        violations.push(`${f.path}: toState:'merged' (forbidden — /workflows authority)`);
      }
      if (/toState:\s*['"]verified['"]/.test(codeOnly)) {
        violations.push(`${f.path}: toState:'verified' (forbidden — /workflows authority)`);
      }
      if (/toState:\s*['"]approved['"]/.test(codeOnly)) {
        violations.push(`${f.path}: toState:'approved' (forbidden — /workflows authority)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // --- (f) execution-policy never creates another ExecutionService ---------

  it('execution-policy never instantiates another ExecutionService (may import the TYPE; must NOT construct)', () => {
    const files = readExecPolicyFiles();
    const violations: string[] = [];
    for (const f of files) {
      const codeOnly = stripComments(f.src);
      if (/\bnew\s+DefaultExecutionService\b/.test(codeOnly)) {
        violations.push(`${f.path}: new DefaultExecutionService (forbidden — submit via the existing ExecutionService through the route layer)`);
      }
      if (/\bextends\s+\w*ExecutionService\b/.test(codeOnly)) {
        violations.push(`${f.path}: extends *ExecutionService (forbidden — never subclass the execution service)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // --- (g) execution-policy composes existing provider metadata ------------

  it('execution-policy composes existing provider metadata (no second provider catalog)', () => {
    const normalizerSrc = readFileSync(
      join(EXEC_POLICY_INTERNAL, 'provider-capability-normalizer.ts'),
      'utf8',
    );
    // Must reference ExecutionProviderInfo (the @modules/agents source of truth).
    expect(normalizerSrc).toMatch(/ExecutionProviderInfo/);
    // Must NOT declare a new provider catalog constant.
    const codeOnly = stripComments(normalizerSrc);
    expect(codeOnly, 'provider-capability-normalizer.ts must not declare a new catalog constant').not.toMatch(
      /\bconst\s+[A-Z_]*CATALOG\b/,
    );

    // The agents barrel re-exports the WORK-033 surface-capability types so the
    // execution-policy layer can compose them WITHOUT inventing capabilities.
    const agentsBarrelSrc = readFileSync(
      join(MODULES_DIR, 'agents', 'index.ts'),
      'utf8',
    );
    expect(agentsBarrelSrc).toMatch(/EXTERNAL_UI_CATALOG/);
    expect(agentsBarrelSrc).toMatch(/ProviderSurfaceCapabilities/);
    expect(agentsBarrelSrc).toMatch(/SurfaceReadiness/);
    expect(agentsBarrelSrc).toMatch(/ProviderSurfaceKind/);
  });

  // --- (h) execution-policy recommendation is evidence-backed --------------

  it('execution-policy recommendation is evidence-backed (references historicalPerformance / observedQuality)', () => {
    const recSrc = readFileSync(
      join(EXEC_POLICY_INTERNAL, 'default-execution-recommendation-service.ts'),
      'utf8',
    );
    // The recommendation engine MUST consume historical evidence (§14) — never
    // declare a winner string without evidence.
    expect(recSrc).toMatch(/historicalPerformance/);
    expect(recSrc).toMatch(/observedQuality/);
    // The Why explanation must NOT be a bare "AI chose this" string — it must
    // be structured (RecommendationReason with dimension + satisfied + detail).
    expect(recSrc).toMatch(/RecommendationReason/);
    expect(recSrc).toMatch(/dimension:/);
    expect(recSrc).toMatch(/satisfied:/);
    expect(recSrc).not.toMatch(/['"]AI chose this['"]/);
  });

  // --- (h2) §21 fairness integrity — BenchmarkMode + ToolPolicy shape ------

  it('§21 fairness integrity — BenchmarkMode has both maximum_capability + controlled_comparison; ToolPolicy has noArtificialCaps', () => {
    const typesSrc = readFileSync(join(EXEC_POLICY_DIR, 'types.ts'), 'utf8');
    // BenchmarkMode MUST declare both literals (§8 — fairness depends on the
    // distinction; maximum-capability mode vs. controlled-comparison mode).
    expect(typesSrc).toMatch(/'maximum_capability'/);
    expect(typesSrc).toMatch(/'controlled_comparison'/);
    // ToolPolicy MUST include noArtificialCaps (§21 — the explicit fairness
    // invariant: NEVER artificially cap a provider's tools solely for fairness).
    expect(typesSrc).toMatch(/noArtificialCaps/);
    expect(typesSrc).toMatch(/maximumCapability/);
    expect(typesSrc).toMatch(/toolClassFixed/);
    // DEFAULT_TOOL_POLICY must default to maximum-capability mode (no caps).
    expect(typesSrc).toMatch(/DEFAULT_TOOL_POLICY/);
    expect(typesSrc).toMatch(/maximumCapability:\s*true/);
    expect(typesSrc).toMatch(/noArtificialCaps:\s*true/);
  });

  // --- (i) execution-policy route is wired ---------------------------------

  it('execution-policy route is wired in server.ts + index.ts', () => {
    const serverSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'server.ts'), 'utf8');
    expect(serverSrc).toMatch(/executionPolicyRoutes/);
    expect(serverSrc).toMatch(/ExecutionPolicyRouteDeps/);
    const indexSrc = readFileSync(join(BACKEND_ROOT, 'src', 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/executionPolicy:/);
  });

  // --- (j) execution-policy service is constructed in app.ts ----------------

  it('execution-policy service is constructed in app.ts', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc).toMatch(/DefaultExecutionPolicyService/);
    expect(appSrc).toMatch(/PgExecutionPolicyRepository/);
    expect(appSrc).toMatch(/executionPolicyService/);
  });

  // --- (k) migration 0026 + test-database truncates -------------------------

  it('migration 0026 exists + test-database truncates execution-policy tables', () => {
    expect(existsSync(MIGRATION_PATH), '0026_execution_policy.sql must exist').toBe(true);
    const testDbSrc = readFileSync(join(BACKEND_ROOT, 'tests', 'helpers', 'test-database.ts'), 'utf8');
    expect(testDbSrc).toMatch(/TRUNCATE wfos_execution_policy_decisions/);
    expect(testDbSrc).toMatch(/TRUNCATE wfos_execution_policies/);
    expect(testDbSrc).toMatch(/TRUNCATE wfos_execution_preferences/);
    expect(testDbSrc).toMatch(/TRUNCATE wfos_provider_access_profiles/);
  });

  // --- (l) §9 policy immutability ------------------------------------------

  it('§9 policy immutability — migration 0026 has frozen reject trigger + policy_version column + touch trigger', () => {
    const migrationSrc = readFileSync(MIGRATION_PATH, 'utf8');
    // policy_version column (monotonically increasing; bumped on every UPDATE).
    expect(migrationSrc).toMatch(/policy_version\s+INTEGER\s+NOT\s+NULL/);
    // wfos_execution_policy_touch — bumps policy_version + updated_at.
    expect(migrationSrc).toMatch(/wfos_execution_policy_touch/);
    expect(migrationSrc).toMatch(/BEFORE INSERT OR UPDATE ON wfos_execution_policies/);
    // wfos_reject_frozen_execution_policy — rejects UPDATE on frozen policies.
    expect(migrationSrc).toMatch(/wfos_reject_frozen_execution_policy/);
    expect(migrationSrc).toMatch(/BEFORE UPDATE ON wfos_execution_policies/);
  });

  // --- (m) §22 decisions append-only ----------------------------------------

  it('§22 decisions append-only — migration 0026 has wfos_execution_policy_decision_immutable trigger (BEFORE UPDATE + BEFORE DELETE)', () => {
    const migrationSrc = readFileSync(MIGRATION_PATH, 'utf8');
    expect(migrationSrc).toMatch(/wfos_execution_policy_decision_immutable/);
    expect(migrationSrc).toMatch(/BEFORE UPDATE ON wfos_execution_policy_decisions/);
    expect(migrationSrc).toMatch(/BEFORE DELETE ON wfos_execution_policy_decisions/);
  });

  // --- (n) §27 server-side actor -------------------------------------------

  it('§27 server-side actor — route calls requireProjectAuthorization; does NOT read actor/createdBy/userId from req.body', () => {
    const routeSrc = readFileSync(
      join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution-policy.route.ts'),
      'utf8',
    );
    // Every authorized route must call requireProjectAuthorization (the actor
    // is derived server-side from the authenticated user — §27, PR #35 fix #5).
    expect(routeSrc).toMatch(/requireProjectAuthorization/);
    // Must NEVER read actor / createdBy / userId from the request body.
    const codeOnly = stripComments(routeSrc);
    expect(codeOnly, 'route must not read body.actor').not.toMatch(/body\.actor/);
    expect(codeOnly, 'route must not read body.createdBy').not.toMatch(/body\.createdBy/);
    expect(codeOnly, 'route must not read body.userId').not.toMatch(/body\.userId/);
  });

  // --- (o) execution-policy never imports provider SDKs ---------------------

  it('execution-policy never imports provider SDKs or env secrets (no @octokit/openai/anthropic/zai-sdk; no process.env *_API_KEY/_SECRET/_TOKEN)', () => {
    const files = readExecPolicyFiles();
    const violations: string[] = [];
    for (const f of files) {
      const codeOnly = stripComments(f.src);
      if (/from\s+['"]@octokit/.test(codeOnly)) {
        violations.push(`${f.path}: imports @octokit (forbidden — use @modules/github)`);
      }
      if (/from\s+['"]openai['"]/.test(codeOnly)) {
        violations.push(`${f.path}: imports openai (forbidden — use @modules/llm)`);
      }
      if (/from\s+['"]anthropic['"]/.test(codeOnly)) {
        violations.push(`${f.path}: imports anthropic (forbidden — use @modules/agents)`);
      }
      if (/\bzai-sdk\b/.test(codeOnly)) {
        violations.push(`${f.path}: imports zai-sdk (forbidden — provider SDKs are not for the policy layer)`);
      }
      if (/process\.env\.[A-Z_]*_API_KEY\b/.test(codeOnly)) {
        violations.push(`${f.path}: reads process.env *_API_KEY (forbidden — never reads secrets)`);
      }
      if (/process\.env\.[A-Z_]*_SECRET\b/.test(codeOnly)) {
        violations.push(`${f.path}: reads process.env *_SECRET (forbidden — never reads secrets)`);
      }
      if (/process\.env\.[A-Z_]*_TOKEN\b/.test(codeOnly)) {
        violations.push(`${f.path}: reads process.env *_TOKEN (forbidden — never reads secrets)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('execution-policy preferences are ADVISORY — buildConstraintSet routes NO preference into the hard constraint set (§12)', () => {
    // PR #37 review fix 1: the previous buildConstraintSet did
    //   allowedModes: prefs.preferredMode ? [prefs.preferredMode] : []
    // inside user constraints — making preferredMode a HARD eligibility
    // block (preferredMode='external' excluded every native candidate even
    // when native execution was fully allowed). The §12 contract:
    // preferences (preferredMode / externalPreferred / nativePreferred /
    // weights) influence RANKING ONLY.
    const serviceSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'default-execution-policy-service.ts'), 'utf8');
    const fn = serviceSrc.match(/private buildConstraintSet[\s\S]*?\n  \}/);
    expect(fn, 'buildConstraintSet must exist').not.toBeNull();
    const code = stripComments(fn![0]);
    // The constraint builder must NOT receive or read the preference
    // profile at all (structural separation: hard constraints in, hard
    // constraints out).
    expect(code).not.toMatch(/prefs\.|UserPreferenceRecord|preferredMode|externalPreferred|nativePreferred/);
    // The user.allowedModes hard-constraint slot must be EMPTY (reserved
    // for an explicit user-configured mode restriction — never a preference).
    expect(code).toMatch(/allowedModes:\s*\[\]/);
    // The preference profile flows EXCLUSIVELY into the ranking input.
    const recommendFn = serviceSrc.match(/async recommend[\s\S]*?\n  \}/)![0];
    expect(recommendFn).toMatch(/toPreferenceProfile\(prefs\)/);
    // The ranking input is the only consumer (RankInput.preferences).
    const recSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'default-execution-recommendation-service.ts'), 'utf8');
    expect(recSrc).toMatch(/preferences: ExecutionPreferenceProfile/);
    // And the eligibility input carries NO preference field at all
    // (structural: the hard filter cannot honor preferences).
    const typesSrc = readFileSync(join(EXEC_POLICY_DIR, 'types.ts'), 'utf8');
    const eligInput = typesSrc.match(/export interface EligibilityEvaluationInput[\s\S]*?\n\}/)![0];
    expect(eligInput).not.toMatch(/preference|preferred/i);
  });

  it('execution-policy constrained modes FAIL CLOSED on unknown cost/latency evidence (§8 — unknown is NOT neutral under an explicit maximum)', () => {
    // PR #37 review fix 2: the previous eligibility only blocked a cost
    // budget when candidate.estimatedCost.cents != null — so an unknown cost
    // PASSED the hard cost constraint (neutral), and maxDurationMs fed only
    // the recommendation scorer (no hard latency check). A candidate with
    // unknown cost or latency cannot legitimately be declared eligible
    // under an explicit maximum constraint:
    //   cost constraint + unknown cost     → ineligible (unknown_constrained)
    //   latency constraint + unknown latency → ineligible (unknown_constrained)
    //   known latency over the cap          → ineligible (hard latency check)
    const eligSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'default-execution-eligibility-service.ts'), 'utf8');
    const code = stripComments(eligSrc);
    // The fail-closed evaluation section exists + runs in evaluate().
    expect(code).toMatch(/evaluateConstrainedEvidence\(input, blocks, satisfied\)/);
    expect(code).toMatch(/private evaluateConstrainedEvidence/);
    // Unknown cost under ANY explicit cost cap (user + org + policy
    // snapshot) blocks with the 'evidence' category.
    expect(code).toMatch(/'unknown_cost_under_cost_constraint'/);
    expect(eligSrc).toMatch(/category: 'evidence'/);
    // Unknown latency under the policy's maxDurationMs blocks.
    expect(code).toMatch(/'unknown_latency_under_latency_constraint'/);
    // Known over-cap latency is a HARD violation (not scoring-only).
    expect(code).toMatch(/'latency_over_max'/);
    // The new status + category exist in the public contract (both backend
    // + the mirrored frontend contract).
    const typesSrc = readFileSync(join(EXEC_POLICY_DIR, 'types.ts'), 'utf8');
    expect(typesSrc).toMatch(/'unknown_constrained'/);
    expect(typesSrc).toMatch(/\| 'evidence';/);
    const frontendSrc = readFileSync(join(BACKEND_ROOT, '..', 'frontend', 'src', 'api', 'client.ts'), 'utf8');
    expect(frontendSrc).toMatch(/'unknown_constrained'/);
    expect(frontendSrc).toMatch(/\| 'evidence';/);
    // The recommendation's neutral-unknown components are only reachable
    // when NO cap is active (fail-closed handles the capped case upstream).
    const recSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'default-execution-recommendation-service.ts'), 'utf8');
    expect(recSrc).toMatch(/FAIL-CLOSED INTERPLAY/);
  });

  it('execution-policy §9 freeze is CONNECTED to the authoritative benchmark start (migration 0032 triggers — no code path can bypass)', () => {
    // PR #37 review fix 3: migration 0026 defined the freeze MECHANISM (the
    // frozen column + reject-frozen-mutation trigger) and the service
    // exposed freezeProjectPolicy(), but NOTHING invoked it from the start
    // path — a policy could remain mutable while an experiment ran. The fix
    // enforces §9 at the persistence boundary, atomically with the
    // authoritative created|paused → running transition:
    const migrationPath = join(
      BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
      '0032_execution_policy_freeze_on_benchmark_start.sql',
    );
    expect(existsSync(migrationPath), '0032_execution_policy_freeze_on_benchmark_start.sql must exist').toBe(true);
    const src = readFileSync(migrationPath, 'utf8');
    // (1) Freeze-on-start: an AFTER UPDATE trigger on the experiments table
    // guarded on the authoritative start transition.
    expect(src).toMatch(/AFTER UPDATE ON wfos_benchmark_experiments/);
    expect(src).toMatch(/NEW\.status = 'running' AND OLD\.status IN \('created', 'paused'\)/);
    expect(src).toMatch(/SET frozen = true/);
    expect(src).toMatch(/WHERE project_id = NEW\.project_id/);
    // (2) Born-frozen: a BEFORE INSERT trigger on the policies table for
    // projects with already-started experiments (the created-later hole).
    expect(src).toMatch(/BEFORE INSERT ON wfos_execution_policies/);
    expect(src).toMatch(/started_at IS NOT NULL/);
    // No unfreeze path (§9 is one-way).
    expect(src).not.toMatch(/SET frozen = false/);
    // No scheduler machinery in the migration (touch-driven by the start
    // transition itself).
    expect(src).not.toMatch(/setInterval|pg_cron|set_timeout/i);
    // The service-level freeze is documented as the EXPLICIT early freeze
    // (not load-bearing for §9 — the trigger is).
    const serviceSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'default-execution-policy-service.ts'), 'utf8');
    expect(serviceSrc).toMatch(/EXPLICIT freeze/);
    expect(serviceSrc).toMatch(/migration 0032/);
    // The regression proof exists: the integration test exercising the REAL
    // start path (startExperiment + claimExperimentStart) + born-frozen +
    // frozen-reject.
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'execution-policy', 'policy-freeze-on-start.integration.test.ts');
    expect(existsSync(testPath), 'policy-freeze-on-start.integration.test.ts must exist').toBe(true);
    const testSrc = readFileSync(testPath, 'utf8');
    expect(testSrc).toMatch(/experiment start FREEZES the project policy atomically/);
    expect(testSrc).toMatch(/BORN FROZEN/);
    expect(testSrc).toMatch(/rejects\.toThrow\(\/execution-policy-frozen\/\)/);
    // And the preference-advisory + fail-closed regressions exist.
    const regPath = join(BACKEND_ROOT, 'tests', 'integration', 'execution-policy', 'execution-policy.regression.test.ts');
    const regSrc = readFileSync(regPath, 'utf8');
    expect(regSrc).toMatch(/preferences are ADVISORY \(never hard eligibility constraints\)/);
    expect(regSrc).toMatch(/constrained modes FAIL CLOSED on unknown cost\/latency evidence/);
  });

  it('execution-policy constrained modes REQUIRE their caps at the policy boundary (§8 — no meaningless constrained policy can persist or evaluate)', () => {
    // PR #37 review final correction: fail-closed eligibility was not
    // enough — the system could still persist + return
    // COST_CONSTRAINED with maxCostCents=NULL (or LATENCY_CONSTRAINED with
    // maxDurationMs=NULL): labeled constrained while imposing no
    // constraint. The invariant is enforced at TWO boundaries:
    //   * the SERVICE (validateBenchmarkModeConstraint — merged-view on
    //     policy update + resolved-mode on recommendation);
    //   * the DATABASE (migration 0033's CHECK — no write path can persist
    //     a meaningless combination, including removing the cap while the
    //     mode stays constrained).
    const migrationPath = join(
      BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
      '0033_execution_policy_constrained_mode_requires_cap.sql',
    );
    expect(existsSync(migrationPath), '0033_execution_policy_constrained_mode_requires_cap.sql must exist').toBe(true);
    const src = readFileSync(migrationPath, 'utf8');
    // The CHECK constraint: both modes require their caps.
    expect(src).toMatch(/wfos_execution_policy_constrained_mode_requires_cap/);
    expect(src).toMatch(/default_benchmark_mode <> 'cost_constrained' OR max_cost_per_task_cents IS NOT NULL/);
    expect(src).toMatch(/default_benchmark_mode <> 'latency_constrained' OR max_time_to_pr_ms IS NOT NULL/);
    // The service validator exists + throws the domain error for both modes.
    const serviceSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'default-execution-policy-service.ts'), 'utf8');
    const fn = serviceSrc.match(/export function validateBenchmarkModeConstraint[\s\S]*?\n\}/);
    expect(fn, 'validateBenchmarkModeConstraint must exist').not.toBeNull();
    expect(fn![0]).toMatch(/'cost_constrained' && maxCostCents == null/);
    expect(fn![0]).toMatch(/'latency_constrained' && maxDurationMs == null/);
    expect(fn![0]).toMatch(/execution-policy-invalid-mode-constraint/);
    // Applied at POLICY UPDATE time (the MERGED view — existing + patch).
    const updateFn = serviceSrc.match(/async updateProjectPolicy[\s\S]*?\n  \}/)![0];
    expect(updateFn).toMatch(/validateBenchmarkModeConstraint\(/);
    expect(updateFn).toMatch(/input\.defaultBenchmarkMode \?\? existing\.defaultBenchmarkMode/);
    // Applied at RECOMMENDATION time (the RESOLVED mode vs the policy caps
    // — before the snapshot is built).
    const recommendFn = serviceSrc.match(/async recommend[\s\S]*?\n  \}/)![0];
    const modeIdx = recommendFn.indexOf('input.benchmarkMode ?? policy.defaultBenchmarkMode');
    const validateIdx = recommendFn.indexOf('validateBenchmarkModeConstraint(benchmarkMode');
    const snapshotIdx = recommendFn.indexOf('buildPolicySnapshot(policy, benchmarkMode)');
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(validateIdx).toBeGreaterThan(modeIdx);
    expect(snapshotIdx).toBeGreaterThan(validateIdx);
    // Exported from the domain barrel + mapped to HTTP 400 on BOTH routes.
    const indexSrc = readFileSync(join(EXEC_POLICY_DIR, 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/export \{ validateBenchmarkModeConstraint \}/);
    const routeSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution-policy.route.ts'), 'utf8');
    expect(routeSrc).toMatch(/execution-policy-invalid-mode-constraint/);
    expect(routeSrc).toMatch(/'invalid-mode-constraint'/);
    // Regression coverage: the reviewer's three required scenarios + the
    // merged directions + the recommendation-time rejection + the DB
    // backstop + the HTTP-level 400 mapping.
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'execution-policy', 'mode-constraint-validation.integration.test.ts');
    expect(existsSync(testPath), 'mode-constraint-validation.integration.test.ts must exist').toBe(true);
    const testSrc = readFileSync(testPath, 'utf8');
    expect(testSrc).toMatch(/COST_CONSTRAINED \+ null maxCost → rejected/);
    expect(testSrc).toMatch(/LATENCY_CONSTRAINED \+ null maxDuration → rejected/);
    expect(testSrc).toMatch(/valid constrained mode \+ cap → accepted/);
    expect(testSrc).toMatch(/removing the cap while the mode is COST_CONSTRAINED → rejected/);
    expect(testSrc).toMatch(/explicit constrained mode on a capless project → rejected/);
    expect(testSrc).toMatch(/DB CHECK rejects/);
    const e2eSrc = readFileSync(join(BACKEND_ROOT, 'tests', 'e2e-browser', 'work-033-execution-policy.spec.ts'), 'utf8');
    expect(e2eSrc).toMatch(/constrained mode without its cap → 400/);
  });

  it('execution-policy frozen-mode override is REJECTED at recommendation time (§9 — a decision cannot claim the frozen policyVersion under a different mode)', () => {
    // PR #37 review final blocker: a frozen project policy could still be
    // overridden at recommendation time with ?benchmarkMode=... even when
    // the frozen policy said benchmarkMode=maximum_capability /
    // policyVersion=N — the resulting decision would claim version N while
    // using a different mode, undermining the §9 immutability/audit
    // guarantee. The fix: in recommend(), an explicit benchmarkMode that
    // DIFFERS from the frozen policy's mode is rejected (the same mode is a
    // no-op; unfrozen policies keep the §16 request-scoped override).
    const serviceSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'default-execution-policy-service.ts'), 'utf8');
    const recommendFn = serviceSrc.match(/async recommend[\s\S]*?\n  \}/)![0];
    // The frozen-mode guard exists with the exact semantics (frozen +
    // explicit + differing).
    expect(recommendFn).toMatch(/policy\.frozen && input\.benchmarkMode != null && input\.benchmarkMode !== policy\.defaultBenchmarkMode/);
    // ...throwing the frozen-mode domain error (which includes the frozen
    // version + mode in the message for auditability).
    expect(recommendFn).toMatch(/execution-policy-frozen-mode: the project policy is frozen \(policyVersion=\$\{policy\.policyVersion\}, benchmarkMode=\$\{policy\.defaultBenchmarkMode\}\)/);
    // ORDERING: the frozen-mode guard MUST precede the mode-constraint
    // validation (a frozen-policy override is a frozen-state violation
    // first, not a missing-cap problem — the reviewer's scenario must
    // surface as the frozen rejection).
    const frozenIdx = recommendFn.indexOf('execution-policy-frozen-mode');
    const validateIdx = recommendFn.indexOf('validateBenchmarkModeConstraint(benchmarkMode');
    expect(frozenIdx).toBeGreaterThan(-1);
    expect(frozenIdx).toBeLessThan(validateIdx);
    // RecommendInput documents the frozen rejection (the public contract).
    const typesSrc = readFileSync(join(EXEC_POLICY_DIR, 'types.ts'), 'utf8');
    const recInput = typesSrc.match(/export interface RecommendInput[\s\S]*?\n\}/)![0];
    expect(recInput).toMatch(/FROZEN/);
    expect(recInput).toMatch(/REJECTED/);
    // The route maps it to HTTP 409 policy-frozen-mode.
    const routeSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution-policy.route.ts'), 'utf8');
    expect(routeSrc).toMatch(/execution-policy-frozen-mode/);
    expect(routeSrc).toMatch(/'policy-frozen-mode'/);
    // Regression coverage: frozen+differing rejected (multiple modes),
    // frozen+same allowed, frozen+none allowed, unfrozen override
    // preserved — + the HTTP-level 409 e2e.
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'execution-policy', 'mode-constraint-validation.integration.test.ts');
    const testSrc = readFileSync(testPath, 'utf8');
    expect(testSrc).toMatch(/frozen policy \+ a DIFFERING explicit benchmarkMode → rejected/);
    expect(testSrc).toMatch(/frozen policy \+ the SAME explicit benchmarkMode → not a frozen-mode rejection/);
    expect(testSrc).toMatch(/frozen policy \+ NO explicit benchmarkMode → uses the frozen mode/);
    expect(testSrc).toMatch(/UNFROZEN policy \+ a differing explicit benchmarkMode → the §16 override still works/);
    const e2eSrc = readFileSync(join(BACKEND_ROOT, 'tests', 'e2e-browser', 'work-033-execution-policy.spec.ts'), 'utf8');
    expect(e2eSrc).toMatch(/frozen-mode override → 409/);
  });

  it('execution-policy decision write is an ATOMIC SNAPSHOT VALIDATION (TOCTOU eliminated — every persisted decision claims one exact, currently authoritative policy version)', () => {
    // PR #37 review final concurrency gap: the read-time frozen-mode guard
    // was not race-safe — recommend() could read policy vN (unfrozen),
    // a concurrent request could mutate/freeze the policy to vN+1, and the
    // recommendation could still persist a decision claiming vN (with a
    // request-scoped mode valid only before the freeze). The decision
    // record is the authoritative audit of policyVersion / benchmarkMode /
    // candidates / why / evidence — it must describe ONE COHERENT policy
    // snapshot. The fix: the decision INSERT is ONE atomic statement
    // conditioned on the CURRENT policy row:
    //   current policy_version == snapshot version
    //   AND (current frozen = false OR decision mode == current default mode)
    // A mutation/freeze during the recommendation → no row → the retryable
    // stale-snapshot error (409) → the caller retries with the fresh policy.
    const repoSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'pg-execution-policy-repository.ts'), 'utf8');
    const fn = repoSrc.match(/async insertDecision[\s\S]*?\n  \}/);
    expect(fn, 'insertDecision must exist').not.toBeNull();
    const body = fn![0];
    // ONE atomic statement: the INSERT is gated by a CTE over the CURRENT
    // policy row (no separate check-then-insert window).
    expect(body).toMatch(/WITH current_policy AS \(/);
    expect(body).toMatch(/SELECT policy_version, frozen, default_benchmark_mode\s+FROM wfos_execution_policies/);
    // THE ROW LOCK (the follow-up review's finding): a plain SELECT reads
    // the STATEMENT-START snapshot, so a concurrent policy UPDATE
    // committing mid-statement could leave the decision persisted against
    // the OLD version. The current_policy read MUST take FOR UPDATE — the
    // locked read blocks on an in-flight concurrent UPDATE and then
    // re-fetches the NEWEST committed row (READ COMMITTED locked-read
    // semantics), serializing the decision boundary against every policy
    // writer.
    expect(body).toMatch(/WHERE project_id = \$2\s+FOR UPDATE/);
    // The version predicate (stale snapshot → no insert).
    expect(body).toMatch(/WHERE cp\.policy_version = \$14/);
    // The frozen/mode predicate (frozen + differing effective mode → no
    // insert — the belt-and-braces clause that holds even if a future
    // change made freezing version-neutral).
    expect(body).toMatch(/AND \(cp\.frozen = false OR \$6::text = cp\.default_benchmark_mode\)/);
    // Null (not a throw) on rejection — the SERVICE surfaces the retryable
    // error (separation of concerns: the repository guards, the service
    // decides the contract).
    expect(body).toMatch(/return res\.rows\[0\] \? mapDecision\(res\.rows\[0\]\) : null;/);
    // The interface requires the guard parameter (callers cannot bypass
    // the validation — there is NO unvalidated insert path).
    const typesInternalSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'execution-policy.types.ts'), 'utf8');
    expect(typesInternalSrc).toMatch(/insertDecision\([^)]*row: DecisionRow, guard: DecisionSnapshotGuard\): Promise<ExecutionPolicyDecisionRecord \| null>/);
    expect(typesInternalSrc).toMatch(/export interface DecisionSnapshotGuard/);
    // The service passes the snapshot version + throws the retryable
    // stale-snapshot error on null (with the request-scoped-mode note).
    const serviceSrc = readFileSync(join(EXEC_POLICY_INTERNAL, 'default-execution-policy-service.ts'), 'utf8');
    const recommendFn = serviceSrc.match(/async recommend[\s\S]*?\n  \}/)![0];
    expect(recommendFn).toMatch(/\{ snapshotPolicyVersion: policy\.policyVersion \}/);
    expect(recommendFn).toMatch(/if \(!decision\)/);
    expect(recommendFn).toMatch(/execution-policy-snapshot-stale: the project policy changed during the recommendation/);
    expect(recommendFn).toMatch(/retry with the fresh policy/);
    // The route maps it to a retryable HTTP 409.
    const routeSrc = readFileSync(join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution-policy.route.ts'), 'utf8');
    expect(routeSrc).toMatch(/execution-policy-snapshot-stale/);
    expect(routeSrc).toMatch(/'policy-snapshot-stale'/);
    // Regression coverage: the concurrent mutation race, the freeze race
    // (with the retry hitting the frozen-mode guard), the happy path, and
    // the repository-level clause isolation.
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'execution-policy', 'mode-constraint-validation.integration.test.ts');
    const testSrc = readFileSync(testPath, 'utf8');
    expect(testSrc).toMatch(/atomic decision snapshot validation \(TOCTOU elimination\)/);
    expect(testSrc).toMatch(/policy MUTATED during the recommendation → the decision insert is REJECTED/);
    expect(testSrc).toMatch(/policy FROZEN during the recommendation \(with a request-scoped mode\) → the decision insert is REJECTED/);
    expect(testSrc).toMatch(/NO mutation during the recommendation → the decision persists with the CURRENT version/);
    expect(testSrc).toMatch(/repository-level guard: each clause in isolation/);
    // The race is genuinely simulated MID-recommendation (the mutating
    // task-profile hook runs after the policy read + before the insert).
    expect(testSrc).toMatch(/buildRacingService/);
    // The follow-up review required the regression to exercise the ACTUAL
    // lock contention/interleaving — a real second connection holding the
    // policy row lock with an in-flight uncommitted UPDATE while the
    // guarded insert BLOCKS (proof of contention: 'still-blocked'), then
    // COMMIT → the newest row rejects the stale snapshot; ROLLBACK → the
    // original row accepts. On pglite (single-session) the closest
    // analogue runs (the in-flight update visible at the decision
    // boundary).
    expect(testSrc).toMatch(/decision boundary serializes against the policy writer \(FOR UPDATE row lock\)/);
    expect(testSrc).toMatch(/holds the row lock → the guarded decision insert WAITS/);
    expect(testSrc).toMatch(/'still-blocked'/);
    expect(testSrc).toMatch(/ROLLED BACK → the \(previously blocked\) insert unblocks against the ORIGINAL row/);
  });
});

describe('WORK-034 invariants — persistent agent session core (first slice)', () => {
  const AGENTS_INTERNAL = join(MODULES_DIR, 'agents', 'internal');
  const SESSION_TYPES = join(AGENTS_INTERNAL, 'execution-session.types.ts');
  const SESSION_REPO = join(AGENTS_INTERNAL, 'pg-execution-session-repository.ts');
  const MIGRATION_PATH = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0034_execution_sessions.sql',
  );

  function strip(src: string): string {
    return src
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*--.*$/gm, '');
  }

  it('session-core migration exists with the durable-core schema (UNIQUE execution, composite FK, version >= 0)', () => {
    // The slice's persistence contract, mechanically enforced:
    //   UNIQUE(execution_id) — exactly one session per ExecutionRecord;
    //   composite FK — project/work-item/work-order linkage consistent with
    //     the execution record;
    //   version >= 0 — the CAS token.
    expect(existsSync(MIGRATION_PATH), '0034_execution_sessions.sql must exist').toBe(true);
    const src = readFileSync(MIGRATION_PATH, 'utf8');
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS wfos_execution_sessions/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS wfos_execution_session_events/);
    // Exactly one session per ExecutionRecord.
    expect(src).toMatch(/CONSTRAINT wfos_execution_sessions_execution_unique UNIQUE \(execution_id\)/);
    // The linkage-consistency composite FK.
    expect(src).toMatch(/FOREIGN KEY \(execution_id, project_id, work_item_id, work_order_id\)/);
    expect(src).toMatch(/REFERENCES wfos_executions\(id, project_id, work_item_id, work_order_id\)/);
    // The CAS token constraint.
    expect(src).toMatch(/version INTEGER NOT NULL DEFAULT 0 CHECK \(version >= 0\)/);
    // The strict status vocabulary.
    expect(src).toMatch(/'created', 'running', 'interrupted', 'completed', 'failed', 'cancelled'/);
    // The event vocabulary (the 9 provider-independent types).
    expect(src).toMatch(/'turn_started', 'model_interaction', 'tool_call', 'observation',\s*'checkpoint', 'interrupted', 'resumed', 'completed', 'failed', 'cancelled'/);
    // UNIQUE(session_id, sequence_number).
    expect(src).toMatch(/CONSTRAINT wfos_execution_session_events_sequence_unique\s+UNIQUE \(session_id, sequence_number\)/);
  });

  it('session events are APPEND-ONLY (migration triggers reject UPDATE + DELETE + terminal appends)', () => {
    const src = readFileSync(MIGRATION_PATH, 'utf8');
    // Historical events are never updated or deleted.
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION wfos_execution_session_event_immutable/);
    expect(src).toMatch(/BEFORE UPDATE OR DELETE ON wfos_execution_session_events/);
    // Terminal sessions accept no further events.
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION wfos_execution_session_event_terminal_guard/);
    expect(src).toMatch(/BEFORE INSERT ON wfos_execution_session_events/);
  });

  it('the session state machine is STRICT + terminal states are FULLY immutable + the identity tuple is immutable (migration guards)', () => {
    const src = readFileSync(MIGRATION_PATH, 'utf8');
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION wfos_execution_session_transition_guard/);
    // Terminal FULL immutability (the audit correction): every authoritative
    // field is compared — status, version, current_turn, interrupted_at,
    // terminal_at, AND the identity tuple — not just the status.
    expect(src).toMatch(/execution-session-terminal-immutable/);
    expect(src).toMatch(/NEW\.version IS DISTINCT FROM OLD\.version/);
    expect(src).toMatch(/NEW\.current_turn IS DISTINCT FROM OLD\.current_turn/);
    expect(src).toMatch(/NEW\.interrupted_at IS DISTINCT FROM OLD\.interrupted_at/);
    expect(src).toMatch(/NEW\.terminal_at IS DISTINCT FROM OLD\.terminal_at/);
    // The no-op terminal update is explicitly allowed (harmless bookkeeping).
    expect(src).toMatch(/-- A terminal row with NO authoritative change: harmless/);
    // IDENTITY-TUPLE immutability (the audit correction): the execution
    // identity can never be re-targeted — a database invariant, not an
    // application convention. Applies to EVERY row state.
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION wfos_execution_session_identity_guard/);
    expect(src).toMatch(/execution-session-identity-immutable/);
    expect(src).toMatch(/BEFORE UPDATE ON wfos_execution_sessions\s+FOR EACH ROW EXECUTE FUNCTION wfos_execution_session_identity_guard/);
    // The strict legal edges (created→running/cancelled; running→interrupted/
    // completed/failed/cancelled; interrupted→running/cancelled).
    expect(src).toMatch(/OLD\.status = 'created'\s+AND NEW\.status IN \('running', 'cancelled'\)/);
    expect(src).toMatch(/OLD\.status = 'running'\s+AND NEW\.status IN \('interrupted', 'completed', 'failed', 'cancelled'\)/);
    expect(src).toMatch(/OLD\.status = 'interrupted'\s+AND NEW\.status IN \('running', 'cancelled'\)/);
    // Monotonic version + timestamp consistency.
    expect(src).toMatch(/execution-session-version-regression/);
    expect(src).toMatch(/execution-session-terminal-timestamp/);
    expect(src).toMatch(/execution-session-interrupted-timestamp/);
  });

  it('session state transitions use CAS (version + status predicate, version increment) — no read-check-write', () => {
    const repoSrc = strip(readFileSync(SESSION_REPO, 'utf8'));
    const transitionFn = repoSrc.match(/async transitionSession[\s\S]*?\n  \}/)!;
    // The CAS predicate: version AND status.
    expect(transitionFn[0]).toMatch(/WHERE id = \$1\s+AND version = \$2\s+AND status = \$4/);
    // The version increment.
    expect(transitionFn[0]).toMatch(/version = version \+ 1/);
    // Lost CAS → null (NOT a throw, NOT a read-check-write).
    expect(transitionFn[0]).toMatch(/return res\.rows\[0\] \? mapSession\(res\.rows\[0\]\) : null;/);
    // The turn CAS is version + status='running' guarded too.
    const turnFn = repoSrc.match(/async advanceTurn[\s\S]*?\n  \}/)!;
    expect(turnFn[0]).toMatch(/AND version = \$2\s+AND status = 'running'/);
    expect(turnFn[0]).toMatch(/version = version \+ 1/);
    // NO read-check-write transition anywhere: the repository never SELECTs a
    // session status and then UPDATEs unconditionally — every mutation in
    // the file is a guarded UPDATE ... WHERE (create/append are inserts).
    expect(repoSrc).not.toMatch(/getSession[\s\S]{0,200}UPDATE wfos_execution_sessions/);
  });

  it('a session has exactly ONE ExecutionRecord (repository never creates executions)', () => {
    // The session REFERENCES an existing execution — it never INSERTs into
    // wfos_executions (no second execution engine: executions remain owned
    // by the existing ExecutionService path).
    const repoSrc = strip(readFileSync(SESSION_REPO, 'utf8'));
    const typesSrc = strip(readFileSync(SESSION_TYPES, 'utf8'));
    expect(repoSrc).not.toMatch(/INSERT INTO wfos_executions\b/);
    expect(repoSrc).not.toMatch(/UPDATE wfos_executions\b/);
    expect(typesSrc).not.toMatch(/INSERT INTO wfos_executions\b/);
    // The session's continuation identity is the ExecutionRecord id.
    expect(typesSrc).toMatch(/executionId: string/);
    // The one-session-per-execution contract is documented on the type.
    expect(readFileSync(SESSION_TYPES, 'utf8')).toMatch(/UNIQUE\(execution_id\)/);
  });

  it('session core never mutates workflow / verification / review state', () => {
    for (const [name, path] of [['types', SESSION_TYPES], ['repository', SESSION_REPO]] as const) {
      const src = strip(readFileSync(path, 'utf8'));
      expect(src, `${name}: no workflow mutation`).not.toMatch(/INSERT INTO wfos_workflow|UPDATE wfos_workflow|DELETE FROM wfos_workflow/);
      expect(src, `${name}: no verification mutation`).not.toMatch(/INSERT INTO wfos_verification|UPDATE wfos_verification|DELETE FROM wfos_verification/);
      expect(src, `${name}: no review mutation`).not.toMatch(/INSERT INTO wfos_reviews|UPDATE wfos_reviews|DELETE FROM wfos_reviews/);
    }
  });

  it('session core imports no provider SDKs and creates no second ExecutionService/execution engine', () => {
    for (const [name, path] of [['types', SESSION_TYPES], ['repository', SESSION_REPO]] as const) {
      const src = strip(readFileSync(path, 'utf8'));
      expect(src, `${name}: no provider SDKs`).not.toMatch(/from ['"]@octokit|from ['"]openai|from ['"]anthropic|zai-sdk/);
      // No second ExecutionService: the session core never constructs or
      // declares one (it persists continuation state; execution stays the
      // existing ExecutionService's authority).
      expect(src, `${name}: no ExecutionService construction`).not.toMatch(/new \w*ExecutionService|implements ExecutionService|extends ExecutionService/);
      expect(src, `${name}: no class named *ExecutionService`).not.toMatch(/class \w*ExecutionService/);
    }
    // The migration stores no credentials (safe payload columns only —
    // strip comments first so doc words like "token" don't trip it).
    const migrationSrc = strip(readFileSync(MIGRATION_PATH, 'utf8'));
    expect(migrationSrc).not.toMatch(/secret|token|cookie|api_key/i);
  });

  it('the /agents barrel exposes exactly the provider-independent session contract (no provider specifics)', () => {
    const barrelSrc = readFileSync(join(MODULES_DIR, 'agents', 'index.ts'), 'utf8');
    // The five public contract names.
    const sessionExport = barrelSrc.match(/export type \{[\s\S]*?\} from '\.\/internal\/execution-session\.types\.js';/);
    expect(sessionExport, 'the session contract export block must exist').not.toBeNull();
    const block = sessionExport![0];
    expect(block).toMatch(/\bExecutionSession\b/);
    expect(block).toMatch(/\bExecutionSessionStatus\b/);
    expect(block).toMatch(/\bExecutionSessionEvent\b/);
    expect(block).toMatch(/\bExecutionSessionEventType\b/);
    expect(block).toMatch(/\bExecutionSessionRepository\b/);
    // Provider-INDEPENDENT: no provider names in the contract files or the
    // export block.
    for (const path of [SESSION_TYPES, SESSION_REPO]) {
      const src = readFileSync(path, 'utf8');
      expect(src, `${path}: no provider-specific session details`).not.toMatch(/\bopenai\b|\banthropic\b|\bzai\b|\bcodex\b|\bclaude\b|\bchatgpt\b/i);
    }
    // The barrel does NOT export the Pg implementation (repositories stay
    // under internal/).
    expect(barrelSrc).not.toMatch(/PgExecutionSessionRepository/);
    // The implementation lives under internal/.
    expect(existsSync(SESSION_REPO), 'pg-execution-session-repository.ts under internal/').toBe(true);
  });

  it('session-core regression tests exist (the required durable-core matrix)', () => {
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'execution-session-core.regression.test.ts');
    expect(existsSync(testPath), 'execution-session-core.regression.test.ts must exist').toBe(true);
    const src = readFileSync(testPath, 'utf8');
    expect(src).toMatch(/create session — status created, version 0, turn 0/);
    expect(src).toMatch(/duplicate execution → rejected/);
    expect(src).toMatch(/CAS transition winner → succeeds/);
    expect(src).toMatch(/CAS transition loser → null/);
    expect(src).toMatch(/append event → sequence increments/);
    expect(src).toMatch(/duplicate sequence → rejected/);
    expect(src).toMatch(/concurrent event append → unique sequences/);
    expect(src).toMatch(/interrupt → resumable; resume → exactly one state transition/);
    expect(src).toMatch(/terminal session → further mutation rejected/);
    expect(src).toMatch(/wrong project\/work-item\/work-order linkage → rejected/);
    // The audit-correction regressions: FULL terminal immutability (every
    // authoritative field), identity re-target rejection, + REAL typed
    // errors (instanceof + stable codes + structured context).
    expect(src).toMatch(/mutation of ANY authoritative field is rejected/);
    expect(src).toMatch(/execution identity tuple is IMMUTABLE/);
    expect(src).toMatch(/typed errors are REAL/);
    expect(src).toMatch(/expectSessionError/);
  });

  it('session-domain errors are REAL typed errors (discriminated class + stable codes + structured context — no string parsing)', () => {
    // The audit correction: the repository contract documents typed errors;
    // the implementation must deliver a discriminated ExecutionSessionError
    // class with a stable machine-readable code. Consumers assert
    // instanceof / switch on the code; they never parse message strings.
    const typesSrc = readFileSync(SESSION_TYPES, 'utf8');
    expect(typesSrc).toMatch(/export class ExecutionSessionError extends Error/);
    expect(typesSrc).toMatch(/readonly code: ExecutionSessionErrorCode;/);
    expect(typesSrc).toMatch(/readonly context: Readonly<Record<string, unknown>>;/);
    // The stable code list (the single source of truth).
    expect(typesSrc).toMatch(/'execution-session-duplicate-execution'/);
    expect(typesSrc).toMatch(/'execution-session-linkage-mismatch'/);
    expect(typesSrc).toMatch(/'execution-session-illegal-transition'/);
    expect(typesSrc).toMatch(/'execution-session-not-found'/);
    expect(typesSrc).toMatch(/'execution-session-terminal'/);
    expect(typesSrc).toMatch(/'execution-session-event-duplicate-sequence'/);
    // The repository throws the TYPED errors (not plain Error).
    const repoSrc = strip(readFileSync(SESSION_REPO, 'utf8'));
    expect(repoSrc).not.toMatch(/new Error\(\s*['"]execution-session-/);
    expect(repoSrc).toMatch(/new ExecutionSessionError\(/);
    // The class + code list are exported from the /agents barrel (the
    // public contract for programmatic handling).
    const barrelSrc = readFileSync(join(MODULES_DIR, 'agents', 'index.ts'), 'utf8');
    expect(barrelSrc).toMatch(/export \{ ExecutionSessionError, EXECUTION_SESSION_ERROR_CODES \}/);
    expect(barrelSrc).toMatch(/export type \{ ExecutionSessionErrorCode \}/);
  });
});

describe('WORK-034 invariants — session-aware execution integration', () => {
  const AGENTS_INTERNAL = join(MODULES_DIR, 'agents', 'internal');
  const SESSION_TYPES = join(AGENTS_INTERNAL, 'execution-session.types.ts');
  const SESSION_REPO = join(AGENTS_INTERNAL, 'pg-execution-session-repository.ts');
  const SESSION_SERVICE = join(AGENTS_INTERNAL, 'execution-session-service.ts');
  const EXECUTION_SERVICE = join(AGENTS_INTERNAL, 'execution-service.ts');
  const NATIVE_PROVIDER = join(AGENTS_INTERNAL, 'native-execution-provider.ts');
  const EXTERNAL_PROVIDER = join(AGENTS_INTERNAL, 'external-execution-provider.ts');

  function strip(src: string): string {
    return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  it('the providers are NOT session-aware (session lifecycle stays /agents-owned — no second session authority)', () => {
    // The session integration must not turn a provider into a second
    // session authority: the providers keep provider-owned execution
    // behavior; the session lifecycle is owned by the ExecutionService
    // integration + the session service (both /agents-owned).
    for (const p of [NATIVE_PROVIDER, EXTERNAL_PROVIDER]) {
      const src = readFileSync(p, 'utf8');
      expect(src, `${p}: no session references`).not.toMatch(/sessionRepository|ExecutionSession|sessionService|transitionWithEvent/i);
    }
  });

  it('the session service NEVER dispatches execution + never creates a second ExecutionService/engine', () => {
    const src = strip(readFileSync(SESSION_SERVICE, 'utf8'));
    // No execution dispatch (no provider submission, no AgentGateway).
    expect(src).not.toMatch(/\.submit\(/);
    expect(src).not.toMatch(/AgentGateway|agentGateway/);
    expect(src).not.toMatch(/new \w*ExecutionService|implements ExecutionService\b|class \w*ExecutionService/);
    // No ExecutionRecord creation (the session CONTINUES an existing
    // record — it never INSERTs executions).
    expect(src).not.toMatch(/INSERT INTO wfos_executions|\.create\(\s*\{[^}]*implementationContextId/);
    // No workflow / verification / review mutation.
    expect(src).not.toMatch(/INSERT INTO wfos_workflow|UPDATE wfos_workflow|DELETE FROM wfos_workflow/);
    expect(src).not.toMatch(/INSERT INTO wfos_verification|UPDATE wfos_verification|DELETE FROM wfos_verification/);
    expect(src).not.toMatch(/INSERT INTO wfos_reviews|UPDATE wfos_reviews|DELETE FROM wfos_reviews/);
  });

  it('the ExecutionService session integration is OPTIONAL (pre-WORK-034 wiring keeps working) + uses only the session service boundary', () => {
    const src = readFileSync(EXECUTION_SERVICE, 'utf8');
    // The dep is optional.
    expect(src).toMatch(/readonly sessionService\?: ExecutionSessionService;/);
    // The integration goes through the session service boundary ONLY (no
    // direct session-repository access from the execution service).
    expect(src).not.toMatch(/sessionRepository|PgExecutionSessionRepository/);
    // Session-aware steps are guarded by the optional dep.
    const occurrences = src.split('this.deps.sessionService').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(4); // the guard checks + the calls
    // The submit() contract is unchanged (no second submit path).
    expect(src).toMatch(/async submit\(task: ExecutionTask\): Promise<ExecutionSubmitResult>/);
  });

  it('transitionWithEvent is a LOCKED-TRANSACTION atomic CAS + event append (loser writes NOTHING)', () => {
    const src = strip(readFileSync(SESSION_REPO, 'utf8'));
    const fn = src.match(/async transitionWithEvent[\s\S]*?\n  \}/)!;
    // The row lock (the same serialized pattern appendEvent uses).
    expect(fn[0]).toMatch(/SELECT status, version FROM wfos_execution_sessions WHERE id = \$1 FOR UPDATE/);
    // The CAS check under the lock (loser → null BEFORE any write).
    expect(fn[0]).toMatch(/currentStatus !== expectedStatus \|\| currentVersion !== expectedVersion/);
    expect(fn[0]).toMatch(/return null;/);
    // The CAS UPDATE retains the version + status predicate.
    expect(fn[0]).toMatch(/WHERE id = \$1\s+AND version = \$2\s+AND status = \$4/);
    // The event append uses the existing store (MAX+1 under the lock).
    expect(fn[0]).toMatch(/INSERT INTO wfos_execution_session_events/);
    expect(fn[0]).toMatch(/COALESCE\(MAX\(e\.sequence_number\), 0\) \+ 1/);
    // Illegal edges are typed errors.
    expect(readFileSync(SESSION_REPO, 'utf8')).toMatch(/execution-session-illegal-transition/);
    // ORDERING (PR #38 review — uniform): the CAS UPDATE runs FIRST and
    // the event is appended ONLY when the update returned a row — a lost
    // CAS writes NOTHING (no duplicate events under any interleaving).
    expect(fn[0].match(/await casUpdate\(\)/g)).toHaveLength(1);
    const updIdx2 = fn[0].indexOf('const updRes = await casUpdate();');
    const guardIdx2 = fn[0].indexOf('if (!updRes.rows[0]) return null;');
    expect(updIdx2).toBeGreaterThan(-1);
    expect(guardIdx2).toBeGreaterThan(updIdx2);
  });

  it('the session service contract + implementation exist; the barrel exposes the provider-independent names', () => {
    const typesSrc = readFileSync(SESSION_TYPES, 'utf8');
    expect(typesSrc).toMatch(/export interface ExecutionSessionService\b/);
    for (const m of ['ensureSession', 'startSession', 'interruptSession', 'resumeSession', 'completeSession', 'failSession', 'getSessionForExecution', 'listSessionEvents']) {
      expect(typesSrc, `the contract must declare ${m}`).toMatch(new RegExp(m + '\\('));
    }
    expect(existsSync(SESSION_SERVICE)).toBe(true);
    const barrelSrc = readFileSync(join(MODULES_DIR, 'agents', 'index.ts'), 'utf8');
    expect(barrelSrc).toMatch(/ExecutionSessionService,/);
    expect(barrelSrc).toMatch(/SessionTransitionResult,/);
    // Provider-independent: no provider names in the service.
    expect(readFileSync(SESSION_SERVICE, 'utf8')).not.toMatch(/\bopenai\b|\banthropic\b|\bzai\b|\bcodex\b|\bclaude\b|\bchatgpt\b/i);
  });

  it('the integration regression suite exists (the 14 required scenarios)', () => {
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'execution-session-integration.regression.test.ts');
    expect(existsSync(testPath)).toBe(true);
    const src = readFileSync(testPath, 'utf8');
    expect(src).toMatch(/native execution creates exactly ONE session bound to the SAME execution identity/);
    expect(src).toMatch(/duplicate session creation for the same execution is rejected/);
    expect(src).toMatch(/external execution uses the SAME session identity/);
    expect(src).toMatch(/external terminal ingestion hook completes the session through the same identity/);
    expect(src).toMatch(/session start is CAS-protected/);
    expect(src).toMatch(/concurrent session start has exactly ONE winner/);
    expect(src).toMatch(/interrupt → resume preserves the SAME executionId\/session\/identity; concurrent resume has ONE winner; no second ExecutionRecord/);
    expect(src).toMatch(/session terminal state does NOT mutate workflow \/ verification \/ review state/);
    expect(src).toMatch(/provider failure produces session FAILURE/);
    expect(src).toMatch(/session identity remains stable across native\/external execution paths/);
    expect(src).toMatch(/retry after interruption does not create duplicate sessions/);
  });

  it('PR #38 review: session-terminal reconciliation is DURABLE (obligation atomic with the record terminal transition + relay job + boot sweep — no scheduler)', () => {
    // The blocking durability gap: terminalization was best-effort after
    // the record became authoritative (catch + log), so a crash left
    // ExecutionRecord=completed with ExecutionSession=running
    // PERMANENTLY. The fix (the reviewer's prescribed architecture):
    //   ExecutionRecord terminal → durable obligation (ATOMIC with the
    //   record's transition) → existing Queue/WorkerHost → CAS
    //   session terminalization.
    const migrationPath = join(
      BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
      '0035_session_terminal_obligations.sql',
    );
    expect(existsSync(migrationPath), '0035_session_terminal_obligations.sql must exist').toBe(true);
    const m = readFileSync(migrationPath, 'utf8');
    // The obligation table + the work-list index.
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS wfos_execution_session_terminal_obligations/);
    expect(m).toMatch(/WHERE discharged_at IS NULL/);
    // ATOMIC creation: the AFTER UPDATE trigger on the EXECUTIONS table
    // (the record's terminal transition writes the obligation in the same
    // statement's transaction — no window).
    expect(m).toMatch(/AFTER UPDATE ON wfos_executions/);
    expect(m).toMatch(/NEW\.status IN \('completed', 'failed'\)/);
    expect(m).toMatch(/ON CONFLICT \(execution_id\) DO NOTHING/);
    // Append-only intent + at most one obligation per execution.
    expect(m).toMatch(/UNIQUE \(execution_id\)/);
    expect(m).toMatch(/session-terminal-obligation-immutable/);
    // The relay (the existing generic OutboxRelay — NOT a scheduler).
    const relaySrc = readFileSync(join(AGENTS_INTERNAL, 'session-terminal-relay.ts'), 'utf8');
    expect(relaySrc).toMatch(/class SessionTerminalOutboxRelay implements OutboxRelay/);
    expect(relaySrc).toMatch(/'agents\.session-terminal\.reconcile'/);
    expect(relaySrc).toMatch(/listPendingTerminalObligations/);
    const relayCode = relaySrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(relayCode).not.toMatch(/setInterval|setTimeout|setImmediate/);
    // The handler delegates to the idempotent reconciliation (fire-once).
    expect(relaySrc).toMatch(/reconcileTerminalForExecution/);
    // The service: durable reconciliation + the claim-time enqueue.
    const svcSrc = readFileSync(SESSION_SERVICE, 'utf8');
    expect(svcSrc).toMatch(/reconcileTerminalForExecution/);
    expect(svcSrc).toMatch(/reconcileAllPendingTerminals/);
    expect(svcSrc).toMatch(/SESSION_TERMINAL_RELAY_JOB_TYPE/);
    // The repository contract: the obligation queries + idempotent discharge.
    const repoTypes = readFileSync(SESSION_TYPES, 'utf8');
    expect(repoTypes).toMatch(/listPendingTerminalObligations/);
    expect(repoTypes).toMatch(/dischargeTerminalObligation/);
    // app.ts: the relay + handler + boot sweep wiring.
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc).toMatch(/new SessionTerminalOutboxRelay\(/);
    expect(appSrc).toMatch(/createSessionTerminalRelayJobHandler\(/);
    expect(appSrc).toMatch(/\.\.\.\(sessionTerminalRelay \? \[sessionTerminalRelay\] : \[\]\)/);
    // The regression suite (the five required scenarios).
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'session-terminal-durability.regression.test.ts');
    expect(existsSync(testPath)).toBe(true);
    const t = readFileSync(testPath, 'utf8');
    expect(t).toMatch(/execution completes \+ the session write fails \(crash window\) → the durable obligation \+ relay recover → session completed/);
    expect(t).toMatch(/execution fails \+ the session write fails \(crash window\) → recovery → session failed/);
    expect(t).toMatch(/recovery repeated/);
    expect(t).toMatch(/concurrent recovery/);
    expect(t).toMatch(/non-terminal execution → no obligation, no terminal session/);
  });

  it('PR #38 review: transitionWithEvent uses UNIFORM CAS-FIRST ordering (a loser writes NOTHING — no duplicate terminal events under any interleaving)', () => {
    const src = strip(readFileSync(SESSION_REPO, 'utf8'));
    const fn = src.match(/async transitionWithEvent[\s\S]*?\n  \}/)!;
    // The CAS UPDATE runs FIRST (once — no per-kind branches).
    expect(fn[0].match(/await casUpdate\(\)/g)).toHaveLength(1);
    const updIdx = fn[0].indexOf('const updRes = await casUpdate();');
    const evIdx = fn[0].indexOf('await appendEvent();');
    const terminalEvIdx = fn[0].indexOf(`isTerminal`);
    expect(updIdx).toBeGreaterThan(-1);
    // The guard: the event is appended ONLY when the update returned a row.
    const guardIdx = fn[0].indexOf('if (!updRes.rows[0]) return null;');
    expect(guardIdx).toBeGreaterThan(updIdx);
    expect(evIdx === -1 || evIdx > guardIdx).toBe(true);
    // The terminal append's WHERE clause re-checks the UPDATED row's
    // (version, status) — the event is keyed to exactly that transition.
    expect(fn[0]).toMatch(/AND EXISTS \(\s*SELECT 1 FROM wfos_execution_sessions s\s*WHERE s\.id = \$1 AND s\.version = \$4 AND s\.status = \$5\s*\)/);
    void terminalEvIdx;
  });

  it('PR #38 review: the terminal-event guard allows exactly the terminal event itself on a terminal row (the atomic transition+event composition)', () => {
    const m34 = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0034_execution_sessions.sql'), 'utf8');
    // The refined guard: a terminal event whose event_type EQUALS the
    // session's terminal status is allowed (the repository appends it in
    // the same transaction as the CAS that terminalized the row); any
    // OTHER event on a terminal session is still rejected.
    expect(m34).toMatch(/IF NEW\.event_type = s THEN/);
    expect(m34).toMatch(/RETURN NEW; -- the terminal event itself/);
  });

  it('app.ts wires the session service into the execution service + the external terminal hook', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    // The session service is constructed + injected.
    expect(appSrc).toMatch(/new DefaultExecutionSessionService\(/);
    expect(appSrc).toMatch(/sessionService: executionSessionService,/);
    // The external terminal hook completes/fails the session through the
    // same logical execution identity (best-effort).
    expect(appSrc).toMatch(/executionSessionService\.completeSession\(execId\)/);
    expect(appSrc).toMatch(/executionSessionService\.failSession\(execId/);
  });
});
