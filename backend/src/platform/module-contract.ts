/**
 * Platform module contract.
 *
 * Every frozen WorkflowOS backend module exposes a {@link ModuleContract} as the
 * authoritative, declared public interface used by other modules.
 *
 * Cross-module communication MUST go through a module's contract (its
 * `index.ts` barrel). Reaching into another module's `internal/` directory is
 * forbidden and is enforced statically — see
 * `tests/architecture/static-architecture.test.ts` (PLAT-AC-02).
 */

/**
 * Canonical name of a frozen backend module, e.g. `/auth`, `/workflows`.
 * Matches the module directory name under `src/modules/`.
 */
export type ModuleName =
  | '/auth'
  | '/users'
  | '/organizations'
  | '/projects'
  | '/architecture'
  | '/specifications'
  | '/requirements'
  | '/work-items'
  | '/workflows'
  | '/verification'
  | '/reviews'
  | '/llm'
  | '/agents'
  | '/github'
  | '/notifications'
  | '/audit'
  | '/runtime';

/**
 * Marker interface implemented by every module's public surface.
 *
 * A module's `index.ts` exports a `ModuleContract` object whose `name` is the
 * canonical frozen module name. Future capability methods are declared on a
 * module-specific interface that extends this marker.
 */
export interface ModuleContract {
  /** Canonical frozen module name (matches `src/modules/<name>/`). */
  readonly name: ModuleName;
}

/**
 * The frozen set of backend module names. This is the single source of truth
 * for the module list and is consumed by the static architecture check
 * (PLAT-AC-01).
 */
export const FROZEN_MODULE_NAMES: readonly ModuleName[] = [
  '/auth',
  '/users',
  '/organizations',
  '/projects',
  '/architecture',
  '/specifications',
  '/requirements',
  '/work-items',
  '/workflows',
  '/verification',
  '/reviews',
  '/llm',
  '/agents',
  '/github',
  '/notifications',
  '/audit',
  '/runtime',
];
