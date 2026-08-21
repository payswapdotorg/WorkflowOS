/**
 * Authentication + authorization contracts (AUTH-001..003, AUTHZ-AC-01..03).
 *
 * Provider-independent. The /auth module owns authentication and
 * authorization-policy concerns; the AuthorizationService is the reusable
 * backend authorization mechanism later modules consume.
 */
import type { SecretRef } from '@platform/secrets/secret-store.js';
import type { User } from '../../users/internal/user.types.js';

/**
 * An authenticated principal — the result of verifying presented credentials
 * against a provider. Distinct from a resolved WorkflowOS {@link User}:
 * authentication produces a principal; identity resolution maps it to a
 * persisted user (AUTH-AC-01).
 */
export interface AuthenticatedPrincipal {
  /**
   * Stable external id (e.g. API key fingerprint, OIDC subject). Used to
   * resolve the principal to the same WorkflowOS user on every authentication.
   */
  readonly externalId: string;
  /** Human-readable label for logs/metrics (NEVER a secret). */
  readonly label: string;
  /** The auth provider that authenticated this principal (e.g. `apikey`). */
  readonly provider: string;
}

/**
 * The result of an authentication attempt.
 *
 * Distinguishes the three states required by WORK-002 §6:
 *   - unauthenticated → { kind: 'unauthenticated' }
 *   - authenticated principal → { kind: 'principal', principal }
 *   - resolved WorkflowOS user → resolved separately via identity resolution
 */
export type AuthenticationResult =
  | { readonly kind: 'unauthenticated'; readonly reason: 'missing-credentials' | 'invalid-credentials' }
  | { readonly kind: 'principal'; readonly principal: AuthenticatedPrincipal };

/**
 * Provider-independent authentication boundary (AUTH-001). Domain logic
 * depends on this interface, never on a concrete provider implementation.
 *
 * A provider implementation (e.g. ApiKeyAuthProvider) lives under
 * /auth/internal/ and is forbidden as an import for other domain modules
 * (enforced by tests/architecture/static-architecture.test.ts).
 */
export interface AuthProvider {
  readonly name: string;
  /**
   * Attempt to authenticate a raw credential. Returns an
   * {@link AuthenticationResult}; never throws for invalid auth — that is a
   * normal `invalid-credentials` result.
   */
  authenticate(rawCredential: string): Promise<AuthenticationResult>;
}

/**
 * A resource on which an authorization decision is made. The minimal
 * representation is a project id; the AuthorizationService resolves its owning
 * organization through the project repository (AUTHZ-AC-02).
 */
export interface ProtectedResource {
  readonly kind: 'project';
  readonly projectId: string;
}

/**
 * Authorization decision returned by {@link AuthorizationService.authorize}.
 * Explicit — never inferred silently. Contains the permission ids that
 * justified the decision so callers can audit the reasoning.
 */
export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly userId: string;
  readonly permission: string;
  readonly resource: ProtectedResource;
  /**
   * The organization that owns the resolved resource. A cross-tenant
   * attempt (user not a member of this org) yields `allowed: false` even if a
   * project_access row exists (AUTHZ-AC-02).
   */
  readonly organizationId: string | null;
  readonly deniedReason?: 'not-a-member' | 'no-project-access' | 'missing-permission' | 'resource-not-found';
}

/**
 * Reusable backend authorization service (AUTHZ-AC-01..03). Later modules
 * ask it whether a principal may perform an action on a resource.
 *
 * Authorization decisions are made server-side and are independent of any
 * frontend state. The service is testable without HTTP/controller code.
 */
export interface AuthorizationService {
  /**
   * Decide whether `user` may exercise `permission` on `resource`.
   *
   * The decision chain (architecture §15):
   *   user → organization membership → role → permission → resource access
   *
   * A different tenant/resource id must NOT bypass the chain (AUTHZ-AC-02):
   * even if a project_access row grants the user a role on a project owned by
   * another organization, the service denies access because the user is not a
   * member of that organization.
   */
  authorize(input: {
    user: User;
    permission: string;
    resource: ProtectedResource;
  }): Promise<AuthorizationDecision>;
}

/**
 * Reference to the API-key credential store. The raw key table lives behind
 * the AuthProvider; the credential *material* is accessed through the
 * SecretStore abstraction (SEC-AC-01) so raw secrets never enter domain
 * records (SEC-AC-02).
 */
export interface ApiKeyCredentialRef {
  /** Stable id of the API key (NOT the key itself). */
  readonly keyId: string;
  /** Opaque reference to the secret material (env var name / key id). */
  readonly secretRef: SecretRef;
  /** External principal id this key authenticates (AUTH-AC-01). */
  readonly externalId: string;
  /** Human-readable label. */
  readonly label: string;
}
