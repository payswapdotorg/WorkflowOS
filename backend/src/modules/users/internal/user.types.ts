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
  /**
   * WORK-074: find a user by email address. Used by the identity-resolution
   * flow to link a freshly-verified provider identity to an existing account.
   * Returns null when no user carries that email.
   */
  findByEmail(email: string): Promise<User | null>;
}

// --- WORK-074: linked provider identities (identity linking on /users) ---

/**
 * A linked external identity: one provider subject (OIDC subject, GitHub user
 * id, or the email of a password account) bound to a WorkflowOS user. The
 * same provider subject always resolves to the same user (AUTH-AC-01
 * generalized to OIDC subjects); multiple provider identities MAY link to one
 * user (WORK-063: identity linking).
 */
export interface LinkedIdentity {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string | null;
  /** Whether the provider attested the email for THIS identity. */
  readonly emailVerified: boolean;
  readonly createdAt: Date;
}

export interface CreateLinkedIdentityInput {
  userId: string;
  provider: string;
  subject: string;
  email?: string | null;
  displayName?: string | null;
  emailVerified?: boolean;
}

/**
 * Repository contract for linked-identity persistence. Owned by /users;
 * consumed by /auth's identity-resolution runtime.
 */
export interface LinkedIdentityRepository {
  /** Find the linked identity for an exact (provider, subject) pair. */
  findByProviderSubject(provider: string, subject: string): Promise<LinkedIdentity | null>;
  /** List every identity linked to a user. */
  listForUser(userId: string): Promise<LinkedIdentity[]>;
  /** Whether the user holds at least one provider-verified identity. */
  hasVerifiedIdentity(userId: string): Promise<boolean>;
  /** Link a provider subject to a user (idempotent on provider+subject). */
  link(input: CreateLinkedIdentityInput): Promise<LinkedIdentity>;
}
