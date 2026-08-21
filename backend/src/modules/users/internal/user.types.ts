/**
 * User identity types shared across the /users, /auth, and /organizations
 * modules. These are the provider-independent contracts; persistence is an
 * implementation detail owned by /users internal/.
 */

/** WorkflowOS user identity (AUTH-001). Persisted in PostgreSQL (wfos_users). */
export interface User {
  readonly id: string;
  /** Stable external principal id from the AuthProvider (AUTH-AC-01). */
  readonly externalId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly createdAt: Date;
}

export interface CreateUserInput {
  externalId: string;
  displayName: string;
  email?: string | null;
}

/**
 * Repository contract for user identity persistence. Owned by /users;
 * consumed by /auth (to resolve/created users during authentication) and
 * potentially by other modules through the /users public interface.
 */
export interface UserRepository {
  /** Find a user by their stable external principal id (AUTH-AC-01). */
  findByExternalId(externalId: string): Promise<User | null>;
  /** Find a user by WorkflowOS user id. */
  findById(id: string): Promise<User | null>;
  /**
   * Create or return an existing user for the given external id. Deterministic:
   * the same externalId always resolves to the same persisted user (AUTH-AC-01).
   */
  upsertByExternalId(input: CreateUserInput): Promise<User>;
}
