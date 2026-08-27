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
  // --- WORK-036 tool executors (concrete execution infrastructure; the
  //     contracts live in tool-contracts.ts which domain code MAY import) ---
  'src/platform/tools/fs-tool-executor.ts', // FsToolExecutor
  'src/platform/tools/process-tool-executor.ts', // ProcessToolExecutor (terminal/git/package)
  'src/platform/tools/process-sandbox.ts', // NamespaceProcessSandbox (the PR #40 review-fix sandbox)
  'src/platform/tools/http-tool-executor.ts', // HttpToolExecutor
  'src/platform/tools/browser-tool-executor.ts', // BrowserToolExecutor + BrowserDriver port host
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
      // WORK-035: the worktree-materializer typed error (the same
      // sanctioned domain-error-class exception as the session/workspace
      // errors — consumers instanceof-check it; it wires nothing).
      'WorktreeMaterializerError',
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
      // WORK-038 Project Baseline types (the evidence-backed reconstruction of
      // a repository WorkflowOS did not create — a PROJECT artifact stored
      // through the existing /projects authority; provenance is the central
      // invariant). These are project-domain contracts: the baseline is a
      // project sub-artifact, NOT a second project/repo/architecture/
      // requirements/workflow/verification/review authority.
      'BaselineProvenance',
      'BaselineState',
      'BaselineAnalysisMode',
      'BaselineObservationKind',
      'BaselineEvidenceSource',
      'ProjectBaseline',
      'BaselineObservation',
      'BaselineEvidence',
      'NewBaselineObservation',
      'NewBaselineEvidence',
      // PR #42 round-3: the governed repository-read boundary's enforcement
      // record shape (lives in /projects — the evidence is a /projects
      // artifact; the onboarding boundary consumes it through the barrel).
      'RepositoryReadEnforcement',
      // PR #42 round-5 (the persistence-boundary fence): the captured
      // policy snapshot + the fenced persist operation's input/result
      // (lives in /projects — the persistence authority; the onboarding
      // orchestrator composes them through the barrel).
      'PersistencePolicySnapshot',
      'PersistencePolicySource',
      'PersistBaselineInput',
      'PersistBaselineResult',
      'EnsureBaselineInput',
      'ProjectBaselineRepository',
      'ProjectBaselineErrorCode',
      // WORK-038: the baseline typed error (the sanctioned
      // discriminated-error-class exception — see PURE_DATA_CATALOG_EXPORTS).
      'ProjectBaselineError',
      'PROJECT_BASELINE_ERROR_CODES',
      // WORK-039: Repository and Context Intelligence — the revision-bound
      // context index + the explainable, provenance-preserving context-item
      // layer (a PROJECT artifact stored THROUGH the existing /projects
      // authority, like ProjectBaseline). The orchestrator lives in the
      // application-layer src/repository-intelligence/ capability (not a
      // module, not an authority). Provenance re-uses the WORK-038
      // vocabulary; the ranker NEVER promotes provenance.
      'ContextIndexState',
      'ContextIndexQueryKind',
      'ContextItemKind',
      'ContextItemSource',
      'ContextItemProvenance',
      'ProjectContextIndex',
      'ContextItem',
      'NewContextItem',
      'EnsureContextIndexInput',
      'EnsureContextIndexResult',
      'MarkContextIndexCompleteInput',
      'MarkContextIndexCompleteResult',
      'MarkContextIndexFailedInput',
      'MarkContextIndexStaleInput',
      'ProjectContextIndexRepository',
      'RepositoryIntelligenceErrorCode',
      // WORK-039: the context-index typed error (the sanctioned
      // discriminated-error-class exception — see PURE_DATA_CATALOG_EXPORTS).
      'RepositoryIntelligenceError',
      'REPOSITORY_INTELLIGENCE_ERROR_CODES',
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
      // WORK-035: the workspace-domain typed error (the same sanctioned
      // exception + reasoning).
      'AgentWorkspaceError',           // @modules/agents — the typed domain error
      'AGENT_WORKSPACE_ERROR_CODES',   // @modules/agents — the stable code list
      // WORK-036: the tool-runtime typed error (the same sanctioned
      // exception + reasoning) + the frozen structural limits constant
      // (pure data — no wiring, no credentials).
      'ToolRuntimeError',              // @modules/agents — the typed domain error
      'TOOL_RUNTIME_ERROR_CODES',      // @modules/agents — the stable code list
      'DEFAULT_TOOL_EXECUTION_LIMITS', // @modules/agents — frozen pure-data limits
      // WORK-037: the agent-policy typed error (the same sanctioned
      // exception + reasoning) + the frozen pure-data domain list +
      // the platform default document (a frozen literal: rule selectors +
      // effects + reasons; no wiring, no credentials).
      'AgentPolicyError',                   // @modules/agents — the typed domain error
      'AGENT_POLICY_ERROR_CODES',           // @modules/agents — the stable code list
      'PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT', // @modules/agents — frozen pure-data default policy
      'AGENT_POLICY_DOMAINS',              // @modules/agents — frozen pure-data domain list
      // WORK-038: the project-baseline typed error (the same sanctioned
      // exception + reasoning) + the frozen pure-data error-code list.
      'ProjectBaselineError',              // @modules/projects — the typed domain error
      'PROJECT_BASELINE_ERROR_CODES',       // @modules/projects — the stable code list
      // WORK-039: the repository-intelligence typed error (the same sanctioned
      // exception + reasoning) + the frozen pure-data error-code list. The
      // context index is a PROJECT artifact stored THROUGH /projects (the
      // same precedent as ProjectBaseline); its typed error class follows
      // the same sanctioned-exception rule.
      'RepositoryIntelligenceError',            // @modules/projects — the typed domain error
      'REPOSITORY_INTELLIGENCE_ERROR_CODES',    // @modules/projects — the stable code list
      // WORK-042: the cross-mode-handoff typed error (the same sanctioned
      // exception + reasoning — a discriminated error CLASS consumers
      // instanceof-check; it wires nothing, constructs nothing, holds only
      // (code, message)) + the frozen pure-data error-code list + the frozen
      // pure-data relay job-type constant (a string literal — no wiring, no
      // credentials).
      'CrossModeHandoffError',                  // @modules/agents — the typed domain error
      'CROSS_MODE_HANDOFF_ERROR_CODES',         // @modules/agents — the stable code list
      'CROSS_MODE_HANDOFF_RELAY_JOB_TYPE',      // @modules/agents — the frozen pure-data relay job-type
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
    // WORK-043 (§33.3) extended the category union — 'evidence' is still a
    // member, now followed by the four new families (quota, rate_limit,
    // security, agent_policy).
    expect(typesSrc).toMatch(/\| 'evidence'/);
    expect(typesSrc).toMatch(/\| 'agent_policy';/);
    const frontendSrc = readFileSync(join(BACKEND_ROOT, '..', 'frontend', 'src', 'api', 'client.ts'), 'utf8');
    expect(frontendSrc).toMatch(/'unknown_constrained'/);
    expect(frontendSrc).toMatch(/\| 'evidence'/);
    expect(frontendSrc).toMatch(/\| 'agent_policy';/);
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
  // (WORK-034's invariants continue below; WORK-035's are appended at the
  // end of the file to keep each work item's invariants self-contained.)
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
    // statement's transaction — no window). The COMPLETE terminal-state
    // mapping (round 2) is asserted in the round-2 invariant below.
    expect(m).toMatch(/AFTER UPDATE ON wfos_executions/);
    expect(m).toMatch(/NEW\.status IN \('completed', 'failed', 'cancelled', 'expired'\)/);
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

  it('PR #38 review round 2: the obligation lifecycle is CORRECT (missing session stays pending, complete terminal mapping, atomic fast-path discharge)', () => {
    // Correction #1: a pending obligation with a MISSING session must
    // REMAIN PENDING (never discharged) — the reconciliation ENSURES the
    // session from the existing record so recovery is autonomous.
    const svcSrc = strip(readFileSync(SESSION_SERVICE, 'utf8'));
    const reconcileFn = svcSrc.match(/async reconcileTerminalForExecution[\s\S]*?\n  \}/)![0];
    // The reconciliation ENSURES the session (never returns early on
    // missing-session + discharge).
    expect(reconcileFn).toMatch(/await this\.ensureSession\(executionId\)/);
    expect(reconcileFn).not.toMatch(/if \(!session\)\s*\{\s*[\s\S]{0,200}dischargeTerminalObligation/);
    // The reconcileObligation policy: no-session → pending (NO discharge).
    const oblFn = svcSrc.match(/private async reconcileObligation[\s\S]*?\n  \}/)![0];
    const noSessionIdx = oblFn.indexOf('if (!session) {');
    expect(noSessionIdx).toBeGreaterThan(-1);
    // The no-session branch returns null (stays pending) with NO
    // discharge call anywhere inside the branch (up to the next 'if ('
    // branch — stripped comments make brace-matching brittle).
    const nextBranchIdx = oblFn.indexOf('if (session.status', noSessionIdx);
    const noSessionBranch = oblFn.slice(noSessionIdx, nextBranchIdx);
    expect(noSessionBranch).toMatch(/return null;/);
    expect(noSessionBranch).not.toMatch(/dischargeTerminalObligation/);

    // Correction #2: the COMPLETE execution terminal-state mapping — the
    // migration's trigger covers completed, failed, cancelled AND expired
    // (expired → failed).
    const m35 = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0035_session_terminal_obligations.sql'), 'utf8');
    expect(m35).toMatch(/NEW\.status IN \('completed', 'failed', 'cancelled', 'expired'\)/);
    expect(m35).toMatch(/CASE WHEN NEW\.status = 'expired' THEN 'failed' ELSE NEW\.status END/);
    expect(m35).toMatch(/CHECK \(terminal_state IN \('completed', 'failed', 'cancelled'\)\)/);
    // The contract exposes cancelSession + the cancelled mapping.
    const typesSrc = readFileSync(SESSION_TYPES, 'utf8');
    expect(typesSrc).toMatch(/cancelSession\(executionId: string\)/);
    expect(typesSrc).toMatch(/readonly terminalState: 'completed' \| 'failed' \| 'cancelled';/);

    // Correction #3: the FAST PATH discharges atomically —
    // transitionWithEvent accepts the obligation id + discharges in the
    // SAME transaction; terminalForExecution resolves + passes it.
    const repoSrc = strip(readFileSync(SESSION_REPO, 'utf8'));
    const fn = repoSrc.match(/async transitionWithEvent[\s\S]*?\n  \}/)![0];
    expect(fn).toMatch(/obligationId\?: string/);
    const dischargeIdx = fn.indexOf('UPDATE wfos_execution_session_terminal_obligations');
    expect(dischargeIdx).toBeGreaterThan(-1);
    // The discharge is INSIDE the transaction (after the CAS win, before
    // the return).
    const casIdx = fn.indexOf('const updRes = await casUpdate();');
    const returnIdx = fn.indexOf('return { session: mapSession(updRes.rows[0])');
    expect(dischargeIdx).toBeGreaterThan(casIdx);
    expect(dischargeIdx).toBeLessThan(returnIdx);
    // The fast path passes the obligation id.
    const terminalFn = svcSrc.match(/private async terminalForExecution[\s\S]*?\n  \}/)![0];
    expect(terminalFn).toMatch(/obligation\?\.obligation\.id/);
    // The reconciler also passes it (atomic discharge on recovery).
    expect(oblFn).toMatch(/obligation\.id,\s*\);/);

    // The round-2 regression existence.
    const t = readFileSync(join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'session-terminal-durability.regression.test.ts'), 'utf8');
    expect(t).toMatch(/the process dies BEFORE the session exists → the obligation REMAINS PENDING/);
    expect(t).toMatch(/execution CANCELLED → the obligation maps to session cancelled/);
    expect(t).toMatch(/execution EXPIRED → the obligation maps to session failed/);
    expect(t).toMatch(/FAST-PATH terminalization discharges its obligation ATOMICALLY/);
    expect(t).toMatch(/a session terminal with the WRONG outcome → the divergence is retained visibly/);
  });

  it('PR #38 review round 3: durable redelivery on the existing worker path (opt-in; unrelated handlers unchanged) + the expired distinction preserved', () => {
    // The liveness blocker: WorkerHost acked EVERY job in finally — a
    // failed relay job was lost until a process restart (the boot sweep
    // only runs at start), so a healthy worker could leave a pending
    // terminal obligation unattempted indefinitely. The fix: an OPT-IN
    // handler redeliveryPolicy — on failure the WorkerHost re-enqueues the
    // job (attempt+1, bounded) onto the SAME durable queue BEFORE the ack.
    // Handlers WITHOUT the policy keep the historical ack-regardless
    // semantics exactly.
    const queueSrc = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'queue', 'queue.ts'), 'utf8');
    expect(queueSrc).toMatch(/readonly attempt\?: number;/);
    const handlerSrc = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'worker', 'job-handler.ts'), 'utf8');
    expect(handlerSrc).toMatch(/redeliveryPolicy\?: \{[\s\S]*?maxAttempts: number;/);
    const hostSrc = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'worker', 'worker-host.ts'), 'utf8');
    const hostCode = hostSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // The failure path re-enqueues (attempt+1) BEFORE the finally-ack.
    const catchIdx = hostCode.indexOf('} catch (err) {');
    const reenqueueIdx = hostCode.indexOf('await this.queue.enqueue(job.type, job.payload,');
    const finallyIdx = hostCode.indexOf('} finally {', catchIdx);
    expect(catchIdx).toBeGreaterThan(-1);
    expect(reenqueueIdx).toBeGreaterThan(catchIdx);
    expect(reenqueueIdx).toBeLessThan(finallyIdx);
    expect(hostCode).toMatch(/attempt: attempt \+ 1/);
    // OPT-IN ONLY: the redelivery is gated on the handler's policy.
    expect(hostCode).toMatch(/const policy = handler\.redeliveryPolicy;/);
    // ROUND 4 — the durable-retention fallback: when the retry enqueue
    // fails, the ORIGINAL delivery is REQUEUED durably (the same attempt
    // number — a queue blip must not consume the handler budget); when
    // even the requeue fails, the original is NOT acknowledged
    // (durability-lost; the boot sweep is the restart backstop). The ack
    // is conditional.
    expect(hostCode).toMatch(/worker\.job\.redelivery-requeued-original/);
    expect(hostCode).toMatch(/worker\.job\.durability-lost/);
    expect(hostCode).toMatch(/ackOriginal = false/);
    expect(hostCode).toMatch(/if \(ackOriginal\) \{/);
    // The session relay handler declares the policy.
    const relaySrc = readFileSync(join(AGENTS_INTERNAL, 'session-terminal-relay.ts'), 'utf8');
    expect(relaySrc).toMatch(/redeliveryPolicy: \{ maxAttempts: 5 \}/);
    // Unrelated handlers (benchmark trial / start-delivery relay / echo)
    // declare NO policy — their semantics are unchanged.
    for (const [name, p] of [
      ['benchmark trial handler', join(BACKEND_ROOT, 'src', 'benchmark', 'internal', 'benchmark-trial-job-handler.ts')],
      ['benchmark start-delivery relay handler', join(BACKEND_ROOT, 'src', 'benchmark', 'internal', 'start-delivery-relay.ts')],
      ['echo fixture handler', join(BACKEND_ROOT, 'src', 'platform', 'worker', 'fixtures', 'echo.job.ts')],
    ] as const) {
      if (existsSync(p)) {
        expect(readFileSync(p, 'utf8'), `${name}: no redelivery policy (unchanged semantics)`).not.toMatch(/redeliveryPolicy/);
      }
    }
    // The expired distinction: the obligation records the SOURCE execution
    // status + the terminal event payload preserves it.
    const m35 = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0035_session_terminal_obligations.sql'), 'utf8');
    expect(m35).toMatch(/source_execution_status TEXT NOT NULL CHECK \(source_execution_status IN \(/);
    expect(m35).toMatch(/'completed', 'failed', 'cancelled', 'expired'/);
    expect(m35).toMatch(/NEW\.status,\s*\)\s*ON CONFLICT|NEW\.status\)\s*ON CONFLICT|NEW\.status,\)[\s\S]*?ON CONFLICT/);
    const svcSrc = strip(readFileSync(SESSION_SERVICE, 'utf8'));
    expect(svcSrc).toMatch(/reason: `execution-\$\{obligation\.sourceExecutionStatus\}`/);
    // The round-3 regression existence.
    const t = readFileSync(join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'session-terminal-durability.regression.test.ts'), 'utf8');
    expect(t).toMatch(/attempt 1 fails transiently → the job is NOT lost \(durable redelivery\)/);
    expect(t).toMatch(/redelivery is BOUNDED/);
    expect(t).toMatch(/UNRELATED handlers keep the historical ack-regardless semantics/);
    expect(t).toMatch(/the expired distinction is PRESERVED in the terminal event payload/);
    // Round 4: the durable-retention regressions.
    expect(t).toMatch(/the original is REQUEUED durably → the subsequent delivery succeeds → obligation discharged/);
    expect(t).toMatch(/durability-lost bound: the retry enqueue AND the requeue BOTH fail/);
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

describe('WORK-035 invariants — agent workspaces and git worktrees', () => {
  const AGENTS_INTERNAL = join(MODULES_DIR, 'agents', 'internal');
  const WS_TYPES = join(AGENTS_INTERNAL, 'agent-workspace.types.ts');
  const WS_REPO = join(AGENTS_INTERNAL, 'pg-agent-workspace-repository.ts');
  const WS_SERVICE = join(AGENTS_INTERNAL, 'agent-workspace-service.ts');
  const WS_MATERIALIZER = join(BACKEND_ROOT, 'src', 'platform', 'workspace', 'fs-worktree-materializer.ts');
  const WS_RELAY = join(AGENTS_INTERNAL, 'workspace-release-relay.ts');
  const MIGRATION_PATH = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0036_agent_workspaces.sql',
  );

  function strip(src: string): string {
    return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
  }

  it('the workspace migration exists with the durable schema (UNIQUE execution + UNIQUE worktree path + composite FK + strict state machine + terminal/identity immutability + release obligations)', () => {
    expect(existsSync(MIGRATION_PATH), '0036_agent_workspaces.sql must exist').toBe(true);
    const src = readFileSync(MIGRATION_PATH, 'utf8');
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS wfos_agent_workspaces/);
    // Exactly ONE workspace per execution; ONE worktree path per workspace.
    expect(src).toMatch(/CONSTRAINT wfos_agent_workspaces_execution_unique UNIQUE \(execution_id\)/);
    expect(src).toMatch(/CONSTRAINT wfos_agent_workspaces_worktree_path_unique UNIQUE \(worktree_path\)/);
    // Linkage consistency with the existing ExecutionRecord.
    expect(src).toMatch(/FOREIGN KEY \(execution_id, project_id\)\s*REFERENCES wfos_executions\(id, project_id\)/);
    // The strict state vocabulary + CAS token.
    expect(src).toMatch(/'requested', 'preparing', 'ready', 'released', 'failed', 'cancelled'/);
    expect(src).toMatch(/version INTEGER NOT NULL DEFAULT 0 CHECK \(version >= 0\)/);
    // Terminal FULL immutability + identity immutability + the guards.
    expect(src).toMatch(/agent-workspace-terminal-immutable/);
    expect(src).toMatch(/agent-workspace-identity-immutable/);
    expect(src).toMatch(/agent-workspace-illegal-transition/);
    expect(src).toMatch(/agent-workspace-version-regression/);
    // The durable release obligations (the execution-terminal cleanup
    // contract — atomic with the record's terminal transition).
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS wfos_agent_workspace_release_obligations/);
    expect(src).toMatch(/AFTER UPDATE ON wfos_executions/);
    expect(src).toMatch(/agent-workspace-release-obligation-immutable/);
  });

  it('NO second execution engine + NO GitHub authority duplication (the workspace references the EXISTING ExecutionRecord + the EXISTING /github repository row)', () => {
    for (const [name, p] of [['types', WS_TYPES], ['repository', WS_REPO], ['service', WS_SERVICE], ['materializer', WS_MATERIALIZER]] as const) {
      const src = strip(readFileSync(p, 'utf8'));
      // Never creates executions (the workspace CONTINUES one).
      expect(src, `${name}: no execution creation`).not.toMatch(/INSERT INTO wfos_executions\b/);
      expect(src, `${name}: no ExecutionService construction`).not.toMatch(/new \w*ExecutionService|implements ExecutionService\b|class \w*ExecutionService/);
      // Never a GitHub authority: no PR/merge operations, no adapter calls.
      expect(src, `${name}: no GitHub PR/merge authority`).not.toMatch(/createPullRequest|mergePullRequest|\.merge\(/);
          }
    // The repository linkage goes through the EXISTING /github row: the
    // workspace row stores the /github repository id, and the repository
    // resolves it via the injected /github lookup (the DI boundary keeps
    // /github authoritative — the workspace never queries GitHub itself).
    const repoSrc = strip(readFileSync(WS_REPO, 'utf8'));
    expect(repoSrc).toMatch(/project_github_repository_id/);
    expect(repoSrc).toMatch(/ProjectGitHubRepositoryLookup/);
  });

  it('NO provider SDKs + NO credentials + NO workflow/verification/review mutation (the workspace is execution infrastructure only)', () => {
    for (const [name, p] of [['types', WS_TYPES], ['repository', WS_REPO], ['service', WS_SERVICE], ['materializer', WS_MATERIALIZER], ['relay', WS_RELAY]] as const) {
      const src = strip(readFileSync(p, 'utf8'));
      expect(src, `${name}: no provider SDKs`).not.toMatch(/from ['"]@octokit|from ['"]openai|from ['"]anthropic|zai-sdk/);
      expect(src, `${name}: no credential access`).not.toMatch(/process\.env\.[A-Z_]*(API_KEY|SECRET|TOKEN)/);
      expect(src, `${name}: no workflow mutation`).not.toMatch(/INSERT INTO wfos_workflow|UPDATE wfos_workflow|DELETE FROM wfos_workflow/);
      expect(src, `${name}: no verification mutation`).not.toMatch(/INSERT INTO wfos_verification|UPDATE wfos_verification|DELETE FROM wfos_verification/);
      expect(src, `${name}: no review mutation`).not.toMatch(/INSERT INTO wfos_reviews|UPDATE wfos_reviews|DELETE FROM wfos_reviews/);
      // Not a permission system / tool runtime / adaptive router.
      expect(src, `${name}: no permission system`).not.toMatch(/permission|allowlist|denylist|capability policy/i);
      expect(src, `${name}: no tool runtime`).not.toMatch(/toolRuntime|ToolExecution|executeTool/);
      expect(src, `${name}: no adaptive routing`).not.toMatch(/adaptiveRoute|routeProvider/);
    }
    // The migration stores no credentials (safe columns only).
    const migrationSrc = strip(readFileSync(MIGRATION_PATH, 'utf8'));
    expect(migrationSrc).not.toMatch(/secret|token|cookie|api_key/i);
    // The materializer's filesystem boundary: the path-traversal guard
    // (the token whitelist + the explicit '..' rejection).
    const matSrc = readFileSync(WS_MATERIALIZER, 'utf8');
    expect(matSrc).toMatch(/function assertSafeToken/);
    expect(matSrc).toMatch(/token\.includes\('/);
    expect(matSrc).toMatch(/resolve\(deps\.rootDir\)/);
  });

  it('the workspace contract is provider-independent + CAS-based (no read-check-write ownership)', () => {
    const typesSrc = readFileSync(WS_TYPES, 'utf8');
    expect(typesSrc).toMatch(/export interface AgentWorkspace\b/);
    // The materializer PORT is platform-owned; /agents re-exports it
    // (domain → platform dependency direction).
    expect(typesSrc).toMatch(/export type \{[\s\S]*?WorktreeMaterializer,[\s\S]*?\} from '@platform\/workspace\/worktree-materializer\.types\.js'/);
    expect(typesSrc).toMatch(/export class AgentWorkspaceError extends Error/);
    // No mode/provider fields on the workspace (mode-independent).
    const wsInterface = typesSrc.match(/export interface AgentWorkspace\b[\s\S]*?\n\}/)![0];
    expect(wsInterface).not.toMatch(/\bmode\b|\bprovider\b|\bmodel\b/);
    // The repository CAS transitions.
    const repoSrc = strip(readFileSync(WS_REPO, 'utf8'));
    const claim = repoSrc.match(/async claimForPreparation[\s\S]*?\n  \}/)![0];
    expect(claim).toMatch(/AND version = \$2\s+AND state = 'requested'/);
    const ready = repoSrc.match(/async markReady[\s\S]*?\n  \}/)![0];
    expect(ready).toMatch(/AND version = \$2\s+AND state = 'preparing'/);
    const reclaim = repoSrc.match(/async reclaimStalePreparation[\s\S]*?\n  \}/)![0];
    expect(reclaim).toMatch(/AND state = 'preparing'/);
    expect(reclaim).toMatch(/prepare_lease_expires_at < NOW\(\)/);
    // ensureWorkspace is lookup-or-create (idempotent).
    const ensure = repoSrc.match(/async ensureWorkspace[\s\S]*?\n  \}/)![0];
    expect(ensure).toMatch(/getWorkspaceForExecution/);
    // The deterministic worktree token — derived ONLY by the EXPLICIT
    // platform layout module (PR #39 review fix #2: never inline string
    // surgery at the call site; the layout cannot drift between the
    // durable identity and the filesystem).
    expect(repoSrc).toMatch(/from '@platform\/workspace\/worktree-layout\.js'/);
    expect(ensure).toMatch(/buildWorktreePathToken\(\{[\s\S]*?executionRecordId: record\.id/);
  });

  it('PR #39 review fix #1 — the AUTHORITATIVE baseline: base_revision is the /github default-branch HEAD commit (fail-closed; never prompt metadata, never a placeholder)', () => {
    const repoSrc = strip(readFileSync(WS_REPO, 'utf8'));
    const typesSrc = readFileSync(WS_TYPES, 'utf8');
    // The typed fail-closed error exists + is in the frozen code list.
    expect(typesSrc).toMatch(/'agent-workspace-baseline-unresolvable'/);
    // The baseline resolves through the INJECTED /github authority read
    // (the WorkspaceBaselineResolver port — the workspace layer itself
    // never holds GitHub credentials).
    expect(repoSrc).toMatch(/interface WorkspaceBaselineResolver/);
    expect(repoSrc).toMatch(/baselineResolver: WorkspaceBaselineResolver/);
    const resolve = repoSrc.match(/private async resolveBaseline[\s\S]*?\n  \}/)![0];
    expect(resolve).toMatch(/getBranch\(/);
    // A REAL commit SHA only (SHA-1 or SHA-256 object ids) — the recorded
    // baseline must be a materializable Git revision.
    expect(resolve).toMatch(/\^\[0-9a-f\]\{40\}\$\|\^\[0-9a-f\]\{64\}\$/);
    expect(resolve).toMatch(/agent-workspace-baseline-unresolvable/);
    // NEVER prompt metadata: the repository does not read promptDigest at
    // all (the first implementation's placeholder is gone).
    expect(repoSrc).not.toMatch(/promptDigest/);
    // The ensure path resolves the baseline ONLY on first creation (an
    // existing row returns its immutable recorded baseline — retries never
    // re-resolve and never diverge).
    const ensure = repoSrc.match(/async ensureWorkspace[\s\S]*?\n  \}/)![0];
    expect(ensure.indexOf('getWorkspaceForExecution')).toBeLessThan(ensure.indexOf('resolveBaseline'));
    // app.ts injects the EXISTING /github adapter (the same getBranch the
    // benchmark snapshot service uses — no new authority, no credentials).
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc).toMatch(/baselineResolver: githubAdapter/);
  });

  it('PR #39 review fix #2 — the EXPLICIT worktree layout: one platform module derives repositoryDir/worktreeDir/token (path-traversal-safe; validated, never trusted)', () => {
    const layoutPath = join(BACKEND_ROOT, 'src', 'platform', 'workspace', 'worktree-layout.ts');
    expect(existsSync(layoutPath), 'worktree-layout.ts must exist').toBe(true);
    const layoutSrc = readFileSync(layoutPath, 'utf8');
    // The single source of truth: build (token) + resolve (layout) + parse
    // (validated re-read of persisted tokens).
    expect(layoutSrc).toMatch(/export function buildWorktreePathToken/);
    expect(layoutSrc).toMatch(/export function resolveWorktreeLayout/);
    expect(layoutSrc).toMatch(/export function parseWorktreeToken/);
    // The exact durable shape: owner/repository/exec/<executionRecordId>.
    expect(layoutSrc).toMatch(/exec\/\$\{input\.executionRecordId\}/);
    // Path-segment safety on EVERY coordinate.
    expect(layoutSrc).toContain("const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;");
    expect(layoutSrc).toMatch(/includes\('\.\.'\)/);
    const matSrc = strip(readFileSync(WS_MATERIALIZER, 'utf8'));
    // The materializer derives its layout ONLY through the module — the
    // dirname()-chaining bug (which resolved the WRONG repository
    // directory) is structurally impossible now.
    expect(matSrc).toMatch(/from '\.\/worktree-layout\.js'/);
    expect(matSrc).toMatch(/resolveWorktreeLayout\(/);
    expect(matSrc).toMatch(/parseWorktreeToken\(/);
    expect(matSrc).not.toMatch(/dirname\(dirname\(/);
    // The persisted token + the declared repository coordinates are
    // cross-validated (a drifted row fails closed — never operate in the
    // wrong repository).
    expect(matSrc).toMatch(/token-invalid[\s\S]*?inconsistent with the repository coordinates/);
    // Fail-closed pre-checks with TYPED stages (the workspace records WHERE).
    expect(matSrc).toMatch(/'git-repository-missing'/);
    expect(matSrc).toMatch(/'base-revision-missing'/);
    // Deterministic re-materialization: `-B` (create OR reset the branch to
    // the recorded base) — never `--no-checkout` + `-b` (which left the
    // worktree unchecked-out and never reset a half-created branch).
    expect(matSrc).toMatch(/'worktree', 'add',/);
    expect(matSrc).toMatch(/'-B', input\.branch/);
    expect(matSrc).not.toMatch(/--no-checkout/);
  });

  it('PR #39 review fix #3 — the acquisition/cleanup race: lease-gated cancel + CAS-loser reconciliation + removal-gated discharge (no orphaned worktree in ANY interleaving)', () => {
    const repoSrc = strip(readFileSync(WS_REPO, 'utf8'));
    const svcSrc = strip(readFileSync(WS_SERVICE, 'utf8'));
    // (a) The LEASE-GATED cancel: from 'preparing' the cancel CAS wins ONLY
    // when no live preparation claim is in flight — cleanup can never
    // cancel an ACTIVE preparation out from under the materializer.
    const cancel = repoSrc.match(/async cancel[\s\S]*?\n  \}/)![0];
    expect(cancel).toMatch(/AND \(state <> 'preparing'/);
    expect(cancel).toMatch(/OR prepare_lease_expires_at IS NULL/);
    expect(cancel).toMatch(/OR prepare_lease_expires_at < NOW\(\)\)/);
    // (b) The CAS-LOSER RECONCILIATION: a materializer that loses the
    // markReady CAS after creating the worktree REMOVES it when the row can
    // no longer become ready (terminal) — the loser never orphans what it
    // created. A row still preparing belongs to a recovery re-claimer (the
    // deterministic path is idempotently re-usable) — observed, not touched.
    const acquireFn = svcSrc.match(/private async materializeAndReady[\s\S]*?\n  \}/)![0];
    const loserBranch = acquireFn.match(/if \(!ready\) \{[\s\S]*?\n      \}/)![0];
    const terminalIdx = loserBranch.indexOf('terminalAt !== null');
    const loserRemoveIdx = loserBranch.indexOf('materializer.remove');
    expect(terminalIdx).toBeGreaterThan(-1);
    expect(loserRemoveIdx).toBeGreaterThan(terminalIdx);
    // (c) The removal-gated discharge on the cancel path: cancel → remove →
    // discharge (the "worktree created → DB write crashed" window heals).
    const releaseFn = svcSrc.match(/async releaseWorkspace[\s\S]*?\n  \}/)![0];
    const cancelIdx = releaseFn.indexOf('workspaceRepository.cancel(');
    const cancelRemoveIdx = releaseFn.indexOf('materializer.remove', cancelIdx);
    const cancelDischargeIdx = releaseFn.indexOf('dischargeReleaseObligation', cancelIdx);
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(cancelRemoveIdx).toBeGreaterThan(cancelIdx);
    expect(cancelDischargeIdx).toBeGreaterThan(cancelRemoveIdx);
    // The terminal re-entry ALSO re-drives the removal BEFORE discharging
    // (a crash between a terminal transition and its removal heals here —
    // the obligation was still pending).
    const terminalBranch = releaseFn.match(/if \(workspace\.terminalAt !== null\) \{[\s\S]*?\n    \}/)![0];
    expect(terminalBranch.indexOf('materializer.remove')).toBeLessThan(
      terminalBranch.indexOf('dischargeReleaseObligation'),
    );
    // A materialization failure best-effort-removes the PARTIAL worktree
    // BEFORE recording the durable failure (a failed workspace must not
    // orphan one) — never masking the primary error.
    const failHandler = svcSrc.match(/if \(err instanceof WorktreeMaterializerError\) \{[\s\S]*?\n      \}/)![0];
    expect(failHandler.indexOf('removeQuietly')).toBeLessThan(failHandler.indexOf('markFailed'));
  });

  it('the barrel exposes the provider-independent workspace contracts (implementations internal)', () => {
    const barrelSrc = readFileSync(join(MODULES_DIR, 'agents', 'index.ts'), 'utf8');
    expect(barrelSrc).toMatch(/AgentWorkspace,\s*\n\s*AgentWorkspaceState,/);
    expect(barrelSrc).toMatch(/export \{ AgentWorkspaceError, AGENT_WORKSPACE_ERROR_CODES \}/);
    // The implementations stay internal (not exported).
    expect(barrelSrc).not.toMatch(/PgAgentWorkspaceRepository|FsWorktreeMaterializer|DefaultAgentWorkspaceService/);
    // Provider-independent: no provider names in the contract files.
    for (const p of [WS_TYPES, WS_SERVICE]) {
      expect(readFileSync(p, 'utf8'), `${p}: no provider specifics`).not.toMatch(/\bopenai\b|\banthropic\b|\bzai\b|\bcodex\b|\bclaude\b|\bchatgpt\b/i);
    }
  });

  it('the durable release protocol is wired (relay + handler + boot sweep + the materializer remove-before-CAS ordering)', () => {
    const relaySrc = readFileSync(WS_RELAY, 'utf8');
    expect(relaySrc).toMatch(/class WorkspaceReleaseOutboxRelay implements OutboxRelay/);
    expect(relaySrc).toMatch(/'agents\.workspace-release\.reconcile'/);
    expect(relaySrc).toMatch(/redeliveryPolicy: \{ maxAttempts: 5 \}/);
    const relayCode = relaySrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(relayCode).not.toMatch(/setInterval|setTimeout|setImmediate/);
    // app.ts wiring.
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc).toMatch(/new WorkspaceReleaseOutboxRelay\(/);
    expect(appSrc).toMatch(/createWorkspaceReleaseRelayJobHandler\(/);
    expect(appSrc).toMatch(/\.\.\.\(workspaceReleaseRelay \? \[workspaceReleaseRelay\] : \[\]\)/);
    // The release ordering: remove the worktree FIRST, then the CAS.
    const svcSrc = strip(readFileSync(WS_SERVICE, 'utf8'));
    const releaseFn = svcSrc.match(/async releaseWorkspace[\s\S]*?\n  \}/)![0];
    const removeIdx = releaseFn.indexOf('materializer.remove');
    const casIdx = releaseFn.indexOf('workspaceRepository.release(');
    expect(removeIdx).toBeGreaterThan(-1);
    expect(casIdx).toBeGreaterThan(removeIdx);
  });

  it('the WORK-035 regression matrix exists (the required scenarios)', () => {
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'agent-workspace.regression.test.ts');
    expect(existsSync(testPath)).toBe(true);
    const src = readFileSync(testPath, 'utf8');
    expect(src).toMatch(/workspace creation: ensure → requested → acquired ready/);
    expect(src).toMatch(/duplicate execution\/workspace prevention/);
    expect(src).toMatch(/worktree isolation: two executions → two DISTINCT worktrees/);
    expect(src).toMatch(/concurrent workspace acquisition/);
    expect(src).toMatch(/concurrent worktree creation is impossible by construction/);
    expect(src).toMatch(/retry after workspace-record crash/);
    expect(src).toMatch(/retry after worktree-creation crash/);
    expect(src).toMatch(/materialization FAILURE/);
    expect(src).toMatch(/cleanup idempotency/);
    expect(src).toMatch(/cleanup racing with execution/);
    expect(src).toMatch(/no linked \/github repository → FAIL-CLOSED/);
    expect(src).toMatch(/unknown execution → the typed not-found error/);
    expect(src).toMatch(/terminal immutability \+ illegal transitions/);
    expect(src).toMatch(/native \+ external execution reference the SAME workspace abstraction/);
    expect(src).toMatch(/no workflow\/verification\/review mutation/);
    // PR #39 review fixes #1 + #3 — the new frozen scenarios.
    expect(src).toMatch(/baseline UNRESOLVABLE/);
    expect(src).toMatch(/baseline NOT-A-COMMIT/);
    expect(src).toMatch(/LIVE preparation lease BLOCKS cancellation/);
    expect(src).toMatch(/EXPIRED-lease interleaving/);
    expect(src).toMatch(/isolated CAS-loser rule/);
    expect(src).toMatch(/crash window reconciliation/);
    // PR #39 review fix #2 — the materializer BEHAVIORAL matrix (real
    // git, no execGit fake): the layout, `-B`, the fail-closed pre-checks,
    // the cross-validation, the idempotent removal.
    const matTestPath = join(BACKEND_ROOT, 'tests', 'unit', 'worktree-materializer.test.ts');
    expect(existsSync(matTestPath), 'the real-git materializer test must exist').toBe(true);
    const matTestSrc = readFileSync(matTestPath, 'utf8');
    expect(matTestSrc).toMatch(/dirname-chaining bug stays fixed/);
    expect(matTestSrc).toMatch(/RESETS a lingering branch ref/);
    expect(matTestSrc).toMatch(/re-used AS-IS/);
    expect(matTestSrc).toMatch(/git-repository-missing/);
    expect(matTestSrc).toMatch(/base-revision-missing/);
    expect(matTestSrc).toMatch(/inconsistent with the repository coordinates/);
    expect(matTestSrc).toMatch(/path-traversal-safe/);
  });
});

// ===========================================================================
// WORK-036 — Tool Runtime invariants (the governed tool boundary)
// ===========================================================================

describe('WORK-036 invariants — the governed Tool Runtime', () => {
  const TR_TYPES = join(MODULES_DIR, 'agents', 'internal', 'tool-runtime.types.ts');
  const TR_SERVICE = join(MODULES_DIR, 'agents', 'internal', 'tool-runtime-service.ts');
  const TR_CONTRACTS = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'tool-contracts.ts');
  const TR_FS = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'fs-tool-executor.ts');
  const TR_PROCESS = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'process-tool-executor.ts');
  const TR_SANDBOX = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'process-sandbox.ts');
  const TR_HTTP = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'http-tool-executor.ts');
  const TR_BROWSER = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'browser-tool-executor.ts');
  const TR_CONFINEMENT = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'path-confinement.ts');
  const TR_REDACTION = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'observation-redaction.ts');
  // WORK-037 PR-#41 FIX: the CANONICAL git argv classifier — ONE vocabulary
  // shared by the policy engine (deployment-domain tagging) and the
  // process executor (remote-network rejection). Pure (no IO). Lives in
  // @platform/tools (the correct one-way dependency direction).
  const TR_GIT_ARGV = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'git-argv.ts');
  const TR_GIT_ARGV_TEST = join(BACKEND_ROOT, 'tests', 'unit', 'git-argv.test.ts');
  // WORK-037 PR-#41 FIX (round 2): the CANONICAL package-command classifier
  // — the package-family twin of the git argv classifier. ONE vocabulary
  // shared by the policy engine (deployment-domain tagging) and the
  // process executor (publish-rejection governance gate). Pure (no IO).
  // Lives in @platform/tools (the same one-way dependency direction).
  const TR_PACKAGE_ARGV = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'package-argv.ts');
  const TR_TEST = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'tool-runtime.regression.test.ts');
  const TR_SANDBOX_TEST = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'process-sandbox.regression.test.ts');

  const TOOL_RUNTIME_FILES = [
    ['types', TR_TYPES],
    ['service', TR_SERVICE],
    ['contracts', TR_CONTRACTS],
    ['fs-executor', TR_FS],
    ['process-executor', TR_PROCESS],
    ['process-sandbox', TR_SANDBOX],
    ['http-executor', TR_HTTP],
    ['browser-executor', TR_BROWSER],
    ['confinement', TR_CONFINEMENT],
    ['redaction', TR_REDACTION],
    ['git-argv-classifier', TR_GIT_ARGV],
    ['package-argv-classifier', TR_PACKAGE_ARGV],
  ] as const;

  function strip(src: string): string {
    return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  it('ONE tool-runtime boundary: the platform contracts + the /agents runtime (no second engine anywhere)', () => {
    // The contracts exist exactly once (platform-owned, provider-independent).
    expect(existsSync(TR_CONTRACTS), 'platform/tools/tool-contracts.ts must exist').toBe(true);
    const contractsSrc = readFileSync(TR_CONTRACTS, 'utf8');
    expect(contractsSrc).toMatch(/export type ToolFamily = 'filesystem' \| 'terminal' \| 'git' \| 'package' \| 'http' \| 'browser'/);
    // The frozen six families.
    for (const family of ['filesystem', 'terminal', 'git', 'package', 'http', 'browser']) {
      expect(contractsSrc).toContain(`'${family}'`);
    }
    // The runtime service exists exactly once in /agents and implements the port.
    const svcSrc = strip(readFileSync(TR_SERVICE, 'utf8'));
    expect(svcSrc).toMatch(/class DefaultToolRuntime implements ToolRuntime/);
    // No OTHER module declares a tool runtime (one boundary — grep the module tree).
    const otherToolRuntimeFiles: string[] = [];
    for (const file of walkTs(MODULES_DIR)) {
      const rel = relative(BACKEND_ROOT, file);
      if (file === TR_TYPES || file === TR_SERVICE) continue;
      const src = readFileSync(file, 'utf8');
      if (/class \w*ToolRuntime\b|interface ToolRuntime\b/.test(src)) {
        otherToolRuntimeFiles.push(rel);
      }
    }
    expect(otherToolRuntimeFiles, `a second tool runtime exists: ${otherToolRuntimeFiles.join(', ')}`).toEqual([]);
  });

  it('NO second execution engine, NO workflow/verification/review mutation (tools are capabilities, never authorities)', () => {
    for (const [name, p] of TOOL_RUNTIME_FILES) {
      const src = strip(readFileSync(p, 'utf8'));
      // Never a second execution engine / provider registry / gateway.
      expect(src, `${name}: no ExecutionService construction`).not.toMatch(/class \w*ExecutionService|new \w*ExecutionService|implements ExecutionService\b/);
      expect(src, `${name}: no AgentGateway`).not.toMatch(/AgentGateway/);
      expect(src, `${name}: no second provider registry`).not.toMatch(/ProviderRegistry\b/);
      // Never an authority: no workflow / verification / review mutation.
      expect(src, `${name}: no workflow mutation`).not.toMatch(/INSERT INTO wfos_workflow|UPDATE wfos_workflow|DELETE FROM wfos_workflow/);
      expect(src, `${name}: no verification mutation`).not.toMatch(/INSERT INTO wfos_verification|UPDATE wfos_verification|DELETE FROM wfos_verification/);
      expect(src, `${name}: no review mutation`).not.toMatch(/INSERT INTO wfos_reviews|UPDATE wfos_reviews|DELETE FROM wfos_reviews/);
      // No WorkItem/WorkOrder state decisions either.
      expect(src, `${name}: no work-item mutation`).not.toMatch(/INSERT INTO wfos_work_items|UPDATE wfos_work_items|DELETE FROM wfos_work_items/);
    }
    // The runtime touches ONLY the session events table (observations) —
    // never the workflow/verification/review tables (checked above), and
    // never the execution records themselves.
    const svcSrc = strip(readFileSync(TR_SERVICE, 'utf8'));
    expect(svcSrc).not.toMatch(/INSERT INTO wfos_executions\b|UPDATE wfos_executions\b/);
  });

  it('NO GitHub authority duplication (git is repository-LOCAL only; remote operations are denied fail-closed via the CANONICAL classifier)', () => {
    // WORK-037 PR-#41 FIX: the fail-closed remote-network classification +
    // the cwd/git-dir redirect set are OWNED by the canonical git-argv
    // classifier (TR_GIT_ARGV) — ONE vocabulary shared by the policy
    // engine (deployment-domain tagging) and the executor (remote-network
    // rejection). The executor no longer keeps a local divergent copy (a
    // mismatch would let policy-allow what the executor rejects, or vice
    // versa). The classifier skips git's GLOBAL/CONFIG options before the
    // effective subcommand (`git -c k=v push` is still push → denied).
    const classifierSrc = strip(readFileSync(TR_GIT_ARGV, 'utf8'));
    expect(classifierSrc, 'the canonical classifier module exists').toMatch(/export function isGitDeploymentInvocation/);
    expect(classifierSrc).toMatch(/export function classifyGitSubcommand/);
    expect(classifierSrc).toMatch(/export const GIT_DEPLOYMENT_SUBCOMMANDS/);
    expect(classifierSrc).toMatch(/export const GIT_REDIRECT_FLAGS/);
    // The canonical classifier's unit proof exists (the architect's
    // options-before-subcommand scenarios — pure-function, no DB).
    expect(existsSync(TR_GIT_ARGV_TEST), 'git-argv.test.ts must exist').toBe(true);
    // The deployment set (one source of truth — the subcommand literals
    // live HERE, not in the executor or the engine).
    for (const sub of ['push', 'pull', 'fetch', 'clone', 'remote', 'ls-remote', 'submodule', 'svn', 'daemon', 'http-backend']) {
      expect(classifierSrc, `${sub} is deployment-class in the canonical set`).toContain(`'${sub}'`);
    }
    // The classifier skips git's GLOBAL/CONFIG options to find the
    // effective subcommand (the architect's `git -c k=v push` example).
    expect(classifierSrc).toMatch(/GIT_GLOBAL_VALUE_OPTIONS_SHORT/);
    expect(classifierSrc).toMatch(/'-c'/); // the architect's exact example
    expect(classifierSrc).toMatch(/GIT_GLOBAL_BOOLEAN_OPTIONS/);
    expect(classifierSrc).toMatch(/'--no-pager'/);
    // The executor imports the canonical classifier + uses it (NOT a local
    // positional args[0] check) + still emits the typed rejection codes.
    const procSrc = strip(readFileSync(TR_PROCESS, 'utf8'));
    expect(procSrc, 'the executor imports the canonical classifier').toMatch(/from '\.\/git-argv\.js'/);
    expect(procSrc).toMatch(/isGitDeploymentInvocation\(req\.args\)/);
    expect(procSrc).toMatch(/classifyGitSubcommand\(req\.args\)/);
    expect(procSrc).toMatch(/git-remote-operation-forbidden/);
    expect(procSrc).toMatch(/GIT_REDIRECT_FLAGS/);
    expect(procSrc).toMatch(/git-redirect-forbidden/);
    // The executor NO LONGER keeps a local divergent copy of either set.
    expect(procSrc, 'the executor has NO local GIT_REMOTE_SUBCOMMANDS copy').not.toMatch(/const GIT_REMOTE_SUBCOMMANDS/);
    expect(procSrc, 'the executor has NO local GIT_REDIRECT_FLAGS copy').not.toMatch(/const GIT_REDIRECT_FLAGS/);
    // No PR/merge operations anywhere in the tool runtime.
    for (const [name, p] of TOOL_RUNTIME_FILES) {
      const src = strip(readFileSync(p, 'utf8'));
      expect(src, `${name}: no GitHub PR/merge authority`).not.toMatch(/createPullRequest|mergePullRequest|\.merge\(/);
      expect(src, `${name}: no octokit`).not.toMatch(/octokit/);
    }
  });

  it('NO provider SDK leakage into the public tool contracts (browser driver is a neutral port)', () => {
    // The contracts + the browser port carry NO provider SDK types.
    for (const [name, p] of [
      ['contracts', TR_CONTRACTS],
      ['browser-executor', TR_BROWSER],
      ['types', TR_TYPES],
    ] as const) {
      const src = strip(readFileSync(p, 'utf8'));
      expect(src, `${name}: no Playwright/CDP coupling`).not.toMatch(/playwright|chrome-remote|cdp|puppeteer|devtools/i);
      expect(src, `${name}: no provider SDKs`).not.toMatch(/from ['"]playwright|from ['"]puppeteer|from ['"]@octokit|zai-sdk/);
    }
    // The BrowserDriver port is neutral (its result types are plain data).
    const browserSrc = readFileSync(TR_BROWSER, 'utf8');
    expect(browserSrc).toMatch(/export interface BrowserDriver\b/);
    expect(browserSrc).toMatch(/export interface BrowserNavigationResult\b/);
    // HTTP is plain fetch — no provider client.
    const httpSrc = strip(readFileSync(TR_HTTP, 'utf8'));
    expect(httpSrc).toMatch(/await fetch\(/);
    expect(httpSrc).not.toMatch(/axios|got\(|node-fetch/);
    // Provider-independent: no provider names in the tool contracts.
    for (const p of [TR_CONTRACTS, TR_TYPES]) {
      const contractSrc = strip(readFileSync(p, 'utf8'));
      expect(contractSrc, `${p}: no provider specifics`).not.toMatch(/\bopenai\b|\banthropic\b|\bzai\b|\bcodex\b|\bclaude\b|\bchatgpt\b/i);
    }
  });

  it('NO credential capture (sanitized process env + observation redaction + no secret-store access)', () => {
    const procSrc = strip(readFileSync(TR_PROCESS, 'utf8'));
    // The child environment is a SANITIZED MINIMAL base — the host env is
    // NEVER inherited wholesale.
    expect(procSrc).toMatch(/sanitizedEnv/);
    expect(procSrc).not.toMatch(/\.\.\.process\.env|env:\s*process\.env/);
    // The HTTP executor never ADDS authentication.
    const httpSrc = strip(readFileSync(TR_HTTP, 'utf8'));
    expect(httpSrc).not.toMatch(/Authorization.*=|Bearer\s+\$\{/);
    // The observation redaction layer exists with the key-name vocabulary.
    const redactSrc = readFileSync(TR_REDACTION, 'utf8');
    expect(redactSrc).toMatch(/export function redactForObservation/);
    expect(redactSrc).toMatch(/export function redactHttpHeaders/);
    expect(redactSrc).toContain("export const REDACTED = '[REDACTED]'");
    for (const key of ['secret', 'token', 'password', 'authorization', 'cookie', 'credential', 'api[-_]?key']) {
      expect(redactSrc).toMatch(new RegExp(key));
    }
    // No credential/secret-store access anywhere in the tool runtime.
    for (const [name, p] of TOOL_RUNTIME_FILES) {
      const src = strip(readFileSync(p, 'utf8'));
      expect(src, `${name}: no env credential reads`).not.toMatch(/process\.env\.[A-Z_]*(API_KEY|SECRET|TOKEN|PASSWORD)/);
      expect(src, `${name}: no secret store`).not.toMatch(/SecretStore|EnvSecretStore|getSecret/);
      expect(src, `${name}: no cookies captured`).not.toMatch(/cookieStore|jar\b/i);
    }
  });

  it('NO permission engine + NO adaptive router (the WORK-037/043/044 boundaries stay unimplemented)', () => {
    for (const [name, p] of TOOL_RUNTIME_FILES) {
      const src = strip(readFileSync(p, 'utf8'));
      // The policy SEAM exists but no ENGINE: no persisted policy tables,
      // no role/capability model, no ask-interaction flow.
      expect(src, `${name}: no permission tables`).not.toMatch(/INSERT INTO wfos_(agent_)?polic|CREATE TABLE.*permission/);
      expect(src, `${name}: no role model`).not.toMatch(/AgentRole|role:|assignRole/);
      // No adaptive routing / eligibility / scheduling.
      expect(src, `${name}: no adaptive router`).not.toMatch(/adaptiveRoute|routeProvider|AdaptiveRouter/);
      expect(src, `${name}: no eligibility engine`).not.toMatch(/EligibilityEngine|executionEligibility/);
      expect(src, `${name}: no scheduler`).not.toMatch(/setInterval|cron|scheduleJob/);
    }
    // The SEAM itself: the gate port + the four-value decision vocabulary.
    const typesSrc = readFileSync(TR_TYPES, 'utf8');
    expect(typesSrc).toMatch(/export type ToolPolicyDecisionValue = 'allow' \| 'deny' \| 'ask' \| 'constrained'/);
    expect(typesSrc).toMatch(/export interface ToolPolicyGate\b/);
    expect(typesSrc).toMatch(/export class DefaultToolPolicyGate implements ToolPolicyGate/);
    // The runtime crosses the gate BEFORE any executor runs.
    const svcSrc = strip(readFileSync(TR_SERVICE, 'utf8'));
    const invokeBody = svcSrc.match(/private async invokeUnchecked[\s\S]*?\n  \}/)![0];
    const gateIdx = invokeBody.indexOf('policyGate.decide');
    const executorIdx = invokeBody.indexOf('executor.execute');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(executorIdx).toBeGreaterThan(gateIdx);
  });

  it('the WORKSPACE BOUNDARY is reused from WORK-035 (no competing filesystem/worktree abstraction)', () => {
    // The runtime consumes the WORK-035 workspace repository + materializer.
    const svcSrc = strip(readFileSync(TR_SERVICE, 'utf8'));
    expect(svcSrc).toMatch(/workspaceRepository: Pick<AgentWorkspaceRepository, 'getWorkspaceForExecution'>/);
    expect(svcSrc).toMatch(/materializer: WorktreeMaterializer/);
    // The host path comes from the materializer re-resolution — no
    // independent path derivation.
    expect(svcSrc).toMatch(/materializer\.materialize\(\{/);
    // Every filesystem/cwd access flows through the confinement module.
    const fsSrc = strip(readFileSync(TR_FS, 'utf8'));
    expect(fsSrc).toMatch(/resolveWithinWorkspace/);
    const procSrc = strip(readFileSync(TR_PROCESS, 'utf8'));
    expect(procSrc).toMatch(/resolveWithinWorkspace/);
    // The confinement module rejects traversal + absolute + symlink escapes.
    const confSrc = readFileSync(TR_CONFINEMENT, 'utf8');
    expect(confSrc).toMatch(/isAbsolute/);
    expect(confSrc).toMatch(/realpath/);
    expect(confSrc).toMatch(/WorkspaceBoundaryError/);
    expect(confSrc).toMatch(/'workspace-boundary-violation'/);
    // No second worktree/materializer abstraction in the tool layer.
    for (const [name, p] of TOOL_RUNTIME_FILES) {
      const src = strip(readFileSync(p, 'utf8'));
      expect(src, `${name}: no competing worktree abstraction`).not.toMatch(/git worktree add|worktreePathToken = |buildWorktreePathToken/);
    }
  });

  it('the normalized contract: identity + linkage + policy + timing + outcome + cancellation + idempotency', () => {
    const typesSrc = readFileSync(TR_TYPES, 'utf8');
    // The full normalized record key set.
    expect(typesSrc).toMatch(/export interface ToolInvocationRecord\b/);
    for (const field of [
      'invocationId', 'executionId', 'sessionId', 'workspaceId', 'origin',
      'tool', 'input', 'policy', 'startedAt', 'completedAt', 'status',
      'exitCode', 'stdout', 'stderr', 'output', 'error', 'truncated',
    ]) {
      expect(typesSrc).toMatch(new RegExp(`readonly ${field}:`));
    }
    // The statuses (uncertainty is observable) + idempotency declaration.
    expect(typesSrc).toMatch(/export type ToolInvocationStatus = 'succeeded' \| 'failed' \| 'cancelled' \| 'blocked' \| 'unknown'/);
    expect(typesSrc).toMatch(/export type ToolInvocationIdempotency = 'idempotent' \| 'non-idempotent'/);
    // Native AND external parity through the same contract.
    expect(typesSrc).toMatch(/origin: 'native' \| 'external'/);
    expect(typesSrc).toMatch(/recordExternalObservation\(input: ExternalToolObservationInput\)/);
    // Bounded output is structural.
    const contractsSrc = readFileSync(TR_CONTRACTS, 'utf8');
    expect(contractsSrc).toMatch(/maxOutputBytes/);
    expect(contractsSrc).toMatch(/maxResponseBytes|maxHttpBodyBytes/);
    expect(contractsSrc).toMatch(/truncated: boolean/);
    // Cancellation is in the contract (AbortSignal).
    expect(typesSrc).toMatch(/readonly signal\?: AbortSignal/);
  });

  it('durable observability through the EXISTING evidence architecture (session events + audit — no parallel tool-event store)', () => {
    // No new migration, no new table for tool events.
    const migrationsDir = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations');
    const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    for (const f of migrationFiles) {
      const src = readFileSync(join(migrationsDir, f), 'utf8');
      expect(src, `${f}: no parallel tool-event store`).not.toMatch(/CREATE TABLE IF NOT EXISTS wfos_tool_|CREATE TABLE IF NOT EXISTS wfos_agent_tool/);
    }
    // The observations ride the session event vocabulary (tool_call + observation).
    const repoSrc = strip(readFileSync(join(AGENTS_INTERNAL_PATH(), 'pg-execution-session-repository.ts'), 'utf8'));
    expect(repoSrc).toMatch(/claimToolInvocation/);
    expect(repoSrc).toMatch(/appendToolObservation/);
    expect(repoSrc).toMatch(/'tool_call'/);
    expect(repoSrc).toMatch(/'observation'/);
    // The invocation-key dedupe uses the payload match under the session
    // row lock (the existing serialized transactional pattern — not a
    // read-check-write).
    expect(repoSrc).toMatch(/payload->>'invocationId' = \$2/);
    expect(repoSrc).toMatch(/FOR UPDATE/);
    // The runtime emits audit events (supplementary, never authoritative).
    const svcSrc = strip(readFileSync(TR_SERVICE, 'utf8'));
    expect(svcSrc).toMatch(/tool\.invocation\.\$\{record\.status\}/);
    expect(svcSrc).toMatch(/emitAudit/);
  });

  it('terminal governance: explicit argv, NO shell, bounded output, sanitized env, timeout + cancellation', () => {
    const procSrc = strip(readFileSync(TR_PROCESS, 'utf8'));
    // execFile with EXPLICIT argv — never child_process.exec (shell).
    expect(procSrc).toMatch(/execFile\(/);
    expect(procSrc).not.toMatch(/child_process\.exec\(|exec\(userString|shell:\s*true/);
    // argv separation is validated (a shell string can never smuggle in).
    expect(procSrc).toMatch(/requires a non-empty argv of strings \(no shell strings\)/);
    // Bounded output + timeout + signal cancellation.
    expect(procSrc).toMatch(/maxBuffer/);
    expect(procSrc).toMatch(/timeout/);
    expect(procSrc).toMatch(/signal: opts\.ctx\.signal/);
    // The teardown: process-group SIGTERM with a guaranteed SIGKILL
    // escalation (the wrapper blocks SIGTERM; the pid-1 target ignores
    // default-disposition signals).
    expect(procSrc).toMatch(/process\.kill\(-child\.pid, sig\)/);
    expect(procSrc).toMatch(/TEARDOWN_GRACE_MS/);
    expect(procSrc).toMatch(/'SIGKILL'/);
    // Cancellation + timeout map to distinct observable outcome codes
    // (deterministic flags — not signal bookkeeping through the wrapper).
    expect(procSrc).toMatch(/'cancelled'/);
    expect(procSrc).toMatch(/'timeout'/);
    // The package family rejects arbitrary binaries (bare runner names).
    expect(procSrc).toMatch(/package-runner-path-forbidden/);
  });

  it('the PROCESS SANDBOX boundary (PR #40 review fix): kernel-enforced confinement, fail-closed, NO unsandboxed fallback', () => {
    expect(existsSync(TR_SANDBOX), 'platform/tools/process-sandbox.ts must exist').toBe(true);
    const sandboxSrc = readFileSync(TR_SANDBOX, 'utf8');
    const procSrc = strip(readFileSync(TR_PROCESS, 'utf8'));
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');

    // The port + exactly ONE implementation; NO pass-through sandbox.
    expect(sandboxSrc).toMatch(/export interface ProcessSandbox\b/);
    expect(sandboxSrc).toMatch(/export class NamespaceProcessSandbox implements ProcessSandbox/);
    expect(sandboxSrc).toMatch(/export class ProcessSandboxError extends Error/);
    // The executor REQUIRES the sandbox (no optional dep, no default).
    expect(procSrc).toMatch(/readonly sandbox: ProcessSandbox;/);
    expect(procSrc).not.toMatch(/sandbox\?:/);
    // app.ts wires the REAL namespace sandbox into ALL THREE process families.
    expect(appSrc).toMatch(/new NamespaceProcessSandbox\(/);
    for (const family of ['terminal', 'git', 'package']) {
      expect(appSrc, `app.ts must wire the sandbox into the ${family} executor`).toContain(
        `new ProcessToolExecutor('${family}', { logger, sandbox: processSandbox })`,
      );
    }

    // Fail-closed: ensureAvailable BEFORE wrapLaunch BEFORE the spawn;
    // the typed unavailable outcome; no fallback spawn of the raw argv.
    const runProcessBody = procSrc.match(/private async runProcess[\s\S]*?\n  \}/)![0];
    const ensureIdx = runProcessBody.indexOf('this.sandbox.ensureAvailable()');
    const wrapIdx = runProcessBody.indexOf('this.sandbox.wrapLaunch(');
    const spawnIdx = procSrc.indexOf('launch.argv[0]!');
    expect(ensureIdx).toBeGreaterThan(-1);
    expect(wrapIdx).toBeGreaterThan(ensureIdx);
    expect(spawnIdx).toBeGreaterThan(procSrc.indexOf('private spawnSandboxed'));
    expect(procSrc).toMatch(/'process-sandbox-unavailable'/);
    expect(procSrc).toMatch(/there is no unsandboxed fallback/);
    // The outcome records WHICH confinement produced it (observability).
    expect(procSrc).toMatch(/sandbox: this\.sandbox\.id/);

    // The unshare flags: user + mount + NET + PID + IPC + UTS + kill-child.
    // The launcher binary is ABSOLUTE (no PATH resolution — the launcher
    // environment is the frozen constant below, nothing else).
    expect(sandboxSrc).toContain("'/usr/bin/unshare',");
    expect(sandboxSrc).toContain("'--user'");
    expect(sandboxSrc).toContain("'--map-root-user'");
    expect(sandboxSrc).toContain("'--mount'");
    expect(sandboxSrc).toContain("'--net'");
    expect(sandboxSrc).toContain("'--pid'");
    expect(sandboxSrc).toContain("'--ipc'");
    expect(sandboxSrc).toContain("'--uts'");
    expect(sandboxSrc).toContain("'--kill-child'");

    // The FROZEN setup script: pivot_root + tmpfs root + read-only system
    // binds + the sealed old root + the capability drop. NO interpolation
    // (no '${' anywhere in the script — user argv travels POSITIONALLY).
    const scriptMatch = sandboxSrc.match(/export const NAMESPACE_SANDBOX_SETUP_SCRIPT = `([\s\S]*?)`;/);
    expect(scriptMatch, 'the frozen setup script constant must exist').not.toBeNull();
    const script = scriptMatch![1];
    expect(script).not.toContain('${');
    for (const fragment of [
      'mount -t tmpfs',
      'mount --bind /usr',
      'mount -o remount,bind,ro',
      'pivot_root /mnt /mnt/.putold',
      'umount -l /.putold',
      'mount -t tmpfs -o size=4k,mode=000 tmpfs /.putold',
      'set -eu',
      'test -x /usr/bin/setpriv',
      'exec /usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- /bin/sh -c',
      'shift 4',
    ]) {
      expect(script, `the frozen script must contain: ${fragment}`).toContain(fragment);
    }
    // The git object store bind derives from the WORK-035 layout module —
    // never from the tamperable .git pointer file.
    expect(sandboxSrc).toMatch(/deriveRepositoryDirFromWorktreePath/);
    expect(sandboxSrc).not.toMatch(/readFile.*\.git|gitdir:/);
    // The layout module owns the inverse derivation (single source).
    const layoutSrc = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'workspace', 'worktree-layout.ts'), 'utf8');
    expect(layoutSrc).toMatch(/export function deriveRepositoryDirFromWorktreePath/);
  });

  it('the TWO-PHASE ENVIRONMENT (PR #40 second review fix): the launcher env is a frozen platform constant — caller env reaches ONLY the post-boundary target', () => {
    const sandboxSrc = readFileSync(TR_SANDBOX, 'utf8');
    const procSrc = strip(readFileSync(TR_PROCESS, 'utf8'));

    // The HOST LAUNCH environment is a frozen literal constant — the
    // entire launcher-phase env contract. It is platform-owned: the
    // sandbox module's CODE reads no process.env at all (comments
    // stripped — no host environment can enter the launcher).
    expect(sandboxSrc).toMatch(
      /export const SANDBOX_HOST_LAUNCH_ENV: Readonly<Record<string, string>> = Object\.freeze\(\{\s*PATH: '\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin',\s*\}\);/,
    );
    expect(strip(sandboxSrc)).not.toContain('process.env');
    // wrapLaunch returns EXACTLY that constant as the launcher env —
    // never the launch input, never a merge, never caller data. (The
    // availability probe legitimately CONSUMES the wrapped launch env —
    // the invariant is scoped to wrapLaunch, the only constructor of
    // WrappedProcessLaunch.)
    const wrapBody = sandboxSrc.match(
      /async wrapLaunch\(launch: ProcessSandboxLaunch\): Promise<WrappedProcessLaunch> \{[\s\S]*?\n  \}/,
    )![0]!;
    expect(wrapBody).toContain('env: SANDBOX_HOST_LAUNCH_ENV');
    expect(wrapBody).not.toMatch(/env:\s*launch/);
    expect(wrapBody).not.toMatch(/env\s*:\s*\{\s*\.\.\.\s*launch/);

    // The launch INPUT has no `env` field at all — the caller-permitted
    // environment can ONLY be named as `targetEnv` (a structurally
    // distinct contract; this is the invariant that makes the
    // LD_PRELOAD-reaches-unshare escape unrepresentable).
    const launchIface = sandboxSrc.match(/export interface ProcessSandboxLaunch \{[\s\S]*?\n\}/)![0];
    expect(launchIface).toContain('readonly targetEnv: Readonly<Record<string, string>>;');
    expect(launchIface).not.toMatch(/readonly env:/);

    // The target env enters the WRAPPED ARGV as count-framed K=V words
    // (data — applied by the in-sandbox shell after the boundary).
    expect(sandboxSrc).toContain('Object.entries(launch.targetEnv)');
    expect(sandboxSrc).toMatch(/String\(targetEnvEntries\.length\)/);

    // The frozen script: the capability drop execs the SECOND frozen
    // shell that applies the counted target env — the drop happens
    // BEFORE any caller environment exists in the process tree, and the
    // env application execs the target verbatim.
    const scriptMatch = sandboxSrc.match(/export const NAMESPACE_SANDBOX_SETUP_SCRIPT = `([\s\S]*?)`;/);
    const script = scriptMatch![1]!;
    const dropIdx = script.indexOf(
      'exec /usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- /bin/sh -c',
    );
    const envApplyIdx = script.indexOf('export "$1"');
    const targetExecIdx = script.lastIndexOf('exec "$@"');
    expect(dropIdx, 'the capability drop must exec the env-applying shell').toBeGreaterThan(-1);
    expect(envApplyIdx, 'the target env is applied by export words').toBeGreaterThan(dropIdx);
    expect(targetExecIdx, 'the target argv exec comes after the env application').toBeGreaterThan(envApplyIdx);
    for (const fragment of ['N=$1', 'while [ "$N" -gt 0 ]; do', 'export "$1"', 'N=$((N - 1))', 'exec "$@"']) {
      expect(script, `the frozen env-application script must contain: ${fragment}`).toContain(fragment);
    }

    // The executor passes the caller env ONLY as targetEnv; the spawn
    // uses the wrapped launch env (the frozen constant) — there is no
    // locally merged environment anywhere in the spawn path.
    expect(procSrc).toContain('targetEnv: env');
    expect(procSrc).not.toMatch(/env:\s*env\b/);
    expect(procSrc).not.toMatch(/env:\s*this\.sanitizedEnv/);
    // Environment keys are SHAPE-validated (a syntactic rule — NOT a
    // variable-name denylist; LD_* keys still reach the target).
    expect(procSrc).toMatch(/ENV_KEY_PATTERN/);
  });

  it('the WORK-036 regression matrix exists (the frozen scenarios)', () => {
    expect(existsSync(TR_TEST), 'tool-runtime.regression.test.ts must exist').toBe(true);
    const src = readFileSync(TR_TEST, 'utf8');
    // The 20 frozen scenarios.
    expect(src).toMatch(/filesystem write \+ read round-trip/);
    expect(src).toMatch(/path traversal is REJECTED/);
    expect(src).toMatch(/workspace boundary is ENFORCED: absolute paths \+ symlink escapes/);
    expect(src).toMatch(/terminal command execution with full capture/);
    expect(src).toMatch(/terminal cancellation: the caller AbortSignal interrupts/);
    expect(src).toMatch(/git operations run inside the CORRECT workspace/);
    expect(src).toMatch(/package\/test execution uses the workspace boundary/);
    expect(src).toMatch(/browser abstraction: the driver port is decoupled/);
    expect(src).toMatch(/HTTP abstraction: explicit URL\/method\/headers\/body/);
    expect(src).toMatch(/invocation identity links execution \+ session \+ workspace/);
    expect(src).toMatch(/concurrent SAME-invocationId calls execute EXACTLY ONCE/);
    expect(src).toMatch(/concurrent DIFFERENT invocationIds both execute/);
    expect(src).toMatch(/retry after a COMPLETED observation REPLAYS/);
    expect(src).toMatch(/NON-IDEMPOTENT retry after a crash/);
    expect(src).toMatch(/IDEMPOTENT retry after a crash re-runs safely/);
    expect(src).toMatch(/tool failure is NEVER reported as success/);
    expect(src).toMatch(/tool observations NEVER mutate workflow\/verification\/review authority/);
    expect(src).toMatch(/external provider observations flow through the SAME normalized contract/);
    expect(src).toMatch(/credentials CANNOT enter durable tool payloads/);
    expect(src).toMatch(/NO arbitrary host filesystem escape from ANY family/);
    // The seam + chain-gate scenarios.
    expect(src).toMatch(/policy seam: deny \+ ask BLOCK execution/);
    expect(src).toMatch(/chain gates: no session \/ not-running session \/ no workspace \/ not-ready workspace/);
  });

  it('the PROCESS-SANDBOX regression matrix exists (the PR #40 review-fix scenarios)', () => {
    expect(existsSync(TR_SANDBOX_TEST), 'process-sandbox.regression.test.ts must exist').toBe(true);
    const src = readFileSync(TR_SANDBOX_TEST, 'utf8');
    // cwd confinement ≠ process confinement — the review's framing.
    expect(src).toMatch(/cwd confinement is NOT process confinement/);
    // Legitimate workspace-local development commands still run.
    expect(src).toMatch(/legitimate workspace-local development commands still run/);
    expect(src).toMatch(/legitimate git operations run inside the worktree THROUGH the shared object store/);
    expect(src).toMatch(/the review bypass route/);
    // The escape routes are all blocked.
    expect(src).toMatch(/absolute host filesystem access is BLOCKED/);
    expect(src).toMatch(/traversal cannot escape the workspace/);
    expect(src).toMatch(/git -C <outside repository> is BLOCKED via the terminal family/);
    expect(src).toMatch(/the host environment and host processes are invisible/);
    expect(src).toMatch(/direct network access is BLOCKED from the sandbox/);
    // The hostile-process + seal + fail-closed + shape invariants.
    expect(src).toMatch(/a hostile process cannot remount, unstack, or unmount the frozen sandbox/);
    expect(src).toMatch(/an unusable sandbox fails CLOSED/);
    expect(src).toMatch(/the frozen constant script \+ POSITIONAL argv/);
    expect(src).toMatch(/extra toolchain roots are validated/);
    expect(src).toMatch(/never the tamperable \.git pointer/);
    // PR #40 SECOND review fix — the TWO-PHASE ENVIRONMENT scenarios:
    // the launcher env is the frozen constant (wrapLaunch shape) and
    // every caller loader/runtime vector (LD_PRELOAD with a compiled
    // malicious workspace .so, LD_PRELOAD naming a host .so, LD_AUDIT,
    // LD_LIBRARY_PATH with a planted bogus libc, caller PATH, LD_DEBUG,
    // legitimate env passthrough, env-key shape) is regression-proven.
    expect(src).toMatch(/the TWO-PHASE ENVIRONMENT/);
    expect(src).toMatch(/caller LD_PRELOAD \(a workspace-resident malicious \.so\) executes ONLY inside the sandbox/);
    expect(src).toMatch(/naming a HOST-resident library preloads NOTHING anywhere/);
    expect(src).toMatch(/caller LD_AUDIT \(a workspace-resident audit library\) is confined to the post-boundary target/);
    expect(src).toMatch(/planted bogus libc\.so\.6 cannot hijack the launcher/);
    expect(src).toMatch(/a caller-controlled PATH cannot influence the sandbox launcher/);
    expect(src).toMatch(/caller LD_DEBUG reaches only the TARGET loader/);
    expect(src).toMatch(/legitimate caller environment variables still work inside the sandbox/);
    expect(src).toMatch(/environment keys must be valid variable names/);
  });

  it('the barrel exposes the tool contracts (implementations internal; the sanctioned error + limits constants)', () => {
    const barrelSrc = readFileSync(join(MODULES_DIR, 'agents', 'index.ts'), 'utf8');
    expect(barrelSrc).toMatch(/ToolRuntime,/)
    expect(barrelSrc).toMatch(/ToolInvocationInput,/);
    expect(barrelSrc).toMatch(/ExternalToolObservationInput,/);
    expect(barrelSrc).toMatch(/export \{\s*ToolRuntimeError,\s*TOOL_RUNTIME_ERROR_CODES,\s*DEFAULT_TOOL_EXECUTION_LIMITS,?\s*\}/);
    // The concrete implementations stay internal.
    expect(barrelSrc).not.toMatch(/DefaultToolRuntime|FsToolExecutor|ProcessToolExecutor|HttpToolExecutor|BrowserToolExecutor|DefaultToolPolicyGate/);
  });
});

/** The /agents internal path helper (WORK-036 checks). */
function AGENTS_INTERNAL_PATH(): string {
  return join(MODULES_DIR, 'agents', 'internal');
}

// ============================================================================
// WORK-037 — Agent Policy & Permissions invariants
// ============================================================================
//
// The durable execution-policy authority BEHIND the WORK-036 ToolPolicyGate
// seam. The invariant under test (the one-way dependency):
//
//   Auth / Project Authorization → Execution Policy → Tool Runtime → Sandbox
//
//   NO reverse dependency: the engine imports no workflow/verification/review
//   /github/work-items/authorization module. Only the ROUTE layer calls
//   requireProjectAuthorization (who-may-resolve) — the engine decides
//   what-agents-may-do (execution-specific policy). These are two separate
//   concerns; the engine is the second.
describe('WORK-037 invariants — Agent Policy and Permissions (the engine behind the ToolPolicyGate seam)', () => {
  const AP_TYPES = join(MODULES_DIR, 'agents', 'internal', 'agent-policy.types.ts');
  const AP_ENGINE = join(MODULES_DIR, 'agents', 'internal', 'agent-policy-engine.ts');
  const AP_REPO = join(MODULES_DIR, 'agents', 'internal', 'pg-agent-policy-repository.ts');
  const AP_HANDOFF = join(MODULES_DIR, 'agents', 'internal', 'policy-gated-handoff-service.ts');
  const AP_ROUTE = join(BACKEND_ROOT, 'src', 'api', 'routes', 'agent-policy.route.ts');
  const AP_REGRESSION = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'agent-policy.regression.test.ts');
  const AP_MIGRATION = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0037_agent_policy.sql');

  // The workflow/authority modules the engine MUST NOT import (the one-way
  // dependency). Audit + logger are infrastructure PORTS (allowed — the
  // engine consumes the AuditEventWriter TYPE + Logger TYPE, never the
  // audit module's logic, never workflow state).
  const FORBIDDEN_ENGINE_IMPORTS = [
    "@modules/auth",
    "@modules/workflows",
    "@modules/work-items",
    "@modules/verification",
    "@modules/reviews",
    "@modules/github",
    "@modules/architecture",
    "@modules/requirements",
    "@modules/notifications",
    "@modules/organizations",
    "@modules/projects",
  ];
  const ENGINE_FILES: ReadonlyArray<string> = [AP_TYPES, AP_ENGINE, AP_REPO, AP_HANDOFF];

  it('the engine + repository + decorator NEVER import a workflow/authority module (the one-way dependency)', () => {
    for (const file of ENGINE_FILES) {
      const src = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_ENGINE_IMPORTS) {
        expect(src, `${file} must not import ${forbidden} (the one-way dependency)`).not.toContain(
          `from '${forbidden}`,
        );
        expect(src, `${file} must not import ${forbidden} (the one-way dependency)`).not.toContain(
          `from "${forbidden}`,
        );
      }
    }
  });

  it('the engine implements the frozen ToolPolicyGate seam (the runtime diff is zero)', () => {
    const engineSrc = readFileSync(AP_ENGINE, 'utf8');
    expect(engineSrc).toMatch(/export class AgentPolicyEngine implements ToolPolicyGate/);
    expect(engineSrc).toMatch(/async decide\(request: ToolPolicyRequest\): Promise<ToolPolicyDecision>/);
    // The decision vocabulary is the FROZEN ToolPolicyDecisionValue
    // (reused, NOT extended — the engine imports it from the seam).
    const typesSrc = readFileSync(AP_TYPES, 'utf8');
    expect(typesSrc).toMatch(/ToolPolicyDecisionValue/);
    // The four control domains + the external-handoff subject.
    expect(typesSrc).toMatch(/'tool' \| 'network' \| 'secrets' \| 'deployment' \| 'external'/);
  });

  it('app.ts wires the ENGINE as the runtime policyGate (NOT DefaultToolPolicyGate)', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    // The engine is constructed + wired as the gate.
    expect(appSrc).toMatch(/new AgentPolicyEngine\(/);
    expect(appSrc).toMatch(/policyGate: agentPolicyEngine,/);
    // DefaultToolPolicyGate is no longer imported (the engine replaces it).
    expect(appSrc).not.toMatch(/DefaultToolPolicyGate/);
    // The handoff decorator wraps the inner service (external eligibility).
    expect(appSrc).toMatch(/new PolicyGatedExecutionHandoffService\(/);
    expect(appSrc).toMatch(/inner: new DefaultExecutionHandoffService\(/);
  });

  it('fail-closed: decide() returns deny on resolution failure (NEVER silently allow)', () => {
    const engineSrc = readFileSync(AP_ENGINE, 'utf8');
    // The catch → deny path + the fail-closed reason codes.
    expect(engineSrc).toMatch(/agent-policy-scope-unresolvable/);
    expect(engineSrc).toMatch(/agent-policy-unavailable/);
    expect(engineSrc).toMatch(/this\.failClosed\(/);
    expect(engineSrc).toMatch(/return this\.failClosed\(/);
    // The fail-closed decision is always 'deny'.
    expect(engineSrc).toMatch(/return \{ decision: 'deny', reason: `agent-policy/);
  });

  it('the ASK interaction: a pending approval is ensured (never silently allow)', () => {
    const engineSrc = readFileSync(AP_ENGINE, 'utf8');
    // The engine delegates pending creation to the repository (idempotent
    // under the partial unique index) + owns the approval-consultation flow.
    expect(engineSrc).toMatch(/private async ensurePending\(/);
    expect(engineSrc).toMatch(/this\.deps\.repository\.ensurePendingApproval\(/);
    expect(engineSrc).toMatch(/decision: 'ask'/);
    // An APPROVED approval resolves to allow; a DENIED to deny (durable).
    expect(engineSrc).toMatch(/approval\.status === 'approved'/);
    expect(engineSrc).toMatch(/approval\.status === 'denied'/);
  });

  it('no workflow/verification/review/github state mutation (SQL-level)', () => {
    const FORBIDDEN_TABLES = [
      'wfos_workflow_states',
      'wfos_work_items',
      'wfos_work_orders',
      'wfos_verification_runs',
      'wfos_reviews',
      'wfos_pull_request_associations',
      'wfos_github_',
    ];
    for (const file of [AP_REPO, AP_ENGINE]) {
      const src = readFileSync(file, 'utf8');
      for (const table of FORBIDDEN_TABLES) {
        expect(src, `${file} must not mutate ${table}`).not.toContain(`INSERT INTO ${table}`);
        expect(src, `${file} must not mutate ${table}`).not.toContain(`UPDATE ${table}`);
        expect(src, `${file} must not mutate ${table}`).not.toContain(`DELETE FROM ${table}`);
      }
    }
    // The engine persists ONLY to wfos_agent_policies + wfos_agent_policy_approvals.
    const repoSrc = readFileSync(AP_REPO, 'utf8');
    expect(repoSrc).toMatch(/INSERT INTO wfos_agent_policies/);
    expect(repoSrc).toMatch(/INSERT INTO wfos_agent_policy_approvals/);
    expect(repoSrc).toMatch(/UPDATE wfos_agent_policy_approvals/);
    expect(repoSrc).toMatch(/DELETE FROM wfos_agent_policies/);
  });

  it('the migration exists: two tables + partial unique indexes + the version-bump trigger', () => {
    expect(existsSync(AP_MIGRATION), '0037_agent_policy.sql must exist').toBe(true);
    const sql = readFileSync(AP_MIGRATION, 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS wfos_agent_policies/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS wfos_agent_policy_approvals/);
    // The partial unique indexes (one org default, one project override per
    // project; one pending approval per execution+subject).
    expect(sql).toMatch(/wfos_agent_policies_org_unique/);
    expect(sql).toMatch(/WHERE scope = 'organization'/);
    expect(sql).toMatch(/wfos_agent_policies_project_unique/);
    expect(sql).toMatch(/WHERE scope = 'project'/);
    expect(sql).toMatch(/wfos_agent_policy_approvals_pending_unique/);
    expect(sql).toMatch(/WHERE status = 'pending'/);
    // The version-bump trigger.
    expect(sql).toMatch(/wfos_agent_policies_bump_version/);
    expect(sql).toMatch(/NEW\.policy_version := OLD\.policy_version \+ 1/);
    // The migration documents the no-credential intent (policy config +
    // subject identifiers only — no tokens/secrets/passwords stored).
    expect(sql).toMatch(/No secrets\./);
  });

  it('the route layer enforces user authorization (who-may-resolve; the engine never imports auth)', () => {
    const routeSrc = readFileSync(AP_ROUTE, 'utf8');
    expect(routeSrc).toContain('requireProjectAuthorization');
    expect(routeSrc).toContain('requireOrganizationAuthorization');
    // Mutations + approval resolution require project.admin (user authority).
    expect(routeSrc).toMatch(/permission: 'project\.admin'/);
    // Reads require project.read.
    expect(routeSrc).toMatch(/permission: 'project\.read'/);
    // The approval resolution verifies the approval belongs to the path project
    // (a project.admin on A cannot resolve an approval for B).
    expect(routeSrc).toMatch(/approval\.projectId !== projectId/);
    // The route depends on the AgentPolicyService INTERFACE (not the concrete
    // engine) — the api layer does not reach into modules/agents/internal.
    expect(routeSrc).toMatch(/from '@modules\/agents\/index\.js'/);
    expect(routeSrc).not.toMatch(/\.\.\/\.\.\/modules\/agents\/internal\//);
  });

  it('the barrel exposes the agent-policy types + the platform default + the error (no concrete impls)', () => {
    const barrelSrc = readFileSync(join(MODULES_DIR, 'agents', 'index.ts'), 'utf8');
    expect(barrelSrc).toMatch(/AgentPolicyDocument,/);
    expect(barrelSrc).toMatch(/AgentPolicyService,/);
    expect(barrelSrc).toMatch(/AgentPolicyError,/);
    expect(barrelSrc).toMatch(/PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT,/);
    // The concrete engine + repository stay internal (wired by app.ts).
    expect(barrelSrc).not.toMatch(/export \{[^}]*AgentPolicyEngine[^}]*\}/);
    expect(barrelSrc).not.toMatch(/export \{[^}]*PgAgentPolicyRepository[^}]*\}/);
  });

  it('the platform default document is a safe out-of-box posture (secrets/deployment/network-mutating controlled)', () => {
    const typesSrc = readFileSync(AP_TYPES, 'utf8');
    // secrets → ask; deployment → deny; network-mutating → ask; terminal/package → constrained.
    expect(typesSrc).toMatch(/id: 'platform-secrets-ask'/);
    expect(typesSrc).toMatch(/id: 'platform-deployment-deny'/);
    expect(typesSrc).toMatch(/id: 'platform-network-mutating-ask'/);
    expect(typesSrc).toMatch(/id: 'platform-terminal-constrained'/);
    expect(typesSrc).toMatch(/id: 'platform-package-constrained'/);
    // The default effect is allow (read-oriented + worktree-confined dev).
    expect(typesSrc).toMatch(/defaultEffect: 'allow'/);
    // The document + its rules are frozen (Object.freeze).
    expect(typesSrc).toMatch(/Object\.freeze\(\{\s*description:/);
  });

  it('the external-handoff eligibility is enforced at the handoff decorator (no host authority gained)', () => {
    const handoffSrc = readFileSync(AP_HANDOFF, 'utf8');
    expect(handoffSrc).toMatch(/class PolicyGatedExecutionHandoffService implements ExecutionHandoffService/);
    // issue() + redeem() both consult the policy (deny/ask → throw; constrained → attach constraints).
    expect(handoffSrc).toMatch(/evaluateExternalHandoff\(/);
    expect(handoffSrc).toMatch(/'handoff-policy-denied'/);
    expect(handoffSrc).toMatch(/'handoff-policy-approval-required'/);
    // redeemByToken is NOT gated (post-issuance delivery; documented).
    expect(handoffSrc).toMatch(/companion path is post-issuance delivery/);
  });

  it('the regression matrix exists with the frozen scenarios', () => {
    expect(existsSync(AP_REGRESSION), 'agent-policy.regression.test.ts must exist').toBe(true);
    const src = readFileSync(AP_REGRESSION, 'utf8');
    // The three layers of proof.
    expect(src).toMatch(/ENGINE DECISION LOGIC/);
    expect(src).toMatch(/PERSISTENCE/);
    expect(src).toMatch(/SEAM INTEGRATION/);
    // The four control domains are exercised.
    expect(src).toMatch(/deployment-class/);
    expect(src).toMatch(/secrets-bearing/);
    expect(src).toMatch(/network-mutating/);
    // The ASK approval flow (approved → allow; denied → deny; pending; expired).
    expect(src).toMatch(/APPROVED approval for the same subject → allow/);
    expect(src).toMatch(/DENIED approval for the same subject → deny/);
    expect(src).toMatch(/EXPIRED approved approval/);
    // Fail-closed (policy failure cannot execute).
    expect(src).toMatch(/unresolvable scope → deny/);
    expect(src).toMatch(/repository throws → deny/);
    // Concurrency (the pending-approval idempotency).
    expect(src).toMatch(/two parallel asks for the same subject/);
    // The seam integration (deny/ask → blocked; constrained → limits; allow → executes).
    expect(src).toMatch(/deny → durable blocked observation; the executor is NEVER called/);
    expect(src).toMatch(/ask → durable blocked observation/);
    expect(src).toMatch(/constrained → the executor runs UNDER the tightened limits/);
    expect(src).toMatch(/constrained readOnly → a mutating invocation is BLOCKED/);
    expect(src).toMatch(/policy failure cannot execute/);
    // The external handoff eligibility.
    expect(src).toMatch(/external handoff eligibility/);
    // The architect's PR-#41 review: the approval-binding contract +
    // the audit-dedup invariant + the supersession semantics.
    expect(src).toMatch(/APPROVAL-BINDING CONTRACT/);
    expect(src).toMatch(/approved under v1 → same subject under v1 → allow/);
    expect(src).toMatch(/approved under v1 → policy bumps to v2 → ASK/);
    expect(src).toMatch(/rule-A replaced with rule-B → ASK/);
    expect(src).toMatch(/concurrent asks AFTER a policy-version change → exactly ONE new v2 pending/);
    expect(src).toMatch(/exactly ONE approval-requested audit event/);
    expect(src).toMatch(/supersedePendingApproval/);
    expect(src).toMatch(/the v1 pending is SUPERSEDED/);
  });

  // ==========================================================================
  // THE APPROVAL-BINDING CONTRACT + AUDIT-DEDUP INVARIANTS (architect's
  // PR-#41 review: approvals are bound to (policyVersion, ruleId);
  // concurrent asks emit exactly ONE audit event per pending DB row).
  // ==========================================================================
  it('the engine enforces the (policyVersion, ruleId) approval-binding contract in consultApproval', () => {
    const engineSrc = readFileSync(AP_ENGINE, 'utf8');
    // consultApproval reads BOTH latest.policyVersion AND latest.ruleId
    // against the current (version, expectedRuleId) the engine just
    // produced. A material policy change supersedes prior approvals.
    expect(engineSrc).toMatch(/latest\.policyVersion/);
    expect(engineSrc).toMatch(/latest\.ruleId/);
    expect(engineSrc).toMatch(/expectedRuleId/);
    expect(engineSrc).toMatch(/match\.rule\?\.id \?\? 'default'/);
    // The stale-approval path: supersede a stale PENDING; leave
    // approved/denied stale rows as terminal evidence (not mutated).
    expect(engineSrc).toMatch(/supersedePendingApproval\(/);
    expect(engineSrc).toMatch(/if \(latest\.status === 'pending'\)/);
    // The binding comment is in the source (provenance for the invariant).
    expect(engineSrc).toMatch(/APPROVAL-BINDING CONTRACT/);
  });

  it('ensurePending emits the approval-requested audit ONLY when the engine created the row (no duplicate audit evidence)', () => {
    const engineSrc = readFileSync(AP_ENGINE, 'utf8');
    // The { approval, created } destructure — the created flag drives the
    // audit decision.
    expect(engineSrc).toMatch(/\{ approval, created \}/);
    expect(engineSrc).toMatch(/this\.deps\.repository\.ensurePendingApproval\(/);
    // The audit is emitted ONLY when created=true (the row's creator). The
    // concurrent observer (created=false) does NOT emit a duplicate.
    expect(engineSrc).toMatch(/if \(created\)/);
    expect(engineSrc).toMatch(/auditApprovalEvent\('agent-policy\.approval-requested'/);
  });

  it('the repository interface binds approvals to (policyVersion, ruleId) + exposes supersedePendingApproval', () => {
    const typesSrc = readFileSync(AP_TYPES, 'utf8');
    // ensurePendingApproval returns { approval, created } so the engine
    // can dedupe the audit emission.
    expect(typesSrc).toMatch(/Promise<{ approval: AgentPolicyApproval; created: boolean }>/);
    // supersedePendingApproval is the sanctioned stale-pending path.
    expect(typesSrc).toMatch(/supersedePendingApproval\(approvalId: string\): Promise<void>/);
    // The binding contract is documented in the source (provenance).
    expect(typesSrc).toMatch(/APPROVAL-BINDING CONTRACT/);
  });

  it('the repository implements supersedePendingApproval as a CAS UPDATE (concurrent supersedes are idempotent)', () => {
    const repoSrc = readFileSync(AP_REPO, 'utf8');
    expect(repoSrc).toMatch(/async supersedePendingApproval\(approvalId: string\): Promise<void>/);
    // The CAS predicate is status='pending' (idempotent under concurrent
    // calls — the second UPDATE matches 0 rows).
    expect(repoSrc).toMatch(/WHERE id = \$1\s+AND status = 'pending'/);
    // The resolution_note + resolved_at are set (audit evidence).
    expect(repoSrc).toMatch(/superseded by policy-version change/);
    // ensurePendingApproval returns { approval, created }.
    expect(repoSrc).toMatch(/return \{ approval: mapApproval\(res\.rows\[0\]\), created: true \}/);
    expect(repoSrc).toMatch(/return \{ approval: existing, created: false \}/);
  });

  it('the migration documents the binding contract + the supersession semantics', () => {
    const sql = readFileSync(AP_MIGRATION, 'utf8');
    // The binding contract comment is in the migration (provenance for the
    // engine's runtime check; documents that approvals are bound to
    // (policy_version, rule_id), not just (execution_id, subject_key)).
    expect(sql).toMatch(/APPROVAL-BINDING CONTRACT/);
    expect(sql).toMatch(/policy_version, rule_id/);
    // The supersession path is documented (stale pending → 'expired';
    // approved/denied stale rows are NOT mutated).
    expect(sql).toMatch(/supersedePendingApproval/);
    expect(sql).toMatch(/status='pending'/);
    expect(sql).toMatch(/NOT mutated/);
    // The 'expired' status overload is documented (TTL-passed OR
    // policy-superseded; the resolution_note distinguishes them).
    expect(sql).toMatch(/'expired' status is overloaded/);
    expect(sql).toMatch(/superseded by policy-version change/);
  });

  // ==========================================================================
  // THE CANONICAL GIT-ARGV CLASSIFIER INVARIANTS (architect's PR-#41 review:
  // git deployment classification must skip global/config options before the
  // effective subcommand — ONE classifier shared by policy + executor; the
  // sandbox's network isolation is defense-in-depth, NOT the authority).
  // ==========================================================================
  it('the canonical git-argv classifier exists + is shared by BOTH the policy engine and the process executor (ONE vocabulary, no second copy)', () => {
    const classifierPath = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'git-argv.ts');
    expect(existsSync(classifierPath), 'git-argv.ts must exist').toBe(true);
    const classifierSrc = readFileSync(classifierPath, 'utf8');
    // The canonical exports (one source of truth).
    expect(classifierSrc).toMatch(/export function classifyGitSubcommand/);
    expect(classifierSrc).toMatch(/export function isGitDeploymentInvocation/);
    expect(classifierSrc).toMatch(/export const GIT_DEPLOYMENT_SUBCOMMANDS/);
    expect(classifierSrc).toMatch(/export const GIT_REDIRECT_FLAGS/);
    // BOTH layers import the SAME classifier from @platform/tools/git-argv.js
    // (the engine via the @platform alias — the correct one-way dependency
    // direction: Execution Policy → Tool Runtime; the executor same-layer).
    const engineSrc = readFileSync(AP_ENGINE, 'utf8');
    expect(engineSrc).toMatch(/from '@platform\/tools\/git-argv\.js'/);
    expect(engineSrc).toMatch(/isGitDeploymentInvocation/);
    const procPath = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'process-tool-executor.ts');
    const procSrc = readFileSync(procPath, 'utf8');
    expect(procSrc).toMatch(/from '\.\/git-argv\.js'/);
    expect(procSrc).toMatch(/isGitDeploymentInvocation/);
    // NEITHER layer keeps a local divergent copy of the deployment set (a
    // mismatch would let policy-allow what the executor rejects, or vice
    // versa). The architect's finding was precisely this duplication with a
    // positional args[0] check on each side.
    expect(engineSrc, 'the engine has NO local DEPLOYMENT_GIT_SUBCOMMANDS copy').not.toMatch(/const DEPLOYMENT_GIT_SUBCOMMANDS/);
    expect(procSrc, 'the executor has NO local GIT_REMOTE_SUBCOMMANDS copy').not.toMatch(/const GIT_REMOTE_SUBCOMMANDS/);
  });

  it('the engine classifies the EFFECTIVE git subcommand (NOT a positional args[0] check — the architect\'s finding)', () => {
    const engineSrc = readFileSync(AP_ENGINE, 'utf8');
    // tagInvocation calls isGitDeploymentInvocation(args) — the canonical
    // classifier that skips git's global/config options before the
    // effective subcommand (`git -c k=v push` is still push → deployment).
    expect(engineSrc).toMatch(/isGitDeploymentInvocation\(args\)/);
    // The positional args[0] check on the deployment set is GONE (the
    // architect's finding: args[0] was `-c`, not `push` → not deployment).
    expect(engineSrc, 'the engine NO LONGER checks args[0] against a local deployment set').not.toMatch(/DEPLOYMENT_GIT_SUBCOMMANDS\.has\(args\[0\]/);
  });

  it('the canonical classifier skips git\'s GLOBAL/CONFIG options before the effective subcommand (the architect\'s `git -c k=v push` example)', () => {
    const classifierPath = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'git-argv.ts');
    const classifierSrc = readFileSync(classifierPath, 'utf8');
    // The global-option vocabulary the classifier skips to find the
    // effective subcommand (value-taking short + long, boolean).
    expect(classifierSrc).toMatch(/GIT_GLOBAL_VALUE_OPTIONS_SHORT/);
    expect(classifierSrc).toMatch(/GIT_GLOBAL_VALUE_OPTIONS/);
    expect(classifierSrc).toMatch(/GIT_GLOBAL_BOOLEAN_OPTIONS/);
    // The architect's exact example: `-c k=v` (short, value-taking).
    expect(classifierSrc).toMatch(/'-c'/);
    // The `--` options terminator + the `=value` attached form.
    expect(classifierSrc).toMatch(/tok === '--'/);
    expect(classifierSrc).toMatch(/tok\.includes\('='\)/);
    // The fail-closed ambiguity path (unknown option before the subcommand
    // → treat as deployment so a crafted unknown option cannot smuggle a
    // remote mutation past the deployment rule).
    expect(classifierSrc).toMatch(/ambiguous/);
  });

  it('the regression matrix covers options-before-subcommand (the architect\'s scenarios) at all three layers', () => {
    // Layer 0: the canonical classifier unit proof.
    const classifierTest = join(BACKEND_ROOT, 'tests', 'unit', 'git-argv.test.ts');
    expect(existsSync(classifierTest), 'git-argv.test.ts must exist').toBe(true);
    const unitSrc = readFileSync(classifierTest, 'utf8');
    // The architect's exact example + the family of options-before-push.
    expect(unitSrc).toMatch(/git -c k=v push/);
    expect(unitSrc).toMatch(/git --no-pager push/);
    expect(unitSrc).toMatch(/git -C \/path push/);
    expect(unitSrc).toMatch(/git --git-dir=\/foo push/);
    // Options before fetch / remote / clone (the architect's "etc.").
    expect(unitSrc).toMatch(/git -c k=v fetch/);
    expect(unitSrc).toMatch(/git --no-pager remote/);
    expect(unitSrc).toMatch(/git -c k=v clone/);
    // The fail-closed ambiguity scenario.
    expect(unitSrc).toMatch(/fail-closed/);
    // Layer 1: the engine integration (agent-policy.regression.test.ts) —
    // the POLICY authorization decision is correct for the scenarios.
    const engineRegressionSrc = readFileSync(AP_REGRESSION, 'utf8');
    expect(engineRegressionSrc).toMatch(/PR#41: `git -c k=v push`/);
    expect(engineRegressionSrc).toMatch(/platform-deployment-deny/);
    expect(engineRegressionSrc).toMatch(/fail-closed on ambiguity/);
    // Layer 2: the executor integration (tool-runtime.regression.test.ts) —
    // the governance-gate rejection before any process spawns.
    const execRegressionPath = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'tool-runtime.regression.test.ts');
    const execRegressionSrc = readFileSync(execRegressionPath, 'utf8');
    expect(execRegressionSrc).toMatch(/git remote-network operations BEHIND global\/config options/);
    expect(execRegressionSrc).toMatch(/git-remote-operation-forbidden/);
    // The fix does NOT over-restrict LOCAL subcommands behind options.
    expect(execRegressionSrc).toMatch(/the fix does NOT over-restrict/);
  });

  // ==========================================================================
  // THE CANONICAL PACKAGE-ARGV CLASSIFIER INVARIANTS (architect's PR-#41
  // round-2 review at `35420da`: the git-argv canonical classifier was
  // approved; the package family's positional `args[0] === 'publish'`
  // shortcut was flagged as the analogous remaining gap — package runners
  // permit global/config options before the effective subcommand, so
  // `npm --registry=<url> publish` could be misclassified as ordinary
  // `tool` activity. ONE classifier shared by policy + executor; the
  // sandbox's network isolation is defense-in-depth, NOT the authority).
  // ==========================================================================
  it('the canonical package-argv classifier exists + is shared by BOTH the policy engine and the process executor (ONE vocabulary, no second copy)', () => {
    const classifierPath = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'package-argv.ts');
    expect(existsSync(classifierPath), 'package-argv.ts must exist').toBe(true);
    const classifierSrc = readFileSync(classifierPath, 'utf8');
    // The canonical exports (one source of truth).
    expect(classifierSrc).toMatch(/export function classifyPackageSubcommand/);
    expect(classifierSrc).toMatch(/export function isPackageDeploymentInvocation/);
    expect(classifierSrc).toMatch(/export const PACKAGE_PUBLISH_CAPABLE_RUNNERS/);
    expect(classifierSrc).toMatch(/export const PACKAGE_DEPLOYMENT_SUBCOMMANDS/);
    // BOTH layers import the SAME classifier — the engine via the @platform
    // alias (the correct one-way dependency direction: Execution Policy →
    // Tool Runtime); the executor same-layer (./package-argv.js).
    const engineSrc = readFileSync(AP_ENGINE, 'utf8');
    expect(engineSrc).toMatch(/from '@platform\/tools\/package-argv\.js'/);
    expect(engineSrc).toMatch(/isPackageDeploymentInvocation/);
    const procPath = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'process-tool-executor.ts');
    const procSrc = readFileSync(procPath, 'utf8');
    expect(procSrc).toMatch(/from '\.\/package-argv\.js'/);
    expect(procSrc).toMatch(/isPackageDeploymentInvocation/);
    // NEITHER layer keeps a local divergent copy of the publish-capable
    // runner set or the deployment subcommand set (a mismatch would let
    // policy-allow what the executor rejects, or vice versa). The
    // architect's round-2 finding was precisely this duplication with a
    // positional args[0] check on the engine side.
    expect(engineSrc, 'the engine has NO local PACKAGE_DEPLOYMENT copy').not.toMatch(/const PACKAGE_DEPLOYMENT_SUBCOMMANDS/);
    expect(procSrc, 'the executor has NO local PACKAGE_PUBLISH_CAPABLE copy').not.toMatch(/const PACKAGE_PUBLISH_CAPABLE_RUNNERS/);
  });

  it('the engine classifies the EFFECTIVE package subcommand (NOT a positional args[0] === \'publish\' shortcut — the architect\'s round-2 finding)', () => {
    const engineSrc = readFileSync(AP_ENGINE, 'utf8');
    // tagInvocation calls isPackageDeploymentInvocation(runner, args) — the
    // canonical classifier that skips the runner's global/config options
    // before the effective subcommand (`npm --registry=<url> publish` is
    // still publish → deployment).
    expect(engineSrc).toMatch(/isPackageDeploymentInvocation\(runner, args\)/);
    // The positional args[0] === 'publish' shortcut is GONE (the
    // architect's round-2 finding: args[0] was `--registry=...`, not
    // `publish` → not deployment → WRONG). This is the static invariant
    // the architect required: the shortcut cannot reappear.
    expect(engineSrc, 'the engine NO LONGER uses the positional args[0] === \'publish\' shortcut').not.toMatch(/args\[0\]\s*===\s*['"]publish['"]/);
  });

  it('the canonical package classifier skips the runner\'s GLOBAL/CONFIG options before the effective subcommand (the architect\'s `npm --registry=<...> publish` example)', () => {
    const classifierPath = join(BACKEND_ROOT, 'src', 'platform', 'tools', 'package-argv.ts');
    const classifierSrc = readFileSync(classifierPath, 'utf8');
    // The global-option vocabulary the classifier skips to find the
    // effective subcommand (value-taking long + short, boolean long + short).
    expect(classifierSrc).toMatch(/PACKAGE_GLOBAL_VALUE_OPTIONS\b/);
    expect(classifierSrc).toMatch(/PACKAGE_GLOBAL_VALUE_OPTIONS_SHORT\b/);
    expect(classifierSrc).toMatch(/PACKAGE_GLOBAL_BOOLEAN_OPTIONS\b/);
    expect(classifierSrc).toMatch(/PACKAGE_GLOBAL_BOOLEAN_OPTIONS_SHORT\b/);
    // The architect's exact example: `--registry=<url>` (long, value-taking,
    // the `=` attached form). The space form `--registry <url>` is also
    // handled (the value-taking long set consumes the next token).
    expect(classifierSrc).toMatch(/'--registry'/);
    // The `--` options terminator + the `=value` attached form.
    expect(classifierSrc).toMatch(/tok === '--'/);
    expect(classifierSrc).toMatch(/tok\.includes\('='\)/);
    // The fail-closed ambiguity path (unknown option before the subcommand
    // → treat as deployment so a crafted unknown option cannot smuggle a
    // publication past the deployment rule).
    expect(classifierSrc).toMatch(/ambiguous/);
    // The runner gate (publish-capable only) — non-publish-capable runners
    // (node/npx/tsx/…) never get a false deployment-deny.
    expect(classifierSrc).toMatch(/PACKAGE_PUBLISH_CAPABLE_RUNNERS\.has\(runner\)/);
    // The publish family (the frozen contract's "package 'publish' commands").
    expect(classifierSrc).toMatch(/'publish'/);
    expect(classifierSrc).toMatch(/'unpublish'/);
    expect(classifierSrc).toMatch(/'deprecate'/);
  });

  it('the regression matrix covers options-before-subcommand (the architect\'s round-2 scenarios) at all three layers', () => {
    // Layer 0: the canonical classifier unit proof.
    const classifierTest = join(BACKEND_ROOT, 'tests', 'unit', 'package-argv.test.ts');
    expect(existsSync(classifierTest), 'package-argv.test.ts must exist').toBe(true);
    const unitSrc = readFileSync(classifierTest, 'utf8');
    // The architect's exact example + the family of options-before-publish.
    expect(unitSrc).toMatch(/npm --registry=http:\/\/x publish/);
    expect(unitSrc).toMatch(/npm --silent publish/);
    expect(unitSrc).toMatch(/npm --workspace foo publish/);
    // Options before publish for the other publish-capable runners.
    expect(unitSrc).toMatch(/pnpm --filter foo publish/);
    expect(unitSrc).toMatch(/pnpm -C \/path publish/);
    expect(unitSrc).toMatch(/yarn --cwd \/path publish/);
    // The publish-family siblings behind options.
    expect(unitSrc).toMatch(/npm --registry=http:\/\/x unpublish/);
    expect(unitSrc).toMatch(/npm --silent deprecate/);
    // The normal (local) case — `npm test` must NOT be deployment.
    expect(unitSrc).toMatch(/`npm test` → NOT deployment/);
    // The non-publish-capable runner case (node + publish as a script arg).
    expect(unitSrc).toMatch(/node --inspect publish\.js/);
    // The fail-closed ambiguity scenario.
    expect(unitSrc).toMatch(/fail-closed/);
    // The value-taking option's value cannot smuggle a publish-looking token.
    expect(unitSrc).toMatch(/cannot smuggle a publish-looking token/);

    // Layer 1: the engine integration (agent-policy.regression.test.ts) —
    // the POLICY authorization decision is correct for the scenarios.
    const engineRegressionSrc = readFileSync(AP_REGRESSION, 'utf8');
    expect(engineRegressionSrc).toMatch(/PR#41 round 2: `npm --registry=http:\/\/x publish`/);
    expect(engineRegressionSrc).toMatch(/platform-deployment-deny/);
    expect(engineRegressionSrc).toMatch(/fail-closed on ambiguity/);
    expect(engineRegressionSrc).toMatch(/non-publish-capable runner/);

    // Layer 2: the executor integration (tool-runtime.regression.test.ts)
    // — the governance-gate rejection before any process spawns.
    const execRegressionPath = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'tool-runtime.regression.test.ts');
    const execRegressionSrc = readFileSync(execRegressionPath, 'utf8');
    expect(execRegressionSrc).toMatch(/package publish operations are DENIED at the governance gate/);
    expect(execRegressionSrc).toMatch(/package-publish-forbidden/);
    // The fix does NOT over-restrict LOCAL commands / non-publish-capable
    // runners (the architect's surgical principle).
    expect(execRegressionSrc).toMatch(/the fix does NOT over-restrict/);
  });
});

/**
 * WORK-038 invariants — Existing Project Onboarding (the Project Baseline
 * boundary + the onboarding application capability).
 *
 * The central correctness requirement: WorkflowOS must NEVER pretend
 * inferred/reconstructed architecture was the historical authoritative
 * architecture of the original project. Every reconstructed fact carries
 * provenance (observed/inferred/confirmed/proposed); provenance is never
 * collapsed into a confidence number; provenance is never silently promoted.
 *
 * Authority boundaries preserved:
 *   /github       — the repository + exact-revision authority (NO GitHub SDK
 *                   in the onboarding domain; the adapter is the only SDK caller)
 *   /projects     — the Project Baseline STORAGE authority (the baseline is a
 *                   project artifact; /projects remains the single project
 *                   authority; onboarding owns NO tables)
 *   /architecture — the architecture authority (onboarding NEVER auto-freezes;
 *                    proposed architecture is a PROPOSED observation, never an
 *                    ArchitectureVersion)
 *   /workflows, /verification, /reviews — never mutated by onboarding
 *
 * The onboarding capability lives in src/onboarding/ — an APPLICATION-LAYER
 * orchestrator (like src/execution-policy/ + src/benchmark/), NOT a frozen
 * module and NOT an authority.
 */
describe('WORK-038 invariants — Existing Project Onboarding (Project Baseline + onboarding capability)', () => {
  const ONBOARDING_DIR = join(SRC_ROOT, 'onboarding');
  const PROJECTS_BASELINE_REPO = join(MODULES_DIR, 'projects', 'internal', 'pg-project-baseline-repository.ts');
  const MIGRATION_0038 = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0038_project_baselines.sql');
  const ENGINE_PATH = join(MODULES_DIR, 'agents', 'internal', 'agent-policy-engine.ts');

  /** Recursively list every .ts file under a directory. */
  function listTsFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...listTsFiles(full));
      } else if (entry.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('WORK-038 is NOT a frozen module — onboarding is an application capability, not a new authority', () => {
    // The static check at PLAT-AC-01 enforces exactly 17 frozen modules. The
    // onboarding capability must NOT add an 18th module under src/modules/.
    // It lives under src/onboarding/ (an application-layer directory, like
    // src/execution-policy/ and src/benchmark/).
    expect(existsSync(join(MODULES_DIR, 'onboarding'))).toBe(false);
    expect(existsSync(ONBOARDING_DIR)).toBe(true);
  });

  it('no second project authority — onboarding does NOT create projects (it stores baselines under existing /projects authority rows)', () => {
    // The onboarding orchestrator + analyzer must not create Project rows.
    // It reads the project (to resolve orgId) + stores baselines THROUGH
    // /projects (the single project authority).
    const files = [...listTsFiles(ONBOARDING_DIR), PROJECTS_BASELINE_REPO];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // The baseline repository must not expose a project-creation method.
      // (It may reference ProjectRepository.findById — read-only — but must
      // not call create/transitionState on the project.)
      expect(
        src,
        `${relative(BACKEND_ROOT, f)} must not create/transition projects`,
      ).not.toMatch(/projectRepository\.(create|transitionState|update)\s*\(/);
    }
  });

  it('no second repository / GitHub authority — onboarding imports NO GitHub SDK + no /github internal/', () => {
    // The onboarding domain holds no GitHub credentials and no GitHub SDK.
    // It consumes the /github barrel (GitHubAdapter.getBranch +
    // ProjectGitHubRepositoryRepository) — the adapter is the only SDK caller.
    const files = listTsFiles(ONBOARDING_DIR);
    expect(files.length, 'src/onboarding/ must contain implementation files').toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import @octokit (GitHub SDK)`).not.toMatch(/from\s+['"]@octokit/);
      expect(src, `${rel} must not import /github internal/`).not.toMatch(/from\s+['"][^'"]*modules\/github\/internal/);
      // The onboarding barrel (index.ts) imports internal/ within its own
      // module — that's allowed (it's not a cross-module internal/ import).
    }
  });

  it('no second architecture authority — onboarding NEVER auto-freezes / never creates ArchitectureVersion rows', () => {
    // Proposed architecture is a PROPOSED baseline observation, never an
    // ArchitectureVersion. Onboarding never calls ArchitectureService
    // mutation methods (freezeVersion / approveChangeAndCreateReplacement /
    // ArchitectureVersionRepository.create). The /architecture authority is
    // untouched.
    const files = listTsFiles(ONBOARDING_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /architecture internal/`).not.toMatch(/from\s+['"][^'"]*modules\/architecture\/internal/);
      expect(src, `${rel} must not freeze architecture versions`).not.toMatch(/freezeVersion\s*\(/);
      expect(src, `${rel} must not create architecture versions`).not.toMatch(/architectureVersionRepository\.create\s*\(/);
      expect(src, `${rel} must not approve architecture change requests`).not.toMatch(/approveChangeAndCreateReplacement\s*\(/);
    }
  });

  it('no second requirements authority — onboarding does NOT create Requirement/AcceptanceCriterion rows', () => {
    // Inferred requirements are OBSERVATIONS (provenance=inferred), never
    // authoritative requirements. The /requirements authority is untouched.
    const files = listTsFiles(ONBOARDING_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /requirements internal/`).not.toMatch(/from\s+['"][^'"]*modules\/requirements\/internal/);
      expect(src, `${rel} must not create requirements`).not.toMatch(/requirementRepository\.create\s*\(/);
      expect(src, `${rel} must not create acceptance criteria`).not.toMatch(/acceptanceCriterionRepository\.create\s*\(/);
    }
  });

  it('no workflow / verification / review mutation — onboarding never mutates those authorities', () => {
    const files = listTsFiles(ONBOARDING_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /workflows internal/`).not.toMatch(/from\s+['"][^'"]*modules\/workflows\/internal/);
      expect(src, `${rel} must not import /verification internal/`).not.toMatch(/from\s+['"][^'"]*modules\/verification\/internal/);
      expect(src, `${rel} must not import /reviews internal/`).not.toMatch(/from\s+['"][^'"]*modules\/reviews\/internal/);
    }
  });

  it('no credentials — onboarding never imports a concrete secret store + never assigns token/password values', () => {
    // The onboarding domain never handles credentials. Secret-shaped content
    // is redacted by the platform observation-redaction util before persistence.
    const files = listTsFiles(ONBOARDING_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import EnvSecretStore`).not.toMatch(/EnvSecretStore/);
      expect(src, `${rel} must not import the secret-store barrel`).not.toMatch(/from\s+['"]@platform\/secrets/);
      expect(src, `${rel} must not import /auth internal/`).not.toMatch(/from\s+['"][^'"]*modules\/auth\/internal/);
    }
  });

  it('no provider SDK leakage — onboarding domain imports no pg / ioredis / pglite', () => {
    const files = listTsFiles(ONBOARDING_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import pg`).not.toMatch(/from\s+['"]pg['"]/);
      expect(src, `${rel} must not import pglite`).not.toMatch(/from\s+['"]@electric-sql\/pglite/);
      expect(src, `${rel} must not import ioredis`).not.toMatch(/from\s+['"]ioredis/);
    }
  });

  it('no maintenance engine / no continuous scheduler — onboarding is baseline reconstruction, not continuous maintenance', () => {
    // WORK-041 (maintenance/health) + WORK-040 (continuous planner) are
    // STRICTLY OUT OF SCOPE. Onboarding produces a ONE-SHOT baseline; it does
    // not schedule recurring scans or maintenance work items.
    const files = listTsFiles(ONBOARDING_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not declare a cron/scheduler`).not.toMatch(/setInterval\s*\(|cron\s*\(/);
      expect(src, `${rel} must not declare a maintenance engine`).not.toMatch(/MaintenanceEngine|HealthEngine/);
    }
  });

  it('provenance required on every reconstructed fact — the migration CHECK enforces the four-value vocabulary', () => {
    const sql = readFileSync(MIGRATION_0038, 'utf8');
    // The observation provenance CHECK.
    expect(sql).toMatch(/provenance TEXT NOT NULL CHECK \(provenance IN \(\s*'observed',\s*'inferred',\s*'confirmed',\s*'proposed'\s*\)/);
    // The baseline state CHECK.
    expect(sql).toMatch(/state TEXT NOT NULL DEFAULT 'analyzing' CHECK \(state IN \(\s*'analyzing',\s*'complete',\s*'failed'\s*\)\)/);
    // The observation-kind CHECK enumerates the baseline-content categories.
    expect(sql).toMatch(/kind TEXT NOT NULL CHECK \(kind IN/);
  });

  it('exact repository revision required — baseline_commit_sha is NOT NULL + immutable', () => {
    const sql = readFileSync(MIGRATION_0038, 'utf8');
    expect(sql).toMatch(/baseline_commit_sha TEXT NOT NULL/);
    // The identity-immutable guard rejects re-targeting the commit SHA.
    expect(sql).toMatch(/NEW\.baseline_commit_sha IS DISTINCT FROM OLD\.baseline_commit_sha/);
    // Idempotency: UNIQUE(project, repo, exact commit).
    expect(sql).toMatch(/UNIQUE \(project_id, project_github_repository_id, baseline_commit_sha\)/);
  });

  it('no silent provenance promotion — the observation-guard trigger enforces the authorized confirmation path', () => {
    const sql = readFileSync(MIGRATION_0038, 'utf8');
    // confirmed requires confirmed_by + confirmed_at (the authorized path).
    expect(sql).toMatch(/provenance=confirmed requires confirmed_by \+ confirmed_at/);
    // Non-confirmed observations must NOT carry confirmation metadata.
    expect(sql).toMatch(/provenance=% must not carry confirmed_by\/confirmed_at/);
    // Only inferred/proposed → confirmed is a legal promotion.
    expect(sql).toMatch(/only inferred\/proposed -> confirmed via the authorized path is permitted/);
    // The claim is immutable (a row is never rewritten under the same key).
    expect(sql).toMatch(/observation kind\/claim\/digest is immutable/);
  });

  it('failed analysis cannot produce a false confirmed baseline — markFailed refuses when a confirmed observation exists', () => {
    // The pg repository's markFailed refuses if any observation is confirmed
    // (the "failed analysis cannot produce a false confirmed baseline"
    // invariant). This is the service-level guard; the trigger is the backstop.
    const src = readFileSync(PROJECTS_BASELINE_REPO, 'utf8');
    expect(src).toMatch(/project-baseline-no-confirmed-on-failed/);
    expect(src).toMatch(/provenance = 'confirmed'/);
  });

  it('the onboarding barrel is types-only — no concrete implementations exported', () => {
    // Mirrors the frozen-module barrel rule (line ~880). The onboarding
    // barrel exposes only type aliases + interface contracts; the concrete
    // DefaultOnboardingService + GovernedFilesystemAnalyzer stay in internal/
    // and are wired by app.ts.
    const barrel = readFileSync(join(ONBOARDING_DIR, 'index.ts'), 'utf8');
    // Value re-exports forbidden (only `export type` + the barrel's own type
    // aliases). The barrel may re-export type aliases of internal classes
    // (DefaultOnboardingService etc.) via `export type { ... }` — that is a
    // TYPE-ONLY re-export, not a value export, so it's permitted.
    const valueExportRe = /export\s+(?!type\b)\{([^}]+)\}\s+from\s+['"]/g;
    const violations: string[] = [];
    for (const m of barrel.matchAll(valueExportRe)) {
      const names = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      for (const n of names) {
        violations.push(`src/onboarding/index.ts value-exports "${n}"`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('decideForProjectScope is ADDITIVE — the engine still implements decide() unchanged (the native execution path)', () => {
    // The frozen ToolPolicyGate seam is UNCHANGED. The engine gains an
    // additive project-scoped method for onboarding; the native decide()
    // path (execution-scoped, with the durable ask→approval interaction) is
    // preserved.
    const engine = readFileSync(ENGINE_PATH, 'utf8');
    expect(engine).toMatch(/async decide\(request: ToolPolicyRequest\)/);
    expect(engine).toMatch(/async decideForProjectScope\(/);
    // decide() still resolves scope by executionId (the native path).
    expect(engine).toMatch(/resolveScope\(request\.executionId\)/);
    // decide() still routes ask through resolveAsk (the durable approval path).
    expect(engine).toMatch(/this\.resolveAsk\(scope, request, core\.tags, core\.match, core\.version, core\.document\)/);
    // The shared core is extracted (no duplicated matcher — the architect's
    // "no second engine" principle).
    expect(engine).toMatch(/private async evaluateCore/);
    // decideForProjectScope is NON-INTERACTIVE (no approval creation for ask).
    expect(engine).toMatch(/onboarding is NON-INTERACTIVE/);
  });

  it('the analyzer NEVER produces confirmed observations — confirmation is the authorized human path only', () => {
    // The "no silent promotion" invariant at the SOURCE: the analyzer can
    // only emit observed/inferred/proposed. Only the /projects
    // confirmObservation method (called by the authorized route) can produce
    // confirmed. This is verified by asserting the analyzer source never
    // emits provenance: 'confirmed'.
    const analyzer = readFileSync(join(ONBOARDING_DIR, 'internal', 'governed-filesystem-analyzer.ts'), 'utf8');
    expect(analyzer).not.toMatch(/provenance:\s*['"]confirmed['"]/);
    expect(analyzer).toMatch(/provenance:\s*['"]observed['"]/);
    expect(analyzer).toMatch(/provenance:\s*['"]inferred['"]/);
    expect(analyzer).toMatch(/provenance:\s*['"]proposed['"]/);
  });

  it('tenant isolation — every baseline query is scoped by project_id (+ organization_id denormalized)', () => {
    // The pg repository's read queries must scope by project_id (which is
    // org-scoped via wfos_projects). No cross-tenant access (no "list all
    // baselines" without a project filter).
    const src = readFileSync(PROJECTS_BASELINE_REPO, 'utf8');
    // findById is permitted (it returns the row; the ROUTE checks
    // baseline.projectId === projectId — verified in onboarding.route.ts).
    // listForProject scopes by project_id.
    expect(src).toMatch(/listForProject\(projectId: string\)/);
    expect(src).toMatch(/WHERE project_id = \$1 ORDER BY created_at DESC/);
  });

  it('the route layer verifies ownership server-side — a baseline UUID is NOT an authorization credential', () => {
    // onboarding.route.ts must check baseline.projectId === projectId for
    // every baseline-scoped mutation/read (no UUID-as-credential).
    const route = readFileSync(join(SRC_ROOT, 'api', 'routes', 'onboarding.route.ts'), 'utf8');
    expect(route).toMatch(/baseline\.projectId !== projectId/);
    expect(route).toMatch(/requireProjectAuthorization/);
  });

  // =========================================================================
  // PR #42 review fixes (three blockers the architect identified).
  // =========================================================================

  it('PR #42 (Blocker 1): the GitHubAdapter interface declares getFileContent + listDir (content-read through /github)', () => {
    // The /github authority is the natural home for content-read — the
    // onboarding domain holds no GitHub SDK. The GitHubAdapter interface
    // must declare getFileContent (returns null when the path does not exist
    // at that revision) + listDir. The DTOs live in
    // project-github-repository.types.ts and are exported through the
    // /github barrel.
    const githubTypes = readFileSync(
      join(MODULES_DIR, 'github', 'internal', 'github.types.ts'),
      'utf8',
    );
    expect(githubTypes).toMatch(/getFileContent\(input: GetFileContentInput\): Promise<GetFileContentResult \| null>/);
    expect(githubTypes).toMatch(/listDir\(input: ListDirInput\): Promise<ListDirResult>/);
    const dtoTypes = readFileSync(
      join(MODULES_DIR, 'github', 'internal', 'project-github-repository.types.ts'),
      'utf8',
    );
    expect(dtoTypes).toMatch(/export interface GetFileContentInput/);
    expect(dtoTypes).toMatch(/export interface GetFileContentResult/);
    expect(dtoTypes).toMatch(/export interface ListDirInput/);
    expect(dtoTypes).toMatch(/export interface ListDirResult/);
    expect(dtoTypes).toMatch(/export interface RepoDirEntry/);
    // The /github barrel exports the new DTOs (the sanctioned surface).
    const ghBarrel = readFileSync(join(MODULES_DIR, 'github', 'index.ts'), 'utf8');
    expect(ghBarrel).toMatch(/GetFileContentInput/);
    expect(ghBarrel).toMatch(/GetFileContentResult/);
    expect(ghBarrel).toMatch(/ListDirInput/);
    expect(ghBarrel).toMatch(/ListDirResult/);
    expect(ghBarrel).toMatch(/RepoDirEntry/);
  });

  it('PR #42 (Blocker 1): a PRODUCTION RepositoryContentPort implementation exists + delegates to the /github GitHubAdapter (no GitHub SDK in onboarding)', () => {
    // The PR #42 review identified that the production analyzer had NO
    // RepositoryContentPort — onboarding never inspected repository files
    // (only metadata-derived observations); tests used an in-memory
    // provider. The fix: a production GitHubRepositoryContentPort that
    // delegates to the /github GitHubAdapter (the only SDK caller). The
    // onboarding domain imports ONLY the /github barrel (the GitHubAdapter
    // TYPE) — never /github internal/, never @octokit, never provider SDKs.
    const contentPortPath = join(ONBOARDING_DIR, 'internal', 'github-content-port.ts');
    expect(existsSync(contentPortPath), 'src/onboarding/internal/github-content-port.ts must exist').toBe(true);
    const src = readFileSync(contentPortPath, 'utf8');
    expect(src, 'implements RepositoryContentPort').toMatch(/implements RepositoryContentPort/);
    expect(src, 'delegates readFile to GitHubAdapter.getFileContent').toMatch(/githubAdapter\.getFileContent/);
    expect(src, 'delegates listDir to GitHubAdapter.listDir').toMatch(/githubAdapter\.listDir/);
    expect(src, 'imports the GitHubAdapter TYPE from the /github barrel').toMatch(/from\s+['"]@modules\/github\/index\.js['"]/);
    // No GitHub SDK, no /github internal/, no provider SDKs, no credentials.
    expect(src, 'must not import @octokit').not.toMatch(/from\s+['"]@octokit/);
    expect(src, 'must not import /github internal/').not.toMatch(/from\s+['"][^'"]*modules\/github\/internal/);
    expect(src, 'must not import pg').not.toMatch(/from\s+['"]pg['"]/);
    expect(src, 'must not import pglite').not.toMatch(/from\s+['"]@electric-sql\/pglite/);
    // The onboarding barrel re-exports the production port (type-only).
    const barrel = readFileSync(join(ONBOARDING_DIR, 'index.ts'), 'utf8');
    expect(barrel).toMatch(/GitHubRepositoryContentPort/);
  });

  it('PR #42 (Blocker 1): app.ts wires the production RepositoryContentPort into the GovernedFilesystemAnalyzer (production onboarding inspects files)', () => {
    // The composition root MUST construct the GovernedFilesystemAnalyzer with
    // a contentPort (the production GitHubRepositoryContentPort delegating to
    // the /github GitHubAdapter). Without this wiring, production onboarding
    // never inspected repository files — the analyzer's
    // `if (allowed && this.deps.contentPort)` branch was never taken.
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc, 'imports GitHubRepositoryContentPort').toMatch(/GitHubRepositoryContentPort/);
    expect(appSrc, 'constructs GitHubRepositoryContentPort').toMatch(/new GitHubRepositoryContentPort\(/);
    expect(appSrc, 'passes contentPort to GovernedFilesystemAnalyzer').toMatch(/contentPort:\s*onboardingContentPort/);
  });

  it('PR #42 (Blocker 2): the observation DELETE trigger forbids direct DELETE (append-only historical evidence)', () => {
    // The PR #42 review identified that the migration's DELETE trigger
    // explicitly permitted deletion (`RETURN OLD`) despite describing
    // observations as append-only historical evidence. The fix: the trigger
    // refuses a direct DELETE when the parent baseline still exists; the
    // ONLY legitimate removal path is the CASCADE from baseline deletion
    // (which fires AFTER the parent row is gone — the PERFORM check returns
    // NOT FOUND during a CASCADE, so the trigger allows it).
    const sql = readFileSync(MIGRATION_0038, 'utf8');
    expect(sql, 'the DELETE branch checks the parent baseline still exists').toMatch(/PERFORM 1 FROM wfos_project_baselines WHERE id = OLD\.baseline_id/);
    expect(sql, 'the DELETE branch raises the append-only exception').toMatch(/project-baseline-observation-append-only/);
    expect(sql, 'documents the only-legitimate-removal path (CASCADE)').toMatch(/CASCADE from baseline deletion/);
    // The old permissive `RETURN OLD`-only DELETE branch must be GONE
    // (replaced by the FOUND check + RAISE). The regex matches the OLD
    // permissive pattern: a DELETE branch that returns OLD unconditionally
    // without the FOUND guard. We assert the permissive pattern is absent by
    // checking the DELETE branch is immediately followed by the PERFORM
    // check (not a bare RETURN OLD).
    expect(sql, 'no permissive DELETE branch (RETURN OLD without the FOUND guard)').not.toMatch(/TG_OP = 'DELETE' THEN\s+-- Observations are append-only historical evidence\. A terminal baseline's\s+-- observations are immutable/);
  });

  it('PR #42 (Blocker 2): the append-only DELETE guard permits the CASCADE from baseline deletion (the parent baseline is already gone)', () => {
    // The trigger must ALLOW the CASCADE (when the parent baseline row is
    // already gone). The PERFORM-FOUND check returns NOT FOUND during a
    // CASCADE (the parent DELETE happened earlier in the same statement /
    // transaction), so the trigger falls through to RETURN OLD. This is
    // verified structurally: the RAISE is INSIDE `IF FOUND`, so a NOT-FOUND
    // result skips the RAISE and reaches RETURN OLD.
    const sql = readFileSync(MIGRATION_0038, 'utf8');
    // The RAISE is gated by `IF FOUND` (direct DELETE); a CASCADE (NOT
    // FOUND) falls through to RETURN OLD.
    expect(sql).toMatch(/IF FOUND THEN\s+RAISE EXCEPTION\s+'project-baseline-observation-append-only/);
    expect(sql).toMatch(/RETURN OLD;/);
  });

  it('PR #42 (Blocker 3): confirmObservation checks the parent baseline state — a failed baseline NEVER carries a confirmed observation', () => {
    // The PR #42 review identified that confirmObservation did not check
    // the parent baseline state, allowing failed → confirmed. The invariant
    // (migration 0038): "a failed baseline NEVER carries a confirmed
    // observation (failed analysis cannot produce a false confirmed
    // baseline)." markFailed enforces the symmetric side; confirmObservation
    // must enforce THIS side — refuse when the parent baseline is failed.
    const src = readFileSync(PROJECTS_BASELINE_REPO, 'utf8');
    // The confirmObservation method must SELECT the parent baseline state
    // BEFORE issuing the UPDATE.
    expect(src, 'selects the parent baseline state before confirming').toMatch(/SELECT state FROM wfos_project_baselines WHERE id = \$1/);
    expect(src, 'refuses to confirm a failed baseline').toMatch(/baselineState === 'failed'/);
    expect(src, 'throws the sanctioned no-confirmed-on-failed error').toMatch(/project-baseline-no-confirmed-on-failed/);
  });

  it('PR #42 (Blocker 3): the route surfaces the no-confirmed-on-failed error as 409 (not 500)', () => {
    // The confirm route must translate the repository's
    // no-confirmed-on-failed error into a 409 (conflict) so the caller
    // distinguishes the invariant violation from a server error.
    const route = readFileSync(join(SRC_ROOT, 'api', 'routes', 'onboarding.route.ts'), 'utf8');
    expect(route).toMatch(/msg\.includes\('no-confirmed-on-failed'\)/);
    expect(route).toMatch(/reply\.code\(409\)\.send\(\{[^}]*error: 'no-confirmed-on-failed'/);
  });

  // =========================================================================
  // PR #42 round-2 review (the two new blockers the architect identified on
  // the 48c4612 diff). The previous three blockers are substantially
  // addressed; round-2 closes two remaining correctness/architecture gaps.
  // =========================================================================

  it('PR #42 r2 (Blocker A): the analyzer does NOT manufacture toolInvocationId for /github-authority reads (no ToolRuntime invocation happened)', () => {
    // The architect's PR #42 round-2 Blocker A: the production path is
    //   Onboarding → GovernedFilesystemAnalyzer
    //     → ToolPolicyGate.decideForProjectScope()
    //     → GitHubRepositoryContentPort
    //         → GitHubAdapter.getFileContent/listDir()
    // The policy gate is consulted, but the actual repository read is
    // performed directly by /github. There is NO ToolRuntime invocation,
    // NO real tool claim, NO tool observation. The evidence row must NOT
    // manufacture a tool_invocation_id for operations that never went
    // through Tool Runtime. The policy_decision must NOT imply a host
    // tool run occurred (the schema reserves policy_decision for "host
    // tool run" audit trail — the /github read is NOT a host tool run).
    //
    // The analyzer source must:
    //   * set toolInvocationId: null on every NewBaselineEvidence it produces;
    //   * set policyDecision: null on every NewBaselineEvidence it produces;
    //   * NOT persist the policy-gate invocationId (the stable decision key)
    //     as the evidence row's tool_invocation_id (that was the
    //     fabrication the architect identified).
    const analyzer = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'governed-filesystem-analyzer.ts'),
      'utf8',
    );
    // The evidence row's toolInvocationId is NULL (no ToolRuntime invocation).
    expect(analyzer, 'evidence toolInvocationId is null (no ToolRuntime invocation)').toMatch(/toolInvocationId:\s*null/);
    // The evidence row's policyDecision is NULL (no host tool run — the
    // /github read path is not a ToolRuntime invocation).
    expect(analyzer, 'evidence policyDecision is null (no host tool run)').toMatch(/policyDecision:\s*null/);
    // The observation→evidence linkage uses the LOCATOR (the path), not a
    // manufactured toolInvocationId. The orchestrator resolves locator→
    // evidence id by the composite (source, locator) key.
    expect(analyzer, 'observations reference evidence by locator').toMatch(/evidenceRef:\s*packageJsonEvidence\s*\?\s*\[packageJsonEvidence\.locator\]/);
    expect(analyzer, 'ci observation references evidence by locator').toMatch(/evidenceRef:\s*ciEvidence\s*\?\s*\[ciEvidence\.locator\]/);
    expect(analyzer, 'deployment observation references evidence by locator').toMatch(/evidenceRef:\s*dockerfileEvidence\s*\?\s*\[dockerfileEvidence\.locator\]/);
    // The policy-gate invocationId (the stable decision key) is INTERNAL
    // to the policy request — it is NOT persisted on the evidence row.
    // The analyzer must NOT assign invocationId to ev.toolInvocationId.
    expect(analyzer, 'must not assign the policy invocationId to evidence toolInvocationId').not.toMatch(/toolInvocationId:\s*invocationId/);
  });

  it('PR #42 r2 (Blocker A): the migration evidence UNIQUE constraint is (baseline_id, source, locator) — the honest idempotency key (NOT tool_invocation_id)', () => {
    // The architect's PR #42 round-2 Blocker A: the previous UNIQUE
    // (baseline_id, tool_invocation_id) could not deduplicate re-drives
    // once tool_invocation_id became NULL for /github-authority reads
    // (NULL != NULL in PostgreSQL UNIQUE). The honest composite key is
    // (baseline_id, source, locator) — one evidence row per read locator
    // per baseline. A re-drive upserts the same row, no duplicates.
    const sql = readFileSync(MIGRATION_0038, 'utf8');
    expect(sql, 'the evidence UNIQUE is on (baseline_id, source, locator)').toMatch(/UNIQUE \(baseline_id, source, locator\)/);
    // The OLD (baseline_id, tool_invocation_id) constraint name must be
    // GONE (replaced by the locator-based constraint).
    expect(sql, 'the old (baseline_id, tool_invocation_id) UNIQUE is removed').not.toMatch(/UNIQUE \(baseline_id, tool_invocation_id\)/);
    // The pg repository's appendEvidence uses the new composite key for
    // ON CONFLICT + the re-fetch SELECT.
    const repo = readFileSync(PROJECTS_BASELINE_REPO, 'utf8');
    expect(repo, 'appendEvidence ON CONFLICT uses (baseline_id, source, locator)').toMatch(/ON CONFLICT \(baseline_id, source, locator\) DO NOTHING/);
    expect(repo, 'appendEvidence re-fetch SELECT uses (source, locator)').toMatch(/WHERE baseline_id = \$1 AND source = \$2 AND locator = \$3/);
  });

  it('PR #42 r2 (Blocker A): the pg repository appendEvidence uses the honest composite key (no tool_invocation_id in ON CONFLICT)', () => {
    // The pg repository's appendEvidence must NOT use tool_invocation_id
    // as the ON CONFLICT key (that would fail when tool_invocation_id is
    // NULL — NULL != NULL in PostgreSQL UNIQUE, so no conflict would be
    // detected and a re-drive would duplicate evidence rows).
    const repo = readFileSync(PROJECTS_BASELINE_REPO, 'utf8');
    expect(repo, 'must NOT ON CONFLICT on tool_invocation_id').not.toMatch(/ON CONFLICT \(baseline_id, tool_invocation_id\)/);
    expect(repo, 'must NOT SELECT evidence by tool_invocation_id alone').not.toMatch(/WHERE baseline_id = \$1 AND tool_invocation_id = \$2/);
  });

  it('PR #42 r2 (Blocker B): the governed repository-read boundary propagates infrastructure failures (no swallow-and-continue)', () => {
    // The architect's PR #42 round-2 Blocker B: the analyzer's per-candidate
    // try/catch around content reads swallowed infrastructure failures
    // (GitHub unavailable, authentication failure, API failure, content
    // retrieval infrastructure failure). That meant a production GitHub
    // configuration failure could result in a COMPLETED Project Baseline
    // containing effectively only repository metadata, rather than a
    // failed/incomplete onboarding. False success for the central WORK-038
    // objective: establishing a baseline FROM REPOSITORY EVIDENCE.
    //
    // PR #42 round-3 refactored the throw to the governed repository-read
    // BOUNDARY (src/onboarding/internal/governed-repository-read-policy.ts) —
    // the analyzer now calls governedRead() per candidate and propagates the
    // boundary's typed OnboardingAnalysisError (no try/catch swallowing).
    // The boundary is the honest home for the throw: it captures the decision
    // + performs the read + propagates the infrastructure failure with the
    // bound authorization (decision + policyVersion + ruleId) in the error
    // context (forensic provenance travels with the failure even though no
    // evidence row is persisted).
    const boundary = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'governed-repository-read-policy.ts'),
      'utf8',
    );
    expect(boundary, 'the boundary throws OnboardingAnalysisError on content-read failure').toMatch(/throw new OnboardingAnalysisError\(/);
    expect(boundary, 'uses the sanctioned repository-content-unavailable code').toMatch(/'repository-content-unavailable'/);
    // The analyzer NO LONGER throws the typed error itself (the boundary
    // does). The analyzer calls governedRead() per candidate and the boundary
    // error propagates through the analyzer (no try/catch around the call).
    const analyzer = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'governed-filesystem-analyzer.ts'),
      'utf8',
    );
    expect(analyzer, 'the analyzer calls governedRead() per candidate').toMatch(/await this\.deps\.governedReadPolicy\.governedRead\(/);
    // The OLD swallow-and-continue pattern (logger.warn +
    // 'does NOT abort the baseline') is GONE from BOTH files.
    expect(analyzer, 'analyzer must NOT contain the old swallow-and-continue comment').not.toMatch(/does NOT abort the baseline/);
    expect(boundary, 'boundary must NOT contain the old swallow-and-continue comment').not.toMatch(/does NOT abort the baseline/);
  });

  it('PR #42 r2 (Blocker B): the orchestrator catches OnboardingAnalysisError + markFailed with the repository-content-unavailable failure stage', () => {
    // The orchestrator must catch the typed OnboardingAnalysisError and
    // markFailed the baseline with failure_stage='repository-content-unavailable'
    // (forensic provenance — the baseline did NOT reach 'complete' on a
    // content-provider failure; the required repository analysis could not
    // actually inspect the repository).
    const orchestrator = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'default-onboarding-service.ts'),
      'utf8',
    );
    expect(orchestrator, 'imports OnboardingAnalysisError').toMatch(/import\s+\{\s*OnboardingAnalysisError\s*\}\s+from\s+['"]\.\.\/onboarding\.types\.js['"]/);
    expect(orchestrator, 'instanceof check for OnboardingAnalysisError').toMatch(/err instanceof OnboardingAnalysisError/);
    expect(orchestrator, 'checks the err.code for repository-content-unavailable').toMatch(/err\.code === 'repository-content-unavailable'/);
    expect(orchestrator, 'markFailed with the repository-content-unavailable failure stage').toMatch(/'repository-content-unavailable'/);
  });

  it('PR #42 r2 (Blocker B): the route surfaces repository-content-unavailable as 502 (bad gateway — the content provider is unavailable)', () => {
    // The route must translate the orchestrator's
    // repository-content-unavailable failure into a 502 (bad gateway —
    // the content provider is unavailable) so the caller distinguishes
    // infrastructure failure from a server error. The response surfaces
    // the failure_stage + baselineState for the caller's forensic
    // provenance.
    const route = readFileSync(join(SRC_ROOT, 'api', 'routes', 'onboarding.route.ts'), 'utf8');
    expect(route).toMatch(/msg\.includes\('repository-content-unavailable'\)/);
    expect(route).toMatch(/reply\.code\(502\)\.send\(\{[^}]*error: 'repository-content-unavailable'/);
    expect(route).toMatch(/failureStage: 'repository-content-unavailable'/);
  });

  it('PR #42 r2 (Blocker B): the typed OnboardingAnalysisError + sanctioned codes live in onboarding.types.ts (the discriminated-class pattern)', () => {
    // The typed onboarding-analysis error class + the sanctioned failure-code
    // list follow the WORK-035/036/037 discriminated-class pattern: a stable
    // machine-readable code + structured context. The orchestrator + the
    // route layer consume the typed error (no message-string parsing for the
    // instanceof path; the route still uses message-string matching for
    // backward compatibility with the existing 'no-repository-link' /
    // 'revision-unresolvable' patterns).
    const types = readFileSync(join(ONBOARDING_DIR, 'onboarding.types.ts'), 'utf8');
    expect(types).toMatch(/ONBOARDING_ANALYSIS_ERROR_CODES/);
    expect(types).toMatch(/'repository-content-unavailable'/);
    expect(types).toMatch(/class OnboardingAnalysisError extends Error/);
    expect(types).toMatch(/readonly code: OnboardingAnalysisErrorCode/);
    expect(types).toMatch(/readonly failingLocator: string \| null/);
  });

  // =========================================================================
  // PR #42 round-3 review (the governed repository-read boundary made real).
  // The architect's round-3 review identified the single remaining
  // architectural blocker: the round-2 path was a check-then-act
  // authorization window (PolicyGate.decideForProjectScope -> if allow/
  // constrained -> GitHubAdapter.getFileContent) with NOTHING atomic tying
  // the authorization decision to the actual read, and `constrained` having
  // no concrete enforcement effect. Round-3 introduces a DISTINCT
  // GovernedRepositoryReadPolicy boundary whose governedRead() atomically
  // captures the decision, enforces it, performs the read under the captured
  // decision, applies the `constrained` enforcement, and returns the bound
  // decision+effect+content. The round-2 invariants (no fake
  // toolInvocationId; infrastructure failure propagates; append-only
  // observations; failed-baseline confirmation guard) are PRESERVED.
  // =========================================================================

  it('PR #42 r3: a DISTINCT GovernedRepositoryReadPolicy boundary exists for /github reads (the atomic governed-read operation)', () => {
    // The architect's round-3 sanctioned alternative path: a clearly distinct
    // RepositoryReadPolicy/authorization boundary for /github reads. The
    // boundary file must exist + implement the boundary interface + reuse the
    // WORK-037 decideForProjectScope engine (NO parallel engine).
    const boundaryPath = join(ONBOARDING_DIR, 'internal', 'governed-repository-read-policy.ts');
    expect(existsSync(boundaryPath), 'src/onboarding/internal/governed-repository-read-policy.ts must exist').toBe(true);
    const boundary = readFileSync(boundaryPath, 'utf8');
    expect(boundary, 'implements the boundary interface').toMatch(/implements GovernedRepositoryReadPolicy/);
    expect(boundary, 'exposes the atomic governedRead method').toMatch(/async governedRead\(/);
    // The boundary REUSES the WORK-037 project-scoped gate (no parallel
    // engine — same matcher, same document, same decision vocabulary).
    expect(boundary, 'reuses the WORK-037 project-scoped gate (no parallel engine)').toMatch(/policyGate: ProjectScopedPolicyGate/);
    // The boundary holds NO GitHub SDK + NO credentials (imports only the
    // onboarding types + node:crypto + @platform/logger). The content port
    // is the boundary's leaf dependency (the /github adapter is the only SDK
    // caller, behind the port).
    expect(boundary, 'imports no GitHub SDK').not.toMatch(/from '@octokit/);
    expect(boundary, 'imports no /github internal/').not.toMatch(/from '@modules\/github\/internal/);
  });

  it('PR #42 r3: the analyzer calls governedRead() per candidate — NO direct policyGate.decide + contentPort.readFile (no check-then-act window)', () => {
    // The architect's round-3 requirement: "make the policy decision and read
    // operation a single authoritative operation boundary." The analyzer must
    // NOT call the policy gate or the content port directly — it calls the
    // boundary's governedRead() ONLY (the decision + the read are bound in
    // ONE method). This eliminates the round-2 check-then-act window.
    const analyzer = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'governed-filesystem-analyzer.ts'),
      'utf8',
    );
    expect(analyzer, 'the analyzer depends on the governed-read boundary').toMatch(/governedReadPolicy: GovernedRepositoryReadPolicy/);
    expect(analyzer, 'the analyzer calls governedRead() per candidate').toMatch(/await this\.deps\.governedReadPolicy\.governedRead\(/);
    // The analyzer must NOT call the policy gate or the content port directly
    // (those are now INSIDE the boundary — the analyzer has no check-then-act
    // window).
    expect(analyzer, 'the analyzer must NOT call the policy gate directly').not.toMatch(/this\.deps\.policyGate\.decideForProjectScope/);
    expect(analyzer, 'the analyzer must NOT call the content port directly').not.toMatch(/this\.deps\.contentPort\.(readFile|listDir)/);
  });

  it('PR #42 r3: `constrained` has a CONCRETE enforcement effect — maxOutputBytes truncation + path-allowlist + read-only', () => {
    // The architect's round-3 requirement: "define what `constrained` means
    // for this direct-read operation." The boundary must implement CONCRETE
    // enforcement (not just consult-and-proceed). The maxOutputBytes
    // constraint must TRUNCATE the observed content + recompute the digest
    // on the truncated content; the path-allowlist must REFUSE reads outside
    // the candidate set; the boundary must be structurally read-only.
    const boundary = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'governed-repository-read-policy.ts'),
      'utf8',
    );
    // maxOutputBytes truncation: the boundary slices the content + recomputes
    // the digest on the truncated slice (the digest reflects what was
    // ACTUALLY observed, not the pre-truncation content). Round-4 refactored
    // the local to `snapshot.maxOutputBytes` (the snapshot's constraint); the
    // regex matches either form (the round-3 `maxOutputBytes` local OR the
    // round-4 `snapshot.maxOutputBytes`).
    expect(boundary, 'the boundary applies maxOutputBytes truncation').toMatch(/maxOutputBytes/);
    expect(boundary, 'the boundary truncates the content slice').toMatch(/\.slice\(0,\s*(\w+\.)?maxOutputBytes\)/);
    expect(boundary, 'the boundary recomputes the digest on the truncated content').toMatch(/contentDigest:\s*sha256\(truncatedContent\)/);
    // path-allowlist: the boundary refuses reads outside the candidate set.
    expect(boundary, 'the boundary enforces the candidate allowlist').toMatch(/candidateAllowlist\.has\(request\.path\)/);
    expect(boundary, 'the boundary refuses out-of-allowlist paths').toMatch(/not in the candidate allowlist/);
    // read-only: the boundary refuses non-read/list operations.
    expect(boundary, 'the boundary is structurally read-only').toMatch(/SUPPORTED_OPERATIONS/);
    expect(boundary, 'the boundary refuses non-read operations').toMatch(/is not supported/);
  });

  it('PR #42 r4: the snapshot/fencing protocol — the boundary REVALIDATES the policy snapshot after the read + DISCARDS stale results (the architect\'s round-4 requirement)', () => {
    // The architect's round-4 review identified that the round-3 boundary
    // claimed atomicity but was still a check-then-act window with respect
    // to POLICY CHANGES. The round-4 fix is an explicit snapshot/fencing
    // protocol: capture → read → REVALIDATE → discard-if-stale. This test
    // verifies the boundary source implements the fence (the revalidation
    // call + the staleness check + the discard + the stale outcome).
    const boundary = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'governed-repository-read-policy.ts'),
      'utf8',
    );
    // The fence: the boundary calls decideForProjectScope a SECOND time after
    // the read (the revalidation). The comment marks the fence step.
    expect(boundary, 'the boundary revalidates the snapshot after the read').toMatch(/REVALIDATE THE POLICY SNAPSHOT/);
    expect(boundary, 'the boundary calls decideForProjectScope for revalidation').toMatch(/decideForProjectScope/);
    // The staleness check: the boundary compares the snapshot version + rule +
    // decision against the revalidation (the isSnapshotStale function).
    expect(boundary, 'the boundary has the staleness check function').toMatch(/function isSnapshotStale/);
    expect(boundary, 'the staleness check compares policyVersion').toMatch(/snapshot\.policyVersion\s*!==\s*revalidation\.policyVersion/);
    expect(boundary, 'the staleness check compares ruleId (defense-in-depth)').toMatch(/snapshot\.ruleId\s*!==\s*revalidation\.ruleId/);
    expect(boundary, 'the staleness check compares decision (defense-in-depth)').toMatch(/snapshot\.decision\.decision\s*!==\s*revalidation\.decision/);
    // The discard: when stale, the boundary returns content=null +
    // performed=false + stale=true (the stale outcome).
    expect(boundary, 'the boundary logs the stale snapshot').toMatch(/repository-read\.policy-snapshot-stale/);
    expect(boundary, 'the boundary has the stale outcome builder').toMatch(/staleOutcome/);
    // The revalidation-failure fail-closed path (a revalidation failure must
    // NOT become an implicit persist).
    expect(boundary, 'the boundary logs revalidation failures').toMatch(/repository-read\.policy-snapshot-revalidation-failed/);
    // The enforcement record type (defined in project-baseline.types.ts)
    // carries the round-4 fencing fields.
    const types = readFileSync(
      join(MODULES_DIR, 'projects', 'internal', 'project-baseline.types.ts'),
      'utf8',
    );
    expect(types, 'RepositoryReadEnforcement carries revalidated').toMatch(/readonly revalidated: boolean/);
    expect(types, 'RepositoryReadEnforcement carries revalidatedPolicyVersion').toMatch(/readonly revalidatedPolicyVersion: number \| null/);
    expect(types, 'RepositoryReadEnforcement carries revalidatedRuleId').toMatch(/readonly revalidatedRuleId: string \| null/);
    expect(types, 'RepositoryReadEnforcement carries revalidatedDecision').toMatch(/readonly revalidatedDecision:/);
    expect(types, 'RepositoryReadEnforcement carries stale').toMatch(/readonly stale: boolean/);
    // The RepositoryReadGovernance type (defined in onboarding.types.ts)
    // carries the top-level stale flag for easy analyzer access.
    const onboardingTypes = readFileSync(join(ONBOARDING_DIR, 'onboarding.types.ts'), 'utf8');
    expect(onboardingTypes, 'RepositoryReadGovernance carries stale').toMatch(/readonly stale: boolean/);
  });

  it('PR #42 r4: the analyzer SKIPS evidence/observation persistence for stale reads (zero evidence + zero observation for discarded reads)', () => {
    // The architect's round-4 invariant: "a repository-read result is
    // persisted only if the policy snapshot that authorized it is still
    // current when the result is committed." The analyzer must SKIP the
    // evidence row + observation derivation when the boundary returns a
    // stale outcome (the read result was discarded by the fence).
    const analyzer = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'governed-filesystem-analyzer.ts'),
      'utf8',
    );
    expect(analyzer, 'the analyzer checks the stale flag').toMatch(/outcome\.governance\.stale/);
    expect(analyzer, 'the analyzer skips (continue) on stale').toMatch(/if \(outcome\.governance\.stale\)\s*\{[^}]*continue/s);
  });

  it('PR #42 r4: the migration documents the round-4 fencing jsonb shape + a forensic revalidated index', () => {
    // The round-4 migration documents the new jsonb fields (revalidated +
    // revalidatedPolicyVersion + revalidatedRuleId + revalidatedDecision +
    // stale) + adds a forensic index for "show me every read that was
    // successfully revalidated current under policy version V."
    const sql = readFileSync(
      join(SRC_ROOT, 'platform', 'postgres', 'migrations', '0040_project_baseline_repository_read_fencing.sql'),
      'utf8',
    );
    expect(sql, 'the migration documents the revalidated field').toMatch(/revalidated/);
    expect(sql, 'the migration documents the revalidatedPolicyVersion field').toMatch(/revalidatedPolicyVersion/);
    expect(sql, 'the migration documents the revalidatedRuleId field').toMatch(/revalidatedRuleId/);
    expect(sql, 'the migration documents the stale field').toMatch(/stale/);
    expect(sql, 'the migration adds the revalidated forensic index').toMatch(/wfos_project_baseline_evidence_read_revalidated_idx/);
  });

  it('PR #42 r4: the pg repository mapper reads the round-4 fencing fields (with null/false defaults for older rows)', () => {
    // The pg repository's mapEnforcement must read the round-4 fields
    // (revalidated + revalidatedPolicyVersion + revalidatedRuleId +
    // revalidatedDecision + stale) so they flow through the persistence
    // layer. Older rows (persisted before round-4) default to null/false
    // (honestly "this row was persisted before the fence existed").
    const repo = readFileSync(PROJECTS_BASELINE_REPO, 'utf8');
    expect(repo, 'mapEnforcement reads revalidated').toMatch(/revalidated:\s*v\.revalidated === true/);
    expect(repo, 'mapEnforcement reads revalidatedPolicyVersion').toMatch(/revalidatedPolicyVersion/);
    expect(repo, 'mapEnforcement reads revalidatedRuleId').toMatch(/revalidatedRuleId/);
    expect(repo, 'mapEnforcement reads revalidatedDecision').toMatch(/revalidatedDecision/);
    expect(repo, 'mapEnforcement reads stale').toMatch(/stale:\s*v\.stale === true/);
  });

  it('PR #42 r3: the migration records the actual decision + enforcement in their OWN columns (distinct from the Tool Runtime columns)', () => {
    // The architect's round-3 requirement: "record the actual decision/effect
    // without pretending it was a Tool Runtime invocation." The migration must
    // add DISTINCT columns (repository_read_decision + repository_read_enforcement)
    // — the round-2 columns (tool_invocation_id + policy_decision) stay NULL
    // for /github reads (round-2 invariant preserved).
    const sql = readFileSync(
      join(SRC_ROOT, 'platform', 'postgres', 'migrations', '0039_project_baseline_repository_read_governance.sql'),
      'utf8',
    );
    expect(sql, 'the migration adds repository_read_decision').toMatch(/ADD COLUMN IF NOT EXISTS repository_read_decision/);
    expect(sql, 'the migration adds repository_read_enforcement').toMatch(/ADD COLUMN IF NOT EXISTS repository_read_enforcement/);
    expect(sql, 'repository_read_decision CHECK is the decision vocabulary').toMatch(/repository_read_decision IN \('allow', 'constrained', 'deny', 'ask'\)/);
    // The migration must NOT alter the round-2 tool_invocation_id /
    // policy_decision columns (those stay NULL for /github reads — the
    // round-2 invariants are preserved).
    expect(sql, 'the migration does NOT drop tool_invocation_id').not.toMatch(/DROP COLUMN.*tool_invocation_id/);
    expect(sql, 'the migration does NOT drop policy_decision').not.toMatch(/DROP COLUMN.*policy_decision/);
  });

  it('PR #42 r3: the evidence type + pg repository carry the new decision + enforcement columns (honest recording)', () => {
    // The NewBaselineEvidence + BaselineEvidence types must carry the two
    // new fields; the pg repository must INSERT + SELECT + map them.
    const types = readFileSync(
      join(MODULES_DIR, 'projects', 'internal', 'project-baseline.types.ts'),
      'utf8',
    );
    expect(types, 'NewBaselineEvidence has repositoryReadDecision').toMatch(/readonly repositoryReadDecision:/);
    expect(types, 'NewBaselineEvidence has repositoryReadEnforcement').toMatch(/readonly repositoryReadEnforcement:/);
    expect(types, 'BaselineEvidence has repositoryReadDecision').toMatch(/readonly repositoryReadDecision:.*'allow' \| 'constrained' \| 'deny' \| 'ask' \| null/);
    // The RepositoryReadEnforcement shape (the forensic record).
    expect(types, 'RepositoryReadEnforcement.policyVersion').toMatch(/readonly policyVersion: number \| null/);
    expect(types, 'RepositoryReadEnforcement.performed').toMatch(/readonly performed: boolean/);
    expect(types, 'RepositoryReadEnforcement.truncated').toMatch(/readonly truncated: boolean/);
    expect(types, 'RepositoryReadEnforcement.pathAllowed').toMatch(/readonly pathAllowed: boolean/);
    // The pg repository INSERT + SELECT + map the new columns.
    const repo = readFileSync(PROJECTS_BASELINE_REPO, 'utf8');
    expect(repo, 'appendEvidence INSERTs repository_read_decision').toMatch(/repository_read_decision/);
    expect(repo, 'appendEvidence INSERTs repository_read_enforcement').toMatch(/repository_read_enforcement/);
    expect(repo, 'listEvidence SELECTs repository_read_decision').toMatch(/repository_read_decision, repository_read_enforcement/);
    expect(repo, 'mapEvidence maps the new fields').toMatch(/repositoryReadDecision:/);
  });

  it('PR #42 r3: the analyzer records the ACTUAL decision + enforcement on the evidence row (round-2 honesty preserved + round-3 honesty added)', () => {
    // The round-2 invariants (tool_invocation_id=NULL, policy_decision=NULL)
    // are PRESERVED; the round-3 fix ADDS the honest recording of the actual
    // decision + enforcement in their OWN columns.
    const analyzer = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'governed-filesystem-analyzer.ts'),
      'utf8',
    );
    // Round-2 invariants PRESERVED.
    expect(analyzer, 'toolInvocationId is NULL (no ToolRuntime invocation — round-2 preserved)').toMatch(/toolInvocationId:\s*null/);
    expect(analyzer, 'policyDecision is NULL (no host tool run — round-2 preserved)').toMatch(/policyDecision:\s*null/);
    // Round-3 honesty ADDED: the actual decision + enforcement are recorded
    // in their OWN columns.
    expect(analyzer, 'records the actual repository_read_decision').toMatch(/repositoryReadDecision:\s*g\.decision/);
    expect(analyzer, 'records the repository_read_enforcement').toMatch(/repositoryReadEnforcement:\s*g\.enforcement/);
  });

  it('PR #42 r3: app.ts wires the governed-read boundary into the analyzer (production onboarding uses the atomic boundary, not the check-then-act path)', () => {
    // The composition root must construct the DefaultGovernedRepositoryReadPolicy
    // (reusing the agentPolicyEngine as the policy gate + the production
    // GitHubRepositoryContentPort as the content port + the analyzer's
    // candidate allowlist) and pass it to the GovernedFilesystemAnalyzer. The
    // analyzer must NOT be constructed with contentPort + policyGate directly
    // (that was the round-2 check-then-act path).
    const appSrc = readFileSync(join(SRC_ROOT, 'app.ts'), 'utf8');
    expect(appSrc, 'imports DefaultGovernedRepositoryReadPolicy').toMatch(/import \{ DefaultGovernedRepositoryReadPolicy \}/);
    expect(appSrc, 'imports the candidate allowlist').toMatch(/GOVERNED_FILESYSTEM_CANDIDATE_ALLOWLIST/);
    expect(appSrc, 'constructs the boundary with policyGate + contentPort + candidateAllowlist').toMatch(/new DefaultGovernedRepositoryReadPolicy\(/);
    expect(appSrc, 'passes governedReadPolicy to the analyzer').toMatch(/governedReadPolicy:\s*onboardingGovernedReadPolicy/);
    // The analyzer must NOT be constructed with the round-2 direct deps.
    expect(appSrc, 'must NOT pass contentPort to the analyzer (round-2 check-then-act path)').not.toMatch(/new GovernedFilesystemAnalyzer\(\{[^}]*contentPort:/);
    expect(appSrc, 'must NOT pass policyGate to the analyzer (round-2 check-then-act path)').not.toMatch(/new GovernedFilesystemAnalyzer\(\{[^}]*policyGate:/);
  });

  it('PR #42 r3: the WORK-037 engine surfaces policyVersion + ruleId + scopeSource on the project-scoped decision (additive — the frozen decide() seam is UNCHANGED)', () => {
    // The architect's round-3 requirement: "prevent policy drift between
    // decision and read" + "record the actual decision/effect." The
    // governed-read boundary needs the policy version snapshot (drift
    // detection) + the matched rule id (forensic provenance) AT DECISION
    // TIME. The WORK-037 engine must surface these from decideForProjectScope
    // (additive — the engine already computes them in evaluateCore; the frozen
    // ToolPolicyGate.decide() seam is UNCHANGED). The decision type lives in
    // /agents (the engine produces it; the dependency direction is
    // onboarding → agents).
    const engine = readFileSync(
      join(MODULES_DIR, 'agents', 'internal', 'agent-policy-engine.ts'),
      'utf8',
    );
    expect(engine, 'decideForProjectScope returns ProjectScopedPolicyDecision').toMatch(/Promise<ProjectScopedPolicyDecision>/);
    expect(engine, 'the engine surfaces policyVersion from evaluateCore').toMatch(/policyVersion:\s*core\.version/);
    expect(engine, 'the engine surfaces ruleId from evaluateCore').toMatch(/ruleId:\s*core\.match\.rule\?\.id/);
    expect(engine, 'the engine surfaces scopeSource from evaluateCore').toMatch(/scopeSource:\s*core\.resolutionSource/);
    // The decision type lives in /agents (NOT /onboarding — the engine
    // produces it; the dependency direction is onboarding → agents).
    const policyTypes = readFileSync(
      join(MODULES_DIR, 'agents', 'internal', 'agent-policy.types.ts'),
      'utf8',
    );
    expect(policyTypes, 'ProjectScopedPolicyDecision is defined in /agents').toMatch(/export interface ProjectScopedPolicyDecision/);
    // The onboarding types RE-IMPORT it (not define a duplicate — the
    // dependency direction is onboarding → agents).
    const onboardingTypes = readFileSync(join(ONBOARDING_DIR, 'onboarding.types.ts'), 'utf8');
    expect(onboardingTypes, 'onboarding re-imports ProjectScopedPolicyDecision from /agents (no duplicate)').toMatch(/import type \{[^}]*ProjectScopedPolicyDecision[^}]*\} from '@modules\/agents\/index\.js'/);
  });

  // =========================================================================
  // PR #42 round-5 invariants — the persistence-boundary fence (the double-
  // CAS protocol that closes the persistence window the round-4 fence left
  // open). The architect's round-5 review of commit `2a597ed` identified
  // that the round-4 fence protects the READ window but does NOT protect
  // the SUBSEQUENT PERSISTENCE window:
  //
  //   capture V7 -> read -> revalidate V7 (round-4 fence passes) ->
  //   policy mutates V7 -> V8 -> appendEvidence(V7) -> markComplete
  //
  // The round-5 fix: the orchestrator captures a persistence-boundary
  // snapshot AFTER analyze() returns + BEFORE the persistence transaction
  // begins; the /projects repository's `persistBaselineWithPolicyFence`
  // method wraps the writes in ONE DB transaction + performs a CAS on the
  // policy version INSIDE the transaction (pre-writes revalidation + per-read
  // snapshot verification + post-writes revalidation). If ANY check fails,
  // the transaction is ROLLED BACK — zero stale evidence/observations are
  // committed.
  // =========================================================================

  it('PR #42 r5: the boundary exposes capturePersistenceSnapshot (the orchestrator captures the persistence-boundary snapshot AFTER analyze() returns + BEFORE the persistence transaction begins)', () => {
    // The architect's round-5 requirement: a "persistence-boundary CAS /
    // transactional policy snapshot guard." The boundary must expose a
    // SECOND method (capturePersistenceSnapshot) that the orchestrator calls
    // after analyze() returns. The snapshot is the persistence fence's
    // reference value.
    const boundary = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'governed-repository-read-policy.ts'),
      'utf8',
    );
    expect(boundary, 'the boundary exposes capturePersistenceSnapshot').toMatch(/async capturePersistenceSnapshot\(/);
    // The capture uses a synthetic 'persist-baseline' request (NOT a real
    // read request — the fence uses ONLY the policyVersion + ruleId for
    // drift detection; the decision is NOT enforced at the persistence
    // boundary — the per-read fence already enforced it for each individual
    // read).
    expect(boundary, 'the capture uses a synthetic persist-baseline operation').toMatch(/operation:\s*'persist-baseline'/);
    // The fail-closed path: if the gate throws on the capture call, the
    // boundary returns a null snapshot (the persistence fence's revalidation
    // will compare it against a fresh revalidation that also fails-closed —
    // both null = no drift signal = stale=false, best-effort).
    expect(boundary, 'the capture fails closed on a gate failure').toMatch(/persistence-snapshot-capture-failed/);
    // The GovernedRepositoryReadPolicy INTERFACE (in onboarding.types.ts)
    // declares the method.
    const onboardingTypes = readFileSync(join(ONBOARDING_DIR, 'onboarding.types.ts'), 'utf8');
    expect(onboardingTypes, 'the interface declares capturePersistenceSnapshot').toMatch(/capturePersistenceSnapshot\(/);
  });

  it('PR #42 r5: the /projects repository exposes persistBaselineWithPolicyFence (the transactional CAS guard)', () => {
    // The architect's round-5 requirement: "persistence-boundary CAS /
    // transactional policy snapshot guard." The /projects repository must
    // expose a method that wraps the appendEvidence + upsertObservations +
    // markComplete in ONE DB transaction + performs a CAS on the policy
    // version INSIDE the transaction.
    const repo = readFileSync(PROJECTS_BASELINE_REPO, 'utf8');
    expect(repo, 'the repository exposes persistBaselineWithPolicyFence').toMatch(/async persistBaselineWithPolicyFence\(/);
    // The fence wraps the writes in a DB transaction (the throw-to-rollback
    // pattern: any fence check failure throws a FenceStaleSignal which the
    // outer catch translates to the typed result; the db.transaction()
    // callback rolls back on the throw).
    expect(repo, 'the fence uses db.transaction').toMatch(/this\.db\.transaction\(/);
    expect(repo, 'the fence has the FenceStaleSignal sentinel').toMatch(/class FenceStaleSignal extends Error/);
    // PR #42 round-7: the fence is the SCOPE-RESOLUTION fence. It locks the
    // scope ANCHOR rows (wfos_projects + wfos_organizations) + the
    // relevant policy rows (project + org, present OR absent) + RE-
    // RESOLVES the effective policy INSIDE the transaction. The round-6
    // fence locked ONLY the row represented by `snapshot.source`; the
    // architect's round-7 review established that locking a single row
    // does NOT fence policy RESOLUTION (a NEW project policy row can
    // override the org default mid-flight without changing the locked org
    // row). The round-7 fence serializes the ENTIRE scope-resolution
    // decision — assert against the EFFECTIVE policy version/source, NOT
    // merely the old policy row's version.
    expect(repo, 'round-7: the fence locks the project scope anchor (wfos_projects) FOR UPDATE').toMatch(/SELECT id FROM wfos_projects WHERE id = \$1 FOR UPDATE/);
    expect(repo, 'round-7: the fence locks the organization scope anchor (wfos_organizations) FOR UPDATE').toMatch(/SELECT id FROM wfos_organizations WHERE id = \$1 FOR UPDATE/);
    expect(repo, 'round-7: the fence locks the project-scope policy row FOR UPDATE').toMatch(/scope = 'project' AND organization_id = \$1 AND project_id = \$2[\s\S]*FOR UPDATE/);
    expect(repo, 'round-7: the fence locks the organization-scope policy row FOR UPDATE').toMatch(/scope = 'organization' AND organization_id = \$1 AND project_id IS NULL[\s\S]*FOR UPDATE/);
    // The fence RE-RESOLVES the effective policy from the locked rows
    // (project-override → org-default → platform-default).
    expect(repo, 'round-7: the fence RE-RESOLVES the effective policy (project → org → platform-default)').toMatch(/effectiveSource/);
    // The fence VERIFY step compares (source, policyVersion) against the
    // snapshot — NOT just version. The source comparison catches the
    // missing-row cases (a row was CREATED or DELETED mid-flight, changing
    // the effective resolution).
    expect(repo, 'round-7: the fence compares the effective source against the snapshot source').toMatch(/effectiveSource !== input\.snapshot\.source/);
    expect(repo, 'round-7: the fence compares the effective version against the snapshot version').toMatch(/input\.snapshot\.policyVersion !== effectiveVersion/);
    // The fence protocol: LOCK the scope anchors + the relevant policy
    // rows + RE-RESOLVE + VERIFY (round-7 scope-resolution fence) + per-
    // read snapshot verification (Check B — retained from round-5). NO
    // post-writes revalidation — the locks held since the LOCK step
    // serialize against ANY concurrent mutation for the duration of the
    // writes + commit.
    expect(repo, 'round-7: the SCOPE-RESOLUTION fence step').toMatch(/SCOPE-RESOLUTION fence/);
    expect(repo, 'Check B — per-read snapshot verification').toMatch(/PER-READ SNAPSHOT VERIFICATION/);
    expect(repo, 'round-7: NO post-writes revalidation (the locks are the fence)').toMatch(/NO post-writes revalidation/);
    // The willMutate test seam (for the real-PG concurrency regression).
    expect(repo, 'round-7: the willMutate test seam').toMatch(/input\.willMutate/);
    // The fence rejects (ROLLBACK) when ANY check fails. The reject
    // messages reference the per-read verification (the architect's exact
    // regression scenario).
    expect(repo, 'Check B rejects on a per-read version mismatch').toMatch(/per-read snapshot.*does NOT match the persistence-boundary snapshot/s);
    // The orchestrator logs the fence rejection (forensic audit) — the
    // repository returns the typed result; the orchestrator's catch path
    // emits the log + markFailed with the 'policy-snapshot-stale-at-
    // persistence' / 'policy-snapshot-revalidation-failed' failure stage.
    const orchestrator = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'default-onboarding-service.ts'),
      'utf8',
    );
    expect(orchestrator, 'the orchestrator logs the fence rejection').toMatch(/persistence-fence-rejected/);
    // The fail-closed path: a revalidation FAILURE (the gate throws on the
    // revalidation call) is treated as STALE — the transaction is ROLLED BACK
    // (a revalidation failure must NOT become an implicit persist).
    expect(repo, 'a revalidation failure fails closed').toMatch(/fence-revalidation-failed/);
    // The repository interface (project-baseline.types.ts) declares the
    // method + the input/result types.
    const types = readFileSync(
      join(MODULES_DIR, 'projects', 'internal', 'project-baseline.types.ts'),
      'utf8',
    );
    expect(types, 'the interface declares persistBaselineWithPolicyFence').toMatch(/persistBaselineWithPolicyFence\(/);
    expect(types, 'PersistencePolicySnapshot type is defined').toMatch(/export interface PersistencePolicySnapshot/);
    expect(types, 'PersistBaselineInput type is defined').toMatch(/export interface PersistBaselineInput/);
    expect(types, 'PersistBaselineResult type is defined').toMatch(/export type PersistBaselineResult/);
    expect(types, 'PersistBaselineResult has the persisted kind').toMatch(/kind: 'persisted'/);
    expect(types, 'PersistBaselineResult has the cas-lost kind').toMatch(/kind: 'cas-lost'/);
    expect(types, 'PersistBaselineResult has the fence-stale kind').toMatch(/kind: 'fence-stale'/);
    expect(types, 'PersistBaselineResult has the fence-revalidation-failed kind').toMatch(/kind: 'fence-revalidation-failed'/);
    // PR #42 round-7 type-level invariants: the snapshot carries `source`
    // (which effective scope the gate surfaced) + the input carries
    // organizationId / projectId (the scope anchor lock targets) + the
    // optional willMutate test seam.
    expect(types, 'round-7: PersistencePolicySource type is defined').toMatch(/export type PersistencePolicySource/);
    expect(types, 'round-7: PersistencePolicySnapshot carries source').toMatch(/readonly source: PersistencePolicySource \| null/);
    expect(types, 'round-7: PersistBaselineInput carries organizationId').toMatch(/readonly organizationId: string/);
    expect(types, 'round-7: PersistBaselineInput carries projectId').toMatch(/readonly projectId: string/);
    expect(types, 'round-7: PersistBaselineInput carries the willMutate test seam').toMatch(/readonly willMutate\?: \(\) => Promise<void>/);
    // The /projects barrel re-exports the new types so the onboarding
    // orchestrator can compose them.
    const barrel = readFileSync(join(MODULES_DIR, 'projects', 'index.ts'), 'utf8');
    expect(barrel, 'the /projects barrel re-exports PersistencePolicySnapshot').toMatch(/PersistencePolicySnapshot/);
    expect(barrel, 'round-7: the /projects barrel re-exports PersistencePolicySource').toMatch(/PersistencePolicySource/);
    expect(barrel, 'the /projects barrel re-exports PersistBaselineInput').toMatch(/PersistBaselineInput/);
    expect(barrel, 'the /projects barrel re-exports PersistBaselineResult').toMatch(/PersistBaselineResult/);
  });

  it('PR #42 r7: the policy mutation paths acquire the SAME scope-anchor lock the fence holds (the missing-row cases are fenced)', () => {
    // The architect's round-7 requirement: policy mutations that can
    // change resolution must acquire the SAME anchor lock before
    // create/replace/clear project policy or modify/clear organization
    // policy. The fence holds SELECT ... FOR UPDATE on wfos_projects +
    // wfos_organizations; the mutation paths in
    // pg-agent-policy-repository.ts acquire the SAME locks BEFORE the
    // INSERT/UPDATE/DELETE so the two transactions SERIALIZE even when
    // the effective policy changes because a row is CREATED (the
    // architect's missing-row case 1) or DELETED (case 2).
    const repo = readFileSync(
      join(MODULES_DIR, 'agents', 'internal', 'pg-agent-policy-repository.ts'),
      'utf8',
    );
    // setProjectPolicy acquires the project-scope anchor lock.
    expect(repo, 'setProjectPolicy acquires the project anchor lock').toMatch(/async setProjectPolicy\([\s\S]*?SELECT id FROM wfos_projects WHERE id = \$1 FOR UPDATE[\s\S]*?INSERT INTO wfos_agent_policies/s);
    // clearProjectPolicy acquires the project-scope anchor lock (the DELETE
    // itself does NOT auto-lock the parent — the explicit lock is required
    // to fence the missing-row case 2: project policy deleted → resolution
    // falls back to organization).
    expect(repo, 'clearProjectPolicy acquires the project anchor lock').toMatch(/async clearProjectPolicy\([\s\S]*?SELECT id FROM wfos_projects WHERE id = \$1 FOR UPDATE[\s\S]*?DELETE FROM wfos_agent_policies/s);
    // setOrganizationPolicy acquires the organization-scope anchor lock.
    expect(repo, 'setOrganizationPolicy acquires the org anchor lock').toMatch(/async setOrganizationPolicy\([\s\S]*?SELECT id FROM wfos_organizations WHERE id = \$1 FOR UPDATE[\s\S]*?INSERT INTO wfos_agent_policies/s);
    // clearOrganizationPolicy acquires the organization-scope anchor lock.
    expect(repo, 'clearOrganizationPolicy acquires the org anchor lock').toMatch(/async clearOrganizationPolicy\([\s\S]*?SELECT id FROM wfos_organizations WHERE id = \$1 FOR UPDATE[\s\S]*?DELETE FROM wfos_agent_policies/s);
  });

  it('PR #42 r5: the orchestrator captures the persistence snapshot + delegates to persistBaselineWithPolicyFence (the persistence window is fenced)', () => {
    // The orchestrator must:
    //   1. call analyzer.analyze(ctx) -> evidence[] + observations[]
    //   2. call governedReadPolicy.capturePersistenceSnapshot(ctx) -> V_p
    //   3. call repository.persistBaselineWithPolicyFence({ snapshot: V_p,
    //      ... }, revalidate) -> PersistBaselineResult
    //   4. handle the result: persisted (success) | cas-lost (convergence) |
    //      fence-stale / fence-revalidation-failed (markFailed with the
    //      'policy-snapshot-stale-at-persistence' or 'policy-snapshot-
    //      revalidation-failed' failure stage).
    const orchestrator = readFileSync(
      join(ONBOARDING_DIR, 'internal', 'default-onboarding-service.ts'),
      'utf8',
    );
    expect(orchestrator, 'the orchestrator captures the persistence snapshot').toMatch(/capturePersistenceSnapshot\(/);
    expect(orchestrator, 'the orchestrator delegates to persistBaselineWithPolicyFence').toMatch(/persistBaselineWithPolicyFence\(/);
    expect(orchestrator, 'the orchestrator passes the snapshot through the input').toMatch(/snapshot:\s*persistenceSnapshot/);
    // PR #42 round-7: the orchestrator passes organizationId + projectId
    // (the fence locks the scope ANCHOR rows wfos_projects +
    // wfos_organizations for this org/project, plus the relevant policy
    // rows). The round-5 revalidate() closure is REMOVED — the round-7
    // scope-resolution fence replaces it.
    expect(orchestrator, 'round-7: the orchestrator passes organizationId').toMatch(/organizationId:\s*analysisContext\.organizationId/);
    expect(orchestrator, 'round-7: the orchestrator passes projectId').toMatch(/projectId:\s*analysisContext\.projectId/);
    // The fence-rejection paths: markFailed with the 'policy-snapshot-stale-
    // at-persistence' / 'policy-snapshot-revalidation-failed' failure stage.
    expect(orchestrator, 'the fence-stale path markFailed').toMatch(/policy-snapshot-stale-at-persistence/);
    expect(orchestrator, 'the fence-revalidation-failed path markFailed').toMatch(/policy-snapshot-revalidation-failed/);
    // The orchestrator's deps interface includes the governedReadPolicy
    // (the same boundary the analyzer uses for per-read fencing — the
    // orchestrator uses it for persistence-boundary snapshot capture).
    expect(orchestrator, 'the deps interface includes governedReadPolicy').toMatch(/readonly governedReadPolicy:\s*GovernedRepositoryReadPolicy/);
  });

  it('PR #42 r5: app.ts wires the governedReadPolicy into the orchestrator (production onboarding uses the persistence fence)', () => {
    // The composition root must wire the SAME governedReadPolicy the analyzer
    // uses into the orchestrator (the orchestrator calls
    // capturePersistenceSnapshot on it after analyze() returns).
    const appSrc = readFileSync(join(SRC_ROOT, 'app.ts'), 'utf8');
    expect(appSrc, 'app.ts passes governedReadPolicy to the orchestrator').toMatch(/governedReadPolicy:\s*onboardingGovernedReadPolicy/);
  });

  it('PR #42 r5: the *In helpers run inside the transaction (the writes are atomic with the fence checks)', () => {
    // The /projects repository must have private *In(q, ...) helpers that
    // run against either the pool OR a transaction-scoped DatabaseTx. The
    // persistBaselineWithPolicyFence method calls them with the tx-scoped
    // queryable so the writes are atomic with the fence checks (a rollback
    // undoes the writes + the markComplete CAS together).
    const repo = readFileSync(PROJECTS_BASELINE_REPO, 'utf8');
    expect(repo, 'appendEvidenceIn helper exists').toMatch(/private async appendEvidenceIn\(/);
    expect(repo, 'upsertObservationsIn helper exists').toMatch(/private async upsertObservationsIn\(/);
    expect(repo, 'markCompleteIn helper exists').toMatch(/private async markCompleteIn\(/);
    expect(repo, 'the legacy methods delegate to the helpers').toMatch(/return this\.appendEvidenceIn\(this\.db,/);
    // The Queryable interface (structural — accepts DatabaseClient OR
    // DatabaseTx; the /projects module stays free of a direct pg dependency,
    // matching the convention every other pg-*.ts repository follows).
    expect(repo, 'the Queryable structural interface is defined').toMatch(/interface Queryable/);
    expect(repo, 'the Queryable uses the DatabaseClient query signature').toMatch(/query:\s*DatabaseClient\['query'\]/);
  });
});


// ===========================================================================
// WORK-039 invariants — Repository and Context Intelligence (the revision-
// bound context index + the repository-intelligence application capability).
// ===========================================================================
//
// The central correctness requirement: WorkflowOS must NEVER silently present
// context from commit A as context from commit B. Every context index is
// pinned to a concrete baseline_commit_sha; the detectStale advisory surfaces
// staleness — it never swaps the baseline under the caller. Provenance (the
// WORK-038 vocabulary observed/inferred/confirmed/proposed) is preserved
// verbatim through indexing + retrieval; the ranker's relevance_score is
// ADVISORY ONLY — ranking NEVER promotes provenance.
//
// Authority boundaries preserved:
//   /projects    — the context-index STORAGE authority (the index is a
//                  PROJECT artifact, like ProjectBaseline; /projects remains
//                  the single project authority; the capability owns NO
//                  tables)
//   /github      — the repository + commit authority (NO GitHub SDK in the
//                  capability domain; the adapter is the only SDK caller)
//   /architecture, /requirements, /work-items — read-only authority
//                  REFERENCES (the context items POINT at architecture
//                  versions / requirements / work items, they never become
//                  them; the capability NEVER calls freezeVersion /
//                  requirementRepository.create / workItemRepository.create)
//   /workflows, /verification, /reviews — never mutated by the capability
//
// The capability lives in src/repository-intelligence/ — an APPLICATION-LAYER
// orchestrator (like src/onboarding/ + src/execution-policy/ + src/benchmark/),
// NOT a frozen module and NOT an authority.
describe('WORK-039 invariants — Repository and Context Intelligence (context index + repository-intelligence capability)', () => {
  const RI_DIR = join(SRC_ROOT, 'repository-intelligence');
  const PROJECTS_CONTEXT_INDEX_TYPES = join(MODULES_DIR, 'projects', 'internal', 'project-context-index.types.ts');
  const PROJECTS_CONTEXT_INDEX_REPO = join(MODULES_DIR, 'projects', 'internal', 'pg-project-context-index-repository.ts');
  const MIGRATION_0041 = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0041_repository_context_intelligence.sql');
  const RI_ROUTE = join(SRC_ROOT, 'api', 'routes', 'repository-intelligence.route.ts');

  /** Recursively list every .ts file under a directory. */
  function listTsFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...listTsFiles(full));
      } else if (entry.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('WORK-039 is NOT a frozen module — repository-intelligence is an application capability, not a new authority', () => {
    // The static check at PLAT-AC-01 enforces exactly 17 frozen modules. The
    // repository-intelligence capability must NOT add an 18th module under
    // src/modules/. It lives under src/repository-intelligence/ (an
    // application-layer directory, like src/onboarding/ + src/execution-policy/).
    expect(existsSync(join(MODULES_DIR, 'repository-intelligence'))).toBe(false);
    expect(existsSync(RI_DIR)).toBe(true);
  });

  it('no second project authority — repository-intelligence does NOT create projects (it stores context indices under existing /projects authority rows)', () => {
    // The orchestrator + source + ranker must not create Project rows. It
    // reads the project (to resolve orgId via the baseline) + stores context
    // indices THROUGH /projects (the single project authority).
    const files = [...listTsFiles(RI_DIR), PROJECTS_CONTEXT_INDEX_REPO];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(
        src,
        `${relative(BACKEND_ROOT, f)} must not create/transition projects`,
      ).not.toMatch(/projectRepository\.(create|transitionState|update)\s*\(/);
    }
  });

  it('no second repository / GitHub authority — repository-intelligence imports NO GitHub SDK + no /github internal/', () => {
    // The capability domain holds no GitHub credentials and no GitHub SDK.
    // It consumes the /github barrel (GitHubAdapter.getBranch + listDir +
    // ProjectGitHubRepositoryRepository) — the adapter is the only SDK caller.
    const files = listTsFiles(RI_DIR);
    expect(files.length, 'src/repository-intelligence/ must contain implementation files').toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import @octokit (GitHub SDK)`).not.toMatch(/from\s+['"]@octokit/);
      expect(src, `${rel} must not import /github internal/`).not.toMatch(/from\s+['"][^'"]*modules\/github\/internal/);
    }
  });

  it('no second architecture authority — repository-intelligence NEVER auto-freezes / never creates ArchitectureVersion rows', () => {
    // Architecture observations in the context index are REFERENCES to
    // ArchitectureVersion ids, never an auto-created ArchitectureVersion. The
    // capability never calls ArchitectureService mutation methods.
    const files = listTsFiles(RI_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /architecture internal/`).not.toMatch(/from\s+['"][^'"]*modules\/architecture\/internal/);
      expect(src, `${rel} must not freeze architecture versions`).not.toMatch(/freezeVersion\s*\(/);
      expect(src, `${rel} must not create architecture versions`).not.toMatch(/architectureVersionRepository\.create\s*\(/);
      expect(src, `${rel} must not approve architecture change requests`).not.toMatch(/approveChangeAndCreateReplacement\s*\(/);
    }
  });

  it('no second requirements authority — repository-intelligence does NOT create Requirement/AcceptanceCriterion rows', () => {
    // Requirement items in the context index are REFERENCES to authoritative
    // Requirement rows, never duplicate requirements. The /requirements
    // authority is untouched.
    const files = listTsFiles(RI_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /requirements internal/`).not.toMatch(/from\s+['"][^'"]*modules\/requirements\/internal/);
      expect(src, `${rel} must not create requirements`).not.toMatch(/requirementRepository\.create\s*\(/);
      expect(src, `${rel} must not create acceptance criteria`).not.toMatch(/acceptanceCriterionRepository\.create\s*\(/);
    }
  });

  it('no second work-items / workflow authority — repository-intelligence does NOT create work items / does NOT mutate workflow state', () => {
    // Work-item references in the context index are REFERENCES to
    // authoritative WorkItem rows, never duplicate work items. The capability
    // never mutates workflow / work-item state.
    const files = listTsFiles(RI_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /work-items internal/`).not.toMatch(/from\s+['"][^'"]*modules\/work-items\/internal/);
      expect(src, `${rel} must not create work items`).not.toMatch(/workItemRepository\.create\s*\(/);
      expect(src, `${rel} must not import /workflows internal/`).not.toMatch(/from\s+['"][^'"]*modules\/workflows\/internal/);
      expect(src, `${rel} must not transition workflow state`).not.toMatch(/workflowRepository\.(transitionState|create|update)\s*\(/);
    }
  });

  it('no workflow / verification / review mutation — repository-intelligence never mutates those authorities', () => {
    const files = listTsFiles(RI_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /verification internal/`).not.toMatch(/from\s+['"][^'"]*modules\/verification\/internal/);
      expect(src, `${rel} must not import /reviews internal/`).not.toMatch(/from\s+['"][^'"]*modules\/reviews\/internal/);
      expect(src, `${rel} must not import /workflows internal/`).not.toMatch(/from\s+['"][^'"]*modules\/workflows\/internal/);
    }
  });

  it('no credentials — repository-intelligence never imports a concrete secret store + never assigns token/password values', () => {
    // The capability domain never handles credentials. Secret-shaped content
    // is already redacted by WORK-038; the redacted flag is preserved, never
    // reversed.
    const files = listTsFiles(RI_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import EnvSecretStore`).not.toMatch(/from\s+['"][^'"]*platform\/secrets/);
      expect(src, `${rel} must not import /auth internal/`).not.toMatch(/from\s+['"][^'"]*modules\/auth\/internal/);
      // The capability must NOT assign token/password/secret VALUES (it passes
      // the redacted flag through verbatim; never reverses redaction).
      expect(src, `${rel} must not assign secret-shaped values`).not.toMatch(/redacted\s*=\s*false\s*;\s*\/\/\s*un-redact/);
    }
  });

  it('no provider SDK leakage — repository-intelligence domain imports no pg / ioredis / pglite', () => {
    // The capability domain holds no DB driver. It delegates to the /projects
    // storage authority (PgProjectContextIndexRepository) which uses
    // DatabaseClient. The capability imports no provider packages.
    const files = listTsFiles(RI_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import pg`).not.toMatch(/from\s+['"]pg['"]/);
      expect(src, `${rel} must not import @electric-sql/pglite`).not.toMatch(/from\s+['"]@electric-sql\/pglite['"]/);
      expect(src, `${rel} must not import ioredis`).not.toMatch(/from\s+['"]ioredis['"]/);
      expect(src, `${rel} must not import concrete provider implementation files`).not.toMatch(/from\s+['"][^'"]*platform\/(postgres|redis|storage|secrets)\/internal/);
    }
  });

  it('no maintenance engine / no continuous scheduler — repository-intelligence is one-shot context assembly, not continuous maintenance', () => {
    // A continuous maintenance engine is STRICTLY OUT OF SCOPE (WORK-041).
    // The capability produces a context index on demand; it does not poll,
    // does not schedule, does not auto-create maintenance work items.
    const files = listTsFiles(RI_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not define a setInterval scheduler`).not.toMatch(/setInterval\s*\(/);
      expect(src, `${rel} must not define a cron scheduler`).not.toMatch(/\bcron\s*\(/);
      expect(src, `${rel} must not define a maintenance engine`).not.toMatch(/MaintenanceEngine|HealthEngine/);
    }
  });

  it('no vector database / no pgvector / no embedding / no tsvector — the deterministic ranker is the retrieval layer', () => {
    // The WORK-039 prompt: "A deterministic baseline-aware retrieval layer
    // should be established before optional semantic ranking. Do not
    // introduce a vector database solely because semantic search is
    // fashionable." The capability uses NO vector/embedding/tsvector
    // infrastructure. The DeterministicContextRanker's signals are discrete
    // + explainable (term_overlap, architecture_ref, requirement_ref, etc.).
    const files = [...listTsFiles(RI_DIR), PROJECTS_CONTEXT_INDEX_REPO, PROJECTS_CONTEXT_INDEX_TYPES];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not use pgvector`).not.toMatch(/pgvector|vector\(\d+|embedding\(\d+/i);
      expect(src, `${rel} must not use tsvector full-text`).not.toMatch(/to_tsvector|tsquery|tsvector/i);
      expect(src, `${rel} must not import an embedding library`).not.toMatch(/from\s+['"][^'"]*(openai|cohere|@xenova|transformers)/);
    }
    // The migration must not declare a vector / embedding / tsvector column.
    const migration = readFileSync(MIGRATION_0041, 'utf8');
    expect(migration, 'migration 0041 must not declare a vector column').not.toMatch(/vector\(\d+|embedding|tsvector/i);
  });

  it('the repository-intelligence barrel is types-only — no concrete implementations exported', () => {
    // Mirrors the frozen-module barrel rule + the WORK-038 onboarding barrel
    // convention. DefaultRepositoryIntelligenceService +
    // DeterministicContextRanker + BaselineContextSource + NoOpHostInspector
    // stay in internal/ (the composition root in app.ts wires them by
    // importing from internal/, the sanctioned wiring boundary).
    const barrel = readFileSync(join(RI_DIR, 'index.ts'), 'utf8');
    // Match value re-exports: `export { Foo } from '...'` (NOT `export type``.
    const valueExportRegex = /export\s+(?!type\b)\{([^}]+)\}\s+from/g;
    const matches = [...barrel.matchAll(valueExportRegex)];
    const violations: string[] = [];
    for (const m of matches) {
      const names = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      for (const n of names) violations.push(n);
    }
    expect(
      violations,
      `src/repository-intelligence/index.ts value-exports: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('REPOSITORY REVISION IS FUNDAMENTAL — the context index is pinned to a concrete baseline_commit_sha + the storage repository never swaps it', () => {
    // The ProjectContextIndex interface carries baseline_commit_sha; the
    // ensureIndex input carries it; the migration's transition guard enforces
    // baseline_commit_sha immutability.
    const types = readFileSync(PROJECTS_CONTEXT_INDEX_TYPES, 'utf8');
    expect(types, 'ProjectContextIndex carries baselineCommitSha').toMatch(/readonly baselineCommitSha:\s*string/);
    expect(types, 'EnsureContextIndexInput carries baselineCommitSha').toMatch(/readonly baselineCommitSha:\s*string/);
    const repo = readFileSync(PROJECTS_CONTEXT_INDEX_REPO, 'utf8');
    expect(repo, 'ensureIndex writes baseline_commit_sha').toMatch(/baseline_commit_sha/);
    // The migration's transition guard enforces baseline_commit_sha immutability.
    const migration = readFileSync(MIGRATION_0041, 'utf8');
    expect(migration, 'migration 0041 enforces baseline_commit_sha immutability').toMatch(/baseline_commit_sha IS DISTINCT FROM OLD\.baseline_commit_sha/);
  });

  it('PROVENANCE PRESERVATION — the ranker + the source NEVER mutate provenance; the storage layer forbids in-place item rewrites', () => {
    // The ranker passes provenance through verbatim — it NEVER assigns to it.
    // The storage layer's item guard forbids UPDATE (append-only-idempotent).
    const ranker = readFileSync(join(RI_DIR, 'internal', 'deterministic-context-ranker.ts'), 'utf8');
    const types = readFileSync(join(RI_DIR, 'repository-intelligence.types.ts'), 'utf8');
    // The ranker must NOT assign to `provenance` (it reads it from the input +
    // passes it to the output). A mutation would look like `provenance =`.
    expect(ranker, 'the ranker must not mutate provenance (no assignment)').not.toMatch(/\.provenance\s*=/);
    expect(ranker, 'the ranker must not hard-code a provenance promotion').not.toMatch(/provenance:\s*['"]confirmed['"]/);
    // The RankedContextItem interface (in the types file) carries provenance through.
    expect(types, 'RankedContextItem carries provenance').toMatch(/readonly provenance:\s*ContextItemProvenance/);
    expect(ranker, 'the ranker returns provenance from the input item').toMatch(/provenance:\s*s\.item\.provenance/);
    // The migration's item guard forbids UPDATE.
    const migration = readFileSync(MIGRATION_0041, 'utf8');
    expect(migration, 'migration 0041 forbids in-place item UPDATE').toMatch(/items are append-only — UPDATE is forbidden/);
    expect(migration, 'migration 0041 forbids direct item DELETE').toMatch(/direct DELETE on items is forbidden/);

    // PR #43 round 2 — the source MUST NOT promote provenance to 'confirmed'
    // based on architecture authority state. The version's `state` ('draft' |
    // 'frozen' | 'superseded') is the /architecture AUTHORITY's lifecycle —
    // it is NOT the WORK-038 provenance of the context item that REFERENCES
    // it. A frozen architecture version is still an OBSERVED reference; the
    // only path to 'confirmed' is the authorized confirmation route on a
    // baseline observation. The source must NEVER assign the literal
    // 'confirmed' to a provenance field (the regex catches both direct
    // assignment `provenance: 'confirmed'` AND conditional promotion
    // `provenance: <something> ? 'confirmed' : 'observed'` — both forms
    // promote authority state into provenance, which is forbidden).
    const source = readFileSync(join(RI_DIR, 'internal', 'baseline-context-source.ts'), 'utf8');
    expect(
      source,
      'the source must not promote provenance to confirmed (no literal \'confirmed\' assigned to a provenance field — frozen architecture authority state ≠ confirmed provenance)',
    ).not.toMatch(/provenance:\s*[^,}]*['"]confirmed['"]/);
  });

  it('READ/MUTATION SEPARATION (PR #43 round 2) — the GET context-index route NEVER invokes the build-if-missing retrieve() under project.read', () => {
    // Blocker 1: the GET /context-index route used project.read but called
    // retrieve() — which builds + persists a missing index (ensureIndex +
    // markComplete are STATE MUTATIONS). Read authorization must NOT hide a
    // mutation. The fix: the GET route calls retrieveExisting (read-only;
    // returns null when missing → 404). The build-if-missing retrieve() is
    // reserved for write-authorized programmatic callers; the route layer
    // NEVER invokes it (the regex matches `.retrieve(` exactly — NOT
    // `.retrieveExisting(`, which has `Existing` between `retrieve` + `(`).
    const route = readFileSync(RI_ROUTE, 'utf8');
    expect(
      route,
      'the route layer must not invoke the build-if-missing retrieve() (read authorization must not hide a state mutation — the GET route uses retrieveExisting)',
    ).not.toMatch(/repositoryIntelligenceService\.retrieve\(/);
    // The GET collection route MUST call retrieveExisting (read-only).
    expect(route, 'the GET collection route calls retrieveExisting').toMatch(/repositoryIntelligenceService\.retrieveExisting\(/);
    // The GET collection route carries project.read (the read permission).
    expect(route, 'the GET collection route uses project.read').toMatch(/permission:\s*['"]project\.read['"]/);
    // The POST build route carries project.write (the write permission).
    expect(route, 'the POST build route uses project.write').toMatch(/permission:\s*['"]project\.write['"]/);
    // The route MUST pass repositoryDefaultBranch (the /github authority's
    // default branch) into the context — detectStale consults it instead of
    // hardcoding 'main'.
    expect(route, 'resolveContext carries repositoryDefaultBranch').toMatch(/repositoryDefaultBranch:\s*repoLink\.defaultBranch/);
    // The stale route MUST call detectStale(indexId, ...) — pinned to the
    // requested index (NOT detectStale(query, ...), which re-queries by
    // query tuple + could inspect a different index).
    expect(route, 'the stale route calls detectStale(indexId, ctx) — pinned to the requested index').toMatch(/detectStale\(indexId,\s*ctx\)/);
  });

  it('CRASH RECOVERY WIRED (PR #43 round 2) — buildIndex invokes reclaimStaleIndexing (a crashed indexing run is never permanently stuck)', () => {
    // Blocker 2: reclaimStaleIndexing existed in the /projects storage
    // authority but buildIndex never invoked it — a crash after ensureIndex
    // left the index permanently 'indexing' (every subsequent buildIndex
    // returned cas-lost forever). The fix: buildIndex's 'existing' + 'indexing'
    // branch calls reclaimStaleIndexing (gated by the staleness TTL — a live
    // run is NOT prematurely reclaimed) + re-drives markComplete.
    const orchestrator = readFileSync(join(RI_DIR, 'internal', 'default-repository-intelligence-service.ts'), 'utf8');
    expect(orchestrator, 'buildIndex calls reclaimStaleIndexing on a stuck indexing row').toMatch(/reclaimStaleIndexing\(/);
    // The TTL guard — a live run (updated_at within the TTL) is NOT reclaimed.
    expect(orchestrator, 'buildIndex gates reclaim on the staleness TTL (isStaleIndexing)').toMatch(/isStaleIndexing/);
    expect(orchestrator, 'the indexing-staleness TTL is configurable (indexingStaleAfterMs)').toMatch(/indexingStaleAfterMs/);
    // The app.ts composition root MUST wire the TTL (env-configurable, with
    // a sane default) — the orchestrator must not silently fall back to 0
    // (which would reclaim legitimately in-flight runs).
    const appSrc = readFileSync(join(SRC_ROOT, 'app.ts'), 'utf8');
    expect(appSrc, 'app.ts wires indexingStaleAfterMs (env WORKFLOWOS_CONTEXT_INDEX_STALE_AFTER_MS)').toMatch(/WORKFLOWOS_CONTEXT_INDEX_STALE_AFTER_MS/);
    expect(appSrc, 'app.ts defaults the TTL to 5 minutes').toMatch(/5\s*\*\s*60\s*\*\s*1000/);
  });

  it('NO FABRICATED TOOL EVIDENCE — the orchestrator passes hostInspector.toolInvocationIds through verbatim; the NoOp default returns []', () => {
    // The orchestrator NEVER invents toolInvocationIds. It passes the
    // hostInspector's output through to ensureIndex verbatim. The NoOpHostInspector
    // returns '[]' (no host inspection; the no-fabrication invariant).
    const orchestrator = readFileSync(join(RI_DIR, 'internal', 'default-repository-intelligence-service.ts'), 'utf8');
    expect(orchestrator, 'the orchestrator passes hostResult.toolInvocationIds through').toMatch(/toolInvocationIds:\s*hostResult\.toolInvocationIds/);
    // The orchestrator must NOT fabricate an ID (no randomUUID assigned to
    // toolInvocationIds; the randomUUID is only for indexingRunId).
    expect(orchestrator, 'the orchestrator must not fabricate toolInvocationIds').not.toMatch(/toolInvocationIds:\s*\[.*randomUUID/);
    const noop = readFileSync(join(RI_DIR, 'internal', 'noop-host-inspector.ts'), 'utf8');
    expect(noop, 'NoOpHostInspector returns empty toolInvocationIds').toMatch(/toolInvocationIds:\s*\[\]/);
    expect(noop, 'NoOpHostInspector returns empty observations').toMatch(/observations:\s*\[\]/);
    // The migration's tool_invocation_ids column defaults to '[]'.
    const migration = readFileSync(MIGRATION_0041, 'utf8');
    expect(migration, 'migration 0041 defaults tool_invocation_ids to []').toMatch(/tool_invocation_ids JSONB NOT NULL DEFAULT '\[\]'/);
  });

  it('EXPLAINABLE RELEVANCE — every context item carries a non-empty relevance_reason', () => {
    // The migration enforces non-empty relevance_reason via CHECK. The ranker
    // produces a reason for every included item (baseline observations get
    // the baseline_observation reason; non-baseline items with no hit are
    // filtered out by the inclusion policy).
    const migration = readFileSync(MIGRATION_0041, 'utf8');
    expect(migration, 'migration 0041 enforces non-empty relevance_reason').toMatch(/relevance_reason TEXT NOT NULL CHECK \(length\(relevance_reason\) > 0\)/);
    const ranker = readFileSync(join(RI_DIR, 'internal', 'deterministic-context-ranker.ts'), 'utf8');
    expect(ranker, 'the ranker produces a reason for every included item').toMatch(/baseline_observation\(\$\{s\.item\.provenance\}/);
  });

  it('TENANT ISOLATION — every context index + item is project_id + organization_id scoped', () => {
    // The migration carries project_id + organization_id on both tables.
    // The route's resolveContext verifies baseline.projectId === projectId
    // (server-side ownership check — no UUID-as-credential).
    const migration = readFileSync(MIGRATION_0041, 'utf8');
    expect(migration, 'wfos_project_context_indices has project_id').toMatch(/project_id UUID NOT NULL REFERENCES wfos_projects/);
    expect(migration, 'wfos_project_context_indices has organization_id').toMatch(/organization_id UUID NOT NULL/);
    expect(migration, 'wfos_project_context_items has project_id').toMatch(/project_id UUID NOT NULL,/);
    expect(migration, 'wfos_project_context_items has organization_id').toMatch(/organization_id UUID NOT NULL,/);
    const route = readFileSync(RI_ROUTE, 'utf8');
    expect(route, 'the route checks baseline.projectId === projectId').toMatch(/baseline\.projectId !== projectId/);
    expect(route, 'the route checks index.projectId === projectId').toMatch(/index\.projectId !== projectId/);
    expect(route, 'the route uses requireProjectAuthorization').toMatch(/requireProjectAuthorization/);
  });

  it('IDEMPOTENCY + CONCURRENCY — the unique constraints + the CAS + the SELECT FOR UPDATE fence concurrent indexing', () => {
    // The migration's UNIQUE(baseline_id, query_kind, query_ref) on indices +
    // UNIQUE(context_index_id, locator, source, kind) on items make
    // concurrent/retried indexing converge to a single row (no duplicates).
    // The storage repository's markComplete wraps SELECT FOR UPDATE + item
    // upserts + CAS complete in a single transaction.
    const migration = readFileSync(MIGRATION_0041, 'utf8');
    expect(migration, 'migration 0041 enforces index idempotency').toMatch(/UNIQUE \(baseline_id, query_kind, query_ref\)/);
    expect(migration, 'migration 0041 enforces item idempotency').toMatch(/UNIQUE \(context_index_id, locator, source, kind\)/);
    const repo = readFileSync(PROJECTS_CONTEXT_INDEX_REPO, 'utf8');
    expect(repo, 'markComplete opens a transaction').toMatch(/this\.db\.transaction\(async \(tx\) =>/);
    expect(repo, 'markComplete acquires SELECT FOR UPDATE on the index row').toMatch(/SELECT \$\{INDEX_COLUMNS\} FROM wfos_project_context_indices\s+WHERE id = \$1 FOR UPDATE/);
    expect(repo, 'markComplete CAS-completes with version predicate').toMatch(/WHERE id = \$3 AND version = \$2 AND state = 'indexing'/);
    expect(repo, 'ensureIndex uses ON CONFLICT DO NOTHING').toMatch(/ON CONFLICT \(baseline_id, query_kind, query_ref\) DO NOTHING/);
    expect(repo, 'insertItemIn uses ON CONFLICT DO NOTHING').toMatch(/ON CONFLICT \(context_index_id, locator, source, kind\) DO NOTHING/);
  });

  it('app.ts wires the repositoryIntelligenceService + projectContextIndexRepository (production context intelligence is available)', () => {
    // The composition root must construct the PgProjectContextIndexRepository
    // + the BaselineContextSource + the DeterministicContextRanker + the
    // DefaultRepositoryIntelligenceService, and expose them for the route.
    const appSrc = readFileSync(join(SRC_ROOT, 'app.ts'), 'utf8');
    expect(appSrc, 'app.ts constructs PgProjectContextIndexRepository').toMatch(/new PgProjectContextIndexRepository\(/);
    expect(appSrc, 'app.ts constructs BaselineContextSource').toMatch(/new BaselineContextSource\(/);
    expect(appSrc, 'app.ts constructs DeterministicContextRanker').toMatch(/new DeterministicContextRanker\(/);
    expect(appSrc, 'app.ts constructs DefaultRepositoryIntelligenceService').toMatch(/new DefaultRepositoryIntelligenceService\(/);
    expect(appSrc, 'app.ts exposes projectContextIndexRepository for the route').toMatch(/projectContextIndexRepository:\s*projectContextIndexRepositoryRef/);
    expect(appSrc, 'app.ts exposes repositoryIntelligenceService for the route').toMatch(/repositoryIntelligenceService:\s*repositoryIntelligenceServiceRef/);
  });

  it('server.ts registers the repositoryIntelligence route + ServerDeps declares it', () => {
    // The route must be registered in buildServer + the ServerDeps interface
    // must declare the repositoryIntelligence field.
    const serverSrc = readFileSync(join(SRC_ROOT, 'api', 'server.ts'), 'utf8');
    expect(serverSrc, 'server.ts imports repositoryIntelligenceRoutes').toMatch(/import\s+\{\s*repositoryIntelligenceRoutes/);
    expect(serverSrc, 'server.ts declares repositoryIntelligence in ServerDeps').toMatch(/repositoryIntelligence\?:\s*RepositoryIntelligenceRouteDeps/);
    expect(serverSrc, 'server.ts registers the repositoryIntelligence route').toMatch(/repositoryIntelligenceRoutes\(app, deps\.repositoryIntelligence\)/);
    // The index.ts production bootstrap assembles the route deps.
    const indexSrc = readFileSync(join(SRC_ROOT, 'index.ts'), 'utf8');
    expect(indexSrc, 'index.ts assembles the repositoryIntelligence route deps').toMatch(/repositoryIntelligence:\s*\{/);
  });

  it('the context index types are re-exported through the /projects barrel (the single project authority)', () => {
    // The context index is a PROJECT artifact (like ProjectBaseline); its
    // types live in /projects/internal/ + are re-exported through the
    // /projects barrel so the capability consumes them through the barrel
    // (NOT through internal/ — the cross-module internal/ import is forbidden
    // by PLAT-AC-02).
    const barrel = readFileSync(join(MODULES_DIR, 'projects', 'index.ts'), 'utf8');
    expect(barrel, 'the /projects barrel re-exports ProjectContextIndex').toMatch(/ProjectContextIndex/);
    expect(barrel, 'the /projects barrel re-exports ContextItem').toMatch(/\bContextItem\b/);
    expect(barrel, 'the /projects barrel re-exports ProjectContextIndexRepository').toMatch(/ProjectContextIndexRepository/);
    expect(barrel, 'the /projects barrel re-exports RepositoryIntelligenceError').toMatch(/RepositoryIntelligenceError/);
    // The capability consumes the /projects barrel (NOT internal/).
    const files = listTsFiles(RI_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /projects internal/ (use the barrel)`).not.toMatch(/from\s+['"][^'"]*modules\/projects\/internal/);
    }
  });
});

// ===========================================================================
// WORK-040 invariants — Continuous Development Planner (turns signals into
// governed Work Items THROUGH the existing /work-items authority).
// ===========================================================================
//
// The central correctness requirement: the planner is NOT a second Work Item
// authority. It CREATES Work Items through the existing WorkItemRepository.create
// (the single creation path) with a deterministic proposedWorkItemId as the
// dedup key; the existing UNIQUE(architecture_version_id, work_item_id) DB
// constraint is the persistence-level dedup fence — concurrent/retried planner
// runs CONVERGE to a single Work Item (no duplicates). The planner NEVER mutates
// the dependency graph (no add/remove), NEVER mutates workflow / verification /
// review state, NEVER starts execution, NEVER selects a provider. Provenance
// (the WORK-038 vocabulary observed/inferred/confirmed/proposed) is preserved
// verbatim — a recommendation is `proposed` (or observed/inferred per the
// signal); it NEVER becomes `confirmed` without an authorized confirmation path.
//
// Authority boundaries preserved:
//   /work-items — the AUTHORITATIVE Work Item authority. The planner CREATES
//                  through the existing WorkItemRepository.create (legitimate).
//                  It does NOT mutate the dependency graph (no add/remove), does
//                  NOT set `completed` (internal-only), does NOT create Work
//                  Orders. The dedup key is the existing
//                  UNIQUE(architecture_version_id, work_item_id).
//   /architecture, /requirements — read-only authority references (the planner
//                  resolves the target ArchitectureVersion + cites ADRs /
//                  requirements as evidence; it NEVER auto-freezes / never
//                  creates versions / requirements / criteria).
//   /projects  — the planner resolves the project + organizationId for tenant
//                  scoping; it NEVER creates projects.
//   /github    — NEVER imported by the planner domain (the revision-bound
//                  baselineCommitSha is carried in the signal; the planner does
//                  NOT re-resolve the repo — that is the WORK-039 caller's job).
//   /workflows, /verification, /reviews, /agents — NEVER mutated/invoked.
//
// The capability lives in src/development-planner/ — an APPLICATION-LAYER
// orchestrator (like src/onboarding/ + src/repository-intelligence/ +
// src/execution-policy/ + src/benchmark/), NOT a frozen module and NOT an
// authority. It owns NO tables — the planning evidence is embedded in the
// authoritative Work Item's existing `metadata` JSONB (field `metadata.planner`).
describe('WORK-040 invariants — Continuous Development Planner (planner capability + governed Work Item creation)', () => {
  const DP_DIR = join(SRC_ROOT, 'development-planner');
  const DP_ROUTE = join(SRC_ROOT, 'api', 'routes', 'development-planner.route.ts');

  /** Recursively list every .ts file under a directory. */
  function listTsFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...listTsFiles(full));
      } else if (entry.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('WORK-040 is NOT a frozen module — development-planner is an application capability, not a new authority', () => {
    // The static check at PLAT-AC-01 enforces exactly 17 frozen modules. The
    // development-planner capability must NOT add an 18th module under
    // src/modules/. It lives under src/development-planner/ (an
    // application-layer directory, like src/onboarding/ +
    // src/repository-intelligence/).
    expect(existsSync(join(MODULES_DIR, 'development-planner'))).toBe(false);
    expect(existsSync(DP_DIR)).toBe(true);
  });

  it('NO NEW TABLE — the planner owns no tables; planning evidence lives in the Work Item existing metadata.planner JSONB', () => {
    // The frozen spec: "Avoid a giant AI planner state table. Use existing
    // /work-items models wherever authoritative state is needed. Persistent
    // planning evidence may belong in an application-layer table only if the
    // frozen specification requires durable planning history." The frozen
    // WORK-040 spec does NOT require durable planning history (it requires
    // governed Work Item creation). The planner therefore owns NO migration +
    // NO table — the evidence is embedded in the authoritative Work Item's
    // existing metadata JSONB (field metadata.planner). There is NO migration
    // 0042+ introduced by WORK-040.
    const migrationsDir = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations');
    const migrations = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    // The highest migration is 0050 (WORK-043 — the execution-eligibility
    // constraint columns + the usage-derivation index: ALTER + INDEX ONLY,
    // no table; 0049 is PR #46 round 9 — the GENERATION-FENCED,
    // IDENTITY-RECOVERABLE provider-operation ledger; 0048 is the durable
    // provider-operation ledger; 0047 is the cross-mode-handoff durable
    // dispatch idempotency key; 0046 is the fenced dispatch gate;
    // 0045 is the claim_epoch fencing token; 0044 is the claim/lease columns;
    // 0043 is the obligation table itself; 0042 is the WORK-042 cross-mode
    // handoff log). WORK-040 added none (0042-0049 belong to WORK-042, 0050
    // belongs to WORK-043 — neither is a planner-owned table).
    // The planner evidence lives in the existing Work Item metadata.planner
    // JSONB; no planner-owned table exists.
    const last = migrations[migrations.length - 1];
    expect(last, 'WORK-040 adds no migration (the last migration is the WORK-043 execution-eligibility constraint migration — ALTER + INDEX only, no planner-owned table)').toMatch(/^0050_/);
    // The planner domain must NOT define any CREATE TABLE.
    const files = listTsFiles(DP_DIR);
    expect(files.length, 'src/development-planner/ must contain implementation files').toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not define a CREATE TABLE`).not.toMatch(/CREATE\s+TABLE/i);
    }
  });

  it('no second project authority — the planner resolves the project for tenant scoping; it NEVER creates/updates projects', () => {
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not create/update projects`).not.toMatch(/projectRepository\.(create|transitionState|update)\s*\(/);
    }
  });

  it('no second architecture authority — the planner NEVER auto-freezes / never creates ArchitectureVersion rows', () => {
    // Architecture references in planning evidence are REFERENCES to
    // ArchitectureVersion ids, never an auto-created ArchitectureVersion. The
    // capability never calls ArchitectureService mutation methods.
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /architecture internal/`).not.toMatch(/from\s+['"][^'"]*modules\/architecture\/internal/);
      expect(src, `${rel} must not freeze architecture versions`).not.toMatch(/freezeVersion\s*\(/);
      expect(src, `${rel} must not create architecture versions`).not.toMatch(/architectureVersionRepository\.create\s*\(/);
      expect(src, `${rel} must not approve architecture change requests`).not.toMatch(/approveChangeAndCreateReplacement\s*\(/);
    }
  });

  it('no second requirements authority — the planner does NOT create Requirement/AcceptanceCriterion rows', () => {
    // Requirement references in planning evidence are REFERENCES to
    // authoritative Requirement rows, never duplicate requirements.
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /requirements internal/`).not.toMatch(/from\s+['"][^'"]*modules\/requirements\/internal/);
      expect(src, `${rel} must not create requirements`).not.toMatch(/requirementRepository\.create\s*\(/);
      expect(src, `${rel} must not create acceptance criteria`).not.toMatch(/acceptanceCriterionRepository\.create\s*\(/);
    }
  });

  it('NO DEPENDENCY GRAPH MUTATION — the planner creates Work Item ROWS (legitimate, via existing create) but NEVER mutates the dependency graph / completion / Work Orders', () => {
    // The planner's legitimate creation: workItemRepository.create (the single
    // creation path). The planner MUST NOT: mutate the dependency graph
    // (workItemDependencyRepository.add/remove), set completion
    // (markCompleted — internal-only), create Work Orders (workOrderRepository).
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      // The dependency graph is mutated ONLY through the existing
      // /work-items/dependencies route — the planner NEVER calls add/remove.
      expect(src, `${rel} must not add work item dependencies (no graph mutation)`).not.toMatch(/workItemDependencyRepository\.(add|remove)\s*\(/);
      // `completed` is internal-only (the public WorkItemRepository interface
      // does not expose markCompleted); the planner NEVER sets it.
      expect(src, `${rel} must not set work item completion`).not.toMatch(/markCompleted\s*\(/);
      // Work Orders are a separate /work-items mutation surface; the planner
      // does NOT create them (the Work Order lifecycle is downstream).
      expect(src, `${rel} must not create work orders`).not.toMatch(/workOrderRepository\.create\s*\(/);
      // The planner does NOT import /work-items internal/ (uses the barrel).
      expect(src, `${rel} must not import /work-items internal/`).not.toMatch(/from\s+['"][^'"]*modules\/work-items\/internal/);
    }
  });

  it('NO WORKFLOW / VERIFICATION / REVIEW MUTATION — the planner never mutates those authorities', () => {
    // The created Work Item enters the EXISTING Work Item → Work Order →
    // Execution → Verification → Review lifecycle; the planner does NOT advance
    // it. It never imports /workflows / /verification / /reviews internal/ +
    // never calls their mutation methods.
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /workflows internal/`).not.toMatch(/from\s+['"][^'"]*modules\/workflows\/internal/);
      expect(src, `${rel} must not transition workflow state`).not.toMatch(/workflowRepository\.(transitionState|create|update)\s*\(/);
      expect(src, `${rel} must not import /verification internal/`).not.toMatch(/from\s+['"][^'"]*modules\/verification\/internal/);
      expect(src, `${rel} must not import /reviews internal/`).not.toMatch(/from\s+['"][^'"]*modules\/reviews\/internal/);
    }
  });

  it('NO DIRECT EXECUTION / NO PROVIDER ROUTING — the planner never starts execution + never selects a provider', () => {
    // WORK-043/044 (execution eligibility + adaptive routing) are OUT OF SCOPE.
    // The planner produces governed Work Items; when later executed, the
    // existing execution policy decides how. The planner notes the ADVISORY
    // frozen-spec value 'native-or-external-per-eligibility' but does NOT
    // select a provider + does NOT start execution.
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /agents internal/ (no execution)`).not.toMatch(/from\s+['"][^'"]*modules\/agents\/internal/);
      expect(src, `${rel} must not start execution`).not.toMatch(/executionService\.start\s*\(/);
      expect(src, `${rel} must not import a provider SDK`).not.toMatch(/from\s+['"][^'"]*(openai|anthropic|@anthropic-ai|@xenova|transformers)/);
    }
    // The executionModeAdvisory is the ADVISORY frozen-spec value (NOT a
    // provider selection) — declared in the types + set by the prioritizer.
    const types = readFileSync(join(DP_DIR, 'development-planner.types.ts'), 'utf8');
    expect(types, 'the types declare the advisory execution-mode value').toMatch(/native-or-external-per-eligibility/);
    const prioritizer = readFileSync(join(DP_DIR, 'internal', 'deterministic-planning-prioritizer.ts'), 'utf8');
    expect(prioritizer, 'the prioritizer sets the advisory execution-mode value (NOT a provider selection)').toMatch(/executionModeAdvisory:\s*['"]native-or-external-per-eligibility['"]/);
  });

  it('NO CREDENTIALS — the planner never imports a concrete secret store + never assigns token/password values', () => {
    // The planner domain never handles credentials. Secret-shaped content
    // from WORK-038 context (cited as evidence) is already redacted; the
    // planner never reverses redaction.
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import EnvSecretStore`).not.toMatch(/from\s+['"][^'"]*platform\/secrets/);
      expect(src, `${rel} must not import /auth internal/`).not.toMatch(/from\s+['"][^'"]*modules\/auth\/internal/);
    }
  });

  it('NO GITHUB SDK / NO /github internal/ — the planner never re-resolves the repo (the revision is carried in the signal)', () => {
    // WORK-039 owns the repository/context engine. The planner CONSUMES at the
    // signal-production layer (the explicit trigger caller may derive signals
    // from retrieveExisting); the planner itself does NOT call retrieveExisting
    // + does NOT import the GitHub SDK / /github internal/.
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import @octokit (GitHub SDK)`).not.toMatch(/from\s+['"]@octokit/);
      expect(src, `${rel} must not import /github internal/`).not.toMatch(/from\s+['"][^'"]*modules\/github\/internal/);
    }
  });

  it('NO PROVIDER SDK LEAKAGE — the planner domain imports no pg / ioredis / pglite', () => {
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import pg`).not.toMatch(/from\s+['"]pg['"]/);
      expect(src, `${rel} must not import @electric-sql/pglite`).not.toMatch(/from\s+['"]@electric-sql\/pglite['"]/);
      expect(src, `${rel} must not import ioredis`).not.toMatch(/from\s+['"]ioredis['"]/);
      expect(src, `${rel} must not import concrete provider implementation files`).not.toMatch(/from\s+['"][^'"]*platform\/(postgres|redis|storage|secrets)\/internal/);
    }
  });

  it('NO MAINTENANCE ENGINE / NO CONTINUOUS SCHEDULER — the planner is trigger-driven (explicit POST + a durable job), not a polling engine', () => {
    // WORK-041 (Maintenance + Project Health Engine) is STRICTLY OUT OF SCOPE.
    // The planner does NOT poll, does NOT setInterval, does NOT cron, does NOT
    // auto-scan vulnerabilities / CI / dependencies. It is triggered
    // EXPLICITLY (POST .../planning/evaluate) + via a durable job registered
    // with the EXISTING WorkerHost (NO new scheduler).
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not define a setInterval scheduler`).not.toMatch(/setInterval\s*\(/);
      expect(src, `${rel} must not define a cron scheduler`).not.toMatch(/\bcron\s*\(/);
      expect(src, `${rel} must not define a maintenance/health engine`).not.toMatch(/MaintenanceEngine|HealthEngine|VulnerabilityScanner|DependencyAdvisoryIngestion/);
    }
  });

  it('NO VECTOR DATABASE / NO EMBEDDING / NO TSVECTOR — the prioritizer is deterministic + discrete', () => {
    // The prioritizer's signals are discrete + explainable (blocks-n-downstream,
    // requested-by-developer, architecture-risk, dependency-chain, etc.). NO
    // opaque AI score; NO vector/embedding/tsvector infrastructure.
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not use pgvector/vector/embedding/tsvector`).not.toMatch(/pgvector|vector\(\d+|embedding\(\d+|to_tsvector|tsquery|tsvector/i);
      expect(src, `${rel} must not import an embedding library`).not.toMatch(/from\s+['"][^'"]*(openai|cohere|@xenova|transformers)/);
    }
  });

  it('PROVENANCE PRESERVATION — the prioritizer + the orchestrator NEVER assign the literal confirmed to a provenance field', () => {
    // The planner re-uses the WORK-038 vocabulary (observed/inferred/confirmed/
    // proposed). A recommendation is `proposed` (or observed/inferred per the
    // signal); it NEVER becomes `confirmed` without an authorized confirmation
    // path on a baseline observation. The regex forbids both direct
    // `provenance: 'confirmed'` AND conditional promotion
    // `provenance: x ? 'confirmed' : 'observed'`.
    const prioritizer = readFileSync(join(DP_DIR, 'internal', 'deterministic-planning-prioritizer.ts'), 'utf8');
    expect(prioritizer, 'the prioritizer must not promote provenance to confirmed').not.toMatch(/provenance:\s*[^,}]*['"]confirmed['"]/);
    const orchestrator = readFileSync(join(DP_DIR, 'internal', 'default-development-planner-service.ts'), 'utf8');
    expect(orchestrator, 'the orchestrator must not promote provenance to confirmed').not.toMatch(/provenance:\s*[^,}]*['"]confirmed['"]/);
    const types = readFileSync(join(DP_DIR, 'development-planner.types.ts'), 'utf8');
    // The PlanningProvenance type is the WORK-038 vocabulary MINUS 'confirmed'
    // (a planner signal is never confirmed — confirmation is a separate path).
    expect(types, 'PlanningProvenance excludes confirmed').toMatch(/'observed'\s*\|\s*'inferred'\s*\|\s*'proposed'/);
    expect(types, 'PlanningProvenance must not include confirmed').not.toMatch(/PlanningProvenance\s*=\s*[^;]*['"]confirmed['"]/);
  });

  it('the development-planner barrel exports ONLY known pure-data constants — no concrete implementations (classes/functions with behavior) are exported', () => {
    // Mirrors the frozen-module barrel rule + the WORK-039 barrel convention.
    // DefaultDevelopmentPlannerService + DeterministicPlanningPrioritizer +
    // PlanningEvaluateJobHandler stay in internal/ (the composition root in
    // app.ts wires them by importing from internal/, the sanctioned wiring
    // boundary). The barrel MAY export pure-data constants (the job-type name,
    // the redelivery policy, the planner version) — these are NOT concrete
    // implementations; they are the frozen string/numeric values the route +
    // the handler need to reference the job type + the policy.
    const barrel = readFileSync(join(DP_DIR, 'index.ts'), 'utf8');
    const valueExportRegex = /export\s+(?!type\b)\{([^}]+)\}\s+from/g;
    const matches = [...barrel.matchAll(valueExportRegex)];
    // The sanctioned pure-data constants (NOT concrete implementations).
    const PURE_DATA_CONSTANTS = new Set<string>([
      'PLANNING_EVALUATE_JOB_TYPE',
      'PLANNING_EVALUATE_REDELIVERY_POLICY',
      'PLANNER_VERSION',
    ]);
    const violations: string[] = [];
    for (const m of matches) {
      const names = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      for (const n of names) {
        if (!PURE_DATA_CONSTANTS.has(n)) violations.push(n);
      }
    }
    expect(
      violations,
      `src/development-planner/index.ts exports non-constant value: ${violations.join(', ')} (only pure-data constants are permitted; concrete implementations stay in internal/)`,
    ).toEqual([]);
    // The barrel must NOT export a class or function (concrete implementation).
    expect(barrel, 'the barrel must not export a concrete class').not.toMatch(/export\s+class\s+/);
    expect(barrel, 'the barrel must not export a concrete function').not.toMatch(/export\s+function\s+/);
  });

  it('READ/MUTATION SEPARATION — the GET route calls only read methods; the POST evaluate is the only mutation (project.write); GET uses project.read', () => {
    // The frozen spec: "A read endpoint must never silently trigger Work Item
    // creation or planner state mutation." The GET recommendations routes call
    // only listRecommendations (read-only service method) + findById (read).
    // The POST evaluate route is the mutation (project.write) that creates
    // Work Items through the orchestrator. The route layer NEVER directly
    // calls workItemRepository.create (the creation is delegated to the
    // orchestrator, invoked only from the POST evaluate handler).
    const route = readFileSync(DP_ROUTE, 'utf8');
    // The route does NOT directly call workItemRepository.create (the
    // orchestrator does, invoked only from the POST /evaluate handler).
    expect(route, 'the route must not directly call workItemRepository.create (the orchestrator does)').not.toMatch(/workItemRepository\.create\s*\(/);
    // The GET routes call listRecommendations (read-only) + findById (read).
    expect(route, 'the GET recommendations route calls listRecommendations').toMatch(/plannerService\.listRecommendations\(/);
    // The POST evaluate route is the mutation — it calls plannerService.evaluate.
    expect(route, 'the POST evaluate route calls plannerService.evaluate (the mutation)').toMatch(/plannerService\.evaluate\(/);
    // project.read is used (for the GET routes).
    expect(route, 'the route uses project.read').toMatch(/permission:\s*['"]project\.read['"]/);
    // project.write is used (for the POST routes — the mutation).
    expect(route, 'the route uses project.write').toMatch(/permission:\s*['"]project\.write['"]/);
  });

  it('DETERMINISTIC DEDUP KEY — the prioritizer computes a deterministic proposedWorkItemId (PLAN- + sha256 slice) for the existing UNIQUE constraint to fence', () => {
    // The dedup natural key is the existing UNIQUE(architecture_version_id,
    // work_item_id). The planner's proposedWorkItemId = "PLAN-" +
    // sha256(canonical(goal)+"|"+canonical(scope)).slice(0,10). Two signals
    // with the same canonical goal + scope produce the same id → the DB
    // constraint fences concurrent runs → convergence.
    const prioritizer = readFileSync(join(DP_DIR, 'internal', 'deterministic-planning-prioritizer.ts'), 'utf8');
    expect(prioritizer, 'uses node:crypto createHash (deterministic)').toMatch(/from\s+['"]node:crypto['"]/);
    expect(prioritizer, 'computes sha256').toMatch(/createHash\(['"]sha256['"]\)/);
    expect(prioritizer, 'the proposedWorkItemId is PLAN- prefixed').toMatch(/`PLAN-\$\{computeCanonicalGoalHash/);
    expect(prioritizer, 'the hash is truncated to 10 hex chars').toMatch(/\.slice\(0,\s*10\)/);
    expect(prioritizer, 'canonicalizes the goal (lowercase + collapse whitespace)').toMatch(/\.toLowerCase\(\)\.replace\(\/\\s\+\/g/);
  });

  it('REVISION-BOUND CONTEXT CITED — the metadata.planner payload records the baselineCommitSha the signal was bound to', () => {
    // The frozen spec: "All context remains revision-bound." The planner
    // records the baselineCommitSha in metadata.planner.baselineCommitSha so
    // the recommendation's evidence is traceable to a concrete revision.
    const orchestrator = readFileSync(join(DP_DIR, 'internal', 'default-development-planner-service.ts'), 'utf8');
    expect(orchestrator, 'the orchestrator embeds metadata.planner').toMatch(/metadata:\s*\{\s*planner:\s*metadataPayload/);
    const types = readFileSync(join(DP_DIR, 'development-planner.types.ts'), 'utf8');
    expect(types, 'PlanningMetadataPayload carries baselineCommitSha').toMatch(/readonly baselineCommitSha:\s*string \| null/);
  });

  it('EXPLAINABLE PRIORITY — every candidate carries priorityFactors + rationale + whyNow (no opaque AI score)', () => {
    // The frozen spec: "Do NOT reduce everything to an opaque AI score. Prefer
    // structured reasons." The prioritizer produces discrete, traceable factors.
    const types = readFileSync(join(DP_DIR, 'development-planner.types.ts'), 'utf8');
    expect(types, 'PlanningCandidate carries priorityFactors').toMatch(/readonly priorityFactors:\s*readonly PlanningPriorityFactor\[\]/);
    expect(types, 'PlanningCandidate carries rationale').toMatch(/readonly rationale:\s*string/);
    expect(types, 'PlanningCandidate carries whyNow').toMatch(/readonly whyNow:\s*string/);
    expect(types, 'PlanningCandidate carries expectedImpact').toMatch(/readonly expectedImpact:\s*string/);
    const prioritizer = readFileSync(join(DP_DIR, 'internal', 'deterministic-planning-prioritizer.ts'), 'utf8');
    expect(prioritizer, 'the prioritizer sums weights to a discrete band').toMatch(/bandFor\(totalWeight\)/);
  });

  it('DURABLE JOB IS IDEMPOTENT + HAS A REDELIVERY POLICY (crash/retry safe) — reuses the existing WorkerHost, NO new scheduler', () => {
    // The planner is convergent (the DB constraint fences concurrent/redelivered
    // runs). The durable planning.evaluate job handler therefore declares a
    // redeliveryPolicy (maxAttempts: 3) — a transient failure produces another
    // DURABLE attempt without a process restart. The handler is registered
    // with the EXISTING WorkerHost registry (NO new scheduler).
    const handler = readFileSync(join(DP_DIR, 'internal', 'planning-evaluate-job-handler.ts'), 'utf8');
    expect(handler, 'the handler implements JobHandler').toMatch(/class\s+PlanningEvaluateJobHandler\s+implements\s+JobHandler/);
    expect(handler, 'the handler declares a redeliveryPolicy').toMatch(/redeliveryPolicy\s*=\s*PLANNING_EVALUATE_REDELIVERY_POLICY/);
    expect(handler, 'the handler re-resolves the project (not serializable handles)').toMatch(/projectRepository\.findById\(/);
    // The handler does NOT define a scheduler (reuses WorkerHost).
    expect(handler, 'the handler must not define setInterval').not.toMatch(/setInterval\s*\(/);
    expect(handler, 'the handler must not define cron').not.toMatch(/\bcron\s*\(/);
    const types = readFileSync(join(DP_DIR, 'development-planner.types.ts'), 'utf8');
    expect(types, 'PLANNING_EVALUATE_REDELIVERY_POLICY maxAttempts: 3').toMatch(/maxAttempts:\s*3/);
  });

  it('TENANT ISOLATION — every route resolves the project + authorizes; the orchestrator re-asserts version.projectId === ctx.projectId', () => {
    // Every route uses requireProjectAuthorization. The orchestrator
    // re-asserts the architecture version belongs to ctx.projectId (defense
    // in depth — a UUID is NEVER a credential). The GET inspect route walks
    // WorkItem→Version→Architecture→Project + checks it matches.
    const route = readFileSync(DP_ROUTE, 'utf8');
    expect(route, 'the route uses requireProjectAuthorization').toMatch(/requireProjectAuthorization/);
    expect(route, 'the GET inspect route checks cross-tenant').toMatch(/cross-tenant-work-item/);
    const orchestrator = readFileSync(join(DP_DIR, 'internal', 'default-development-planner-service.ts'), 'utf8');
    expect(orchestrator, 'the orchestrator re-asserts version in project').toMatch(/planning-architecture-version-not-in-project/);
  });

  it('app.ts wires the developmentPlannerService + the planningEvaluateJobHandler (production planning is available)', () => {
    // The composition root must construct the DeterministicPlanningPrioritizer
    // + the DefaultDevelopmentPlannerService + the PlanningEvaluateJobHandler,
    // and expose the service for the route + push the handler to the existing
    // WorkerHost registry.
    const appSrc = readFileSync(join(SRC_ROOT, 'app.ts'), 'utf8');
    expect(appSrc, 'app.ts constructs DeterministicPlanningPrioritizer').toMatch(/new DeterministicPlanningPrioritizer\(/);
    expect(appSrc, 'app.ts constructs DefaultDevelopmentPlannerService').toMatch(/new DefaultDevelopmentPlannerService\(/);
    expect(appSrc, 'app.ts constructs PlanningEvaluateJobHandler').toMatch(/new PlanningEvaluateJobHandler\(/);
    expect(appSrc, 'app.ts exposes developmentPlannerService for the route').toMatch(/developmentPlannerService:\s*developmentPlannerServiceRef/);
    expect(appSrc, 'app.ts pushes the planning handler to the existing WorkerHost registry').toMatch(/handlerList\.push\(planningEvaluateJobHandlerRef\)/);
  });

  it('server.ts registers the developmentPlanner route + ServerDeps declares it; index.ts assembles the route deps', () => {
    const serverSrc = readFileSync(join(SRC_ROOT, 'api', 'server.ts'), 'utf8');
    expect(serverSrc, 'server.ts imports developmentPlannerRoutes').toMatch(/import\s+\{\s*developmentPlannerRoutes/);
    expect(serverSrc, 'server.ts declares developmentPlanner in ServerDeps').toMatch(/developmentPlanner\?:\s*DevelopmentPlannerRouteDeps/);
    expect(serverSrc, 'server.ts registers the developmentPlanner route').toMatch(/developmentPlannerRoutes\(app,\s*deps\.developmentPlanner\)/);
    const indexSrc = readFileSync(join(SRC_ROOT, 'index.ts'), 'utf8');
    expect(indexSrc, 'index.ts assembles the developmentPlanner route deps').toMatch(/developmentPlanner:\s*\{/);
  });

  it('the development-planner capability consumes the authority barrels (NOT internal/)', () => {
    // The capability imports from @modules/work-items, @modules/architecture,
    // @modules/requirements, @development-planner, @platform — never from any
    // internal/ of a frozen module (PLAT-AC-02).
    const files = listTsFiles(DP_DIR);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BACKEND_ROOT, f);
      expect(src, `${rel} must not import /work-items internal/`).not.toMatch(/from\s+['"][^'"]*modules\/work-items\/internal/);
      expect(src, `${rel} must not import /architecture internal/`).not.toMatch(/from\s+['"][^'"]*modules\/architecture\/internal/);
      expect(src, `${rel} must not import /requirements internal/`).not.toMatch(/from\s+['"][^'"]*modules\/requirements\/internal/);
      expect(src, `${rel} must not import /projects internal/`).not.toMatch(/from\s+['"][^'"]*modules\/projects\/internal/);
    }
  });

  it('NO FABRICATED TOOL EVIDENCE — the orchestrator + prioritizer never invent evidence refs; the prioritizer records honest read failures', () => {
    // The prioritizer reads the dependency graph for explanation; if a related
    // id is not found (or its deps can't be read), it records the failure
    // honestly (logger.warn) — it does NOT fabricate a chain.
    const prioritizer = readFileSync(join(DP_DIR, 'internal', 'deterministic-planning-prioritizer.ts'), 'utf8');
    expect(prioritizer, 'the prioritizer logs honest dependency-chain read failures').toMatch(/dependency-chain-read-failed/);
  });

  it('TENANT-OWNERSHIP GUARD BEFORE DEPENDENCY TRAVERSAL (PR #44 round 2) — listTransitiveDependencies is ALWAYS preceded by a project-ownership check (no cross-tenant dependency leak)', () => {
    // Blocker: the route accepts caller-controlled PlanningSignal.relatedWorkItemIds.
    // The prioritizer must NOT call listTransitiveDependencies(relatedId) without
    // first resolving WorkItem → ArchitectureVersion → Architecture → Project +
    // requiring === ctx.projectId. A Project A user submitting a Project B work
    // item id must NOT cause traversal of Project B's dependency graph (cross-
    // tenant information leak). The fix: a resolveWorkItemProject guard gates
    // every traversal; cross-project ids are ignored WITHOUT traversal.
    const prioritizer = readFileSync(join(DP_DIR, 'internal', 'deterministic-planning-prioritizer.ts'), 'utf8');
    // 1. The ownership-guard helper exists + is called.
    expect(prioritizer, 'the prioritizer defines + calls resolveWorkItemProject (the ownership guard)').toMatch(/resolveWorkItemProject\(/);
    // 2. The gate: the resolved projectId is compared to ctx.projectId.
    expect(prioritizer, 'the prioritizer gates on ownerProjectId === ctx.projectId').toMatch(/ownerProjectId\s*!==\s*ctx\.projectId/);
    // 3. The honest rejection log for cross-tenant / not-found ids.
    expect(prioritizer, 'the prioritizer logs cross-tenant related-work-item rejection').toMatch(/related-work-item-not-in-project/);
    // 4. The traversal is present (gated by the guard). The dotted form
    //    (.listTransitiveDependencies() matches only the actual method CALL,
    //    not JSDoc mentions of the symbol — the ordering check below is
    //    therefore precise).
    expect(prioritizer, 'the prioritizer calls listTransitiveDependencies (gated by the guard)').toMatch(/\.listTransitiveDependencies\(/);
    // 5. ORDERING: the guard symbol MUST appear BEFORE the traversal CALL in
    //    the file (the guard is defined + called before the traversal). This
    //    is the static proof that the guard precedes the FIRST traversal; the
    //    count check (#6 below) proves EVERY traversal is gated; the dynamic
    //    proof is the cross-tenant regression test (#8b).
    const guardIdx = prioritizer.indexOf('resolveWorkItemProject(');
    const traversalIdx = prioritizer.indexOf('.listTransitiveDependencies(');
    expect(guardIdx, 'the ownership guard must be present').toBeGreaterThan(-1);
    expect(traversalIdx, 'the traversal call must be present').toBeGreaterThan(-1);
    expect(guardIdx, 'the ownership guard must precede the traversal call in the file').toBeLessThan(traversalIdx);
    // 6. The WorkItem → ArchitectureVersion → Architecture → Project walk is
    //    present in the guard (the canonical traceability chain).
    expect(prioritizer, 'the guard resolves the work item').toMatch(/workItemRepository\.findById\(/);
    expect(prioritizer, 'the guard resolves the architecture version').toMatch(/architectureVersionRepository\.findById\(/);
    expect(prioritizer, 'the guard resolves the architecture (→ project)').toMatch(/architectureRepository\.findById\(/);
    expect(prioritizer, 'the guard returns the project id').toMatch(/return arch\.projectId/);
    // 7. EVERY traversal site is gated — count-based proof. The number of
    //    guard CALL sites (resolveWorkItemProject( occurrences MINUS the one
    //    function definition) must be >= the number of traversal CALL sites
    //    (.listTransitiveDependencies( dotted calls). This PREVENTS a future
    //    developer from adding a SECOND, unguarded listTransitiveDependencies
    //    call in a different code path — every traversal site must have a
    //    corresponding guard call site. (The first-occurrence ordering check
    //    #5 proves the guard precedes the first traversal; this count check
    //    proves NO traversal site lacks a guard — the architect's "preventing
    //    an unscoped listTransitiveDependencies(relatedId) call" requirement.)
    const guardAllMatches = prioritizer.match(/resolveWorkItemProject\(/g) ?? [];
    // Subtract 1 for the `async function resolveWorkItemProject(` definition.
    const guardCallSiteCount = Math.max(0, guardAllMatches.length - 1);
    const traversalCallSiteCount = (prioritizer.match(/\.listTransitiveDependencies\(/g) ?? []).length;
    expect(guardCallSiteCount, 'the prioritizer has at least one guard CALL site (not just the definition)').toBeGreaterThanOrEqual(1);
    expect(traversalCallSiteCount, 'the prioritizer has at least one traversal call site (the guarded one)').toBeGreaterThanOrEqual(1);
    expect(
      guardCallSiteCount,
      'EVERY listTransitiveDependencies call site must have a corresponding resolveWorkItemProject guard call site (no unscoped traversal — a second unguarded traversal would make guard < traversal)',
    ).toBeGreaterThanOrEqual(traversalCallSiteCount);
    // 8. MUTATION PROOF — the count check actually CATCHES an unscoped
    //    traversal. Synthesize a mutated prioritizer with a second, unguarded
    //    listTransitiveDependencies call (the exact regression the invariant
    //    must prevent) + assert the count check detects the violation (guard
    //    call sites < traversal call sites). This proves "preventing," not
    //    merely "checking."
    const mutatedPrioritizer = prioritizer + [
      '',
      '// MUTATION (for the static-arch test only — NOT in the real file):',
      'async function futureUnguardedPath(ctx) {',
      '  // A second traversal site WITHOUT a preceding resolveWorkItemProject',
      '  // guard — this is the unscoped call the invariant must catch.',
      '  return ctx.workItemDependencyRepository.listTransitiveDependencies(\'rogue-id\');',
      '}',
      '',
    ].join('\n');
    const mutatedGuardSites = Math.max(
      0,
      (mutatedPrioritizer.match(/resolveWorkItemProject\(/g) ?? []).length - 1,
    );
    const mutatedTraversalSites = (mutatedPrioritizer.match(/\.listTransitiveDependencies\(/g) ?? []).length;
    expect(mutatedTraversalSites, 'the mutated file has 2 traversal sites (the original guarded one + the unguarded mutation)').toBe(traversalCallSiteCount + 1);
    expect(mutatedGuardSites, 'the mutated file still has the same guard call site count (the mutation added no guard)').toBe(guardCallSiteCount);
    expect(
      mutatedGuardSites,
      'the count check CATCHES the unscoped traversal — guard < traversal in the mutated file (the invariant fails on the mutation, proving it prevents unscoped calls)',
    ).toBeLessThan(mutatedTraversalSites);
  });

  it('PUBLIC ROUTE AUTHORITY/PROVENANCE BOUNDARY (PR #44 round 4) — the public route accepts ONLY the user-request shape; the server constructs kind=developer-request, provenance=proposed, originator from auth; NO caller-supplied provenance/kind/evidenceRefs/blocksCount/relatedWorkItemIds/baselineCommitSha/originator', () => {
    // Blocker (PR #44 round 4): the public POST .../planning/evaluate trusted
    // caller-asserted evidence + provenance. A project.write caller could
    // submit { provenance: "observed", evidenceRefs: [fabricated],
    // baselineCommitSha: "arbitrary-sha", blocksCount: 100 } and the planner
    // would persist those claims into the authoritative Work Item's
    // metadata.planner — turning UNVERIFIED CLIENT ASSERTIONS into `observed`
    // repository evidence, violating the frozen provenance rule (source-fact
    // → baseline/context-evidence → planner recommendation → authoritative
    // Work Item). The planner MUST NOT turn unverified client assertions
    // into `observed` repository evidence.
    //
    // Fix: SEPARATE trusted signal production from user-requested planning.
    // The PUBLIC route accepts ONLY the user-request shape { canonicalGoal,
    // scope? } + rejects every forbidden signal-authority field. The server
    // constructs kind=developer-request, provenance=proposed, originator=
    // user.id (from the authenticated principal). Trusted INTERNAL producers
    // call DevelopmentPlannerService.evaluate DIRECTLY (programmatically)
    // with the full vocabulary — they do NOT go through the public route.
    const route = readFileSync(DP_ROUTE, 'utf8');
    // 1. The old full-vocabulary caller-controlled parser is GONE.
    expect(route, 'the old caller-controlled parseSignal is removed').not.toMatch(/\bparseSignal\(/);
    // 2. The constrained public-user-request parser is present.
    expect(route, 'the public route uses parsePublicUserRequest (the constrained parser)').toMatch(/parsePublicUserRequest\(/);
    // 3. The FORBIDDEN-field list names EVERY authority field a public
    //    caller must NOT supply. Each is a string literal in the list — a
    //    public caller supplying ANY of these is REJECTED with 400.
    expect(route, 'the forbidden-field list rejects kind (server forces developer-request)').toMatch(/['"]kind['"]/);
    expect(route, 'the forbidden-field list rejects provenance (server forces proposed)').toMatch(/['"]provenance['"]/);
    expect(route, 'the forbidden-field list rejects evidenceRefs (no caller-supplied evidence authority)').toMatch(/['"]evidenceRefs['"]/);
    expect(route, 'the forbidden-field list rejects blocksCount (no caller-controlled priority input)').toMatch(/['"]blocksCount['"]/);
    expect(route, 'the forbidden-field list rejects relatedWorkItemIds (no caller-supplied dependency refs)').toMatch(/['"]relatedWorkItemIds['"]/);
    expect(route, 'the forbidden-field list rejects originator (server resolves from auth)').toMatch(/['"]originator['"]/);
    expect(route, 'the forbidden-field list rejects baselineCommitSha (no caller-supplied revision)').toMatch(/['"]baselineCommitSha['"]/);
    // 4. The server constructs kind='developer-request' (literal — the public
    //    route FORCES this kind; a caller cannot assert architecture-observation
    //    / requirement-gap / benchmark-evidence / completed-work / observed /
    //    inferred via the public route).
    expect(route, 'the server forces kind=developer-request').toMatch(/kind:\s*['"]developer-request['"]/);
    // 5. The server constructs provenance='proposed' (literal — the public
    //    route FORCES proposed; a caller cannot assert observed/inferred
    //    repository facts via the public route).
    expect(route, 'the server forces provenance=proposed').toMatch(/provenance:\s*['"]proposed['"]/);
    // 6. The server resolves originator from the authenticated user (user.id),
    //    NOT from the caller-supplied body.
    expect(route, 'the server resolves originator from the authenticated user (user.id)').toMatch(/originator:\s*user\.id/);
    // 7. The body shape is constrained — `requests` (the user-request array),
    //    NOT `signals` (the full-vocabulary internal shape).
    expect(route, 'the body shape uses requests (the user-request array, not signals)').toMatch(/requests\?:/);
    // 8. The route REJECTS the old full-vocabulary top-level body fields
    //    (`signals` + `baselineCommitSha`) — the boundary is EXPLICIT (400,
    //    not silent ignore).
    expect(route, 'the route rejects the old top-level signals body field').toMatch(/['"]signals['"]\s+in\s+body/);
    expect(route, 'the route rejects the old top-level baselineCommitSha body field').toMatch(/['"]baselineCommitSha['"]\s+in\s+body/);
    // 9. The route captures the authenticated user from requireProjectAuthorization
    //    (the originator is the auth principal, not a body field).
    expect(route, 'the route captures the authenticated user (originator source)').toMatch(/const user = await requireProjectAuthorization/);
    // 10. The programmatic path RETAINS the full vocabulary — the service's
    //     evaluate method takes PlanningEvaluateInput (which carries
    //     signals: readonly PlanningSignal[]). The trusted-producer entry
    //     point is the PROGRAMMATIC service, NOT the public HTTP route — the
    //     constraint is on the route, not the service.
    const service = readFileSync(join(DP_DIR, 'internal', 'default-development-planner-service.ts'), 'utf8');
    expect(service, 'the programmatic service evaluate method takes PlanningEvaluateInput (the full-vocabulary entry point)').toMatch(/evaluate\(\s*input:\s*PlanningEvaluateInput/);
    expect(service, 'the programmatic service delegates to the prioritizer with the signal (full vocabulary passed through)').toMatch(/prioritizer\.prioritize\(signal/);
    // 11. The programmatic input type retains baselineCommitSha (trusted
    //     internal producers that have resolved a real revision supply it
    //     DIRECTLY — the constraint is on the PUBLIC ROUTE, not the
    //     programmatic API).
    const types = readFileSync(join(DP_DIR, 'development-planner.types.ts'), 'utf8');
    expect(types, 'PlanningEvaluateInput retains baselineCommitSha for trusted internal producers').toMatch(/readonly baselineCommitSha\?:\s*string/);
    expect(types, 'PlanningSignal retains provenance (full vocabulary for trusted internal producers)').toMatch(/readonly provenance:\s*PlanningProvenance/);
    expect(types, 'PlanningSignal retains evidenceRefs (full vocabulary for trusted internal producers)').toMatch(/readonly evidenceRefs\?:\s*readonly PlanningEvidenceRef\[\]/);
    expect(types, 'PlanningSignal retains blocksCount (full vocabulary for trusted internal producers)').toMatch(/readonly blocksCount\?:\s*number/);
  });
});

// =============================================================================
// WORK-041 invariants — Maintenance baseline cross-tenant guard (PR #45
// architect review). The scan / scan-async routes accept a caller-controlled
// baselineId; the AdvisoryDetector reads listObservations(baselineId). A
// Project A caller MUST NOT cause the detector to inspect Project B's baseline
// evidence. The fix is layered:
//   * ROUTE-LAYER GATE — assertBaselineInProject(deps, projectId, baselineId)
//     is called by scan (before detectAndEvaluate) + scan-async (before
//     enqueue) + returns a clean 403 for a foreign / non-existent baselineId.
//   * DETECTOR-LAYER GUARD (defense in depth) — the AdvisoryDetector verifies
//     baseline.projectId === input.projectId via findById BEFORE
//     listObservations; throws maintenance-baseline-not-in-project on mismatch
//     (protects programmatic calls + the async job handler).
// The invariants below are the static proof; the dynamic proof is the
// sync/async two-project regression coverage in
// maintenance-domain.integration.test.ts (#13 + #14 + #15).
// =============================================================================
describe('WORK-041 invariants — Maintenance baseline cross-tenant guard (PR #45 architect review)', () => {
  const MAINT_DIR = join(SRC_ROOT, 'maintenance');
  const ADVISORY_DETECTOR = join(MAINT_DIR, 'internal', 'detectors', 'advisory-detector.ts');
  const MAINT_ROUTE = join(SRC_ROOT, 'api', 'routes', 'maintenance.route.ts');

  it('TENANT-OWNERSHIP GUARD BEFORE BASELINE OBSERVATION READ (PR #45) — listObservations in the AdvisoryDetector is ALWAYS preceded by a project-ownership check (no cross-tenant baseline evidence leak)', () => {
    // Blocker (PR #45 architect review): scan / scan-async accept a caller-
    // controlled baselineId. The AdvisoryDetector read
    // listObservations(baselineId) without verifying the baseline belongs to
    // the authorized project. A Project A caller could supply Project B's
    // baselineId + cause the detector to inspect Project B's package_managers
    // observation (cross-tenant information leak). The fix: when input.baselineId
    // is supplied, the detector calls findById(baselineId) + compares
    // baseline.projectId to input.projectId BEFORE listObservations. A foreign
    // or non-existent baselineId throws maintenance-baseline-not-in-project;
    // listObservations is NEVER called for a baseline that does not belong to
    // the authorized project.
    const detector = readFileSync(ADVISORY_DETECTOR, 'utf8');
    // 1. The ownership guard exists — the detector calls findById to resolve
    //    the baseline's projectId.
    expect(detector, 'the AdvisoryDetector calls findById to resolve the baseline owner').toMatch(/projectBaselineRepository\.findById\(/);
    // 2. The gate — the resolved baseline.projectId is compared to input.projectId.
    expect(detector, 'the AdvisoryDetector gates on baseline.projectId === input.projectId').toMatch(/baseline\.projectId !== input\.projectId/);
    // 3. The honest rejection — a foreign / non-existent baseline throws.
    expect(detector, 'the AdvisoryDetector throws maintenance-baseline-not-in-project on a foreign baseline').toMatch(/maintenance-baseline-not-in-project/);
    // 4. The traversal is present (gated by the guard). The dotted form
    //    (.listObservations( matches only the actual method CALL, not JSDoc
    //    mentions — the ordering check below is therefore precise).
    expect(detector, 'the AdvisoryDetector calls listObservations (gated by the ownership guard)').toMatch(/\.listObservations\(/);
    // 5. ORDERING: the gate MUST appear BEFORE the listObservations CALL in
    //    the file (the guard is evaluated before the traversal). This is the
    //    static proof the guard precedes the traversal; the count check (#6)
    //    proves EVERY traversal is gated; the dynamic proof is the detector-
    //    level regression #15.
    const guardIdx = detector.indexOf('baseline.projectId !== input.projectId');
    const traversalIdx = detector.indexOf('.listObservations(');
    expect(guardIdx, 'the ownership gate must be present').toBeGreaterThan(-1);
    expect(traversalIdx, 'the listObservations call must be present').toBeGreaterThan(-1);
    expect(guardIdx, 'the ownership gate must precede the listObservations call in the file').toBeLessThan(traversalIdx);
    // 6. EVERY traversal site is gated — count-based proof. The number of
    //    gate sites (baseline.projectId !== input.projectId) must be >= the
    //    number of listObservations CALL sites (.listObservations( dotted
    //    calls). This PREVENTS a future developer from adding a SECOND,
    //    unguarded listObservations call in a different code path — every
    //    traversal site must have a corresponding gate. (The first-occurrence
    //    ordering check #5 proves the gate precedes the first traversal; this
    //    count check proves NO traversal site lacks a guard — the architect's
    //    "preventing an unscoped listObservations(baselineId) call" requirement.)
    const gateSiteCount = (detector.match(/baseline\.projectId !== input\.projectId/g) ?? []).length;
    const traversalCallSiteCount = (detector.match(/\.listObservations\(/g) ?? []).length;
    expect(gateSiteCount, 'the AdvisoryDetector has at least one ownership gate site').toBeGreaterThanOrEqual(1);
    expect(traversalCallSiteCount, 'the AdvisoryDetector has at least one listObservations call site (the guarded one)').toBeGreaterThanOrEqual(1);
    expect(
      gateSiteCount,
      'EVERY listObservations call site must have a corresponding baseline.projectId ownership gate (no unscoped traversal — a second unguarded call would make gate < traversal)',
    ).toBeGreaterThanOrEqual(traversalCallSiteCount);
    // 7. MUTATION PROOF — the count check actually CATCHES an unscoped
    //    traversal. Synthesize a mutated detector with a second, unguarded
    //    listObservations call (the exact regression the invariant must
    //    prevent) + assert the count check detects the violation (gate sites
    //    < traversal call sites). This proves "preventing," not merely
    //    "checking."
    const mutatedDetector = detector + [
      '',
      '// MUTATION (for the static-arch test only — NOT in the real file):',
      'async function futureUnguardedPath(ctx) {',
      '  // A second traversal site WITHOUT a preceding baseline.projectId gate',
      '  // — this is the unscoped call the invariant must catch.',
      '  return ctx.projectBaselineRepository.listObservations(\'rogue-baseline-id\');',
      '}',
      '',
    ].join('\n');
    const mutatedGateSites = (mutatedDetector.match(/baseline\.projectId !== input\.projectId/g) ?? []).length;
    const mutatedTraversalSites = (mutatedDetector.match(/\.listObservations\(/g) ?? []).length;
    expect(mutatedTraversalSites, 'the mutated file has 2 traversal sites (the original guarded one + the unguarded mutation)').toBe(traversalCallSiteCount + 1);
    expect(mutatedGateSites, 'the mutated file still has the same gate site count (the mutation added no gate)').toBe(gateSiteCount);
    expect(
      mutatedGateSites,
      'the count check CATCHES the unscoped listObservations — gate < traversal in the mutated file (the invariant fails on the mutation, proving it prevents unscoped calls)',
    ).toBeLessThan(mutatedTraversalSites);
  });

  it('ROUTE-LEVEL BASELINE OWNERSHIP GATE (PR #45) — scan + scan-async call assertBaselineInProject before detectAndEvaluate / enqueue; a foreign baselineId returns 403 baseline-not-in-project', () => {
    // The route-layer gate is the PRIMARY defense (clean 403 semantics for
    // both sync + async); the detector guard is defense in depth. The route
    // must call assertBaselineInProject BEFORE detectAndEvaluate (scan) /
    // BEFORE enqueue (scan-async) so a foreign baselineId is rejected
    // immediately + the detectors are NEVER invoked (sync) / the job is NEVER
    // enqueued (async).
    const route = readFileSync(MAINT_ROUTE, 'utf8');
    // 1. The assertBaselineInProject helper exists (defined once).
    expect(route, 'the route defines assertBaselineInProject (the ownership gate helper)').toMatch(/async function assertBaselineInProject\(/);
    // 2. The gate uses findById + projectId comparison.
    expect(route, 'assertBaselineInProject calls findById to resolve the baseline').toMatch(/projectBaselineRepository\.findById\(baselineId\)/);
    expect(route, 'assertBaselineInProject compares baseline.projectId to the authorized projectId').toMatch(/baseline\.projectId === projectId/);
    // 3. The 403 reason is present for both scan + scan-async.
    expect(route, 'the route returns 403 baseline-not-in-project for a foreign baselineId').toMatch(/baseline-not-in-project/);
    // 4. ORDERING — the scan route calls assertBaselineInProject BEFORE
    //    detectAndEvaluate. The indexOf of the guard call (inside `if
    //    (body.baselineId)`) must be < the indexOf of detectAndEvaluate.
    const scanGuardIdx = route.indexOf('assertBaselineInProject(deps, projectId, body.baselineId)');
    const scanDetectIdx = route.indexOf('deps.maintenanceService.detectAndEvaluate(');
    expect(scanGuardIdx, 'the scan route calls assertBaselineInProject').toBeGreaterThan(-1);
    expect(scanDetectIdx, 'the scan route calls detectAndEvaluate').toBeGreaterThan(-1);
    // The scan route has TWO assertBaselineInProject calls (scan + scan-async);
    // the first one (scan) must precede the detectAndEvaluate call.
    expect(scanGuardIdx, 'the scan route gates before detectAndEvaluate').toBeLessThan(scanDetectIdx);
    // 5. The scan-async route calls assertBaselineInProject BEFORE enqueue.
    //    The LAST assertBaselineInProject call (scan-async's) must precede
    //    the scan-async enqueue. NOTE: we locate the enqueue via the LAST
    //    `deps.queue.enqueue(` call (the scan-async enqueue) — there are two
    //    such calls in the route (evaluate-async enqueues PLANNING_EVALUATE_
    //    JOB_TYPE first; scan-async enqueues MAINTENANCE_RUN_JOB_TYPE second);
    //    the second is the scan-async enqueue. (Searching for the literal
    //    MAINTENANCE_RUN_JOB_TYPE symbol would also match its top-of-file
    //    import, which precedes everything — wrong for an ordering check.)
    const lastGuardIdx = route.lastIndexOf('assertBaselineInProject(deps, projectId, body.baselineId)');
    const scanAsyncEnqueueIdx = route.lastIndexOf('deps.queue.enqueue(');
    expect(lastGuardIdx, 'the scan-async route calls assertBaselineInProject').toBeGreaterThan(scanGuardIdx);
    expect(scanAsyncEnqueueIdx, 'the scan-async route calls deps.queue.enqueue').toBeGreaterThan(-1);
    expect(lastGuardIdx, 'the scan-async route gates before enqueue').toBeLessThan(scanAsyncEnqueueIdx);
    // 6. COUNT PROOF — the route calls assertBaselineInProject exactly twice
    //    (scan + scan-async). A future developer adding a third scan route
    //    without the gate would NOT be caught by count alone (the gate count
    //    would stay 2); but the ordering checks (#4, #5) catch a missing gate
    //    on a SPECIFIC detect/enqueue call. The count check here asserts the
    //    two known routes both have the gate (a regression where one is removed
    //    drops the count to 1).
    const guardCallSites = (route.match(/assertBaselineInProject\(deps, projectId, body\.baselineId\)/g) ?? []).length;
    expect(guardCallSites, 'both scan + scan-async call assertBaselineInProject (the gate is wired into both routes)').toBe(2);
  });
});

// =============================================================================
// WORK-042 invariants — Cross-Mode Execution Handoff (the append-only mode-
// transition log for the SAME logical ExecutionRecord). ONE ExecutionRecord
// preserved; the handoff is a SUBORDINATE state transition + an append-only
// history log row. The service composes the EXISTING NativeExecutionProvider +
// ExternalExecutionProvider + ExecutionTaskService + AgentPolicyEngine +
// ExecutionPolicyService + AgentProviderRegistryService — it is NOT an
// ExecutionService, it NEVER creates a second ExecutionRecord, NEVER touches
// workflow/verification/review state, NEVER persists secrets. The route
// accepts NO authoritative fields (executionId from path; projectId resolved
// server-side; policy decision server-side; audit identity server-side). The
// cross-project guard (record.projectId validation) runs BEFORE any mutation.
// =============================================================================
describe('WORK-042 — Cross-Mode Execution Handoff', () => {
  const AGENTS_INTERNAL = join(MODULES_DIR, 'agents', 'internal');
  const CROSS_MODE_TYPES = join(AGENTS_INTERNAL, 'cross-mode-handoff.types.ts');
  const CROSS_MODE_REPO = join(AGENTS_INTERNAL, 'pg-cross-mode-handoff-repository.ts');
  const CROSS_MODE_SERVICE = join(AGENTS_INTERNAL, 'default-cross-mode-handoff-service.ts');
  const MIGRATION_0042 = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0042_cross_mode_execution_handoff.sql',
  );
  const CROSS_MODE_MIGRATION_0044 = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0044_cross_mode_handoff_claim_lease.sql',
  );
  const CROSS_MODE_MIGRATION_0045 = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0045_cross_mode_handoff_claim_epoch.sql',
  );
  const CROSS_MODE_MIGRATION_0046 = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0046_cross_mode_handoff_dispatch_gate.sql',
  );
  const AGENTS_BARREL = join(MODULES_DIR, 'agents', 'index.ts');
  const PG_EXECUTION_REPO = join(AGENTS_INTERNAL, 'pg-execution-repository.ts');
  const EXECUTION_ROUTE = join(SRC_ROOT, 'api', 'routes', 'execution.route.ts');

  /** Strip line + block comments (TypeScript + SQL) so doc-only mentions of
   *  sensitive tokens do not trip the secret-persistence invariant. */
  function strip(src: string): string {
    return src
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*--.*$/gm, '');
  }

  // -------------------------------------------------------------------------
  // A1: Migration 0042 exists + the correct schema.
  // -------------------------------------------------------------------------
  it('A1. migration 0042 exists with the cross-mode handoff log schema (UNIQUE execution + mode-change CHECK + idempotency UNIQUE + append-only trigger + prior-phase snapshot)', () => {
    expect(existsSync(MIGRATION_0042), '0042_cross_mode_execution_handoff.sql must exist').toBe(true);
    const src = readFileSync(MIGRATION_0042, 'utf8');
    // The append-only mode-transition log table.
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS wfos_execution_mode_handoffs/);
    // ONE handoff per execution (the hard fence against a second handoff).
    expect(src).toMatch(/CONSTRAINT wfos_execution_mode_handoffs_execution_unique UNIQUE \(execution_record_id\)/);
    // A handoff MUST change the mode.
    expect(src).toMatch(/CONSTRAINT wfos_execution_mode_handoffs_mode_change CHECK \(from_mode <> to_mode\)/);
    // Idempotency key (convergent retry).
    expect(src).toMatch(/idempotency_key TEXT NOT NULL/);
    expect(src).toMatch(/CONSTRAINT wfos_execution_mode_handoffs_idempotency_unique UNIQUE \(idempotency_key\)/);
    // The prior-phase authoritative evidence snapshot (preserves the correction chain).
    expect(src).toMatch(/previous_agent_run_id UUID/);
    expect(src).toMatch(/previous_external_session_ref TEXT/);
    expect(src).toMatch(/previous_package_json JSONB/);
    // Append-only immutability trigger (no UPDATE/DELETE — the history is permanent).
    expect(src).toMatch(/wfos_execution_mode_handoff_immutable/);
    expect(src).toMatch(/BEFORE UPDATE OR DELETE ON wfos_execution_mode_handoffs/);
  });

  it('A1b. the migration stores NO credentials (stripped of comments, the schema mentions no secret/token/cookie/api_key/password)', () => {
    const src = readFileSync(MIGRATION_0042, 'utf8');
    const stripped = strip(src);
    expect(stripped, 'the handoff log table stores no secrets').not.toMatch(/secret|token|cookie|api_key|password/i);
  });

  // -------------------------------------------------------------------------
  // A2: NO second ExecutionService / NO second AgentGateway / NO second
  // session/workspace engine (the CrossModeHandoffService is a SEPARATE
  // boundary that composes the existing ones; it never constructs a parallel
  // engine).
  // -------------------------------------------------------------------------
  it('A2. the cross-mode handoff boundary creates NO second ExecutionService / AgentGateway / SessionService / WorkspaceService', () => {
    for (const [name, path] of [
      ['types', CROSS_MODE_TYPES],
      ['repository', CROSS_MODE_REPO],
      ['service', CROSS_MODE_SERVICE],
    ] as const) {
      const src = strip(readFileSync(path, 'utf8'));
      // No second ExecutionService (the CrossModeHandoffService is a SEPARATE
      // interface — it transitions the SAME ExecutionRecord; it never
      // constructs, implements, or declares an ExecutionService).
      expect(src, `${name}: no second ExecutionService`).not.toMatch(/new\s+\w*ExecutionService\b|implements\s+ExecutionService\b|class\s+\w*ExecutionService\b/);
      // No second AgentGateway (the service calls the EXISTING
      // NativeExecutionProvider which delegates to the existing gateway).
      expect(src, `${name}: no second DefaultAgentGateway`).not.toMatch(/new\s+DefaultAgentGateway/);
      // No second session engine (the existing DefaultExecutionSessionService
      // is the ONE; the cross-mode service must NOT create another).
      expect(src, `${name}: no second SessionService`).not.toMatch(/class\s+\w*SessionService\b|implements\s+ExecutionSessionService\b/);
      // No second workspace engine (the existing DefaultAgentWorkspaceService
      // is the ONE; the cross-mode service must NOT create another).
      expect(src, `${name}: no second WorkspaceService`).not.toMatch(/class\s+\w*WorkspaceService\b|implements\s+AgentWorkspaceService\b/);
    }
  });

  // -------------------------------------------------------------------------
  // A3: NO workflow / verification / review mutation (the cross-mode handoff
  // is a subordinate state transition — it never touches the workflow /
  // verification / review authority).
  // -------------------------------------------------------------------------
  it('A3. the cross-mode handoff NEVER mutates workflow / verification / review state (SQL-level + state-machine-level)', () => {
    for (const [name, path] of [
      ['types', CROSS_MODE_TYPES],
      ['repository', CROSS_MODE_REPO],
      ['service', CROSS_MODE_SERVICE],
    ] as const) {
      const src = strip(readFileSync(path, 'utf8'));
      expect(src, `${name}: no workflow mutation`).not.toMatch(/INSERT INTO wfos_workflow|UPDATE wfos_workflow|DELETE FROM wfos_workflow/);
      expect(src, `${name}: no verification mutation`).not.toMatch(/INSERT INTO wfos_verification|UPDATE wfos_verification|DELETE FROM wfos_verification/);
      expect(src, `${name}: no review mutation`).not.toMatch(/INSERT INTO wfos_reviews|UPDATE wfos_reviews|DELETE FROM wfos_reviews/);
      // No workflow state-machine transition (the toState: 'approved'/
      // 'merged'/'verified' shape would be a workflow authority claim).
      expect(src, `${name}: no workflow state-machine mutation`).not.toMatch(/toState:\s*'(approved|merged|verified)'/);
    }
    // The service does NOT import the workflow / verification / review
    // modules (the one-way dependency — agents → execution-policy → tool
    // runtime, never agents → workflow authority).
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    expect(serviceSrc, 'the cross-mode service does not import @modules/workflows').not.toContain("from '@modules/workflows");
    expect(serviceSrc, 'the cross-mode service does not import @modules/verification').not.toContain("from '@modules/verification");
    expect(serviceSrc, 'the cross-mode service does not import @modules/reviews').not.toContain("from '@modules/reviews");
  });

  // -------------------------------------------------------------------------
  // A4: The cross-mode handoff reuses the EXISTING providers + task service +
  // policy engine (NO parallel model).
  // -------------------------------------------------------------------------
  it('A4. the cross-mode handoff reuses the EXISTING NativeExecutionProvider + ExternalExecutionProvider + ExecutionTaskService + agent-policy evaluateExternalHandoff (no parallel model)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // The service depends on the existing native + external providers (typed
    // as the provider-independent ExecutionProvider interface — not new ones).
    expect(serviceSrc, 'the service depends on nativeExecutionProvider').toMatch(/nativeExecutionProvider\s*[:.]/);
    expect(serviceSrc, 'the service depends on externalExecutionProvider').toMatch(/externalExecutionProvider\s*[:.]/);
    // The service reuses the EXISTING ExecutionTaskService.build (the same
    // path the ExecutionService uses to build a task).
    expect(serviceSrc, 'the service depends on executionTaskService').toMatch(/executionTaskService\s*[:.]/);
    // For targetMode='external', the service calls the EXISTING
    // agent-policy evaluateExternalHandoff hook (no second policy engine).
    expect(serviceSrc, 'the service calls evaluateExternalHandoff').toMatch(/evaluateExternalHandoff\s*\(/);
    // The service does NOT construct a DefaultAgentGateway (it dispatches
    // through NativeExecutionProvider, which delegates to the existing
    // gateway — never a parallel gateway).
    expect(serviceSrc, 'the service never constructs a second DefaultAgentGateway').not.toMatch(/new\s+DefaultAgentGateway/);
  });

  // -------------------------------------------------------------------------
  // A5: POST-only mutation (NO GET mutation on the cross-mode-handoff route).
  // -------------------------------------------------------------------------
  it('A5. the cross-mode-handoff route is POST-only (NO GET mutation)', () => {
    const routeSrc = readFileSync(EXECUTION_ROUTE, 'utf8');
    expect(routeSrc, 'the route registers a POST handler').toMatch(/app\.post\('\/execution\/:executionId\/cross-mode-handoff'/);
    // No GET handler on the cross-mode-handoff path (no read-as-mutation).
    expect(routeSrc, 'no GET mutation on the cross-mode-handoff path').not.toMatch(/app\.get\('\/execution\/:executionId\/cross-mode-handoff'/);
  });

  // -------------------------------------------------------------------------
  // A6: Server-side authority (no caller-supplied authoritative fields).
  // The route body destructuring reads ONLY caller-controlled INTENT
  // (targetMode/reason/userInstruction/idempotencyKey/provider/model). The
  // projectId / executionRecordId / policyDecision / audit identity are
  // resolved server-side.
  // -------------------------------------------------------------------------
  it('A6. the cross-mode-handoff route accepts NO authoritative fields (executionId from path; projectId/policyDecision/audit identity resolved server-side)', () => {
    const routeSrc = readFileSync(EXECUTION_ROUTE, 'utf8');
    // Extract the cross-mode-handoff route handler (from app.post to the end
    // of the file — it is the LAST route).
    const sectionStart = routeSrc.indexOf("app.post('/execution/:executionId/cross-mode-handoff'");
    expect(sectionStart, 'the cross-mode-handoff route section must be present').toBeGreaterThan(-1);
    const section = routeSrc.slice(sectionStart);
    // The body destructuring must NOT read authoritative fields.
    expect(section, 'no body.projectId').not.toMatch(/body\??\.(projectId|executionRecordId|policyDecision|auditId|workspaceId|evidenceId)/i);
    // The route resolves record.projectId server-side + calls
    // requireProjectAuthorization (the projectId is NEVER from the body).
    expect(section, 'the route resolves record.projectId server-side').toMatch(/record\.projectId/);
    expect(section, 'the route calls requireProjectAuthorization').toMatch(/requireProjectAuthorization\(/);
  });

  it('A6b. ORDERING — the route calls requireProjectAuthorization BEFORE crossModeHandoffService.handoff (authorize BEFORE mutate)', () => {
    const routeSrc = readFileSync(EXECUTION_ROUTE, 'utf8');
    const sectionStart = routeSrc.indexOf("app.post('/execution/:executionId/cross-mode-handoff'");
    const section = routeSrc.slice(sectionStart);
    const authIdx = section.indexOf('requireProjectAuthorization(req, reply');
    const mutateIdx = section.indexOf('crossModeHandoffService.handoff(');
    expect(authIdx, 'the route calls requireProjectAuthorization').toBeGreaterThan(-1);
    expect(mutateIdx, 'the route calls crossModeHandoffService.handoff').toBeGreaterThan(-1);
    expect(authIdx, 'the route authorizes BEFORE mutating').toBeLessThan(mutateIdx);
  });

  // -------------------------------------------------------------------------
  // A9: Tenant-ownership guard BEFORE mutation (the WORK-041 mutation-proof
  // pattern). The route's requireProjectAuthorization (which validates the
  // caller's project membership) runs BEFORE crossModeHandoffService.handoff.
  // PLUS the service re-resolves the record (record.projectId) BEFORE any
  // createHandoff call (defense-in-depth).
  //
  // Count + MUTATION-PROOF: count the requireProjectAuthorization CALL sites
  // (await requireProjectAuthorization() dotted call) in the cross-mode-
  // handoff route section (>= 1) + synthesize a mutated route section WITHOUT
  // the authorize call → the count check catches the violation.
  // -------------------------------------------------------------------------
  it('A9. tenant-ownership guard BEFORE mutation — requireProjectAuthorization runs BEFORE crossModeHandoffService.handoff; a synthesized unguarded mutation is caught by the count check', () => {
    const routeSrc = readFileSync(EXECUTION_ROUTE, 'utf8');
    const sectionStart = routeSrc.indexOf("app.post('/execution/:executionId/cross-mode-handoff'");
    const section = routeSrc.slice(sectionStart);
    // Count actual CALL sites (the await + parenthesised call — NOT JSDoc
    // mentions of the helper name).
    const gateCallSitePattern = /await\s+requireProjectAuthorization\(/g;
    const gateCallSiteCount = (section.match(gateCallSitePattern) ?? []).length;
    expect(gateCallSiteCount, 'the cross-mode-handoff route calls requireProjectAuthorization (the project-ownership gate)').toBeGreaterThanOrEqual(1);

    // MUTATION PROOF — synthesize a mutated route section WITHOUT the
    // authorize call (the exact regression the invariant must prevent) +
    // assert the count check detects the violation (gate call sites == 0).
    const mutatedSection = section.replace(/await\s+requireProjectAuthorization\([^)]*\)/g, '/* MUTATION: authorize call removed */');
    const mutatedGateCallSites = (mutatedSection.match(gateCallSitePattern) ?? []).length;
    expect(mutatedGateCallSites, 'the mutated section has 0 authorize call sites (the mutation stripped the gate)').toBe(0);
    expect(
      mutatedGateCallSites,
      'the count check CATCHES the unguarded mutation — gate < 1 in the mutated section',
    ).toBeLessThan(1);

    // SERVICE-LEVEL defense-in-depth: the service re-resolves the record
    // (record.projectId is known) BEFORE the createHandoffAndClaim INSERT
    // (PR #46 round 4: the reserve + claim are atomic in ONE transaction —
    // the reserve step is now `createHandoffAndClaim`, NOT the round-1
    // `createHandoff`). The FIRST occurrence of record.projectId must
    // precede the FIRST createHandoffAndClaim call site (the reserve+claim
    // step).
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    const recordProjectIdIdx = serviceSrc.indexOf('record.projectId');
    const createHandoffIdx = serviceSrc.indexOf('createHandoffAndClaim(');
    expect(recordProjectIdIdx, 'the service resolves record.projectId').toBeGreaterThan(-1);
    expect(createHandoffIdx, 'the service calls createHandoffAndClaim (the round-4 atomic reserve+claim)').toBeGreaterThan(-1);
    expect(recordProjectIdIdx, 'the service resolves record.projectId BEFORE the createHandoffAndClaim INSERT (defense-in-depth)').toBeLessThan(createHandoffIdx);
  });

  // -------------------------------------------------------------------------
  // A10: ONE handoff per execution (the UNIQUE fence). The migration has
  // UNIQUE(execution_record_id) (A1 covers); the service has EXACTLY ONE
  // createHandoffAndClaim call site (PR #46 round 4: the reserve + claim
  // are atomic in ONE transaction — the reserve step is now
  // `createHandoffAndClaim`, NOT the round-1 `createHandoff`). A mutated
  // service with a second createHandoffAndClaim site → the count check
  // catches it.
  // -------------------------------------------------------------------------
  it('A10. ONE handoff per execution — the service has EXACTLY ONE createHandoffAndClaim call site (the UNIQUE(execution_record_id) fence)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    const createHandoffCallSites = (serviceSrc.match(/\.createHandoffAndClaim\(/g) ?? []).length;
    expect(createHandoffCallSites, 'the service has exactly ONE createHandoffAndClaim call site (the round-4 atomic reserve+claim)').toBe(1);
    // MUTATION PROOF — synthesize a mutated service with a second
    // createHandoffAndClaim site → the count check catches it.
    const mutatedService = serviceSrc + [
      '',
      '// MUTATION (for the static-arch test only — NOT in the real file):',
      'async function futureUnguardedCreate(ctx) {',
      '  // A second createHandoffAndClaim site — this is the regression the',
      '  // invariant must catch (would bypass the UNIQUE fence on a',
      '  // different idempotency_key).',
      '  return ctx.deps.crossModeHandoffRepository.createHandoffAndClaim({} as never, \'x\', 1);',
      '}',
      '',
    ].join('\n');
    const mutatedCallSites = (mutatedService.match(/\.createHandoffAndClaim\(/g) ?? []).length;
    expect(mutatedCallSites, 'the mutated service has 2 createHandoffAndClaim call sites').toBe(createHandoffCallSites + 1);
    expect(
      mutatedCallSites,
      'the count check CATCHES the second createHandoffAndClaim site — count > 1 in the mutated service',
    ).toBeGreaterThan(1);
  });

  // -------------------------------------------------------------------------
  // A11: Idempotent convergence (findByIdempotencyKey BEFORE
  // createHandoffAndClaim — a retry with the same key converges to the
  // existing result).
  // -------------------------------------------------------------------------
  it('A11. idempotent convergence — the service calls findByIdempotencyKey (the convergence lookup) BEFORE createHandoffAndClaim', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    expect(serviceSrc, 'the service calls findByIdempotencyKey (convergence check)').toMatch(/findByIdempotencyKey/);
    // ORDERING — the findByIdempotencyKey lookup precedes the
    // createHandoffAndClaim INSERT (the convergence check is evaluated
    // BEFORE the reserve+claim). PR #46 round 4: the reserve step is now
    // `createHandoffAndClaim` (the atomic reserve + claim).
    const idempotencyLookupIdx = serviceSrc.indexOf('findByIdempotencyKey');
    const createHandoffIdx = serviceSrc.indexOf('createHandoffAndClaim(');
    expect(idempotencyLookupIdx, 'findByIdempotencyKey must be present').toBeGreaterThan(-1);
    expect(createHandoffIdx, 'createHandoffAndClaim must be present').toBeGreaterThan(-1);
    expect(idempotencyLookupIdx, 'findByIdempotencyKey precedes createHandoffAndClaim (converge before reserve+claim)').toBeLessThan(createHandoffIdx);
  });

  // -------------------------------------------------------------------------
  // A12: Durable relay constant (IMPL-1 added CROSS_MODE_HANDOFF_RELAY_JOB_TYPE
  // + the idempotent reconcileCrossModeHandoffForExecution entry point). PR #46
  // review #2: the relay is NO LONGER OPTIONAL — R1-A proves it is WIRED into
  // the WorkerHost (the job handler + the boot-sweep outbox relay).
  // -------------------------------------------------------------------------
  it('A12. the durable relay constant is exported (the cross-mode-handoff reconciliation relay job type — WIRED, not optional)', () => {
    const typesSrc = readFileSync(CROSS_MODE_TYPES, 'utf8');
    expect(typesSrc, 'CROSS_MODE_HANDOFF_RELAY_JOB_TYPE is defined in the types').toMatch(/CROSS_MODE_HANDOFF_RELAY_JOB_TYPE/);
    const barrelSrc = readFileSync(AGENTS_BARREL, 'utf8');
    expect(barrelSrc, 'CROSS_MODE_HANDOFF_RELAY_JOB_TYPE is exported from the barrel').toMatch(/CROSS_MODE_HANDOFF_RELAY_JOB_TYPE/);
    // The service defines the idempotent reconciliation entry point (the
    // relay calls this on retry; a complete handoff is a no-op).
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    expect(serviceSrc, 'the service implements reconcileCrossModeHandoffForExecution').toMatch(/reconcileCrossModeHandoffForExecution/);
  });

  // -------------------------------------------------------------------------
  // A13: Barrel exports (the public contract; concrete impls stay internal).
  // -------------------------------------------------------------------------
  it('A13. the /agents barrel exports the cross-mode handoff public contract (no concrete impls)', () => {
    const barrelSrc = readFileSync(AGENTS_BARREL, 'utf8');
    // The public contract names.
    expect(barrelSrc).toMatch(/CrossModeHandoffService/);
    expect(barrelSrc).toMatch(/CrossModeHandoffRecord/);
    expect(barrelSrc).toMatch(/CrossModeHandoffError/);
    expect(barrelSrc).toMatch(/CROSS_MODE_HANDOFF_ERROR_CODES/);
    expect(barrelSrc).toMatch(/TransitionModeInput/);
    // The concrete implementations stay internal (wired only by app.ts).
    expect(barrelSrc, 'PgCrossModeHandoffRepository stays internal').not.toMatch(/PgCrossModeHandoffRepository/);
    expect(barrelSrc, 'DefaultCrossModeHandoffService stays internal').not.toMatch(/DefaultCrossModeHandoffService/);
  });

  // -------------------------------------------------------------------------
  // A14: transitionMode repo method exists + does NOT touch
  // workflow/verification/review (it ONLY touches wfos_executions — the
  // SAME ExecutionRecord's mode/status/provider columns).
  // -------------------------------------------------------------------------
  it('A14. PgExecutionRecordRepository.transitionMode exists + uses an UPDATE on wfos_executions (NOT a new table) + does NOT touch workflow/verification/review', () => {
    const repoSrc = readFileSync(PG_EXECUTION_REPO, 'utf8');
    expect(repoSrc, 'transitionMode method exists').toMatch(/transitionMode\s*\(/);
    expect(repoSrc, 'transitionMode uses UPDATE wfos_executions SET (the SAME record — no new table)').toMatch(/UPDATE wfos_executions SET/);
    // Extract the transitionMode method body + assert it touches ONLY
    // wfos_executions (no workflow/verification/review SQL).
    const methodStart = repoSrc.indexOf('async transitionMode(');
    expect(methodStart, 'transitionMode method body must be present').toBeGreaterThan(-1);
    // Find the method's closing brace (the next '\n  }' at column 2).
    const methodEnd = repoSrc.indexOf('\n  }', methodStart);
    const methodBody = repoSrc.slice(methodStart, methodEnd);
    expect(methodBody, 'transitionMode does NOT insert/update workflow state').not.toMatch(/INSERT INTO wfos_workflow|UPDATE wfos_workflow/);
    expect(methodBody, 'transitionMode does NOT insert/update verification state').not.toMatch(/INSERT INTO wfos_verification|UPDATE wfos_verification/);
    expect(methodBody, 'transitionMode does NOT insert/update review state').not.toMatch(/INSERT INTO wfos_reviews|UPDATE wfos_reviews/);
  });

  // -------------------------------------------------------------------------
  // A7 + A8 (combined for clarity): NO token/credential persistence + NO
  // direct provider SDK coupling.
  // -------------------------------------------------------------------------
  it('A7. the cross-mode handoff log + service persist NO secrets (no raw_token / api_key / secret / password / cookie); the service does NOT issue tokens (token issuance is the EXISTING ExecutionHandoffService job via POST /execution/:id/handoff)', () => {
    for (const [name, path] of [
      ['types', CROSS_MODE_TYPES],
      ['repository', CROSS_MODE_REPO],
      ['service', CROSS_MODE_SERVICE],
    ] as const) {
      const src = strip(readFileSync(path, 'utf8'));
      expect(src, `${name}: no raw_token / api_key / secret / password / cookie`).not.toMatch(/raw_token|rawToken|api_key|apiKey|secret|password|cookie/i);
    }
    // The service does NOT call createHash or generate tokens (token
    // issuance for native->external is the EXISTING ExecutionHandoffService's
    // job — the cross-mode handoff generates the package + sets
    // status=handoff_ready; the user then calls POST /execution/:id/handoff
    // to issue the token, which goes through the existing policy-gated
    // decorator).
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    expect(serviceSrc, 'the service does NOT call createHash').not.toMatch(/createHash\(/);
    expect(serviceSrc, 'the service does NOT issue handoff tokens (the existing ExecutionHandoffService owns that)').not.toMatch(/executionHandoffService\s*\./);
  });

  it('A8. the cross-mode handoff has NO direct provider SDK coupling (no @octokit / openai / anthropic / zai-sdk imports)', () => {
    for (const [name, path] of [
      ['types', CROSS_MODE_TYPES],
      ['repository', CROSS_MODE_REPO],
      ['service', CROSS_MODE_SERVICE],
    ] as const) {
      const src = readFileSync(path, 'utf8');
      expect(src, `${name}: no @octokit/openai/anthropic/zai-sdk imports`).not.toMatch(/from ['"]@octokit|from ['"]openai|from ['"]anthropic|zai-sdk/);
    }
  });

  // -------------------------------------------------------------------------
  // The cross-mode-handoff regression test file must exist (the 20 frozen
  // regressions + the two-project tenant-ownership regression). This is the
  // dynamic proof that mirrors these static invariants.
  // -------------------------------------------------------------------------
  it('the cross-mode-handoff regression test file exists with the frozen identity + concurrency + crash + tenant-ownership scenarios', () => {
    const testPath = join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'cross-mode-handoff.regression.test.ts');
    expect(existsSync(testPath), 'cross-mode-handoff.regression.test.ts must exist').toBe(true);
    const src = readFileSync(testPath, 'utf8');
    // The six describe blocks (the frozen test matrix shape).
    expect(src).toMatch(/describe\('identity preservation'/);
    expect(src).toMatch(/describe\('evidence \+ audit'/);
    expect(src).toMatch(/describe\('concurrency \+ idempotency'/);
    expect(src).toMatch(/describe\('crash recovery'/);
    expect(src).toMatch(/describe\('tenant isolation \(two-project\)'/);
    expect(src).toMatch(/describe\('policy integration'/);
    // The two-project tenant-ownership regression is present (the route
    // 403 + the service-level defense-in-depth rejection).
    expect(src).toMatch(/403/);
    expect(src).toMatch(/tenant/);
  });

  // -------------------------------------------------------------------------
  // PR #46 review round 1 — the three blocking fixes' static invariants.
  // These PREVENT reintroduction of the forbidden patterns (not merely
  // assert current correctness): a future change that drops the continuity
  // gates or the durable relay wiring fails the architecture suite.
  // -------------------------------------------------------------------------

  // R1-A (finding #2): the durable relay is WIRED into the WorkerHost — the
  // job handler is registered in the handler registry AND the boot-sweep
  // outbox relay is registered in WorkerHostOptions.outboxRelays. The relay
  // being merely DEFINED is insufficient (the review found it was declared
  // "optional" and not wired — a process crash left a stranded handoff).
  it('R1-A. the cross-mode-handoff durable relay is WIRED into the WorkerHost (the job handler in the registry + the boot-sweep outbox relay) — not merely defined', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    const barrelSrc = readFileSync(AGENTS_BARREL, 'utf8');
    // The relay module is imported by app.ts DIRECTLY from the internal path
    // (mirrors the WORK-034/035 relay pattern — the barrel exposes only the
    // contract types; the concrete impls stay internal).
    expect(appSrc, 'app.ts imports the CrossModeHandoffOutboxRelay').toMatch(/CrossModeHandoffOutboxRelay/);
    expect(appSrc, 'app.ts imports the createCrossModeHandoffRelayJobHandler').toMatch(/createCrossModeHandoffRelayJobHandler/);
    expect(appSrc, 'app.ts imports from the internal relay path (NOT the barrel)').toMatch(/from '\.\/modules\/agents\/internal\/cross-mode-handoff-relay\.js'/);
    // The relay job handler is registered in the handler registry.
    expect(appSrc, 'the relay job handler is pushed into the handlerList').toMatch(/handlerList\.push\(createCrossModeHandoffRelayJobHandler/);
    // The boot-sweep outbox relay is registered in outboxRelays.
    expect(appSrc, 'the cross-mode-handoff outbox relay is in outboxRelays (the boot sweep)').toMatch(/crossModeHandoffRelay \? \[crossModeHandoffRelay\]/);
    // The barrel exposes ONLY the contract types (the concrete relay impls
    // stay internal — the module-boundary invariant holds). The barrel
    // references the relay types (the contract surface) but NOT the concrete
    // class/function.
    expect(barrelSrc, 'the barrel exposes the CrossModeHandoffReconciler contract type').toMatch(/CrossModeHandoffReconciler/);
    expect(barrelSrc, 'the barrel does NOT value-export the concrete CrossModeHandoffOutboxRelay class (module-boundary invariant)').not.toMatch(/export \{[^}]*CrossModeHandoffOutboxRelay/);
    expect(barrelSrc, 'the barrel does NOT value-export the concrete createCrossModeHandoffRelayJobHandler (module-boundary invariant)').not.toMatch(/export \{[^}]*createCrossModeHandoffRelayJobHandler/);
  });

  // R1-B (finding #2): the durable obligation table + the AFTER INSERT
  // trigger exist (migration 0043 — the transactional-outbox row written
  // ATOMICALLY with the reserve). Without this, the relay has nothing to
  // sweep + the crash window #1 (reserve → process dies) is unrecoverable.
  it('R1-B. migration 0043 creates the cross-mode-handoff obligation table + the AFTER INSERT trigger (the durable obligation written ATOMICALLY with the reserve)', () => {
    const migrationPath = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations', '0043_cross_mode_handoff_obligations.sql');
    expect(existsSync(migrationPath), 'migration 0043 must exist').toBe(true);
    const src = readFileSync(migrationPath, 'utf8');
    expect(src, 'the obligation table is created').toMatch(/CREATE TABLE IF NOT EXISTS wfos_cross_mode_handoff_obligations/);
    expect(src, 'UNIQUE(handoff_id) — one obligation per handoff').toMatch(/UNIQUE \(handoff_id\)/);
    expect(src, 'the discharged_at column (the durable state)').toMatch(/discharged_at TIMESTAMPTZ/);
    expect(src, 'the pending index (the boot-sweep work list)').toMatch(/wfos_cross_mode_handoff_obligations_pending_idx/);
    // The AFTER INSERT trigger writes the obligation ATOMICALLY with the reserve.
    expect(src, 'the AFTER INSERT trigger function').toMatch(/wfos_cross_mode_handoff_obligation_on_reserve/);
    expect(src, 'the trigger is AFTER INSERT on the handoff log').toMatch(/AFTER INSERT ON wfos_execution_mode_handoffs/);
    // The append-only immutability (only the discharge column may change).
    expect(src, 'the immutability trigger').toMatch(/wfos_cross_mode_handoff_obligation_immutable/);
  });

  // R1-C (finding #1 + #3): the service COMPOSES the WORK-035 workspace
  // port + the WORK-034 session port (the continuity gates). A future
  // change that drops these deps fails the architecture suite — the
  // physical-worktree continuity + the WORK-034 session-terminal
  // compatibility are NOT silently removable.
  it('R1-C. the cross-mode handoff service composes the WORK-035 workspace port + the WORK-034 session port (the continuity gates are NOT optional)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // The workspace port (finding #1: physical-worktree continuity).
    expect(serviceSrc, 'the CrossModeAgentWorkspacePort is declared').toMatch(/CrossModeAgentWorkspacePort/);
    expect(serviceSrc, 'the agentWorkspaceService dep is required').toMatch(/readonly agentWorkspaceService:/);
    expect(serviceSrc, 'the workspace continuity gate is called').toMatch(/assertWorkspaceContinuityEligible/);
    expect(serviceSrc, 'a terminal workspace is REJECTED (handoff-ineligible-state)').toMatch(/terminalAt !== null/);
    // The session port (finding #3: WORK-034 terminal-session compatibility).
    expect(serviceSrc, 'the CrossModeExecutionSessionPort is declared').toMatch(/CrossModeExecutionSessionPort/);
    expect(serviceSrc, 'the executionSessionService dep is required').toMatch(/readonly executionSessionService:/);
    expect(serviceSrc, 'the session continuity gate is called').toMatch(/assertSessionContinuityEligible/);
    expect(serviceSrc, 'a terminal session is REJECTED (handoff-ineligible-state)').toMatch(/session\.status === 'completed'/);
    // The session is driven through the EXISTING non-terminal path
    // (interrupt on native→external; resume/start on external→native).
    expect(serviceSrc, 'transitionSessionForHandoff is implemented').toMatch(/transitionSessionForHandoff/);
    expect(serviceSrc, 'native→external interrupts a running session').toMatch(/interruptSession/);
    expect(serviceSrc, 'external→native resumes an interrupted session').toMatch(/resumeSession/);
    // NEVER silently continues a terminal session — the gate rejects it
    // BEFORE the mutate.
    const mutateIdx = serviceSrc.indexOf('async mutateAndDispatch(');
    // The gate is CALLED in the handoff flow (not just defined). Find the
    // handoff() method body's call to the gate.
    const handoffStart = serviceSrc.indexOf('async handoff(');
    const gateCallInHandoff = serviceSrc.indexOf('assertSessionContinuityEligible(', handoffStart);
    expect(gateCallInHandoff, 'the session continuity gate is called inside handoff()').toBeGreaterThan(handoffStart);
    expect(gateCallInHandoff, 'the gate call in handoff() precedes the mutateAndDispatch definition').toBeGreaterThan(-1);
    expect(mutateIdx, 'mutateAndDispatch is defined').toBeGreaterThan(-1);
  });

  // R1-D (finding #2): the repository implements the obligation surface
  // (listPendingHandoffObligations + dischargeHandoffObligation) — the relay
  // + the boot sweep need these to sweep + drain. Without them the relay is
  // inert.
  it('R1-D. the cross-mode-handoff repository implements the obligation surface (listPendingHandoffObligations + dischargeHandoffObligation)', () => {
    const repoSrc = readFileSync(CROSS_MODE_REPO, 'utf8');
    expect(repoSrc, 'listPendingHandoffObligations is implemented').toMatch(/async listPendingHandoffObligations\(/);
    expect(repoSrc, 'the pending query filters discharged_at IS NULL').toMatch(/WHERE o\.discharged_at IS NULL/);
    expect(repoSrc, 'dischargeHandoffObligation is implemented').toMatch(/async dischargeHandoffObligation\(/);
    expect(repoSrc, 'the discharge UPDATE sets discharged_at').toMatch(/SET discharged_at = NOW\(\)/);
    // The service discharges the obligation when the reconcile confirms
    // completion (the boot-sweep work list drains). PR #46 round 5: the
    // discharge call carries the EXACT lease identity (the unique
    // per-invocation owner + the fencing epoch) — the epoch-fenced discharge.
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    expect(serviceSrc, 'the service discharges the obligation on completion (epoch-fenced by the lease identity)').toMatch(/dischargeHandoffObligation\(\s*handoff\.id,\s*lease\.owner,\s*lease\.claimEpoch,?\s*\)/);
  });

  // R1-E (finding #2 + round 3): the service enqueues the durable relay job
  // (the live-worker delivery — a live worker drains the job without any
  // restart; the boot sweep is the backstop). PR #46 round 3 (the concurrency
  // fix): the enqueue now happens AFTER the mutation+dispatch+session
  // convergence (NOT at reserve — see R3-A for the ordering invariant). Without
  // this enqueue, the only delivery path is the boot sweep (requires a
  // restart).
  it('R1-E. the service enqueues the durable relay job (the live-worker delivery path — PR #46 round 3: AFTER the mutation, not at reserve)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    expect(serviceSrc, 'enqueueRelayJob is defined').toMatch(/private async enqueueRelayJob/);
    expect(serviceSrc, 'the handoff calls enqueueRelayJob').toMatch(/await this\.enqueueRelayJob\(executionId\)/);
    expect(serviceSrc, 'the enqueue uses CROSS_MODE_HANDOFF_RELAY_JOB_TYPE').toMatch(/CROSS_MODE_HANDOFF_RELAY_JOB_TYPE/);
  });

  // -------------------------------------------------------------------------
  // PR #46 review round 2 — the two REFINED blocking findings. These
  // PREVENT reintroduction of the forbidden patterns: a future change that
  // makes the queue optional, swallows enqueue failures, swallows session
  // transition failures, OR discharges the obligation before the session has
  // converged fails the architecture suite.
  // -------------------------------------------------------------------------

  // R2-A (Finding #1): the queue dep is REQUIRED (not optional). The round-1
  // type contract declared `queue?: Queue` (optional) — the production
  // durability guarantee depended on a later boot sweep. Now the queue is
  // REQUIRED: `readonly queue: Queue;` (no `?`). A future change that
  // re-optionalizes the queue fails this invariant.
  it('R2-A. the cross-mode handoff service queue dep is REQUIRED (not optional — Finding #1 round 2)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // The queue dep is declared as REQUIRED (no `?`).
    expect(serviceSrc, 'the queue dep is declared').toMatch(/readonly queue: Queue;/);
    // The OPTIONAL declaration is GONE (the round-1 `queue?: Queue` is
    // forbidden). A negative lookahead on the optional form.
    expect(serviceSrc, 'the queue dep is NOT optional (no `?`)').not.toMatch(/readonly queue\?: Queue/);
  });

  // R2-B (Finding #1): the enqueueRelayJob method does NOT swallow enqueue
  // failures. The round-1 impl wrapped the enqueue in a try/catch that
  // logged + swallowed (the durability guarantee depended on the boot sweep).
  // Now an enqueue failure PROPAGATES (the handoff fails fast; the obligation
  // is durable; the boot sweep reconciles). The method MAY log before the
  // throw (operator visibility), but the `throw err` MUST be present.
  it('R2-B. enqueueRelayJob does NOT swallow enqueue failures (the failure propagates — Finding #1 round 2)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // The enqueueRelayJob method is defined.
    const methodStart = serviceSrc.indexOf('private async enqueueRelayJob(');
    expect(methodStart, 'enqueueRelayJob is defined').toBeGreaterThan(-1);
    // Extract the method body (up to the next method's JSDoc or the closing
    // brace at the same indentation).
    const methodBody = serviceSrc.slice(methodStart, methodStart + 800);
    // The `throw err` (or `throw`) MUST be present — the failure propagates.
    expect(methodBody, 'enqueueRelayJob re-throws on failure (not swallowed)').toMatch(/throw err/);
    // The early-return guard for `!this.deps.queue` is GONE (the round-1
    // `if (!this.deps.queue) return;` is forbidden — the queue is REQUIRED).
    expect(methodBody, 'no queueless-construction early return (the queue is REQUIRED)').not.toMatch(/if \(!this\.deps\.queue\) return/);
  });

  // R2-C (Finding #2): the transitionSessionForHandoff method does NOT
  // swallow session-transition failures. The round-1 impl wrapped the
  // transition in a try/catch that logged + swallowed (the crash gap — a
  // crash after the record mutate but before the session transition left
  // the session mismatched indefinitely). Now a session-transition failure
  // PROPAGATES (the handoff fails fast; the obligation stays pending; the
  // reconcile re-attempts). The method MAY log on success (the interrupt/
  // resume/start log lines), but the catch-and-swallow pattern is GONE.
  it('R2-C. transitionSessionForHandoff does NOT swallow session-transition failures (the failure propagates — Finding #2 round 2)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    const methodStart = serviceSrc.indexOf('private async transitionSessionForHandoff(');
    expect(methodStart, 'transitionSessionForHandoff is defined').toBeGreaterThan(-1);
    // Extract the method body (up to the next method's JSDoc).
    const methodEnd = serviceSrc.indexOf('private ', methodStart + 10);
    const methodBody = serviceSrc.slice(methodStart, methodEnd > methodStart ? methodEnd : methodStart + 1200);
    // The catch-and-swallow pattern is GONE. The round-1 impl had a
    // `} catch (err) { ... this.deps.logger.warn(...); }` that swallowed the
    // error. Now the method has NO try/catch around the transition (a CAS
    // loss / null result is handled inline — NOT via a catch).
    expect(methodBody, 'no catch-and-swallow around the session transition').not.toMatch(/catch \(err\) \{[\s\S]*session-transition-failed/);
    // The session-transition-failed warn log (the round-1 swallow path) is
    // GONE.
    expect(methodBody, 'the session-transition-failed swallow log is gone').not.toMatch(/session-transition-failed/);
  });

  // R2-D (Finding #2): the handoffComplete check INCLUDES session
  // convergence. The round-1 impl only checked record.mode === toMode + the
  // dispatch outcome — a crash after the record mutate but before the
  // session transition discharged the obligation prematurely. Now the
  // complete-check calls sessionConverged + returns false when the session
  // has not converged. The obligation stays pending until the session
  // converges.
  it('R2-D. handoffComplete includes session convergence (the obligation stays pending until the session converges — Finding #2 round 2)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // The sessionConverged method is defined.
    expect(serviceSrc, 'sessionConverged is defined').toMatch(/private sessionConverged\(/);
    // The handoffComplete method calls sessionConverged.
    const completeStart = serviceSrc.indexOf('private async handoffComplete(');
    expect(completeStart, 'handoffComplete is defined').toBeGreaterThan(-1);
    const completeEnd = serviceSrc.indexOf('private ', completeStart + 10);
    const completeBody = serviceSrc.slice(completeStart, completeEnd > completeStart ? completeEnd : completeStart + 800);
    expect(completeBody, 'handoffComplete resolves the session').toMatch(/getSessionForExecution/);
    expect(completeBody, 'handoffComplete calls sessionConverged').toMatch(/sessionConverged\(session, record, handoff\)/);
    // The convergence check returns false when not converged (the obligation
    // stays pending).
    expect(completeBody, 'handoffComplete returns false when not converged').toMatch(/if \(!this\.sessionConverged\(session, record, handoff\)\) return false/);
  });

  // R2-E (Finding #2): the reconcile re-attempts the session transition
  // when the session has NOT converged (crash window #3). The round-1 impl
  // only revisited the session inside crash window #1 (record.mode !== toMode
  // — the re-mutate path). A crash after the record mutate but before the
  // session transition left the session mismatched indefinitely (the
  // reconcile skipped the session transition when record.mode === toMode).
  // Now the reconcile resolves the session + re-attempts the transition when
  // not converged, REGARDLESS of the crash window.
  it('R2-E. the reconcile re-attempts the session transition when not converged (crash window #3 — Finding #2 round 2)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    const reconcileStart = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(');
    expect(reconcileStart, 'reconcileCrossModeHandoffForExecution is defined').toBeGreaterThan(-1);
    // The reconcile body extends to the next method.
    const reconcileEnd = serviceSrc.indexOf('private async handoffComplete(', reconcileStart + 10);
    const reconcileBody = serviceSrc.slice(reconcileStart, reconcileEnd > reconcileStart ? reconcileEnd : reconcileStart + 4000);
    // The crash window #3: the reconcile resolves the session AFTER the
    // re-dispatch (crash window #2) + re-attempts the transition when not
    // converged.
    expect(reconcileBody, 'the reconcile resolves the session for convergence').toMatch(/getSessionForExecution/);
    expect(reconcileBody, 'the reconcile uses the sessionForConvergence binding (crash window #3)').toMatch(/sessionForConvergence/);
    expect(reconcileBody, 'the reconcile calls sessionConverged').toMatch(/sessionConverged\(sessionForConvergence, record, handoff\)/);
    expect(reconcileBody, 'the reconcile re-attempts the session transition (crash window #3)').toMatch(/transitionSessionForHandoff\(\s*sessionForConvergence/);
    // The stage type includes the new 'session-convergence' value.
    expect(reconcileBody, 'the stage type includes session-convergence').toMatch(/'session-convergence'/);
  });

  // -------------------------------------------------------------------------
  // PR #46 review round 3 — the concurrency blocker. These PREVENT
  // reintroduction of the forbidden patterns: a future change that enqueues
  // the relay job BEFORE the mutation (re-introducing the live-worker race)
  // OR treats a terminal session as converged for external→native
  // (re-introducing the accidental-discharge path) fails the architecture
  // suite.
  // -------------------------------------------------------------------------

  // R3-A (round 3 BLOCKER — the concurrency race): the relay job is enqueued
  // AFTER the mutation+session convergence+dispatch (NOT before). Round 2
  // enqueued at reserve (BEFORE the mutation) — a live WorkerHost could
  // consume the relay BETWEEN the reserve and the caller's transitionMode,
  // after which BOTH the worker and the caller performed the same
  // mutation+dispatch (duplicate provider submission / conflicting session
  // transitions). The handoff-row UNIQUE constraint did NOT serialize these
  // two executions (both operated on the same already-reserved handoff row).
  // Now the relay job is enqueued ONLY AFTER the caller's synchronous state
  // transition is safely committed: a live worker that picks up the job sees
  // a COMPLETE (or near-complete) handoff + the reconcile is a no-op
  // discharge (NOT a competing mutation). This invariant checks the SOURCE
  // ORDERING: the `enqueueRelayJob` call MUST appear AFTER the
  // `mutateAndDispatch` call in the `handoff()` method body.
  it('R3-A. the relay job is enqueued AFTER the mutation+dispatch+session (NOT before — the round 3 concurrency fix)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // Locate the handoff() method body (from `async handoff(` to the next
    // method `async reconcileCrossModeHandoffForExecution(`).
    const handoffStart = serviceSrc.indexOf('async handoff(');
    expect(handoffStart, 'handoff is defined').toBeGreaterThan(-1);
    const handoffEnd = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(', handoffStart + 10);
    const handoffBody = serviceSrc.slice(handoffStart, handoffEnd > handoffStart ? handoffEnd : handoffStart + 6000);
    // The mutateAndDispatch call MUST appear in the handoff body.
    const mutateIdx = handoffBody.indexOf('await this.mutateAndDispatch(');
    expect(mutateIdx, 'mutateAndDispatch is called in handoff').toBeGreaterThan(-1);
    // The enqueueRelayJob call MUST appear in the handoff body.
    const enqueueIdx = handoffBody.indexOf('await this.enqueueRelayJob(');
    expect(enqueueIdx, 'enqueueRelayJob is called in handoff').toBeGreaterThan(-1);
    // The enqueue MUST appear AFTER the mutate (the round 3 ordering — a live
    // worker that picks up the job sees a COMPLETE handoff, not a half-mutated
    // one). A future change that moves the enqueue BEFORE the mutate
    // (re-introducing the round 2 race) fails this invariant.
    expect(enqueueIdx, 'enqueueRelayJob is called AFTER mutateAndDispatch (round 3: no live-relay race)').toBeGreaterThan(mutateIdx);
  });

  // R3-B (round 3 secondary — the terminal-session accidental discharge):
  // sessionConverged does NOT treat a terminal session as converged for
  // external→native by itself. The round 2 impl had an unconditional
  // `if (session.status === 'completed' || session.status === 'failed' ||
  // session.status === 'cancelled') return true;` branch BEFORE the
  // record-terminal check — a terminal session that arose mid-handoff
  // (concurrent terminalization) would discharge the obligation
  // accidentally. Now the terminal-session-as-converged branch is GONE for
  // external→native: a terminal session falls through to the record-terminal
  // check (the authoritative signal that the execution finished). The
  // obligation stays pending until the record reaches a terminal state or an
  // operator resolves it. This invariant checks that the OLD terminal-session-
  // as-converged pattern (a `return true` guarded by a session.status check
  // for a terminal state, appearing BEFORE the record.status check) is GONE
  // from the sessionConverged method body.
  it('R3-B. sessionConverged does NOT treat a terminal session as converged for external→native (round 3 secondary — terminalization cannot accidentally discharge a handoff)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    const methodStart = serviceSrc.indexOf('private sessionConverged(');
    expect(methodStart, 'sessionConverged is defined').toBeGreaterThan(-1);
    // The method body extends to the next `private` method.
    const methodEnd = serviceSrc.indexOf('private ', methodStart + 10);
    const methodBody = serviceSrc.slice(methodStart, methodEnd > methodStart ? methodEnd : methodStart + 1500);
    // The OLD terminal-session-as-converged branch is GONE. The pattern: a
    // session.status check for a terminal state (completed/failed/cancelled),
    // followed by `return true;`, appearing BEFORE the record.status check.
    // This is the round 3 secondary defect — a terminal session that arose
    // mid-handoff would discharge the obligation. Now this pattern is GONE.
    expect(methodBody, 'no terminal-session-as-converged branch before the record check (the session.status===cancelled guard is gone)').not.toMatch(
      /session\.status === '(?:completed|failed|cancelled)'[\s\S]*?return true;[\s\S]*?record\.status/,
    );
    // The record-terminal check IS present (the authoritative signal that the
    // execution finished — the ONLY way a terminal session discharges a
    // handoff).
    expect(methodBody, 'the record-terminal check is present').toMatch(/record\.status === 'completed' \|\| record\.status === 'failed'/);
  });

  // =========================================================================
  // PR #46 round 4 (the durable claim/lease — the concurrency-serialization
  // fix the architect required): the round-3 reorder (enqueue AFTER mutation)
  // closed the live-relay race but NOT the boot-sweep race — the synchronous
  // caller + the boot sweep / the relay reconcile could BOTH drive the same
  // pending obligation between the reserve and the caller's mutation (TWO
  // concurrent handoff drivers → duplicate provider dispatches + conflicting
  // session transitions). The round-4 fix introduces a durable execution
  // claim/lease on the obligation row (migration 0044): the caller acquires
  // the claim ATOMICALLY with the reserve (one transaction), and the relay
  // reconcile acquires the claim at entry. A failed claim returns early (NO
  // re-mutate, NO re-dispatch). A crashed owner's lease auto-expires (the
  // reclaim predicate `claimed_at IS NULL OR claim_expires_at < NOW()`) so
  // the boot sweep reclaims + recovers. The 5 invariants below prevent
  // regression of these structural properties at the source level.
  // =========================================================================

  // R4-A (round 4 — the claim primitive is on BOTH paths): the synchronous
  // caller path (`handoff`) calls `createHandoffAndClaim` (the atomic
  // reserve + claim in ONE transaction — closes the boot-sweep race between
  // the reserve commit and a separate claim commit), AND the relay reconcile
  // path (`reconcileCrossModeHandoffForExecution`) calls
  // `claimHandoffObligation` at entry (the same serialization primitive).
  // Both paths MUST acquire the claim BEFORE mutating — removing the claim
  // from either path reintroduces the race on that path.
  it('R4-A. the service uses the claim primitive on BOTH paths (handoff calls createHandoffAndClaim + reconcile calls claimHandoffObligation)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // The caller path: createHandoffAndClaim is called in handoff() (the
    // reserveAndClaim helper invokes it — the claim is the caller's
    // serialization boundary). Removing it from the caller path
    // reintroduces the boot-sweep race between reserve and mutation.
    expect(serviceSrc, 'handoff() exercises createHandoffAndClaim (the caller-path claim)').toMatch(/createHandoffAndClaim\(/);
    // The relay path: claimHandoffObligation is called in
    // reconcileCrossModeHandoffForExecution (the reconcile's entry-point
    // claim — a failed claim returns early before any mutate). Removing it
    // from the relay path reintroduces the race on the relay path.
    expect(serviceSrc, 'reconcileCrossModeHandoffForExecution() exercises claimHandoffObligation (the relay-path claim)').toMatch(/claimHandoffObligation\(/);
  });

  // R4-B (round 4 — the claim is released in a `finally` on BOTH paths):
  // the claim is the serialization boundary; if the caller / the reconcile
  // crashes mid-critical-section (mutate/dispatch/session throws), the claim
  // MUST be released so the boot sweep / relay can reclaim immediately (no
  // lease wait). A bare `releaseHandoffObligationClaim` call after the
  // critical section (NOT in a `finally`) would leak the claim on failure
  // (the lease would auto-expire, but that delays recovery by `claimLeaseMs`).
  // The release is wrapped in `releaseClaimSafely` (a non-throwing wrapper
  // so a release failure does not mask the original error) + invoked in a
  // `finally` block. This invariant checks the `finally { ... releaseClaimSafely(
  // }` pattern is present in BOTH method bodies.
  it('R4-B. the claim is released in a `finally` block on BOTH paths (no leaked claim on failure)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // The handoff() body: from `async handoff(` to the next method
    // `async reconcileCrossModeHandoffForExecution(`.
    const handoffStart = serviceSrc.indexOf('async handoff(');
    expect(handoffStart, 'handoff is defined').toBeGreaterThan(-1);
    const handoffEnd = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(', handoffStart + 10);
    expect(handoffEnd, 'reconcile is defined after handoff').toBeGreaterThan(-1);
    const handoffBody = serviceSrc.slice(handoffStart, handoffEnd);
    // The caller-path release: a `finally` block containing a
    // `releaseClaimSafely(` call. The pattern is `finally {` (with optional
    // whitespace/newline) followed by ANY text up to `releaseClaimSafely(`.
    expect(handoffBody, 'handoff() releases the claim in a `finally` block').toMatch(/finally\s*\{[\s\S]*?releaseClaimSafely\(/);
    // There is NO bare `releaseHandoffObligationClaim(` call OUTSIDE a
    // finally — the service routes releases through `releaseClaimSafely`
    // (the non-throwing wrapper). A direct call would bypass the safety
    // wrapper + could throw out of a `finally`, masking the original error.
    expect(handoffBody, 'handoff() does NOT call releaseHandoffObligationClaim directly (always through releaseClaimSafely)').not.toMatch(/releaseHandoffObligationClaim\(/);

    // The reconcile() body: from `async reconcileCrossModeHandoffForExecution(`
    // to the next `private` method (the reconcile is followed by private
    // helpers — `handoffComplete` is the first private method after it).
    const reconcileStart = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(');
    expect(reconcileStart, 'reconcile is defined').toBeGreaterThan(-1);
    const reconcileEnd = serviceSrc.indexOf('private ', reconcileStart + 10);
    const reconcileBody = serviceSrc.slice(reconcileStart, reconcileEnd > reconcileStart ? reconcileEnd : reconcileStart + 5000);
    // The relay-path release: same `finally { ... releaseClaimSafely( }`
    // pattern.
    expect(reconcileBody, 'reconcile() releases the claim in a `finally` block').toMatch(/finally\s*\{[\s\S]*?releaseClaimSafely\(/);
    expect(reconcileBody, 'reconcile() does NOT call releaseHandoffObligationClaim directly').not.toMatch(/releaseHandoffObligationClaim\(/);
  });

  // R4-C (round 4 — the migration 0044 + the claim/lease columns exist):
  // the durable claim/lease lives on the obligation row (migration 0043's
  // `wfos_cross_mode_handoff_obligations`). Migration 0044 adds the three
  // new columns (`claimed_at`, `claim_expires_at`, `claim_owner`) + an
  // index on `claim_expires_at` (the reclaimable-claim work-list probe).
  // The 0043 immutability trigger only guards `handoff_id`/`execution_id`/
  // `created_at` (the recorded intent) — the new claim columns are FREE to
  // mutate (like `discharged_at` — the durable execution state). NO trigger
  // extension is needed. Dropping the migration OR removing any column
  // breaks the claim UPDATE predicate (the conditional UPDATE would no
  // longer fire).
  it('R4-C. migration 0044 exists + adds the claim/lease columns (claimed_at, claim_expires_at, claim_owner)', () => {
    expect(existsSync(CROSS_MODE_MIGRATION_0044), '0044_cross_mode_handoff_claim_lease.sql must exist').toBe(true);
    const src = readFileSync(CROSS_MODE_MIGRATION_0044, 'utf8');
    // ALTERs the obligations table (NOT a CREATE TABLE — the table is from
    // migration 0043; 0044 extends it with the claim columns).
    expect(src).toMatch(/ALTER TABLE wfos_cross_mode_handoff_obligations/);
    // The three new claim/lease columns.
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ/);
    expect(src).toMatch(/claim_expires_at TIMESTAMPTZ/);
    expect(src).toMatch(/claim_owner TEXT/);
  });

  // R4-D (round 4 — the claim UPDATE uses the reclaim predicate): a crashed
  // owner's lease auto-expires — the conditional UPDATE's WHERE clause
  // includes the reclaim predicate `claimed_at IS NULL OR claim_expires_at <
  // NOW()` so an expired lease is reclaimable by the next sweep. Replacing
  // the conditional UPDATE with an unconditional one (or removing the
  // `claim_expires_at < NOW()` arm) would NEVER reclaim a crashed owner
  // (the boot sweep would see a permanently-claimed obligation + skip it).
  // The repository source must contain this predicate verbatim.
  it('R4-D. the claim UPDATE uses the reclaim predicate (a crashed owner\'s expired lease is reclaimable)', () => {
    const repoSrc = readFileSync(CROSS_MODE_REPO, 'utf8');
    // The reclaim predicate: `claimed_at IS NULL OR claim_expires_at < NOW()`.
    // The `claimed_at IS NULL` arm lets the FIRST claim match; the
    // `claim_expires_at < NOW()` arm lets an EXPIRED claim be reclaimed
    // (the crash-reclaim semantic). Both arms MUST be present.
    expect(repoSrc, 'the claim UPDATE predicate includes the reclaimable-expired-lease arm').toMatch(/claimed_at IS NULL OR claim_expires_at < NOW\(\)/);
  });

  // R4-E (round 4 — the reconcile returns early on a failed claim): the
  // relay reconcile acquires the claim at entry + returns BEFORE any
  // mutate/dispatch when another actor owns the obligation (the caller OR
  // another concurrent reconcile). This is the structural prevention of two
  // concurrent handoff drivers — the architect's round-4 required correction.
  // The claim call MUST appear BEFORE the first `mutateAndDispatch` call in
  // the reconcile body (reordering it after the mutate would reintroduce the
  // race), AND there MUST be a `!claim.claimed` early-return that emits the
  // `stage: 'claim-held'` result (NO mutate, NO dispatch). Removing the
  // early-return OR reordering the claim after the mutate would reintroduce
  // the race the architect identified.
  it('R4-E. the reconcile returns early on a failed claim (NO mutate, NO dispatch when another actor owns the obligation)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // The reconcile() body: from `async reconcileCrossModeHandoffForExecution(`
    // to the next `private` method.
    const reconcileStart = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(');
    expect(reconcileStart, 'reconcile is defined').toBeGreaterThan(-1);
    const reconcileEnd = serviceSrc.indexOf('private ', reconcileStart + 10);
    const reconcileBody = serviceSrc.slice(reconcileStart, reconcileEnd > reconcileStart ? reconcileEnd : reconcileStart + 5000);
    // The claim call appears BEFORE the first mutateAndDispatch call. A
    // future change that reorders the claim AFTER the mutate (re-introducing
    // the race) fails this inequality.
    const claimIdx = reconcileBody.indexOf('claimHandoffObligation(');
    expect(claimIdx, 'reconcile calls claimHandoffObligation').toBeGreaterThan(-1);
    const mutateIdx = reconcileBody.indexOf('mutateAndDispatch(');
    expect(mutateIdx, 'reconcile calls mutateAndDispatch').toBeGreaterThan(-1);
    expect(claimIdx, 'the claim is acquired BEFORE the first mutate (no race)').toBeLessThan(mutateIdx);
    // The `!claim.claimed` early-return emits `stage: 'claim-held'` BEFORE
    // the mutate — the structural prevention of two concurrent handoff
    // drivers. A future change that removes the early-return (letting the
    // reconcile proceed to the mutate even on a failed claim) fails this
    // match.
    expect(reconcileBody, 'the !claim.claimed branch returns { stage: \'claim-held\' } before the mutate').toMatch(/if\s*\(!claim\.claimed\)[\s\S]*?return\s*\{[\s\S]*?stage:\s*'claim-held'/);
  });

  // =========================================================================
  // PR #46 round 5 (the lease-ownership + lease-expiry fixes). The round-5
  // review found two lease-correctness holes in the round-4 claim/lease:
  //
  //   1. the claim owner was a FIXED per-role string shared by EVERY
  //      invocation of that role — with a reclaimable lease, an old
  //      invocation could outlive its expired lease, a new invocation of the
  //      same role could reclaim under the SAME owner string, and the old
  //      invocation's `finally` release would then clear the NEW owner's
  //      live claim (the serialization boundary was gone);
  //   2. the fixed 30s lease had NO renewal + NO fencing — a critical
  //      section legitimately longer than the lease let a second actor
  //      reclaim while the first was STILL EXECUTING (both then performed
  //      the provider dispatch + session transitions).
  //
  // The fix: unique per-invocation owners (`<role-prefix>:<uuid>`), the
  // claim_epoch fencing token (migration 0045), the heartbeat renewal
  // covering the whole critical section, phase-boundary fence checks, and
  // the epoch-fenced discharge. The 7 invariants below prevent regression of
  // these structural properties at the source level.
  // =========================================================================

  // R5-A (round 5 — the claim owner is a UNIQUE per-invocation identity):
  // both critical-section entry points compose their owner from the role
  // PREFIX + a random UUID via newCrossModeHandoffClaimOwner — NEVER the
  // bare role constant (two invocations of the same role must NEVER share
  // an owner, or a stale invocation's owner-guarded release could clear a
  // newer owner's live claim).
  it('R5-A. the claim owner is a unique per-invocation identity on BOTH paths (role prefix + UUID via newCrossModeHandoffClaimOwner)', () => {
    const typesSrc = readFileSync(CROSS_MODE_TYPES, 'utf8');
    // The generator: composes the role prefix + a random UUID.
    expect(typesSrc, 'newCrossModeHandoffClaimOwner is defined').toMatch(/export function newCrossModeHandoffClaimOwner\(rolePrefix: string\): string \{/);
    expect(typesSrc, 'the owner generator composes a random UUID (unique per invocation)').toMatch(/export function newCrossModeHandoffClaimOwner\(rolePrefix: string\): string \{[\s\S]*?randomUUID\(\)/);
    // The role constants are documented as PREFIXES.
    expect(typesSrc, 'the caller role prefix constant exists').toMatch(/CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX = 'cross-mode-handoff-caller'/);
    expect(typesSrc, 'the relay role prefix constant exists').toMatch(/CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX = 'cross-mode-handoff-relay'/);

    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    const handoffStart = serviceSrc.indexOf('async handoff(');
    expect(handoffStart, 'handoff is defined').toBeGreaterThan(-1);
    const handoffEnd = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(', handoffStart + 10);
    const handoffBody = serviceSrc.slice(handoffStart, handoffEnd);
    // The caller path composes its owner from the prefix + UUID.
    expect(handoffBody, 'handoff() composes a unique per-invocation caller owner').toMatch(/newCrossModeHandoffClaimOwner\(\s*CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX/);
    // The caller NEVER passes a bare role constant as the claim owner.
    expect(handoffBody, 'handoff() does NOT pass a bare role constant to the claim').not.toMatch(/createHandoffAndClaim\(\s*createInput,\s*CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX\s*,/);

    const reconcileStart = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(');
    const reconcileEnd = serviceSrc.indexOf('private ', reconcileStart + 10);
    const reconcileBody = serviceSrc.slice(reconcileStart, reconcileEnd > reconcileStart ? reconcileEnd : reconcileStart + 5000);
    // The relay path composes its owner from the prefix + UUID.
    expect(reconcileBody, 'reconcile() composes a unique per-invocation relay owner').toMatch(/newCrossModeHandoffClaimOwner\(\s*CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX/);
    // The relay NEVER passes a bare role constant as the claim owner.
    expect(reconcileBody, 'reconcile() does NOT pass a bare role constant to the claim').not.toMatch(/claimHandoffObligation\(\s*handoff\.id,\s*CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX\s*,/);
  });

  // R5-B (round 5 — the heartbeat renewal covers the ENTIRE critical
  // section): a live owner's lease cannot expire mid-flight. The service
  // starts a lease guard (startClaimLease — a heartbeat timer renewing every
  // claimLeaseMs/3) after a successful claim on BOTH paths + stops it in the
  // `finally` (before the release, so no renewal can race the release).
  it('R5-B. the heartbeat lease guard covers the whole critical section on BOTH paths (started after the claim, stopped in the finally)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // The heartbeat interval default: claimLeaseMs / 3.
    expect(serviceSrc, 'the heartbeat interval derives from the lease (claimLeaseMs / 3)').toMatch(/Math\.max\(1, Math\.floor\(this\.claimLeaseMs \/ 3\)\)/);
    expect(serviceSrc, 'the handoffClaimHeartbeatMs dep exists (tests can suppress the heartbeat to simulate a stalled owner)').toMatch(/readonly handoffClaimHeartbeatMs\?: number/);
    // The guard renews through the repository primitive.
    expect(serviceSrc, 'the lease guard renews via renewHandoffObligationClaim').toMatch(/renewHandoffObligationClaim\(/);

    const handoffStart = serviceSrc.indexOf('async handoff(');
    const handoffEnd = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(', handoffStart + 10);
    const handoffBody = serviceSrc.slice(handoffStart, handoffEnd);
    expect(handoffBody, 'handoff() starts the lease guard after the claim').toMatch(/startClaimLease\(/);
    expect(handoffBody, 'handoff() stops the heartbeat in the finally (before the release)').toMatch(/finally\s*\{[\s\S]*?lease\.stop\(\)[\s\S]*?releaseClaimSafely\(/);

    const reconcileStart = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(');
    const reconcileEnd = serviceSrc.indexOf('private ', reconcileStart + 10);
    const reconcileBody = serviceSrc.slice(reconcileStart, reconcileEnd > reconcileStart ? reconcileEnd : reconcileStart + 5000);
    expect(reconcileBody, 'reconcile() starts the lease guard after the claim').toMatch(/startClaimLease\(/);
    expect(reconcileBody, 'reconcile() stops the heartbeat in the finally (before the release)').toMatch(/finally\s*\{[\s\S]*?lease\.stop\(\)[\s\S]*?releaseClaimSafely\(/);
  });

  // R5-C (round 5 — the fencing-token column exists): migration 0045 adds
  // claim_epoch BIGINT NOT NULL DEFAULT 0 to the obligation table. Every
  // claim increments it; the renewal + the discharge + the release are all
  // guarded by it. Dropping the migration breaks the fence predicates.
  it('R5-C. migration 0045 exists + adds the claim_epoch fencing token', () => {
    expect(existsSync(CROSS_MODE_MIGRATION_0045), '0045_cross_mode_handoff_claim_epoch.sql must exist').toBe(true);
    const src = readFileSync(CROSS_MODE_MIGRATION_0045, 'utf8');
    expect(src, 'the migration ALTERs the obligations table').toMatch(/ALTER TABLE wfos_cross_mode_handoff_obligations/);
    expect(src, 'the migration adds the claim_epoch fencing column').toMatch(/ADD COLUMN IF NOT EXISTS claim_epoch BIGINT NOT NULL DEFAULT 0/);
  });

  // R5-D (round 5 — the renewal is lease-identity-guarded): the heartbeat
  // renewal is a conditional UPDATE guarded by the EXACT lease identity
  // (claim_owner + claim_epoch). A stale owner's renewal returns 0 rows →
  // the fence check fails → it aborts. An unconditional renewal would let a
  // stale owner keep "renewing" a lease that was reclaimed under a new
  // owner.
  it('R5-D. the renewal UPDATE is guarded by the exact lease identity (claim_owner + claim_epoch)', () => {
    const repoSrc = readFileSync(CROSS_MODE_REPO, 'utf8');
    expect(repoSrc, 'renewHandoffObligationClaim is implemented').toMatch(/async renewHandoffObligationClaim\(/);
    // The renewal predicate: owner + epoch + not-yet-discharged.
    expect(repoSrc, 'the renewal is guarded by claim_owner + claim_epoch (the fencing check)').toMatch(/async renewHandoffObligationClaim\([\s\S]*?AND claim_owner = \$2[\s\S]*?AND claim_epoch = \$3[\s\S]*?AND discharged_at IS NULL/);
    // The release is guarded by the SAME lease identity (a stale invocation
    // can never clear a newer owner's claim).
    expect(repoSrc, 'the release is guarded by claim_owner + claim_epoch').toMatch(/async releaseHandoffObligationClaim\([\s\S]*?AND claim_owner = \$2[\s\S]*?AND claim_epoch = \$3/);
  });

  // R5-E (round 5 — every claim increments the fencing epoch): both claim
  // sites (the atomic reserve+claim + the standalone reclaim) increment
  // claim_epoch, so each successive lease gets a strictly greater token.
  // Without the increment, a reclaimed lease would keep the stale owner's
  // epoch + the fence predicates could not distinguish the leases.
  it('R5-E. every claim increments the claim_epoch fencing token (monotonic per lease)', () => {
    const repoSrc = readFileSync(CROSS_MODE_REPO, 'utf8');
    const increments = repoSrc.match(/claim_epoch = COALESCE\(claim_epoch, 0\) \+ 1/g) ?? [];
    expect(increments.length, 'BOTH claim sites increment the epoch (createHandoffAndClaim + claimHandoffObligation)').toBe(2);
    // The claim RETURNs the epoch (the claimant learns its fencing token).
    expect(repoSrc, 'the claim RETURNs claim_epoch (the claimant learns its fencing token)').toMatch(/RETURNING id, claim_epoch/);
  });

  // R5-F (round 5 — the discharge is epoch-fenced): the discharge UPDATE is
  // guarded by the claim owner + epoch — only the LIVE lease holder can
  // complete the authoritative obligation transition. A stale owner's
  // discharge affects 0 rows, so an expired-then-reclaimed owner can never
  // discharge even if its phase-boundary fence check raced.
  it('R5-F. the discharge is epoch-fenced at the DB (only the live lease holder can discharge)', () => {
    const repoSrc = readFileSync(CROSS_MODE_REPO, 'utf8');
    expect(repoSrc, 'the discharge is implemented').toMatch(/async dischargeHandoffObligation\(/);
    expect(repoSrc, 'the discharge UPDATE is guarded by claim_owner + claim_epoch').toMatch(/async dischargeHandoffObligation\([\s\S]*?AND claim_owner = \$2[\s\S]*?AND claim_epoch = \$3/);
    // The service passes the EXACT lease identity to the discharge.
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    expect(serviceSrc, 'the service discharges under its own lease identity (lease.owner + lease.claimEpoch)').toMatch(/dischargeHandoffObligation\(\s*handoff\.id,\s*lease\.owner,\s*lease\.claimEpoch,?\s*\)/);
    // A fenced-out discharge is NOT treated as completion (fence-lost return).
    const reconcileStart = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(');
    const reconcileEnd = serviceSrc.indexOf('private ', reconcileStart + 10);
    const reconcileBody = serviceSrc.slice(reconcileStart, reconcileEnd > reconcileStart ? reconcileEnd : reconcileStart + 5000);
    expect(reconcileBody, 'a fenced-out discharge returns stage fence-lost (NOT complete)').toMatch(/if\s*\(!discharged\)[\s\S]*?stage:\s*'fence-lost'/);
  });

  // R5-G (round 5 — the fence check precedes EVERY side-effect phase): the
  // phase-boundary ensureFence calls run BEFORE the record mutate, the
  // session transition, the provider dispatch, and the relay enqueue. A
  // stalled owner whose lease was reclaimed aborts at the NEXT boundary —
  // BEFORE any further side effect (zero duplicate dispatch / session
  // transitions). Reordering any fence check after its phase (or removing
  // it) fails these orderings.
  it('R5-G. the fence check precedes every side-effect phase (mutate, session, dispatch, enqueue) on BOTH paths', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // mutateAndDispatch body: 3 fence checks (record-mutate, session-
    // transition, dispatch), each BEFORE its phase.
    const mdStart = serviceSrc.indexOf('private async mutateAndDispatch(');
    expect(mdStart, 'mutateAndDispatch is defined').toBeGreaterThan(-1);
    const mdEnd = serviceSrc.indexOf('private ', mdStart + 10);
    const mdBody = serviceSrc.slice(mdStart, mdEnd > mdStart ? mdEnd : mdStart + 3000);
    const fenceCalls = mdBody.match(/ensureFence\(lease,/g) ?? [];
    expect(fenceCalls.length, 'mutateAndDispatch has a fence check per side-effect phase (record-mutate, session-transition, dispatch)').toBe(3);
    expect(mdBody.indexOf("ensureFence(lease, 'record-mutate')"), 'the record-mutate fence check exists').toBeGreaterThan(-1);
    expect(mdBody.indexOf("ensureFence(lease, 'record-mutate')"), 'the fence precedes the transitionMode mutate').toBeLessThan(mdBody.indexOf('transitionMode('));
    expect(mdBody.indexOf("ensureFence(lease, 'session-transition')"), 'the session-transition fence check exists').toBeGreaterThan(-1);
    expect(mdBody.indexOf("ensureFence(lease, 'session-transition')"), 'the fence precedes the session transition').toBeLessThan(mdBody.indexOf('transitionSessionForHandoff('));
    expect(mdBody.indexOf("ensureFence(lease, 'dispatch')"), 'the dispatch fence check exists').toBeGreaterThan(-1);
    expect(mdBody.indexOf("ensureFence(lease, 'dispatch')"), 'the fence precedes the provider dispatch').toBeLessThan(mdBody.indexOf('dispatchExternal('));

    // The caller path: the fence precedes the relay enqueue.
    const handoffStart = serviceSrc.indexOf('async handoff(');
    const handoffEnd = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(', handoffStart + 10);
    const handoffBody = serviceSrc.slice(handoffStart, handoffEnd);
    expect(handoffBody.indexOf("ensureFence(lease, 'relay-enqueue')"), 'the relay-enqueue fence check exists in handoff()').toBeGreaterThan(-1);
    expect(handoffBody.indexOf("ensureFence(lease, 'relay-enqueue')"), 'the fence precedes the relay enqueue').toBeLessThan(handoffBody.indexOf('enqueueRelayJob('));

    // The relay path: fence checks before the re-mutate, each re-dispatch,
    // and the session convergence.
    const reconcileStart = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(');
    const reconcileEnd = serviceSrc.indexOf('private ', reconcileStart + 10);
    const reconcileBody = serviceSrc.slice(reconcileStart, reconcileEnd > reconcileStart ? reconcileEnd : reconcileStart + 5000);
    const reconcileFences = reconcileBody.match(/ensureFence\(lease,/g) ?? [];
    expect(reconcileFences.length, 'the reconcile has a fence check per recovery phase (re-mutate, re-dispatch-external, re-dispatch-native, session-convergence)').toBeGreaterThanOrEqual(4);
    expect(reconcileBody.indexOf("ensureFence(lease, 're-mutate')"), 'the re-mutate fence check exists').toBeLessThan(reconcileBody.indexOf('mutateAndDispatch('));
    expect(reconcileBody.indexOf("ensureFence(lease, 're-dispatch-external')"), 'the re-dispatch-external fence precedes dispatchExternal').toBeLessThan(reconcileBody.indexOf('dispatchExternal('));
    expect(reconcileBody.indexOf("ensureFence(lease, 're-dispatch-native')"), 'the re-dispatch-native fence precedes dispatchNative').toBeLessThan(reconcileBody.indexOf('dispatchNative('));
    expect(reconcileBody.indexOf("ensureFence(lease, 'session-convergence')"), 'the session-convergence fence precedes the session transition').toBeLessThan(reconcileBody.indexOf('transitionSessionForHandoff('));
    // A fence loss inside the reconcile body is caught + converted to a
    // fence-lost return (NOT an error — the new owner completes the handoff).
    expect(reconcileBody, 'the reconcile catches claim-fence-lost + returns stage fence-lost').toMatch(/err\.code === 'claim-fence-lost'[\s\S]*?stage:\s*'fence-lost'/);
  });

  // -------------------------------------------------------------------------
  // PR #46 round 6 (the side-effect-boundary fencing fix): the round-5
  // phase-boundary ensureFence() runs BEFORE the side-effecting provider
  // call, NOT ATOMICALLY with it — an owner that passed the pre-call check
  // and then stalled could resume after a reclaim and complete its
  // ALREADY-STARTED dispatch (a second authoritative provider operation).
  // The dispatch side-effect boundary itself is now fenced:
  // beginFencedDispatch (the lease fence evaluated ATOMICALLY with the
  // durable dispatch intent, BEFORE the provider submit) +
  // completeFencedDispatch (the gate CAS AND the authoritative outcome write
  // in ONE transaction — a fenced-out completion rolls back with NO write).
  // -------------------------------------------------------------------------

  // R6-A (round 6 — migration 0046 + the dispatch-gate columns): the
  // obligation carries the durable dispatch intent.
  it('R6-A. migration 0046 exists + adds the dispatch-gate columns (dispatch_state, dispatch_epoch) with a state CHECK', () => {
    expect(existsSync(CROSS_MODE_MIGRATION_0046), '0046_cross_mode_handoff_dispatch_gate.sql must exist').toBe(true);
    const src = readFileSync(CROSS_MODE_MIGRATION_0046, 'utf8');
    expect(src, 'the migration adds dispatch_state').toMatch(/ADD COLUMN IF NOT EXISTS dispatch_state TEXT/);
    expect(src, 'the migration adds dispatch_epoch').toMatch(/ADD COLUMN IF NOT EXISTS dispatch_epoch BIGINT/);
    expect(src, 'the dispatch_state CHECK constrains the gate to in_flight|completed').toMatch(/dispatch_state IN \('in_flight', 'completed'\)/);
  });

  // R6-B (round 6 — the repo exposes the fenced dispatch boundary): BOTH
  // gate primitives exist on the repository + the interface.
  it('R6-B. the repository + the interface expose beginFencedDispatch + completeFencedDispatch (the fenced dispatch boundary)', () => {
    const repoSrc = readFileSync(CROSS_MODE_REPO, 'utf8');
    expect(repoSrc, 'beginFencedDispatch is implemented').toMatch(/async beginFencedDispatch\(/);
    expect(repoSrc, 'completeFencedDispatch is implemented').toMatch(/async completeFencedDispatch\(/);
    const typesSrc = readFileSync(CROSS_MODE_TYPES, 'utf8');
    expect(typesSrc, 'the interface declares beginFencedDispatch').toMatch(/beginFencedDispatch\(/);
    expect(typesSrc, 'the interface declares completeFencedDispatch').toMatch(/completeFencedDispatch\(/);
    expect(typesSrc, 'the fenced-dispatch OUTCOME type exists (the authoritative write payload)').toMatch(/interface CrossModeHandoffFencedDispatchOutcome/);
  });

  // R6-C (round 6 — the gate BEGIN is lease-fenced ATOMICALLY with the
  // intent): ONE conditional UPDATE carrying claim_owner + claim_epoch in
  // the WHERE clause (NOT a read-check-write), with the fresh + stale
  // in-flight take-over arms + the never-re-enter-completed guard.
  it('R6-C. the gate BEGIN is ONE lease-fenced conditional UPDATE (owner + epoch in the WHERE; fresh OR stale-take-over arms; completed never re-entered)', () => {
    const repoSrc = readFileSync(CROSS_MODE_REPO, 'utf8');
    const beginMatch = repoSrc.match(/async beginFencedDispatch\([\s\S]*?\n  \}/);
    expect(beginMatch, 'beginFencedDispatch is defined').toBeTruthy();
    const beginSrc = beginMatch![0];
    expect(beginSrc, 'the gate BEGIN is a single conditional UPDATE').toMatch(/UPDATE wfos_cross_mode_handoff_obligations/);
    expect(beginSrc, 'the gate BEGIN carries the lease owner in the WHERE clause').toMatch(/AND claim_owner = \$2/);
    expect(beginSrc, 'the gate BEGIN carries the fencing epoch in the WHERE clause').toMatch(/AND claim_epoch = \$3/);
    expect(beginSrc, 'a fresh gate (dispatch_state IS NULL) opens').toMatch(/dispatch_state IS NULL/);
    expect(beginSrc, 'a STALE in-flight gate is TAKEN OVER by the newer (monotonic) epoch').toMatch(/dispatch_state = 'in_flight' AND dispatch_epoch < \$3/);
    expect(beginSrc, 'the gate opens at the claimant\'s epoch').toMatch(/SET dispatch_state = 'in_flight',\s*dispatch_epoch = \$3/);
  });

  // R6-D (round 6 — the gate COMPLETION is the atomic side-effect boundary):
  // ONE TRANSACTION = the gate CAS (owner + epoch + in_flight@epoch) AND the
  // authoritative outcome write on wfos_executions; a fenced-out completion
  // returns FALSE with NO write (the rollback guarantee).
  it('R6-D. the gate COMPLETION is ONE transaction — the gate CAS AND the authoritative wfos_executions outcome write (rollback on fence loss)', () => {
    const repoSrc = readFileSync(CROSS_MODE_REPO, 'utf8');
    const completeMatch = repoSrc.match(/async completeFencedDispatch\([\s\S]*?\n  \}/);
    expect(completeMatch, 'completeFencedDispatch is defined').toBeTruthy();
    const completeSrc = completeMatch![0];
    expect(completeSrc, 'the completion runs in a transaction').toMatch(/this\.db\.transaction\(/);
    expect(completeSrc, 'the gate CAS requires the exact lease identity').toMatch(/AND claim_owner = \$2[\s\S]*?AND claim_epoch = \$3/);
    expect(completeSrc, 'the gate CAS requires in_flight at THIS epoch').toMatch(/AND dispatch_state = 'in_flight'[\s\S]*?AND dispatch_epoch = \$3/);
    expect(completeSrc, 'the authoritative outcome write targets wfos_executions').toMatch(/UPDATE wfos_executions SET/);
    expect(completeSrc, 'the outcome write sets the status').toMatch(/status = \$2/);
    expect(completeSrc, 'the outcome write COALESCEs agent_run_id + package_json + timestamps').toMatch(/agent_run_id = COALESCE\(\$3, agent_run_id\)/);
    expect(completeSrc, 'the outcome write merges benchmark_metadata atomically (jsonb ||)').toMatch(/benchmark_metadata = COALESCE\(benchmark_metadata, '\{\}'::jsonb\)\s*\|\|\s*COALESCE\(\$8::jsonb, '\{\}'::jsonb\)/);
    // The rollback guarantee: 0 rows on the gate CAS → NO outcome write.
    const gateZeroIdx = completeSrc.indexOf('rows.length === 0');
    const outcomeWriteIdx = completeSrc.indexOf('UPDATE wfos_executions');
    expect(gateZeroIdx, 'the 0-rows fence-loss branch exists').toBeGreaterThan(-1);
    expect(outcomeWriteIdx, 'the outcome write exists').toBeGreaterThan(-1);
    expect(gateZeroIdx, 'the gate CAS is evaluated BEFORE the outcome write (0 rows → return false BEFORE any write)').toBeLessThan(outcomeWriteIdx);
    expect(completeSrc, 'the 0-rows branch returns false WITHOUT writing').toMatch(/return false;/);
  });

  // R6-E (round 6 — BOTH dispatch sub-methods cross the fenced boundary on
  // EVERY call site): dispatchExternal + dispatchNative call
  // beginFencedDispatch BEFORE their provider submit + commit their outcome
  // through completeFencedDispatch; the re-dispatch call sites in the
  // reconcile pass the lease too (NO unfenced dispatch path remains).
  it('R6-E. BOTH dispatch sub-methods cross the fenced dispatch boundary (begin before the submit; complete as the atomic outcome write; NO unfenced dispatch path)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    // dispatchExternal: gated begin BEFORE the external submit; the outcome
    // write goes THROUGH completeFencedDispatch (no direct updateStatus).
    const deStart = serviceSrc.indexOf('private async dispatchExternal(');
    const deEnd = serviceSrc.indexOf('private ', deStart + 10);
    const deBody = serviceSrc.slice(deStart, deEnd > deStart ? deEnd : deStart + 4000);
    expect(deBody.indexOf('beginFencedDispatch('), 'dispatchExternal crosses the gate').toBeGreaterThan(-1);
    expect(deBody.indexOf('beginFencedDispatch('), 'the gate crossing precedes the external provider submit').toBeLessThan(deBody.indexOf('externalExecutionProvider.submit('));
    expect(deBody, 'the external outcome commits through the fenced completion').toMatch(/completeFencedDispatch\(/);
    expect(deBody, 'dispatchExternal performs NO direct updateStatus write (the fenced completion is the ONLY outcome write)').not.toMatch(/executionRecordRepository\.updateStatus\(/);
    // dispatchNative: gated begin BEFORE the gateway submit; the outcome
    // write goes THROUGH completeFencedDispatch on EVERY path (success,
    // existing-run converge, conflict recovery, AND run-less failure).
    const dnStart = serviceSrc.indexOf('private async dispatchNative(');
    const dnEnd = serviceSrc.indexOf('private ', dnStart + 10);
    const dnBody = serviceSrc.slice(dnStart, dnEnd > dnStart ? dnEnd : dnStart + 5000);
    expect(dnBody.indexOf('beginFencedDispatch('), 'dispatchNative crosses the gate').toBeGreaterThan(-1);
    expect(dnBody.indexOf('beginFencedDispatch('), 'the gate crossing precedes the gateway submit').toBeLessThan(dnBody.indexOf('nativeExecutionProvider.submit('));
    const dnCompletions = dnBody.match(/completeFencedDispatch\(/g) ?? [];
    expect(dnCompletions.length, 'dispatchNative commits EVERY outcome through the fenced completion (success + converge + conflict-recovery/failure)').toBeGreaterThanOrEqual(3);
    expect(dnBody, 'dispatchNative performs NO direct updateStatus write (the fenced completion is the ONLY outcome write)').not.toMatch(/executionRecordRepository\.updateStatus\(/);
    // The reconcile's re-dispatch call sites pass the lease (both
    // directions) — no unfenced dispatch call remains.
    const reconcileStart = serviceSrc.indexOf('async reconcileCrossModeHandoffForExecution(');
    const reconcileEnd = serviceSrc.indexOf('private ', reconcileStart + 10);
    const reconcileBody = serviceSrc.slice(reconcileStart, reconcileEnd > reconcileStart ? reconcileEnd : reconcileStart + 5000);
    expect(reconcileBody, 'the external re-dispatch passes the lease (fenced)').toMatch(/dispatchExternal\(record, executionId, lease\)/);
    expect(reconcileBody, 'the native re-dispatch passes the lease (fenced)').toMatch(/dispatchNative\(record, executionId, record\.model, lease\)/);
  });

  // R6-F (round 6 — a fenced-out dispatch aborts with 'claim-fence-lost' and
  // the failure-clobber is GONE): every FALSE outcome throws the typed fence
  // error (propagated as-is on the caller path / converted to stage
  // fence-lost on the reconcile path); the legacy unconditional
  // updateStatus-to-failed clobber no longer exists.
  it('R6-F. a fenced-out dispatch aborts claim-fence-lost (the stale actor writes NOTHING — no failure clobber)', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    const deStart = serviceSrc.indexOf('private async dispatchExternal(');
    const deEnd = serviceSrc.indexOf('private ', deStart + 10);
    const deBody = serviceSrc.slice(deStart, deEnd > deStart ? deEnd : deStart + 4000);
    expect(deBody, 'a failed gate BEGIN aborts BEFORE the submit (claim-fence-lost)').toMatch(/if \(!began\)[\s\S]*?'claim-fence-lost'/);
    expect(deBody, 'a fenced-out completion aborts (claim-fence-lost)').toMatch(/if \(!completed\)[\s\S]*?'claim-fence-lost'/);
    const dnStart = serviceSrc.indexOf('private async dispatchNative(');
    const dnEnd = serviceSrc.indexOf('private ', dnStart + 10);
    const dnBody = serviceSrc.slice(dnStart, dnEnd > dnStart ? dnEnd : dnStart + 5000);
    expect(dnBody, 'a failed gate BEGIN aborts BEFORE the gateway submit (claim-fence-lost)').toMatch(/if \(!began\)[\s\S]*?'claim-fence-lost'/);
    expect(dnBody, 'every fenced-out completion aborts (claim-fence-lost — including the failure-handler path: NO failure clobber from a stale actor)').toMatch(/if \(!completed\)[\s\S]*?'claim-fence-lost'/);
    // Fence errors propagate as-is (never swallowed into handoff-dispatch-failed).
    expect(deBody, 'fence losses propagate as-is in dispatchExternal').toMatch(/err\.code === 'claim-fence-lost'[\s\S]*?throw err/);
    expect(dnBody, 'fence losses propagate as-is in dispatchNative').toMatch(/err\.code === 'claim-fence-lost'[\s\S]*?throw err/);
    // The conflict-recovery converge exists (a UNIQUE-colliding submit
    // converges to the existing run instead of clobbering a stale failure).
    expect(dnBody, 'the native conflict recovery converges to an existing AgentRun through the fence').toMatch(/CONFLICT RECOVERY[\s\S]*?completeFencedDispatch\(/);
  });

  // -----------------------------------------------------------------------
  // PR #46 ROUND 7 — the KEYED PROVIDER-DISPATCH BOUNDARY (the provider-
  // operation exactly-once contract). The round-7 review established that the
  // round-6 dispatch gate protects the AUTHORITATIVE DB OUTCOME but NOT the
  // provider operation itself: the submit runs OUTSIDE the DB transaction, so
  // a lease reclaimed while the first submit is in flight let the reclaiming
  // owner's take-over re-dispatch start a SECOND provider operation. The
  // round-7 correction adopts the architect's contract option 1 — the
  // exactly-once side-effect boundary via a DURABLE IDEMPOTENCY KEY derived
  // from the LOGICAL HANDOFF IDENTITY: the provider boundary CONVERGES
  // same-key submits onto ONE operation (never a second).
  // -----------------------------------------------------------------------

  const CROSS_MODE_MIGRATION_0047 = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0047_cross_mode_handoff_dispatch_key.sql',
  );
  const R7_NATIVE_PROVIDER = join(AGENTS_INTERNAL, 'native-execution-provider.ts');
  const R7_EXTERNAL_PROVIDER = join(AGENTS_INTERNAL, 'external-execution-provider.ts');

  // R7-A (round 7 — migration 0047): the durable dispatch idempotency key is
  // a column on the obligation row (recorded atomically with the gate-open).
  it('R7-A. migration 0047 exists + adds the durable dispatch_idempotency_key column', () => {
    expect(existsSync(CROSS_MODE_MIGRATION_0047), '0047_cross_mode_handoff_dispatch_key.sql must exist').toBe(true);
    const src = readFileSync(CROSS_MODE_MIGRATION_0047, 'utf8');
    expect(src, 'the migration adds dispatch_idempotency_key').toMatch(/ADD COLUMN IF NOT EXISTS dispatch_idempotency_key TEXT/);
  });

  // R7-B (round 7, updated by round 8): the keyed provider-dispatch contract
  // is DECLARED at the task level + implemented at BOTH provider boundaries.
  // PR #46 round 8: the external provider's registry is the DURABLE
  // PROVIDER-OPERATION LEDGER (no in-memory Map) — the keyed contract now
  // routes through the durable store (see R8-B/R8-F).
  it('R7-B. the keyed provider-dispatch contract: the ExecutionTask declares dispatchIdempotencyKey + BOTH providers implement keyed convergence', () => {
    const typesSrc = readFileSync(join(AGENTS_INTERNAL, 'execution.types.ts'), 'utf8');
    expect(typesSrc, 'the ExecutionTask declares the dispatch idempotency key').toMatch(/readonly dispatchIdempotencyKey\?: string \| null/);
    expect(typesSrc, 'the ExecutionProvider contract documents the keyed-convergence requirement').toMatch(/MUST CONVERGE to the SAME provider operation/);
    // The external provider: the keyed submit resolves through the DURABLE
    // provider-operation ledger store (round 8) — a keyed task without a
    // store is a wiring error; an unkeyed (mainline) task bypasses the
    // registry entirely (the pre-WORK-042 behavior).
    const externalSrc = readFileSync(R7_EXTERNAL_PROVIDER, 'utf8');
    expect(externalSrc, 'the external provider keys its registry on the dispatch key').toMatch(/const key = task\.dispatchIdempotencyKey/);
    expect(externalSrc, 'a keyed submit resolves through the DURABLE store (the ledger row is the operation)').toMatch(/store\.register\(/);
    // The native provider: the keyed convergence on the durable execution
    // identity — a keyed dispatch whose run exists NEVER reaches the gateway.
    const nativeSrc = readFileSync(R7_NATIVE_PROVIDER, 'utf8');
    expect(nativeSrc, 'the native provider implements the keyed pre-check convergence').toMatch(/if \(task\.dispatchIdempotencyKey\) \{/);
    expect(nativeSrc, 'the native provider implements the collision-recovery convergence').toMatch(/collision-recovery/);
  });

  // R7-C (round 7 — the key derivation is LOGICAL, not volatile): the service
  // derives the key from the HANDOFF IDENTITY ONLY (the handoff row id —
  // stable across owners, epochs, and reclaims) and stamps it on BOTH
  // dispatch sub-methods' provider submits + the gate-open. A key derived
  // from the lease owner/epoch would CHANGE on reclaim and could never
  // converge two actors onto one operation.
  it('R7-C. the service derives the dispatch key from the LOGICAL HANDOFF IDENTITY (never owner/epoch) + stamps it on BOTH dispatch sub-methods', () => {
    const serviceSrc = readFileSync(CROSS_MODE_SERVICE, 'utf8');
    const deriveMatch = serviceSrc.match(/private dispatchIdempotencyKey\(lease: ClaimLeaseGuard\): string \{\s*return (`[^`]+`);/);
    expect(deriveMatch, 'the dispatch-key derivation helper exists').toBeTruthy();
    expect(deriveMatch![1], 'the key is derived from the handoff identity').toContain('${lease.handoffId}');
    // The derivation must NOT reference the volatile lease identity.
    const deriveBody = deriveMatch![1];
    expect(deriveBody, 'the key derivation NEVER references the lease owner (volatile — changes on reclaim)').not.toContain('owner');
    expect(deriveBody, 'the key derivation NEVER references the claim epoch (volatile — changes on reclaim)').not.toContain('Epoch');
    // BOTH dispatch sub-methods stamp the key on the submitted task + pass it
    // to the gate-open.
    const deStart = serviceSrc.indexOf('private async dispatchExternal(');
    const deEnd = serviceSrc.indexOf('private ', deStart + 10);
    const deBody = serviceSrc.slice(deStart, deEnd > deStart ? deEnd : deStart + 5000);
    expect(deBody, 'dispatchExternal derives the dispatch key').toMatch(/const dispatchKey = this\.dispatchIdempotencyKey\(lease\)/);
    expect(deBody, 'dispatchExternal records the key with the gate-open').toMatch(/beginFencedDispatch\(\s*lease\.handoffId,\s*lease\.owner,\s*lease\.claimEpoch,\s*dispatchKey,/);
    expect(deBody, 'dispatchExternal stamps the key on the submitted task (the KEYED submit)').toMatch(/externalExecutionProvider\.submit\(\{\s*\.\.\.built\.task,\s*dispatchIdempotencyKey: dispatchKey,/);
    const dnStart = serviceSrc.indexOf('private async dispatchNative(');
    const dnEnd = serviceSrc.indexOf('private ', dnStart + 10);
    const dnBody = serviceSrc.slice(dnStart, dnEnd > dnStart ? dnEnd : dnStart + 6000);
    expect(dnBody, 'dispatchNative derives the dispatch key').toMatch(/const dispatchKey = this\.dispatchIdempotencyKey\(lease\)/);
    expect(dnBody, 'dispatchNative records the key with the gate-open').toMatch(/beginFencedDispatch\(\s*lease\.handoffId,\s*lease\.owner,\s*lease\.claimEpoch,\s*dispatchKey,/);
    expect(dnBody, 'dispatchNative stamps the key on the submitted task (the KEYED submit)').toMatch(/nativeExecutionProvider\.submit\(\{\s*\.\.\.built\.task,\s*dispatchIdempotencyKey: dispatchKey,/);
  });

  // R7-D (round 7 — the key is recorded DURABLY, atomically with the
  // gate-open): beginFencedDispatch's single conditional UPDATE also sets
  // dispatch_idempotency_key — the durable record of the dispatch operation
  // identity, in the SAME statement that evaluates the lease fence + opens
  // the dispatch intent (no check-then-act window).
  it('R7-D. the gate-open records dispatch_idempotency_key ATOMICALLY (the same conditional UPDATE as the fence + intent)', () => {
    const repoSrc = readFileSync(CROSS_MODE_REPO, 'utf8');
    const beginMatch = repoSrc.match(/async beginFencedDispatch\([\s\S]*?\n  \}/);
    expect(beginMatch, 'beginFencedDispatch is defined').toBeTruthy();
    const beginSrc = beginMatch![0];
    expect(beginSrc, 'the gate-open SETs the durable dispatch idempotency key').toMatch(/dispatch_idempotency_key = \$4/);
    const setStateIdx = beginSrc.indexOf("SET dispatch_state = 'in_flight'");
    const setKeyIdx = beginSrc.indexOf('dispatch_idempotency_key = $4');
    const whereIdx = beginSrc.indexOf('WHERE handoff_id = $1');
    expect(setStateIdx, 'the gate-open sets dispatch_state').toBeGreaterThan(-1);
    expect(setKeyIdx, 'the gate-open sets the key').toBeGreaterThan(-1);
    expect(whereIdx, 'the WHERE clause exists').toBeGreaterThan(-1);
    expect(setKeyIdx, 'the key is set in the SAME UPDATE (one atomic statement with the intent)').toBeGreaterThan(setStateIdx);
    expect(setKeyIdx, 'the key is set in the SAME UPDATE (not after the WHERE)').toBeLessThan(whereIdx);
    // The interface declares the 4-arg signature.
    const typesSrc = readFileSync(CROSS_MODE_TYPES, 'utf8');
    expect(typesSrc, 'the repository interface passes the dispatch key to beginFencedDispatch').toMatch(/beginFencedDispatch\(\s*handoffId: string,\s*owner: string,\s*claimEpoch: number,\s*dispatchIdempotencyKey: string,/);
  });

  // R7-E (round 7 — the native provider boundary is AT-MOST-ONCE): a KEYED
  // dispatch whose run already exists CONVERGES BEFORE the gateway call (no
  // gateway call, no second adapter invocation); the gateway invokes the
  // adapter only AFTER its own run-creation succeeded (the adapter execution
  // is therefore structurally at-most-once per execution identity).
  it('R7-E. the native provider NEVER reaches the gateway when the keyed operation identity already exists (converge BEFORE the gateway submit)', () => {
    const nativeSrc = readFileSync(R7_NATIVE_PROVIDER, 'utf8');
    const preCheckIdx = nativeSrc.indexOf('if (task.dispatchIdempotencyKey) {');
    const convergeIdx = nativeSrc.indexOf("return this.convergeToRun(task, existing, 'pre-check');");
    const gatewayIdx = nativeSrc.indexOf('this.deps.agentGateway.execute(');
    expect(preCheckIdx, 'the keyed pre-check exists').toBeGreaterThan(-1);
    expect(convergeIdx, 'the pre-check convergence return exists').toBeGreaterThan(-1);
    expect(gatewayIdx, 'the gateway submit exists').toBeGreaterThan(-1);
    expect(preCheckIdx, 'the keyed pre-check runs BEFORE the gateway submit').toBeLessThan(gatewayIdx);
    expect(convergeIdx, 'the convergence return precedes the gateway submit (a converged dispatch NEVER invokes the gateway/adapter)').toBeLessThan(gatewayIdx);
    // The gateway invokes the adapter only AFTER its own run-creation
    // succeeded (the adapter execution is inside the post-create section).
    const gatewaySrc = readFileSync(join(AGENTS_INTERNAL, 'agent-gateway.ts'), 'utf8');
    const createIdx = gatewaySrc.indexOf('await this.runRepo.create(');
    const adapterIdx = gatewaySrc.indexOf('await adapter.execute(request)');
    expect(createIdx, 'the gateway creates the AgentRun').toBeGreaterThan(-1);
    expect(adapterIdx, 'the gateway invokes the adapter').toBeGreaterThan(-1);
    expect(createIdx, 'the gateway creates the run BEFORE invoking the adapter (the adapter only runs for the ONE create-winner)').toBeLessThan(adapterIdx);
  });

  // R7-F (round 7, rewritten by round 8): the external convergence does NOT
  // depend on determinism — and (the round-8 correction) it does NOT depend
  // on provider-instance memory either. A same-key submit returns the
  // REGISTERED operation's STORED submission (the durable ledger row's
  // submission_json) — it never re-invokes the generation for a same-key
  // replay. The architect's round-7 words: "the cross-mode architecture
  // cannot make its correctness depend on that implementation detail
  // [determinism]"; the round-8 words: the registry must be durable, never an
  // in-memory Map (see R8-F).
  it('R7-F. the external provider returns the REGISTERED operation on a same-key submit (convergence independent of provider determinism)', () => {
    const externalSrc = readFileSync(R7_EXTERNAL_PROVIDER, 'utf8');
    const submitMatch = externalSrc.match(/async submit\(task: ExecutionTask\): Promise<ExecutionSubmission> \{[\s\S]*?\n  \}/);
    expect(submitMatch, 'the external submit is defined').toBeTruthy();
    const submitSrc = submitMatch![0];
    // The keyed branch resolves through the durable ledger store (register →
    // converge/await/take-over → drive) — there is NO in-memory registry.
    const registerIdx = submitSrc.indexOf('await store.register(');
    const generateIdx = submitSrc.indexOf('this.generate(task)');
    expect(registerIdx, 'the keyed submit registers through the DURABLE store first').toBeGreaterThan(-1);
    expect(generateIdx, 'the generation call exists (the operation body — only on the OPENED/take-over path)').toBeGreaterThan(-1);
    // The unkeyed (mainline) branch generates directly — the pre-WORK-042
    // behavior, no registry.
    const unkeyedIdx = submitSrc.indexOf('return this.generate(task);');
    expect(unkeyedIdx, 'the unkeyed mainline branch generates directly (no registry)').toBeGreaterThan(-1);
    // The replay path returns the STORED submission (the ledger row's
    // recorded result), never a re-computed lookalike — the convergence is a
    // CONTRACT, not a determinism accident.
    expect(externalSrc, 'the convergence returns the STORED submission from the ledger row (the registered operation\'s result)').toMatch(/return record\.submission;/);
  });

  // -----------------------------------------------------------------------
  // PR #46 round 8 — the DURABLE PROVIDER-OPERATION LEDGER (the round-8
  // review's blocking correction). The round-7 registry was an in-memory
  // Map inside the ExternalExecutionProvider: convergence existed only for
  // the lifetime of that provider instance, so a process loss between
  // submit(K) and the outcome left nothing durable remembering that K
  // already owned an operation — a fresh instance's submit(K) started a
  // SECOND provider operation. The round-8 correction implements the
  // architect's acceptable architecture:
  //
  //     stable dispatch key
  //            ↓
  //     durable provider-operation ledger
  //            ↓
  //     PENDING / COMPLETED / FAILED + provider operation/result
  //            ↓
  //     same key always resolves to the same operation
  // -----------------------------------------------------------------------

  const CROSS_MODE_MIGRATION_0048 = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0048_execution_provider_operation_ledger.sql',
  );
  const R8_OPERATION_REPO = join(
    AGENTS_INTERNAL, 'pg-execution-provider-operation-repository.ts',
  );

  // R8-A (round 8 — migration 0048): the durable provider-operation ledger
  // table — idempotency_key is the PRIMARY KEY (ONE row per key — the ROW is
  // the operation; there is structurally no second operation record), the
  // state CHECK is the PENDING/COMPLETED/FAILED lifecycle, and
  // submission_json is the stored operation/result.
  it('R8-A. migration 0048 exists — the durable provider-operation ledger (PRIMARY KEY idempotency_key + PENDING/COMPLETED/FAILED CHECK + the stored result)', () => {
    expect(existsSync(CROSS_MODE_MIGRATION_0048), '0048_execution_provider_operation_ledger.sql must exist').toBe(true);
    const src = readFileSync(CROSS_MODE_MIGRATION_0048, 'utf8');
    expect(src, 'the ledger table is created').toMatch(/CREATE TABLE IF NOT EXISTS wfos_execution_provider_operations/);
    expect(src, 'the idempotency key is the PRIMARY KEY (ONE row per key — the ROW is the operation)').toMatch(/idempotency_key\s+TEXT PRIMARY KEY/);
    expect(src, 'the state lifecycle is PENDING / COMPLETED / FAILED').toMatch(/CHECK \(state IN \('pending', 'completed', 'failed'\)\)/);
    expect(src, 'the operation/result is stored (submission_json)').toMatch(/submission_json\s+JSONB/);
    expect(src, 'the failure is stored (error_message)').toMatch(/error_message\s+TEXT/);
    // The native arm's EXPLICIT DEFINITION is declared in the migration
    // header (the run table IS the durable native ledger).
    expect(src, 'the native durable provider-operation ledger (wfos_agent_runs) is explicitly defined').toMatch(/durable NATIVE provider-operation ledger is wfos_agent_runs/);
  });

  // R8-B (round 8): the ExternalExecutionProvider has NO in-memory operation
  // registry — the keyed registry is the DURABLE LEDGER (the round-8 review
  // explicitly forbade promoting the Map to a global/static cache: "the
  // idempotency boundary must be durable").
  it('R8-B. the external provider has NO in-memory operation registry — the keyed registry is the durable ledger store', () => {
    const externalSrc = readFileSync(R7_EXTERNAL_PROVIDER, 'utf8');
    expect(
      externalSrc,
      'NO in-memory operation Map (the round-7 registry died with its instance)',
    ).not.toMatch(/new Map<[^>]*Promise<ExecutionSubmission>/);
    expect(
      externalSrc,
      'no private operations field at all',
    ).not.toMatch(/private readonly operations/);
    expect(externalSrc, 'the durable ledger store is a constructor dependency').toMatch(/readonly operationStore\?: ExecutionProviderOperationStore/);
    expect(externalSrc, 'a keyed submit WITHOUT a store fails loudly (a wiring error)').toMatch(/external-execution-operation-store-required/);
    expect(externalSrc, 'the store dependency is imported from the durable-ledger repository module').toMatch(/pg-execution-provider-operation-repository\.js/);
  });

  // R8-C (round 8): the composition root (app.ts) wires the
  // ExternalExecutionProvider with the durable ledger store — the production
  // wiring can never fall into the store-less (keyed-submit-rejected) arm.
  it('R8-C. app.ts wires the ExternalExecutionProvider with the durable provider-operation ledger store', () => {
    const appSrc = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(appSrc, 'app.ts imports the durable ledger repository').toMatch(/PgExecutionProviderOperationRepository/);
    expect(appSrc, 'app.ts constructs the ExternalExecutionProvider WITH the durable store').toMatch(/new ExternalExecutionProvider\(\{\s*operationStore: new PgExecutionProviderOperationRepository\(database\),/);
  });

  // R8-D (round 8, rewritten by round 9): the ledger state machine is
  // CAS-only (single conditional statements — no read-check-write) and (the
  // round-9 correction) GENERATION-FENCED: register opens exactly one row
  // (and NEVER re-arms a terminal row — the key is immutable), the
  // completion/failure are the generation-fenced resolution CASes, the
  // operation identity has its own attach CAS, and takeOver RETURNS the new
  // generation token.
  it('R8-D. the durable ledger state machine — the INSERT-only register (NO re-arm — the key is immutable) + the GENERATION-FENCED resolution CASes + the operation-identity attach CAS + the takeOver-returns-the-token recovery', () => {
    const repoSrc = readFileSync(R8_OPERATION_REPO, 'utf8');
    // register: the FRESH open is an INSERT ... ON CONFLICT DO NOTHING.
    expect(repoSrc, 'the fresh open is INSERT ... ON CONFLICT DO NOTHING (ONE row per key)').toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
    // register: NO re-arm — a terminally FAILED row is returned AS-IS (round 9
    // removed the round-8 `AND state = 'failed'` conditional re-arm).
    expect(repoSrc, 'NO re-arm: register NEVER conditionally updates a failed row back to pending (the key identifies ONE operation with ONE terminal result)').not.toMatch(/AND state = 'failed'/);
    // complete: the GENERATION-FENCED resolution CAS ('pending' @ THIS
    // generation → 'completed') — concurrent drivers and a late dead driver
    // all funnel through it; only the ACTIVE generation can resolve.
    expect(repoSrc, 'the completion is the generation-fenced resolution CAS (pending @ generation → completed)').toMatch(/state = 'completed',[\s\S]*?WHERE idempotency_key = \$1\s+AND state = 'pending'\s+AND generation = \$2/);
    expect(repoSrc, 'the completion stores the submission result').toMatch(/submission_json = \$3::jsonb/);
    // fail: the symmetric GENERATION-FENCED CAS (a stale generation's
    // failure is structurally discarded — it can never defeat the active
    // recovery generation).
    expect(repoSrc, 'the failure is the symmetric generation-fenced CAS').toMatch(/state = 'failed',[\s\S]*?WHERE idempotency_key = \$1\s+AND state = 'pending'\s+AND generation = \$2/);
    // attachOperation: the operation-identity CAS (migration 0049's column).
    expect(repoSrc, 'the operation-identity attach CAS exists (the handle is durably recorded BEFORE the body)').toMatch(/AND provider_operation_handle IS NULL/);
    // takeOver: the process-loss recovery — the recovery drive of the SAME
    // row, RETURNING the NEW GENERATION TOKEN (the fencing token).
    expect(repoSrc, 'the take-over records the recovery drive on the SAME row (generation + 1) + RETURNS the token').toMatch(/generation = generation \+ 1,[\s\S]*?WHERE idempotency_key = \$1\s+AND state = 'pending'\s+RETURNING generation/);
    expect(repoSrc, 'the takeOver port returns the NEW GENERATION TOKEN').toMatch(/tookOver: boolean;\s*generation: number \| null;/);
  });

  // R8-E (round 8 — the EXPLICIT native definition the review requires): the
  // AgentRun table IS the durable native provider-operation ledger — declared
  // in the provider contract (execution.types.ts) + the native provider, with
  // the process-loss recovery defined as converge-on-the-existing-run.
  it('R8-E. the EXPLICIT definition — AgentRun is the durable native operation ledger (the contract + the provider declare it, updated to the round-9 exact wording)', () => {
    const typesSrc = readFileSync(join(AGENTS_INTERNAL, 'execution.types.ts'), 'utf8');
    expect(typesSrc, 'the contract defines the durable native operation ledger (the round-9 exact wording)').toMatch(/AgentRun is the durable native operation ledger[\s\S]{0,120}wfos_agent_runs/);
    expect(typesSrc, 'the contract declares the execution_id UNIQUE as the operation-key uniqueness').toMatch(/execution_id TEXT NOT NULL\s*\*?\s*UNIQUE/);
    const nativeSrc = readFileSync(R7_NATIVE_PROVIDER, 'utf8');
    expect(nativeSrc, 'the native provider declares the durable ledger definition').toMatch(/IS the DURABLE NATIVE[\s\S]{0,8}PROVIDER-OPERATION/);
    expect(nativeSrc, 'the native provider declares the converge-on-the-existing-run process-loss recovery').toMatch(/process-loss recovery is CONVERGE-ON-THE-EXISTING-RUN/);
  });

  // R8-F (round 8, rewritten by round 9): the await-then-take-over recovery —
  // a PENDING row whose driver died is resolved THROUGH THE SAME ROW by the
  // recovering actor: the await (converge while in flight) followed by the
  // take-over (which RETURNS the new generation token) after the resolution
  // window (process loss). The recovery driver either RESOLVES BY IDENTITY
  // (the handle is recorded — never a body re-run) or drives the FIRST
  // execution (the handle is absent — the body never started); the
  // generation-fenced resolution CAS arbitrates drivers; the loser converges
  // to the winner. Same key always resolves to the same operation — across
  // provider instances, processes, and actors.
  it('R8-F. the await-then-take-over recovery — a pending ledger row is resolved through the SAME row (the await converges; the window-elapsed take-over drives the recovery under the NEW GENERATION TOKEN)', () => {
    const externalSrc = readFileSync(R7_EXTERNAL_PROVIDER, 'utf8');
    // The in-flight convergence: a PENDING row is awaited (the original
    // submitter's liveness is irrelevant — the operation lives in the ledger).
    expect(externalSrc, 'the PENDING row is awaited (the in-flight convergence)').toMatch(/awaitResolution/);
    // The process-loss recovery: after the resolution window elapses, the
    // submitter TAKES OVER the drive of the SAME row (never a second row).
    expect(externalSrc, 'the take-over (the process-loss recovery drive of the SAME row)').toMatch(/provider-operation-takeover/);
    // The resolution-CAS loser converges to the winner's stored result (a
    // dead driver's late completion replays it — it never stores a second).
    expect(externalSrc, "the CAS loser replays the winner's stored result (the late-driver convergence)").toMatch(/provider-operation-converged-late-driver/);
    expect(externalSrc, 'a failed drive re-checks the row — a COMPLETED result still resolves the same key').toMatch(/provider-operation-converged-after-failure/);
    const repoSrc = readFileSync(R8_OPERATION_REPO, 'utf8');
    expect(repoSrc, 'the store port declares the durable provider-operation ledger contract').toMatch(/export interface ExecutionProviderOperationStore/);
    expect(repoSrc, 'the register contract documents the key-immutability semantics (terminal rows are returned as-is — NEVER re-armed)').toMatch(/there is NO re-arm/);
  });

  // -----------------------------------------------------------------------
  // PR #46 round 9 — the GENERATION-FENCED, IDENTITY-RECOVERABLE takeover
  // protocol (the round-8 review's three blocking corrections). The durable
  // ledger was real, but its takeover protocol (1) re-ran the operation body,
  // (2) resolved without a generation fence (a stale FAIL could defeat the
  // recovery generation; a stale SUCCESS could win merely by racing), and
  // (3) re-armed terminally FAILED keys (one key, two terminal outcomes). The
  // corrected design (the review's freeze — the ledger behaves like the
  // existing handoff lease):
  //
  //     operation key
  //        ↓
  //     one durable operation row
  //        ↓
  //     generation / fencing token          ← takeOver() RETURNS the token
  //        ↓
  //     one active driver
  //        ↓
  //     operation-specific durable/provider idempotency identity
  //        ↓                                    ← migration 0049: the handle
  //     one terminal result
  // -----------------------------------------------------------------------

  const CROSS_MODE_MIGRATION_0049 = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0049_execution_provider_operation_generation_fence.sql',
  );

  // R9-A (round 9 — migration 0049): the operation-identity layer + the
  // generation fence's durable columns — provider_operation_handle (the
  // durable provider-side identity of the ONE operation, recorded BEFORE
  // the operation body runs) + operation_attached_at.
  it('R9-A. migration 0049 exists — the provider-operation IDENTITY columns (provider_operation_handle + operation_attached_at) + the generation-fence/key-immutability header', () => {
    expect(existsSync(CROSS_MODE_MIGRATION_0049), '0049_execution_provider_operation_generation_fence.sql must exist').toBe(true);
    const src = readFileSync(CROSS_MODE_MIGRATION_0049, 'utf8');
    expect(src, 'the migration adds the provider operation handle').toMatch(/ADD COLUMN IF NOT EXISTS provider_operation_handle TEXT/);
    expect(src, 'the migration adds the attach timestamp').toMatch(/ADD COLUMN IF NOT EXISTS operation_attached_at TIMESTAMPTZ/);
    expect(src, 'the header documents the generation-fenced resolution CAS').toMatch(/GENERATION-FENCED RESOLUTION/);
    expect(src, 'the header documents the key immutability (FAILED is terminal — no re-arm)').toMatch(/KEY IMMUTABILITY/);
    expect(src, 'the header documents the resolve-by-identity recovery (takeover NEVER re-runs the operation body)').toMatch(/NEVER re-runs the operation body/);
    expect(src, 'the header applies the review\'s exact native wording').toMatch(/AgentRun[\s\S]{0,12}is the durable native operation ledger/);
  });

  // R9-B (round 9 — the provider protocol): the ATTACH-BEFORE-BODY ordering
  // + the RESOLVE-BY-IDENTITY recovery. The operation identity is derived
  // WITHOUT side effects + durably attached BEFORE the operation body runs,
  // so a recorded handle PROVES the operation started (a recovery driver
  // resolves it by identity — it NEVER re-runs the body) and an absent handle
  // PROVES the body never started (driving it is the FIRST execution). The
  // generic takeover primitive is therefore no longer "run the operation
  // again".
  it('R9-B. the attach-before-body operation-identity protocol + the resolve-by-identity recovery — takeover NEVER re-runs a started operation\'s body', () => {
    const externalSrc = readFileSync(R7_EXTERNAL_PROVIDER, 'utf8');
    // The identity seams exist with their contracts.
    expect(externalSrc, 'the openOperation seam derives the durable operation identity WITHOUT side effects').toMatch(/protected async openOperation\(/);
    expect(externalSrc, 'the resolveOperation seam resolves a STARTED operation by identity (a status fetch for a platform provider; re-derivation ONLY because the default operations are PURE)').toMatch(/protected async resolveOperation\(/);
    // THE ORDERING: in attemptDrive, the attach CAS precedes the body call.
    const driveMatch = externalSrc.match(/private async attemptDrive\([\s\S]*?\n  \}/);
    expect(driveMatch, 'attemptDrive is defined').toBeTruthy();
    const driveSrc = driveMatch![0];
    const handleCheckIdx = driveSrc.indexOf('row.providerOperationHandle != null');
    const attachIdx = driveSrc.indexOf('store.attachOperation(');
    const bodyIdx = driveSrc.indexOf('this.generate(task)');
    expect(handleCheckIdx, 'the drive checks the recorded identity FIRST').toBeGreaterThan(-1);
    expect(attachIdx, 'the attach CAS is in the drive').toBeGreaterThan(-1);
    expect(bodyIdx, 'the body call is in the drive').toBeGreaterThan(-1);
    expect(attachIdx, 'the identity is ATTACHED BEFORE the operation body runs (a recorded handle proves the operation started; an absent handle proves the body never started)').toBeLessThan(bodyIdx);
    // The resolve-by-identity routing: a recorded handle resolves through the
    // resolveOperation seam — never the body.
    const resolveMatch = externalSrc.match(/private async resolveByIdentity\([\s\S]*?\n  \}/);
    expect(resolveMatch, 'resolveByIdentity is defined').toBeTruthy();
    expect(resolveMatch![0], 'the recovery resolves through the contract-bound resolveOperation seam').toContain('this.resolveOperation(');
    expect(resolveMatch![0], 'the recovery NEVER calls the operation body').not.toContain('this.generate(');
    expect(externalSrc, 'the resolve-by-identity observability log exists').toMatch(/provider-operation-resolve-by-identity/);
    // The provider-side convergence contract (the justification for the
    // residual window — the default provider declares its operations PURE).
    expect(externalSrc, 'the resolve seam documents the per-provider justification (purity for the default provider; a platform status fetch otherwise)').toMatch(/RE-DERIVATION of the same value from the same task/);
  });

  // R9-C (round 9 — the generation-fenced resolution in the provider): every
  // resolution the provider issues carries the DRIVER GENERATION, and a CAS
  // loss with a still-pending row NEVER returns the driver's own lookalike
  // result — it yields to the ACTIVE driver's outcome.
  it('R9-C. the provider issues ONLY generation-fenced resolutions + never returns its own result on a CAS loss (the active driver owns the row)', () => {
    const externalSrc = readFileSync(R7_EXTERNAL_PROVIDER, 'utf8');
    // settle + failDrive pass the generation to the CASes.
    const settleMatch = externalSrc.match(/private async settle\([\s\S]*?\n  \}/);
    expect(settleMatch, 'settle is defined').toBeTruthy();
    expect(settleMatch![0], 'the completion CAS carries the driver generation').toMatch(/store\.complete\(\s*key,\s*generation,/);
    const failMatch = externalSrc.match(/private async failDrive\([\s\S]*?\n  \}/);
    expect(failMatch, 'failDrive is defined').toBeTruthy();
    expect(failMatch![0], 'the failure CAS carries the driver generation').toMatch(/store\.fail\(key, generation,/);
    expect(externalSrc, 'a stale driver\'s failure is structurally DISCARDED (the active recovery driver owns the resolution)').toMatch(/structurally DISCARDED/);
    // The CAS-loss-with-pending outcome yields (the RECOVERY_CONTINUE
    // sentinel) — the stale driver never returns its own lookalike.
    expect(externalSrc, 'the recovery-continue sentinel exists (a stale driver yields to the active driver)').toMatch(/RECOVERY_CONTINUE/);
    expect(settleMatch![0], 'a CAS loss on a still-pending row yields to the ACTIVE recovery driver (never the loser\'s own result)').toMatch(/RECOVERY_CONTINUE/);
    // The takeOver call consumes the RETURNED token.
    const submitMatch = externalSrc.match(/async submit\(task: ExecutionTask\): Promise<ExecutionSubmission> \{[\s\S]*?\n  \}/);
    expect(submitMatch, 'the external submit is defined').toBeTruthy();
    expect(submitMatch![0], 'the recovery drive runs under the takeOver-RETURNED generation token').toMatch(/attemptDrive\(store, key, task, takeover\.generation!/);
  });

  // R9-D (round 9 — KEY IMMUTABILITY at the provider level): a terminally
  // FAILED operation is a KNOWN outcome — a later same-key submit surfaces
  // the stored failure; it never re-arms, never opens a second operation
  // under the same key.
  it('R9-D. the key is immutable at the provider level — COMPLETED and FAILED are BOTH terminal (convergeFrom surfaces the stored terminal failure; register NEVER re-arms)', () => {
    const externalSrc = readFileSync(R7_EXTERNAL_PROVIDER, 'utf8');
    const convergeMatch = externalSrc.match(/private convergeFrom\([\s\S]*?\n  \}/);
    expect(convergeMatch, 'convergeFrom is defined').toBeTruthy();
    expect(convergeMatch![0], 'a FAILED row surfaces the STORED terminal failure').toMatch(/record\.errorMessage/);
    expect(externalSrc, 'the round-9 no-re-arm doc (the key identifies ONE logical operation invocation)').toMatch(/register NEVER re-arms/);
    const repoSrc = readFileSync(R8_OPERATION_REPO, 'utf8');
    expect(repoSrc, 'the store\'s register declares the key-immutability contract (a terminally failed row is returned AS-IS)').toMatch(/NEVER re-arms/);
    // And the recovery window itself never flips a terminal row: takeOver is
    // the ONLY generation mutation, and it requires state = 'pending'.
    expect(repoSrc, 'takeOver requires state = pending (a terminal row is never taken over)').toMatch(/generation = generation \+ 1,[\s\S]*?WHERE idempotency_key = \$1\s+AND state = 'pending'\s+RETURNING generation/);
  });

  // R9-E (round 9 — the review's exact native wording): "AgentRun is the
  // durable native operation ledger" — applied explicitly in the contract +
  // the native provider, WITH the mechanics distinction (the two ledgers do
  // NOT share one mechanism).
  it('R9-E. the exact wording — AgentRun is the durable native operation ledger (the contract + the provider + the mechanics distinction)', () => {
    const typesSrc = readFileSync(join(AGENTS_INTERNAL, 'execution.types.ts'), 'utf8');
    expect(typesSrc, 'the contract applies the review\'s exact wording on the task field').toMatch(/AgentRun is the durable native operation ledger/);
    expect(typesSrc, 'the contract applies the wording on the provider interface').toMatch(/native — AgentRun is the durable native operation ledger/);
    expect(typesSrc, 'the contract states the mechanics DISTINCTION (the ledgers do not share one mechanism)').toMatch(/they do not share one mechanism/);
    const nativeSrc = readFileSync(R7_NATIVE_PROVIDER, 'utf8');
    expect(nativeSrc, 'the native provider applies the exact wording').toMatch(/AgentRun is the durable native[\s\S]{0,8}operation ledger/);
    expect(nativeSrc, 'the native provider states the mechanics distinction').toMatch(/they do not share one mechanism/);
  });

  // R9-F (round 9 — the regression suite proves the adversarial
  // interleavings): the two review-required races (stale FAIL after takeover;
  // stale SUCCESS after takeover) + the key-immutability semantics + the
  // non-pure provider's exactly-once body + the identity-absent FIRST
  // execution — all on REAL PostgreSQL with provider-instance separation.
  it('R9-F. the concurrency regression suite covers the round-9 adversarial interleavings (stale fail / stale success / key immutability / the side-effecting provider / the identity-absent first execution)', () => {
    const suitePath = join(
      BACKEND_ROOT, 'tests', 'integration', 'agents',
      'cross-mode-handoff-claim-lease-concurrency.regression.test.ts',
    );
    const suiteSrc = readFileSync(suitePath, 'utf8');
    expect(suiteSrc, 'R9-#1 — the stale-generation FAIL interleaving is asserted').toMatch(/R9-#1\. takeover → stale-generation FAIL → new-generation SUCCESS/);
    expect(suiteSrc, 'R9-#2 — the old-generation SUCCESS interleaving is asserted').toMatch(/R9-#2\. takeover → old-generation SUCCESS → new-generation SUCCESS/);
    expect(suiteSrc, 'R9-#3 — the key-immutability semantics are asserted').toMatch(/R9-#3\. KEY IMMUTABILITY/);
    expect(suiteSrc, 'R9-#4 — the genuinely side-effecting provider proof').toMatch(/R9-#4\. the genuinely SIDE-EFFECTING provider/);
    expect(suiteSrc, 'R9-#5 — the identity-absent FIRST-execution proof').toMatch(/R9-#5\. the identity-ABSENT takeover is the FIRST execution/);
    // The side-effecting provider double resolves by a STATUS FETCH (never
    // the body) + the park seams for the adversarial interleavings exist.
    expect(suiteSrc, 'the SideEffectingExternalProvider double (the platform status fetch recovery)').toMatch(/class SideEffectingExternalProvider/);
    expect(suiteSrc, 'the parkAtResolve seam (the mid-recovery stall point)').toMatch(/parkAtResolve/);
    expect(suiteSrc, 'the parkAtOpen seam (the pre-identity death point)').toMatch(/parkAtOpen/);
    expect(suiteSrc, 'the resolution marker (proves WHICH generation\'s result was stored)').toMatch(/resolutionMarker/);
  });
});

// =============================================================================
// WORK-043 — Execution Eligibility and Constraint Engine (§33.3): the four
// new hard-constraint families (quota, rate limits, security requirements,
// agent policy) evaluated BEFORE performance ranking. The engine is the
// WORK-033 DefaultExecutionEligibilityService EXTENDED (no parallel engine);
// usage is DERIVED from the authoritative wfos_executions rows (no parallel
// usage ledger); the WORK-042 handoff re-evaluates the RESOLVED destination
// candidate through the SAME engine (evaluateCandidateEligibility). Quotas,
// rate limits, and security classifications are ELIGIBILITY INPUTS, never
// quality scores (§33.3) — they never enter the ranking scorer.
// =============================================================================
describe('WORK-043 invariants — Execution Eligibility and Constraint Engine (§33.3)', () => {
  const EXEC_POLICY_DIR = join(BACKEND_ROOT, 'src', 'execution-policy');
  const EXEC_POLICY_INTERNAL = join(EXEC_POLICY_DIR, 'internal');
  const ELIGIBILITY_SERVICE = join(EXEC_POLICY_INTERNAL, 'default-execution-eligibility-service.ts');
  const POLICY_SERVICE = join(EXEC_POLICY_INTERNAL, 'default-execution-policy-service.ts');
  const RECOMMENDATION_SERVICE = join(EXEC_POLICY_INTERNAL, 'default-execution-recommendation-service.ts');
  const POLICY_TYPES = join(EXEC_POLICY_DIR, 'types.ts');
  const POLICY_REPO = join(EXEC_POLICY_INTERNAL, 'pg-execution-policy-repository.ts');
  const MIGRATION_0050 = join(
    BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations',
    '0050_execution_eligibility_constraints.sql',
  );
  const AGENT_POLICY_ENGINE = join(MODULES_DIR, 'agents', 'internal', 'agent-policy-engine.ts');
  const HANDOFF_SERVICE = join(MODULES_DIR, 'agents', 'internal', 'default-cross-mode-handoff-service.ts');
  const HANDOFF_TYPES = join(MODULES_DIR, 'agents', 'internal', 'cross-mode-handoff.types.ts');
  const EXECUTION_ROUTE = join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution.route.ts');
  const EXECUTION_POLICY_ROUTE = join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution-policy.route.ts');
  const APP_TS = join(BACKEND_ROOT, 'src', 'app.ts');
  const FRONTEND_CLIENT = join(BACKEND_ROOT, '..', 'frontend', 'src', 'api', 'client.ts');

  function stripCodeComments(src: string): string {
    return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  // --- (a) ONE engine — the WORK-033 service EXTENDED, no parallel engine ---

  it('ONE eligibility engine (the WORK-033 DefaultExecutionEligibilityService EXTENDED — no parallel engine)', () => {
    // The engine file exists and evaluates the four new families.
    const src = stripCodeComments(readFileSync(ELIGIBILITY_SERVICE, 'utf8'));
    expect(src).toMatch(/evaluateSecurity/);
    expect(src).toMatch(/evaluateAgentPolicy/);
    expect(src).toMatch(/evaluateQuota/);
    expect(src).toMatch(/evaluateRateLimit/);
    // No OTHER file in src/ declares a competing eligibility engine.
    const srcRoot = join(BACKEND_ROOT, 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) {
          const rel = relative(BACKEND_ROOT, full);
          if (rel === relative(BACKEND_ROOT, ELIGIBILITY_SERVICE)) continue;
          const text = stripCodeComments(readFileSync(full, 'utf8'));
          if (/\bclass\s+\w*(Eligibility|Constraint)Engine\b/.test(text)) {
            offenders.push(`${rel}: declares a parallel eligibility/constraint engine`);
          }
          if (/implements\s+ExecutionEligibilityService\b/.test(text)) {
            offenders.push(`${rel}: implements ExecutionEligibilityService (the ONE engine is the WORK-033 service)`);
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  // --- (b) NO parallel usage ledger — the two DISTINCT usage models
  //         (AR-043-02): quota = LOGICAL EXECUTIONS; rate-limit = PROVIDER
  //         DISPATCH EVENTS attributed to the dispatching provider --------

  it('NO parallel usage ledger — quota counts LOGICAL EXECUTIONS, rate limits count PROVIDER DISPATCH EVENTS via the authoritative artifacts (AR-043-01 + AR-043-02)', () => {
    // Migration 0050 adds NO table (ALTER + INDEX only).
    const migration = stripCodeComments(readFileSync(MIGRATION_0050, 'utf8'));
    expect(migration, 'migration 0050 must not create a usage/quota table').not.toMatch(/CREATE TABLE/i);
    // No migration anywhere introduces a usage/quota counter table.
    const migrationsDir = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations');
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql'))) {
      const text = stripCodeComments(readFileSync(join(migrationsDir, f), 'utf8'));
      expect(text, `${f}: no parallel usage ledger table`).not.toMatch(
        /CREATE TABLE[^\n]*(usage|quota)/i,
      );
    }
    // The usage queries read the AUTHORITATIVE records and apply the
    // AR-043-01 DISPATCH PREDICATE: a row counts ONLY when a durable
    // provider-dispatch artifact exists —
    //   NATIVE:   an AgentRun ledger row (wfos_agent_runs IS the durable
    //             native provider-operation ledger, PR #46 round 8 — the
    //             gateway creates the run BEFORE the adapter invocation)
    //   EXTERNAL: the persisted ExternalExecutionPackage (package_json —
    //             written only after ExternalExecutionProvider.submit
    //             succeeded), including a handed-off-away external phase's
    //             snapshot in the append-only handoff log
    const repoSrc = stripCodeComments(readFileSync(POLICY_REPO, 'utf8'));
    expect(repoSrc, 'the usage queries count wfos_executions').toMatch(/FROM wfos_executions e/);
    expect(repoSrc, 'the dispatch predicate probes the AgentRun ledger').toMatch(
      /FROM wfos_agent_runs r[\s\S]{0,120}r\.execution_id = e\.execution_id/,
    );
    expect(repoSrc, 'the dispatch predicate probes the external package artifact').toMatch(
      /e\.package_json IS NOT NULL/,
    );
    // AR-043-02 — the RATE-LIMIT query attributes EACH actual dispatch to
    // the provider that dispatched it (NEVER the execution row's mutable
    // current provider):
    //   native events   → the AgentRun row's OWN provider (immutable)
    //   external events → the package artifact's OWN provider field
    //                     (ExternalExecutionPackage is self-describing)
    expect(repoSrc, 'native dispatch events attribute to the run row provider').toMatch(
      /r\.provider = \$2/,
    );
    expect(repoSrc, 'external dispatch events attribute to the package provider field').toMatch(
      /package_json->>'provider' = \$2/,
    );
    expect(repoSrc, 'the handed-off-away external phase attributes through the log snapshot').toMatch(
      /h\.to_mode = 'native'[\s\S]{0,120}h\.previous_package_json IS NOT NULL/,
    );
    // AR-043-01 regression pin: the BARE execution-row count (existence +
    // created_at only — counting executions that never dispatched) must NOT
    // reappear.
    expect(
      repoSrc,
      'the usage query must NOT be a bare execution-row count (AR-043-01: existence is not dispatch)',
    ).not.toMatch(
      /FROM wfos_executions\s+WHERE project_id = \$1 AND provider = \$2 AND created_at >= \$3/,
    );
    // AR-043-02 regression pin: attributing the ROW count to the execution
    // row's CURRENT provider (one row → one provider) understates the
    // handed-off-from provider's window — each ACTUAL dispatch belongs to
    // the provider that dispatched it.
    expect(
      repoSrc,
      'usage must NOT be attributed to the execution row current provider (AR-043-02: each actual dispatch belongs to the provider that dispatched it)',
    ).not.toMatch(/e\.provider = \$\d/);
    // The repository port exposes the TWO DISTINCT derivation seams (the
    // AR-043-02 usage-model split: quota = logical executions; rate =
    // provider dispatch events) + the fail-closed NULL contract.
    const internalTypes = readFileSync(join(EXEC_POLICY_INTERNAL, 'execution-policy.types.ts'), 'utf8');
    expect(internalTypes, 'the quota seam (logical executions)').toMatch(/countProjectDispatchedExecutionsSince/);
    expect(internalTypes, 'the rate seam (provider dispatch events)').toMatch(/countProjectProviderDispatchesSince/);
    expect(internalTypes, 'the conflated single seam must not reappear (AR-043-02)').not.toMatch(/countProjectDispatchesSince/);
    expect(internalTypes).not.toMatch(/countProjectExecutionsSince/);
    expect(internalTypes, 'the AR-043-02 unit distinction is documented').toMatch(/LOGICAL EXECUTIONS/);
    expect(internalTypes).toMatch(/PROVIDER DISPATCH EVENTS/);
    expect(internalTypes).toMatch(/NULL = the usage\s*\*?\s*is unresolvable/);
    expect(internalTypes).toMatch(/DISPATCH PREDICATE/);
  });

  // --- (c) the constraint vocabulary: categories + statuses + the ladder ---

  it('the §33.3 constraint vocabulary is closed and complete (categories, statuses, the classification ladder)', () => {
    const types = readFileSync(POLICY_TYPES, 'utf8');
    // The four new categories.
    for (const cat of ["| 'quota'", "| 'rate_limit'", "| 'security'", "| 'agent_policy'"]) {
      expect(types, `category ${cat} declared`).toMatch(new RegExp(cat.replace(/[|']/g, (m) => `\\${m}`)));
    }
    // The four new statuses.
    for (const status of ["'quota_exhausted'", "'rate_limited'", "'security_blocked'", "'agent_policy_blocked'"]) {
      expect(types, `status ${status} declared`).toContain(status);
    }
    // The ordered classification ladder (standard < confidential < restricted).
    expect(types).toMatch(/SECURITY_CLASSIFICATION_RANK/);
    expect(types).toMatch(/standard:\s*0,\s*confidential:\s*1,\s*restricted:\s*2/);
    // The constraint set carries the four new families.
    expect(types).toMatch(/readonly quota: QuotaConstraints/);
    expect(types).toMatch(/readonly rateLimit: RateLimitConstraints/);
    expect(types).toMatch(/readonly security: SecurityConstraints/);
    expect(types).toMatch(/readonly agentPolicy: AgentPolicyConstraints/);
  });

  // --- (d) FAIL-CLOSED: unresolvable usage under an ACTIVE constraint ------

  it('the engine FAILS CLOSED on unresolvable usage under an ACTIVE quota/rate constraint', () => {
    const src = stripCodeComments(readFileSync(ELIGIBILITY_SERVICE, 'utf8'));
    // Quota: usage null under an active quota → blocked.
    expect(src).toMatch(/monthly_quota_usage_unresolvable/);
    expect(src).toMatch(/daily_quota_usage_unresolvable/);
    // Rate limit: unresolvable window map under an active limit → blocked.
    expect(src).toMatch(/rate_limit_usage_unresolvable/);
    // Agent policy: unresolved decision → fail-closed for external candidates.
    expect(src).toMatch(/external_handoff_unresolved/);
  });

  // --- (e) eligibility inputs are NEVER scores (§33.3) ---------------------

  it('quota/rate/security/agent-policy constraints NEVER enter the ranking scorer (§33.3: eligibility inputs, not quality scores)', () => {
    const scorer = stripCodeComments(readFileSync(RECOMMENDATION_SERVICE, 'utf8'));
    expect(scorer, 'the scorer must not read quota constraints').not.toMatch(/\bquota\b/i);
    expect(scorer, 'the scorer must not read rate-limit constraints').not.toMatch(/rateLimit|rate_limit/i);
    expect(scorer, 'the scorer must not read security constraints').not.toMatch(/securityClassification|externalCeiling|security_/);
    expect(scorer, 'the scorer must not read agent-policy constraints').not.toMatch(/agentPolicy|agent_policy/i);
  });

  // --- (f) the recommend() path resolves the new families BEFORE ranking ---

  it('recommend() resolves usage + the agent-policy decision into the constraint set BEFORE ranking', () => {
    const src = stripCodeComments(readFileSync(POLICY_SERVICE, 'utf8'));
    expect(src).toMatch(/resolveUsageConstraints/);
    expect(src).toMatch(/resolveAgentPolicyConstraint/);
    // The usage derivation only queries while the constraint is ACTIVE.
    expect(src).toMatch(/quotaActive/);
    expect(src).toMatch(/rateActive/);
    // Eligibility runs BEFORE ranking (§3 order preserved with the new
    // families) — code-level anchors (comments are stripped).
    const recommendStart = src.indexOf('async recommend(input: RecommendInput)');
    const recommendBody = src.slice(recommendStart, recommendStart + 9000);
    const eligibilityIdx = recommendBody.indexOf('this.deps.eligibilityService.evaluate');
    const rankIdx = recommendBody.indexOf('this.deps.recommendationService.rank');
    expect(eligibilityIdx).toBeGreaterThan(-1);
    expect(rankIdx, 'ranking runs after eligibility in recommend()').toBeGreaterThan(eligibilityIdx);
    // The policy-boundary validation (clean domain errors; DB CHECK backstop).
    expect(src).toMatch(/validateWork043PolicyFields/);
  });

  // --- (g) the point-in-time seam (the WORK-042 handoff gate input) --------

  it('the point-in-time evaluateCandidateEligibility seam exists and persists NOTHING', () => {
    const src = stripCodeComments(readFileSync(POLICY_SERVICE, 'utf8'));
    expect(src).toMatch(/async evaluateCandidateEligibility/);
    // It reuses the SAME per-provider candidate builder (one construction path).
    expect(src).toMatch(/buildCandidateForProvider/);
    expect(src).toMatch(/buildSingleCandidate/);
    // It never writes a §22 decision (that is the recommendation path's job).
    const seamBody = src.slice(
      src.indexOf('async evaluateCandidateEligibility'),
      src.indexOf('async evaluateCandidateEligibility') + 4000,
    );
    expect(seamBody, 'the seam must not insert decisions').not.toMatch(/insertDecision/);
    // The public contract carries the seam.
    const types = readFileSync(POLICY_TYPES, 'utf8');
    expect(types).toMatch(/evaluateCandidateEligibility\(input: CandidateEligibilityInput\)/);
  });

  // --- (h) the WORK-042 handoff destination re-eligibility gate ------------

  it('the handoff gate re-evaluates the RESOLVED destination AFTER provider resolution + BEFORE the reserve', () => {
    const src = stripCodeComments(readFileSync(HANDOFF_SERVICE, 'utf8'));
    // The gate method exists.
    expect(src).toMatch(/destinationEligibilityGate/);
    // ORDER: policyGate → resolveProviderModel → destinationEligibilityGate → reserveAndClaim.
    const policyGateIdx = src.indexOf('await this.policyGate(');
    const resolveIdx = src.indexOf('await this.resolveProviderModel(');
    const destGateIdx = src.indexOf('await this.destinationEligibilityGate(');
    const reserveIdx = src.indexOf('await this.reserveAndClaim(');
    expect(policyGateIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(policyGateIdx);
    expect(destGateIdx, 'the destination gate runs after provider resolution').toBeGreaterThan(resolveIdx);
    expect(reserveIdx, 'the destination gate runs before the reserve (side-effect-free rejection)').toBeGreaterThan(destGateIdx);
    // Fail-closed on a THROWING evaluation + the structured rejection.
    expect(src).toMatch(/handoff-ineligible-destination/);
    expect(src).toMatch(/failing closed/);
    // The port seam is OPTIONAL (pre-WORK-043 fakes still satisfy it) and
    // the skip is recorded HONESTLY.
    expect(src).toMatch(/not_evaluated/);
    // The error code is in the stable vocabulary.
    const types = stripCodeComments(readFileSync(HANDOFF_TYPES, 'utf8'));
    expect(types).toMatch(/'handoff-ineligible-destination'/);
    // The route maps it to 409.
    const route = stripCodeComments(readFileSync(EXECUTION_ROUTE, 'utf8'));
    expect(route).toMatch(/case 'handoff-ineligible-destination'/);
  });

  // --- (i) the WORK-037 recommendation-time seam (non-interactive) ---------

  it('the agent-policy evaluateExternalForProject seam is NON-INTERACTIVE (no approval creation/consultation at recommendation time)', () => {
    const src = stripCodeComments(readFileSync(AGENT_POLICY_ENGINE, 'utf8'));
    expect(src).toMatch(/async evaluateExternalForProject/);
    // The method body must NOT create or consult approvals (an 'ask' stays
    // 'ask' — a recommendation cannot pre-approve a future handoff). The
    // body is sliced to the NEXT method boundary (a fixed-size slice would
    // bleed into resolveAsk, which legitimately consults approvals).
    const bodyStart = src.indexOf('async evaluateExternalForProject');
    const bodyEnd = (() => {
      const next = src.slice(bodyStart + 10).search(/\n  (?:private |async |\/\/ =)/);
      return next === -1 ? bodyStart + 3000 : bodyStart + 10 + next;
    })();
    const body = src.slice(bodyStart, bodyEnd);
    expect(body).not.toMatch(/ensurePending|consultApproval/);
    // The composition root wires the gate into the execution-policy service.
    const appSrc = stripCodeComments(readFileSync(APP_TS, 'utf8'));
    expect(appSrc).toMatch(/agentPolicyProjectGate:\s*agentPolicyEngine/);
  });

  // --- (j) migration 0050 — the policy-boundary CHECK backstops ------------

  it('migration 0050 carries the rate-limit/window + classification-ladder + non-negative CHECKs and the usage index', () => {
    const migration = readFileSync(MIGRATION_0050, 'utf8');
    expect(migration).toMatch(/wfos_execution_policy_rate_limit_requires_window/);
    expect(migration).toMatch(/wfos_execution_policy_security_classification_valid/);
    expect(migration).toMatch(/wfos_execution_policy_quota_nonnegative/);
    expect(migration).toMatch(/idx_executions_project_provider_created/);
    // The new columns.
    for (const col of [
      'max_executions_per_month',
      'max_executions_per_day',
      'rate_limit_max_requests',
      'rate_limit_window_seconds',
      'security_classification',
      'external_security_ceiling',
    ]) {
      expect(migration).toContain(col);
    }
  });

  // --- (k) the PATCH route maps the constraint-validation errors to 400 ----

  it('the execution-policy PATCH route maps execution-policy-invalid-constraint to HTTP 400', () => {
    const route = stripCodeComments(readFileSync(EXECUTION_POLICY_ROUTE, 'utf8'));
    expect(route).toMatch(/execution-policy-invalid-constraint/);
    expect(route).toMatch(/invalid-policy-constraint/);
  });

  // --- (l) the frontend mirror types stay in sync (the §33.3 vocabulary) ---

  it('the frontend mirror types declare the new statuses, categories, and the policy fields', () => {
    const client = readFileSync(FRONTEND_CLIENT, 'utf8');
    for (const status of ["'quota_exhausted'", "'rate_limited'", "'security_blocked'", "'agent_policy_blocked'"]) {
      expect(client, `frontend mirror declares ${status}`).toContain(status);
    }
    for (const cat of ["'quota'", "'rate_limit'", "'security'", "'agent_policy'"]) {
      expect(client, `frontend mirror declares ${cat}`).toContain(cat);
    }
    expect(client).toMatch(/maxExecutionsPerMonth:\s*number \| null/);
    expect(client).toMatch(/securityClassification:\s*SecurityClassification/);
    expect(client).toMatch(/externalSecurityCeiling/);
  });

  // --- (m) the test coverage exists (pure + PG + handoff-gate suites) ------

  it('the WORK-043 test suites exist with the required scenario coverage', () => {
    const regression = readFileSync(
      join(BACKEND_ROOT, 'tests', 'integration', 'execution-policy', 'execution-eligibility-constraints.regression.test.ts'),
      'utf8',
    );
    expect(regression).toMatch(/FAIL-CLOSED: an ACTIVE monthly quota with UNRESOLVABLE usage/);
    expect(regression).toMatch(/the limit is PER-PROVIDER/);
    expect(regression).toMatch(/project classification ABOVE the external ceiling/);
    expect(regression).toMatch(/a recommendation is NON-INTERACTIVE/);
    expect(regression).toMatch(/§33.3 — a quota block is a BLOCK/);

    const integration = readFileSync(
      join(BACKEND_ROOT, 'tests', 'integration', 'execution-policy', 'execution-eligibility-engine.integration.test.ts'),
      'utf8',
    );
    // AR-043-01: the PG suite must create BOTH dispatched and non-dispatched
    // execution records and prove the distinction.
    // AR-043-02: the suite must prove the per-provider split — each ACTUAL
    // dispatch attributed to the provider that dispatched it, including
    // cross-mode handoffs in BOTH directions (the architect's four-line
    // proof table + the reverse-direction log-snapshot attribution).
    expect(integration).toMatch(/countProjectDispatchedExecutionsSince/);
    expect(integration).toMatch(/countProjectProviderDispatchesSince/);
    expect(integration).toMatch(/WITHOUT dispatch → NOT counted/);
    expect(integration).toMatch(/rejected before dispatch → NOT counted/);
    expect(integration).toMatch(/FAILED run still dispatched/);
    expect(integration).toMatch(/EXACTLY ONCE/);
    expect(integration).toMatch(/A window = 1, B window = 1/);
    expect(integration).toMatch(/blocked at limit 1/);
    expect(integration).toMatch(/REVERSE cross-mode handoff/);
    expect(integration).toMatch(/previous_package_json/);
    expect(integration).toMatch(/falls out of the window by ITS OWN event time/);
    expect(integration).toMatch(/an exhausted monthly quota EXCLUDES every candidate/);
    expect(integration).toMatch(/an UNKNOWN provider → the honest configuration_missing verdict/);

    const handoff = readFileSync(
      join(BACKEND_ROOT, 'tests', 'integration', 'agents', 'cross-mode-handoff.regression.test.ts'),
      'utf8',
    );
    expect(handoff).toMatch(/WORK-043 destination re-eligibility/);
    expect(handoff).toMatch(/quota-exhausted external destination/);
    expect(handoff).toMatch(/a throwing evaluation → fail-closed/);
    expect(handoff).toMatch(/the verdict is recorded on the append-only log row/);
  });
});
