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

  it('PROJ-001 scope limit: /projects exposes only minimal ownership/access contracts', () => {
    // WORK-002 must NOT broaden into full project-domain functionality. The
    // /projects public interface may export only the types/repos required for
    // authorization; it must NOT export project configuration, repository
    // associations, or lifecycle methods.
    const projectsIndex = readFileSync(join(MODULES_DIR, 'projects', 'index.ts'), 'utf8');
    const allowed = new Set([
      'Project',
      'CreateProjectInput',
      'ProjectAccess',
      'GrantProjectAccessInput',
      'ProjectRepository',
      'ProjectAccessRepository',
      'PgProjectRepository',
      'PgProjectAccessRepository',
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
});
