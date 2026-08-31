/**
 * Authentication + authorization contracts (AUTH-001..003, AUTHZ-AC-01..03).
 *
 * Provider-independent. The /auth module owns authentication and
 * authorization-policy concerns; the AuthorizationService is the reusable
 * backend authorization mechanism later modules consume.
 */
import type { SecretRef } from '@platform/secrets/secret-store.js';
import type { User } from '@modules/users/index.js';

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
  /**
   * WORK-074: the resolved server-side session when this principal was
   * authenticated through the session provider (HttpOnly cookie → server-side
   * wfos_sessions row). Present ONLY for session principals; the raw session
   * token is NEVER carried here.
   */
  readonly session?: SessionContext;
  /**
   * WORK-074: present ONLY when the principal is a MACHINE (a service account
   * authenticated through a scoped API credential). A machine principal is
   * never a human user: the request pipeline must NOT resolve it to a
   * wfos_users row. Human principals never carry this field.
   */
  readonly machine?: MachinePrincipalContext;
}

/**
 * WORK-074: the machine-principal context of a scoped service-account
 * credential (WORK-063 machine identity). The service identity belongs to an
 * organization (its tenant anchor) and carries the credential's granted
 * capability set. Authorization decisions flow through the SAME
 * AuthorizationService chain (capability → permission mapping) — never a
 * parallel mechanism.
 */
export interface MachinePrincipalContext {
  readonly serviceAccountId: string;
  readonly organizationId: string;
  /** The credential's granted capabilities (scopes). Fail closed: anything not granted is denied. */
  readonly capabilities: readonly string[];
  /** Human-readable label (safe to log — never secret material). */
  readonly label: string;
}

/**
 * WORK-074: the session context attached to a session-authenticated principal.
 * Carries identifiers only — never the token material.
 */
export interface SessionContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: Date;
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
 *
 * For organization-level operations (e.g. creating a project within an org),
 * use {@link AuthorizationService.authorizeForOrganization} which authorizes
 * directly against the organization id — no synthetic project id required.
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
  readonly deniedReason?:
    | 'not-a-member'
    | 'no-project-access'
    | 'missing-permission'
    | 'resource-not-found'
    // WORK-074 (machine principals): the capability was not granted — or is
    // outside the closed grantable set. Typed fail-closed denial (WORK-063
    // invariant #6).
    | 'capability-not-granted';
}

/**
 * Authorization decision for an organization-level operation (e.g. creating a
 * project within an org). Distinct from {@link AuthorizationDecision} because
 * there is no project resource yet — the decision is about whether the user
 * may perform an action scoped to the organization itself.
 */
export interface OrganizationAuthorizationDecision {
  readonly allowed: boolean;
  readonly userId: string;
  readonly permission: string;
  readonly organizationId: string;
  readonly deniedReason?: 'not-a-member' | 'missing-permission';
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

  /**
   * Decide whether `user` may exercise `permission` scoped to `organizationId`.
   *
   * Used for organization-level operations that are NOT tied to a specific
   * project resource — e.g. creating a project within an organization
   * (PROJ-AC-01). The decision chain:
   *   user → organization membership → role → permission
   *
   * A user who is not a member of `organizationId` is denied with
   * `not-a-member` (AUTHZ-AC-02). This is the sanctioned way to authorize
   * project creation; do NOT use a synthetic nonexistent project id to infer
   * membership.
   */
  authorizeForOrganization(input: {
    user: User;
    permission: string;
    organizationId: string;
  }): Promise<OrganizationAuthorizationDecision>;

  /**
   * WORK-074 (machine identity): decide whether a scoped MACHINE principal may
   * exercise `capability` — mapping to `permission` — on `resource`.
   *
   * This is the SAME authorization authority and the SAME decision chain
   * (WORK-063: "authorization decisions for machine principals flow through
   * the SAME server-side AuthorizationService path (capability → permission
   * mapping), never a parallel authorization mechanism"). The chain for a
   * machine principal:
   *
   *   resource → owning organization → tenant anchor (the service account's
   *   organization IS its membership) → capability ∈ granted scopes →
   *   capability maps to the requested permission
   *
   * Fail closed (WORK-063 invariant #6): a capability not granted — or not in
   * the closed grantable capability set — is a typed
   * `capability-not-granted` denial. Cross-tenant attempts are denied with
   * `not-a-member` exactly as for humans (AUTHZ-AC-02, unchanged and
   * unweakened).
   *
   * Optional on the interface: only the backend DefaultAuthorizationService
   * implements it; no other authorization implementation may exist (the
   * static architecture checks enforce this).
   */
  authorizeForMachinePrincipal?(input: {
    principal: MachinePrincipalContext;
    /** The route's declared machine capability (undefined → deny). */
    capability?: string;
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
