/**
 * users module — public interface.
 *
 * Canonical name: /users
 * Responsibility (spec/architecture.md): WorkflowOS user records and identity resolution.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-002: exposes the {@link UserRepository} contract and {@link User} type
 * consumed by /auth for identity resolution.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type { User, UserRepository, CreateUserInput } from './internal/user.types.js';
export { PgUserRepository } from './internal/pg-user-repository.js';

/**
 * Public capabilities exposed by the /users module to other modules.
 */
export interface UsersModuleApi {
  // future: additional user-domain methods consumed by other modules
}

/**
 * Frozen module contract for /users.
 */
export const usersModule: ModuleContract & UsersModuleApi = {
  name: '/users',
};

export default usersModule;
